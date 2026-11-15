import { auth } from '../firebase';
import { apiFetchJson, apiUrl, executeApiFetch, isApiBaseUsableForCurrentOrigin } from '../config/api';
import { AuditDeletionRecord, AuditLog, LoginHistoryEntry } from '../types';

export async function getAuthHeaders(extraHeaders?: Record<string, string>): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(extraHeaders || {}),
  };
  try {
    if (auth.currentUser) {
      const token = await auth.currentUser.getIdToken();
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
    }
  } catch {
    // Graceful fallback if auth session is mid-transition
  }
  return headers;
}

export function getActiveSessionId(): string | undefined {
  try {
    return (
      localStorage.getItem('narid_session_id') ||
      sessionStorage.getItem('narid_session_id') ||
      undefined
    );
  } catch {
    return undefined;
  }
}

export interface ServerAuditEventPayload {
  action: string;
  category?: string;
  targetType?: string;
  targetId?: string;
  employeeId?: string;
  oldValue?: any;
  newValue?: any;
  actionSource?: string;
  reason?: string;
  description?: string;
  success?: boolean;
}

export async function sendServerAuditEvent(payload: ServerAuditEventPayload): Promise<void> {
  if (!auth.currentUser || !isApiBaseUsableForCurrentOrigin()) return;
  try {
    const headers = await getAuthHeaders();
    if (!headers.Authorization) return;
    await executeApiFetch(
      apiUrl('/api/audit/event'),
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...payload,
          sessionId: getActiveSessionId(),
        }),
      },
      'POST /api/audit/event'
    );
  } catch {
    // Non-blocking audit dispatch
  }
}

export interface AuditKpis {
  totalLogs: number;
  todayActivities: number;
  successfulLogins: number;
  failedLogins: number;
  employeeChanges: number;
  attendanceEvents: number;
  securityAlerts: number;
  archivedLogs: number;
  pendingLogReviews: number;
  permanentDeletionsCount: number;
}

export interface AuditQueryFilters {
  search?: string;
  from?: string;
  to?: string;
  loginId?: string;
  role?: string;
  category?: string;
  action?: string;
  ip?: string;
  success?: 'ALL' | 'SUCCESS' | 'FAILURE';
  importance?: 'ALL' | 'IMPORTANT' | 'NORMAL';
  lifecycle?: 'active' | 'archived' | 'pending_review' | 'all';
  page?: number;
  pageSize?: number;
}

export interface AuditLogsResponse {
  success: boolean;
  kpis: AuditKpis;
  retentionDays: number;
  logs: AuditLog[];
  pagination: {
    page: number;
    pageSize: number;
    totalFiltered: number;
    totalPages: number;
  };
  facets: {
    actions: string[];
    actors: string[];
  };
}

export async function fetchAuditLogs(filters: AuditQueryFilters = {}): Promise<AuditLogsResponse> {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') {
      params.set(k, String(v));
    }
  });
  const headers = await getAuthHeaders();
  return apiFetchJson<AuditLogsResponse>(
    `/api/audit/logs?${params.toString()}`,
    { headers },
    'Failed to fetch enterprise audit logs.'
  );
}

export async function fetchLoginHistory(filters: {
  loginId?: string;
  eventType?: string;
  status?: string;
  search?: string;
} = {}): Promise<LoginHistoryEntry[]> {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') {
      params.set(k, String(v));
    }
  });
  const headers = await getAuthHeaders();
  const data = await apiFetchJson<{ success: boolean; entries?: LoginHistoryEntry[] }>(
    `/api/audit/login-history?${params.toString()}`,
    { headers },
    'Failed to load login history.'
  );
  return data.entries || [];
}

export async function fetchAuditDeletions(): Promise<AuditDeletionRecord[]> {
  const headers = await getAuthHeaders();
  const data = await apiFetchJson<{ success: boolean; deletions?: AuditDeletionRecord[] }>(
    '/api/audit/deletions',
    { headers },
    'Failed to load permanent deletion ledger.'
  );
  return data.deletions || [];
}

export async function toggleAuditImportant(
  id: string,
  isImportant: boolean,
  reviewNote?: string
): Promise<void> {
  const headers = await getAuthHeaders();
  await apiFetchJson(
    `/api/audit/logs/${encodeURIComponent(id)}/important`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ isImportant, reviewNote }),
    },
    'Failed to update importance status.'
  );
}

export async function archiveAuditLog(id: string, reviewNote?: string): Promise<void> {
  const headers = await getAuthHeaders();
  await apiFetchJson(
    `/api/audit/logs/${encodeURIComponent(id)}/archive`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ reviewNote }),
    },
    'Failed to archive audit log.'
  );
}

export interface LogDependencyReview {
  success: boolean;
  log: AuditLog;
  isProtected: boolean;
  protectionReasons: string[];
  ageDays: number;
  retentionDays: number;
  meetsRetentionAge: boolean;
  linkedRecords: string[];
  canDelete: boolean;
}

export async function reviewAuditLogDependencies(id: string): Promise<LogDependencyReview> {
  const headers = await getAuthHeaders();
  return apiFetchJson<LogDependencyReview>(
    `/api/audit/logs/${encodeURIComponent(id)}/review-dependencies`,
    { headers },
    'Failed to review audit log dependencies.'
  );
}

export async function controlledDeleteAuditLog(
  id: string,
  payload: { reason: string; confirmLogId: string; superAdminConfirmed: boolean }
): Promise<{ deletionId: string; message: string }> {
  const headers = await getAuthHeaders();
  return apiFetchJson<{ deletionId: string; message: string }>(
    `/api/audit/logs/${encodeURIComponent(id)}/controlled-delete`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    },
    'Failed to execute controlled deletion.'
  );
}

export interface CleanupAccountDependency {
  collection: string;
  matches: number;
  note: string;
}

export interface CleanupAuditAccount {
  key: string;
  loginId: string;
  email: string;
  firebaseUid: string;
  role: string;
  createdDate: string;
  lastSignIn: string;
  accountType: string;
  isCanonicalKeep: boolean;
  isProtected: boolean;
  dependencies: CleanupAccountDependency[];
  activeBlockingDependencies: number;
  approvalState: {
    approved: boolean;
    approvedBy: string;
    approvedAt: string;
    migratedDocs?: string[];
  } | null;
  canApproveForCleanup: boolean;
  consoleCleanupCommand: string | null;
  recommendation: string;
}

export interface AccountCleanupAuditResponse {
  success: boolean;
  auditTimestamp: string;
  projectId: string;
  collectionsScanned: number;
  canonicalKeepEmails: string[];
  accounts: CleanupAuditAccount[];
  safeguardMessage: string;
}

export async function fetchAccountCleanupAudit(): Promise<AccountCleanupAuditResponse> {
  const headers = await getAuthHeaders();
  return apiFetchJson<AccountCleanupAuditResponse>(
    '/api/admin/account-cleanup-audit',
    { headers },
    'Failed to run cross-collection account cleanup audit.'
  );
}

export async function approveAccountCleanup(payload: {
  accountKey: string;
  migrateCanonicalEmails?: boolean;
  confirmEmail: string;
}): Promise<{ success: boolean; message: string; cliSnippet: string; consoleUrl: string }> {
  const headers = await getAuthHeaders();
  return apiFetchJson(
    '/api/admin/account-cleanup/approve',
    {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    },
    'Failed to approve account cleanup.'
  );
}
