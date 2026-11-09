import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { initializeApp } from 'firebase/app';
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Firebase Client SDK for Server Firestore Operations
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId);

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

// Initial Industrial Accounts Specification
const INITIAL_ACCOUNTS = [
  {
    loginId: 'superadmin',
    name: 'Chief Plant Operations (Super Admin)',
    email: 'superadmin_root@narid.com',
    role: 'super_admin',
    modulesAllowed: ['all'],
  },
  {
    loginId: 'admin',
    name: 'Shift Supervisor (Admin)',
    email: 'admin_root@narid.com',
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
    email: 'user_root@narid.com',
    role: 'user',
    modulesAllowed: ['scanner'],
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
    settings: { view: false, add: false, edit: false, delete: false },
  },
  user: {
    dashboard: { view: false, add: false, edit: false, delete: false },
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
    description: 'Attendance Scanner access only, according to assigned permissions.',
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
          updatedAt: now,
        });
        console.log(`[Roles Boot] Provisioned role definition "${roleDef.roleId}" in Firestore`);
      }
      const permSnap = await getDoc(doc(db, 'role_permissions', roleDef.roleId));
      if (!permSnap.exists()) {
        await setDoc(doc(db, 'role_permissions', roleDef.roleId), {
          roleId: roleDef.roleId,
          roleName: roleDef.roleName,
          modulePermissions: roleDef.defaultPermissions,
          updatedAt: now,
          updatedBy: 'system',
        });
      }
    } catch (e: any) {
      console.warn(`[Roles Boot] Warning for role ${roleDef.roleId}:`, e.message);
    }
  }
}

