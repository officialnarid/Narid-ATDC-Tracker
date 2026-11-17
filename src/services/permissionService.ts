import { 
  collection, 
  doc,
  getDocs, 
  onSnapshot 
} from 'firebase/firestore';
import { db } from '../firebase';
import { apiFetchJson } from '../config/api';
import { UserRoleRecord, UserRoleType } from '../types';
import { getAuthHeaders } from './auditService';
import {
  DASHBOARD_CARDS,
  DASHBOARD_SECTIONS,
  DASHBOARD_CARD_PERMISSION_KEYS,
  DASHBOARD_SECTION_PERMISSION_KEYS,
  DASHBOARD_VISIBILITY_KEYS,
  resolveDashboardVisibility,
} from '../config/dashboardCardsConfig';

export {
  DASHBOARD_CARDS,
  DASHBOARD_SECTIONS,
  DASHBOARD_CARD_PERMISSION_KEYS,
  DASHBOARD_SECTION_PERMISSION_KEYS,
  DASHBOARD_VISIBILITY_KEYS,
  resolveDashboardVisibility,
};

export const SYSTEM_ROLE_IDS = new Set(['super_admin', 'admin', 'user']);
export const VALID_ROLE_ID_REGEX = /^[a-z][a-z0-9_]{1,47}$/;

export function normalizeRoleId(role: UserRoleType | string | null | undefined): string {
  const cleaned = String(role ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/^_+|_+$/g, '');
  if (!cleaned) return 'user';
  if (cleaned === 'superadmin' || cleaned === 'super_admin') return 'super_admin';
  if (cleaned === 'admin') return 'admin';
  if (cleaned === 'user') return 'user';
  return VALID_ROLE_ID_REGEX.test(cleaned) ? cleaned : 'user';
}

export function deriveRoleIdFromName(roleName: string): string {
  const cleaned = String(roleName ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/^_+|_+$/g, '');
  if (!cleaned) return '';
  if (cleaned === 'superadmin' || cleaned === 'super_admin') return 'super_admin';
  return VALID_ROLE_ID_REGEX.test(cleaned) ? cleaned : '';
}

export type ModuleAction = 'view' | 'add' | 'edit' | 'delete';

export interface ModulePermission {
  view: boolean;
  add: boolean;
  edit: boolean;
  delete: boolean;
}

export interface RolePermissionRecord {
  roleId: string;
  roleName: string;
  modulePermissions: Record<string, ModulePermission>;
  updatedAt: string;
  updatedBy: string;
}

export interface RoleRecord {
  roleId: string;
  roleName: string;
  description: string;
  defaultPermissions?: Record<string, ModulePermission>;
  isActive: boolean;
  isSystemRole?: boolean;
  createdBy?: string;
  updatedAt: string;
}

export interface UserPermissionRecord {
  id: string;
  userId: string;
  loginId: string;
  role: string;
  permissions: Record<string, ModulePermission>;
  updatedAt: string;
  updatedBy: string;
}

export interface PermissionModuleItem {
  key: string;
  label: string;
  category: string;
  description: string;
  isParent?: boolean;
  parentKey?: string;
  submodule?: boolean;
  isCapability?: boolean;
  isVisibilityOnly?: boolean;
  visibilityGroup?: 'card' | 'section';
}

export const SCANNER_CAPABILITY_KEYS = new Set([
  'attendance.qr.scan',
  'attendance.manual.entry',
]);

export const DASHBOARD_VISIBILITY_MODULES: PermissionModuleItem[] = [
  ...DASHBOARD_CARDS.map((c) => ({
    key: c.permissionKey,
    label: `• Card: ${c.label}`,
    category: 'Dashboard Visibility',
    description: `${c.description} (${c.permissionKey})`,
    submodule: true,
    parentKey: 'dashboard',
    isVisibilityOnly: true,
    visibilityGroup: 'card' as const,
  })),
  ...DASHBOARD_SECTIONS.map((s) => ({
    key: s.permissionKey,
    label: `• Section: ${s.label}`,
    category: 'Dashboard Visibility',
    description: `${s.description} (${s.permissionKey})`,
    submodule: true,
    parentKey: 'dashboard',
    isVisibilityOnly: true,
    visibilityGroup: 'section' as const,
  })),
];

