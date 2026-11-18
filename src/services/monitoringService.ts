import { auth } from '../firebase';
import { apiFetchJson, isApiBaseUsableForCurrentOrigin } from '../config/api';
import { getAuthHeaders } from './auditService';
import {
  drainClientTelemetryQueue,
  getPendingTelemetryCount,
  queueClientTelemetry,
} from '../utils/perfMonitor';

export type MonitoringTimeRange = '15m' | '1h' | '24h' | '7d' | '30d' | 'custom';

export type HealthStatus =
  | 'Healthy'
  | 'Degraded'
  | 'Warning'
  | 'Critical'
  | 'Unknown / Not Instrumented';

export interface LatencyStatsSummary {
  count: number;
  minMs: number | null;
  avgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
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

export interface MonitoringAlertItem {
  id: string;
  groupKey: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  module: string;
  title: string;
  description: string;
  affectedOperation: string;
  status: 'ACTIVE' | 'ACKNOWLEDGED' | 'RESOLVED';
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

export interface ModuleHealthItem {
  module: string;
  status: HealthStatus;
  sampleCount: number;
  errorCount: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  lastActivityAt: string | null;
  lastErrorAt: string | null;
  reason: string;
}

export interface ApiEndpointSummary {
  endpoint: string;
  method: string;
  count: number;
  errorCount: number;
  timeoutCount: number;
  avgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  lastStatus: number;
  lastTimestamp: string;
}

export interface ApiTraceItem {
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

export interface DbOpItem {
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

export interface ImportExportBatchItem {
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

export interface QrPunchTraceItem {
  id: string;
  mode: 'QR_IN' | 'QR_OUT' | 'MANUAL_IN' | 'MANUAL_OUT';
  action: string;
  success: boolean;
  isDuplicateRejection: boolean;
  timedOut: boolean;
  qrDetectMs?: number;
  qrParseMs?: number;
  apiRequestMs?: number;
  authMs?: number;
  permissionMs?: number;
  lookupAndQueryMs?: number;
  tokenValidationMs?: number;
  txMs?: number;
  firestoreOpMs?: number;
  totalServerMs?: number;
  totalE2eMs?: number;
  reasonCode?: string;
  timestamp: string;
  timestampMs: number;
  correlationId?: string;
}

export interface ErrorLogItem {
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

export interface UserActivityItem {
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

export interface TimeSeriesBucket {
  label: string;
  bucketStartIso: string;
  apiAvgMs: number | null;
  apiCalls: number;
  qrAvgMs: number | null;
  qrPunches: number;
  dbAvgMs: number | null;
  errorCount: number;
  activityCount: number;
  importExportAvgMs: number | null;
  availabilityPct: number | null;
}

export interface HistoricalRollupItem {
  dateKey?: string;
  weekKey?: string;
  monthKey?: string;
  updatedAt?: string;
  apiTotalCalls?: number;
  apiErrorCount?: number;
  apiAvgMs?: number | null;
  apiP95Ms?: number | null;
  qrTotalPunches?: number;
  qrFailureCount?: number;
  qrAvgMs?: number | null;
  dbOpsCount?: number;
  errorCount?: number;
  activityCount?: number;
  importExportCount?: number;
}

export interface MonitoringOverviewResponse {
  success: boolean;
  generatedAt: string;
  window: {
    range: MonitoringTimeRange | string;
    fromIso: string;
    toIso: string;
  };
  overview: {
    overallHealth: HealthStatus;
    backendStatus: HealthStatus;
    frontendStatus: HealthStatus;
    firebaseConnectivity: 'Connected' | 'Error';
    firebasePingMs: number | null;
    projectId: string;
    databaseId: string;
    credentialMode: string;
    apiAvgMs: number | null;
    apiP50Ms: number | null;
    apiP95Ms: number | null;
    totalApiRequests: number;
    failedApiRequests: number;
    timeoutApiRequests: number;
    applicationErrorCount: number;
    activeUserSessions: number | null;
    totalActiveUserAccounts: number | null;
    recentAuditCount: number | null;
    qrPunchAvgMs: number | null;
    qrPunchP50Ms: number | null;
    qrPunchP95Ms: number | null;
    qrPunchMaxMs: number | null;
    qrPunchTotal: number;
    qrPunchSuccessRatePct: number | null;
    qrPunchFailureRatePct: number | null;
    qrDuplicateRejections: number;
    qrTimeouts: number;
    backgroundRefreshAvgMs: number | null;
    backgroundRefreshStatus: string;
    lastSuccessfulHealthCheck: string | null;
    lastMonitoringUpdate: string | null;
    activeAlertsCount: number;
  };
  websitePerf: {
    initialLoad: LatencyStatsSummary;
    navigation: LatencyStatsSummary;
    skeletonDuration: LatencyStatsSummary;
    routePrefetch: LatencyStatsSummary;
    backgroundRefresh: LatencyStatsSummary;
    slowRender: LatencyStatsSummary;
    jsErrorsCount: number;
    promiseRejectionsCount: number;
    networkFailuresCount: number;
  };
  apiMonitoring: {
    summary: LatencyStatsSummary;
    totalRequests: number;
    failedRequests: number;
    timeoutCount: number;
    endpoints: ApiEndpointSummary[];
    recentTraces: ApiTraceItem[];
  };
  databaseMonitoring: {
    connectivity: string;
    probeLatencyMs: number | null;
    measuredTotalOps: number;
    measuredReads: number;
    measuredWrites: number;
    transactionCount: number;
    failedTransactionCount: number;
    avgOpDurationMs: number | null;
    p95OpDurationMs: number | null;
    permissionDeniedCount: number;
    networkErrorCount: number;
    slowOperations: DbOpItem[];
    bulkAndImportBatches: ImportExportBatchItem[];
    cloudBillingUsageStatus: string;
    cloudBillingRequirement: string;
  };
  qrPerformance: {
    summary: LatencyStatsSummary;
    successCount: number;
    failedCount: number;
    duplicateRejections: number;
    timeoutCount: number;
    stages: {
      qrDetect: LatencyStatsSummary;
      qrParse: LatencyStatsSummary;
      apiRequest: LatencyStatsSummary;
      authTokenVerify: LatencyStatsSummary;
      tokenValidation: LatencyStatsSummary;
      firestoreTx: LatencyStatsSummary;
      totalPunchIn: LatencyStatsSummary;
      totalPunchOut: LatencyStatsSummary;
      manualPunch: LatencyStatsSummary;
    };
    recentPunches: QrPunchTraceItem[];
  };
  userActivity: UserActivityItem[];
  moduleHealth: ModuleHealthItem[];
  errorLogs: ErrorLogItem[];
  alerts: MonitoringAlertItem[];
  thresholds: MonitoringThresholds;
  timeSeries: TimeSeriesBucket[];
  historicalRollups: HistoricalRollupItem[];
  networkMonitoring?: NetworkMonitoringSummary;
}

export interface NetworkSpeedTestItem {
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

export interface NetworkHistoryBucket {
  label: string;
  bucketStartIso: string;
  probeCount: number;
  rttAvgMs: number | null;
  jitterMs: number | null;
  packetLossPct: number | null;
  downloadMbps: number | null;
  uploadMbps: number | null;
  apiAvgMs: number | null;
  disconnections: number;
}

export interface NetworkDeviceSessionItem {
  sessionId: string;
  actorLoginId: string;
  actorRole: string;
  userAgentShort: string;
  connectionType: string;
  effectiveType: string;
  browserEstimatedDownlinkMbps: number | null;
  browserEstimatedRttMs: number | null;
  measuredRttAvgMs: number | null;
  measuredRttLastMs: number | null;
  probeCount: number;
  lastSampleAt: string;
  networkStatus: string;
}

export interface NetworkMonitoringSummary {
  online: boolean;
  connectionStatusLabel: string;
  lastSuccessfulMeasurementAt: string | null;
  lastDisconnectionAt: string | null;
  disconnectionCount: number;
  rttStats: {
    currentMs: number | null;
    avgMs: number | null;
    p50Ms: number | null;
    p95Ms: number | null;
    maxMs: number | null;
    rating: string;
    sampleCount: number;
  };
  avgServerProbeProcessMs: number | null;
  dnsMs: number | null;
  tcpConnectMs: number | null;
  tlsHandshakeMs: number | null;
  timingMeasurementNote: string;
  jitter: {
    valueMs: number | null;
    rating: string;
    sampleCount: number;
  };
  packetLoss: {
    totalProbes: number;
    failedProbes: number;
    rawFailurePct: number | null;
    reportablePacketLossPct: number | null;
    rating: string;
    note: string;
  };
  speedTest: {
    latestDownloadMbps: number | null;
    latestUploadMbps: number | null;
    downloadRating: string;
    uploadRating: string;
    lastTestedAt: string | null;
    isEstimate: boolean;
    disclosure: string;
    recentTests: NetworkSpeedTestItem[];
  };
  networkRequestFailureRatePct: number | null;
  backendApiAvgMs: number | null;
  backendApiP95Ms: number | null;
  healthScore: {
    score: number | null;
    tier: string;
    formulaSummary: string;
    factors: Array<{
      factor: string;
      measuredValue: string;
      weightPct: number;
      subScore: number | null;
      status: string;
      included: boolean;
    }>;
  };
  diagnostics: {
    primaryCause: string;
    confidence: string;
    summary: string;
    evidenceBullets: string[];
    comparison: {
      appRttAvgMs: number | null;
      backendApiP95Ms: number | null;
      firestoreP95Ms: number | null;
      frontendSlowRenderAvgMs: number | null;
    };
  };
  indicatorStatuses: {
    connectivity: string;
    latency: string;
    jitter: string;
    packetLoss: string;
    throughput: string;
    backendVsNetwork: string;
  };
  historyBuckets: NetworkHistoryBucket[];
  activeDeviceSessions: NetworkDeviceSessionItem[];
  totalProbeSamplesInWindow: number;
}

export async function fetchMonitoringOverview(params: {
  range: MonitoringTimeRange;
  from?: string;
  to?: string;
}): Promise<MonitoringOverviewResponse> {
  const qs = new URLSearchParams({ range: params.range });
  if (params.range === 'custom' && params.from) {
    qs.set('from', params.from);
    if (params.to) qs.set('to', params.to);
  }
  const headers = await getAuthHeaders();
  return apiFetchJson<MonitoringOverviewResponse>(
    `/api/monitoring/overview?${qs.toString()}`,
    { method: 'GET', headers },
    'Failed to load system monitoring telemetry.'
  );
}

export async function runMonitoringHealthProbe(): Promise<{
  success: boolean;
  status: string;
  firestoreProbeMs: number;
  checkedAt: string;
}> {
  const headers = await getAuthHeaders();
  return apiFetchJson(
    '/api/monitoring/health-probe',
    { method: 'POST', headers },
    'Failed to run live health probe.'
  );
}

export async function performMonitoringAlertAction(
  groupKey: string,
  action: 'ACKNOWLEDGE' | 'RESOLVE' | 'REOPEN'
): Promise<{ success: boolean; alert: MonitoringAlertItem }> {
  const headers = await getAuthHeaders();
  return apiFetchJson(
    '/api/monitoring/alerts/action',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ groupKey, action }),
    },
    `Failed to ${action.toLowerCase()} alert.`
  );
}

export async function updateMonitoringThresholds(
  partial: Partial<MonitoringThresholds>
): Promise<{ success: boolean; thresholds: MonitoringThresholds }> {
  const headers = await getAuthHeaders();
  return apiFetchJson(
    '/api/monitoring/thresholds',
    {
      method: 'POST',
      headers,
      body: JSON.stringify(partial),
    },
    'Failed to update monitoring thresholds.'
  );
}

let isFlushingTelemetry = false;

export async function flushQueuedClientTelemetry(): Promise<number> {
  if (isFlushingTelemetry || getPendingTelemetryCount() === 0) {
    return 0;
  }
  if (!auth.currentUser || !isApiBaseUsableForCurrentOrigin()) {
    return 0;
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 0;
  }

  const batch = drainClientTelemetryQueue(40);
  if (batch.length === 0) return 0;

  isFlushingTelemetry = true;
  try {
    const headers = await getAuthHeaders();
    await apiFetchJson(
      '/api/monitoring/ingest',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ events: batch }),
      },
      'Failed to ingest client telemetry.'
    );
    return batch.length;
  } catch {
    // Non-blocking: re-queue up to bounded capacity on transient failure, never throwing
    for (let i = 0; i < Math.min(20, batch.length); i++) {
      queueClientTelemetry(batch[i]);
    }
    return 0;
  } finally {
    isFlushingTelemetry = false;
  }
}

export function startClientTelemetryFlushLoop(intervalMs = 15_000): () => void {
  if (typeof window === 'undefined') return () => {};

  const timer = window.setInterval(() => {
    void flushQueuedClientTelemetry();
  }, intervalMs);

  const onVisibilityChange = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      void flushQueuedClientTelemetry();
    }
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  return () => {
    window.clearInterval(timer);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
  };
}
