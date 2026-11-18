import { 
  signInWithEmailAndPassword, 
  signOut, 
  sendPasswordResetEmail,
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
  query,
  where,
} from 'firebase/firestore';
import { auth, db } from '../firebase';
import {
  apiFetchJson,
  apiUrl,
  assertApiBaseConfigured,
  executeApiFetch,
  isApiBaseUsableForCurrentOrigin,
  safeParseJsonResponse,
} from '../config/api';
import { UserRoleRecord, UserRoleType } from '../types';
import { NavItem } from '../components/Sidebar';
import { getAuthHeaders, sendServerAuditEvent } from './auditService';
import { reportFirebaseThrottleSignal } from './securityService';

export interface LoginAuthError extends Error {
  code?: string;
  locked?: boolean;
  warning?: boolean;
  attemptNumber?: number;
  maxAttempts?: number;
  remainingAttempts?: number;
  cooldownSeconds?: number;
  firebaseAbuseProtection?: boolean;
}

// Default initial industrial user accounts (canonical *@narid.com kept active)
export const DEFAULT_ACCOUNTS: Omit<UserRoleRecord, 'id' | 'createdAt' | 'updatedAt'>[] = [
  {
    loginId: 'superadmin',
    name: 'Chief Plant Operations (Super Admin)',
    email: 'superadmin@narid.com',
    emailAliases: ['superadmin_root@narid.com'],
    role: 'super_admin',
    status: 'Active',
    mustChangePassword: false,
    modulesAllowed: ['all'],
  },
  {
    loginId: 'admin',
    name: 'Shift Supervisor (Admin)',
    email: 'admin@narid.com',
    emailAliases: ['admin_root@narid.com'],
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
    email: 'user@narid.com',
    emailAliases: ['user_root@narid.com'],
    role: 'user',
    status: 'Active',
    mustChangePassword: false,
    modulesAllowed: ['dashboard', 'scanner'],
  },
];

// Backend Admin SDK handles authoritative user_roles initialization on startup.
export async function seedDefaultUserRoles(): Promise<void> {
  return Promise.resolve();
}

// Fetch user profile from Firestore by loginId (Authoritative Backend & Firestore Synchronization)
export async function getUserProfileByLoginId(loginId: string): Promise<UserRoleRecord | null> {
  const cleanId = loginId.toLowerCase().trim();

  // 1. Check authoritative backend verify-session endpoint when Firebase session exists
  if (auth.currentUser && isApiBaseUsableForCurrentOrigin()) {
    try {
      const headers = await getAuthHeaders();
      const res = await executeApiFetch(
        apiUrl('/api/auth/verify-session'),
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ loginId: cleanId }),
        },
        'POST /api/auth/verify-session'
      );
      const parsed = await safeParseJsonResponse<{ success?: boolean; profile?: UserRoleRecord }>(
        res,
        'POST /api/auth/verify-session'
      );
      if (parsed.ok && parsed.data?.profile) {
        return parsed.data.profile;
      }
    } catch {
      // Fall through to Firestore read lookup
    }
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

  return null;
}