export const PERMISSION_MODULES: PermissionModuleItem[] = [
  {
    key: 'dashboard',
    label: '1. Dashboard',
    category: 'Analytics',
    description: 'Real-time manpower metrics, line attendance, gate tracking',
    isParent: true,
  },
  ...DASHBOARD_VISIBILITY_MODULES,
  {
    key: 'scanner',
    label: '2. Attendance Scanner',
    category: 'Attendance',
    description: 'Continuous QR / barcode punch in and out scanning interface',
    isParent: true,
  },
  {
    key: 'attendance.qr.scan',
    label: '• Allow QR Code Scanning',
    category: 'Attendance',
    description: 'Camera QR scanning, USB QR scanner input, and QR Punch In / Punch Out (attendance.qr.scan)',
    submodule: true,
    parentKey: 'scanner',
    isCapability: true,
  },
  {
    key: 'attendance.manual.entry',
    label: '• Allow Manual Employee ID Entry',
    category: 'Attendance',
    description: 'Manually typing Employee ID, Manual Punch In, and Manual Punch Out (attendance.manual.entry)',
    submodule: true,
    parentKey: 'scanner',
    isCapability: true,
  },
  {
    key: 'employees',
    label: '3. Employee Master',
    category: 'Personnel',
    description: 'Workforce records, personal details, biometric tokens, lines',
  },
  {
    key: 'excel_import',
    label: '4. Excel Import / Update',
    category: 'Personnel',
    description: 'Bulk spreadsheet upload and workforce master data syncing',
  },
  {
    key: 'qr_codes',
    label: '5. QR Code Management',
    category: 'Personnel',
    description: 'Employee ID badge generation, PDF printing, token management',
  },
  {
    key: 'organization',
    label: '6. Organization Management',
    category: 'Master',
    description: 'Factory lines, production sections, and plant departments',
    isParent: true,
  },
  {
    key: 'floors',
    label: '• Line Management',
    category: 'Master',
    description: 'Production line creation, lines, supervisor assignment',
    submodule: true,
    parentKey: 'organization',
  },
  {
    key: 'sections',
    label: '• Section Management',
    category: 'Master',
    description: 'Sub-assembly sections, operational zones, lines link',
    submodule: true,
    parentKey: 'organization',
  },
  {
    key: 'departments',
    label: '• Department Master',
    category: 'Master',
    description: 'Department taxonomy, department codes, heads of department',
    submodule: true,
    parentKey: 'organization',
  },
  {
    key: 'shifts',
    label: '7. Shift Management',
    category: 'Operations',
    description: 'Day/night shift timings, grace periods, auto-closing thresholds',
  },
  {
    key: 'history',
    label: '8. Attendance History',
    category: 'Operations',
    description: 'Daily punch logs, shift audit trail, manual punch adjustments',
  },
  {
    key: 'reports',
    label: '9. Reports & Export',
    category: 'Analytics',
    description: 'Muster roll, overtime logs, absenteeism, Excel data export',
  },
  {
    key: 'user_rights',
    label: '10. User Rights & Auth',
    category: 'Administration',
    description: 'Account directory, login ID creation, passwords, permissions',
  },
  {
    key: 'audit_logs',
    label: '11. Audit Logs & Security',
    category: 'Administration',
    description: 'Enterprise activity logs, login IP/geo history, retention review & cleanup',
  },
  {
    key: 'security_management',
    label: '12. Security & Lockout Control',
    category: 'Administration',
    description: 'Login attempt monitoring, rate limiting, account unblocking & temporary password resets',
  },
  {
    key: 'settings',
    label: '13. System Settings',
    category: 'Administration',
    description: 'Camera parameters, company branding, security retention policies',
  },
];

// Default permissions for Super Admin (Always complete and unrestricted)
const FULL_PERMISSIONS: ModulePermission = { view: true, add: true, edit: true, delete: true };

