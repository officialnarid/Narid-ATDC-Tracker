import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ExcelJS from 'exceljs';
import { createApp } from '../server.ts';
import {
  InMemoryAdminAuth,
  InMemoryFirestore,
  TEST_CANONICAL_ACCOUNTS,
  seedIsolatedTestEnvironment,
} from './helpers/inMemoryAdmin.ts';
import type { AttendanceRecord, Department, Employee, Floor, Section } from '../src/types';
import {
  detectAttendanceCalculationDiscrepancy,
  evaluateAutoCloseDuty,
  evaluateOptionAPunchOut,
  formatDurationClock,
  resolveAttendanceMetrics,
} from '../src/utils/attendanceStatus';
import {
  ATTENDANCE_HISTORY_EXPORT_COLUMNS,
  PRIMARY_ATTENDANCE_REPORT_COLUMNS,
  buildAttendanceHistoryExportRows,
  buildAttendanceReportTable,
  computeAttendanceReportSummary,
} from '../src/utils/attendanceReportBuilder';
import { buildPremiumExcelWorkbookBuffer } from '../src/utils/excelReportExporter';
import { buildCsvContent } from '../src/services/exportService';
import { Reports } from '../src/components/Reports';

const EXPECTED_16_HEADERS = [
  'Employee ID',
  'Name',
  'Line',
  'Department',
  'Attendance Date',
  'Shift',
  'Scheduled Shift Start',
  'Scheduled Shift End',
  'Actual Punch-In',
  'Actual Punch-Out',
  'Auto-Close Time',
  'Attendance Status',
  'Auto-Close Recorded At',
  'Duty Hours',
  'OT Hours',
  'Total Working Hours',
];

