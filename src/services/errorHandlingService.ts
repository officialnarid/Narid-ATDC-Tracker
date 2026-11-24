import { auth } from '../firebase';
import { apiUrl, executeApiFetch, parseApiJsonOrThrow } from '../config/api';
import {
  type DatabaseOperationCategory,
  type ErrorCategory,
  type ErrorResolutionStatus,
  type NormalizedAppError,
  type StandardErrorCode,
  type TechnicalErrorLogRecord,
  classifyAndNormalizeError,
  sanitizeDiagnosticObject,
  sanitizeTextForLog,
} from '../utils/errorRegistry';

export interface HandleAppErrorContext {
  moduleName: string;
  endpoint?: string | null;
  operation?: string;
  forcedErrorCode?: StandardErrorCode;
  isDatabaseContext?: boolean;
  dbOperationCategory?: DatabaseOperationCategory;
  preserveSafeValidationMessage?: boolean;
  reportToServer?: boolean;
  reportToBackend?: boolean;
  notifyGlobalToast?: boolean;
  extraMetadata?: Record<string, unknown>;
}

export interface TechnicalErrorKpis {
  totalErrors: number;
  totalOccurrences: number;
  networkErrors: number;
  databaseErrors: number;
  apiErrors: number;
  authErrors: number;
  unresolvedErrors: number;
  resolvedErrors: number;
}

export interface TechnicalErrorQueryFilters {
  search?: string;
  requestId?: string;
  errorCode?: string;
  category?: string;
  module?: string;
  userId?: string;
  role?: string;
  status?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export interface TechnicalErrorQueryResponse {
  success: boolean;
  kpis: TechnicalErrorKpis;
  availableModules: string[];
  pagination: {
    page: number;
    pageSize: number;
    totalFiltered: number;
    totalPages: number;
  };
  errors: TechnicalErrorLogRecord[];
}

export interface RequestTraceResponse {
  success: boolean;
  referenceId: string;
  totalMatched: number;
  records: TechnicalErrorLogRecord[];
}

type GlobalErrorListener = (err: NormalizedAppError) => void;
const globalErrorListeners = new Set<GlobalErrorListener>();

export function subscribeGlobalAppErrors(listener: GlobalErrorListener): () => void {
  globalErrorListeners.add(listener);
  return () => {
    globalErrorListeners.delete(listener);
  };
}

export function emitGlobalAppError(normalized: NormalizedAppError): void {
  for (const listener of globalErrorListeners) {
    try {
      listener(normalized);
    } catch {
      // Never allow UI notification listeners to throw
    }
  }
}

function getBrowserDeviceSummary(): string {
  if (typeof navigator === 'undefined') return 'Non-Browser Runtime';
  const ua = String(navigator.userAgent || '').trim();
  const online = typeof navigator.onLine === 'boolean' ? (navigator.onLine ? 'Online' : 'Offline') : 'Unknown';
  const platform = String((navigator as any).userAgentData?.platform || navigator.platform || '').trim();
  return sanitizeTextForLog(
    [platform || 'Browser', `Net:${online}`, ua].filter(Boolean).join(' | '),
    210
  );
}

// Track recently reported Reference IDs to prevent duplicate client reports for the exact same failure
const reportedReferenceIds = new Set<string>();
const MAX_REPORTED_CACHE = 200;
let isCurrentlyReporting = false;

async function sendDiagnosticReportNonFatal(
  normalized: NormalizedAppError,
  extraMetadata?: Record<string, unknown>
): Promise<void> {
  if (typeof window === 'undefined') return;
  if (isCurrentlyReporting) return;
  if (reportedReferenceIds.has(normalized.referenceId)) return;
  if (normalized.endpoint?.includes('/api/diagnostics/report')) return;

  // Do not attempt network report if the browser is confirmed offline
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

  const user = auth.currentUser;
  if (!user) return; // Diagnostic ingestion endpoint requires authenticated caller

  reportedReferenceIds.add(normalized.referenceId);
  if (reportedReferenceIds.size > MAX_REPORTED_CACHE) {
    const first = reportedReferenceIds.values().next().value;
    if (first) reportedReferenceIds.delete(first);
  }

  isCurrentlyReporting = true;
  try {
    const token = await user.getIdToken();
    const payload = {
      errorCode: normalized.errorCode,
      moduleName: normalized.moduleName,
      apiEndpoint: normalized.endpoint || 'client://ui',
      httpStatus: normalized.httpStatus,
      requestId: normalized.requestId,
      errorEventId: normalized.errorEventId,
      technicalMessage: normalized.technicalMessage,
      rootCauseConfidence: normalized.rootCauseConfidence,
      rootCauseDetails: normalized.rootCauseDetail,
      exceptionType: normalized.exceptionType,
      browserDeviceInfo: getBrowserDeviceSummary(),
      networkFailureClass: normalized.networkFailureClass,
      dbFailureClass: normalized.dbFailureClass,
      dbOperationCategory: normalized.dbOperationCategory,
      failureStage: normalized.failureStage,
      retryCount: normalized.retryCount,
      extraMetadata: extraMetadata ? sanitizeDiagnosticObject(extraMetadata) : undefined,
    };

    await executeApiFetch(
      apiUrl('/api/diagnostics/report'),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      },
      'POST /api/diagnostics/report',
      {
        timeoutMs: 5000,
        noRetryOnNetworkError: true,
        preferSameOriginInPreview: true,
        skipDiagnosticCapture: true,
      }
    );
  } catch {
    // Diagnostic reporting must ALWAYS be non-fatal and silent
  } finally {
    isCurrentlyReporting = false;
  }
}

