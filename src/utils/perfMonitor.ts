// ============================================================================
// Client Performance Telemetry & Scoped Background Refresh Event Bus
// ============================================================================
// PRIVACY & SECURITY INVARIANT:
// - Stores ONLY non-sensitive numeric timings, sanitized error summaries, and
//   non-sensitive operational/module labels.
// - NEVER logs or stores passwords, Firebase ID tokens, QR secrets, or PII.
// ============================================================================

export type PerfMetricName =
  | 'app_initial_load_ms'
  | 'navigation_ms'
  | 'skeleton_visible_ms'
  | 'route_prefetch_ms'
  | 'slow_render_ms'
  | 'qr_detect_ms'
  | 'qr_parse_ms'
  | 'qr_api_ms'
  | 'qr_auth_token_ms'
  | 'qr_firestore_ms'
  | 'qr_punch_in_e2e_ms'
  | 'qr_punch_out_e2e_ms'
  | 'qr_scan_e2e_ms'
  | 'qr_scan_server_ms'
  | 'manual_punch_e2e_ms'
  | 'manual_punch_server_ms'
  | 'background_refresh_ms';

export interface PerfMetricStats {
  count: number;
  minMs: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  lastMs: number;
}

export interface AttendanceCommittedDetail {
  scannerType: 'IN' | 'OUT';
  action: 'PUNCH_IN' | 'PUNCH_OUT';
  attendanceId?: string;
  shiftDate?: string;
  timestamp: number;
}

export interface ClientTelemetryEventInput {
  kind: 'PERF' | 'ERROR' | 'API_CLIENT' | 'ACTIVITY' | 'NETWORK_PROBE' | 'SPEED_TEST';
  metric?: string;
  module: string;
  durationMs?: number;
  action?: string;
  result?: 'Success' | 'Failed';
  endpoint?: string;
  method?: string;
  status?: number;
  timedOut?: boolean;
  errorCategory?: string;
  message?: string;
  correlationId?: string;
  timestampMs?: number;
  sessionId?: string;
  online?: boolean;
  probeSucceeded?: boolean;
  rttMs?: number | null;
  serverProcessMs?: number | null;
  dnsMs?: number | null;
  tcpConnectMs?: number | null;
  tlsHandshakeMs?: number | null;
  connectionType?: string;
  effectiveType?: string;
  downlinkEstimateMbps?: number | null;
  browserRttEstimateMs?: number | null;
  disconnectionEvent?: boolean;
  userAgentShort?: string;
  downloadMbps?: number | null;
  uploadMbps?: number | null;
  downloadBytes?: number;
  uploadBytes?: number;
  downloadDurationMs?: number;
  uploadDurationMs?: number;
}

export const TAB_TO_MODULE_NAME: Record<string, string> = {
  dashboard: 'Dashboard',
  scanner: 'Attendance Scanner',
  employees: 'Employee Master',
  excel_import: 'Excel Import / Update',
  qr_codes: 'QR Code Management',
  floors: 'Organization Management',
  sections: 'Organization Management',
  departments: 'Organization Management',
  shifts: 'Shift Management',
  history: 'Attendance History',
  reports: 'Reports & Export',
  user_rights: 'User Rights & Permissions',
  audit_logs: 'Audit Logs & Security',
  security_management: 'Audit Logs & Security',
  system_performance: 'System Performance',
  settings: 'System Settings',
};

const MAX_SAMPLES_PER_METRIC = 200;
const MAX_TELEMETRY_QUEUE = 100;
const metricsStore = new Map<PerfMetricName, number[]>();
const telemetryQueue: ClientTelemetryEventInput[] = [];
const attendanceSubscribers = new Set<(detail: AttendanceCommittedDetail) => void>();

let globalMonitoringInstalled = false;

export const ATTENDANCE_UPDATED_EVENT = 'narid:attendance-updated';

function safeNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function computePercentile(sorted: number[], percentile: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1)
  );
  return roundMs(sorted[idx]);
}

function inferModuleFromMetric(name: PerfMetricName): string {
  if (name.startsWith('qr_') || name.startsWith('manual_punch_')) {
    return 'Attendance Scanner';
  }
  if (name === 'skeleton_visible_ms') {
    return 'Dashboard';
  }
  return 'Frontend';
}

export function sanitizeTelemetryText(raw: unknown, maxLen = 280): string {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  s = s.replace(/Bearer\s+[A-Za-z0-9\-._~+/=]+/gi, 'Bearer [REDACTED]');
  s = s.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, '[REDACTED_JWT]');
  s = s.replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED_KEY]');
  s = s.replace(/\bQR_[A-Za-z0-9_.-]+\b/g, '[REDACTED_QR]');
  s = s.replace(/\{\s*"employeeId"[^}]*"token"[^}]*\}/gi, '[REDACTED_QR_JSON]');
  s = s.replace(/(password|passcode|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
  if (s.length > maxLen) {
    s = `${s.slice(0, maxLen - 3)}...`;
  }
  return s;
}

export function queueClientTelemetry(event: ClientTelemetryEventInput): void {
  if (!event || !event.kind) return;
  const cleanEvent: ClientTelemetryEventInput = {
    kind: event.kind,
    module: sanitizeTelemetryText(event.module || 'Frontend', 64) || 'Frontend',
    timestampMs: typeof event.timestampMs === 'number' ? event.timestampMs : Date.now(),
  };

  if (event.metric) cleanEvent.metric = sanitizeTelemetryText(event.metric, 64);
  if (typeof event.durationMs === 'number' && Number.isFinite(event.durationMs) && event.durationMs >= 0) {
    cleanEvent.durationMs = Math.min(300_000, roundMs(event.durationMs));
  }
  if (event.action) cleanEvent.action = sanitizeTelemetryText(event.action, 80);
  if (event.result) cleanEvent.result = event.result;
  if (event.endpoint) cleanEvent.endpoint = sanitizeTelemetryText(event.endpoint, 160);
  if (event.method) cleanEvent.method = sanitizeTelemetryText(event.method, 10).toUpperCase();
  if (typeof event.status === 'number' && Number.isFinite(event.status)) {
    cleanEvent.status = Math.max(0, Math.min(599, Math.round(event.status)));
  }
  if (typeof event.timedOut === 'boolean') cleanEvent.timedOut = event.timedOut;
  if (event.errorCategory) cleanEvent.errorCategory = sanitizeTelemetryText(event.errorCategory, 48);
  if (event.message) cleanEvent.message = sanitizeTelemetryText(event.message, 280);
  if (event.correlationId) cleanEvent.correlationId = sanitizeTelemetryText(event.correlationId, 64);

  if (event.sessionId) cleanEvent.sessionId = sanitizeTelemetryText(event.sessionId, 64);
  if (typeof event.online === 'boolean') cleanEvent.online = event.online;
  if (typeof event.probeSucceeded === 'boolean') cleanEvent.probeSucceeded = event.probeSucceeded;
  if (event.rttMs !== undefined) cleanEvent.rttMs = typeof event.rttMs === 'number' ? roundMs(event.rttMs) : null;
  if (event.serverProcessMs !== undefined) {
    cleanEvent.serverProcessMs = typeof event.serverProcessMs === 'number' ? roundMs(event.serverProcessMs) : null;
  }
  if (event.dnsMs !== undefined) cleanEvent.dnsMs = typeof event.dnsMs === 'number' ? roundMs(event.dnsMs) : null;
  if (event.tcpConnectMs !== undefined) {
    cleanEvent.tcpConnectMs = typeof event.tcpConnectMs === 'number' ? roundMs(event.tcpConnectMs) : null;
  }
  if (event.tlsHandshakeMs !== undefined) {
    cleanEvent.tlsHandshakeMs = typeof event.tlsHandshakeMs === 'number' ? roundMs(event.tlsHandshakeMs) : null;
  }
  if (event.connectionType) cleanEvent.connectionType = sanitizeTelemetryText(event.connectionType, 32);
  if (event.effectiveType) cleanEvent.effectiveType = sanitizeTelemetryText(event.effectiveType, 16);
  if (event.downlinkEstimateMbps !== undefined) {
    cleanEvent.downlinkEstimateMbps =
      typeof event.downlinkEstimateMbps === 'number' ? roundMs(event.downlinkEstimateMbps) : null;
  }
  if (event.browserRttEstimateMs !== undefined) {
    cleanEvent.browserRttEstimateMs =
      typeof event.browserRttEstimateMs === 'number' ? roundMs(event.browserRttEstimateMs) : null;
  }
  if (typeof event.disconnectionEvent === 'boolean') cleanEvent.disconnectionEvent = event.disconnectionEvent;
  if (event.userAgentShort) cleanEvent.userAgentShort = sanitizeTelemetryText(event.userAgentShort, 64);
  if (event.downloadMbps !== undefined) {
    cleanEvent.downloadMbps = typeof event.downloadMbps === 'number' ? roundMs(event.downloadMbps) : null;
  }
  if (event.uploadMbps !== undefined) {
    cleanEvent.uploadMbps = typeof event.uploadMbps === 'number' ? roundMs(event.uploadMbps) : null;
  }
  if (typeof event.downloadBytes === 'number') cleanEvent.downloadBytes = event.downloadBytes;
  if (typeof event.uploadBytes === 'number') cleanEvent.uploadBytes = event.uploadBytes;
  if (typeof event.downloadDurationMs === 'number') cleanEvent.downloadDurationMs = roundMs(event.downloadDurationMs);
  if (typeof event.uploadDurationMs === 'number') cleanEvent.uploadDurationMs = roundMs(event.uploadDurationMs);

  telemetryQueue.push(cleanEvent);
  if (telemetryQueue.length > MAX_TELEMETRY_QUEUE) {
    telemetryQueue.splice(0, telemetryQueue.length - MAX_TELEMETRY_QUEUE);
  }
}

export function drainClientTelemetryQueue(maxBatch = 40): ClientTelemetryEventInput[] {
  if (telemetryQueue.length === 0) return [];
  const count = Math.max(1, Math.min(maxBatch, telemetryQueue.length));
  return telemetryQueue.splice(0, count);
}

export function getPendingTelemetryCount(): number {
  return telemetryQueue.length;
}

export function reportUiActivity(
  action: string,
  moduleName: string,
  detail?: string,
  result: 'Success' | 'Failed' = 'Success'
): void {
  queueClientTelemetry({
    kind: 'ACTIVITY',
    action,
    module: moduleName,
    result,
    message: detail,
    timestampMs: Date.now(),
  });
}

export function startPerfTimer(): () => number {
  const start = safeNow();
  return () => Math.max(0, roundMs(safeNow() - start));
}

export function recordPerfMetric(
  name: PerfMetricName,
  durationMs: number,
  moduleName?: string
): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  const clean = roundMs(durationMs);
  let bucket = metricsStore.get(name);
  if (!bucket) {
    bucket = [];
    metricsStore.set(name, bucket);
  }
  bucket.push(clean);
  if (bucket.length > MAX_SAMPLES_PER_METRIC) {
    bucket.shift();
  }

  queueClientTelemetry({
    kind: 'PERF',
    metric: name,
    module: moduleName || inferModuleFromMetric(name),
    durationMs: clean,
    timestampMs: Date.now(),
  });

  if (
    typeof window !== 'undefined' &&
    ((import.meta as any)?.env?.DEV || (window as any).__NARID_PERF_DEBUG__ === true) &&
    typeof console !== 'undefined'
  ) {
    console.info(`[PERF] ${name}=${clean}ms`);
  }
}