// Fetch all registered user roles from Firestore (with strict loginId deduplication)
export async function getAllUserRoles(): Promise<UserRoleRecord[]> {
  try {
    const snap = await getDocs(collection(db, 'user_roles'));
    if (!snap.empty) {
      const raw = snap.docs.map(d => ({ ...d.data(), id: d.id } as UserRoleRecord));
      // Deduplicate by normalized loginId
      const map = new Map<string, UserRoleRecord>();
      raw.forEach(r => {
        const key = (r.loginId || r.id.replace(/^role_/, '')).trim().toLowerCase();
        const existing = map.get(key);
        if (!existing || r.id === `role_${key}` || (!existing.id.startsWith('role_') && r.passwordHash)) {
          map.set(key, r);
        }
      });
      return Array.from(map.values());
    }
  } catch (error) {
    console.warn('Error fetching all user roles:', error);
  }

  return [];
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

// Fetch authoritative user profile for signed-in session (strictly UID-verified, zero synthetic fallbacks)
export async function getUserProfileByEmail(email: string): Promise<UserRoleRecord | null> {
  const cleanEmail = email.toLowerCase().trim();

  // 1. Always prefer authoritative backend UID-verified session profile when authenticated
  if (auth.currentUser) {
    if (isApiBaseUsableForCurrentOrigin()) {
      try {
        const headers = await getAuthHeaders();
        const res = await executeApiFetch(
          apiUrl('/api/auth/verify-session'),
          {
            method: 'POST',
            headers,
            body: JSON.stringify({}),
          },
          'POST /api/auth/verify-session'
        );
        const parsed = await safeParseJsonResponse<{ success?: boolean; profile?: UserRoleRecord }>(
          res,
          'POST /api/auth/verify-session'
        );
        if (parsed.ok && parsed.data?.profile) {
          return parsed.data.profile;
        }
      } catch {
        // Fall through to UID-matched Firestore lookup
      }
    }

    try {
      const uidQuery = query(collection(db, 'user_roles'), where('authUid', '==', auth.currentUser.uid));
      const uidSnap = await getDocs(uidQuery);
      if (!uidSnap.empty) {
        return uidSnap.docs[0].data() as UserRoleRecord;
      }
    } catch (err) {
      console.warn('UID-based Firestore profile lookup notice:', err);
    }
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

  return null;
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
  const normalizedLoginId = loginIdInput.trim();
  if (!normalizedLoginId) {
    throw new Error('Please enter your Login ID.');
  }
  if (!passwordInput) {
    throw new Error('Please enter your password.');
  }

  // 1. Authenticate against single-source-of-truth backend (Atomic 3-Strike & Rate Limit Guard)
  // Note: passwordInput is sent verbatim without trimming or transformation.
  assertApiBaseConfigured();
  const res = await executeApiFetch(
    apiUrl('/api/auth/login'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        loginId: normalizedLoginId,
        password: passwordInput,
      }),
    },
    'POST /api/auth/login'
  );

  const parsed = await safeParseJsonResponse<any>(res, 'POST /api/auth/login');
  const data = parsed.data || {};
  if (!parsed.ok) {
    const authErr: LoginAuthError = new Error(
      parsed.errorMessage || data.error || 'Invalid password, check again'
    );
    authErr.code = data.code || (parsed.isHtmlOrNonJson ? `HTTP_${res.status}_NON_JSON` : undefined);
    authErr.locked = Boolean(data.locked || res.status === 423);
    authErr.warning = Boolean(data.warning);
    authErr.attemptNumber = data.attemptNumber;
    authErr.maxAttempts = data.maxAttempts;
    authErr.remainingAttempts = data.remainingAttempts;
    authErr.cooldownSeconds = data.cooldownSeconds;
    throw authErr;
  }

  const profile: UserRoleRecord = data.profile;
  const cleanLoginLower = String(profile.loginId || normalizedLoginId).trim().toLowerCase();
  const canonicalEmail = `${cleanLoginLower}@narid.com`;
  const rawEmail = String(profile.email || canonicalEmail).trim().toLowerCase();

  // Always prefer the canonical *@narid.com primary email over legacy *_root@narid.com aliases
  const primaryAuthEmail =
    rawEmail.endsWith('_root@narid.com') &&
    (Array.isArray(profile.emailAliases) ? profile.emailAliases.map((e) => e.toLowerCase()).includes(canonicalEmail) : true)
      ? canonicalEmail
      : rawEmail;

  // 2. Authenticate with Firebase Auth ONCE using canonical email (never bypass or retry on failure/rate-limit)
  await setPersistence(auth, rememberMe ? browserLocalPersistence : browserSessionPersistence);

  try {
    await signInWithEmailAndPassword(auth, primaryAuthEmail, passwordInput);
  } catch (fbErr: any) {
    try {
      localStorage.removeItem('narid_active_user');
      sessionStorage.removeItem('narid_active_user');
      localStorage.removeItem('narid_session_id');
      sessionStorage.removeItem('narid_session_id');
    } catch {}

    const fbCode = String(fbErr?.code || '');
    const fbMsg = String(fbErr?.message || '');

    if (fbCode === 'auth/too-many-requests' || fbMsg.includes('TOO_MANY_ATTEMPTS_TRY_LATER')) {
      await reportFirebaseThrottleSignal(cleanLoginLower);
      const throttleErr: LoginAuthError = new Error(
        'Too many authentication requests detected by Firebase security protection (TOO_MANY_ATTEMPTS_TRY_LATER). Please wait before trying again.'
      );
      throttleErr.code = 'TOO_MANY_ATTEMPTS_TRY_LATER';
      throttleErr.firebaseAbuseProtection = true;
      throw throttleErr;
    }

    const syncErr: LoginAuthError = new Error(
      `Firebase Authentication rejected sign-in for "${primaryAuthEmail}" (${fbCode || fbMsg || 'INVALID_LOGIN_CREDENTIALS'}). Please verify password synchronization with Super Admin.`
    );
    syncErr.code = fbCode || 'INVALID_LOGIN_CREDENTIALS';
    throw syncErr;
  }

  const fbUser: FirebaseUser | null = auth.currentUser;
  if (!fbUser) {
    throw new Error('Firebase authentication session could not be established. Please try signing in again.');
  }

  // 3. Persist active session only AFTER both backend verification and Firebase Auth succeed
  const normalizedProfile: UserRoleRecord = {
    ...profile,
    email: primaryAuthEmail,
    authUid: fbUser.uid,
  };
  const storage = rememberMe ? localStorage : sessionStorage;
  storage.setItem('narid_active_user', JSON.stringify(normalizedProfile));
  if (data.sessionId) {
    storage.setItem('narid_session_id', String(data.sessionId));
  }

  return {
    user: fbUser,
    profile: normalizedProfile,
  };
}

