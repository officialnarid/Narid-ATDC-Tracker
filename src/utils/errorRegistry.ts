/**
 * Centralized Standardized Error Code Registry, Evidence-Based Classifier,
 * Secret/PII Sanitizer, and Cryptographic Reference ID Formatter.
 *
 * Shared across Frontend and Backend to ensure a single source of truth
 * for safe user-facing errors and structured Admin Technical Diagnostic Logs.
 */

export type StandardErrorCode =
  | 'NET-001'
  | 'NET-002'
  | 'DB-001'
  | 'DB-002'
  | 'AUTH-001'
  | 'AUTH-002'
  | 'PERM-001'
  | 'API-001'
  | 'SYS-001'
  | 'FILE-001'
  | 'FILE-002'
  | 'QR-001'
  | 'ATT-001'
  | 'VAL-001'
  | 'SYS-999';

export type ErrorCategory =
  | 'NETWORK'
  | 'DATABASE'
  | 'AUTH'
  | 'PERMISSION'
  | 'API'
  | 'SYSTEM'
  | 'FILE'
  | 'QR'
  | 'ATTENDANCE'
  | 'VALIDATION'
  | 'UNKNOWN';

export type RootCauseConfidence = 'CONFIRMED' | 'SUSPECTED' | 'UNKNOWN';

export type NetworkFailureClassification =
  | 'INTERNET_DISCONNECTED'
  | 'REQUEST_TIMEOUT'
  | 'DNS_OR_CONNECTION_FAILURE'
  | 'SERVER_UNREACHABLE'
  | 'UPSTREAM_GATEWAY_502_503_504'
  | 'CORS_OR_PREFLIGHT_FAILURE'
  | 'UNKNOWN_NETWORK_REQUEST_FAILURE'
  | 'NONE';

export type DatabaseFailureClassification =
  | 'FIRESTORE_UNAVAILABLE'
  | 'DATABASE_CONNECTION_FAILURE'
  | 'PERMISSION_DENIED'
  | 'TRANSACTION_ABORTED'
  | 'READ_FAILURE'
  | 'WRITE_FAILURE'
  | 'TIMEOUT'
  | 'NONE';

export type DatabaseOperationCategory = 'read' | 'write' | 'transaction' | 'connection' | null;

export type FailureStage =
  | 'BEFORE_BACKEND'
  | 'BACKEND_PROCESSING'
  | 'DATABASE'
  | 'CLIENT_RUNTIME';

export type ErrorResolutionStatus = 'OPEN' | 'INVESTIGATING' | 'RESOLVED';

export type RequestLifecycleStage =
  | 'REQUEST_RECEIVED'
  | 'AUTH_VERIFIED'
  | 'AUTHORIZATION_CHECKED'
  | 'PROCESSING_STARTED'
  | 'DB_OPERATION_STARTED'
  | 'DB_OPERATION_COMPLETED'
  | 'DB_OPERATION_FAILED'
  | 'RESPONSE_SENT';

export interface RequestLifecycleEvent {
  stage: RequestLifecycleStage;
  timestampUtc: string;
  elapsedMs: number;
  detail?: string;
}

export interface ErrorCodeDefinition {
  code: StandardErrorCode;
  category: ErrorCategory;
  categoryLabel: string;
  userTitle: string;
  defaultAction: string;
  retryable: boolean;
  securityCritical?: boolean;
}

