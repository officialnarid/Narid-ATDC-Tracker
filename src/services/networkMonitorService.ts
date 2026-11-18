import { auth } from '../firebase';
import { apiUrl, isApiBaseUsableForCurrentOrigin } from '../config/api';
import { getAuthHeaders } from './auditService';
import { queueClientTelemetry } from '../utils/perfMonitor';
import { flushQueuedClientTelemetry } from './monitoringService';
import { round2 } from '../utils/networkDiagnostics';

// ============================================================================
// Client Internet & Network Probe Service
// ============================================================================
// Cost & Safety Invariants:
// - Probes hit `/api/network/ping` (zero Firestore access).
// - Auto-pauses when browser tab is hidden or offline.
// - Never throws unhandled rejections into UI/attendance workflows.
// - Speed test is strictly manual and bounded to <= 512 KB (default 256 KB).
// ============================================================================

export interface BrowserNetworkEstimate {
  supported: boolean;
  connectionType: string;
  effectiveType: string;
  downlinkEstimateMbps: number | null;
  browserRttEstimateMs: number | null;
}

export interface ClientProbeMeasurement {
  sessionId: string;
  online: boolean;
  probeSucceeded: boolean;
  rttMs: number | null;
  serverProcessMs: number | null;
  dnsMs: number | null;
  tcpConnectMs: number | null;
  tlsHandshakeMs: number | null;
  estimate: BrowserNetworkEstimate;
  timestamp: string;
}

export interface ManualSpeedTestResult {
  downloadMbps: number | null;
  uploadMbps: number | null;
  downloadBytes: number;
  uploadBytes: number;
  downloadDurationMs: number;
  uploadDurationMs: number;
  testedAt: string;
}

const SESSION_STORAGE_KEY = 'narid_net_session_id';

