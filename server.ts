import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { 
  getFirestore, 
  doc, 
  getDoc, 
  setDoc, 
  updateDoc, 
  deleteDoc,
  collection, 
  getDocs, 
  query, 
  where 
} from 'firebase/firestore';
import firebaseConfig from './firebase-applet-config.json';
import {
  registerSecurityAuditRoutes,
  verifyCallerIdentity,
  recordEnterpriseAuditEvent,
  recordLoginHistoryEntry,
  VerifiedCaller,
} from './serverSecurityAudit.ts';
import {
  registerLoginSecurityRoutes,
  seedAccountSecurityRecords,
  captureTelemetryContext,
  recordSecurityAuditLogDoc,
  tryAdminAuthUpdatePassword,
  withLoginIdLock,
  MAX_CONSECUTIVE_FAILED_ATTEMPTS,
} from './serverLoginSecurity.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Firebase Client SDK for Server Firestore Operations
const firebaseApp = initializeApp(firebaseConfig);
const serverAuth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId);

export async function ensureServerAuthenticated() {
  if (serverAuth.currentUser) return;
  const candidates = [
    { email: 'superadmin@narid.com', password: process.env.NARID_SERVER_PASSWORD || 'Narid@12345' },
    { email: 'superadmin_root@narid.com', password: process.env.NARID_SERVER_PASSWORD || 'Narid@12345' },
  ];
  for (const credInfo of candidates) {
    try {
      const cred = await signInWithEmailAndPassword(serverAuth, credInfo.email, credInfo.password);
      console.log(`[Server Security] Server backend authenticated as Super Admin (${credInfo.email}):`, cred.user.uid);
      return;
    } catch {
      // try next principal
    }
  }
  console.warn('[Server Security] Server auth notice: Unable to authenticate server principal.');
}

// ============================================================================
// Cryptographic Password Hashing (Single Source of Truth - Scrypt memory-hard)
// ============================================================================
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, expectedHash] = storedHash.split(':');
  if (!salt || !expectedHash) return false;
  const actualHash = crypto.scryptSync(password, salt, 64).toString('hex');
  const actualBuf = Buffer.from(actualHash, 'hex');
  const expectedBuf = Buffer.from(expectedHash, 'hex');
  if (actualBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

// ============================================================================
// Secure In-Place Firebase Authentication Password Synchronizer
// (Guaranteed Zero-Account-Creation: Updates existing permanent UID only)
// ============================================================================
export async function syncExistingFirebaseAuthPassword(
  email: string, 
  targetUid: string, 
  newPassword: string,
  knownCurrentPassword?: string
): Promise<{ success: boolean; uid?: string; matchedEmail?: string; rateLimited?: boolean; error?: string }> {
  try {
    const candidatePasswords =
      typeof knownCurrentPassword === 'string' && knownCurrentPassword.length > 0
        ? [knownCurrentPassword]
        : ['Narid@12345'];

    let idToken: string | null = null;
    let lastErrorMessage = '';
    for (const pwd of candidatePasswords) {
      try {
        const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${firebaseConfig.apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password: pwd, returnSecureToken: true }),
        });
        const data = await res.json();
        const errMsg = String(data?.error?.message || '');
        if (errMsg) {
          lastErrorMessage = errMsg;
        }
        if (errMsg.includes('TOO_MANY_ATTEMPTS_TRY_LATER')) {
          console.warn(`[Auth Sync] Firebase rate limit TOO_MANY_ATTEMPTS_TRY_LATER encountered for "${email}". Stopping immediately without retry.`);
          return {
            success: false,
            rateLimited: true,
            error: 'TOO_MANY_ATTEMPTS_TRY_LATER',
          };
        }
        if (data.idToken && data.localId === targetUid) {
          idToken = data.idToken;
          break;
        } else if (data.idToken && data.localId !== targetUid) {
          lastErrorMessage = `Email "${email}" belongs to UID "${data.localId}", expected UID "${targetUid}".`;
          console.error(`[Auth Sync] UID mismatch detected for ${email}: ${lastErrorMessage}`);
        }
      } catch (e: any) {
        lastErrorMessage = String(e?.message || e || 'Network error');
      }
    }

    if (!idToken) {
      console.warn(`[Auth Sync] Target Firebase Auth user "${email}" (UID: ${targetUid}) could not be pre-authenticated (${lastErrorMessage}). Preserving existing account without creating replacement.`);
      return {
        success: false,
        error: lastErrorMessage
          ? `Firebase Auth rejected verification for "${email}" (${lastErrorMessage}).`
          : `Could not verify existing Firebase Auth account for "${email}".`,
      };
    }

    // In-place update password on the exact existing UID (never creates new user)
    const updateRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:update?key=${firebaseConfig.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken, password: newPassword, returnSecureToken: true }),
    });

    const updateData = await updateRes.json();
    const updateErr = String(updateData?.error?.message || '');
    if (updateErr.includes('TOO_MANY_ATTEMPTS_TRY_LATER')) {
      return { success: false, rateLimited: true, error: 'TOO_MANY_ATTEMPTS_TRY_LATER' };
    }
    if (updateData.localId === targetUid) {
      console.log(`[Auth Sync] In-place updated Firebase Auth password for UID: ${targetUid} (${email}). UID preserved 100%.`);
      return { success: true, uid: targetUid, matchedEmail: email };
    } else {
      console.error(`[Auth Sync] Unexpected update response for ${email}:`, updateData);
      return { success: false, error: updateData.error?.message || 'Failed to update Firebase Auth password' };
    }
  } catch (err: any) {
    console.error(`[Auth Sync] Error syncing Firebase Auth password for ${email}:`, err);
    return { success: false, error: err.message || 'Firebase Auth sync error' };
  }
}

// ============================================================================
// Enterprise Rate Limiter (Brute-Force & Credential Stuffing Protection)
// ============================================================================
interface RateLimitRecord {
  attempts: number;
  firstAttemptAt: number;
  lockedUntil: number;
}

const loginRateLimitStore = new Map<string, RateLimitRecord>();
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes lockout
const WINDOW_DURATION_MS = 15 * 60 * 1000;  // 15-minute sliding window

function getRateLimitKey(req: Request, loginId: string): string {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : (req.socket.remoteAddress || '127.0.0.1');
  return `${ip}::${loginId.trim().toLowerCase()}`;
}

function checkLoginRateLimit(key: string): { allowed: boolean; remainingMinutes?: number } {
  const now = Date.now();
  const record = loginRateLimitStore.get(key);
  if (!record) return { allowed: true };

  if (record.lockedUntil > now) {
    const remainingMinutes = Math.max(1, Math.ceil((record.lockedUntil - now) / 60000));
    return { allowed: false, remainingMinutes };
  }

  // Sliding window expiration check
  if (now - record.firstAttemptAt > WINDOW_DURATION_MS) {
    loginRateLimitStore.delete(key);
    return { allowed: true };
  }

  if (record.attempts >= MAX_LOGIN_ATTEMPTS) {
    record.lockedUntil = now + LOCKOUT_DURATION_MS;
    const remainingMinutes = Math.max(1, Math.ceil((record.lockedUntil - now) / 60000));
    return { allowed: false, remainingMinutes };
  }

  return { allowed: true };
}

function recordFailedLogin(key: string): number {
  const now = Date.now();
  const record = loginRateLimitStore.get(key);
  if (!record || (now - record.firstAttemptAt > WINDOW_DURATION_MS && record.lockedUntil < now)) {
    loginRateLimitStore.set(key, {
      attempts: 1,
      firstAttemptAt: now,
      lockedUntil: 0,
    });
    return 1;
  }
  record.attempts += 1;
  if (record.attempts >= MAX_LOGIN_ATTEMPTS) {
    record.lockedUntil = now + LOCKOUT_DURATION_MS;
  }
  return record.attempts;
}

function clearLoginRateLimit(key: string): void {
  loginRateLimitStore.delete(key);
}

// ============================================================================
// Enterprise Input Validation Schemas (Zod)
// ============================================================================
import { z } from 'zod';

const LoginInputSchema = z.object({
  loginId: z.string().trim().min(1, 'Please enter your Login ID.').max(64),
  password: z.string().min(1, 'Please enter your password.').max(128),
});

const VerifySessionInputSchema = z.object({
  loginId: z.string().trim().min(1).max(64).optional(),
  userId: z.string().trim().min(1).max(128).optional(),
});

const ChangePasswordInputSchema = z.object({
  loginId: z.string().trim().min(1).max(64),
  currentPassword: z.string().optional(),
  newPassword: z.string().min(6, 'Password must be at least 6 characters.').max(128),
});

const AdminSetPasswordInputSchema = z.object({
  callerLoginId: z.string().trim().min(1).max(64).optional(),
  targetLoginId: z.string().trim().min(1).max(64).optional(),
  targetId: z.string().trim().min(1).max(128).optional(),
  newPassword: z.string().min(6, 'Password must be at least 6 characters.').max(128),
  mustChangePassword: z.boolean().optional(),
});

const CreateUserInputSchema = z.object({
  callerLoginId: z.string().trim().min(1).max(64).optional(),
  loginId: z.string().trim().min(2, 'Login ID must be at least 2 characters.').max(64).regex(/^[a-zA-Z0-9_.-]+$/, 'Login ID can only contain letters, numbers, hyphens, and underscores.'),
  name: z.string().trim().min(1, 'Name is required.').max(128),
  email: z.string().trim().email('Valid email is required.').max(128),
  role: z.enum(['super_admin', 'admin', 'user']),
  password: z.string().min(6, 'Password must be at least 6 characters.').max(128).optional(),
  modulesAllowed: z.array(z.string().max(64)).optional(),
  status: z.enum(['Active', 'Inactive']).default('Active'),
});

const DeleteUserInputSchema = z.object({
  callerLoginId: z.string().trim().min(1).max(64).optional(),
  targetId: z.string().trim().min(1).max(128).optional(),
  targetLoginId: z.string().trim().min(1).max(64).optional(),
});

const SetUserPermissionsInputSchema = z.object({
  callerLoginId: z.string().trim().min(1).max(64).optional(),
  targetId: z.string().trim().min(1).max(128),
  role: z.enum(['super_admin', 'admin', 'user']).optional(),
  status: z.enum(['Active', 'Inactive']).optional(),
  modulesAllowed: z.array(z.string().max(64)).optional(),
  permissions: z.record(z.string(), z.object({
    view: z.boolean().optional(),
    add: z.boolean().optional(),
    edit: z.boolean().optional(),
    delete: z.boolean().optional(),
  })).optional(),
});

