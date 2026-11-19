import express, { type Request, type Response, type NextFunction } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import {
  type AdminFirestoreLike,
  type VerifiedCaller,
  recordEnterpriseAuditEvent,
} from './serverSecurityAudit.ts';
import {
  DEFAULT_NETWORK_THRESHOLDS,
  classifyDownloadRating,
  classifyJitterRating,
  classifyLatencyRating,
  classifyUploadRating,
  computeInternetHealthScore,
  computeJitterFromRttSeries,
  computeNumericStats,
  diagnoseNetworkVsServer,
  evaluatePacketLoss,
} from './src/utils/networkDiagnostics.ts';

// ============================================================================
// NARID ATDC TRACKER — Enterprise System Performance & Live Monitoring Engine
// ============================================================================
// PRIVACY, SECURITY & PERFORMANCE INVARIANTS:
// 1. NEVER stores passwords, Firebase ID tokens, Authorization headers, QR tokens,
//    raw QR scan payloads, or unnecessary PII.
// 2. Scoped per AdminFirestoreLike instance via WeakMap for clean isolated testing.
// 3. Uses bounded ring buffers in memory + debounced/aggregated Firestore rollups
//    so monitoring overhead never blocks attendance punching or API responses.
// 4. Strictly enforces Super Admin authorization on all read/governance APIs.
// ============================================================================

export type HealthStatus =
  | 'Healthy'
  | 'Degraded'
  | 'Warning'
  | 'Critical'
  | 'Unknown / Not Instrumented';

export type AlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL';
export type AlertResolutionStatus = 'ACTIVE' | 'ACKNOWLEDGED' | 'RESOLVED';

export interface ApiTraceEntry {
  id: string;
  endpoint: string;
  method: string;
  status: number;
  durationMs: number;
  success: boolean;
  timedOut: boolean;
  errorCategory: string;
  timestamp: string;
  timestampMs: number;
  correlationId: string;
}

export interface DbOpEntry {
  id: string;
  operation: 'READ' | 'WRITE' | 'QUERY' | 'TRANSACTION' | 'BATCH';
  collection: string;
  durationMs: number;
  success: boolean;
  isPermissionDenied: boolean;
  isNetworkError: boolean;
  recordCount: number;
  errorCode?: string;
  timestamp: string;
  timestampMs: number;
  correlationId?: string;
}

export interface QrPunchTelemetryEntry {
  id: string;
  mode: 'QR_IN' | 'QR_OUT' | 'MANUAL_IN' | 'MANUAL_OUT';
  action: string;
  success: boolean;
  isDuplicateRejection: boolean;
  timedOut: boolean;
  qrDetectMs?: number;
  qrParseMs?: number;
  apiRequestMs?: number;
  tokenVerifyMs?: number;
  callerLookupMs?: number;
  authMs?: number;
  permissionMs?: number;
  employeeLookupMs?: number;
  attendanceLookupMs?: number;
  configLookupMs?: number;
  lookupAndQueryMs?: number;
  tokenValidationMs?: number;
  txMs?: number;
  firestoreOpMs?: number;
  auditMs?: number;
  totalServerMs?: number;
  totalE2eMs?: number;
  firestoreReads?: number;
  firestoreWrites?: number;
  reasonCode?: string;
  timestamp: string;
  timestampMs: number;
  correlationId?: string;
}

export interface ClientPerfEntry {
  id: string;
  metric: string;
  module: string;
  durationMs: number;
  timestamp: string;
  timestampMs: number;
  correlationId?: string;
}

export interface MonitoringErrorEntry {
  id: string;
  source: 'BACKEND' | 'FRONTEND' | 'DATABASE' | 'QR' | 'IMPORT_EXPORT' | 'BULK' | 'AUTH';
  module: string;
  category: string;
  severity: 'WARNING' | 'CRITICAL';
  message: string;
  statusCode?: number;
  timestamp: string;
  timestampMs: number;
  correlationId?: string;
}

export interface UserActivityEntry {
  id: string;
  timestamp: string;
  timestampMs: number;
  actorUid: string;
  actorLoginId: string;
  actorRole: string;
  action: string;
  module: string;
  result: 'Success' | 'Failed';
  correlationId?: string;
  detail?: string;
}

export interface ImportExportTraceEntry {
  id: string;
  type: 'EXCEL_IMPORT' | 'EXCEL_EXPORT' | 'CSV_EXPORT' | 'QR_ZIP' | 'BULK_ACTION';
  module: string;
  rowCount: number;
  durationMs: number;
  success: boolean;
  actorLoginId: string;
  timestamp: string;
  timestampMs: number;
  correlationId?: string;
  detail?: string;
}

export interface LiveAlertRecord {
  id: string;
  groupKey: string;
  severity: AlertSeverity;
  module: string;
  title: string;
  description: string;
  affectedOperation: string;
  status: AlertResolutionStatus;
  occurrenceCount: number;
  firstTriggeredAt: string;
  firstTriggeredMs: number;
  lastTriggeredAt: string;
  lastTriggeredMs: number;
  acknowledgedAt?: string | null;
  acknowledgedBy?: string | null;
  resolvedAt?: string | null;
  resolvedBy?: string | null;
  lastMetricValue?: number;
  thresholdValue?: number;
}

export interface NetworkProbeEntry {
  id: string;
  sessionId: string;
  actorLoginId: string;
  actorRole: string;
  online: boolean;
  probeSucceeded: boolean;
  rttMs: number | null;
  serverProcessMs: number | null;
  dnsMs: number | null;
  tcpConnectMs: number | null;
  tlsHandshakeMs: number | null;
  connectionType: string;
  effectiveType: string;
  downlinkEstimateMbps: number | null;
  browserRttEstimateMs: number | null;
  disconnectionEvent: boolean;
  userAgentShort: string;
  timestamp: string;
  timestampMs: number;
}

export interface SpeedTestEntry {
  id: string;
  sessionId: string;
  actorLoginId: string;
  downloadMbps: number | null;
  uploadMbps: number | null;
  downloadBytes: number;
  uploadBytes: number;
  downloadDurationMs: number;
  uploadDurationMs: number;
  timestamp: string;
  timestampMs: number;
}

export interface MonitoringThresholds {
  apiP95WarningMs: number;
  apiErrorRateWarningPct: number;
  qrPunchAvgWarningMs: number;
  qrFailureSpikeCount: number;
  txFailureWarningCount: number;
  frontendErrorSpikeCount: number;
  unauthorizedSpikeCount: number;
  alertCooldownMinutes: number;
  clientSampleRate: number;
  retentionDays: number;
  netLatencyGoodMaxMs: number;
  netLatencyWarnMaxMs: number;
  netLatencyPoorMaxMs: number;
  netLatencyCriticalMinMs: number;
  netJitterGoodMaxMs: number;
  netJitterWarnMaxMs: number;
  netPacketLossGoodMaxPct: number;
  netPacketLossWarnMaxPct: number;
  netDownloadGoodMinMbps: number;
  netDownloadWarnMinMbps: number;
  netUploadGoodMinMbps: number;
  netUploadWarnMinMbps: number;
  netProbeIntervalSec: number;
  netNetworkFailureSpikeCount: number;
}

export const DEFAULT_MONITORING_THRESHOLDS: MonitoringThresholds = {
  apiP95WarningMs: 1200,
  apiErrorRateWarningPct: 10,
  qrPunchAvgWarningMs: 1200,
  qrFailureSpikeCount: 5,
  txFailureWarningCount: 3,
  frontendErrorSpikeCount: 8,
  unauthorizedSpikeCount: 3,
  alertCooldownMinutes: 15,
  clientSampleRate: 1.0,
  retentionDays: 14,
  netLatencyGoodMaxMs: DEFAULT_NETWORK_THRESHOLDS.netLatencyGoodMaxMs,
  netLatencyWarnMaxMs: DEFAULT_NETWORK_THRESHOLDS.netLatencyWarnMaxMs,
  netLatencyPoorMaxMs: DEFAULT_NETWORK_THRESHOLDS.netLatencyPoorMaxMs,
  netLatencyCriticalMinMs: DEFAULT_NETWORK_THRESHOLDS.netLatencyCriticalMinMs,
  netJitterGoodMaxMs: DEFAULT_NETWORK_THRESHOLDS.netJitterGoodMaxMs,
  netJitterWarnMaxMs: DEFAULT_NETWORK_THRESHOLDS.netJitterWarnMaxMs,
  netPacketLossGoodMaxPct: DEFAULT_NETWORK_THRESHOLDS.netPacketLossGoodMaxPct,
  netPacketLossWarnMaxPct: DEFAULT_NETWORK_THRESHOLDS.netPacketLossWarnMaxPct,
  netDownloadGoodMinMbps: DEFAULT_NETWORK_THRESHOLDS.netDownloadGoodMinMbps,
  netDownloadWarnMinMbps: DEFAULT_NETWORK_THRESHOLDS.netDownloadWarnMinMbps,
  netUploadGoodMinMbps: DEFAULT_NETWORK_THRESHOLDS.netUploadGoodMinMbps,
  netUploadWarnMinMbps: DEFAULT_NETWORK_THRESHOLDS.netUploadWarnMinMbps,
  netProbeIntervalSec: DEFAULT_NETWORK_THRESHOLDS.netProbeIntervalSec,
  netNetworkFailureSpikeCount: DEFAULT_NETWORK_THRESHOLDS.netNetworkFailureSpikeCount,
};

interface MonitoringStore {
  apiTraces: ApiTraceEntry[];
  dbOps: DbOpEntry[];
  qrPunches: QrPunchTelemetryEntry[];
  clientPerf: ClientPerfEntry[];
  errors: MonitoringErrorEntry[];
  activities: UserActivityEntry[];
  importExports: ImportExportTraceEntry[];
  networkSamples: NetworkProbeEntry[];
  speedTests: SpeedTestEntry[];
  lastDisconnectionAt: string | null;
  disconnectionCount: number;
  alerts: Map<string, LiveAlertRecord>;
  thresholds: MonitoringThresholds;
  lastHealthCheckAt: string | null;
  lastHealthCheckStatus: 'ok' | 'degraded' | 'unavailable' | null;
  lastHealthProbeMs: number | null;
  lastTelemetryUpdateAt: string | null;
  lastPersistAtMs: number;
  hydratedFromDb: boolean;
  pendingDirty: boolean;
  persistTimer: ReturnType<typeof setTimeout> | null;
  firestoreErrorsCount: number;
}

const MAX_API_TRACES = 600;
const MAX_DB_OPS = 600;
const MAX_QR_PUNCHES = 400;
const MAX_CLIENT_PERF = 500;
const MAX_ERROR_EVENTS = 300;
const MAX_ACTIVITY_EVENTS = 500;
const MAX_IMPORT_EXPORT = 200;
const MAX_NETWORK_SAMPLES = 600;
const MAX_SPEED_TESTS = 100;

const monitoringStoreWeakMap = new WeakMap<object, MonitoringStore>();

function getStore(db: AdminFirestoreLike): MonitoringStore {
  let store = monitoringStoreWeakMap.get(db as object);
  if (!store) {
    store = {
      apiTraces: [],
      dbOps: [],
      qrPunches: [],
      clientPerf: [],
      errors: [],
      activities: [],
      importExports: [],
      networkSamples: [],
      speedTests: [],
      lastDisconnectionAt: null,
      disconnectionCount: 0,
      alerts: new Map(),
      thresholds: { ...DEFAULT_MONITORING_THRESHOLDS },
      lastHealthCheckAt: null,
      lastHealthCheckStatus: null,
      lastHealthProbeMs: null,
      lastTelemetryUpdateAt: null,
      lastPersistAtMs: 0,
      hydratedFromDb: false,
      pendingDirty: false,
      persistTimer: null,
      firestoreErrorsCount: 0,
    };
    monitoringStoreWeakMap.set(db as object, store);
  }
  return store;
}

function pushBounded<T>(arr: T[], item: T, maxLen: number): void {
  arr.push(item);
  if (arr.length > maxLen) {
    arr.splice(0, arr.length - maxLen);
  }
}

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function roundMs(v: number): number {
  return Math.round(v * 100) / 100;
}

// ============================================================================
// Sensitive Field Sanitizer (Strict Privacy Guard)
// ============================================================================
const FORBIDDEN_TELEMETRY_PATTERN = /(password|passcode|token|qr_?token|qrcode|rawpayload|secret|authorization|bearer|private_key|api_key|salt|cookie)/i;

export function sanitizeTelemetryMessage(raw: unknown, maxLen = 280): string {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  // Redact Bearer tokens, JWTs, QR token patterns (QR_XXX_...) and JSON QR payloads
  s = s.replace(/Bearer\s+[A-Za-z0-9\-._~+/=]+/gi, 'Bearer [REDACTED]');
  s = s.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, '[REDACTED_JWT]');
  s = s.replace(/\bQR_[A-Za-z0-9_.-]+\b/g, '[REDACTED_QR]');
  s = s.replace(/\{\s*"employeeId"[^}]*"token"[^}]*\}/gi, '[REDACTED_QR_JSON]');
  if (s.length > maxLen) {
    s = `${s.slice(0, maxLen - 3)}...`;
  }
  return s;
}

export function sanitizeTelemetryMetadata(input: any, depth = 0): Record<string, any> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input) || depth > 3) {
    return undefined;
  }
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(input)) {
    if (FORBIDDEN_TELEMETRY_PATTERN.test(k)) {
      continue; // Omit sensitive keys completely
    }
    if (typeof v === 'string') {
      out[k] = sanitizeTelemetryMessage(v, 180);
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = v;
    } else if (typeof v === 'boolean') {
      out[k] = v;
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      const nested = sanitizeTelemetryMetadata(v, depth + 1);
      if (nested && Object.keys(nested).length > 0) out[k] = nested;
    }
  }
  return out;
}

