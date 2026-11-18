import express, { type Request, type Response } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import {
  getFirebaseAdminContext,
  isFirestorePermissionDeniedError,
  formatAdminPermissionDeniedError,
  TARGET_DATABASE_ID,
} from './serverFirebaseAdmin.ts';
import {
  type AdminAuthLike,
  type AdminFirestoreLike,
  type VerifiedCaller,
  normalizeRoleValue,
  SYSTEM_ROLE_IDS,
  extractTrustedClientIp,
  parseUserAgent,
  resolveIpGeoLocation,
  recordEnterpriseAuditEvent,
  recordLoginHistoryEntry,
  syncUserUidIndex,
  type GeoLocationInfo,
  type UserAgentMeta,
} from './serverSecurityAudit.ts';
import {
  recordActivityTelemetry,
  recordErrorTelemetry,
} from './serverMonitoring.ts';

export const MAX_CONSECUTIVE_FAILED_ATTEMPTS = 3;
export const LOCKED_ACCOUNT_MESSAGE =
  'Your account has been temporarily blocked. Please contact Super Admin.';

// ============================================================================
// 1. Concurrency Mutex per Login ID (Serializes In-Instance Concurrent Bursts)
//    Combined with Firestore runTransaction() for Cross-Instance Atomicity
// ============================================================================
const loginMutexQueues = new Map<string, Promise<unknown>>();

export async function withLoginIdLock<T>(loginId: string, task: () => Promise<T>): Promise<T> {
  const key = loginId.trim().toLowerCase() || '__anonymous__';
  const prev = loginMutexQueues.get(key) || Promise.resolve();

  let releaseCurrent!: () => void;
  const currentGate = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });

  const chained = prev.then(() => currentGate);
  loginMutexQueues.set(key, chained);

  try {
    await prev;
    return await task();
  } finally {
    releaseCurrent();
    if (loginMutexQueues.get(key) === chained) {
      loginMutexQueues.delete(key);
    }
  }
}

// ============================================================================
// 2. Distributed Firestore-Backed IP & Abuse Rate Limiter
//    Persists progressive cooldowns across restarts & multiple Cloud Run pods
// ============================================================================
export interface IpRateRecord {
  scopeKey: string;
  ip: string;
  loginScope: string;
  failures: number;
  unknownIdFailures: number;
  lockedHits: number;
  windowStart: number;
  cooldownUntil: number;
  strikes: number;
  updatedAt: string;
}

const IP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const PROGRESSIVE_COOLDOWNS_MS = [30 * 1000, 2 * 60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000];

function getIpScopeKey(ip: string, loginId?: string): string {
  const cleanIp = (ip || '127.0.0.1').trim();
  const cleanLogin = (loginId || '__global__').trim().toLowerCase();
  return `${cleanIp}::${cleanLogin}`;
}

function getIpRateDocId(scopeKey: string): string {
  return `ip_${crypto.createHash('sha256').update(scopeKey).digest('hex').slice(0, 32)}`;
}

export async function checkIpProgressiveRateLimitPersistent(
  db: AdminFirestoreLike,
  ip: string,
  loginId?: string
): Promise<{
  allowed: boolean;
  cooldownSeconds?: number;
  reason?: string;
}> {
  const now = Date.now();
  const keysToCheck = [
    ...(loginId ? [getIpScopeKey(ip, loginId)] : []),
    getIpScopeKey(ip, '__unknown_probe__'),
  ];

  for (const scopeKey of keysToCheck) {
    const docId = getIpRateDocId(scopeKey);
    const snap = await db.collection('ip_rate_limits').doc(docId).get();
    if (snap.exists) {
      const rec = snap.data() as IpRateRecord;
      if (rec && Number(rec.cooldownUntil || 0) > now) {
        const cooldownSeconds = Math.max(1, Math.ceil((Number(rec.cooldownUntil) - now) / 1000));
        return {
          allowed: false,
          cooldownSeconds,
          reason: `Rate limit cooldown active (${cooldownSeconds}s remaining).`,
        };
      }
    }
  }

  return { allowed: true };
}

export async function recordIpFailurePersistent(
  db: AdminFirestoreLike,
  ip: string,
  kind: 'password' | 'unknown_id' | 'locked_hit' | 'firebase_throttle',
  loginId?: string
): Promise<{ triggeredCooldown: boolean; cooldownSeconds: number }> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const cleanLogin = kind === 'unknown_id' ? '__unknown_probe__' : (loginId || '__global__').trim().toLowerCase();
  const scopeKey = getIpScopeKey(ip, cleanLogin);
  const ref = db.collection('ip_rate_limits').doc(getIpRateDocId(scopeKey));

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    let rec: IpRateRecord;
    if (!snap.exists) {
      rec = {
        scopeKey,
        ip: (ip || '127.0.0.1').trim(),
        loginScope: cleanLogin,
        failures: 0,
        unknownIdFailures: 0,
        lockedHits: 0,
        windowStart: now,
        cooldownUntil: 0,
        strikes: 0,
        updatedAt: nowIso,
      };
    } else {
      const data = snap.data() as IpRateRecord;
      const expired = now - Number(data.windowStart || 0) > IP_WINDOW_MS && Number(data.cooldownUntil || 0) <= now;
      rec = expired
        ? {
            scopeKey,
            ip: (ip || '127.0.0.1').trim(),
            loginScope: cleanLogin,
            failures: 0,
            unknownIdFailures: 0,
            lockedHits: 0,
            windowStart: now,
            cooldownUntil: 0,
            strikes: 0,
            updatedAt: nowIso,
          }
        : {
            ...data,
            scopeKey,
            ip: (ip || '127.0.0.1').trim(),
            loginScope: cleanLogin,
            failures: Number(data.failures || 0),
            unknownIdFailures: Number(data.unknownIdFailures || 0),
            lockedHits: Number(data.lockedHits || 0),
            windowStart: Number(data.windowStart || now),
            cooldownUntil: Number(data.cooldownUntil || 0),
            strikes: Number(data.strikes || 0),
            updatedAt: nowIso,
          };
    }

    rec.failures += 1;
    if (kind === 'unknown_id') rec.unknownIdFailures += 1;
    if (kind === 'locked_hit') rec.lockedHits += 1;

    const shouldThrottle =
      kind === 'firebase_throttle' ||
      rec.unknownIdFailures >= 10 ||
      rec.lockedHits >= 5 ||
      rec.failures >= 15;

    let triggeredCooldown = false;
    let cooldownSeconds = 0;

    if (shouldThrottle) {
      const idx = Math.min(rec.strikes, PROGRESSIVE_COOLDOWNS_MS.length - 1);
      const delayMs = PROGRESSIVE_COOLDOWNS_MS[idx];
      rec.cooldownUntil = now + delayMs;
      rec.strikes += 1;
      triggeredCooldown = true;
      cooldownSeconds = Math.ceil(delayMs / 1000);
    }

    rec.updatedAt = nowIso;
    tx.set(ref, rec, { merge: true });
    return { triggeredCooldown, cooldownSeconds };
  });
}

export async function clearIpCooldownPersistent(
  db: AdminFirestoreLike,
  ip?: string,
  loginId?: string
): Promise<void> {
  try {
    if (ip && loginId) {
      const scopeKey = getIpScopeKey(ip, loginId);
      await db.collection('ip_rate_limits').doc(getIpRateDocId(scopeKey)).delete();
      return;
    }
    if (loginId) {
      const cleanLogin = loginId.trim().toLowerCase();
      const snap = await db.collection('ip_rate_limits').where('loginScope', '==', cleanLogin).get();
      await Promise.all(
        snap.docs.map((d) => db.collection('ip_rate_limits').doc(d.id).delete())
      );
      return;
    }
    if (ip) {
      const cleanIp = ip.trim();
      const snap = await db.collection('ip_rate_limits').where('ip', '==', cleanIp).get();
      await Promise.all(
        snap.docs.map((d) => db.collection('ip_rate_limits').doc(d.id).delete())
      );
    }
  } catch {
    // non-fatal cleanup
  }
}

// ============================================================================
// 3. Cryptographic Random Temporary Password Generator & Admin SDK Helper
// ============================================================================
export function generateStrongTemporaryPassword(length = 14): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const special = '@#$%&*!?';
  const all = upper + lower + digits + special;

  const chars: string[] = [
    upper[crypto.randomInt(0, upper.length)],
    lower[crypto.randomInt(0, lower.length)],
    digits[crypto.randomInt(0, digits.length)],
    special[crypto.randomInt(0, special.length)],
  ];

  while (chars.length < length) {
    chars.push(all[crypto.randomInt(0, all.length)]);
  }

  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    const tmp = chars[i];
    chars[i] = chars[j];
    chars[j] = tmp;
  }

  return chars.join('');
}

export async function getAdminAuthContext(
  _projectId: string,
  injectedAuth?: AdminAuthLike | null
): Promise<{
  available: boolean;
  adminAuth?: AdminAuthLike;
  credentialSource?: string;
  serviceAccountEmail?: string;
  reason?: string;
}> {
  if (injectedAuth) {
    return {
      available: true,
      adminAuth: injectedAuth,
      credentialSource: 'INJECTED_ADMIN_AUTH',
    };
  }
  const ctx = getFirebaseAdminContext();
  if (!ctx.auth) {
    return {
      available: false,
      reason: ctx.error || 'Firebase Admin Auth is not initialized.',
    };
  }
  return {
    available: true,
    adminAuth: ctx.auth as unknown as AdminAuthLike,
    credentialSource: ctx.credentialSource,
    serviceAccountEmail: ctx.serviceAccountEmail,
  };
}

