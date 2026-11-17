import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../server.ts';
import { resolveScannerCapabilities } from '../src/services/permissionService.ts';
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

  it('rejects missing QR tokens strictly on /api/attendance/scan, fails closed on scanner permission errors, and blocks production wipes', async () => {
    const adminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid);
    const superToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.superadmin.uid);
    const userToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.user.uid);

    // 1. Structured JSON QR payload without token must be rejected when employee has qrCodeToken configured
    const missingJsonTokenRes = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        rawPayload: JSON.stringify({ employeeId: 'EMP001' }),
        scannerType: 'IN',
        customScanTime: '2026-11-14T09:05:00+05:30',
      });
    expect(missingJsonTokenRes.status).toBe(403);
    expect(missingJsonTokenRes.body.success).toBe(false);
    expect(missingJsonTokenRes.body.message).toContain('Security token is required');

    // 1b. Plain untokenized Employee ID submitted to QR scan endpoint MUST be rejected (403)
    const plainIdOnQrEndpointRes = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        rawPayload: 'EMP001',
        scannerType: 'IN',
        customScanTime: '2026-11-14T09:05:00+05:30',
      });
    expect(plainIdOnQrEndpointRes.status).toBe(403);
    expect(plainIdOnQrEndpointRes.body.success).toBe(false);
    expect(plainIdOnQrEndpointRes.body.message).toContain('Security token is required');

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

  describe('Independent Secure QR Scan & Authorized Manual Employee ID Entry Suites', () => {
    it('keeps secure JSON and token-string QR scanning strict and rejects untokenized IDs or invalid tokens on /api/attendance/scan', async () => {
      const adminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid);

      await db.collection('employees').doc('MSI1335').set({
        id: 'MSI1335',
        employeeId: 'MSI1335',
        employeeName: 'ANIL KUMAR',
        employeeType: 'Offroll',
        floor: 'MI-02',
        section: 'MI',
        department: 'Production',
        designation: 'Operator',
        employeeStatus: 'Active',
        qrCodeToken: 'QR_MSI1335_AUTH',
      });

      // Plain Employee ID submitted to QR scan endpoint MUST stay rejected (403)
      const untokenizedQrRes = await request(app)
        .post('/api/attendance/scan')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          rawPayload: 'MSI1335',
          scannerType: 'IN',
          customScanTime: '2026-11-17T09:00:00+05:30',
        });
      expect(untokenizedQrRes.status).toBe(403);
      expect(untokenizedQrRes.body.success).toBe(false);
      expect(untokenizedQrRes.body.message).toBe(
        'Invalid QR Payload: Security token is required for this employee.'
      );

      // Valid secure JSON QR payload works end-to-end (IN -> OUT)
      const secureJsonIn = await request(app)
        .post('/api/attendance/scan')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          rawPayload: JSON.stringify({ employeeId: 'MSI1335', token: 'QR_MSI1335_AUTH' }),
          scannerType: 'IN',
          scannerDevice: 'WEBCAM',
          customScanTime: '2026-11-17T09:00:00+05:30',
        });
      expect(secureJsonIn.status).toBe(200);
      expect(secureJsonIn.body.success).toBe(true);
      expect(secureJsonIn.body.action).toBe('PUNCH_IN');
      expect(secureJsonIn.body.attendance.qrVerificationMode).toBe('TOKEN_VERIFIED');

      // Secure token-string QR payload works for Punch Out
      const secureTokenOut = await request(app)
        .post('/api/attendance/scan')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          rawPayload: 'QR_MSI1335_AUTH',
          scannerType: 'OUT',
          scannerDevice: 'USB_SCANNER',
          customScanTime: '2026-11-17T18:00:00+05:30',
        });
      expect(secureTokenOut.status).toBe(200);
      expect(secureTokenOut.body.success).toBe(true);
      expect(secureTokenOut.body.action).toBe('PUNCH_OUT');
      expect(secureTokenOut.body.attendance.totalDutyMinutes).toBe(540);
      expect(secureTokenOut.body.attendance.overtimeMinutes).toBe(30);

      // Unknown Employee ID on QR scan (404)
      const unknownQrRes = await request(app)
        .post('/api/attendance/scan')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          rawPayload: 'UNKNOWN999',
          scannerType: 'IN',
          customScanTime: '2026-11-17T09:00:00+05:30',
        });
      expect(unknownQrRes.status).toBe(404);
      expect(unknownQrRes.body.success).toBe(false);

      // Invalid QR payloads -> 400
      for (const badPayload of ['{broken-json', '{}', '../admin', 'EMP 001!', 'https://evil.test/EMP001', 'QR_']) {
        const invalidRes = await request(app)
          .post('/api/attendance/scan')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({
            rawPayload: badPayload,
            scannerType: 'IN',
            customScanTime: '2026-11-17T09:00:00+05:30',
          });
        expect(invalidRes.status).toBe(400);
        expect(invalidRes.body.success).toBe(false);
        expect(invalidRes.body.action).toBe('REJECTED');
      }

      // Missing/empty or revoked token -> 403
      const emptyTokenJson = await request(app)
        .post('/api/attendance/scan')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          rawPayload: JSON.stringify({ employeeId: 'EMP001', token: '' }),
          scannerType: 'IN',
          customScanTime: '2026-11-17T09:00:00+05:30',
        });
      expect(emptyTokenJson.status).toBe(403);

      const truncatedTokenRes = await request(app)
        .post('/api/attendance/scan')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          rawPayload: 'QR_EMP001',
          scannerType: 'IN',
          customScanTime: '2026-11-17T09:00:00+05:30',
        });
      expect(truncatedTokenRes.status).toBe(403);

      const revokedTokenRes = await request(app)
        .post('/api/attendance/scan')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          rawPayload: JSON.stringify({ employeeId: 'EMP001', token: 'QR_EMP001_REVOKED' }),
          scannerType: 'IN',
          customScanTime: '2026-11-17T09:00:00+05:30',
        });
      expect(revokedTokenRes.status).toBe(403);
    });

    it('processes authorized manual Employee ID Punch In/Out only when attendance.manual.entry is granted, enforcing RBAC, OT rules, and audit logging', async () => {
      const superAdminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.superadmin.uid);
      const adminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid);
      const userToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.user.uid);

      await db.collection('employees').doc('MSI1335').set({
        id: 'MSI1335',
        employeeId: 'MSI1335',
        employeeName: 'ANIL KUMAR',
        employeeType: 'Offroll',
        floor: 'MI-02',
        section: 'MI',
        department: 'Production',
        designation: 'Operator',
        employeeStatus: 'Active',
        qrCodeToken: 'QR_MSI1335_AUTH',
      });

      // 1. Unauthenticated request blocked (401)
      const unauthRes = await request(app)
        .post('/api/attendance/manual-punch')
        .send({ employeeId: 'MSI1335', scannerType: 'IN' });
      expect(unauthRes.status).toBe(401);

      // 2. Deny-by-default: Built-in admin and user WITHOUT attendance.manual.entry are blocked (403)
      const defaultAdminManualRes = await request(app)
        .post('/api/attendance/manual-punch')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ employeeId: 'MSI1335', scannerType: 'IN' });
      expect(defaultAdminManualRes.status).toBe(403);
      expect(defaultAdminManualRes.body.error).toContain('attendance.manual.entry');

      const defaultUserManualRes = await request(app)
        .post('/api/attendance/manual-punch')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ employeeId: 'MSI1335', scannerType: 'IN' });
      expect(defaultUserManualRes.status).toBe(403);
      expect(defaultUserManualRes.body.error).toContain('attendance.manual.entry');

      // Grant attendance.manual.entry to admin role & user role via Role Permissions API
      const grantAdminRes = await request(app)
        .post('/api/admin/role-permissions')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          roleId: 'admin',
          modulePermissions: {
            scanner: { view: true, add: true, edit: true, delete: false },
            'attendance.manual.entry': { view: true, add: true, edit: false, delete: false },
            history: { view: true, add: false, edit: true, delete: false },
          },
        });
      expect(grantAdminRes.status).toBe(200);

      const grantUserRes = await request(app)
        .post('/api/admin/role-permissions')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          roleId: 'user',
          modulePermissions: {
            scanner: { view: true, add: true, edit: false, delete: false },
            'attendance.manual.entry': { view: true, add: true, edit: false, delete: false },
          },
        });
      expect(grantUserRes.status).toBe(200);

      // 3. USER role without scanner.edit/history.edit cannot spoof customScanTime (403)
      const spoofTimeRes = await request(app)
        .post('/api/attendance/manual-punch')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          employeeId: 'MSI1335',
          scannerType: 'IN',
          customScanTime: '2026-11-17T09:00:00+05:30',
        });
      expect(spoofTimeRes.status).toBe(403);

      // 4. Invalid Employee ID format (400) & Unknown Employee ID (404)
      const badFormatRes = await request(app)
        .post('/api/attendance/manual-punch')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ employeeId: 'BAD ID!', scannerType: 'IN' });
      expect(badFormatRes.status).toBe(400);

      const unknownRes = await request(app)
        .post('/api/attendance/manual-punch')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ employeeId: 'UNKNOWN999', scannerType: 'IN' });
      expect(unknownRes.status).toBe(404);
      expect(unknownRes.body.error).toContain('UNKNOWN999');

      // 5. Inactive employee rejected (400)
      const inactiveRes = await request(app)
        .post('/api/attendance/manual-punch')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ employeeId: 'EMP002', scannerType: 'IN' });
      expect(inactiveRes.status).toBe(400);
      expect(inactiveRes.body.success).toBe(false);

      // 6. Manual Punch Out without open Punch In rejected (400)
      const earlyOutRes = await request(app)
        .post('/api/attendance/manual-punch')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          employeeId: 'MSI1335',
          scannerType: 'OUT',
          customScanTime: '2026-11-17T09:05:00+05:30',
        });
      expect(earlyOutRes.status).toBe(400);
      expect(earlyOutRes.body.action).toBe('REJECTED');

      // 7. Authorized Manual Punch In with lowercase + padded Employee ID succeeds (200)
      const manualInRes = await request(app)
        .post('/api/attendance/manual-punch')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          employeeId: '  msi1335  ',
          scannerType: 'IN',
          customScanTime: '2026-11-17T09:05:00+05:30',
        });
      expect(manualInRes.status).toBe(200);
      expect(manualInRes.body.success).toBe(true);
      expect(manualInRes.body.action).toBe('PUNCH_IN');
      expect(manualInRes.body.currentState).toBe('INSIDE');
      expect(manualInRes.body.employee.employeeId).toBe('MSI1335');
      expect(manualInRes.body.attendance.qrVerificationMode).toBe('MANUAL_EMPLOYEE_ID');

      // Audit log recorded for MANUAL_ATTENDANCE_PUNCH
      const auditSnap = await db.collection('audit_logs').where('action', '==', 'MANUAL_ATTENDANCE_PUNCH').get();
      expect(auditSnap.size).toBe(1);
      expect(auditSnap.docs[0].data()?.employeeId).toBe('MSI1335');

      // 8. Duplicate consecutive Manual Punch In rejected (409)
      const dupInRes = await request(app)
        .post('/api/attendance/manual-punch')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          employeeId: 'MSI1335',
          scannerType: 'IN',
          customScanTime: '2026-11-17T09:30:00+05:30',
        });
      expect(dupInRes.status).toBe(409);
      expect(dupInRes.body.action).toBe('REJECTED_DUPLICATE');

      // 9. Valid Manual Punch Out calculates duty & OT accurately (10h -> 510 regular + 90 OT)
      const manualOutRes = await request(app)
        .post('/api/attendance/manual-punch')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          employeeId: 'MSI1335',
          scannerType: 'OUT',
          customScanTime: '2026-11-17T19:05:00+05:30',
        });
      expect(manualOutRes.status).toBe(200);
      expect(manualOutRes.body.success).toBe(true);
      expect(manualOutRes.body.action).toBe('PUNCH_OUT');
      expect(manualOutRes.body.currentState).toBe('OUTSIDE');
      expect(manualOutRes.body.attendance.totalDutyMinutes).toBe(600);
      expect(manualOutRes.body.attendance.regularDutyMinutes).toBe(510);
      expect(manualOutRes.body.attendance.overtimeMinutes).toBe(90);

      // 10. Mixed workflow works seamlessly when both permissions are granted: QR Punch In -> Manual Punch Out
      const qrInRes = await request(app)
        .post('/api/attendance/scan')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          rawPayload: JSON.stringify({ employeeId: 'EMP001', token: 'QR_EMP001_VALID' }),
          scannerType: 'IN',
          customScanTime: new Date(Date.now() - 10_000).toISOString(),
        });
      expect(qrInRes.status).toBe(200);

      const userManualOutRes = await request(app)
        .post('/api/attendance/manual-punch')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          employeeId: 'EMP001',
          scannerType: 'OUT',
        });
      expect(userManualOutRes.status).toBe(200);
      expect(userManualOutRes.body.action).toBe('PUNCH_OUT');
    });

    it('enforces independent attendance.qr.scan & attendance.manual.entry permissions across all 8 RBAC cases, IN/OUT punches, and user overrides', async () => {
      const superAdminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.superadmin.uid);
      const adminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid);
      const userToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.user.uid);

      // Additional employees so real-time user IN & OUT tests do not hit the 5-second rapid-tap debounce on the same ID
      await db.collection('employees').doc('EMP003').set({
        id: 'EMP003',
        employeeId: 'EMP003',
        employeeName: 'EMP THREE',
        employeeType: 'Onroll',
        floor: 'MI-01',
        section: 'MI',
        department: 'Production',
        designation: 'Operator',
        employeeStatus: 'Active',
        qrCodeToken: 'QR_EMP003_VALID',
      });
      await db.collection('employees').doc('EMP004').set({
        id: 'EMP004',
        employeeId: 'EMP004',
        employeeName: 'EMP FOUR',
        employeeType: 'Onroll',
        floor: 'MI-01',
        section: 'MI',
        department: 'Production',
        designation: 'Operator',
        employeeStatus: 'Active',
        qrCodeToken: 'QR_EMP004_VALID',
      });
      await db.collection('employees').doc('EMP005').set({
        id: 'EMP005',
        employeeId: 'EMP005',
        employeeName: 'EMP FIVE',
        employeeType: 'Onroll',
        floor: 'MI-01',
        section: 'MI',
        department: 'Production',
        designation: 'Operator',
        employeeStatus: 'Active',
        qrCodeToken: 'QR_EMP005_VALID',
      });
      await db.collection('employees').doc('MSI1335').set({
        id: 'MSI1335',
        employeeId: 'MSI1335',
        employeeName: 'ANIL KUMAR',
        employeeType: 'Offroll',
        floor: 'MI-02',
        section: 'MI',
        department: 'Production',
        designation: 'Operator',
        employeeStatus: 'Active',
        qrCodeToken: 'QR_MSI1335_AUTH',
      });
      await db.collection('employees').doc('EMP_LEGACY_NP').set({
        id: 'EMP_LEGACY_NP',
        employeeId: 'EMP_LEGACY_NP',
        employeeName: 'LEGACY EMP',
        employeeType: 'Offroll',
        floor: 'MI-01',
        section: 'MI',
        department: 'Production',
        designation: 'Operator',
        employeeStatus: 'Active',
        qrCodeToken: '',
      });

      // Pre-punch EMP003 and EMP004 IN 2 hours ago via Admin so User OUT punches have open shifts cleanly
      const twoHoursAgoIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      await request(app)
        .post('/api/attendance/scan')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ rawPayload: 'QR_EMP003_VALID', scannerType: 'IN', customScanTime: twoHoursAgoIso });
      await request(app)
        .post('/api/attendance/scan')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ rawPayload: 'QR_EMP004_VALID', scannerType: 'IN', customScanTime: twoHoursAgoIso });

      // Helper to configure role_permissions through real API
      const setRolePerms = async (roleId: string, modulePermissions: Record<string, any>) => {
        const r = await request(app)
          .post('/api/admin/role-permissions')
          .set('Authorization', `Bearer ${superAdminToken}`)
          .send({ roleId, modulePermissions });
        expect(r.status).toBe(200);
        return r.body;
      };

      // Case 8a: Unconfigured roles preserve legacy QR functionality WITHOUT auto-enabling Manual ID Entry
      const adminCapDefault = resolveScannerCapabilities({
        profile: { id: 'role_admin', loginId: 'admin', email: 'admin@test.local', name: 'Admin', role: 'admin', status: 'Active', modulesAllowed: ['dashboard', 'scanner'], createdAt: '', updatedAt: '' },
      });
      expect(adminCapDefault.canQrScan).toBe(true);
      expect(adminCapDefault.canManualEntry).toBe(false);

      // Case 1: QR allowed (attendance.qr.scan: true), Manual denied (attendance.manual.entry: false)
      await setRolePerms('user', {
        scanner: { view: true, add: false, edit: false, delete: false },
        'attendance.qr.scan': { view: true, add: true, edit: false, delete: false },
        'attendance.manual.entry': { view: false, add: false, edit: false, delete: false },
      });

      const qrOnlyRolePerms = {
        user: {
          roleId: 'user',
          roleName: 'User',
          modulePermissions: (await db.collection('role_permissions').doc('user').get()).data()?.modulePermissions,
          updatedAt: '',
          updatedBy: '',
        },
      };
      const capCase1 = resolveScannerCapabilities({
        profile: { id: 'role_user', loginId: 'user', email: 'user@test.local', name: 'User', role: 'user', status: 'Active', modulesAllowed: ['scanner'], createdAt: '', updatedAt: '' },
        rolePermissions: qrOnlyRolePerms,
      });
      expect(capCase1.canViewScanner).toBe(true);
      expect(capCase1.canQrScan).toBe(true);
      expect(capCase1.canManualEntry).toBe(false);

      // QR Punch IN & OUT allowed (200); Manual IN & OUT denied (403)
      const qrIn1 = await request(app)
        .post('/api/attendance/scan')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ rawPayload: 'QR_EMP001_VALID', scannerType: 'IN' });
      expect(qrIn1.status).toBe(200);

      const manualOutBlocked1 = await request(app)
        .post('/api/attendance/manual-punch')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ employeeId: 'EMP001', scannerType: 'OUT' });
      expect(manualOutBlocked1.status).toBe(403);

      const qrOut1 = await request(app)
        .post('/api/attendance/scan')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ rawPayload: 'QR_EMP003_VALID', scannerType: 'OUT' });
      expect(qrOut1.status).toBe(200);

      const manualInBlocked1 = await request(app)
        .post('/api/attendance/manual-punch')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ employeeId: 'MSI1335', scannerType: 'IN' });
      expect(manualInBlocked1.status).toBe(403);

      // Case 2: QR denied (attendance.qr.scan: false), Manual allowed (attendance.manual.entry: true)
      // Even when scanner.add is true, explicit attendance.qr.scan: false MUST deny QR scanning & webcam/USB scan endpoints!
      await setRolePerms('user', {
        scanner: { view: true, add: true, edit: false, delete: false },
        'attendance.qr.scan': { view: false, add: false, edit: false, delete: false },
        'attendance.manual.entry': { view: true, add: true, edit: false, delete: false },
      });
      const manualOnlyRolePerms = {
        user: {
          roleId: 'user',
          roleName: 'User',
          modulePermissions: (await db.collection('role_permissions').doc('user').get()).data()?.modulePermissions,
          updatedAt: '',
          updatedBy: '',
        },
      };
      const capCase2 = resolveScannerCapabilities({
        profile: { id: 'role_user', loginId: 'user', email: 'user@test.local', name: 'User', role: 'user', status: 'Active', modulesAllowed: ['scanner'], createdAt: '', updatedAt: '' },
        rolePermissions: manualOnlyRolePerms,
      });
      expect(capCase2.canViewScanner).toBe(true);
      expect(capCase2.canQrScan).toBe(false);
      expect(capCase2.canManualEntry).toBe(true);

      // Direct API QR scan blocked (403) even if client attempts scannerDevice: 'MANUAL'
      const qrInBlocked2 = await request(app)
        .post('/api/attendance/scan')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ rawPayload: 'QR_MSI1335_AUTH', scannerType: 'IN', scannerDevice: 'MANUAL' });
      expect(qrInBlocked2.status).toBe(403);
      expect(qrInBlocked2.body.error).toContain('attendance.qr.scan');

      // Manual IN succeeds (200), QR OUT blocked (403), Manual OUT succeeds (200)
      const manualIn2 = await request(app)
        .post('/api/attendance/manual-punch')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ employeeId: 'MSI1335', scannerType: 'IN' });
      expect(manualIn2.status).toBe(200);
      expect(manualIn2.body.action).toBe('PUNCH_IN');

      const qrOutBlocked2 = await request(app)
        .post('/api/attendance/scan')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ rawPayload: 'QR_EMP004_VALID', scannerType: 'OUT' });
      expect(qrOutBlocked2.status).toBe(403);

      const manualOut2 = await request(app)
        .post('/api/attendance/manual-punch')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ employeeId: 'EMP004', scannerType: 'OUT' });
      expect(manualOut2.status).toBe(200);
      expect(manualOut2.body.action).toBe('PUNCH_OUT');

      // Case 3: Both permissions allowed
      await setRolePerms('admin', {
        scanner: { view: true, add: false, edit: true, delete: false },
        'attendance.qr.scan': { view: true, add: true, edit: false, delete: false },
        'attendance.manual.entry': { view: true, add: true, edit: false, delete: false },
        history: { view: true, add: false, edit: true, delete: false },
      });

      const bothQrIn = await request(app)
        .post('/api/attendance/scan')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          rawPayload: JSON.stringify({ employeeId: 'EMP001', token: 'QR_EMP001_VALID' }),
          scannerType: 'IN',
          customScanTime: '2026-11-18T09:00:00+05:30',
        });
      expect(bothQrIn.status).toBe(200);

      const bothManualOut = await request(app)
        .post('/api/attendance/manual-punch')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          employeeId: 'EMP001',
          scannerType: 'OUT',
          customScanTime: '2026-11-18T17:30:00+05:30',
        });
      expect(bothManualOut.status).toBe(200);

      // Case 8b: Existing untokenized legacy QR compatibility continues to work when attendance.qr.scan is granted
      const legacyQrRes = await request(app)
        .post('/api/attendance/scan')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          rawPayload: 'EMP_LEGACY_NP',
          scannerType: 'IN',
          customScanTime: '2026-11-18T09:00:00+05:30',
        });
      expect(legacyQrRes.status).toBe(200);
      expect(legacyQrRes.body.attendance.qrVerificationMode).toBe('UNTOKENIZED_EMPLOYEE');

      // Case 4: Both permissions denied
      await setRolePerms('user', {
        scanner: { view: true, add: false, edit: false, delete: false },
        'attendance.qr.scan': { view: false, add: false, edit: false, delete: false },
        'attendance.manual.entry': { view: false, add: false, edit: false, delete: false },
      });
      const capCase4 = resolveScannerCapabilities({
        profile: { id: 'role_user', loginId: 'user', email: 'user@test.local', name: 'User', role: 'user', status: 'Active', modulesAllowed: ['scanner'], createdAt: '', updatedAt: '' },
        rolePermissions: {
          user: {
            roleId: 'user',
            roleName: 'User',
            modulePermissions: (await db.collection('role_permissions').doc('user').get()).data()?.modulePermissions,
            updatedAt: '',
            updatedBy: '',
          },
        },
      });
      expect(capCase4.canQrScan).toBe(false);
      expect(capCase4.canManualEntry).toBe(false);

      expect(
        (await request(app).post('/api/attendance/scan').set('Authorization', `Bearer ${userToken}`).send({ rawPayload: 'QR_EMP001_VALID', scannerType: 'IN' })).status
      ).toBe(403);
      expect(
        (await request(app).post('/api/attendance/scan').set('Authorization', `Bearer ${userToken}`).send({ rawPayload: 'QR_EMP001_VALID', scannerType: 'OUT' })).status
      ).toBe(403);
      expect(
        (await request(app).post('/api/attendance/manual-punch').set('Authorization', `Bearer ${userToken}`).send({ employeeId: 'EMP001', scannerType: 'IN' })).status
      ).toBe(403);
      expect(
        (await request(app).post('/api/attendance/manual-punch').set('Authorization', `Bearer ${userToken}`).send({ employeeId: 'EMP001', scannerType: 'OUT' })).status
      ).toBe(403);

      // Case 5b: Account-level user_permissions override takes precedence over role_permissions independently
      const overrideRes = await request(app)
        .post('/api/admin/set-user-permissions')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          callerLoginId: 'superadmin',
          targetId: 'role_user',
          permissions: {
            scanner: { view: true, add: false, edit: false, delete: false },
            'attendance.qr.scan': { view: false, add: false, edit: false, delete: false },
            'attendance.manual.entry': { view: true, add: true, edit: false, delete: false },
          },
          modulesAllowed: ['dashboard', 'scanner'],
        });
      expect(overrideRes.status).toBe(200);

      // User override grants ONLY Manual ID Entry -> QR stays 403, Manual IN succeeds 200
      expect(
        (await request(app).post('/api/attendance/scan').set('Authorization', `Bearer ${userToken}`).send({ rawPayload: 'QR_EMP005_VALID', scannerType: 'IN' })).status
      ).toBe(403);
      expect(
        (await request(app).post('/api/attendance/manual-punch').set('Authorization', `Bearer ${userToken}`).send({ employeeId: 'EMP005', scannerType: 'IN' })).status
      ).toBe(200);
    });
  });
});