export function normalizeApiEndpointPath(rawPath: string): string {
  const pathOnly = String(rawPath || '/').split('?')[0].trim() || '/';
  // Collapse resource IDs / employee IDs / doc IDs for clean grouping
  return pathOnly
    .replace(/\/att_[A-Za-z0-9_.-]+/g, '/:attendanceId')
    .replace(/\/log_[A-Za-z0-9_.-]+/g, '/:logId')
    .replace(/\/alert_[A-Za-z0-9_.-]+/g, '/:alertId')
    .replace(/\/role_[A-Za-z0-9_.-]+/g, '/:roleDocId')
    .replace(/\/([0-9]{4,}|[a-f0-9-]{16,})/gi, '/:id');
}

function classifyHttpErrorCategory(status: number, timedOut: boolean): string {
  if (timedOut || status === 408 || status === 504) return 'TIMEOUT';
  if (status === 401) return 'AUTH';
  if (status === 403) return 'PERMISSION';
  if (status === 400 || status === 422) return 'VALIDATION';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 503) return 'SERVICE_UNAVAILABLE';
  if (status >= 500) return 'SERVER';
  return 'NONE';
}

function mapEndpointToModule(endpoint: string): string {
  if (endpoint.startsWith('/api/auth') || endpoint.startsWith('/api/login-security')) return 'Authentication';
  if (endpoint.startsWith('/api/attendance/scan') || endpoint.startsWith('/api/attendance/manual-punch')) return 'Attendance Scanner';
  if (endpoint.startsWith('/api/attendance/')) return 'Attendance History';
  if (endpoint.startsWith('/api/employees/bulk-import')) return 'Excel Import / Update';
  if (endpoint.startsWith('/api/employees')) return 'Employee Master';
  if (endpoint.startsWith('/api/masters')) return 'Organization Management';
  if (endpoint.startsWith('/api/dashboard')) return 'Dashboard';
  if (endpoint.startsWith('/api/audit')) return 'Audit Logs & Security';
  if (endpoint.startsWith('/api/security')) return 'Audit Logs & Security';
  if (endpoint.startsWith('/api/admin')) return 'User Rights & Permissions';
  if (endpoint.startsWith('/api/monitoring')) return 'System Performance';
  return 'Backend APIs';
}

// ============================================================================
// Percentile & Aggregation Math
// ============================================================================
export function computeLatencyStats(durations: number[]): {
  count: number;
  minMs: number | null;
  avgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
} {
  if (!durations || durations.length === 0) {
    return { count: 0, minMs: null, avgMs: null, p50Ms: null, p95Ms: null, maxMs: null };
  }
  const sorted = [...durations].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const pct = (p: number) => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return roundMs(sorted[idx]);
  };
  return {
    count: sorted.length,
    minMs: roundMs(sorted[0]),
    avgMs: roundMs(sum / sorted.length),
    p50Ms: pct(50),
    p95Ms: pct(95),
    maxMs: roundMs(sorted[sorted.length - 1]),
  };
}

// ============================================================================
// Live Alert Engine (Configurable Thresholds + Duplicate Grouping / Cooldown)
// ============================================================================
function raiseOrGroupAlert(
  db: AdminFirestoreLike,
  params: {
    groupKey: string;
    severity: AlertSeverity;
    module: string;
    title: string;
    description: string;
    affectedOperation: string;
    metricValue?: number;
    thresholdValue?: number;
  }
): void {
  const store = getStore(db);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const cooldownMs = Math.max(1, store.thresholds.alertCooldownMinutes) * 60_000;

  const existing = store.alerts.get(params.groupKey);
  if (existing) {
    const withinCooldown = nowMs - existing.lastTriggeredMs < cooldownMs;
    if (existing.status !== 'RESOLVED' || withinCooldown) {
      existing.occurrenceCount += 1;
      existing.lastTriggeredAt = nowIso;
      existing.lastTriggeredMs = nowMs;
      existing.description = params.description;
      existing.lastMetricValue = params.metricValue;
      existing.thresholdValue = params.thresholdValue;
      // Upgrade severity if escalated
      if (params.severity === 'CRITICAL') existing.severity = 'CRITICAL';
      // Re-open only if cooldown expired on a previously resolved alert
      if (existing.status === 'RESOLVED' && !withinCooldown) {
        existing.status = 'ACTIVE';
        existing.resolvedAt = null;
        existing.resolvedBy = null;
      }
      store.pendingDirty = true;
      return;
    }
  }

  const created: LiveAlertRecord = {
    id: makeId('alert'),
    groupKey: params.groupKey,
    severity: params.severity,
    module: params.module,
    title: params.title,
    description: params.description,
    affectedOperation: params.affectedOperation,
    status: 'ACTIVE',
    occurrenceCount: 1,
    firstTriggeredAt: nowIso,
    firstTriggeredMs: nowMs,
    lastTriggeredAt: nowIso,
    lastTriggeredMs: nowMs,
    acknowledgedAt: null,
    acknowledgedBy: null,
    resolvedAt: null,
    resolvedBy: null,
    lastMetricValue: params.metricValue,
    thresholdValue: params.thresholdValue,
  };
  store.alerts.set(params.groupKey, created);
  store.pendingDirty = true;

  // Cap alerts map size to prevent unbounded growth
  if (store.alerts.size > 200) {
    const entries = Array.from(store.alerts.entries()).sort(
      (a, b) => a[1].lastTriggeredMs - b[1].lastTriggeredMs
    );
    for (const [k, v] of entries) {
      if (store.alerts.size <= 150) break;
      if (v.status === 'RESOLVED') store.alerts.delete(k);
    }
  }
}

export function evaluateAlertThresholds(db: AdminFirestoreLike): void {
  const store = getStore(db);
  const nowMs = Date.now();
  const window15m = nowMs - 15 * 60_000;
  const th = store.thresholds;

  // 1. API Latency P95 & Error/Timeout spikes (last 15 minutes)
  const recentApis = store.apiTraces.filter((a) => a.timestampMs >= window15m);
  if (recentApis.length >= 5) {
    const stats = computeLatencyStats(recentApis.map((a) => a.durationMs));
    if (stats.p95Ms !== null && stats.p95Ms > th.apiP95WarningMs) {
      raiseOrGroupAlert(db, {
        groupKey: 'ALERT_HIGH_API_LATENCY',
        severity: stats.p95Ms > th.apiP95WarningMs * 2 ? 'CRITICAL' : 'WARNING',
        module: 'Backend APIs',
        title: 'API P95 Latency Threshold Exceeded',
        description: `15-minute API P95 response time is ${stats.p95Ms}ms (threshold ${th.apiP95WarningMs}ms across ${recentApis.length} calls).`,
        affectedOperation: 'HTTP API Pipeline',
        metricValue: stats.p95Ms,
        thresholdValue: th.apiP95WarningMs,
      });
    }

    const failedCount = recentApis.filter((a) => !a.success && a.status >= 500).length;
    const timeoutCount = recentApis.filter((a) => a.timedOut).length;
    const errRatePct = roundMs((failedCount / recentApis.length) * 100);
    if (errRatePct > th.apiErrorRateWarningPct && failedCount >= 2) {
      raiseOrGroupAlert(db, {
        groupKey: 'ALERT_API_ERROR_SPIKE',
        severity: 'CRITICAL',
        module: 'Backend APIs',
        title: 'Backend 5xx Error Rate Spike',
        description: `Server 5xx error rate reached ${errRatePct}% (${failedCount}/${recentApis.length} requests in 15m).`,
        affectedOperation: 'Express API Handlers',
        metricValue: errRatePct,
        thresholdValue: th.apiErrorRateWarningPct,
      });
    }
    if (timeoutCount >= 3) {
      raiseOrGroupAlert(db, {
        groupKey: 'ALERT_API_TIMEOUT_SPIKE',
        severity: 'CRITICAL',
        module: 'Backend APIs',
        title: 'API Timeout Spike Detected',
        description: `${timeoutCount} API request timeouts recorded in the last 15 minutes.`,
        affectedOperation: 'HTTP / Firestore Upstream',
        metricValue: timeoutCount,
        thresholdValue: 3,
      });
    }
  }

  // 2. QR Punch Latency & Repeated QR Failures
  const recentQr = store.qrPunches.filter((q) => q.timestampMs >= window15m);
  if (recentQr.length > 0) {
    const qrDurations = recentQr
      .map((q) => q.totalE2eMs ?? q.totalServerMs ?? 0)
      .filter((v) => v > 0);
    const qrStats = computeLatencyStats(qrDurations);
    if (qrStats.avgMs !== null && qrStats.avgMs > th.qrPunchAvgWarningMs) {
      raiseOrGroupAlert(db, {
        groupKey: 'ALERT_HIGH_QR_LATENCY',
        severity: qrStats.avgMs > th.qrPunchAvgWarningMs * 1.5 ? 'CRITICAL' : 'WARNING',
        module: 'Attendance Scanner',
        title: 'High QR / Attendance Punch Latency',
        description: `Average punch latency is ${qrStats.avgMs}ms (threshold ${th.qrPunchAvgWarningMs}ms over ${recentQr.length} punches).`,
        affectedOperation: 'POST /api/attendance/scan',
        metricValue: qrStats.avgMs,
        thresholdValue: th.qrPunchAvgWarningMs,
      });
    }

    const failedQr = recentQr.filter((q) => !q.success && !q.isDuplicateRejection).length;
    if (failedQr >= th.qrFailureSpikeCount) {
      raiseOrGroupAlert(db, {
        groupKey: 'ALERT_REPEATED_QR_FAILURES',
        severity: 'WARNING',
        module: 'Attendance Scanner',
        title: 'Repeated Failed QR / Punch Operations',
        description: `${failedQr} non-duplicate failed QR/attendance punch attempts in the last 15 minutes (threshold ${th.qrFailureSpikeCount}).`,
        affectedOperation: 'QR Validation & Punch Processing',
        metricValue: failedQr,
        thresholdValue: th.qrFailureSpikeCount,
      });
    }
  }

  // 3. Database Transaction / Permission Failures
  const recentDb = store.dbOps.filter((d) => d.timestampMs >= window15m);
  const failedTxOrPerm = recentDb.filter((d) => !d.success || d.isPermissionDenied);
  if (failedTxOrPerm.length >= th.txFailureWarningCount) {
    raiseOrGroupAlert(db, {
      groupKey: 'ALERT_DB_FAILURE_RATE',
      severity: failedTxOrPerm.some((d) => d.isPermissionDenied) ? 'CRITICAL' : 'WARNING',
      module: 'Firebase / Firestore',
      title: 'Firestore Operation / Transaction Failures',
      description: `${failedTxOrPerm.length} failed Firestore database operations in the last 15 minutes.`,
      affectedOperation: 'Firestore Admin / Client Operations',
      metricValue: failedTxOrPerm.length,
      thresholdValue: th.txFailureWarningCount,
    });
  }

  // 4. Excessive Frontend Errors
  const recentFeErrors = store.errors.filter(
    (e) => e.timestampMs >= window15m && e.source === 'FRONTEND'
  );
  if (recentFeErrors.length >= th.frontendErrorSpikeCount) {
    raiseOrGroupAlert(db, {
      groupKey: 'ALERT_FRONTEND_ERROR_SPIKE',
      severity: 'WARNING',
      module: 'Frontend Application',
      title: 'Excessive Browser-Side JavaScript Errors',
      description: `${recentFeErrors.length} frontend runtime/promise errors captured in the last 15 minutes.`,
      affectedOperation: 'Browser Client Runtime',
      metricValue: recentFeErrors.length,
      thresholdValue: th.frontendErrorSpikeCount,
    });
  }

  // 5. Unauthorized Access Attempt Spike
  const recentUnauth = store.errors.filter(
    (e) =>
      e.timestampMs >= window15m &&
      (e.category === 'PERMISSION' || e.category === 'AUTH' || e.statusCode === 403)
  );
  if (recentUnauth.length >= th.unauthorizedSpikeCount) {
    raiseOrGroupAlert(db, {
      groupKey: 'ALERT_UNAUTHORIZED_SPIKE',
      severity: 'CRITICAL',
      module: 'Audit Logs & Security',
      title: 'Unauthorized Access Attempts Detected',
      description: `${recentUnauth.length} blocked unauthorized/permission errors recorded in the last 15 minutes.`,
      affectedOperation: 'RBAC Authorization Guards',
      metricValue: recentUnauth.length,
      thresholdValue: th.unauthorizedSpikeCount,
    });
  }

  // 6. Internet & Network Performance Alerts (15-minute window)
  const recentNet = store.networkSamples.filter((n) => n.timestampMs >= window15m);
  const recentSpeed = store.speedTests.filter((s) => s.timestampMs >= window15m);
  if (recentNet.length > 0) {
    const latestProbe = recentNet[recentNet.length - 1];
    if (!latestProbe.online || latestProbe.disconnectionEvent) {
      raiseOrGroupAlert(db, {
        groupKey: 'NET_ALERT_DISCONNECTED',
        severity: 'CRITICAL',
        module: 'Internet & Network',
        title: 'User Internet Disconnection Detected',
        description: `Session ${latestProbe.sessionId} reported browser offline / network loss at ${latestProbe.timestamp}.`,
        affectedOperation: 'Network Connectivity Probe',
      });
    }

    const okRtts = recentNet
      .filter((n) => n.probeSucceeded && typeof n.rttMs === 'number')
      .map((n) => n.rttMs as number);
    const rttSummary = computeNumericStats(okRtts);
    if (rttSummary.avg !== null && rttSummary.avg > th.netLatencyPoorMaxMs) {
      raiseOrGroupAlert(db, {
        groupKey: 'NET_ALERT_HIGH_LATENCY',
        severity: rttSummary.avg > th.netLatencyCriticalMinMs ? 'CRITICAL' : 'WARNING',
        module: 'Internet & Network',
        title: 'High Application Network RTT Latency',
        description: `Measured HTTP probe RTT averaged ${rttSummary.avg} ms (P95 ${rttSummary.p95 ?? '—'} ms, threshold > ${th.netLatencyPoorMaxMs} ms).`,
        affectedOperation: 'GET /api/network/ping',
        metricValue: rttSummary.avg,
        thresholdValue: th.netLatencyPoorMaxMs,
      });
    }

    const jitterMs = computeJitterFromRttSeries(okRtts);
    if (jitterMs !== null && jitterMs >= th.netJitterGoodMaxMs) {
      raiseOrGroupAlert(db, {
        groupKey: 'NET_ALERT_HIGH_JITTER',
        severity: jitterMs > th.netJitterWarnMaxMs ? 'CRITICAL' : 'WARNING',
        module: 'Internet & Network',
        title: 'Elevated Network Jitter / Instability',
        description: `Measured RTT jitter is ${jitterMs} ms across ${okRtts.length} probes (threshold ${th.netJitterWarnMaxMs} ms).`,
        affectedOperation: 'HTTP RTT Stability',
        metricValue: jitterMs,
        thresholdValue: th.netJitterWarnMaxMs,
      });
    }

    // Strict safeguard: evaluatePacketLoss requires >=5 probes and NEVER classifies 1 isolated failed probe as packet loss
    const lossEval = evaluatePacketLoss(
      recentNet.map((n) => ({ success: n.probeSucceeded })),
      th
    );
    if (
      lossEval.reportablePacketLossPct !== null &&
      lossEval.reportablePacketLossPct > th.netPacketLossGoodMaxPct
    ) {
      raiseOrGroupAlert(db, {
        groupKey: 'NET_ALERT_PACKET_LOSS',
        severity:
          lossEval.reportablePacketLossPct > th.netPacketLossWarnMaxPct ? 'CRITICAL' : 'WARNING',
        module: 'Internet & Network',
        title: 'Sustained HTTP Probe Packet Loss Detected',
        description: `${lossEval.note} (threshold ${th.netPacketLossWarnMaxPct}%).`,
        affectedOperation: 'Repeated Connectivity Probes',
        metricValue: lossEval.reportablePacketLossPct,
        thresholdValue: th.netPacketLossWarnMaxPct,
      });
    }

    // Repeated network request failures from client API telemetry
    const clientNetErrors = store.errors.filter(
      (e) =>
        e.timestampMs >= window15m &&
        e.source === 'FRONTEND' &&
        (e.category === 'NETWORK_FAILURE' || e.category === 'CLIENT_TIMEOUT')
    );
    if (clientNetErrors.length >= th.netNetworkFailureSpikeCount) {
      raiseOrGroupAlert(db, {
        groupKey: 'NET_ALERT_REQUEST_FAILURES',
        severity: clientNetErrors.length >= th.netNetworkFailureSpikeCount * 2 ? 'CRITICAL' : 'WARNING',
        module: 'Internet & Network',
        title: 'Repeated Client Network Request Failures',
        description: `${clientNetErrors.length} failed/timed-out HTTP requests detected in client browser telemetry (15m).`,
        affectedOperation: 'Client API Fetch Pipeline',
        metricValue: clientNetErrors.length,
        thresholdValue: th.netNetworkFailureSpikeCount,
      });
    }

    // Backend reachable/fast network, but Backend API slow
    const apiSummary = computeNumericStats(recentApis.map((a) => a.durationMs));
    const dbSummary = computeNumericStats(recentDb.map((d) => d.durationMs));
    if (
      rttSummary.avg !== null &&
      rttSummary.avg <= th.netLatencyWarnMaxMs &&
      apiSummary.p95 !== null &&
      apiSummary.p95 > th.apiP95WarningMs &&
      (dbSummary.p95 === null || dbSummary.p95 < apiSummary.p95 * 0.45)
    ) {
      raiseOrGroupAlert(db, {
        groupKey: 'NET_ALERT_SLOW_BACKEND_HEALTHY_NET',
        severity: 'WARNING',
        module: 'Backend APIs',
        title: 'Backend Reachable Quickly But API Processing Slow',
        description: `Client HTTP RTT is healthy (${rttSummary.avg} ms avg), while Backend API P95 is ${apiSummary.p95} ms.`,
        affectedOperation: 'Backend Express API Layer',
        metricValue: apiSummary.p95,
        thresholdValue: th.apiP95WarningMs,
      });
    }
  }

  if (recentSpeed.length > 0) {
    const latestSp = recentSpeed[recentSpeed.length - 1];
    const dlBad =
      latestSp.downloadMbps !== null && latestSp.downloadMbps < th.netDownloadGoodMinMbps;
    const ulBad = latestSp.uploadMbps !== null && latestSp.uploadMbps < th.netUploadGoodMinMbps;
    if (dlBad || ulBad) {
      const isCrit =
        (latestSp.downloadMbps !== null && latestSp.downloadMbps < th.netDownloadWarnMinMbps) ||
        (latestSp.uploadMbps !== null && latestSp.uploadMbps < th.netUploadWarnMinMbps);
      raiseOrGroupAlert(db, {
        groupKey: 'NET_ALERT_LOW_THROUGHPUT',
        severity: isCrit ? 'CRITICAL' : 'WARNING',
        module: 'Internet & Network',
        title: 'Low Measured Network Bandwidth',
        description: `Controlled speed test measured ↓${latestSp.downloadMbps ?? '—'} Mbps / ↑${latestSp.uploadMbps ?? '—'} Mbps (targets ≥${th.netDownloadGoodMinMbps} / ≥${th.netUploadGoodMinMbps} Mbps).`,
        affectedOperation: 'Controlled Speed Test',
        metricValue: latestSp.downloadMbps ?? latestSp.uploadMbps ?? 0,
        thresholdValue: th.netDownloadGoodMinMbps,
      });
    }
  }
}

