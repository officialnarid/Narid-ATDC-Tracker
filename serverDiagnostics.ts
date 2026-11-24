import type { Express, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import {
  type AdminFirestoreLike,
  type VerifiedCaller,
  normalizeRoleValue,
  recordEnterpriseAuditEvent,
} from './serverSecurityAudit.ts';
import { getCachedRolePermissionsDoc } from './serverPerfCache.ts';
import {
  ERROR_CODE_REGISTRY,
  type DatabaseFailureClassification,
  type DatabaseOperationCategory,
  type ErrorCategory,
  type ErrorResolutionStatus,
  type FailureStage,
  type NetworkFailureClassification,
  type RequestLifecycleEvent,
  type RequestLifecycleStage,
  type RootCauseConfidence,
  type StandardErrorCode,
  type TechnicalErrorLogRecord,
  type TechnicalErrorOccurrence,
  classifyAndNormalizeError,
  containsRawTechnicalLeak,
  formatUtcAndIstTimestamps,
  isValidReferenceId,
  sanitizeDiagnosticObject,
  sanitizeTextForLog,
} from './src/utils/errorRegistry.ts';

// ============================================================================
// Firestore Collection & Constants
// ============================================================================
export const COL_TECHNICAL_ERROR_LOGS = 'technical_error_logs';
const DUPLICATE_GROUPING_WINDOW_MS = 15 * 60 * 1000; // 15-minute grouping window for repeated identical errors
const MAX_OCCURRENCES_STORED = 50;
const MAX_RELATED_REQUEST_IDS = 100;
const MAX_LIFECYCLE_EVENTS = 16;

// ============================================================================
// Authoritative Cryptographic Backend Request ID Generation
// ============================================================================

export interface RequestTraceState {
  requestId: string;
  correlationUuid: string;
  clientCorrelationId: string | null;
  startedAtMs: number;
  endpoint: string;
  method: string;
  moduleName: string;
  userUid: string;
  userLoginId: string;
  userRole: string;
  browserDeviceInfo: string;
  lifecycleEvents: RequestLifecycleEvent[];
  dbOperationCategory: DatabaseOperationCategory;
  dbCollectionSafe: string | null;
  transactionRetryCount: number | null;
  errorLogged: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
      traceState?: RequestTraceState;
    }
  }
}

/**
 * Generates a cryptographically secure, non-sequential, globally unique backend Request ID
 * backed by Node crypto.randomUUID() + crypto.randomBytes().
 * Format: REQ-YYYYMMDD-<12 uppercase hex chars>
 */
export function generateBackendRequestId(now: Date = new Date()): {
  requestId: string;
  correlationUuid: string;
} {
  const correlationUuid = crypto.randomUUID();
  const { dateCompactIst } = formatUtcAndIstTimestamps(now);
  const randHex = crypto.randomBytes(6).toString('hex').toUpperCase();
  return {
    requestId: `REQ-${dateCompactIst}-${randHex}`,
    correlationUuid,
  };
}

export function getRequestId(req?: Request | null): string {
  if (!req) return generateBackendRequestId().requestId;
  if (req.requestId && isValidReferenceId(req.requestId)) {
    return req.requestId;
  }
  const { requestId, correlationUuid } = generateBackendRequestId();
  req.requestId = requestId;
  if (!req.traceState) {
    req.traceState = {
      requestId,
      correlationUuid,
      clientCorrelationId: null,
      startedAtMs: Date.now(),
      endpoint: sanitizeEndpointPath(req.originalUrl || req.path || '/api'),
      method: String(req.method || 'GET').toUpperCase(),
      moduleName: inferModuleFromEndpoint(req.originalUrl || req.path || '/api'),
      userUid: 'anonymous',
      userLoginId: 'anonymous',
      userRole: 'ANONYMOUS',
      browserDeviceInfo: extractSafeUserAgentSummary(req),
      lifecycleEvents: [],
      dbOperationCategory: null,
      dbCollectionSafe: null,
      transactionRetryCount: null,
      errorLogged: false,
    };
  }
  return requestId;
}

export function markRequestLifecycle(
  req: Request | undefined | null,
  stage: RequestLifecycleStage,
  detail?: string,
  meta?: {
    dbOperationCategory?: DatabaseOperationCategory;
    dbCollectionSafe?: string | null;
    transactionRetryCount?: number | null;
    caller?: Pick<VerifiedCaller, 'uid' | 'loginId' | 'role'>;
  }
): void {
  if (!req?.traceState) return;
  const state = req.traceState;
  if (meta?.caller) {
    state.userUid = meta.caller.uid || state.userUid;
    state.userLoginId = meta.caller.loginId || state.userLoginId;
    state.userRole = String(meta.caller.role || state.userRole).toUpperCase();
  }
  if (meta?.dbOperationCategory !== undefined) {
    state.dbOperationCategory = meta.dbOperationCategory;
  }
  if (meta?.dbCollectionSafe !== undefined) {
    state.dbCollectionSafe = meta.dbCollectionSafe
      ? sanitizeTextForLog(meta.dbCollectionSafe, 64)
      : null;
  }
  if (meta?.transactionRetryCount !== undefined) {
    state.transactionRetryCount = meta.transactionRetryCount;
  }
  if (state.lifecycleEvents.length < MAX_LIFECYCLE_EVENTS) {
    state.lifecycleEvents.push({
      stage,
      timestampUtc: new Date().toISOString(),
      elapsedMs: Math.max(0, Date.now() - state.startedAtMs),
      ...(detail ? { detail: sanitizeTextForLog(detail, 200) } : {}),
    });
  }
}

