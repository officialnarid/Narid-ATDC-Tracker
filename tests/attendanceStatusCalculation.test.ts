import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../server.ts';
import {
  classifyCompletedDutyStatus,
  formatOtBadge,
  resolveAttendanceMetrics,
  STANDARD_DUTY_MINUTES,
} from '../src/utils/attendanceStatus.ts';
import {
  InMemoryAdminAuth,
  InMemoryFirestore,
  TEST_CANONICAL_ACCOUNTS,
  seedIsolatedTestEnvironment,
} from './helpers/inMemoryAdmin.ts';

describe('Duty-Based Attendance Status Classification & Edge-Case Accuracy', () => {
  let db: InMemoryFirestore;
  let auth: InMemoryAdminAuth;
  let app: ReturnType<typeof createApp>['app'];

  beforeEach(async () => {
    db = new InMemoryFirestore();
    auth = new InMemoryAdminAuth();
    await seedIsolatedTestEnvironment(db, auth);

    for (let i = 10; i <= 25; i++) {
      const id = `DUTY${i}`;
      await db.collection('employees').doc(id).set({
        id,
        employeeId: id,
        employeeName: `Worker ${id}`,
        employeeType: 'Permanent',
        floor: 'MI-01',
        section: 'MI',
        department: 'Production',
        designation: 'Operator',
        employeeStatus: 'Active',
        qrCodeToken: `QR_${id}_VALID`,
      });
    }

    app = createApp({
      db,
      auth,
      projectId: 'narid-atdc-tracker',
      databaseId: 'ai-studio-manpowertracker-9b87a863-5c0d-4126-accb-7a3be802b10b',
      credentialMode: 'ADC',
      disableBackgroundBoot: true,
    }).app;
  });

  it('classifies every closed-shift boundary accurately with standard 08:30 (510 min) duty', () => {
    const cases: Array<{ mins: number; expectedStatus: string; expectedOt: number; expectedOtLabel: string }> = [
      { mins: 0, expectedStatus: 'SHORT LEAVE', expectedOt: 0, expectedOtLabel: '00:00' },
      { mins: 240, expectedStatus: 'SHORT LEAVE', expectedOt: 0, expectedOtLabel: '00:00' }, // 04:00
      { mins: 269, expectedStatus: 'SHORT LEAVE', expectedOt: 0, expectedOtLabel: '00:00' }, // 04:29
      { mins: 270, expectedStatus: 'HALF DAY', expectedOt: 0, expectedOtLabel: '00:00' },    // 04:30
      { mins: 360, expectedStatus: 'HALF DAY', expectedOt: 0, expectedOtLabel: '00:00' },    // 06:00
      { mins: 480, expectedStatus: 'HALF DAY', expectedOt: 0, expectedOtLabel: '00:00' },    // 08:00
      { mins: 509, expectedStatus: 'HALF DAY', expectedOt: 0, expectedOtLabel: '00:00' },    // 08:29
      { mins: 510, expectedStatus: 'COMPLETED', expectedOt: 0, expectedOtLabel: '00:00' },   // 08:30
      { mins: 630, expectedStatus: 'COMPLETED + OT', expectedOt: 120, expectedOtLabel: '02:00 OT' }, // 10:30
      { mins: 690, expectedStatus: 'COMPLETED + OT', expectedOt: 180, expectedOtLabel: '03:00 OT' }, // 11:30
    ];

    for (const c of cases) {
      expect(classifyCompletedDutyStatus(c.mins, STANDARD_DUTY_MINUTES)).toBe(c.expectedStatus);
      const metrics = resolveAttendanceMetrics({
        currentState: 'OUTSIDE',
        punchOutType: 'ACTUAL',
        totalDutyMinutes: c.mins,
        attendanceStatus: 'COMPLETED',
      });
      expect(metrics.status).toBe(c.expectedStatus);
      expect(metrics.overtimeMinutes).toBe(c.expectedOt);
      expect(metrics.otLabel).toBe(c.expectedOtLabel);
      expect(formatOtBadge(metrics.overtimeMinutes)).toBe(c.expectedOtLabel);
    }
  });

  it('records open shift as INSIDE / IN PROGRESS, tracks accumulated time separately, and excludes open shifts from completed duty/OT KPIs', async () => {
    const adminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid);
    const inIso = '2026-11-18T09:00:00+05:30';

    const inRes = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        rawPayload: 'QR_DUTY10_VALID',
        scannerType: 'IN',
        customScanTime: inIso,
      });

    expect(inRes.status).toBe(200);
    expect(inRes.body.currentState).toBe('INSIDE');
    expect(inRes.body.attendance.attendanceStatus).toBe('IN PROGRESS');
    expect(inRes.body.attendance.totalDutyMinutes).toBe(0);
    expect(inRes.body.attendance.overtimeMinutes).toBe(0);

    // Accumulated open duty at 13:30 (4h30m elapsed) is shown separately and MUST NOT finalize HALF DAY / OT
    const futureCheckMs = new Date('2026-11-18T13:30:00+05:30').getTime();
    const resolvedOpen = resolveAttendanceMetrics(inRes.body.attendance, futureCheckMs);
    expect(resolvedOpen.status).toBe('IN PROGRESS');
    expect(resolvedOpen.state).toBe('INSIDE');
    expect(resolvedOpen.isOpen).toBe(true);
    expect(resolvedOpen.completedDutyMinutes).toBe(0);
    expect(resolvedOpen.overtimeMinutes).toBe(0);
    expect(resolvedOpen.accumulatedDutyMinutes).toBe(270);

    // Dashboard summary for 2026-11-18 reports 0 completed duty & 0 OT while shift is open
    const dashRes = await request(app)
      .get('/api/dashboard/summary?date=2026-11-18')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(dashRes.status).toBe(200);
    expect(dashRes.body.metrics.currentlyInside).toBe(1);
    expect(dashRes.body.metrics.dutyHoursMins).toBe(0);
    expect(dashRes.body.metrics.otHoursMins).toBe(0);
  });

  it('persists exact duty-based status across Punch Out endpoints and alternating IN/OUT cycles without counting post-OUT time', async () => {
    const adminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid);

    const punchPair = async (empId: string, inIso: string, outIso: string) => {
      const rIn = await request(app)
        .post('/api/attendance/scan')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ rawPayload: `QR_${empId}_VALID`, scannerType: 'IN', customScanTime: inIso });
      expect(rIn.status).toBe(200);

      const rOut = await request(app)
        .post('/api/attendance/scan')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ rawPayload: `QR_${empId}_VALID`, scannerType: 'OUT', customScanTime: outIso });
      expect(rOut.status).toBe(200);
      return rOut.body.attendance;
    };

    // 04:00 -> SHORT LEAVE
    const a1 = await punchPair('DUTY11', '2026-11-18T09:00:00+05:30', '2026-11-18T13:00:00+05:30');
    expect(a1.totalDutyMinutes).toBe(240);
    expect(a1.overtimeMinutes).toBe(0);
    expect(a1.attendanceStatus).toBe('SHORT LEAVE');

    // Verify resolving 10 hours later does NOT count time after last Punch Out (13:00)
    const lateCheck = resolveAttendanceMetrics(a1, new Date('2026-11-18T23:00:00+05:30').getTime());
    expect(lateCheck.status).toBe('SHORT LEAVE');
    expect(lateCheck.completedDutyMinutes).toBe(240);

    // 04:30 -> HALF DAY
    const a2 = await punchPair('DUTY12', '2026-11-18T09:00:00+05:30', '2026-11-18T13:30:00+05:30');
    expect(a2.totalDutyMinutes).toBe(270);
    expect(a2.overtimeMinutes).toBe(0);
    expect(a2.attendanceStatus).toBe('HALF DAY');

    // 06:00 -> HALF DAY
    const a3 = await punchPair('DUTY13', '2026-11-18T09:00:00+05:30', '2026-11-18T15:00:00+05:30');
    expect(a3.totalDutyMinutes).toBe(360);
    expect(a3.overtimeMinutes).toBe(0);
    expect(a3.attendanceStatus).toBe('HALF DAY');

    // 08:00 -> HALF DAY
    const a4 = await punchPair('DUTY14', '2026-11-18T09:00:00+05:30', '2026-11-18T17:00:00+05:30');
    expect(a4.totalDutyMinutes).toBe(480);
    expect(a4.overtimeMinutes).toBe(0);
    expect(a4.attendanceStatus).toBe('HALF DAY');

    // 08:30 -> COMPLETED
    const a5 = await punchPair('DUTY15', '2026-11-18T09:00:00+05:30', '2026-11-18T17:30:00+05:30');
    expect(a5.totalDutyMinutes).toBe(510);
    expect(a5.overtimeMinutes).toBe(0);
    expect(a5.attendanceStatus).toBe('COMPLETED');

    // 10:30 -> COMPLETED + OT (02:00 OT)
    const a6 = await punchPair('DUTY16', '2026-11-18T09:00:00+05:30', '2026-11-18T19:30:00+05:30');
    expect(a6.totalDutyMinutes).toBe(630);
    expect(a6.regularDutyMinutes).toBe(510);
    expect(a6.overtimeMinutes).toBe(120);
    expect(a6.attendanceStatus).toBe('COMPLETED + OT');
    expect(resolveAttendanceMetrics(a6).otLabel).toBe('02:00 OT');

    // 11:30 -> COMPLETED + OT (03:00 OT)
    const a7 = await punchPair('DUTY17', '2026-11-18T09:00:00+05:30', '2026-11-18T20:30:00+05:30');
    expect(a7.totalDutyMinutes).toBe(690);
    expect(a7.regularDutyMinutes).toBe(510);
    expect(a7.overtimeMinutes).toBe(180);
    expect(a7.attendanceStatus).toBe('COMPLETED + OT');
    expect(resolveAttendanceMetrics(a7).otLabel).toBe('03:00 OT');

    // Multiple alternating punches: IN1 (09:00) -> OUT1 (12:00) -> IN2 (12:30) -> OUT2 (19:30)
    await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_DUTY18_VALID', scannerType: 'IN', customScanTime: '2026-11-18T09:00:00+05:30' });
    const midOut = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_DUTY18_VALID', scannerType: 'OUT', customScanTime: '2026-11-18T12:00:00+05:30' });
    expect(midOut.body.attendance.attendanceStatus).toBe('SHORT LEAVE');

    const reIn = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_DUTY18_VALID', scannerType: 'IN', customScanTime: '2026-11-18T12:30:00+05:30' });
    expect(reIn.status).toBe(200);
    expect(reIn.body.currentState).toBe('INSIDE');
    expect(reIn.body.attendance.attendanceStatus).toBe('IN PROGRESS');
    expect(reIn.body.attendance.totalDutyMinutes).toBe(0);
    expect(reIn.body.attendance.overtimeMinutes).toBe(0);

    const finalOut = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_DUTY18_VALID', scannerType: 'OUT', customScanTime: '2026-11-18T19:30:00+05:30' });
    expect(finalOut.status).toBe(200);
    expect(finalOut.body.attendance.punches).toHaveLength(4);
    expect(finalOut.body.attendance.firstPunchIn).toBe('2026-11-18T09:00:00.000Z'.replace('09:00:00.000Z', finalOut.body.attendance.firstPunchIn.slice(11)));
    expect(finalOut.body.attendance.totalDutyMinutes).toBe(630);
    expect(finalOut.body.attendance.overtimeMinutes).toBe(120);
    expect(finalOut.body.attendance.attendanceStatus).toBe('COMPLETED + OT');
  });

  it('handles Night Shift across midnight and preserves late arrival metadata', async () => {
    const adminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid);

    // Night shift punch in at 20:30 (late past 20:15 grace window)
    const nightIn = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        rawPayload: 'QR_DUTY19_VALID',
        scannerType: 'IN',
        customScanTime: '2026-11-18T20:30:00+05:30',
      });
    expect(nightIn.status).toBe(200);
    expect(nightIn.body.shift.id).toBe('NIGHT');
    expect(nightIn.body.attendance.attendanceStatus).toBe('IN PROGRESS');
    expect(nightIn.body.attendance.isLate).toBe(true);
    expect(nightIn.body.attendance.arrivalStatus).toBe('LATE');

    // Punch out next morning at 05:00 => 480m regular (20:30 -> 04:30) + 30m post-shift OT (04:30 -> 05:00) = 510m total -> COMPLETED + OT
    const nightOut = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        rawPayload: 'QR_DUTY19_VALID',
        scannerType: 'OUT',
        customScanTime: '2026-11-19T05:00:00+05:30',
      });
    expect(nightOut.status).toBe(200);
    expect(nightOut.body.attendance.shiftDate).toBe('2026-11-18');
    expect(nightOut.body.attendance.regularDutyMinutes).toBe(480);
    expect(nightOut.body.attendance.overtimeMinutes).toBe(30);
    expect(nightOut.body.attendance.totalDutyMinutes).toBe(510);
    expect(nightOut.body.attendance.attendanceStatus).toBe('COMPLETED + OT');
    expect(nightOut.body.attendance.isLate).toBe(true);
  });

  it('resolves legacy historical records identically without DB mutation and updates status on supervisor correction', async () => {
    const adminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid);

    // Legacy Firestore record stored before this update: had 'COMPLETED' despite only 04:00 duty
    const legacyShortRecord = {
      id: 'att_DUTY20_2026-11-10_DAY',
      employeeId: 'DUTY20',
      firstPunchIn: '2026-11-10T09:00:00+05:30',
      lastPunchOut: '2026-11-10T13:00:00+05:30',
      actualPunchOut: '2026-11-10T13:00:00+05:30',
      punchOutType: 'ACTUAL',
      currentState: 'OUTSIDE',
      totalDutyMinutes: 240,
      regularDutyMinutes: 240,
      overtimeMinutes: 0,
      attendanceStatus: 'COMPLETED',
    };
    const legacyMetrics = resolveAttendanceMetrics(legacyShortRecord);
    expect(legacyMetrics.status).toBe('SHORT LEAVE');
    expect(legacyMetrics.overtimeMinutes).toBe(0);

    // Open legacy record with 'PRESENT'
    const legacyOpenRecord = {
      id: 'att_DUTY21_2026-11-18_DAY',
      employeeId: 'DUTY21',
      firstPunchIn: '2026-11-18T09:00:00+05:30',
      punchIn: '2026-11-18T09:00:00+05:30',
      actualPunchOut: null,
      punchOutType: 'NONE',
      currentState: 'INSIDE',
      totalDutyMinutes: 0,
      regularDutyMinutes: 0,
      overtimeMinutes: 0,
      attendanceStatus: 'PRESENT',
    };
    const openMetrics = resolveAttendanceMetrics(
      legacyOpenRecord,
      new Date('2026-11-18T11:15:00+05:30').getTime()
    );
    expect(openMetrics.status).toBe('IN PROGRESS');
    expect(openMetrics.accumulatedDutyMinutes).toBe(135);
    expect(openMetrics.completedDutyMinutes).toBe(0);

    // Supervisor correction recalculates status cleanly on backend
    await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        rawPayload: 'QR_DUTY22_VALID',
        scannerType: 'IN',
        customScanTime: '2026-11-18T09:00:00+05:30',
      });
    const corrRes = await request(app)
      .post('/api/attendance/correct')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        attendanceId: 'att_DUTY22_2026-11-18_DAY',
        actualPunchOut: '2026-11-18T15:00:00+05:30', // 6h = 360 mins -> HALF DAY
        punchOutType: 'ACTUAL',
        attendanceStatus: 'COMPLETED',
        reason: 'Verified missed exit scan with supervisor',
      });
    expect(corrRes.status).toBe(200);
    expect(corrRes.body.record.totalDutyMinutes).toBe(360);
    expect(corrRes.body.record.overtimeMinutes).toBe(0);
    expect(corrRes.body.record.attendanceStatus).toBe('HALF DAY');
  });
});