export const ERROR_CODE_REGISTRY: Record<StandardErrorCode, ErrorCodeDefinition> = {
  'NET-001': {
    code: 'NET-001',
    category: 'NETWORK',
    categoryLabel: 'Network Connectivity',
    userTitle: 'Network Issue',
    defaultAction: 'Please check your internet connection and try again.',
    retryable: true,
  },
  'NET-002': {
    code: 'NET-002',
    category: 'NETWORK',
    categoryLabel: 'Network Timeout',
    userTitle: 'Connection Timed Out',
    defaultAction: 'The request took too long to complete. Please try again.',
    retryable: true,
  },
  'DB-001': {
    code: 'DB-001',
    category: 'DATABASE',
    categoryLabel: 'Database Connectivity',
    userTitle: 'Database Connectivity Issue',
    defaultAction: 'Unable to reach the database right now. Please try again shortly.',
    retryable: true,
  },
  'DB-002': {
    code: 'DB-002',
    category: 'DATABASE',
    categoryLabel: 'Database Operation Failed',
    userTitle: 'Data Processing Issue',
    defaultAction: 'Unable to complete the requested operation. Please try again.',
    retryable: true,
  },
  'AUTH-001': {
    code: 'AUTH-001',
    category: 'AUTH',
    categoryLabel: 'Authentication Failed',
    userTitle: 'Authentication Failed',
    defaultAction: 'Please check your credentials and try signing in again.',
    retryable: false,
    securityCritical: true,
  },
  'AUTH-002': {
    code: 'AUTH-002',
    category: 'AUTH',
    categoryLabel: 'Session Expired',
    userTitle: 'Session Expired',
    defaultAction: 'Please sign in again to continue.',
    retryable: false,
    securityCritical: true,
  },
  'PERM-001': {
    code: 'PERM-001',
    category: 'PERMISSION',
    categoryLabel: 'Permission Denied',
    userTitle: 'Access Denied',
    defaultAction: 'You do not have permission to perform this action.',
    retryable: false,
    securityCritical: true,
  },
  'API-001': {
    code: 'API-001',
    category: 'API',
    categoryLabel: 'API Request Failed',
    userTitle: 'Service Request Failed',
    defaultAction: 'Unable to complete your request right now. Please try again.',
    retryable: true,
  },
  'SYS-001': {
    code: 'SYS-001',
    category: 'SYSTEM',
    categoryLabel: 'Server Unavailable',
    userTitle: 'Service Temporarily Unavailable',
    defaultAction: 'The service is temporarily unavailable. Please try again in a moment.',
    retryable: true,
  },
  'FILE-001': {
    code: 'FILE-001',
    category: 'FILE',
    categoryLabel: 'File Upload Failed',
    userTitle: 'File Upload Failed',
    defaultAction: 'Please verify the file format and try uploading again.',
    retryable: true,
  },
  'FILE-002': {
    code: 'FILE-002',
    category: 'FILE',
    categoryLabel: 'File Download Failed',
    userTitle: 'File Download Failed',
    defaultAction: 'Unable to generate or download the file. Please try again.',
    retryable: true,
  },
  'QR-001': {
    code: 'QR-001',
    category: 'QR',
    categoryLabel: 'QR Scanning Failed',
    userTitle: 'QR Scanning Issue',
    defaultAction: 'Please re-scan the employee QR card and try again.',
    retryable: true,
  },
  'ATT-001': {
    code: 'ATT-001',
    category: 'ATTENDANCE',
    categoryLabel: 'Attendance Operation Failed',
    userTitle: 'Attendance Operation Failed',
    defaultAction: 'Unable to record attendance right now. Please verify and try again.',
    retryable: true,
  },
  'VAL-001': {
    code: 'VAL-001',
    category: 'VALIDATION',
    categoryLabel: 'Data Validation Failed',
    userTitle: 'Invalid Input',
    defaultAction: 'Please check the entered details and try again.',
    retryable: false,
  },
  'SYS-999': {
    code: 'SYS-999',
    category: 'UNKNOWN',
    categoryLabel: 'Unknown Unexpected Error',
    userTitle: 'Something went wrong',
    defaultAction: 'An unexpected issue occurred. Please try again or contact your administrator.',
    retryable: true,
  },
};

export function getErrorDefinition(code: StandardErrorCode | string | undefined): ErrorCodeDefinition {
  if (code && code in ERROR_CODE_REGISTRY) {
    return ERROR_CODE_REGISTRY[code as StandardErrorCode];
  }
  return ERROR_CODE_REGISTRY['SYS-999'];
}

export interface NormalizedAppError {
  errorCode: StandardErrorCode;
  category: ErrorCategory;
  categoryLabel: string;
  userTitle: string;
  shortLabel: string;
  userAction: string;
  safeUserMessage: string;
  referenceId: string;
  referenceIdSource: 'backend' | 'frontend';
  requestId: string | null;
  errorEventId: string | null;
  moduleName: string;
  endpoint: string | null;
  httpStatus: number | null;
  technicalMessage: string;
  rootCauseConfidence: RootCauseConfidence;
  rootCauseDetail: string;
  exceptionType: string;
  networkFailureClass: NetworkFailureClassification;
  dbFailureClass: DatabaseFailureClassification;
  dbOperationCategory: DatabaseOperationCategory;
  failureStage: FailureStage;
  retryCount: number;
  retryable: boolean;
  timestampUtc: string;
  timestampIst: string;
}

export interface TechnicalErrorOccurrence {
  requestId: string | null;
  errorEventId: string | null;
  timestampUtc: string;
  timestampIst: string;
  userUid: string;
  userLoginId: string;
  userRole: string;
  httpStatus: number | null;
  retryCount: number;
}

