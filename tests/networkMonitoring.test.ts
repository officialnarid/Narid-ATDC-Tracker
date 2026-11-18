import http from 'http';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createApp } from '../server.ts';
import {
  evaluateAlertThresholds,
  recordApiMetric,
  recordDbOpMetric,
} from '../serverMonitoring.ts';
import {
  classifyLatencyRating,
  computeInternetHealthScore,
  computeJitterFromRttSeries,
  evaluatePacketLoss,
} from '../src/utils/networkDiagnostics.ts';
import {
  InMemoryAdminAuth,
  InMemoryFirestore,
  TEST_CANONICAL_ACCOUNTS,
  seedIsolatedTestEnvironment,
} from './helpers/inMemoryAdmin.ts';
import { SystemPerformance } from '../src/components/SystemPerformance';
import { MonitoringOverviewResponse } from '../src/services/monitoringService';

describe('Internet & Network Performance Monitoring — Diagnostics, Endpoints & Alerts', () => {
  let db: InMemoryFirestore;
  let auth: InMemoryAdminAuth;
  let server: http.Server;
  let baseUrl: string;

  let superAdminToken = '';
  let adminToken = '';
  let userToken = '';

  beforeEach(async () => {
    db = new InMemoryFirestore();
    auth = new InMemoryAdminAuth();
    await seedIsolatedTestEnvironment(db, auth);

    const { app } = createApp({
      db,
      auth,
      projectId: 'narid-atdc-tracker',
      databaseId: 'ai-studio-manpowertracker-9b87a863-5c0d-4126-accb-7a3be802b10b',
      credentialMode: 'ADC',
      disableBackgroundBoot: true,
    });

    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;

    superAdminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.superadmin.uid);
    adminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid);
    userToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.user.uid);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function reqJson(
    method: 'GET' | 'POST',
    path: string,
    token: string,
    body?: any
  ) {
    const resp = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = await resp.json();
    return { status: resp.status, headers: resp.headers, data };
  }

  function makeProbe(overrides: Partial<Record<string, any>> = {}) {
    return {
      kind: 'NETWORK_PROBE',
      module: 'Internet & Network',
      sessionId: 'sess_unit_01',
      online: true,
      probeSucceeded: true,
      rttMs: 32,
      serverProcessMs: 1.5,
      dnsMs: null,
      tcpConnectMs: null,
      tlsHandshakeMs: null,
      connectionType: 'wifi',
      effectiveType: '4g',
      downlinkEstimateMbps: 25,
      browserRttEstimateMs: 50,
      disconnectionEvent: false,
      userAgentShort: 'Chrome / Linux',
      timestampMs: Date.now(),
      ...overrides,
    };
  }

  it('Scenario 1: Classifies stable high-speed network as EXCELLENT/GOOD with All Systems Nominal', async () => {
    const probes = [26, 30, 29, 34, 28, 31].map((rttMs) => makeProbe({ rttMs }));
    const ingest = await reqJson('POST', '/api/monitoring/ingest', userToken, {
      events: [
        ...probes,
        {
          kind: 'SPEED_TEST',
          module: 'Internet & Network',
          sessionId: 'sess_unit_01',
          downloadMbps: 44.5,
          uploadMbps: 14.2,
          downloadBytes: 262144,
          uploadBytes: 262144,
          downloadDurationMs: 47,
          uploadDurationMs: 148,
        },
      ],
    });
    expect(ingest.status).toBe(200);

    for (let i = 0; i < 4; i++) {
      recordApiMetric(db, {
        endpoint: '/api/employees',
        method: 'GET',
        status: 200,
        durationMs: 95 + i * 10,
        success: true,
        timedOut: false,
        errorCategory: 'NONE',
        correlationId: `cid_nom_${i}`,
      });
    }

    const overview = await reqJson('GET', '/api/monitoring/overview?range=15m', superAdminToken);
    expect(overview.status).toBe(200);
    const net = overview.data.networkMonitoring;
    expect(net.online).toBe(true);
    expect(net.rttStats.rating).toBe('EXCELLENT');
    expect(net.jitter.rating).toBe('GOOD');
    expect(net.packetLoss.rating).toBe('GOOD');
    expect(net.speedTest.downloadRating).toBe('GOOD');
    expect(net.speedTest.uploadRating).toBe('GOOD');
    expect(net.healthScore.score).toBeGreaterThanOrEqual(90);
    expect(net.healthScore.tier).toBe('EXCELLENT');
    expect(net.diagnostics.primaryCause).toBe('All Systems Nominal');
  });

  it('Scenario 2: Detects high latency HTTP RTT (>400ms CRITICAL), fires NET_ALERT_HIGH_LATENCY, and attributes User Internet Problem', async () => {
    expect(classifyLatencyRating(25)).toBe('EXCELLENT');
    expect(classifyLatencyRating(80)).toBe('GOOD');
    expect(classifyLatencyRating(150)).toBe('WARNING');
    expect(classifyLatencyRating(320)).toBe('POOR');
    expect(classifyLatencyRating(480)).toBe('CRITICAL');

    const probes = [460, 490, 510, 475, 530].map((rttMs) =>
      makeProbe({ rttMs, serverProcessMs: 1.8 })
    );
    await reqJson('POST', '/api/monitoring/ingest', userToken, { events: probes });

    const overview = await reqJson('GET', '/api/monitoring/overview?range=15m', superAdminToken);
    const net = overview.data.networkMonitoring;
    expect(net.rttStats.rating).toBe('CRITICAL');
    expect(net.diagnostics.primaryCause).toBe('User Internet Problem');

    const highLatAlert = overview.data.alerts.find(
      (a: any) => a.groupKey === 'NET_ALERT_HIGH_LATENCY'
    );
    expect(highLatAlert).toBeDefined();
    expect(highLatAlert.severity).toBe('CRITICAL');
  });

  it('Scenario 3: Detects low manual bandwidth (DL <5 / UL <2 CRITICAL), triggers NET_ALERT_LOW_THROUGHPUT, and avoids auto heavy tests', async () => {
    const probes = [38, 42, 36, 40, 39].map((rttMs) => makeProbe({ rttMs }));
    await reqJson('POST', '/api/monitoring/ingest', userToken, {
      events: [
        ...probes,
        {
          kind: 'SPEED_TEST',
          module: 'Internet & Network',
          sessionId: 'sess_unit_01',
          downloadMbps: 2.1,
          uploadMbps: 0.9,
          downloadBytes: 262144,
          uploadBytes: 262144,
          downloadDurationMs: 998,
          uploadDurationMs: 2330,
        },
      ],
    });

    const overview = await reqJson('GET', '/api/monitoring/overview?range=15m', superAdminToken);
    const net = overview.data.networkMonitoring;
    expect(net.speedTest.downloadRating).toBe('CRITICAL');
    expect(net.speedTest.uploadRating).toBe('CRITICAL');
    expect(net.diagnostics.primaryCause).toBe('User Internet Problem');

    const bwAlert = overview.data.alerts.find(
      (a: any) => a.groupKey === 'NET_ALERT_LOW_THROUGHPUT'
    );
    expect(bwAlert).toBeDefined();
    expect(bwAlert.severity).toBe('CRITICAL');
  });

  it('Scenario 4: Enforces Packet Loss single-probe failure safeguard AND detects unstable high jitter + sustained packet loss', async () => {
    // Safeguard unit check: 1 isolated failed HTTPS probe out of 10 MUST NOT be labeled packet loss
    const singleFailEval = evaluatePacketLoss([
      ...Array.from({ length: 9 }, () => ({ success: true })),
      { success: false },
    ]);
    expect(singleFailEval.failedProbes).toBe(1);
    expect(singleFailEval.reportablePacketLossPct).toBe(0);
    expect(singleFailEval.rating).toBe('GOOD');
    expect(singleFailEval.note).toContain('not classified as sustained packet loss');

    // Also insufficient probes (<5) stays UNKNOWN
    const tooFewEval = evaluatePacketLoss([{ success: true }, { success: false }]);
    expect(tooFewEval.rating).toBe('UNKNOWN');
    expect(tooFewEval.reportablePacketLossPct).toBeNull();

    // Unstable network: wild jitter [25, 170, 28, 195, 22, 188, 30] + 3 failed probes out of 10 (30% loss)
    const wildEvents = [
      ...[25, 170, 28, 195, 22, 188, 30].map((rttMs) => makeProbe({ rttMs })),
      makeProbe({ probeSucceeded: false, rttMs: null }),
      makeProbe({ probeSucceeded: false, rttMs: null }),
      makeProbe({ probeSucceeded: false, rttMs: null }),
    ];
    await reqJson('POST', '/api/monitoring/ingest', userToken, { events: wildEvents });

    const overview = await reqJson('GET', '/api/monitoring/overview?range=15m', superAdminToken);
    const net = overview.data.networkMonitoring;
    expect(net.jitter.valueMs).toBeGreaterThan(50);
    expect(net.jitter.rating).toBe('CRITICAL');
    expect(net.packetLoss.reportablePacketLossPct).toBe(30);
    expect(net.packetLoss.rating).toBe('CRITICAL');
    expect(net.diagnostics.primaryCause).toBe('User Internet Problem');
    expect(overview.data.alerts.some((a: any) => a.groupKey === 'NET_ALERT_HIGH_JITTER')).toBe(true);
    expect(overview.data.alerts.some((a: any) => a.groupKey === 'NET_ALERT_PACKET_LOSS')).toBe(true);
  });

  it('Scenario 5: Records offline disconnection event & NET_ALERT_DISCONNECTED, then captures recovery', async () => {
    await reqJson('POST', '/api/monitoring/ingest', userToken, {
      events: [
        makeProbe({
          online: false,
          probeSucceeded: false,
          rttMs: null,
          disconnectionEvent: true,
        }),
      ],
    });

    const downOverview = await reqJson('GET', '/api/monitoring/overview?range=15m', superAdminToken);
    expect(downOverview.data.networkMonitoring.online).toBe(false);
    expect(downOverview.data.networkMonitoring.disconnectionCount).toBe(1);
    expect(downOverview.data.networkMonitoring.lastDisconnectionAt).toBeTruthy();
    expect(downOverview.data.networkMonitoring.healthScore.score).toBe(0);
    expect(downOverview.data.networkMonitoring.healthScore.tier).toBe('CRITICAL');
    expect(
      downOverview.data.alerts.some(
        (a: any) => a.groupKey === 'NET_ALERT_DISCONNECTED' && a.severity === 'CRITICAL'
      )
    ).toBe(true);

    // Recovery probes come online
    await reqJson('POST', '/api/monitoring/ingest', userToken, {
      events: [28, 32, 30, 31].map((rttMs) => makeProbe({ rttMs, online: true })),
    });
    const upOverview = await reqJson('GET', '/api/monitoring/overview?range=15m', superAdminToken);
    expect(upOverview.data.networkMonitoring.online).toBe(true);
    expect(upOverview.data.networkMonitoring.lastSuccessfulMeasurementAt).toBeTruthy();
    expect(upOverview.data.networkMonitoring.disconnectionCount).toBe(1);
  });

  it('Scenario 6: Isolates Backend Server Problem when client RTT & Firestore are fast but Backend API is slow', async () => {
    await reqJson('POST', '/api/monitoring/ingest', userToken, {
      events: [22, 25, 24, 26, 23].map((rttMs) => makeProbe({ rttMs })),
    });

    for (let i = 0; i < 6; i++) {
      recordDbOpMetric(db, {
        operation: 'READ',
        collection: 'employees',
        durationMs: 32,
        success: true,
      });
      recordApiMetric(db, {
        endpoint: '/api/attendance/report',
        method: 'GET',
        status: i === 5 ? 500 : 200,
        durationMs: 1650,
        success: i !== 5,
        timedOut: false,
        errorCategory: i === 5 ? 'SERVER_ERROR' : 'NONE',
        correlationId: `cid_be_${i}`,
      });
    }
    evaluateAlertThresholds(db);

    const overview = await reqJson('GET', '/api/monitoring/overview?range=15m', superAdminToken);
    const net = overview.data.networkMonitoring;
    expect(net.diagnostics.primaryCause).toBe('Backend Server Problem');
    expect(
      overview.data.alerts.some((a: any) => a.groupKey === 'NET_ALERT_SLOW_BACKEND_HEALTHY_NET')
    ).toBe(true);
  });

  it('Scenario 7: Isolates Firebase / Database Problem when client RTT & backend ingress are healthy but Firestore ops fail/lag', async () => {
    await reqJson('POST', '/api/monitoring/ingest', userToken, {
      events: [24, 28, 27, 29, 25].map((rttMs) => makeProbe({ rttMs })),
    });

    for (let i = 0; i < 6; i++) {
      recordDbOpMetric(db, {
        operation: 'TRANSACTION',
        collection: 'attendance_logs',
        durationMs: 1120,
        success: i < 4,
        errorCode: i >= 4 ? 'deadline-exceeded' : undefined,
      });
      recordApiMetric(db, {
        endpoint: '/api/attendance/scan',
        method: 'POST',
        status: 200,
        durationMs: 1180,
        success: true,
        timedOut: false,
        errorCategory: 'NONE',
        correlationId: `cid_db_${i}`,
      });
    }

    const overview = await reqJson('GET', '/api/monitoring/overview?range=15m', superAdminToken);
    expect(overview.data.networkMonitoring.diagnostics.primaryCause).toBe(
      'Firebase / Database Problem'
    );
  });

  it('Scenario 8: Verifies controlled network probe & bounded speed test endpoints, UNKNOWN guard, privacy scrubbing, thresholds & SSR UI', async () => {
    // 1. Auth guard (401 when unauthenticated)
    const unauthPing = await reqJson('GET', '/api/network/ping', '');
    expect(unauthPing.status).toBe(401);
    const unauthDl = await fetch(`${baseUrl}/api/network/speedtest/download`);
    expect(unauthDl.status).toBe(401);

    // 2. Ping returns no-store, Timing-Allow-Origin, X-Server-Process-Ms and performs 0 Firestore ops
    const pingRes = await reqJson('GET', '/api/network/ping', userToken);
    expect(pingRes.status).toBe(200);
    expect(pingRes.data.ok).toBe(true);
    expect(pingRes.headers.get('timing-allow-origin')).toBe('*');
    expect(pingRes.headers.get('cache-control')).toContain('no-store');
    expect(Number(pingRes.headers.get('x-server-process-ms'))).toBeGreaterThanOrEqual(0);

    // 3. Download speed test strictly caps arbitrary huge request bytes down to 512 KB (524,288 bytes)
    const dlRes = await fetch(`${baseUrl}/api/network/speedtest/download?bytes=99999999`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(dlRes.status).toBe(200);
    const dlBuf = await dlRes.arrayBuffer();
    expect(dlBuf.byteLength).toBe(524_288);
    expect(dlRes.headers.get('x-payload-bytes')).toBe('524288');

    // 4. Upload speed test handles raw octet-stream payload cleanly
    const ulRes = await fetch(`${baseUrl}/api/network/speedtest/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${userToken}`,
        'Content-Type': 'application/octet-stream',
      },
      body: new Uint8Array(131_072),
    });
    expect(ulRes.status).toBe(200);
    const ulJson = await ulRes.json();
    expect(ulJson.success).toBe(true);
    expect(ulJson.receivedBytes).toBe(131_072);

    // 5. Insufficient samples (<3) returns UNKNOWN health score (no fabricated numbers)
    await reqJson('POST', '/api/monitoring/ingest', userToken, {
      events: [
        makeProbe({
          sessionId: 'sess_min_01',
          connectionType: 'Unavailable',
          effectiveType: 'Unavailable',
          downlinkEstimateMbps: null,
          browserRttEstimateMs: null,
        }),
      ],
    });
    const minOverview = await reqJson('GET', '/api/monitoring/overview?range=15m', superAdminToken);
    expect(minOverview.data.networkMonitoring.healthScore.tier).toBe('UNKNOWN');
    expect(minOverview.data.networkMonitoring.healthScore.score).toBeNull();
    // Privacy & unavailable browser API disclosure check
    const sess = minOverview.data.networkMonitoring.activeDeviceSessions[0];
    expect(sess.connectionType).toBe('Unavailable');
    expect(sess.browserEstimatedDownlinkMbps).toBeNull();
    expect(JSON.stringify(sess)).not.toMatch(/ipAddress|latitude|longitude|password|token/i);

    // 6. Custom threshold update works for Super Admin and blocks regular Admin
    const denyAdminTh = await reqJson('POST', '/api/monitoring/thresholds', adminToken, {
      netProbeIntervalSec: 45,
    });
    expect(denyAdminTh.status).toBe(403);

    const saveTh = await reqJson('POST', '/api/monitoring/thresholds', superAdminToken, {
      netProbeIntervalSec: 45,
      netLatencyGoodMaxMs: 60,
    });
    expect(saveTh.status).toBe(200);
    expect(saveTh.data.thresholds.netProbeIntervalSec).toBe(45);
    expect(saveTh.data.thresholds.netLatencyGoodMaxMs).toBe(60);

    // 7. React SSR renders Overview with Internet Health card without errors
    const ssrHtml = renderToStaticMarkup(
      React.createElement(SystemPerformance, {
        initialData: minOverview.data as MonitoringOverviewResponse,
      })
    );
    expect(ssrHtml).toContain('Internet &amp; Network');
    expect(ssrHtml).toContain('Internet Health &amp; Network Diagnostics');
    expect(computeJitterFromRttSeries([20, 30])).toBeNull();
    expect(computeInternetHealthScore({
      online: true,
      probeCount: 2,
      successfulProbeCount: 2,
      avgRttMs: 30,
      jitterMs: null,
      packetLossPct: null,
      downloadMbps: null,
      uploadMbps: null,
    }).tier).toBe('UNKNOWN');
  });
});