/**
 * Central error normalization & diagnostic reporting gateway for the entire frontend.
 * Always returns a sanitized NormalizedAppError with a safe user-facing message,
 * standardized Error Code, and backend Request ID or frontend Error Event ID.
 */
export function handleAppError(
  err: unknown,
  context: HandleAppErrorContext
): NormalizedAppError {
  const anyErr = err as any;
  const isOffline =
    typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean'
      ? !navigator.onLine
      : false;

  const normalized = classifyAndNormalizeError({
    error: err,
    rawMessage:
      anyErr?.technicalDetail ||
      anyErr?.technicalMessage ||
      anyErr?.message ||
      (typeof err === 'string' ? err : undefined),
    httpStatus: typeof anyErr?.status === 'number' ? anyErr.status : null,
    code: anyErr?.errorCode || anyErr?.code || null,
    forcedErrorCode: context.forcedErrorCode,
    moduleName: context.moduleName,
    endpoint: context.endpoint ?? anyErr?.endpoint ?? null,
    isOffline: isOffline || Boolean(anyErr?.isOffline),
    isTimeout: Boolean(anyErr?.isTimeout || anyErr?.name === 'AbortError'),
    isNetworkFetchFailure: Boolean(anyErr?.isNetworkFetchFailure),
    isDatabaseContext: Boolean(context.isDatabaseContext),
    dbOperationCategory: context.dbOperationCategory ?? null,
    requestId: anyErr?.requestId || anyErr?.data?.requestId || null,
    errorEventId: anyErr?.errorEventId || null,
    retryCount: typeof anyErr?.retryCount === 'number' ? anyErr.retryCount : 0,
    preserveSafeValidationMessage: context.preserveSafeValidationMessage !== false,
  });

  const shouldReport =
    context.reportToServer !== false &&
    context.reportToBackend !== false &&
    // Backend already persists 5xx/401/403/404 automatically when a backend requestId exists;
    // still report client-only errors (no backend requestId), DB client SDK errors, and file/QR client failures.
    (normalized.referenceIdSource === 'frontend' ||
      context.isDatabaseContext ||
      normalized.category === 'FILE' ||
      normalized.category === 'QR' ||
      normalized.category === 'NETWORK');

  if (shouldReport) {
    void sendDiagnosticReportNonFatal(normalized, {
      ...(context.extraMetadata || {}),
      ...(context.operation ? { operation: context.operation } : {}),
    });
  }

  if (context.notifyGlobalToast) {
    emitGlobalAppError(normalized);
  }

  return normalized;
}