function sanitizeEndpointPath(rawUrl: string): string {
  const withoutQuery = String(rawUrl || '/').split('?')[0] || '/';
  return sanitizeTextForLog(withoutQuery, 160);
}

function extractSafeUserAgentSummary(req: Request): string {
  const ua = String(req.headers['user-agent'] || '').trim();
  if (!ua) return 'Unknown Client';
  return sanitizeTextForLog(ua, 180);
}

export function inferModuleFromEndpoint(endpoint: string): string {
  const p = String(endpoint || '').toLowerCase();
  if (p.includes('/api/attendance')) return 'Attendance Scanner';
  if (p.includes('/api/employees')) return 'Employee Master';
  if (p.includes('/api/dashboard')) return 'Dashboard';
  if (p.includes('/api/company-wifi')) return 'Network Security';
  if (p.includes('/api/auth')) return 'Authentication';
  if (p.includes('/api/security')) return 'Security & Lockouts';
  if (p.includes('/api/audit')) return 'Audit Logs & Security';
  if (p.includes('/api/diagnostics')) return 'Technical Error Logs';
  if (p.includes('/api/monitoring') || p.includes('/api/network')) return 'System Performance';
  if (p.includes('/api/masters/shifts')) return 'Shift Management';
  if (p.includes('/api/masters')) return 'Organization Management';
  if (p.includes('/api/admin') || p.includes('/api/roles')) return 'User Rights & Auth';
  return 'Backend API';
}

function resolveRuntimeEnvironment(): 'preview' | 'production' | 'test' {
  if (process.env.VITEST || process.env.NODE_ENV === 'test') return 'test';
  if (process.env.VERCEL === '1' && process.env.VERCEL_ENV === 'production') return 'production';
  return 'preview';
}

// ============================================================================
// Duplicate Error Grouping & Non-Fatal Persistence
// ============================================================================

function computeErrorFingerprint(params: {
  errorCode: StandardErrorCode;
  moduleName: string;
  apiEndpoint: string;
  httpStatus: number | null;
  exceptionType: string;
  networkFailureClass: NetworkFailureClassification;
  dbFailureClass: DatabaseFailureClassification;
  referenceIdSource: 'backend' | 'frontend';
}): string {
  const normalizedEndpoint = params.apiEndpoint.replace(/\/[a-zA-Z0-9_-]{12,}/g, '/:id');
  const raw = [
    params.errorCode,
    params.moduleName.toLowerCase(),
    normalizedEndpoint.toLowerCase(),
    String(params.httpStatus ?? 'none'),
    params.exceptionType.toLowerCase(),
    params.networkFailureClass,
    params.dbFailureClass,
    params.referenceIdSource,
  ].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 20);
}

export interface RecordTechnicalErrorParams {
  db: AdminFirestoreLike;
  errorCode: StandardErrorCode;
  errorCategory: ErrorCategory;
  affectedUserUid: string;
  affectedUserLoginId: string;
  userRole: string;
  moduleName: string;
  apiEndpoint: string;
  httpStatus: number | null;
  requestId: string | null;
  errorEventId: string | null;
  referenceIdSource: 'backend' | 'frontend';
  correlationUuid?: string | null;
  technicalMessage: string;
  rootCauseConfidence: RootCauseConfidence;
  rootCauseDetails: string;
  exceptionType: string;
  browserDeviceInfo: string;
  networkFailureClass?: NetworkFailureClassification;
  dbFailureClass?: DatabaseFailureClassification;
  dbOperationCategory?: DatabaseOperationCategory;
  dbCollectionSafe?: string | null;
  failureStage?: FailureStage;
  retryCount?: number;
  transactionRetryCount?: number | null;
  lifecycleEvents?: RequestLifecycleEvent[];
  nowMs?: number;
  forceSeparateRecord?: boolean;
}

/**
 * Persists a sanitized Technical Error Log record with smart duplicate grouping.
 * Strictly non-fatal: logging failures NEVER interrupt application requests.
 */
