import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../server.ts';
import {
  COL_TECHNICAL_ERROR_LOGS,
  generateBackendRequestId,
  persistTechnicalErrorLog,
} from '../serverDiagnostics.ts';
import {
  ERROR_CODE_REGISTRY,
  classifyAndNormalizeError,
  containsRawTechnicalLeak,
  formatUtcAndIstTimestamps,
  generateFrontendErrorEventId,
  sanitizeTextForLog,
  sanitizeDiagnosticObject,
} from '../src/utils/errorRegistry.ts';
import {
  ApiRequestError,
  executeApiFetch,
  safeParseJsonResponse,
} from '../src/config/api.ts';
import {
  handleAppError,
  getSafeErrorText,
} from '../src/services/errorHandlingService.ts';
import {
  InMemoryAdminAuth,
  InMemoryFirestore,
  TEST_CANONICAL_ACCOUNTS,
  seedIsolatedTestEnvironment,
} from './helpers/inMemoryAdmin.ts';

const REQUEST_ID_PATTERN = /^REQ-\d{8}-[A-Z0-9]{12}$/;
const FRONTEND_EVENT_ID_PATTERN = /^ERR-\d{8}-[A-Z0-9]{12}$/;

describe('Centralized Error Handling, Unique Request ID & Admin Diagnostic Logging System', () => {
  let db: InMemoryFirestore;
  let auth: InMemoryAdminAuth;
  let app: ReturnType<typeof createApp>['app'];
  let superToken: string;
  let adminToken: string;
  let userToken: string;

  beforeEach(async () => {
    db = new InMemoryFirestore();
    auth = new InMemoryAdminAuth();
    await seedIsolatedTestEnvironment(db, auth);
    app = createApp({
      db,
      auth,
      projectId: 'narid-atdc-tracker',
      databaseId: 'ai-studio-manpowertracker-9b87a863-5c0d-4126-accb-7a3be802b10b',
      credentialMode: 'ADC',
      disableBackgroundBoot: true,
    }).app;

    superToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.superadmin.uid);
    adminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid);
    userToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.user.uid);
  });

  // ==========================================================================
  // 1. Standardized Registry & Network vs Database Classification
  // ==========================================================================
  it('T1: Classifies browser network / Failed to fetch failures as NET-001 (NEVER mislabelled as DB-001) and labels frontend Event IDs cleanly', () => {
    const normalized = classifyAndNormalizeError({
      rawMessage: 'TypeError: Failed to fetch https://narid-atdc-tracker.vercel.app/api/attendance/scan',
      isNetworkFetchFailure: true,
      httpStatus: 0,
      moduleName: 'Attendance Scanner',
      endpoint: '/api/attendance/scan',
    });

    expect(normalized.errorCode).toBe('NET-001');
    expect(normalized.category).toBe('NETWORK');
    expect(normalized.categoryLabel).toBe('Network Connectivity');
    expect(normalized.userTitle).toBe('Network Issue');
    expect(normalized.networkFailureClass).not.toBe('NONE');
    expect(normalized.dbFailureClass).toBe('NONE');
    expect(normalized.failureStage).toBe('BEFORE_BACKEND');
    expect(normalized.referenceId).toMatch(FRONTEND_EVENT_ID_PATTERN);
    expect(normalized.referenceIdSource).toBe('frontend');
    expect(normalized.errorEventId).toBe(normalized.referenceId);
    expect(normalized.requestId).toBeNull();
    // User-facing strings must never contain raw technical details
    expect(containsRawTechnicalLeak(normalized.userTitle)).toBe(false);
    expect(containsRawTechnicalLeak(normalized.userAction)).toBe(false);
    expect(normalized.shortLabel).toBe('Network Issue – Error Code: NET-001');
  });

  it('T2: Classifies request timeout as NET-002 and verified Firestore connectivity/operation failures as DB-001 / DB-002', () => {
    const timeoutNorm = classifyAndNormalizeError({
      rawMessage: 'AbortError: The user aborted a request',
      isTimeout: true,
      httpStatus: 408,
      moduleName: 'Attendance Scanner',
    });
    expect(timeoutNorm.errorCode).toBe('NET-002');
    expect(timeoutNorm.networkFailureClass).toBe('REQUEST_TIMEOUT');
    expect(timeoutNorm.dbFailureClass).toBe('NONE');
    expect(timeoutNorm.rootCauseConfidence).toBe('CONFIRMED');

    const dbConnNorm = classifyAndNormalizeError({
      rawMessage: 'FirebaseError: [code=unavailable]: The Firestore service is currently unavailable',
      code: 'FIREBASE_ADMIN_UNCONFIGURED',
      httpStatus: 503,
      moduleName: 'Master Data',
      dbOperationCategory: 'connection',
      requestId: 'REQ-20261123-ABCDEF123456',
    });
    expect(dbConnNorm.errorCode).toBe('DB-001');
    expect(dbConnNorm.userTitle).toBe('Database Connectivity Issue');
    expect(dbConnNorm.dbFailureClass).toBe('FIRESTORE_UNAVAILABLE');
    expect(dbConnNorm.rootCauseConfidence).toBe('CONFIRMED');
    expect(dbConnNorm.referenceId).toBe('REQ-20261123-ABCDEF123456');
    expect(dbConnNorm.referenceIdSource).toBe('backend');

    const dbOpNorm = classifyAndNormalizeError({
      rawMessage: 'Firestore transaction aborted due to contention on attendance record',
      httpStatus: 500,
      moduleName: 'Attendance Scanner',
      dbOperationCategory: 'transaction',
      requestId: 'REQ-20261123-123456ABCDEF',
    });
    expect(dbOpNorm.errorCode).toBe('DB-002');
    expect(dbOpNorm.dbFailureClass).toBe('TRANSACTION_ABORTED');
    expect(dbOpNorm.rootCauseConfidence).toBe('CONFIRMED');
  });

  it('T3: Never exposes raw technical messages, URLs, Firebase errors, Vercel internals, or stack traces in user-facing output', () => {
    const rawLeaks = [
      'TypeError: Failed to fetch https://narid-atdc-tracker.vercel.app/api/auth/login',
      'FirebaseError: Missing or insufficient permissions on collection user_roles',
      'Verify Vercel Serverless Function routing (/api/*) and vercel.json rewrites.',
      'Error: ECONNREFUSED 127.0.0.1:3000\n    at TCPConnectWrap.afterConnect (node:net:1555:16)',
      '<!doctype html><html><body>502 Bad Gateway</body></html>',
    ];

    for (const raw of rawLeaks) {
      expect(containsRawTechnicalLeak(raw)).toBe(true);
      const safeText = getSafeErrorText(new Error(raw), {
        moduleName: 'Dashboard',
        reportToBackend: false,
      });
      expect(safeText).toMatch(/Error Code: [A-Z]+-\d{3}/);
      expect(safeText).toMatch(/Ref: (?:REQ|ERR)-\d{8}-[A-Z0-9]{12}/);
      expect(safeText.toLowerCase()).not.toContain('vercel');
      expect(safeText.toLowerCase()).not.toContain('firebaseerror');
      expect(safeText.toLowerCase()).not.toContain('failed to fetch');
      expect(safeText.toLowerCase()).not.toContain('econnrefused');
      expect(safeText.toLowerCase()).not.toContain('user_roles');
      expect(safeText.toLowerCase()).not.toContain('https://');
      expect(safeText.toLowerCase()).not.toContain('<!doctype');
    }

    // Verify every registry code has safe, non-leaking user strings
    for (const def of Object.values(ERROR_CODE_REGISTRY)) {
      expect(containsRawTechnicalLeak(def.userTitle)).toBe(false);
      expect(containsRawTechnicalLeak(def.defaultAction)).toBe(false);
    }
  });

  // ==========================================================================
  // 2. Cryptographic Unique Request ID Generation & Propagation
  // ==========================================================================
  it('T4: Generates cryptographically unique non-sequential X-Request-ID on EVERY backend request (2xx, 4xx, 5xx) and ignores untrusted client Request IDs', async () => {
    const seenIds = new Set<string>();
    const clientForgedId = 'REQ-19990101-FORGEDCLIENT';

    // 2xx health checks (5 consecutive requests)
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .get('/api/health')
        .set('X-Request-ID', clientForgedId);
      expect(res.status).toBe(200);
      const reqId = res.headers['x-request-id'];
      expect(reqId).toMatch(REQUEST_ID_PATTERN);
      expect(reqId).not.toBe(clientForgedId);
      expect(seenIds.has(reqId)).toBe(false);
      seenIds.add(reqId);
    }

    // 404 API error includes matching X-Request-ID and body.requestId
    const res404 = await request(app)
      .get('/api/nonexistent-endpoint-test')
      .set('X-Request-ID', 'FORGED-CLIENT-HEADER-12345');
    expect(res404.status).toBe(404);
    const id404 = res404.headers['x-request-id'];
    expect(id404).toMatch(REQUEST_ID_PATTERN);
    expect(id404).not.toBe('FORGED-CLIENT-HEADER-12345');
    expect(res404.body.requestId).toBe(id404);
    expect(res404.body.errorCode).toBe('API-001');
    expect(res404.headers['x-error-code']).toBe('API-001');
    expect(seenIds.has(id404)).toBe(false);
    seenIds.add(id404);

    // 401 unauthorized request on protected endpoint includes matching X-Request-ID and body.requestId
    const res401 = await request(app).get('/api/diagnostics/errors');
    expect(res401.status).toBe(401);
    const id401 = res401.headers['x-request-id'];
    expect(id401).toMatch(REQUEST_ID_PATTERN);
    expect(res401.body.requestId).toBe(id401);
    expect(res401.body.errorCode).toBe('AUTH-002');
    expect(seenIds.has(id401)).toBe(false);

    // Verify generator produces unique values across 100 calls
    const batch = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const { requestId: id } = generateBackendRequestId();
      expect(id).toMatch(REQUEST_ID_PATTERN);
      batch.add(id);
    }
    expect(batch.size).toBe(100);
  });

  it('T5: Successful 2xx API requests NEVER create false entries in technical_error_logs', async () => {
    const healthRes = await request(app).get('/api/health');
    expect(healthRes.status).toBe(200);
    expect(healthRes.headers['x-request-id']).toMatch(REQUEST_ID_PATTERN);

    const dashRes = await request(app)
      .get('/api/dashboard/summary')
      .set('Authorization', `Bearer ${superToken}`);
    expect(dashRes.status).toBe(200);
    expect(dashRes.headers['x-request-id']).toMatch(REQUEST_ID_PATTERN);

    // Allow any microtasks to settle
    await new Promise((r) => setTimeout(r, 25));

    const stored = db.getRawCollection(COL_TECHNICAL_ERROR_LOGS);
    expect(Object.keys(stored)).toHaveLength(0);
  });

  // ==========================================================================
  // 3. Frontend ApiRequestError + handleAppError Propagation of Exact Backend Request ID
  // ==========================================================================
  it('T6: Frontend safeParseJsonResponse and handleAppError preserve and display the exact backend X-Request-ID', async () => {
    const backendReqId = 'REQ-20261123-7A8B9C0D1E2F';
    const resp = new Response(
      JSON.stringify({
        success: false,
        error: 'Firestore permission denied on collection employees',
        requestId: backendReqId,
        errorCode: 'DB-001',
        errorCategory: 'Database Connectivity',
      }),
      {
        status: 503,
        headers: {
          'Content-Type': 'application/json',
          'X-Request-ID': backendReqId,
          'X-Error-Code': 'DB-001',
        },
      }
    );

    const parsed = await safeParseJsonResponse(resp, 'GET /api/employees');
    expect(parsed.ok).toBe(false);
    expect(parsed.requestId).toBe(backendReqId);
    expect(parsed.errorCode).toBe('DB-001');
    // Must not leak raw Firestore / collection name to user
    expect(parsed.errorMessage).toContain('DB-001');
    expect(parsed.errorMessage).toContain(backendReqId);
    expect(parsed.errorMessage.toLowerCase()).not.toContain('firestore');
    expect(parsed.errorMessage.toLowerCase()).not.toContain('employees');

    const apiErr = new ApiRequestError(
      parsed.errorMessage,
      parsed.status,
      parsed.data,
      parsed.isHtmlOrNonJson,
      {
        requestId: parsed.requestId,
        errorCode: parsed.errorCode,
        technicalDetail: parsed.technicalDetail,
        endpoint: '/api/employees',
      }
    );

    const handled = handleAppError(apiErr, {
      moduleName: 'Employee Master',
      reportToBackend: false,
      notifyGlobalToast: false,
    });

    expect(handled.errorCode).toBe('DB-001');
    expect(handled.referenceId).toBe(backendReqId);
    expect(handled.referenceIdSource).toBe('backend');
    expect(handled.requestId).toBe(backendReqId);
  });

  it('T7: Frontend-only network fetch failure generates distinct ERR- event ID and never exposes internal endpoints or Vercel URLs', async () => {
    const prevFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => {
        throw new TypeError('Failed to fetch');
      }) as typeof fetch;

      let caught: any = null;
      try {
        await executeApiFetch(
          'https://narid-atdc-tracker.vercel.app/api/attendance/scan',
          { method: 'POST' },
          'POST /api/attendance/scan',
          { noRetryOnNetworkError: true }
        );
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(ApiRequestError);
      expect(caught.errorCode).toBe('NET-001');
      expect(caught.isNetworkFetchFailure).toBe(true);
      expect(caught.errorEventId).toMatch(FRONTEND_EVENT_ID_PATTERN);
      expect(caught.message).toContain('NET-001');
      expect(caught.message).toContain(caught.errorEventId);
      expect(caught.message.toLowerCase()).not.toContain('vercel');
      expect(caught.message.toLowerCase()).not.toContain('failed to fetch');
      expect(caught.message).not.toContain('/api/attendance/scan');

      const handled = handleAppError(caught, {
        moduleName: 'Attendance Scanner',
        reportToBackend: false,
      });
      expect(handled.errorCode).toBe('NET-001');
      expect(handled.referenceId).toBe(caught.errorEventId);
      expect(handled.referenceIdSource).toBe('frontend');
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  // ==========================================================================
  // 4. Secret / PII Scrubbing & CR/LF Log Injection Protection
  // ==========================================================================
  it('T8: Scrubs passwords, Firebase ID tokens, Bearer tokens, API keys, Master PINs, and strips CR/LF log injection characters', () => {
    const maliciousPayload =
      'Auth failed\r\nFAKE_LOG_ENTRY: admin granted\nAuthorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123 ' +
      'apiKey=AIzaSyD1234567890abcdefghijklmnopqrstuv password="SuperSecretPassword123!" masterPin: 987654 refreshToken=rt_secret_9999999';

    const cleaned = sanitizeTextForLog(maliciousPayload);
    expect(cleaned).not.toContain('\r');
    expect(cleaned).not.toContain('\n');
    expect(cleaned).not.toContain('SuperSecretPassword123!');
    expect(cleaned).not.toContain('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(cleaned).not.toContain('AIzaSyD1234567890abcdefghijklmnopqrstuv');
    expect(cleaned).not.toContain('987654');
    expect(cleaned).not.toContain('rt_secret_9999999');
    expect(cleaned).toContain('[REDACTED');

    const objClean = sanitizeDiagnosticObject({
      password: 'MyPassword!',
      idToken: 'eyJ.abc.def',
      safeField: 'hello\r\nworld',
      nested: {
        masterPin: '112233',
        employeeId: 'EMP001',
      },
    }) as Record<string, any>;
    expect(objClean.password).toBe('[REDACTED]');
    expect(objClean.idToken).toBe('[REDACTED]');
    expect(objClean.safeField).toBe('hello world');
    expect(objClean.nested.masterPin).toBe('[REDACTED]');
    expect(objClean.nested.employeeId).toBe('EMP001');
  });

  // ==========================================================================
  // 5. Protected Admin Diagnostic Logging APIs, RBAC, Deduplication & Trace Search
  // ==========================================================================
  it('T9: Enforces strict RBAC on Technical Error Logs (Super Admin & explicitly authorized Admin allowed; ordinary USER & unauthorized Admin get 403)', async () => {
    // Unauthenticated -> 401 (Session Expired / AUTH-002 on protected endpoint)
    const unauth = await request(app).get('/api/diagnostics/errors');
    expect(unauth.status).toBe(401);
    expect(unauth.body.errorCode).toBe('AUTH-002');

    // Ordinary USER -> 403
    const userRes = await request(app)
      .get('/api/diagnostics/errors')
      .set('Authorization', `Bearer ${userToken}`);
    expect(userRes.status).toBe(403);
    expect(userRes.body.errorCode).toBe('PERM-001');

    // Ordinary USER cannot search trace or update status either
    const userTrace = await request(app)
      .get('/api/diagnostics/trace/REQ-20261123-ABCDEF123456')
      .set('Authorization', `Bearer ${userToken}`);
    expect(userTrace.status).toBe(403);

    // ADMIN without audit_logs.view permission -> 403
    await db.collection('role_permissions').doc('admin').set({
      roleId: 'admin',
      modulePermissions: { audit_logs: { view: false, add: false, edit: false, delete: false } },
    });
    const unauthAdminRes = await request(app)
      .get('/api/diagnostics/errors')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(unauthAdminRes.status).toBe(403);

    // SUPER_ADMIN -> 200
    const superRes = await request(app)
      .get('/api/diagnostics/errors')
      .set('Authorization', `Bearer ${superToken}`);
    expect(superRes.status).toBe(200);
    expect(superRes.body.success).toBe(true);
    expect(Array.isArray(superRes.body.errors)).toBe(true);
  });

  it('T10: Explicitly authorized ADMIN (role_permissions.audit_logs.view = true) can access Technical Error Logs & Request Trace', async () => {
    await db.collection('role_permissions').doc('admin').set({
      roleId: 'admin',
      modulePermissions: { audit_logs: { view: true, add: false, edit: false, delete: false } },
    });

    const adminRes = await request(app)
      .get('/api/diagnostics/errors')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(adminRes.status).toBe(200);
    expect(adminRes.body.success).toBe(true);
  });

  it('T11: Persists detailed IST/UTC diagnostic records, groups repeated identical errors within 15 minutes while preserving occurrences, and supports Request ID trace search', async () => {
    const baseMs = Date.parse('2026-11-23T10:00:00.000Z');
    const reqId1 = 'REQ-20261123-AAAA11112222';
    const reqId2 = 'REQ-20261123-BBBB33334444';

    const first = await persistTechnicalErrorLog({
      db,
      errorCode: 'DB-002',
      errorCategory: 'DATABASE',
      moduleName: 'Attendance Scanner',
      apiEndpoint: '/api/attendance/scan',
      httpStatus: 500,
      requestId: reqId1,
      errorEventId: null,
      referenceIdSource: 'backend',
      technicalMessage: 'Transaction write contention on attendance document',
      rootCauseConfidence: 'CONFIRMED',
      rootCauseDetails: 'Verified Firestore transaction contention during punch commit.',
      exceptionType: 'FirestoreTransactionError',
      browserDeviceInfo: 'Vitest/Node',
      dbFailureClass: 'TRANSACTION_ABORTED',
      dbOperationCategory: 'transaction',
      failureStage: 'DATABASE',
      affectedUserUid: TEST_CANONICAL_ACCOUNTS.user.uid,
      affectedUserLoginId: 'user',
      userRole: 'USER',
      lifecycleEvents: [
        { stage: 'REQUEST_RECEIVED', timestampUtc: new Date(baseMs).toISOString(), elapsedMs: 0, detail: 'POST /api/attendance/scan' },
        { stage: 'AUTH_VERIFIED', timestampUtc: new Date(baseMs + 5).toISOString(), elapsedMs: 5, detail: 'Authenticated as user' },
        { stage: 'DB_OPERATION_FAILED', timestampUtc: new Date(baseMs + 25).toISOString(), elapsedMs: 25, detail: 'Transaction aborted' },
      ],
      nowMs: baseMs,
    });

    expect(first).not.toBeNull();
    expect(first!.occurrenceCount).toBe(1);

    // Repeat identical error 3 minutes later with a NEW Request ID -> grouped, occurrenceCount=2, both Request IDs preserved
    const second = await persistTechnicalErrorLog({
      db,
      errorCode: 'DB-002',
      errorCategory: 'DATABASE',
      moduleName: 'Attendance Scanner',
      apiEndpoint: '/api/attendance/scan',
      httpStatus: 500,
      requestId: reqId2,
      errorEventId: null,
      referenceIdSource: 'backend',
      technicalMessage: 'Transaction write contention on attendance document',
      rootCauseConfidence: 'CONFIRMED',
      rootCauseDetails: 'Verified Firestore transaction contention during punch commit.',
      exceptionType: 'FirestoreTransactionError',
      browserDeviceInfo: 'Vitest/Node',
      dbFailureClass: 'TRANSACTION_ABORTED',
      dbOperationCategory: 'transaction',
      failureStage: 'DATABASE',
      affectedUserUid: TEST_CANONICAL_ACCOUNTS.user.uid,
      affectedUserLoginId: 'user',
      userRole: 'USER',
      nowMs: baseMs + 3 * 60_000,
    });

    expect(second).not.toBeNull();
    expect(second!.errorId).toBe(first!.errorId);
    expect(second!.occurrenceCount).toBe(2);

    // Search via GET /api/diagnostics/errors?requestId=<reqId2> finds the grouped record!
    const listRes = await request(app)
      .get(`/api/diagnostics/errors?requestId=${reqId2}`)
      .set('Authorization', `Bearer ${superToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.errors).toHaveLength(1);
    const log = listRes.body.errors[0];
    expect(log.errorId).toBe(first!.errorId);
    expect(log.occurrenceCount).toBe(2);
    expect(log.relatedRequestIds).toContain(reqId1);
    expect(log.relatedRequestIds).toContain(reqId2);
    expect(log.timestampIst).toContain('IST');
    expect(log.timestampUtc).toBeTruthy();
    expect(log.lifecycleEvents.length).toBeGreaterThanOrEqual(3);

    // Dedicated Request Trace API locates record by either reqId1 or reqId2
    const traceRes = await request(app)
      .get(`/api/diagnostics/trace/${reqId2}`)
      .set('Authorization', `Bearer ${superToken}`);
    expect(traceRes.status).toBe(200);
    expect(traceRes.body.success).toBe(true);
    expect(traceRes.body.totalMatched).toBe(1);
    expect(traceRes.body.records[0].errorId).toBe(first!.errorId);
  });

  it('T12: Supports frontend authenticated diagnostic reporting (POST /api/diagnostics/report) with secret redaction and admin resolution workflow (OPEN -> INVESTIGATING -> RESOLVED)', async () => {
    const clientEventId = generateFrontendErrorEventId();

    const reportRes = await request(app)
      .post('/api/diagnostics/report')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        errorCode: 'NET-001',
        moduleName: 'Attendance Scanner',
        apiEndpoint: '/api/attendance/scan',
        httpStatus: 0,
        errorEventId: clientEventId,
        technicalMessage: 'Browser fetch error password="LeakedPassword!" Bearer eyJabc.def.ghi',
        rootCauseConfidence: 'SUSPECTED',
        rootCauseDetails: 'Network disconnected before reaching backend.',
        networkFailureClass: 'INTERNET_DISCONNECTED',
        dbFailureClass: 'NONE',
        failureStage: 'BEFORE_BACKEND',
        retryCount: 1,
      });

    expect(reportRes.status).toBe(201);
    expect(reportRes.body.success).toBe(true);
    expect(reportRes.body.errorId).toBeTruthy();

    // Verify Super Admin can trace by frontend clientEventId and verify secrets were redacted
    const traceRes = await request(app)
      .get(`/api/diagnostics/trace/${clientEventId}`)
      .set('Authorization', `Bearer ${superToken}`);
    expect(traceRes.status).toBe(200);
    expect(traceRes.body.totalMatched).toBe(1);
    const saved = traceRes.body.records[0];
    expect(saved.errorCode).toBe('NET-001');
    expect(saved.errorEventId).toBe(clientEventId);
    expect(saved.technicalMessage).not.toContain('LeakedPassword!');
    expect(saved.technicalMessage).not.toContain('eyJabc.def.ghi');
    expect(saved.affectedUserLoginId).toBe('user');
    expect(saved.resolutionStatus).toBe('OPEN');

    // Update resolution status -> INVESTIGATING -> RESOLVED with notes
    const patchInv = await request(app)
      .patch(`/api/diagnostics/errors/${saved.errorId}/status`)
      .set('Authorization', `Bearer ${superToken}`)
      .send({
        resolutionStatus: 'INVESTIGATING',
        resolutionNotes: 'Checking gate Wi-Fi router signal.',
      });
    expect(patchInv.status).toBe(200);
    expect(patchInv.body.errorRecord.resolutionStatus).toBe('INVESTIGATING');

    const patchRes = await request(app)
      .patch(`/api/diagnostics/errors/${saved.errorId}/status`)
      .set('Authorization', `Bearer ${superToken}`)
      .send({
        resolutionStatus: 'RESOLVED',
        resolutionNotes: 'Replaced ethernet patch cable at Gate 2 scanner.',
      });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.errorRecord.resolutionStatus).toBe('RESOLVED');
    expect(patchRes.body.errorRecord.resolvedBy).toBe('superadmin');
    expect(patchRes.body.errorRecord.resolvedAtUtc).toBeTruthy();

    // Filter by status=RESOLVED confirms persistence
    const filtered = await request(app)
      .get('/api/diagnostics/errors?status=RESOLVED&errorCode=NET-001')
      .set('Authorization', `Bearer ${superToken}`);
    expect(filtered.status).toBe(200);
    expect(filtered.body.errors.some((l: any) => l.errorId === saved.errorId)).toBe(true);
  });

  it('T13: Does not suppress security-critical AUTH/PERM errors during duplicate grouping window and formats IST/UTC accurately', async () => {
    const ts = formatUtcAndIstTimestamps(new Date(Date.parse('2026-11-23T10:30:00.000Z')));
    expect(ts.utc).toBe('2026-11-23T10:30:00.000Z');
    expect(ts.ist).toContain('2026-11-23 16:00:00');
    expect(ts.ist).toContain('IST');

    // Two unauthorized attempts -> separate security-critical entries (not suppressed into one)
    const r1 = await request(app)
      .get('/api/diagnostics/errors')
      .set('Authorization', `Bearer ${userToken}`);
    const r2 = await request(app)
      .get('/api/diagnostics/errors')
      .set('Authorization', `Bearer ${userToken}`);
    expect(r1.status).toBe(403);
    expect(r2.status).toBe(403);
    expect(r1.headers['x-request-id']).not.toBe(r2.headers['x-request-id']);

    await new Promise((r) => setTimeout(r, 40));

    const logsRes = await request(app)
      .get('/api/diagnostics/errors?errorCode=PERM-001')
      .set('Authorization', `Bearer ${superToken}`);
    expect(logsRes.status).toBe(200);
    expect(logsRes.body.errors.length).toBeGreaterThanOrEqual(2);
    const ids = logsRes.body.errors.map((l: any) => l.requestId);
    expect(ids).toContain(r1.headers['x-request-id']);
    expect(ids).toContain(r2.headers['x-request-id']);
  });

  it('T14: Preserves existing Attendance QR scan, Employee Master, and Dashboard endpoints with authoritative X-Request-ID headers', async () => {
    // Seed an active employee & verify QR scan endpoint still operates identically + returns X-Request-ID
    await db.collection('shifts').doc('DAY').set({
      id: 'DAY',
      name: 'Day Shift',
      startTime: '09:00',
      endTime: '17:30',
      scheduledDurationMinutes: 510,
      punchInWindowStart: '07:30',
      punchInWindowEnd: '12:00',
      isOvernight: false,
      gracePeriodMinutes: 15,
      status: 'Active',
    });
    await db.collection('employees').doc('EMP900').set({
      employeeId: 'EMP900',
      employeeName: 'Regression Test Operator',
      designation: 'Operator',
      floor: 'Line 1',
      section: 'Assembly',
      department: 'Production',
      employeeStatus: 'Active',
      qrCodeToken: 'QR_REGRESSION_TOKEN_900',
    });

    const scanRes = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${superToken}`)
      .send({
        rawPayload: JSON.stringify({ employeeId: 'EMP900', token: 'QR_REGRESSION_TOKEN_900' }),
        scannerType: 'IN',
        scannerDevice: 'USB_SCANNER',
        customScanTime: '2026-11-23T09:00:00+05:30',
      });
    expect(scanRes.status).toBe(200);
    expect(scanRes.body.success).toBe(true);
    expect(scanRes.headers['x-request-id']).toMatch(REQUEST_ID_PATTERN);

    const dashRes = await request(app)
      .get('/api/dashboard/summary')
      .set('Authorization', `Bearer ${superToken}`);
    expect(dashRes.status).toBe(200);
    expect(dashRes.body.success).toBe(true);
    expect(dashRes.headers['x-request-id']).toMatch(REQUEST_ID_PATTERN);
  });
});