// Change initial password on first login via authoritative backend + fresh Firebase session sync
export async function changeInitialPassword(newPassword: string, currentPassword?: string): Promise<void> {
  if (!currentPassword || currentPassword.length === 0) {
    throw new Error('Please enter your current password to verify your identity.');
  }
  if (!newPassword || newPassword.length < 6) {
    throw new Error('Password must be at least 6 characters.');
  }
  if (newPassword === currentPassword) {
    throw new Error('New password must be different from your current password.');
  }
  if (!auth.currentUser) {
    throw new Error('Your session has expired. Please sign in again.');
  }

  const storedUser = getStoredActiveUser();
  const loginId = storedUser?.loginId || (auth.currentUser?.email ? auth.currentUser.email.split('@')[0] : 'admin');
  const headers = await getAuthHeaders();
  if (!headers.Authorization) {
    throw new Error('Authentication session token missing. Please sign out and sign in again.');
  }

  const resData = await apiFetchJson<{
    success: boolean;
    targetEmail?: string;
    mustChangePassword?: boolean;
    forcePasswordChange?: boolean;
  }>(
    '/api/auth/change-password',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        loginId,
        currentPassword,
        newPassword,
      }),
    },
    'Failed to update password.'
  );

  const canonicalEmail = `${String(loginId).trim().toLowerCase()}@narid.com`;
  const signInEmail = (
    resData?.targetEmail ||
    auth.currentUser?.email ||
    storedUser?.email ||
    canonicalEmail
  )
    .trim()
    .toLowerCase();

  // Refresh client Firebase Auth session immediately so revoked old refresh tokens never break verify-session
  try {
    await signInWithEmailAndPassword(auth, signInEmail, newPassword);
  } catch {
    if (signInEmail !== canonicalEmail) {
      await signInWithEmailAndPassword(auth, canonicalEmail, newPassword);
    } else {
      throw new Error('Password updated successfully, but session refresh failed. Please sign in again with your new password.');
    }
  }

  if (storedUser) {
    storedUser.mustChangePassword = false;
    storedUser.forcePasswordChange = false;
    storedUser.passwordLastChangedAt = new Date().toISOString();
    const hadLocal = Boolean(localStorage.getItem('narid_active_user'));
    const hadSession = Boolean(sessionStorage.getItem('narid_active_user'));
    if (hadLocal || !hadSession) {
      localStorage.setItem('narid_active_user', JSON.stringify(storedUser));
    }
    if (hadSession) {
      sessionStorage.setItem('narid_active_user', JSON.stringify(storedUser));
    }
  }
}

