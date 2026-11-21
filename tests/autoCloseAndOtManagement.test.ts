import request from 'supertest';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createApp } from '../server.ts';
import {
  computeExpectedPunchOutTimes,
  evaluateOptionAPunchOut,
  MAX_CREDITED_TOTAL_MINUTES,
  MAX_REGULAR_DUTY_MINUTES,
  MAX_TOTAL_OT_MINUTES,
  resolveAttendanceMetrics,
  resolveShiftScheduleBounds,
  STANDARD_DUTY_MINUTES,
} from '../src/utils/attendanceStatus.ts';
import {
  InMemoryAdminAuth,
  InMemoryFirestore,
  TEST_CANONICAL_ACCOUNTS,
  seedIsolatedTestEnvironment,
} from './helpers/inMemoryAdmin.ts';

describe('NARID ATDC Auto-Close, Actual Punch-Out Reconciliation & OT Cap Management', () => {
  let db: InMemoryFirestore;
  let auth: InMemoryAdminAuth;
  let app: ReturnType<typeof createApp>['app'];
  let adminToken: string;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    db = new InMemoryFirestore();
    auth = new InMemoryAdminAuth();
    await seedIsolatedTestEnvironment(db, auth);

    for (let i = 1; i <= 20; i++) {
      const id = `AC${String(i).padStart(3, '0')}`;
      await db.collection('employees').doc(id).set({
        id,
        employeeId: id,
        employeeName: `AutoClose Worker ${i}`,
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

    adminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Case 1: Day Shift employee with no Punch-Out is auto-closed at 05:30 PM.
  it('1. Auto-closes Day Shift employee at 05:30 PM IST with zero OT while preserving Punch-In & audit history', async () => {
    vi.setSystemTime(new Date('2026-11-22T09:00:00+05:30'));
    const inRes = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_AC001_VALID', scannerType: 'IN' });
    expect(inRes.status).toBe(200);
    expect(inRes.body.attendance.shiftId).toBe('DAY');
    const originalFirstIn = inRes.body.attendance.firstPunchIn;

    // 05:29:59 PM -> must NOT auto-close yet
    vi.setSystemTime(new Date('2026-11-22T17:29:59+05:30'));
    const beforeClose = await request(app)
      .post('/api/attendance/auto-close')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(beforeClose.status).toBe(200);
    expect(beforeClose.body.closedCount).toBe(0);

    // 05:30:00 PM -> MUST auto-close provisionally
    vi.setSystemTime(new Date('2026-11-22T17:30:00+05:30'));
    const atClose = await request(app)
      .post('/api/attendance/auto-close')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(atClose.status).toBe(200);
    expect(atClose.body.closedCount).toBe(1);

    const closed = atClose.body.closedRecords[0];
    expect(closed.employeeId).toBe('AC001');
    expect(closed.punchOutType).toBe('AUTO');
    expect(closed.autoClosed).toBe(true);
    expect(closed.missedPunchOut).toBe(true);
    expect(closed.attendanceStatus).toBe('AUTO CLOSED');
    expect(closed.effectivePunchOut).toBe('2026-11-22T17:30:00+05:30');
    expect(closed.actualPunchOut).toBeNull();
    expect(closed.overtimeMinutes).toBe(0);
    expect(closed.earlyOtMinutes).toBe(0);
    expect(closed.postShiftOtMinutes).toBe(0);
    expect(closed.earlyOtFinalized).toBe(false);
    expect(closed.firstPunchIn).toBe(originalFirstIn);
    expect(closed.autoCloseEventId).toBeTruthy();

    // Auto-close event persisted in punch_events & punch_logs
    const punchEvents = Object.values(db.getRawCollection('punch_events'));
    expect(punchEvents.some((e) => e.id === closed.autoCloseEventId && e.status === 'AUTO_CLOSE')).toBe(true);
    const punchLogs = Object.values(db.getRawCollection('punch_logs'));
    expect(punchLogs.some((l) => l.employeeId === 'AC001' && l.action === 'AUTO_CLOSE')).toBe(true);
  });

  // Case 2: Night Shift employee with no Punch-Out is auto-closed at 04:30 AM next day.
  it('2. Auto-closes Night Shift employee at 04:30 AM next calendar day (D+1) IST with zero OT', async () => {
    vi.setSystemTime(new Date('2026-11-22T20:00:00+05:30'));
    const inRes = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_AC002_VALID', scannerType: 'IN' });
    expect(inRes.status).toBe(200);
    expect(inRes.body.attendance.shiftId).toBe('NIGHT');
    expect(inRes.body.attendance.shiftDate).toBe('2026-11-22');

    // 04:29:59 AM on D+1 -> still open
    vi.setSystemTime(new Date('2026-11-23T04:29:59+05:30'));
    const earlyCheck = await request(app)
      .post('/api/attendance/auto-close')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(earlyCheck.status).toBe(200);
    expect(earlyCheck.body.closedCount).toBe(0);

    // 04:30:00 AM on D+1 -> auto-closed at 2026-11-23T04:30:00+05:30
    vi.setSystemTime(new Date('2026-11-23T04:30:00+05:30'));
    const nightClose = await request(app)
      .post('/api/attendance/auto-close')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(nightClose.status).toBe(200);
    expect(nightClose.body.closedCount).toBe(1);

    const closed = nightClose.body.closedRecords[0];
    expect(closed.shiftId).toBe('NIGHT');
    expect(closed.shiftDate).toBe('2026-11-22');
    expect(closed.punchOutType).toBe('AUTO');
    expect(closed.autoClosed).toBe(true);
    expect(closed.missedPunchOut).toBe(true);
    expect(closed.attendanceStatus).toBe('AUTO CLOSED');
    expect(closed.effectivePunchOut).toBe('2026-11-23T04:30:00+05:30');
    expect(closed.overtimeMinutes).toBe(0);
    expect(closed.earlyOtMinutes).toBe(0);
    expect(closed.postShiftOtMinutes).toBe(0);
    expect(closed.earlyOtFinalized).toBe(false);
  });

  // Case 3: Auto-Closed employee later performs a genuine Punch-Out; AUTO CLOSED is reconciled to ACTUAL.
  it('3. Reconciles provisional AUTO CLOSED attendance to ACTUAL on genuine subsequent Punch-Out with recalculated OT and preserved audit trail', async () => {
    vi.setSystemTime(new Date('2026-11-22T08:00:00+05:30')); // 60m early for Day Shift
    const inRes = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_AC003_VALID', scannerType: 'IN' });
    expect(inRes.status).toBe(200);
    const originalFirstIn = inRes.body.attendance.firstPunchIn;

    // Provisional Auto-Close fires at 05:30 PM
    vi.setSystemTime(new Date('2026-11-22T17:30:05+05:30'));
    const autoCloseRes = await request(app)
      .post('/api/attendance/auto-close')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(autoCloseRes.status).toBe(200);
    expect(autoCloseRes.body.closedCount).toBe(1);
    const autoCloseEventId = autoCloseRes.body.closedRecords[0].autoCloseEventId;

    // Employee genuinely scans OUT at 07:00 PM (1h30m post-shift OT + 1h00m early OT = 2h30m = 150m total OT)
    vi.setSystemTime(new Date('2026-11-22T19:00:00+05:30'));
    const actualOutRes = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_AC003_VALID', scannerType: 'OUT' });
    expect(actualOutRes.status).toBe(200);
    expect(actualOutRes.body.success).toBe(true);
    expect(actualOutRes.body.reconciledFromAutoClose).toBe(true);

    const rec = actualOutRes.body.attendance;
    expect(rec.punchOutType).toBe('ACTUAL');
    expect(rec.autoClosed).toBe(false);
    expect(rec.missedPunchOut).toBe(false);
    expect(rec.reconciledFromAutoClose).toBe(true);
    expect(rec.firstPunchIn).toBe(originalFirstIn);
    expect(rec.actualPunchOut).toBe(new Date('2026-11-22T19:00:00+05:30').toISOString());
    expect(rec.effectivePunchOut).toBe(rec.actualPunchOut);
    expect(rec.regularDutyMinutes).toBe(510);
    expect(rec.earlyOtMinutes).toBe(60);
    expect(rec.postShiftOtMinutes).toBe(90);
    expect(rec.overtimeMinutes).toBe(150);
    expect(rec.totalDutyMinutes).toBe(660);
    expect(rec.attendanceStatus).toBe('COMPLETED + OT');
    expect(rec.autoCloseEventId).toBe(autoCloseEventId);

    // Both AUTO_CLOSE and RECONCILED_ACTUAL_OUT events exist in punch_events
    const events = Object.values(db.getRawCollection('punch_events')).filter((e) => e.employeeId === 'AC003');
    expect(events.some((e) => e.status === 'AUTO_CLOSE' && e.id === autoCloseEventId)).toBe(true);
    expect(events.some((e) => e.status === 'RECONCILED_ACTUAL_OUT' && e.reconciledFromAutoClose === true)).toBe(true);

    // Reconciliation audit log exists
    const audits = Object.values(db.getRawCollection('audit_logs')).filter(
      (a) => a.action === 'RECONCILE_AUTO_CLOSED_PUNCH_OUT' && a.employeeId === 'AC003'
    );
    expect(audits).toHaveLength(1);
  });

  // Case 4: Actual Punch-Out before Auto-Close prevents Auto-Close from overwriting it.
  it('4. Prevents Auto-Close from overwriting an already committed Actual Punch-Out', async () => {
    vi.setSystemTime(new Date('2026-11-22T09:00:00+05:30'));
    await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_AC004_VALID', scannerType: 'IN' });

    // Employee punches out at 05:20 PM (before 05:30 PM auto-close)
    vi.setSystemTime(new Date('2026-11-22T17:20:00+05:30'));
    const outRes = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_AC004_VALID', scannerType: 'OUT' });
    expect(outRes.status).toBe(200);
    expect(outRes.body.attendance.punchOutType).toBe('ACTUAL');
    const savedOutIso = outRes.body.attendance.actualPunchOut;

    // Auto-Close runs at 06:00 PM -> must NOT touch AC004
    vi.setSystemTime(new Date('2026-11-22T18:00:00+05:30'));
    const autoCloseRes = await request(app)
      .post('/api/attendance/auto-close')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(autoCloseRes.status).toBe(200);
    expect(autoCloseRes.body.closedCount).toBe(0);

    const stored = (await db.collection('attendance').doc('att_AC004_2026-11-22_DAY').get()).data()!;
    expect(stored.punchOutType).toBe('ACTUAL');
    expect(stored.autoClosed).toBe(false);
    expect(stored.actualPunchOut).toBe(savedOutIso);
    expect(stored.attendanceStatus).toBe('HALF DAY'); // 500 mins
  });

  // Case 5: Duplicate Punch-Out is rejected (both normal ACTUAL and post-reconciliation ACTUAL).
  it('5. Rejects duplicate Punch-Out after normal ACTUAL close AND after Auto-Close reconciliation', async () => {
    vi.setSystemTime(new Date('2026-11-22T09:00:00+05:30'));
    await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_AC005_VALID', scannerType: 'IN' });

    // Auto-close at 05:30 PM
    vi.setSystemTime(new Date('2026-11-22T17:30:05+05:30'));
    await request(app)
      .post('/api/attendance/auto-close')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    // First genuine Punch-Out at 06:30 PM reconciles successfully
    vi.setSystemTime(new Date('2026-11-22T18:30:00+05:30'));
    const firstOut = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_AC005_VALID', scannerType: 'OUT' });
    expect(firstOut.status).toBe(200);
    expect(firstOut.body.reconciledFromAutoClose).toBe(true);

    // Second duplicate Punch-Out at 06:45 PM MUST be rejected (409)
    vi.setSystemTime(new Date('2026-11-22T18:45:00+05:30'));
    const dupOut = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_AC005_VALID', scannerType: 'OUT' });
    expect(dupOut.status).toBe(409);
    expect(dupOut.body.success).toBe(false);
    expect(dupOut.body.action).toBe('REJECTED_DUPLICATE');
  });

  // Case 6 & 7: Early OT < 60m is zero; Early OT == 60m qualifies only after required duty completion.
  it('6 & 7. Enforces Option A Early OT (<60m = 0; >=60m qualifies only when 510m regular duty is completed)', async () => {
    const bounds = resolveShiftScheduleBounds('2026-11-22', {
      id: 'DAY',
      startTime: '09:00',
      endTime: '17:30',
      isOvernight: false,
    });

    // Case 6: 59 minutes early (08:01 AM -> 05:30 PM) => 0 Early OT
    const below60 = evaluateOptionAPunchOut({
      firstInIso: '2026-11-22T08:01:00+05:30',
      lastOutIso: '2026-11-22T17:30:00+05:30',
      scheduledStartIso: bounds.scheduledStartIso,
      scheduledEndIso: bounds.scheduledEndIso,
    });
    expect(below60.earlyArrivalMinutes).toBe(59);
    expect(below60.earlyOtMinutes).toBe(0);
    expect(below60.overtimeMinutes).toBe(0);
    expect(below60.totalDutyMinutes).toBe(510);
    expect(below60.attendanceStatus).toBe('COMPLETED');

    // Case 7a: 60m early (08:00 AM -> 05:00 PM) -> incomplete regular duty (480m < 510m) => Early OT forfeited!
    const earlyIncomplete = evaluateOptionAPunchOut({
      firstInIso: '2026-11-22T08:00:00+05:30',
      lastOutIso: '2026-11-22T17:00:00+05:30',
      scheduledStartIso: bounds.scheduledStartIso,
      scheduledEndIso: bounds.scheduledEndIso,
    });
    expect(earlyIncomplete.earlyArrivalMinutes).toBe(60);
    expect(earlyIncomplete.earlyOtMinutes).toBe(0);
    expect(earlyIncomplete.overtimeMinutes).toBe(0);
    expect(earlyIncomplete.regularDutyMinutes).toBe(480);
    expect(earlyIncomplete.attendanceStatus).toBe('HALF DAY');

    // Case 7b: 60m early (08:00 AM -> 05:30 PM) -> completed 510m regular duty => 60m Early OT awarded!
    const earlyComplete = evaluateOptionAPunchOut({
      firstInIso: '2026-11-22T08:00:00+05:30',
      lastOutIso: '2026-11-22T17:30:00+05:30',
      scheduledStartIso: bounds.scheduledStartIso,
      scheduledEndIso: bounds.scheduledEndIso,
    });
    expect(earlyComplete.earlyArrivalMinutes).toBe(60);
    expect(earlyComplete.earlyOtMinutes).toBe(60);
    expect(earlyComplete.overtimeMinutes).toBe(60);
    expect(earlyComplete.totalDutyMinutes).toBe(570);
    expect(earlyComplete.attendanceStatus).toBe('COMPLETED + OT');
  });

  // Case 8, 9 & 10: Max OT = 210m, Max Total Credited Duty = 720m, and actual Punch-Out timestamp preserved.
  it('8, 9 & 10. Caps Early OT + Post-Shift OT at 210m (03:30), total credited duty at 720m (12:00), and preserves real Punch-Out timestamp', async () => {
    expect(MAX_REGULAR_DUTY_MINUTES).toBe(510);
    expect(MAX_TOTAL_OT_MINUTES).toBe(210);
    expect(MAX_CREDITED_TOTAL_MINUTES).toBe(720);

    // Day Shift: 07:00 AM IN (120m early) -> 10:30 PM OUT (300m raw post-shift; 420m raw total OT; 15h30m actual presence)
    vi.setSystemTime(new Date('2026-11-22T07:00:00+05:30'));
    const inRes = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_AC006_VALID', scannerType: 'IN' });
    expect(inRes.status).toBe(200);

    // Verify expected Punch-Out schedule for 07:00 AM early arrival (120m Early OT -> 90m remaining Post-Shift OT -> Max Eligible Out = 07:00 PM)
    expect(inRes.body.punchOutSchedule.scheduledShiftEndDisplay).toBe('05:30 PM');
    expect(inRes.body.punchOutSchedule.regularDutyCompletionDisplay).toBe('05:30 PM');
    expect(inRes.body.punchOutSchedule.maxEligiblePunchOutDisplay).toBe('07:00 PM');
    expect(inRes.body.punchOutSchedule.maxOtDisplay).toBe('03:30 Hours');
    expect(inRes.body.punchOutSchedule.maxCreditedWorkingDisplay).toBe('12:00 Hours');

    const actualLateOutIso = new Date('2026-11-22T22:30:00+05:30').toISOString();
    vi.setSystemTime(new Date('2026-11-22T22:30:00+05:30'));
    const outRes = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_AC006_VALID', scannerType: 'OUT' });
    expect(outRes.status).toBe(200);

    const rec = outRes.body.attendance;
    expect(rec.regularDutyMinutes).toBe(510);
    expect(rec.earlyOtMinutes).toBe(120);
    expect(rec.postShiftOtMinutes).toBe(90); // 210 - 120 = 90 remaining OT budget
    expect(rec.overtimeMinutes).toBe(210);
    expect(rec.totalOtMinutes).toBe(210);
    expect(rec.totalDutyMinutes).toBe(720);
    expect(rec.otCapApplied).toBe(true);
    expect(rec.actualPresenceMinutes).toBe(930); // 15h30m real presence preserved
    expect(rec.actualPunchOut).toBe(actualLateOutIso); // Actual Punch-Out timestamp preserved!
    expect(rec.effectivePunchOut).toBe(actualLateOutIso);
    expect(rec.attendanceStatus).toBe('COMPLETED + OT');

    // Pure post-shift cap check (09:00 AM -> 11:00 PM = 14h presence) -> 510 regular + 210 post OT = 720 total
    const purePostCap = evaluateOptionAPunchOut({
      firstInIso: '2026-11-22T09:00:00+05:30',
      lastOutIso: '2026-11-22T23:00:00+05:30',
      scheduledStartIso: '2026-11-22T09:00:00+05:30',
      scheduledEndIso: '2026-11-22T17:30:00+05:30',
    });
    expect(purePostCap.regularDutyMinutes).toBe(510);
    expect(purePostCap.earlyOtMinutes).toBe(0);
    expect(purePostCap.postShiftOtMinutes).toBe(210);
    expect(purePostCap.totalOtMinutes).toBe(210);
    expect(purePostCap.totalDutyMinutes).toBe(720);
    expect(purePostCap.otCapApplied).toBe(true);
  });

  // Case 11: Night Shift actual Punch-Out after 09:00 AM is correctly attached to previous night's attendance.
  it('11. Attaches Night Shift actual Punch-Out after 09:00 AM (both open and post-auto-close) to previous night attendance', async () => {
    // Employee AC007: Night Shift on 2026-11-22 (late start 21:30 PM), stays open, punches out at 09:30 AM next day (2026-11-23)
    vi.setSystemTime(new Date('2026-11-22T21:30:00+05:30'));
    const inOpen = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_AC007_VALID', scannerType: 'IN' });
    expect(inOpen.status).toBe(200);
    expect(inOpen.body.attendance.shiftDate).toBe('2026-11-22');
    // Verify expected Punch-Out schedule for 09:30 PM late Night Shift start:
    // Regular ends at 06:00 AM, Max Eligible Out = 09:30 AM!
    expect(inOpen.body.punchOutSchedule.scheduledShiftEndDisplay).toBe('04:30 AM');
    expect(inOpen.body.punchOutSchedule.regularDutyCompletionDisplay).toBe('06:00 AM');
    expect(inOpen.body.punchOutSchedule.maxEligiblePunchOutDisplay).toBe('09:30 AM');

    // Employee AC008: Night Shift on 2026-11-22 (20:00 PM), gets auto-closed at 04:30 AM, then punches out at 10:15 AM on 2026-11-23
    vi.setSystemTime(new Date('2026-11-22T20:00:00+05:30'));
    const inAuto = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_AC008_VALID', scannerType: 'IN' });
    expect(inAuto.status).toBe(200);

    // Run Auto-Close at 04:31 AM on 2026-11-23 -> closes BOTH AC007 and AC008 provisionally
    vi.setSystemTime(new Date('2026-11-23T04:31:00+05:30'));
    const autoRes = await request(app)
      .post('/api/attendance/auto-close')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(autoRes.status).toBe(200);
    expect(autoRes.body.closedCount).toBe(2);

    // AC007 punches out at 09:30 AM on 2026-11-23 -> reconciles 2026-11-22 NIGHT shift (510 regular + 210 post OT = 720)
    vi.setSystemTime(new Date('2026-11-23T09:30:00+05:30'));
    const out7 = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_AC007_VALID', scannerType: 'OUT' });
    expect(out7.status).toBe(200);
    expect(out7.body.reconciledFromAutoClose).toBe(true);
    expect(out7.body.attendance.id).toBe('att_AC007_2026-11-22_NIGHT');
    expect(out7.body.attendance.shiftDate).toBe('2026-11-22');
    expect(out7.body.attendance.shiftId).toBe('NIGHT');
    expect(out7.body.attendance.regularDutyMinutes).toBe(510);
    expect(out7.body.attendance.overtimeMinutes).toBe(210);
    expect(out7.body.attendance.totalDutyMinutes).toBe(720);

    // AC008 punches out at 10:15 AM on 2026-11-23 -> reconciles 2026-11-22 NIGHT shift (capped at 210m OT / 720m total; real 10:15 AM timestamp preserved)
    vi.setSystemTime(new Date('2026-11-23T10:15:00+05:30'));
    const out8 = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_AC008_VALID', scannerType: 'OUT' });
    expect(out8.status).toBe(200);
    expect(out8.body.reconciledFromAutoClose).toBe(true);
    expect(out8.body.attendance.id).toBe('att_AC008_2026-11-22_NIGHT');
    expect(out8.body.attendance.shiftDate).toBe('2026-11-22');
    expect(out8.body.attendance.actualPunchOut).toBe(new Date('2026-11-23T10:15:00+05:30').toISOString());
    expect(out8.body.attendance.overtimeMinutes).toBe(210);
    expect(out8.body.attendance.totalDutyMinutes).toBe(720);

    // Also test an OPEN (non-auto-closed) Night Shift Punch-Out at 09:45 AM on 2026-11-23
    vi.setSystemTime(new Date('2026-11-22T20:00:00+05:30'));
    await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_AC009_VALID', scannerType: 'IN' });

    vi.setSystemTime(new Date('2026-11-23T09:45:00+05:30'));
    const out9 = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_AC009_VALID', scannerType: 'OUT' });
    expect(out9.status).toBe(200);
    expect(out9.body.attendance.id).toBe('att_AC009_2026-11-22_NIGHT');
    expect(out9.body.attendance.shiftDate).toBe('2026-11-22');
    expect(out9.body.attendance.overtimeMinutes).toBe(210);
    expect(out9.body.attendance.totalDutyMinutes).toBe(720);

    // Verify NO accidental 2026-11-23 attendance record was created for AC007, AC008, or AC009
    const allAtt = Object.values(db.getRawCollection('attendance'));
    expect(allAtt.filter((a) => a.shiftDate === '2026-11-23')).toHaveLength(0);
  });

  // Case 12: Auto-Close without actual Punch-Out remains AUTO CLOSED with zero OT.
  it('12. Keeps Auto-Closed attendance permanently AUTO CLOSED with strictly 0 OT when no genuine Punch-Out arrives', async () => {
    vi.setSystemTime(new Date('2026-11-22T07:30:00+05:30')); // 90m early
    await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_AC010_VALID', scannerType: 'IN' });

    vi.setSystemTime(new Date('2026-11-22T17:35:00+05:30'));
    const auto1 = await request(app)
      .post('/api/attendance/auto-close')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(auto1.body.closedCount).toBe(1);

    // Running auto-close again later is idempotent (0 newly closed)
    vi.setSystemTime(new Date('2026-11-22T22:00:00+05:30'));
    const auto2 = await request(app)
      .post('/api/attendance/auto-close')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(auto2.body.closedCount).toBe(0);

    const stored = (await db.collection('attendance').doc('att_AC010_2026-11-22_DAY').get()).data()!;
    const resolved = resolveAttendanceMetrics(stored);
    expect(stored.attendanceStatus).toBe('AUTO CLOSED');
    expect(stored.punchOutType).toBe('AUTO');
    expect(stored.autoClosed).toBe(true);
    expect(stored.overtimeMinutes).toBe(0);
    expect(stored.earlyOtMinutes).toBe(0);
    expect(resolved.status).toBe('AUTO CLOSED');
    expect(resolved.overtimeMinutes).toBe(0);
    expect(resolved.earlyOtMinutes).toBe(0);
    expect(resolved.completedDutyMinutes).toBe(STANDARD_DUTY_MINUTES);
  });

  // Case 13: Concurrent Auto-Close and Punch-Out cannot corrupt attendance.
  it('13. Handles concurrent Auto-Close and Actual Punch-Out safely without corrupting attendance or duplicating closures', async () => {
    vi.setSystemTime(new Date('2026-11-22T09:00:00+05:30'));
    await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_AC011_VALID', scannerType: 'IN' });

    // Fire Auto-Close + Actual Punch-Out + duplicate Auto-Close + duplicate Actual Punch-Out simultaneously at 06:30 PM!
    vi.setSystemTime(new Date('2026-11-22T18:30:00+05:30'));
    const [autoA, outA, autoB, outB] = await Promise.all([
      request(app).post('/api/attendance/auto-close').set('Authorization', `Bearer ${adminToken}`).send({}),
      request(app).post('/api/attendance/scan').set('Authorization', `Bearer ${adminToken}`).send({ rawPayload: 'QR_AC011_VALID', scannerType: 'OUT' }),
      request(app).post('/api/attendance/auto-close').set('Authorization', `Bearer ${adminToken}`).send({}),
      request(app).post('/api/attendance/scan').set('Authorization', `Bearer ${adminToken}`).send({ rawPayload: 'QR_AC011_VALID', scannerType: 'OUT' }),
    ]);

    expect(autoA.status).toBe(200);
    expect(autoB.status).toBe(200);

    // Strictly ONE actual Punch-Out succeeds (200), the second duplicate Punch-Out is rejected (409/429)
    const outStatuses = [outA.status, outB.status].sort();
    expect(outStatuses[0]).toBe(200);
    expect([409, 429]).toContain(outStatuses[1]);

    // Regardless of whether Auto-Close or Actual Punch-Out acquired the lock first,
    // final persisted record MUST be clean ACTUAL with 60m Post-Shift OT and original Punch-In preserved!
    const stored = (await db.collection('attendance').doc('att_AC011_2026-11-22_DAY').get()).data()!;
    expect(stored.punchOutType).toBe('ACTUAL');
    expect(stored.autoClosed).toBe(false);
    expect(stored.missedPunchOut).toBe(false);
    expect(stored.actualPunchOut).toBe(new Date('2026-11-22T18:30:00+05:30').toISOString());
    expect(stored.regularDutyMinutes).toBe(510);
    expect(stored.overtimeMinutes).toBe(60);
    expect(stored.totalDutyMinutes).toBe(570);
    expect(stored.attendanceStatus).toBe('COMPLETED + OT');
    expect(stored.firstPunchIn).toBe(new Date('2026-11-22T09:00:00+05:30').toISOString());
    // Must never have more than 1 ACTUAL OUT event in punches
    expect(stored.punches.filter((p: any) => p.eventType === 'OUT')).toHaveLength(1);
  });

  // Case 14: Admin correction and attendance reports/dashboard remain consistent.
  it('14. Keeps Admin correction, Dashboard summary, and resolveAttendanceMetrics consistent after Auto-Close and OT caps', async () => {
    vi.setSystemTime(new Date('2026-11-22T08:00:00+05:30')); // 60m early
    await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_AC012_VALID', scannerType: 'IN' });

    // Auto-close at 05:30 PM
    vi.setSystemTime(new Date('2026-11-22T17:31:00+05:30'));
    await request(app)
      .post('/api/attendance/auto-close')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    // Admin manually corrects AUTO CLOSED record to ACTUAL with 10:00 PM punch-out (raw OT = 60m early + 270m post = 330m -> MUST cap at 210m!)
    const corrRes = await request(app)
      .post('/api/attendance/correct')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        attendanceId: 'att_AC012_2026-11-22_DAY',
        actualPunchOut: '2026-11-22T22:00:00+05:30',
        punchOutType: 'ACTUAL',
        attendanceStatus: 'COMPLETED + OT',
        reason: 'Verified physical exit register at gate',
      });
    expect(corrRes.status).toBe(200);
    const corrected = corrRes.body.record;
    expect(corrected.punchOutType).toBe('ACTUAL');
    expect(corrected.autoClosed).toBe(false);
    expect(corrected.missedPunchOut).toBe(false);
    expect(corrected.regularDutyMinutes).toBe(510);
    expect(corrected.earlyOtMinutes).toBe(60);
    expect(corrected.postShiftOtMinutes).toBe(150);
    expect(corrected.overtimeMinutes).toBe(210);
    expect(corrected.totalDutyMinutes).toBe(720);
    expect(corrected.otCapApplied).toBe(true);
    expect(corrected.attendanceStatus).toBe('COMPLETED + OT');

    // resolveAttendanceMetrics (used by AttendanceHistory & Reports) matches backend 100%
    const reportMetrics = resolveAttendanceMetrics(corrected);
    expect(reportMetrics.status).toBe('COMPLETED + OT');
    expect(reportMetrics.regularDutyMinutes).toBe(510);
    expect(reportMetrics.earlyOtMinutes).toBe(60);
    expect(reportMetrics.postShiftOtMinutes).toBe(150);
    expect(reportMetrics.overtimeMinutes).toBe(210);
    expect(reportMetrics.completedDutyMinutes).toBe(720);

    // Dashboard summary reflects corrected duty (720) & OT (210) and autoClosed = 0
    const dashRes = await request(app)
      .get('/api/dashboard/summary?date=2026-11-22')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(dashRes.status).toBe(200);
    expect(dashRes.body.metrics.autoClosed).toBe(0);
    expect(dashRes.body.metrics.dutyHoursMins).toBe(720);
    expect(dashRes.body.metrics.otHoursMins).toBe(210);
  });

  // Verification of Punch-Out Time Display calculations across Day/Night early/normal/late scenarios
  it('computes accurate Scheduled End, Regular Duty Completion, and Max Eligible Punch-Out times without blindly adding 12h', () => {
    // Day Early < 60m (08:30 AM): 0 Early OT -> Shift anchor 09:00 -> Regular done 05:30 PM -> Max Eligible Out 09:00 PM (NOT 08:30 PM!)
    const dayEarly30 = computeExpectedPunchOutTimes({
      firstInIso: '2026-11-22T08:30:00+05:30',
      scheduledStartIso: '2026-11-22T09:00:00+05:30',
      scheduledEndIso: '2026-11-22T17:30:00+05:30',
    })!;
    expect(dayEarly30.scheduledShiftEndDisplay).toBe('05:30 PM');
    expect(dayEarly30.regularDutyCompletionDisplay).toBe('05:30 PM');
    expect(dayEarly30.maxEligiblePunchOutDisplay).toBe('09:00 PM');
    expect(dayEarly30.eligibleEarlyOtMinutes).toBe(0);
    expect(dayEarly30.remainingPostShiftOtMinutes).toBe(210);

    // Day Early 60m (08:00 AM): 60m Early OT -> 150m remaining Post OT -> Max Eligible Out 08:00 PM
    const dayEarly60 = computeExpectedPunchOutTimes({
      firstInIso: '2026-11-22T08:00:00+05:30',
      scheduledStartIso: '2026-11-22T09:00:00+05:30',
      scheduledEndIso: '2026-11-22T17:30:00+05:30',
    })!;
    expect(dayEarly60.regularDutyCompletionDisplay).toBe('05:30 PM');
    expect(dayEarly60.maxEligiblePunchOutDisplay).toBe('08:00 PM');
    expect(dayEarly60.eligibleEarlyOtMinutes).toBe(60);
    expect(dayEarly60.remainingPostShiftOtMinutes).toBe(150);

    // Day Late 30m (09:30 AM): Regular ends 06:00 PM -> Max Eligible Out 09:30 PM
    const dayLate30 = computeExpectedPunchOutTimes({
      firstInIso: '2026-11-22T09:30:00+05:30',
      scheduledStartIso: '2026-11-22T09:00:00+05:30',
      scheduledEndIso: '2026-11-22T17:30:00+05:30',
    })!;
    expect(dayLate30.scheduledShiftEndDisplay).toBe('05:30 PM');
    expect(dayLate30.regularDutyCompletionDisplay).toBe('06:00 PM');
    expect(dayLate30.maxEligiblePunchOutDisplay).toBe('09:30 PM');

    // Night Normal (08:00 PM): Scheduled End 04:30 AM, Regular Ends 04:30 AM, Max Eligible Out 08:00 AM
    const nightNormal = computeExpectedPunchOutTimes({
      firstInIso: '2026-11-22T20:00:00+05:30',
      scheduledStartIso: '2026-11-22T20:00:00+05:30',
      scheduledEndIso: '2026-11-23T04:30:00+05:30',
    })!;
    expect(nightNormal.scheduledShiftEndDisplay).toBe('04:30 AM');
    expect(nightNormal.regularDutyCompletionDisplay).toBe('04:30 AM');
    expect(nightNormal.maxEligiblePunchOutDisplay).toBe('08:00 AM');
  });
});