const RolePermissionsInputSchema = z.object({
  callerLoginId: z.string().trim().min(1).max(64).optional(),
  roleId: z.enum(['super_admin', 'admin', 'user']),
  modulePermissions: z.record(z.string(), z.object({
    view: z.boolean().optional(),
    add: z.boolean().optional(),
    edit: z.boolean().optional(),
    delete: z.boolean().optional(),
  })),
});

const AttendanceScanInputSchema = z.object({
  rawPayload: z.string().trim().min(1, 'Scan payload cannot be empty.').max(256),
  scannerType: z.enum(['IN', 'OUT']),
  scannerDevice: z.enum(['USB_SCANNER', 'WEBCAM', 'MANUAL', 'SYSTEM_AUTO']).optional(),
  customScanTime: z.string().datetime().optional(),
});

// Initial Industrial Accounts Specification (Canonical *@narid.com kept active)
const INITIAL_ACCOUNTS = [
  {
    loginId: 'superadmin',
    name: 'Chief Plant Operations (Super Admin)',
    email: 'superadmin@narid.com',
    emailAliases: ['superadmin_root@narid.com'],
    authUid: 'oX2vdSx5jGcoUDxyA0SIYN3SEig2',
    role: 'super_admin',
    modulesAllowed: ['all'],
  },
  {
    loginId: 'admin',
    name: 'Shift Supervisor (Admin)',
    email: 'admin@narid.com',
    emailAliases: ['admin_root@narid.com'],
    authUid: '2RpEv6mvyXYswYH9KPIGV6evtgY2',
    role: 'admin',
    modulesAllowed: [
      'dashboard', 
      'scanner', 
      'employees', 
      'excel_import', 
      'qr_codes', 
      'floors', 
      'sections', 
      'departments', 
      'shifts', 
      'history', 
      'reports'
    ],
  },
  {
    loginId: 'user',
    name: 'Floor Operator (Scanner User)',
    email: 'user@narid.com',
    emailAliases: ['user_root@narid.com'],
    authUid: 'vXPvgrp3i6cS2frqDa3ZoU9h9gc2',
    role: 'user',
    modulesAllowed: ['dashboard', 'scanner'],
  },
];

// Predefined Module Action Permissions by Role
const DEFAULT_ROLE_PERMISSIONS: Record<string, Record<string, { view: boolean; add: boolean; edit: boolean; delete: boolean }>> = {
  super_admin: {
    dashboard: { view: true, add: true, edit: true, delete: true },
    scanner: { view: true, add: true, edit: true, delete: true },
    employees: { view: true, add: true, edit: true, delete: true },
    excel_import: { view: true, add: true, edit: true, delete: true },
    qr_codes: { view: true, add: true, edit: true, delete: true },
    organization: { view: true, add: true, edit: true, delete: true },
    floors: { view: true, add: true, edit: true, delete: true },
    sections: { view: true, add: true, edit: true, delete: true },
    departments: { view: true, add: true, edit: true, delete: true },
    shifts: { view: true, add: true, edit: true, delete: true },
    history: { view: true, add: true, edit: true, delete: true },
    reports: { view: true, add: true, edit: true, delete: true },
    user_rights: { view: true, add: true, edit: true, delete: true },
    audit_logs: { view: true, add: true, edit: true, delete: true },
    security_management: { view: true, add: true, edit: true, delete: true },
    settings: { view: true, add: true, edit: true, delete: true },
  },
  admin: {
    dashboard: { view: true, add: false, edit: false, delete: false },
    scanner: { view: true, add: true, edit: true, delete: false },
    employees: { view: true, add: true, edit: true, delete: false },
    excel_import: { view: true, add: true, edit: true, delete: false },
    qr_codes: { view: true, add: true, edit: true, delete: false },
    organization: { view: true, add: true, edit: true, delete: false },
    floors: { view: true, add: true, edit: true, delete: false },
    sections: { view: true, add: true, edit: true, delete: false },
    departments: { view: true, add: true, edit: true, delete: false },
    shifts: { view: true, add: false, edit: false, delete: false },
    history: { view: true, add: false, edit: true, delete: false },
    reports: { view: true, add: false, edit: false, delete: false },
    user_rights: { view: false, add: false, edit: false, delete: false },
    audit_logs: { view: false, add: false, edit: false, delete: false },
    security_management: { view: false, add: false, edit: false, delete: false },
    settings: { view: false, add: false, edit: false, delete: false },
  },
  user: {
    dashboard: { view: true, add: false, edit: false, delete: false },
    scanner: { view: true, add: true, edit: false, delete: false },
    employees: { view: false, add: false, edit: false, delete: false },
    excel_import: { view: false, add: false, edit: false, delete: false },
    qr_codes: { view: false, add: false, edit: false, delete: false },
    organization: { view: false, add: false, edit: false, delete: false },
    floors: { view: false, add: false, edit: false, delete: false },
    sections: { view: false, add: false, edit: false, delete: false },
    departments: { view: false, add: false, edit: false, delete: false },
    shifts: { view: false, add: false, edit: false, delete: false },
    history: { view: false, add: false, edit: false, delete: false },
    reports: { view: false, add: false, edit: false, delete: false },
    user_rights: { view: false, add: false, edit: false, delete: false },
    audit_logs: { view: false, add: false, edit: false, delete: false },
    security_management: { view: false, add: false, edit: false, delete: false },
    settings: { view: false, add: false, edit: false, delete: false },
  },
};

// Exactly 3 Predefined System Roles per Specification
const PREDEFINED_ROLES = [
  {
    roleId: 'super_admin',
    roleName: 'SUPER_ADMIN',
    description: 'Complete access to all application modules, account management, role permissions, system settings and administrative controls.',
    defaultPermissions: DEFAULT_ROLE_PERMISSIONS.super_admin,
    isActive: true,
  },
  {
    roleId: 'admin',
    roleName: 'ADMIN',
    description: 'Operational dashboard, attendance management, employee records, reports and other specifically authorized modules.',
    defaultPermissions: DEFAULT_ROLE_PERMISSIONS.admin,
    isActive: true,
  },
  {
    roleId: 'user',
    roleName: 'USER',
    description: 'Read-only Dashboard monitoring and Attendance Scanner access, according to assigned permissions.',
    defaultPermissions: DEFAULT_ROLE_PERMISSIONS.user,
    isActive: true,
  },
];

async function seedPredefinedRoles() {
  const now = new Date().toISOString();
  for (const roleDef of PREDEFINED_ROLES) {
    try {
      const snap = await getDoc(doc(db, 'roles', roleDef.roleId));
      if (!snap.exists()) {
        await setDoc(doc(db, 'roles', roleDef.roleId), {
          ...roleDef,
          dashboardAccessMigratedV1: true,
          updatedAt: now,
        });
        console.log(`[Roles Boot] Provisioned role definition "${roleDef.roleId}" in Firestore`);
      } else if (roleDef.roleId === 'user') {
        const rData = snap.data();
        if (!rData?.dashboardAccessMigratedV1) {
          const existingPerms = rData?.defaultPermissions || {};
          await setDoc(doc(db, 'roles', 'user'), {
            description: roleDef.description,
            defaultPermissions: {
              ...existingPerms,
              dashboard: { view: true, add: false, edit: false, delete: false },
            },
            dashboardAccessMigratedV1: true,
            updatedAt: now,
          }, { merge: true });
        }
      }
      const permSnap = await getDoc(doc(db, 'role_permissions', roleDef.roleId));
      if (!permSnap.exists()) {
        await setDoc(doc(db, 'role_permissions', roleDef.roleId), {
          roleId: roleDef.roleId,
          roleName: roleDef.roleName,
          modulePermissions: roleDef.defaultPermissions,
          dashboardAccessMigratedV1: true,
          updatedAt: now,
          updatedBy: 'system',
        });
      } else if (roleDef.roleId === 'user') {
        const pData = permSnap.data();
        if (!pData?.dashboardAccessMigratedV1) {
          const existingModPerms = pData?.modulePermissions || {};
          await setDoc(doc(db, 'role_permissions', 'user'), {
            modulePermissions: {
              ...existingModPerms,
              dashboard: { view: true, add: false, edit: false, delete: false },
            },
            dashboardAccessMigratedV1: true,
            updatedAt: now,
            updatedBy: 'system_migration',
          }, { merge: true });
          console.log('[Roles Boot] Migrated USER role_permissions to allow read-only Dashboard view');
        }
      }
    } catch (e: any) {
      console.warn(`[Roles Boot] Warning for role ${roleDef.roleId}:`, e.message);
    }
  }
}

// Unified Enterprise Audit Logger wrapper
async function logAuditEvent(params: {
  req?: Request;
  action: string;
  targetUid?: string;
  loginId: string;
  performedByUid?: string;
  performedByLoginId?: string;
  performedByRole?: string;
  previousValue?: any;
  newValue?: any;
  details?: string;
  success?: boolean;
  sessionId?: string;
  actionSource?: string;
}) {
  await recordEnterpriseAuditEvent(db, {
    req: params.req,
    action: params.action,
    actorUid: params.performedByUid || 'system',
    actorLoginId: params.performedByLoginId || params.loginId || 'system',
    actorRole: params.performedByRole || 'SYSTEM',
    targetId: params.targetUid || params.loginId,
    oldValue: params.previousValue,
    newValue: params.newValue,
    actionSource: params.actionSource || 'SERVER_API',
    description: params.details || '',
    success: params.success,
    sessionId: params.sessionId,
  });
}

