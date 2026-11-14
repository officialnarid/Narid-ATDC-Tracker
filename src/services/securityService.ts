import { getAuthHeaders } from './auditService';
import {
  LoginAttemptRecord,
  SecurityAuditLogRecord,
  SecurityOverviewResponse,
} from '../types';

export async function fetchSecurityOverview(): Promise<SecurityOverviewResponse> {
  const headers = await getAuthHeaders();
  const res = await fetch('/api/security/overview', { headers });
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to fetch security & lockout overview.');
  }
  return data as SecurityOverviewResponse;
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
  const res = await fetch(`/api/security/attempts?${params.toString()}`, { headers });
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to load login attempts.');
  }
  return (data.attempts || []) as LoginAttemptRecord[];
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
  const res = await fetch(`/api/security/audit-logs?${params.toString()}`, { headers });
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to load security audit logs.');
  }
  return (data.logs || []) as SecurityAuditLogRecord[];
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
  const res = await fetch('/api/security/unblock-account', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to unblock account.');
  }
  return data;
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
  const res = await fetch('/api/security/generate-temp-password', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
    const err: any = new Error(data.error || 'Failed to generate temporary password.');
    err.requiresFreshAuth = Boolean(data.requiresFreshAuth);
    throw err;
  }
  return data;
}

export async function reportFirebaseThrottleSignal(loginId: string): Promise<void> {
  try {
    await fetch('/api/auth/firebase-throttle-signal', {
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
  const res = await fetch('/api/security/firebase-admin-status', { headers });
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to inspect Firebase Admin SDK status.');
  }
  return data as FirebaseAdminStatusResponse;
}