describe('NARID ATDC Tracker — Attendance Calculation Correction & Premium Excel Export (15 Mandatory Cases)', () => {
  let app: ReturnType<typeof createApp>['app'];
  let db: InMemoryFirestore;
  let auth: InMemoryAdminAuth;
  let adminToken: string;

  const floors: Floor[] = [{ id: 'f1', name: 'MI-01', code: 'MI01', order: 1, status: 'Active' }];
  const sections: Section[] = [{ id: 's1', name: 'MI', code: 'MI', floorId: 'f1', status: 'Active' }];
  const departments: Department[] = [{ id: 'd1', name: 'Production', code: 'PROD', status: 'Active' }];
  const activeEmps: Employee[] = [];

  beforeEach(async () => {
    vi.useFakeTimers();
    db = new InMemoryFirestore();
    auth = new InMemoryAdminAuth();
    await seedIsolatedTestEnvironment(db, auth);
    activeEmps.length = 0;

    for (let i = 1; i <= 11; i++) {
      const id = `TC${String(i).padStart(2, '0')}`;
      const emp: Employee = {
        employeeId: id,
        employeeName: `Test Employee ${i}`,
        employeeType: 'Permanent',
        section: 'MI',
        department: 'Production',
        floor: 'MI-01',
        designation: 'Operator',
        qrCodeToken: `QR_${id}_VALID`,
        employeeStatus: 'Active',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      };
      activeEmps.push(emp);
      await db.collection('employees').doc(id).set({ id, ...emp });
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

  // Case 1
  it('1. Day Shift 09:00 AM Punch-In, Auto-Close 05:30 PM -> Duty 08:30, OT 00:00, Total 08:30', async () => {
    vi.setSystemTime(new Date('2026-11-23T09:00:00+05:30'));
    await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_TC01_VALID', scannerType: 'IN' });

    vi.setSystemTime(new Date('2026-11-23T17:31:00+05:30'));
    const autoRes = await request(app)
      .post('/api/attendance/auto-close')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    expect(autoRes.status).toBe(200);
    const rec = autoRes.body.closedRecords.find((r: AttendanceRecord) => r.employeeId === 'TC01');
    expect(rec.attendanceStatus).toBe('AUTO CLOSED');
    expect(rec.regularDutyMinutes).toBe(510);
    expect(rec.overtimeMinutes).toBe(0);
    expect(rec.totalDutyMinutes).toBe(510);

    const m = resolveAttendanceMetrics(rec, Date.now());
    expect(formatDurationClock(m.regularDutyMinutes)).toBe('08:30');
    expect(formatDurationClock(m.overtimeMinutes)).toBe('00:00');
    expect(formatDurationClock(m.completedDutyMinutes)).toBe('08:30');
  });

  // Case 2
  it('2. Day Shift 10:00 AM Punch-In, Auto-Close 05:30 PM -> Duty 07:30, OT 00:00, Total 07:30', async () => {
    vi.setSystemTime(new Date('2026-11-23T10:00:00+05:30'));
    await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_TC02_VALID', scannerType: 'IN' });

    vi.setSystemTime(new Date('2026-11-23T17:31:00+05:30'));
    const autoRes = await request(app)
      .post('/api/attendance/auto-close')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    const rec = autoRes.body.closedRecords.find((r: AttendanceRecord) => r.employeeId === 'TC02');
    expect(rec.attendanceStatus).toBe('AUTO CLOSED');
    expect(rec.regularDutyMinutes).toBe(450); // 07:30
    expect(rec.overtimeMinutes).toBe(0);
    expect(rec.totalDutyMinutes).toBe(450);

    const m = resolveAttendanceMetrics(rec, Date.now());
    expect(formatDurationClock(m.regularDutyMinutes)).toBe('07:30');
    expect(formatDurationClock(m.overtimeMinutes)).toBe('00:00');
    expect(formatDurationClock(m.completedDutyMinutes)).toBe('07:30');
  });

  // Cases 3 & 4 (Mandatory User Example)
  it('3 & 4. Day Shift 12:30 PM Punch-In -> Auto-Close 05:30 PM (05:00/00:00/05:00) -> Later Actual Punch-Out 07:30 PM (05:00 Duty, 02:00 Post-Shift OT, 07:00 Total, reconciled from AUTO CLOSED)', async () => {
    vi.setSystemTime(new Date('2026-11-23T12:30:00+05:30'));
    const inRes = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_TC03_VALID', scannerType: 'IN' });
    expect(inRes.status).toBe(200);

    // Case 3: Auto-Close at 05:30 PM
    vi.setSystemTime(new Date('2026-11-23T17:32:00+05:30'));
    const autoRes = await request(app)
      .post('/api/attendance/auto-close')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(autoRes.status).toBe(200);
    const autoRec = autoRes.body.closedRecords.find((r: AttendanceRecord) => r.employeeId === 'TC03');
    expect(autoRec.attendanceStatus).toBe('AUTO CLOSED');
    expect(autoRec.punchOutType).toBe('AUTO');
    expect(autoRec.regularDutyMinutes).toBe(300); // 05:00
    expect(autoRec.overtimeMinutes).toBe(0);
    expect(autoRec.totalDutyMinutes).toBe(300);

    const autoMetrics = resolveAttendanceMetrics(autoRec, Date.now());
    expect(formatDurationClock(autoMetrics.regularDutyMinutes)).toBe('05:00');
    expect(formatDurationClock(autoMetrics.overtimeMinutes)).toBe('00:00');
    expect(formatDurationClock(autoMetrics.completedDutyMinutes)).toBe('05:00');
    expect(autoMetrics.status).toBe('AUTO CLOSED');
    expect(autoMetrics.actualPunchOutDisplay).toBe('N/A');
    expect(autoMetrics.autoCloseTimeDisplay).toBe('05:30 PM');

    // Case 4: Same employee later performs genuine Actual Punch-Out at 07:30 PM
    vi.setSystemTime(new Date('2026-11-23T19:30:00+05:30'));
    const outRes = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_TC03_VALID', scannerType: 'OUT' });
    expect(outRes.status).toBe(200);
    expect(outRes.body.reconciledFromAutoClose).toBe(true);

    const actualRec = outRes.body.attendance as AttendanceRecord;
    expect(actualRec.punchOutType).toBe('ACTUAL');
    expect(actualRec.autoClosed).toBe(false);
    expect(actualRec.missedPunchOut).toBe(false);
    expect(actualRec.attendanceStatus).not.toBe('AUTO CLOSED');
    expect(actualRec.attendanceStatus).toBe('HALF DAY'); // 420m total (< 510m, >= 270m)
    expect(actualRec.regularDutyMinutes).toBe(300); // 05:00
    expect(actualRec.earlyOtMinutes).toBe(0);
    expect(actualRec.postShiftOtMinutes).toBe(120); // 02:00 (05:30 PM -> 07:30 PM)
    expect(actualRec.overtimeMinutes).toBe(120); // 02:00
    expect(actualRec.totalDutyMinutes).toBe(420); // 07:00

    const actualMetrics = resolveAttendanceMetrics(actualRec, Date.now());
    expect(formatDurationClock(actualMetrics.regularDutyMinutes)).toBe('05:00');
    expect(formatDurationClock(actualMetrics.overtimeMinutes)).toBe('02:00');
    expect(formatDurationClock(actualMetrics.completedDutyMinutes)).toBe('07:00');
    expect(actualMetrics.actualPunchOutDisplay).toBe('07:30 PM');
    expect(actualMetrics.autoCloseTimeDisplay).toBe('N/A');
  });

  // Cases 5 & 6
  it('5 & 6. Day Shift 07:00 AM Early Punch-In -> Auto-Close 05:30 PM (08:30/00:00/08:30, no Early OT) vs Actual Punch-Out 05:30 PM (08:30 Duty, 02:00 Early OT, 10:30 Total)', async () => {
    vi.setSystemTime(new Date('2026-11-23T07:00:00+05:30'));
    await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_TC05_VALID', scannerType: 'IN' });

    await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_TC06_VALID', scannerType: 'IN' });

    // TC06 performs genuine Actual Punch-Out at 05:30 PM
    vi.setSystemTime(new Date('2026-11-23T17:30:00+05:30'));
    const out6 = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_TC06_VALID', scannerType: 'OUT' });
    expect(out6.status).toBe(200);
    expect(out6.body.attendance.regularDutyMinutes).toBe(510);
    expect(out6.body.attendance.earlyOtMinutes).toBe(120);
    expect(out6.body.attendance.postShiftOtMinutes).toBe(0);
    expect(out6.body.attendance.overtimeMinutes).toBe(120);
    expect(out6.body.attendance.totalDutyMinutes).toBe(630);
    expect(out6.body.attendance.attendanceStatus).toBe('COMPLETED + OT');

    // TC05 misses Punch-Out -> Auto-Close at 05:31 PM
    vi.setSystemTime(new Date('2026-11-23T17:31:00+05:30'));
    const auto5 = await request(app)
      .post('/api/attendance/auto-close')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    const rec5 = auto5.body.closedRecords.find((r: AttendanceRecord) => r.employeeId === 'TC05');
    expect(rec5.regularDutyMinutes).toBe(510);
    expect(rec5.earlyOtMinutes).toBe(0);
    expect(rec5.overtimeMinutes).toBe(0);
    expect(rec5.totalDutyMinutes).toBe(510);
    expect(rec5.attendanceStatus).toBe('AUTO CLOSED');
  });

  // Cases 7, 8 & 9 (Including the November 2026 03:11 AM Anomaly!)
  it('7, 8 & 9. Night Shift Auto-Close: 08:00 PM -> 08:30, 09:00 PM -> 07:30, and 03:11 AM (D+1) -> 01:19 (NOT 08:30!) + Read-only Discrepancy Detector', async () => {
    // TC07: 08:00 PM on 2026-11-22
    vi.setSystemTime(new Date('2026-11-22T20:00:00+05:30'));
    await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_TC07_VALID', scannerType: 'IN' });

    // TC08: 09:00 PM on 2026-11-22
    vi.setSystemTime(new Date('2026-11-22T21:00:00+05:30'));
    await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_TC08_VALID', scannerType: 'IN' });

    // TC09: 03:11 AM on 2026-11-23 (belongs to 2026-11-22 Night Shift ending 04:30 AM on 2026-11-23)
    vi.setSystemTime(new Date('2026-11-23T03:11:00+05:30'));
    const in9 = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_TC09_VALID', scannerType: 'IN' });
    expect(in9.status).toBe(200);
    expect(in9.body.shift.id).toBe('NIGHT');
    expect(in9.body.attendance.shiftDate).toBe('2026-11-22');

    // Run Auto-Close at 04:31 AM on 2026-11-23
    vi.setSystemTime(new Date('2026-11-23T04:31:00+05:30'));
    const autoRes = await request(app)
      .post('/api/attendance/auto-close')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(autoRes.status).toBe(200);

    const rec7 = autoRes.body.closedRecords.find((r: AttendanceRecord) => r.employeeId === 'TC07');
    const rec8 = autoRes.body.closedRecords.find((r: AttendanceRecord) => r.employeeId === 'TC08');
    const rec9 = autoRes.body.closedRecords.find((r: AttendanceRecord) => r.employeeId === 'TC09');

    // Case 7: 08:00 PM -> 04:30 AM = 510m (08:30)
    expect(rec7.regularDutyMinutes).toBe(510);
    expect(rec7.overtimeMinutes).toBe(0);
    expect(rec7.totalDutyMinutes).toBe(510);

    // Case 8: 09:00 PM -> 04:30 AM = 450m (07:30)
    expect(rec8.regularDutyMinutes).toBe(450);
    expect(rec8.overtimeMinutes).toBe(0);
    expect(rec8.totalDutyMinutes).toBe(450);

    // Case 9: 03:11 AM -> 04:30 AM = 79m (01:19), NEVER 510m (08:30)!
    expect(rec9.regularDutyMinutes).toBe(79);
    expect(rec9.overtimeMinutes).toBe(0);
    expect(rec9.totalDutyMinutes).toBe(79);
    expect(formatDurationClock(rec9.regularDutyMinutes)).toBe('01:19');

    // Also verify legacy corrupted historical record (stored 510m in DB for 03:11 AM -> 04:30 AM)
    // displays 01:19 via resolveAttendanceMetrics AND is flagged by read-only discrepancy detector without DB write!
    const legacyBugRecord: AttendanceRecord = {
      ...rec9,
      regularDutyMinutes: 510,
      totalDutyMinutes: 510,
    };
    const resolvedLegacy = resolveAttendanceMetrics(legacyBugRecord, Date.now());
    expect(resolvedLegacy.regularDutyMinutes).toBe(79);
    expect(resolvedLegacy.completedDutyMinutes).toBe(79);
    expect(formatDurationClock(resolvedLegacy.regularDutyMinutes)).toBe('01:19');

    const discrepancy = detectAttendanceCalculationDiscrepancy(legacyBugRecord);
    expect(discrepancy).not.toBeNull();
    expect(discrepancy!.storedRegularDutyMinutes).toBe(510);
    expect(discrepancy!.expectedRegularDutyMinutes).toBe(79);
    expect(discrepancy!.reason).toContain('stored 08:30');
    expect(discrepancy!.reason).toContain('01:19');
  });

  // Case 10
  it('10. Night Shift 10:00 PM Punch-In, Actual Punch-Out 06:30 AM -> Duty 06:30, Post-Shift OT 02:00, Total 08:30', async () => {
    vi.setSystemTime(new Date('2026-11-22T22:00:00+05:30'));
    await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_TC10_VALID', scannerType: 'IN' });

    vi.setSystemTime(new Date('2026-11-23T06:30:00+05:30'));
    const outRes = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_TC10_VALID', scannerType: 'OUT' });
    expect(outRes.status).toBe(200);
    const rec = outRes.body.attendance as AttendanceRecord;
    expect(rec.regularDutyMinutes).toBe(390); // 10:00 PM -> 04:30 AM = 06:30
    expect(rec.postShiftOtMinutes).toBe(120); // 04:30 AM -> 06:30 AM = 02:00
    expect(rec.overtimeMinutes).toBe(120);
    expect(rec.totalDutyMinutes).toBe(510); // 08:30
    expect(rec.attendanceStatus).toBe('COMPLETED + OT');
  });

  // Case 11
  it('11. OT Cap: Total OT never exceeds 03:30 (210m) and Total Working Time never exceeds 12:00 (720m)', () => {
    // 06:30 AM -> 10:30 PM (Early arrival 150m + Regular 510m + Post-shift 300m)
    const capEval = evaluateOptionAPunchOut({
      firstInIso: '2026-11-23T06:30:00+05:30',
      lastOutIso: '2026-11-23T22:30:00+05:30',
      scheduledStartIso: '2026-11-23T09:00:00+05:30',
      scheduledEndIso: '2026-11-23T17:30:00+05:30',
    });
    expect(capEval.regularDutyMinutes).toBe(510);
    expect(capEval.totalOtMinutes).toBe(210);
    expect(capEval.totalDutyMinutes).toBe(720);
    expect(capEval.otCapApplied).toBe(true);
    expect(formatDurationClock(capEval.totalOtMinutes)).toBe('03:30');
    expect(formatDurationClock(capEval.totalDutyMinutes)).toBe('12:00');

    // Direct helper check for evaluateAutoCloseDuty early punch cap
    const autoEval = evaluateAutoCloseDuty({
      firstInIso: '2026-11-23T06:30:00+05:30',
      scheduledStartIso: '2026-11-23T09:00:00+05:30',
      scheduledEndIso: '2026-11-23T17:30:00+05:30',
    });
    expect(autoEval.regularDutyMinutes).toBe(510);
    expect(autoEval.totalOtMinutes).toBe(0);
    expect(autoEval.totalDutyMinutes).toBe(510);
  });

  // Cases 12, 13, 14 & 15
  it('12-15. Single Source of Truth Consistency + Premium ExcelJS Workbook Formatting, Print Setup, Summary KPIs, CSV, and Clean UI Render', async () => {
    // Build a realistic mixed dataset:
    // - TC01: Day 09:00 -> Auto-Close 17:30 (08:30 / 00:00 / 08:30, AUTO CLOSED)
    // - TC02: Day 12:30 -> Actual 19:30 (05:00 / 02:00 / 07:00, HALF DAY)
    // - TC03: Day 09:00 -> Actual 18:30 (08:30 / 01:00 / 09:30, COMPLETED + OT)
    // - TC04: Day 14:00 -> Actual 17:00 (03:00 / 00:00 / 03:00, SHORT LEAVE)
    // - TC05: Night 03:11 AM -> Auto-Close 04:30 AM (01:19 / 00:00 / 01:19, AUTO CLOSED)
    vi.setSystemTime(new Date('2026-11-23T09:00:00+05:30'));
    await request(app).post('/api/attendance/scan').set('Authorization', `Bearer ${adminToken}`).send({ rawPayload: 'QR_TC01_VALID', scannerType: 'IN' });
    await request(app).post('/api/attendance/scan').set('Authorization', `Bearer ${adminToken}`).send({ rawPayload: 'QR_TC03_VALID', scannerType: 'IN' });

    vi.setSystemTime(new Date('2026-11-23T12:30:00+05:30'));
    await request(app).post('/api/attendance/scan').set('Authorization', `Bearer ${adminToken}`).send({ rawPayload: 'QR_TC02_VALID', scannerType: 'IN' });

    vi.setSystemTime(new Date('2026-11-23T14:00:00+05:30'));
    await request(app).post('/api/attendance/scan').set('Authorization', `Bearer ${adminToken}`).send({ rawPayload: 'QR_TC04_VALID', scannerType: 'IN' });

    vi.setSystemTime(new Date('2026-11-23T17:00:00+05:30'));
    await request(app).post('/api/attendance/scan').set('Authorization', `Bearer ${adminToken}`).send({ rawPayload: 'QR_TC04_VALID', scannerType: 'OUT' });

    vi.setSystemTime(new Date('2026-11-23T17:32:10+05:30'));
    await request(app).post('/api/attendance/auto-close').set('Authorization', `Bearer ${adminToken}`).send({});

    vi.setSystemTime(new Date('2026-11-23T18:30:00+05:30'));
    await request(app).post('/api/attendance/scan').set('Authorization', `Bearer ${adminToken}`).send({ rawPayload: 'QR_TC03_VALID', scannerType: 'OUT' });

    vi.setSystemTime(new Date('2026-11-23T19:30:00+05:30'));
    await request(app).post('/api/attendance/scan').set('Authorization', `Bearer ${adminToken}`).send({ rawPayload: 'QR_TC02_VALID', scannerType: 'OUT' });

    vi.setSystemTime(new Date('2026-11-24T03:11:00+05:30'));
    await request(app).post('/api/attendance/scan').set('Authorization', `Bearer ${adminToken}`).send({ rawPayload: 'QR_TC05_VALID', scannerType: 'IN' });

    vi.setSystemTime(new Date('2026-11-24T04:31:05+05:30'));
    await request(app).post('/api/attendance/auto-close').set('Authorization', `Bearer ${adminToken}`).send({});

    const allRecords = Object.values(db.getRawCollection('attendance')) as AttendanceRecord[];
    const nowMs = Date.now();

    const monthlyReport = buildAttendanceReportTable('monthly_attendance', {
      attendanceRecords: allRecords,
      activeEmps,
      floors,
      sections,
      departments,
      selectedDate: '2026-11-23',
      selectedMonth: '2026-11',
      nowMs,
    });

    // Clean corporate filename
    expect(monthlyReport.fileName).toBe('NARID_Monthly_Attendance_2026-11');
    // Exact 16 primary headers
    expect(monthlyReport.tableColumns.map((c) => c.header)).toEqual(EXPECTED_16_HEADERS);
    expect(PRIMARY_ATTENDANCE_REPORT_COLUMNS.map((c) => c.header)).toEqual(EXPECTED_16_HEADERS);
    expect(ATTENDANCE_HISTORY_EXPORT_COLUMNS.map((c) => c.header)).toEqual(EXPECTED_16_HEADERS);

    // Dynamic Executive Summary verification
    expect(monthlyReport.summary).not.toBeNull();
    expect(monthlyReport.summary!.totalEmployees).toBe(5);
    expect(monthlyReport.summary!.completedCount).toBe(1); // TC03 (COMPLETED + OT)
    expect(monthlyReport.summary!.autoClosedCount).toBe(2); // TC01 & TC05
    expect(monthlyReport.summary!.halfDayCount).toBe(1); // TC02 (05:00 + 02:00 = 07:00)
    expect(monthlyReport.summary!.shortLeaveCount).toBe(1); // TC04 (03:00)
    expect(monthlyReport.summary!.totalOtMinutes).toBe(180); // TC02 (120) + TC03 (60)
    expect(monthlyReport.summary!.totalOtHoursFormatted).toBe('03:00');

    // Case 12: Cross-surface consistency (Backend vs History Export vs Reports Preview)
    const historyExportRows = buildAttendanceHistoryExportRows(allRecords, nowMs);
    for (const empId of ['TC01', 'TC02', 'TC03', 'TC04', 'TC05']) {
      const repRow = monthlyReport.tableData.find((r) => r.employeeId === empId)!;
      const histRow = historyExportRows.find((r) => r.employeeId === empId)!;
      expect(repRow.dutyHours).toBe(histRow.dutyHours);
      expect(repRow.otHours).toBe(histRow.otHours);
      expect(repRow.totalWorkingHours).toBe(histRow.totalWorkingHours);
      expect(repRow.status).toBe(histRow.status);
      expect(repRow.autoCloseTime).toBe(histRow.autoCloseTime);
      expect(repRow.actualOutTime).toBe(histRow.actualOutTime);
    }

    // Case 13: Premium ExcelJS Workbook inspection (restore real timers for async zip streams)
    vi.useRealTimers();
    const xlsxBuffer = await buildPremiumExcelWorkbookBuffer({
      rows: monthlyReport.tableData,
      columns: monthlyReport.tableColumns,
      fileName: monthlyReport.fileName,
      reportTitle: monthlyReport.reportTitle,
      periodLabel: monthlyReport.periodLabel,
      sheetName: monthlyReport.reportTitle,
      summary: monthlyReport.summary,
      generatedAtIso: '2026-11-24T10:00:00+05:30',
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsxBuffer);
    const ws = wb.worksheets[0];
    expect(ws).toBeDefined();

    // Corporate Banner (Rows 1-3)
    expect(ws.getCell('A1').value).toBe('NARID ATDC TRACKER');
    expect(String(ws.getCell('A2').value)).toContain('MONTHLY ATTENDANCE REPORT');
    expect(String(ws.getCell('A2').value)).toContain('2026-11');
    expect(String(ws.getCell('A3').value)).toContain('Total Records: 5');

    // Executive Summary Row 5 & 6
    expect(ws.getCell('A5').value).toBe('Total Employees');
    expect(ws.getCell('A6').value).toBe(5);
    expect(ws.getCell('E5').value).toBe('Auto-Closed Attendance');
    expect(ws.getCell('E6').value).toBe(2);
    expect(ws.getCell('K5').value).toBe('Total OT Hours');
    expect(ws.getCell('K6').value).toBe('03:00');

    // Styled Table Column Header Row (Row 8)
    const headerRow = ws.getRow(8);
    const actualExcelHeaders: string[] = [];
    for (let c = 1; c <= 16; c++) {
      const cell = headerRow.getCell(c);
      actualExcelHeaders.push(String(cell.value));
      expect((cell.fill as any)?.fgColor?.argb).toBe('FF1B365D');
      expect(cell.font?.bold).toBe(true);
      expect(cell.font?.color?.argb).toBe('FFFFFFFF');
    }
    expect(actualExcelHeaders).toEqual(EXPECTED_16_HEADERS);

    // Zero merged cells inside data rows (Row 9+)
    const merges: string[] = (ws.model as any).merges || [];
    for (const range of merges) {
      const match = range.match(/\d+/g);
      const maxRowInMerge = Math.max(...(match || ['0']).map(Number));
      expect(maxRowInMerge, `Unexpected merge inside table range: ${range}`).toBeLessThan(8);
    }

    // Inspect data rows for exact values, [hh]:mm formatting, and semantic status colors
    const excelRowByEmp = new Map<string, ExcelJS.Row>();
    for (let r = 9; r <= 13; r++) {
      const row = ws.getRow(r);
      excelRowByEmp.set(String(row.getCell(1).value), row);
    }

    const excelDurationMinutes = (val: unknown): number => {
      if (val instanceof Date) {
        return Math.round((val.getTime() - Date.UTC(1899, 11, 30, 0, 0, 0)) / 60000);
      }
      return Math.round(Number(val) * 1440);
    };

    const tc02Row = excelRowByEmp.get('TC02')!;
    expect(tc02Row.getCell(10).value).toBe('07:30 PM'); // Actual Punch-Out
    expect(tc02Row.getCell(11).value).toBe('N/A'); // Auto-Close Time
    expect(tc02Row.getCell(12).value).toBe('HALF DAY');
    expect((tc02Row.getCell(12).fill as any)?.fgColor?.argb).toBe('FFFEF9C3'); // Soft Yellow
    expect(tc02Row.getCell(14).numFmt).toBe('[hh]:mm');
    expect(excelDurationMinutes(tc02Row.getCell(14).value)).toBe(300); // 05:00 Duty
    expect(excelDurationMinutes(tc02Row.getCell(15).value)).toBe(120); // 02:00 OT
    expect((tc02Row.getCell(15).fill as any)?.fgColor?.argb).toBe('FFEEF2FF'); // OT highlight
    expect(excelDurationMinutes(tc02Row.getCell(16).value)).toBe(420); // 07:00 Total

    const tc05Row = excelRowByEmp.get('TC05')!;
    expect(tc05Row.getCell(11).value).toBe('04:30 AM');
    expect(tc05Row.getCell(12).value).toBe('AUTO CLOSED');
    expect((tc05Row.getCell(12).fill as any)?.fgColor?.argb).toBe('FFFFEDD5'); // Soft Orange
    expect(excelDurationMinutes(tc05Row.getCell(14).value)).toBe(79); // 01:19 Duty
    expect(excelDurationMinutes(tc05Row.getCell(15).value)).toBe(0); // 00:00 OT
    expect(excelDurationMinutes(tc05Row.getCell(16).value)).toBe(79); // 01:19 Total

    const tc03Row = excelRowByEmp.get('TC03')!;
    expect((tc03Row.getCell(12).fill as any)?.fgColor?.argb).toBe('FFDCFCE7'); // Soft Green

    const tc04Row = excelRowByEmp.get('TC04')!;
    expect((tc04Row.getCell(12).fill as any)?.fgColor?.argb).toBe('FFFEE2E2'); // Soft Light Red

    // Frozen header row, AutoFilter, Landscape Print Setup, Repeating Print Titles & Header/Footer
    expect(ws.views[0]?.state).toBe('frozen');
    expect((ws.views[0] as any)?.ySplit).toBe(8);
    expect(ws.autoFilter).toBeTruthy();
    expect(ws.pageSetup.orientation).toBe('landscape');
    expect(ws.pageSetup.fitToPage).toBe(true);
    expect(ws.pageSetup.fitToWidth).toBe(1);
    expect(ws.pageSetup.printTitlesRow).toBe('8:8');
    expect(ws.headerFooter.oddHeader).toContain('Monthly Attendance Report');
    expect(ws.headerFooter.oddFooter).toContain('Page &P of &N');

    // Case 14: CSV export test (exact 16 columns, HH:MM durations, N/A formatting)
    const csv = buildCsvContent(monthlyReport.tableData, monthlyReport.tableColumns);
    const csvLines = csv.split('\r\n');
    expect(csvLines[0]).toBe(EXPECTED_16_HEADERS.join(','));
    const csvTc02 = csvLines.find((l) => l.startsWith('TC02,'))!;
    expect(csvTc02).toContain(',07:30 PM,N/A,HALF DAY,N/A,05:00,02:00,07:00');
    const csvTc05 = csvLines.find((l) => l.startsWith('TC05,'))!;
    expect(csvTc05).toContain(',N/A,04:30 AM,AUTO CLOSED,');
    expect(csvTc05).toContain(',01:19,00:00,01:19');

    // Case 15: UI render verification for Reports component
    const reportsHtml = renderToStaticMarkup(
      React.createElement(Reports, {
        employees: activeEmps,
        floors,
        sections,
        departments,
        shifts: [],
      })
    );
    for (const h of EXPECTED_16_HEADERS) {
      expect(reportsHtml).toContain(h);
    }
    expect(reportsHtml).not.toContain('Regular Duty Minutes');
    expect(reportsHtml).not.toContain('Post-Shift OT Minutes');
    expect(computeAttendanceReportSummary(monthlyReport.tableData).totalOtHoursFormatted).toBe('03:00');
  });
});