export interface TechnicalErrorLogRecord {
  errorId: string;
  fingerprint: string;
  errorCode: StandardErrorCode;
  errorCategory: ErrorCategory;
  errorCategoryLabel: string;
  timestampUtc: string;
  timestampIst: string;
  lastSeenAtUtc: string;
  lastSeenAtIst: string;
  affectedUserUid: string;
  affectedUserLoginId: string;
  userRole: string;
  moduleName: string;
  apiEndpoint: string;
  httpStatus: number | null;
  requestId: string | null;
  errorEventId: string | null;
  referenceId: string;
  referenceIdSource: 'backend' | 'frontend';
  correlationUuid: string | null;
  relatedRequestIds: string[];
  technicalMessage: string;
  rootCauseConfidence: RootCauseConfidence;
  rootCauseDetails: string;
  exceptionType: string;
  browserDeviceInfo: string;
  networkFailureClass: NetworkFailureClassification;
  dbFailureClass: DatabaseFailureClassification;
  dbOperationCategory: DatabaseOperationCategory;
  dbCollectionSafe: string | null;
  failureStage: FailureStage;
  retryCount: number;
  transactionRetryCount: number | null;
  occurrenceCount: number;
  occurrences: TechnicalErrorOccurrence[];
  lifecycleEvents: RequestLifecycleEvent[];
  resolutionStatus: ErrorResolutionStatus;
  resolvedBy: string | null;
  resolvedAtUtc: string | null;
  resolvedAtIst: string | null;
  resolutionNotes: string;
  environment: 'preview' | 'production' | 'test';
}

// ============================================================================
// Timestamp Helpers (IST + UTC)
// ============================================================================

export function formatUtcAndIstTimestamps(dateInput: Date | number = new Date()): {
  utc: string;
  ist: string;
  dateCompactIst: string;
} {
  const date = typeof dateInput === 'number' ? new Date(dateInput) : dateInput;
  const utc = date.toISOString();
  // Asia/Kolkata is fixed UTC+05:30 with no DST
  const istMs = date.getTime() + 330 * 60 * 1000;
  const istDate = new Date(istMs);
  const y = istDate.getUTCFullYear();
  const m = String(istDate.getUTCMonth() + 1).padStart(2, '0');
  const d = String(istDate.getUTCDate()).padStart(2, '0');
  const hh = String(istDate.getUTCHours()).padStart(2, '0');
  const mm = String(istDate.getUTCMinutes()).padStart(2, '0');
  const ss = String(istDate.getUTCSeconds()).padStart(2, '0');
  const ms = String(istDate.getUTCMilliseconds()).padStart(3, '0');
  return {
    utc,
    ist: `${y}-${m}-${d} ${hh}:${mm}:${ss}.${ms} IST`,
    dateCompactIst: `${y}${m}${d}`,
  };
}

// ============================================================================
// Cryptographic Reference ID Helpers (REQ-* for backend, ERR-* for frontend)
// ============================================================================

function randomHexFromWebOrFallback(byteLen: number): string {
  const g = globalThis as any;
  if (g?.crypto && typeof g.crypto.getRandomValues === 'function') {
    const arr = new Uint8Array(byteLen);
    g.crypto.getRandomValues(arr);
    return Array.from(arr)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
  }
  if (g?.crypto && typeof g.crypto.randomUUID === 'function') {
    return String(g.crypto.randomUUID()).replace(/-/g, '').slice(0, byteLen * 2).toUpperCase();
  }
  let out = '';
  for (let i = 0; i < byteLen * 2; i++) {
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return out.toUpperCase();
}

export function generateFrontendErrorEventId(now: Date = new Date()): string {
  const { dateCompactIst } = formatUtcAndIstTimestamps(now);
  return `ERR-${dateCompactIst}-${randomHexFromWebOrFallback(6)}`;
}

export function isValidReferenceId(val: unknown): val is string {
  if (typeof val !== 'string') return false;
  return /^(?:REQ|ERR)-\d{8}-[A-F0-9]{8,24}$/.test(val.trim());
}

// ============================================================================
// Security & Privacy Sanitization (Prevents Token/Secret Leakage & Log Injection)
// ============================================================================

const SENSITIVE_KEY_PATTERN =
  /(?:password|passwd|pwd|secret|token|idtoken|refreshtoken|apikey|api_key|privatekey|private_key|authorization|cookie|pin|masterpin|credential|sessionsecret|rawbody|service_account)/i;

const SECRET_VALUE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // Bearer / JWT tokens
  { pattern: /Bearer\s+[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/gi, replacement: 'Bearer [REDACTED_TOKEN]' },
  { pattern: /Bearer\s+[A-Za-z0-9\-_.~+/]+=*/gi, replacement: 'Bearer [REDACTED_TOKEN]' },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: '[REDACTED_JWT]' },
  // Google / Firebase API keys & PEM private keys
  { pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/g, replacement: '[REDACTED_API_KEY]' },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: '[REDACTED_PRIVATE_KEY]' },
  // Inline key=value or "key":"value" secret patterns
  {
    pattern: /(["']?(?:password|passwd|pwd|pin|masterPin|idToken|refreshToken|token|apiKey|api_key|secret|private_key|authorization|cookie)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,&;}\]]+)/gi,
    replacement: '$1[REDACTED]',
  },
  // URL query parameter secrets (?key=..., &token=...)
  {
    pattern: /([?&](?:key|token|idToken|refreshToken|password|secret|pin|auth)=)[^&\s]+/gi,
    replacement: '$1[REDACTED]',
  },
];

/**
 * Strips CR/LF/control chars (log injection defense) and redacts secrets/tokens/passwords/PINs.
 */
export function sanitizeTextForLog(raw: unknown, maxLength = 800): string {
  if (raw === null || raw === undefined) return '';
  let text = typeof raw === 'string' ? raw : String(raw);
  // Strip control characters, newlines, and ANSI escape sequences (prevents log forging / injection)
  text = text
    .replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  for (const rule of SECRET_VALUE_PATTERNS) {
    text = text.replace(rule.pattern, rule.replacement);
  }

  if (text.length > maxLength) {
    return `${text.slice(0, maxLength - 3)}...`;
  }
  return text;
}

export function sanitizeDiagnosticObject(
  input: unknown,
  depth = 0
): Record<string, unknown> | unknown {
  if (depth > 4) return '[TRUNCATED]';
  if (input === null || input === undefined) return null;
  if (typeof input === 'string') return sanitizeTextForLog(input, 400);
  if (typeof input === 'number' || typeof input === 'boolean') return input;
  if (Array.isArray(input)) {
    return input.slice(0, 20).map((item) => sanitizeDiagnosticObject(item, depth + 1));
  }
  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>).slice(0, 30)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = sanitizeDiagnosticObject(v, depth + 1);
      }
    }
    return out;
  }
  return sanitizeTextForLog(String(input), 200);
}

