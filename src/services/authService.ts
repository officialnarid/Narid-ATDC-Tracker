import { 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword,
  signOut, 
  sendPasswordResetEmail,
  updatePassword,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  User as FirebaseUser
} from 'firebase/auth';
import { 
  collection, 
  doc, 
  getDoc,
  getDocs, 
  setDoc, 
  updateDoc,
  deleteDoc,
  query, 
  where 
} from 'firebase/firestore';
import { auth, db, sanitizeFirestoreData } from '../firebase';
import firebaseConfig from '../../firebase-applet-config.json';
import { UserRoleRecord, UserRoleType } from '../types';
import { NavItem } from '../components/Sidebar';

export const INITIAL_DEFAULT_PASSWORD = 'Narid@12345';

// Default initial industrial user accounts
export const DEFAULT_ACCOUNTS: Omit<UserRoleRecord, 'id' | 'createdAt' | 'updatedAt'>[] = [
  {
    loginId: 'superadmin',
    name: 'Chief Plant Operations (Super Admin)',
    email: 'superadmin_root@narid.com',
    role: 'super_admin',
    status: 'Active',
    mustChangePassword: false,
    modulesAllowed: ['all'],
  },
  {
    loginId: 'admin',
    name: 'Shift Supervisor (Admin)',
    email: 'admin_root@narid.com',
    role: 'admin',
    status: 'Active',
    mustChangePassword: false,
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
    status: 'Active',
    mustChangePassword: false,
    modulesAllowed: ['scanner'],
  },
];

// Seed default role records into Firestore and securely ensure accounts exist
export async function seedDefaultUserRoles(): Promise<void> {
  try {
    // 1. Trigger backend Admin SDK provisioning if available
    try {
      fetch('/api/admin/provision-accounts', { method: 'POST' }).catch(() => {});
    } catch {
      // Backend provisioning optional if running client-only
    }

    // 2. Synchronize Firestore user_roles documents without duplicating
    const snap = await getDocs(collection(db, 'user_roles'));
    const existingDocs = snap.docs.map(d => {
      const data = d.data() as UserRoleRecord;
      return { ...data, id: d.id };
    });
    const now = new Date().toISOString();

    for (const acc of DEFAULT_ACCOUNTS) {
      const id = `role_${acc.loginId}`;
      const existing = existingDocs.find(
        e => e.id === id || e.loginId?.toLowerCase() === acc.loginId.toLowerCase()
      );

      if (!existing) {
        const record: UserRoleRecord = {
          ...acc,
          id,
          createdAt: now,
          updatedAt: now,
        };
        await setDoc(doc(db, 'user_roles', id), sanitizeFirestoreData(record));
      } else {
        const updatePayload: Partial<UserRoleRecord> = {
          loginId: acc.loginId,
          role: acc.role,
          name: existing.name || acc.name,
          status: existing.status || 'Active',
          modulesAllowed: acc.modulesAllowed,
          updatedAt: now,
        };
        await setDoc(doc(db, 'user_roles', existing.id), updatePayload, { merge: true });
      }
    }
  } catch (error) {
    console.warn('Could not seed default user roles:', error);
  }
}