export async function persistTechnicalErrorLog(
  params: RecordTechnicalErrorParams
): Promise<TechnicalErrorLogRecord | null> {
  try {
    const nowMs = params.nowMs ?? Date.now();
    const { utc: nowUtc, ist: nowIst } = formatUtcAndIstTimestamps(new Date(nowMs));
    const def = ERROR_CODE_REGISTRY[params.errorCode] || ERROR_CODE_REGISTRY['SYS-999'];

    const cleanRequestId = isValidReferenceId(params.requestId) ? params.requestId : null;
    const cleanErrorEventId = isValidReferenceId(params.errorEventId) ? params.errorEventId : null;
    const referenceId =
      cleanRequestId ||
      cleanErrorEventId ||
      generateBackendRequestId(new Date(nowMs)).requestId;

    const networkFailureClass: NetworkFailureClassification = params.networkFailureClass || 'NONE';
    const dbFailureClass: DatabaseFailureClassification = params.dbFailureClass || 'NONE';
    const apiEndpoint = sanitizeEndpointPath(params.apiEndpoint || '/');
    const moduleName = sanitizeTextForLog(params.moduleName || inferModuleFromEndpoint(apiEndpoint), 80);
    const exceptionType = sanitizeTextForLog(params.exceptionType || 'Error', 80);

    const fingerprint = computeErrorFingerprint({
      errorCode: def.code,
      moduleName,
      apiEndpoint,
      httpStatus: params.httpStatus,
      exceptionType,
      networkFailureClass,
      dbFailureClass,
      referenceIdSource: params.referenceIdSource,
    });

    const occurrence: TechnicalErrorOccurrence = {
      requestId: cleanRequestId,
      errorEventId: cleanErrorEventId,
      timestampUtc: nowUtc,
      timestampIst: nowIst,
      userUid: sanitizeTextForLog(params.affectedUserUid || 'anonymous', 128),
      userLoginId: sanitizeTextForLog(params.affectedUserLoginId || 'anonymous', 64),
      userRole: sanitizeTextForLog(params.userRole || 'ANONYMOUS', 40).toUpperCase(),
      httpStatus: params.httpStatus,
      retryCount: Math.max(0, Math.floor(Number(params.retryCount || 0))),
    };

    const isSecurityCritical = Boolean(def.securityCritical);

    // Check if an identical open/investigating record exists within the grouping window
    // Never suppress security-critical events or explicitly separate trace events
    if (!isSecurityCritical && !params.forceSeparateRecord) {
      const existingSnap = await params.db
        .collection(COL_TECHNICAL_ERROR_LOGS)
        .where('fingerprint', '==', fingerprint)
        .get();

      const candidates = existingSnap.docs
        .map((d) => d.data() as TechnicalErrorLogRecord)
        .filter((r) => r && r.resolutionStatus !== 'RESOLVED')
        .sort((a, b) => String(b.lastSeenAtUtc || b.timestampUtc).localeCompare(String(a.lastSeenAtUtc || a.timestampUtc)));

      const latest = candidates[0];
      if (latest) {
        const lastSeenMs = Date.parse(latest.lastSeenAtUtc || latest.timestampUtc || '');
        if (Number.isFinite(lastSeenMs) && nowMs - lastSeenMs <= DUPLICATE_GROUPING_WINDOW_MS) {
          const prevOccurrences = Array.isArray(latest.occurrences) ? latest.occurrences : [];
          const nextOccurrences = [...prevOccurrences, occurrence].slice(-MAX_OCCURRENCES_STORED);
          const prevRelated = Array.isArray(latest.relatedRequestIds) ? latest.relatedRequestIds : [];
          const nextRelatedSet = new Set(prevRelated);
          if (cleanRequestId) nextRelatedSet.add(cleanRequestId);
          if (cleanErrorEventId) nextRelatedSet.add(cleanErrorEventId);
          const nextRelated = Array.from(nextRelatedSet).slice(-MAX_RELATED_REQUEST_IDS);

          const updated: TechnicalErrorLogRecord = {
            ...latest,
            lastSeenAtUtc: nowUtc,
            lastSeenAtIst: nowIst,
            occurrenceCount: (Number(latest.occurrenceCount) || 1) + 1,
            occurrences: nextOccurrences,
            relatedRequestIds: nextRelated,
            retryCount: Math.max(Number(latest.retryCount) || 0, occurrence.retryCount),
          };
          await params.db.collection(COL_TECHNICAL_ERROR_LOGS).doc(latest.errorId).set(updated);
          return updated;
        }
      }
    }

    const errorId = `terr_${nowMs}_${crypto.randomBytes(4).toString('hex')}`;
    const relatedIds: string[] = [];
    if (cleanRequestId) relatedIds.push(cleanRequestId);
    if (cleanErrorEventId && cleanErrorEventId !== cleanRequestId) relatedIds.push(cleanErrorEventId);

    const record: TechnicalErrorLogRecord = {
      errorId,
      fingerprint,
      errorCode: def.code,
      errorCategory: def.category,
      errorCategoryLabel: def.categoryLabel,
      timestampUtc: nowUtc,
      timestampIst: nowIst,
      lastSeenAtUtc: nowUtc,
      lastSeenAtIst: nowIst,
      affectedUserUid: occurrence.userUid,
      affectedUserLoginId: occurrence.userLoginId,
      userRole: occurrence.userRole,
      moduleName,
      apiEndpoint,
      httpStatus: params.httpStatus,
      requestId: cleanRequestId,
      errorEventId: cleanErrorEventId,
      referenceId,
      referenceIdSource: params.referenceIdSource,
      correlationUuid: params.correlationUuid || null,
      relatedRequestIds: relatedIds,
      technicalMessage: sanitizeTextForLog(params.technicalMessage, 900),
      rootCauseConfidence: params.rootCauseConfidence || 'UNKNOWN',
      rootCauseDetails: sanitizeTextForLog(params.rootCauseDetails, 600),
      exceptionType,
      browserDeviceInfo: sanitizeTextForLog(params.browserDeviceInfo || 'Unknown Client', 180),
      networkFailureClass,
      dbFailureClass,
      dbOperationCategory: params.dbOperationCategory ?? null,
      dbCollectionSafe: params.dbCollectionSafe
        ? sanitizeTextForLog(params.dbCollectionSafe, 64)
        : null,
      failureStage: params.failureStage || (params.referenceIdSource === 'backend' ? 'BACKEND_PROCESSING' : 'CLIENT_RUNTIME'),
      retryCount: occurrence.retryCount,
      transactionRetryCount: params.transactionRetryCount ?? null,
      occurrenceCount: 1,
      occurrences: [occurrence],
      lifecycleEvents: Array.isArray(params.lifecycleEvents)
        ? params.lifecycleEvents.slice(0, MAX_LIFECYCLE_EVENTS)
        : [],
      resolutionStatus: 'OPEN',
      resolvedBy: null,
      resolvedAtUtc: null,
      resolvedAtIst: null,
      resolutionNotes: '',
      environment: resolveRuntimeEnvironment(),
    };

    await params.db.collection(COL_TECHNICAL_ERROR_LOGS).doc(errorId).set(record);
    return record;
  } catch (err) {
    // Logging must NEVER interrupt or break normal operations
    console.warn('[Diagnostics] Non-fatal error persisting diagnostic log:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ============================================================================
// Express Request ID Propagation, Safe Error Envelope & Lifecycle Middleware
// ============================================================================

export function createRequestIdAndDiagnosticsMiddleware(
  getDb: () => AdminFirestoreLike | null
) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith('/api')) {
      return next();
    }

    const { requestId, correlationUuid } = generateBackendRequestId();
    const rawClientCorr = String(req.headers['x-correlation-id'] || '').trim();
    const clientCorrelationId = rawClientCorr
      ? sanitizeTextForLog(rawClientCorr, 64)
      : null;

    req.requestId = requestId;
    req.traceState = {
      requestId,
      correlationUuid,
      clientCorrelationId,
      startedAtMs: Date.now(),
      endpoint: sanitizeEndpointPath(req.originalUrl || req.path || '/api'),
      method: String(req.method || 'GET').toUpperCase(),
      moduleName: inferModuleFromEndpoint(req.originalUrl || req.path || '/api'),
      userUid: 'anonymous',
      userLoginId: 'anonymous',
      userRole: 'ANONYMOUS',
      browserDeviceInfo: extractSafeUserAgentSummary(req),
      lifecycleEvents: [],
      dbOperationCategory: null,
      dbCollectionSafe: null,
      transactionRetryCount: null,
      errorLogged: false,
    };

    markRequestLifecycle(req, 'REQUEST_RECEIVED', `${req.traceState.method} ${req.traceState.endpoint}`);

    // Always emit authoritative server-generated X-Request-ID header on EVERY API response
    res.setHeader('X-Request-ID', requestId);

    const originalJson = res.json.bind(res);
    res.json = ((body: any) => {
      try {
        const status = res.statusCode || 200;
        const isErrorPayload = status >= 400 || (body && typeof body === 'object' && body.success === false);

        if (isErrorPayload && body && typeof body === 'object' && !Array.isArray(body)) {
          const rawErrText = String(body.error || body.message || `HTTP ${status} API error`);
          const normalized = classifyAndNormalizeError({
            rawMessage: rawErrText,
            httpStatus: status,
            code: body.errorCode || body.code,
            moduleName: req.traceState?.moduleName,
            endpoint: req.traceState?.endpoint,
            requestId,
            dbOperationCategory: req.traceState?.dbOperationCategory ?? null,
          });

          res.setHeader('X-Error-Code', normalized.errorCode);
          res.setHeader('X-Error-Category', normalized.category);

          // Always attach safe Request ID & Error Code metadata to API error responses
          const safeBody: Record<string, any> = {
            ...body,
            requestId,
            errorCode: normalized.errorCode,
            errorCategory: normalized.category,
          };

          // For 5xx server/database failures, guarantee raw technical details NEVER reach the user
          if (status >= 500 && containsRawTechnicalLeak(rawErrText)) {
            safeBody.error = `${normalized.userTitle} – Error Code: ${normalized.errorCode}. ${normalized.userAction}`;
          }

          markRequestLifecycle(req, 'RESPONSE_SENT', `HTTP ${status} (${normalized.errorCode})`);

          // Persist technical diagnostic log asynchronously (never blocks response, skips self-recursion)
          const db = getDb();
          const shouldLog =
            Boolean(db) &&
            !req.traceState?.errorLogged &&
            !req.path.startsWith('/api/diagnostics/report') &&
            (status >= 500 || status === 401 || status === 403 || status === 404 || status === 429);

          if (shouldLog && db && req.traceState) {
            req.traceState.errorLogged = true;
            void persistTechnicalErrorLog({
              db,
              errorCode: normalized.errorCode,
              errorCategory: normalized.category,
              affectedUserUid: req.traceState.userUid,
              affectedUserLoginId: req.traceState.userLoginId,
              userRole: req.traceState.userRole,
              moduleName: req.traceState.moduleName,
              apiEndpoint: req.traceState.endpoint,
              httpStatus: status,
              requestId,
              errorEventId: null,
              referenceIdSource: 'backend',
              correlationUuid: req.traceState.correlationUuid,
              technicalMessage: rawErrText,
              rootCauseConfidence: normalized.rootCauseConfidence,
              rootCauseDetails: normalized.rootCauseDetail,
              exceptionType: normalized.exceptionType,
              browserDeviceInfo: req.traceState.browserDeviceInfo,
              networkFailureClass: normalized.networkFailureClass,
              dbFailureClass: normalized.dbFailureClass,
              dbOperationCategory: req.traceState.dbOperationCategory ?? normalized.dbOperationCategory,
              dbCollectionSafe: req.traceState.dbCollectionSafe,
              failureStage: normalized.failureStage,
              retryCount: 0,
              transactionRetryCount: req.traceState.transactionRetryCount,
              lifecycleEvents: req.traceState.lifecycleEvents,
            });
          }

          return originalJson(safeBody);
        }

        // Successful 2xx response: zero extra Firestore writes!
        markRequestLifecycle(req, 'RESPONSE_SENT', `HTTP ${status}`);
      } catch {
        // Non-fatal fallback: always send original payload
      }
      return originalJson(body);
    }) as any;

    return next();
  };
}

