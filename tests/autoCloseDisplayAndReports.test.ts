import request from 'supertest';
import * as XLSX from 'xlsx';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createApp } from '../server.ts';
import {
  formatIsoDateTimeKolkata12h,
  formatIsoTimeKolkata12h,
  resolveAttendanceMetrics,
} from '../src/utils/attendanceStatus.ts';
import {
  ATTENDANCE_HISTORY_EXPORT_COLUMNS,
  buildAttendanceHistoryExportRows,
  buildAttendanceReportTable,
} from '../src/utils/attendanceReportBuilder.ts';
import { buildCsvContent, buildExcelWorkbookBuffer } from '../src/services/exportService.ts';
import type { AttendanceRecord, Department, Employee, Floor, Section } from '../src/types';
import {
  InMemoryAdminAuth,
  InMemoryFirestore,
  TEST_CANONICAL_ACCOUNTS,
  seedIsolatedTestEnvironment,
} from './helpers/inMemoryAdmin.ts';

describe('NARID ATDC Auto-Close Time Display in Attendance History, Reports & Exports', () => {
  let db: InMemoryFirestore;
  let auth: InMemoryAdminAuth;
  let app: ReturnType<typeof createApp>['app'];
  let adminToken: string;

  const floors: Floor[] = [
    { id: 'MI-01', name: 'MI-01', code: 'MI-01', order: 1, status: 'Active' },
  ];
  const sections: Section[] = [
    { id: 'MI', name: 'MI', code: 'MI', floorId: 'MI-01', status: 'Active' },
  ];
  const departments: Department[] = [
    { id: 'Production', name: 'Production', code: 'PROD', status: 'Active' },
  ];
  const activeEmps: Employee[] = [];

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    db = new InMemoryFirestore();
    auth = new InMemoryAdminAuth();
    await seedIsolatedTestEnvironment(db, auth);
    activeEmps.length = 0;

    for (let i = 1; i <= 10; i++) {
      const id = `ACD${String(i).padStart(3, '0')}`;
      const emp: Employee = {
        employeeId: id,
        employeeName: `AutoClose Display Worker ${i}`,
        employeeType: 'Permanent',
        floor: 'MI-01',
        section: 'MI',
        department: 'Production',
        designation: 'Operator',
        employeeStatus: 'Active',
        qrCodeToken: `QR_${id}_VALID`,
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
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

  const getAllAttendanceFromDb = (): AttendanceRecord[] =>
    Object.values(db.getRawCollection('attendance')) as unknown as AttendanceRecord[];

  // Scenario 1: Day Shift auto-close displays 05:30 PM.
  it('1. Day Shift auto-close records and displays 05:30 PM IST effective Auto-Close Time', async () => {
    vi.setSystemTime(new Date('2026-11-22T09:00:00+05:30'));
    const inRes = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_ACD001_VALID', scannerType: 'IN' });
    expect(inRes.status).toBe(200);

    vi.setSystemTime(new Date('2026-11-22T17:30:00+05:30'));
    const closeRes = await request(app)
      .post('/api/attendance/auto-close')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(closeRes.status).toBe(200);
    expect(closeRes.body.closedCount).toBe(1);

    const record = closeRes.body.closedRecords[0] as AttendanceRecord;
    const metrics = resolveAttendanceMetrics(record, Date.now());

    expect(record.shiftId).toBe('DAY');
    expect(record.shiftDate).toBe('2026-11-22');
    expect(record.scheduledPunchIn).toBe('09:00');
    expect(record.scheduledPunchOut).toBe('17:30');
    expect(record.effectivePunchOut).toBe('2026-11-22T17:30:00+05:30');
    expect(record.autoCloseEffectivePunchOut).toBe('2026-11-22T17:30:00+05:30');

    expect(metrics.isCurrentlyAutoClosed).toBe(true);
    expect(metrics.punchOutTypeResolved).toBe('AUTO');
    expect(metrics.scheduledStartDisplay).toBe('09:00 AM');
    expect(metrics.scheduledEndDisplay).toBe('05:30 PM');
    expect(metrics.actualPunchOutDisplay).toBe('N/A');
    expect(metrics.autoCloseTimeDisplay).toBe('05:30 PM');
    expect(metrics.autoCloseRecordedAtDisplay).toBe('22 Nov 2026, 05:30:00 PM IST');
    expect(metrics.status).toBe('AUTO CLOSED');
    expect(metrics.completedDutyMinutes).toBe(510);
    expect(metrics.overtimeMinutes).toBe(0);
  });

  // Scenario 2: Night Shift auto-close displays 04:30 AM (next day) while Attendance Date stays on D.
  it('2. Night Shift auto-close displays 04:30 AM next calendar day (D+1) while Attendance Date remains shift start date D', async () => {
    vi.setSystemTime(new Date('2026-11-22T20:00:00+05:30'));
    const inRes = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_ACD002_VALID', scannerType: 'IN' });
    expect(inRes.status).toBe(200);
    expect(inRes.body.attendance.shiftId).toBe('NIGHT');
    expect(inRes.body.attendance.shiftDate).toBe('2026-11-22');

    vi.setSystemTime(new Date('2026-11-23T04:30:00+05:30'));
    const closeRes = await request(app)
      .post('/api/attendance/auto-close')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(closeRes.status).toBe(200);
    expect(closeRes.body.closedCount).toBe(1);

    const record = closeRes.body.closedRecords[0] as AttendanceRecord;
    const metrics = resolveAttendanceMetrics(record, Date.now());

    // Shift Attendance Date stays on 2026-11-22 (D), while effective & recorded timestamps reflect 2026-11-23 (D+1)
    expect(record.shiftDate).toBe('2026-11-22');
    expect(record.scheduledPunchIn).toBe('20:00');
    expect(record.scheduledPunchOut).toBe('04:30');
    expect(record.scheduledPunchOutIso).toBe('2026-11-23T04:30:00+05:30');
    expect(record.effectivePunchOut).toBe('2026-11-23T04:30:00+05:30');
    expect(record.autoCloseEffectivePunchOut).toBe('2026-11-23T04:30:00+05:30');

    expect(metrics.isCurrentlyAutoClosed).toBe(true);
    expect(metrics.scheduledStartDisplay).toBe('08:00 PM');
    expect(metrics.scheduledEndDisplay).toBe('04:30 AM');
    expect(metrics.autoCloseTimeDisplay).toBe('04:30 AM');
    expect(metrics.autoCloseRecordedAtDisplay).toBe('23 Nov 2026, 04:30:00 AM IST');
    expect(metrics.actualPunchOutDisplay).toBe('N/A');
  });

  // Scenario 3: Actual server-side processing timestamp (autoClosedAt) is stored separately from effectivePunchOut.
  it('3. Stores actual server-side autoClosedAt separately from effective scheduled shift end Punch-Out for both Day & Night shifts', async () => {
    // Day Shift employee punches in at 09:00 AM on 22 Nov; auto-close job executes 7m 15s late at 05:37:15 PM IST
    vi.setSystemTime(new Date('2026-11-22T09:00:00+05:30'));
    await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_ACD003_VALID', scannerType: 'IN' });

    vi.setSystemTime(new Date('2026-11-22T17:37:15+05:30'));
    const dayCloseRes = await request(app)
      .post('/api/attendance/auto-close')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(dayCloseRes.status).toBe(200);
    const dayClosed = dayCloseRes.body.closedRecords[0] as AttendanceRecord;
    const dayMetrics = resolveAttendanceMetrics(dayClosed, Date.now());

    expect(dayClosed.effectivePunchOut).toBe('2026-11-22T17:30:00+05:30');
    expect(dayClosed.autoClosedAt).toBe(new Date('2026-11-22T17:37:15+05:30').toISOString());
    expect(dayClosed.autoClosedAt).not.toBe(dayClosed.effectivePunchOut);
    expect(dayMetrics.autoCloseTimeDisplay).toBe('05:30 PM');
    expect(dayMetrics.autoCloseRecordedAtDisplay).toBe('22 Nov 2026, 05:37:15 PM IST');

    // Night Shift employee punches in at 08:00 PM on 22 Nov; auto-close job executes 12m 10s late at 04:42:10 AM on 23 Nov IST
    vi.setSystemTime(new Date('2026-11-22T20:00:00+05:30'));
    await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_ACD004_VALID', scannerType: 'IN' });

    vi.setSystemTime(new Date('2026-11-23T04:42:10+05:30'));
    const nightCloseRes = await request(app)
      .post('/api/attendance/auto-close')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(nightCloseRes.status).toBe(200);
    const nightClosed = nightCloseRes.body.closedRecords[0] as AttendanceRecord;
    const nightMetrics = resolveAttendanceMetrics(nightClosed, Date.now());

    expect(nightClosed.shiftDate).toBe('2026-11-22');
    expect(nightClosed.effectivePunchOut).toBe('2026-11-23T04:30:00+05:30');
    expect(nightClosed.autoClosedAt).toBe(new Date('2026-11-23T04:42:10+05:30').toISOString());
    expect(nightMetrics.autoCloseTimeDisplay).toBe('04:30 AM');
    expect(nightMetrics.autoCloseRecordedAtDisplay).toBe('23 Nov 2026, 04:42:10 AM IST');
  });

  // Scenario 4: Auto-Closed Attendance popup data displays Auto-Close Time & Auto-Close Recorded At, excludes ACTUAL/reconciled, and never fabricates legacy timestamps.
  it('4. Auto-Closed Attendance popup & summary counters display Auto-Close times cleanly and show N/A for legacy records without autoClosedAt', async () => {
    // Employee 1: Day Shift auto-closed
    vi.setSystemTime(new Date('2026-11-22T08:55:00+05:30'));
    await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_ACD001_VALID', scannerType: 'IN' });

    // Employee 2: Day Shift ordinary ACTUAL Punch-Out at 05:30 PM
    vi.setSystemTime(new Date('2026-11-22T09:00:00+05:30'));
    await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_ACD002_VALID', scannerType: 'IN' });

    vi.setSystemTime(new Date('2026-11-22T17:30:00+05:30'));
    await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_ACD002_VALID', scannerType: 'OUT' });

    // Run auto-close at 05:31:20 PM -> only ACD001 is auto-closed
    vi.setSystemTime(new Date('2026-11-22T17:31:20+05:30'));
    await request(app)
      .post('/api/attendance/auto-close')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    // Verify backend dashboard summary endpoint count matches isCurrentlyAutoClosed
    const dashRes = await request(app)
      .get('/api/dashboard/summary?date=2026-11-22')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(dashRes.status).toBe(200);
    expect(dashRes.body.metrics.autoClosed).toBe(1);
    expect(dashRes.body.metrics.missedPunchOut).toBe(1);

    const allRecords = getAllAttendanceFromDb();
    const popupRecords = allRecords.filter((r) => resolveAttendanceMetrics(r, Date.now()).isCurrentlyAutoClosed);
    expect(popupRecords).toHaveLength(1);
    expect(popupRecords[0].employeeId).toBe('ACD001');

    const popupMetrics = resolveAttendanceMetrics(popupRecords[0], Date.now());
    expect(popupMetrics.scheduledStartDisplay).toBe('09:00 AM');
    expect(popupMetrics.scheduledEndDisplay).toBe('05:30 PM');
    expect(popupMetrics.autoCloseTimeDisplay).toBe('05:30 PM');
    expect(popupMetrics.autoCloseRecordedAtDisplay).toBe('22 Nov 2026, 05:31:20 PM IST');
    expect(popupMetrics.earlyArrivalMinutes).toBe(5);
    expect(popupMetrics.status).toBe('AUTO CLOSED');
    expect(popupMetrics.earlyOtMinutes).toBe(0);
    expect(popupMetrics.postShiftOtMinutes).toBe(0);
    expect(popupMetrics.completedDutyMinutes).toBe(510);
    expect(popupMetrics.overtimeMinutes).toBe(0);

    // Ordinary ACTUAL punch-out must show N/A for Auto-Close fields
    const actualRecord = allRecords.find((r) => r.employeeId === 'ACD002')!;
    const actualMetrics = resolveAttendanceMetrics(actualRecord, Date.now());
    expect(actualMetrics.isCurrentlyAutoClosed).toBe(false);
    expect(actualMetrics.punchOutTypeResolved).toBe('ACTUAL');
    expect(actualMetrics.actualPunchOutDisplay).toBe('05:30 PM');
    expect(actualMetrics.autoCloseTimeDisplay).toBe('N/A');
    expect(actualMetrics.autoCloseRecordedAtDisplay).toBe('N/A');

    // Legacy AUTO record missing autoClosedAt & effectivePunchOut must NOT fabricate fake timestamps
    const legacyAutoRecord: AttendanceRecord = {
      id: 'att_LEGACY01_2026-10-01',
      employeeId: 'LEGACY01',
      employeeNameSnapshot: 'Legacy Worker',
      employeeTypeSnapshot: 'Permanent',
      floorIdSnapshot: 'MI-01',
      sectionIdSnapshot: 'MI',
      departmentIdSnapshot: 'Production',
      shiftId: 'DAY',
      shiftNameSnapshot: 'Day Shift',
      shiftDate: '2026-10-01',
      scheduledPunchOut: '17:30',
      firstPunchIn: '2026-10-01T09:00:00+05:30',
      punchIn: '2026-10-01T09:00:00+05:30',
      actualPunchOut: null,
      effectivePunchOut: null,
      punchOutType: 'AUTO',
      autoClosed: true,
      missedPunchOut: true,
      attendanceStatus: 'AUTO CLOSED',
      currentState: 'OUTSIDE',
      regularDutyMinutes: 510,
      totalDutyMinutes: 510,
      overtimeMinutes: 0,
      isLate: false,
      qrTokenReference: 'QR_LEGACY01_VALID',
      createdAt: '2026-10-01T09:00:00+05:30',
      updatedAt: '2026-10-01T17:30:00+05:30',
    };
    const legacyMetrics = resolveAttendanceMetrics(legacyAutoRecord, Date.now());
    expect(legacyMetrics.isCurrentlyAutoClosed).toBe(true);
    expect(legacyMetrics.autoCloseTimeDisplay).toBe('N/A');
    expect(legacyMetrics.autoCloseRecordedAtDisplay).toBe('N/A');
    expect(formatIsoDateTimeKolkata12h(null)).toBe('N/A');
    expect(formatIsoDateTimeKolkata12h(undefined)).toBe('N/A');
  });

  // Scenario 5, 6 & 7: Daily, Shift-wise, Employee-wise, Monthly, Missed Punch Out, Attendance History + Excel (.xlsx) & CSV exports.
  it('5-7. Includes Auto-Close Time & Recorded At across Daily, Monthly, Shift-wise, Employee-wise, Missed Punch Out, Attendance History, Excel (.xlsx) & CSV exports', async () => {
    // 1) Day Shift Auto-Closed (ACD001)
    vi.setSystemTime(new Date('2026-11-22T09:00:00+05:30'));
    await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_ACD001_VALID', scannerType: 'IN' });

    // 2) Day Shift Ordinary Actual Punch-Out with 60m Post-Shift OT (ACD002)
    vi.setSystemTime(new Date('2026-11-22T09:00:00+05:30'));
    await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_ACD002_VALID', scannerType: 'IN' });

    vi.setSystemTime(new Date('2026-11-22T17:35:40+05:30'));
    await request(app)
      .post('/api/attendance/auto-close')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    // Reconcile ACD002 with Actual Punch-Out at 06:30 PM -> becomes ACTUAL with 60m post-shift OT
    vi.setSystemTime(new Date('2026-11-22T18:30:00+05:30'));
    await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_ACD002_VALID', scannerType: 'OUT' });

    // 3) Day Shift Ordinary Actual Punch-Out BEFORE auto-close (ACD003)
    vi.setSystemTime(new Date('2026-11-22T09:05:00+05:30'));
    await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_ACD003_VALID', scannerType: 'IN' });

    vi.setSystemTime(new Date('2026-11-22T17:20:00+05:30'));
    await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_ACD003_VALID', scannerType: 'OUT' });

    // 4) Night Shift Auto-Closed on D+1 (ACD004)
    vi.setSystemTime(new Date('2026-11-22T20:00:00+05:30'));
    await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_ACD004_VALID', scannerType: 'IN' });

    vi.setSystemTime(new Date('2026-11-23T04:33:12+05:30'));
    await request(app)
      .post('/api/attendance/auto-close')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    const records = getAllAttendanceFromDb();
    const nowMs = Date.now();
    const baseParams = {
      attendanceRecords: records,
      activeEmps,
      floors,
      sections,
      departments,
      selectedDate: '2026-11-22',
      selectedMonth: '2026-11',
      nowMs,
    };

    const requiredHeaders = [
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

    for (const reportType of [
      'daily_attendance',
      'monthly_attendance',
      'shift_wise',
      'employee_wise',
      'missed_punch_out',
    ] as const) {
      const built = buildAttendanceReportTable(reportType, baseParams);
      const headers = built.tableColumns.map((c) => c.header);
      expect(headers, `Report ${reportType} headers must match exact 16 primary columns`).toEqual(requiredHeaders);

      if (reportType === 'missed_punch_out') {
        // Only currently auto-closed records (ACD001 Day & ACD004 Night) appear — reconciled ACD002 & actual ACD003 are excluded
        const empIds = built.tableData.map((r) => r.employeeId).sort();
        expect(empIds).toEqual(['ACD001', 'ACD004']);
      } else {
        const dayAutoRow = built.tableData.find((r) => r.employeeId === 'ACD001')!;
        expect(dayAutoRow.scheduledStart).toBe('09:00 AM');
        expect(dayAutoRow.scheduledEnd).toBe('05:30 PM');
        expect(dayAutoRow.actualOutTime).toBe('N/A');
        expect(dayAutoRow.autoCloseTime).toBe('05:30 PM');
        expect(dayAutoRow.autoCloseRecordedAt).toBe('22 Nov 2026, 05:35:40 PM IST');
        expect(dayAutoRow.status).toBe('AUTO CLOSED');
        expect(dayAutoRow.dutyHours).toBe('08:30');
        expect(dayAutoRow.otHours).toBe('00:00');
        expect(dayAutoRow.totalWorkingHours).toBe('08:30');

        const nightAutoRow = built.tableData.find((r) => r.employeeId === 'ACD004')!;
        expect(nightAutoRow.date).toBe('2026-11-22');
        expect(nightAutoRow.scheduledStart).toBe('08:00 PM');
        expect(nightAutoRow.scheduledEnd).toBe('04:30 AM');
        expect(nightAutoRow.actualOutTime).toBe('N/A');
        expect(nightAutoRow.autoCloseTime).toBe('04:30 AM');
        expect(nightAutoRow.autoCloseRecordedAt).toBe('23 Nov 2026, 04:33:12 AM IST');
        expect(nightAutoRow.status).toBe('AUTO CLOSED');
        expect(nightAutoRow.dutyHours).toBe('08:30');
        expect(nightAutoRow.otHours).toBe('00:00');
        expect(nightAutoRow.totalWorkingHours).toBe('08:30');

        const reconciledRow = built.tableData.find((r) => r.employeeId === 'ACD002')!;
        expect(reconciledRow.actualOutTime).toBe('06:30 PM');
        expect(reconciledRow.autoCloseTime).toBe('N/A');
        expect(reconciledRow.autoCloseRecordedAt).toBe('N/A');
        expect(reconciledRow.status).toBe('COMPLETED + OT');
        expect(reconciledRow.dutyHours).toBe('08:30');
        expect(reconciledRow.otHours).toBe('01:00');
        expect(reconciledRow.totalWorkingHours).toBe('09:30');

        const ordinaryActualRow = built.tableData.find((r) => r.employeeId === 'ACD003')!;
        expect(ordinaryActualRow.actualOutTime).toBe('05:20 PM');
        expect(ordinaryActualRow.autoCloseTime).toBe('N/A');
        expect(ordinaryActualRow.autoCloseRecordedAt).toBe('N/A');
        expect(ordinaryActualRow.dutyHours).toBe('08:15');
        expect(ordinaryActualRow.otHours).toBe('00:00');
        expect(ordinaryActualRow.totalWorkingHours).toBe('08:15');
      }
    }

    // Verify Attendance History export rows & columns match the exact 16 primary columns
    const historyHeaders = ATTENDANCE_HISTORY_EXPORT_COLUMNS.map((c) => c.header);
    expect(historyHeaders).toEqual(requiredHeaders);
    const historyRows = buildAttendanceHistoryExportRows(records, nowMs);
    const histNight = historyRows.find((r) => r.employeeId === 'ACD004')!;
    expect(histNight.date).toBe('2026-11-22');
    expect(histNight.autoCloseTime).toBe('04:30 AM');
    expect(histNight.autoCloseRecordedAt).toBe('23 Nov 2026, 04:33:12 AM IST');
    expect(histNight.status).toBe('AUTO CLOSED');

    // Scenario 6: Premium Excel (.xlsx) Export verification via buildExcelWorkbookBuffer + XLSX.read
    vi.useRealTimers();
    const dailyReport = buildAttendanceReportTable('daily_attendance', baseParams);
    const xlsxBuf = await buildExcelWorkbookBuffer(dailyReport.tableData, dailyReport.tableColumns, 'DailyReport');
    const parsedWb = XLSX.read(xlsxBuf, { type: 'array' });
    expect(parsedWb.SheetNames).toContain('DailyReport');
    // Table header row is on row 8 (0-indexed row 7) beneath corporate banner & executive summary
    const parsedRows = XLSX.utils.sheet_to_json<Record<string, any>>(parsedWb.Sheets['DailyReport'], { range: 7 });

    const xlsxDayAuto = parsedRows.find((r) => r['Employee ID'] === 'ACD001')!;
    expect(xlsxDayAuto['Scheduled Shift Start']).toBe('09:00 AM');
    expect(xlsxDayAuto['Scheduled Shift End']).toBe('05:30 PM');
    expect(xlsxDayAuto['Actual Punch-Out']).toBe('N/A');
    expect(xlsxDayAuto['Auto-Close Time']).toBe('05:30 PM');
    expect(xlsxDayAuto['Auto-Close Recorded At']).toBe('22 Nov 2026, 05:35:40 PM IST');
    expect(xlsxDayAuto['Attendance Status']).toBe('AUTO CLOSED');
    expect(xlsxDayAuto['Duty Hours']).toBeCloseTo(510 / 1440, 5);
    expect(xlsxDayAuto['OT Hours']).toBeCloseTo(0, 5);
    expect(xlsxDayAuto['Total Working Hours']).toBeCloseTo(510 / 1440, 5);

    const xlsxNightAuto = parsedRows.find((r) => r['Employee ID'] === 'ACD004')!;
    expect(xlsxNightAuto['Attendance Date']).toBe('2026-11-22');
    expect(xlsxNightAuto['Scheduled Shift End']).toBe('04:30 AM');
    expect(xlsxNightAuto['Auto-Close Time']).toBe('04:30 AM');
    expect(xlsxNightAuto['Auto-Close Recorded At']).toBe('23 Nov 2026, 04:33:12 AM IST');

    const xlsxActual = parsedRows.find((r) => r['Employee ID'] === 'ACD003')!;
    expect(xlsxActual['Actual Punch-Out']).toBe('05:20 PM');
    expect(xlsxActual['Auto-Close Time']).toBe('N/A');
    expect(xlsxActual['Auto-Close Recorded At']).toBe('N/A');

    // Scenario 7: CSV Export verification via buildCsvContent
    const csvText = buildCsvContent(dailyReport.tableData, dailyReport.tableColumns);
    const csvLines = csvText.split('\r\n');
    expect(csvLines[0]).toBe(requiredHeaders.join(','));

    const dayCsvLine = csvLines.find((line) => line.startsWith('ACD001,'))!;
    expect(dayCsvLine).toContain('05:30 PM');
    expect(dayCsvLine).toContain('AUTO CLOSED');
    expect(dayCsvLine).toContain('"22 Nov 2026, 05:35:40 PM IST"');
    expect(dayCsvLine).toContain(',08:30,00:00,08:30');

    const nightCsvLine = csvLines.find((line) => line.startsWith('ACD004,'))!;
    expect(nightCsvLine).toContain('2026-11-22');
    expect(nightCsvLine).toContain('04:30 AM');
    expect(nightCsvLine).toContain('"23 Nov 2026, 04:33:12 AM IST"');

    const actualCsvLine = csvLines.find((line) => line.startsWith('ACD003,'))!;
    expect(actualCsvLine).toContain('05:20 PM,N/A,HALF DAY,N/A,08:15,00:00,08:15');
  });

  // Scenarios 8, 9 & 10: Reconciliation updates current status to ACTUAL, preserves historical Auto-Close audit event, and creates zero duplicate attendance records.
  it('8-10. Reconciles provisional Auto-Close to ACTUAL Punch-Out, removes from Auto-Closed views, preserves historical Auto-Close audit event, and keeps a single attendance document', async () => {
    // Punch-In at 08:00 AM (60m early) for Day Shift
    vi.setSystemTime(new Date('2026-11-22T08:00:00+05:30'));
    const inRes = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_ACD005_VALID', scannerType: 'IN' });
    expect(inRes.status).toBe(200);
    const originalAttendanceId = inRes.body.attendance.id;
    const originalFirstIn = inRes.body.attendance.firstPunchIn;

    // Provisional Auto-Close runs at 05:34:05 PM IST
    vi.setSystemTime(new Date('2026-11-22T17:34:05+05:30'));
    const closeRes = await request(app)
      .post('/api/attendance/auto-close')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(closeRes.status).toBe(200);
    expect(closeRes.body.closedCount).toBe(1);
    const closedRecord = closeRes.body.closedRecords[0] as AttendanceRecord;
    const originalAutoCloseEventId = closedRecord.autoCloseEventId;
    const originalAutoClosedAt = closedRecord.autoClosedAt;

    // Confirm before reconciliation: appears in Auto-Closed dashboard summary & Missed Punch Out report
    const beforeDash = await request(app)
      .get('/api/dashboard/summary?date=2026-11-22')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(beforeDash.body.metrics.autoClosed).toBe(1);

    // Employee performs genuine Actual Punch-Out at 07:00 PM IST
    vi.setSystemTime(new Date('2026-11-22T19:00:00+05:30'));
    const outRes = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rawPayload: 'QR_ACD005_VALID', scannerType: 'OUT' });
    expect(outRes.status).toBe(200);
    expect(outRes.body.reconciledFromAutoClose).toBe(true);

    const reconciled = outRes.body.attendance as AttendanceRecord;
    const metrics = resolveAttendanceMetrics(reconciled, Date.now());

    // Scenario 8: Current display is ACTUAL, not AUTO CLOSED
    expect(reconciled.id).toBe(originalAttendanceId);
    expect(reconciled.firstPunchIn).toBe(originalFirstIn);
    expect(reconciled.punchOutType).toBe('ACTUAL');
    expect(reconciled.autoClosed).toBe(false);
    expect(reconciled.missedPunchOut).toBe(false);
    expect(reconciled.reconciledFromAutoClose).toBe(true);
    expect(reconciled.attendanceStatus).toBe('COMPLETED + OT');

    expect(metrics.isCurrentlyAutoClosed).toBe(false);
    expect(metrics.punchOutTypeResolved).toBe('ACTUAL');
    expect(metrics.status).toBe('COMPLETED + OT');
    expect(metrics.actualPunchOutDisplay).toBe('07:00 PM');
    expect(formatIsoTimeKolkata12h(reconciled.actualPunchOut)).toBe('07:00 PM');
    expect(metrics.autoCloseTimeDisplay).toBe('N/A');
    expect(metrics.autoCloseRecordedAtDisplay).toBe('N/A');
    expect(metrics.regularDutyMinutes).toBe(510);
    expect(metrics.earlyOtMinutes).toBe(60);
    expect(metrics.postShiftOtMinutes).toBe(90);
    expect(metrics.overtimeMinutes).toBe(150);

    // Dashboard summary & Missed Punch Out report no longer include ACD005 as auto-closed
    const afterDash = await request(app)
      .get('/api/dashboard/summary?date=2026-11-22')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(afterDash.body.metrics.autoClosed).toBe(0);
    expect(afterDash.body.metrics.missedPunchOut).toBe(0);

    const missedReport = buildAttendanceReportTable('missed_punch_out', {
      attendanceRecords: getAllAttendanceFromDb(),
      activeEmps,
      floors,
      sections,
      departments,
      selectedDate: '2026-11-22',
      nowMs: Date.now(),
    });
    expect(missedReport.tableData).toHaveLength(0);

    // Scenario 9: Historical Auto-Close event remains preserved on record, punch_events, and audit_logs
    expect(reconciled.autoClosedAt).toBe(originalAutoClosedAt);
    expect(reconciled.autoCloseEffectivePunchOut).toBe('2026-11-22T17:30:00+05:30');
    expect(reconciled.autoCloseEventId).toBe(originalAutoCloseEventId);
    expect(metrics.historicalAutoCloseTimeDisplay).toBe('05:30 PM');
    expect(metrics.historicalAutoCloseRecordedAtDisplay).toBe('22 Nov 2026, 05:34:05 PM IST');

    const punchEvents = Object.values(db.getRawCollection('punch_events')).filter(
      (e) => e.employeeId === 'ACD005'
    );
    expect(punchEvents.some((e) => e.id === originalAutoCloseEventId && e.status === 'AUTO_CLOSE')).toBe(true);
    expect(punchEvents.some((e) => e.status === 'RECONCILED_ACTUAL_OUT' && e.reconciledFromAutoClose === true)).toBe(true);

    const auditLogs = Object.values(db.getRawCollection('audit_logs')).filter(
      (a) => a.action === 'RECONCILE_AUTO_CLOSED_PUNCH_OUT' && a.employeeId === 'ACD005'
    );
    expect(auditLogs).toHaveLength(1);

    // Scenario 10: No duplicate attendance documents exist for ACD005
    const attendanceDocsForEmp = getAllAttendanceFromDb().filter((d) => d.employeeId === 'ACD005');
    expect(attendanceDocsForEmp).toHaveLength(1);
    expect(attendanceDocsForEmp[0].id).toBe(originalAttendanceId);
    expect(attendanceDocsForEmp[0].id).toBe('att_ACD005_2026-11-22_DAY');
  });
});
