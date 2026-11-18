// ============================================================================
// Client Performance Telemetry & Scoped Background Refresh Event Bus
// ============================================================================
// PRIVACY & SECURITY INVARIANT:
// - Stores ONLY non-sensitive numeric timings and operation/tab labels.
// - NEVER logs or stores passwords, Firebase ID tokens, QR secrets, or PII.
// ============================================================================

export type PerfMetricName =
  | 'app_initial_load_ms'
  | 'navigation_ms'
  | 'skeleton_visible_ms'
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

const MAX_SAMPLES_PER_METRIC = 200;
const metricsStore = new Map<PerfMetricName, number[]>();
const attendanceSubscribers = new Set<(detail: AttendanceCommittedDetail) => void>();

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

export function startPerfTimer(): () => number {
  const start = safeNow();
  return () => Math.max(0, roundMs(safeNow() - start));
}

export function recordPerfMetric(name: PerfMetricName, durationMs: number): void {
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

  if (
    typeof window !== 'undefined' &&
    ((import.meta as any)?.env?.DEV || (window as any).__NARID_PERF_DEBUG__ === true) &&
    typeof console !== 'undefined'
  ) {
    console.info(`[PERF] ${name}=${clean}ms`);
  }
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
  };
}
