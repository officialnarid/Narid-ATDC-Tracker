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
  isCanonicalSuperAdminAccount,
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

export const SUPER_ADMIN_PROGRESSIVE_LOCK_MINUTES = [10, 20, 30, 60] as const;
export const DEFAULT_SUPER_ADMIN_LOCKOUT_RESET_HOURS = 24;
export const MIN_SUPER_ADMIN_LOCKOUT_RESET_HOURS = 6;
export const MAX_SUPER_ADMIN_LOCKOUT_RESET_HOURS = 720;

export function computeSuperAdminLockDurationMinutes(progressiveLockLevel: number): number {
  const safeLevel = Math.max(1, Math.floor(Number(progressiveLockLevel) || 1));
  const idx = Math.min(safeLevel - 1, SUPER_ADMIN_PROGRESSIVE_LOCK_MINUTES.length - 1);
  return SUPER_ADMIN_PROGRESSIVE_LOCK_MINUTES[idx];
}

export function formatLockoutDurationText(remainingSeconds: number): string {
  const safeSec = Math.max(1, Math.ceil(Number(remainingSeconds) || 0));
  const mins = Math.floor(safeSec / 60);
  const secs = safeSec % 60;
  if (mins <= 0) {
    return `${secs} second${secs === 1 ? '' : 's'}`;
  }
  if (secs === 0) {
    return `${mins} minute${mins === 1 ? '' : 's'}`;
  }
  return `${mins}m ${String(secs).padStart(2, '0')}s`;
}

export async function resolveSuperAdminLockoutResetHours(db: AdminFirestoreLike): Promise<number> {
  let candidate: number | null = null;
  try {
    const snap = await db.collection('system_settings').doc('global').get();
    if (snap.exists) {
      const val = Number(snap.data()?.superAdminLockoutResetHours);
      if (Number.isFinite(val) && val > 0) {
        candidate = val;
      }
    }
  } catch {
    // non-blocking fallback to env/default
  }
  if (candidate === null && process.env.SUPER_ADMIN_LOCKOUT_RESET_HOURS) {
    const envVal = Number(process.env.SUPER_ADMIN_LOCKOUT_RESET_HOURS);
    if (Number.isFinite(envVal) && envVal > 0) {
      candidate = envVal;
    }
  }
  if (candidate === null) {
    candidate = DEFAULT_SUPER_ADMIN_LOCKOUT_RESET_HOURS;
  }
  return Math.min(
    MAX_SUPER_ADMIN_LOCKOUT_RESET_HOURS,
    Math.max(MIN_SUPER_ADMIN_LOCKOUT_RESET_HOURS, Math.round(candidate))
  );
}