// ============================================================================
// Telemetry Recording API (In-Memory Bounded + Async Debounced Persistence)
// ============================================================================
function scheduleMonitoringPersist(db: AdminFirestoreLike): void {
  if (process.env.VITEST) return;
  const store = getStore(db);
  store.pendingDirty = true;
  if (store.persistTimer) return;
  store.persistTimer = setTimeout(() => {
    store.persistTimer = null;
    void flushMonitoringToFirestore(db);
  }, 15_000);
  if (typeof (store.persistTimer as any)?.unref === 'function') {
    (store.persistTimer as any).unref();
  }
}

export async function flushMonitoringToFirestore(db: AdminFirestoreLike): Promise<void> {
  const store = getStore(db);
  if (!store.pendingDirty) return;
  store.pendingDirty = false;
  store.lastPersistAtMs = Date.now();

  try {
    const todayKey = new Date().toISOString().slice(0, 10);
    const recentApis = store.apiTraces.slice(-200);
    const apiStats = computeLatencyStats(recentApis.map((a) => a.durationMs));
    const qrDurations = store.qrPunches
      .slice(-200)
      .map((q) => q.totalE2eMs ?? q.totalServerMs ?? 0)
      .filter((v) => v > 0);
    const qrStats = computeLatencyStats(qrDurations);

    await db
      .collection('monitoring_rollups')
      .doc(todayKey)
      .set(
        {
          dateKey: todayKey,
          updatedAt: new Date().toISOString(),
          apiCountWindow: recentApis.length,
          apiAvgMs: apiStats.avgMs,
          apiP95Ms: apiStats.p95Ms,
          apiErrorCount: recentApis.filter((a) => !a.success).length,
          qrCountWindow: store.qrPunches.length,
          qrAvgMs: qrStats.avgMs,
          qrP95Ms: qrStats.p95Ms,
          dbOpsCount: store.dbOps.length,
          errorCount: store.errors.length,
          activityCount: store.activities.length,
        },
        { merge: true }
      );

    // Persist active or updated alerts (bounded to latest 25 alerts)
    const alertList = Array.from(store.alerts.values())
      .sort((a, b) => b.lastTriggeredMs - a.lastTriggeredMs)
      .slice(0, 25);

    if (typeof db.batch === 'function' && alertList.length > 0) {
      const batch = db.batch();
      for (const al of alertList) {
        batch.set(db.collection('monitoring_alerts').doc(al.groupKey), al, { merge: true });
      }
      await batch.commit();
    }
  } catch (err: any) {
    store.firestoreErrorsCount += 1;
    // Never throw or block runtime flows if monitoring persistence fails
    if (!process.env.VITEST) {
      console.warn('[Monitoring] Background rollup persist notice:', err?.message || err);
    }
  }
}

export function recordApiMetric(
  db: AdminFirestoreLike,
  entry: Omit<ApiTraceEntry, 'id' | 'timestamp' | 'timestampMs'> & { timestamp?: string; timestampMs?: number }
): void {
  const store = getStore(db);
  const tsMs = entry.timestampMs ?? Date.now();
  const ts = entry.timestamp ?? new Date(tsMs).toISOString();
  const cleanEndpoint = normalizeApiEndpointPath(entry.endpoint);

  pushBounded(
    store.apiTraces,
    {
      ...entry,
      id: makeId('api'),
      endpoint: cleanEndpoint,
      timestamp: ts,
      timestampMs: tsMs,
    },
    MAX_API_TRACES
  );

  if (!entry.success && (entry.status >= 500 || entry.timedOut || entry.status === 403 || entry.status === 401)) {
    // Skip logging monitoring endpoint's own 401/403 twice if already captured in error log
    pushBounded(
      store.errors,
      {
        id: makeId('err'),
        source: entry.status === 401 || entry.status === 403 ? 'AUTH' : 'BACKEND',
        module: mapEndpointToModule(cleanEndpoint),
        category: entry.errorCategory,
        severity: entry.status >= 500 || entry.status === 403 ? 'CRITICAL' : 'WARNING',
        message: `${entry.method} ${cleanEndpoint} failed with HTTP ${entry.status}${entry.timedOut ? ' (timeout)' : ''}`,
        statusCode: entry.status,
        timestamp: ts,
        timestampMs: tsMs,
        correlationId: entry.correlationId,
      },
      MAX_ERROR_EVENTS
    );
  }

  store.lastTelemetryUpdateAt = ts;
  evaluateAlertThresholds(db);
  scheduleMonitoringPersist(db);
}

export function recordDbOpMetric(
  db: AdminFirestoreLike,
  params: {
    operation: DbOpEntry['operation'];
    collection: string;
    durationMs: number;
    success: boolean;
    isPermissionDenied?: boolean;
    isNetworkError?: boolean;
    recordCount?: number;
    errorCode?: string;
    errorMessage?: string;
    correlationId?: string;
  }
): void {
  const store = getStore(db);
  const tsMs = Date.now();
  const ts = new Date(tsMs).toISOString();

  pushBounded(
    store.dbOps,
    {
      id: makeId('db'),
      operation: params.operation,
      collection: params.collection,
      durationMs: roundMs(params.durationMs),
      success: params.success,
      isPermissionDenied: Boolean(params.isPermissionDenied),
      isNetworkError: Boolean(params.isNetworkError),
      recordCount: Math.max(1, Number(params.recordCount || 1)),
      ...(params.errorCode ? { errorCode: params.errorCode } : {}),
      timestamp: ts,
      timestampMs: tsMs,
      correlationId: params.correlationId,
    },
    MAX_DB_OPS
  );

  if (!params.success) {
    store.firestoreErrorsCount += 1;
    pushBounded(
      store.errors,
      {
        id: makeId('err'),
        source: 'DATABASE',
        module: 'Firebase / Firestore',
        category: params.isPermissionDenied ? 'PERMISSION_DENIED' : params.isNetworkError ? 'NETWORK' : 'DATABASE',
        severity: 'CRITICAL',
        message: sanitizeTelemetryMessage(
          params.errorMessage || `Firestore ${params.operation} failed on ${params.collection}`
        ),
        timestamp: ts,
        timestampMs: tsMs,
        correlationId: params.correlationId,
      },
      MAX_ERROR_EVENTS
    );

    if (params.isPermissionDenied || params.isNetworkError) {
      raiseOrGroupAlert(db, {
        groupKey: 'ALERT_FIREBASE_CONNECTION_FAILURE',
        severity: 'CRITICAL',
        module: 'Firebase / Firestore',
        title: params.isPermissionDenied
          ? 'Firestore Permission Denied Detected'
          : 'Firestore Connectivity Error',
        description: sanitizeTelemetryMessage(
          params.errorMessage || `Firestore ${params.operation} error on ${params.collection}.`
        ),
        affectedOperation: `Firestore ${params.operation}`,
      });
    }
  }

  store.lastTelemetryUpdateAt = ts;
  evaluateAlertThresholds(db);
  scheduleMonitoringPersist(db);
}

export function recordQrPunchTelemetry(
  db: AdminFirestoreLike,
  params: Omit<QrPunchTelemetryEntry, 'id' | 'timestamp' | 'timestampMs'>
): void {
  const store = getStore(db);
  const tsMs = Date.now();
  const ts = new Date(tsMs).toISOString();

  pushBounded(
    store.qrPunches,
    {
      ...params,
      id: makeId('qr'),
      timestamp: ts,
      timestampMs: tsMs,
    },
    MAX_QR_PUNCHES
  );

  if (!params.success && !params.isDuplicateRejection) {
    pushBounded(
      store.errors,
      {
        id: makeId('err'),
        source: 'QR',
        module: 'Attendance Scanner',
        category: params.timedOut ? 'TIMEOUT' : params.reasonCode || 'QR_REJECTED',
        severity: params.timedOut ? 'CRITICAL' : 'WARNING',
        message: sanitizeTelemetryMessage(
          `${params.mode} failed (${params.reasonCode || params.action || 'REJECTED'})`
        ),
        timestamp: ts,
        timestampMs: tsMs,
        correlationId: params.correlationId,
      },
      MAX_ERROR_EVENTS
    );
  }

  store.lastTelemetryUpdateAt = ts;
  evaluateAlertThresholds(db);
  scheduleMonitoringPersist(db);
}