// Request Password Reset
export async function sendUserPasswordReset(loginIdOrEmail: string): Promise<string> {
  const { candidates } = await resolveCandidateEmails(loginIdOrEmail);
  const targetEmail = candidates[0];
  await sendPasswordResetEmail(auth, targetEmail);
  return targetEmail;
}

// Sign Out (Records server-enriched LOGOUT / SESSION_EXPIRED event before clearing Firebase token)
export async function logoutUser(reason: 'logout' | 'session_expired' = 'logout'): Promise<void> {
  if (auth.currentUser) {
    await sendServerAuditEvent({
      action: reason,
      category: 'AUTH',
      targetType: 'SESSION',
      actionSource: reason === 'session_expired' ? 'SESSION_GUARD' : 'USER_LOGOUT',
      description:
        reason === 'session_expired'
          ? 'Session automatically terminated by security session guard.'
          : 'User signed out of NARID ATDC Tracker.',
      success: true,
    });
  }
  try {
    localStorage.removeItem('narid_active_user');
    sessionStorage.removeItem('narid_active_user');
    localStorage.removeItem('narid_session_id');
    sessionStorage.removeItem('narid_session_id');
  } catch {}
  try {
    await signOut(auth);
  } catch {}
}

const LANDING_TAB_PRIORITY: NavItem[] = [
  'dashboard',
  'scanner',
  'employees',
  'history',
  'reports',
  'floors',
  'sections',
  'departments',
  'shifts',
  'qr_codes',
  'excel_import',
  'settings',
];

// Determine default redirect tab for role (supports future custom roles without dashboard permission)
export function getDefaultTabForRole(role: UserRoleType, profile?: UserRoleRecord | null): NavItem {
  const normalized = (role || '').toUpperCase();
  if (normalized === 'SUPER_ADMIN') {
    return 'dashboard';
  }

  if (profile && Array.isArray(profile.modulesAllowed)) {
    if (profile.modulesAllowed.includes('all') || profile.modulesAllowed.includes('dashboard')) {
      return 'dashboard';
    }
    const firstAllowed = LANDING_TAB_PRIORITY.find((tab) => isModuleAllowedForUser(profile, tab));
    if (firstAllowed) {
      return firstAllowed;
    }
  }

  return 'dashboard';
}

// Dynamic user-level access validation checking custom Firestore permissions
export function isModuleAllowedForUser(profile: UserRoleRecord | null | undefined, tab: NavItem): boolean {
  if (!profile) return false;

  const normalized = (profile.role || '').trim().toUpperCase();
  if (normalized === 'SUPER_ADMIN' || normalized === 'SUPERADMIN') {
    return true; // Super Admin always has full access
  }

  // Security Lockout Control, Audit Logs, User Rights & System Performance are strictly SUPER_ADMIN only
  if (
    tab === 'security_management' ||
    tab === 'audit_logs' ||
    tab === 'user_rights' ||
    tab === 'system_performance'
  ) {
    return false;
  }

  // Check custom granted permissions from Firestore
  if (Array.isArray(profile.modulesAllowed)) {
    if (profile.modulesAllowed.includes('all')) {
      return true;
    }
    return profile.modulesAllowed.includes(tab);
  }

  // Default fallback ONLY for built-in system roles if modulesAllowed is not set
  if (normalized === 'ADMIN') {
    return tab !== 'settings';
  }
  if (normalized === 'USER') {
    return tab === 'dashboard' || tab === 'scanner';
  }
  return false;
}

