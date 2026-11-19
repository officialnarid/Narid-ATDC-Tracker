import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../server.ts';
import { parseQrPayload } from '../serverAttendance.ts';
import {
  AdminFirestoreLike,
  AdminAuthLike,
  AdminCollectionRefLike,
  AdminDocRefLike,
  AdminQueryLike,
} from '../serverSecurityAudit.ts';
import {
  recordPerfMetric,
  getPerfMetricStats,
  getClientPerfSnapshot,
  resetPerfMetrics,
} from '../src/utils/perfMonitor';
import {
  InMemoryAdminAuth,
  InMemoryFirestore,
  TEST_CANONICAL_ACCOUNTS,
  seedIsolatedTestEnvironment,
} from './helpers/inMemoryAdmin.ts';

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function wrapDbWithLatency(
  inner: InMemoryFirestore,
  latencies: { readMs: number; queryMs: number; txMs: number }
): {
  db: AdminFirestoreLike;
  counts: { reads: number; queries: number; writes: number; txs: number };
  resetCounts: () => void;
} {
  const counts = { reads: 0, queries: 0, writes: 0, txs: 0 };

  const wrapDocRef = (ref: AdminDocRefLike): AdminDocRefLike => ({
    id: ref.id,
    get: async () => {
      counts.reads++;
      await delay(latencies.readMs);
      return ref.get();
    },
    set: async (data, opts) => {
      counts.writes++;
      await delay(latencies.readMs);
      return ref.set(data, opts);
    },
    update: async (data) => {
      counts.writes++;
      await delay(latencies.readMs);
      return ref.update(data);
    },
    delete: async () => {
      counts.writes++;
      await delay(latencies.readMs);
      return ref.delete();
    },
  });

  const wrapQuery = (q: AdminQueryLike): AdminQueryLike => ({
    where: (f, op, v) => wrapQuery(q.where(f, op, v)),
    orderBy: (f, dir) => wrapQuery(q.orderBy ? q.orderBy(f, dir) : q),
    limit: (n) => wrapQuery(q.limit ? q.limit(n) : q),
    get: async () => {
      counts.queries++;
      await delay(latencies.queryMs);
      return q.get();
    },
  });

  const db: AdminFirestoreLike = {
    collection: (path: string): AdminCollectionRefLike => {
      const col = inner.collection(path);
      const wrappedQ = wrapQuery(col);
      return {
        ...wrappedQ,
        doc: (id: string) => wrapDocRef(col.doc(id)),
      };
    },
    runTransaction: async <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
      counts.txs++;
      await delay(latencies.txMs);
      return inner.runTransaction(fn);
    },
  };

  return {
    db,
    counts,
    resetCounts: () => {
      counts.reads = 0;
      counts.queries = 0;
      counts.writes = 0;
      counts.txs = 0;
    },
  };
}

function wrapAuthWithLatency(inner: InMemoryAdminAuth, verifyMs: number): AdminAuthLike {
  return {
    verifyIdToken: async (token, checkRevoked) => {
      await delay(verifyMs);
      return inner.verifyIdToken(token, checkRevoked);
    },
    getUser: (uid) => inner.getUser(uid),
    getUserByEmail: (email) => inner.getUserByEmail(email),
    createUser: (props) => inner.createUser(props),
    updateUser: (uid, props) => inner.updateUser(uid, props),
    deleteUser: (uid) => inner.deleteUser(uid),
    revokeRefreshTokens: (uid) => inner.revokeRefreshTokens(uid),
    listUsers: (max) => inner.listUsers(max),
  };
}