/**
 * Convenience helper returning a concise, strictly sanitized message with Error Code & Reference ID
 * suitable for inline banners, form alerts, or toast notifications.
 */
export function getSafeErrorText(err: unknown, context: HandleAppErrorContext): string {
  return handleAppError(err, context).safeUserMessage;
}

/**
 * Copies a Reference ID to the clipboard safely without throwing in restricted iframe contexts.
 */
export async function copyReferenceIdToClipboard(referenceId: string): Promise<boolean> {
  if (!referenceId || typeof document === 'undefined') return false;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(referenceId);
      return true;
    }
  } catch {
    // Fallback below
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = referenceId;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

// ============================================================================
// Admin Technical Error Logs API Client (RBAC-Protected Backend Endpoints)
// ============================================================================

async function getRequiredAuthToken(): Promise<string> {
  const user = auth.currentUser;
  if (!user) {
    const e: any = new Error('Session expired');
    e.status = 401;
    e.errorCode = 'AUTH-002';
    throw e;
  }
  return user.getIdToken();
}

export async function fetchTechnicalErrorLogs(
  filters: TechnicalErrorQueryFilters = {}
): Promise<TechnicalErrorQueryResponse> {
  const token = await getRequiredAuthToken();
  const params = new URLSearchParams();
  if (filters.search) params.set('search', filters.search);
  if (filters.requestId) params.set('requestId', filters.requestId);
  if (filters.errorCode && filters.errorCode !== 'ALL') params.set('errorCode', filters.errorCode);
  if (filters.category && filters.category !== 'ALL') params.set('category', filters.category);
  if (filters.module && filters.module !== 'ALL') params.set('module', filters.module);
  if (filters.userId) params.set('userId', filters.userId);
  if (filters.role && filters.role !== 'ALL') params.set('role', filters.role);
  if (filters.status && filters.status !== 'ALL') params.set('status', filters.status);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.page) params.set('page', String(filters.page));
  if (filters.pageSize) params.set('pageSize', String(filters.pageSize));

  const query = params.toString();
  const path = `/api/diagnostics/errors${query ? `?${query}` : ''}`;
  const res = await executeApiFetch(
    apiUrl(path),
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    },
    'GET /api/diagnostics/errors',
    { preferSameOriginInPreview: true, timeoutMs: 12000 }
  );
  return parseApiJsonOrThrow<TechnicalErrorQueryResponse>(
    res,
    'Unable to load technical error logs.',
    'GET /api/diagnostics/errors'
  );
}

export async function fetchRequestTrace(referenceId: string): Promise<RequestTraceResponse> {
  const token = await getRequiredAuthToken();
  const cleanRef = encodeURIComponent(referenceId.trim());
  const path = `/api/diagnostics/trace/${cleanRef}`;
  const res = await executeApiFetch(
    apiUrl(path),
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    },
    'GET /api/diagnostics/trace',
    { preferSameOriginInPreview: true, timeoutMs: 10000 }
  );
  return parseApiJsonOrThrow<RequestTraceResponse>(
    res,
    'Unable to look up Request ID trace.',
    'GET /api/diagnostics/trace'
  );
}

export async function updateTechnicalErrorStatus(
  errorId: string,
  payload: { resolutionStatus: ErrorResolutionStatus; resolutionNotes?: string }
): Promise<{ success: boolean; errorRecord: TechnicalErrorLogRecord }> {
  const token = await getRequiredAuthToken();
  const path = `/api/diagnostics/errors/${encodeURIComponent(errorId)}/status`;
  const res = await executeApiFetch(
    apiUrl(path),
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    },
    'PATCH /api/diagnostics/errors/status',
    { preferSameOriginInPreview: true, timeoutMs: 10000 }
  );
  return parseApiJsonOrThrow<{ success: boolean; errorRecord: TechnicalErrorLogRecord }>(
    res,
    'Unable to update technical error status.',
    'PATCH /api/diagnostics/errors/status'
  );
}

export type {
  ErrorCategory,
  ErrorResolutionStatus,
  NormalizedAppError,
  StandardErrorCode,
  TechnicalErrorLogRecord,
};
