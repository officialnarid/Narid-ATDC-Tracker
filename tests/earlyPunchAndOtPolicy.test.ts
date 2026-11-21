import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../server.ts';
import { identifyShiftForPunchIn } from '../serverAttendance.ts';
import {
  EARLY_OT_THRESHOLD_MINUTES,
  EARLY_PUNCH_POLICY_ID,
  evaluateEarlyPunchOnPunchIn,
  evaluateOptionAPunchOut,
  resolveAttendanceMetrics,
  resolveShiftScheduleBounds,
  STANDARD_DUTY_MINUTES,
} from '../src/utils/attendanceStatus.ts';
import { AttendanceHistory } from '../src/components/AttendanceHistory.tsx';
import { Reports } from '../src/components/Reports.tsx';
import { Dashboard } from '../src/components/Dashboard.tsx';
import {
  InMemoryAdminAuth,
  InMemoryFirestore,
  TEST_CANONICAL_ACCOUNTS,
  seedIsolatedTestEnvironment,
} from './helpers/inMemoryAdmin.ts';

describe('Approved Early Punch & Early Overtime Policy (Option A)', () => {
  let db: InMemoryFirestore;
  let auth: InMemoryAdminAuth;
  let app: ReturnType<typeof createApp>['app'];

  beforeEach(async () => {
    db = new InMemoryFirestore();
    auth = new InMemoryAdminAuth();
    await seedIsolatedTestEnvironment(db, auth);

    for (let i = 1; i <= 25; i++) {
      const id = `EP${String(i).padStart(3, '0')}`;
      await db.collection('employees').doc(id).set({
        id,
        employeeId: id,
        employeeName: `Early Policy Worker ${i}`,
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

  it('enforces exact 59-minute, 60-minute, and 61-minute Early OT boundaries (Option A) for both Day and Night shifts', () => {
    expect(EARLY_OT_THRESHOLD_MINUTES).toBe(60);

    // Day Shift: 09:00 AM -> 05:30 PM
    const dayBounds = resolveShiftScheduleBounds('2026-11-19', {
      id: 'DAY',
      startTime: '09:00',
      endTime: '17:30',
      isOvernight: false,
    });

    const day59 = evaluateOptionAPunchOut({
      firstInIso: '2026-11-19T08:01:00+05:30', // 59m early
      lastOutIso: '2026-11-19T17:30:00+05:30',
      scheduledStartIso: dayBounds.scheduledStartIso,
      scheduledEndIso: dayBounds.scheduledEndIso,
    });
    expect(day59.earlyArrivalMinutes).toBe(59);
    expect(day59.earlyOtMinutes).toBe(0);
    expect(day59.postShiftOtMinutes).toBe(0);
    expect(day59.overtimeMinutes).toBe(0);
    expect(day59.regularDutyMinutes).toBe(510);
    expect(day59.attendanceStatus).toBe('COMPLETED');

    const day60 = evaluateOptionAPunchOut({
      firstInIso: '2026-11-19T08:00:00+05:30', // exactly 60m early -> full 60m Early OT
      lastOutIso: '2026-11-19T17:30:00+05:30',
      scheduledStartIso: dayBounds.scheduledStartIso,
      scheduledEndIso: dayBounds.scheduledEndIso,
    });
    expect(day60.earlyArrivalMinutes).toBe(60);
    expect(day60.earlyOtMinutes).toBe(60);
    expect(day60.postShiftOtMinutes).toBe(0);
    expect(day60.overtimeMinutes).toBe(60);
    expect(day60.totalOtMinutes).toBe(60);
    expect(day60.attendanceStatus).toBe('COMPLETED + OT');

    const day61 = evaluateOptionAPunchOut({
      firstInIso: '2026-11-19T07:59:00+05:30', // 61m early -> full 61m Early OT (never subtract 30 or 60)
      lastOutIso: '2026-11-19T17:30:00+05:30',
      scheduledStartIso: dayBounds.scheduledStartIso,
      scheduledEndIso: dayBounds.scheduledEndIso,
    });
    expect(day61.earlyArrivalMinutes).toBe(61);
    expect(day61.earlyOtMinutes).toBe(61);
    expect(day61.postShiftOtMinutes).toBe(0);
    expect(day61.overtimeMinutes).toBe(61);
    expect(day61.attendanceStatus).toBe('COMPLETED + OT');

    // Night Shift: 08:00 PM -> 04:30 AM next calendar day
    const nightBounds = resolveShiftScheduleBounds('2026-11-19', {
      id: 'NIGHT',
      startTime: '20:00',
      endTime: '04:30',
      isOvernight: true,
    });
    expect(nightBounds.scheduledStartIso).toBe('2026-11-19T20:00:00+05:30');
    expect(nightBounds.scheduledEndIso).toBe('2026-11-20T04:30:00+05:30');

    const night59 = evaluateOptionAPunchOut({
      firstInIso: '2026-11-19T19:01:00+05:30', // 59m early
      lastOutIso: '2026-11-20T04:30:00+05:30',
      scheduledStartIso: nightBounds.scheduledStartIso,
      scheduledEndIso: nightBounds.scheduledEndIso,
    });
    expect(night59.earlyArrivalMinutes).toBe(59);
    expect(night59.earlyOtMinutes).toBe(0);
    expect(night59.postShiftOtMinutes).toBe(0);
    expect(night59.overtimeMinutes).toBe(0);
    expect(night59.attendanceStatus).toBe('COMPLETED');

    const night60 = evaluateOptionAPunchOut({
      firstInIso: '2026-11-19T19:00:00+05:30', // 60m early -> full 60m Early OT
      lastOutIso: '2026-11-20T04:30:00+05:30',
      scheduledStartIso: nightBounds.scheduledStartIso,
      scheduledEndIso: nightBounds.scheduledEndIso,
    });
    expect(night60.earlyArrivalMinutes).toBe(60);
    expect(night60.earlyOtMinutes).toBe(60);
    expect(night60.overtimeMinutes).toBe(60);
    expect(night60.attendanceStatus).toBe('COMPLETED + OT');

    const night61 = evaluateOptionAPunchOut({
      firstInIso: '2026-11-19T18:59:00+05:30', // 61m early -> full 61m Early OT
      lastOutIso: '2026-11-20T04:30:00+05:30',
      scheduledStartIso: nightBounds.scheduledStartIso,
      scheduledEndIso: nightBounds.scheduledEndIso,
    });
    expect(night61.earlyArrivalMinutes).toBe(61);
    expect(night61.earlyOtMinutes).toBe(61);
    expect(night61.overtimeMinutes).toBe(61);
    expect(night61.attendanceStatus).toBe('COMPLETED + OT');
  });

  it('correctly assigns Day and Night shifts for all approved early-punch examples even with legacy stored shift windows', () => {
    const legacyStoredShifts = [
      {
        id: 'DAY',
        name: 'DAY SHIFT',
        startTime: '09:00',
        endTime: '17:30',
        scheduledDurationMinutes: 510,
        punchInWindowStart: '09:00',
        punchInWindowEnd: '20:00',
        isOvernight: false,
        gracePeriodMinutes: 15,
        status: 'Active',
      },
      {
        id: 'NIGHT',
        name: 'NIGHT SHIFT',
        startTime: '20:00',
        endTime: '04:30',
        scheduledDurationMinutes: 510,
        punchInWindowStart: '20:00',
        punchInWindowEnd: '09:00',
        isOvernight: true,
        gracePeriodMinutes: 15,
        status: 'Active',
      },
    ];

    // Day Shift early arrivals stay DAY SHIFT with today's shiftDate
    for (const time of ['07:30:00', '08:00:00', '08:30:00', '09:00:00']) {
      const match = identifyShiftForPunchIn(legacyStoredShifts, new Date(`2026-11-19T${time}+05:30`));
      expect(match?.shift.id).toBe('DAY');
      expect(match?.shiftDate).toBe('2026-11-19');
    }

    // Night Shift early arrivals (06:00 PM .. 07:30 PM) stay NIGHT SHIFT with today's shiftDate
    for (const time of ['18:00:00', '18:30:00', '19:00:00', '19:15:00', '19:30:00', '20:00:00']) {
      const match = identifyShiftForPunchIn(legacyStoredShifts, new Date(`2026-11-19T${time}+05:30`));
      expect(match?.shift.id).toBe('NIGHT');
      expect(match?.shiftDate).toBe('2026-11-19');
    }

    // Cross-midnight Night Shift punch-in (e.g. 00:30 AM on Nov 20) attributes to yesterday (Nov 19)
    const afterMidnight = identifyShiftForPunchIn(legacyStoredShifts, new Date('2026-11-20T00:30:00+05:30'));
    expect(afterMidnight?.shift.id).toBe('NIGHT');
    expect(afterMidnight?.shiftDate).toBe('2026-11-19');
  });

  it('verifies all Day Shift API examples (08:30 AM, 08:01 AM, 08:00 AM, 07:59 AM, 07:30 AM) end-to-end', async () => {
    const adminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid);

    const cases = [
      { emp: 'EP001', inTime: '2026-11-19T08:30:00+05:30', outTime: '2026-11-19T17:30:00+05:30', early: 30, earlyOt: 0, postOt: 0, totalOt: 0, status: 'COMPLETED' },
      { emp: 'EP002', inTime: '2026-11-19T08:01:00+05:30', outTime: '2026-11-19T17:30:00+05:30', early: 59, earlyOt: 0, postOt: 0, totalOt: 0, status: 'COMPLETED' },
      { emp: 'EP003', inTime: '2026-11-19T08:00:00+05:30', outTime: '2026-11-19T17:30:00+05:30', early: 60, earlyOt: 60, postOt: 0, totalOt: 60, status: 'COMPLETED + OT' },
      { emp: 'EP004', inTime: '2026-11-19T07:59:00+05:30', outTime: '2026-11-19T17:30:00+05:30', early: 61, earlyOt: 61, postOt: 0, totalOt: 61, status: 'COMPLETED + OT' },
      { emp: 'EP005', inTime: '2026-11-19T07:30:00+05:30', outTime: '2026-11-19T17:30:00+05:30', early: 90, earlyOt: 90, postOt: 0, totalOt: 90, status: 'COMPLETED + OT' },
    ];

    for (const c of cases) {
      const rIn = await request(app)
        .post('/api/attendance/scan')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ rawPayload: `QR_${c.emp}_VALID`, scannerType: 'IN', customScanTime: c.inTime });
      expect(rIn.status).toBe(200);
      expect(rIn.body.shift.id).toBe('DAY');
      expect(rIn.body.attendance.shiftDate).toBe('2026-11-19');
      expect(rIn.body.attendance.scheduledPunchIn).toBe('09:00');
      expect(rIn.body.attendance.scheduledPunchOut).toBe('17:30');
      expect(new Date(rIn.body.attendance.firstPunchIn).getTime()).toBe(new Date(c.inTime).getTime());
      expect(rIn.body.attendance.isLate).toBe(false);
      expect(rIn.body.attendance.earlyArrivalMinutes).toBe(c.early);
      expect(rIn.body.attendance.provisionalEarlyOtMinutes).toBe(c.earlyOt);
      // Open shift MUST remain IN PROGRESS with 0 finalized OT
      expect(rIn.body.attendance.attendanceStatus).toBe('IN PROGRESS');
      expect(rIn.body.attendance.overtimeMinutes).toBe(0);
      expect(rIn.body.attendance.earlyOtMinutes).toBe(0);
      expect(rIn.body.attendance.earlyOtFinalized).toBe(false);

      const rOut = await request(app)
        .post('/api/attendance/scan')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ rawPayload: `QR_${c.emp}_VALID`, scannerType: 'OUT', customScanTime: c.outTime });
      expect(rOut.status).toBe(200);
      expect(rOut.body.attendance.earlyArrivalMinutes).toBe(c.early);
      expect(rOut.body.attendance.earlyOtMinutes).toBe(c.earlyOt);
      expect(rOut.body.attendance.postShiftOtMinutes).toBe(c.postOt);
      expect(rOut.body.attendance.overtimeMinutes).toBe(c.totalOt);
      expect(rOut.body.attendance.totalOtMinutes).toBe(c.totalOt);
      expect(rOut.body.attendance.regularDutyMinutes).toBe(STANDARD_DUTY_MINUTES);
      expect(rOut.body.attendance.attendanceStatus).toBe(c.status);
      expect(rOut.body.attendance.earlyOtFinalized).toBe(true);
    }
  });

  it('verifies all Night Shift cross-midnight API examples (07:30 PM, 07:15 PM, 07:01 PM, 07:00 PM, 06:59 PM, 06:30 PM, 06:00 PM)', async () => {
    const adminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid);

    const cases = [
      { emp: 'EP006', inTime: '2026-11-19T19:30:00+05:30', outTime: '2026-11-20T04:30:00+05:30', early: 30, earlyOt: 0, status: 'COMPLETED' },
      { emp: 'EP007', inTime: '2026-11-19T19:15:00+05:30', outTime: '2026-11-20T04:30:00+05:30', early: 45, earlyOt: 0, status: 'COMPLETED' },
      { emp: 'EP008', inTime: '2026-11-19T19:01:00+05:30', outTime: '2026-11-20T04:30:00+05:30', early: 59, earlyOt: 0, status: 'COMPLETED' },
      { emp: 'EP009', inTime: '2026-11-19T19:00:00+05:30', outTime: '2026-11-20T04:30:00+05:30', early: 60, earlyOt: 60, status: 'COMPLETED + OT' },
      { emp: 'EP010', inTime: '2026-11-19T18:59:00+05:30', outTime: '2026-11-20T04:30:00+05:30', early: 61, earlyOt: 61, status: 'COMPLETED + OT' },
      { emp: 'EP011', inTime: '2026-11-19T18:30:00+05:30', outTime: '2026-11-20T04:30:00+05:30', early: 90, earlyOt: 90, status: 'COMPLETED + OT' },
      { emp: 'EP012', inTime: '2026-11-19T18:00:00+05:30', outTime: '2026-11-20T04:30:00+05:30', early: 120, earlyOt: 120, status: 'COMPLETED + OT' },
    ];

    for (const c of cases) {
      const rIn = await request(app)
        .post('/api/attendance/scan')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ rawPayload: `QR_${c.emp}_VALID`, scannerType: 'IN', customScanTime: c.inTime });
      expect(rIn.status).toBe(200);
      expect(rIn.body.shift.id).toBe('NIGHT');
      expect(rIn.body.attendance.shiftId).toBe('NIGHT');
      expect(rIn.body.attendance.shiftDate).toBe('2026-11-19');
      expect(rIn.body.attendance.scheduledPunchIn).toBe('20:00');
      expect(rIn.body.attendance.scheduledPunchOut).toBe('04:30');
      expect(rIn.body.attendance.isLate).toBe(false);
      expect(rIn.body.attendance.earlyArrivalMinutes).toBe(c.early);
      expect(rIn.body.attendance.provisionalEarlyOtMinutes).toBe(c.earlyOt);
      expect(rIn.body.attendance.overtimeMinutes).toBe(0);
      expect(rIn.body.attendance.attendanceStatus).toBe('IN PROGRESS');

      const rOut = await request(app)
        .post('/api/attendance/scan')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ rawPayload: `QR_${c.emp}_VALID`, scannerType: 'OUT', customScanTime: c.outTime });
      expect(rOut.status).toBe(200);
      expect(rOut.body.attendance.shiftId).toBe('NIGHT');
      expect(rOut.body.attendance.shiftDate).toBe('2026-11-19');
      expect(rOut.body.attendance.earlyArrivalMinutes).toBe(c.early);
      expect(rOut.body.attendance.earlyOtMinutes).toBe(c.earlyOt);
      expect(rOut.body.attendance.postShiftOtMinutes).toBe(0);
      expect(rOut.body.attendance.overtimeMinutes).toBe(c.earlyOt);
      expect(rOut.body.attendance.attendanceStatus).toBe(c.status);
    }
  });

  it('computes Early OT + Post-shift OT separately without double-counting overlapping intervals', async () => {
    const adminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid);

    // Day Shift: 07:30 AM (90m early -> 90m Early OT) to 06:30 PM (60m post-shift -> 60m Post OT) => Total OT = 150m
    await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_EP013_VALID', scannerType: 'IN', customScanTime: '2026-11-19T07:30:00+05:30' });
    const dayCombined = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_EP013_VALID', scannerType: 'OUT', customScanTime: '2026-11-19T18:30:00+05:30' });
    expect(dayCombined.status).toBe(200);
    expect(dayCombined.body.attendance.earlyArrivalMinutes).toBe(90);
    expect(dayCombined.body.attendance.earlyOtMinutes).toBe(90);
    expect(dayCombined.body.attendance.postShiftOtMinutes).toBe(60);
    expect(dayCombined.body.attendance.overtimeMinutes).toBe(150);
    expect(dayCombined.body.attendance.regularDutyMinutes).toBe(510);
    expect(dayCombined.body.attendance.totalDutyMinutes).toBe(660);
    expect(dayCombined.body.attendance.attendanceStatus).toBe('COMPLETED + OT');

    // Day Shift: 08:30 AM (30m early -> 0m Early OT) to 06:30 PM (60m post-shift -> 60m Post OT) => Total OT = 60m (NOT 90m!)
    await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_EP014_VALID', scannerType: 'IN', customScanTime: '2026-11-19T08:30:00+05:30' });
    const daySubThreshold = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_EP014_VALID', scannerType: 'OUT', customScanTime: '2026-11-19T18:30:00+05:30' });
    expect(daySubThreshold.status).toBe(200);
    expect(daySubThreshold.body.attendance.earlyArrivalMinutes).toBe(30);
    expect(daySubThreshold.body.attendance.earlyOtMinutes).toBe(0);
    expect(daySubThreshold.body.attendance.postShiftOtMinutes).toBe(60);
    expect(daySubThreshold.body.attendance.overtimeMinutes).toBe(60);
    expect(daySubThreshold.body.attendance.attendanceStatus).toBe('COMPLETED + OT');

    // Night Shift cross-midnight: 06:00 PM (120m early) to 06:30 AM next morning (120m raw post-shift)
    // Enforces 210m Total OT cap (120m Early OT + 90m Post OT = 210m) and 720m Max Credited Working Time
    await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_EP015_VALID', scannerType: 'IN', customScanTime: '2026-11-19T18:00:00+05:30' });
    const nightCombined = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_EP015_VALID', scannerType: 'OUT', customScanTime: '2026-11-20T06:30:00+05:30' });
    expect(nightCombined.status).toBe(200);
    expect(nightCombined.body.attendance.shiftId).toBe('NIGHT');
    expect(nightCombined.body.attendance.shiftDate).toBe('2026-11-19');
    expect(nightCombined.body.attendance.earlyArrivalMinutes).toBe(120);
    expect(nightCombined.body.attendance.earlyOtMinutes).toBe(120);
    expect(nightCombined.body.attendance.postShiftOtMinutes).toBe(90);
    expect(nightCombined.body.attendance.overtimeMinutes).toBe(210);
    expect(nightCombined.body.attendance.totalDutyMinutes).toBe(720);
    expect(nightCombined.body.attendance.otCapApplied).toBe(true);
    expect(nightCombined.body.attendance.attendanceStatus).toBe('COMPLETED + OT');
  });

  it('keeps open early-punch shifts IN PROGRESS with provisional Early OT excluded from Dashboard finalized OT KPIs and preserves Short Leave / Half Day / Auto-Close rules', async () => {
    const adminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid);

    // EP016 punches in 90m early on Day Shift and has NOT punched out yet
    const openRes = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_EP016_VALID', scannerType: 'IN', customScanTime: '2026-11-19T07:30:00+05:30' });
    expect(openRes.status).toBe(200);
    expect(openRes.body.attendance.attendanceStatus).toBe('IN PROGRESS');
    expect(openRes.body.attendance.provisionalEarlyOtMinutes).toBe(90);
    expect(openRes.body.attendance.overtimeMinutes).toBe(0);
    expect(openRes.body.attendance.earlyOtMinutes).toBe(0);

    const openMetrics = resolveAttendanceMetrics(
      openRes.body.attendance,
      new Date('2026-11-19T16:30:00+05:30').getTime()
    );
    expect(openMetrics.status).toBe('IN PROGRESS');
    expect(openMetrics.isOpen).toBe(true);
    expect(openMetrics.provisionalEarlyOtMinutes).toBe(90);
    expect(openMetrics.earlyOtMinutes).toBe(0);
    expect(openMetrics.overtimeMinutes).toBe(0);
    expect(openMetrics.totalOtMinutes).toBe(0);
    expect(openMetrics.earlyOtFinalized).toBe(false);

    // Dashboard summary MUST NOT include provisional Early OT of open shifts
    const dashRes = await request(app)
      .get('/api/dashboard/summary?date=2026-11-19')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(dashRes.status).toBe(200);
    expect(dashRes.body.metrics.currentlyInside).toBe(1);
    expect(dashRes.body.metrics.otHoursMins).toBe(0);

    // Early arrival + early exit (07:30 AM -> 13:30 PM = 4h30m from 09:00 shift start -> HALF DAY, 0 OT)
    await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_EP017_VALID', scannerType: 'IN', customScanTime: '2026-11-19T07:30:00+05:30' });
    const halfDayOut = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_EP017_VALID', scannerType: 'OUT', customScanTime: '2026-11-19T13:30:00+05:30' });
    expect(halfDayOut.status).toBe(200);
    expect(halfDayOut.body.attendance.attendanceStatus).toBe('HALF DAY');
    expect(halfDayOut.body.attendance.earlyOtMinutes).toBe(0);
    expect(halfDayOut.body.attendance.overtimeMinutes).toBe(0);

    // Early arrival + very short exit (07:30 AM -> 11:00 AM = 2h from 09:00 -> SHORT LEAVE, 0 OT)
    await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_EP018_VALID', scannerType: 'IN', customScanTime: '2026-11-19T07:30:00+05:30' });
    const shortLeaveOut = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_EP018_VALID', scannerType: 'OUT', customScanTime: '2026-11-19T11:00:00+05:30' });
    expect(shortLeaveOut.status).toBe(200);
    expect(shortLeaveOut.body.attendance.attendanceStatus).toBe('SHORT LEAVE');
    expect(shortLeaveOut.body.attendance.earlyOtMinutes).toBe(0);
    expect(shortLeaveOut.body.attendance.overtimeMinutes).toBe(0);

    // Auto-close on expired early-punch shift MUST still award 0 OT
    await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_EP019_VALID', scannerType: 'IN', customScanTime: '2025-05-01T07:30:00+05:30' });
    const autoCloseRes = await request(app)
      .post('/api/attendance/auto-close')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(autoCloseRes.status).toBe(200);
    const closedEp19 = autoCloseRes.body.closedRecords.find((r: any) => r.employeeId === 'EP019');
    expect(closedEp19).toBeDefined();
    expect(closedEp19.punchOutType).toBe('AUTO');
    expect(closedEp19.overtimeMinutes).toBe(0);
    expect(closedEp19.earlyOtMinutes).toBe(0);
    expect(closedEp19.postShiftOtMinutes).toBe(0);
  });

  it('preserves historical legacy attendance records identically without migration or mutation', () => {
    const legacyRecord = {
      id: 'att_LEGACY01_2025-10-01_DAY',
      employeeId: 'LEGACY01',
      shiftId: 'DAY',
      shiftNameSnapshot: 'DAY SHIFT',
      shiftDate: '2025-10-01',
      punchIn: '2025-10-01T08:30:00+05:30',
      firstPunchIn: '2025-10-01T08:30:00+05:30',
      actualPunchOut: '2025-10-01T18:00:00+05:30',
      lastPunchOut: '2025-10-01T18:00:00+05:30',
      punchOutType: 'ACTUAL',
      currentState: 'OUTSIDE',
      totalDutyMinutes: 570,
      regularDutyMinutes: 510,
      overtimeMinutes: 60,
      attendanceStatus: 'COMPLETED + OT',
    };

    const resolved = resolveAttendanceMetrics(legacyRecord);
    expect(resolved.completedDutyMinutes).toBe(570);
    expect(resolved.regularDutyMinutes).toBe(510);
    expect(resolved.overtimeMinutes).toBe(60);
    expect(resolved.status).toBe('COMPLETED + OT');
    expect(resolved.scheduledStartDisplay).toBe('09:00 AM');

    // Pure punch-in helper verification
    const earlyCheck = evaluateEarlyPunchOnPunchIn({
      firstInIso: '2026-11-19T18:30:00+05:30',
      scheduledStartIso: '2026-11-19T20:00:00+05:30',
    });
    expect(earlyCheck.earlyPunchPolicy).toBe(EARLY_PUNCH_POLICY_ID);
    expect(earlyCheck.earlyArrivalMinutes).toBe(90);
    expect(earlyCheck.provisionalEarlyOtMinutes).toBe(90);
    expect(earlyCheck.earlyOtFinalized).toBe(false);
  });

  it('renders required Early Punch & OT columns cleanly across AttendanceHistory, Reports, and Dashboard', () => {
    const shifts = [
      {
        id: 'DAY',
        name: 'DAY SHIFT',
        startTime: '09:00',
        endTime: '17:30',
        scheduledDurationMinutes: 510,
        punchInWindowStart: '06:00',
        punchInWindowEnd: '18:00',
        isOvernight: false,
        gracePeriodMinutes: 15,
        status: 'Active' as const,
      },
    ];
    const historyHtml = renderToStaticMarkup(
      React.createElement(AttendanceHistory, {
        floors: [],
        sections: [],
        departments: [],
        shifts,
      })
    );
    expect(historyHtml).toContain('Scheduled Start');
    expect(historyHtml).toContain('Actual Punch In');
    expect(historyHtml).toContain('Early Arrival');
    expect(historyHtml).toContain('Early OT');
    expect(historyHtml).toContain('Post-shift OT');
    expect(historyHtml).toContain('Total OT');

    const reportsHtml = renderToStaticMarkup(
      React.createElement(Reports, {
        employees: [],
        floors: [],
        sections: [],
        departments: [],
        shifts,
      })
    );
    expect(reportsHtml).toContain('Scheduled Shift Start');
    expect(reportsHtml).toContain('Actual Punch In');
    expect(reportsHtml).toContain('Early Arrival Duration');
    expect(reportsHtml).toContain('Early OT');
    expect(reportsHtml).toContain('Post-shift OT');
    expect(reportsHtml).toContain('Total OT');

    const dashHtml = renderToStaticMarkup(
      React.createElement(Dashboard, {
        employees: [],
        shifts,
        floors: [],
        sections: [],
        departments: [],
        onNavigateToScanner: () => {},
        onNavigateToReports: () => {},
      })
    );
    expect(dashHtml.length).toBeGreaterThan(200);
    expect(dashHtml).toContain('animate-pulse');
  });
});