describe('QR Punch In & Punch Out Pipeline Optimization & Compatibility Suite', () => {
  let rawDb: InMemoryFirestore;
  let rawAuth: InMemoryAdminAuth;

  beforeEach(async () => {
    rawDb = new InMemoryFirestore();
    rawAuth = new InMemoryAdminAuth();
    await seedIsolatedTestEnvironment(rawDb, rawAuth);

    await rawDb.collection('role_permissions').doc('admin').set({
      roleId: 'admin',
      roleName: 'Admin',
      modulePermissions: {
        dashboard: { view: true, add: false, edit: false, delete: false },
        scanner: { view: true, add: true, edit: true, delete: false },
        'attendance.qr.scan': { view: true, add: true, edit: false, delete: false },
        'attendance.manual.entry': { view: true, add: true, edit: false, delete: false },
        history: { view: true, add: false, edit: true, delete: false },
      },
      updatedAt: new Date().toISOString(),
      updatedBy: 'superadmin',
    });

    for (const id of ['AUU679', 'AUU680', 'AUU681']) {
      await rawDb.collection('employees').doc(id).set({
        id,
        employeeId: id,
        employeeName: `Operator ${id}`,
        employeeType: 'Permanent',
        floor: 'Line-1',
        section: 'MI',
        department: 'Production',
        designation: 'Operator',
        employeeStatus: 'Active',
        qrCodeToken: `QR_${id}_MWL01A6O_3VUKP8Y`,
      });
    }
    resetPerfMetrics();
  });

  it('preserves exact existing JSON QR format (employeeId + token), reduces warm Firestore reads to <= 4, and emits full step timings cleanly', async () => {
    const exactJsonPayload = JSON.stringify({
      employeeId: 'AUU679',
      token: 'QR_AUU679_MWL01A6O_3VUKP8Y',
    });

    // Verify parse compatibility first
    expect(parseQrPayload(exactJsonPayload)).toEqual({
      employeeId: 'AUU679',
      token: 'QR_AUU679_MWL01A6O_3VUKP8Y',
      format: 'JSON_TOKEN',
    });

    const wrapped = wrapDbWithLatency(rawDb, { readMs: 45, queryMs: 45, txMs: 65 });
    const latencyAuth = wrapAuthWithLatency(rawAuth, 30);
    const { app } = createApp({
      db: wrapped.db,
      auth: latencyAuth,
      projectId: 'narid-atdc-tracker',
      databaseId: 'ai-studio-manpowertracker-9b87a863-5c0d-4126-accb-7a3be802b10b',
      credentialMode: 'ADC',
      disableBackgroundBoot: true,
    });

    const adminToken = rawAuth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid);

    // 1. Cold Punch IN using exact production QR JSON format
    wrapped.resetCounts();
    const resColdIn = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        rawPayload: exactJsonPayload,
        scannerType: 'IN',
        scannerDevice: 'USB_SCANNER',
        customScanTime: '2026-11-18T09:00:00+05:30',
      });
    expect(resColdIn.status).toBe(200);
    expect(resColdIn.body.action).toBe('PUNCH_IN');
    expect(resColdIn.body.attendance.qrVerificationMode).toBe('TOKEN_VERIFIED');
    expect(resColdIn.body.perf.cacheHitUidRoute).toBe(false);
    expect(typeof resColdIn.body.perf.qrParseMs).toBe('number');
    expect(typeof resColdIn.body.perf.tokenValidationMs).toBe('number');
    expect(typeof resColdIn.body.perf.firestoreOpMs).toBe('number');

    // 2. Warm Punch IN on AUU680 -> uidRolePointers + prefetched user_permissions + cached config
    wrapped.resetCounts();
    const resWarmIn = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        rawPayload: JSON.stringify({
          employeeId: 'AUU680',
          token: 'QR_AUU680_MWL01A6O_3VUKP8Y',
        }),
        scannerType: 'IN',
        scannerDevice: 'WEBCAM',
        customScanTime: '2026-11-18T09:02:00+05:30',
      });
    expect(resWarmIn.status).toBe(200);
    expect(resWarmIn.body.action).toBe('PUNCH_IN');
    expect(resWarmIn.body.perf.cacheHitUidRoute).toBe(true);
    expect(resWarmIn.body.perf.cacheHitRolePerms).toBe(true);
    expect(resWarmIn.body.perf.cacheHitConfig).toBe(true);
    expect(resWarmIn.body.perf.permissionMs).toBeLessThan(15);
    expect(wrapped.counts.reads).toBeLessThanOrEqual(4);
    expect(wrapped.counts.queries).toBe(1);

    // 3. Warm Punch OUT on AUU679 -> computes exact COMPLETED + OT status
    wrapped.resetCounts();
    const resWarmOut = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        rawPayload: exactJsonPayload,
        scannerType: 'OUT',
        scannerDevice: 'USB_SCANNER',
        customScanTime: '2026-11-18T19:00:00+05:30', // 10 hours -> 510 + 90 OT
      });
    expect(resWarmOut.status).toBe(200);
    expect(resWarmOut.body.action).toBe('PUNCH_OUT');
    expect(resWarmOut.body.attendance.totalDutyMinutes).toBe(600);
    expect(resWarmOut.body.attendance.regularDutyMinutes).toBe(510);
    expect(resWarmOut.body.attendance.overtimeMinutes).toBe(90);
    expect(resWarmOut.body.attendance.attendanceStatus).toBe('COMPLETED + OT');
    expect(resWarmOut.body.perf.cacheHitUidRoute).toBe(true);
    expect(wrapped.counts.reads).toBeLessThanOrEqual(4);

    // Confirm zero QR secrets or tokens leak in perf telemetry
    const serialized = JSON.stringify(resWarmOut.body.perf);
    expect(serialized).not.toContain('QR_AUU679');
    expect(serialized).not.toContain('MWL01A6O');
    expect(serialized).not.toContain('Operator');
  });

  it('keeps live security checks active on warm UID routes (live user deactivation, account lock, permission override, token rotation)', async () => {
    const { app } = createApp({
      db: rawDb,
      auth: rawAuth,
      projectId: 'narid-atdc-tracker',
      databaseId: 'ai-studio-manpowertracker-9b87a863-5c0d-4126-accb-7a3be802b10b',
      credentialMode: 'ADC',
      disableBackgroundBoot: true,
    });
    const adminToken = rawAuth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid);

    // Warm the uidRolePointers cache with a valid Punch IN
    const warm1 = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        rawPayload: JSON.stringify({
          employeeId: 'AUU679',
          token: 'QR_AUU679_MWL01A6O_3VUKP8Y',
        }),
        scannerType: 'IN',
        customScanTime: '2026-11-18T09:00:00+05:30',
      });
    expect(warm1.status).toBe(200);

    // 1. Live QR token rotation MUST immediately reject old token (never cached!)
    await rawDb.collection('employees').doc('AUU679').update({
      qrCodeToken: 'QR_AUU679_ROTATED_NEW',
    });
    const oldTokenAttempt = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        rawPayload: JSON.stringify({
          employeeId: 'AUU679',
          token: 'QR_AUU679_MWL01A6O_3VUKP8Y',
        }),
        scannerType: 'OUT',
        customScanTime: '2026-11-18T18:00:00+05:30',
      });
    expect(oldTokenAttempt.status).toBe(403);

    // 2. Live employee deactivation MUST immediately reject scan
    await rawDb.collection('employees').doc('AUU680').update({
      employeeStatus: 'Inactive',
    });
    const inactiveEmpAttempt = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        rawPayload: JSON.stringify({
          employeeId: 'AUU680',
          token: 'QR_AUU680_MWL01A6O_3VUKP8Y',
        }),
        scannerType: 'IN',
        customScanTime: '2026-11-18T09:05:00+05:30',
      });
    expect(inactiveEmpAttempt.status).toBe(400);

    // 3. Live user_permissions revocation MUST take effect immediately on next warm request
    await rawDb.collection('user_permissions').doc('role_admin').set({
      userId: 'role_admin',
      permissions: {
        'attendance.qr.scan': { view: false, add: false, edit: false, delete: false },
      },
      updatedAt: new Date().toISOString(),
    });
    const permRevokedAttempt = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        rawPayload: JSON.stringify({
          employeeId: 'AUU681',
          token: 'QR_AUU681_MWL01A6O_3VUKP8Y',
        }),
        scannerType: 'IN',
        customScanTime: '2026-11-18T09:10:00+05:30',
      });
    expect(permRevokedAttempt.status).toBe(403);

    // 4. Live user_roles lockStatus MUST immediately reject even when uidRolePointers is hot
    await rawDb.collection('user_permissions').doc('role_admin').delete();
    await rawDb.collection('user_roles').doc('role_admin').update({
      lockStatus: 'LOCKED',
    });
    const lockedAttempt = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        rawPayload: JSON.stringify({
          employeeId: 'AUU681',
          token: 'QR_AUU681_MWL01A6O_3VUKP8Y',
        }),
        scannerType: 'IN',
        customScanTime: '2026-11-18T09:11:00+05:30',
      });
    expect(lockedAttempt.status).toBe(403);
  });

  it('tracks separate stage timings cleanly in perfMonitor without leaking tokens or PII, and preserves Manual Employee ID Entry', async () => {
    recordPerfMetric('qr_detect_ms', 12.4);
    recordPerfMetric('qr_parse_ms', 0.2);
    recordPerfMetric('qr_api_ms', 385.1);
    recordPerfMetric('qr_auth_token_ms', 77.3);
    recordPerfMetric('qr_firestore_ms', 296.2);
    recordPerfMetric('qr_punch_in_e2e_ms', 399.5);
    recordPerfMetric('qr_punch_out_e2e_ms', 392.0);

    expect(getPerfMetricStats('qr_detect_ms')?.lastMs).toBe(12.4);
    expect(getPerfMetricStats('qr_parse_ms')?.lastMs).toBe(0.2);
    expect(getPerfMetricStats('qr_api_ms')?.lastMs).toBe(385.1);
    expect(getPerfMetricStats('qr_auth_token_ms')?.lastMs).toBe(77.3);
    expect(getPerfMetricStats('qr_firestore_ms')?.lastMs).toBe(296.2);
    expect(getPerfMetricStats('qr_punch_in_e2e_ms')?.lastMs).toBe(399.5);
    expect(getPerfMetricStats('qr_punch_out_e2e_ms')?.lastMs).toBe(392.0);

    const snapshotJson = JSON.stringify(getClientPerfSnapshot());
    expect(snapshotJson).not.toMatch(/AUU679|MWL01A6O|Bearer|password|qrCodeToken/i);

    // Manual Employee ID entry continues working seamlessly
    const { app } = createApp({
      db: rawDb,
      auth: rawAuth,
      projectId: 'narid-atdc-tracker',
      databaseId: 'ai-studio-manpowertracker-9b87a863-5c0d-4126-accb-7a3be802b10b',
      credentialMode: 'ADC',
      disableBackgroundBoot: true,
    });
    const adminToken = rawAuth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid);
    const manualIn = await request(app)
      .post('/api/attendance/manual-punch')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        employeeId: 'AUU681',
        scannerType: 'IN',
        customScanTime: '2026-11-18T09:05:00+05:30',
      });
    expect(manualIn.status).toBe(200);
    expect(manualIn.body.action).toBe('PUNCH_IN');
    expect(manualIn.body.perf.cacheHitUidRoute).toBe(false);
    expect(typeof manualIn.body.perf.firestoreOpMs).toBe('number');
    expect(typeof manualIn.body.perf.auditMs).toBe('number');
    expect(typeof manualIn.body.perf.employeeLookupMs).toBe('number');
    expect(typeof manualIn.body.perf.attendanceLookupMs).toBe('number');
  });

  it('overlaps post-token employee+attendance+config reads with caller lookup to eliminate 1 full Firestore RTT and emits all granular stage timings', async () => {
    const wrapped = wrapDbWithLatency(rawDb, { readMs: 90, queryMs: 90, txMs: 40 });
    const latencyAuth = wrapAuthWithLatency(rawAuth, 40);
    const { app } = createApp({
      db: wrapped.db,
      auth: latencyAuth,
      projectId: 'narid-atdc-tracker',
      databaseId: 'ai-studio-manpowertracker-9b87a863-5c0d-4126-accb-7a3be802b10b',
      credentialMode: 'ADC',
      disableBackgroundBoot: true,
    });
    const adminToken = rawAuth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid);

    // Cold scan warms uid pointer, role_permissions, shifts, settings
    const coldRes = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        rawPayload: JSON.stringify({
          employeeId: 'AUU679',
          token: 'QR_AUU679_MWL01A6O_3VUKP8Y',
        }),
        scannerType: 'IN',
        scannerDevice: 'USB_SCANNER',
        customScanTime: '2026-11-18T09:00:00+05:30',
      });
    expect(coldRes.status).toBe(200);
    expect(coldRes.body.perf.parallelPrefetchUsed).toBe(true);
    // Cold role_permissions was prefetched inside caller lookup, so permissionMs is near 0ms
    expect(coldRes.body.perf.permissionMs).toBeLessThan(25);

    // Warm scan: employees + attendance run in parallel with user_roles + user_permissions (90ms RTT)
    wrapped.resetCounts();
    const warmRes = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        rawPayload: JSON.stringify({
          employeeId: 'AUU680',
          token: 'QR_AUU680_MWL01A6O_3VUKP8Y',
        }),
        scannerType: 'IN',
        scannerDevice: 'USB_SCANNER',
        customScanTime: '2026-11-18T09:05:00+05:30',
      });

    expect(warmRes.status).toBe(200);
    const p = warmRes.body.perf;
    expect(p.parallelPrefetchUsed).toBe(true);
    expect(p.tokenVerifyMs).toBeGreaterThanOrEqual(30);
    expect(p.callerLookupMs).toBeGreaterThanOrEqual(75);
    expect(p.employeeLookupMs).toBeGreaterThanOrEqual(75);
    expect(p.attendanceLookupMs).toBeGreaterThanOrEqual(75);
    expect(typeof p.configLookupMs).toBe('number');
    expect(typeof p.txMs).toBe('number');
    expect(p.auditMs).toBe(0);
    expect(typeof p.totalServerMs).toBe('number');
    expect(p.firestoreReads).toBeLessThanOrEqual(5);
    expect(p.firestoreWrites).toBe(3);
    // Because employee+attendance overlapped with callerLookup (90ms), post-auth lookup wait is near 0ms (< 30ms instead of ~90ms!)
    expect(p.lookupAndQueryMs).toBeLessThan(30);
    expect(p.permissionMs).toBeLessThan(20);
  });

  it('performs zero Firestore reads on invalid or revoked Firebase ID tokens (401) and fails closed on missing QR permission (403)', async () => {
    const wrapped = wrapDbWithLatency(rawDb, { readMs: 10, queryMs: 10, txMs: 10 });
    const { app } = createApp({
      db: wrapped.db,
      auth: rawAuth,
      projectId: 'narid-atdc-tracker',
      databaseId: 'ai-studio-manpowertracker-9b87a863-5c0d-4126-accb-7a3be802b10b',
      credentialMode: 'ADC',
      disableBackgroundBoot: true,
    });

    // 1. Invalid token -> 401 with zero Firestore reads or queries
    wrapped.resetCounts();
    const invalidRes = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', 'Bearer invalid-token-xyz')
      .send({
        rawPayload: JSON.stringify({
          employeeId: 'AUU679',
          token: 'QR_AUU679_MWL01A6O_3VUKP8Y',
        }),
        scannerType: 'IN',
      });
    expect(invalidRes.status).toBe(401);
    expect(wrapped.counts.reads).toBe(0);
    expect(wrapped.counts.queries).toBe(0);

    // 2. Revoked token -> verifyIdToken(token, true) rejects with 401 and zero Firestore reads
    const revokedToken = rawAuth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid);
    await rawAuth.revokeRefreshTokens(TEST_CANONICAL_ACCOUNTS.admin.uid);
    wrapped.resetCounts();
    const revokedRes = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${revokedToken}`)
      .send({
        rawPayload: JSON.stringify({
          employeeId: 'AUU679',
          token: 'QR_AUU679_MWL01A6O_3VUKP8Y',
        }),
        scannerType: 'IN',
      });
    expect(revokedRes.status).toBe(401);
    expect(wrapped.counts.reads).toBe(0);
    expect(wrapped.counts.queries).toBe(0);

    // 3. Authenticated user without attendance.qr.scan -> 403 and no employee/attendance returned
    await rawDb.collection('user_permissions').doc('role_user').set({
      userId: 'role_user',
      isCustomOverride: true,
      permissions: {
        'attendance.qr.scan': { view: false, add: false, edit: false, delete: false },
        scanner: { view: false, add: false, edit: false, delete: false },
      },
      updatedAt: new Date().toISOString(),
    });
    const userToken = rawAuth.issueToken(TEST_CANONICAL_ACCOUNTS.user.uid);
    const forbiddenRes = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        rawPayload: JSON.stringify({
          employeeId: 'AUU679',
          token: 'QR_AUU679_MWL01A6O_3VUKP8Y',
        }),
        scannerType: 'IN',
      });
    expect(forbiddenRes.status).toBe(403);
    expect(forbiddenRes.body.employee).toBeUndefined();
    expect(forbiddenRes.body.attendance).toBeUndefined();
  });

  it('prevents stale prefetched attendance reads under concurrent same-employee burst scans (duplicate IN rejected)', async () => {
    const wrapped = wrapDbWithLatency(rawDb, { readMs: 25, queryMs: 25, txMs: 30 });
    const { app } = createApp({
      db: wrapped.db,
      auth: rawAuth,
      projectId: 'narid-atdc-tracker',
      databaseId: 'ai-studio-manpowertracker-9b87a863-5c0d-4126-accb-7a3be802b10b',
      credentialMode: 'ADC',
      disableBackgroundBoot: true,
    });
    const adminToken = rawAuth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid);
    const payload = JSON.stringify({
      employeeId: 'AUU681',
      token: 'QR_AUU681_MWL01A6O_3VUKP8Y',
    });

    // Fire two concurrent Punch IN scans for the same employee with different clientRequestIds
    const [r1, r2] = await Promise.all([
      request(app)
        .post('/api/attendance/scan')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          rawPayload: payload,
          scannerType: 'IN',
          scannerDevice: 'USB_SCANNER',
          clientRequestId: 'burst_req_1',
          customScanTime: '2026-11-18T09:00:00+05:30',
        }),
      request(app)
        .post('/api/attendance/scan')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          rawPayload: payload,
          scannerType: 'IN',
          scannerDevice: 'USB_SCANNER',
          clientRequestId: 'burst_req_2',
          customScanTime: '2026-11-18T09:00:05+05:30',
        }),
    ]);

    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);
    const winner = r1.status === 200 ? r1 : r2;
    const rejected = r1.status === 409 ? r1 : r2;
    expect(winner.body.action).toBe('PUNCH_IN');
    expect(rejected.body.action).toBe('REJECTED_DUPLICATE');
    // The 2nd scan waited on the employee mutex and refreshed attendance state instead of trusting stale prefetch
    expect(rejected.body.perf.parallelPrefetchUsed).toBe(false);
  });

  it('invalidates cached shift config immediately when shifts are updated via /api/masters/bulk-status', async () => {
    const { app } = createApp({
      db: rawDb,
      auth: rawAuth,
      projectId: 'narid-atdc-tracker',
      databaseId: 'ai-studio-manpowertracker-9b87a863-5c0d-4126-accb-7a3be802b10b',
      credentialMode: 'ADC',
      disableBackgroundBoot: true,
    });
    const superToken = rawAuth.issueToken(TEST_CANONICAL_ACCOUNTS.superadmin.uid);

    // Warm shift cache with first scan
    const s1 = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${superToken}`)
      .send({
        rawPayload: JSON.stringify({
          employeeId: 'AUU679',
          token: 'QR_AUU679_MWL01A6O_3VUKP8Y',
        }),
        scannerType: 'IN',
        customScanTime: '2026-11-18T09:00:00+05:30',
      });
    expect(s1.status).toBe(200);

    // Second scan hits warm shift cache
    const s2 = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${superToken}`)
      .send({
        rawPayload: JSON.stringify({
          employeeId: 'AUU680',
          token: 'QR_AUU680_MWL01A6O_3VUKP8Y',
        }),
        scannerType: 'IN',
        customScanTime: '2026-11-18T09:01:00+05:30',
      });
    expect(s2.status).toBe(200);
    expect(s2.body.perf.cacheHitConfig).toBe(true);

    // Update shift via master bulk-status API -> invalidates shifts cache
    const updateRes = await request(app)
      .post('/api/masters/bulk-status')
      .set('Authorization', `Bearer ${superToken}`)
      .send({
        resource: 'shifts',
        status: 'Inactive',
        ids: ['NIGHT'],
        confirmed: true,
      });
    expect(updateRes.status).toBe(200);

    // Next scan MUST re-fetch fresh shift config (cacheHitConfig === false)
    const s3 = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${superToken}`)
      .send({
        rawPayload: JSON.stringify({
          employeeId: 'AUU681',
          token: 'QR_AUU681_MWL01A6O_3VUKP8Y',
        }),
        scannerType: 'IN',
        customScanTime: '2026-11-18T09:02:00+05:30',
      });
    expect(s3.status).toBe(200);
    expect(s3.body.perf.cacheHitConfig).toBe(false);
  });
});