// Role-based access validation for navigation (legacy wrapper)
export function isModuleAllowedForRole(role: UserRoleType, tab: NavItem): boolean {
  const normalized = (role || '').trim().toUpperCase();
  if (normalized === 'SUPER_ADMIN' || normalized === 'SUPERADMIN') {
    return true; // Full access
  }
  if (
    tab === 'security_management' ||
    tab === 'audit_logs' ||
    tab === 'user_rights' ||
    tab === 'system_performance'
  ) {
    return false;
  }
  if (normalized === 'ADMIN') {
    return tab !== 'settings';
  }
  if (normalized === 'USER') {
    return tab === 'dashboard' || tab === 'scanner';
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
  const headers = await getAuthHeaders();

  // Provision through trusted backend single source of truth
  const resData = await apiFetchJson<{ success: boolean; profile: UserRoleRecord }>(
    '/api/admin/create-user',
    {
      method: 'POST',
      headers,
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
    },
    'Failed to create user account.'
  );

  return resData.profile;
}

// Super Admin sets or resets password for any user account (Strict Server-Side Verification)
export async function adminSetUserPassword(
  _userId: string,
  loginId: string,
  newPassword: string,
  mustChangePasswordOnLogin: boolean = true,
  unlockAccount: boolean = true,
  revokeSessions: boolean = true,
  currentTargetPassword?: string
): Promise<{
  success: boolean;
  message: string;
  firebaseAuthSynced: boolean;
  firebaseUid?: string;
  matchedFirebaseEmail?: string | null;
}> {
  if (!newPassword || newPassword.length < 6) {
    throw new Error('Password must be at least 6 characters.');
  }

  const cleanId = loginId.trim().toLowerCase();
  const caller = getStoredActiveUser();
  const headers = await getAuthHeaders();

  assertApiBaseConfigured();
  const res = await executeApiFetch(
    apiUrl('/api/admin/set-user-password'),
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        callerLoginId: caller?.loginId || 'superadmin',
        targetLoginId: cleanId,
        newPassword,
        mustChangePassword: mustChangePasswordOnLogin,
        unlockAccount,
        revokeSessions,
        ...(currentTargetPassword ? { currentTargetPassword } : {}),
      }),
    },
    'POST /api/admin/set-user-password'
  );

  const parsed = await safeParseJsonResponse<any>(res, 'POST /api/admin/set-user-password');
  const data = parsed.data || {};
  if (!parsed.ok) {
    const err: any = new Error(parsed.errorMessage || data.error || 'Failed to update password.');
    err.code = data.code;
    err.firebaseAuthSynced = Boolean(data.firebaseAuthSynced);
    err.adminSdkConfigured = data.adminSdkConfigured;
    throw err;
  }

  return data;
}

// Fetch password reset audit history (Super Admin Only)
export async function fetchPasswordResetHistory(): Promise<any[]> {
  const caller = getStoredActiveUser();
  const callerLoginId = caller?.loginId || 'superadmin';
  const headers = await getAuthHeaders();
  const data = await apiFetchJson<{ success: boolean; history?: any[] }>(
    `/api/admin/password-reset-history?callerLoginId=${encodeURIComponent(callerLoginId)}`,
    { headers },
    'Failed to fetch password reset history.'
  );
  return data.history || [];
}

// Super Admin updates module permissions, role, or status via Admin SDK backend
export async function updateUserRolePermissions(
  userId: string,
  modulesAllowed: string[],
  role?: UserRoleType,
  status?: 'Active' | 'Inactive'
): Promise<void> {
  const caller = getStoredActiveUser();
  const headers = await getAuthHeaders();
  await apiFetchJson(
    '/api/admin/set-user-permissions',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        callerLoginId: caller?.loginId || 'superadmin',
        targetId: userId,
        modulesAllowed,
        ...(role ? { role } : {}),
        ...(status ? { status } : {}),
      }),
    },
    'Failed to update user access permissions.'
  );
}