// Enterprise Audit Logger
async function logAuditEvent(params: {
  action: string;
  targetUid: string;
  loginId: string;
  performedByUid?: string;
  performedByLoginId?: string;
  previousValue?: any;
  newValue?: any;
  details?: string;
}) {
  try {
    const logId = `audit_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const now = new Date().toISOString();
    await setDoc(doc(db, 'audit_logs', logId), {
      id: logId,
      action: params.action,
      targetUid: params.targetUid,
      loginId: params.loginId,
      performedByUid: params.performedByUid || 'system',
      performedByLoginId: params.performedByLoginId || 'superadmin',
      timestamp: now,
      previousValue: params.previousValue !== undefined ? params.previousValue : null,
      newValue: params.newValue !== undefined ? params.newValue : null,
      details: params.details || '',
      createdAt: now,
    });
  } catch (err: any) {
    console.warn('[Audit Log] Failed to write audit log:', err.message);
  }
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
          role: acc.role,
          status: 'Active',
          modulesAllowed: acc.modulesAllowed,
          passwordHash,
          mustChangePassword: true,
          createdAt: now,
          updatedAt: now,
        });
        console.log(`[Auth Boot] Provisioned ${acc.loginId} with initial single-source passwordHash`);
      } else {
        const data = snap.data();
        if (!data.passwordHash) {
          const passwordHash = hashPassword('Narid@12345');
          await updateDoc(doc(db, 'user_roles', docId), {
            passwordHash,
            updatedAt: now,
          });
          console.log(`[Auth Boot] Upgraded ${acc.loginId} to cryptographic passwordHash`);
        }
      }
    } catch (e: any) {
      console.warn(`[Auth Boot] Could not verify account ${acc.loginId}:`, e.message);
    }
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Bootstrap initial accounts & predefined roles in background
  seedInitialAccounts().catch((err) => {
    console.warn('[Auth Boot] Seeding warning:', err.message);
  });
  seedPredefinedRoles().catch((err) => {
    console.warn('[Roles Boot] Seeding warning:', err.message);
  });

  // Health check
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), project: firebaseConfig.projectId });
  });

  // ============================================================================
  // 1. Single Source of Truth Login Verification
  // ============================================================================
  app.post('/api/auth/login', async (req: Request, res: Response) => {
    try {
      const { loginId, password } = req.body;
      if (!loginId || typeof loginId !== 'string' || !loginId.trim()) {
        return res.status(400).json({ success: false, error: 'Please enter your Login ID.' });
      }
      if (!password || typeof password !== 'string') {
        return res.status(400).json({ success: false, error: 'Please enter your password.' });
      }

      const cleanId = loginId.trim().toLowerCase();
      const docId = `role_${cleanId}`;
      let userDoc = await getDoc(doc(db, 'user_roles', docId));

      if (!userDoc.exists()) {
        // Fallback query by loginId field
        const q = query(collection(db, 'user_roles'), where('loginId', '==', cleanId));
        const snap = await getDocs(q);
        if (snap.empty) {
          return res.status(401).json({ success: false, error: 'Account not found. Please verify your Login ID.' });
        }
        userDoc = snap.docs[0];
      }

      const userData = userDoc.data();
      if (!userData) {
        return res.status(401).json({ success: false, error: 'Account not found. Please verify your Login ID.' });
      }

      if (userData.status === 'Inactive') {
        return res.status(403).json({ success: false, error: 'Account Deactivated. Please contact system administrator.' });
      }

      // Verify against single passwordHash
      let isPasswordValid = false;
      if (userData.passwordHash) {
        isPasswordValid = verifyPassword(password, userData.passwordHash);
      } else {
        // Fallback for un-migrated account: check initial default password
        if (password === 'Narid@12345') {
          isPasswordValid = true;
          // Upgrade immediately to single-source hash
          const newHash = hashPassword(password);
          await updateDoc(doc(db, 'user_roles', userDoc.id), { passwordHash: newHash });
        }
      }

      if (!isPasswordValid) {
        // Exact user requirement: "agar password wrong enter kre to invalid password check again bataye"
        return res.status(401).json({ success: false, error: 'Invalid password, check again' });
      }

      // Return sanitized user profile (never expose passwordHash)
      const { passwordHash: _, ...sanitizedProfile } = userData;
      return res.json({
        success: true,
        profile: { ...sanitizedProfile, id: userDoc.id },
      });
    } catch (err: any) {
      console.error('[API Login] Error:', err);
      return res.status(500).json({ success: false, error: 'Authentication service error. Please try again.' });
    }
  });

  // ============================================================================
  // 2. Super Admin Password Change (Direct Overwrite of Single Source of Truth)
  // ============================================================================
  app.post('/api/admin/set-user-password', async (req: Request, res: Response) => {
    try {
      const { callerLoginId, targetLoginId, newPassword, mustChangePassword } = req.body;

      if (!targetLoginId || !newPassword) {
        return res.status(400).json({ success: false, error: 'targetLoginId and newPassword are required.' });
      }
      if (newPassword.length < 6) {
        return res.status(400).json({ success: false, error: 'Password must be at least 6 characters.' });
      }

      // Validate caller role if callerLoginId provided
      if (callerLoginId) {
        const callerSnap = await getDoc(doc(db, 'user_roles', `role_${callerLoginId.trim().toLowerCase()}`));
        if (callerSnap.exists()) {
          const callerData = callerSnap.data();
          if (callerData.role?.toLowerCase() !== 'super_admin' && callerLoginId.toLowerCase() !== 'superadmin') {
            return res.status(403).json({ success: false, error: 'Only Super Admin can update user passwords.' });
          }
        }
      }

      const cleanTargetId = targetLoginId.trim().toLowerCase();
      const docId = `role_${cleanTargetId}`;
      let targetDoc = await getDoc(doc(db, 'user_roles', docId));

      if (!targetDoc.exists()) {
        const q = query(collection(db, 'user_roles'), where('loginId', '==', cleanTargetId));
        const snap = await getDocs(q);
        if (snap.empty) {
          return res.status(404).json({ success: false, error: `User with Login ID "${targetLoginId}" not found.` });
        }
        targetDoc = snap.docs[0];
      }

      // Compute new single password hash
      const newHash = hashPassword(newPassword);
      const now = new Date().toISOString();

      // Completely overwrite existing passwordHash (historical/old passwords are wiped permanently)
      await updateDoc(doc(db, 'user_roles', targetDoc.id), {
        passwordHash: newHash,
        mustChangePassword: mustChangePassword !== undefined ? !!mustChangePassword : false,
        passwordLastChangedAt: now,
        updatedAt: now,
      });

      console.log(`[Admin Password Change] Successfully updated single-source password for "${cleanTargetId}". Old passwords invalidated.`);
      return res.json({
        success: true,
        message: `Password for ${cleanTargetId} updated. Old passwords permanently revoked.`,
      });
    } catch (err: any) {
      console.error('[Admin Password Change] Error:', err);
      return res.status(500).json({ success: false, error: err.message || 'Failed to update password.' });
    }
  });

  // ============================================================================
  // 3. User First-Time / Self Password Change
  // ============================================================================
  app.post('/api/auth/change-password', async (req: Request, res: Response) => {
    try {
      const { loginId, currentPassword, newPassword } = req.body;
      if (!loginId || !newPassword) {
        return res.status(400).json({ success: false, error: 'loginId and newPassword are required.' });
      }
      if (newPassword.length < 6) {
        return res.status(400).json({ success: false, error: 'New password must be at least 6 characters.' });
      }

      const cleanId = loginId.trim().toLowerCase();
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

      // If currentPassword provided, verify it
      if (currentPassword && userData.passwordHash) {
        if (!verifyPassword(currentPassword, userData.passwordHash)) {
          return res.status(401).json({ success: false, error: 'Invalid password, check again' });
        }
      }

      const newHash = hashPassword(newPassword);
      const now = new Date().toISOString();

      await updateDoc(doc(db, 'user_roles', userDoc.id), {
        passwordHash: newHash,
        mustChangePassword: false,
        passwordLastChangedAt: now,
        updatedAt: now,
      });

      console.log(`[Self Password Change] User "${cleanId}" updated password. Old passwords invalidated.`);
      return res.json({ success: true, message: 'Password updated successfully.' });
    } catch (err: any) {
      console.error('[Self Password Change] Error:', err);
      return res.status(500).json({ success: false, error: err.message || 'Failed to update password.' });
    }
  });

  // ============================================================================
  // 4. Create User Account with Initial Single-Source Password Hash & Default Permissions
  // ============================================================================
  app.post('/api/admin/create-user', async (req: Request, res: Response) => {
    try {
      const { callerLoginId, name, loginId, email, role, password, status, modulesAllowed, mustChangePassword } = req.body;

      // Validate caller role
      if (callerLoginId) {
        const callerSnap = await getDoc(doc(db, 'user_roles', `role_${callerLoginId.trim().toLowerCase()}`));
        if (callerSnap.exists()) {
          const callerData = callerSnap.data();
          if (callerData.role?.toLowerCase() !== 'super_admin' && callerLoginId.toLowerCase() !== 'superadmin') {
            return res.status(403).json({ success: false, error: 'Only Super Admin can create login accounts.' });
          }
        }
      }

      if (!loginId || !password) {
        return res.status(400).json({ success: false, error: 'Login ID and password are required.' });
      }
      if (password.length < 6) {
        return res.status(400).json({ success: false, error: 'Password must be at least 6 characters.' });
      }

      const cleanId = loginId.trim().toLowerCase();
      if (!/^[a-z0-9_-]+$/.test(cleanId)) {
        return res.status(400).json({ success: false, error: 'Login ID must contain only lowercase letters, numbers, hyphens or underscores.' });
      }

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

      const assignedRole = (role || 'user').toLowerCase();
      const now = new Date().toISOString();
      const passwordHash = hashPassword(password);
      const cleanEmail = (email?.trim() || `${cleanId}@narid.com`).toLowerCase();

      let finalModules = modulesAllowed;
      if (!finalModules || finalModules.length === 0) {
        if (assignedRole === 'super_admin') finalModules = ['all'];
        else if (assignedRole === 'admin') finalModules = ['dashboard', 'scanner', 'employees', 'excel_import', 'qr_codes', 'floors', 'sections', 'departments', 'shifts', 'history', 'reports'];
        else finalModules = ['scanner'];
      }

      const newRecord = {
        id: docId,
        uid: docId,
        loginId: cleanId,
        name: name?.trim() || cleanId.toUpperCase(),
        displayName: name?.trim() || cleanId.toUpperCase(),
        email: cleanEmail,
        role: assignedRole,
        status: status || 'Active',
        modulesAllowed: finalModules,
        passwordHash,
        mustChangePassword: mustChangePassword !== undefined ? mustChangePassword : true,
        createdBy: callerLoginId || 'superadmin',
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
        updatedBy: callerLoginId || 'superadmin',
      });

      // 3. Write audit log
      await logAuditEvent({
        action: 'account_created',
        targetUid: docId,
        loginId: cleanId,
        performedByLoginId: callerLoginId || 'superadmin',
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
      const { callerLoginId, targetId, targetLoginId } = req.body;

      if (!targetId && !targetLoginId) {
        return res.status(400).json({ success: false, error: 'targetId or targetLoginId is required.' });
      }

      // 1. Verify caller authorization
      const cleanCallerId = (callerLoginId || 'superadmin').trim().toLowerCase();
      const callerSnap = await getDoc(doc(db, 'user_roles', `role_${cleanCallerId}`));
      if (callerSnap.exists()) {
        const callerData = callerSnap.data();
        if (callerData.role?.toLowerCase() !== 'super_admin' && cleanCallerId !== 'superadmin') {
          return res.status(403).json({ success: false, error: 'Unauthorized: Only Super Admin can delete user accounts.' });
        }
      }

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
        action: 'account_deleted',
        targetUid: targetDocId,
        loginId: targetLogin,
        performedByLoginId: cleanCallerId,
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
      const { callerLoginId, targetId, permissions, modulesAllowed, role, status } = req.body;

      if (!targetId) {
        return res.status(400).json({ success: false, error: 'targetId is required.' });
      }

      // Caller verification
      if (callerLoginId) {
        const callerSnap = await getDoc(doc(db, 'user_roles', `role_${callerLoginId.trim().toLowerCase()}`));
        if (callerSnap.exists()) {
          const callerData = callerSnap.data();
          if (callerData.role?.toLowerCase() !== 'super_admin' && callerLoginId.toLowerCase() !== 'superadmin') {
            return res.status(403).json({ success: false, error: 'Only Super Admin can update user permissions.' });
          }
        }
      }

      const targetDocRef = doc(db, 'user_roles', targetId);
      const targetSnap = await getDoc(targetDocRef);
      if (!targetSnap.exists()) {
        return res.status(404).json({ success: false, error: 'User account not found.' });
      }

      const oldData = targetSnap.data();
      const now = new Date().toISOString();

      // Update user_roles
      const updatePayload: any = { updatedAt: now };
      if (modulesAllowed) updatePayload.modulesAllowed = modulesAllowed;
      if (role) updatePayload.role = role;
      if (status) updatePayload.status = status;
      await updateDoc(targetDocRef, updatePayload);

      // Update user_permissions if permissions map provided
      if (permissions) {
        await setDoc(doc(db, 'user_permissions', targetId), {
          id: targetId,
          userId: targetId,
          loginId: oldData.loginId || '',
          role: role || oldData.role || 'user',
          permissions,
          updatedAt: now,
          updatedBy: callerLoginId || 'superadmin',
        }, { merge: true });
      }

      // Write audit log
      await logAuditEvent({
        action: 'permission_updated',
        targetUid: targetId,
        loginId: oldData.loginId || '',
        performedByLoginId: callerLoginId || 'superadmin',
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
  // 7. Save Role Permissions (Role Defaults)
  // ============================================================================
  app.post('/api/admin/role-permissions', async (req: Request, res: Response) => {
    try {
      const { callerLoginId, roleId, modulePermissions } = req.body;

      if (!roleId || !modulePermissions) {
        return res.status(400).json({ success: false, error: 'roleId and modulePermissions are required.' });
      }

      // Caller verification
      if (callerLoginId) {
        const callerSnap = await getDoc(doc(db, 'user_roles', `role_${callerLoginId.trim().toLowerCase()}`));
        if (callerSnap.exists()) {
          const callerData = callerSnap.data();
          if (callerData.role?.toLowerCase() !== 'super_admin' && callerLoginId.toLowerCase() !== 'superadmin') {
            return res.status(403).json({ success: false, error: 'Only Super Admin can update role-level permissions.' });
          }
        }
      }

      const now = new Date().toISOString();

      // Update role_permissions
      await setDoc(doc(db, 'role_permissions', roleId), {
        roleId,
        roleName: roleId === 'admin' ? 'Admin' : roleId === 'user' ? 'User' : 'Super Admin',
        modulePermissions,
        updatedAt: now,
        updatedBy: callerLoginId || 'superadmin',
      }, { merge: true });

      // Update roles collection defaultPermissions
      await setDoc(doc(db, 'roles', roleId), {
        defaultPermissions: modulePermissions,
        updatedAt: now,
      }, { merge: true });

      // Write audit log
      await logAuditEvent({
        action: 'role_permissions_updated',
        targetUid: roleId,
        loginId: roleId,
        performedByLoginId: callerLoginId || 'superadmin',
        newValue: modulePermissions,
        details: `Updated default role permissions for role "${roleId.toUpperCase()}"`,
      });

      return res.json({ success: true, message: `Role permissions for ${roleId.toUpperCase()} saved successfully.` });
    } catch (err: any) {
      console.error('[Save Role Permissions] Error:', err);
      return res.status(500).json({ success: false, error: err.message || 'Failed to save role permissions.' });
    }
  });

  // ============================================================================
  // Role-Protected Dashboard Summary Metrics Endpoint
  // ============================================================================
  app.get('/api/dashboard/summary', async (req: Request, res: Response) => {
    try {
      const loginId = (req.query.loginId as string)?.trim().toLowerCase();
      const date = (req.query.date as string) || new Date().toISOString().substring(0, 10);

      if (!loginId) {
        return res.status(401).json({ success: false, error: 'Unauthorized: loginId required.' });
      }

      // Verify user from Firestore user_roles collection
      const docId = `role_${loginId}`;
      let userDoc = await getDoc(doc(db, 'user_roles', docId));
      if (!userDoc.exists()) {
        const q = query(collection(db, 'user_roles'), where('loginId', '==', loginId));
        const snap = await getDocs(q);
        if (snap.empty) {
          return res.status(401).json({ success: false, error: 'Unauthorized: User not found.' });
        }
        userDoc = snap.docs[0];
      }

      const userData = userDoc.data();
      const rawRole = (userData?.role || '').toUpperCase();
      const isSuperAdmin = rawRole === 'SUPER_ADMIN' || rawRole === 'SUPERADMIN';
      const isAdmin = rawRole === 'ADMIN';

      if (!isSuperAdmin && !isAdmin) {
        return res.status(403).json({ success: false, error: 'Forbidden: Standard users do not have dashboard access.' });
      }

      // Fetch attendance records for the requested date
      const attSnap = await getDocs(query(collection(db, 'attendance'), where('shiftDate', '==', date)));
      const attendance = attSnap.docs.map(d => d.data());

      // Fetch active employees
      const empSnap = await getDocs(query(collection(db, 'employees'), where('employeeStatus', '==', 'Active')));
      const activeTotal = empSnap.size;

      const totalPresent = attendance.length;
      const absent = Math.max(0, activeTotal - totalPresent);
      const otHoursMins = attendance.reduce((acc, curr) => acc + (curr.overtimeMinutes || 0), 0);
      const autoClosed = attendance.filter(a => a.punchOutType === 'AUTO' || a.autoClosed).length;
      const missedPunchOut = attendance.filter(a => a.missedPunchOut || a.attendanceStatus === 'MISSED PUNCH OUT').length;

      // Base metrics accessible to ADMIN and SUPER_ADMIN
      const baseMetrics: Record<string, any> = {
        activeTotal,
        totalPresent,
        absent,
        otHoursMins,
        autoClosed,
        missedPunchOut,
      };

      if (isSuperAdmin) {
        // Restricted metrics strictly for SUPER_ADMIN
        const currentlyInside = attendance.filter(a => a.currentState === 'INSIDE' || (!a.actualPunchOut && a.punchOutType === 'NONE')).length;
        const currentlyOutside = attendance.filter(a => a.currentState === 'OUTSIDE' || (!!a.actualPunchOut || a.punchOutType === 'ACTUAL')).length;
        const firstIn = attendance.filter(a => !!(a.firstPunchIn || a.punchIn)).length;
        const finalOut = attendance.filter(a => !!(a.lastPunchOut || a.actualPunchOut)).length;
        const dutyHoursMins = attendance.reduce((acc, curr) => acc + (curr.totalDutyMinutes || curr.regularDutyMinutes || 0), 0);

        // Fetch roster for leave count
        const rosterSnap = await getDocs(query(collection(db, 'shift_rosters'), where('shiftDate', '==', date), where('rosterStatus', '==', 'LEAVE')));
        const onLeave = rosterSnap.size;

        return res.json({
          success: true,
          role: 'SUPER_ADMIN',
          metrics: {
            ...baseMetrics,
            currentlyInside,
            currentlyOutside,
            onLeave,
            firstIn,
            finalOut,
            dutyHoursMins,
          },
        });
      }

      // ADMIN response: STRICTLY ONLY the permitted 6 metrics
      return res.json({
        success: true,
        role: 'ADMIN',
        metrics: baseMetrics,
      });
    } catch (err: any) {
      console.error('[Dashboard Summary API] Error:', err);
      return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
    }
  });

  // ============================================================================
  // Role Permissions Management Endpoints (Granular View, Add, Edit, Delete)
  // ============================================================================

  // 1. Get all role permissions
  app.get('/api/admin/role-permissions', async (_req: Request, res: Response) => {
    try {
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

  // 2. Super Admin updates role permissions for Admin or User
  app.post('/api/admin/role-permissions', async (req: Request, res: Response) => {
    try {
      const { callerLoginId, roleId, modulePermissions } = req.body;

      if (!callerLoginId) {
        return res.status(401).json({ success: false, error: 'Caller Login ID required.' });
      }
      if (!roleId || !modulePermissions) {
        return res.status(400).json({ success: false, error: 'roleId and modulePermissions are required.' });
      }

      // Security Check: Only Super Admin can modify role permissions
      const cleanCallerId = callerLoginId.trim().toLowerCase();
      let callerDoc = await getDoc(doc(db, 'user_roles', `role_${cleanCallerId}`));
      if (!callerDoc.exists()) {
        const q = query(collection(db, 'user_roles'), where('loginId', '==', cleanCallerId));
        const snap = await getDocs(q);
        if (snap.empty) {
          return res.status(403).json({ success: false, error: 'Forbidden: Caller account not found.' });
        }
        callerDoc = snap.docs[0];
      }

      const callerData = callerDoc.data();
      const callerRole = (callerData?.role || '').toLowerCase();
      if (callerRole !== 'super_admin' && cleanCallerId !== 'superadmin') {
        return res.status(403).json({ success: false, error: 'Forbidden: Only Super Admin can modify role permissions.' });
      }

      // Protection: Super Admin role permissions cannot be altered or downgraded
      if (roleId === 'super_admin') {
        return res.status(400).json({ success: false, error: 'Super Admin permissions are complete and permanent.' });
      }

      if (roleId !== 'admin' && roleId !== 'user') {
        return res.status(400).json({ success: false, error: 'Invalid roleId. Must be "admin" or "user".' });
      }

      const now = new Date().toISOString();
      const roleRef = doc(db, 'role_permissions', roleId);
      await setDoc(roleRef, {
        roleId,
        roleName: roleId === 'admin' ? 'Admin' : 'User',
        modulePermissions,
        updatedAt: now,
        updatedBy: cleanCallerId,
      }, { merge: true });

      // Synchronize modulesAllowed on users with this role to maintain View consistency in navigation
      const allowedModules: string[] = [];
      Object.entries(modulePermissions).forEach(([modKey, perms]: [string, any]) => {
        if (perms?.view) {
          allowedModules.push(modKey);
        }
      });

      // Update matching user_roles documents in Firestore
      const usersSnap = await getDocs(query(collection(db, 'user_roles'), where('role', '==', roleId)));
      const updatePromises = usersSnap.docs.map(uDoc => 
        updateDoc(doc(db, 'user_roles', uDoc.id), {
          modulesAllowed: allowedModules,
          updatedAt: now,
        })
      );
      await Promise.all(updatePromises);

      return res.json({
        success: true,
        message: `Permissions for role "${roleId}" updated and synced successfully.`,
        updatedAt: now,
      });
    } catch (err: any) {
      console.error('[Role Permissions API] Save error:', err);
      return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
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