export async function tryAdminAuthUpdatePassword(
  projectId: string,
  targetUid: string,
  newPassword: string,
  injectedAuth?: AdminAuthLike | null
): Promise<{
  updated: boolean;
  adminSdkAvailable: boolean;
  uid?: string;
  email?: string | null;
  reason?: string;
}> {
  if (!targetUid || targetUid.startsWith('role_')) {
    return {
      updated: false,
      adminSdkAvailable: false,
      reason: 'Target record does not have a valid Firebase Authentication UID.',
    };
  }

  const ctx = await getAdminAuthContext(projectId, injectedAuth);
  if (!ctx.available || !ctx.adminAuth) {
    return {
      updated: false,
      adminSdkAvailable: false,
      reason: ctx.reason,
    };
  }

  try {
    const existingUser = await ctx.adminAuth.getUser(targetUid);
    await ctx.adminAuth.updateUser(existingUser.uid, { password: newPassword });
    await ctx.adminAuth.revokeRefreshTokens(existingUser.uid);
    return {
      updated: true,
      adminSdkAvailable: true,
      uid: existingUser.uid,
      email: existingUser.email || null,
    };
  } catch (err: any) {
    return {
      updated: false,
      adminSdkAvailable: true,
      reason: String(err?.message || err || 'Firebase Admin updateUser failed.'),
    };
  }
}

export async function inspectFirebaseAuthStatus(
  projectId: string,
  db: AdminFirestoreLike,
  injectedAuth?: AdminAuthLike | null
): Promise<{
  adminSdkConfigured: boolean;
  projectId: string;
  credentialSource?: string;
  serviceAccountEmail?: string;
  reason?: string;
  authUsers: Array<{
    uid: string;
    email: string | null;
    disabled: boolean;
    creationTime?: string;
    lastSignInTime?: string;
  }>;
  firestoreMappings: Array<{
    docId: string;
    loginId: string;
    role: string;
    firestoreEmail: string;
    firestoreAuthUid: string | null;
    emailAliases: string[];
    firebaseAuthMatchedEmail?: string | null;
    firebaseAuthMatchedBy?: 'UID' | 'EMAIL' | 'UNVERIFIED' | 'MISSING';
    mappingConflict?: boolean;
  }>;
}> {
  const ctx = await getAdminAuthContext(projectId, injectedAuth);
  const usersSnap = await db.collection('user_roles').get();

  let authUsers: Array<{
    uid: string;
    email: string | null;
    disabled: boolean;
    creationTime?: string;
    lastSignInTime?: string;
  }> = [];
  let authListError = '';

  if (ctx.available && ctx.adminAuth) {
    try {
      const listRes = await ctx.adminAuth.listUsers(100);
      authUsers = (listRes.users || []).map((u: any) => ({
        uid: u.uid,
        email: u.email || null,
        disabled: Boolean(u.disabled),
        creationTime: u.metadata?.creationTime,
        lastSignInTime: u.metadata?.lastSignInTime,
      }));
    } catch (listErr: any) {
      authListError = String(listErr?.message || listErr || 'listUsers failed');
    }
  }

  const byUid = new Map(authUsers.map((u) => [u.uid, u]));
  const byEmail = new Map(
    authUsers.filter((u) => u.email).map((u) => [String(u.email).toLowerCase(), u])
  );
  const authListed = ctx.available && !authListError;

  const firestoreMappings = usersSnap.docs.map((d) => {
    const data = d.data() || {};
    const fsEmail = String(data.email || '').trim().toLowerCase();
    const fsUid = data.authUid ? String(data.authUid) : null;
    const aliases = Array.isArray(data.emailAliases) ? data.emailAliases.map((a: any) => String(a)) : [];

    let matchedBy: 'UID' | 'EMAIL' | 'UNVERIFIED' | 'MISSING' = 'UNVERIFIED';
    let matchedEmail: string | null = null;
    let conflict = false;

    if (authListed) {
      const uidUser = fsUid ? byUid.get(fsUid) : undefined;
      const emailUser = fsEmail ? byEmail.get(fsEmail) : undefined;
      if (uidUser) {
        matchedBy = 'UID';
        matchedEmail = uidUser.email;
        if (uidUser.email && fsEmail && uidUser.email.toLowerCase() !== fsEmail) {
          conflict = true;
        }
      } else if (emailUser) {
        matchedBy = 'EMAIL';
        matchedEmail = emailUser.email;
        if (fsUid && emailUser.uid !== fsUid) {
          conflict = true;
        }
      } else {
        matchedBy = 'MISSING';
        conflict = true;
      }
    }

    return {
      docId: d.id,
      loginId: String(data.loginId || d.id.replace(/^role_/, '')),
      role: String(data.role || 'user').toUpperCase(),
      firestoreEmail: fsEmail,
      firestoreAuthUid: fsUid,
      emailAliases: aliases,
      firebaseAuthMatchedEmail: matchedEmail,
      firebaseAuthMatchedBy: matchedBy,
      mappingConflict: conflict,
    };
  });

  return {
    adminSdkConfigured: authListed,
    projectId,
    credentialSource: ctx.credentialSource,
    serviceAccountEmail: ctx.serviceAccountEmail,
    reason: authListError || ctx.reason,
    authUsers,
    firestoreMappings,
  };
}

// ============================================================================
// 4. Security Record Writers (login_attempts & security_audit_logs)
// ============================================================================
export interface AttemptTelemetryContext {
  ipAddress: string;
  geoLocation: GeoLocationInfo;
  uaMeta: UserAgentMeta;
}

export async function captureTelemetryContext(db: AdminFirestoreLike, req: Request): Promise<AttemptTelemetryContext> {
  const ipAddress = extractTrustedClientIp(req);
  const uaMeta = parseUserAgent(req.headers['user-agent']);
  let captureGeo = true;
  try {
    const settingsSnap = await db.collection('system_settings').doc('global').get();
    if (settingsSnap.exists && settingsSnap.data()?.captureGeoLocation === false) {
      captureGeo = false;
    }
  } catch {
    // non-blocking
  }
  const geoLocation = await resolveIpGeoLocation(ipAddress, captureGeo);
  return { ipAddress, geoLocation, uaMeta };
}

export async function recordLoginAttemptDoc(
  db: AdminFirestoreLike,
  params: {
    loginId: string;
    role: string;
    firebaseUid?: string | null;
    success: boolean;
    outcome:
      | 'SUCCESS'
      | 'FAILED_PASSWORD'
      | 'BLOCKED_LOCKED'
      | 'BLOCKED_INACTIVE'
      | 'BLOCKED_RATE_LIMIT'
      | 'FIREBASE_TOO_MANY_ATTEMPTS'
      | 'ACCOUNT_NOT_FOUND';
    failureReasonCategory:
      | 'NONE'
      | 'INVALID_PASSWORD'
      | 'ACCOUNT_LOCKED'
      | 'RATE_LIMITED'
      | 'FIREBASE_ABUSE_PROTECTION'
      | 'ACCOUNT_INACTIVE'
      | 'ROLE_INACTIVE'
      | 'ACCOUNT_NOT_FOUND';
    failureReason?: string | null;
    attemptNumber?: number | null;
    consecutiveFailedAfter?: number | null;
    triggeredLock?: boolean;
    sessionId?: string | null;
    telemetry: AttemptTelemetryContext;
  }
): Promise<string> {
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const attemptId = `att_${nowDate.getTime()}_${crypto.randomBytes(4).toString('hex')}`;

  await db.collection('login_attempts').doc(attemptId).set({
    id: attemptId,
    loginId: params.loginId.trim().toLowerCase(),
    role: String(params.role || 'UNKNOWN').toUpperCase(),
    firebaseUid: params.firebaseUid || null,
    timestamp: now,
    timestampMs: nowDate.getTime(),
    success: params.success,
    outcome: params.outcome,
    failureReasonCategory: params.failureReasonCategory,
    failureReason: params.failureReason ? String(params.failureReason).slice(0, 500) : null,
    attemptNumber: params.attemptNumber ?? null,
    consecutiveFailedAfter: params.consecutiveFailedAfter ?? null,
    triggeredLock: Boolean(params.triggeredLock),
    ipAddress: params.telemetry.ipAddress,
    geoLocation: params.telemetry.geoLocation,
    browser: params.telemetry.uaMeta.browser,
    os: params.telemetry.uaMeta.os,
    deviceType: params.telemetry.uaMeta.deviceType,
    userAgent: params.telemetry.uaMeta.raw ? params.telemetry.uaMeta.raw.slice(0, 240) : '',
    sessionId: params.sessionId || null,
  });

  return attemptId;
}

export async function recordSecurityAuditLogDoc(
  db: AdminFirestoreLike,
  params: {
    action:
      | 'LOGIN_ATTEMPT_FAILED'
      | 'LOGIN_ATTEMPT_WARNING'
      | 'ACCOUNT_LOCKED'
      | 'LOGIN_BLOCKED_WHILE_LOCKED'
      | 'LOGIN_SUCCESS'
      | 'RATE_LIMIT_TRIGGERED'
      | 'FIREBASE_TOO_MANY_ATTEMPTS'
      | 'ACCOUNT_UNBLOCKED'
      | 'TEMP_PASSWORD_GENERATED'
      | 'TEMP_PASSWORD_SYNC_FAILED'
      | 'PASSWORD_RESET_SYNC_FAILED'
      | 'MANDATORY_PASSWORD_CHANGED'
      | 'UNAUTHORIZED_SECURITY_ACCESS';
    severity: 'INFO' | 'WARNING' | 'CRITICAL';
    targetLoginId: string;
    targetRole?: string;
    targetUid?: string | null;
    actorUid?: string;
    actorLoginId?: string;
    actorRole?: string;
    reason: string;
    details: string;
    metadata?: Record<string, any>;
    telemetry: AttemptTelemetryContext;
  }
): Promise<string> {
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const logId = `saud_${nowDate.getTime()}_${crypto.randomBytes(4).toString('hex')}`;

  const safeMeta: Record<string, any> = {};
  if (params.metadata) {
    for (const [k, v] of Object.entries(params.metadata)) {
      if (/(password|hash|token|secret|credential)/i.test(k)) continue;
      safeMeta[k] = v;
    }
  }

  await db.collection('security_audit_logs').doc(logId).set({
    id: logId,
    action: params.action,
    severity: params.severity,
    targetLoginId: params.targetLoginId.trim().toLowerCase(),
    targetRole: String(params.targetRole || 'UNKNOWN').toUpperCase(),
    targetUid: params.targetUid || null,
    actorUid: params.actorUid || 'system',
    actorLoginId: (params.actorLoginId || params.targetLoginId || 'system').trim().toLowerCase(),
    actorRole: String(params.actorRole || 'SYSTEM').toUpperCase(),
    timestamp: now,
    timestampMs: nowDate.getTime(),
    ipAddress: params.telemetry.ipAddress,
    geoLocation: params.telemetry.geoLocation,
    deviceInfo: {
      browser: params.telemetry.uaMeta.browser,
      os: params.telemetry.uaMeta.os,
      deviceType: params.telemetry.uaMeta.deviceType,
    },
    reason: params.reason.slice(0, 1000),
    details: params.details.slice(0, 2000),
    metadata: safeMeta,
  });

  return logId;
}