export const DEFAULT_SUPER_ADMIN_PERMISSIONS: Record<string, ModulePermission> = PERMISSION_MODULES.reduce((acc, m) => {
  acc[m.key] = { ...FULL_PERMISSIONS };
  return acc;
}, {} as Record<string, ModulePermission>);

export const DEFAULT_ADMIN_PERMISSIONS: Record<string, ModulePermission> = {
  dashboard: { view: true, add: false, edit: false, delete: false },
  scanner: { view: true, add: true, edit: false, delete: false },
  'attendance.manual.entry': { view: false, add: false, edit: false, delete: false },
  employees: { view: true, add: true, edit: true, delete: false },
  excel_import: { view: true, add: true, edit: true, delete: false },
  qr_codes: { view: true, add: true, edit: true, delete: false },
  organization: { view: true, add: true, edit: true, delete: false },
  floors: { view: true, add: true, edit: true, delete: false },
  sections: { view: true, add: true, edit: true, delete: false },
  departments: { view: true, add: true, edit: true, delete: false },
  shifts: { view: true, add: true, edit: true, delete: false },
  history: { view: true, add: false, edit: true, delete: false },
  reports: { view: true, add: false, edit: false, delete: false },
  user_rights: { view: false, add: false, edit: false, delete: false },
  audit_logs: { view: false, add: false, edit: false, delete: false },
  security_management: { view: false, add: false, edit: false, delete: false },
  settings: { view: false, add: false, edit: false, delete: false },
};

export const EMPTY_MODULE_PERMISSIONS: Record<string, ModulePermission> = PERMISSION_MODULES.reduce((acc, m) => {
  acc[m.key] = { view: false, add: false, edit: false, delete: false };
  return acc;
}, {} as Record<string, ModulePermission>);

export const DEFAULT_USER_PERMISSIONS: Record<string, ModulePermission> = {
  dashboard: { view: true, add: false, edit: false, delete: false },
  scanner: { view: true, add: true, edit: false, delete: false },
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
};

/**
 * Role permissions are seeded server-side via Firebase Admin SDK.
 * Retained as a safe read-only helper for component compatibility.
 */
export async function seedInitialRolePermissions(): Promise<void> {
  await getAllRolePermissions();
}

/**
 * Fetch role permissions for all roles
 */
export async function getAllRolePermissions(): Promise<Record<string, RolePermissionRecord>> {
  try {
    const snap = await getDocs(collection(db, 'role_permissions'));
    const result: Record<string, RolePermissionRecord> = {};

    snap.docs.forEach(d => {
      const data = d.data() as RolePermissionRecord;
      result[data.roleId] = {
        ...data,
        roleId: d.id as any,
      };
    });

    // Fallbacks if not seeded
    if (!result['super_admin']) {
      result['super_admin'] = {
        roleId: 'super_admin',
        roleName: 'Super Admin',
        modulePermissions: DEFAULT_SUPER_ADMIN_PERMISSIONS,
        updatedAt: new Date().toISOString(),
        updatedBy: 'system',
      };
    }
    if (!result['admin']) {
      result['admin'] = {
        roleId: 'admin',
        roleName: 'Admin',
        modulePermissions: DEFAULT_ADMIN_PERMISSIONS,
        updatedAt: new Date().toISOString(),
        updatedBy: 'system',
      };
    }
    if (!result['user']) {
      result['user'] = {
        roleId: 'user',
        roleName: 'User',
        modulePermissions: DEFAULT_USER_PERMISSIONS,
        updatedAt: new Date().toISOString(),
        updatedBy: 'system',
      };
    }

    return result;
  } catch (err) {
    console.error('[PermissionService] Failed to load role permissions:', err);
    return {
      super_admin: { roleId: 'super_admin', roleName: 'Super Admin', modulePermissions: DEFAULT_SUPER_ADMIN_PERMISSIONS, updatedAt: '', updatedBy: '' },
      admin: { roleId: 'admin', roleName: 'Admin', modulePermissions: DEFAULT_ADMIN_PERMISSIONS, updatedAt: '', updatedBy: '' },
      user: { roleId: 'user', roleName: 'User', modulePermissions: DEFAULT_USER_PERMISSIONS, updatedAt: '', updatedBy: '' },
    };
  }
}