/**
 * Detects whether a message leaks raw technical details that must NEVER appear in user-facing UI.
 */
export function containsRawTechnicalLeak(message: string): boolean {
  if (!message) return false;
  const patterns: RegExp[] = [
    /https?:\/\//i,
    /\/api\/[a-z0-9_/-]+/i,
    /\bvercel\.app\b/i,
    /\brun\.app\b/i,
    /\blocalhost(?::\d+)?\b/i,
    /\b127\.0\.0\.1\b/i,
    /\bfirebase(?:error|admin)?\b/i,
    /\bfirestore\b/i,
    /\bidentitytoolkit\b/i,
    /\bpermission_denied\b/i,
    /\bmissing or insufficient permissions\b/i,
    /\bfailed to fetch\b/i,
    /\bnetworkerror\b/i,
    /\bload failed\b/i,
    /\btypeerror\b|\bsyntaxerror\b|\breferenceerror\b|\brangeerror\b/i,
    /\beconnrefused\b|\benotfound\b|\betimedout\b|\beconnreset\b/i,
    /\bserverless\b|\bvercel\.json\b|\bexpress\b|\bport 3000\b/i,
    /\bvite_[a-z0-9_]+\b|\bprocess\.env\b|\bfirebase_service_account/i,
    /\btext\/html\b|\bapplication\/json\b|\bnon-json\b|\bindex\.html\b|\bwarmup\b/i,
    /<!doctype\s+html/i,
    /<\/?(?:html|head|body|script|title)\b/i,
    /\b50[234]\s+(?:bad gateway|service unavailable|gateway timeout)\b|\bbad gateway\b/i,
    /\bhttp\s+[45]\d\d\b/i,
    /\bat\s+[A-Za-z0-9_$.]+\s*\([^)]+:\d+:\d+\)/, // Stack frame
    /\b(?:user_roles|user_uid_index|punch_logs|punch_events|shift_rosters|account_security|audit_logs|technical_error_logs|company_wifi_networks)\b/i,
    /\bquota exceeded\b|\bresource_exhausted\b|\bdeadline_exceeded\b|\b(?:code=|firestore\/)unavailable\b/i,
  ];
  return patterns.some((rx) => rx.test(message));
}

// ============================================================================
// Evidence-Based Error Classification Engine
// ============================================================================

export interface ClassifyErrorInput {
  error?: unknown;
  rawMessage?: string;
  httpStatus?: number | null;
  code?: string | null;
  forcedErrorCode?: StandardErrorCode;
  moduleName?: string;
  endpoint?: string | null;
  isOffline?: boolean;
  isTimeout?: boolean;
  isNetworkFetchFailure?: boolean;
  isDatabaseContext?: boolean;
  dbOperationCategory?: DatabaseOperationCategory;
  requestId?: string | null;
  errorEventId?: string | null;
  retryCount?: number;
  preserveSafeValidationMessage?: boolean;
}