// ============================================================================
// 5. Bootstrap / Ensure account_security & user_uid_index for Existing Accounts
//    (Never creates auth users, never overwrites authUid/email/passwordHash)
// ============================================================================
export async function seedAccountSecurityRecords(db: AdminFirestoreLike): Promise<void> {
  try {
    const usersSnap = await db.collection('user_roles').get();
    const now = new Date().toISOString();

    for (const uDoc of usersSnap.docs) {
      const uData = uDoc.data() || {};
      const loginId = String(uData.loginId || uDoc.id.replace(/^role_/, '')).trim().toLowerCase();
      if (!loginId) continue;

      if (uData.authUid) {
        await syncUserUidIndex(db, {
          uid: String(uData.authUid),
          roleDocId: uDoc.id,
          role: String(uData.role || 'user'),
          status: String(uData.status || 'Active'),
          lockStatus: uData.isLocked || uData.lockStatus === 'LOCKED' ? 'LOCKED' : 'ACTIVE',
          loginId,
        });
      }

      const secId = `sec_${loginId}`;
      const secRef = db.collection('account_security').doc(secId);
      const secSnap = await secRef.get();

      if (!secSnap.exists) {
        await secRef.set({
          id: secId,
          loginId,
          role: String(uData.role || 'USER').toUpperCase(),
          firebaseUid: uData.authUid || uDoc.id,
          email: uData.email || `${loginId}@narid.com`,
          lockStatus: uData.isLocked || uData.lockStatus === 'LOCKED' ? 'LOCKED' : 'ACTIVE',
          consecutiveFailedAttempts: Number(uData.consecutiveFailedAttempts || 0),
          maxAttemptsAllowed: MAX_CONSECUTIVE_FAILED_ATTEMPTS,
          totalLoginAttempts: 0,
          totalSuccessfulLogins: 0,
          totalFailedLogins: 0,
          forcePasswordChange: uData.mustChangePassword === true || uData.forcePasswordChange === true,
          lockedAt: uData.lockedAt || null,
          lockReason: uData.lockReason || null,
          lastFailedAt: null,
          lastFailedIp: null,
          lastFailedGeo: null,
          lastFailedDevice: null,
          lastFailedReason: null,
          lastSuccessAt: uData.lastSuccessLoginAt || null,
          lastSuccessIp: null,
          lastSuccessGeo: null,
          lastSuccessDevice: null,
          unblockedByUid: null,
          unblockedByLoginId: null,
          unblockedAt: null,
          unblockReason: null,
          tempPasswordResetByUid: null,
          tempPasswordResetByLoginId: null,
          tempPasswordResetAt: uData.passwordResetAt || null,
          updatedAt: now,
        });
      } else {
        const sData = secSnap.data() || {};
        const updates: Record<string, any> = {};
        if (uData.email && sData.email !== uData.email) {
          updates.email = uData.email;
        }
        if (uData.authUid && sData.firebaseUid !== uData.authUid) {
          updates.firebaseUid = uData.authUid;
        }
        if (Object.keys(updates).length > 0) {
          updates.updatedAt = now;
          await secRef.update(updates);
        }
      }
    }
  } catch (err: any) {
    console.warn('[Security Boot] account_security seed notice:', err?.message || err);
  }
}

// ============================================================================
// 6. Atomic Concurrency-Safe Login Verification Engine
// ============================================================================
export interface LoginSecurityDeps {
  db: AdminFirestoreLike;
  auth: AdminAuthLike | null;
  projectId: string;
  verifyPassword: (password: string, storedHash: string) => boolean;
  hashPassword: (password: string) => string;
  syncExistingFirebaseAuthPassword: (
    email: string,
    targetUid: string,
    newPassword: string,
    knownCurrentPassword?: string
  ) => Promise<{ success: boolean; uid?: string; error?: string; rateLimited?: boolean }>;
  requireVerifiedCaller: (
    req: Request,
    res: Response,
    allowedRoles: string[] | '*',
    actionLabel: string
  ) => Promise<VerifiedCaller | null>;
}

const UnblockAccountSchema = z.object({
  targetLoginId: z.string().trim().min(1, 'Target Login ID is required.').max(64),
  reason: z.string().trim().min(5, 'An explicit unblock reason (at least 5 characters) is mandatory.').max(500),
  confirmed: z.literal(true, { message: 'Explicit confirmation is required to unblock an account.' }),
});

const GenerateTempPasswordSchema = z.object({
  targetLoginId: z.string().trim().min(1, 'Target Login ID is required.').max(64),
  reason: z.string().trim().min(5, 'A governance reason (at least 5 characters) is mandatory.').max(500),
  freshSuperAdminPassword: z.string().optional(),
});