export function resolveAuthoritativeLockedUntilMs(
  secData?: Record<string, any> | null,
  userData?: Record<string, any> | null
): number | null {
  const candidates: unknown[] = [
    secData?.lockedUntilMs,
    userData?.lockedUntilMs,
    secData?.lockoutUntil,
    secData?.lockedUntil,
    userData?.lockoutUntil,
    userData?.lockedUntil,
  ];
  for (const val of candidates) {
    if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
      return val;
    }
    if (typeof val === 'string' && val.trim()) {
      const parsed = Date.parse(val.trim());
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return null;
}

export function resolveAuthoritativeLockedUntilIso(
  lockedUntilMs: number | null,
  secData?: Record<string, any> | null,
  userData?: Record<string, any> | null
): string | null {
  if (lockedUntilMs === null) return null;
  const rawIso =
    secData?.lockoutUntil ||
    secData?.lockedUntil ||
    userData?.lockoutUntil ||
    userData?.lockedUntil;
  if (typeof rawIso === 'string' && rawIso.trim() && Number.isFinite(Date.parse(rawIso.trim()))) {
    return rawIso.trim();
  }
  return new Date(lockedUntilMs).toISOString();
}

export function resolveCanonicalSuperAdminLockWindow(
  secData?: Record<string, any> | null,
  userData?: Record<string, any> | null
): {
  lockedUntilMs: number | null;
  lockoutUntil: string | null;
  lockDurationMinutes: number | null;
} {
  const explicitMs = resolveAuthoritativeLockedUntilMs(secData, userData);
  const explicitDuration =
    typeof secData?.lockDurationMinutes === 'number' && Number.isFinite(secData.lockDurationMinutes)
      ? secData.lockDurationMinutes
      : typeof userData?.lockDurationMinutes === 'number' && Number.isFinite(userData.lockDurationMinutes)
        ? userData.lockDurationMinutes
        : null;

  if (explicitMs !== null) {
    const level = Math.max(
      1,
      Number(secData?.progressiveLockLevel ?? userData?.progressiveLockLevel ?? 1)
    );
    return {
      lockedUntilMs: explicitMs,
      lockoutUntil: resolveAuthoritativeLockedUntilIso(explicitMs, secData, userData),
      lockDurationMinutes: explicitDuration ?? computeSuperAdminLockDurationMinutes(level),
    };
  }

  // Legacy lock compatibility for canonical Super Admin ONLY:
  // If a pre-policy lock recorded lockStatus='LOCKED' without lockoutUntil, anchor to lockedAt + progressive duration
  const anchorCandidates = [
    secData?.lockedAt,
    userData?.lockedAt,
    secData?.lastFailedAt,
    secData?.updatedAt,
    userData?.updatedAt,
  ];
  let anchorMs: number | null = null;
  for (const raw of anchorCandidates) {
    if (typeof raw === 'string' && raw.trim()) {
      const parsed = Date.parse(raw.trim());
      if (Number.isFinite(parsed) && parsed > 0) {
        anchorMs = parsed;
        break;
      }
    }
  }
  if (anchorMs === null) {
    return { lockedUntilMs: null, lockoutUntil: null, lockDurationMinutes: explicitDuration };
  }

  const effectiveLevel = Math.max(
    1,
    Number(secData?.progressiveLockLevel ?? userData?.progressiveLockLevel ?? 1)
  );
  const derivedDuration = explicitDuration ?? computeSuperAdminLockDurationMinutes(effectiveLevel);
  const derivedUntilMs = anchorMs + derivedDuration * 60 * 1000;
  return {
    lockedUntilMs: derivedUntilMs,
    lockoutUntil: new Date(derivedUntilMs).toISOString(),
    lockDurationMinutes: derivedDuration,
  };
}

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
  loginId?: string,
  nowMs?: number
): Promise<{
  allowed: boolean;
  cooldownSeconds?: number;
  reason?: string;
}> {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
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
  loginId?: string,
  nowMs?: number
): Promise<{ triggeredCooldown: boolean; cooldownSeconds: number }> {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
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
    lockDurationMinutes?: number | null;
    lockedUntil?: string | null;
    sessionId?: string | null;
    nowMs?: number;
    telemetry: AttemptTelemetryContext;
  }
): Promise<string> {
  const effectiveNowMs = typeof params.nowMs === 'number' ? params.nowMs : Date.now();
  const now = new Date(effectiveNowMs).toISOString();
  const attemptId = `att_${effectiveNowMs}_${crypto.randomBytes(4).toString('hex')}`;

  await db.collection('login_attempts').doc(attemptId).set({
    id: attemptId,
    loginId: params.loginId.trim().toLowerCase(),
    role: String(params.role || 'UNKNOWN').toUpperCase(),
    firebaseUid: params.firebaseUid || null,
    timestamp: now,
    timestampMs: effectiveNowMs,
    success: params.success,
    outcome: params.outcome,
    failureReasonCategory: params.failureReasonCategory,
    failureReason: params.failureReason ? String(params.failureReason).slice(0, 500) : null,
    attemptNumber: params.attemptNumber ?? null,
    consecutiveFailedAfter: params.consecutiveFailedAfter ?? null,
    triggeredLock: Boolean(params.triggeredLock),
    lockDurationMinutes: params.lockDurationMinutes ?? null,
    lockoutUntil: params.lockedUntil ?? null,
    lockedUntil: params.lockedUntil ?? null,
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
      | 'LOCKOUT_EXPIRED_REACTIVATED'
      | 'LOGIN_SUCCESS_AFTER_LOCKOUT'
      | 'LOCKOUT_LEVEL_RESET'
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
    nowMs?: number;
    telemetry: AttemptTelemetryContext;
  }
): Promise<string> {
  const effectiveNowMs = typeof params.nowMs === 'number' ? params.nowMs : Date.now();
  const now = new Date(effectiveNowMs).toISOString();
  const logId = `saud_${effectiveNowMs}_${crypto.randomBytes(4).toString('hex')}`;

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
    timestampMs: effectiveNowMs,
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
          lockedUntilMs: typeof uData.lockedUntilMs === 'number' ? uData.lockedUntilMs : null,
          loginId,
        });
      }

      const secId = `sec_${loginId}`;
      const secRef = db.collection('account_security').doc(secId);
      const secSnap = await secRef.get();
      const isCanonicalSA = isCanonicalSuperAdminAccount(uDoc.id, uData);

      if (!secSnap.exists) {
        await secRef.set({
          id: secId,
          loginId,
          role: String(uData.role || 'USER').toUpperCase(),
          firebaseUid: uData.authUid || uDoc.id,
          email: uData.email || `${loginId}@narid.com`,
          lockStatus: uData.isLocked || uData.lockStatus === 'LOCKED' ? 'LOCKED' : 'ACTIVE',
          lockPolicyType: isCanonicalSA ? 'PROGRESSIVE_TEMPORARY' : 'PERMANENT_MANUAL',
          consecutiveFailedAttempts: Number(uData.consecutiveFailedAttempts || 0),
          maxAttemptsAllowed: MAX_CONSECUTIVE_FAILED_ATTEMPTS,
          totalLoginAttempts: 0,
          totalSuccessfulLogins: 0,
          totalFailedLogins: 0,
          forcePasswordChange: uData.mustChangePassword === true || uData.forcePasswordChange === true,
          lockedAt: uData.lockedAt || null,
          lockoutUntil: uData.lockoutUntil || uData.lockedUntil || null,
          lockedUntil: uData.lockedUntil || uData.lockoutUntil || null,
          lockedUntilMs: typeof uData.lockedUntilMs === 'number' ? uData.lockedUntilMs : null,
          lockDurationMinutes:
            typeof uData.lockDurationMinutes === 'number' ? uData.lockDurationMinutes : null,
          lockReason: uData.lockReason || null,
          progressiveLockLevel: Number(uData.progressiveLockLevel || 0),
          totalLockoutEvents: Number(uData.totalLockoutEvents || 0),
          lastLockoutAt: uData.lastLockoutAt || null,
          lastLockExpiredAt: uData.lastLockExpiredAt || null,
          cleanWindowStartAt: uData.cleanWindowStartAt || null,
          cleanWindowStartMs:
            typeof uData.cleanWindowStartMs === 'number' ? uData.cleanWindowStartMs : null,
          cleanLoginsSinceLastLockout: Number(uData.cleanLoginsSinceLastLockout || 0),
          pendingPostLockoutLoginAudit: Boolean(uData.pendingPostLockoutLoginAudit),
          lockoutLevelResetAt: uData.lockoutLevelResetAt || null,
          lockoutLevelResetReason: uData.lockoutLevelResetReason || null,
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
        const expectedPolicy = isCanonicalSA ? 'PROGRESSIVE_TEMPORARY' : 'PERMANENT_MANUAL';
        if (sData.lockPolicyType !== expectedPolicy) {
          updates.lockPolicyType = expectedPolicy;
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
  nowProvider?: () => number;
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

const ResetSuperAdminLockoutLevelSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(5, 'An explicit governance reason (at least 5 characters) is mandatory.')
    .max(500),
  confirmed: z.literal(true, {
    message: 'Explicit confirmation is required to reset the Super Admin progressive lockout level.',
  }),
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
    nowProvider,
  } = deps;
  const getNowMs = nowProvider || (() => Date.now());

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
      const requestNowMs = getNowMs();

      // 1. Check Persistent Distributed IP Rate Limit
      const ipCheck = await checkIpProgressiveRateLimitPersistent(
        db,
        telemetry.ipAddress,
        cleanId,
        requestNowMs
      );
      if (!ipCheck.allowed) {
        await recordLoginAttemptDoc(db, {
          loginId: cleanId,
          role: 'UNKNOWN',
          success: false,
          outcome: 'BLOCKED_RATE_LIMIT',
          failureReasonCategory: 'RATE_LIMITED',
          failureReason: ipCheck.reason || 'Rate limit cooldown active',
          nowMs: requestNowMs,
          telemetry,
        });
        await recordSecurityAuditLogDoc(db, {
          action: 'RATE_LIMIT_TRIGGERED',
          severity: 'CRITICAL',
          targetLoginId: cleanId,
          reason: 'IP progressive rate limit cooldown blocked login attempt',
          details: `Blocked login attempt for "${cleanId}" from IP ${telemetry.ipAddress} (${ipCheck.cooldownSeconds}s remaining).`,
          metadata: { cooldownSeconds: ipCheck.cooldownSeconds },
          nowMs: requestNowMs,
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

        const nowMs = getNowMs();
        const now = new Date(nowMs).toISOString();
        const deviceSummary = {
          browser: telemetry.uaMeta.browser,
          os: telemetry.uaMeta.os,
          deviceType: telemetry.uaMeta.deviceType,
        };
        const isPreCheckedCanonicalSuperAdmin = isCanonicalSuperAdminAccount(userDoc.id, userData);
        const superAdminResetHours = isPreCheckedCanonicalSuperAdmin
          ? await resolveSuperAdminLockoutResetHours(db)
          : DEFAULT_SUPER_ADMIN_LOCKOUT_RESET_HOURS;

        type ExpiredLockInfo = {
          previousLockedAt: string | null;
          previousLockedUntil: string | null;
          previousDurationMinutes: number | null;
          retainedProgressiveLevel: number;
        };

        type AutoResetLevelInfo = {
          previousLevel: number;
          cleanWindowHours: number;
          cleanLogins: number;
        };

        const txOutcome = await db.runTransaction(async (tx) => {
          const [secSnap, freshUserSnap] = await Promise.all([tx.get(secRef), tx.get(userRef)]);
          const freshUserData: Record<string, any> = freshUserSnap.exists
            ? (freshUserSnap.data() || {})
            : userData;
          const isCanonicalSA = isCanonicalSuperAdminAccount(userDoc.id, freshUserData);

          let curSec: Record<string, any> = secSnap.exists
            ? { ...(secSnap.data() || {}) }
            : {
                id: `sec_${cleanId}`,
                loginId: cleanId,
                role: roleUpper,
                firebaseUid,
                email: freshUserData.email || `${cleanId}@narid.com`,
                lockStatus:
                  freshUserData.isLocked || freshUserData.lockStatus === 'LOCKED' ? 'LOCKED' : 'ACTIVE',
                lockPolicyType: isCanonicalSA ? 'PROGRESSIVE_TEMPORARY' : 'PERMANENT_MANUAL',
                consecutiveFailedAttempts: Number(freshUserData.consecutiveFailedAttempts || 0),
                maxAttemptsAllowed: MAX_CONSECUTIVE_FAILED_ATTEMPTS,
                totalLoginAttempts: 0,
                totalSuccessfulLogins: 0,
                totalFailedLogins: 0,
                forcePasswordChange:
                  freshUserData.mustChangePassword === true || freshUserData.forcePasswordChange === true,
                lockedAt: freshUserData.lockedAt || null,
                lockoutUntil: freshUserData.lockoutUntil || freshUserData.lockedUntil || null,
                lockedUntil: freshUserData.lockedUntil || freshUserData.lockoutUntil || null,
                lockedUntilMs:
                  typeof freshUserData.lockedUntilMs === 'number' ? freshUserData.lockedUntilMs : null,
                lockDurationMinutes:
                  typeof freshUserData.lockDurationMinutes === 'number'
                    ? freshUserData.lockDurationMinutes
                    : null,
                lockReason: freshUserData.lockReason || null,
                progressiveLockLevel: Number(freshUserData.progressiveLockLevel || 0),
                totalLockoutEvents: Number(freshUserData.totalLockoutEvents || 0),
                lastLockoutAt: freshUserData.lastLockoutAt || null,
                lastLockExpiredAt: freshUserData.lastLockExpiredAt || null,
                cleanWindowStartAt: freshUserData.cleanWindowStartAt || null,
                cleanWindowStartMs:
                  typeof freshUserData.cleanWindowStartMs === 'number'
                    ? freshUserData.cleanWindowStartMs
                    : null,
                cleanLoginsSinceLastLockout: Number(freshUserData.cleanLoginsSinceLastLockout || 0),
                pendingPostLockoutLoginAudit: Boolean(freshUserData.pendingPostLockoutLoginAudit),
              };

          const saLockWindow = isCanonicalSA
            ? resolveCanonicalSuperAdminLockWindow(curSec, freshUserData)
            : {
                lockedUntilMs: resolveAuthoritativeLockedUntilMs(curSec, freshUserData),
                lockoutUntil: null,
                lockDurationMinutes: null,
              };
          const existingLockedUntilMs = saLockWindow.lockedUntilMs;

          let isCurrentlyLocked =
            curSec.lockStatus === 'LOCKED' ||
            freshUserData.lockStatus === 'LOCKED' ||
            freshUserData.isLocked === true;

          let expiredLockInfo: ExpiredLockInfo | null = null;

          // Canonical Super Admin ONLY: automatically reactivate if temporary lockout has expired
          if (isCurrentlyLocked && isCanonicalSA && existingLockedUntilMs !== null && nowMs >= existingLockedUntilMs) {
            const retainedLevel = Number(
              curSec.progressiveLockLevel ?? freshUserData.progressiveLockLevel ?? 0
            );
            expiredLockInfo = {
              previousLockedAt: curSec.lockedAt || freshUserData.lockedAt || null,
              previousLockedUntil:
                saLockWindow.lockoutUntil ||
                resolveAuthoritativeLockedUntilIso(existingLockedUntilMs, curSec, freshUserData),
              previousDurationMinutes:
                saLockWindow.lockDurationMinutes ??
                curSec.lockDurationMinutes ??
                freshUserData.lockDurationMinutes ??
                null,
              retainedProgressiveLevel: retainedLevel,
            };
            isCurrentlyLocked = false;
            curSec = {
              ...curSec,
              lockStatus: 'ACTIVE',
              lockPolicyType: 'PROGRESSIVE_TEMPORARY',
              consecutiveFailedAttempts: 0,
              lockedAt: null,
              lockoutUntil: null,
              lockedUntil: null,
              lockedUntilMs: null,
              lockDurationMinutes: null,
              lockReason: null,
              lastLockExpiredAt: now,
              progressiveLockLevel: retainedLevel,
              pendingPostLockoutLoginAudit: true,
            };
          }

          if (isCurrentlyLocked) {
            const activeLockedUntilMs = isCanonicalSA ? existingLockedUntilMs : null;
            const remainingSeconds =
              isCanonicalSA && activeLockedUntilMs !== null
                ? Math.max(1, Math.ceil((activeLockedUntilMs - nowMs) / 1000))
                : null;
            const lockedUntilIso =
              isCanonicalSA && activeLockedUntilMs !== null
                ? saLockWindow.lockoutUntil ||
                  resolveAuthoritativeLockedUntilIso(activeLockedUntilMs, curSec, freshUserData)
                : null;
            const activeDurationMinutes = isCanonicalSA
              ? (saLockWindow.lockDurationMinutes ??
                curSec.lockDurationMinutes ??
                freshUserData.lockDurationMinutes ??
                null)
              : null;

            tx.set(
              secRef,
              {
                ...curSec,
                role: roleUpper,
                firebaseUid,
                lockStatus: 'LOCKED',
                lockPolicyType: isCanonicalSA ? 'PROGRESSIVE_TEMPORARY' : 'PERMANENT_MANUAL',
                totalLoginAttempts: Number(curSec.totalLoginAttempts || 0) + 1,
                lastFailedAt: now,
                lastFailedIp: telemetry.ipAddress,
                lastFailedGeo: telemetry.geoLocation,
                lastFailedDevice: deviceSummary,
                lastFailedReason:
                  isCanonicalSA && remainingSeconds !== null
                    ? `Attempted login during active temporary lockout (${formatLockoutDurationText(remainingSeconds)} remaining)`
                    : 'Attempted login while account LOCKED',
                updatedAt: now,
              },
              { merge: true }
            );

            return {
              kind: 'LOCKED_REJECT' as const,
              isCanonicalSA,
              temporaryLock: Boolean(isCanonicalSA && activeLockedUntilMs !== null),
              lockedUntil: lockedUntilIso,
              lockedUntilMs: activeLockedUntilMs,
              serverNowMs: nowMs,
              remainingSeconds,
              lockDurationMinutes: activeDurationMinutes,
              progressiveLockLevel: Number(
                curSec.progressiveLockLevel ?? freshUserData.progressiveLockLevel ?? 0
              ),
              consecutiveFailed: Number(curSec.consecutiveFailedAttempts || MAX_CONSECUTIVE_FAILED_ATTEMPTS),
              expiredLockInfo: null as ExpiredLockInfo | null,
              freshUserData,
            };
          }

          // Strictly verify against stored scrypt hash ONLY (no hardcoded fallback password)
          const isPasswordValid = freshUserData.passwordHash
            ? verifyPassword(password, String(freshUserData.passwordHash))
            : false;

          if (!isPasswordValid) {
            const nextConsecutive = Number(curSec.consecutiveFailedAttempts || 0) + 1;
            const reachedLock = nextConsecutive >= MAX_CONSECUTIVE_FAILED_ATTEMPTS;

            if (isCanonicalSA) {
              const currentLevel = Number(
                curSec.progressiveLockLevel ?? freshUserData.progressiveLockLevel ?? 0
              );
              const nextLevel = reachedLock ? currentLevel + 1 : currentLevel;
              const durationMinutes = reachedLock
                ? computeSuperAdminLockDurationMinutes(nextLevel)
                : null;
              const lockedUntilMs =
                reachedLock && durationMinutes !== null
                  ? nowMs + durationMinutes * 60 * 1000
                  : null;
              const lockedUntilIso =
                lockedUntilMs !== null ? new Date(lockedUntilMs).toISOString() : null;
              const totalLockoutEvents =
                Number(curSec.totalLockoutEvents ?? freshUserData.totalLockoutEvents ?? 0) +
                (reachedLock ? 1 : 0);
              const lockReasonText =
                reachedLock && durationMinutes !== null
                  ? `Progressive temporary lockout (${durationMinutes} minutes) after ${nextConsecutive} consecutive failed password attempts`
                  : null;

              const secUpdate = {
                ...curSec,
                id: `sec_${cleanId}`,
                loginId: cleanId,
                role: roleUpper,
                firebaseUid,
                email: freshUserData.email || `${cleanId}@narid.com`,
                lockStatus: reachedLock ? 'LOCKED' : 'ACTIVE',
                lockPolicyType: 'PROGRESSIVE_TEMPORARY',
                consecutiveFailedAttempts: nextConsecutive,
                maxAttemptsAllowed: MAX_CONSECUTIVE_FAILED_ATTEMPTS,
                totalLoginAttempts: Number(curSec.totalLoginAttempts || 0) + 1,
                totalFailedLogins: Number(curSec.totalFailedLogins || 0) + 1,
                lastFailedAt: now,
                lastFailedIp: telemetry.ipAddress,
                lastFailedGeo: telemetry.geoLocation,
                lastFailedDevice: deviceSummary,
                lastFailedReason: reachedLock
                  ? `Super Admin temporarily locked for ${durationMinutes} minutes after ${nextConsecutive} consecutive failed password attempts`
                  : `Invalid password (Attempt ${nextConsecutive} of ${MAX_CONSECUTIVE_FAILED_ATTEMPTS})`,
                lockedAt: reachedLock ? now : null,
                lockoutUntil: lockedUntilIso,
                lockedUntil: lockedUntilIso,
                lockedUntilMs,
                lockDurationMinutes: durationMinutes,
                lockReason: lockReasonText,
                progressiveLockLevel: nextLevel,
                totalLockoutEvents,
                lastLockoutAt: reachedLock ? now : (curSec.lastLockoutAt || freshUserData.lastLockoutAt || null),
                lastLockExpiredAt: expiredLockInfo
                  ? now
                  : (curSec.lastLockExpiredAt || freshUserData.lastLockExpiredAt || null),
                // Any failed password attempt clears the sustained clean usage window
                cleanWindowStartAt: null,
                cleanWindowStartMs: null,
                cleanLoginsSinceLastLockout: 0,
                pendingPostLockoutLoginAudit: reachedLock
                  ? true
                  : Boolean(expiredLockInfo || curSec.pendingPostLockoutLoginAudit),
                updatedAt: now,
              };

              tx.set(secRef, secUpdate, { merge: true });
              const userUpdates: Record<string, any> = {
                consecutiveFailedAttempts: nextConsecutive,
                isLocked: reachedLock,
                lockStatus: reachedLock ? 'LOCKED' : 'ACTIVE',
                lockPolicyType: 'PROGRESSIVE_TEMPORARY',
                lockedAt: reachedLock ? now : null,
                lockoutUntil: lockedUntilIso,
                lockedUntil: lockedUntilIso,
                lockedUntilMs,
                lockDurationMinutes: durationMinutes,
                lockReason: lockReasonText,
                progressiveLockLevel: nextLevel,
                totalLockoutEvents,
                lastLockoutAt: secUpdate.lastLockoutAt,
                lastLockExpiredAt: secUpdate.lastLockExpiredAt,
                cleanWindowStartAt: null,
                cleanWindowStartMs: null,
                cleanLoginsSinceLastLockout: 0,
                pendingPostLockoutLoginAudit: secUpdate.pendingPostLockoutLoginAudit,
                updatedAt: now,
              };
              if (reachedLock) {
                // Immediately invalidate any existing Super Admin session tokens on lockout
                userUpdates.sessionRevokedAt = now;
              }
              tx.update(userRef, userUpdates);

              return {
                kind: reachedLock ? ('NOW_LOCKED' as const) : ('FAILED_PASSWORD' as const),
                isCanonicalSA: true,
                temporaryLock: reachedLock,
                attemptNumber: nextConsecutive,
                remainingAttempts: Math.max(0, MAX_CONSECUTIVE_FAILED_ATTEMPTS - nextConsecutive),
                lockedUntil: lockedUntilIso,
                lockedUntilMs,
                serverNowMs: nowMs,
                remainingSeconds: durationMinutes !== null ? durationMinutes * 60 : null,
                lockDurationMinutes: durationMinutes,
                progressiveLockLevel: nextLevel,
                totalLockoutEvents,
                expiredLockInfo,
                freshUserData,
              };
            }

            // Non-canonical roles (Admin, User, Custom Roles): unchanged permanent manual lock
            const secUpdate = {
              ...curSec,
              id: `sec_${cleanId}`,
              loginId: cleanId,
              role: roleUpper,
              firebaseUid,
              email: freshUserData.email || `${cleanId}@narid.com`,
              lockStatus: reachedLock ? 'LOCKED' : 'ACTIVE',
              lockPolicyType: 'PERMANENT_MANUAL',
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
              lockedAt: reachedLock ? now : freshUserData.lockedAt || null,
              lockReason: reachedLock ? secUpdate.lockReason : freshUserData.lockReason || null,
              updatedAt: now,
            });

            return {
              kind: reachedLock ? ('NOW_LOCKED' as const) : ('FAILED_PASSWORD' as const),
              isCanonicalSA: false,
              temporaryLock: false,
              attemptNumber: nextConsecutive,
              remainingAttempts: Math.max(0, MAX_CONSECUTIVE_FAILED_ATTEMPTS - nextConsecutive),
              lockedUntil: null as string | null,
              lockedUntilMs: null as number | null,
              serverNowMs: nowMs,
              remainingSeconds: null as number | null,
              lockDurationMinutes: null as number | null,
              progressiveLockLevel: 0,
              totalLockoutEvents: 0,
              expiredLockInfo: null as ExpiredLockInfo | null,
              freshUserData,
            };
          }

          // Valid password!
          const mustChange =
            freshUserData.mustChangePassword === true || curSec.forcePasswordChange === true;

          if (isCanonicalSA) {
            const wasPostLockoutLogin = Boolean(
              expiredLockInfo ||
                curSec.pendingPostLockoutLoginAudit ||
                freshUserData.pendingPostLockoutLoginAudit
            );
            const currentLevel = Number(
              curSec.progressiveLockLevel ?? freshUserData.progressiveLockLevel ?? 0
            );
            let nextLevel = currentLevel;
            let nextCleanStartAt: string | null =
              curSec.cleanWindowStartAt || freshUserData.cleanWindowStartAt || null;
            let nextCleanStartMs: number | null =
              typeof curSec.cleanWindowStartMs === 'number'
                ? curSec.cleanWindowStartMs
                : typeof freshUserData.cleanWindowStartMs === 'number'
                  ? freshUserData.cleanWindowStartMs
                  : null;
            let nextCleanLogins = Number(
              curSec.cleanLoginsSinceLastLockout ?? freshUserData.cleanLoginsSinceLastLockout ?? 0
            );
            let autoResetLevelInfo: AutoResetLevelInfo | null = null;

            if (currentLevel > 0) {
              const requiredWindowMs = superAdminResetHours * 60 * 60 * 1000;
              if (nextCleanStartMs !== null && nowMs - nextCleanStartMs >= requiredWindowMs) {
                autoResetLevelInfo = {
                  previousLevel: currentLevel,
                  cleanWindowHours: superAdminResetHours,
                  cleanLogins: nextCleanLogins + 1,
                };
                nextLevel = 0;
                nextCleanStartAt = null;
                nextCleanStartMs = null;
                nextCleanLogins = 0;
              } else {
                if (nextCleanStartMs === null) {
                  nextCleanStartMs = nowMs;
                  nextCleanStartAt = now;
                }
                nextCleanLogins += 1;
              }
            } else {
              nextCleanStartAt = null;
              nextCleanStartMs = null;
              nextCleanLogins = 0;
            }

            const resetReasonText = autoResetLevelInfo
              ? `Automatic reset after ${superAdminResetHours}h of sustained clean Super Admin usage with zero failed password attempts`
              : (curSec.lockoutLevelResetReason || freshUserData.lockoutLevelResetReason || null);
            const resetAtText = autoResetLevelInfo
              ? now
              : (curSec.lockoutLevelResetAt || freshUserData.lockoutLevelResetAt || null);

            tx.set(
              secRef,
              {
                ...curSec,
                id: `sec_${cleanId}`,
                loginId: cleanId,
                role: roleUpper,
                firebaseUid,
                email: freshUserData.email || `${cleanId}@narid.com`,
                lockStatus: 'ACTIVE',
                lockPolicyType: 'PROGRESSIVE_TEMPORARY',
                consecutiveFailedAttempts: 0,
                maxAttemptsAllowed: MAX_CONSECUTIVE_FAILED_ATTEMPTS,
                totalLoginAttempts: Number(curSec.totalLoginAttempts || 0) + 1,
                totalSuccessfulLogins: Number(curSec.totalSuccessfulLogins || 0) + 1,
                forcePasswordChange: mustChange,
                lockedAt: null,
                lockoutUntil: null,
                lockedUntil: null,
                lockedUntilMs: null,
                lockDurationMinutes: null,
                lockReason: null,
                progressiveLockLevel: nextLevel,
                totalLockoutEvents: Number(
                  curSec.totalLockoutEvents ?? freshUserData.totalLockoutEvents ?? 0
                ),
                lastLockoutAt: curSec.lastLockoutAt || freshUserData.lastLockoutAt || null,
                lastLockExpiredAt: expiredLockInfo
                  ? now
                  : (curSec.lastLockExpiredAt || freshUserData.lastLockExpiredAt || null),
                cleanWindowStartAt: nextCleanStartAt,
                cleanWindowStartMs: nextCleanStartMs,
                cleanLoginsSinceLastLockout: nextCleanLogins,
                pendingPostLockoutLoginAudit: false,
                lockoutLevelResetAt: resetAtText,
                lockoutLevelResetReason: resetReasonText,
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
              lockPolicyType: 'PROGRESSIVE_TEMPORARY',
              lockedAt: null,
              lockoutUntil: null,
              lockedUntil: null,
              lockedUntilMs: null,
              lockDurationMinutes: null,
              lockReason: null,
              progressiveLockLevel: nextLevel,
              lastLockExpiredAt: expiredLockInfo
                ? now
                : (freshUserData.lastLockExpiredAt || null),
              cleanWindowStartAt: nextCleanStartAt,
              cleanWindowStartMs: nextCleanStartMs,
              cleanLoginsSinceLastLockout: nextCleanLogins,
              pendingPostLockoutLoginAudit: false,
              lockoutLevelResetAt: resetAtText,
              lockoutLevelResetReason: resetReasonText,
              lastSuccessLoginAt: now,
              updatedAt: now,
            });

            return {
              kind: 'SUCCESS' as const,
              isCanonicalSA: true,
              mustChange,
              expiredLockInfo,
              wasPostLockoutLogin,
              autoResetLevelInfo,
              progressiveLockLevel: nextLevel,
              freshUserData,
            };
          }

          tx.set(
            secRef,
            {
              ...curSec,
              id: `sec_${cleanId}`,
              loginId: cleanId,
              role: roleUpper,
              firebaseUid,
              email: freshUserData.email || `${cleanId}@narid.com`,
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
            isCanonicalSA: false,
            mustChange,
            expiredLockInfo: null as ExpiredLockInfo | null,
            wasPostLockoutLogin: false,
            autoResetLevelInfo: null as AutoResetLevelInfo | null,
            progressiveLockLevel: 0,
            freshUserData,
          };
        });

        const resolvedUserData = txOutcome.freshUserData || userData;

        // Audit automatic temporary lockout expiry & reactivation whenever it occurred
        if (txOutcome.expiredLockInfo) {
          await Promise.all([
            recordSecurityAuditLogDoc(db, {
              action: 'LOCKOUT_EXPIRED_REACTIVATED',
              severity: 'INFO',
              targetLoginId: cleanId,
              targetRole: roleUpper,
              targetUid: firebaseUid,
              reason: 'Super Admin temporary lockout duration expired; account automatically reactivated',
              details: `Temporary lockout for canonical Super Admin "${cleanId}" expired at ${txOutcome.expiredLockInfo.previousLockedUntil || now}. Consecutive failed counter reset to 0 while retaining progressive level ${txOutcome.expiredLockInfo.retainedProgressiveLevel}.`,
              metadata: {
                previousLockedAt: txOutcome.expiredLockInfo.previousLockedAt,
                previousLockedUntil: txOutcome.expiredLockInfo.previousLockedUntil,
                previousDurationMinutes: txOutcome.expiredLockInfo.previousDurationMinutes,
                retainedProgressiveLevel: txOutcome.expiredLockInfo.retainedProgressiveLevel,
              },
              nowMs,
              telemetry,
            }),
            recordEnterpriseAuditEvent(db, {
              req,
              action: 'super_admin_lockout_expired',
              category: 'SECURITY',
              severity: 'INFO',
              actorUid: firebaseUid,
              actorLoginId: cleanId,
              actorRole: roleUpper,
              targetType: 'ACCOUNT',
              targetId: userDoc.id,
              oldValue: {
                lockStatus: 'LOCKED',
                lockedUntil: txOutcome.expiredLockInfo.previousLockedUntil,
                lockDurationMinutes: txOutcome.expiredLockInfo.previousDurationMinutes,
              },
              newValue: {
                lockStatus: 'ACTIVE',
                consecutiveFailedAttempts: 0,
                progressiveLockLevel: txOutcome.expiredLockInfo.retainedProgressiveLevel,
              },
              actionSource: 'PROGRESSIVE_LOCKOUT_ENGINE',
              description: `Canonical Super Admin temporary lockout expired; account automatically reactivated with progressive level ${txOutcome.expiredLockInfo.retainedProgressiveLevel} retained.`,
              success: true,
            }),
          ]);
        }

        if (txOutcome.kind === 'LOCKED_REJECT') {
          await syncUserUidIndex(db, {
            uid: resolvedUserData.authUid || null,
            roleDocId: userDoc.id,
            role: String(resolvedUserData.role || 'user'),
            status: String(resolvedUserData.status || 'Active'),
            lockStatus: 'LOCKED',
            lockedUntilMs: txOutcome.lockedUntilMs ?? null,
            loginId: cleanId,
          });
          const ipRes = await recordIpFailurePersistent(
            db,
            telemetry.ipAddress,
            'locked_hit',
            cleanId,
            nowMs
          );
          const lockedErrorMessage =
            txOutcome.temporaryLock && txOutcome.remainingSeconds !== null
              ? `Super Admin account is temporarily locked due to repeated failed password attempts. Try again in ${formatLockoutDurationText(txOutcome.remainingSeconds)}.`
              : LOCKED_ACCOUNT_MESSAGE;

          await Promise.all([
            recordLoginAttemptDoc(db, {
              loginId: cleanId,
              role: roleUpper,
              firebaseUid,
              success: false,
              outcome: 'BLOCKED_LOCKED',
              failureReasonCategory: 'ACCOUNT_LOCKED',
              failureReason: txOutcome.temporaryLock
                ? `Login rejected during active temporary lockout (${txOutcome.remainingSeconds}s remaining)`
                : 'Login rejected because account status is LOCKED',
              consecutiveFailedAfter: txOutcome.consecutiveFailed,
              lockDurationMinutes: txOutcome.lockDurationMinutes,
              lockedUntil: txOutcome.lockedUntil,
              nowMs,
              telemetry,
            }),
            recordSecurityAuditLogDoc(db, {
              action: 'LOGIN_BLOCKED_WHILE_LOCKED',
              severity: 'WARNING',
              targetLoginId: cleanId,
              targetRole: roleUpper,
              targetUid: firebaseUid,
              reason: txOutcome.temporaryLock
                ? 'Attempted login during active Super Admin temporary lockout'
                : 'Attempted login on locked account',
              details: txOutcome.temporaryLock
                ? `Rejected login attempt for temporarily locked Super Admin "${cleanId}" from IP ${telemetry.ipAddress} (${txOutcome.remainingSeconds}s remaining until ${txOutcome.lockedUntil}).`
                : `Rejected login attempt for locked account "${cleanId}" (${roleUpper}) from IP ${telemetry.ipAddress}.`,
              metadata: txOutcome.temporaryLock
                ? {
                    temporaryLock: true,
                    lockedUntil: txOutcome.lockedUntil,
                    remainingSeconds: txOutcome.remainingSeconds,
                    lockDurationMinutes: txOutcome.lockDurationMinutes,
                  }
                : undefined,
              nowMs,
              telemetry,
            }),
            recordLoginHistoryEntry(db, {
              req,
              eventType: 'LOGIN_LOCKED',
              loginId: cleanId,
              authUid: firebaseUid,
              role: roleUpper,
              success: false,
              failureReason: lockedErrorMessage,
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
              description: txOutcome.temporaryLock
                ? `Blocked login attempt on temporarily locked Super Admin "${cleanId}" (${txOutcome.remainingSeconds}s remaining).`
                : `Blocked login attempt on already locked account "${cleanId}".`,
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
              nowMs,
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
            detail: txOutcome.temporaryLock
              ? `Blocked during temporary lockout (${txOutcome.remainingSeconds}s remaining)`
              : 'Attempted login on locked account',
          });

          if (txOutcome.temporaryLock) {
            return {
              status: 423,
              body: {
                success: false,
                code: 'ACCOUNT_LOCKED',
                locked: true,
                temporaryLock: true,
                lockoutUntil: txOutcome.lockedUntil,
                lockedUntil: txOutcome.lockedUntil,
                lockedUntilMs: txOutcome.lockedUntilMs,
                serverNowMs: txOutcome.serverNowMs,
                remainingSeconds: txOutcome.remainingSeconds,
                lockDurationMinutes: txOutcome.lockDurationMinutes,
                error: lockedErrorMessage,
              },
            };
          }

          return {
            status: 423,
            body: {
              success: false,
              code: 'ACCOUNT_LOCKED',
              locked: true,
              temporaryLock: false,
              error: LOCKED_ACCOUNT_MESSAGE,
            },
          };
        }

        if (txOutcome.kind === 'NOW_LOCKED') {
          await syncUserUidIndex(db, {
            uid: resolvedUserData.authUid || null,
            roleDocId: userDoc.id,
            role: String(resolvedUserData.role || 'user'),
            status: String(resolvedUserData.status || 'Active'),
            lockStatus: 'LOCKED',
            lockedUntilMs: txOutcome.lockedUntilMs ?? null,
            loginId: cleanId,
          });

          // Immediately revoke Firebase refresh tokens when canonical Super Admin enters temporary lockout
          if (
            txOutcome.isCanonicalSA &&
            auth &&
            resolvedUserData.authUid &&
            !String(resolvedUserData.authUid).startsWith('role_')
          ) {
            try {
              await auth.revokeRefreshTokens(String(resolvedUserData.authUid));
            } catch (revokeErr: any) {
              console.warn(
                '[Super Admin Progressive Lockout] revokeRefreshTokens notice:',
                revokeErr?.message || revokeErr
              );
            }
          }

          await recordIpFailurePersistent(db, telemetry.ipAddress, 'password', cleanId, nowMs);

          const isTempSA = txOutcome.isCanonicalSA && txOutcome.temporaryLock;
          const lockedReasonMsg = isTempSA
            ? `Super Admin account temporarily locked for ${txOutcome.lockDurationMinutes} minutes after ${txOutcome.attemptNumber} consecutive failed password attempts. Please wait before trying again.`
            : LOCKED_ACCOUNT_MESSAGE;

          await Promise.all([
            recordLoginAttemptDoc(db, {
              loginId: cleanId,
              role: roleUpper,
              firebaseUid,
              success: false,
              outcome: 'FAILED_PASSWORD',
              failureReasonCategory: 'ACCOUNT_LOCKED',
              failureReason: isTempSA
                ? `3rd consecutive failed password triggered progressive temporary lockout (${txOutcome.lockDurationMinutes} minutes)`
                : '3rd consecutive failed password attempt triggered automatic account lock',
              attemptNumber: txOutcome.attemptNumber,
              consecutiveFailedAfter: txOutcome.attemptNumber,
              triggeredLock: true,
              lockDurationMinutes: txOutcome.lockDurationMinutes,
              lockedUntil: txOutcome.lockedUntil,
              nowMs,
              telemetry,
            }),
            recordSecurityAuditLogDoc(db, {
              action: 'ACCOUNT_LOCKED',
              severity: 'CRITICAL',
              targetLoginId: cleanId,
              targetRole: roleUpper,
              targetUid: firebaseUid,
              reason: isTempSA
                ? `Super Admin progressive temporary lockout triggered (${txOutcome.lockDurationMinutes} minutes, level ${txOutcome.progressiveLockLevel})`
                : 'Exceeded 3 consecutive failed password attempts',
              details: isTempSA
                ? `SECURITY ALERT: Canonical Super Admin "${cleanId}" (UID: ${firebaseUid}) temporarily LOCKED for ${txOutcome.lockDurationMinutes} minutes (progressive level ${txOutcome.progressiveLockLevel}, event #${txOutcome.totalLockoutEvents}) until ${txOutcome.lockedUntil}. Active sessions revoked.`
                : `SECURITY ALERT: Account "${cleanId}" (${roleUpper}, UID: ${firebaseUid}) automatically LOCKED on failed attempt #${txOutcome.attemptNumber}.`,
              metadata: isTempSA
                ? {
                    attemptNumber: txOutcome.attemptNumber,
                    maxAttempts: MAX_CONSECUTIVE_FAILED_ATTEMPTS,
                    lockPolicyType: 'PROGRESSIVE_TEMPORARY',
                    progressiveLockLevel: txOutcome.progressiveLockLevel,
                    totalLockoutEvents: txOutcome.totalLockoutEvents,
                    lockDurationMinutes: txOutcome.lockDurationMinutes,
                    lockedUntil: txOutcome.lockedUntil,
                    sessionsRevoked: true,
                  }
                : { attemptNumber: txOutcome.attemptNumber, maxAttempts: MAX_CONSECUTIVE_FAILED_ATTEMPTS },
              nowMs,
              telemetry,
            }),
            recordLoginHistoryEntry(db, {
              req,
              eventType: 'LOGIN_LOCKED',
              loginId: cleanId,
              authUid: firebaseUid,
              role: roleUpper,
              success: false,
              failureReason: isTempSA
                ? `Progressive temporary lockout (${txOutcome.lockDurationMinutes}m) after ${txOutcome.attemptNumber} failed attempts`
                : `Locked after ${txOutcome.attemptNumber} consecutive failed attempts`,
            }),
            recordEnterpriseAuditEvent(db, {
              req,
              action: isTempSA ? 'super_admin_progressive_lockout' : 'failed_login_threshold_exceeded',
              category: 'SECURITY',
              severity: 'CRITICAL',
              actorUid: firebaseUid,
              actorLoginId: cleanId,
              actorRole: roleUpper,
              targetType: 'ACCOUNT',
              targetId: userDoc.id,
              newValue: isTempSA
                ? {
                    lockStatus: 'LOCKED',
                    lockPolicyType: 'PROGRESSIVE_TEMPORARY',
                    progressiveLockLevel: txOutcome.progressiveLockLevel,
                    totalLockoutEvents: txOutcome.totalLockoutEvents,
                    lockDurationMinutes: txOutcome.lockDurationMinutes,
                    lockedUntil: txOutcome.lockedUntil,
                  }
                : undefined,
              actionSource: isTempSA ? 'PROGRESSIVE_LOCKOUT_ENGINE' : 'ACCOUNT_LOCKOUT_ENGINE',
              description: isTempSA
                ? `Canonical Super Admin "${cleanId}" temporarily locked for ${txOutcome.lockDurationMinutes} minutes (level ${txOutcome.progressiveLockLevel}) after ${txOutcome.attemptNumber} consecutive failed attempts.`
                : `Account "${cleanId}" (${roleUpper}) automatically LOCKED after ${txOutcome.attemptNumber} consecutive failed password attempts.`,
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
            detail: isTempSA
              ? `Progressive temporary lock (${txOutcome.lockDurationMinutes}m) on attempt #${txOutcome.attemptNumber}`
              : `Auto-locked on attempt #${txOutcome.attemptNumber}`,
          });
          recordErrorTelemetry(db, {
            source: 'AUTH',
            module: 'Authentication',
            category: 'AUTH',
            severity: 'CRITICAL',
            message: isTempSA
              ? `Super Admin temporarily locked (${txOutcome.lockDurationMinutes}m) after ${txOutcome.attemptNumber} failed attempts`
              : `Account locked after ${txOutcome.attemptNumber} failed attempts`,
            statusCode: 423,
            correlationId: (req as any).correlationId,
          });

          if (isTempSA) {
            return {
              status: 423,
              body: {
                success: false,
                code: 'ACCOUNT_LOCKED',
                locked: true,
                temporaryLock: true,
                lockoutUntil: txOutcome.lockedUntil,
                lockedUntil: txOutcome.lockedUntil,
                lockedUntilMs: txOutcome.lockedUntilMs,
                serverNowMs: txOutcome.serverNowMs,
                remainingSeconds: txOutcome.remainingSeconds,
                lockDurationMinutes: txOutcome.lockDurationMinutes,
                attemptNumber: txOutcome.attemptNumber,
                maxAttempts: MAX_CONSECUTIVE_FAILED_ATTEMPTS,
                remainingAttempts: 0,
                error: lockedReasonMsg,
              },
            };
          }

          return {
            status: 423,
            body: {
              success: false,
              code: 'ACCOUNT_LOCKED',
              locked: true,
              temporaryLock: false,
              attemptNumber: txOutcome.attemptNumber,
              maxAttempts: MAX_CONSECUTIVE_FAILED_ATTEMPTS,
              remainingAttempts: 0,
              error: LOCKED_ACCOUNT_MESSAGE,
            },
          };
        }

        if (txOutcome.kind === 'FAILED_PASSWORD') {
          if (txOutcome.expiredLockInfo) {
            await syncUserUidIndex(db, {
              uid: resolvedUserData.authUid || null,
              roleDocId: userDoc.id,
              role: String(resolvedUserData.role || 'user'),
              status: String(resolvedUserData.status || 'Active'),
              lockStatus: 'ACTIVE',
              lockedUntilMs: null,
              loginId: cleanId,
            });
          }

          await recordIpFailurePersistent(db, telemetry.ipAddress, 'password', cleanId, nowMs);
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
              nowMs,
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
              nowMs,
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
          uid: resolvedUserData.authUid || null,
          roleDocId: userDoc.id,
          role: String(resolvedUserData.role || 'user'),
          status: String(resolvedUserData.status || 'Active'),
          lockStatus: 'ACTIVE',
          lockedUntilMs: null,
          loginId: cleanId,
        });

        const sessionId = `sess_${crypto.randomBytes(10).toString('hex')}`;
        const sessionToken = crypto.randomBytes(32).toString('hex');

        let effectiveModules = Array.isArray(resolvedUserData.modulesAllowed)
          ? [...resolvedUserData.modulesAllowed]
          : [];
        if (
          String(resolvedUserData.role || '').toLowerCase() === 'user' &&
          !resolvedUserData.dashboardAccessMigratedV1
        ) {
          if (!effectiveModules.includes('dashboard')) {
            effectiveModules = ['dashboard', ...effectiveModules];
          }
        }

        const successAuditTasks: Promise<any>[] = [
          recordLoginAttemptDoc(db, {
            loginId: cleanId,
            role: roleUpper,
            firebaseUid,
            success: true,
            outcome: 'SUCCESS',
            failureReasonCategory: 'NONE',
            consecutiveFailedAfter: 0,
            sessionId,
            nowMs,
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
            nowMs,
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
        ];

        if (txOutcome.isCanonicalSA && txOutcome.wasPostLockoutLogin) {
          successAuditTasks.push(
            recordSecurityAuditLogDoc(db, {
              action: 'LOGIN_SUCCESS_AFTER_LOCKOUT',
              severity: 'INFO',
              targetLoginId: cleanId,
              targetRole: roleUpper,
              targetUid: firebaseUid,
              actorUid: firebaseUid,
              actorLoginId: cleanId,
              actorRole: roleUpper,
              reason: 'First successful Super Admin login following temporary lockout expiry',
              details: `Canonical Super Admin "${cleanId}" signed in successfully after temporary lockout expiry (session ${sessionId}). Progressive lockout level is ${txOutcome.progressiveLockLevel}.`,
              metadata: {
                sessionId,
                progressiveLockLevel: txOutcome.progressiveLockLevel,
              },
              nowMs,
              telemetry,
            }),
            recordEnterpriseAuditEvent(db, {
              req,
              action: 'login_success_after_lockout',
              category: 'SECURITY',
              severity: 'INFO',
              actorUid: firebaseUid,
              actorLoginId: cleanId,
              actorRole: roleUpper,
              targetType: 'ACCOUNT',
              targetId: userDoc.id,
              actionSource: 'PROGRESSIVE_LOCKOUT_ENGINE',
              sessionId,
              newValue: { progressiveLockLevel: txOutcome.progressiveLockLevel },
              description: `Canonical Super Admin "${cleanId}" completed first successful login after temporary lockout expiry.`,
              success: true,
            })
          );
        }

        if (txOutcome.isCanonicalSA && txOutcome.autoResetLevelInfo) {
          successAuditTasks.push(
            recordSecurityAuditLogDoc(db, {
              action: 'LOCKOUT_LEVEL_RESET',
              severity: 'INFO',
              targetLoginId: cleanId,
              targetRole: roleUpper,
              targetUid: firebaseUid,
              actorUid: firebaseUid,
              actorLoginId: cleanId,
              actorRole: roleUpper,
              reason: `Automatic progressive lockout level reset after ${txOutcome.autoResetLevelInfo.cleanWindowHours}h sustained clean usage`,
              details: `Canonical Super Admin "${cleanId}" progressive lockout level automatically reset from ${txOutcome.autoResetLevelInfo.previousLevel} to 0 after ${txOutcome.autoResetLevelInfo.cleanWindowHours} hours of clean usage with zero failed password attempts.`,
              metadata: {
                resetType: 'AUTOMATIC_SUSTAINED_CLEAN_USAGE',
                previousLevel: txOutcome.autoResetLevelInfo.previousLevel,
                newLevel: 0,
                cleanWindowHours: txOutcome.autoResetLevelInfo.cleanWindowHours,
                cleanLogins: txOutcome.autoResetLevelInfo.cleanLogins,
              },
              nowMs,
              telemetry,
            }),
            recordEnterpriseAuditEvent(db, {
              req,
              action: 'super_admin_lockout_level_reset',
              category: 'SECURITY',
              severity: 'INFO',
              actorUid: firebaseUid,
              actorLoginId: cleanId,
              actorRole: roleUpper,
              targetType: 'ACCOUNT',
              targetId: userDoc.id,
              oldValue: { progressiveLockLevel: txOutcome.autoResetLevelInfo.previousLevel },
              newValue: {
                progressiveLockLevel: 0,
                resetType: 'AUTOMATIC_SUSTAINED_CLEAN_USAGE',
                cleanWindowHours: txOutcome.autoResetLevelInfo.cleanWindowHours,
              },
              actionSource: 'PROGRESSIVE_LOCKOUT_ENGINE',
              description: `Canonical Super Admin progressive lockout level automatically reset from ${txOutcome.autoResetLevelInfo.previousLevel} to 0 after ${txOutcome.autoResetLevelInfo.cleanWindowHours}h of sustained clean usage.`,
              success: true,
            })
          );
        }

        await Promise.all(successAuditTasks);

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

        const { passwordHash: _ph, ...sanitizedProfile } = resolvedUserData;
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
              lockedAt: null,
              lockoutUntil: null,
              lockedUntil: null,
              lockedUntilMs: null,
              lockDurationMinutes: null,
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

  // A2. Authoritative Canonical Super Admin Temporary Lockout Status (Server-Time Synchronized)
  // Strictly scoped to canonical Super Admin — never leaks existence or lock status of Admin/User/Custom Roles.
  app.get('/api/auth/lockout-status', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    try {
      const nowMs = getNowMs();
      const rawLoginId = typeof req.query?.loginId === 'string' ? req.query.loginId.trim().toLowerCase() : '';

      // Zero enumeration / zero leakage for Admin, User, or Custom Roles
      if (rawLoginId && rawLoginId !== 'superadmin') {
        return res.json({
          success: true,
          locked: false,
          temporaryLock: false,
          serverNowMs: nowMs,
        });
      }

      let userDoc = await db.collection('user_roles').doc('role_superadmin').get();
      if (!userDoc.exists) {
        const snap = await db.collection('user_roles').where('loginId', '==', 'superadmin').limit(1).get();
        if (!snap.empty) {
          userDoc = snap.docs[0];
        }
      }

      if (!userDoc || !userDoc.exists) {
        return res.json({
          success: true,
          locked: false,
          temporaryLock: false,
          serverNowMs: nowMs,
        });
      }

      const userData = userDoc.data() || {};
      if (!isCanonicalSuperAdminAccount(userDoc.id, userData)) {
        return res.json({
          success: true,
          locked: false,
          temporaryLock: false,
          serverNowMs: nowMs,
        });
      }

      const secRef = db.collection('account_security').doc('sec_superadmin');
      const userRef = db.collection('user_roles').doc(userDoc.id);
      const secSnap = await secRef.get();
      const secData = secSnap.exists ? (secSnap.data() || {}) : {};

      const isCurrentlyLocked =
        secData.lockStatus === 'LOCKED' ||
        userData.lockStatus === 'LOCKED' ||
        userData.isLocked === true;
      const saLockWindow = resolveCanonicalSuperAdminLockWindow(secData, userData);
      const existingLockedUntilMs = saLockWindow.lockedUntilMs;

      if (!isCurrentlyLocked || existingLockedUntilMs === null) {
        return res.json({
          success: true,
          locked: false,
          temporaryLock: false,
          serverNowMs: nowMs,
        });
      }

      // Active temporary lockout: server time has NOT yet reached lockoutUntil
      if (nowMs < existingLockedUntilMs) {
        const remainingSeconds = Math.max(1, Math.ceil((existingLockedUntilMs - nowMs) / 1000));
        const lockoutUntilIso =
          saLockWindow.lockoutUntil ||
          resolveAuthoritativeLockedUntilIso(existingLockedUntilMs, secData, userData);
        const lockDurationMinutes = saLockWindow.lockDurationMinutes;

        return res.json({
          success: true,
          locked: true,
          temporaryLock: true,
          loginId: 'superadmin',
          lockoutUntil: lockoutUntilIso,
          lockedUntil: lockoutUntilIso,
          lockedUntilMs: existingLockedUntilMs,
          serverNowMs: nowMs,
          remainingSeconds,
          lockDurationMinutes,
        });
      }

      // Server independently verified lockoutUntil <= serverNowMs: atomically reactivate under mutex + transaction
      const reactivationOutcome = await withLoginIdLock('superadmin', async () => {
        const txNowMs = getNowMs();
        const txNowIso = new Date(txNowMs).toISOString();

        const txResult = await db.runTransaction(async (tx) => {
          const [freshSecSnap, freshUserSnap] = await Promise.all([tx.get(secRef), tx.get(userRef)]);
          const freshSec = freshSecSnap.exists ? (freshSecSnap.data() || {}) : {};
          const freshUser = freshUserSnap.exists ? (freshUserSnap.data() || {}) : userData;

          const txIsLocked =
            freshSec.lockStatus === 'LOCKED' ||
            freshUser.lockStatus === 'LOCKED' ||
            freshUser.isLocked === true;
          const txLockWindow = resolveCanonicalSuperAdminLockWindow(freshSec, freshUser);
          const txLockedUntilMs = txLockWindow.lockedUntilMs;

          if (!txIsLocked || txLockedUntilMs === null) {
            return { kind: 'ALREADY_ACTIVE' as const, serverNowMs: txNowMs };
          }

          // Re-verify inside transaction in case account was freshly re-locked concurrently
          if (txNowMs < txLockedUntilMs) {
            const remSec = Math.max(1, Math.ceil((txLockedUntilMs - txNowMs) / 1000));
            const iso =
              txLockWindow.lockoutUntil ||
              resolveAuthoritativeLockedUntilIso(txLockedUntilMs, freshSec, freshUser);
            return {
              kind: 'STILL_LOCKED' as const,
              serverNowMs: txNowMs,
              lockoutUntil: iso,
              lockedUntilMs: txLockedUntilMs,
              remainingSeconds: remSec,
              lockDurationMinutes: txLockWindow.lockDurationMinutes,
            };
          }

          const retainedLevel = Number(
            freshSec.progressiveLockLevel ?? freshUser.progressiveLockLevel ?? 0
          );
          const previousLockedAt = freshSec.lockedAt || freshUser.lockedAt || null;
          const previousLockedUntil = resolveAuthoritativeLockedUntilIso(
            txLockedUntilMs,
            freshSec,
            freshUser
          );
          const previousDurationMinutes =
            freshSec.lockDurationMinutes ?? freshUser.lockDurationMinutes ?? null;

          tx.set(
            secRef,
            {
              ...freshSec,
              id: 'sec_superadmin',
              loginId: 'superadmin',
              role: 'SUPER_ADMIN',
              firebaseUid: String(freshUser.authUid || userDoc.id),
              email: freshUser.email || 'superadmin@narid.com',
              lockStatus: 'ACTIVE',
              lockPolicyType: 'PROGRESSIVE_TEMPORARY',
              consecutiveFailedAttempts: 0,
              lockedAt: null,
              lockoutUntil: null,
              lockedUntil: null,
              lockedUntilMs: null,
              lockDurationMinutes: null,
              lockReason: null,
              lastLockExpiredAt: txNowIso,
              progressiveLockLevel: retainedLevel,
              pendingPostLockoutLoginAudit: true,
              updatedAt: txNowIso,
            },
            { merge: true }
          );

          tx.update(userRef, {
            isLocked: false,
            lockStatus: 'ACTIVE',
            lockPolicyType: 'PROGRESSIVE_TEMPORARY',
            consecutiveFailedAttempts: 0,
            lockedAt: null,
            lockoutUntil: null,
            lockedUntil: null,
            lockedUntilMs: null,
            lockDurationMinutes: null,
            lockReason: null,
            lastLockExpiredAt: txNowIso,
            progressiveLockLevel: retainedLevel,
            pendingPostLockoutLoginAudit: true,
            updatedAt: txNowIso,
          });

          return {
            kind: 'REACTIVATED' as const,
            serverNowMs: txNowMs,
            nowIso: txNowIso,
            firebaseUid: String(freshUser.authUid || userDoc.id),
            authUid: freshUser.authUid || null,
            role: String(freshUser.role || 'super_admin'),
            status: String(freshUser.status || 'Active'),
            previousLockedAt,
            previousLockedUntil,
            previousDurationMinutes,
            retainedLevel,
          };
        });

        if (txResult.kind === 'REACTIVATED') {
          await syncUserUidIndex(db, {
            uid: txResult.authUid,
            roleDocId: userDoc.id,
            role: txResult.role,
            status: txResult.status,
            lockStatus: 'ACTIVE',
            lockedUntilMs: null,
            loginId: 'superadmin',
          });

          const telemetry = await captureTelemetryContext(db, req);
          await Promise.all([
            recordSecurityAuditLogDoc(db, {
              action: 'LOCKOUT_EXPIRED_REACTIVATED',
              severity: 'INFO',
              targetLoginId: 'superadmin',
              targetRole: 'SUPER_ADMIN',
              targetUid: txResult.firebaseUid,
              reason: 'Super Admin temporary lockout duration expired; account automatically reactivated',
              details: `Temporary lockout for canonical Super Admin "superadmin" expired at ${txResult.previousLockedUntil || txResult.nowIso}. Verified server-side and reactivated with progressive level ${txResult.retainedLevel} retained.`,
              metadata: {
                previousLockedAt: txResult.previousLockedAt,
                previousLockedUntil: txResult.previousLockedUntil,
                previousDurationMinutes: txResult.previousDurationMinutes,
                retainedProgressiveLevel: txResult.retainedLevel,
                verifiedVia: 'LOCKOUT_STATUS_CHECK',
              },
              nowMs: txResult.serverNowMs,
              telemetry,
            }),
            recordEnterpriseAuditEvent(db, {
              req,
              action: 'super_admin_lockout_expired',
              category: 'SECURITY',
              severity: 'INFO',
              actorUid: txResult.firebaseUid,
              actorLoginId: 'superadmin',
              actorRole: 'SUPER_ADMIN',
              targetType: 'ACCOUNT',
              targetId: userDoc.id,
              oldValue: {
                lockStatus: 'LOCKED',
                lockoutUntil: txResult.previousLockedUntil,
                lockDurationMinutes: txResult.previousDurationMinutes,
              },
              newValue: {
                lockStatus: 'ACTIVE',
                consecutiveFailedAttempts: 0,
                progressiveLockLevel: txResult.retainedLevel,
              },
              actionSource: 'PROGRESSIVE_LOCKOUT_ENGINE',
              description: `Canonical Super Admin "superadmin" temporary lockout expired and was automatically reactivated upon server verification (progressive level ${txResult.retainedLevel} retained).`,
              success: true,
            }),
          ]);
        }

        return txResult;
      });

      if (reactivationOutcome.kind === 'STILL_LOCKED') {
        return res.json({
          success: true,
          locked: true,
          temporaryLock: true,
          loginId: 'superadmin',
          lockoutUntil: reactivationOutcome.lockoutUntil,
          lockedUntil: reactivationOutcome.lockoutUntil,
          lockedUntilMs: reactivationOutcome.lockedUntilMs,
          serverNowMs: reactivationOutcome.serverNowMs,
          remainingSeconds: reactivationOutcome.remainingSeconds,
          lockDurationMinutes: reactivationOutcome.lockDurationMinutes,
        });
      }

      return res.json({
        success: true,
        locked: false,
        temporaryLock: false,
        expiredReactivated: reactivationOutcome.kind === 'REACTIVATED',
        serverNowMs: reactivationOutcome.serverNowMs,
      });
    } catch (err: any) {
      if (isFirestorePermissionDeniedError(err)) {
        const msg = formatAdminPermissionDeniedError(projectId, TARGET_DATABASE_ID);
        return res.status(503).json({
          success: false,
          code: 'FIREBASE_ADMIN_PERMISSION_DENIED',
          error: msg,
        });
      }
      console.error('[Lockout Status API] Error:', err);
      return res.status(500).json({
        success: false,
        error: 'Failed to check lockout status.',
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

      const [usersSnap, secSnap, attemptsSnap, secLogsSnap, superAdminLockoutResetHours] =
        await Promise.all([
          db.collection('user_roles').get(),
          db.collection('account_security').get(),
          db.collection('login_attempts').get(),
          db.collection('security_audit_logs').get(),
          resolveSuperAdminLockoutResetHours(db),
        ]);
      const nowMs = getNowMs();

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
        const isCanonicalSA = isCanonicalSuperAdminAccount(uDoc.id, uData);
        const saLockWindow = isCanonicalSA
          ? resolveCanonicalSuperAdminLockWindow(sec, uData)
          : {
              lockedUntilMs: resolveAuthoritativeLockedUntilMs(sec, uData),
              lockoutUntil: null,
              lockDurationMinutes: null,
            };
        const lockedUntilMs = saLockWindow.lockedUntilMs;

        const rawIsLocked =
          sec.lockStatus === 'LOCKED' || uData.lockStatus === 'LOCKED' || uData.isLocked === true;
        const lockoutExpiredPendingLogin = Boolean(
          isCanonicalSA && rawIsLocked && lockedUntilMs !== null && nowMs >= lockedUntilMs
        );
        const effectiveLockStatus =
          rawIsLocked && !lockoutExpiredPendingLogin ? 'LOCKED' : 'ACTIVE';
        const remainingLockSeconds =
          isCanonicalSA && effectiveLockStatus === 'LOCKED' && lockedUntilMs !== null
            ? Math.max(0, Math.ceil((lockedUntilMs - nowMs) / 1000))
            : 0;
        const effectiveLockedUntilIso =
          effectiveLockStatus === 'LOCKED'
            ? saLockWindow.lockoutUntil || resolveAuthoritativeLockedUntilIso(lockedUntilMs, sec, uData)
            : null;

        accountMap.set(loginId, {
          id: sec.id || `sec_${loginId}`,
          roleDocId: uDoc.id,
          loginId,
          name: uData.name || loginId.toUpperCase(),
          email: uData.email || `${loginId}@narid.com`,
          role: String(uData.role || 'USER').toUpperCase(),
          firebaseUid: sec.firebaseUid || uData.authUid || uDoc.id,
          accountStatus: uData.status || 'Active',
          lockStatus: effectiveLockStatus,
          lockPolicyType: isCanonicalSA ? 'PROGRESSIVE_TEMPORARY' : 'PERMANENT_MANUAL',
          consecutiveFailedAttempts: lockoutExpiredPendingLogin
            ? 0
            : Number(sec.consecutiveFailedAttempts ?? uData.consecutiveFailedAttempts ?? 0),
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
          lockedAt: effectiveLockStatus === 'LOCKED' ? (sec.lockedAt || uData.lockedAt || null) : null,
          lockoutUntil: effectiveLockedUntilIso,
          lockedUntil: effectiveLockedUntilIso,
          lockedUntilMs: effectiveLockStatus === 'LOCKED' ? lockedUntilMs : null,
          lockDurationMinutes:
            effectiveLockStatus === 'LOCKED'
              ? (saLockWindow.lockDurationMinutes ?? sec.lockDurationMinutes ?? uData.lockDurationMinutes ?? null)
              : null,
          remainingLockSeconds,
          lockoutExpiredPendingLogin,
          lockReason: effectiveLockStatus === 'LOCKED' ? (sec.lockReason || uData.lockReason || null) : null,
          progressiveLockLevel: isCanonicalSA
            ? Number(sec.progressiveLockLevel ?? uData.progressiveLockLevel ?? 0)
            : 0,
          totalLockoutEvents: isCanonicalSA
            ? Number(sec.totalLockoutEvents ?? uData.totalLockoutEvents ?? 0)
            : 0,
          lastLockoutAt: isCanonicalSA ? (sec.lastLockoutAt || uData.lastLockoutAt || null) : null,
          lastLockExpiredAt: isCanonicalSA
            ? (sec.lastLockExpiredAt || uData.lastLockExpiredAt || null)
            : null,
          cleanWindowStartAt: isCanonicalSA
            ? (sec.cleanWindowStartAt || uData.cleanWindowStartAt || null)
            : null,
          cleanWindowStartMs: isCanonicalSA
            ? (typeof sec.cleanWindowStartMs === 'number'
                ? sec.cleanWindowStartMs
                : typeof uData.cleanWindowStartMs === 'number'
                  ? uData.cleanWindowStartMs
                  : null)
            : null,
          cleanLoginsSinceLastLockout: isCanonicalSA
            ? Number(sec.cleanLoginsSinceLastLockout ?? uData.cleanLoginsSinceLastLockout ?? 0)
            : 0,
          lockoutLevelResetAt: isCanonicalSA
            ? (sec.lockoutLevelResetAt || uData.lockoutLevelResetAt || null)
            : null,
          lockoutLevelResetReason: isCanonicalSA
            ? (sec.lockoutLevelResetReason || uData.lockoutLevelResetReason || null)
            : null,
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
        superAdminLockoutResetHours,
        serverNowMs: nowMs,
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
              lockoutUntil: null,
              lockedUntil: null,
              lockedUntilMs: null,
              lockDurationMinutes: null,
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
            lockoutUntil: null,
            lockedUntil: null,
            lockedUntilMs: null,
            lockDurationMinutes: null,
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

  // I. Explicit Approved Super Admin Progressive Lockout Level Reset (Strictly SUPER_ADMIN Only + Fresh Auth)
  app.post('/api/security/reset-superadmin-lockout-level', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        ['super_admin'],
        'Reset Super Admin Progressive Lockout Level'
      );
      if (!caller) return;

      const parsed = ResetSuperAdminLockoutLevelSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: parsed.error.issues[0]?.message || 'Invalid lockout level reset request.',
        });
      }

      const reason = parsed.data.reason.trim();
      const freshPassword = parsed.data.freshSuperAdminPassword;
      const telemetry = await captureTelemetryContext(db, req);
      const nowMs = getNowMs();
      const now = new Date(nowMs).toISOString();

      const nowSec = Math.floor(nowMs / 1000);
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
            targetLoginId: 'superadmin',
            targetRole: 'SUPER_ADMIN',
            actorUid: caller.uid,
            actorLoginId: caller.loginId,
            actorRole: 'SUPER_ADMIN',
            reason: 'Failed fresh Super Admin password verification for progressive lockout level reset',
            details: `Super Admin "${caller.loginId}" entered an incorrect password during fresh re-authentication check for progressive lockout level reset.`,
            nowMs,
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
            'Fresh Super Admin authentication is required before resetting the progressive lockout level. Please enter your current Super Admin password.',
        });
      }

      const resetResult = await withLoginIdLock('superadmin', async () => {
        let userDoc = await db.collection('user_roles').doc('role_superadmin').get();
        if (!userDoc.exists) {
          const snap = await db.collection('user_roles').where('loginId', '==', 'superadmin').limit(1).get();
          if (!snap.empty) userDoc = snap.docs[0];
        }
        if (!userDoc || !userDoc.exists) {
          return { notFound: true as const };
        }

        const userData = userDoc.data() || {};
        if (!isCanonicalSuperAdminAccount(userDoc.id, userData)) {
          return { notFound: true as const };
        }

        const firebaseUid = String(userData.authUid || userDoc.id);
        const secRef = db.collection('account_security').doc('sec_superadmin');
        const userRef = db.collection('user_roles').doc(userDoc.id);

        let previousLevel = 0;
        let totalLockoutEvents = 0;

        await db.runTransaction(async (tx) => {
          const [secSnap, freshUserSnap] = await Promise.all([tx.get(secRef), tx.get(userRef)]);
          const curSec = secSnap.exists ? (secSnap.data() || {}) : {};
          const freshUser = freshUserSnap.exists ? (freshUserSnap.data() || {}) : userData;

          previousLevel = Number(curSec.progressiveLockLevel ?? freshUser.progressiveLockLevel ?? 0);
          totalLockoutEvents = Number(curSec.totalLockoutEvents ?? freshUser.totalLockoutEvents ?? 0);

          tx.set(
            secRef,
            {
              ...curSec,
              id: 'sec_superadmin',
              loginId: 'superadmin',
              role: 'SUPER_ADMIN',
              firebaseUid,
              email: freshUser.email || 'superadmin@narid.com',
              lockPolicyType: 'PROGRESSIVE_TEMPORARY',
              progressiveLockLevel: 0,
              consecutiveFailedAttempts: 0,
              cleanWindowStartAt: null,
              cleanWindowStartMs: null,
              cleanLoginsSinceLastLockout: 0,
              lockoutLevelResetAt: now,
              lockoutLevelResetReason: reason,
              updatedAt: now,
            },
            { merge: true }
          );

          tx.update(userRef, {
            progressiveLockLevel: 0,
            consecutiveFailedAttempts: 0,
            cleanWindowStartAt: null,
            cleanWindowStartMs: null,
            cleanLoginsSinceLastLockout: 0,
            lockoutLevelResetAt: now,
            lockoutLevelResetReason: reason,
            updatedAt: now,
          });
        });

        await Promise.all([
          recordSecurityAuditLogDoc(db, {
            action: 'LOCKOUT_LEVEL_RESET',
            severity: 'CRITICAL',
            targetLoginId: 'superadmin',
            targetRole: 'SUPER_ADMIN',
            targetUid: firebaseUid,
            actorUid: caller.uid,
            actorLoginId: caller.loginId,
            actorRole: 'SUPER_ADMIN',
            reason,
            details: `Super Admin "${caller.loginId}" explicitly reset canonical Super Admin progressive lockout level from ${previousLevel} to 0. Historical lockout count (${totalLockoutEvents}) preserved. Reason: ${reason}`,
            metadata: {
              resetType: 'MANUAL_APPROVED_RESET',
              previousLevel,
              newLevel: 0,
              totalLockoutEventsPreserved: totalLockoutEvents,
            },
            nowMs,
            telemetry,
          }),
          recordEnterpriseAuditEvent(db, {
            req,
            action: 'super_admin_lockout_level_reset',
            category: 'SECURITY',
            severity: 'CRITICAL',
            actorUid: caller.uid,
            actorLoginId: caller.loginId,
            actorRole: 'SUPER_ADMIN',
            targetType: 'ACCOUNT',
            targetId: userDoc.id,
            oldValue: { progressiveLockLevel: previousLevel },
            newValue: {
              progressiveLockLevel: 0,
              resetType: 'MANUAL_APPROVED_RESET',
              totalLockoutEventsPreserved: totalLockoutEvents,
              reason,
            },
            actionSource: 'SECURITY_CONTROL_LOCKOUT_RESET',
            reason,
            description: `Super Admin "${caller.loginId}" reset canonical Super Admin progressive lockout level from ${previousLevel} to 0.`,
            success: true,
          }),
        ]);

        return {
          notFound: false as const,
          previousLevel,
          newLevel: 0,
          totalLockoutEvents,
          resetAt: now,
        };
      });

      if (resetResult.notFound) {
        return res.status(404).json({
          success: false,
          error: 'Canonical Super Admin account not found.',
        });
      }

      return res.json({
        success: true,
        message: `Super Admin progressive lockout level reset from ${resetResult.previousLevel} to 0. Full lockout history (${resetResult.totalLockoutEvents} events) preserved.`,
        ...resetResult,
      });
    } catch (err: any) {
      if (isFirestorePermissionDeniedError(err)) {
        const msg = formatAdminPermissionDeniedError(projectId, TARGET_DATABASE_ID);
        return res.status(503).json({ success: false, code: 'FIREBASE_ADMIN_PERMISSION_DENIED', error: msg });
      }
      console.error('[Security Reset Super Admin Lockout Level API] Error:', err);
      return res.status(500).json({
        success: false,
        error: err?.message || 'Failed to reset Super Admin progressive lockout level.',
      });
    }
  });
}