// ============================================================================
// RBAC Helper: Strictly Super Admin OR Explicitly Authorized Admin
// ============================================================================

async function isAuthorizedForTechnicalLogs(
  db: AdminFirestoreLike,
  caller: VerifiedCaller
): Promise<boolean> {
  const roleId = normalizeRoleValue(caller.role);
  if (roleId === 'super_admin') return true;
  if (roleId !== 'admin') return false;

  // Check if ADMIN role has explicit audit_logs.view permission granted in role_permissions
  try {
    const permDoc = await getCachedRolePermissionsDoc(db, roleId);
    const mp = permDoc?.exists
      ? (permDoc.data?.modulePermissions as Record<string, any> | undefined)
      : undefined;
    if (mp?.audit_logs?.view === true) {
      return true;
    }
  } catch {
    // Fail closed if permission lookup fails
  }
  return false;
}

// ============================================================================
// Zod Validation Schemas for Diagnostic APIs
// ============================================================================

const ClientDiagnosticReportSchema = z.object({
  errorCode: z.enum([
    'NET-001',
    'NET-002',
    'DB-001',
    'DB-002',
    'AUTH-001',
    'AUTH-002',
    'PERM-001',
    'API-001',
    'SYS-001',
    'FILE-001',
    'FILE-002',
    'QR-001',
    'ATT-001',
    'VAL-001',
    'SYS-999',
  ]),
  moduleName: z.string().trim().min(1).max(80),
  apiEndpoint: z.string().trim().max(160).optional(),
  httpStatus: z.number().int().min(0).max(599).nullable().optional(),
  requestId: z.string().trim().max(64).nullable().optional(),
  errorEventId: z.string().trim().max(64).nullable().optional(),
  technicalMessage: z.string().trim().min(1).max(1200),
  rootCauseConfidence: z.enum(['CONFIRMED', 'SUSPECTED', 'UNKNOWN']).optional(),
  rootCauseDetails: z.string().trim().max(600).optional(),
  exceptionType: z.string().trim().max(80).optional(),
  browserDeviceInfo: z.string().trim().max(220).optional(),
  networkFailureClass: z
    .enum([
      'INTERNET_DISCONNECTED',
      'REQUEST_TIMEOUT',
      'DNS_OR_CONNECTION_FAILURE',
      'SERVER_UNREACHABLE',
      'UPSTREAM_GATEWAY_502_503_504',
      'CORS_OR_PREFLIGHT_FAILURE',
      'UNKNOWN_NETWORK_REQUEST_FAILURE',
      'NONE',
    ])
    .optional(),
  dbFailureClass: z
    .enum([
      'FIRESTORE_UNAVAILABLE',
      'DATABASE_CONNECTION_FAILURE',
      'PERMISSION_DENIED',
      'TRANSACTION_ABORTED',
      'READ_FAILURE',
      'WRITE_FAILURE',
      'TIMEOUT',
      'NONE',
    ])
    .optional(),
  dbOperationCategory: z.enum(['read', 'write', 'transaction', 'connection']).nullable().optional(),
  failureStage: z
    .enum(['BEFORE_BACKEND', 'BACKEND_PROCESSING', 'DATABASE', 'CLIENT_RUNTIME'])
    .optional(),
  retryCount: z.number().int().min(0).max(20).optional(),
  extraMetadata: z.record(z.string(), z.unknown()).optional(),
});

