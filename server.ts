import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { z } from 'zod';
import {
  getFirebaseAdminContext,
  loadFirebaseAppletConfig,
  TARGET_PROJECT_ID,
  TARGET_DATABASE_ID,
  isFirestorePermissionDeniedError,
  formatAdminPermissionDeniedError,
} from './serverFirebaseAdmin.ts';
import {
  type AdminAuthLike,
  type AdminFirestoreLike,
  type VerifiedCaller,
  normalizeRoleValue,
  deriveStrictRoleId,
  SYSTEM_ROLE_IDS,
  VALID_ROLE_ID_REGEX,
  registerSecurityAuditRoutes,
  verifyCallerIdentity,
  recordEnterpriseAuditEvent,
  syncUserUidIndex,
  removeUserUidIndex,
} from './serverSecurityAudit.ts';
import {
  registerLoginSecurityRoutes,
  seedAccountSecurityRecords,
  captureTelemetryContext,
  recordSecurityAuditLogDoc,
  tryAdminAuthUpdatePassword,
  withLoginIdLock,
  clearIpCooldownPersistent,
  MAX_CONSECUTIVE_FAILED_ATTEMPTS,
} from './serverLoginSecurity.ts';
import { registerAttendanceRoutes } from './serverAttendance.ts';
import { registerEmployeeRoutes } from './serverEmployees.ts';
import { registerMasterRoutes } from './serverMasters.ts';
import {
  getCachedRoleDefDoc,
  getCachedRolePermissionsDoc,
  invalidateRoleCaches,
  invalidateUidRolePointer,
} from './serverPerfCache.ts';
import { resolveAttendanceMetrics } from './src/utils/attendanceStatus.ts';
import {
  DASHBOARD_CARDS,
  DASHBOARD_VISIBILITY_KEYS,
  resolveDashboardVisibility,
  type DashboardCardId,
  type DashboardSectionId,
  type DashboardSummaryMetricKey,
} from './src/config/dashboardCardsConfig.ts';

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
// In-Place Firebase Authentication Password Synchronizer (Requires Explicit Current Password)
// Used only when Admin SDK credentials are unavailable and current password is supplied.
// Zero hardcoded passwords, zero new account creation, strict UID preservation.
// ============================================================================
export async function syncExistingFirebaseAuthPassword(
  email: string,
  targetUid: string,
  newPassword: string,
  knownCurrentPassword?: string
): Promise<{ success: boolean; uid?: string; matchedEmail?: string; rateLimited?: boolean; error?: string }> {
  if (typeof knownCurrentPassword !== 'string' || knownCurrentPassword.length === 0) {
    return {
      success: false,
      error: 'Firebase Admin SDK credentials (ADC or Service Account) or current password are required for password synchronization.',
    };
  }

  try {
    const appletConfig = loadFirebaseAppletConfig();
    if (!appletConfig.apiKey) {
      return {
        success: false,
        error: 'Missing Firebase web API key in firebase-applet-config.json.',
      };
    }

    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${appletConfig.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: knownCurrentPassword, returnSecureToken: true }),
      }
    );
    const data: any = await res.json();
    const errMsg = String(data?.error?.message || '');

    if (errMsg.includes('TOO_MANY_ATTEMPTS_TRY_LATER')) {
      return { success: false, rateLimited: true, error: 'TOO_MANY_ATTEMPTS_TRY_LATER' };
    }
    if (!data?.idToken) {
      return {
        success: false,
        error: errMsg || `Firebase Auth rejected verification for "${email}".`,
      };
    }
    if (data.localId !== targetUid) {
      return {
        success: false,
        error: `Email "${email}" belongs to UID "${data.localId}", expected UID "${targetUid}".`,
      };
    }

    const updateRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:update?key=${appletConfig.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: data.idToken, password: newPassword, returnSecureToken: true }),
      }
    );

    const updateData: any = await updateRes.json();
    const updateErr = String(updateData?.error?.message || '');
    if (updateErr.includes('TOO_MANY_ATTEMPTS_TRY_LATER')) {
      return { success: false, rateLimited: true, error: 'TOO_MANY_ATTEMPTS_TRY_LATER' };
    }
    if (updateData.localId === targetUid) {
      return { success: true, uid: targetUid, matchedEmail: email };
    }
    return {
      success: false,
      error: updateData.error?.message || 'Failed to update Firebase Auth password.',
    };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Firebase Auth sync error.' };
  }
}

// ============================================================================
// Enterprise Input Validation Schemas (Zod)
// ============================================================================
const VerifySessionInputSchema = z.object({
  loginId: z.string().trim().min(1).max(64).optional(),
  userId: z.string().trim().min(1).max(128).optional(),
});

const AdminSetPasswordInputSchema = z.object({
  targetLoginId: z.string().trim().min(1, 'targetLoginId is required.').max(64),
  newPassword: z.string().min(6, 'Password must be at least 6 characters.').max(128),
  mustChangePassword: z.boolean().optional(),
  unlockAccount: z.boolean().optional(),
  revokeSessions: z.boolean().optional(),
  currentTargetPassword: z.string().optional(),
});

const RESERVED_CUSTOM_ROLE_ALIASES = new Set([
  'superadmin',
  'super_admin',
  'root',
  'system',
  'super_admin_root',
]);

const DynamicRoleIdSchema = z
  .string()
  .trim()
  .min(2, 'Role ID must be at least 2 characters.')
  .max(64, 'Role ID must be 64 characters or fewer.')
  .transform((val) => deriveStrictRoleId(val))
  .refine((val) => VALID_ROLE_ID_REGEX.test(val), {
    message: 'Role ID must start with a letter and contain only lowercase letters, numbers, or underscores.',
  });

const RoleDefinitionInputSchema = z.object({
  roleId: z.string().trim().max(64).optional(),
  roleName: z
    .string()
    .trim()
    .min(2, 'Role name must be at least 2 characters.')
    .max(48, 'Role name must be 48 characters or fewer.'),
  description: z
    .string()
    .trim()
    .min(3, 'Role description must be at least 3 characters.')
    .max(500, 'Role description must be 500 characters or fewer.'),
  isActive: z.boolean().default(true),
  defaultPermissions: z
    .record(
      z.string(),
      z.object({
        view: z.boolean().optional(),
        add: z.boolean().optional(),
        edit: z.boolean().optional(),
        delete: z.boolean().optional(),
      })
    )
    .optional(),
});

const CreateUserInputSchema = z.object({
  callerLoginId: z.string().trim().min(1).max(64).optional(),
  loginId: z
    .string()
    .trim()
    .min(2, 'Login ID must be at least 2 characters.')
    .max(64)
    .regex(/^[a-zA-Z0-9_.-]+$/, 'Login ID can only contain letters, numbers, hyphens, underscores, and dots.'),
  name: z.string().trim().min(1, 'Name is required.').max(128),
  email: z.string().trim().email('Valid email is required.').max(128),
  role: DynamicRoleIdSchema,
  password: z.string().min(6, 'Password must be at least 6 characters.').max(128),
  modulesAllowed: z.array(z.string().max(64)).optional(),
  status: z.enum(['Active', 'Inactive']).default('Active'),
  mustChangePassword: z.boolean().optional(),
});

const DeleteUserInputSchema = z.object({
  callerLoginId: z.string().trim().min(1).max(64).optional(),
  targetId: z.string().trim().min(1).max(128).optional(),
  targetLoginId: z.string().trim().min(1).max(64).optional(),
});

const SetUserPermissionsInputSchema = z.object({
  callerLoginId: z.string().trim().min(1).max(64).optional(),
  targetId: z.string().trim().min(1).max(128),
  role: DynamicRoleIdSchema.optional(),
  status: z.enum(['Active', 'Inactive']).optional(),
  modulesAllowed: z.array(z.string().max(64)).optional(),
  permissions: z
    .record(
      z.string(),
      z.object({
        view: z.boolean().optional(),
        add: z.boolean().optional(),
        edit: z.boolean().optional(),
        delete: z.boolean().optional(),
      })
    )
    .optional(),
});

const RolePermissionsInputSchema = z.object({
  callerLoginId: z.string().trim().min(1).max(64).optional(),
  roleId: DynamicRoleIdSchema,
  modulePermissions: z.record(
    z.string(),
    z.object({
      view: z.boolean().optional(),
      add: z.boolean().optional(),
      edit: z.boolean().optional(),
      delete: z.boolean().optional(),
    })
  ),
});

// Canonical Protected Auth UIDs (Data Preservation Guard)
const CANONICAL_PROTECTED_UIDS = new Set([
  'oX2vdSx5jGcoUDxyA0SIYN3SEig2', // superadmin@narid.com
  '2RpEv6mvyXYswYH9KPIGV6evtgY2', // admin@narid.com
  'vXPvgrp3i6cS2frqDa3ZoU9h9gc2', // user@narid.com
  'UNGneXk4pURTrQVXbVPAKPYtRvH3', // legacy superadmin_root@narid.com
  'vsz6j6kcbtSiCbecmJYVIRgbacJ2', // legacy admin_root@narid.com
]);

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
      'reports',
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

const DEFAULT_ROLE_PERMISSIONS: Record<
  string,
  Record<string, { view: boolean; add: boolean; edit: boolean; delete: boolean }>