function detectFirebaseErrorCode(err: unknown, rawText: string): string {
  const anyErr = err as any;
  const directCode = String(anyErr?.code || anyErr?.errorInfo?.code || '').toLowerCase();
  if (directCode) return directCode;
  const match = rawText.match(/\b((?:auth|firestore|storage|functions)\/[a-z0-9-]+)\b/i);
  if (match) return match[1].toLowerCase();
  return '';
}

function isFirestoreConnectivitySignal(fbCode: string, lower: string, numericCode?: unknown): boolean {
  if (
    fbCode === 'unavailable' ||
    fbCode === 'firestore/unavailable' ||
    fbCode === 'deadline-exceeded' ||
    fbCode === 'firestore/deadline-exceeded' ||
    numericCode === 14 ||
    numericCode === 4
  ) {
    return true;
  }
  return (
    /firestore.*(?:unavailable|offline|connection|could not reach|deadline|timeout)/i.test(lower) ||
    /client is offline/i.test(lower) ||
    /firebase_admin_unconfigured/i.test(lower) ||
    /failed to get document because the client is offline/i.test(lower)
  );
}

function isFirestoreOperationSignal(fbCode: string, lower: string, numericCode?: unknown): boolean {
  if (
    fbCode === 'aborted' ||
    fbCode === 'firestore/aborted' ||
    fbCode === 'failed-precondition' ||
    fbCode === 'firestore/failed-precondition' ||
    fbCode === 'resource-exhausted' ||
    fbCode === 'firestore/resource-exhausted' ||
    fbCode === 'data-loss' ||
    fbCode === 'firestore/data-loss' ||
    numericCode === 10 ||
    numericCode === 9 ||
    numericCode === 8
  ) {
    return true;
  }
  return (
    /firestore.*(?:permission|transaction|aborted|write|read|index|quota)/i.test(lower) ||
    /missing or insufficient permissions/i.test(lower) ||
    /transaction.*aborted/i.test(lower) ||
    /no document to update/i.test(lower)
  );
}