const ResolutionStatusUpdateSchema = z.object({
  resolutionStatus: z.enum(['OPEN', 'INVESTIGATING', 'RESOLVED']),
  resolutionNotes: z.string().trim().max(800).optional(),
});

// ============================================================================
// Express Routes Registration (`/api/diagnostics/*`)
// ============================================================================

export function registerDiagnosticRoutes(
  app: Express,
  deps: {
    db: AdminFirestoreLike;
    requireVerifiedCaller: (
      req: Request,
      res: Response,
      allowedRoles: string[] | '*',
      actionLabel: string,
      options?: { skipWifiCheck?: boolean }
    ) => Promise<VerifiedCaller | null>;
    nowProvider?: () => number;
  }
): void {
  const { db, requireVerifiedCaller } = deps;
  const getNowMs = deps.nowProvider || (() => Date.now());

  // --------------------------------------------------------------------------
  // 1. POST /api/diagnostics/report — Authenticated Client Error Ingestion
  //    Sanitizes & records frontend-only / client-observed diagnostic events.
  // --------------------------------------------------------------------------
  app.post('/api/diagnostics/report', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        '*',
        'Report Diagnostic Error Event',
        { skipWifiCheck: true }
      );
      if (!caller) return;

      const parsed = ClientDiagnosticReportSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: 'Invalid diagnostic event payload.',
        });
      }

      const d = parsed.data;
      const def = ERROR_CODE_REGISTRY[d.errorCode] || ERROR_CODE_REGISTRY['SYS-999'];

      // Never trust arbitrary non-conforming client Request IDs
      const validatedBackendReqId = isValidReferenceId(d.requestId) && d.requestId.startsWith('REQ-')
        ? d.requestId
        : null;
      const validatedClientEventId = isValidReferenceId(d.errorEventId) && d.errorEventId.startsWith('ERR-')
        ? d.errorEventId
        : !validatedBackendReqId
        ? `ERR-${formatUtcAndIstTimestamps(new Date(getNowMs())).dateCompactIst}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`
        : null;

      const sanitizedExtra = d.extraMetadata
        ? JSON.stringify(sanitizeDiagnosticObject(d.extraMetadata))
        : '';

      const combinedTechnical = sanitizedExtra && sanitizedExtra !== '{}'
        ? `${d.technicalMessage} | meta=${sanitizedExtra}`
        : d.technicalMessage;

      const saved = await persistTechnicalErrorLog({
        db,
        errorCode: def.code,
        errorCategory: def.category,
        affectedUserUid: caller.uid,
        affectedUserLoginId: caller.loginId,
        userRole: String(caller.role || 'USER').toUpperCase(),
        moduleName: d.moduleName,
        apiEndpoint: d.apiEndpoint || 'client://ui',
        httpStatus: d.httpStatus ?? null,
        requestId: validatedBackendReqId,
        errorEventId: validatedClientEventId,
        referenceIdSource: validatedBackendReqId ? 'backend' : 'frontend',
        correlationUuid: req.traceState?.correlationUuid || null,
        technicalMessage: combinedTechnical,
        rootCauseConfidence: d.rootCauseConfidence || 'UNKNOWN',
        rootCauseDetails:
          d.rootCauseDetails ||
          'Reported by client runtime; technical cause requires administrator review.',
        exceptionType: d.exceptionType || 'ClientError',
        browserDeviceInfo: d.browserDeviceInfo || extractSafeUserAgentSummary(req),
        networkFailureClass: d.networkFailureClass || 'NONE',
        dbFailureClass: d.dbFailureClass || 'NONE',
        dbOperationCategory: d.dbOperationCategory ?? null,
        failureStage:
          d.failureStage || (validatedBackendReqId ? 'BACKEND_PROCESSING' : 'CLIENT_RUNTIME'),
        retryCount: d.retryCount ?? 0,
        nowMs: getNowMs(),
      });

      return res.status(201).json({
        success: true,
        errorId: saved?.errorId || null,
        referenceId: saved?.referenceId || validatedBackendReqId || validatedClientEventId,
        referenceIdSource: validatedBackendReqId ? 'backend' : 'frontend',
        occurrenceCount: saved?.occurrenceCount || 1,
      });
    } catch (err) {
      console.warn('[Diagnostics] Report ingestion error:', err);
      return res.status(500).json({
        success: false,
        error: 'Unable to record diagnostic event.',
      });
    }
  });

  // --------------------------------------------------------------------------
  // 2. GET /api/diagnostics/errors — Admin Technical Error Logs Dashboard & Search
  // --------------------------------------------------------------------------
  app.get('/api/diagnostics/errors', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        '*',
        'View Technical Error Logs',
        { skipWifiCheck: true }
      );
      if (!caller) return;

      const authorized = await isAuthorizedForTechnicalLogs(db, caller);
      if (!authorized) {
        return res.status(403).json({
          success: false,
          error: 'Access Denied: Technical Error Logs are restricted to authorized administrators.',
        });
      }

      const search = String(req.query.search || '').trim().toLowerCase();
      const requestIdFilter = String(req.query.requestId || '').trim().toUpperCase();
      const errorCodeFilter = String(req.query.errorCode || '').trim().toUpperCase();
      const categoryFilter = String(req.query.category || '').trim().toUpperCase();
      const moduleFilter = String(req.query.module || '').trim().toLowerCase();
      const userIdFilter = String(req.query.userId || '').trim().toLowerCase();
      const roleFilter = String(req.query.role || '').trim().toUpperCase();
      const statusFilter = String(req.query.status || '').trim().toUpperCase();
      const fromFilter = String(req.query.from || '').trim();
      const toFilter = String(req.query.to || '').trim();
      const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
      const pageSize = Math.max(1, Math.min(100, parseInt(String(req.query.pageSize || '25'), 10) || 25));

      const snap = await db.collection(COL_TECHNICAL_ERROR_LOGS).get();
      const allRecords: TechnicalErrorLogRecord[] = snap.docs
        .map((d) => d.data() as TechnicalErrorLogRecord)
        .filter((r) => Boolean(r && r.errorId))
        .sort((a, b) =>
          String(b.lastSeenAtUtc || b.timestampUtc || '').localeCompare(
            String(a.lastSeenAtUtc || a.timestampUtc || '')
          )
        );

      // Compute KPI counts over all persisted logs
      const kpis = {
        totalErrors: allRecords.length,
        totalOccurrences: allRecords.reduce((acc, r) => acc + (Number(r.occurrenceCount) || 1), 0),
        networkErrors: allRecords.filter((r) => r.errorCategory === 'NETWORK').length,
        databaseErrors: allRecords.filter((r) => r.errorCategory === 'DATABASE').length,
        apiErrors: allRecords.filter((r) => r.errorCategory === 'API' || r.errorCategory === 'SYSTEM').length,
        authErrors: allRecords.filter((r) => r.errorCategory === 'AUTH' || r.errorCategory === 'PERMISSION').length,
        unresolvedErrors: allRecords.filter((r) => r.resolutionStatus !== 'RESOLVED').length,
        resolvedErrors: allRecords.filter((r) => r.resolutionStatus === 'RESOLVED').length,
      };

      const availableModules = Array.from(new Set(allRecords.map((r) => r.moduleName).filter(Boolean))).sort();

      let filtered = allRecords;

      if (requestIdFilter) {
        filtered = filtered.filter(
          (r) =>
            String(r.requestId || '').toUpperCase().includes(requestIdFilter) ||
            String(r.errorEventId || '').toUpperCase().includes(requestIdFilter) ||
            String(r.referenceId || '').toUpperCase().includes(requestIdFilter) ||
            (Array.isArray(r.relatedRequestIds) &&
              r.relatedRequestIds.some((id) => String(id).toUpperCase().includes(requestIdFilter)))
        );
      }

      if (errorCodeFilter && errorCodeFilter !== 'ALL') {
        filtered = filtered.filter((r) => r.errorCode === errorCodeFilter);
      }

      if (categoryFilter && categoryFilter !== 'ALL') {
        filtered = filtered.filter((r) => r.errorCategory === categoryFilter);
      }

      if (moduleFilter && moduleFilter !== 'all') {
        filtered = filtered.filter((r) => String(r.moduleName || '').toLowerCase() === moduleFilter);
      }

      if (userIdFilter) {
        filtered = filtered.filter(
          (r) =>
            String(r.affectedUserUid || '').toLowerCase().includes(userIdFilter) ||
            String(r.affectedUserLoginId || '').toLowerCase().includes(userIdFilter)
        );
      }

      if (roleFilter && roleFilter !== 'ALL') {
        filtered = filtered.filter((r) => String(r.userRole || '').toUpperCase() === roleFilter);
      }

      if (statusFilter && statusFilter !== 'ALL') {
        filtered = filtered.filter((r) => String(r.resolutionStatus || 'OPEN').toUpperCase() === statusFilter);
      }

      if (fromFilter) {
        const fromMs = Date.parse(fromFilter);
        if (Number.isFinite(fromMs)) {
          filtered = filtered.filter((r) => Date.parse(r.lastSeenAtUtc || r.timestampUtc) >= fromMs);
        }
      }

      if (toFilter) {
        const toMs = Date.parse(toFilter);
        if (Number.isFinite(toMs)) {
          filtered = filtered.filter((r) => Date.parse(r.timestampUtc) <= toMs);
        }
      }

      if (search) {
        filtered = filtered.filter((r) => {
          const hay = [
            r.errorId,
            r.errorCode,
            r.errorCategory,
            r.errorCategoryLabel,
            r.requestId,
            r.errorEventId,
            r.referenceId,
            ...(Array.isArray(r.relatedRequestIds) ? r.relatedRequestIds : []),
            r.affectedUserUid,
            r.affectedUserLoginId,
            r.userRole,
            r.moduleName,
            r.apiEndpoint,
            r.technicalMessage,
            r.rootCauseDetails,
            r.exceptionType,
            r.resolutionNotes,
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return hay.includes(search);
        });
      }

      const totalFiltered = filtered.length;
      const totalPages = Math.max(1, Math.ceil(totalFiltered / pageSize));
      const safePage = Math.min(page, totalPages);
      const start = (safePage - 1) * pageSize;
      const pageItems = filtered.slice(start, start + pageSize);

      return res.json({
        success: true,
        kpis,
        availableModules,
        pagination: {
          page: safePage,
          pageSize,
          totalFiltered,
          totalPages,
        },
        errors: pageItems,
      });
    } catch (err) {
      console.error('[Diagnostics] List technical error logs failed:', err);
      return res.status(500).json({
        success: false,
        error: 'Failed to load technical error logs.',
      });
    }
  });

  // --------------------------------------------------------------------------
  // 3. GET /api/diagnostics/trace/:requestId — Request Trace Chronological View
  // --------------------------------------------------------------------------
  app.get('/api/diagnostics/trace/:requestId', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        '*',
        'Lookup Request Trace',
        { skipWifiCheck: true }
      );
      if (!caller) return;

      const authorized = await isAuthorizedForTechnicalLogs(db, caller);
      if (!authorized) {
        return res.status(403).json({
          success: false,
          error: 'Access Denied: Technical request traces are restricted to authorized administrators.',
        });
      }

      const targetRef = String(req.params.requestId || '').trim().toUpperCase();
      if (!targetRef || targetRef.length < 4 || targetRef.length > 64) {
        return res.status(400).json({
          success: false,
          error: 'Invalid Request ID or Reference ID.',
        });
      }

      const snap = await db.collection(COL_TECHNICAL_ERROR_LOGS).get();
      const matched = snap.docs
        .map((d) => d.data() as TechnicalErrorLogRecord)
        .filter((r) => {
          if (!r) return false;
          if (String(r.requestId || '').toUpperCase() === targetRef) return true;
          if (String(r.errorEventId || '').toUpperCase() === targetRef) return true;
          if (String(r.referenceId || '').toUpperCase() === targetRef) return true;
          if (
            Array.isArray(r.relatedRequestIds) &&
            r.relatedRequestIds.some((id) => String(id).toUpperCase() === targetRef)
          ) {
            return true;
          }
          return false;
        })
        .sort((a, b) => String(a.timestampUtc || '').localeCompare(String(b.timestampUtc || '')));

      return res.json({
        success: true,
        referenceId: targetRef,
        totalMatched: matched.length,
        records: matched,
      });
    } catch (err) {
      console.error('[Diagnostics] Trace lookup failed:', err);
      return res.status(500).json({
        success: false,
        error: 'Failed to retrieve diagnostic request trace.',
      });
    }
  });

  // --------------------------------------------------------------------------
  // 4. PATCH /api/diagnostics/errors/:errorId/status — Update Resolution Status
  // --------------------------------------------------------------------------
  app.patch('/api/diagnostics/errors/:errorId/status', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        '*',
        'Update Technical Error Resolution Status',
        { skipWifiCheck: true }
      );
      if (!caller) return;

      const authorized = await isAuthorizedForTechnicalLogs(db, caller);
      if (!authorized) {
        return res.status(403).json({
          success: false,
          error: 'Access Denied: Only authorized administrators can update diagnostic error statuses.',
        });
      }

      const errorId = String(req.params.errorId || '').trim();
      if (!errorId || !/^[a-zA-Z0-9_-]{4,128}$/.test(errorId)) {
        return res.status(400).json({ success: false, error: 'Invalid error ID.' });
      }

      const parsed = ResolutionStatusUpdateSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: parsed.error.issues[0]?.message || 'Invalid status update payload.',
        });
      }

      const docRef = db.collection(COL_TECHNICAL_ERROR_LOGS).doc(errorId);
      const snap = await docRef.get();
      if (!snap.exists) {
        return res.status(404).json({ success: false, error: 'Technical error record not found.' });
      }

      const current = snap.data() as TechnicalErrorLogRecord;
      const nowMs = getNowMs();
      const { utc: nowUtc, ist: nowIst } = formatUtcAndIstTimestamps(new Date(nowMs));
      const nextStatus: ErrorResolutionStatus = parsed.data.resolutionStatus;
      const cleanNotes =
        parsed.data.resolutionNotes !== undefined
          ? sanitizeTextForLog(parsed.data.resolutionNotes, 800)
          : current.resolutionNotes || '';

      const updated: TechnicalErrorLogRecord = {
        ...current,
        resolutionStatus: nextStatus,
        resolvedBy: nextStatus === 'RESOLVED' ? caller.loginId : nextStatus === 'OPEN' ? null : current.resolvedBy,
        resolvedAtUtc: nextStatus === 'RESOLVED' ? nowUtc : nextStatus === 'OPEN' ? null : current.resolvedAtUtc,
        resolvedAtIst: nextStatus === 'RESOLVED' ? nowIst : nextStatus === 'OPEN' ? null : current.resolvedAtIst,
        resolutionNotes: cleanNotes,
      };

      await docRef.set(updated);

      void recordEnterpriseAuditEvent(db, {
        req,
        action: 'technical_error_status_updated',
        category: 'SYSTEM',
        severity: 'INFO',
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: String(caller.role || 'ADMIN').toUpperCase(),
        targetType: 'TECHNICAL_ERROR_LOG',
        targetId: errorId,
        oldValue: current.resolutionStatus,
        newValue: nextStatus,
        actionSource: 'TECHNICAL_ERROR_LOGS',
        description: `Updated technical error ${current.errorCode} (${current.referenceId}) status to ${nextStatus}.`,
      });

      return res.json({ success: true, errorRecord: updated });
    } catch (err) {
      console.error('[Diagnostics] Update status error:', err);
      return res.status(500).json({
        success: false,
        error: 'Failed to update diagnostic error status.',
      });
    }
  });
}