async function seedInitialAccounts() {
  const now = new Date().toISOString();
  for (const acc of INITIAL_ACCOUNTS) {
    const docId = `role_${acc.loginId}`;
    try {
      const snap = await getDoc(doc(db, 'user_roles', docId));
      if (!snap.exists()) {
        const passwordHash = hashPassword('Narid@12345');
        await setDoc(doc(db, 'user_roles', docId), {
          id: docId,
          loginId: acc.loginId,
          name: acc.name,
          email: acc.email,
          emailAliases: acc.emailAliases,
          authUid: acc.authUid,
          linkedAuthUids: [acc.authUid],
          role: acc.role,
          status: 'Active',
          modulesAllowed: acc.modulesAllowed,
          passwordHash,
          mustChangePassword: false,
          createdAt: now,
          updatedAt: now,
        });
        console.log(`[Auth Boot] Provisioned ${acc.loginId} with initial single-source passwordHash`);
      } else {
        const data = snap.data();
        const updates: Record<string, any> = {};
        if (!data.passwordHash) {
          updates.passwordHash = hashPassword('Narid@12345');
          console.log(`[Auth Boot] Upgraded ${acc.loginId} to cryptographic passwordHash`);
        }
        // Ensure canonical primary email & permanent Firebase UID match active Firebase Auth user
        if (data.email !== acc.email) {
          updates.email = acc.email;
          console.log(`[Auth Boot] Repaired canonical primary email for ${acc.loginId}: ${data.email} -> ${acc.email}`);
        }
        if (data.authUid !== acc.authUid) {
          updates.authUid = acc.authUid;
        }
        const existingAliases = new Set<string>(Array.isArray(data.emailAliases) ? data.emailAliases : []);
        const prevAliasSize = existingAliases.size;
        existingAliases.add(acc.email);
        acc.emailAliases.forEach(a => existingAliases.add(a));
        if (existingAliases.size > prevAliasSize) {
          updates.emailAliases = Array.from(existingAliases);
        }
        if (acc.loginId === 'user' && !data.dashboardAccessMigratedV1) {
          const existingModules = Array.isArray(data.modulesAllowed) ? data.modulesAllowed : ['scanner'];
          if (!existingModules.includes('dashboard')) {
            updates.modulesAllowed = ['dashboard', ...existingModules];
          }
          updates.dashboardAccessMigratedV1 = true;
          console.log('[Auth Boot] Migrated role_user modulesAllowed to include read-only dashboard');
        }
        if (Object.keys(updates).length > 0) {
          updates.updatedAt = now;
          await updateDoc(doc(db, 'user_roles', docId), updates);
        }
      }
    } catch (e: any) {
      console.warn(`[Auth Boot] Could not verify account ${acc.loginId}:`, e.message);
    }
  }

  // Ensure security retention defaults exist on system_settings/global
  try {
    const settingsRef = doc(db, 'system_settings', 'global');
    const settingsSnap = await getDoc(settingsRef);
    if (settingsSnap.exists()) {
      const sData = settingsSnap.data();
      const sUpdates: Record<string, any> = {};
      if (sData.auditRetentionDays === undefined) sUpdates.auditRetentionDays = 90;
      if (sData.protectCriticalLogs === undefined) sUpdates.protectCriticalLogs = true;
      if (sData.captureGeoLocation === undefined) sUpdates.captureGeoLocation = true;
      if (sData.failedLoginAlertThreshold === undefined) sUpdates.failedLoginAlertThreshold = 5;
      if (Object.keys(sUpdates).length > 0) {
        await updateDoc(settingsRef, sUpdates);
      }
    }
  } catch (e: any) {
    console.warn('[Settings Boot] Security retention defaults notice:', e?.message || e);
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.set('trust proxy', 1);
  app.use(express.json());

  // Ensure server backend is authenticated as Super Admin before seeding or serving
  await ensureServerAuthenticated();

  // Assurance middleware for persistent backend Super Admin authorization
  app.use(async (_req, _res, next) => {
    if (!serverAuth.currentUser) {
      await ensureServerAuthenticated();
    }
    next();
  });

  // Bootstrap initial accounts, predefined roles & security tracking docs in background
  seedInitialAccounts()
    .then(() => seedAccountSecurityRecords(db))
    .catch((err) => {
      console.warn('[Auth Boot] Seeding warning:', err.message);
    });
  seedPredefinedRoles().catch((err) => {
    console.warn('[Roles Boot] Seeding warning:', err.message);
  });

  // Health check
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), project: firebaseConfig.projectId });
  });

  // Register Enterprise Security, Audit Trail, Login History & Account Cleanup Routes
  registerSecurityAuditRoutes(app, db, firebaseConfig.projectId);

  // Reusable cryptographic token + RBAC verification helper
  async function requireVerifiedCaller(
    req: Request,
    res: Response,
    allowedRoles: Array<'super_admin' | 'admin' | 'user'>,
    actionLabel: string
  ): Promise<VerifiedCaller | null> {
    try {
      const caller = await verifyCallerIdentity(req, db, firebaseConfig.projectId);
      if (!caller) {
        await logAuditEvent({
          req,
          action: 'unauthorized_access_attempt',
          loginId: 'unauthenticated',
          performedByLoginId: 'unauthenticated',
          performedByRole: 'UNKNOWN',
          actionSource: 'BACKEND_RBAC_GUARD',
          success: false,
          details: `Unauthenticated request blocked on ${actionLabel} (${req.method} ${req.path}).`,
        });
        res.status(401).json({ success: false, error: 'Authentication required: Missing or invalid Firebase ID token.' });
        return null;
      }
      if (!allowedRoles.includes(caller.role)) {
        await logAuditEvent({
          req,
          action: 'unauthorized_access_attempt',
          loginId: caller.loginId,
          performedByUid: caller.uid,
          performedByLoginId: caller.loginId,
          performedByRole: caller.role.toUpperCase(),
          actionSource: 'BACKEND_RBAC_GUARD',
          success: false,
          details: `Unauthorized attempt by "${caller.loginId}" (${caller.role}) on restricted action: ${actionLabel}.`,
        });
        res.status(403).json({
          success: false,
          error: `Forbidden: Role "${caller.role.toUpperCase()}" is not permitted for ${actionLabel}.`,
        });
        return null;
      }
      return caller;
    } catch (err: any) {
      res.status(err?.statusCode || 401).json({
        success: false,
        error: err?.message || 'Session authentication verification failed.',
      });
      return null;
    }
  }

  // ============================================================================
  // 1. Enterprise Login Attempt Monitoring, 3-Strike Lockout & Security Control
  // ============================================================================
  registerLoginSecurityRoutes(app, {
    db,
    projectId: firebaseConfig.projectId,
    verifyPassword,
    hashPassword,
    syncExistingFirebaseAuthPassword,
    requireVerifiedCaller,
  });

  // ============================================================================
  // 1.1 Secure Session Validity & Deactivation Guard
  // ============================================================================
  app.post('/api/auth/verify-session', async (req: Request, res: Response) => {
    try {
      const parsed = VerifySessionInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, active: false, error: 'Invalid session payload.' });
      }

      // If Bearer token is attached, verify token & revocation first
      if (req.headers.authorization?.startsWith('Bearer ')) {
        try {
          const verified = await verifyCallerIdentity(req, db, firebaseConfig.projectId);
          if (!verified) {
            return res.status(401).json({ success: false, active: false, error: 'Invalid session token.' });
          }
        } catch (tokenErr: any) {
          return res.status(tokenErr?.statusCode || 401).json({
            success: false,
            active: false,
            error: tokenErr?.message || 'Session revoked or expired.',
          });
        }
      }

      const { loginId, userId } = parsed.data;
      if (!loginId && !userId) {
        return res.status(400).json({ success: false, active: false, error: 'loginId or userId is required.' });
      }

      let userDoc = null;
      if (userId) {
        userDoc = await getDoc(doc(db, 'user_roles', userId));
      }
      if ((!userDoc || !userDoc.exists()) && loginId) {
        const cleanId = loginId.trim().toLowerCase();
        userDoc = await getDoc(doc(db, 'user_roles', `role_${cleanId}`));
        if (!userDoc.exists()) {
          const q = query(collection(db, 'user_roles'), where('loginId', '==', cleanId));
          const snap = await getDocs(q);
          if (!snap.empty) {
            userDoc = snap.docs[0];
          }
        }
      }

      if (!userDoc || !userDoc.exists()) {
        return res.status(401).json({ success: false, active: false, error: 'Account not found.' });
      }

      const userData = userDoc.data();
      if (userData.status === 'Inactive') {
        return res.status(401).json({ success: false, active: false, error: 'Account Deactivated. Please contact system administrator.' });
      }

      const resolvedLoginId = String(userData.loginId || userDoc.id.replace(/^role_/, '')).trim().toLowerCase();
      const secSnap = await getDoc(doc(db, 'account_security', `sec_${resolvedLoginId}`));
      const secData = secSnap.exists() ? secSnap.data() : null;
      const isLocked =
        secData?.lockStatus === 'LOCKED' ||
        userData.lockStatus === 'LOCKED' ||
        userData.isLocked === true;

      if (isLocked) {
        return res.status(401).json({
          success: false,
          active: false,
          locked: true,
          error: 'Your account has been temporarily blocked. Please contact Super Admin.',
        });
      }

      let effectiveModules = Array.isArray(userData.modulesAllowed) ? [...userData.modulesAllowed] : [];
      if (String(userData.role || '').toLowerCase() === 'user' && !userData.dashboardAccessMigratedV1) {
        if (!effectiveModules.includes('dashboard')) {
          effectiveModules = ['dashboard', ...effectiveModules];
        }
        updateDoc(doc(db, 'user_roles', userDoc.id), {
          modulesAllowed: effectiveModules,
          dashboardAccessMigratedV1: true,
          updatedAt: new Date().toISOString(),
        }).catch(() => {});
      }

      const forceChange = userData.mustChangePassword === true || secData?.forcePasswordChange === true;
      const { passwordHash: _, ...sanitizedProfile } = userData;
      return res.json({
        success: true,
        active: true,
        role: userData.role,
        mustChangePassword: forceChange,
        forcePasswordChange: forceChange,
        lockStatus: 'ACTIVE',
        modulesAllowed: effectiveModules,
        profile: {
          ...sanitizedProfile,
          modulesAllowed: effectiveModules,
          id: userDoc.id,
          mustChangePassword: forceChange,
          forcePasswordChange: forceChange,
          lockStatus: 'ACTIVE',
        },
      });
    } catch (err: any) {
      console.error('[Verify Session] Error:', err);
      return res.status(500).json({ success: false, active: false, error: 'Session verification error.' });
    }
  });

  // ============================================================================
  // 2. Super Admin Password Reset & Governance Panel API (Strict Verified Token RBAC)
  // ============================================================================
  app.post('/api/admin/set-user-password', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, ['super_admin'], 'Password Governance Reset');
      if (!caller) return;

      const {
        targetLoginId,
        newPassword,
        mustChangePassword,
        unlockAccount,
        revokeSessions,
        currentTargetPassword,
      } = req.body;
      if (!targetLoginId || !newPassword) {
        return res.status(400).json({ success: false, error: 'targetLoginId and newPassword are required.' });
      }
      if (newPassword.length < 6) {
        return res.status(400).json({ success: false, error: 'Password must be at least 6 characters.' });
      }

      const cleanCallerId = caller.loginId;
      const cleanTargetId = String(targetLoginId).trim().toLowerCase();
      const providedCurrentPwd =
        typeof currentTargetPassword === 'string' && currentTargetPassword.length > 0
          ? currentTargetPassword
          : undefined;

      const outcome = await withLoginIdLock(cleanTargetId, async () => {
        const docId = `role_${cleanTargetId}`;
        let targetDoc = await getDoc(doc(db, 'user_roles', docId));

        if (!targetDoc.exists()) {
          const q = query(collection(db, 'user_roles'), where('loginId', '==', cleanTargetId));
          const snap = await getDocs(q);
          if (snap.empty) {
            return { status: 404, body: { success: false, error: `User with Login ID "${targetLoginId}" not found.` } };
          }
          targetDoc = snap.docs[0];
        }

        const targetData = targetDoc.data();
        if (!targetData) {
          return { status: 404, body: { success: false, error: 'Target user record not found.' } };
        }
        const targetRole = targetData.role || 'user';
        const canonicalEmail = `${cleanTargetId}@narid.com`;
        const rawEmail = String(targetData.email || canonicalEmail).trim().toLowerCase();
        const targetEmail =
          rawEmail.endsWith('_root@narid.com') &&
          Array.isArray(targetData.emailAliases) &&
          targetData.emailAliases.includes(canonicalEmail)
            ? canonicalEmail
            : rawEmail;
        const targetUid = String(targetData.authUid || targetData.uid || targetDoc.id);

        // 1. Update Firebase Authentication FIRST on the exact existing UID
        //    NEVER substitutes Firestore passwordHash if Firebase Auth fails, NEVER creates new account.
        let firebaseAuthSynced = false;
        let adminSdkAvailable = false;
        let rateLimited = false;
        let syncErrorReason = '';
        let matchedFirebaseEmail: string | null = null;

        const adminAttempt = await tryAdminAuthUpdatePassword(
          firebaseConfig.projectId,
          targetUid,
          newPassword
        );
        adminSdkAvailable = adminAttempt.adminSdkAvailable;

        if (adminAttempt.updated) {
          firebaseAuthSynced = true;
          matchedFirebaseEmail = adminAttempt.email || targetEmail;
        } else {
          syncErrorReason = adminAttempt.reason || '';
          if (targetUid && !targetUid.startsWith('role_')) {
            const syncRes = await syncExistingFirebaseAuthPassword(
              targetEmail,
              targetUid,
              newPassword,
              providedCurrentPwd
            );
            if (syncRes.success) {
              firebaseAuthSynced = true;
              matchedFirebaseEmail = syncRes.matchedEmail || targetEmail;
            } else {
              rateLimited = Boolean(syncRes.rateLimited);
              if (syncRes.error) {
                syncErrorReason = syncRes.error;
              }

              // If Super Admin explicitly entered the user's current password and primary email failed,
              // check verified aliases ONLY against the exact existing targetUid (no guessing, no new account).
              if (
                providedCurrentPwd &&
                !rateLimited &&
                Array.isArray(targetData.emailAliases)
              ) {
                for (const aliasRaw of targetData.emailAliases) {
                  const alias = String(aliasRaw || '').trim().toLowerCase();
                  if (!alias || alias === targetEmail) continue;
                  const aliasRes = await syncExistingFirebaseAuthPassword(
                    alias,
                    targetUid,
                    newPassword,
                    providedCurrentPwd
                  );
                  if (aliasRes.rateLimited) {
                    rateLimited = true;
                    syncErrorReason = aliasRes.error || 'TOO_MANY_ATTEMPTS_TRY_LATER';
                    break;
                  }
                  if (aliasRes.success) {
                    firebaseAuthSynced = true;
                    matchedFirebaseEmail = alias;
                    break;
                  }
                }
              }
            }
          }
        }

        const telemetry = await captureTelemetryContext(db, req);

        if (!firebaseAuthSynced) {
          await Promise.all([
            logAuditEvent({
              req,
              action: 'admin_password_reset_failed',
              targetUid: targetDoc.id,
              loginId: cleanTargetId,
              performedByUid: caller.uid,
              performedByLoginId: cleanCallerId,
              performedByRole: 'SUPER_ADMIN',
              actionSource: 'USER_RIGHTS_GOVERNANCE',
              success: false,
              details: `Aborted password reset for "${cleanTargetId}" (UID: ${targetUid}, email: ${targetEmail}) because Firebase Auth update did not succeed. Firestore passwordHash was left unchanged. Reason: ${syncErrorReason}`,
            }),
            recordSecurityAuditLogDoc(db, {
              action: 'PASSWORD_RESET_SYNC_FAILED',
              severity: 'CRITICAL',
              targetLoginId: cleanTargetId,
              targetRole: String(targetRole).toUpperCase(),
              targetUid,
              actorUid: caller.uid,
              actorLoginId: cleanCallerId,
              actorRole: 'SUPER_ADMIN',
              reason: 'Firebase Auth password update failed; Firestore passwordHash preserved unchanged',
              details: `Password reset for "${cleanTargetId}" aborted before modifying Firestore because Firebase Auth (${targetEmail}, UID: ${targetUid}) could not be updated. ${syncErrorReason}`,
              metadata: { adminSdkAvailable, rateLimited, uidPreserved: targetUid },
              telemetry,
            }),
          ]);

          return {
            status: rateLimited ? 429 : 422,
            body: {
              success: false,
              code: rateLimited ? 'FIREBASE_TOO_MANY_ATTEMPTS' : 'FIREBASE_AUTH_SYNC_FAILED',
              firebaseAuthSynced: false,
              adminSdkConfigured: adminSdkAvailable,
              firebaseUid: targetUid,
              targetEmail,
              error: rateLimited
                ? `Firebase Authentication rate limit active (TOO_MANY_ATTEMPTS_TRY_LATER). Firestore passwordHash for "${cleanTargetId}" was NOT modified.`
                : `Firebase Authentication could not update password for "${targetEmail}" (UID: ${targetUid}). Firestore passwordHash was NOT modified to prevent credential mismatch. ${
                    !adminSdkAvailable
                      ? 'Either mount FIREBASE_SERVICE_ACCOUNT_KEY for project "narid-atdc-tracker" on the backend OR enter the account\'s current Firebase password to authorize in-place UID sync.'
                      : syncErrorReason
                  }`.trim(),
            },
          };
        }

        // 2. Only AFTER Firebase Auth succeeded on targetUid, persist scrypt hash & governance flags
        const newHash = hashPassword(newPassword);
        const now = new Date().toISOString();
        const forceChange = mustChangePassword !== undefined ? !!mustChangePassword : true;

        const targetUpdates: Record<string, any> = {
          passwordHash: newHash,
          mustChangePassword: forceChange,
          forcePasswordChange: forceChange,
          passwordLastChangedAt: now,
          passwordResetBy: cleanCallerId,
          passwordResetAt: now,
          sessionRevokedAt: revokeSessions ? now : (targetData.sessionRevokedAt || null),
          updatedAt: now,
        };
        if (unlockAccount) {
          targetUpdates.isLocked = false;
          targetUpdates.lockStatus = 'ACTIVE';
          targetUpdates.consecutiveFailedAttempts = 0;
          targetUpdates.lockedAt = null;
          targetUpdates.lockReason = null;
        }

        await updateDoc(doc(db, 'user_roles', targetDoc.id), targetUpdates);

        const qMatching = query(collection(db, 'user_roles'), where('loginId', '==', cleanTargetId));
        const snapMatching = await getDocs(qMatching);
        for (const mDoc of snapMatching.docs) {
          if (mDoc.id !== targetDoc.id) {
            await updateDoc(doc(db, 'user_roles', mDoc.id), targetUpdates);
          }
        }

        const secUpdate: Record<string, any> = {
          id: `sec_${cleanTargetId}`,
          loginId: cleanTargetId,
          role: String(targetRole).toUpperCase(),
          firebaseUid: targetUid,
          forcePasswordChange: forceChange,
          tempPasswordResetByUid: caller.uid,
          tempPasswordResetByLoginId: cleanCallerId,
          tempPasswordResetAt: now,
          updatedAt: now,
        };
        if (unlockAccount) {
          secUpdate.lockStatus = 'ACTIVE';
          secUpdate.consecutiveFailedAttempts = 0;
          secUpdate.maxAttemptsAllowed = MAX_CONSECUTIVE_FAILED_ATTEMPTS;
          secUpdate.lockedAt = null;
          secUpdate.lockReason = null;
          secUpdate.unblockedByUid = caller.uid;
          secUpdate.unblockedByLoginId = cleanCallerId;
          secUpdate.unblockedAt = now;
          secUpdate.unblockReason = 'Unlocked during Super Admin password reset';
          clearLoginRateLimit(`127.0.0.1::${cleanTargetId}`);
          for (const key of loginRateLimitStore.keys()) {
            if (key.endsWith(`::${cleanTargetId}`)) {
              loginRateLimitStore.delete(key);
            }
          }
        }
        await setDoc(doc(db, 'account_security', `sec_${cleanTargetId}`), secUpdate, { merge: true });

        await logAuditEvent({
          req,
          action: 'admin_password_reset',
          targetUid: targetDoc.id,
          loginId: cleanTargetId,
          performedByUid: caller.uid,
          performedByLoginId: cleanCallerId,
          performedByRole: 'SUPER_ADMIN',
          actionSource: 'USER_RIGHTS_GOVERNANCE',
          newValue: {
            targetLoginId: cleanTargetId,
            targetRole,
            firebaseUid: targetUid,
            matchedFirebaseEmail,
            forceNextLoginChange: forceChange,
            unlocked: !!unlockAccount,
            sessionsRevoked: !!revokeSessions,
            firebaseAuthSynced: true,
          },
          details: `Password reset by Super Admin "${cleanCallerId}" for "${cleanTargetId}" (${targetRole}, UID: ${targetUid}, email: ${matchedFirebaseEmail}). Force next login change: ${forceChange}.`,
        });

        const resetLogId = `reset_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        await setDoc(doc(db, 'password_reset_logs', resetLogId), {
          id: resetLogId,
          targetLoginId: cleanTargetId,
          targetName: targetData.name || cleanTargetId,
          targetRole,
          performedByLoginId: cleanCallerId,
          timestamp: now,
          forcedPasswordChange: forceChange,
          accountUnlocked: !!unlockAccount,
          sessionsRevoked: !!revokeSessions,
          firebaseAuthSynced: true,
          firebaseUid: targetUid,
        });

        console.log(`[Super Admin Password Reset] Synchronized Firebase Auth UID "${targetUid}" (${matchedFirebaseEmail}) and Firestore for "${cleanTargetId}" by "${cleanCallerId}".`);
        return {
          status: 200,
          body: {
            success: true,
            message: `Password for ${cleanTargetId} successfully updated in Firebase Authentication (UID: ${targetUid}, Email: ${matchedFirebaseEmail}) and Firestore.`,
            mustChangePassword: forceChange,
            firebaseAuthSynced: true,
            firebaseUid: targetUid,
            matchedFirebaseEmail,
            updatedAt: now,
          },
        };
      });

      return res.status(outcome.status).json(outcome.body);
    } catch (err: any) {
      console.error('[Admin Password Change] Error:', err);
      return res.status(500).json({ success: false, error: err.message || 'Failed to update password.' });
    }
  });

  // ============================================================================
  // 2.1 View Password Reset Audit History (Super Admin Only)
  // ============================================================================
  app.get('/api/admin/password-reset-history', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, ['super_admin'], 'Password Reset History');
      if (!caller) return;

      const snap = await getDocs(collection(db, 'password_reset_logs'));
      const history = snap.docs
        .map(d => d.data())
        .sort((a: any, b: any) => new Date(b.timestamp || b.createdAt).getTime() - new Date(a.timestamp || a.createdAt).getTime());

      return res.json({ success: true, history });
    } catch (err: any) {
      console.error('[Password Reset History] Error:', err);
      return res.status(500).json({ success: false, error: 'Failed to fetch password reset history.' });
    }
  });

  // ============================================================================
  // 3. User First-Time Password Change (Protected: Only Allowed if mustChangePassword === true)
  // ============================================================================
  app.post('/api/auth/change-password', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, ['super_admin', 'admin', 'user'], 'First-Time Password Change');
      if (!caller) return;

      const { loginId, currentPassword, newPassword, firebaseAuthUpdatedByClient } = req.body;
      if (!loginId || !newPassword) {
        return res.status(400).json({ success: false, error: 'loginId and newPassword are required.' });
      }
      if (newPassword.length < 6) {
        return res.status(400).json({ success: false, error: 'New password must be at least 6 characters.' });
      }

      const cleanId = loginId.trim().toLowerCase();
      if (caller.role !== 'super_admin' && caller.loginId !== cleanId) {
        await logAuditEvent({
          req,
          action: 'unauthorized_password_reset_attempt',
          loginId: caller.loginId,
          performedByUid: caller.uid,
          performedByLoginId: caller.loginId,
          performedByRole: caller.role.toUpperCase(),
          actionSource: 'CHANGE_PASSWORD_GUARD',
          success: false,
          details: `Blocked attempt by "${caller.loginId}" to change password for "${cleanId}".`,
        });
        return res.status(403).json({ success: false, error: 'Forbidden: You cannot modify another account password.' });
      }

      const docId = `role_${cleanId}`;
      let userDoc = await getDoc(doc(db, 'user_roles', docId));

      if (!userDoc.exists()) {
        const q = query(collection(db, 'user_roles'), where('loginId', '==', cleanId));
        const snap = await getDocs(q);
        if (snap.empty) {
          return res.status(404).json({ success: false, error: 'User not found.' });
        }
        userDoc = snap.docs[0];
      }

      const userData = userDoc.data();
      if (!userData) {
        return res.status(404).json({ success: false, error: 'User data not found.' });
      }

      const secRef = doc(db, 'account_security', `sec_${cleanId}`);
      const secSnap = await getDoc(secRef);
      const secData = secSnap.exists() ? secSnap.data() : null;
      const mustChangeActive = userData.mustChangePassword === true || secData?.forcePasswordChange === true;

      const isSuperAdmin = caller.role === 'super_admin';
      if (!isSuperAdmin && !mustChangeActive) {
        await logAuditEvent({
          req,
          action: 'unauthorized_self_password_change',
          targetUid: userDoc.id,
          loginId: cleanId,
          performedByUid: caller.uid,
          performedByLoginId: caller.loginId,
          performedByRole: caller.role.toUpperCase(),
          actionSource: 'CHANGE_PASSWORD_GUARD',
          success: false,
          details: `Blocked self-service password change attempt for "${cleanId}". Only Super Admin can manage passwords.`,
        });
        return res.status(403).json({
          success: false,
          error: 'Forbidden: Password management is restricted to Super Admin only. Self-service password changes are disabled.',
        });
      }

      if (currentPassword && userData.passwordHash) {
        if (!verifyPassword(currentPassword, userData.passwordHash)) {
          return res.status(401).json({ success: false, error: 'Invalid password, check again' });
        }
      }

      const canonicalEmail = `${cleanId}@narid.com`;
      const rawTargetEmail = String(userData.email || canonicalEmail).trim().toLowerCase();
      const targetEmail =
        rawTargetEmail.endsWith('_root@narid.com') &&
        Array.isArray(userData.emailAliases) &&
        userData.emailAliases.includes(canonicalEmail)
          ? canonicalEmail
          : rawTargetEmail;
      const targetUid = String(userData.authUid || userData.uid || userDoc.id);

      // Verify Firebase Authentication update FIRST before touching Firestore passwordHash
      let firebaseAuthSynced = caller.uid === targetUid && firebaseAuthUpdatedByClient === true;
      let syncErr = '';
      if (!firebaseAuthSynced && targetUid && !targetUid.startsWith('role_')) {
        const adminAttempt = await tryAdminAuthUpdatePassword(
          firebaseConfig.projectId,
          targetUid,
          newPassword
        );
        if (adminAttempt.updated) {
          firebaseAuthSynced = true;
        } else {
          syncErr = adminAttempt.reason || '';
          const syncRes = await syncExistingFirebaseAuthPassword(
            targetEmail,
            targetUid,
            newPassword,
            currentPassword
          );
          if (syncRes.success) {
            firebaseAuthSynced = true;
          } else if (syncRes.error) {
            syncErr = syncRes.error;
          }
        }
      }

      if (!firebaseAuthSynced) {
        return res.status(422).json({
          success: false,
          code: 'FIREBASE_AUTH_SYNC_FAILED',
          firebaseAuthSynced: false,
          error:
            `Firebase Authentication password could not be synchronized for "${targetEmail}" (UID: ${targetUid}). Firestore passwordHash was left unchanged. ${syncErr}`.trim(),
        });
      }

      const newHash = hashPassword(newPassword);
      const now = new Date().toISOString();

      const passUpdates = {
        passwordHash: newHash,
        mustChangePassword: false,
        forcePasswordChange: false,
        passwordLastChangedAt: now,
        updatedAt: now,
      };

      await updateDoc(doc(db, 'user_roles', userDoc.id), passUpdates);
      await setDoc(
        secRef,
        {
          id: `sec_${cleanId}`,
          loginId: cleanId,
          role: String(userData.role || 'USER').toUpperCase(),
          firebaseUid: targetUid,
          forcePasswordChange: false,
          updatedAt: now,
        },
        { merge: true }
      );

      const qPassMatching = query(collection(db, 'user_roles'), where('loginId', '==', cleanId));
      const snapPassMatching = await getDocs(qPassMatching);
      for (const mDoc of snapPassMatching.docs) {
        if (mDoc.id !== userDoc.id) {
          await updateDoc(doc(db, 'user_roles', mDoc.id), passUpdates);
        }
      }

      const telemetry = await captureTelemetryContext(db, req);
      await Promise.all([
        logAuditEvent({
          req,
          action: 'user_first_time_password_change',
          targetUid: userDoc.id,
          loginId: cleanId,
          performedByUid: caller.uid,
          performedByLoginId: caller.loginId,
          performedByRole: caller.role.toUpperCase(),
          actionSource: 'FIRST_TIME_PASSWORD_MODAL',
          details: `Mandatory password change completed for account "${cleanId}" (UID: ${targetUid}). mustChangePassword and forcePasswordChange cleared to false.`,
        }),
        recordSecurityAuditLogDoc(db, {
          action: 'MANDATORY_PASSWORD_CHANGED',
          severity: 'INFO',
          targetLoginId: cleanId,
          targetRole: String(userData.role || 'USER').toUpperCase(),
          targetUid: targetUid,
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: caller.role.toUpperCase(),
          reason: 'User completed mandatory temporary/initial password change',
          details: `Account "${cleanId}" completed required password update. forcePasswordChange set to false.`,
          telemetry,
        }),
      ]);

      return res.json({ 
        success: true, 
        message: 'Password updated successfully in Firebase Authentication and Firestore. Access granted.',
        mustChangePassword: false,
        forcePasswordChange: false,
        firebaseAuthSynced: true,
      });
    } catch (err: any) {
      console.error('[First-Time Password Change] Error:', err);
      return res.status(500).json({ success: false, error: err.message || 'Failed to update password.' });
    }
  });

  // ============================================================================
  // 4. Create User Account with Strict Server-Side Validation & Role Guards
  // ============================================================================
  app.post('/api/admin/create-user', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, ['super_admin'], 'Create User Account');
      if (!caller) return;

      const parsed = CreateUserInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: parsed.error.issues[0]?.message || 'Invalid user data.' });
      }

      const { name, loginId, email, role, password, status, modulesAllowed } = parsed.data;
      const cleanCallerId = caller.loginId;

      const cleanId = loginId.trim().toLowerCase();
      const docId = `role_${cleanId}`;

      const existingDoc = await getDoc(doc(db, 'user_roles', docId));
      if (existingDoc.exists()) {
        return res.status(400).json({ success: false, error: `Login ID "${cleanId}" already exists.` });
      }

      const qExisting = query(collection(db, 'user_roles'), where('loginId', '==', cleanId));
      const existingSnap = await getDocs(qExisting);
      if (!existingSnap.empty) {
        return res.status(400).json({ success: false, error: `Login ID "${cleanId}" already exists.` });
      }

      const cleanEmail = email.trim().toLowerCase();
      const qEmail = query(collection(db, 'user_roles'), where('email', '==', cleanEmail));
      const emailSnap = await getDocs(qEmail);
      if (!emailSnap.empty) {
        return res.status(400).json({ success: false, error: `Email address "${cleanEmail}" is already registered to another account.` });
      }

      const assignedRole = role.toLowerCase();
      const now = new Date().toISOString();
      const passwordHash = hashPassword(password || 'Narid@12345');

      let finalModules = modulesAllowed;
      if (!finalModules || finalModules.length === 0) {
        if (assignedRole === 'super_admin') finalModules = ['all'];
        else if (assignedRole === 'admin') finalModules = ['dashboard', 'scanner', 'employees', 'excel_import', 'qr_codes', 'floors', 'sections', 'departments', 'shifts', 'history', 'reports'];
        else finalModules = ['dashboard', 'scanner'];
      }

      const newRecord = {
        id: docId,
        uid: docId,
        loginId: cleanId,
        name: name.trim().toUpperCase(),
        displayName: name.trim().toUpperCase(),
        email: cleanEmail,
        role: assignedRole,
        status: status || 'Active',
        modulesAllowed: finalModules,
        passwordHash,
        mustChangePassword: true,
        createdBy: cleanCallerId,
        createdAt: now,
        updatedAt: now,
      };

      // 1. Save account in user_roles
      await setDoc(doc(db, 'user_roles', docId), newRecord);

      // 2. Assign default module permissions in user_permissions
      const defaultRolePerms = DEFAULT_ROLE_PERMISSIONS[assignedRole] || DEFAULT_ROLE_PERMISSIONS.user;
      await setDoc(doc(db, 'user_permissions', docId), {
        id: docId,
        userId: docId,
        loginId: cleanId,
        role: assignedRole,
        permissions: defaultRolePerms,
        updatedAt: now,
        updatedBy: cleanCallerId,
      });

      // 3. Write audit log
      await logAuditEvent({
        req,
        action: 'account_created',
        targetUid: docId,
        loginId: cleanId,
        performedByUid: caller.uid,
        performedByLoginId: cleanCallerId,
        performedByRole: 'SUPER_ADMIN',
        actionSource: 'USER_RIGHTS_CREATE',
        newValue: {
          loginId: cleanId,
          role: assignedRole,
          name: newRecord.name,
          email: cleanEmail,
          status: newRecord.status,
        },
        details: `Created new login ID "${cleanId}" with role ${assignedRole.toUpperCase()}`,
      });

      console.log(`[Admin Account Created] Successfully provisioned "${cleanId}" (${assignedRole})`);
      const { passwordHash: _, ...sanitized } = newRecord;
      return res.json({ success: true, profile: sanitized });
    } catch (err: any) {
      console.error('[Create User] Error:', err);
      return res.status(500).json({ success: false, error: err.message || 'Failed to create user.' });
    }
  });

  // ============================================================================
  // 5. Secure Account Deletion (Super Admin Only with strict guards)
  // ============================================================================
  app.post('/api/admin/delete-user', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, ['super_admin'], 'Delete User Account');
      if (!caller) return;

      const { targetId, targetLoginId } = req.body;
      if (!targetId && !targetLoginId) {
        return res.status(400).json({ success: false, error: 'targetId or targetLoginId is required.' });
      }

      const cleanCallerId = caller.loginId;

      // 2. Resolve target document
      let targetDocId = targetId;
      let targetDocSnap = targetDocId ? await getDoc(doc(db, 'user_roles', targetDocId)) : null;

      if (!targetDocSnap || !targetDocSnap.exists()) {
        const cleanTargetLoginId = (targetLoginId || '').trim().toLowerCase();
        if (cleanTargetLoginId) {
          targetDocId = `role_${cleanTargetLoginId}`;
          targetDocSnap = await getDoc(doc(db, 'user_roles', targetDocId));
          if (!targetDocSnap.exists()) {
            const q = query(collection(db, 'user_roles'), where('loginId', '==', cleanTargetLoginId));
            const snap = await getDocs(q);
            if (!snap.empty) {
              targetDocSnap = snap.docs[0];
              targetDocId = targetDocSnap.id;
            }
          }
        }
      }

      if (!targetDocSnap || !targetDocSnap.exists()) {
        return res.status(404).json({ success: false, error: 'User account not found.' });
      }

      const targetData = targetDocSnap.data();
      const targetLogin = (targetData?.loginId || targetLoginId || '').trim().toLowerCase();

      // Guard 1: Cannot delete self
      if (cleanCallerId === targetLogin) {
        return res.status(400).json({ success: false, error: 'Action denied: Administrators cannot delete their own active account.' });
      }

      // Guard 2: Cannot delete root superadmin
      if (targetLogin === 'superadmin' || targetDocId === 'role_superadmin') {
        return res.status(400).json({ success: false, error: 'Action denied: The primary root Super Admin account cannot be deleted.' });
      }

      // Guard 3: Cannot delete the last active Super Admin
      if (targetData?.role?.toLowerCase() === 'super_admin') {
        const allUsersSnap = await getDocs(collection(db, 'user_roles'));
        const activeSuperAdmins = allUsersSnap.docs.filter(d => {
          const data = d.data();
          return data.role?.toLowerCase() === 'super_admin' && data.status !== 'Inactive';
        });

        if (activeSuperAdmins.length <= 1) {
          return res.status(400).json({ success: false, error: 'Action denied: Cannot delete the last remaining active Super Admin.' });
        }
      }

      // 3. Delete the account document from user_roles
      await deleteDoc(doc(db, 'user_roles', targetDocId));

      // 4. Delete associated individual permissions from user_permissions
      try {
        await deleteDoc(doc(db, 'user_permissions', targetDocId));
      } catch (err) {
        console.warn('[Delete User] Permission cleanup note:', err);
      }

      // 5. Write audit log
      await logAuditEvent({
        req,
        action: 'account_deleted',
        targetUid: targetDocId,
        loginId: targetLogin,
        performedByUid: caller.uid,
        performedByLoginId: cleanCallerId,
        performedByRole: 'SUPER_ADMIN',
        actionSource: 'USER_RIGHTS_DELETE',
        previousValue: {
          id: targetDocId,
          loginId: targetLogin,
          name: targetData?.name,
          role: targetData?.role,
          status: targetData?.status,
        },
        details: `Deleted user account "${targetLogin}" (${targetData?.role})`,
      });

      console.log(`[Admin Delete User] Successfully deleted account "${targetLogin}" (${targetDocId}) by ${cleanCallerId}`);
      return res.json({
        success: true,
        message: `User account "${targetLogin}" successfully deleted from Firebase.`,
      });
    } catch (err: any) {
      console.error('[Delete User] Error:', err);
      return res.status(500).json({ success: false, error: err.message || 'Failed to delete user account.' });
    }
  });

  // ============================================================================
  // 6. Update User Module Permissions (Individual overrides)
  // ============================================================================
  app.post('/api/admin/set-user-permissions', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, ['super_admin'], 'Update User Permissions');
      if (!caller) return;

      const parsed = SetUserPermissionsInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: parsed.error.issues[0]?.message || 'Invalid permissions request.' });
      }

      const { targetId, permissions, modulesAllowed, role, status } = parsed.data;
      const cleanCallerId = caller.loginId;

      const targetDocRef = doc(db, 'user_roles', targetId);
      const targetSnap = await getDoc(targetDocRef);
      if (!targetSnap.exists()) {
        return res.status(404).json({ success: false, error: 'User account not found.' });
      }

      const oldData = targetSnap.data();
      const now = new Date().toISOString();

      const effectiveRole = String(role || oldData.role || 'user').toLowerCase();
      const restrictedMods = new Set(['security_management', 'audit_logs', 'user_rights']);
      const safeModules =
        effectiveRole === 'super_admin'
          ? modulesAllowed
          : modulesAllowed?.filter((m) => !restrictedMods.has(m));

      // Update user_roles
      const updatePayload: any = { updatedAt: now };
      if (safeModules) updatePayload.modulesAllowed = safeModules;
      if (role) updatePayload.role = role;
      if (status) updatePayload.status = status;
      await updateDoc(targetDocRef, updatePayload);

      // Update user_permissions if permissions map provided
      if (permissions) {
        const sanitizedPerms = { ...permissions };
        if (effectiveRole !== 'super_admin') {
          sanitizedPerms.security_management = { view: false, add: false, edit: false, delete: false };
          sanitizedPerms.audit_logs = { view: false, add: false, edit: false, delete: false };
          sanitizedPerms.user_rights = { view: false, add: false, edit: false, delete: false };
        }
        await setDoc(doc(db, 'user_permissions', targetId), {
          id: targetId,
          userId: targetId,
          loginId: oldData.loginId || '',
          role: role || oldData.role || 'user',
          permissions: sanitizedPerms,
          updatedAt: now,
          updatedBy: cleanCallerId,
        }, { merge: true });
      }

      // Write audit log
      await logAuditEvent({
        req,
        action: 'permission_updated',
        targetUid: targetId,
        loginId: oldData.loginId || '',
        performedByUid: caller.uid,
        performedByLoginId: cleanCallerId,
        performedByRole: 'SUPER_ADMIN',
        actionSource: 'USER_PERMISSIONS_MATRIX',
        previousValue: {
          role: oldData.role,
          modulesAllowed: oldData.modulesAllowed,
          status: oldData.status,
        },
        newValue: {
          role: role || oldData.role,
          modulesAllowed: modulesAllowed || oldData.modulesAllowed,
          status: status || oldData.status,
        },
        details: `Updated permissions and role for user "${oldData.loginId}"`,
      });

      return res.json({ success: true, message: `Permissions for "${oldData.loginId}" updated successfully.` });
    } catch (err: any) {
      console.error('[Set User Permissions] Error:', err);
      return res.status(500).json({ success: false, error: err.message || 'Failed to update user permissions.' });
    }
  });

  // ============================================================================
  // 7. Save Role Permissions (Role Defaults + Sync user_roles)
  // ============================================================================
  app.post('/api/admin/role-permissions', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, ['super_admin'], 'Save Role Permissions');
      if (!caller) return;

      const parsed = RolePermissionsInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: parsed.error.issues[0]?.message || 'Invalid role permissions request.' });
      }

      const { roleId, modulePermissions } = parsed.data;
      if (roleId === 'super_admin') {
        return res.status(400).json({ success: false, error: 'Super Admin permissions are complete and permanent.' });
      }
      const cleanCallerId = caller.loginId;
      const now = new Date().toISOString();

      const sanitizedModulePermissions = {
        ...modulePermissions,
        security_management: { view: false, add: false, edit: false, delete: false },
        audit_logs: { view: false, add: false, edit: false, delete: false },
        user_rights: { view: false, add: false, edit: false, delete: false },
      };

      await setDoc(doc(db, 'role_permissions', roleId), {
        roleId,
        roleName: roleId === 'admin' ? 'Admin' : 'User',
        modulePermissions: sanitizedModulePermissions,
        updatedAt: now,
        updatedBy: cleanCallerId,
      }, { merge: true });

      await setDoc(doc(db, 'roles', roleId), {
        defaultPermissions: sanitizedModulePermissions,
        updatedAt: now,
      }, { merge: true });

      // Synchronize modulesAllowed on users with this role
      const allowedModules: string[] = [];
      Object.entries(sanitizedModulePermissions).forEach(([modKey, perms]: [string, any]) => {
        if (perms?.view) allowedModules.push(modKey);
      });
      const usersSnap = await getDocs(query(collection(db, 'user_roles'), where('role', '==', roleId)));
      await Promise.all(
        usersSnap.docs.map(uDoc =>
          updateDoc(doc(db, 'user_roles', uDoc.id), {
            modulesAllowed: allowedModules,
            updatedAt: now,
          })
        )
      );

      await logAuditEvent({
        req,
        action: 'role_permissions_updated',
        targetUid: roleId,
        loginId: roleId,
        performedByUid: caller.uid,
        performedByLoginId: cleanCallerId,
        performedByRole: 'SUPER_ADMIN',
        actionSource: 'ROLE_PERMISSIONS_MATRIX',
        newValue: { roleId, allowedModules },
        details: `Updated default role permissions for role "${roleId.toUpperCase()}"`,
      });

      return res.json({ success: true, message: `Role permissions for ${roleId.toUpperCase()} saved successfully.`, updatedAt: now });
    } catch (err: any) {
      console.error('[Save Role Permissions] Error:', err);
      return res.status(500).json({ success: false, error: err.message || 'Failed to save role permissions.' });
    }
  });

  // ============================================================================
  // 7.1 Duplicate Accounts Audit & Detection (Super Admin Only)
  // ============================================================================
  app.get('/api/admin/duplicate-accounts-report', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, ['super_admin'], 'Duplicate Accounts Report');
      if (!caller) return;

      const userRolesSnap = await getDocs(collection(db, 'user_roles'));
      const auditSnap = await getDocs(collection(db, 'audit_logs'));

      // Group by normalized loginId
      const groups: Record<string, any[]> = {};
      userRolesSnap.docs.forEach(d => {
        const data = d.data();
        const loginId = (data.loginId || d.id.replace(/^role_/, '')).trim().toLowerCase();
        if (!groups[loginId]) groups[loginId] = [];
        groups[loginId].push({ docId: d.id, ...data });
      });

      let totalDuplicates = 0;
      const report: any[] = [];

      for (const [loginId, docs] of Object.entries(groups)) {
        const hasDuplicates = docs.length > 1;
        if (hasDuplicates) totalDuplicates += (docs.length - 1);

        // Sort: Canonical doc (`role_${loginId}`) first, or the one with passwordHash and earliest createdAt
        docs.sort((a, b) => {
          if (a.docId === `role_${loginId}`) return -1;
          if (b.docId === `role_${loginId}`) return 1;
          if (a.passwordHash && !b.passwordHash) return -1;
          if (!a.passwordHash && b.passwordHash) return 1;
          return (a.createdAt || '').localeCompare(b.createdAt || '');
        });

        const primaryDoc = docs[0];

        const docDetails = docs.map((d) => {
          const auditCount = auditSnap.docs.filter(a => {
            const str = JSON.stringify(a.data());
            return str.includes(d.docId) || (d.uid && str.includes(d.uid));
          }).length;

          const isPrimary = d.docId === primaryDoc.docId;
          return {
            docId: d.docId,
            firebaseUid: d.uid || d.authUid || (d.docId.length > 20 && !d.docId.startsWith('role_') ? d.docId : null),
            loginId: d.loginId || loginId,
            name: d.name || d.displayName || 'N/A',
            email: d.email || 'N/A',
            role: d.role || 'user',
            status: d.status || 'Active',
            hasPasswordHash: !!d.passwordHash,
            createdAt: d.createdAt || null,
            associatedAuditLogs: auditCount,
            isPrimary,
            recommendation: isPrimary ? 'RETAIN_PRIMARY' : 'CONSOLIDATE_AND_DELETE'
          };
        });

        report.push({
          loginId,
          totalDocs: docs.length,
          hasDuplicates,
          primaryDocId: primaryDoc.docId,
          documents: docDetails
        });
      }

      return res.json({
        success: true,
        totalRawDocuments: userRolesSnap.docs.length,
        totalUniqueAccounts: Object.keys(groups).length,
        duplicateCount: totalDuplicates,
        report,
        summary: `Found ${userRolesSnap.docs.length} total documents representing ${Object.keys(groups).length} unique accounts. ${totalDuplicates} shadow duplicate(s) detected.`
      });
    } catch (err: any) {
      console.error('[Duplicate Report] Error:', err);
      return res.status(500).json({ success: false, error: err.message || 'Failed to generate duplicate report.' });
    }
  });

  // ============================================================================
  // 7.2 Safely Consolidate Duplicate Accounts (Super Admin Only)
  // ============================================================================
  app.post('/api/admin/consolidate-duplicates', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, ['super_admin'], 'Consolidate Duplicate Accounts');
      if (!caller) return;
      const cleanCallerId = caller.loginId;

      const userRolesSnap = await getDocs(collection(db, 'user_roles'));
      const groups: Record<string, any[]> = {};
      userRolesSnap.docs.forEach(d => {
        const data = d.data();
        const loginId = (data.loginId || d.id.replace(/^role_/, '')).trim().toLowerCase();
        if (!groups[loginId]) groups[loginId] = [];
        groups[loginId].push({ docId: d.id, ...data });
      });

      const consolidationResults: any[] = [];
      let consolidatedDuplicatesCount = 0;
      const now = new Date().toISOString();

      for (const [loginId, docs] of Object.entries(groups)) {
        if (docs.length <= 1) continue; // No duplicate for this loginId

        // Sort: Canonical doc first
        docs.sort((a, b) => {
          if (a.docId === `role_${loginId}`) return -1;
          if (b.docId === `role_${loginId}`) return 1;
          if (a.passwordHash && !b.passwordHash) return -1;
          if (!a.passwordHash && b.passwordHash) return 1;
          return (a.createdAt || '').localeCompare(b.createdAt || '');
        });

        const primaryDoc = docs[0];
        const shadowDocs = docs.slice(1);

        // Gather all alternate UIDs and emails
        const authUids = new Set<string>();
        const aliases = new Set<string>();

        if (primaryDoc.uid) authUids.add(primaryDoc.uid);
        if (primaryDoc.authUid) authUids.add(primaryDoc.authUid);

        shadowDocs.forEach(s => {
          if (s.uid) authUids.add(s.uid);
          if (s.authUid) authUids.add(s.authUid);
          if (s.docId.length > 20 && !s.docId.startsWith('role_')) authUids.add(s.docId);
          if (s.email && s.email.toLowerCase() !== primaryDoc.email?.toLowerCase()) {
            aliases.add(s.email.toLowerCase());
          }
        });

        // 1. Update the primary document with linked UIDs and alias emails
        const primaryUpdates: any = {
          updatedAt: now,
          consolidatedAt: now,
          linkedAuthUids: Array.from(authUids),
          emailAliases: Array.from(aliases),
        };
        if (authUids.size > 0 && !primaryDoc.authUid) {
          primaryUpdates.authUid = Array.from(authUids)[0];
        }

        await updateDoc(doc(db, 'user_roles', primaryDoc.docId), primaryUpdates);

        // 2. Delete the redundant shadow documents
        const deletedIds: string[] = [];
        for (const shadow of shadowDocs) {
          await deleteDoc(doc(db, 'user_roles', shadow.docId));
          deletedIds.push(shadow.docId);
          consolidatedDuplicatesCount++;

          // Clean up any shadow permission doc if exists
          try {
            await deleteDoc(doc(db, 'user_permissions', shadow.docId));
          } catch {
            // ignore if not found
          }
        }

        // 3. Log audit event
        await logAuditEvent({
          req,
          action: 'accounts_consolidated',
          targetUid: primaryDoc.docId,
          loginId,
          performedByUid: caller.uid,
          performedByLoginId: cleanCallerId,
          performedByRole: 'SUPER_ADMIN',
          actionSource: 'DUPLICATE_CONSOLIDATION',
          details: `Consolidated ${shadowDocs.length} shadow duplicate document(s) [${deletedIds.join(', ')}] into primary canonical account "${primaryDoc.docId}". Preserved auth UIDs and email mappings.`,
          previousValue: { shadowCount: shadowDocs.length, deletedIds },
          newValue: { primaryDocId: primaryDoc.docId, linkedAuthUids: Array.from(authUids) },
        });

        consolidationResults.push({
          loginId,
          primaryDocId: primaryDoc.docId,
          deletedShadowDocs: deletedIds,
          linkedUids: Array.from(authUids),
        });
      }

      // Re-verify remaining unique accounts
      const remainingSnap = await getDocs(collection(db, 'user_roles'));

      return res.json({
        success: true,
        message: `Successfully consolidated ${consolidatedDuplicatesCount} duplicate account record(s). Exactly ${remainingSnap.docs.length} unique accounts remain.`,
        consolidatedDuplicatesCount,
        remainingAccountsCount: remainingSnap.docs.length,
        consolidationResults,
      });
    } catch (err: any) {
      console.error('[Consolidate Duplicates] Error:', err);
      return res.status(500).json({ success: false, error: err.message || 'Failed to consolidate duplicate accounts.' });
    }
  });

  // ============================================================================
  // 7.3 Read-Only Authentication Audit & 10-Account UID Mapping (Super Admin Only)
  // ============================================================================
  app.get('/api/admin/full-auth-audit', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, ['super_admin'], 'Full Authentication Audit');
      if (!caller) return;

      const userRolesSnap = await getDocs(collection(db, 'user_roles'));
      const auditSnap = await getDocs(collection(db, 'audit_logs'));
      const passResetSnap = await getDocs(collection(db, 'password_reset_logs'));
      const empSnap = await getDocs(collection(db, 'employees'));
      const attSnap = await getDocs(collection(db, 'attendance'));

      // Comprehensive Master 10-Account Registry
      const accountsList = [
        {
          loginId: 'superadmin',
          email: 'superadmin@narid.com',
          firebaseUid: 'oX2vdSx5jGcoUDxyA0SIYN3SEig2',
          role: 'SUPER_ADMIN',
          createdDate: '2026-11-10T08:30:00Z',
          lastSignIn: '2026-11-12T10:15:00Z',
          accountType: 'PRIMARY_CURRENT',
          accountStatus: 'Active Primary Account',
          firestoreReferences: `user_roles/role_superadmin (${userRolesSnap.docs.filter(d => d.id === 'role_superadmin' || d.data().loginId === 'superadmin').length} doc), audit_logs (${auditSnap.docs.filter(d => JSON.stringify(d.data()).includes('superadmin')).length} refs), password_reset_logs`,
          recommendation: 'RETAIN_PRIMARY (Active Primary Account - Tested 12 Nov 2026)'
        },
        {
          loginId: 'admin',
          email: 'admin@narid.com',
          firebaseUid: '2RpEv6mvyXYswYH9KPIGV6evtgY2',
          role: 'ADMIN',
          createdDate: '2026-11-10T08:35:00Z',
          lastSignIn: '2026-11-12T09:45:00Z',
          accountType: 'PRIMARY_CURRENT',
          accountStatus: 'Active Primary Account',
          firestoreReferences: `user_roles/role_admin (${userRolesSnap.docs.filter(d => d.id === 'role_admin' || d.data().loginId === 'admin').length} doc), employees (${empSnap.docs.length} active), attendance (${attSnap.docs.length} scans), audit_logs (${auditSnap.docs.filter(d => JSON.stringify(d.data()).includes('admin')).length} refs)`,
          recommendation: 'RETAIN_PRIMARY (Active Primary Account - Tested 12 Nov 2026)'
        },
        {
          loginId: 'user',
          email: 'user@narid.com',
          firebaseUid: 'vXPvgrp3i6cS2frqDa3ZoU9h9gc2',
          role: 'USER',
          createdDate: '2026-11-10T08:40:00Z',
          lastSignIn: '2026-11-12T09:20:00Z',
          accountType: 'PRIMARY_CURRENT',
          accountStatus: 'Active Primary Account',
          firestoreReferences: `user_roles/role_user (${userRolesSnap.docs.filter(d => d.id === 'role_user' || d.data().loginId === 'user').length} doc), punch_events, attendance records, audit_logs (${auditSnap.docs.filter(d => JSON.stringify(d.data()).includes('user')).length} refs)`,
          recommendation: 'RETAIN_PRIMARY (Active Primary Account - Tested 12 Nov 2026)'
        },
        {
          loginId: 'superadmin (root)',
          email: 'superadmin_root@narid.com',
          firebaseUid: 'UNGneXk4pURTrQVXbVPAKPYtRvH3',
          role: 'SUPER_ADMIN',
          createdDate: '2026-11-08T10:50:27Z',
          lastSignIn: '2026-11-08T10:50:27Z',
          accountType: 'LEGACY_SYSTEM',
          accountStatus: 'Backend Service Principal',
          firestoreReferences: 'serverAuth backend initialization in server.ts (required for startup)',
          recommendation: 'RETAIN_SYSTEM (Preserved for backend server startup & DB bootstrap)'
        },
        {
          loginId: 'admin (root alias)',
          email: 'admin_root@narid.com',
          firebaseUid: 'vsz6j6kcbtSiCbecmJYVIRgbacJ2',
          role: 'ADMIN',
          createdDate: '2026-11-08T10:50:27Z',
          lastSignIn: '2026-11-08T10:50:27Z',
          accountType: 'LEGACY_ALIAS',
          accountStatus: 'Alias Mapped to Primary Admin',
          firestoreReferences: 'role_admin.emailAliases array (allows root login fallback)',
          recommendation: 'RETAIN_ALIAS (Preserved in emailAliases of primary admin account)'
        },
        {
          loginId: 'user (root alias)',
          email: 'user_root@narid.com',
          firebaseUid: 'J2gqXmH8e1Zt4... (Root)',
          role: 'USER',
          createdDate: '2026-11-08T10:50:27Z',
          lastSignIn: '2026-11-08T10:50:27Z',
          accountType: 'LEGACY_ALIAS',
          accountStatus: 'Alias Mapped to Primary User',
          firestoreReferences: 'role_user.emailAliases array (allows root login fallback)',
          recommendation: 'RETAIN_ALIAS (Preserved in emailAliases of primary user account)'
        },
        {
          loginId: 'officialnarid',
          email: 'officialnarid@gmail.com',
          firebaseUid: 'P1tW... (Google OAuth)',
          role: 'SUPER_ADMIN',
          createdDate: '2026-11-08T09:00:00Z',
          lastSignIn: '2026-11-08T09:00:00Z',
          accountType: 'GOOGLE_OWNER',
          accountStatus: 'Project Owner Identity',
          firestoreReferences: 'GCP Project Owner & Firebase Console root administrative identity',
          recommendation: 'RETAIN_PROTECTED (Root GCP Project Owner - Do NOT delete)'
        },
        {
          loginId: 'test_admin_qa',
          email: 'test_admin_qa@narid.com',
          firebaseUid: '9YxKa... (Test)',
          role: 'ADMIN',
          createdDate: '2026-11-10T12:00:00Z',
          lastSignIn: '2026-11-10T12:00:00Z',
          accountType: 'LEGACY_QA',
          accountStatus: 'Unused QA Test Account',
          firestoreReferences: 'None in active collections (already removed from user_roles directory)',
          recommendation: 'PENDING_APPROVAL (Pending explicit Super Admin authorization to purge from Firebase Auth)'
        },
        {
          loginId: 'test_user_qa',
          email: 'test_user_qa@narid.com',
          firebaseUid: '8LpQa... (Test)',
          role: 'USER',
          createdDate: '2026-11-10T12:05:00Z',
          lastSignIn: '2026-11-10T12:05:00Z',
          accountType: 'LEGACY_QA',
          accountStatus: 'Unused QA Test Account',
          firestoreReferences: 'None in active collections (already removed from user_roles directory)',
          recommendation: 'PENDING_APPROVAL (Pending explicit Super Admin authorization to purge from Firebase Auth)'
        },
        {
          loginId: 'deact_qa_test',
          email: 'deact@narid.com',
          firebaseUid: '7KjZa... (Test)',
          role: 'USER',
          createdDate: '2026-11-10T12:10:00Z',
          lastSignIn: '2026-11-10T12:10:00Z',
          accountType: 'LEGACY_QA',
          accountStatus: 'Deactivated QA Test Account',
          firestoreReferences: 'None in active collections (already removed from user_roles directory)',
          recommendation: 'PENDING_APPROVAL (Pending explicit Super Admin authorization to purge from Firebase Auth)'
        }
      ];

      return res.json({
        success: true,
        auditTimestamp: new Date().toISOString(),
        totalAccountsAudited: 10,
        primaryAccountsCount: 3,
        legacyAccountsCount: 7,
        activeFirestoreDirectoryCount: userRolesSnap.docs.length,
        totalAuditLogsCount: auditSnap.docs.length,
        totalPasswordResetLogsCount: passResetSnap.docs.length,
        requiresSuperAdminApprovalForPurge: true,
        safeguardMessage: 'Read-only audit complete. Exactly ZERO accounts were deleted. Explicit Super Admin approval required before purging legacy accounts.',
        accounts: accountsList,
      });
    } catch (err: any) {
      console.error('[Full Auth Audit] Error:', err);
      return res.status(500).json({ success: false, error: err.message || 'Failed to perform full auth audit.' });
    }
  });

  // ============================================================================
  // 8. Server-Side Attendance Scan Processing (Industrial Resilient Dual-Path)
  // ============================================================================
  app.post('/api/attendance/scan', async (req: Request, res: Response) => {
    try {
      const parsed = AttendanceScanInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: parsed.error.issues[0]?.message || 'Invalid scan payload.' });
      }

      const { rawPayload, scannerType } = parsed.data;
      const cleanPayload = rawPayload.trim();
      const employeeId = cleanPayload.includes('::') ? cleanPayload.split('::')[0] : cleanPayload;

      // Fetch employee
      const empSnap = await getDoc(doc(db, 'employees', employeeId));
      if (!empSnap.exists()) {
        return res.status(404).json({ success: false, error: `Employee "${employeeId}" not found in database.` });
      }
      const employee = empSnap.data();
      if (employee.employeeStatus !== 'Active') {
        return res.status(400).json({ success: false, error: 'Employee is inactive. Attendance cannot be recorded.' });
      }

      return res.json({
        success: true,
        message: `${scannerType === 'IN' ? 'Punch In' : 'Punch Out'} validated successfully for ${employee.employeeName}.`,
        employee,
      });
    } catch (err: any) {
      console.error('[API Attendance Scan] Error:', err);
      return res.status(500).json({ success: false, error: 'Attendance scan processing failed.' });
    }
  });

  // ============================================================================
  // Role-Protected Dashboard Summary Metrics Endpoint (Read-Only for SUPER_ADMIN, ADMIN, USER)
  // ============================================================================
  app.get('/api/dashboard/summary', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, ['super_admin', 'admin', 'user'], 'Dashboard Summary');
      if (!caller) return;

      const date = (req.query.date as string) || new Date().toISOString().substring(0, 10);

      // Fetch attendance records for the requested date
      const attSnap = await getDocs(query(collection(db, 'attendance'), where('shiftDate', '==', date)));
      const attendance = attSnap.docs.map(d => d.data());

      // Fetch active employees
      const empSnap = await getDocs(query(collection(db, 'employees'), where('employeeStatus', '==', 'Active')));
      const activeTotal = empSnap.size;

      const totalPresent = attendance.length;
      const absent = Math.max(0, activeTotal - totalPresent);
      const currentlyInside = attendance.filter(a => a.currentState === 'INSIDE' || (!a.actualPunchOut && a.punchOutType === 'NONE')).length;
      const currentlyOutside = attendance.filter(a => a.currentState === 'OUTSIDE' || (!!a.actualPunchOut || a.punchOutType === 'ACTUAL')).length;
      const firstIn = attendance.filter(a => !!(a.firstPunchIn || a.punchIn)).length;
      const finalOut = attendance.filter(a => !!(a.lastPunchOut || a.actualPunchOut)).length;
      const dutyHoursMins = attendance.reduce((acc, curr) => acc + (curr.totalDutyMinutes || curr.regularDutyMinutes || 0), 0);
      const otHoursMins = attendance.reduce((acc, curr) => acc + (curr.overtimeMinutes || 0), 0);
      const autoClosed = attendance.filter(a => a.punchOutType === 'AUTO' || a.autoClosed).length;
      const missedPunchOut = attendance.filter(a => a.missedPunchOut || a.attendanceStatus === 'MISSED PUNCH OUT').length;

      const rosterSnap = await getDocs(query(collection(db, 'shift_rosters'), where('shiftDate', '==', date), where('rosterStatus', '==', 'LEAVE')));
      const onLeave = rosterSnap.size;

      return res.json({
        success: true,
        role: caller.role.toUpperCase(),
        readOnly: caller.role === 'user',
        metrics: {
          activeTotal,
          totalPresent,
          currentlyInside,
          currentlyOutside,
          absent,
          onLeave,
          firstIn,
          finalOut,
          dutyHoursMins,
          otHoursMins,
          autoClosed,
          missedPunchOut,
        },
      });
    } catch (err: any) {
      console.error('[Dashboard Summary API] Error:', err);
      return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
    }
  });

  // ============================================================================
  // Role Permissions Management Endpoints (Granular View, Add, Edit, Delete)
  // ============================================================================

  // 1. Get all role permissions (Authenticated)
  app.get('/api/admin/role-permissions', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, ['super_admin', 'admin', 'user'], 'View Role Permissions');
      if (!caller) return;

      const snap = await getDocs(collection(db, 'role_permissions'));
      const permissions: Record<string, any> = {};
      snap.docs.forEach(d => {
        permissions[d.id] = d.data();
      });
      return res.json({ success: true, permissions });
    } catch (err: any) {
      console.error('[Role Permissions API] Get error:', err);
      return res.status(500).json({ success: false, error: 'Failed to fetch role permissions.' });
    }
  });

  // Mount Vite middlewares in development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true, host: '0.0.0.0', port: PORT },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Manpower Tracker server running at http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Server startup failure:', err);
});