// Fetch user profile from Firestore by loginId (Authoritative Backend & Firestore Synchronization)
export async function getUserProfileByLoginId(loginId: string): Promise<UserRoleRecord | null> {
  const cleanId = loginId.toLowerCase().trim();

  // 1. Check authoritative backend verify-session endpoint first
  try {
    const res = await fetch('/api/auth/verify-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginId: cleanId }),
    });
    const data = await res.json();
    if (res.ok && data.success && data.profile) {
      return data.profile as UserRoleRecord;
    }
  } catch (err) {
    // Network fallback
  }

  // 2. Direct Firestore document get
  try {
    const docSnap = await getDoc(doc(db, 'user_roles', `role_${cleanId}`));
    if (docSnap.exists()) {
      return docSnap.data() as UserRoleRecord;
    }
    const q = query(collection(db, 'user_roles'), where('loginId', '==', cleanId));
    const snap = await getDocs(q);
    if (!snap.empty) {
      return snap.docs[0].data() as UserRoleRecord;
    }
  } catch (err) {
    console.warn('Direct Firestore profile lookup notice:', err);
  }

  // 3. Fallback to default accounts only if offline (strictly mustChangePassword: false)
  const def = DEFAULT_ACCOUNTS.find(a => a.loginId.toLowerCase() === cleanId);
  if (def) {
    return {
      ...def,
      mustChangePassword: false,
      id: `role_${def.loginId}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  return null;
}

// Fetch all registered user roles from Firestore
export async function getAllUserRoles(): Promise<UserRoleRecord[]> {
  try {
    const snap = await getDocs(collection(db, 'user_roles'));
    if (!snap.empty) {
      return snap.docs.map(d => d.data() as UserRoleRecord);
    }
  } catch (error) {
    console.warn('Error fetching all user roles:', error);
  }

  // Fallback to default accounts
  return DEFAULT_ACCOUNTS.map(acc => ({
    ...acc,
    id: `role_${acc.loginId}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
}

// Resolve Login ID or Email to the single active email in Firestore
export async function resolveCandidateEmails(input: string): Promise<{ candidates: string[]; profile?: UserRoleRecord }> {
  const clean = input.trim();
  if (!clean) {
    throw new Error('Please enter your Login ID.');
  }

  const lower = clean.toLowerCase();

  // 1. Fetch official profile from Firestore user_roles
  const profile = await getUserProfileByLoginId(lower);
  if (profile && profile.email) {
    return { candidates: [profile.email], profile };
  }

  // 2. If input is direct email
  if (clean.includes('@')) {
    const profileByEmail = await getUserProfileByEmail(clean);
    return { candidates: [clean], profile: profileByEmail || undefined };
  }

  // 3. Fallback to default canonical accounts
  const def = DEFAULT_ACCOUNTS.find(a => a.loginId.toLowerCase() === lower);
  if (def) {
    return { 
      candidates: [def.email], 
      profile: { ...def, id: `role_${def.loginId}`, createdAt: '', updatedAt: '' } 
    };
  }

  return { candidates: [`${lower}@narid.com`] };
}

// Fetch user profile from Firestore by email
export async function getUserProfileByEmail(email: string): Promise<UserRoleRecord | null> {
  const cleanEmail = email.toLowerCase().trim();

  // Try extracting login ID from email format (e.g. user_auth123@narid.com or user@narid.com)
  const extractedLoginId = cleanEmail.split('@')[0].split('_auth')[0];
  if (extractedLoginId) {
    const profileByLogin = await getUserProfileByLoginId(extractedLoginId);
    if (profileByLogin) return profileByLogin;
  }

  // Handle aliases
  if (cleanEmail.includes('superadmin')) {
    const profile = await getUserProfileByLoginId('superadmin');
    if (profile) return profile;
  }
  if (cleanEmail.includes('admin') && !cleanEmail.includes('superadmin')) {
    const profile = await getUserProfileByLoginId('admin');
    if (profile) return profile;
  }
  if (cleanEmail.includes('user') || cleanEmail.includes('operator')) {
    const profile = await getUserProfileByLoginId('user');
    if (profile) return profile;
  }

  try {
    const q = query(collection(db, 'user_roles'), where('email', '==', cleanEmail));
    const snap = await getDocs(q);
    if (!snap.empty) {
      return snap.docs[0].data() as UserRoleRecord;
    }
  } catch (err) {
    console.warn('Failed to fetch user role by email:', err);
  }

  const def = DEFAULT_ACCOUNTS.find(a => a.email.toLowerCase() === cleanEmail);
  if (def) {
    return {
      ...def,
      mustChangePassword: false,
      id: `role_${def.loginId}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  return {
    id: `role_user_${Date.now()}`,
    loginId: cleanEmail.split('@')[0],
    name: cleanEmail.split('@')[0].toUpperCase(),
    email: cleanEmail,
    role: 'user',
    status: 'Active',
    mustChangePassword: false,
    modulesAllowed: ['scanner'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// Session Persistence Helper
export function getStoredActiveUser(): UserRoleRecord | null {
  try {
    const raw = localStorage.getItem('narid_active_user') || sessionStorage.getItem('narid_active_user');
    if (!raw) return null;
    return JSON.parse(raw) as UserRoleRecord;
  } catch {
    return null;
  }
}

// Authenticate user with Login ID and Password (Single Source of Truth)
export async function loginWithLoginIdAndPassword(
  loginIdInput: string,
  passwordInput: string,
  rememberMe: boolean = true
): Promise<{ user: FirebaseUser; profile: UserRoleRecord }> {
  if (!loginIdInput.trim()) {
    throw new Error('Please enter your Login ID.');
  }
  if (!passwordInput) {
    throw new Error('Please enter your password.');
  }

  // 1. Authenticate against single-source-of-truth backend
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      loginId: loginIdInput.trim(),
      password: passwordInput,
    }),
  });

  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Invalid password, check again');
  }

  const profile: UserRoleRecord = data.profile;

  // 2. Persist active session in browser storage
  const storage = rememberMe ? localStorage : sessionStorage;
  storage.setItem('narid_active_user', JSON.stringify(profile));

  // 3. Authenticate with Firebase Auth for direct client Firestore access
  try {
    await setPersistence(auth, rememberMe ? browserLocalPersistence : browserSessionPersistence);
    const candidateEmails = [
      profile.email,
      `${profile.loginId}@narid.com`,
      `${profile.loginId}_root@narid.com`
    ].filter(Boolean);

    for (const em of candidateEmails) {
      if (auth.currentUser) break;
      try {
        await signInWithEmailAndPassword(auth, em, passwordInput);
        break;
      } catch {
        try {
          await signInWithEmailAndPassword(auth, em, INITIAL_DEFAULT_PASSWORD);
          break;
        } catch {
          // continue to next candidate
        }
      }
    }
  } catch (err) {
    console.warn('Firebase Auth sign in notice:', err);
  }

  const fbUser: FirebaseUser | null = auth.currentUser;

  return {
    user: fbUser || ({
      uid: profile.id,
      email: profile.email,
      displayName: profile.name,
      emailVerified: true,
      isAnonymous: false,
    } as any),
    profile,
  };
}

// Change initial password on first login
export async function changeInitialPassword(newPassword: string, currentPassword?: string): Promise<void> {
  if (!newPassword || newPassword.length < 6) {
    throw new Error('Password must be at least 6 characters.');
  }

  const storedUser = getStoredActiveUser();
  const loginId = storedUser?.loginId || (auth.currentUser?.email ? auth.currentUser.email.split('@')[0] : 'admin');

  const res = await fetch('/api/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      loginId,
      currentPassword,
      newPassword,
    }),
  });

  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to update password.');
  }

  if (storedUser) {
    storedUser.mustChangePassword = false;
    storedUser.passwordLastChangedAt = new Date().toISOString();
    localStorage.setItem('narid_active_user', JSON.stringify(storedUser));
    sessionStorage.setItem('narid_active_user', JSON.stringify(storedUser));
  }

  if (auth.currentUser) {
    await updatePassword(auth.currentUser, newPassword).catch(() => {});
  }
}

// Request Password Reset
export async function sendUserPasswordReset(loginIdOrEmail: string): Promise<string> {
  const { candidates } = await resolveCandidateEmails(loginIdOrEmail);
  const targetEmail = candidates[0];
  await sendPasswordResetEmail(auth, targetEmail);
  return targetEmail;
}

// Sign Out
export async function logoutUser(): Promise<void> {
  try {
    localStorage.removeItem('narid_active_user');
    sessionStorage.removeItem('narid_active_user');
  } catch {}
  try {
    await signOut(auth);
  } catch {}
}

// Determine default redirect tab for role
export function getDefaultTabForRole(role: UserRoleType): NavItem {
  const normalized = (role || '').toUpperCase();
  switch (normalized) {
    case 'SUPER_ADMIN':
      return 'dashboard';
    case 'ADMIN':
      return 'dashboard';
    case 'USER':
      return 'scanner';
    default:
      return 'scanner';
  }
}

// Dynamic user-level access validation checking custom Firestore permissions
export function isModuleAllowedForUser(profile: UserRoleRecord | null | undefined, tab: NavItem): boolean {
  if (!profile) return false;

  const normalized = (profile.role || '').toUpperCase();
  if (normalized === 'SUPER_ADMIN') {
    return true; // Super Admin always has full access
  }

  // Check custom granted permissions from Firestore
  if (Array.isArray(profile.modulesAllowed)) {
    if (profile.modulesAllowed.includes('all')) {
      return true;
    }
    return profile.modulesAllowed.includes(tab);
  }

  // Default fallback if modulesAllowed is not set
  if (normalized === 'ADMIN') {
    return tab !== 'user_rights' && tab !== 'settings';
  }
  if (normalized === 'USER') {
    return tab === 'scanner';
  }
  return false;
}

// Role-based access validation for navigation (legacy wrapper)
export function isModuleAllowedForRole(role: UserRoleType, tab: NavItem): boolean {
  const normalized = (role || '').toUpperCase();
  if (normalized === 'SUPER_ADMIN') {
    return true; // Full access
  }
  if (normalized === 'ADMIN') {
    return tab !== 'user_rights' && tab !== 'settings';
  }
  if (normalized === 'USER') {
    return tab === 'scanner';
  }
  return false;
}

// Create new user account with credentials and Firestore synchronization
export async function createUserAccount(data: {
  name: string;
  loginId: string;
  email?: string;
  password: string;
  role: UserRoleType;
  modulesAllowed: string[];
  status: 'Active' | 'Inactive';
  mustChangePassword?: boolean;
}): Promise<UserRoleRecord> {
  const cleanId = data.loginId.trim().toLowerCase();
  if (!cleanId || !/^[a-zA-Z0-9_-]+$/.test(cleanId)) {
    throw new Error('Login ID must contain only letters, numbers, hyphens, or underscores.');
  }

  const caller = getStoredActiveUser();

  // Provision through trusted backend single source of truth
  const res = await fetch('/api/admin/create-user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callerLoginId: caller?.loginId || 'superadmin',
      name: data.name,
      loginId: cleanId,
      email: data.email,
      password: data.password,
      role: data.role,
      status: data.status,
      modulesAllowed: data.modulesAllowed,
      mustChangePassword: data.mustChangePassword,
    }),
  });

  const resData = await res.json();
  if (!res.ok || !resData.success) {
    throw new Error(resData.error || 'Failed to create user account.');
  }

  return resData.profile as UserRoleRecord;
}

// Super Admin sets or resets password for any user account (Strict Server-Side Verification)
export async function adminSetUserPassword(
  _userId: string,
  loginId: string,
  newPassword: string,
  mustChangePasswordOnLogin: boolean = true,
  unlockAccount: boolean = true,
  revokeSessions: boolean = true
): Promise<void> {
  if (!newPassword || newPassword.length < 6) {
    throw new Error('Password must be at least 6 characters.');
  }

  const cleanId = loginId.trim().toLowerCase();
  const caller = getStoredActiveUser();

  const res = await fetch('/api/admin/set-user-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callerLoginId: caller?.loginId || 'superadmin',
      targetLoginId: cleanId,
      newPassword,
      mustChangePassword: mustChangePasswordOnLogin,
      unlockAccount,
      revokeSessions,
    }),
  });

  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to update password.');
  }
}

// Fetch password reset audit history (Super Admin Only)
export async function fetchPasswordResetHistory(): Promise<any[]> {
  const caller = getStoredActiveUser();
  const callerLoginId = caller?.loginId || 'superadmin';
  const res = await fetch(`/api/admin/password-reset-history?callerLoginId=${encodeURIComponent(callerLoginId)}`);
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to fetch password reset history.');
  }
  return data.history || [];
}


// Super Admin updates module permissions, role, or status for any user in Firestore
export async function updateUserRolePermissions(
  userId: string,
  modulesAllowed: string[],
  role?: UserRoleType,
  status?: 'Active' | 'Inactive'
): Promise<void> {
  const docRef = doc(db, 'user_roles', userId);
  const payload: any = {
    modulesAllowed,
    updatedAt: new Date().toISOString(),
  };
  if (role) payload.role = role;
  if (status) payload.status = status;

  await updateDoc(docRef, sanitizeFirestoreData(payload));
}

// Secure User Account Deletion (Super Admin only, calls backend)
export async function deleteUserRole(userId: string, targetLoginId?: string): Promise<void> {
  if (userId === 'role_superadmin' || targetLoginId === 'superadmin') {
    throw new Error('Action denied: The primary root Super Admin account cannot be deleted.');
  }

  const caller = getStoredActiveUser();
  const callerLoginId = caller?.loginId || 'superadmin';

  const res = await fetch('/api/admin/delete-user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callerLoginId,
      targetId: userId,
      targetLoginId: targetLoginId || userId.replace(/^role_/, ''),
    }),
  });

  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to delete user account.');
  }
}

export const deleteUserAccount = deleteUserRole;