/**
 * Real-time listener for role permissions
 */
export function subscribeToAllRolePermissions(
  callback: (permissions: Record<string, RolePermissionRecord>) => void
): () => void {
  const colRef = collection(db, 'role_permissions');
  return onSnapshot(colRef, (snap) => {
    const result: Record<string, RolePermissionRecord> = {};
    snap.docs.forEach(d => {
      const data = d.data() as RolePermissionRecord;
      result[d.id] = data;
    });

    // Fill missing defaults
    if (!result['super_admin']) {
      result['super_admin'] = {
        roleId: 'super_admin',
        roleName: 'Super Admin',
        modulePermissions: DEFAULT_SUPER_ADMIN_PERMISSIONS,
        updatedAt: new Date().toISOString(),
        updatedBy: 'system',
      };
    }
    if (!result['admin']) {
      result['admin'] = {
        roleId: 'admin',
        roleName: 'Admin',
        modulePermissions: DEFAULT_ADMIN_PERMISSIONS,
        updatedAt: new Date().toISOString(),
        updatedBy: 'system',
      };
    }
    if (!result['user']) {
      result['user'] = {
        roleId: 'user',
        roleName: 'User',
        modulePermissions: DEFAULT_USER_PERMISSIONS,
        updatedAt: new Date().toISOString(),
        updatedBy: 'system',
      };
    }

    callback(result);
  }, (err) => {
    console.warn('[PermissionService] Real-time role permissions subscription notice:', err);
  });
}

/**
 * Super Admin saves configured permissions for any non-super_admin role (system or custom)
 */
export async function saveRolePermissions(
  callerLoginId: string,
  targetRoleId: string,
  modulePermissions: Record<string, ModulePermission>
): Promise<void> {
  const normalizedTarget = normalizeRoleId(targetRoleId);
  const headers = await getAuthHeaders();
  await apiFetchJson(
    '/api/admin/role-permissions',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        callerLoginId,
        roleId: normalizedTarget,
        modulePermissions,
      }),
    },
    'Failed to update role permissions.'
  );
}

/**
 * Super Admin creates or updates a role definition (system or future custom role)
 */
export async function saveRoleDefinition(payload: {
  roleId?: string;
  roleName: string;
  description: string;
  isActive: boolean;
  defaultPermissions?: Record<string, ModulePermission>;
}): Promise<{ success: boolean; created: boolean; role: RoleRecord }> {
  const headers = await getAuthHeaders();
  return apiFetchJson<{ success: boolean; created: boolean; role: RoleRecord }>(
    '/api/admin/roles',
    {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    },
    'Failed to save role definition.'
  );
}

/**
 * Super Admin deletes an unused custom role
 */
export async function deleteCustomRole(roleId: string): Promise<void> {
  const headers = await getAuthHeaders();
  await apiFetchJson(
    `/api/admin/roles/${encodeURIComponent(roleId)}`,
    {
      method: 'DELETE',
      headers,
    },
    'Failed to delete custom role.'
  );
}

/**
 * Check if a role has a specific permission on a module
 * Super Admin ALWAYS returns true. Custom roles fail closed unless granted.
 */