// Secure User Account Deletion (Super Admin only, calls backend)
export async function deleteUserRole(userId: string, targetLoginId?: string): Promise<void> {
  if (userId === 'role_superadmin' || targetLoginId === 'superadmin') {
    throw new Error('Action denied: The primary root Super Admin account cannot be deleted.');
  }

  const caller = getStoredActiveUser();
  const callerLoginId = caller?.loginId || 'superadmin';
  const headers = await getAuthHeaders();

  await apiFetchJson(
    '/api/admin/delete-user',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        callerLoginId,
        targetId: userId,
        targetLoginId: targetLoginId || userId.replace(/^role_/, ''),
      }),
    },
    'Failed to delete user account.'
  );
}

export const deleteUserAccount = deleteUserRole;

// Fetch Duplicate Accounts Report (Super Admin Only)
export interface DuplicateDocDetail {
  docId: string;
  firebaseUid: string | null;
  loginId: string;
  name: string;
  email: string;
  role: string;
  status: string;
  hasPasswordHash: boolean;
  createdAt: string | null;
  associatedAuditLogs: number;
  isPrimary: boolean;
  recommendation: 'RETAIN_PRIMARY' | 'CONSOLIDATE_AND_DELETE';
}

export interface DuplicateGroupReport {
  loginId: string;
  totalDocs: number;
  hasDuplicates: boolean;
  primaryDocId: string;
  documents: DuplicateDocDetail[];
}

export interface DuplicateReportResponse {
  success: boolean;
  totalRawDocuments: number;
  totalUniqueAccounts: number;
  duplicateCount: number;
  report: DuplicateGroupReport[];
  summary: string;
}

export async function fetchDuplicateAccountsReport(): Promise<DuplicateReportResponse> {
  const caller = getStoredActiveUser();
  const callerLoginId = caller?.loginId || 'superadmin';
  const headers = await getAuthHeaders();
  return apiFetchJson<DuplicateReportResponse>(
    `/api/admin/duplicate-accounts-report?callerLoginId=${encodeURIComponent(callerLoginId)}`,
    { headers },
    'Failed to fetch duplicate accounts report.'
  );
}

export async function consolidateDuplicateAccounts(): Promise<{
  success: boolean;
  message: string;
  consolidatedDuplicatesCount: number;
  remainingAccountsCount: number;
  consolidationResults: any[];
}> {
  const caller = getStoredActiveUser();
  const callerLoginId = caller?.loginId || 'superadmin';
  const headers = await getAuthHeaders();
  return apiFetchJson(
    '/api/admin/consolidate-duplicates',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ callerLoginId }),
    },
    'Failed to consolidate duplicate accounts.'
  );
}

// Full 10-Account Master Authentication Audit
export interface FullAuthAuditAccount {
  loginId: string;
  email: string;
  firebaseUid: string;
  role: string;
  createdDate: string;
  lastSignIn: string;
  accountType: string;
  accountStatus: string;
  firestoreReferences: string;
  recommendation: string;
}

export interface FullAuthAuditResponse {
  success: boolean;
  auditTimestamp: string;
  totalAccountsAudited: number;
  primaryAccountsCount: number;
  legacyAccountsCount: number;
  activeFirestoreDirectoryCount: number;
  totalAuditLogsCount: number;
  totalPasswordResetLogsCount: number;
  requiresSuperAdminApprovalForPurge: boolean;
  safeguardMessage: string;
  accounts: FullAuthAuditAccount[];
}

export async function fetchFullAuthAudit(): Promise<FullAuthAuditResponse> {
  const caller = getStoredActiveUser();
  const callerLoginId = caller?.loginId || 'superadmin';
  const headers = await getAuthHeaders();
  return apiFetchJson<FullAuthAuditResponse>(
    `/api/admin/full-auth-audit?callerLoginId=${encodeURIComponent(callerLoginId)}`,
    { headers },
    'Failed to fetch full authentication audit.'
  );
}