export function recordActivityTelemetry(
  db: AdminFirestoreLike,
  params: {
    actorUid: string;
    actorLoginId: string;
    actorRole: string;
    action: string;
    module: string;
    result: 'Success' | 'Failed';
    correlationId?: string;
    detail?: string;
  }
): void {
  const store = getStore(db);
  const tsMs = Date.now();
  const ts = new Date(tsMs).toISOString();

  pushBounded(
    store.activities,
    {
      id: makeId('act'),
      timestamp: ts,
      timestampMs: tsMs,
      actorUid: params.actorUid,
      actorLoginId: params.actorLoginId,
      actorRole: String(params.actorRole || 'UNKNOWN').toUpperCase(),
      action: sanitizeTelemetryMessage(params.action, 80),
      module: sanitizeTelemetryMessage(params.module, 60),
      result: params.result,
      correlationId: params.correlationId,
      ...(params.detail ? { detail: sanitizeTelemetryMessage(params.detail, 200) } : {}),
    },
    MAX_ACTIVITY_EVENTS
  );

  store.lastTelemetryUpdateAt = ts;
  scheduleMonitoringPersist(db);
}

export function recordImportExportTelemetry(
  db: AdminFirestoreLike,
  params: {
    type: ImportExportTraceEntry['type'];
    module: string;
    rowCount: number;
    durationMs: number;
    success: boolean;
    actorLoginId: string;
    correlationId?: string;
    detail?: string;
  }
): void {
  const store = getStore(db);
  const tsMs = Date.now();
  const ts = new Date(tsMs).toISOString();

  pushBounded(
    store.importExports,
    {
      id: makeId('io'),
      type: params.type,
      module: params.module,
      rowCount: Math.max(0, Number(params.rowCount || 0)),
      durationMs: roundMs(params.durationMs),
      success: params.success,
      actorLoginId: params.actorLoginId,
      timestamp: ts,
      timestampMs: tsMs,
      correlationId: params.correlationId,
      ...(params.detail ? { detail: sanitizeTelemetryMessage(params.detail, 200) } : {}),
    },
    MAX_IMPORT_EXPORT
  );

  if (!params.success) {
    pushBounded(
      store.errors,
      {
        id: makeId('err'),
        source: params.type === 'BULK_ACTION' ? 'BULK' : 'IMPORT_EXPORT',
        module: params.module,
        category: params.type,
        severity: 'CRITICAL',
        message: sanitizeTelemetryMessage(
          params.detail || `${params.type} failed for ${params.rowCount} records.`
        ),
        timestamp: ts,
        timestampMs: tsMs,
        correlationId: params.correlationId,
      },
      MAX_ERROR_EVENTS
    );

    raiseOrGroupAlert(db, {
      groupKey:
        params.type === 'BULK_ACTION' ? 'ALERT_BULK_OP_FAILURE' : 'ALERT_EXCEL_IMPORT_FAILURE',
      severity: 'CRITICAL',
      module: params.module,
      title:
        params.type === 'BULK_ACTION'
          ? 'Bulk Batch Operation Failure'
          : 'Excel Import / Export Failure',
      description: sanitizeTelemetryMessage(
        params.detail || `${params.type} encountered an error.`
      ),
      affectedOperation: params.type,
    });
  }

  store.lastTelemetryUpdateAt = ts;
  scheduleMonitoringPersist(db);
}

export function recordErrorTelemetry(
  db: AdminFirestoreLike,
  params: Omit<MonitoringErrorEntry, 'id' | 'timestamp' | 'timestampMs'>
): void {
  const store = getStore(db);
  const tsMs = Date.now();
  const ts = new Date(tsMs).toISOString();

  pushBounded(
    store.errors,
    {
      ...params,
      message: sanitizeTelemetryMessage(params.message),
      id: makeId('err'),
      timestamp: ts,
      timestampMs: tsMs,
    },
    MAX_ERROR_EVENTS
  );

  store.lastTelemetryUpdateAt = ts;
  evaluateAlertThresholds(db);
  scheduleMonitoringPersist(db);
}

export function noteServerHealthCheck(
  db: AdminFirestoreLike,
  status: 'ok' | 'degraded' | 'unavailable',
  probeMs?: number
): void {
  const store = getStore(db);
  const nowIso = new Date().toISOString();
  store.lastHealthCheckAt = nowIso;
  store.lastHealthCheckStatus = status;
  if (typeof probeMs === 'number' && Number.isFinite(probeMs)) {
    store.lastHealthProbeMs = roundMs(probeMs);
  }
  if (status !== 'ok') {
    raiseOrGroupAlert(db, {
      groupKey: 'ALERT_BACKEND_OR_FIREBASE_DEGRADED',
      severity: 'CRITICAL',
      module: 'Backend APIs',
      title: 'Backend / Firebase Health Check Degraded',
      description: `Server health check reported status "${status}".`,
      affectedOperation: 'GET /api/health',
    });
  }
}

// ============================================================================
// Express Request Correlation & Latency Instrumentation Middleware
// ============================================================================
export function createMonitoringRequestMiddleware(getDb: () => AdminFirestoreLike | null) {
  return (req: Request, res: Response, next: NextFunction) => {
    const startNs = performance.now();
    const headerCid = String(req.headers['x-correlation-id'] || '').trim();
    const correlationId =
      headerCid && /^[A-Za-z0-9_.-]{6,64}$/.test(headerCid)
        ? headerCid
        : `req_${crypto.randomBytes(6).toString('hex')}`;

    (req as any).correlationId = correlationId;
    res.setHeader('X-Correlation-ID', correlationId);

    const pathOnly = String(req.path || req.originalUrl || '/').split('?')[0];
    if (!pathOnly.startsWith('/api')) {
      return next();
    }

    res.on('finish', () => {
      const db = getDb();
      if (!db) return;
      const durationMs = roundMs(performance.now() - startNs);
      const status = res.statusCode || 200;
      const timedOut = status === 408 || status === 504;
      const success = status >= 200 && status < 400;

      // Do not log high-frequency self-reads from monitoring dashboard into API error loops,
      // but DO record its latency accurately unless excluded.
      recordApiMetric(db, {
        endpoint: pathOnly,
        method: req.method.toUpperCase(),
        status,
        durationMs,
        success,
        timedOut,
        errorCategory: success ? 'NONE' : classifyHttpErrorCategory(status, timedOut),
        correlationId,
      });
    });

    return next();
  };
}

// ============================================================================
// Module Health Computation (Real Telemetry + Health Thresholds)
// ============================================================================
const MONITORED_MODULES = [
  'Authentication',
  'Dashboard',
  'Employee Master',
  'Attendance Scanner',
  'QR Code Management',
  'Excel Import / Update',
  'Attendance History',
  'Reports & Export',
  'Shift Management',
  'Organization Management',
  'User Rights & Permissions',
  'Audit Logs & Security',
  'Firebase / Firestore',
  'Backend APIs',
] as const;

export function computeModuleHealthMatrix(
  db: AdminFirestoreLike,
  nowMs: number = Date.now()
): Array<{
  module: string;
  status: HealthStatus;
  sampleCount: number;
  errorCount: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  lastErrorAt: string | null;
  lastActivityAt: string | null;
  reason: string;
}> {
  const store = getStore(db);
  const window1h = nowMs - 60 * 60_000;

  return MONITORED_MODULES.map((modName) => {
    // 1. Firebase / Firestore
    if (modName === 'Firebase / Firestore') {
      const ops = store.dbOps.filter((d) => d.timestampMs >= window1h);
      const errs = ops.filter((d) => !d.success);
      const permDenied = errs.filter((d) => d.isPermissionDenied);
      const stats = computeLatencyStats(ops.map((o) => o.durationMs));

      if (store.lastHealthCheckStatus === 'unavailable' || permDenied.length > 0) {
        return {
          module: modName,
          status: 'Critical',
          sampleCount: ops.length,
          errorCount: errs.length,
          avgLatencyMs: stats.avgMs,
          p95LatencyMs: stats.p95Ms,
          lastErrorAt: errs.length ? errs[errs.length - 1].timestamp : null,
          lastActivityAt: ops.length ? ops[ops.length - 1].timestamp : store.lastHealthCheckAt,
          reason:
            permDenied.length > 0
              ? `${permDenied.length} Firestore permission error(s) in last 1h`
              : 'Firestore connectivity degraded/unavailable',
        };
      }
      if (ops.length === 0 && !store.lastHealthCheckAt) {
        return {
          module: modName,
          status: 'Unknown / Not Instrumented',
          sampleCount: 0,
          errorCount: 0,
          avgLatencyMs: null,
          p95LatencyMs: null,
          lastErrorAt: null,
          lastActivityAt: null,
          reason: 'No database operations or probe recorded yet in current window',
        };
      }
      const errRate = ops.length > 0 ? errs.length / ops.length : 0;
      const status: HealthStatus =
        errRate > 0.1
          ? 'Critical'
          : errs.length > 0 || (stats.p95Ms ?? 0) > 1000
            ? 'Degraded'
            : (stats.p95Ms ?? 0) > 600
              ? 'Warning'
              : 'Healthy';

      return {
        module: modName,
        status,
        sampleCount: ops.length || 1,
        errorCount: errs.length,
        avgLatencyMs: stats.avgMs ?? store.lastHealthProbeMs,
        p95LatencyMs: stats.p95Ms ?? store.lastHealthProbeMs,
        lastErrorAt: errs.length ? errs[errs.length - 1].timestamp : null,
        lastActivityAt: ops.length ? ops[ops.length - 1].timestamp : store.lastHealthCheckAt,
        reason:
          status === 'Healthy'
            ? 'Admin SDK & Firestore read/write probes operating within latency SLA'
            : `${errs.length} DB failure(s); P95 ${stats.p95Ms ?? '--'}ms`,
      };
    }

    // 2. Backend APIs
    if (modName === 'Backend APIs') {
      const apis = store.apiTraces.filter((a) => a.timestampMs >= window1h);
      if (apis.length === 0 && !store.lastHealthCheckAt) {
        return {
          module: modName,
          status: 'Unknown / Not Instrumented',
          sampleCount: 0,
          errorCount: 0,
          avgLatencyMs: null,
          p95LatencyMs: null,
          lastErrorAt: null,
          lastActivityAt: null,
          reason: 'No backend HTTP requests recorded yet',
        };
      }
      const serverErrs = apis.filter((a) => !a.success && a.status >= 500);
      const timeouts = apis.filter((a) => a.timedOut);
      const stats = computeLatencyStats(apis.map((a) => a.durationMs));
      const errPct = apis.length ? (serverErrs.length / apis.length) * 100 : 0;

      const status: HealthStatus =
        store.lastHealthCheckStatus === 'unavailable' || errPct > 15 || timeouts.length >= 3
          ? 'Critical'
          : serverErrs.length > 0 || (stats.p95Ms ?? 0) > store.thresholds.apiP95WarningMs
            ? 'Degraded'
            : (stats.p95Ms ?? 0) > store.thresholds.apiP95WarningMs * 0.75
              ? 'Warning'
              : 'Healthy';

      return {
        module: modName,
        status,
        sampleCount: apis.length,
        errorCount: serverErrs.length + timeouts.length,
        avgLatencyMs: stats.avgMs,
        p95LatencyMs: stats.p95Ms,
        lastErrorAt: serverErrs.length ? serverErrs[serverErrs.length - 1].timestamp : null,
        lastActivityAt: apis.length ? apis[apis.length - 1].timestamp : store.lastHealthCheckAt,
        reason:
          status === 'Healthy'
            ? `All ${apis.length} recent API requests healthy`
            : `${serverErrs.length} 5xx errors, ${timeouts.length} timeouts, P95 ${stats.p95Ms ?? '--'}ms`,
      };
    }

    // 3. Domain Modules (combine API traces matching module + client perf + QR punches + errors)
    const modApis = store.apiTraces.filter(
      (a) => a.timestampMs >= window1h && mapEndpointToModule(a.endpoint) === modName
    );
    const modErrors = store.errors.filter(
      (e) => e.timestampMs >= window1h && e.module === modName
    );
    const modPerf = store.clientPerf.filter(
      (c) => c.timestampMs >= window1h && c.module === modName
    );
    const modActivities = store.activities.filter(
      (act) => act.timestampMs >= window1h && act.module === modName
    );

    const isScanner = modName === 'Attendance Scanner';
    const qrRecent = isScanner ? store.qrPunches.filter((q) => q.timestampMs >= window1h) : [];

    const totalSamples = modApis.length + modPerf.length + qrRecent.length;
    if (totalSamples === 0 && modErrors.length === 0) {
      return {
        module: modName,
        status: 'Unknown / Not Instrumented',
        sampleCount: 0,
        errorCount: 0,
        avgLatencyMs: null,
        p95LatencyMs: null,
        lastErrorAt: null,
        lastActivityAt: modActivities.length
          ? modActivities[modActivities.length - 1].timestamp
          : null,
        reason: 'No execution samples recorded for this module in the last 1h',
      };
    }

    const latencies = [
      ...modApis.map((a) => a.durationMs),
      ...modPerf.map((p) => p.durationMs),
      ...qrRecent.map((q) => q.totalServerMs ?? 0).filter((v) => v > 0),
    ];
    const stats = computeLatencyStats(latencies);
    const criticalErrs = modErrors.filter((e) => e.severity === 'CRITICAL').length;
    const server5xx = modApis.filter((a) => !a.success && a.status >= 500).length;

    let status: HealthStatus = 'Healthy';
    if (criticalErrs > 0 || server5xx > 0) {
      status = criticalErrs >= 3 || server5xx >= 2 ? 'Critical' : 'Degraded';
    } else if (
      modErrors.length > 0 ||
      (stats.p95Ms !== null && stats.p95Ms > store.thresholds.apiP95WarningMs)
    ) {
      status = 'Warning';
    }

    return {
      module: modName,
      status,
      sampleCount: totalSamples,
      errorCount: modErrors.length,
      avgLatencyMs: stats.avgMs,
      p95LatencyMs: stats.p95Ms,
      lastErrorAt: modErrors.length ? modErrors[modErrors.length - 1].timestamp : null,
      lastActivityAt:
        modApis[modApis.length - 1]?.timestamp ||
        modActivities[modActivities.length - 1]?.timestamp ||
        modPerf[modPerf.length - 1]?.timestamp ||
        null,
      reason:
        status === 'Healthy'
          ? `${totalSamples} measured operation(s), 0 errors`
          : `${modErrors.length} error(s), P95 latency ${stats.p95Ms ?? '--'}ms`,
    };
  });
}

