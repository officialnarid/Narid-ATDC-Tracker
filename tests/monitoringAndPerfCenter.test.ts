import http from 'http';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createApp } from '../server.ts';
import {
  DEFAULT_MONITORING_THRESHOLDS,
  evaluateAlertThresholds,
  flushMonitoringToFirestore,
  recordApiMetric,
  recordDbOpMetric,
  recordErrorTelemetry,
  recordQrPunchTelemetry,
  sanitizeTelemetryMessage,
  sanitizeTelemetryMetadata,
} from '../serverMonitoring.ts';
import {
  InMemoryAdminAuth,
  InMemoryFirestore,
  TEST_CANONICAL_ACCOUNTS,
  seedIsolatedTestEnvironment,
} from './helpers/inMemoryAdmin.ts';
import { SystemPerformance } from '../src/components/SystemPerformance';
import { Sidebar } from '../src/components/Sidebar';
import { MonitoringOverviewResponse } from '../src/services/monitoringService';

describe('System Performance & Live Monitoring Center — End-to-End & Security Verification', () => {
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

    // Ensure at least one shift & test employee exist for scan failure-resilience tests
    await db.collection('shifts').doc('shift_general').set({
      id: 'shift_general',
      name: 'General Shift',
      code: 'GS',
      startTime: '09:00',
      endTime: '18:00',
      punchInWindowStart: '00:00',
      punchInWindowEnd: '23:59',
      isOvernight: false,
      graceMinutes: 15,
      halfDayHours: 4,
      fullDayHours: 8,
      overtimeAfterHours: 8,
      autoCloseAfterHours: 14,
      isDefault: true,
      status: 'Active',
    });

    await db.collection('employees').doc('TST_MON_01').set({
      id: 'TST_MON_01',
      employeeId: 'TST_MON_01',
      employeeName: 'MONITORING TEST WORKER',
      employeeType: 'Permanent',
      section: 'MI',
      department: 'Production',
      floor: 'MI-01',
      designation: 'Operator',
      employeeStatus: 'Active',
      qrCodeToken: 'QR_TST_MON_01_SECRET99',
      createdAt: '2025-01-01T00:00:00.000Z',
    });

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
    body?: any,
    extraHeaders?: Record<string, string>
  ) {
    const resp = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(extraHeaders || {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = await resp.json();
    return { status: resp.status, headers: resp.headers, data };
  }

  it('1. Enforces strict Super Admin-only RBAC on monitoring endpoints and logs unauthorized attempts', async () => {
    // Unauthenticated -> 401
    const unauthOverview = await reqJson('GET', '/api/monitoring/overview?range=15m', '');
    expect(unauthOverview.status).toBe(401);

    // Operator (user) -> 403
    const userOverview = await reqJson('GET', '/api/monitoring/overview?range=15m', userToken);
    expect(userOverview.status).toBe(403);

    // Admin (non-super_admin) -> 403 across overview, health-probe, thresholds, alerts
    const adminOverview = await reqJson('GET', '/api/monitoring/overview?range=15m', adminToken);
    expect(adminOverview.status).toBe(403);

    const adminProbe = await reqJson('POST', '/api/monitoring/health-probe', adminToken);
    expect(adminProbe.status).toBe(403);

    const adminThreshold = await reqJson('POST', '/api/monitoring/thresholds', adminToken, {
      apiP95WarningMs: 900,
    });
    expect(adminThreshold.status).toBe(403);

    const adminAlertAct = await reqJson('POST', '/api/monitoring/alerts/action', adminToken, {
      groupKey: 'ALERT_HIGH_API_LATENCY',
      action: 'RESOLVE',
    });
    expect(adminAlertAct.status).toBe(403);

    // Super Admin -> 200
    const superOverview = await reqJson('GET', '/api/monitoring/overview?range=15m', superAdminToken);
    expect(superOverview.status).toBe(200);
    expect(superOverview.data.success).toBe(true);
    expect(superOverview.data.databaseMonitoring.cloudBillingUsageStatus).toBe('Not Available');
    expect(superOverview.data.databaseMonitoring.cloudBillingRequirement).toContain('roles/monitoring.viewer');

    // Audit log recorded for unauthorized access attempts
    const audits = Object.values(db.getRawCollection('audit_logs'));
    expect(audits.some((a) => String(a.action).toLowerCase().includes('unauthorized') || a.success === false)).toBe(true);
  });

  it('2. Propagates and generates X-Correlation-ID headers and measures API trace timing', async () => {
    const customCid = 'cli_corr_trace_987';
    const healthRes = await reqJson('GET', '/api/health', '', undefined, {
      'X-Correlation-ID': customCid,
    });
    expect(healthRes.status).toBe(200);
    expect(healthRes.headers.get('x-correlation-id')).toBe(customCid);

    const overviewRes = await reqJson('GET', '/api/monitoring/overview?range=15m', superAdminToken);
    expect(overviewRes.status).toBe(200);
    const traces = overviewRes.data.apiMonitoring.recentTraces;
    const foundHealth = traces.find(
      (t: any) => t.endpoint === '/api/health' && t.correlationId === customCid
    );
    expect(foundHealth).toBeDefined();
    expect(foundHealth.durationMs).toBeGreaterThanOrEqual(0);
    expect(foundHealth.status).toBe(200);
  });

  it('3. Accepts validated client telemetry ingestion, preserves token-derived identity, and strips sensitive data', async () => {
    const fakeJwt = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sigXYZ123';
    const ingestRes = await reqJson('POST', '/api/monitoring/ingest', userToken, {
      events: [
        {
          kind: 'PERF',
          metric: 'app_initial_load_ms',
          module: 'Dashboard',
          durationMs: 312.5,
        },
        {
          kind: 'PERF',
          metric: 'route_prefetch_ms',
          module: 'Employee Master',
          durationMs: 84.2,
        },
        {
          kind: 'ERROR',
          module: 'Attendance Scanner',
          errorCategory: 'JS_ERROR',
          message: `Crash with Authorization: Bearer ${fakeJwt} and payload {"employeeId":"TST_MON_01","token":"QR_TST_MON_01_SECRET99"}`,
        },
        {
          kind: 'ACTIVITY',
          action: 'MODULE_OPENED',
          module: 'Reports & Export',
          result: 'Success',
          message: 'Opened reports view',
        },
      ],
    });

    expect(ingestRes.status).toBe(200);
    expect(ingestRes.data.accepted).toBe(4);

    // Reject empty or oversized invalid batches via Zod
    const badBatch = await reqJson('POST', '/api/monitoring/ingest', userToken, { events: [] });
    expect(badBatch.status).toBe(400);

    // Inspect overview payload: verify PII / QR secrets / JWT tokens are redacted everywhere
    const overviewRes = await reqJson('GET', '/api/monitoring/overview?range=15m', superAdminToken);
    expect(overviewRes.status).toBe(200);
    const serialized = JSON.stringify(overviewRes.data);
    expect(serialized).not.toContain('QR_TST_MON_01_SECRET99');
    expect(serialized).not.toContain(fakeJwt);
    expect(overviewRes.data.websitePerf.initialLoad.count).toBe(1);
    expect(overviewRes.data.websitePerf.initialLoad.avgMs).toBeCloseTo(312.5, 1);
    expect(overviewRes.data.websitePerf.routePrefetch.count).toBe(1);

    // Server sanitizer unit verification
    expect(sanitizeTelemetryMessage('Bearer abc.def.ghi')).toBe('Bearer [REDACTED]');
    const cleanMeta = sanitizeTelemetryMetadata({
      module: 'Scanner',
      qrCodeToken: 'QR_SECRET',
      password: '123',
      nested: { authorization: 'Bearer x', rowCount: 10 },
    });
    expect(cleanMeta).toEqual({ module: 'Scanner', nested: { rowCount: 10 } });
  });

  it('4. Keeps unmeasured modules honest ("Unknown / Not Instrumented") and upgrades when real telemetry arrives', async () => {
    const initialRes = await reqJson('GET', '/api/monitoring/overview?range=15m', superAdminToken);
    expect(initialRes.status).toBe(200);
    const modHealth: any[] = initialRes.data.moduleHealth;
    expect(modHealth.length).toBe(14);

    // Unmeasured module like Shift Management must NOT falsely claim Healthy
    const shiftMod = modHealth.find((m) => m.module === 'Shift Management');
    expect(shiftMod.status).toBe('Unknown / Not Instrumented');
    expect(shiftMod.sampleCount).toBe(0);

    // Record real API metric touching /api/shifts or QR punch -> status transitions based on measured samples
    recordQrPunchTelemetry(db, {
      mode: 'QR_IN',
      action: 'PUNCH_IN',
      success: true,
      isDuplicateRejection: false,
      timedOut: false,
      totalServerMs: 140,
      txMs: 42,
    });
    const afterRes = await reqJson('GET', '/api/monitoring/overview?range=15m', superAdminToken);
    const scannerMod = afterRes.data.moduleHealth.find((m: any) => m.module === 'Attendance Scanner');
    expect(scannerMod.status).toBe('Healthy');
    expect(scannerMod.sampleCount).toBeGreaterThanOrEqual(1);
  });

  it('5. Fires live alert thresholds, suppresses duplicates via cooldowns, and supports full ACK/RESOLVE/REOPEN lifecycle', async () => {
    // Configure strict lower threshold via endpoint
    const updRes = await reqJson('POST', '/api/monitoring/thresholds', superAdminToken, {
      qrFailureSpikeCount: 2,
      qrPunchAvgWarningMs: 300,
      alertCooldownMinutes: 30,
    });
    expect(updRes.status).toBe(200);
    expect(updRes.data.thresholds.qrFailureSpikeCount).toBe(2);

    // Record 3 failed QR punches -> triggers ALERT_REPEATED_QR_FAILURES
    for (let i = 0; i < 3; i++) {
      recordQrPunchTelemetry(db, {
        mode: 'QR_IN',
        action: 'ERROR',
        success: false,
        isDuplicateRejection: false,
        timedOut: false,
        totalServerMs: 450,
        reasonCode: 'INVALID_QR',
      });
    }
    evaluateAlertThresholds(db);
    // Repeat evaluation to verify deduplication increments occurrenceCount rather than creating duplicate alert entries
    evaluateAlertThresholds(db);

    const ov1 = await reqJson('GET', '/api/monitoring/overview?range=15m', superAdminToken);
    const qrFailAlerts = ov1.data.alerts.filter(
      (a: any) => a.groupKey === 'ALERT_REPEATED_QR_FAILURES'
    );
    expect(qrFailAlerts.length).toBe(1);
    expect(qrFailAlerts[0].occurrenceCount).toBeGreaterThanOrEqual(2);
    expect(qrFailAlerts[0].status).toBe('ACTIVE');

    // Acknowledge -> Resolve -> Reopen lifecycle
    const ackRes = await reqJson('POST', '/api/monitoring/alerts/action', superAdminToken, {
      groupKey: 'ALERT_REPEATED_QR_FAILURES',
      action: 'ACKNOWLEDGE',
    });
    expect(ackRes.status).toBe(200);
    expect(ackRes.data.alert.status).toBe('ACKNOWLEDGED');

    const resolveRes = await reqJson('POST', '/api/monitoring/alerts/action', superAdminToken, {
      groupKey: 'ALERT_REPEATED_QR_FAILURES',
      action: 'RESOLVE',
    });
    expect(resolveRes.status).toBe(200);
    expect(resolveRes.data.alert.status).toBe('RESOLVED');

    // Within cooldown window, re-evaluating does NOT reopen resolved alert prematurely
    evaluateAlertThresholds(db);
    const ov2 = await reqJson('GET', '/api/monitoring/overview?range=15m', superAdminToken);
    expect(
      ov2.data.alerts.find((a: any) => a.groupKey === 'ALERT_REPEATED_QR_FAILURES')?.status
    ).toBe('RESOLVED');

    const reopenRes = await reqJson('POST', '/api/monitoring/alerts/action', superAdminToken, {
      groupKey: 'ALERT_REPEATED_QR_FAILURES',
      action: 'REOPEN',
    });
    expect(reopenRes.status).toBe(200);
    expect(reopenRes.data.alert.status).toBe('ACTIVE');
  });

  it('6. Caps in-memory ring buffers cleanly and executes live health probe', async () => {
    for (let i = 0; i < 650; i++) {
      recordApiMetric(db, {
        endpoint: '/api/employees',
        method: 'GET',
        status: 200,
        durationMs: 25 + (i % 10),
        success: true,
        timedOut: false,
        errorCategory: 'NONE',
        correlationId: `cid_${i}`,
      });
    }
    const probeRes = await reqJson('POST', '/api/monitoring/health-probe', superAdminToken);
    expect(probeRes.status).toBe(200);
    expect(probeRes.data.status).toBe('ok');
    expect(typeof probeRes.data.firestoreProbeMs).toBe('number');

    const ov = await reqJson('GET', '/api/monitoring/overview?range=15m', superAdminToken);
    // API traces are capped at MAX_API_TRACES (600) plus the small overhead of the test calls
    expect(ov.data.apiMonitoring.totalRequests).toBeLessThanOrEqual(600);
  });

  it('7. Never blocks QR punch processing when monitoring Firestore persistence fails', async () => {
    // Force monitoring_rollups writes to fail loudly
    const origCollection = db.collection.bind(db);
    vi.spyOn(db, 'collection').mockImplementation((name: string) => {
      if (name === 'monitoring_rollups' || name === 'monitoring_alerts') {
        return {
          doc: () => ({
            get: async () => ({ exists: false, data: () => undefined }),
            set: async () => {
              throw new Error('Simulated monitoring storage write quota failure');
            },
            update: async () => {
              throw new Error('Simulated monitoring storage write quota failure');
            },
            delete: async () => undefined,
          }),
          get: async () => ({ empty: true, size: 0, docs: [] }),
          where: () => ({ get: async () => ({ empty: true, size: 0, docs: [] }) }),
          orderBy: () => ({ limit: () => ({ get: async () => ({ empty: true, size: 0, docs: [] }) }) }),
          limit: () => ({ get: async () => ({ empty: true, size: 0, docs: [] }) }),
          add: async () => {
            throw new Error('Simulated monitoring storage write quota failure');
          },
        } as any;
      }
      return origCollection(name);
    });

    // Execute real QR Punch In while monitoring storage fails
    const scanRes = await reqJson('POST', '/api/attendance/scan', userToken, {
      rawPayload: JSON.stringify({
        employeeId: 'TST_MON_01',
        token: 'QR_TST_MON_01_SECRET99',
      }),
      scannerType: 'IN',
      scannerDevice: 'USB_SCANNER',
    });
    expect(scanRes.status).toBe(200);
    expect(scanRes.data.success).toBe(true);
    expect(scanRes.data.action).toBe('PUNCH_IN');

    // Explicit flush catches and records internal error without throwing
    recordDbOpMetric(db, {
      operation: 'WRITE',
      collection: 'attendance',
      durationMs: 12,
      success: true,
    });
    recordErrorTelemetry(db, {
      source: 'BACKEND',
      module: 'System Performance',
      category: 'TEST',
      severity: 'WARNING',
      message: 'Non-fatal test notice',
    });
    await expect(flushMonitoringToFirestore(db)).resolves.toBeUndefined();
  });

  it('8. Renders SystemPerformance dashboard & hides System Performance link from non-Super Admins in Sidebar', () => {
    const sampleOverview: MonitoringOverviewResponse = {
      success: true,
      generatedAt: new Date().toISOString(),
      window: {
        range: '24h',
        fromIso: new Date(Date.now() - 86_400_000).toISOString(),
        toIso: new Date().toISOString(),
      },
      overview: {
        overallHealth: 'Healthy',
        backendStatus: 'Healthy',
        frontendStatus: 'Unknown / Not Instrumented',
        firebaseConnectivity: 'Connected',
        firebasePingMs: 18.4,
        projectId: 'narid-atdc-tracker',
        databaseId: 'ai-studio-manpowertracker',
        credentialMode: 'ADC',
        apiAvgMs: 42.1,
        apiP50Ms: 38.0,
        apiP95Ms: 91.2,
        totalApiRequests: 14,
        failedApiRequests: 0,
        timeoutApiRequests: 0,
        applicationErrorCount: 0,
        activeUserSessions: 1,
        totalActiveUserAccounts: 3,
        recentAuditCount: null,
        qrPunchAvgMs: 120.5,
        qrPunchP50Ms: 118.0,
        qrPunchP95Ms: 155.0,
        qrPunchMaxMs: 160.0,
        qrPunchTotal: 2,
        qrPunchSuccessRatePct: 100,
        qrPunchFailureRatePct: 0,
        qrDuplicateRejections: 0,
        qrTimeouts: 0,
        backgroundRefreshAvgMs: null,
        backgroundRefreshStatus: 'Unknown / Not Instrumented',
        lastSuccessfulHealthCheck: new Date().toISOString(),
        lastMonitoringUpdate: new Date().toISOString(),
        activeAlertsCount: 0,
      },
      websitePerf: {
        initialLoad: { count: 0, minMs: null, avgMs: null, p50Ms: null, p95Ms: null, maxMs: null },
        navigation: { count: 0, minMs: null, avgMs: null, p50Ms: null, p95Ms: null, maxMs: null },
        skeletonDuration: { count: 0, minMs: null, avgMs: null, p50Ms: null, p95Ms: null, maxMs: null },
        routePrefetch: { count: 0, minMs: null, avgMs: null, p50Ms: null, p95Ms: null, maxMs: null },
        backgroundRefresh: { count: 0, minMs: null, avgMs: null, p50Ms: null, p95Ms: null, maxMs: null },
        slowRender: { count: 0, minMs: null, avgMs: null, p50Ms: null, p95Ms: null, maxMs: null },
        jsErrorsCount: 0,
        promiseRejectionsCount: 0,
        networkFailuresCount: 0,
      },
      apiMonitoring: {
        summary: { count: 14, minMs: 10, avgMs: 42.1, p50Ms: 38, p95Ms: 91.2, maxMs: 99 },
        totalRequests: 14,
        failedRequests: 0,
        timeoutCount: 0,
        endpoints: [],
        recentTraces: [],
      },
      databaseMonitoring: {
        connectivity: 'Connected',
        probeLatencyMs: 18.4,
        measuredTotalOps: 6,
        measuredReads: 4,
        measuredWrites: 2,
        transactionCount: 1,
        failedTransactionCount: 0,
        avgOpDurationMs: 22.0,
        p95OpDurationMs: 35.0,
        permissionDeniedCount: 0,
        networkErrorCount: 0,
        slowOperations: [],
        bulkAndImportBatches: [],
        cloudBillingUsageStatus: 'Not Available',
        cloudBillingRequirement: 'Requires IAM role roles/monitoring.viewer',
      },
      qrPerformance: {
        summary: { count: 2, minMs: 110, avgMs: 120.5, p50Ms: 118, p95Ms: 155, maxMs: 160 },
        successCount: 2,
        failedCount: 0,
        duplicateRejections: 0,
        timeoutCount: 0,
        stages: {
          qrDetect: { count: 0, minMs: null, avgMs: null, p50Ms: null, p95Ms: null, maxMs: null },
          qrParse: { count: 0, minMs: null, avgMs: null, p50Ms: null, p95Ms: null, maxMs: null },
          apiRequest: { count: 0, minMs: null, avgMs: null, p50Ms: null, p95Ms: null, maxMs: null },
          authTokenVerify: { count: 0, minMs: null, avgMs: null, p50Ms: null, p95Ms: null, maxMs: null },
          tokenValidation: { count: 0, minMs: null, avgMs: null, p50Ms: null, p95Ms: null, maxMs: null },
          firestoreTx: { count: 1, minMs: 30, avgMs: 30, p50Ms: 30, p95Ms: 30, maxMs: 30 },
          totalPunchIn: { count: 2, minMs: 110, avgMs: 120.5, p50Ms: 118, p95Ms: 155, maxMs: 160 },
          totalPunchOut: { count: 0, minMs: null, avgMs: null, p50Ms: null, p95Ms: null, maxMs: null },
          manualPunch: { count: 0, minMs: null, avgMs: null, p50Ms: null, p95Ms: null, maxMs: null },
        },
        recentPunches: [],
      },
      userActivity: [],
      moduleHealth: [
        {
          module: 'Dashboard',
          status: 'Unknown / Not Instrumented',
          sampleCount: 0,
          errorCount: 0,
          avgLatencyMs: null,
          p95LatencyMs: null,
          lastActivityAt: null,
          lastErrorAt: null,
          reason: 'No measured traffic in selected window',
        },
      ],
      errorLogs: [],
      alerts: [],
      thresholds: {
        ...DEFAULT_MONITORING_THRESHOLDS,
      },
      timeSeries: [],
      historicalRollups: [],
    };

    const html = renderToStaticMarkup(
      React.createElement(SystemPerformance, { initialData: sampleOverview })
    );
    expect(html).toContain('System Performance &amp; Live Monitoring Center');
    expect(html).toContain('Unknown / Not Instrumented');
    expect(html).toContain('120.5 ms');

    // Role gating check in Sidebar
    const superSidebar = renderToStaticMarkup(
      React.createElement(Sidebar, {
        currentTab: 'dashboard',
        onSelectTab: () => {},
        currentUserRole: {
          id: 'role_superadmin',
          loginId: 'superadmin',
          name: 'Super Admin',
          email: 'super@narid.com',
          role: 'super_admin',
          status: 'Active',
          modulesAllowed: ['all'],
          createdAt: '',
          updatedAt: '',
        },
      })
    );
    expect(superSidebar).toContain('System Performance');

    const adminSidebar = renderToStaticMarkup(
      React.createElement(Sidebar, {
        currentTab: 'dashboard',
        onSelectTab: () => {},
        currentUserRole: {
          id: 'role_admin',
          loginId: 'admin',
          name: 'Factory Admin',
          email: 'admin@narid.com',
          role: 'admin',
          status: 'Active',
          modulesAllowed: ['all'],
          createdAt: '',
          updatedAt: '',
        },
      })
    );
    expect(adminSidebar).not.toContain('System Performance');
  });
});