export function getOrCreateNetworkSessionId(): string {
  if (typeof window === 'undefined') return 'sess_ssr';
  try {
    const existing = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (existing && /^sess_[A-Za-z0-9_-]{6,32}$/.test(existing)) {
      return existing;
    }
    const created = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, created);
    return created;
  } catch {
    return `sess_${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function getShortBrowserLabel(): string {
  if (typeof navigator === 'undefined') return 'Unknown Runtime';
  const ua = navigator.userAgent || '';
  let browser = 'Browser';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) browser = 'Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) browser = 'Safari';

  let os = 'Desktop';
  if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iOS/i.test(ua)) os = 'iOS';
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
  else if (/Linux/i.test(ua)) os = 'Linux';

  return `${browser} / ${os}`;
}

export function readBrowserNetworkEstimate(): BrowserNetworkEstimate {
  if (typeof navigator === 'undefined') {
    return {
      supported: false,
      connectionType: 'Unavailable',
      effectiveType: 'Unavailable',
      downlinkEstimateMbps: null,
      browserRttEstimateMs: null,
    };
  }
  const conn =
    (navigator as any).connection ||
    (navigator as any).mozConnection ||
    (navigator as any).webkitConnection;
  if (!conn) {
    return {
      supported: false,
      connectionType: 'Unavailable',
      effectiveType: 'Unavailable',
      downlinkEstimateMbps: null,
      browserRttEstimateMs: null,
    };
  }
  return {
    supported: true,
    connectionType: String(conn.type || conn.effectiveType || 'Unavailable'),
    effectiveType: String(conn.effectiveType || 'Unavailable'),
    downlinkEstimateMbps:
      typeof conn.downlink === 'number' && Number.isFinite(conn.downlink)
        ? round2(conn.downlink)
        : null,
    browserRttEstimateMs:
      typeof conn.rtt === 'number' && Number.isFinite(conn.rtt) ? Math.round(conn.rtt) : null,
  };
}

function extractResourceTimingsForUrl(targetUrl: string): {
  dnsMs: number | null;
  tcpConnectMs: number | null;
  tlsHandshakeMs: number | null;
} {
  if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') {
    return { dnsMs: null, tcpConnectMs: null, tlsHandshakeMs: null };
  }
  try {
    const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const match = [...entries].reverse().find((e) => e.name.includes('/api/network/ping') || e.name === targetUrl);
    if (!match) return { dnsMs: null, tcpConnectMs: null, tlsHandshakeMs: null };

    const rawDns = match.domainLookupEnd - match.domainLookupStart;
    const rawTcp = match.connectEnd - match.connectStart;
    const rawTls =
      match.secureConnectionStart > 0 ? match.connectEnd - match.secureConnectionStart : 0;

    return {
      dnsMs: rawDns > 0.05 ? round2(rawDns) : null,
      tcpConnectMs: rawTcp > 0.05 ? round2(rawTcp) : null,
      tlsHandshakeMs: rawTls > 0.05 ? round2(rawTls) : null,
    };
  } catch {
    return { dnsMs: null, tcpConnectMs: null, tlsHandshakeMs: null };
  }
}

let probeInFlight = false;

export async function runSingleNetworkProbe(options?: {
  disconnectionEvent?: boolean;
}): Promise<ClientProbeMeasurement | null> {
  if (typeof window === 'undefined' || !auth.currentUser || !isApiBaseUsableForCurrentOrigin()) {
    return null;
  }

  const sessionId = getOrCreateNetworkSessionId();
  const estimate = readBrowserNetworkEstimate();
  const uaShort = getShortBrowserLabel();
  const nowIso = new Date().toISOString();

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    queueClientTelemetry({
      kind: 'NETWORK_PROBE',
      module: 'Internet & Network',
      sessionId,
      online: false,
      probeSucceeded: false,
      rttMs: null,
      serverProcessMs: null,
      dnsMs: null,
      tcpConnectMs: null,
      tlsHandshakeMs: null,
      connectionType: estimate.connectionType,
      effectiveType: estimate.effectiveType,
      downlinkEstimateMbps: estimate.downlinkEstimateMbps,
      browserRttEstimateMs: estimate.browserRttEstimateMs,
      disconnectionEvent: options?.disconnectionEvent ?? true,
      userAgentShort: uaShort,
      timestampMs: Date.now(),
    });
    return {
      sessionId,
      online: false,
      probeSucceeded: false,
      rttMs: null,
      serverProcessMs: null,
      dnsMs: null,
      tcpConnectMs: null,
      tlsHandshakeMs: null,
      estimate,
      timestamp: nowIso,
    };
  }

  if (probeInFlight) return null;
  probeInFlight = true;

  try {
    const headers = await getAuthHeaders();
    const targetUrl = apiUrl(`/api/network/ping?_t=${Date.now()}`);
    const t0 = performance.now();
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8000);

    try {
      const res = await fetch(targetUrl, {
        method: 'GET',
        headers,
        cache: 'no-store',
        signal: controller.signal,
      });
      const rttMs = round2(Math.max(0.1, performance.now() - t0));
      const procHdr = res.headers.get('X-Server-Process-Ms');
      const serverProcessMs = procHdr !== null && Number.isFinite(Number(procHdr)) ? round2(Number(procHdr)) : null;
      const resTimings = extractResourceTimingsForUrl(targetUrl);

      const ok = res.ok;
      queueClientTelemetry({
        kind: 'NETWORK_PROBE',
        module: 'Internet & Network',
        sessionId,
        online: true,
        probeSucceeded: ok,
        rttMs: ok ? rttMs : null,
        serverProcessMs,
        dnsMs: resTimings.dnsMs,
        tcpConnectMs: resTimings.tcpConnectMs,
        tlsHandshakeMs: resTimings.tlsHandshakeMs,
        connectionType: estimate.connectionType,
        effectiveType: estimate.effectiveType,
        downlinkEstimateMbps: estimate.downlinkEstimateMbps,
        browserRttEstimateMs: estimate.browserRttEstimateMs,
        disconnectionEvent: false,
        userAgentShort: uaShort,
        timestampMs: Date.now(),
      });

      return {
        sessionId,
        online: true,
        probeSucceeded: ok,
        rttMs: ok ? rttMs : null,
        serverProcessMs,
        dnsMs: resTimings.dnsMs,
        tcpConnectMs: resTimings.tcpConnectMs,
        tlsHandshakeMs: resTimings.tlsHandshakeMs,
        estimate,
        timestamp: nowIso,
      };
    } catch {
      queueClientTelemetry({
        kind: 'NETWORK_PROBE',
        module: 'Internet & Network',
        sessionId,
        online: typeof navigator !== 'undefined' ? navigator.onLine !== false : true,
        probeSucceeded: false,
        rttMs: null,
        serverProcessMs: null,
        dnsMs: null,
        tcpConnectMs: null,
        tlsHandshakeMs: null,
        connectionType: estimate.connectionType,
        effectiveType: estimate.effectiveType,
        downlinkEstimateMbps: estimate.downlinkEstimateMbps,
        browserRttEstimateMs: estimate.browserRttEstimateMs,
        disconnectionEvent: false,
        userAgentShort: uaShort,
        timestampMs: Date.now(),
      });
      return {
        sessionId,
        online: typeof navigator !== 'undefined' ? navigator.onLine !== false : true,
        probeSucceeded: false,
        rttMs: null,
        serverProcessMs: null,
        dnsMs: null,
        tcpConnectMs: null,
        tlsHandshakeMs: null,
        estimate,
        timestamp: nowIso,
      };
    } finally {
      window.clearTimeout(timer);
    }
  } finally {
    probeInFlight = false;
  }
}

/**
 * Controlled Manual Speed Test (bounded 256 KB download + 256 KB upload).
 * Never runs automatically in background.
 */
export async function runControlledSpeedTest(payloadBytes = 262_144): Promise<ManualSpeedTestResult> {
  const safeBytes = Math.max(32_768, Math.min(524_288, Math.floor(payloadBytes)));
  const sessionId = getOrCreateNetworkSessionId();
  const headers = await getAuthHeaders();

  // 1. Download test
  const dlUrl = apiUrl(`/api/network/speedtest/download?bytes=${safeBytes}&_t=${Date.now()}`);
  const dlStart = performance.now();
  const dlRes = await fetch(dlUrl, {
    method: 'GET',
    headers,
    cache: 'no-store',
  });
  if (!dlRes.ok) {
    throw new Error(`Download speed test failed with HTTP ${dlRes.status}.`);
  }
  const dlBuf = await dlRes.arrayBuffer();
  const dlDurationMs = Math.max(1, round2(performance.now() - dlStart));
  const dlActualBytes = dlBuf.byteLength || safeBytes;
  const downloadMbps = round2((dlActualBytes * 8) / (dlDurationMs / 1000) / 1_000_000);

  // 2. Upload test
  const ulPayload = new Uint8Array(safeBytes);
  const ulUrl = apiUrl(`/api/network/speedtest/upload?_t=${Date.now()}`);
  const tokenHeader =
    headers && typeof headers === 'object' ? (headers as Record<string, string>) : {};
  const ulHeaders: Record<string, string> = {
    ...(tokenHeader.Authorization ? { Authorization: tokenHeader.Authorization } : {}),
    'Content-Type': 'application/octet-stream',
  };
  const ulStart = performance.now();
  const ulRes = await fetch(ulUrl, {
    method: 'POST',
    headers: ulHeaders,
    body: ulPayload,
    cache: 'no-store',
  });
  if (!ulRes.ok) {
    throw new Error(`Upload speed test failed with HTTP ${ulRes.status}.`);
  }
  await ulRes.json().catch(() => ({}));
  const ulDurationMs = Math.max(1, round2(performance.now() - ulStart));
  const uploadMbps = round2((safeBytes * 8) / (ulDurationMs / 1000) / 1_000_000);

  const testedAt = new Date().toISOString();
  queueClientTelemetry({
    kind: 'SPEED_TEST',
    module: 'Internet & Network',
    sessionId,
    downloadMbps,
    uploadMbps,
    downloadBytes: dlActualBytes,
    uploadBytes: safeBytes,
    downloadDurationMs: dlDurationMs,
    uploadDurationMs: ulDurationMs,
    timestampMs: Date.now(),
  });
  await flushQueuedClientTelemetry();

  return {
    downloadMbps,
    uploadMbps,
    downloadBytes: dlActualBytes,
    uploadBytes: safeBytes,
    downloadDurationMs: dlDurationMs,
    uploadDurationMs: ulDurationMs,
    testedAt,
  };
}

export function startBackgroundNetworkMonitoring(intervalMs = 30_000): () => void {
  if (typeof window === 'undefined') return () => {};

  let cancelled = false;
  const safeInterval = Math.max(10_000, Math.min(300_000, intervalMs));

  // Initial lightweight 3-probe calibration burst (only when tab visible & online)
  const bootstrapTimeout = window.setTimeout(async () => {
    for (let i = 0; i < 3; i++) {
      if (cancelled) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      await runSingleNetworkProbe();
      if (i < 2) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (!cancelled) {
      void flushQueuedClientTelemetry();
    }
  }, 1500);

  const intervalId = window.setInterval(() => {
    if (cancelled) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    void runSingleNetworkProbe();
  }, safeInterval);

  const onOffline = () => {
    if (cancelled) return;
    void runSingleNetworkProbe({ disconnectionEvent: true });
  };

  const onOnline = () => {
    if (cancelled) return;
    void runSingleNetworkProbe().then(() => flushQueuedClientTelemetry());
  };

  window.addEventListener('offline', onOffline);
  window.addEventListener('online', onOnline);

  return () => {
    cancelled = true;
    window.clearTimeout(bootstrapTimeout);
    window.clearInterval(intervalId);
    window.removeEventListener('offline', onOffline);
    window.removeEventListener('online', onOnline);
  };
}