// ============================================================================
// Validation Schemas for Authenticated Ingestion, Alerts & Thresholds
// ============================================================================
const ClientTelemetryEventSchema = z.object({
  kind: z.enum(['PERF', 'ERROR', 'API_CLIENT', 'ACTIVITY', 'NETWORK_PROBE', 'SPEED_TEST']),
  metric: z.string().trim().min(1).max(64).optional(),
  module: z.string().trim().min(1).max(64).default('Frontend'),
  durationMs: z.number().min(0).max(300_000).optional(),
  action: z.string().trim().min(1).max(80).optional(),
  result: z.enum(['Success', 'Failed']).optional(),
  endpoint: z.string().trim().min(1).max(160).optional(),
  method: z.string().trim().min(1).max(10).optional(),
  status: z.number().int().min(0).max(599).optional(),
  timedOut: z.boolean().optional(),
  errorCategory: z.string().trim().max(48).optional(),
  message: z.string().trim().max(300).optional(),
  correlationId: z.string().trim().max(64).optional(),
  timestampMs: z.number().int().optional(),
  // Network probe & speed-test telemetry fields
  sessionId: z.string().trim().min(2).max(64).optional(),
  online: z.boolean().optional(),
  probeSucceeded: z.boolean().optional(),
  rttMs: z.number().min(0).max(120_000).nullable().optional(),
  serverProcessMs: z.number().min(0).max(30_000).nullable().optional(),
  dnsMs: z.number().min(0).max(60_000).nullable().optional(),
  tcpConnectMs: z.number().min(0).max(60_000).nullable().optional(),
  tlsHandshakeMs: z.number().min(0).max(60_000).nullable().optional(),
  connectionType: z.string().trim().max(32).optional(),
  effectiveType: z.string().trim().max(16).optional(),
  downlinkEstimateMbps: z.number().min(0).max(10_000).nullable().optional(),
  browserRttEstimateMs: z.number().min(0).max(60_000).nullable().optional(),
  disconnectionEvent: z.boolean().optional(),
  userAgentShort: z.string().trim().max(64).optional(),
  downloadMbps: z.number().min(0).max(20_000).nullable().optional(),
  uploadMbps: z.number().min(0).max(20_000).nullable().optional(),
  downloadBytes: z.number().int().min(0).max(1_048_576).optional(),
  uploadBytes: z.number().int().min(0).max(1_048_576).optional(),
  downloadDurationMs: z.number().min(0).max(120_000).optional(),
  uploadDurationMs: z.number().min(0).max(120_000).optional(),
});

const IngestTelemetrySchema = z.object({
  events: z
    .array(ClientTelemetryEventSchema)
    .min(1, 'At least one telemetry event is required.')
    .max(50, 'Maximum 50 telemetry events allowed per ingestion batch.'),
});

const AlertActionSchema = z.object({
  groupKey: z.string().trim().min(1).max(100),
  action: z.enum(['ACKNOWLEDGE', 'RESOLVE', 'REOPEN']),
});

const ThresholdUpdateSchema = z.object({
  apiP95WarningMs: z.number().min(100).max(30_000).optional(),
  apiErrorRateWarningPct: z.number().min(1).max(100).optional(),
  qrPunchAvgWarningMs: z.number().min(100).max(30_000).optional(),
  qrFailureSpikeCount: z.number().int().min(1).max(500).optional(),
  txFailureWarningCount: z.number().int().min(1).max(200).optional(),
  frontendErrorSpikeCount: z.number().int().min(1).max(500).optional(),
  unauthorizedSpikeCount: z.number().int().min(1).max(100).optional(),
  alertCooldownMinutes: z.number().int().min(1).max(1440).optional(),
  clientSampleRate: z.number().min(0.05).max(1.0).optional(),
  retentionDays: z.number().int().min(1).max(90).optional(),
  netLatencyGoodMaxMs: z.number().min(5).max(5000).optional(),
  netLatencyWarnMaxMs: z.number().min(10).max(5000).optional(),
  netLatencyPoorMaxMs: z.number().min(20).max(10_000).optional(),
  netLatencyCriticalMinMs: z.number().min(50).max(20_000).optional(),
  netJitterGoodMaxMs: z.number().min(1).max(2000).optional(),
  netJitterWarnMaxMs: z.number().min(5).max(5000).optional(),
  netPacketLossGoodMaxPct: z.number().min(0).max(100).optional(),
  netPacketLossWarnMaxPct: z.number().min(0.1).max(100).optional(),
  netDownloadGoodMinMbps: z.number().min(0.1).max(1000).optional(),
  netDownloadWarnMinMbps: z.number().min(0.1).max(1000).optional(),
  netUploadGoodMinMbps: z.number().min(0.1).max(1000).optional(),
  netUploadWarnMinMbps: z.number().min(0.1).max(1000).optional(),
  netProbeIntervalSec: z.number().int().min(10).max(300).optional(),
  netNetworkFailureSpikeCount: z.number().int().min(1).max(100).optional(),
});

// ============================================================================
// Route Registration
// ============================================================================
export interface MonitoringRoutesDeps {
  db: AdminFirestoreLike;
  requireVerifiedCaller: (
    req: Request,
    res: Response,
    allowedRoles: string[] | '*',
    actionLabel: string,
    options?: { prefetchUserPermission?: boolean }
  ) => Promise<VerifiedCaller | null>;
  projectId: string;
  databaseId: string;
  credentialMode: string;
}