export function hasModulePermission(
  role: UserRoleType | string | null | undefined,
  moduleKey: string,
  action: ModuleAction,
  activePermissions?: Record<string, RolePermissionRecord> | null
): boolean {
  if (!role) return false;
  const roleKey = normalizeRoleId(role);

  // Super Admin permissions must always remain complete and unrestricted
  if (roleKey === 'super_admin') {
    return true;
  }

  // Restricted administrative modules are never allowed for non-Super Admin roles
  if (moduleKey === 'user_rights' || moduleKey === 'audit_logs' || moduleKey === 'security_management') {
    return false;
  }

  // Check from live permissions store first (works for both system and custom roles)
  if (activePermissions && activePermissions[roleKey]) {
    const perms = activePermissions[roleKey].modulePermissions;
    if (perms && perms[moduleKey]) {
      return !!perms[moduleKey][action];
    }
  }

  // Fallback to static defaults ONLY for built-in system roles
  if (roleKey === 'admin') {
    return !!DEFAULT_ADMIN_PERMISSIONS[moduleKey]?.[action];
  }
  if (roleKey === 'user') {
    return !!DEFAULT_USER_PERMISSIONS[moduleKey]?.[action];
  }

  return false;
}

/**
 * Real-time listener for roles collection (built-in system roles + future custom roles)
 */
export function subscribeToRoles(
  callback: (roles: RoleRecord[]) => void
): () => void {
  const colRef = collection(db, 'roles');
  return onSnapshot(colRef, (snap) => {
    const list: RoleRecord[] = snap.docs.map(d => {
      const data = d.data() as RoleRecord;
      const roleId = normalizeRoleId(data.roleId || d.id);
      return {
        ...data,
        roleId,
        roleName: data.roleName || roleId.toUpperCase(),
        isActive: data.isActive !== false,
        isSystemRole: SYSTEM_ROLE_IDS.has(roleId),
      };
    });

    // Ensure all 3 built-in system roles are always present without auto-seeding custom roles
    const order: Record<string, number> = { super_admin: 0, admin: 1, user: 2 };
    const defaultDescriptions: Record<string, string> = {
      super_admin: 'Complete access to all application modules, account management, role permissions, system settings and administrative controls.',
      admin: 'Operational dashboard, attendance management, employee records, reports and other specifically authorized modules.',
      user: 'Read-only Dashboard monitoring and Attendance Scanner access, according to assigned permissions.',
    };

    const rolesMap = new Map<string, RoleRecord>();
    list.forEach(r => rolesMap.set(r.roleId, r));

    (['super_admin', 'admin', 'user'] as const).forEach(roleId => {
      if (!rolesMap.has(roleId)) {
        rolesMap.set(roleId, {
          roleId,
          roleName: roleId.toUpperCase(),
          description: defaultDescriptions[roleId],
          isActive: true,
          isSystemRole: true,
          updatedAt: new Date().toISOString(),
          defaultPermissions: roleId === 'super_admin' ? DEFAULT_SUPER_ADMIN_PERMISSIONS :
                              roleId === 'admin' ? DEFAULT_ADMIN_PERMISSIONS : DEFAULT_USER_PERMISSIONS,
        });
      }
    });

    const finalList = Array.from(rolesMap.values());
    finalList.sort((a, b) => {
      const pA = order[a.roleId] ?? 10;
      const pB = order[b.roleId] ?? 10;
      if (pA !== pB) return pA - pB;
      return String(a.roleName || a.roleId).localeCompare(String(b.roleName || b.roleId));
    });
    callback(finalList);
  }, (err) => {
    console.warn('[PermissionService] Roles subscription notice:', err);
  });
}

/**
 * Real-time listener for individual user permission overrides
 */
export function subscribeToUserPermissions(
  callback: (permsMap: Record<string, UserPermissionRecord>) => void
): () => void {
  const colRef = collection(db, 'user_permissions');
  return onSnapshot(colRef, (snap) => {
    const map: Record<string, UserPermissionRecord> = {};
    snap.docs.forEach(d => {
      map[d.id] = { ...(d.data() as UserPermissionRecord), id: d.id };
    });
    callback(map);
  }, (err) => {
    console.warn('[PermissionService] User permissions subscription notice:', err);
  });
}

/**
 * Super Admin saves customized individual permissions for an account
 */
export async function saveUserIndividualPermissions(
  callerLoginId: string,
  targetUserId: string,
  permissions: Record<string, ModulePermission>,
  modulesAllowed: string[],
  role?: UserRoleType,
  status?: 'Active' | 'Inactive'
): Promise<void> {
  const headers = await getAuthHeaders();
  await apiFetchJson(
    '/api/admin/set-user-permissions',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        callerLoginId,
        targetId: targetUserId,
        permissions,
        modulesAllowed,
        role,
        status,
      }),
    },
    'Failed to update user permissions.'
  );
}

