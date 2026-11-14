import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../server.ts';
import {
  InMemoryAdminAuth,
  InMemoryFirestore,
  TEST_CANONICAL_ACCOUNTS,
  seedIsolatedTestEnvironment,
} from './helpers/inMemoryAdmin.ts';

describe('Server-Side Attendance Engine, Concurrent 3-Strike Lockout & Persistent IP Rate Limiting', () => {
  let db: InMemoryFirestore;
  let auth: InMemoryAdminAuth;
  let app: ReturnType<typeof createApp>['app'];

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
  });

  it('processes authenticated IN -> duplicate IN rejection -> OUT with duty & OT calculation', async () => {
    const adminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid);
    const punchInIso = '2026-11-14T09:05:00+05:30';
    const punchOutIso = '2026-11-14T19:05:00+05:30'; // 10h = 600 mins => 510 regular + 90 OT

    // 1. Valid First Punch IN
    const inRes = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        rawPayload: 'QR_EMP001_VALID',
        scannerType: 'IN',
        scannerDevice: 'USB_SCANNER',
        customScanTime: punchInIso,
      });

    expect(inRes.status).toBe(200);
    expect(inRes.body.success).toBe(true);
    expect(inRes.body.action).toBe('PUNCH_IN');
    expect(inRes.body.currentState).toBe('INSIDE');
    expect(inRes.body.attendance.firstPunchIn).toBeTruthy();

    // 2. Duplicate Consecutive Punch IN MUST be rejected cleanly (409)
    const dupInRes = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        rawPayload: 'QR_EMP001_VALID',
        scannerType: 'IN',
        scannerDevice: 'USB_SCANNER',
        customScanTime: '2026-11-14T10:00:00+05:30',
      });

    expect(dupInRes.status).toBe(409);
    expect(dupInRes.body.success).toBe(false);
    expect(dupInRes.body.action).toBe('REJECTED_DUPLICATE');

    // 3. Valid Punch OUT calculates duty & OT accurately
    const outRes = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        rawPayload: 'QR_EMP001_VALID',
        scannerType: 'OUT',
        scannerDevice: 'USB_SCANNER',
        customScanTime: punchOutIso,
      });

    expect(outRes.status).toBe(200);
    expect(outRes.body.success).toBe(true);
    expect(outRes.body.action).toBe('PUNCH_OUT');
    expect(outRes.body.currentState).toBe('OUTSIDE');
    expect(outRes.body.attendance.totalDutyMinutes).toBe(600);
    expect(outRes.body.attendance.regularDutyMinutes).toBe(510);
    expect(outRes.body.attendance.overtimeMinutes).toBe(90);

    // 4. Duplicate Consecutive Punch OUT MUST be rejected (409)
    const dupOutRes = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        rawPayload: 'QR_EMP001_VALID',
        scannerType: 'OUT',
        scannerDevice: 'USB_SCANNER',
        customScanTime: '2026-11-14T19:15:00+05:30',
      });

    expect(dupOutRes.status).toBe(409);
    expect(dupOutRes.body.success).toBe(false);
    expect(dupOutRes.body.action).toBe('REJECTED_DUPLICATE');
  });

  it('rejects inactive employees, expired QR tokens, customScanTime from USER role, and unauthorized scanner users', async () => {
    const adminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid);
    const userToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.user.uid);

    // Inactive employee rejected
    const inactiveRes = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        rawPayload: 'QR_EMP002_INACTIVE',
        scannerType: 'IN',
        customScanTime: '2026-11-14T09:00:00+05:30',
      });
    expect(inactiveRes.status).toBe(400);
    expect(inactiveRes.body.success).toBe(false);
    expect(inactiveRes.body.action).toBe('REJECTED');

    // Tampered QR token rejected with 403
    const badTokenRes = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        rawPayload: 'QR_EMP001_REVOKED_OLD',
        scannerType: 'IN',
        customScanTime: '2026-11-14T09:00:00+05:30',
      });
    expect(badTokenRes.status).toBe(403);
    expect(badTokenRes.body.success).toBe(false);

    // USER role cannot spoof customScanTime (403)
    const spoofTimeRes = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        rawPayload: 'QR_EMP001_VALID',
        scannerType: 'IN',
        customScanTime: '2026-11-14T09:00:00+05:30',
      });
    expect(spoofTimeRes.status).toBe(403);

    // USER role without scanner permission blocked with 403
    await db.collection('user_roles').doc('role_user').update({
      modulesAllowed: ['dashboard'],
    });
    const deniedUserRes = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        rawPayload: 'QR_EMP001_VALID',
        scannerType: 'IN',
      });
    expect(deniedUserRes.status).toBe(403);
  });

  it('auto-closes expired open shifts with strictly zero overtime and restricts admin attendance routes from USER', async () => {
    const adminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid);
    const userToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.user.uid);

    // Create an open DAY shift record from an earlier date
    const inPastRes = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        rawPayload: 'QR_EMP001_VALID',
        scannerType: 'IN',
        customScanTime: '2025-05-01T09:00:00+05:30',
      });
    expect(inPastRes.status).toBe(200);
    const attId = inPastRes.body.attendance.id;

    // USER blocked from auto-close, correct, clear
    const userAutoClose = await request(app)
      .post('/api/attendance/auto-close')
      .set('Authorization', `Bearer ${userToken}`)
      .send({});
    expect(userAutoClose.status).toBe(403);

    const userCorrect = await request(app)
      .post('/api/attendance/correct')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        attendanceId: attId,
        punchOutType: 'ACTUAL',
        attendanceStatus: 'COMPLETED',
        reason: 'Unauthorized edit',
      });
    expect(userCorrect.status).toBe(403);

    const userClear = await request(app)
      .post('/api/attendance/clear')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ confirmed: true });
    expect(userClear.status).toBe(403);

    // ADMIN executes auto-close -> closed with overtimeMinutes === 0 & punchOutType === 'AUTO'
    const autoCloseRes = await request(app)
      .post('/api/attendance/auto-close')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(autoCloseRes.status).toBe(200);
    expect(autoCloseRes.body.closedCount).toBe(1);
    expect(autoCloseRes.body.closedRecords[0].punchOutType).toBe('AUTO');
    expect(autoCloseRes.body.closedRecords[0].overtimeMinutes).toBe(0);
    expect(autoCloseRes.body.closedRecords[0].missedPunchOut).toBe(true);
  });

  it('enforces atomic 3-strike account lockout under concurrent burst attempts and persists IP cooldown across app instances', async () => {
    // Launch 5 concurrent wrong-password attempts from different forwarded IPs to test per-LoginId atomic lock
    const burst = Array.from({ length: 5 }, (_, idx) =>
      request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', `198.51.100.${10 + idx}`)
        .send({ loginId: 'admin', password: 'WrongPassword#999' })
    );
    const responses = await Promise.all(burst);

    const lockedResponses = responses.filter((r) => r.status === 423);
    expect(lockedResponses.length).toBeGreaterThanOrEqual(2);

    const secSnap = await db.collection('account_security').doc('sec_admin').get();
    expect(secSnap.data()?.lockStatus).toBe('LOCKED');
    expect(secSnap.data()?.consecutiveFailedAttempts).toBe(3);

    // Even the correct password must be blocked once LOCKED
    const correctWhileLocked = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', '198.51.100.99')
      .send({ loginId: 'admin', password: TEST_CANONICAL_ACCOUNTS.admin.password });
    expect(correctWhileLocked.status).toBe(423);
    expect(correctWhileLocked.body.locked).toBe(true);

    // Trigger IP progressive cooldown threshold (10 unknown-account probes from a single IP)
    const attackerIp = '203.0.113.77';
    for (let i = 0; i < 10; i++) {
      await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', attackerIp)
        .send({ loginId: `unknown_probe_${i}`, password: `BadPass#${i}` });
    }

    // Spin up a brand-new Express app instance sharing the SAME Firestore db (simulates Cloud Run cold start / new instance)
    const freshApp = createApp({
      db,
      auth,
      projectId: 'narid-atdc-tracker',
      databaseId: 'ai-studio-manpowertracker-9b87a863-5c0d-4126-accb-7a3be802b10b',
      credentialMode: 'ADC',
      disableBackgroundBoot: true,
    }).app;

    const blockedOnFreshInstance = await request(freshApp)
      .post('/api/auth/login')
      .set('X-Forwarded-For', attackerIp)
      .send({ loginId: 'superadmin', password: TEST_CANONICAL_ACCOUNTS.superadmin.password });

    expect(blockedOnFreshInstance.status).toBe(429);
    expect(blockedOnFreshInstance.body.code).toBe('RATE_LIMITED');
  });

  it('rejects missing QR tokens when qrCodeToken is set, fails closed on scanner permission errors, and blocks production wipes', async () => {
    const adminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid);
    const superToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.superadmin.uid);
    const userToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.user.uid);

    // 1. Raw Employee ID without token must be rejected when employee has qrCodeToken configured
    const missingTokenRes = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        rawPayload: 'EMP001',
        scannerType: 'IN',
        customScanTime: '2026-11-14T09:05:00+05:30',
      });
    expect(missingTokenRes.status).toBe(403);
    expect(missingTokenRes.body.success).toBe(false);

    // 2. Empty modulesAllowed on user_roles must fail closed (403)
    await db.collection('user_roles').doc('role_user').update({
      modulesAllowed: [],
    });
    const emptyModulesRes = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        rawPayload: 'QR_EMP001_VALID',
        scannerType: 'IN',
      });
    expect(emptyModulesRes.status).toBe(403);

    // 3. Production attendance clear must be blocked unless ALLOW_ATTENDANCE_CLEAR=true
    const prevEnv = process.env.NODE_ENV;
    const prevAllow = process.env.ALLOW_ATTENDANCE_CLEAR;
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.ALLOW_ATTENDANCE_CLEAR;

      const blockedProdClear = await request(app)
        .post('/api/attendance/clear')
        .set('Authorization', `Bearer ${superToken}`)
        .send({ confirmed: true, confirmPhrase: 'CLEAR_ALL_ATTENDANCE' });
      expect(blockedProdClear.status).toBe(403);
      expect(blockedProdClear.body.code).toBe('PRODUCTION_WIPE_BLOCKED');

      // Missing confirmPhrase must fail validation (400) even when allowed
      process.env.ALLOW_ATTENDANCE_CLEAR = 'true';
      const missingPhraseClear = await request(app)
        .post('/api/attendance/clear')
        .set('Authorization', `Bearer ${superToken}`)
        .send({ confirmed: true });
      expect(missingPhraseClear.status).toBe(400);
    } finally {
      process.env.NODE_ENV = prevEnv;
      if (prevAllow === undefined) {
        delete process.env.ALLOW_ATTENDANCE_CLEAR;
      } else {
        process.env.ALLOW_ATTENDANCE_CLEAR = prevAllow;
      }
    }
  });

  it('enforces atomic attendance scan transactions under parallel concurrent IN and OUT bursts', async () => {
    const adminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid);

    // 5 simultaneous IN scans for EMP001 -> strictly 1 succeeds (200), 4 fail (409/429)
    const parallelIn = Array.from({ length: 5 }, () =>
      request(app)
        .post('/api/attendance/scan')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          rawPayload: 'QR_EMP001_VALID',
          scannerType: 'IN',
          scannerDevice: 'USB_SCANNER',
          customScanTime: '2026-11-15T09:05:00+05:30',
        })
    );
    const inResults = await Promise.all(parallelIn);
    const inSuccess = inResults.filter((r) => r.status === 200);
    const inRejected = inResults.filter((r) => r.status === 409 || r.status === 429);

    expect(inSuccess.length).toBe(1);
    expect(inRejected.length).toBe(4);
    expect(inSuccess[0].body.attendance.punches.length).toBe(1);

    // 5 simultaneous OUT scans for EMP001 -> strictly 1 succeeds (200), 4 fail (409/429)
    const parallelOut = Array.from({ length: 5 }, () =>
      request(app)
        .post('/api/attendance/scan')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          rawPayload: 'QR_EMP001_VALID',
          scannerType: 'OUT',
          scannerDevice: 'USB_SCANNER',
          customScanTime: '2026-11-15T18:05:00+05:30',
        })
    );
    const outResults = await Promise.all(parallelOut);
    const outSuccess = outResults.filter((r) => r.status === 200);
    const outRejected = outResults.filter((r) => r.status === 409 || r.status === 429);

    expect(outSuccess.length).toBe(1);
    expect(outRejected.length).toBe(4);
    expect(outSuccess[0].body.attendance.punches.length).toBe(2);
    expect(outSuccess[0].body.attendance.currentState).toBe('OUTSIDE');
  });
});