export function installGlobalErrorMonitoring(getCurrentModule?: () => string): () => void {
  if (typeof window === 'undefined' || globalMonitoringInstalled) {
    return () => {};
  }
  globalMonitoringInstalled = true;

  const resolveModule = () => {
    try {
      return getCurrentModule?.() || 'Frontend';
    } catch {
      return 'Frontend';
    }
  };

  const onError = (event: ErrorEvent) => {
    const msg = event?.message || event?.error?.message || 'Uncaught frontend JavaScript error';
    queueClientTelemetry({
      kind: 'ERROR',
      module: resolveModule(),
      errorCategory: 'JS_ERROR',
      message: msg,
      timestampMs: Date.now(),
    });
  };

  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    const reason = event?.reason;
    const msg =
      typeof reason === 'string'
        ? reason
        : reason?.message || 'Unhandled frontend promise rejection';
    queueClientTelemetry({
      kind: 'ERROR',
      module: resolveModule(),
      errorCategory: 'UNHANDLED_REJECTION',
      message: msg,
      timestampMs: Date.now(),
    });
  };

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onUnhandledRejection);

  let longTaskObserver: PerformanceObserver | null = null;
  try {
    if (
      typeof PerformanceObserver !== 'undefined' &&
      Array.isArray((PerformanceObserver as any).supportedEntryTypes) &&
      (PerformanceObserver as any).supportedEntryTypes.includes('longtask')
    ) {
      longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration >= 150) {
            recordPerfMetric('slow_render_ms', entry.duration, resolveModule());
          }
        }
      });
      longTaskObserver.observe({ entryTypes: ['longtask'] });
    }
  } catch {
    // PerformanceObserver longtask not supported in this runtime
  }

  return () => {
    globalMonitoringInstalled = false;
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onUnhandledRejection);
    if (longTaskObserver) {
      try {
        longTaskObserver.disconnect();
      } catch {}
    }
  };
}