export interface UserPermissionRecordWithOverride extends UserPermissionRecord {
  isCustomOverride?: boolean;
}

/**
 * Subscribe to the signed-in caller's own individual user_permissions/{profileDocId} document
 * (Permitted by Firestore Rules via isOwnerByUidIndex without requiring list access).
 */
export function subscribeToCurrentUserPermission(
  profileDocId: string | null | undefined,
  callback: (record: UserPermissionRecordWithOverride | null) => void
): () => void {
  const cleanId = String(profileDocId || '').trim();
  if (!cleanId) {
    callback(null);
    return () => {};
  }
  const docRef = doc(db, 'user_permissions', cleanId);
  return onSnapshot(
    docRef,
    (snap) => {
      if (!snap.exists()) {
        callback(null);
        return;
      }
      callback({
        ...(snap.data() as UserPermissionRecordWithOverride),
        id: snap.id,
      });
    },
    (err) => {
      console.warn('[PermissionService] Current user permission subscription notice:', err);
      callback(null);
    }
  );
}

export function isScannerCapabilityEntryEnabled(entry: Partial<ModulePermission> | null | undefined): boolean {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.view === false) return false;
  if (typeof entry.add === 'boolean') {
    return entry.add === true;
  }
  return entry.view === true;
}

export interface ResolvedScannerCapabilities {
  canViewScanner: boolean;
  canQrScan: boolean;
  canManualEntry: boolean;
  qrConfiguredExplicitly: boolean;
  manualConfiguredExplicitly: boolean;
}

/**
 * Resolves independent attendance.qr.scan and attendance.manual.entry capabilities
 * mirroring the backend guard precedence:
 * 1. Super Admin -> all enabled
 * 2. user_permissions override (when isCustomOverride !== false)
 * 3. role_permissions[role]
 * 4. Fallback: QR falls back to legacy scanner access; Manual stays strictly denied by default
 */