export function registerLoginSecurityRoutes(app: express.Express, deps: LoginSecurityDeps) {
  const {
    db,
    auth,
    projectId,
    verifyPassword,
    hashPassword,
    syncExistingFirebaseAuthPassword,
    requireVerifiedCaller,
  } = deps;

  // A. Hardened POST /api/auth/login (Atomic 3-Strike Lockout + Persistent IP Rate Limit)
  app.post('/api/auth/login', async (req: Request, res: Response) => {
    try {
      const loginIdRaw = typeof req.body?.loginId === 'string' ? req.body.loginId.trim() : '';
      const password = typeof req.body?.password === 'string' ? req.body.password : '';

      if (!loginIdRaw) {
        return res.status(400).json({ success: false, error: 'Please enter your Login ID.' });
      }
      if (!password) {
        return res.status(400).json({ success: false, error: 'Please enter your password.' });
      }

      const cleanId = loginIdRaw.toLowerCase();
      const telemetry = await captureTelemetryContext(db, req);

      // 1. Check Persistent Distributed IP Rate Limit
      const ipCheck = await checkIpProgressiveRateLimitPersistent(db, telemetry.ipAddress, cleanId);
      if (!ipCheck.allowed) {
        await recordLoginAttemptDoc(db, {
          loginId: cleanId,
          role: 'UNKNOWN',
          success: false,
          outcome: 'BLOCKED_RATE_LIMIT',
          failureReasonCategory: 'RATE_LIMITED',
          failureReason: ipCheck.reason || 'Rate limit cooldown active',
          telemetry,
        });
        await recordSecurityAuditLogDoc(db, {
          action: 'RATE_LIMIT_TRIGGERED',
          severity: 'CRITICAL',
          targetLoginId: cleanId,
          reason: 'IP progressive rate limit cooldown blocked login attempt',
          details: `Blocked login attempt for "${cleanId}" from IP ${telemetry.ipAddress} (${ipCheck.cooldownSeconds}s remaining).`,
          metadata: { cooldownSeconds: ipCheck.cooldownSeconds },
          telemetry,
        });
        return res.status(429).json({
          success: false,
          code: 'RATE_LIMITED',
          cooldownSeconds: ipCheck.cooldownSeconds,
          error: `Too many authentication attempts from this network. Please wait ${ipCheck.cooldownSeconds} seconds and try again.`,
        });
      }

      await new Promise((r) => setTimeout(r, 25));

      // 2. Serialize all login verification & counter mutations per Login ID
      const result = await withLoginIdLock(cleanId, async () => {
        const docId = `role_${cleanId}`;
        let userDoc = await db.collection('user_roles').doc(docId).get();

        if (!userDoc.exists) {
          const snap = await db.collection('user_roles').where('loginId', '==', cleanId).limit(1).get();
          if (!snap.empty) {
            userDoc = snap.docs[0];
          }
        }

        if (!userDoc || !userDoc.exists) {
          const ipRes = await recordIpFailurePersistent(db, telemetry.ipAddress, 'unknown_id');
          await recordLoginAttemptDoc(db, {
            loginId: cleanId,
            role: 'UNKNOWN',
            success: false,
            outcome: 'ACCOUNT_NOT_FOUND',
            failureReasonCategory: 'ACCOUNT_NOT_FOUND',
            failureReason: 'Login ID does not exist',
            telemetry,
          });
          await recordLoginHistoryEntry(db, {
            req,
            eventType: 'LOGIN_FAILED',
            loginId: cleanId,
            role: 'UNKNOWN',
            success: false,
            failureReason: 'Account not found',
          });
          if (ipRes.triggeredCooldown) {
            await recordSecurityAuditLogDoc(db, {
              action: 'RATE_LIMIT_TRIGGERED',
              severity: 'CRITICAL',
              targetLoginId: cleanId,
              reason: 'Repeated login probes for nonexistent Login IDs',
              details: `Automated unknown-account brute-force probe detected from ${telemetry.ipAddress}. Cooldown: ${ipRes.cooldownSeconds}s.`,
              metadata: { cooldownSeconds: ipRes.cooldownSeconds },
              telemetry,
            });
            return {
              status: 429,
              body: {
                success: false,
                code: 'RATE_LIMITED',
                cooldownSeconds: ipRes.cooldownSeconds,
                error: `Too many invalid authentication requests. Please wait ${ipRes.cooldownSeconds} seconds before trying again.`,
              },
            };
          }
          return {
            status: 401,
            body: {
              success: false,
              code: 'INVALID_CREDENTIALS',
              error: 'Invalid Login ID or password, check again.',
            },
          };
        }

        const userData = userDoc.data() || {};
        const roleUpper = String(userData.role || 'USER').toUpperCase();
        const firebaseUid = String(userData.authUid || userDoc.id);
        const secRef = db.collection('account_security').doc(`sec_${cleanId}`);
        const userRef = db.collection('user_roles').doc(userDoc.id);

        const normalizedUserRole = normalizeRoleValue(userData.role);
        let roleDeactivated = false;
        if (!SYSTEM_ROLE_IDS.has(normalizedUserRole)) {
          const roleDocSnap = await db.collection('roles').doc(normalizedUserRole).get();
          if (roleDocSnap.exists && roleDocSnap.data()?.isActive === false) {
            roleDeactivated = true;
          }
        }

        if (userData.status === 'Inactive' || roleDeactivated) {
          await recordLoginAttemptDoc(db, {
            loginId: cleanId,
            role: roleUpper,
            firebaseUid,
            success: false,
            outcome: 'BLOCKED_INACTIVE',
            failureReasonCategory: roleDeactivated ? 'ROLE_INACTIVE' : 'ACCOUNT_INACTIVE',
            failureReason: roleDeactivated
              ? `Assigned role "${normalizedUserRole}" is Inactive`
              : 'Account status is Inactive',
            telemetry,
          });
          await recordLoginHistoryEntry(db, {
            req,
            eventType: 'LOGIN_FAILED',
            loginId: cleanId,
            authUid: firebaseUid,
            role: roleUpper,
            success: false,
            failureReason: roleDeactivated ? 'Assigned role is Inactive' : 'Account is Inactive',
          });
          return {
            status: 403,
            body: {
              success: false,
              code: roleDeactivated ? 'ROLE_INACTIVE' : 'ACCOUNT_INACTIVE',
              error: roleDeactivated
                ? 'Your assigned role is currently inactive. Please contact Super Admin.'
                : 'Account Deactivated. Please contact Super Admin.',
            },
          };
        }

        const now = new Date().toISOString();
        const deviceSummary = {
          browser: telemetry.uaMeta.browser,
          os: telemetry.uaMeta.os,
          deviceType: telemetry.uaMeta.deviceType,
        };

        const txOutcome = await db.runTransaction(async (tx) => {
          const secSnap = await tx.get(secRef);
          const curSec: Record<string, any> = secSnap.exists
            ? (secSnap.data() || {})
            : {
                id: `sec_${cleanId}`,
                loginId: cleanId,
                role: roleUpper,
                firebaseUid,
                email: userData.email || `${cleanId}@narid.com`,
                lockStatus: userData.isLocked || userData.lockStatus === 'LOCKED' ? 'LOCKED' : 'ACTIVE',
                consecutiveFailedAttempts: Number(userData.consecutiveFailedAttempts || 0),
                maxAttemptsAllowed: MAX_CONSECUTIVE_FAILED_ATTEMPTS,
                totalLoginAttempts: 0,
                totalSuccessfulLogins: 0,
                totalFailedLogins: 0,
                forcePasswordChange: userData.mustChangePassword === true || userData.forcePasswordChange === true,
                lockedAt: userData.lockedAt || null,
                lockReason: userData.lockReason || null,
              };

          const isCurrentlyLocked =
            curSec.lockStatus === 'LOCKED' ||
            userData.lockStatus === 'LOCKED' ||
            userData.isLocked === true;

          if (isCurrentlyLocked) {
            tx.set(
              secRef,
              {
                ...curSec,
                role: roleUpper,
                firebaseUid,
                lockStatus: 'LOCKED',
                totalLoginAttempts: Number(curSec.totalLoginAttempts || 0) + 1,
                lastFailedAt: now,
                lastFailedIp: telemetry.ipAddress,
                lastFailedGeo: telemetry.geoLocation,
                lastFailedDevice: deviceSummary,
                lastFailedReason: 'Attempted login while account LOCKED',
                updatedAt: now,
              },
              { merge: true }
            );

            return {
              kind: 'LOCKED_REJECT' as const,
              consecutiveFailed: Number(curSec.consecutiveFailedAttempts || MAX_CONSECUTIVE_FAILED_ATTEMPTS),
            };
          }

          // Strictly verify against stored scrypt hash ONLY (no hardcoded fallback password)
          const isPasswordValid = userData.passwordHash
            ? verifyPassword(password, String(userData.passwordHash))
            : false;

          if (!isPasswordValid) {
            const nextConsecutive = Number(curSec.consecutiveFailedAttempts || 0) + 1;
            const reachedLock = nextConsecutive >= MAX_CONSECUTIVE_FAILED_ATTEMPTS;

            const secUpdate = {
              ...curSec,
              id: `sec_${cleanId}`,
              loginId: cleanId,
              role: roleUpper,
              firebaseUid,
              email: userData.email || `${cleanId}@narid.com`,
              lockStatus: reachedLock ? 'LOCKED' : 'ACTIVE',
              consecutiveFailedAttempts: nextConsecutive,
              maxAttemptsAllowed: MAX_CONSECUTIVE_FAILED_ATTEMPTS,
              totalLoginAttempts: Number(curSec.totalLoginAttempts || 0) + 1,
              totalFailedLogins: Number(curSec.totalFailedLogins || 0) + 1,
              lastFailedAt: now,
              lastFailedIp: telemetry.ipAddress,
              lastFailedGeo: telemetry.geoLocation,
              lastFailedDevice: deviceSummary,
              lastFailedReason: reachedLock
                ? `Account locked after ${nextConsecutive} consecutive failed password attempts`
                : `Invalid password (Attempt ${nextConsecutive} of ${MAX_CONSECUTIVE_FAILED_ATTEMPTS})`,
              lockedAt: reachedLock ? now : curSec.lockedAt || null,
              lockReason: reachedLock
                ? `Automatically locked after ${nextConsecutive} consecutive failed password attempts`
                : curSec.lockReason || null,
              updatedAt: now,
            };

            tx.set(secRef, secUpdate, { merge: true });
            tx.update(userRef, {
              consecutiveFailedAttempts: nextConsecutive,
              isLocked: reachedLock,
              lockStatus: reachedLock ? 'LOCKED' : 'ACTIVE',
              lockedAt: reachedLock ? now : userData.lockedAt || null,
              lockReason: reachedLock ? secUpdate.lockReason : userData.lockReason || null,
              updatedAt: now,
            });

            return {
              kind: reachedLock ? ('NOW_LOCKED' as const) : ('FAILED_PASSWORD' as const),
              attemptNumber: nextConsecutive,
              remainingAttempts: Math.max(0, MAX_CONSECUTIVE_FAILED_ATTEMPTS - nextConsecutive),
            };
          }

          const mustChange =
            userData.mustChangePassword === true || curSec.forcePasswordChange === true;

          tx.set(
            secRef,
            {
              ...curSec,
              id: `sec_${cleanId}`,
              loginId: cleanId,
              role: roleUpper,
              firebaseUid,
              email: userData.email || `${cleanId}@narid.com`,
              lockStatus: 'ACTIVE',
              consecutiveFailedAttempts: 0,
              maxAttemptsAllowed: MAX_CONSECUTIVE_FAILED_ATTEMPTS,
              totalLoginAttempts: Number(curSec.totalLoginAttempts || 0) + 1,
              totalSuccessfulLogins: Number(curSec.totalSuccessfulLogins || 0) + 1,
              forcePasswordChange: mustChange,
              lastSuccessAt: now,
              lastSuccessIp: telemetry.ipAddress,
              lastSuccessGeo: telemetry.geoLocation,
              lastSuccessDevice: deviceSummary,
              updatedAt: now,
            },
            { merge: true }
          );

          tx.update(userRef, {
            consecutiveFailedAttempts: 0,
            isLocked: false,
            lockStatus: 'ACTIVE',
            lastSuccessLoginAt: now,
            updatedAt: now,
          });

          return {
            kind: 'SUCCESS' as const,
            mustChange,
          };
        });

        if (txOutcome.kind === 'LOCKED_REJECT') {
          await syncUserUidIndex(db, {
            uid: userData.authUid || null,
            roleDocId: userDoc.id,
            role: String(userData.role || 'user'),
            status: String(userData.status || 'Active'),
            lockStatus: 'LOCKED',
            loginId: cleanId,
          });
          const ipRes = await recordIpFailurePersistent(db, telemetry.ipAddress, 'locked_hit', cleanId);
          await Promise.all([
            recordLoginAttemptDoc(db, {
              loginId: cleanId,
              role: roleUpper,
              firebaseUid,
              success: false,
              outcome: 'BLOCKED_LOCKED',
              failureReasonCategory: 'ACCOUNT_LOCKED',
              failureReason: 'Login rejected because account status is LOCKED',
              consecutiveFailedAfter: txOutcome.consecutiveFailed,
              telemetry,
            }),
            recordSecurityAuditLogDoc(db, {
              action: 'LOGIN_BLOCKED_WHILE_LOCKED',
              severity: 'WARNING',
              targetLoginId: cleanId,
              targetRole: roleUpper,
              targetUid: firebaseUid,
              reason: 'Attempted login on locked account',
              details: `Rejected login attempt for locked account "${cleanId}" (${roleUpper}) from IP ${telemetry.ipAddress}.`,
              telemetry,
            }),
            recordLoginHistoryEntry(db, {
              req,
              eventType: 'LOGIN_LOCKED',
              loginId: cleanId,
              authUid: firebaseUid,
              role: roleUpper,
              success: false,
              failureReason: LOCKED_ACCOUNT_MESSAGE,
            }),
            recordEnterpriseAuditEvent(db, {
              req,
              action: 'login_locked_rate_limit',
              category: 'SECURITY',
              severity: 'CRITICAL',
              actorUid: firebaseUid,
              actorLoginId: cleanId,
              actorRole: roleUpper,
              targetId: userDoc.id,
              actionSource: 'ACCOUNT_LOCKOUT_GUARD',
              description: `Blocked login attempt on already locked account "${cleanId}".`,
              success: false,
            }),
          ]);

          if (ipRes.triggeredCooldown) {
            await recordSecurityAuditLogDoc(db, {
              action: 'RATE_LIMIT_TRIGGERED',
              severity: 'CRITICAL',
              targetLoginId: cleanId,
              targetRole: roleUpper,
              targetUid: firebaseUid,
              reason: 'Repeated attempts against locked account triggered progressive IP cooldown',
              details: `IP ${telemetry.ipAddress} triggered ${ipRes.cooldownSeconds}s progressive cooldown after hammering locked account "${cleanId}".`,
              metadata: { cooldownSeconds: ipRes.cooldownSeconds },
              telemetry,
            });
          }

          recordActivityTelemetry(db, {
            actorUid: firebaseUid,
            actorLoginId: cleanId,
            actorRole: roleUpper,
            action: 'LOGIN_BLOCKED_LOCKED',
            module: 'Authentication',
            result: 'Failed',
            correlationId: (req as any).correlationId,
            detail: 'Attempted login on locked account',
          });

          return {
            status: 423,
            body: {
              success: false,
              code: 'ACCOUNT_LOCKED',
              locked: true,
              error: LOCKED_ACCOUNT_MESSAGE,
            },
          };
        }

        if (txOutcome.kind === 'NOW_LOCKED') {
          await syncUserUidIndex(db, {
            uid: userData.authUid || null,
            roleDocId: userDoc.id,
            role: String(userData.role || 'user'),
            status: String(userData.status || 'Active'),
            lockStatus: 'LOCKED',
            loginId: cleanId,
          });
          await recordIpFailurePersistent(db, telemetry.ipAddress, 'password', cleanId);
          await Promise.all([
            recordLoginAttemptDoc(db, {
              loginId: cleanId,
              role: roleUpper,
              firebaseUid,
              success: false,
              outcome: 'FAILED_PASSWORD',
              failureReasonCategory: 'ACCOUNT_LOCKED',
              failureReason: '3rd consecutive failed password attempt triggered automatic account lock',
              attemptNumber: txOutcome.attemptNumber,
              consecutiveFailedAfter: txOutcome.attemptNumber,
              triggeredLock: true,
              telemetry,
            }),
            recordSecurityAuditLogDoc(db, {
              action: 'ACCOUNT_LOCKED',
              severity: 'CRITICAL',
              targetLoginId: cleanId,
              targetRole: roleUpper,
              targetUid: firebaseUid,
              reason: 'Exceeded 3 consecutive failed password attempts',
              details: `SECURITY ALERT: Account "${cleanId}" (${roleUpper}, UID: ${firebaseUid}) automatically LOCKED on failed attempt #${txOutcome.attemptNumber}.`,
              metadata: { attemptNumber: txOutcome.attemptNumber, maxAttempts: MAX_CONSECUTIVE_FAILED_ATTEMPTS },
              telemetry,
            }),
            recordLoginHistoryEntry(db, {
              req,
              eventType: 'LOGIN_LOCKED',
              loginId: cleanId,
              authUid: firebaseUid,
              role: roleUpper,
              success: false,
              failureReason: `Locked after ${txOutcome.attemptNumber} consecutive failed attempts`,
            }),
            recordEnterpriseAuditEvent(db, {
              req,
              action: 'failed_login_threshold_exceeded',
              category: 'SECURITY',
              severity: 'CRITICAL',
              actorUid: firebaseUid,
              actorLoginId: cleanId,
              actorRole: roleUpper,
              targetId: userDoc.id,
              actionSource: 'ACCOUNT_LOCKOUT_ENGINE',
              description: `Account "${cleanId}" (${roleUpper}) automatically LOCKED after ${txOutcome.attemptNumber} consecutive failed password attempts.`,
              success: false,
            }),
          ]);

          recordActivityTelemetry(db, {
            actorUid: firebaseUid,
            actorLoginId: cleanId,
            actorRole: roleUpper,
            action: 'ACCOUNT_LOCKED',
            module: 'Authentication',
            result: 'Failed',
            correlationId: (req as any).correlationId,
            detail: `Auto-locked on attempt #${txOutcome.attemptNumber}`,
          });
          recordErrorTelemetry(db, {
            source: 'AUTH',
            module: 'Authentication',
            category: 'AUTH',
            severity: 'CRITICAL',
            message: `Account locked after ${txOutcome.attemptNumber} failed attempts`,
            statusCode: 423,
            correlationId: (req as any).correlationId,
          });

          return {
            status: 423,
            body: {
              success: false,
              code: 'ACCOUNT_LOCKED',
              locked: true,
              attemptNumber: txOutcome.attemptNumber,
              maxAttempts: MAX_CONSECUTIVE_FAILED_ATTEMPTS,
              remainingAttempts: 0,
              error: LOCKED_ACCOUNT_MESSAGE,
            },
          };
        }

        if (txOutcome.kind === 'FAILED_PASSWORD') {
          await recordIpFailurePersistent(db, telemetry.ipAddress, 'password', cleanId);
          const isSecondWarning = txOutcome.attemptNumber === 2;

          await Promise.all([
            recordLoginAttemptDoc(db, {
              loginId: cleanId,
              role: roleUpper,
              firebaseUid,
              success: false,
              outcome: 'FAILED_PASSWORD',
              failureReasonCategory: 'INVALID_PASSWORD',
              failureReason: isSecondWarning
                ? '2nd consecutive failed attempt (Warning issued: 1 attempt remaining)'
                : `Failed password attempt #${txOutcome.attemptNumber}`,
              attemptNumber: txOutcome.attemptNumber,
              consecutiveFailedAfter: txOutcome.attemptNumber,
              triggeredLock: false,
              telemetry,
            }),
            recordSecurityAuditLogDoc(db, {
              action: isSecondWarning ? 'LOGIN_ATTEMPT_WARNING' : 'LOGIN_ATTEMPT_FAILED',
              severity: 'WARNING',
              targetLoginId: cleanId,
              targetRole: roleUpper,
              targetUid: firebaseUid,
              reason: isSecondWarning ? '2nd consecutive failed password attempt warning' : 'Invalid password attempt',
              details: isSecondWarning
                ? `Warning issued on "${cleanId}" (${roleUpper}): 2 of 3 consecutive failed attempts recorded. Next failure will lock account.`
                : `Failed login attempt #${txOutcome.attemptNumber} for "${cleanId}" (${roleUpper}).`,
              metadata: {
                attemptNumber: txOutcome.attemptNumber,
                remainingAttempts: txOutcome.remainingAttempts,
              },
              telemetry,
            }),
            recordLoginHistoryEntry(db, {
              req,
              eventType: 'LOGIN_FAILED',
              loginId: cleanId,
              authUid: firebaseUid,
              role: roleUpper,
              success: false,
              failureReason: `Incorrect password (Attempt ${txOutcome.attemptNumber} of ${MAX_CONSECUTIVE_FAILED_ATTEMPTS})`,
            }),
            recordEnterpriseAuditEvent(db, {
              req,
              action: 'login_failed',
              category: 'AUTH',
              severity: 'WARNING',
              actorUid: firebaseUid,
              actorLoginId: cleanId,
              actorRole: roleUpper,
              targetId: userDoc.id,
              actionSource: 'AUTH_LOGIN',
              description: `Failed login attempt ${txOutcome.attemptNumber}/${MAX_CONSECUTIVE_FAILED_ATTEMPTS} for "${cleanId}".`,
              success: false,
            }),
          ]);

          recordActivityTelemetry(db, {
            actorUid: firebaseUid,
            actorLoginId: cleanId,
            actorRole: roleUpper,
            action: 'LOGIN_FAILED',
            module: 'Authentication',
            result: 'Failed',
            correlationId: (req as any).correlationId,
            detail: `Invalid password attempt ${txOutcome.attemptNumber}/${MAX_CONSECUTIVE_FAILED_ATTEMPTS}`,
          });

          return {
            status: 401,
            body: isSecondWarning
              ? {
                  success: false,
                  code: 'SECOND_FAILED_WARNING',
                  warning: true,
                  attemptNumber: txOutcome.attemptNumber,
                  maxAttempts: MAX_CONSECUTIVE_FAILED_ATTEMPTS,
                  remainingAttempts: txOutcome.remainingAttempts,
                  error:
                    'Invalid password. Warning: 2 of 3 failed attempts recorded. 1 attempt remaining before your account is locked.',
                }
              : {
                  success: false,
                  code: 'INVALID_PASSWORD',
                  warning: false,
                  attemptNumber: txOutcome.attemptNumber,
                  maxAttempts: MAX_CONSECUTIVE_FAILED_ATTEMPTS,
                  remainingAttempts: txOutcome.remainingAttempts,
                  error: `Invalid password, check again (Attempt ${txOutcome.attemptNumber} of ${MAX_CONSECUTIVE_FAILED_ATTEMPTS}).`,
                },
          };
        }

        // SUCCESSFUL LOGIN -> Clear persistent IP cooldown and sync UID index
        await clearIpCooldownPersistent(db, telemetry.ipAddress, cleanId);
        await syncUserUidIndex(db, {
          uid: userData.authUid || null,
          roleDocId: userDoc.id,
          role: String(userData.role || 'user'),
          status: String(userData.status || 'Active'),
          lockStatus: 'ACTIVE',
          loginId: cleanId,
        });

        const sessionId = `sess_${crypto.randomBytes(10).toString('hex')}`;
        const sessionToken = crypto.randomBytes(32).toString('hex');

        let effectiveModules = Array.isArray(userData.modulesAllowed) ? [...userData.modulesAllowed] : [];
        if (String(userData.role || '').toLowerCase() === 'user' && !userData.dashboardAccessMigratedV1) {
          if (!effectiveModules.includes('dashboard')) {
            effectiveModules = ['dashboard', ...effectiveModules];
          }
        }

        await Promise.all([
          recordLoginAttemptDoc(db, {
            loginId: cleanId,
            role: roleUpper,
            firebaseUid,
            success: true,
            outcome: 'SUCCESS',
            failureReasonCategory: 'NONE',
            consecutiveFailedAfter: 0,
            sessionId,
            telemetry,
          }),
          recordSecurityAuditLogDoc(db, {
            action: 'LOGIN_SUCCESS',
            severity: 'INFO',
            targetLoginId: cleanId,
            targetRole: roleUpper,
            targetUid: firebaseUid,
            actorUid: firebaseUid,
            actorLoginId: cleanId,
            actorRole: roleUpper,
            reason: 'Successful credential verification',
            details: `User "${cleanId}" (${roleUpper}) authenticated successfully. Consecutive failed counter reset to 0.`,
            metadata: { sessionId, forcePasswordChange: txOutcome.mustChange },
            telemetry,
          }),
          recordLoginHistoryEntry(db, {
            req,
            eventType: 'LOGIN_SUCCESS',
            loginId: cleanId,
            authUid: firebaseUid,
            role: roleUpper,
            success: true,
            sessionId,
          }),
          recordEnterpriseAuditEvent(db, {
            req,
            action: 'login_success',
            category: 'AUTH',
            severity: 'INFO',
            actorUid: firebaseUid,
            actorLoginId: cleanId,
            actorRole: roleUpper,
            targetId: userDoc.id,
            actionSource: 'AUTH_LOGIN',
            sessionId,
            description: `User "${cleanId}" (${roleUpper}) successfully authenticated.`,
            success: true,
          }),
        ]);

        recordActivityTelemetry(db, {
          actorUid: firebaseUid,
          actorLoginId: cleanId,
          actorRole: roleUpper,
          action: 'LOGIN_SUCCESS',
          module: 'Authentication',
          result: 'Success',
          correlationId: (req as any).correlationId,
          detail: `Authenticated session ${sessionId}`,
        });

        const { passwordHash: _ph, ...sanitizedProfile } = userData;
        return {
          status: 200,
          body: {
            success: true,
            profile: {
              ...sanitizedProfile,
              id: userDoc.id,
              modulesAllowed: effectiveModules,
              mustChangePassword: txOutcome.mustChange,
              forcePasswordChange: txOutcome.mustChange,
              lockStatus: 'ACTIVE',
              consecutiveFailedAttempts: 0,
            },
            sessionToken,
            sessionId,
          },
        };
      });

      return res.status(result.status).json(result.body);
    } catch (err: any) {
      if (isFirestorePermissionDeniedError(err)) {
        const msg = formatAdminPermissionDeniedError(projectId, TARGET_DATABASE_ID);
        console.warn('[Enterprise Login Security] Firestore IAM notice:', msg);
        return res.status(503).json({
          success: false,
          code: 'FIREBASE_ADMIN_PERMISSION_DENIED',
          error: msg,
        });
      }
      console.error('[Enterprise Login Security] Error:', err);
      return res.status(500).json({
        success: false,
        error: 'Authentication security service error. Please try again.',
      });
    }
  });

  // B. Record Firebase Auth Native Abuse Protection Signal
  app.post('/api/auth/firebase-throttle-signal', async (req: Request, res: Response) => {
    try {
      const cleanId =
        typeof req.body?.loginId === 'string' && req.body.loginId.trim()
          ? req.body.loginId.trim().toLowerCase().slice(0, 64)
          : 'unknown';
      const telemetry = await captureTelemetryContext(db, req);
      const ipRes = await recordIpFailurePersistent(db, telemetry.ipAddress, 'firebase_throttle', cleanId);

      await Promise.all([
        recordLoginAttemptDoc(db, {
          loginId: cleanId,
          role: 'UNKNOWN',
          success: false,
          outcome: 'FIREBASE_TOO_MANY_ATTEMPTS',
          failureReasonCategory: 'FIREBASE_ABUSE_PROTECTION',
          failureReason: 'Firebase Auth TOO_MANY_ATTEMPTS_TRY_LATER triggered',
          telemetry,
        }),
        recordSecurityAuditLogDoc(db, {
          action: 'FIREBASE_TOO_MANY_ATTEMPTS',
          severity: 'CRITICAL',
          targetLoginId: cleanId,
          reason: 'Firebase native abuse protection TOO_MANY_ATTEMPTS_TRY_LATER encountered',
          details: `Firebase Auth enforced TOO_MANY_ATTEMPTS_TRY_LATER for "${cleanId}" from IP ${telemetry.ipAddress}. Automatic retries prevented.`,
          metadata: { cooldownSeconds: ipRes.cooldownSeconds },
          telemetry,
        }),
      ]);

      return res.json({ success: true, cooldownSeconds: ipRes.cooldownSeconds });
    } catch {
      return res.status(200).json({ success: false });
    }
  });

  // C. Super Admin Security Dashboard Overview (Strictly SUPER_ADMIN Only)
  app.get('/api/security/overview', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        ['super_admin'],
        'Security & Login Attempt Management Overview'
      );
      if (!caller) return;

      const [usersSnap, secSnap, attemptsSnap, secLogsSnap] = await Promise.all([
        db.collection('user_roles').get(),
        db.collection('account_security').get(),
        db.collection('login_attempts').get(),
        db.collection('security_audit_logs').get(),
      ]);

      const secByLoginId = new Map<string, any>();
      secSnap.docs.forEach((d) => {
        const data = d.data() || {};
        const key = String(data.loginId || d.id.replace(/^sec_/, '')).trim().toLowerCase();
        secByLoginId.set(key, { id: d.id, ...data });
      });

      const attempts = attemptsSnap.docs
        .map((d) => ({ id: d.id, ...(d.data() || {}) } as any))
        .sort((a, b) => (b.timestampMs || 0) - (a.timestampMs || 0));

      const securityLogs = secLogsSnap.docs
        .map((d) => ({ id: d.id, ...(d.data() || {}) } as any))
        .sort((a, b) => (b.timestampMs || 0) - (a.timestampMs || 0));

      const accountMap = new Map<string, any>();
      usersSnap.docs.forEach((uDoc) => {
        const uData = uDoc.data() || {};
        const loginId = String(uData.loginId || uDoc.id.replace(/^role_/, '')).trim().toLowerCase();
        if (!loginId) return;

        if (accountMap.has(loginId) && uDoc.id !== `role_${loginId}`) {
          return;
        }

        const sec = secByLoginId.get(loginId) || {};
        const accAttempts = attempts.filter((a) => String(a.loginId || '').toLowerCase() === loginId);
        const lockStatus =
          sec.lockStatus === 'LOCKED' || uData.lockStatus === 'LOCKED' || uData.isLocked === true
            ? 'LOCKED'
            : 'ACTIVE';

        accountMap.set(loginId, {
          id: sec.id || `sec_${loginId}`,
          roleDocId: uDoc.id,
          loginId,
          name: uData.name || loginId.toUpperCase(),
          email: uData.email || `${loginId}@narid.com`,
          role: String(uData.role || 'USER').toUpperCase(),
          firebaseUid: sec.firebaseUid || uData.authUid || uDoc.id,
          accountStatus: uData.status || 'Active',
          lockStatus,
          consecutiveFailedAttempts: Number(
            sec.consecutiveFailedAttempts ?? uData.consecutiveFailedAttempts ?? 0
          ),
          maxAttemptsAllowed: MAX_CONSECUTIVE_FAILED_ATTEMPTS,
          totalLoginAttempts: Number(sec.totalLoginAttempts ?? accAttempts.length),
          totalSuccessfulLogins: Number(
            sec.totalSuccessfulLogins ?? accAttempts.filter((a) => a.success === true).length
          ),
          totalFailedLogins: Number(
            sec.totalFailedLogins ?? accAttempts.filter((a) => a.success === false).length
          ),
          forcePasswordChange: Boolean(uData.mustChangePassword === true || sec.forcePasswordChange === true),
          mustChangePassword: Boolean(uData.mustChangePassword === true),
          lockedAt: sec.lockedAt || uData.lockedAt || null,
          lockReason: sec.lockReason || uData.lockReason || null,
          lastSuccessAt: sec.lastSuccessAt || uData.lastSuccessLoginAt || null,
          lastSuccessIp: sec.lastSuccessIp || null,
          lastSuccessGeo: sec.lastSuccessGeo || null,
          lastSuccessDevice: sec.lastSuccessDevice || null,
          lastFailedAt: sec.lastFailedAt || null,
          lastFailedIp: sec.lastFailedIp || null,
          lastFailedGeo: sec.lastFailedGeo || null,
          lastFailedDevice: sec.lastFailedDevice || null,
          lastFailedReason: sec.lastFailedReason || null,
          unblockedByUid: sec.unblockedByUid || null,
          unblockedByLoginId: sec.unblockedByLoginId || null,
          unblockedAt: sec.unblockedAt || null,
          unblockReason: sec.unblockReason || null,
          tempPasswordResetByUid: sec.tempPasswordResetByUid || null,
          tempPasswordResetByLoginId: sec.tempPasswordResetByLoginId || null,
          tempPasswordResetAt: sec.tempPasswordResetAt || uData.passwordResetAt || null,
          passwordLastChangedAt: uData.passwordLastChangedAt || null,
          updatedAt: sec.updatedAt || uData.updatedAt || null,
        });
      });

      const roleOrder: Record<string, number> = { SUPER_ADMIN: 0, ADMIN: 1, USER: 2 };
      const accounts = Array.from(accountMap.values()).sort((a, b) => {
        const ao = roleOrder[a.role] ?? 9;
        const bo = roleOrder[b.role] ?? 9;
        if (ao !== bo) return ao - bo;
        return a.loginId.localeCompare(b.loginId);
      });

      const kpis = {
        totalLoginAttempts: attempts.length,
        successfulLogins: attempts.filter((a) => a.success === true).length,
        failedLogins: attempts.filter((a) => a.success === false).length,
        currentlyLockedAccounts: accounts.filter((a) => a.lockStatus === 'LOCKED').length,
        accountsWithForcePasswordChange: accounts.filter((a) => a.forcePasswordChange).length,
        rateLimitAlerts: attempts.filter(
          (a) => a.outcome === 'BLOCKED_RATE_LIMIT' || a.outcome === 'FIREBASE_TOO_MANY_ATTEMPTS'
        ).length,
      };

      return res.json({
        success: true,
        kpis,
        accounts,
        recentAttempts: attempts.slice(0, 150),
        recentSecurityLogs: securityLogs.slice(0, 150),
      });
    } catch (err: any) {
      if (isFirestorePermissionDeniedError(err)) {
        const msg = formatAdminPermissionDeniedError(projectId, TARGET_DATABASE_ID);
        return res.status(503).json({ success: false, code: 'FIREBASE_ADMIN_PERMISSION_DENIED', error: msg });
      }
      console.error('[Security Overview API] Error:', err);
      return res.status(500).json({
        success: false,
        error: err?.message || 'Failed to load security overview.',
      });
    }
  });

  // D. Filterable Login Attempts History (Strictly SUPER_ADMIN Only)
  app.get('/api/security/attempts', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        ['super_admin'],
        'Security Login Attempts Query'
      );
      if (!caller) return;

      const {
        loginId = 'ALL',
        outcome = 'ALL',
        search = '',
        limit = '250',
      } = req.query as Record<string, string>;

      const snap = await db.collection('login_attempts').get();
      let rows = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() || {}) } as any))
        .sort((a, b) => (b.timestampMs || 0) - (a.timestampMs || 0));

      const q = search.trim().toLowerCase();
      rows = rows.filter((r) => {
        if (loginId !== 'ALL' && String(r.loginId || '').toLowerCase() !== loginId.toLowerCase()) {
          return false;
        }
        if (outcome === 'SUCCESS' && !r.success) return false;
        if (outcome === 'FAILURE' && r.success) return false;
        if (outcome !== 'ALL' && outcome !== 'SUCCESS' && outcome !== 'FAILURE' && r.outcome !== outcome) {
          return false;
        }
        if (q) {
          const hay = `${r.loginId} ${r.role} ${r.ipAddress} ${r.browser} ${r.os} ${r.failureReason || ''} ${r.geoLocation?.city || ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });

      const maxLimit = Math.min(500, Math.max(10, parseInt(limit, 10) || 250));
      return res.json({ success: true, attempts: rows.slice(0, maxLimit) });
    } catch (err: any) {
      if (isFirestorePermissionDeniedError(err)) {
        const msg = formatAdminPermissionDeniedError(projectId, TARGET_DATABASE_ID);
        return res.status(503).json({ success: false, code: 'FIREBASE_ADMIN_PERMISSION_DENIED', error: msg });
      }
      console.error('[Security Attempts API] Error:', err);
      return res.status(500).json({ success: false, error: 'Failed to load login attempts.' });
    }
  });

  // E. Security Governance Audit Logs (Strictly SUPER_ADMIN Only)
  app.get('/api/security/audit-logs', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        ['super_admin'],
        'Security Governance Audit Logs'
      );
      if (!caller) return;

      const {
        loginId = 'ALL',
        action = 'ALL',
        severity = 'ALL',
        search = '',
      } = req.query as Record<string, string>;

      const snap = await db.collection('security_audit_logs').get();
      let rows = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() || {}) } as any))
        .sort((a, b) => (b.timestampMs || 0) - (a.timestampMs || 0));

      const q = search.trim().toLowerCase();
      rows = rows.filter((r) => {
        if (loginId !== 'ALL' && String(r.targetLoginId || '').toLowerCase() !== loginId.toLowerCase()) {
          return false;
        }
        if (action !== 'ALL' && r.action !== action) return false;
        if (severity !== 'ALL' && r.severity !== severity) return false;
        if (q) {
          const hay = `${r.action} ${r.targetLoginId} ${r.actorLoginId} ${r.ipAddress} ${r.reason} ${r.details}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });

      return res.json({ success: true, logs: rows.slice(0, 300) });
    } catch (err: any) {
      if (isFirestorePermissionDeniedError(err)) {
        const msg = formatAdminPermissionDeniedError(projectId, TARGET_DATABASE_ID);
        return res.status(503).json({ success: false, code: 'FIREBASE_ADMIN_PERMISSION_DENIED', error: msg });
      }
      console.error('[Security Audit Logs API] Error:', err);
      return res.status(500).json({ success: false, error: 'Failed to load security audit logs.' });
    }
  });

  // F. Super Admin Account Unblock Workflow (Atomic Transaction + Persistent Cooldown Clear)
  app.post('/api/security/unblock-account', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        ['super_admin'],
        'Unblock Locked Account'
      );
      if (!caller) return;

      const parsed = UnblockAccountSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: parsed.error.issues[0]?.message || 'Invalid unblock payload.',
        });
      }

      const cleanTargetId = parsed.data.targetLoginId.trim().toLowerCase();
      const reason = parsed.data.reason.trim();
      const telemetry = await captureTelemetryContext(db, req);

      const unblockResult = await withLoginIdLock(cleanTargetId, async () => {
        const docId = `role_${cleanTargetId}`;
        let userDoc = await db.collection('user_roles').doc(docId).get();
        if (!userDoc.exists) {
          const snap = await db.collection('user_roles').where('loginId', '==', cleanTargetId).limit(1).get();
          if (!snap.empty) userDoc = snap.docs[0];
        }

        if (!userDoc || !userDoc.exists) {
          return { notFound: true as const };
        }

        const userData = userDoc.data() || {};
        const targetRole = String(userData.role || 'USER').toUpperCase();
        const firebaseUid = String(userData.authUid || userDoc.id);
        const secRef = db.collection('account_security').doc(`sec_${cleanTargetId}`);
        const userRef = db.collection('user_roles').doc(userDoc.id);
        const now = new Date().toISOString();

        let previousState: any = {};

        await db.runTransaction(async (tx) => {
          const secSnap = await tx.get(secRef);
          const curSec = secSnap.exists ? (secSnap.data() || {}) : {};
          previousState = {
            lockStatus: curSec.lockStatus || userData.lockStatus || 'ACTIVE',
            consecutiveFailedAttempts: Number(
              curSec.consecutiveFailedAttempts ?? userData.consecutiveFailedAttempts ?? 0
            ),
            lockedAt: curSec.lockedAt || userData.lockedAt || null,
          };

          tx.set(
            secRef,
            {
              id: `sec_${cleanTargetId}`,
              loginId: cleanTargetId,
              role: targetRole,
              firebaseUid,
              email: userData.email || `${cleanTargetId}@narid.com`,
              lockStatus: 'ACTIVE',
              consecutiveFailedAttempts: 0,
              maxAttemptsAllowed: MAX_CONSECUTIVE_FAILED_ATTEMPTS,
              lockedAt: null,
              lockReason: null,
              unblockedByUid: caller.uid,
              unblockedByLoginId: caller.loginId,
              unblockedAt: now,
              unblockReason: reason,
              updatedAt: now,
            },
            { merge: true }
          );

          tx.update(userRef, {
            isLocked: false,
            lockStatus: 'ACTIVE',
            consecutiveFailedAttempts: 0,
            lockedAt: null,
            lockReason: null,
            unblockedBy: caller.loginId,
            unblockedAt: now,
            updatedAt: now,
          });
        });

        await syncUserUidIndex(db, {
          uid: userData.authUid || null,
          roleDocId: userDoc.id,
          role: String(userData.role || 'user'),
          status: String(userData.status || 'Active'),
          lockStatus: 'ACTIVE',
          loginId: cleanTargetId,
        });

        await clearIpCooldownPersistent(db, undefined, cleanTargetId);

        await Promise.all([
          recordSecurityAuditLogDoc(db, {
            action: 'ACCOUNT_UNBLOCKED',
            severity: 'CRITICAL',
            targetLoginId: cleanTargetId,
            targetRole,
            targetUid: firebaseUid,
            actorUid: caller.uid,
            actorLoginId: caller.loginId,
            actorRole: 'SUPER_ADMIN',
            reason,
            details: `Super Admin "${caller.loginId}" unblocked account "${cleanTargetId}" (${targetRole}, UID: ${firebaseUid}). Failed attempts reset from ${previousState.consecutiveFailedAttempts} to 0. Reason: ${reason}`,
            metadata: { previousState, newStatus: 'ACTIVE' },
            telemetry,
          }),
          recordEnterpriseAuditEvent(db, {
            req,
            action: 'account_unblocked',
            category: 'SECURITY',
            severity: 'CRITICAL',
            actorUid: caller.uid,
            actorLoginId: caller.loginId,
            actorRole: 'SUPER_ADMIN',
            targetType: 'ACCOUNT',
            targetId: userDoc.id,
            oldValue: previousState,
            newValue: { lockStatus: 'ACTIVE', consecutiveFailedAttempts: 0, reason },
            actionSource: 'SECURITY_CONTROL_UNBLOCK',
            reason,
            description: `Super Admin "${caller.loginId}" unblocked "${cleanTargetId}" (${targetRole}).`,
          }),
        ]);

        return {
          notFound: false as const,
          targetLoginId: cleanTargetId,
          targetRole,
          firebaseUid,
          unblockedAt: now,
        };
      });

      if (unblockResult.notFound) {
        return res.status(404).json({
          success: false,
          error: `Account "${cleanTargetId}" not found.`,
        });
      }

      return res.json({
        success: true,
        message: `Account "${cleanTargetId}" has been unblocked (LOCKED -> ACTIVE) and consecutive failed attempts reset to 0.`,
        ...unblockResult,
      });
    } catch (err: any) {
      console.error('[Security Unblock API] Error:', err);
      return res.status(500).json({
        success: false,
        error: err?.message || 'Failed to unblock account.',
      });
    }
  });

  // G. Super Admin Firebase Admin SDK Live Inspection Status (Read-Only)
  app.get('/api/security/firebase-admin-status', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        ['super_admin'],
        'Inspect Firebase Admin SDK & Auth Mapping Status'
      );
      if (!caller) return;

      const status = await inspectFirebaseAuthStatus(projectId, db, auth);
      return res.json({
        success: true,
        ...status,
      });
    } catch (err: any) {
      console.error('[Security Firebase Admin Status API] Error:', err);
      return res.status(500).json({
        success: false,
        error: err?.message || 'Failed to inspect Firebase Admin SDK status.',
      });
    }
  });

  // H. Super Admin Temporary Password Generation
  app.post('/api/security/generate-temp-password', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        ['super_admin'],
        'Generate Temporary Password'
      );
      if (!caller) return;

      const parsed = GenerateTempPasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: parsed.error.issues[0]?.message || 'Invalid temporary password request.',
        });
      }

      const cleanTargetId = parsed.data.targetLoginId.trim().toLowerCase();
      const reason = parsed.data.reason.trim();
      const freshPassword = parsed.data.freshSuperAdminPassword;
      const telemetry = await captureTelemetryContext(db, req);

      const nowSec = Math.floor(Date.now() / 1000);
      const isRecentTokenAuth =
        typeof caller.authTime === 'number' && nowSec - caller.authTime <= 300;

      let freshAuthVerified = false;
      if (freshPassword && freshPassword.length > 0) {
        const callerDoc = await db.collection('user_roles').doc(caller.profileDocId).get();
        const callerHash = callerDoc.exists ? callerDoc.data()?.passwordHash : null;
        if (callerHash && verifyPassword(freshPassword, String(callerHash))) {
          freshAuthVerified = true;
        } else {
          await recordSecurityAuditLogDoc(db, {
            action: 'UNAUTHORIZED_SECURITY_ACCESS',
            severity: 'CRITICAL',
            targetLoginId: cleanTargetId,
            actorUid: caller.uid,
            actorLoginId: caller.loginId,
            actorRole: 'SUPER_ADMIN',
            reason: 'Failed fresh Super Admin password verification for temp password generation',
            details: `Super Admin "${caller.loginId}" entered an incorrect password during fresh re-authentication check for resetting "${cleanTargetId}".`,
            telemetry,
          });
          return res.status(401).json({
            success: false,
            requiresFreshAuth: true,
            error: 'Fresh Super Admin authentication failed: Incorrect Super Admin password.',
          });
        }
      } else if (isRecentTokenAuth) {
        freshAuthVerified = true;
      }

      if (!freshAuthVerified) {
        return res.status(401).json({
          success: false,
          requiresFreshAuth: true,
          error:
            'Fresh Super Admin authentication is required before generating a temporary password. Please enter your current Super Admin password.',
        });
      }

      const temporaryPassword = generateStrongTemporaryPassword(14);
      const newHash = hashPassword(temporaryPassword);

      const result = await withLoginIdLock(cleanTargetId, async () => {
        const docId = `role_${cleanTargetId}`;
        let userDoc = await db.collection('user_roles').doc(docId).get();
        if (!userDoc.exists) {
          const snap = await db.collection('user_roles').where('loginId', '==', cleanTargetId).limit(1).get();
          if (!snap.empty) userDoc = snap.docs[0];
        }

        if (!userDoc || !userDoc.exists) {
          return { notFound: true as const };
        }

        const userData = userDoc.data() || {};
        const targetRole = String(userData.role || 'USER').toUpperCase();
        const rawEmail = String(userData.email || `${cleanTargetId}@narid.com`).trim().toLowerCase();
        const canonicalEmail = `${cleanTargetId}@narid.com`;
        const targetEmail =
          rawEmail.endsWith('_root@narid.com') &&
          Array.isArray(userData.emailAliases) &&
          userData.emailAliases.includes(canonicalEmail)
            ? canonicalEmail
            : rawEmail;
        const targetUid = String(userData.authUid || userData.uid || userDoc.id);
        const now = new Date().toISOString();

        let firebaseAuthSynced = false;
        let syncErrorReason = '';
        let adminSdkAvailable = false;
        let rateLimited = false;

        const adminAttempt = await tryAdminAuthUpdatePassword(projectId, targetUid, temporaryPassword, auth);
        adminSdkAvailable = adminAttempt.adminSdkAvailable;
        if (adminAttempt.updated) {
          firebaseAuthSynced = true;
        } else {
          syncErrorReason = adminAttempt.reason || '';
          if (targetUid && !targetUid.startsWith('role_')) {
            const syncRes = await syncExistingFirebaseAuthPassword(
              targetEmail,
              targetUid,
              temporaryPassword
            );
            if (syncRes.success) {
              firebaseAuthSynced = true;
            } else {
              rateLimited = Boolean(syncRes.rateLimited);
              if (syncRes.error) {
                syncErrorReason = syncRes.error;
              }
            }
          }
        }

        if (!firebaseAuthSynced) {
          await recordSecurityAuditLogDoc(db, {
            action: 'TEMP_PASSWORD_SYNC_FAILED',
            severity: 'CRITICAL',
            targetLoginId: cleanTargetId,
            targetRole,
            targetUid,
            actorUid: caller.uid,
            actorLoginId: caller.loginId,
            actorRole: 'SUPER_ADMIN',
            reason,
            details: `Aborted temporary password generation for "${cleanTargetId}" (UID: ${targetUid}) because Firebase Authentication could not be updated in-place. Firestore passwordHash was left UNCHANGED to prevent credential divergence. Reason: ${syncErrorReason}`,
            metadata: {
              adminSdkAvailable,
              rateLimited,
              uidPreserved: targetUid,
            },
            telemetry,
          });

          return {
            notFound: false as const,
            syncFailed: true as const,
            rateLimited,
            adminSdkAvailable,
            targetLoginId: cleanTargetId,
            firebaseUid: targetUid,
            error:
              rateLimited
                ? 'Firebase Auth rate limit (TOO_MANY_ATTEMPTS_TRY_LATER) blocked in-place sync. Firestore passwordHash was kept unchanged.'
                : `Firebase Authentication password update failed for "${targetEmail}" (UID: ${targetUid}). Firestore passwordHash was NOT modified to prevent mismatch. ${syncErrorReason}`.trim(),
          };
        }

        const userRef = db.collection('user_roles').doc(userDoc.id);
        const secRef = db.collection('account_security').doc(`sec_${cleanTargetId}`);

        const tempPassUpdates = {
          passwordHash: newHash,
          mustChangePassword: true,
          forcePasswordChange: true,
          passwordLastChangedAt: now,
          passwordResetBy: caller.loginId,
          passwordResetAt: now,
          sessionRevokedAt: now,
          updatedAt: now,
        };

        await db.runTransaction(async (tx) => {
          const secSnap = await tx.get(secRef);
          const curSec = secSnap.exists ? (secSnap.data() || {}) : {};

          tx.update(userRef, tempPassUpdates);

          tx.set(
            secRef,
            {
              ...curSec,
              id: `sec_${cleanTargetId}`,
              loginId: cleanTargetId,
              role: targetRole,
              firebaseUid: targetUid,
              email: targetEmail,
              forcePasswordChange: true,
              tempPasswordResetByUid: caller.uid,
              tempPasswordResetByLoginId: caller.loginId,
              tempPasswordResetAt: now,
              updatedAt: now,
            },
            { merge: true }
          );
        });

        const matchingDocs = await db
          .collection('user_roles')
          .where('loginId', '==', cleanTargetId)
          .get();
        for (const mDoc of matchingDocs.docs) {
          if (mDoc.id !== userDoc.id) {
            await db.collection('user_roles').doc(mDoc.id).update(tempPassUpdates);
          }
        }

        const resetLogId = `reset_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
        await Promise.all([
          db.collection('password_reset_logs').doc(resetLogId).set({
            id: resetLogId,
            targetLoginId: cleanTargetId,
            targetName: userData.name || cleanTargetId,
            targetRole,
            performedByLoginId: caller.loginId,
            performedByUid: caller.uid,
            timestamp: now,
            forcedPasswordChange: true,
            accountUnlocked: false,
            sessionsRevoked: true,
            reason,
          }),
          recordSecurityAuditLogDoc(db, {
            action: 'TEMP_PASSWORD_GENERATED',
            severity: 'CRITICAL',
            targetLoginId: cleanTargetId,
            targetRole,
            targetUid,
            actorUid: caller.uid,
            actorLoginId: caller.loginId,
            actorRole: 'SUPER_ADMIN',
            reason,
            details: `Super Admin "${caller.loginId}" generated a one-time temporary password for "${cleanTargetId}" (${targetRole}, UID: ${targetUid}). Mandatory change on next login enforced.`,
            metadata: {
              forcePasswordChange: true,
              firebaseAuthSynced: true,
              uidPreserved: targetUid,
            },
            telemetry,
          }),
          recordEnterpriseAuditEvent(db, {
            req,
            action: 'admin_password_reset',
            category: 'ACCOUNT',
            severity: 'CRITICAL',
            actorUid: caller.uid,
            actorLoginId: caller.loginId,
            actorRole: 'SUPER_ADMIN',
            targetType: 'ACCOUNT',
            targetId: userDoc.id,
            newValue: {
              targetLoginId: cleanTargetId,
              targetRole,
              forcePasswordChange: true,
              firebaseAuthSynced: true,
            },
            actionSource: 'SECURITY_CONTROL_TEMP_PASSWORD',
            reason,
            description: `Temporary password generated by Super Admin "${caller.loginId}" for "${cleanTargetId}". UID ${targetUid} preserved.`,
          }),
        ]);

        return {
          notFound: false as const,
          syncFailed: false as const,
          targetLoginId: cleanTargetId,
          targetRole,
          firebaseUid: targetUid,
          firebaseAuthSynced: true,
          generatedAt: now,
        };
      });

      if (result.notFound) {
        return res.status(404).json({
          success: false,
          error: `Account "${cleanTargetId}" not found.`,
        });
      }

      if (result.syncFailed) {
        return res.status(result.rateLimited ? 429 : 422).json({
          success: false,
          code: result.rateLimited ? 'FIREBASE_TOO_MANY_ATTEMPTS' : 'FIREBASE_AUTH_SYNC_FAILED',
          firebaseAuthSynced: false,
          adminSdkConfigured: result.adminSdkAvailable,
          targetLoginId: result.targetLoginId,
          firebaseUid: result.firebaseUid,
          error: result.error,
        });
      }

      return res.json({
        success: true,
        targetLoginId: result.targetLoginId,
        targetRole: result.targetRole,
        firebaseUid: result.firebaseUid,
        temporaryPassword,
        forcePasswordChange: true,
        firebaseAuthSynced: result.firebaseAuthSynced,
        generatedAt: result.generatedAt,
        message: `One-time temporary password generated for "${result.targetLoginId}" and synced in Firebase Auth (UID: ${result.firebaseUid}). Password change is mandatory on next login.`,
      });
    } catch (err: any) {
      if (isFirestorePermissionDeniedError(err)) {
        const msg = formatAdminPermissionDeniedError(projectId, TARGET_DATABASE_ID);
        return res.status(503).json({ success: false, code: 'FIREBASE_ADMIN_PERMISSION_DENIED', error: msg });
      }
      console.error('[Security Generate Temp Password API] Error:', err);
      return res.status(500).json({
        success: false,
        error: err?.message || 'Failed to generate temporary password.',
      });
    }
  });
}