export function getPerfMetricStats(name: PerfMetricName): PerfMetricStats | null {
  const bucket = metricsStore.get(name);
  if (!bucket || bucket.length === 0) return null;
  const sorted = [...bucket].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    minMs: sorted[0],
    avgMs: roundMs(sum / sorted.length),
    p50Ms: computePercentile(sorted, 50),
    p95Ms: computePercentile(sorted, 95),
    maxMs: sorted[sorted.length - 1],
    lastMs: bucket[bucket.length - 1],
  };
}

export function getClientPerfSnapshot(): Partial<Record<PerfMetricName, PerfMetricStats>> {
  const out: Partial<Record<PerfMetricName, PerfMetricStats>> = {};
  for (const name of metricsStore.keys()) {
    const stats = getPerfMetricStats(name);
    if (stats) {
      out[name] = stats;
    }
  }
  return out;
}

export function resetPerfMetrics(): void {
  metricsStore.clear();
  telemetryQueue.length = 0;
}

export function notifyAttendanceCommitted(detail: AttendanceCommittedDetail): void {
  for (const listener of attendanceSubscribers) {
    try {
      listener(detail);
    } catch {
      // Never let a background subscriber break scanner readiness
    }
  }
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    try {
      window.dispatchEvent(new CustomEvent<AttendanceCommittedDetail>(ATTENDANCE_UPDATED_EVENT, { detail }));
    } catch {
      // Ignore environments without CustomEvent constructor
    }
  }
}

export function subscribeAttendanceCommitted(
  listener: (detail: AttendanceCommittedDetail) => void
): () => void {
  attendanceSubscribers.add(listener);
  return () => {
    attendanceSubscribers.delete(listener);
  };
}

if (typeof window !== 'undefined') {
  (window as any).__NARID_PERF__ = {
    getSnapshot: getClientPerfSnapshot,
    getStats: getPerfMetricStats,
    reset: resetPerfMetrics,
    getPendingTelemetryCount,
  };
}