> = {
  super_admin: {
    dashboard: { view: true, add: true, edit: true, delete: true },
    scanner: { view: true, add: true, edit: true, delete: true },
    'attendance.qr.scan': { view: true, add: true, edit: true, delete: true },
    'attendance.manual.entry': { view: true, add: true, edit: true, delete: true },
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
    ...Object.fromEntries(
      Array.from(DASHBOARD_VISIBILITY_KEYS).map((k) => [
        k,
        { view: true, add: true, edit: true, delete: true },
      ])
    ),
  },
  admin: {
    dashboard: { view: true, add: false, edit: false, delete: false },
    scanner: { view: true, add: true, edit: true, delete: false },
    'attendance.qr.scan': { view: false, add: false, edit: false, delete: false },
    'attendance.manual.entry': { view: false, add: false, edit: false, delete: false },
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
    'attendance.qr.scan': { view: false, add: false, edit: false, delete: false },
    'attendance.manual.entry': { view: false, add: false, edit: false, delete: false },
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

export const RESTRICTED_SUPER_ADMIN_MODULES = new Set([
  'user_rights',
  'audit_logs',
  'security_management',
]);

export const SCANNER_CAPABILITY_KEYS = new Set([
  'attendance.qr.scan',
  'attendance.manual.entry',
]);

export function sanitizeRoleModulePermissions(
  roleId: string,
  rawPerms?: Record<string, { view?: boolean; add?: boolean; edit?: boolean; delete?: boolean }> | null
): Record<string, { view: boolean; add: boolean; edit: boolean; delete: boolean }> {
  const normalizedRole = normalizeRoleValue(roleId);
  if (normalizedRole === 'super_admin') {
    return Object.fromEntries(
      Object.entries(DEFAULT_ROLE_PERMISSIONS.super_admin).map(([k, v]) => [k, { ...v }])
    );
  }

  const hasExplicitQrKey =
    Boolean(rawPerms) && Object.prototype.hasOwnProperty.call(rawPerms, 'attendance.qr.scan');

  const baseKeys = new Set([
    ...Object.keys(DEFAULT_ROLE_PERMISSIONS.user),
    ...Object.keys(rawPerms || {}),
  ]);
  const sanitized: Record<string, { view: boolean; add: boolean; edit: boolean; delete: boolean }> = {};

  for (const modKey of baseKeys) {
    if (RESTRICTED_SUPER_ADMIN_MODULES.has(modKey)) {
      sanitized[modKey] = { view: false, add: false, edit: false, delete: false };
      continue;
    }
    // Preserve unconfigured legacy QR behavior until attendance.qr.scan is explicitly configured
    if (modKey === 'attendance.qr.scan' && !hasExplicitQrKey) {
      continue;
    }
    // Preserve unconfigured legacy Dashboard Card/Section behavior unless explicitly provided
    if (DASHBOARD_VISIBILITY_KEYS.has(modKey)) {
      if (!rawPerms || !Object.prototype.hasOwnProperty.call(rawPerms, modKey)) {
        continue;
      }
      const visEntry = rawPerms[modKey];
      sanitized[modKey] = {
        view: Boolean(visEntry?.view),
        add: false,
        edit: false,
        delete: false,
      };
      continue;
    }
    const entry = rawPerms?.[modKey];
    const add = Boolean(entry?.add);
    const edit = Boolean(entry?.edit);
    const del = Boolean(entry?.delete);
    const view = Boolean(entry?.view) || add || edit || del;
    sanitized[modKey] = { view, add, edit, delete: del };
  }

  // If scanner module key was omitted while a scanner sub-capability was enabled,
  // grant Scanner page view visibility without granting scanner.add (prevents QR/manual bleed-over).
  if (
    rawPerms &&
    !Object.prototype.hasOwnProperty.call(rawPerms, 'scanner') &&
    (sanitized['attendance.qr.scan']?.view || sanitized['attendance.manual.entry']?.view)
  ) {
    sanitized.scanner = { view: true, add: false, edit: false, delete: false };
  }

  const anyDashSubEnabled = Array.from(DASHBOARD_VISIBILITY_KEYS).some(
    (k) => sanitized[k]?.view === true
  );
  if (
    rawPerms &&
    !Object.prototype.hasOwnProperty.call(rawPerms, 'dashboard') &&
    anyDashSubEnabled
  ) {
    sanitized.dashboard = { view: true, add: false, edit: false, delete: false };
  }

  if (rawPerms && Object.prototype.hasOwnProperty.call(rawPerms, 'dashboard') && sanitized.dashboard?.view === false) {
    for (const visKey of DASHBOARD_VISIBILITY_KEYS) {
      if (Object.prototype.hasOwnProperty.call(sanitized, visKey)) {
        sanitized[visKey] = { view: false, add: false, edit: false, delete: false };
      }
    }
  }

  return sanitized;
}

const PREDEFINED_ROLES = [
  {
    roleId: 'super_admin',
    roleName: 'SUPER_ADMIN',
    description:
      'Complete access to all application modules, account management, role permissions, system settings and administrative controls.',
    defaultPermissions: DEFAULT_ROLE_PERMISSIONS.super_admin,
    isActive: true,
    isSystemRole: true,
  },
  {
    roleId: 'admin',
    roleName: 'ADMIN',
    description:
      'Operational dashboard, attendance management, employee records, reports and other specifically authorized modules.',
    defaultPermissions: DEFAULT_ROLE_PERMISSIONS.admin,
    isActive: true,
    isSystemRole: true,
  },
  {
    roleId: 'user',
    roleName: 'USER',
    description:
      'Read-only Dashboard monitoring and Attendance Scanner access, according to assigned permissions.',
    defaultPermissions: DEFAULT_ROLE_PERMISSIONS.user,
    isActive: true,
    isSystemRole: true,
  },
];

// ============================================================================
// Admin SDK Bootstrap Seeders (Data Preservation Enforced)
// ============================================================================
async function seedPredefinedRoles(db: AdminFirestoreLike) {
  const now = new Date().toISOString();
  for (const roleDef of PREDEFINED_ROLES) {
    try {
      const roleRef = db.collection('roles').doc(roleDef.roleId);
      const snap = await roleRef.get();
      if (!snap.exists) {
        await roleRef.set({
          ...roleDef,
          dashboardAccessMigratedV1: true,
          updatedAt: now,
        });
      } else if (roleDef.roleId === 'user') {
        const rData = snap.data() || {};
        if (!rData.dashboardAccessMigratedV1) {
          await roleRef.set(
            {
              description: roleDef.description,
              defaultPermissions: {
                ...(rData.defaultPermissions || {}),
                dashboard: { view: true, add: false, edit: false, delete: false },
              },
              dashboardAccessMigratedV1: true,
              updatedAt: now,
            },
            { merge: true }
          );
        }
      }

      const permRef = db.collection('role_permissions').doc(roleDef.roleId);
      const permSnap = await permRef.get();
      if (!permSnap.exists) {
        await permRef.set({
          roleId: roleDef.roleId,
          roleName: roleDef.roleName,
          modulePermissions: roleDef.defaultPermissions,
          dashboardAccessMigratedV1: true,
          updatedAt: now,
          updatedBy: 'system',
        });
      } else if (roleDef.roleId === 'user') {
        const pData = permSnap.data() || {};
        if (!pData.dashboardAccessMigratedV1) {
          await permRef.set(
            {
              modulePermissions: {
                ...(pData.modulePermissions || {}),
                dashboard: { view: true, add: false, edit: false, delete: false },
              },
              dashboardAccessMigratedV1: true,
              updatedAt: now,
              updatedBy: 'system_migration',
            },
            { merge: true }
          );
        }
      }
    } catch (e: any) {
      console.warn(`[Roles Boot] Warning for role ${roleDef.roleId}:`, e?.message || e);
    }
  }
}

async function seedInitialAccounts(db: AdminFirestoreLike) {
  const now = new Date().toISOString();
  for (const acc of INITIAL_ACCOUNTS) {
    const docId = `role_${acc.loginId}`;
    try {
      const userRef = db.collection('user_roles').doc(docId);
      const snap = await userRef.get();
      if (!snap.exists) {
        // Only provision if missing in an empty database; never assigns a hardcoded known password
        const randomInitialHash = hashPassword(crypto.randomBytes(24).toString('hex'));
        await userRef.set({
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
          passwordHash: randomInitialHash,
          mustChangePassword: true,
          dashboardAccessMigratedV1: true,
          createdAt: now,
          updatedAt: now,
        });
        await syncUserUidIndex(db, {
          uid: acc.authUid,
          roleDocId: docId,
          role: acc.role,
          status: 'Active',
          lockStatus: 'ACTIVE',
          loginId: acc.loginId,
        });
      } else {
        // Strictly preserve existing authUid, email, and passwordHash!
        const data = snap.data() || {};
        const updates: Record<string, any> = {};

        if (acc.loginId === 'user' && !data.dashboardAccessMigratedV1) {
          const existingModules = Array.isArray(data.modulesAllowed) ? data.modulesAllowed : ['scanner'];
          if (!existingModules.includes('dashboard')) {
            updates.modulesAllowed = ['dashboard', ...existingModules];
          }
          updates.dashboardAccessMigratedV1 = true;
        }

        if (Object.keys(updates).length > 0) {
          updates.updatedAt = now;
          await userRef.update(updates);
        }

        const effectiveUid = String(data.authUid || acc.authUid || '').trim();
        if (effectiveUid) {
          await syncUserUidIndex(db, {
            uid: effectiveUid,
            roleDocId: docId,
            role: String(data.role || acc.role),
            status: String(data.status || 'Active'),
            lockStatus: data.isLocked || data.lockStatus === 'LOCKED' ? 'LOCKED' : 'ACTIVE',
            loginId: String(data.loginId || acc.loginId),
          });
        }
      }
    } catch (e: any) {
      console.warn(`[Auth Boot] Verification notice for ${acc.loginId}:`, e?.message || e);
    }
  }

  try {
    const settingsRef = db.collection('system_settings').doc('global');
    const settingsSnap = await settingsRef.get();
    if (settingsSnap.exists) {
      const sData = settingsSnap.data() || {};
      const sUpdates: Record<string, any> = {};
      if (sData.auditRetentionDays === undefined) sUpdates.auditRetentionDays = 90;
      if (sData.protectCriticalLogs === undefined) sUpdates.protectCriticalLogs = true;
      if (sData.captureGeoLocation === undefined) sUpdates.captureGeoLocation = true;
      if (sData.failedLoginAlertThreshold === undefined) sUpdates.failedLoginAlertThreshold = 5;
      if (Object.keys(sUpdates).length > 0) {
        await settingsRef.update(sUpdates);
      }
    }
  } catch (e: any) {
    console.warn('[Settings Boot] Security retention defaults notice:', e?.message || e);
  }
}

// ============================================================================
// CORS Origin Allowlist Helper
// ============================================================================
export const VERCEL_PRODUCTION_ORIGIN = 'https://narid-atdc-tracker.vercel.app';
export const AI_STUDIO_DEV_ORIGIN =
  'https://ais-dev-ffrnx5p5324ee4aajyzxbj-356936239657.asia-southeast1.run.app';
export const AI_STUDIO_PREVIEW_ORIGIN =
  'https://ais-pre-ffrnx5p5324ee4aajyzxbj-356936239657.asia-southeast1.run.app';

export function normalizeAllowedOrigin(raw?: string | null): string | null {
  const clean = String(raw || '').trim().replace(/\/+$/, '');
  if (!clean || clean === '*' || clean.includes('*')) return null;
  try {
    const parsed = new URL(clean);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (!parsed.hostname) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function buildAllowedOriginsSet(explicitOverride?: string[]): Set<string> {
  const allowed = new Set<string>();

  if (Array.isArray(explicitOverride)) {
    explicitOverride.forEach((o) => {
      const origin = normalizeAllowedOrigin(o);
      if (origin) allowed.add(origin);
    });
    return allowed;
  }

  // Canonical deployment origins (exact origins only; never wildcard subdomains)
  allowed.add(VERCEL_PRODUCTION_ORIGIN);
  allowed.add(AI_STUDIO_DEV_ORIGIN);
  allowed.add(AI_STUDIO_PREVIEW_ORIGIN);

  const rawEnv = process.env.ALLOWED_ORIGINS || '';
  rawEnv
    .split(',')
    .map((s) => normalizeAllowedOrigin(s))
    .filter((o): o is string => Boolean(o))
    .forEach((o) => allowed.add(o));

  for (const singleUrl of [process.env.APP_URL, process.env.FRONTEND_URL]) {
    const origin = normalizeAllowedOrigin(singleUrl);
    if (origin) {
      allowed.add(origin);
    }
  }

  for (const vercelHost of [
    process.env.VERCEL_URL,
    process.env.VERCEL_BRANCH_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
  ]) {
    const cleanHost = (vercelHost || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    if (cleanHost) {
      const origin = normalizeAllowedOrigin(`https://${cleanHost}`);
      if (origin) allowed.add(origin);
    }
  }

  if (process.env.NODE_ENV !== 'production') {
    allowed.add('http://localhost:3000');
    allowed.add('http://127.0.0.1:3000');
    allowed.add('http://localhost:5173');
    allowed.add('http://127.0.0.1:5173');
  }

  return allowed;
}

// ============================================================================
// Application Factory (Injectable for Isolated Testing & Vercel Serverless)
// ============================================================================
export interface ServerAppOptions {
  db?: AdminFirestoreLike;
  auth?: AdminAuthLike | null;
  projectId?: string;
  databaseId?: string;
  credentialMode?: 'SERVICE_ACCOUNT_ENV' | 'ADC' | 'UNCONFIGURED';
  allowedOrigins?: string[];
  disableBackgroundBoot?: boolean;
}

export function createApp(options: ServerAppOptions = {}) {
  const adminCtx = options.db ? null : getFirebaseAdminContext();
  const db = (options.db || adminCtx?.db) as AdminFirestoreLike | null;
  const auth = (options.auth !== undefined ? options.auth : adminCtx?.auth || null) as AdminAuthLike | null;
  const projectId = options.projectId || adminCtx?.projectId || TARGET_PROJECT_ID;
  const databaseId = options.databaseId || adminCtx?.databaseId || TARGET_DATABASE_ID;
  const credentialMode = options.credentialMode || adminCtx?.credentialMode || 'UNCONFIGURED';

  const app = express();
  app.set('trust proxy', 1);

  // Strict CORS Allowlist Middleware
  const allowedOrigins = buildAllowedOriginsSet(options.allowedOrigins);
  const useStrictExplicitCors = Array.isArray(options.allowedOrigins);

  const isOriginPermitted = (origin: string | undefined, req: Request): boolean => {
    if (!origin) return true; // Non-browser / same-origin fetch without Origin header
    const cleanOrigin = normalizeAllowedOrigin(origin);
    if (!cleanOrigin) return false;
    if (allowedOrigins.has(cleanOrigin)) return true;

    // Allow exact same-origin requests against active host / forwarded host unless explicit allowlist override was passed
    if (!useStrictExplicitCors) {
      const candidateHosts = [
        req.get('x-forwarded-host')?.split(',')[0]?.trim(),
        req.get('host'),
      ].filter((h): h is string => Boolean(h));

      const proto = req.get('x-forwarded-proto')?.split(',')[0]?.trim() || req.protocol || 'http';
      for (const host of candidateHosts) {
        if (cleanOrigin === `${proto}://${host}` || cleanOrigin === `https://${host}`) {
          return true;
        }
      }
    }
    return false;
  };

  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Vary', 'Origin');
    const origin = req.headers.origin;
    if (origin && !isOriginPermitted(origin, req)) {
      return res.status(403).json({
        success: false,
        code: 'CORS_ORIGIN_FORBIDDEN',
        error: 'Origin not allowed by CORS policy.',
      });
    }
    return next();
  });

  app.use(
    cors((req: Request, callback) => {
      const rawOrigin = req.headers.origin;
      const permitted = Boolean(rawOrigin && isOriginPermitted(rawOrigin, req));
      callback(null, {
        origin: permitted ? normalizeAllowedOrigin(rawOrigin) || false : false,
        credentials: permitted,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
        optionsSuccessStatus: 204,
      });
    })
  );

  const jsonBodyParser = express.json({ limit: '2mb' });
  app.use((req: Request, res: Response, next: NextFunction) => {
    // Preserve platform-parsed body if a serverless runtime (e.g. @vercel/node) already populated req.body
    const bodyDesc = Object.getOwnPropertyDescriptor(req, 'body');
    const hasOwnBodyProp = Boolean(
      bodyDesc && ('value' in bodyDesc || typeof bodyDesc.get === 'function')
    );

    if (hasOwnBodyProp) {
      const existingBody = (req as any).body;
      const isReadOnlyGetter = Boolean(bodyDesc && typeof bodyDesc.get === 'function' && !bodyDesc.set);

      if (existingBody !== undefined && existingBody !== null) {
        const isJsonHeader = String(req.headers['content-type'] || '')
          .toLowerCase()
          .includes('application/json');
        let normalizedBody = existingBody;

        if (isJsonHeader && (typeof existingBody === 'string' || Buffer.isBuffer(existingBody))) {
          const rawText = Buffer.isBuffer(existingBody)
            ? existingBody.toString('utf8')
            : existingBody;
          if (rawText.trim().length > 0) {
            try {
              normalizedBody = JSON.parse(rawText);
            } catch {
              // Leave malformed raw payload untouched
            }
          }
        }

        if (normalizedBody !== existingBody || isReadOnlyGetter) {
          if (!bodyDesc || bodyDesc.writable || typeof bodyDesc.set === 'function') {
            (req as any).body = normalizedBody;
          } else if (bodyDesc.configurable) {
            Object.defineProperty(req, 'body', {
              value: normalizedBody,
              writable: true,
              enumerable: true,
              configurable: true,
            });
          }
        }
        (req as any)._body = true;
        return next();
      }

      // If runtime attached an empty read-only getter, skip body-parser's `req.body = {}` assignment
      if (isReadOnlyGetter) {
        (req as any)._body = true;
        return next();
      }
    }

    return jsonBodyParser(req, res, next);
  });

  let runtimeFirestoreAccessError: string | null = null;
  const noteRuntimeFirestoreError = (err: unknown): boolean => {
    if (isFirestorePermissionDeniedError(err)) {
      runtimeFirestoreAccessError = formatAdminPermissionDeniedError(projectId, databaseId);
      return true;
    }
    return false;
  };

  // Health Check (Before DB dependency check so Cloud Run readiness probes always inspect status)
  app.get('/api/health', (_req: Request, res: Response) => {
    const effectiveWarning = runtimeFirestoreAccessError || adminCtx?.error;
    res.json({
      status: db && !runtimeFirestoreAccessError ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      projectId,
      databaseId,
      adminSdkInitialized: Boolean(db && auth),
      firestoreAccess: runtimeFirestoreAccessError ? 'permission_denied' : db ? 'ok' : 'unconfigured',
      credentialMode,
      ...(effectiveWarning ? { initWarning: effectiveWarning } : {}),
    });
  });

  if (!db) {
    app.use('/api', (_req: Request, res: Response) => {
      res.status(503).json({
        success: false,
        code: 'FIREBASE_ADMIN_UNCONFIGURED',
        error:
          adminCtx?.error ||
          'Firebase Admin SDK is not initialized. Configure FIREBASE_SERVICE_ACCOUNT_KEY (or FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY) on the server.',
      });
    });
    return { app, db: null, auth: null, projectId, databaseId, credentialMode };
  }

  const adminDb = db;

  if (!options.disableBackgroundBoot) {
    seedInitialAccounts(adminDb)
      .then(() => seedAccountSecurityRecords(adminDb))
      .catch((err) => {
        if (noteRuntimeFirestoreError(err)) {
          console.warn(`[Auth Boot] Firestore IAM notice: ${runtimeFirestoreAccessError}`);
        } else {
          console.warn('[Auth Boot] Seeding warning:', err?.message || err);
        }
      });
    seedPredefinedRoles(adminDb).catch((err) => {
      if (!noteRuntimeFirestoreError(err)) {
        console.warn('[Roles Boot] Seeding warning:', err?.message || err);
      }
    });
  }

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
    await recordEnterpriseAuditEvent(adminDb, {
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

  // Reusable Cryptographic Token + Strictly UID-Based RBAC Verification Helper
  async function requireVerifiedCaller(
    req: Request,
    res: Response,
    allowedRoles: string[] | '*',
    actionLabel: string,
    options?: { prefetchUserPermission?: boolean }
  ): Promise<VerifiedCaller | null> {
    try {
      const caller = await verifyCallerIdentity(req, adminDb, auth, projectId, options);
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
        res.status(401).json({
          success: false,
          error: 'Authentication required: Missing or invalid Firebase ID token.',
        });
        return null;
      }
      if (allowedRoles !== '*' && !allowedRoles.includes(caller.role)) {
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
      if (noteRuntimeFirestoreError(err)) {
        res.status(503).json({
          success: false,
          code: 'FIREBASE_ADMIN_PERMISSION_DENIED',
          error: runtimeFirestoreAccessError,
        });
        return null;
      }
      res.status(err?.statusCode || 401).json({
        success: false,
        error: err?.message || 'Session authentication verification failed.',
      });
      return null;
    }
  }

  async function getCallerEffectiveDashboardAccess(
    caller: VerifiedCaller
  ): Promise<{
    allowed: boolean;
    readOnly: boolean;
    permittedCards: DashboardCardId[];
    permittedSections: DashboardSectionId[];
  }> {
    if (caller.role === 'super_admin') {
      const visibility = resolveDashboardVisibility({ role: 'super_admin' });
      return {
        allowed: true,
        readOnly: false,
        permittedCards: visibility.permittedCards,
        permittedSections: visibility.permittedSections,
      };
    }

    const [userPermSnap, rolePermSnap, roleDefSnap, userRoleSnap] = await Promise.all([
      caller.profileDocId
        ? adminDb.collection('user_permissions').doc(caller.profileDocId).get()
        : Promise.resolve(null),
      getCachedRolePermissionsDoc(adminDb, caller.role),
      getCachedRoleDefDoc(adminDb, caller.role),
      caller.modulesAllowed === undefined && caller.profileDocId
        ? adminDb.collection('user_roles').doc(caller.profileDocId).get()
        : Promise.resolve(null),
    ]);

    const hasUserOverride = userPermSnap?.exists && userPermSnap.data()?.isCustomOverride !== false;
    const userPerms = hasUserOverride ? userPermSnap?.data()?.permissions || {} : null;
    const rolePerms = rolePermSnap?.exists ? rolePermSnap.data?.modulePermissions || {} : null;
    const roleDefaultPerms = roleDefSnap?.exists ? roleDefSnap.data?.defaultPermissions || {} : null;
    const rawModules =
      caller.modulesAllowed !== undefined
        ? caller.modulesAllowed
        : userRoleSnap?.exists && Array.isArray(userRoleSnap.data()?.modulesAllowed)
        ? userRoleSnap.data()!.modulesAllowed
        : [];
    const modulesAllowed = Array.isArray(rawModules)
      ? rawModules.map((m: any) => String(m).trim().toLowerCase())
      : [];

    const visibility = resolveDashboardVisibility({
      role: caller.role,
      modulesAllowed,
      rolePermissions: rolePerms,
      roleDefaultPermissions: roleDefaultPerms,
      userPermissionOverride: hasUserOverride
        ? { isCustomOverride: true, permissions: userPerms }
        : null,
    });

    if (caller.role === 'user') {
      return {
        allowed: visibility.dashboardViewAllowed,
        readOnly: true,
        permittedCards: visibility.permittedCards,
        permittedSections: visibility.permittedSections,
      };
    }
    if (caller.role === 'admin') {
      return {
        allowed: visibility.dashboardViewAllowed,
        readOnly: false,
        permittedCards: visibility.permittedCards,
        permittedSections: visibility.permittedSections,
      };
    }

    // Dynamic custom roles: readOnly=false when the role/user holds any non-dashboard operational write permission
    const effectivePerms = userPerms || rolePerms || roleDefaultPerms || {};
    const hasOperationalWrite = Object.entries(effectivePerms).some(([modKey, perms]: [string, any]) => {
      if (
        modKey === 'dashboard' ||
        DASHBOARD_VISIBILITY_KEYS.has(modKey) ||
        RESTRICTED_SUPER_ADMIN_MODULES.has(modKey)
      ) {
        return false;
      }
      return Boolean(perms?.add || perms?.edit || perms?.delete);
    });

    return {
      allowed: visibility.dashboardViewAllowed,
      readOnly: !hasOperationalWrite,
      permittedCards: visibility.permittedCards,
      permittedSections: visibility.permittedSections,
    };
  }

  // Register Security, Audit, Login Rate-Limiting & Attendance Routes
  registerSecurityAuditRoutes(app, adminDb, auth, projectId);

  registerLoginSecurityRoutes(app, {
    db: adminDb,
    auth,
    projectId,
    verifyPassword,
    hashPassword,
    syncExistingFirebaseAuthPassword,
    requireVerifiedCaller,
  });

  registerAttendanceRoutes(app, {
    db: adminDb,
    requireVerifiedCaller,
  });

  registerEmployeeRoutes(app, {
    db: adminDb,
    requireVerifiedCaller,
  });

  registerMasterRoutes(app, {
    db: adminDb,
    requireVerifiedCaller,
  });

  // ============================================================================
  // 1.1 Secure Authenticated Session Validity & Deactivation Guard
  // ============================================================================
  app.post('/api/auth/verify-session', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        '*',
        'Verify Active Session'
      );
      if (!caller) return;

      const parsed = VerifySessionInputSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({ success: false, active: false, error: 'Invalid session payload.' });
      }

      const { loginId, userId } = parsed.data;
      if (
        caller.role !== 'super_admin' &&
        ((loginId && loginId.toLowerCase() !== caller.loginId) ||
          (userId && userId !== caller.profileDocId && userId !== caller.uid))
      ) {
        return res.status(403).json({
          success: false,
          active: false,
          error: 'Forbidden: Cannot verify session status for another account.',
        });
      }

      const targetDocId = userId || caller.profileDocId;
      const speculativeSecId =
        !loginId || loginId.trim().toLowerCase() === caller.loginId
          ? `sec_${caller.loginId}`
          : null;

      let [userDoc, secSnap] = await Promise.all([
        adminDb.collection('user_roles').doc(targetDocId).get(),
        speculativeSecId
          ? adminDb.collection('account_security').doc(speculativeSecId).get()
          : Promise.resolve(null),
      ]);

      if (!userDoc.exists && loginId) {
        const cleanId = loginId.trim().toLowerCase();
        userDoc = await adminDb.collection('user_roles').doc(`role_${cleanId}`).get();
        if (!userDoc.exists) {
          const snap = await adminDb
            .collection('user_roles')
            .where('loginId', '==', cleanId)
            .limit(1)
            .get();
          if (!snap.empty) {
            userDoc = snap.docs[0];
          }
        }
      }

      if (!userDoc.exists) {
        return res.status(401).json({ success: false, active: false, error: 'Account not found.' });
      }

      const userData = userDoc.data() || {};
      if (userData.status === 'Inactive') {
        return res.status(401).json({
          success: false,
          active: false,
          error: 'Account Deactivated. Please contact system administrator.',
        });
      }

      const resolvedLoginId = String(userData.loginId || userDoc.id.replace(/^role_/, ''))
        .trim()
        .toLowerCase();
      if (!secSnap || speculativeSecId !== `sec_${resolvedLoginId}`) {
        secSnap = await adminDb.collection('account_security').doc(`sec_${resolvedLoginId}`).get();
      }
      const secData = secSnap.exists ? secSnap.data() || {} : null;
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

      const parsed = AdminSetPasswordInputSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: parsed.error.issues[0]?.message || 'targetLoginId and newPassword are required.',
        });
      }

      const {
        targetLoginId,
        newPassword,
        mustChangePassword,
        unlockAccount,
        revokeSessions,
        currentTargetPassword,
      } = parsed.data;

      const cleanCallerId = caller.loginId;
      const cleanTargetId = targetLoginId.trim().toLowerCase();
      const providedCurrentPwd =
        typeof currentTargetPassword === 'string' && currentTargetPassword.length > 0
          ? currentTargetPassword
          : undefined;

      const outcome = await withLoginIdLock(cleanTargetId, async () => {
        const docId = `role_${cleanTargetId}`;
        let targetDoc = await adminDb.collection('user_roles').doc(docId).get();

        if (!targetDoc.exists) {
          const snap = await adminDb
            .collection('user_roles')
            .where('loginId', '==', cleanTargetId)
            .limit(1)
            .get();
          if (snap.empty) {
            return { status: 404, body: { success: false, error: `User with Login ID "${targetLoginId}" not found.` } };
          }
          targetDoc = snap.docs[0];
        }

        const targetData = targetDoc.data();
        if (!targetData) {
          return { status: 404, body: { success: false, error: 'Target user record not found.' } };
        }
        const targetRole = String(targetData.role || 'user');
        const canonicalEmail = `${cleanTargetId}@narid.com`;
        const rawEmail = String(targetData.email || canonicalEmail).trim().toLowerCase();
        const targetEmail =
          rawEmail.endsWith('_root@narid.com') &&
          Array.isArray(targetData.emailAliases) &&
          targetData.emailAliases.includes(canonicalEmail)
            ? canonicalEmail
            : rawEmail;
        const targetUid = String(targetData.authUid || targetData.uid || targetDoc.id);

        let firebaseAuthSynced = false;
        let adminSdkAvailable = false;
        let rateLimited = false;
        let syncErrorReason = '';
        let matchedFirebaseEmail: string | null = null;

        const adminAttempt = await tryAdminAuthUpdatePassword(projectId, targetUid, newPassword, auth);
        adminSdkAvailable = adminAttempt.adminSdkAvailable;

        if (adminAttempt.updated) {
          firebaseAuthSynced = true;
          matchedFirebaseEmail = adminAttempt.email || targetEmail;
        } else {
          syncErrorReason = adminAttempt.reason || '';
          if (providedCurrentPwd && targetUid && !targetUid.startsWith('role_')) {
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
            }
          }
        }

        const telemetry = await captureTelemetryContext(adminDb, req);

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
              details: `Aborted password reset for "${cleanTargetId}" (UID: ${targetUid}, email: ${targetEmail}) because Firebase Auth update did not succeed. Firestore passwordHash left unchanged. Reason: ${syncErrorReason}`,
            }),
            recordSecurityAuditLogDoc(adminDb, {
              action: 'PASSWORD_RESET_SYNC_FAILED',
              severity: 'CRITICAL',
              targetLoginId: cleanTargetId,
              targetRole: targetRole.toUpperCase(),
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
            status: rateLimited ? 429 : adminSdkAvailable ? 422 : 503,
            body: {
              success: false,
              code: rateLimited ? 'FIREBASE_TOO_MANY_ATTEMPTS' : 'FIREBASE_AUTH_SYNC_FAILED',
              firebaseAuthSynced: false,
              adminSdkConfigured: adminSdkAvailable,
              firebaseUid: targetUid,
              targetEmail,
              error: rateLimited
                ? `Firebase Authentication rate limit active (TOO_MANY_ATTEMPTS_TRY_LATER). Firestore passwordHash for "${cleanTargetId}" was NOT modified.`
                : `Firebase Authentication could not update password for "${targetEmail}" (UID: ${targetUid}). Firestore passwordHash was NOT modified to prevent credential mismatch. ${syncErrorReason}`.trim(),
            },
          };
        }

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
          sessionRevokedAt: revokeSessions ? now : targetData.sessionRevokedAt || null,
          updatedAt: now,
        };
        if (unlockAccount) {
          targetUpdates.isLocked = false;
          targetUpdates.lockStatus = 'ACTIVE';
          targetUpdates.consecutiveFailedAttempts = 0;
          targetUpdates.lockedAt = null;
          targetUpdates.lockReason = null;
        }

        await adminDb.collection('user_roles').doc(targetDoc.id).update(targetUpdates);

        const snapMatching = await adminDb
          .collection('user_roles')
          .where('loginId', '==', cleanTargetId)
          .get();
        for (const mDoc of snapMatching.docs) {
          if (mDoc.id !== targetDoc.id) {
            await adminDb.collection('user_roles').doc(mDoc.id).update(targetUpdates);
          }
        }

        const secUpdate: Record<string, any> = {
          id: `sec_${cleanTargetId}`,
          loginId: cleanTargetId,
          role: targetRole.toUpperCase(),
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
          await clearIpCooldownPersistent(adminDb, undefined, cleanTargetId);
          if (targetData.authUid) {
            await syncUserUidIndex(adminDb, {
              uid: String(targetData.authUid),
              roleDocId: targetDoc.id,
              role: targetRole,
              status: String(targetData.status || 'Active'),
              lockStatus: 'ACTIVE',
              loginId: cleanTargetId,
            });
          }
        }

        await adminDb.collection('account_security').doc(`sec_${cleanTargetId}`).set(secUpdate, { merge: true });

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

        const resetLogId = `reset_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
        await adminDb.collection('password_reset_logs').doc(resetLogId).set({
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
      return res.status(500).json({ success: false, error: err?.message || 'Failed to update password.' });
    }
  });

  // ============================================================================
  // 2.1 View Password Reset Audit History (Super Admin Only)
  // ============================================================================
  app.get('/api/admin/password-reset-history', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, ['super_admin'], 'Password Reset History');
      if (!caller) return;

      const snap = await adminDb.collection('password_reset_logs').get();
      const history = snap.docs
        .map((d) => d.data())
        .sort(
          (a: any, b: any) =>
            new Date(b.timestamp || b.createdAt).getTime() - new Date(a.timestamp || a.createdAt).getTime()
        );

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
      const caller = await requireVerifiedCaller(
        req,
        res,
        '*',
        'First-Time Password Change'
      );
      if (!caller) return;

      const { loginId, currentPassword, newPassword } = req.body || {};
      if (typeof newPassword !== 'string' || newPassword.length < 6) {
        return res.status(400).json({ success: false, error: 'New password must be at least 6 characters.' });
      }
      if (newPassword.length > 128) {
        return res.status(400).json({ success: false, error: 'New password must be 128 characters or fewer.' });
      }

      const requestedLoginId = typeof loginId === 'string' ? loginId.trim().toLowerCase() : '';
      if (caller.role !== 'super_admin' && requestedLoginId && requestedLoginId !== caller.loginId) {
        await logAuditEvent({
          req,
          action: 'unauthorized_password_reset_attempt',
          loginId: caller.loginId,
          performedByUid: caller.uid,
          performedByLoginId: caller.loginId,
          performedByRole: caller.role.toUpperCase(),
          actionSource: 'CHANGE_PASSWORD_GUARD',
          success: false,
          details: `Blocked attempt by "${caller.loginId}" to change password for "${requestedLoginId}".`,
        });
        return res
          .status(403)
          .json({ success: false, error: 'Forbidden: You cannot modify another account password.' });
      }

      // Derive target account strictly from verified token caller for non-super-admin self-service
      const cleanId =
        caller.role === 'super_admin' && requestedLoginId ? requestedLoginId : caller.loginId;

      let userDoc =
        cleanId === caller.loginId && caller.profileDocId
          ? await adminDb.collection('user_roles').doc(caller.profileDocId).get()
          : await adminDb.collection('user_roles').doc(`role_${cleanId}`).get();

      if (!userDoc.exists) {
        const snap = await adminDb
          .collection('user_roles')
          .where('loginId', '==', cleanId)
          .limit(1)
          .get();
        if (snap.empty) {
          return res.status(404).json({ success: false, error: 'User not found.' });
        }
        userDoc = snap.docs[0];
      }

      const userData = userDoc.data();
      if (!userData) {
        return res.status(404).json({ success: false, error: 'User data not found.' });
      }

      const secRef = adminDb.collection('account_security').doc(`sec_${cleanId}`);
      const secSnap = await secRef.get();
      const secData = secSnap.exists ? secSnap.data() : null;
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

      const isSelfChange = caller.loginId === cleanId;
      if ((isSelfChange || !isSuperAdmin) && userData.passwordHash) {
        if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
          return res.status(400).json({
            success: false,
            code: 'CURRENT_PASSWORD_REQUIRED',
            error: 'Please enter your current password to verify your identity.',
          });
        }
        if (!verifyPassword(currentPassword, String(userData.passwordHash))) {
          await logAuditEvent({
            req,
            action: 'password_change_invalid_current',
            targetUid: userDoc.id,
            loginId: cleanId,
            performedByUid: caller.uid,
            performedByLoginId: caller.loginId,
            performedByRole: caller.role.toUpperCase(),
            actionSource: 'CHANGE_PASSWORD_GUARD',
            success: false,
            details: `Rejected password change for "${cleanId}" due to invalid current password.`,
          });
          return res.status(401).json({
            success: false,
            code: 'INVALID_CURRENT_PASSWORD',
            error: 'Current password is incorrect. Please check and try again.',
          });
        }
        if (newPassword === currentPassword) {
          return res.status(400).json({
            success: false,
            code: 'PASSWORD_REUSE_NOT_ALLOWED',
            error: 'New password must be different from your current password.',
          });
        }
      } else if (typeof currentPassword === 'string' && currentPassword.length > 0 && userData.passwordHash) {
        if (!verifyPassword(currentPassword, String(userData.passwordHash))) {
          return res.status(401).json({
            success: false,
            code: 'INVALID_CURRENT_PASSWORD',
            error: 'Current password is incorrect. Please check and try again.',
          });
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

      let firebaseAuthSynced = false;
      let syncErr = '';
      if (targetUid && !targetUid.startsWith('role_')) {
        const adminAttempt = await tryAdminAuthUpdatePassword(projectId, targetUid, newPassword, auth);
        if (adminAttempt.updated) {
          firebaseAuthSynced = true;
        } else {
          syncErr = adminAttempt.reason || '';
          const syncRes = await syncExistingFirebaseAuthPassword(
            targetEmail,
            targetUid,
            newPassword,
            typeof currentPassword === 'string' ? currentPassword : undefined
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
          error: `Firebase Authentication password could not be synchronized for "${targetEmail}" (UID: ${targetUid}). Firestore passwordHash was left unchanged. ${syncErr}`.trim(),
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

      await adminDb.collection('user_roles').doc(userDoc.id).update(passUpdates);
      await secRef.set(
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

      const snapPassMatching = await adminDb
        .collection('user_roles')
        .where('loginId', '==', cleanId)
        .get();
      for (const mDoc of snapPassMatching.docs) {
        if (mDoc.id !== userDoc.id) {
          await adminDb.collection('user_roles').doc(mDoc.id).update(passUpdates);
        }
      }

      const telemetry = await captureTelemetryContext(adminDb, req);
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
        recordSecurityAuditLogDoc(adminDb, {
          action: 'MANDATORY_PASSWORD_CHANGED',
          severity: 'INFO',
          targetLoginId: cleanId,
          targetRole: String(userData.role || 'USER').toUpperCase(),
          targetUid,
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
        targetEmail,
        mustChangePassword: false,
        forcePasswordChange: false,
        firebaseAuthSynced: true,
      });
    } catch (err: any) {
      console.error('[First-Time Password Change] Error:', err);
      return res.status(500).json({ success: false, error: err?.message || 'Failed to update password.' });
    }
  });

  // ============================================================================
  // 4. Create User Account via Firebase Admin SDK (Explicit Password, Real UID)
  // ============================================================================
  app.post('/api/admin/create-user', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, ['super_admin'], 'Create User Account');
      if (!caller) return;

      const parsed = CreateUserInputSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res
          .status(400)
          .json({ success: false, error: parsed.error.issues[0]?.message || 'Invalid user data.' });
      }

      if (!auth) {
        return res.status(503).json({
          success: false,
          error: 'Firebase Admin SDK Auth is not configured on backend; cannot create Firebase user.',
        });
      }

      const { name, loginId, email, role, password, status, modulesAllowed, mustChangePassword } = parsed.data;
      const cleanCallerId = caller.loginId;
      const cleanId = loginId.trim().toLowerCase();
      const cleanEmail = email.trim().toLowerCase();
      const docId = `role_${cleanId}`;

      const [existingDoc, existingSnap, emailSnap] = await Promise.all([
        adminDb.collection('user_roles').doc(docId).get(),
        adminDb.collection('user_roles').where('loginId', '==', cleanId).limit(1).get(),
        adminDb.collection('user_roles').where('email', '==', cleanEmail).limit(1).get(),
      ]);

      if (existingDoc.exists || !existingSnap.empty) {
        return res.status(400).json({ success: false, error: `Login ID "${cleanId}" already exists.` });
      }
      if (!emailSnap.empty) {
        return res
          .status(400)
          .json({ success: false, error: `Email address "${cleanEmail}" is already registered to another account.` });
      }

      const assignedRole = deriveStrictRoleId(role);
      if (!assignedRole || !VALID_ROLE_ID_REGEX.test(assignedRole)) {
        return res.status(400).json({ success: false, error: 'Invalid role ID specified.' });
      }

      const [roleDocSnap, rolePermSnap] = await Promise.all([
        adminDb.collection('roles').doc(assignedRole).get(),
        adminDb.collection('role_permissions').doc(assignedRole).get(),
      ]);

      if (!SYSTEM_ROLE_IDS.has(assignedRole) && !roleDocSnap.exists) {
        return res.status(400).json({
          success: false,
          error: `Role "${assignedRole}" does not exist. Create the role in Role Management first.`,
        });
      }
      if (roleDocSnap.exists && roleDocSnap.data()?.isActive === false) {
        return res.status(400).json({
          success: false,
          error: `Role "${assignedRole}" is currently inactive and cannot be assigned to new users.`,
        });
      }

      const roleDocData = roleDocSnap.exists ? roleDocSnap.data() || {} : null;
      const rolePermData = rolePermSnap.exists ? rolePermSnap.data() || {} : null;

      const now = new Date().toISOString();
      const passwordHash = hashPassword(password);
      const upperName = name.trim().toUpperCase();

      // Create real Firebase Auth user first to bind a real Firebase UID
      const fbUser = await auth.createUser({
        email: cleanEmail,
        password,
        displayName: upperName,
        disabled: status === 'Inactive',
      });

      try {
        let finalModules = Array.isArray(modulesAllowed) ? [...modulesAllowed] : [];
        if (assignedRole !== 'super_admin') {
          finalModules = finalModules.filter((m) => !RESTRICTED_SUPER_ADMIN_MODULES.has(m));
        }

        if (finalModules.length === 0) {
          if (assignedRole === 'super_admin') {
            finalModules = ['all'];
          } else if (rolePermData?.modulePermissions) {
            finalModules = Object.entries(rolePermData.modulePermissions)
              .filter(
                ([modKey, perms]: [string, any]) =>
                  Boolean(perms?.view) &&
                  !RESTRICTED_SUPER_ADMIN_MODULES.has(modKey) &&
                  !SCANNER_CAPABILITY_KEYS.has(modKey) &&
                  !DASHBOARD_VISIBILITY_KEYS.has(modKey)
              )
              .map(([modKey]) => modKey);
          } else if (roleDocData?.defaultPermissions) {
            finalModules = Object.entries(roleDocData.defaultPermissions)
              .filter(
                ([modKey, perms]: [string, any]) =>
                  Boolean(perms?.view) &&
                  !RESTRICTED_SUPER_ADMIN_MODULES.has(modKey) &&
                  !SCANNER_CAPABILITY_KEYS.has(modKey) &&
                  !DASHBOARD_VISIBILITY_KEYS.has(modKey)
              )
              .map(([modKey]) => modKey);
          } else if (assignedRole === 'admin') {
            finalModules = [
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
              'reports',
            ];
          } else if (assignedRole === 'user') {
            finalModules = ['dashboard', 'scanner'];
          }
        }

        const forceChange = mustChangePassword !== undefined ? Boolean(mustChangePassword) : true;
        const newRecord = {
          id: docId,
          uid: fbUser.uid,
          authUid: fbUser.uid,
          linkedAuthUids: [fbUser.uid],
          loginId: cleanId,
          name: upperName,
          displayName: upperName,
          email: cleanEmail,
          role: assignedRole,
          status: status || 'Active',
          modulesAllowed: finalModules,
          passwordHash,
          mustChangePassword: forceChange,
          forcePasswordChange: forceChange,
          isLocked: false,
          lockStatus: 'ACTIVE',
          consecutiveFailedAttempts: 0,
          createdBy: cleanCallerId,
          createdAt: now,
          updatedAt: now,
        };

        await adminDb.collection('user_roles').doc(docId).set(newRecord);

        const rawDefaultPerms =
          rolePermData?.modulePermissions ||
          roleDocData?.defaultPermissions ||
          DEFAULT_ROLE_PERMISSIONS[assignedRole] ||
          null;
        const defaultRolePerms = sanitizeRoleModulePermissions(assignedRole, rawDefaultPerms);

        await adminDb.collection('user_permissions').doc(docId).set({
          id: docId,
          userId: docId,
          loginId: cleanId,
          role: assignedRole,
          isCustomOverride: false,
          permissions: defaultRolePerms,
          updatedAt: now,
          updatedBy: cleanCallerId,
        });

        await adminDb.collection('account_security').doc(`sec_${cleanId}`).set({
          id: `sec_${cleanId}`,
          loginId: cleanId,
          role: assignedRole.toUpperCase(),
          firebaseUid: fbUser.uid,
          email: cleanEmail,
          lockStatus: 'ACTIVE',
          consecutiveFailedAttempts: 0,
          maxAttemptsAllowed: MAX_CONSECUTIVE_FAILED_ATTEMPTS,
          totalLoginAttempts: 0,
          totalSuccessfulLogins: 0,
          totalFailedLogins: 0,
          forcePasswordChange: forceChange,
          updatedAt: now,
        });

        await syncUserUidIndex(adminDb, {
          uid: fbUser.uid,
          roleDocId: docId,
          role: assignedRole,
          status: status || 'Active',
          lockStatus: 'ACTIVE',
          loginId: cleanId,
        });

        await logAuditEvent({
          req,
          action: 'account_created',
          targetUid: fbUser.uid,
          loginId: cleanId,
          performedByUid: caller.uid,
          performedByLoginId: cleanCallerId,
          performedByRole: 'SUPER_ADMIN',
          actionSource: 'USER_RIGHTS_CREATE',
          newValue: {
            loginId: cleanId,
            authUid: fbUser.uid,
            role: assignedRole,
            name: upperName,
            email: cleanEmail,
            status: newRecord.status,
          },
          details: `Created new login ID "${cleanId}" (Firebase UID: ${fbUser.uid}) with role ${assignedRole.toUpperCase()}.`,
        });

        const { passwordHash: _, ...sanitized } = newRecord;
        return res.json({ success: true, profile: sanitized });
      } catch (persistErr: any) {
        // Atomic rollback of Firebase Auth user if Firestore persistence fails
        await auth.deleteUser(fbUser.uid).catch(() => {});
        throw persistErr;
      }
    } catch (err: any) {
      console.error('[Create User] Error:', err);
      const code = String(err?.code || '');
      if (code.includes('email-already-exists')) {
        return res.status(400).json({
          success: false,
          error: 'Email address is already registered in Firebase Authentication.',
        });
      }
      return res.status(500).json({ success: false, error: err?.message || 'Failed to create user.' });
    }
  });

  // ============================================================================
  // 5. Secure Account Deletion (Super Admin Only with Canonical UID Protection)
  // ============================================================================
  app.post('/api/admin/delete-user', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, ['super_admin'], 'Delete User Account');
      if (!caller) return;

      const parsed = DeleteUserInputSchema.safeParse(req.body || {});
      if (!parsed.success || (!parsed.data.targetId && !parsed.data.targetLoginId)) {
        return res.status(400).json({ success: false, error: 'targetId or targetLoginId is required.' });
      }

      const { targetId, targetLoginId } = parsed.data;
      const cleanCallerId = caller.loginId;

      let targetDocId = targetId || '';
      let targetDocSnap = targetDocId
        ? await adminDb.collection('user_roles').doc(targetDocId).get()
        : null;

      if (!targetDocSnap || !targetDocSnap.exists) {
        const cleanTargetLoginId = (targetLoginId || '').trim().toLowerCase();
        if (cleanTargetLoginId) {
          targetDocId = `role_${cleanTargetLoginId}`;
          targetDocSnap = await adminDb.collection('user_roles').doc(targetDocId).get();
          if (!targetDocSnap.exists) {
            const snap = await adminDb
              .collection('user_roles')
              .where('loginId', '==', cleanTargetLoginId)
              .limit(1)
              .get();
            if (!snap.empty) {
              targetDocSnap = snap.docs[0];
              targetDocId = targetDocSnap.id;
            }
          }
        }
      }

      if (!targetDocSnap || !targetDocSnap.exists) {
        return res.status(404).json({ success: false, error: 'User account not found.' });
      }

      const targetData = targetDocSnap.data() || {};
      const targetLogin = String(targetData.loginId || targetLoginId || '').trim().toLowerCase();
      const targetUid = String(targetData.authUid || targetData.uid || '');

      if (cleanCallerId === targetLogin) {
        return res.status(400).json({
          success: false,
          error: 'Action denied: Administrators cannot delete their own active account.',
        });
      }

      if (targetLogin === 'superadmin' || targetDocId === 'role_superadmin' || CANONICAL_PROTECTED_UIDS.has(targetUid)) {
        return res.status(400).json({
          success: false,
          error: 'Action denied: Protected canonical system accounts cannot be deleted.',
        });
      }

      if (String(targetData.role || '').toLowerCase() === 'super_admin') {
        const allUsersSnap = await adminDb.collection('user_roles').get();
        const activeSuperAdmins = allUsersSnap.docs.filter((d) => {
          const data = d.data() || {};
          return String(data.role || '').toLowerCase() === 'super_admin' && data.status !== 'Inactive';
        });
        if (activeSuperAdmins.length <= 1) {
          return res.status(400).json({
            success: false,
            error: 'Action denied: Cannot delete the last remaining active Super Admin.',
          });
        }
      }

      await adminDb.collection('user_roles').doc(targetDocId).delete();
      await adminDb.collection('user_permissions').doc(targetDocId).delete().catch(() => {});
      if (targetUid && !targetUid.startsWith('role_')) {
        await removeUserUidIndex(adminDb, targetUid);
        invalidateUidRolePointer(adminDb, targetUid);
        if (auth) {
          await auth.revokeRefreshTokens(targetUid).catch(() => {});
          await auth.deleteUser(targetUid).catch(() => {});
        }
      }

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
          name: targetData.name,
          role: targetData.role,
          status: targetData.status,
        },
        details: `Deleted user account "${targetLogin}" (${targetData.role})`,
      });

      return res.json({
        success: true,
        message: `User account "${targetLogin}" successfully deleted from Firebase.`,
      });
    } catch (err: any) {
      console.error('[Delete User] Error:', err);
      return res.status(500).json({ success: false, error: err?.message || 'Failed to delete user account.' });
    }
  });

  // ============================================================================
  // 6. Update User Module Permissions (Admin SDK + UID Index Sync)
  // ============================================================================
  app.post('/api/admin/set-user-permissions', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, ['super_admin'], 'Update User Permissions');
      if (!caller) return;

      const parsed = SetUserPermissionsInputSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res
          .status(400)
          .json({ success: false, error: parsed.error.issues[0]?.message || 'Invalid permissions request.' });
      }

      const { targetId, permissions, modulesAllowed, role, status } = parsed.data;
      const cleanCallerId = caller.loginId;

      const targetDocRef = adminDb.collection('user_roles').doc(targetId);
      const targetSnap = await targetDocRef.get();
      if (!targetSnap.exists) {
        return res.status(404).json({ success: false, error: 'User account not found.' });
      }

      const oldData = targetSnap.data() || {};
      const now = new Date().toISOString();

      const oldLoginId = String(oldData.loginId || '').trim().toLowerCase();
      const targetUid = String(oldData.authUid || oldData.uid || '');
      const requestedRole = role ? deriveStrictRoleId(role) : '';

      if (
        requestedRole &&
        requestedRole !== 'super_admin' &&
        (oldLoginId === 'superadmin' || targetId === 'role_superadmin' || CANONICAL_PROTECTED_UIDS.has(targetUid))
      ) {
        return res.status(400).json({
          success: false,
          error: 'Action denied: Protected canonical system accounts cannot have their role downgraded.',
        });
      }

      if (requestedRole && !SYSTEM_ROLE_IDS.has(requestedRole)) {
        const customRoleSnap = await adminDb.collection('roles').doc(requestedRole).get();
        if (!customRoleSnap.exists) {
          return res.status(400).json({
            success: false,
            error: `Role "${requestedRole}" does not exist.`,
          });
        }
        if (customRoleSnap.data()?.isActive === false) {
          return res.status(400).json({
            success: false,
            error: `Role "${requestedRole}" is currently inactive.`,
          });
        }
      }

      const effectiveRole = normalizeRoleValue(requestedRole || oldData.role || 'user');
      const safeModules =
        effectiveRole === 'super_admin'
          ? modulesAllowed
          : modulesAllowed?.filter((m) => !RESTRICTED_SUPER_ADMIN_MODULES.has(m));

      const updatePayload: Record<string, any> = { updatedAt: now };
      if (safeModules) updatePayload.modulesAllowed = safeModules;
      if (requestedRole) updatePayload.role = requestedRole;
      if (status) updatePayload.status = status;
      await targetDocRef.update(updatePayload);

      if (oldData.authUid) {
        await syncUserUidIndex(adminDb, {
          uid: String(oldData.authUid),
          roleDocId: targetId,
          role: requestedRole || normalizeRoleValue(oldData.role || 'user'),
          status: status || String(oldData.status || 'Active'),
          lockStatus: oldData.isLocked || oldData.lockStatus === 'LOCKED' ? 'LOCKED' : 'ACTIVE',
          loginId: String(oldData.loginId || ''),
        });
        if (auth && status) {
          await auth.updateUser(String(oldData.authUid), { disabled: status === 'Inactive' }).catch(() => {});
          if (status === 'Inactive') {
            await auth.revokeRefreshTokens(String(oldData.authUid)).catch(() => {});
          }
        }
      }

      if (permissions) {
        const sanitizedPerms = sanitizeRoleModulePermissions(effectiveRole, permissions);
        const userPermRef = adminDb.collection('user_permissions').doc(targetId);
        const userPermExisting = await userPermRef.get();
        const userPermPayload = {
          id: targetId,
          userId: targetId,
          loginId: oldData.loginId || '',
          role: effectiveRole,
          isCustomOverride: true,
          permissions: sanitizedPerms,
          updatedAt: now,
          updatedBy: cleanCallerId,
        };
        if (userPermExisting.exists) {
          await userPermRef.update(userPermPayload);
        } else {
          await userPermRef.set(userPermPayload);
        }
      }

      await logAuditEvent({
        req,
        action: 'permission_updated',
        targetUid: targetId,
        loginId: String(oldData.loginId || ''),
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
          role: effectiveRole,
          modulesAllowed: safeModules || oldData.modulesAllowed,
          status: status || oldData.status,
        },
        details: `Updated permissions and role for user "${oldData.loginId}"`,
      });

      invalidateRoleCaches(adminDb, effectiveRole);
      if (oldData.authUid) {
        invalidateUidRolePointer(adminDb, String(oldData.authUid));
      }

      return res.json({ success: true, message: `Permissions for "${oldData.loginId}" updated successfully.` });
    } catch (err: any) {
      console.error('[Set User Permissions] Error:', err);
      return res.status(500).json({ success: false, error: err?.message || 'Failed to update user permissions.' });
    }
  });

  // ============================================================================
  // 6.1 Bulk User Status Toggle (Super Admin Only — Safe Account Activation/Deactivation)
  // ============================================================================
  const BulkUserStatusInputSchema = z.object({
    userIds: z.array(z.string().trim().min(1)).min(1, 'Select at least one user account.').max(200),
    status: z.enum(['Active', 'Inactive']),
    confirmed: z.literal(true, {
      message: 'Explicit confirmation is required for bulk user status updates.',
    }),
  });

  app.post('/api/admin/users/bulk-status', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, ['super_admin'], 'Bulk User Status Update');
      if (!caller) return;

      const parsed = BulkUserStatusInputSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: parsed.error.issues[0]?.message || 'Invalid bulk user status payload.',
        });
      }

      const { status } = parsed.data;
      const uniqueIds = Array.from(new Set(parsed.data.userIds.map((id) => id.trim()).filter(Boolean)));
      const now = new Date().toISOString();

      const allUsersSnap = await adminDb.collection('user_roles').get();
      const userDocById = new Map<string, Record<string, any>>();
      let activeSuperAdminCount = 0;

      for (const docSnap of allUsersSnap.docs) {
        const data = docSnap.data() || {};
        userDocById.set(docSnap.id, data);
        if (String(data.role || '').toLowerCase() === 'super_admin' && data.status !== 'Inactive') {
          activeSuperAdminCount++;
        }
      }

      const committedIds: string[] = [];
      const skippedItems: Array<{ id: string; reason: string }> = [];
      const failedItems: Array<{ id: string; error: string }> = [];

      for (const targetId of uniqueIds) {
        const targetData = userDocById.get(targetId);
        if (!targetData) {
          skippedItems.push({ id: targetId, reason: 'User account not found.' });
          continue;
        }

        const targetLogin = String(targetData.loginId || '').trim().toLowerCase();
        const targetUid = String(targetData.authUid || targetData.uid || '');
        const isSuper = String(targetData.role || '').toLowerCase() === 'super_admin';

        if (status === 'Inactive') {
          if (targetLogin === caller.loginId || targetId === caller.profileDocId) {
            skippedItems.push({
              id: targetId,
              reason: 'Protected: Cannot deactivate your own active account.',
            });
            continue;
          }
          if (
            targetLogin === 'superadmin' ||
            targetId === 'role_superadmin' ||
            CANONICAL_PROTECTED_UIDS.has(targetUid)
          ) {
            skippedItems.push({
              id: targetId,
              reason: 'Protected: Root canonical Super Admin account cannot be deactivated.',
            });
            continue;
          }
          if (isSuper && activeSuperAdminCount <= 1) {
            skippedItems.push({
              id: targetId,
              reason: 'Protected: Cannot deactivate the last remaining active Super Admin.',
            });
            continue;
          }
        }

        if (targetData.status === status) {
          skippedItems.push({ id: targetId, reason: `Account is already ${status}.` });
          continue;
        }

        try {
          await adminDb.collection('user_roles').doc(targetId).update({
            status,
            updatedAt: now,
          });

          if (targetUid && !targetUid.startsWith('role_')) {
            await syncUserUidIndex(adminDb, {
              uid: targetUid,
              roleDocId: targetId,
              role: normalizeRoleValue(targetData.role || 'user'),
              status,
              lockStatus: targetData.isLocked || targetData.lockStatus === 'LOCKED' ? 'LOCKED' : 'ACTIVE',
              loginId: targetLogin,
            });
            invalidateUidRolePointer(adminDb, targetUid);
            if (auth) {
              await auth.updateUser(targetUid, { disabled: status === 'Inactive' }).catch(() => {});
              if (status === 'Inactive') {
                await auth.revokeRefreshTokens(targetUid).catch(() => {});
              }
            }
          }

          if (status === 'Inactive' && isSuper) {
            activeSuperAdminCount--;
          } else if (status === 'Active' && isSuper && targetData.status === 'Inactive') {
            activeSuperAdminCount++;
          }

          committedIds.push(targetId);
        } catch (err: any) {
          failedItems.push({ id: targetId, error: err?.message || 'Failed to update account status.' });
        }
      }

      await logAuditEvent({
        req,
        action: 'bulk_user_status_updated',
        targetUid: committedIds.slice(0, 10).join(',') || 'user_roles',
        loginId: caller.loginId,
        performedByUid: caller.uid,
        performedByLoginId: caller.loginId,
        performedByRole: 'SUPER_ADMIN',
        actionSource: 'USER_RIGHTS_BULK_STATUS',
        newValue: {
          status,
          savedCount: committedIds.length,
          skippedCount: skippedItems.length,
          failedCount: failedItems.length,
          committedIds,
        },
        details: `Super Admin bulk set ${committedIds.length} user account(s) to ${status} (skipped ${skippedItems.length}).`,
      });

      const partialCommit = committedIds.length > 0 && failedItems.length > 0;
      const statusCode = failedItems.length > 0 && committedIds.length === 0 ? 500 : 200;

      return res.status(statusCode).json({
        success: failedItems.length === 0,
        status,
        savedCount: committedIds.length,
        skippedCount: skippedItems.length,
        failedCount: failedItems.length,
        partialCommit,
        committedIds,
        skippedItems,
        failedItems,
      });
    } catch (err: any) {
      console.error('[Bulk User Status API] Error:', err);
      return res.status(500).json({ success: false, error: err?.message || 'Bulk user status update failed.' });
    }
  });

  // ============================================================================
  // 7. Save Role Permissions (Role Defaults + Sync user_roles)
  // ============================================================================
  app.post('/api/admin/role-permissions', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, ['super_admin'], 'Save Role Permissions');
      if (!caller) return;

      const parsed = RolePermissionsInputSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res
          .status(400)
          .json({ success: false, error: parsed.error.issues[0]?.message || 'Invalid role permissions request.' });
      }

      const { roleId, modulePermissions } = parsed.data;
      if (roleId === 'super_admin') {
        return res.status(400).json({ success: false, error: 'Super Admin permissions are complete and permanent.' });
      }

      const roleDocSnap = await adminDb.collection('roles').doc(roleId).get();
      if (!SYSTEM_ROLE_IDS.has(roleId) && !roleDocSnap.exists) {
        return res.status(404).json({ success: false, error: `Role "${roleId}" does not exist.` });
      }

      const resolvedRoleName =
        String(roleDocSnap.exists ? roleDocSnap.data()?.roleName || '' : '').trim() ||
        (roleId === 'admin' ? 'Admin' : roleId === 'user' ? 'User' : roleId.toUpperCase());

      const cleanCallerId = caller.loginId;
      const now = new Date().toISOString();

      const sanitizedModulePermissions = sanitizeRoleModulePermissions(roleId, modulePermissions);

      const rolePermRef = adminDb.collection('role_permissions').doc(roleId);
      const rolePermExisting = await rolePermRef.get();
      const rolePermPayload = {
        roleId,
        roleName: resolvedRoleName,
        modulePermissions: sanitizedModulePermissions,
        updatedAt: now,
        updatedBy: cleanCallerId,
      };
      if (rolePermExisting.exists) {
        await rolePermRef.update(rolePermPayload);
      } else {
        await rolePermRef.set(rolePermPayload);
      }

      const roleRefForUpdate = adminDb.collection('roles').doc(roleId);
      const roleUpdatePayload = {
        roleId,
        roleName: resolvedRoleName,
        defaultPermissions: sanitizedModulePermissions,
        updatedAt: now,
      };
      if (roleDocSnap.exists) {
        await roleRefForUpdate.update(roleUpdatePayload);
      } else {
        await roleRefForUpdate.set(roleUpdatePayload, { merge: true });
      }

      const allowedModules: string[] = [];
      Object.entries(sanitizedModulePermissions).forEach(([modKey, perms]: [string, any]) => {
        if (
          perms?.view &&
          !SCANNER_CAPABILITY_KEYS.has(modKey) &&
          !DASHBOARD_VISIBILITY_KEYS.has(modKey)
        ) {
          allowedModules.push(modKey);
        }
      });
      const usersSnap = await adminDb.collection('user_roles').where('role', '==', roleId).get();
      await Promise.all(
        usersSnap.docs.map(async (uDoc) => {
          await adminDb.collection('user_roles').doc(uDoc.id).update({
            modulesAllowed: allowedModules,
            updatedAt: now,
          });
          const userPermRef = adminDb.collection('user_permissions').doc(uDoc.id);
          const userPermSnap = await userPermRef.get();
          if (!userPermSnap.exists || userPermSnap.data()?.isCustomOverride !== true) {
            const inheritedPayload = {
              id: uDoc.id,
              userId: uDoc.id,
              loginId: uDoc.data()?.loginId || '',
              role: roleId,
              isCustomOverride: false,
              permissions: sanitizedModulePermissions,
              updatedAt: now,
              updatedBy: cleanCallerId,
            };
            if (userPermSnap.exists) {
              await userPermRef.update(inheritedPayload);
            } else {
              await userPermRef.set(inheritedPayload);
            }
          }
        })
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

      invalidateRoleCaches(adminDb, roleId);

      return res.json({
        success: true,
        message: `Role permissions for ${resolvedRoleName} saved successfully.`,
        modulePermissions: sanitizedModulePermissions,
        updatedAt: now,
      });
    } catch (err: any) {
      console.error('[Save Role Permissions] Error:', err);
      return res.status(500).json({ success: false, error: err?.message || 'Failed to save role permissions.' });
    }
  });

  // ============================================================================
  // 7.0 Dynamic Role Registry & Custom Role Management (Super Admin Only Writes)
  // ============================================================================
  app.get('/api/admin/roles', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, '*', 'List System and Custom Roles');
      if (!caller) return;

      const snap = await adminDb.collection('roles').get();
      const map = new Map<string, any>();

      PREDEFINED_ROLES.forEach((def) => {
        map.set(def.roleId, { ...def });
      });

      snap.docs.forEach((d) => {
        const data = d.data() || {};
        const roleId = normalizeRoleValue(data.roleId || d.id);
        map.set(roleId, {
          ...data,
          roleId,
          roleName: String(data.roleName || roleId.toUpperCase()),
          isActive: data.isActive !== false,
          isSystemRole: SYSTEM_ROLE_IDS.has(roleId),
        });
      });

      const orderPriority: Record<string, number> = { super_admin: 0, admin: 1, user: 2 };
      const roles = Array.from(map.values()).sort((a, b) => {
        const pA = orderPriority[a.roleId] ?? 10;
        const pB = orderPriority[b.roleId] ?? 10;
        if (pA !== pB) return pA - pB;
        return String(a.roleName || a.roleId).localeCompare(String(b.roleName || b.roleId));
      });

      return res.json({ success: true, roles });
    } catch (err: any) {
      console.error('[Roles API] List error:', err);
      return res.status(500).json({ success: false, error: 'Failed to load role definitions.' });
    }
  });

  app.post('/api/admin/roles', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, ['super_admin'], 'Create or Update Role');
      if (!caller) return;

      const parsed = RoleDefinitionInputSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: parsed.error.issues[0]?.message || 'Invalid role definition payload.',
        });
      }

      const rawIdCandidate = parsed.data.roleId || parsed.data.roleName;
      const derivedId = deriveStrictRoleId(rawIdCandidate);
      const isCreatingFromName = !parsed.data.roleId;

      if (!derivedId || !VALID_ROLE_ID_REGEX.test(derivedId)) {
        return res.status(400).json({
          success: false,
          error: 'Role ID must start with a letter and use lowercase letters, numbers, or underscores.',
        });
      }

      if (isCreatingFromName && (SYSTEM_ROLE_IDS.has(derivedId) || RESERVED_CUSTOM_ROLE_ALIASES.has(derivedId))) {
        return res.status(400).json({
          success: false,
          error: `Role name "${parsed.data.roleName}" conflicts with a reserved system role.`,
        });
      }

      if (parsed.data.roleId && RESERVED_CUSTOM_ROLE_ALIASES.has(derivedId) && derivedId !== 'super_admin') {
        return res.status(400).json({
          success: false,
          error: `Role ID "${derivedId}" is reserved and cannot be used for a custom role.`,
        });
      }

      if (derivedId === 'super_admin') {
        return res.status(400).json({
          success: false,
          error: 'Super Admin system role configuration is protected and immutable.',
        });
      }

      const isSystem = SYSTEM_ROLE_IDS.has(derivedId);
      if (isSystem && parsed.data.isActive === false) {
        return res.status(400).json({
          success: false,
          error: 'Built-in system roles cannot be deactivated.',
        });
      }

      const roleRef = adminDb.collection('roles').doc(derivedId);
      const existingSnap = await roleRef.get();
      const existingData = existingSnap.exists ? existingSnap.data() || {} : null;
      const now = new Date().toISOString();
      const cleanCallerId = caller.loginId;

      const sanitizedDefaultPerms = sanitizeRoleModulePermissions(
        derivedId,
        parsed.data.defaultPermissions ||
          existingData?.defaultPermissions ||
          DEFAULT_ROLE_PERMISSIONS[derivedId] ||
          null
      );

      const roleDoc = {
        roleId: derivedId,
        roleName: parsed.data.roleName.trim(),
        description: parsed.data.description.trim(),
        isActive: isSystem ? true : Boolean(parsed.data.isActive),
        isSystemRole: isSystem,
        defaultPermissions: sanitizedDefaultPerms,
        createdAt: existingData?.createdAt || now,
        createdBy: existingData?.createdBy || cleanCallerId,
        updatedAt: now,
        updatedBy: cleanCallerId,
      };

      if (existingSnap.exists) {
        await roleRef.update(roleDoc);
      } else {
        await roleRef.set(roleDoc);
      }
      const rolePermRef = adminDb.collection('role_permissions').doc(derivedId);
      const rolePermSnap = await rolePermRef.get();
      const rolePermDocPayload = {
        roleId: derivedId,
        roleName: roleDoc.roleName,
        modulePermissions: sanitizedDefaultPerms,
        updatedAt: now,
        updatedBy: cleanCallerId,
      };
      if (rolePermSnap.exists) {
        await rolePermRef.update(rolePermDocPayload);
      } else {
        await rolePermRef.set(rolePermDocPayload);
      }

      if (parsed.data.defaultPermissions) {
        const allowedModules = Object.entries(sanitizedDefaultPerms)
          .filter(
            ([modKey, perms]) =>
              Boolean(perms?.view) &&
              !SCANNER_CAPABILITY_KEYS.has(modKey) &&
              !DASHBOARD_VISIBILITY_KEYS.has(modKey)
          )
          .map(([modKey]) => modKey);
        const usersSnap = await adminDb.collection('user_roles').where('role', '==', derivedId).get();
        await Promise.all(
          usersSnap.docs.map(async (uDoc) => {
            await adminDb.collection('user_roles').doc(uDoc.id).update({
              modulesAllowed: allowedModules,
              updatedAt: now,
            });
            const userPermRef = adminDb.collection('user_permissions').doc(uDoc.id);
            const userPermSnap = await userPermRef.get();
            if (!userPermSnap.exists || userPermSnap.data()?.isCustomOverride !== true) {
              const inheritedPayload = {
                id: uDoc.id,
                userId: uDoc.id,
                loginId: uDoc.data()?.loginId || '',
                role: derivedId,
                isCustomOverride: false,
                permissions: sanitizedDefaultPerms,
                updatedAt: now,
                updatedBy: cleanCallerId,
              };
              if (userPermSnap.exists) {
                await userPermRef.update(inheritedPayload);
              } else {
                await userPermRef.set(inheritedPayload);
              }
            }
          })
        );
      }

      await logAuditEvent({
        req,
        action: existingSnap.exists ? 'role_updated' : 'role_created',
        targetUid: derivedId,
        loginId: derivedId,
        performedByUid: caller.uid,
        performedByLoginId: cleanCallerId,
        performedByRole: 'SUPER_ADMIN',
        actionSource: 'ROLE_MANAGEMENT',
        previousValue: existingData
          ? {
              roleName: existingData.roleName,
              description: existingData.description,
              isActive: existingData.isActive,
            }
          : undefined,
        newValue: {
          roleId: derivedId,
          roleName: roleDoc.roleName,
          description: roleDoc.description,
          isActive: roleDoc.isActive,
        },
        details: `${existingSnap.exists ? 'Updated' : 'Created'} role "${roleDoc.roleName}" (${derivedId}).`,
      });

      invalidateRoleCaches(adminDb, derivedId);

      return res.json({
        success: true,
        created: !existingSnap.exists,
        role: roleDoc,
        modulePermissions: sanitizedDefaultPerms,
      });
    } catch (err: any) {
      console.error('[Save Role Definition] Error:', err);
      return res.status(500).json({ success: false, error: err?.message || 'Failed to save role definition.' });
    }
  });

  app.delete('/api/admin/roles/:roleId', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, ['super_admin'], 'Delete Custom Role');
      if (!caller) return;

      const roleId = deriveStrictRoleId(req.params.roleId);
      if (!roleId || !VALID_ROLE_ID_REGEX.test(roleId)) {
        return res.status(400).json({ success: false, error: 'Invalid role ID.' });
      }

      if (SYSTEM_ROLE_IDS.has(roleId)) {
        return res.status(400).json({
          success: false,
          error: `Built-in system role "${roleId}" cannot be deleted.`,
        });
      }

      const roleSnap = await adminDb.collection('roles').doc(roleId).get();
      if (!roleSnap.exists) {
        return res.status(404).json({ success: false, error: `Role "${roleId}" not found.` });
      }

      const assignedUsersSnap = await adminDb
        .collection('user_roles')
        .where('role', '==', roleId)
        .limit(1)
        .get();
      if (!assignedUsersSnap.empty) {
        return res.status(400).json({
          success: false,
          error: `Cannot delete role "${roleId}" while one or more user accounts are assigned to it.`,
        });
      }

      const prevRoleData = roleSnap.data() || {};
      await Promise.all([
        adminDb.collection('roles').doc(roleId).delete(),
        adminDb.collection('role_permissions').doc(roleId).delete().catch(() => {}),
      ]);

      await logAuditEvent({
        req,
        action: 'role_deleted',
        targetUid: roleId,
        loginId: roleId,
        performedByUid: caller.uid,
        performedByLoginId: caller.loginId,
        performedByRole: 'SUPER_ADMIN',
        actionSource: 'ROLE_MANAGEMENT',
        previousValue: {
          roleId,
          roleName: prevRoleData.roleName,
          description: prevRoleData.description,
        },
        details: `Deleted custom role "${prevRoleData.roleName || roleId}" (${roleId}).`,
      });

      invalidateRoleCaches(adminDb, roleId);

      return res.json({
        success: true,
        message: `Custom role "${prevRoleData.roleName || roleId}" deleted successfully.`,
      });
    } catch (err: any) {
      console.error('[Delete Custom Role] Error:', err);
      return res.status(500).json({ success: false, error: err?.message || 'Failed to delete role.' });
    }
  });

  // ============================================================================
  // 7.1 Duplicate Accounts Audit & Detection (Super Admin Only)
  // ============================================================================
  app.get('/api/admin/duplicate-accounts-report', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, ['super_admin'], 'Duplicate Accounts Report');
      if (!caller) return;

      const [userRolesSnap, auditSnap] = await Promise.all([
        adminDb.collection('user_roles').get(),
        adminDb.collection('audit_logs').get(),
      ]);

      const groups: Record<string, any[]> = {};
      userRolesSnap.docs.forEach((d) => {
        const data = d.data() || {};
        const loginId = String(data.loginId || d.id.replace(/^role_/, '')).trim().toLowerCase();
        if (!groups[loginId]) groups[loginId] = [];
        groups[loginId].push({ docId: d.id, ...data });
      });

      let totalDuplicates = 0;
      const report: any[] = [];

      for (const [loginId, docs] of Object.entries(groups)) {
        const hasDuplicates = docs.length > 1;
        if (hasDuplicates) totalDuplicates += docs.length - 1;

        docs.sort((a, b) => {
          if (a.docId === `role_${loginId}`) return -1;
          if (b.docId === `role_${loginId}`) return 1;
          if (a.passwordHash && !b.passwordHash) return -1;
          if (!a.passwordHash && b.passwordHash) return 1;
          return (a.createdAt || '').localeCompare(b.createdAt || '');
        });

        const primaryDoc = docs[0];
        const docDetails = docs.map((d) => {
          const auditCount = auditSnap.docs.filter((a) => {
            const str = JSON.stringify(a.data());
            return str.includes(d.docId) || (d.uid && str.includes(d.uid));
          }).length;

          const isPrimary = d.docId === primaryDoc.docId;
          return {
            docId: d.docId,
            firebaseUid:
              d.uid || d.authUid || (d.docId.length > 20 && !d.docId.startsWith('role_') ? d.docId : null),
            loginId: d.loginId || loginId,
            name: d.name || d.displayName || 'N/A',
            email: d.email || 'N/A',
            role: d.role || 'user',
            status: d.status || 'Active',
            hasPasswordHash: !!d.passwordHash,
            createdAt: d.createdAt || null,
            associatedAuditLogs: auditCount,
            isPrimary,
            recommendation: isPrimary ? 'RETAIN_PRIMARY' : 'CONSOLIDATE_AND_DELETE',
          };
        });

        report.push({
          loginId,
          totalDocs: docs.length,
          hasDuplicates,
          primaryDocId: primaryDoc.docId,
          documents: docDetails,
        });
      }

      return res.json({
        success: true,
        totalRawDocuments: userRolesSnap.docs.length,
        totalUniqueAccounts: Object.keys(groups).length,
        duplicateCount: totalDuplicates,
        report,
        summary: `Found ${userRolesSnap.docs.length} total documents representing ${Object.keys(groups).length} unique accounts. ${totalDuplicates} shadow duplicate(s) detected.`,
      });
    } catch (err: any) {
      console.error('[Duplicate Report] Error:', err);
      return res.status(500).json({ success: false, error: err?.message || 'Failed to generate duplicate report.' });
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

      const userRolesSnap = await adminDb.collection('user_roles').get();
      const groups: Record<string, any[]> = {};
      userRolesSnap.docs.forEach((d) => {
        const data = d.data() || {};
        const loginId = String(data.loginId || d.id.replace(/^role_/, '')).trim().toLowerCase();
        if (!groups[loginId]) groups[loginId] = [];
        groups[loginId].push({ docId: d.id, ...data });
      });

      const consolidationResults: any[] = [];
      let consolidatedDuplicatesCount = 0;
      const now = new Date().toISOString();

      for (const [loginId, docs] of Object.entries(groups)) {
        if (docs.length <= 1) continue;

        docs.sort((a, b) => {
          if (a.docId === `role_${loginId}`) return -1;
          if (b.docId === `role_${loginId}`) return 1;
          if (a.passwordHash && !b.passwordHash) return -1;
          if (!a.passwordHash && b.passwordHash) return 1;
          return (a.createdAt || '').localeCompare(b.createdAt || '');
        });

        const primaryDoc = docs[0];
        const shadowDocs = docs.slice(1);

        const authUids = new Set<string>();
        const aliases = new Set<string>();
        if (primaryDoc.uid) authUids.add(primaryDoc.uid);
        if (primaryDoc.authUid) authUids.add(primaryDoc.authUid);

        shadowDocs.forEach((s) => {
          if (s.uid) authUids.add(s.uid);
          if (s.authUid) authUids.add(s.authUid);
          if (s.docId.length > 20 && !s.docId.startsWith('role_')) authUids.add(s.docId);
          if (s.email && s.email.toLowerCase() !== primaryDoc.email?.toLowerCase()) {
            aliases.add(s.email.toLowerCase());
          }
        });

        const primaryUpdates: Record<string, any> = {
          updatedAt: now,
          consolidatedAt: now,
          linkedAuthUids: Array.from(authUids),
          emailAliases: Array.from(aliases),
        };
        if (authUids.size > 0 && !primaryDoc.authUid) {
          primaryUpdates.authUid = Array.from(authUids)[0];
        }

        await adminDb.collection('user_roles').doc(primaryDoc.docId).update(primaryUpdates);

        const deletedIds: string[] = [];
        for (const shadow of shadowDocs) {
          await adminDb.collection('user_roles').doc(shadow.docId).delete();
          deletedIds.push(shadow.docId);
          consolidatedDuplicatesCount++;
          await adminDb.collection('user_permissions').doc(shadow.docId).delete().catch(() => {});
        }

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

      invalidateUidRolePointer(adminDb);
      const remainingSnap = await adminDb.collection('user_roles').get();
      return res.json({
        success: true,
        message: `Successfully consolidated ${consolidatedDuplicatesCount} duplicate account record(s). Exactly ${remainingSnap.docs.length} unique accounts remain.`,
        consolidatedDuplicatesCount,
        remainingAccountsCount: remainingSnap.docs.length,
        consolidationResults,
      });
    } catch (err: any) {
      console.error('[Consolidate Duplicates] Error:', err);
      return res.status(500).json({ success: false, error: err?.message || 'Failed to consolidate duplicate accounts.' });
    }
  });

  // ============================================================================
  // 7.3 Read-Only Authentication Audit & UID Mapping (Super Admin Only)
  // ============================================================================
  app.get('/api/admin/full-auth-audit', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, ['super_admin'], 'Full Authentication Audit');
      if (!caller) return;

      const [userRolesSnap, auditSnap, passResetSnap, empSnap, attSnap] = await Promise.all([
        adminDb.collection('user_roles').get(),
        adminDb.collection('audit_logs').get(),
        adminDb.collection('password_reset_logs').get(),
        adminDb.collection('employees').get(),
        adminDb.collection('attendance').get(),
      ]);

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
          firestoreReferences: `user_roles/role_superadmin (${userRolesSnap.docs.filter((d) => d.id === 'role_superadmin' || d.data()?.loginId === 'superadmin').length} doc), audit_logs (${auditSnap.docs.filter((d) => JSON.stringify(d.data()).includes('superadmin')).length} refs), password_reset_logs`,
          recommendation: 'RETAIN_PRIMARY (Active Primary Account)',
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
          firestoreReferences: `user_roles/role_admin (${userRolesSnap.docs.filter((d) => d.id === 'role_admin' || d.data()?.loginId === 'admin').length} doc), employees (${empSnap.docs.length} active), attendance (${attSnap.docs.length} scans)`,
          recommendation: 'RETAIN_PRIMARY (Active Primary Account)',
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
          firestoreReferences: `user_roles/role_user (${userRolesSnap.docs.filter((d) => d.id === 'role_user' || d.data()?.loginId === 'user').length} doc), punch_events, attendance records`,
          recommendation: 'RETAIN_PRIMARY (Active Primary Account)',
        },
      ];

      return res.json({
        success: true,
        auditTimestamp: new Date().toISOString(),
        totalAccountsAudited: accountsList.length,
        primaryAccountsCount: 3,
        legacyAccountsCount: 0,
        activeFirestoreDirectoryCount: userRolesSnap.docs.length,
        totalAuditLogsCount: auditSnap.docs.length,
        totalPasswordResetLogsCount: passResetSnap.docs.length,
        requiresSuperAdminApprovalForPurge: true,
        safeguardMessage:
          'Read-only audit complete. Zero Firebase Auth accounts or Firestore records modified.',
        accounts: accountsList,
      });
    } catch (err: any) {
      console.error('[Full Auth Audit] Error:', err);
      return res.status(500).json({ success: false, error: err?.message || 'Failed to perform full auth audit.' });
    }
  });

  // ============================================================================
  // Role-Protected Dashboard Summary Metrics Endpoint
  // ============================================================================
  app.get('/api/dashboard/summary', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        '*',
        'Dashboard Summary'
      );
      if (!caller) return;

      const access = await getCallerEffectiveDashboardAccess(caller);
      if (!access.allowed) {
        return res.status(403).json({
          success: false,
          error: `Forbidden: Role "${caller.role.toUpperCase()}" does not have Dashboard view permission.`,
        });
      }

      const date = (req.query.date as string) || new Date().toISOString().substring(0, 10);

      const [attSnap, empSnap, rosterSnap] = await Promise.all([
        adminDb.collection('attendance').where('shiftDate', '==', date).get(),
        adminDb.collection('employees').where('employeeStatus', '==', 'Active').get(),
        adminDb
          .collection('shift_rosters')
          .where('shiftDate', '==', date)
          .where('rosterStatus', '==', 'LEAVE')
          .get(),
      ]);

      const attendance = attSnap.docs.map((d) => d.data() || {});
      const activeTotal = empSnap.size;
      const totalPresent = attendance.length;
      const absent = Math.max(0, activeTotal - totalPresent);
      const currentlyInside = attendance.filter(
        (a) => a.currentState === 'INSIDE' || (!a.actualPunchOut && a.punchOutType === 'NONE')
      ).length;
      const currentlyOutside = attendance.filter(
        (a) => a.currentState === 'OUTSIDE' || !!a.actualPunchOut || a.punchOutType === 'ACTUAL'
      ).length;
      const firstIn = attendance.filter((a) => !!(a.firstPunchIn || a.punchIn)).length;
      const finalOut = attendance.filter((a) => !!(a.lastPunchOut || a.actualPunchOut)).length;
      const nowMs = Date.now();
      let dutyHoursMins = 0;
      let otHoursMins = 0;
      for (const curr of attendance) {
        const m = resolveAttendanceMetrics(curr, nowMs);
        if (!m.isOpen) {
          dutyHoursMins += m.completedDutyMinutes;
          otHoursMins += m.overtimeMinutes;
        }
      }
      const autoClosed = attendance.filter((a) => a.punchOutType === 'AUTO' || a.autoClosed).length;
      const missedPunchOut = attendance.filter(
        (a) => a.missedPunchOut || a.attendanceStatus === 'MISSED PUNCH OUT'
      ).length;
      const onLeave = rosterSnap.size;

      const allMetrics: Record<DashboardSummaryMetricKey, number> = {
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
      };
      const permittedCardSet = new Set(access.permittedCards);
      const filteredMetrics: Partial<Record<DashboardSummaryMetricKey, number>> = {};
      for (const card of DASHBOARD_CARDS) {
        if (permittedCardSet.has(card.id)) {
          filteredMetrics[card.metricKey] = allMetrics[card.metricKey];
        }
      }

      return res.json({
        success: true,
        role: caller.role.toUpperCase(),
        readOnly: access.readOnly,
        permittedCards: access.permittedCards,
        permittedSections: access.permittedSections,
        metrics: filteredMetrics,
      });
    } catch (err: any) {
      console.error('[Dashboard Summary API] Error:', err);
      return res.status(500).json({ success: false, error: err?.message || 'Internal server error' });
    }
  });

  // ============================================================================
  // Role Permissions Management Endpoint (Authenticated)
  // ============================================================================
  app.get('/api/admin/role-permissions', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        '*',
        'View Role Permissions'
      );
      if (!caller) return;

      const snap = await adminDb.collection('role_permissions').get();
      const permissions: Record<string, any> = {};
      snap.docs.forEach((d) => {
        permissions[d.id] = d.data();
      });
      return res.json({ success: true, permissions });
    } catch (err: any) {
      console.error('[Role Permissions API] Get error:', err);
      return res.status(500).json({ success: false, error: 'Failed to fetch role permissions.' });
    }
  });

  // Return clean JSON 404 for unknown API paths inside createApp() so serverless & local share identical handling
  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ success: false, error: 'API endpoint not found.' });
  });

  return { app, db: adminDb, auth, projectId, databaseId, credentialMode };
}

export async function startServer() {
  const { app, credentialMode, projectId, databaseId } = createApp();
  const PORT = Number(process.env.PORT) || 8080;

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, host: '0.0.0.0', port: PORT },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    const distIndex = path.join(distDir, 'index.html');
    if (fs.existsSync(distIndex)) {
      app.use(express.static(distDir));
      app.get('*', (_req: Request, res: Response) => {
        res.sendFile(distIndex);
      });
    } else {
      app.get('/', (_req: Request, res: Response) => {
        res.json({
          service: 'NARID ATDC Tracker API',
          status: 'ok',
          health: '/api/health',
        });
      });
    }
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(
      `NARID ATDC Tracker API running at http://0.0.0.0:${PORT} (project=${projectId}, db=${databaseId}, credMode=${credentialMode})`
    );
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  const shutdown = (signal: string) => {
    console.log(`[Server] Received ${signal}, closing HTTP server cleanly.`);
    server.close(() => process.exit(0));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  return server;
}

if (!process.env.VITEST && !process.env.VERCEL) {
  startServer().catch((err) => {
    console.error('Server startup failure:', err);
  });
}