export function classifyAndNormalizeError(input: ClassifyErrorInput): NormalizedAppError {
  const errObj = input.error as any;
  const rawMessage = String(
    input.rawMessage ||
      errObj?.technicalMessage ||
      errObj?.technicalDetail ||
      errObj?.message ||
      (typeof input.error === 'string' ? input.error : '') ||
      'Unexpected error'
  );
  const lower = rawMessage.toLowerCase();
  const httpStatus =
    typeof input.httpStatus === 'number'
      ? input.httpStatus
      : typeof errObj?.status === 'number'
      ? errObj.status
      : null;
  const apiCode = String(input.code || errObj?.code || errObj?.errorCode || '').trim();
  const upperCode = apiCode.toUpperCase();
  const fbCode = detectFirebaseErrorCode(input.error, rawMessage);
  const exceptionType = sanitizeTextForLog(
    errObj?.name || (typeof input.error === 'object' && input.error ? input.error.constructor?.name : 'Error') || 'Error',
    80
  );
  const moduleName = sanitizeTextForLog(input.moduleName || 'Application', 80) || 'Application';
  const endpoint = input.endpoint ? sanitizeTextForLog(input.endpoint, 160) : null;
  const retryCount = Math.max(0, Math.floor(Number(input.retryCount ?? errObj?.retryCount ?? 0) || 0));

  const backendReqId =
    isValidReferenceId(input.requestId)
      ? input.requestId
      : isValidReferenceId(errObj?.requestId)
      ? String(errObj.requestId)
      : null;

  const existingFrontendId =
    isValidReferenceId(input.errorEventId)
      ? input.errorEventId
      : isValidReferenceId(errObj?.errorEventId)
      ? String(errObj.errorEventId)
      : null;

  const referenceIdSource: 'backend' | 'frontend' = backendReqId ? 'backend' : 'frontend';
  const errorEventId = backendReqId ? existingFrontendId : existingFrontendId || generateFrontendErrorEventId();
  const referenceId = backendReqId || errorEventId!;

  const { utc: timestampUtc, ist: timestampIst } = formatUtcAndIstTimestamps();
  const sanitizedTechnical = sanitizeTextForLog(rawMessage, 900);

  let errorCode: StandardErrorCode = 'SYS-999';
  let rootCauseConfidence: RootCauseConfidence = 'UNKNOWN';
  let rootCauseDetail = 'Root cause could not be conclusively established from available error telemetry.';
  let networkFailureClass: NetworkFailureClassification = 'NONE';
  let dbFailureClass: DatabaseFailureClassification = 'NONE';
  let dbOperationCategory: DatabaseOperationCategory = input.dbOperationCategory ?? null;
  let failureStage: FailureStage = backendReqId ? 'BACKEND_PROCESSING' : 'CLIENT_RUNTIME';

  // 0. If backend already assigned a valid standardized Error Code, respect it unless more specific
  if (upperCode in ERROR_CODE_REGISTRY) {
    errorCode = upperCode as StandardErrorCode;
  }

  // 1. Offline / Client-side Timeout / Fetch Failures (NEVER falsely label "Failed to fetch" as DB-001!)
  const looksLikeFetchFail =
    Boolean(input.isNetworkFetchFailure) ||
    lower.includes('failed to fetch') ||
    lower.includes('networkerror when attempting to fetch') ||
    lower.includes('load failed') ||
    lower.includes('unable to reach') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('net::err_');

  const looksLikeTimeout =
    Boolean(input.isTimeout) ||
    errObj?.name === 'AbortError' ||
    httpStatus === 408 ||
    httpStatus === 504 ||
    lower.includes('timed out') ||
    lower.includes('timeout') ||
    lower.includes('etimedout');

  if (input.isOffline === true) {
    errorCode = 'NET-001';
    networkFailureClass = 'INTERNET_DISCONNECTED';
    rootCauseConfidence = 'CONFIRMED';
    rootCauseDetail = 'Browser navigator.onLine reported offline state before request could reach the server.';
    failureStage = 'BEFORE_BACKEND';
  } else if (looksLikeTimeout && !isFirestoreConnectivitySignal(fbCode, lower, errObj?.code)) {
    errorCode = 'NET-002';
    networkFailureClass = httpStatus === 504 ? 'UPSTREAM_GATEWAY_502_503_504' : 'REQUEST_TIMEOUT';
    rootCauseConfidence = 'CONFIRMED';
    rootCauseDetail =
      httpStatus === 504
        ? 'Gateway timeout (HTTP 504) returned while awaiting backend completion.'
        : 'Client or network request exceeded the configured timeout threshold.';
    failureStage = httpStatus === 504 ? 'BACKEND_PROCESSING' : 'BEFORE_BACKEND';
  } else if (looksLikeFetchFail && (httpStatus === null || httpStatus === 0)) {
    errorCode = 'NET-001';
    failureStage = 'BEFORE_BACKEND';
    if (lower.includes('cors') || lower.includes('preflight')) {
      networkFailureClass = 'CORS_OR_PREFLIGHT_FAILURE';
      rootCauseConfidence = 'SUSPECTED';
      rootCauseDetail = 'Browser blocked or failed cross-origin preflight/CORS fetch before backend response was readable.';
    } else if (lower.includes('enotfound') || lower.includes('err_name_not_resolved') || lower.includes('econnrefused')) {
      networkFailureClass = 'DNS_OR_CONNECTION_FAILURE';
      rootCauseConfidence = 'CONFIRMED';
      rootCauseDetail = 'DNS resolution or TCP connection failed prior to reaching the backend service.';
    } else {
      networkFailureClass = 'UNKNOWN_NETWORK_REQUEST_FAILURE';
      rootCauseConfidence = 'UNKNOWN';
      rootCauseDetail =
        'Unknown Network/Request Failure: browser fetch failed before receiving an HTTP response. This does not confirm a database outage.';
    }
  }
  // 2. Verified Database / Firestore Errors
  else if (isFirestoreConnectivitySignal(fbCode, lower, errObj?.code)) {
    errorCode = 'DB-001';
    dbFailureClass = fbCode.includes('deadline') || lower.includes('timeout')
      ? 'TIMEOUT'
      : lower.includes('unavailable') || fbCode.includes('unavailable')
      ? 'FIRESTORE_UNAVAILABLE'
      : 'DATABASE_CONNECTION_FAILURE';
    dbOperationCategory = dbOperationCategory || 'connection';
    rootCauseConfidence = 'CONFIRMED';
    rootCauseDetail = `Verified Firestore connectivity failure (${fbCode || 'unavailable'}).`;
    failureStage = 'DATABASE';
  } else if (isFirestoreOperationSignal(fbCode, lower, errObj?.code) || (input.isDatabaseContext && !httpStatus)) {
    errorCode = 'DB-002';
    if (fbCode.includes('permission') || lower.includes('insufficient permissions')) {
      dbFailureClass = 'PERMISSION_DENIED';
    } else if (fbCode.includes('aborted') || lower.includes('aborted')) {
      dbFailureClass = 'TRANSACTION_ABORTED';
      dbOperationCategory = dbOperationCategory || 'transaction';
    } else if (dbOperationCategory === 'write') {
      dbFailureClass = 'WRITE_FAILURE';
    } else if (dbOperationCategory === 'read') {
      dbFailureClass = 'READ_FAILURE';
    } else {
      dbFailureClass = 'WRITE_FAILURE';
    }
    rootCauseConfidence =
      fbCode || dbFailureClass === 'TRANSACTION_ABORTED' || dbFailureClass === 'PERMISSION_DENIED'
        ? 'CONFIRMED'
        : 'SUSPECTED';
    rootCauseDetail = `Database operation failed during ${dbOperationCategory || 'query/mutation'} (${fbCode || exceptionType}).`;
    failureStage = 'DATABASE';
  }
  // 3. Authentication & Session Failures
  else if (
    httpStatus === 401 ||
    fbCode === 'auth/id-token-expired' ||
    fbCode === 'auth/id-token-revoked' ||
    fbCode === 'auth/user-token-expired' ||
    upperCode === 'SESSION_EXPIRED' ||
    lower.includes('session expired') ||
    lower.includes('token expired') ||
    lower.includes('revoked') ||
    lower.includes('sign in again')
  ) {
    const isSessionExpired =
      fbCode.includes('expired') ||
      fbCode.includes('revoked') ||
      lower.includes('expired') ||
      lower.includes('revoked') ||
      lower.includes('session') ||
      (httpStatus === 401 && !endpoint?.includes('/auth/login'));
    errorCode = isSessionExpired ? 'AUTH-002' : 'AUTH-001';
    rootCauseConfidence = 'CONFIRMED';
    rootCauseDetail = isSessionExpired
      ? 'Authentication session token is expired, missing, or revoked.'
      : 'Authentication credentials or identity verification failed.';
    failureStage = backendReqId || httpStatus ? 'BACKEND_PROCESSING' : 'CLIENT_RUNTIME';
  } else if (
    fbCode.startsWith('auth/') ||
    upperCode.includes('LOCKED') ||
    upperCode.includes('AUTH') ||
    endpoint?.includes('/api/auth/login')
  ) {
    errorCode = 'AUTH-001';
    rootCauseConfidence = 'CONFIRMED';
    rootCauseDetail = `Authentication rejected (${fbCode || upperCode || `HTTP ${httpStatus || 401}`}).`;
    failureStage = httpStatus ? 'BACKEND_PROCESSING' : 'CLIENT_RUNTIME';
  }
  // 4. Permission / RBAC / Company Wi-Fi Policy Denial
  else if (
    httpStatus === 403 ||
    upperCode === 'COMPANY_WIFI_ACCESS_DENIED' ||
    upperCode === 'CORS_ORIGIN_FORBIDDEN' ||
    fbCode === 'permission-denied' ||
    fbCode === 'firestore/permission-denied'
  ) {
    errorCode = 'PERM-001';
    rootCauseConfidence = 'CONFIRMED';
    rootCauseDetail =
      upperCode === 'COMPANY_WIFI_ACCESS_DENIED'
        ? 'Request denied by Company Wi-Fi Access Control policy.'
        : upperCode === 'CORS_ORIGIN_FORBIDDEN'
        ? 'Request blocked by backend CORS origin allowlist.'
        : 'Caller lacks required role or module permission for this operation.';
    failureStage = 'BACKEND_PROCESSING';
  }
  // 5. Upstream Gateway / Server Unavailable (502, 503, 504)
  else if (httpStatus === 502 || httpStatus === 503) {
    errorCode = 'SYS-001';
    networkFailureClass = 'UPSTREAM_GATEWAY_502_503_504';
    rootCauseConfidence = 'CONFIRMED';
    rootCauseDetail = `Backend or upstream proxy returned HTTP ${httpStatus} (Service Unavailable / Bad Gateway).`;
    failureStage = 'BACKEND_PROCESSING';
  }
  // 6. Domain-Specific Module Errors (QR, Attendance, File Upload/Download, Validation)
  else if (httpStatus === 400 || httpStatus === 422 || upperCode === 'INVALID_JSON_BODY') {
    if (moduleName.toLowerCase().includes('qr') || endpoint?.includes('/qr')) {
      errorCode = 'QR-001';
    } else if (moduleName.toLowerCase().includes('import') || lower.includes('excel') || lower.includes('upload')) {
      errorCode = 'FILE-001';
    } else {
      errorCode = 'VAL-001';
    }
    rootCauseConfidence = 'CONFIRMED';
    rootCauseDetail = `Request failed validation with HTTP ${httpStatus || 400}.`;
    failureStage = 'BACKEND_PROCESSING';
  } else if (httpStatus && httpStatus >= 500) {
    if (moduleName.toLowerCase().includes('attendance') || endpoint?.includes('/attendance')) {
      errorCode = 'ATT-001';
    } else {
      errorCode = 'API-001';
    }
    rootCauseConfidence = 'SUSPECTED';
    rootCauseDetail = `Backend endpoint returned HTTP ${httpStatus} internal processing error.`;
    failureStage = 'BACKEND_PROCESSING';
  } else if (httpStatus && httpStatus >= 400) {
    if (moduleName.toLowerCase().includes('attendance') || endpoint?.includes('/attendance')) {
      errorCode = 'ATT-001';
    } else if (moduleName.toLowerCase().includes('qr')) {
      errorCode = 'QR-001';
    } else {
      errorCode = 'API-001';
    }
    rootCauseConfidence = 'CONFIRMED';
    rootCauseDetail = `API request rejected with HTTP ${httpStatus}.`;
    failureStage = 'BACKEND_PROCESSING';
  } else if (input.forcedErrorCode && input.forcedErrorCode in ERROR_CODE_REGISTRY) {
    errorCode = input.forcedErrorCode;
    rootCauseConfidence = 'SUSPECTED';
    rootCauseDetail = `Module-classified ${errorCode} failure in ${moduleName}.`;
    if (errorCode === 'DB-001') {
      dbFailureClass = 'DATABASE_CONNECTION_FAILURE';
      dbOperationCategory = dbOperationCategory || 'connection';
      failureStage = 'DATABASE';
    } else if (errorCode === 'DB-002') {
      dbFailureClass = dbOperationCategory === 'read' ? 'READ_FAILURE' : 'WRITE_FAILURE';
      failureStage = 'DATABASE';
    }
  } else if (moduleName.toLowerCase().includes('export') || lower.includes('download') || lower.includes('xlsx')) {
    errorCode = 'FILE-002';
    rootCauseConfidence = 'SUSPECTED';
    rootCauseDetail = 'Client-side file generation or export operation failed.';
    failureStage = 'CLIENT_RUNTIME';
  } else if (moduleName.toLowerCase().includes('import') || lower.includes('upload')) {
    errorCode = 'FILE-001';
    rootCauseConfidence = 'SUSPECTED';
    rootCauseDetail = 'File parsing or upload operation failed.';
    failureStage = 'CLIENT_RUNTIME';
  } else if (moduleName.toLowerCase().includes('qr')) {
    errorCode = 'QR-001';
    rootCauseConfidence = 'SUSPECTED';
    rootCauseDetail = 'QR processing or camera scanning encountered an error.';
    failureStage = 'CLIENT_RUNTIME';
  } else if (moduleName.toLowerCase().includes('attendance') || moduleName.toLowerCase().includes('scanner')) {
    errorCode = 'ATT-001';
    rootCauseConfidence = 'SUSPECTED';
    rootCauseDetail = 'Attendance operation failed during client or server execution.';
  } else {
    errorCode = 'SYS-999';
    rootCauseConfidence = 'UNKNOWN';
    rootCauseDetail = 'Unexpected error occurred; exact root cause could not be automatically verified.';
  }

  // Preserve authoritative standardized errorCode returned directly by the backend
  if (backendReqId && upperCode in ERROR_CODE_REGISTRY) {
    errorCode = upperCode as StandardErrorCode;
  }

  const def = ERROR_CODE_REGISTRY[errorCode];

  // Decide safe user-facing message:
  // Preserve short, clean business/field-level validation messages ONLY when they contain zero raw technical leaks.
  const canPreserveBusinessMsg =
    (input.preserveSafeValidationMessage !== false &&
      (errorCode === 'VAL-001' ||
        errorCode === 'AUTH-001' ||
        errorCode === 'PERM-001' ||
        errorCode === 'ATT-001' ||
        errorCode === 'QR-001') &&
      rawMessage.trim().length > 0 &&
      rawMessage.trim().length <= 180 &&
      !containsRawTechnicalLeak(rawMessage)) ||
    upperCode === 'COMPANY_WIFI_ACCESS_DENIED';

  const userAction = canPreserveBusinessMsg
    ? sanitizeTextForLog(rawMessage, 180)
    : def.defaultAction;

  const shortLabel = `${def.userTitle} – Error Code: ${def.code}`;
  const safeUserMessage = canPreserveBusinessMsg
    ? `${userAction} (Error Code: ${def.code} | Ref: ${referenceId})`
    : `${shortLabel}. ${def.defaultAction} (Ref: ${referenceId})`;

  return {
    errorCode: def.code,
    category: def.category,
    categoryLabel: def.categoryLabel,
    userTitle: def.userTitle,
    shortLabel,
    userAction,
    safeUserMessage,
    referenceId,
    referenceIdSource,
    requestId: backendReqId,
    errorEventId,
    moduleName,
    endpoint,
    httpStatus,
    technicalMessage: sanitizedTechnical,
    rootCauseConfidence,
    rootCauseDetail: sanitizeTextForLog(rootCauseDetail, 500),
    exceptionType,
    networkFailureClass,
    dbFailureClass,
    dbOperationCategory,
    failureStage,
    retryCount,
    retryable: def.retryable,
    timestampUtc,
    timestampIst,
  };
}