export function registerMonitoringRoutes(app: express.Express, deps: MonitoringRoutesDeps) {
  const { db, requireVerifiedCaller, projectId, databaseId, credentialMode } = deps;

  async function ensureHydrated() {
    const store = getStore(db);
    if (store.hydratedFromDb) return;
    store.hydratedFromDb = true;
    try {
      const [cfgSnap, alertsSnap] = await Promise.all([
        db.collection('monitoring_config').doc('thresholds').get(),
        db.collection('monitoring_alerts').get(),
      ]);
      if (cfgSnap.exists) {
        const d = cfgSnap.data() || {};
        store.thresholds = {
          ...DEFAULT_MONITORING_THRESHOLDS,
          ...Object.fromEntries(
            Object.entries(d).filter(
              ([k, v]) => k in DEFAULT_MONITORING_THRESHOLDS && typeof v === 'number'
            )
          ),
        };
      }
      for (const docSnap of alertsSnap.docs) {
        const d = docSnap.data() as LiveAlertRecord | undefined;
        if (d && d.groupKey && !store.alerts.has(d.groupKey)) {
          store.alerts.set(d.groupKey, d);
        }
      }
    } catch {
      // Non-fatal startup hydration fallback
    }
  }

  // --------------------------------------------------------------------------
  // 1. POST /api/monitoring/ingest — Authenticated, Validated Client Telemetry
  //    (Signed-in users can report frontend errors/timings & UI navigation events;
  //     actor identity is derived strictly from Firebase ID token, zero spoofing.)
  // --------------------------------------------------------------------------
  app.post('/api/monitoring/ingest', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, '*', 'Monitoring Telemetry Ingest');
      if (!caller) return;

      const parsed = IngestTelemetrySchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          code: 'TELEMETRY_VALIDATION_ERROR',
          error: parsed.error.issues[0]?.message || 'Invalid telemetry payload.',
        });
      }

      const store = getStore(db);
      const nowMs = Date.now();
      let accepted = 0;

      for (const ev of parsed.data.events) {
        const tsMs =
          ev.timestampMs && Math.abs(nowMs - ev.timestampMs) <= 24 * 3600_000
            ? ev.timestampMs
            : nowMs;
        const tsIso = new Date(tsMs).toISOString();
        const cid = ev.correlationId || (req as any).correlationId;

        if (ev.kind === 'PERF' && typeof ev.durationMs === 'number') {
          pushBounded(
            store.clientPerf,
            {
              id: makeId('cperf'),
              metric: sanitizeTelemetryMessage(ev.metric || 'navigation_ms', 64),
              module: sanitizeTelemetryMessage(ev.module, 60),
              durationMs: roundMs(ev.durationMs),
              timestamp: tsIso,
              timestampMs: tsMs,
              correlationId: cid,
            },
            MAX_CLIENT_PERF
          );
          accepted++;
        } else if (ev.kind === 'ERROR') {
          pushBounded(
            store.errors,
            {
              id: makeId('err'),
              source: 'FRONTEND',
              module: sanitizeTelemetryMessage(ev.module, 60),
              category: sanitizeTelemetryMessage(ev.errorCategory || 'JS_ERROR', 48),
              severity: 'WARNING',
              message: sanitizeTelemetryMessage(ev.message || 'Unhandled frontend error.'),
              statusCode: ev.status,
              timestamp: tsIso,
              timestampMs: tsMs,
              correlationId: cid,
            },
            MAX_ERROR_EVENTS
          );
          accepted++;
        } else if (ev.kind === 'API_CLIENT' && ev.endpoint) {
          // Record client-detected timeouts / unreachable network failures
          if (ev.timedOut || ev.status === 0 || (ev.status !== undefined && ev.status >= 500)) {
            pushBounded(
              store.errors,
              {
                id: makeId('err'),
                source: 'FRONTEND',
                module: mapEndpointToModule(normalizeApiEndpointPath(ev.endpoint)),
                category: ev.timedOut ? 'CLIENT_TIMEOUT' : 'NETWORK_FAILURE',
                severity: ev.timedOut ? 'CRITICAL' : 'WARNING',
                message: sanitizeTelemetryMessage(
                  ev.message ||
                    `${ev.method || 'GET'} ${normalizeApiEndpointPath(ev.endpoint)} network/timeout error`
                ),
                statusCode: ev.status,
                timestamp: tsIso,
                timestampMs: tsMs,
                correlationId: cid,
              },
              MAX_ERROR_EVENTS
            );
          }
          if (typeof ev.durationMs === 'number' && ev.metric) {
            pushBounded(
              store.clientPerf,
              {
                id: makeId('cperf'),
                metric: sanitizeTelemetryMessage(ev.metric, 64),
                module: mapEndpointToModule(normalizeApiEndpointPath(ev.endpoint)),
                durationMs: roundMs(ev.durationMs),
                timestamp: tsIso,
                timestampMs: tsMs,
                correlationId: cid,
              },
              MAX_CLIENT_PERF
            );
          }
          accepted++;
        } else if (ev.kind === 'ACTIVITY' && ev.action) {
          recordActivityTelemetry(db, {
            actorUid: caller.uid,
            actorLoginId: caller.loginId,
            actorRole: caller.role.toUpperCase(),
            action: ev.action,
            module: ev.module,
            result: ev.result || 'Success',
            correlationId: cid,
            detail: ev.message,
          });
          accepted++;
        } else if (ev.kind === 'NETWORK_PROBE') {
          const isOffline = ev.online === false || ev.disconnectionEvent === true;
          if (isOffline) {
            store.disconnectionCount += 1;
            store.lastDisconnectionAt = tsIso;
          }
          pushBounded(
            store.networkSamples,
            {
              id: makeId('net'),
              sessionId: sanitizeTelemetryMessage(ev.sessionId || `sess_${caller.uid.slice(0, 8)}`, 64),
              actorLoginId: caller.loginId,
              actorRole: caller.role.toUpperCase(),
              online: ev.online ?? true,
              probeSucceeded: ev.probeSucceeded ?? !isOffline,
              rttMs: typeof ev.rttMs === 'number' ? roundMs(ev.rttMs) : null,
              serverProcessMs: typeof ev.serverProcessMs === 'number' ? roundMs(ev.serverProcessMs) : null,
              dnsMs: typeof ev.dnsMs === 'number' && ev.dnsMs > 0 ? roundMs(ev.dnsMs) : null,
              tcpConnectMs:
                typeof ev.tcpConnectMs === 'number' && ev.tcpConnectMs > 0
                  ? roundMs(ev.tcpConnectMs)
                  : null,
              tlsHandshakeMs:
                typeof ev.tlsHandshakeMs === 'number' && ev.tlsHandshakeMs > 0
                  ? roundMs(ev.tlsHandshakeMs)
                  : null,
              connectionType: sanitizeTelemetryMessage(ev.connectionType || 'Unavailable', 32),
              effectiveType: sanitizeTelemetryMessage(ev.effectiveType || 'Unavailable', 16),
              downlinkEstimateMbps:
                typeof ev.downlinkEstimateMbps === 'number' ? roundMs(ev.downlinkEstimateMbps) : null,
              browserRttEstimateMs:
                typeof ev.browserRttEstimateMs === 'number' ? roundMs(ev.browserRttEstimateMs) : null,
              disconnectionEvent: Boolean(ev.disconnectionEvent),
              userAgentShort: sanitizeTelemetryMessage(ev.userAgentShort || 'Browser', 64),
              timestamp: tsIso,
              timestampMs: tsMs,
            },
            MAX_NETWORK_SAMPLES
          );
          accepted++;
        } else if (ev.kind === 'SPEED_TEST') {
          pushBounded(
            store.speedTests,
            {
              id: makeId('spd'),
              sessionId: sanitizeTelemetryMessage(ev.sessionId || `sess_${caller.uid.slice(0, 8)}`, 64),
              actorLoginId: caller.loginId,
              downloadMbps: typeof ev.downloadMbps === 'number' ? roundMs(ev.downloadMbps) : null,
              uploadMbps: typeof ev.uploadMbps === 'number' ? roundMs(ev.uploadMbps) : null,
              downloadBytes: Math.min(524_288, Math.max(0, ev.downloadBytes ?? 0)),
              uploadBytes: Math.min(524_288, Math.max(0, ev.uploadBytes ?? 0)),
              downloadDurationMs: roundMs(ev.downloadDurationMs ?? 0),
              uploadDurationMs: roundMs(ev.uploadDurationMs ?? 0),
              timestamp: tsIso,
              timestampMs: tsMs,
            },
            MAX_SPEED_TESTS
          );
          accepted++;
        }
      }

      store.lastTelemetryUpdateAt = new Date().toISOString();
      evaluateAlertThresholds(db);
      scheduleMonitoringPersist(db);

      return res.json({
        success: true,
        accepted,
        correlationId: (req as any).correlationId,
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err?.message || 'Telemetry ingestion failed.',
      });
    }
  });

  // --------------------------------------------------------------------------
  // 2. GET /api/monitoring/overview — Super Admin System Overview, Analytics & Metrics
  // --------------------------------------------------------------------------
  app.get('/api/monitoring/overview', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        ['super_admin'],
        'System Performance Overview'
      );
      if (!caller) return;

      await ensureHydrated();
      const store = getStore(db);

      const rangeParam = String(req.query.range || '24h').toLowerCase();
      const fromParam = req.query.from ? new Date(String(req.query.from)).getTime() : NaN;
      const toParam = req.query.to ? new Date(String(req.query.to)).getTime() : NaN;
      const nowMs = Date.now();

      let windowStartMs = nowMs - 24 * 3600_000;
      let windowEndMs = nowMs;
      if (rangeParam === '15m') windowStartMs = nowMs - 15 * 60_000;
      else if (rangeParam === '1h') windowStartMs = nowMs - 3600_000;
      else if (rangeParam === '24h') windowStartMs = nowMs - 24 * 3600_000;
      else if (rangeParam === '7d') windowStartMs = nowMs - 7 * 24 * 3600_000;
      else if (rangeParam === '30d') windowStartMs = nowMs - 30 * 24 * 3600_000;
      else if (rangeParam === 'custom' && Number.isFinite(fromParam)) {
        windowStartMs = fromParam;
        if (Number.isFinite(toParam) && toParam >= fromParam) {
          windowEndMs = toParam;
        }
      }

      const inWindow = (tsMs: number) => tsMs >= windowStartMs && tsMs <= windowEndMs;

      const apis = store.apiTraces.filter((a) => inWindow(a.timestampMs));
      const dbOps = store.dbOps.filter((d) => inWindow(d.timestampMs));
      const qrList = store.qrPunches.filter((q) => inWindow(q.timestampMs));
      const cPerf = store.clientPerf.filter((c) => inWindow(c.timestampMs));
      const errList = store.errors.filter((e) => inWindow(e.timestampMs));
      const actList = store.activities.filter((act) => inWindow(act.timestampMs));
      const ioList = store.importExports.filter((io) => inWindow(io.timestampMs));

      // Active User Sessions: query recent login_history + user_roles for actual active accounts & recent logins
      let activeUserSessionsCount: number | null = null;
      let totalRegisteredAccounts: number | null = null;
      let recentAuditCount: number | null = null;
      let dbPingMs: number | null = null;
      let dbConnected = true;

      try {
        const pingStart = performance.now();
        const [rolesSnap, loginHistSnap] = await Promise.all([
          db.collection('user_roles').get(),
          db.collection('login_history').limit(200).get(),
        ]);
        dbPingMs = roundMs(performance.now() - pingStart);
        noteServerHealthCheck(db, 'ok', dbPingMs);

        totalRegisteredAccounts = rolesSnap.docs.filter((d) => d.data()?.status === 'Active').length;

        const sessionCutoff = nowMs - 8 * 3600_000; // 8h shift session window
        const latestByLogin = new Map<string, { eventType: string; tsMs: number }>();
        for (const docSnap of loginHistSnap.docs) {
          const d = docSnap.data() || {};
          const lid = String(d.loginId || '').trim().toLowerCase();
          if (!lid) continue;
          const tsMs = typeof d.timestampMs === 'number' ? d.timestampMs : new Date(d.timestamp || 0).getTime();
          if (!Number.isFinite(tsMs)) continue;
          const prev = latestByLogin.get(lid);
          if (!prev || tsMs > prev.tsMs) {
            latestByLogin.set(lid, { eventType: String(d.eventType || ''), tsMs });
          }
        }
        let activeSessions = 0;
        for (const v of latestByLogin.values()) {
          if (v.eventType === 'LOGIN_SUCCESS' && v.tsMs >= sessionCutoff) {
            activeSessions++;
          }
        }
        activeUserSessionsCount = activeSessions;
      } catch (dbErr: any) {
        dbConnected = false;
        noteServerHealthCheck(db, 'degraded');
        recordDbOpMetric(db, {
          operation: 'QUERY',
          collection: 'monitoring_probe',
          durationMs: 0,
          success: false,
          errorMessage: dbErr?.message || 'Health probe Firestore read failed.',
        });
      }

      // Compute API stats & endpoint breakdown
      const apiStats = computeLatencyStats(apis.map((a) => a.durationMs));
      const failedApiCount = apis.filter((a) => !a.success).length;
      const timeoutApiCount = apis.filter((a) => a.timedOut).length;

      const byEndpoint = new Map<
        string,
        {
          endpoint: string;
          method: string;
          count: number;
          errorCount: number;
          timeoutCount: number;
          durations: number[];
          lastStatus: number;
          lastTimestamp: string;
        }
      >();
      for (const a of apis) {
        const key = `${a.method} ${a.endpoint}`;
        let group = byEndpoint.get(key);
        if (!group) {
          group = {
            endpoint: a.endpoint,
            method: a.method,
            count: 0,
            errorCount: 0,
            timeoutCount: 0,
            durations: [],
            lastStatus: a.status,
            lastTimestamp: a.timestamp,
          };
          byEndpoint.set(key, group);
        }
        group.count++;
        if (!a.success) group.errorCount++;
        if (a.timedOut) group.timeoutCount++;
        group.durations.push(a.durationMs);
        group.lastStatus = a.status;
        group.lastTimestamp = a.timestamp;
      }

      const apiEndpointSummary = Array.from(byEndpoint.values())
        .map((g) => {
          const st = computeLatencyStats(g.durations);
          return {
            endpoint: g.endpoint,
            method: g.method,
            count: g.count,
            errorCount: g.errorCount,
            timeoutCount: g.timeoutCount,
            avgMs: st.avgMs,
            p50Ms: st.p50Ms,
            p95Ms: st.p95Ms,
            maxMs: st.maxMs,
            lastStatus: g.lastStatus,
            lastTimestamp: g.lastTimestamp,
          };
        })
        .sort((a, b) => (b.p95Ms ?? 0) - (a.p95Ms ?? 0));

      // QR & Attendance stats
      const qrInList = qrList.filter((q) => q.mode === 'QR_IN');
      const qrOutList = qrList.filter((q) => q.mode === 'QR_OUT');
      const manualList = qrList.filter((q) => q.mode === 'MANUAL_IN' || q.mode === 'MANUAL_OUT');
      const qrOnly = qrList.filter((q) => q.mode === 'QR_IN' || q.mode === 'QR_OUT');
      const qrDurations = qrOnly
        .map((q) => q.totalE2eMs ?? q.totalServerMs ?? 0)
        .filter((v) => v > 0);
      const qrStats = computeLatencyStats(qrDurations);
      const qrSuccessCount = qrOnly.filter((q) => q.success).length;
      const qrDuplicateRejects = qrOnly.filter((q) => q.isDuplicateRejection).length;
      const qrFailedCount = qrOnly.filter((q) => !q.success && !q.isDuplicateRejection).length;
      const qrTimeoutCount = qrOnly.filter((q) => q.timedOut).length;

      const stageStats = {
        qrDetect: computeLatencyStats(qrOnly.map((q) => q.qrDetectMs).filter((v): v is number => typeof v === 'number')),
        qrParse: computeLatencyStats(qrOnly.map((q) => q.qrParseMs).filter((v): v is number => typeof v === 'number')),
        apiRequest: computeLatencyStats(qrOnly.map((q) => q.apiRequestMs).filter((v): v is number => typeof v === 'number')),
        authTokenVerify: computeLatencyStats(qrOnly.map((q) => q.authMs).filter((v): v is number => typeof v === 'number')),
        tokenValidation: computeLatencyStats(qrOnly.map((q) => q.tokenValidationMs).filter((v): v is number => typeof v === 'number')),
        firestoreTx: computeLatencyStats(qrOnly.map((q) => q.txMs).filter((v): v is number => typeof v === 'number')),
        totalPunchIn: computeLatencyStats(qrInList.map((q) => q.totalE2eMs ?? q.totalServerMs).filter((v): v is number => typeof v === 'number')),
        totalPunchOut: computeLatencyStats(qrOutList.map((q) => q.totalE2eMs ?? q.totalServerMs).filter((v): v is number => typeof v === 'number')),
        manualPunch: computeLatencyStats(manualList.map((q) => q.totalE2eMs ?? q.totalServerMs).filter((v): v is number => typeof v === 'number')),
      };

      // Database Monitoring Summary
      const dbStats = computeLatencyStats(dbOps.map((d) => d.durationMs));
      const dbReads = dbOps.filter((d) => d.operation === 'READ' || d.operation === 'QUERY').length;
      const dbWrites = dbOps.filter((d) => d.operation === 'WRITE' || d.operation === 'BATCH').length;
      const dbTxList = dbOps.filter((d) => d.operation === 'TRANSACTION');
      const dbTxFailed = dbTxList.filter((d) => !d.success).length;
      const dbPermDenied = dbOps.filter((d) => d.isPermissionDenied).length;
      const dbNetErrors = dbOps.filter((d) => d.isNetworkError).length;
      const slowDbOps = dbOps.filter((d) => d.durationMs >= 500).slice(-30).reverse();

      // Website Client Perf Breakdown
      const groupClientMetric = (metricKey: string) =>
        computeLatencyStats(cPerf.filter((c) => c.metric === metricKey).map((c) => c.durationMs));

      const websitePerf = {
        initialLoad: groupClientMetric('app_initial_load_ms'),
        navigation: groupClientMetric('navigation_ms'),
        skeletonDuration: groupClientMetric('skeleton_visible_ms'),
        routePrefetch: groupClientMetric('route_prefetch_ms'),
        backgroundRefresh: groupClientMetric('background_refresh_ms'),
        slowRender: groupClientMetric('slow_render_ms'),
        jsErrorsCount: errList.filter((e) => e.source === 'FRONTEND' && e.category === 'JS_ERROR').length,
        promiseRejectionsCount: errList.filter((e) => e.source === 'FRONTEND' && e.category === 'UNHANDLED_REJECTION').length,
        networkFailuresCount: errList.filter((e) => e.source === 'FRONTEND' && (e.category === 'NETWORK_FAILURE' || e.category === 'CLIENT_TIMEOUT')).length,
      };

      // Time-Series Trend Buckets (Adaptive: 12 buckets across active window)
      const totalSpanMs = Math.max(60_000, windowEndMs - windowStartMs);
      const bucketCount = rangeParam === '7d' ? 7 : rangeParam === '30d' ? 15 : 12;
      const bucketStepMs = totalSpanMs / bucketCount;
      const timeSeries = Array.from({ length: bucketCount }, (_, idx) => {
        const bStart = windowStartMs + idx * bucketStepMs;
        const bEnd = bStart + bucketStepMs;
        const label =
          rangeParam === '7d' || rangeParam === '30d'
            ? new Date(bStart).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
            : new Date(bStart).toLocaleTimeString('en-IN', {
                timeZone: 'Asia/Kolkata',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
              });

        const bApis = apis.filter((a) => a.timestampMs >= bStart && a.timestampMs < bEnd);
        const bQr = qrOnly.filter((q) => q.timestampMs >= bStart && q.timestampMs < bEnd);
        const bDb = dbOps.filter((d) => d.timestampMs >= bStart && d.timestampMs < bEnd);
        const bErr = errList.filter((e) => e.timestampMs >= bStart && e.timestampMs < bEnd);
        const bAct = actList.filter((a) => a.timestampMs >= bStart && a.timestampMs < bEnd);
        const bIo = ioList.filter((io) => io.timestampMs >= bStart && io.timestampMs < bEnd);

        const apiAvg = computeLatencyStats(bApis.map((x) => x.durationMs)).avgMs;
        const qrAvg = computeLatencyStats(
          bQr.map((x) => x.totalE2eMs ?? x.totalServerMs ?? 0).filter((v) => v > 0)
        ).avgMs;
        const dbAvg = computeLatencyStats(bDb.map((x) => x.durationMs)).avgMs;
        const ioAvg = computeLatencyStats(bIo.map((x) => x.durationMs)).avgMs;

        return {
          label,
          bucketStartIso: new Date(bStart).toISOString(),
          apiAvgMs: apiAvg,
          apiCalls: bApis.length,
          qrAvgMs: qrAvg,
          qrPunches: bQr.length,
          dbAvgMs: dbAvg,
          errorCount: bErr.length,
          activityCount: bAct.length,
          importExportAvgMs: ioAvg,
          availabilityPct:
            bApis.length > 0
              ? roundMs(((bApis.length - bApis.filter((x) => !x.success && x.status >= 500).length) / bApis.length) * 100)
              : null,
        };
      });

      const moduleHealth = computeModuleHealthMatrix(db, nowMs);
      const alertsList = Array.from(store.alerts.values()).sort(
        (a, b) => b.lastTriggeredMs - a.lastTriggeredMs
      );
      const activeAlertsCount = alertsList.filter((a) => a.status === 'ACTIVE').length;

      // Overall system status
      let overallHealth: HealthStatus = 'Healthy';
      if (!dbConnected) {
        overallHealth = 'Critical';
      } else if (activeAlertsCount > 0 && alertsList.some((a) => a.status === 'ACTIVE' && a.severity === 'CRITICAL')) {
        overallHealth = 'Critical';
      } else if (
        activeAlertsCount > 0 ||
        moduleHealth.some((m) => m.status === 'Degraded' || m.status === 'Warning')
      ) {
        overallHealth = 'Warning';
      }

      // Historical rollups summary (Daily / Weekly / Monthly persisted in Firestore monitoring_rollups)
      let historicalRollups: any[] = [];
      try {
        const rollupSnap = await db.collection('monitoring_rollups').get();
        historicalRollups = rollupSnap.docs
          .map((d) => d.data())
          .filter(Boolean)
          .sort((a: any, b: any) => String(b.dateKey || '').localeCompare(String(a.dateKey || '')))
          .slice(0, 30);
      } catch {
        // Non-fatal rollup read fallback
      }

      // ----------------------------------------------------------------------
      // Internet & Network Performance Monitoring Aggregation
      // ----------------------------------------------------------------------
      const netSamples = store.networkSamples.filter((n) => inWindow(n.timestampMs));
      const speedTestsWindow = store.speedTests.filter((s) => inWindow(s.timestampMs));
      const latestSpeedAny =
        speedTestsWindow[speedTestsWindow.length - 1] ??
        store.speedTests[store.speedTests.length - 1] ??
        null;

      const successfulProbes = netSamples.filter((n) => n.probeSucceeded && n.rttMs !== null);
      const rttValues = successfulProbes.map((n) => n.rttMs as number);
      const rttNumStats = computeNumericStats(rttValues);
      const serverProcStats = computeNumericStats(
        successfulProbes
          .map((n) => n.serverProcessMs)
          .filter((v): v is number => typeof v === 'number')
      );
      const dnsStats = computeNumericStats(
        netSamples.map((n) => n.dnsMs).filter((v): v is number => typeof v === 'number' && v > 0)
      );
      const tcpStats = computeNumericStats(
        netSamples
          .map((n) => n.tcpConnectMs)
          .filter((v): v is number => typeof v === 'number' && v > 0)
      );
      const tlsStats = computeNumericStats(
        netSamples
          .map((n) => n.tlsHandshakeMs)
          .filter((v): v is number => typeof v === 'number' && v > 0)
      );

      const jitterValueMs = computeJitterFromRttSeries(rttValues);
      const jitterRating = classifyJitterRating(jitterValueMs, store.thresholds);
      const packetLossEval = evaluatePacketLoss(
        netSamples.map((n) => ({ success: n.probeSucceeded })),
        store.thresholds
      );

      const latestSample = netSamples[netSamples.length - 1] ?? store.networkSamples[store.networkSamples.length - 1] ?? null;
      const netOnline = latestSample ? latestSample.online : true;
      const lastSuccessfulNet = [...netSamples].reverse().find((n) => n.probeSucceeded) ?? null;

      const clientNetFailures = errList.filter(
        (e) =>
          e.source === 'FRONTEND' &&
          (e.category === 'NETWORK_FAILURE' || e.category === 'CLIENT_TIMEOUT')
      ).length;
      const totalClientPlusProbeRequests = netSamples.length + apis.length;
      const networkRequestFailureRatePct =
        totalClientPlusProbeRequests > 0
          ? roundMs((clientNetFailures / totalClientPlusProbeRequests) * 100)
          : netSamples.length > 0
            ? 0
            : null;

      const dlMbps = latestSpeedAny?.downloadMbps ?? null;
      const ulMbps = latestSpeedAny?.uploadMbps ?? null;
      const dlRating = classifyDownloadRating(dlMbps, store.thresholds);
      const ulRating = classifyUploadRating(ulMbps, store.thresholds);

      const healthScore = computeInternetHealthScore({
        online: netOnline,
        probeCount: netSamples.length,
        successfulProbeCount: successfulProbes.length,
        avgRttMs: rttNumStats.avg,
        jitterMs: jitterValueMs,
        packetLossPct: packetLossEval.reportablePacketLossPct,
        downloadMbps: dlMbps,
        uploadMbps: ulMbps,
        thresholds: store.thresholds,
      });

      const apiServerErrorCount = apis.filter((a) => !a.success && a.status >= 500).length;
      const diagnostics = diagnoseNetworkVsServer({
        online: netOnline,
        probeCount: netSamples.length,
        successfulProbeCount: successfulProbes.length,
        avgRttMs: rttNumStats.avg,
        p95RttMs: rttNumStats.p95,
        avgServerProbeProcessMs: serverProcStats.avg,
        jitterMs: jitterValueMs,
        packetLossPct: packetLossEval.reportablePacketLossPct,
        downloadMbps: dlMbps,
        uploadMbps: ulMbps,
        networkRequestFailureRatePct,
        apiSampleCount: apis.length,
        apiAvgMs: apiStats.avgMs,
        apiP95Ms: apiStats.p95Ms,
        apiServerErrorCount,
        apiTimeoutCount: timeoutApiCount,
        dbOpCount: dbOps.length,
        dbAvgOpMs: dbStats.avgMs,
        dbP95OpMs: dbStats.p95Ms,
        dbErrorCount: dbOps.filter((d) => !d.success).length,
        dbTxFailureCount: dbTxFailed,
        frontendPerfCount: cPerf.length,
        frontendSlowRenderAvgMs: websitePerf.slowRender.avgMs,
        frontendSlowRenderCount: websitePerf.slowRender.count,
        frontendNavAvgMs: websitePerf.navigation.avgMs,
        thresholds: store.thresholds,
      });

      // Build per-session device network summary (Zero PII/IP/location)
      const sessionMap = new Map<
        string,
        {
          sessionId: string;
          actorLoginId: string;
          actorRole: string;
          userAgentShort: string;
          connectionType: string;
          effectiveType: string;
          browserEstimatedDownlinkMbps: number | null;
          browserEstimatedRttMs: number | null;
          rtts: number[];
          online: boolean;
          lastSampleAt: string;
          lastSampleMs: number;
          failedCount: number;
        }
      >();
      for (const n of netSamples) {
        let rec = sessionMap.get(n.sessionId);
        if (!rec) {
          rec = {
            sessionId: n.sessionId,
            actorLoginId: n.actorLoginId,
            actorRole: n.actorRole,
            userAgentShort: n.userAgentShort,
            connectionType: n.connectionType,
            effectiveType: n.effectiveType,
            browserEstimatedDownlinkMbps: n.downlinkEstimateMbps,
            browserEstimatedRttMs: n.browserRttEstimateMs,
            rtts: [],
            online: n.online,
            lastSampleAt: n.timestamp,
            lastSampleMs: n.timestampMs,
            failedCount: 0,
          };
          sessionMap.set(n.sessionId, rec);
        }
        if (n.probeSucceeded && n.rttMs !== null) rec.rtts.push(n.rttMs);
        if (!n.probeSucceeded) rec.failedCount += 1;
        if (n.timestampMs >= rec.lastSampleMs) {
          rec.online = n.online;
          rec.connectionType = n.connectionType;
          rec.effectiveType = n.effectiveType;
          rec.browserEstimatedDownlinkMbps = n.downlinkEstimateMbps;
          rec.browserEstimatedRttMs = n.browserRttEstimateMs;
          rec.lastSampleAt = n.timestamp;
          rec.lastSampleMs = n.timestampMs;
          rec.userAgentShort = n.userAgentShort;
        }
      }

      const activeDeviceSessions = Array.from(sessionMap.values())
        .sort((a, b) => b.lastSampleMs - a.lastSampleMs)
        .slice(0, 50)
        .map((s) => {
          const st = computeNumericStats(s.rtts);
          const rating = classifyLatencyRating(st.last, store.thresholds);
          const status = !s.online
            ? 'CRITICAL'
            : rating === 'CRITICAL' || rating === 'POOR'
              ? 'CRITICAL'
              : rating === 'WARNING'
                ? 'WARNING'
                : rating === 'UNKNOWN'
                  ? 'UNKNOWN'
                  : 'GOOD';
          return {
            sessionId: s.sessionId,
            actorLoginId: s.actorLoginId,
            actorRole: s.actorRole,
            userAgentShort: s.userAgentShort,
            connectionType: s.connectionType,
            effectiveType: s.effectiveType,
            browserEstimatedDownlinkMbps: s.browserEstimatedDownlinkMbps,
            browserEstimatedRttMs: s.browserEstimatedRttMs,
            measuredRttAvgMs: st.avg,
            measuredRttLastMs: st.last,
            probeCount: s.rtts.length + s.failedCount,
            lastSampleAt: s.lastSampleAt,
            networkStatus: status,
          };
        });

      const networkHistoryBuckets = Array.from({ length: bucketCount }, (_, idx) => {
        const bStart = windowStartMs + idx * bucketStepMs;
        const bEnd = bStart + bucketStepMs;
        const label =
          rangeParam === '7d' || rangeParam === '30d'
            ? new Date(bStart).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
            : new Date(bStart).toLocaleTimeString('en-IN', {
                timeZone: 'Asia/Kolkata',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
              });

        const bNet = netSamples.filter((n) => n.timestampMs >= bStart && n.timestampMs < bEnd);
        const bOkRtts = bNet
          .filter((n) => n.probeSucceeded && n.rttMs !== null)
          .map((n) => n.rttMs as number);
        const bRttStats = computeNumericStats(bOkRtts);
        const bJitter = computeJitterFromRttSeries(bOkRtts);
        const bFail = bNet.filter((n) => !n.probeSucceeded).length;
        const bLossPct =
          bNet.length >= 5
            ? bFail === 1
              ? 0
              : roundMs((bFail / bNet.length) * 100)
            : null;
        const bSp = speedTestsWindow.filter((s) => s.timestampMs >= bStart && s.timestampMs < bEnd);
        const bApis = apis.filter((a) => a.timestampMs >= bStart && a.timestampMs < bEnd);
        const bApiStats = computeNumericStats(bApis.map((a) => a.durationMs));
        const bDlStats = computeNumericStats(
          bSp.map((s) => s.downloadMbps).filter((v): v is number => typeof v === 'number')
        );
        const bUlStats = computeNumericStats(
          bSp.map((s) => s.uploadMbps).filter((v): v is number => typeof v === 'number')
        );

        return {
          label,
          bucketStartIso: new Date(bStart).toISOString(),
          probeCount: bNet.length,
          rttAvgMs: bRttStats.avg,
          jitterMs: bJitter,
          packetLossPct: bLossPct,
          downloadMbps: bDlStats.avg,
          uploadMbps: bUlStats.avg,
          apiAvgMs: bApiStats.avg,
          disconnections: bNet.filter((n) => n.disconnectionEvent).length,
        };
      });

      const latencyRating = classifyLatencyRating(rttNumStats.avg, store.thresholds);
      const throughputStatus =
        dlRating === 'UNKNOWN' && ulRating === 'UNKNOWN'
          ? 'UNKNOWN'
          : dlRating === 'CRITICAL' || ulRating === 'CRITICAL'
            ? 'CRITICAL'
            : dlRating === 'WARNING' || ulRating === 'WARNING'
              ? 'WARNING'
              : 'GOOD';
      const backendVsNetStatus =
        diagnostics.primaryCause === 'Cause Unknown'
          ? 'UNKNOWN'
          : diagnostics.primaryCause === 'All Systems Nominal'
            ? 'GOOD'
            : diagnostics.confidence === 'High'
              ? 'CRITICAL'
              : 'WARNING';

      const networkMonitoring = {
        online: netOnline,
        connectionStatusLabel: !netOnline
          ? 'Disconnected (Offline)'
          : netSamples.length === 0
            ? 'Connected (Awaiting HTTP Probes)'
            : successfulProbes.length === 0
              ? 'Unreachable (Probes Failing)'
              : 'Connected',
        lastSuccessfulMeasurementAt: lastSuccessfulNet?.timestamp ?? null,
        lastDisconnectionAt: store.lastDisconnectionAt,
        disconnectionCount: store.disconnectionCount,
        rttStats: {
          currentMs: rttNumStats.last,
          avgMs: rttNumStats.avg,
          p50Ms: rttNumStats.p50,
          p95Ms: rttNumStats.p95,
          maxMs: rttNumStats.max,
          rating: latencyRating,
          sampleCount: rttNumStats.count,
        },
        avgServerProbeProcessMs: serverProcStats.avg,
        dnsMs: dnsStats.avg,
        tcpConnectMs: tcpStats.avg,
        tlsHandshakeMs: tlsStats.avg,
        timingMeasurementNote:
          'DNS, TCP, and TLS timings are extracted from Browser PerformanceResourceTiming only on fresh uncached connections where Timing-Allow-Origin permits; reused keep-alive sockets report null (Not Measurable).',
        jitter: {
          valueMs: jitterValueMs,
          rating: jitterRating,
          sampleCount: rttValues.length,
        },
        packetLoss: packetLossEval,
        speedTest: {
          latestDownloadMbps: dlMbps,
          latestUploadMbps: ulMbps,
          downloadRating: dlRating,
          uploadRating: ulRating,
          lastTestedAt: latestSpeedAny?.timestamp ?? null,
          isEstimate: true,
          disclosure:
            'Measured on manual trigger using bounded 256 KB HTTP payloads (not a multi-stream ISP throughput saturation benchmark).',
          recentTests: [...store.speedTests].reverse().slice(0, 20),
        },
        networkRequestFailureRatePct,
        backendApiAvgMs: apiStats.avgMs,
        backendApiP95Ms: apiStats.p95Ms,
        healthScore,
        diagnostics,
        indicatorStatuses: {
          connectivity: !netOnline ? 'CRITICAL' : netSamples.length === 0 ? 'UNKNOWN' : successfulProbes.length === 0 ? 'CRITICAL' : 'GOOD',
          latency:
            latencyRating === 'UNKNOWN'
              ? 'UNKNOWN'
              : latencyRating === 'CRITICAL' || latencyRating === 'POOR'
                ? 'CRITICAL'
                : latencyRating === 'WARNING'
                  ? 'WARNING'
                  : 'GOOD',
          jitter: jitterRating,
          packetLoss: packetLossEval.rating,
          throughput: throughputStatus,
          backendVsNetwork: backendVsNetStatus,
        },
        historyBuckets: networkHistoryBuckets,
        activeDeviceSessions,
        totalProbeSamplesInWindow: netSamples.length,
      };

      return res.json({
        success: true,
        generatedAt: new Date(nowMs).toISOString(),
        window: {
          range: rangeParam,
          fromIso: new Date(windowStartMs).toISOString(),
          toIso: new Date(windowEndMs).toISOString(),
        },
        overview: {
          overallHealth,
          backendStatus: dbConnected ? 'Healthy' : 'Degraded',
          frontendStatus:
            cPerf.length > 0
              ? websitePerf.jsErrorsCount >= store.thresholds.frontendErrorSpikeCount
                ? 'Warning'
                : 'Healthy'
              : 'Unknown / Not Instrumented',
          firebaseConnectivity: dbConnected ? 'Connected' : 'Error',
          firebasePingMs: dbPingMs,
          projectId,
          databaseId,
          credentialMode,
          apiAvgMs: apiStats.avgMs,
          apiP50Ms: apiStats.p50Ms,
          apiP95Ms: apiStats.p95Ms,
          totalApiRequests: apis.length,
          failedApiRequests: failedApiCount,
          timeoutApiRequests: timeoutApiCount,
          applicationErrorCount: errList.length,
          activeUserSessions: activeUserSessionsCount,
          totalActiveUserAccounts: totalRegisteredAccounts,
          recentAuditCount,
          qrPunchAvgMs: qrStats.avgMs,
          qrPunchP50Ms: qrStats.p50Ms,
          qrPunchP95Ms: qrStats.p95Ms,
          qrPunchMaxMs: qrStats.maxMs,
          qrPunchTotal: qrOnly.length,
          qrPunchSuccessRatePct:
            qrOnly.length > 0 ? roundMs((qrSuccessCount / qrOnly.length) * 100) : null,
          qrPunchFailureRatePct:
            qrOnly.length > 0 ? roundMs((qrFailedCount / qrOnly.length) * 100) : null,
          qrDuplicateRejections: qrDuplicateRejects,
          qrTimeouts: qrTimeoutCount,
          backgroundRefreshAvgMs: websitePerf.backgroundRefresh.avgMs,
          backgroundRefreshStatus:
            websitePerf.backgroundRefresh.count > 0 ? 'Active' : 'Unknown / Not Instrumented',
          lastSuccessfulHealthCheck: store.lastHealthCheckAt,
          lastMonitoringUpdate: store.lastTelemetryUpdateAt,
          activeAlertsCount,
        },
        websitePerf,
        apiMonitoring: {
          summary: apiStats,
          totalRequests: apis.length,
          failedRequests: failedApiCount,
          timeoutCount: timeoutApiCount,
          endpoints: apiEndpointSummary,
          recentTraces: [...apis].reverse().slice(0, 120),
        },
        databaseMonitoring: {
          connectivity: dbConnected ? 'Connected' : 'Unavailable',
          probeLatencyMs: dbPingMs,
          measuredTotalOps: dbOps.length,
          measuredReads: dbReads,
          measuredWrites: dbWrites,
          transactionCount: dbTxList.length,
          failedTransactionCount: dbTxFailed,
          avgOpDurationMs: dbStats.avgMs,
          p95OpDurationMs: dbStats.p95Ms,
          permissionDeniedCount: dbPermDenied,
          networkErrorCount: dbNetErrors,
          slowOperations: slowDbOps,
          bulkAndImportBatches: [...ioList].reverse().slice(0, 50),
          cloudBillingUsageStatus: 'Not Available',
          cloudBillingRequirement:
            'Requires server-side Google Cloud Monitoring API (@google-cloud/monitoring) and IAM role roles/monitoring.viewer on the backend service account for project-wide Firestore read/write billing & quota counters.',
        },
        qrPerformance: {
          summary: qrStats,
          successCount: qrSuccessCount,
          failedCount: qrFailedCount,
          duplicateRejections: qrDuplicateRejects,
          timeoutCount: qrTimeoutCount,
          stages: stageStats,
          recentPunches: [...qrList].reverse().slice(0, 100),
        },
        userActivity: [...actList].reverse().slice(0, 200),
        moduleHealth,
        errorLogs: [...errList].reverse().slice(0, 200),
        alerts: alertsList,
        thresholds: store.thresholds,
        timeSeries,
        historicalRollups,
        networkMonitoring,
      });
    } catch (err: any) {
      console.error('[Monitoring Overview] Error:', err);
      return res.status(500).json({
        success: false,
        error: err?.message || 'Failed to compute monitoring overview.',
      });
    }
  });

  // --------------------------------------------------------------------------
  // 3. POST /api/monitoring/health-probe — Live Backend + Firestore Probe
  // --------------------------------------------------------------------------
  app.post('/api/monitoring/health-probe', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        ['super_admin'],
        'System Health Probe'
      );
      if (!caller) return;

      const start = performance.now();
      await db.collection('system_settings').doc('global').get();
      const probeMs = roundMs(performance.now() - start);
      noteServerHealthCheck(db, 'ok', probeMs);
      recordDbOpMetric(db, {
        operation: 'READ',
        collection: 'system_settings',
        durationMs: probeMs,
        success: true,
        correlationId: (req as any).correlationId,
      });

      return res.json({
        success: true,
        status: 'ok',
        firestoreProbeMs: probeMs,
        checkedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      noteServerHealthCheck(db, 'degraded');
      recordDbOpMetric(db, {
        operation: 'READ',
        collection: 'system_settings',
        durationMs: 0,
        success: false,
        errorMessage: err?.message,
        correlationId: (req as any).correlationId,
      });
      return res.status(503).json({
        success: false,
        status: 'degraded',
        error: err?.message || 'Health probe failed.',
      });
    }
  });

  // --------------------------------------------------------------------------
  // 4. POST /api/monitoring/alerts/action — Acknowledge / Resolve / Reopen Alert
  // --------------------------------------------------------------------------
  app.post('/api/monitoring/alerts/action', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        ['super_admin'],
        'Update Monitoring Alert'
      );
      if (!caller) return;

      const parsed = AlertActionSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: parsed.error.issues[0]?.message || 'Invalid alert action payload.',
        });
      }

      const { groupKey, action } = parsed.data;
      const store = getStore(db);
      const alert = store.alerts.get(groupKey);
      if (!alert) {
        return res.status(404).json({
          success: false,
          error: 'Alert group not found.',
        });
      }

      const nowIso = new Date().toISOString();
      if (action === 'ACKNOWLEDGE') {
        alert.status = 'ACKNOWLEDGED';
        alert.acknowledgedAt = nowIso;
        alert.acknowledgedBy = caller.loginId;
      } else if (action === 'RESOLVE') {
        alert.status = 'RESOLVED';
        alert.resolvedAt = nowIso;
        alert.resolvedBy = caller.loginId;
      } else if (action === 'REOPEN') {
        alert.status = 'ACTIVE';
        alert.resolvedAt = null;
        alert.resolvedBy = null;
      }

      await db
        .collection('monitoring_alerts')
        .doc(groupKey)
        .set(alert, { merge: true })
        .catch(() => {});

      await recordEnterpriseAuditEvent(db, {
        req,
        action: `MONITORING_ALERT_${action}`,
        category: 'SYSTEM',
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        targetType: 'MONITORING_ALERT',
        targetId: groupKey,
        newValue: { status: alert.status },
        actionSource: 'SYSTEM_PERFORMANCE_CENTER',
        description: `Alert "${alert.title}" (${groupKey}) marked ${alert.status} by ${caller.loginId}.`,
        success: true,
      }).catch(() => {});

      return res.json({ success: true, alert });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err?.message || 'Failed to update monitoring alert.',
      });
    }
  });

  // --------------------------------------------------------------------------
  // 5. GET / POST /api/monitoring/thresholds — Configurable Alert Thresholds
  // --------------------------------------------------------------------------
  app.get('/api/monitoring/thresholds', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        ['super_admin'],
        'View Monitoring Thresholds'
      );
      if (!caller) return;
      await ensureHydrated();
      return res.json({
        success: true,
        thresholds: getStore(db).thresholds,
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err?.message || 'Failed to load thresholds.' });
    }
  });

  app.post('/api/monitoring/thresholds', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        ['super_admin'],
        'Update Monitoring Thresholds'
      );
      if (!caller) return;

      const parsed = ThresholdUpdateSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: parsed.error.issues[0]?.message || 'Invalid threshold parameters.',
        });
      }

      const store = getStore(db);
      const previous = { ...store.thresholds };
      store.thresholds = {
        ...store.thresholds,
        ...parsed.data,
      };

      await db
        .collection('monitoring_config')
        .doc('thresholds')
        .set(
          {
            ...store.thresholds,
            updatedAt: new Date().toISOString(),
            updatedBy: caller.loginId,
          },
          { merge: true }
        );

      await recordEnterpriseAuditEvent(db, {
        req,
        action: 'MONITORING_THRESHOLDS_UPDATED',
        category: 'SETTINGS',
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        targetType: 'MONITORING_CONFIG',
        targetId: 'thresholds',
        oldValue: previous,
        newValue: store.thresholds,
        actionSource: 'SYSTEM_PERFORMANCE_CENTER',
        description: `Updated live monitoring thresholds & alert configuration.`,
        success: true,
      }).catch(() => {});

      evaluateAlertThresholds(db);

      return res.json({
        success: true,
        thresholds: store.thresholds,
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err?.message || 'Failed to update monitoring thresholds.',
      });
    }
  });

  // --------------------------------------------------------------------------
  // 6. Controlled Lightweight Network Diagnostics (Ping & Bounded Speed Test)
  // --------------------------------------------------------------------------
  // ZERO Firestore reads/writes — pure in-memory timing probes so speed tests
  // & periodic connectivity checks never consume DB quota or impact attendance.
  const SPEEDTEST_PAYLOAD_BUFFER = crypto.randomBytes(524_288);

  app.get('/api/network/ping', async (req: Request, res: Response) => {
    const startNs = performance.now();
    try {
      const caller = await requireVerifiedCaller(req, res, '*', 'Network RTT Probe');
      if (!caller) return;

      const serverProcessMs = roundMs(performance.now() - startNs);
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Timing-Allow-Origin', '*');
      res.setHeader('X-Server-Process-Ms', String(serverProcessMs));
      res.setHeader('Server-Timing', `app;dur=${serverProcessMs}`);

      return res.json({
        ok: true,
        probeKind: 'HTTP_APP_RTT',
        serverTimeIso: new Date().toISOString(),
        serverProcessMs,
      });
    } catch (err: any) {
      return res.status(500).json({
        ok: false,
        error: err?.message || 'Network ping probe failed.',
      });
    }
  });

  app.get('/api/network/speedtest/download', async (req: Request, res: Response) => {
    const startNs = performance.now();
    try {
      const caller = await requireVerifiedCaller(req, res, '*', 'Network Download Speed Test');
      if (!caller) return;

      const requested = Number(req.query.bytes ?? 262_144);
      const boundedBytes = Number.isFinite(requested)
        ? Math.max(32_768, Math.min(524_288, Math.floor(requested)))
        : 262_144;

      const chunk = SPEEDTEST_PAYLOAD_BUFFER.subarray(0, boundedBytes);
      const serverProcessMs = roundMs(performance.now() - startNs);

      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Timing-Allow-Origin', '*');
      res.setHeader('X-Payload-Bytes', String(boundedBytes));
      res.setHeader('X-Server-Process-Ms', String(serverProcessMs));
      res.setHeader('Server-Timing', `app;dur=${serverProcessMs}`);
      return res.status(200).send(chunk);
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err?.message || 'Download speed test failed.',
      });
    }
  });

  app.post('/api/network/speedtest/upload', async (req: Request, res: Response) => {
    const startNs = performance.now();
    try {
      const caller = await requireVerifiedCaller(req, res, '*', 'Network Upload Speed Test');
      if (!caller) return;

      let receivedBytes = 0;
      const bodyVal = (req as any).body;
      if (Buffer.isBuffer(bodyVal)) {
        receivedBytes = bodyVal.byteLength;
      } else if (typeof bodyVal === 'string') {
        receivedBytes = Buffer.byteLength(bodyVal, 'utf8');
      } else if (bodyVal && typeof bodyVal === 'object') {
        receivedBytes = Buffer.byteLength(JSON.stringify(bodyVal), 'utf8');
      } else {
        const cl = Number(req.headers['content-length'] || 0);
        if (Number.isFinite(cl) && cl > 0) receivedBytes = cl;
      }

      if (receivedBytes > 600_000) {
        return res.status(413).json({
          success: false,
          error: 'Upload speed test payload exceeds 512 KB cap.',
        });
      }

      const serverReceiveMs = roundMs(performance.now() - startNs);
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Timing-Allow-Origin', '*');
      res.setHeader('X-Server-Process-Ms', String(serverReceiveMs));

      return res.json({
        success: true,
        receivedBytes,
        serverReceiveMs,
        checkedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err?.message || 'Upload speed test failed.',
      });
    }
  });
}