export function resolveScannerCapabilities(params: {
  profile?: UserRoleRecord | null;
  rolePermissions?: Record<string, RolePermissionRecord> | null;
  userPermissionOverride?: UserPermissionRecordWithOverride | null;
}): ResolvedScannerCapabilities {
  const { profile, rolePermissions, userPermissionOverride } = params;
  if (!profile) {
    return {
      canViewScanner: false,
      canQrScan: false,
      canManualEntry: false,
      qrConfiguredExplicitly: false,
      manualConfiguredExplicitly: false,
    };
  }

  const roleKey = normalizeRoleId(profile.role);
  if (roleKey === 'super_admin') {
    return {
      canViewScanner: true,
      canQrScan: true,
      canManualEntry: true,
      qrConfiguredExplicitly: true,
      manualConfiguredExplicitly: true,
    };
  }

  const hasCustomOverride =
    Boolean(userPermissionOverride) && userPermissionOverride?.isCustomOverride !== false;
  const userPerms = hasCustomOverride ? userPermissionOverride?.permissions || {} : {};
  const roleModPerms = rolePermissions?.[roleKey]?.modulePermissions || {};

  // Evaluate attendance.qr.scan
  let canQrScan: boolean;
  let qrConfiguredExplicitly = false;

  const userQrEntry = userPerms['attendance.qr.scan'];
  const roleQrEntry = roleModPerms['attendance.qr.scan'];

  if (
    userQrEntry &&
    typeof userQrEntry === 'object' &&
    (typeof userQrEntry.view === 'boolean' || typeof userQrEntry.add === 'boolean')
  ) {
    canQrScan = isScannerCapabilityEntryEnabled(userQrEntry);
    qrConfiguredExplicitly = true;
  } else if (hasCustomOverride && userPerms.scanner && typeof userPerms.scanner === 'object') {
    canQrScan = isScannerCapabilityEntryEnabled(userPerms.scanner);
  } else if (
    roleQrEntry &&
    typeof roleQrEntry === 'object' &&
    (typeof roleQrEntry.view === 'boolean' || typeof roleQrEntry.add === 'boolean')
  ) {
    canQrScan = isScannerCapabilityEntryEnabled(roleQrEntry);
    qrConfiguredExplicitly = true;
  } else if (roleModPerms.scanner && typeof roleModPerms.scanner === 'object') {
    canQrScan = isScannerCapabilityEntryEnabled(roleModPerms.scanner);
  } else if (Array.isArray(profile.modulesAllowed)) {
    canQrScan = profile.modulesAllowed.includes('all') || profile.modulesAllowed.includes('scanner');
  } else {
    canQrScan = roleKey === 'admin' || roleKey === 'user';
  }

  // Evaluate attendance.manual.entry (strict deny-by-default)
  let canManualEntry = false;
  let manualConfiguredExplicitly = false;

  const userManualEntry = userPerms['attendance.manual.entry'];
  const roleManualEntry = roleModPerms['attendance.manual.entry'];

  if (
    userManualEntry &&
    typeof userManualEntry === 'object' &&
    (typeof userManualEntry.view === 'boolean' || typeof userManualEntry.add === 'boolean')
  ) {
    canManualEntry = isScannerCapabilityEntryEnabled(userManualEntry);
    manualConfiguredExplicitly = true;
  } else if (hasCustomOverride && userPerms.scanner?.view === false) {
    canManualEntry = false;
  } else if (
    roleManualEntry &&
    typeof roleManualEntry === 'object' &&
    (typeof roleManualEntry.view === 'boolean' || typeof roleManualEntry.add === 'boolean')
  ) {
    canManualEntry = isScannerCapabilityEntryEnabled(roleManualEntry);
    manualConfiguredExplicitly = true;
  }

  const canViewScanner =
    canQrScan ||
    canManualEntry ||
    Boolean(userPerms.scanner?.view) ||
    Boolean(roleModPerms.scanner?.view) ||
    (Array.isArray(profile.modulesAllowed)
      ? profile.modulesAllowed.includes('all') || profile.modulesAllowed.includes('scanner')
      : roleKey === 'admin' || roleKey === 'user');

  return {
    canViewScanner,
    canQrScan,
    canManualEntry,
    qrConfiguredExplicitly,
    manualConfiguredExplicitly,
  };
}

/**
 * Evaluate effective permissions for a user
 * Individual permissions override role defaults only where explicitly configured.
 */
export function getEffectiveModulePermissions(
  role: string,
  userPermissionOverride?: UserPermissionRecord | null,
  rolePermissionDefault?: RolePermissionRecord | null
): Record<string, ModulePermission> {
  const cleanRole = normalizeRoleId(role);
  if (cleanRole === 'super_admin') {
    return DEFAULT_SUPER_ADMIN_PERMISSIONS;
  }

  const roleDefaults = rolePermissionDefault?.modulePermissions ||
    (cleanRole === 'admin'
      ? DEFAULT_ADMIN_PERMISSIONS
      : cleanRole === 'user'
        ? DEFAULT_USER_PERMISSIONS
        : EMPTY_MODULE_PERMISSIONS);

  if (!userPermissionOverride?.permissions) {
    return roleDefaults;
  }

  const effective: Record<string, ModulePermission> = { ...roleDefaults };
  for (const [modKey, overridePerm] of Object.entries(userPermissionOverride.permissions)) {
    effective[modKey] = {
      view: overridePerm.view !== undefined ? overridePerm.view : (roleDefaults[modKey]?.view ?? false),
      add: overridePerm.add !== undefined ? overridePerm.add : (roleDefaults[modKey]?.add ?? false),
      edit: overridePerm.edit !== undefined ? overridePerm.edit : (roleDefaults[modKey]?.edit ?? false),
      delete: overridePerm.delete !== undefined ? overridePerm.delete : (roleDefaults[modKey]?.delete ?? false),
    };
  }

  return effective;
}
