import { 
  collection, 
  getDocs, 
  onSnapshot 
} from 'firebase/firestore';
import { db } from '../firebase';
import { apiFetchJson } from '../config/api';
import { UserRoleRecord, UserRoleType } from '../types';
import { getAuthHeaders } from './auditService';

export type ModuleAction = 'view' | 'add' | 'edit' | 'delete';

export interface ModulePermission {
  view: boolean;
  add: boolean;
  edit: boolean;
  delete: boolean;
}

export interface RolePermissionRecord {
  roleId: 'super_admin' | 'admin' | 'user';
  roleName: string;
  modulePermissions: Record<string, ModulePermission>;
  updatedAt: string;
  updatedBy: string;
}

export interface RoleRecord {
  roleId: 'super_admin' | 'admin' | 'user';
  roleName: 'SUPER_ADMIN' | 'ADMIN' | 'USER';
  description: string;
  defaultPermissions?: Record<string, ModulePermission>;
  isActive: boolean;
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
}

export const PERMISSION_MODULES: PermissionModuleItem[] = [
  {
    key: 'dashboard',
    label: '1. Dashboard',
    category: 'Analytics',
    description: 'Real-time manpower metrics, line attendance, gate tracking',
  },
  {
    key: 'scanner',
    label: '2. Attendance Scanner',
    category: 'Attendance',
    description: 'Continuous QR / barcode punch in and out scanning interface',
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

export const DEFAULT_USER_PERMISSIONS: Record<string, ModulePermission> = {
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
 * Super Admin saves configured permissions for Admin or User
 */
export async function saveRolePermissions(
  callerLoginId: string,
  targetRoleId: 'admin' | 'user',
  modulePermissions: Record<string, ModulePermission>
): Promise<void> {
  const headers = await getAuthHeaders();
  await apiFetchJson(
    '/api/admin/role-permissions',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        callerLoginId,
        roleId: targetRoleId,
        modulePermissions,
      }),
    },
    'Failed to update role permissions.'
  );
}

/**
 * Check if a role has a specific permission on a module
 * Super Admin ALWAYS returns true.
 */
export function hasModulePermission(
  role: UserRoleType | string | null | undefined,
  moduleKey: string,
  action: ModuleAction,
  activePermissions?: Record<string, RolePermissionRecord> | null
): boolean {
  if (!role) return false;
  const cleanRole = String(role).trim().toLowerCase();

  // Super Admin permissions must always remain complete and unrestricted
  if (cleanRole === 'super_admin' || cleanRole === 'superadmin') {
    return true;
  }

  const roleKey = cleanRole === 'admin' ? 'admin' : 'user';

  // Check from live permissions store
  if (activePermissions && activePermissions[roleKey]) {
    const perms = activePermissions[roleKey].modulePermissions;
    if (perms && perms[moduleKey]) {
      return !!perms[moduleKey][action];
    }
  }

  // Fallback to static defaults
  if (roleKey === 'admin') {
    return !!DEFAULT_ADMIN_PERMISSIONS[moduleKey]?.[action];
  }

  return !!DEFAULT_USER_PERMISSIONS[moduleKey]?.[action];
}

/**
 * Real-time listener for roles collection (Predefined roles)
 */
export function subscribeToRoles(
  callback: (roles: RoleRecord[]) => void
): () => void {
  const colRef = collection(db, 'roles');
  return onSnapshot(colRef, (snap) => {
    const list: RoleRecord[] = snap.docs.map(d => ({
      ...(d.data() as RoleRecord),
      roleId: d.id as any,
    }));

    // Ensure all 3 predefined roles are present
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
          roleName: roleId.toUpperCase() as any,
          description: defaultDescriptions[roleId],
          isActive: true,
          updatedAt: new Date().toISOString(),
          defaultPermissions: roleId === 'super_admin' ? DEFAULT_SUPER_ADMIN_PERMISSIONS :
                              roleId === 'admin' ? DEFAULT_ADMIN_PERMISSIONS : DEFAULT_USER_PERMISSIONS,
        });
      }
    });

    const finalList = Array.from(rolesMap.values());
    finalList.sort((a, b) => (order[a.roleId] ?? 9) - (order[b.roleId] ?? 9));
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

/**
 * Evaluate effective permissions for a user
 * Individual permissions override role defaults only where explicitly configured.
 */
export function getEffectiveModulePermissions(
  role: string,
  userPermissionOverride?: UserPermissionRecord | null,
  rolePermissionDefault?: RolePermissionRecord | null
): Record<string, ModulePermission> {
  const cleanRole = (role || 'user').toLowerCase();
  if (cleanRole === 'super_admin' || cleanRole === 'superadmin') {
    return DEFAULT_SUPER_ADMIN_PERMISSIONS;
  }

  const roleDefaults = rolePermissionDefault?.modulePermissions || 
    (cleanRole === 'admin' ? DEFAULT_ADMIN_PERMISSIONS : DEFAULT_USER_PERMISSIONS);

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
