import {
  apiFetchJson,
  apiUrl,
  isApiBaseUsableForCurrentOrigin,
} from '../config/api';
import { getAuthHeaders } from './auditService';
import {
  LoginAttemptRecord,
  SecurityAuditLogRecord,
  SecurityOverviewResponse,
} from '../types';

export async function fetchSecurityOverview(): Promise<SecurityOverviewResponse> {
  const headers = await getAuthHeaders();
  return apiFetchJson<SecurityOverviewResponse>(
    '/api/security/overview',
    { headers },
    'Failed to fetch security & lockout overview.'
  );
}

export async function fetchLoginAttempts(
  filters: {
    loginId?: string;
    outcome?: string;
    search?: string;
    limit?: number;
  } = {}
): Promise<LoginAttemptRecord[]> {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') {
      params.set(k, String(v));
    }
  });
  const headers = await getAuthHeaders();
  const data = await apiFetchJson<{ success: boolean; attempts?: LoginAttemptRecord[] }>(
    `/api/security/attempts?${params.toString()}`,
    { headers },
    'Failed to load login attempts.'
  );
  return data.attempts || [];
}

export async function fetchSecurityAuditLogs(
  filters: {
    loginId?: string;
    action?: string;
    severity?: string;
    search?: string;
  } = {}
): Promise<SecurityAuditLogRecord[]> {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') {
      params.set(k, String(v));
    }
  });
  const headers = await getAuthHeaders();
  const data = await apiFetchJson<{ success: boolean; logs?: SecurityAuditLogRecord[] }>(
    `/api/security/audit-logs?${params.toString()}`,
    { headers },
    'Failed to load security audit logs.'
  );
  return data.logs || [];
}

export async function unblockLockedAccount(payload: {
  targetLoginId: string;
  reason: string;
  confirmed: boolean;
}): Promise<{
  success: boolean;
  message: string;
  targetLoginId: string;
  targetRole: string;
  firebaseUid: string;
  unblockedAt: string;
}> {
  const headers = await getAuthHeaders();
  return apiFetchJson(
    '/api/security/unblock-account',
    {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    },
    'Failed to unblock account.'
  );
}

export async function generateTemporaryPasswordForAccount(payload: {
  targetLoginId: string;
  reason: string;
  freshSuperAdminPassword?: string;
}): Promise<{
  success: boolean;
  targetLoginId: string;
  targetRole: string;
  firebaseUid: string;
  temporaryPassword: string;
  forcePasswordChange: boolean;
  firebaseAuthSynced: boolean;
  generatedAt: string;
  message: string;
}> {
  const headers = await getAuthHeaders();
  return apiFetchJson(
    '/api/security/generate-temp-password',
    {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    },
    'Failed to generate temporary password.'
  );
}

export async function reportFirebaseThrottleSignal(loginId: string): Promise<void> {
  if (!isApiBaseUsableForCurrentOrigin()) return;
  try {
    await fetch(apiUrl('/api/auth/firebase-throttle-signal'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginId }),
    });
  } catch {
    // non-blocking telemetry
  }
}

export interface FirebaseAdminStatusResponse {
  success: boolean;
  adminSdkConfigured: boolean;
  projectId: string;
  credentialSource?: string;
  serviceAccountEmail?: string;
  adcSandboxProject: string;
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
}

export async function fetchFirebaseAdminStatus(): Promise<FirebaseAdminStatusResponse> {
  const headers = await getAuthHeaders();
  return apiFetchJson<FirebaseAdminStatusResponse>(
    '/api/security/firebase-admin-status',
    { headers },
    'Failed to inspect Firebase Admin SDK status.'
  );
}

