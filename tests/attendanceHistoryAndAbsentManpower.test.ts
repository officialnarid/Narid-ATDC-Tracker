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
import type { AttendanceRecord, Employee, Shift } from '../src/types';
import {
  type ClassificationContext,
  buildEmployeeMonthlyCalendar,
  classifyEmployeeDay,
  computeConsecutiveAbsenceMetrics,
} from '../src/utils/attendanceCalendarEngine';
import {
  ABSENT_MANPOWER_12_COLUMNS,
  EMPLOYEE_MONTHLY_CALENDAR_EXPORT_COLUMNS,
  buildAbsentManpowerExportRows,
  buildAnalyticsGroupExportRows,
  buildEmployeeMonthlyCalendarExportRows,
} from '../src/utils/attendanceHistoryExportBuilder';
import { buildPremiumExcelWorkbookBuffer } from '../src/utils/excelReportExporter';
import { AttendanceHistory } from '../src/components/AttendanceHistory';
import { EmployeeMonthlyCalendar } from '../src/components/attendanceHistory/EmployeeMonthlyCalendar';
import { AbsentManpowerPanel } from '../src/components/attendanceHistory/AbsentManpowerPanel';

function makeDayAttendance(params: {
  employee: Employee;
  shiftDate: string;
  punchInTime: string; // e.g. '09:00:00'
  punchOutTime?: string | null; // e.g. '17:30:00'
  autoClosed?: boolean;
  isLate?: boolean;
  shiftId?: 'DAY' | 'NIGHT';
}): AttendanceRecord {
  const {
    employee,
    shiftDate,
    punchInTime,
    punchOutTime = '17:30:00',
    autoClosed = false,
    isLate = false,
    shiftId = 'DAY',
  } = params;

  const isNight = shiftId === 'NIGHT';
  const schedStart = isNight ? '20:00' : '09:00';
  const schedEnd = isNight ? '04:30' : '17:30';
  const punchInIso = `${shiftDate}T${punchInTime}+05:30`;
  const actualOutIso = punchOutTime ? `${shiftDate}T${punchOutTime}+05:30` : null;
  const schedEndIso = `${shiftDate}T${schedEnd}:00+05:30`;

  return {
    id: `att_${employee.employeeId}_${shiftDate}`,
    employeeId: employee.employeeId,
    employeeNameSnapshot: employee.employeeName,
    employeeTypeSnapshot: employee.employeeType,
    floorIdSnapshot: employee.floor,
    lineIdSnapshot: employee.line || employee.floor,
    sectionIdSnapshot: employee.section,
    departmentIdSnapshot: employee.department,
    shiftId,
    shiftNameSnapshot: isNight ? 'NIGHT SHIFT' : 'DAY SHIFT',
    shiftDate,
    punchIn: punchInIso,
    firstPunchIn: punchInIso,
    scheduledPunchIn: schedStart,
    scheduledPunchInIso: `${shiftDate}T${schedStart}:00+05:30`,
    scheduledPunchOut: schedEnd,
    scheduledPunchOutIso: schedEndIso,
    actualPunchOut: autoClosed ? null : actualOutIso,
    lastPunchOut: autoClosed ? null : actualOutIso,
    effectivePunchOut: autoClosed ? schedEndIso : actualOutIso,
    punchOutType: autoClosed ? 'AUTO' : actualOutIso ? 'ACTUAL' : 'NONE',
    currentState: autoClosed || actualOutIso ? 'OUTSIDE' : 'INSIDE',
    regularDutyMinutes: autoClosed ? 510 : actualOutIso ? 510 : 0,
    overtimeMinutes: 0,
    earlyPunchPolicy: 'OPTION_A_60M',
    attendanceStatus: autoClosed
      ? 'AUTO CLOSED'
      : actualOutIso
        ? 'COMPLETED'
        : 'IN PROGRESS',
    isLate,
    arrivalStatus: isLate ? 'LATE' : 'PRESENT',
    autoClosed,
    autoClosedAt: autoClosed ? `${shiftDate}T17:31:00+05:30` : null,
    autoCloseEffectivePunchOut: autoClosed ? schedEndIso : null,
    qrTokenReference: employee.qrCodeToken,
    createdAt: punchInIso,
    updatedAt: actualOutIso || punchInIso,
  };
}

describe('NARID ATDC Tracker — Premium Attendance History, Employee Monthly Calendar & Absent Manpower (19 Mandatory Cases)', () => {
  let app: ReturnType<typeof createApp>['app'];
  let db: InMemoryFirestore;
  let auth: InMemoryAdminAuth;
  let superAdminToken: string;
  let adminToken: string;
  let userToken: string;

  // Fixed reference clock: Wednesday, 18 Nov 2026 15:00:00 IST
  const FIXED_NOW_MS = new Date('2026-11-18T15:00:00+05:30').getTime();

  const employeesFixture: Array<Employee & Record<string, any>> = [
    {
      employeeId: 'EMP001',
      employeeName: 'Aarav Sharma',
      employeeType: 'Permanent',
      section: 'MI',
      department: 'Production',
      floor: 'MI-01',
      line: 'MI-01',
      designation: 'Senior Operator',
      qrCodeToken: 'SECRET_QR_EMP001',
      phone: '+91-9999990001',
      email: 'aarav.private@example.com',
      address: 'Private Street 1',
      employeeStatus: 'Active',
      joiningDate: '2026-11-01',
      createdAt: '2026-11-01T08:00:00+05:30',
      updatedAt: '2026-11-01T08:00:00+05:30',
    },
    {
      employeeId: 'EMP002',
      employeeName: 'Bhavna Patel',
      employeeType: 'Staff',
      section: 'SMT',
      department: 'Quality',
      floor: 'SMT-01',
      line: 'SMT-01',
      designation: 'QA Inspector',
      qrCodeToken: 'SECRET_QR_EMP002',
      phone: '+91-9999990002',
      employeeStatus: 'Active',
      joiningDate: '2026-11-01',
      createdAt: '2026-11-01T08:00:00+05:30',
      updatedAt: '2026-11-01T08:00:00+05:30',
    },
    {
      employeeId: 'EMP003',
      employeeName: 'Chetan Verma',
      employeeType: 'Offroll',
      section: 'FATP',
      department: 'Production',
      floor: 'FATP-STB',
      line: 'FATP-STB',
      designation: 'Line Helper',
      qrCodeToken: 'SECRET_QR_EMP003',
      employeeStatus: 'Active',
      joiningDate: '2026-11-01',
      createdAt: '2026-11-01T08:00:00+05:30',
      updatedAt: '2026-11-01T08:00:00+05:30',
    },
    {
      employeeId: 'EMP004',
      employeeName: 'Deepa Nair',
      employeeType: 'Permanent',
      section: 'STORE',
      department: 'Store',
      floor: 'MI-01',
      line: 'MI-01',
      designation: 'Store Keeper',
      qrCodeToken: 'SECRET_QR_EMP004',
      employeeStatus: 'Active',
      joiningDate: '2026-11-10', // Joined mid-month
      createdAt: '2026-11-10T08:00:00+05:30',
      updatedAt: '2026-11-10T08:00:00+05:30',
    },
    {
      employeeId: 'EMP005',
      employeeName: 'Eshan Joshi',
      employeeType: 'Permanent',
      section: 'MI',
      department: 'Production',
      floor: 'MI-01',
      line: 'MI-01',
      designation: 'Technician',
      qrCodeToken: 'SECRET_QR_EMP005',
      employeeStatus: 'Active',
      joiningDate: '2026-11-01',
      createdAt: '2026-11-01T08:00:00+05:30',
      updatedAt: '2026-11-01T08:00:00+05:30',
    },
    {
      employeeId: 'EMP006',
      employeeName: 'Farhan Khan',
      employeeType: 'Offroll',
      section: 'SMT',
      department: 'Quality',
      floor: 'SMT-01',
      line: 'SMT-01',
      designation: 'Operator',
      qrCodeToken: 'SECRET_QR_EMP006',
      employeeStatus: 'Inactive',
      joiningDate: '2026-11-01',
      exitDate: '2026-11-05',
      createdAt: '2026-11-01T08:00:00+05:30',
      updatedAt: '2026-11-05T18:00:00+05:30',
    },
  ];

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_MS);

    db = new InMemoryFirestore();
    auth = new InMemoryAdminAuth();
    await seedIsolatedTestEnvironment(db, auth);

    // Explicitly revoke history & reports view from standard USER role to test strict RBAC
    await db.collection('role_permissions').doc('user').set(
      {
        roleId: 'user',
        roleName: 'User',
        modulePermissions: {
          dashboard: { view: true, add: false, edit: false, delete: false },
          scanner: { view: true, add: true, edit: false, delete: false },
          history: { view: false, add: false, edit: false, delete: false },
          reports: { view: false, add: false, edit: false, delete: false },
        },
        updatedAt: new Date(FIXED_NOW_MS).toISOString(),
        updatedBy: 'superadmin',
      },
      { merge: true }
    );

    // Seed employees
    for (const emp of employeesFixture) {
      await db.collection('employees').doc(emp.employeeId).set(emp);
    }

    // Seed Declared Holiday: Monday 2026-11-16 (Guru Nanak Jayanti / Plant Holiday)
    await db.collection('holidays').doc('hol_2026-11-16').set({
      date: '2026-11-16',
      name: 'Plant Declared Holiday',
      status: 'Active',
    });

    // Seed Approved Leave for EMP002 on 2026-11-18
    await db.collection('leaves').doc('lv_emp002_nov18').set({
      employeeId: 'EMP002',
      startDate: '2026-11-18',
      endDate: '2026-11-18',
      leaveType: 'Casual Leave',
      reason: 'Family Function',
      status: 'APPROVED',
    });

    // Seed Attendance Records:
    // EMP001: Present on Nov 12, Nov 13, Nov 14 (with OT), Nov 17 (AUTO CLOSED), Nov 18 (IN PROGRESS + LATE)
    const emp1 = employeesFixture[0];
    const attRecords: AttendanceRecord[] = [
      makeDayAttendance({ employee: emp1, shiftDate: '2026-11-12', punchInTime: '09:00:00', punchOutTime: '17:30:00' }),
      makeDayAttendance({ employee: emp1, shiftDate: '2026-11-13', punchInTime: '09:00:00', punchOutTime: '14:00:00' }), // 5h = HALF DAY
      makeDayAttendance({ employee: emp1, shiftDate: '2026-11-14', punchInTime: '09:00:00', punchOutTime: '19:30:00' }), // 10h30m = COMPLETED + OT (2h OT)
      makeDayAttendance({ employee: emp1, shiftDate: '2026-11-17', punchInTime: '09:30:00', punchOutTime: null, autoClosed: true, isLate: true }), // AUTO CLOSED (8h duty, 0 OT)
      makeDayAttendance({ employee: emp1, shiftDate: '2026-11-18', punchInTime: '09:25:00', punchOutTime: null, autoClosed: false, isLate: true }), // IN PROGRESS + LATE

      // EMP002: Present Nov 12..14, Nov 17 (SHORT LEAVE: 09:00 -> 11:30 = 2h30m), Approved Leave on Nov 18
      makeDayAttendance({ employee: employeesFixture[1], shiftDate: '2026-11-12', punchInTime: '09:00:00', punchOutTime: '17:30:00' }),
      makeDayAttendance({ employee: employeesFixture[1], shiftDate: '2026-11-13', punchInTime: '09:00:00', punchOutTime: '17:30:00' }),
      makeDayAttendance({ employee: employeesFixture[1], shiftDate: '2026-11-14', punchInTime: '09:00:00', punchOutTime: '17:30:00' }),
      makeDayAttendance({ employee: employeesFixture[1], shiftDate: '2026-11-17', punchInTime: '09:00:00', punchOutTime: '11:30:00' }),

      // EMP003: Last present Thu 2026-11-12; Absent Fri Nov 13, Sat Nov 14, [Sun Nov 15 Weekly Off], [Mon Nov 16 Holiday], Absent Tue Nov 17, Wed Nov 18
      // => Consecutive Absent Working Days on Nov 18 = 4 working days (13, 14, 17, 18)!
      makeDayAttendance({ employee: employeesFixture[2], shiftDate: '2026-11-12', punchInTime: '09:00:00', punchOutTime: '17:30:00' }),

      // EMP004: Joined Nov 10. Present Nov 10..14, Nov 17. Absent ONLY Nov 18 (1 consecutive working day)
      makeDayAttendance({ employee: employeesFixture[3], shiftDate: '2026-11-10', punchInTime: '09:00:00', punchOutTime: '17:30:00' }),
      makeDayAttendance({ employee: employeesFixture[3], shiftDate: '2026-11-11', punchInTime: '09:00:00', punchOutTime: '17:30:00' }),
      makeDayAttendance({ employee: employeesFixture[3], shiftDate: '2026-11-12', punchInTime: '09:00:00', punchOutTime: '17:30:00' }),
      makeDayAttendance({ employee: employeesFixture[3], shiftDate: '2026-11-13', punchInTime: '09:00:00', punchOutTime: '17:30:00' }),
      makeDayAttendance({ employee: employeesFixture[3], shiftDate: '2026-11-14', punchInTime: '09:00:00', punchOutTime: '17:30:00' }),
      makeDayAttendance({ employee: employeesFixture[3], shiftDate: '2026-11-17', punchInTime: '09:00:00', punchOutTime: '17:30:00' }),

      // EMP005: Present Nov 18 (AUTO CLOSED for KPI verification of auto-closed count on Nov 18)
      makeDayAttendance({ employee: employeesFixture[4], shiftDate: '2026-11-18', punchInTime: '09:00:00', punchOutTime: null, autoClosed: true }),
    ];

    for (const rec of attRecords) {
      await db.collection('attendance').doc(rec.id).set(rec);
    }

    const created = createApp({
      db,
      auth,
      projectId: 'narid-atdc-tracker',
      databaseId: 'ai-studio-manpowertracker-9b87a863-5c0d-4126-accb-7a3be802b10b',
      credentialMode: 'ADC',
      disableBackgroundBoot: true,
      nowProvider: () => FIXED_NOW_MS,
    });
    app = created.app;

    superAdminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.superadmin.uid);
    adminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid);
    userToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.user.uid);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('TC1: Top 8 Summary KPI cards return exact real backend counts (no static/sample values)', async () => {
    const res = await request(app)
      .get('/api/attendance-history/overview?date=2026-11-18')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Active employees: EMP001..EMP005 = 5 (EMP006 is Inactive)
    // On 2026-11-18:
    // - EMP001: IN PROGRESS + LATE (attended)
    // - EMP002: APPROVED LEAVE (not scheduled working, not absent)
    // - EMP003: ABSENT (4 consecutive working days -> counts as consecutive absentee)
    // - EMP004: ABSENT (1 consecutive working day)
    // - EMP005: AUTO CLOSED (attended)
    expect(res.body.kpis.totalActiveEmployees).toBe(5);
    expect(res.body.kpis.presentToday).toBe(2);
    expect(res.body.kpis.absentToday).toBe(2);
    expect(res.body.kpis.lateArrivals).toBe(1);
    expect(res.body.kpis.autoClosedAttendance).toBe(1);
    expect(res.body.kpis.currentlyIn).toBe(1);
    expect(res.body.kpis.consecutiveAbsentees).toBe(1); // EMP003 >= 2 working days
    // Attendance % = 2 present / 4 scheduled working = 50.0%
    expect(res.body.kpis.overallAttendancePercentage).toBe(50);
    expect(res.body.scheduleSummary.approvedLeaveCount).toBe(1);
  });

  it('TC2: Employee Search finds by ID, Name, Line, and Department while stripping PII & QR tokens', async () => {
    const byId = await request(app)
      .get('/api/attendance-history/employees?q=EMP001')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(byId.status).toBe(200);
    expect(byId.body.employees).toHaveLength(1);
    const emp = byId.body.employees[0];
    expect(emp.employeeId).toBe('EMP001');
    expect(emp.employeeName).toBe('Aarav Sharma');
    expect(emp.line).toBe('MI-01');
    expect(emp.department).toBe('Production');
    // Strict PII & secret stripping
    expect(emp.qrCodeToken).toBeUndefined();
    expect(emp.phone).toBeUndefined();
    expect(emp.email).toBeUndefined();
    expect(emp.address).toBeUndefined();

    const byDept = await request(app)
      .get('/api/attendance-history/employees?q=Quality')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(byDept.status).toBe(200);
    expect(byDept.body.employees.map((e: any) => e.employeeId)).toEqual(['EMP002', 'EMP006']);
  });

  it('TC3: Monthly Employee Calendar returns exact calendar days with zero duplicate dates', async () => {
    const res = await request(app)
      .get('/api/attendance-history/employee/EMP001/calendar?year=2026&month=11')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.days).toHaveLength(30); // Nov has 30 days
    const uniqueDates = new Set(res.body.days.map((d: any) => d.date));
    expect(uniqueDates.size).toBe(30);
    expect(res.body.days[0].date).toBe('2026-11-01');
    expect(res.body.days[29].date).toBe('2026-11-30');
  });

  it('TC4: Calendar preserves Present, Half Day, Short Leave, Auto Closed, In Progress & exact Duty/OT math', async () => {
    const res1 = await request(app)
      .get('/api/attendance-history/employee/EMP001/calendar?year=2026&month=11')
      .set('Authorization', `Bearer ${adminToken}`);
    const byDate1 = new Map<string, any>(res1.body.days.map((d: any) => [d.date, d]));

    expect(byDate1.get('2026-11-12').status).toBe('PRESENT');
    expect(byDate1.get('2026-11-12').dutyHours).toBe('08:30');
    expect(byDate1.get('2026-11-12').otHours).toBe('00:00');

    expect(byDate1.get('2026-11-13').status).toBe('HALF DAY');
    expect(byDate1.get('2026-11-13').dutyHours).toBe('05:00');

    expect(byDate1.get('2026-11-14').status).toBe('PRESENT');
    expect(byDate1.get('2026-11-14').rawAttendanceStatus).toBe('COMPLETED + OT');
    expect(byDate1.get('2026-11-14').dutyHours).toBe('08:30');
    expect(byDate1.get('2026-11-14').otHours).toBe('02:00');
    expect(byDate1.get('2026-11-14').totalWorkingHours).toBe('10:30');

    // Late arrival Auto-Closed at 09:30 -> 17:30 = 08:00 duty, 00:00 OT (never blindly 08:30!)
    expect(byDate1.get('2026-11-17').status).toBe('AUTO CLOSED');
    expect(byDate1.get('2026-11-17').dutyHours).toBe('08:00');
    expect(byDate1.get('2026-11-17').otHours).toBe('00:00');
    expect(byDate1.get('2026-11-17').autoCloseTime).toBe('05:30 PM');

    expect(byDate1.get('2026-11-18').status).toBe('IN PROGRESS');
    expect(byDate1.get('2026-11-18').actualPunchOut).toBe('In Progress');

    const res2 = await request(app)
      .get('/api/attendance-history/employee/EMP002/calendar?year=2026&month=11')
      .set('Authorization', `Bearer ${adminToken}`);
    const byDate2 = new Map<string, any>(res2.body.days.map((d: any) => [d.date, d]));
    expect(byDate2.get('2026-11-17').status).toBe('SHORT LEAVE');
    expect(byDate2.get('2026-11-17').dutyHours).toBe('02:30');
  });

  it('TC5: Verified absent scheduled working day displays ABSENT – NO ATTENDANCE RECORD', async () => {
    const res = await request(app)
      .get('/api/attendance-history/employee/EMP003/calendar?year=2026&month=11')
      .set('Authorization', `Bearer ${adminToken}`);
    const byDate = new Map<string, any>(res.body.days.map((d: any) => [d.date, d]));
    const nov17 = byDate.get('2026-11-17');
    expect(nov17.status).toBe('ABSENT');
    expect(nov17.statusReason).toBe('ABSENT – NO ATTENDANCE RECORD');
    expect(nov17.actualPunchIn).toBe('N/A');
  });

  it('TC6: Weekly Off days (Sunday) are classified as WEEKLY OFF and never marked ABSENT', async () => {
    const res = await request(app)
      .get('/api/attendance-history/employee/EMP003/calendar?year=2026&month=11')
      .set('Authorization', `Bearer ${adminToken}`);
    const byDate = new Map<string, any>(res.body.days.map((d: any) => [d.date, d]));
    // Sundays in Nov 2026: 1, 8, 15
    expect(byDate.get('2026-11-01').status).toBe('WEEKLY OFF');
    expect(byDate.get('2026-11-08').status).toBe('WEEKLY OFF');
    expect(byDate.get('2026-11-15').status).toBe('WEEKLY OFF');
    expect(byDate.get('2026-11-15').isScheduledWorkingDay).toBe(false);
  });

  it('TC7: Declared Holidays are classified as HOLIDAY and never marked ABSENT', async () => {
    const res = await request(app)
      .get('/api/attendance-history/employee/EMP003/calendar?year=2026&month=11')
      .set('Authorization', `Bearer ${adminToken}`);
    const byDate = new Map<string, any>(res.body.days.map((d: any) => [d.date, d]));
    expect(byDate.get('2026-11-16').status).toBe('HOLIDAY');
    expect(byDate.get('2026-11-16').leaveOrOffDetail).toContain('Plant Declared Holiday');
  });

  it('TC8: Approved Leave is classified as APPROVED LEAVE and never marked ABSENT', async () => {
    const res = await request(app)
      .get('/api/attendance-history/employee/EMP002/calendar?year=2026&month=11')
      .set('Authorization', `Bearer ${adminToken}`);
    const byDate = new Map<string, any>(res.body.days.map((d: any) => [d.date, d]));
    expect(byDate.get('2026-11-18').status).toBe('APPROVED LEAVE');
    expect(byDate.get('2026-11-18').leaveOrOffDetail).toContain('Casual Leave');
  });

  it('TC9: Pre-joining dates and Inactive post-exit dates are classified as NOT EMPLOYED, never ABSENT', async () => {
    // EMP004 joined 2026-11-10 -> Nov 1..9 must be NOT EMPLOYED
    const res4 = await request(app)
      .get('/api/attendance-history/employee/EMP004/calendar?year=2026&month=11')
      .set('Authorization', `Bearer ${adminToken}`);
    const byDate4 = new Map<string, any>(res4.body.days.map((d: any) => [d.date, d]));
    expect(byDate4.get('2026-11-05').status).toBe('NOT EMPLOYED');
    expect(byDate4.get('2026-11-09').status).toBe('NOT EMPLOYED');
    expect(byDate4.get('2026-11-10').status).toBe('PRESENT');

    // EMP006 inactive after 2026-11-05 -> Nov 6..18 must be NOT EMPLOYED
    const res6 = await request(app)
      .get('/api/attendance-history/employee/EMP006/calendar?year=2026&month=11')
      .set('Authorization', `Bearer ${adminToken}`);
    const byDate6 = new Map<string, any>(res6.body.days.map((d: any) => [d.date, d]));
    expect(byDate6.get('2026-11-10').status).toBe('NOT EMPLOYED');
    expect(byDate6.get('2026-11-18').status).toBe('NOT EMPLOYED');
  });

  it('TC10: Future dates are classified as FUTURE DATE and never counted as ABSENT', async () => {
    const res = await request(app)
      .get('/api/attendance-history/employee/EMP004/calendar?year=2026&month=11')
      .set('Authorization', `Bearer ${adminToken}`);
    const byDate = new Map<string, any>(res.body.days.map((d: any) => [d.date, d]));
    expect(byDate.get('2026-11-19').status).toBe('FUTURE DATE');
    expect(byDate.get('2026-11-30').status).toBe('FUTURE DATE');
    expect(res.body.summary.futureDays).toBe(12); // Nov 19..30
  });

  it('TC11: Unverified / missing schedule marks day as UNKNOWN / NOT VERIFIED instead of assuming ABSENT', () => {
    const dayShift: Shift = {
      id: 'DAY',
      name: 'DAY SHIFT',
      startTime: '09:00',
      endTime: '17:30',
      scheduledDurationMinutes: 510,
      punchInWindowStart: '06:00',
      punchInWindowEnd: '18:00',
      isOvernight: false,
      gracePeriodMinutes: 15,
      status: 'Active',
    };
    const ctx: ClassificationContext = {
      todayIstKey: '2026-11-18',
      nowMs: FIXED_NOW_MS,
      shiftsById: new Map([['DAY', dayShift]]),
      policy: {
        weeklyOffDays: [0],
        schedulePolicyMode: 'ROSTER_ONLY',
      },
      holidaysByDate: new Map(),
      rostersByEmpDate: new Map(),
      leavesByEmp: new Map(),
      attendanceByEmpDate: new Map(),
    };
    const result = classifyEmployeeDay(employeesFixture[0], '2026-11-17', ctx);
    expect(result.status).toBe('UNKNOWN');
    expect(result.statusReason).toContain('UNKNOWN / NOT VERIFIED');
    expect(result.isScheduledWorkingDay).toBe(false);
  });

  it('TC12: Monthly Attendance Summary calculates exact counts, Duty/OT totals, and Attendance %', async () => {
    // EMP004 joined Nov 10:
    // Nov 1..9: NOT EMPLOYED (9)
    // Nov 10..14: PRESENT (5)
    // Nov 15: WEEKLY OFF (1)
    // Nov 16: HOLIDAY (1)
    // Nov 17: PRESENT (1)
    // Nov 18: ABSENT (1)
    // Nov 19..30: FUTURE DATE (12)
    // Scheduled Working Days = 7 (6 Present + 1 Absent) -> 6/7 = 85.7%
    const res = await request(app)
      .get('/api/attendance-history/employee/EMP004/calendar?year=2026&month=11')
      .set('Authorization', `Bearer ${adminToken}`);
    const s = res.body.summary;
    expect(s.notEmployedDays).toBe(9);
    expect(s.presentDays).toBe(6);
    expect(s.absentDays).toBe(1);
    expect(s.weeklyOffDays).toBe(1);
    expect(s.holidays).toBe(1);
    expect(s.futureDays).toBe(12);
    expect(s.totalScheduledWorkingDays).toBe(7);
    expect(s.attendancePercentage).toBe(85.7);
    expect(s.totalDutyHours).toBe('51:00'); // 6 * 08:30
    expect(s.totalOtHours).toBe('00:00');
  });

  it('TC13: Consecutive Absent Working Days bridges Weekly Off & Holiday without inflating count', async () => {
    const res = await request(app)
      .get('/api/attendance-history/employee/EMP003/calendar?year=2026&month=11')
      .set('Authorization', `Bearer ${adminToken}`);
    const c = res.body.consecutiveAbsence;
    // EMP003: Present Thu Nov 12; Absent Fri 13, Sat 14, [Sun 15 Off], [Mon 16 Holiday], Absent Tue 17, Wed 18
    expect(c.isAbsentOnReferenceDate).toBe(true);
    expect(c.consecutiveAbsentWorkingDays).toBe(4);
    expect(c.firstDateOfCurrentAbsence).toBe('2026-11-13');
    expect(c.lastPresentDate).toBe('2026-11-12');
  });

  it('TC14: Returning to work resets Consecutive Absence streak to 0 and preserves previous absence spells', () => {
    const emp = employeesFixture[2];
    const dayShift: Shift = {
      id: 'DAY',
      name: 'DAY SHIFT',
      startTime: '09:00',
      endTime: '17:30',
      scheduledDurationMinutes: 510,
      punchInWindowStart: '06:00',
      punchInWindowEnd: '18:00',
      isOvernight: false,
      gracePeriodMinutes: 15,
      status: 'Active',
    };
    const attMap = new Map<string, AttendanceRecord>();
    attMap.set('EMP003__2026-11-12', makeDayAttendance({ employee: emp, shiftDate: '2026-11-12', punchInTime: '09:00:00' }));
    // Absent 13, 14, [15 Off], [16 Hol], 17 -> returns on 18!
    attMap.set('EMP003__2026-11-18', makeDayAttendance({ employee: emp, shiftDate: '2026-11-18', punchInTime: '09:00:00' }));

    const ctx: ClassificationContext = {
      todayIstKey: '2026-11-18',
      nowMs: FIXED_NOW_MS,
      shiftsById: new Map([['DAY', dayShift]]),
      policy: { weeklyOffDays: [0], schedulePolicyMode: 'DEFAULT_WEEKLY' },
      holidaysByDate: new Map([['2026-11-16', { date: '2026-11-16', name: 'Holiday' }]]),
      rostersByEmpDate: new Map(),
      leavesByEmp: new Map(),
      attendanceByEmpDate: attMap,
    };

    const metrics = computeConsecutiveAbsenceMetrics(emp, '2026-11-18', ctx);
    expect(metrics.isAbsentOnReferenceDate).toBe(false);
    expect(metrics.consecutiveAbsentWorkingDays).toBe(0);
    expect(metrics.lastPresentDate).toBe('2026-11-18');
    expect(metrics.previousAbsenceSpells.length).toBeGreaterThanOrEqual(1);
    expect(metrics.previousAbsenceSpells[0]).toEqual({
      startDate: '2026-11-13',
      endDate: '2026-11-17',
      workingDays: 3,
    });
  });

  it('TC15: Absent Manpower endpoint returns 12-column schema, presets, filters, default consecutive sort & pagination', async () => {
    const res = await request(app)
      .get('/api/attendance-history/absent-manpower?date=2026-11-18&sortBy=consecutive_desc&page=1&pageSize=25')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2); // EMP003 (4d) and EMP004 (1d)
    expect(res.body.presetCounts.absentToday).toBe(2);
    expect(res.body.presetCounts.consecutive2Plus).toBe(1);
    expect(res.body.presetCounts.consecutive3Plus).toBe(1);

    // Default sort: highest consecutive absence first -> EMP003 before EMP004
    expect(res.body.records[0].employeeId).toBe('EMP003');
    expect(res.body.records[0].consecutiveAbsentWorkingDays).toBe(4);
    expect(res.body.records[0].lastPresentDate).toBe('2026-11-12');
    expect(res.body.records[0].firstDateOfCurrentAbsence).toBe('2026-11-13');
    expect(res.body.records[0].currentShift).toBe('DAY SHIFT');
    expect(res.body.records[1].employeeId).toBe('EMP004');
    expect(res.body.records[1].consecutiveAbsentWorkingDays).toBe(1);

    // Filter by 3+ consecutive days
    const res3Plus = await request(app)
      .get('/api/attendance-history/absent-manpower?date=2026-11-18&minConsecutive=3')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res3Plus.status).toBe(200);
    expect(res3Plus.body.records).toHaveLength(1);
    expect(res3Plus.body.records[0].employeeId).toBe('EMP003');
  });

  it('TC16: Daily Attendance Ledger supports server-side date range, status filter, sorting & pagination', async () => {
    const res = await request(app)
      .get('/api/attendance-history/daily?startDate=2026-11-14&endDate=2026-11-18&status=AUTO%20CLOSED')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2); // EMP001 Nov 17 & EMP005 Nov 18
    const nov17Emp1 = res.body.records.find(
      (r: any) => r.employeeId === 'EMP001' && r.attendanceDate === '2026-11-17'
    );
    expect(nov17Emp1).toBeTruthy();
    expect(nov17Emp1.autoCloseTime).toBe('05:30 PM');
    expect(nov17Emp1.dutyHours).toBe('08:00');
    expect(nov17Emp1.otHours).toBe('00:00');
    expect(nov17Emp1.totalWorkingHours).toBe('08:00');
  });

  it('TC17: Attendance Analytics returns real backend-aggregated trends, breakdowns & continuous absences', async () => {
    const res = await request(app)
      .get('/api/attendance-history/analytics?date=2026-11-18&month=2026-11')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.dailyTrend).toHaveLength(14);
    expect(res.body.monthlyTrend.length).toBeGreaterThanOrEqual(3);
    expect(res.body.departmentWise.length).toBeGreaterThanOrEqual(3);
    expect(res.body.lineWise.length).toBeGreaterThanOrEqual(3);
    expect(res.body.shiftWise.length).toBeGreaterThanOrEqual(1);
    expect(res.body.employeeTypeWise.length).toBeGreaterThanOrEqual(3);
    expect(res.body.longestContinuousAbsence[0].employeeId).toBe('EMP003');
    expect(res.body.longestContinuousAbsence[0].consecutiveAbsentWorkingDays).toBe(4);
    expect(res.body.topAbsenceEmployees.length).toBeGreaterThan(0);
  });

  it('TC18: Strict RBAC enforces 401/403 on all endpoints and never mutates employee status on absence', async () => {
    const endpoints = [
      '/api/attendance-history/overview?date=2026-11-18',
      '/api/attendance-history/employees?q=EMP001',
      '/api/attendance-history/employee/EMP001/calendar?year=2026&month=11',
      '/api/attendance-history/absent-manpower?date=2026-11-18',
      '/api/attendance-history/daily?startDate=2026-11-12&endDate=2026-11-18',
      '/api/attendance-history/analytics?date=2026-11-18&month=2026-11',
    ];

    for (const ep of endpoints) {
      const unauth = await request(app).get(ep);
      expect(unauth.status).toBe(401);

      const forbidden = await request(app).get(ep).set('Authorization', `Bearer ${userToken}`);
      expect(forbidden.status).toBe(403);

      const superOk = await request(app).get(ep).set('Authorization', `Bearer ${superAdminToken}`);
      expect(superOk.status).toBe(200);
    }

    // Verify EMP003 (4 consecutive absent days) was NEVER disabled or deleted
    const emp3Doc = await db.collection('employees').doc('EMP003').get();
    expect(emp3Doc.exists).toBe(true);
    expect(emp3Doc.data()?.employeeStatus).toBe('Active');
  });

  it('TC19: Excel (.xlsx) exports & SSR UI render all required sections and columns cleanly', async () => {
    const calRes = await request(app)
      .get('/api/attendance-history/employee/EMP001/calendar?year=2026&month=11')
      .set('Authorization', `Bearer ${adminToken}`);
    const absRes = await request(app)
      .get('/api/attendance-history/absent-manpower?date=2026-11-18')
      .set('Authorization', `Bearer ${adminToken}`);
    const anaRes = await request(app)
      .get('/api/attendance-history/analytics?date=2026-11-18&month=2026-11')
      .set('Authorization', `Bearer ${adminToken}`);

    // Use real timers before ExcelJS zip serialization
    vi.useRealTimers();

    // 1. Employee Monthly Calendar Excel
    const calRows = buildEmployeeMonthlyCalendarExportRows(
      calRes.body.employee,
      calRes.body.days,
      calRes.body.summary
    );
    const calBuf = await buildPremiumExcelWorkbookBuffer({
      rows: calRows,
      columns: EMPLOYEE_MONTHLY_CALENDAR_EXPORT_COLUMNS,
      fileName: 'EMP001_Calendar',
      reportTitle: 'Employee Monthly Attendance Calendar',
      periodLabel: 'Nov 2026',
    });
    const wbCal = new ExcelJS.Workbook();
    await wbCal.xlsx.load(Buffer.from(calBuf) as any);
    expect(wbCal.worksheets.length).toBeGreaterThanOrEqual(1);

    // 2. Absent Manpower 12-Column Excel
    const absRows = buildAbsentManpowerExportRows(absRes.body.records);
    const absBuf = await buildPremiumExcelWorkbookBuffer({
      rows: absRows,
      columns: ABSENT_MANPOWER_12_COLUMNS,
      fileName: 'Absent_Manpower',
      reportTitle: 'Absent Manpower Report',
      periodLabel: '2026-11-18',
      summary: null,
    });
    const wbAbs = new ExcelJS.Workbook();
    await wbAbs.xlsx.load(Buffer.from(absBuf) as any);
    const absSheet = wbAbs.worksheets[0];
    let foundAbsentHeader = false;
    absSheet.eachRow((r) => {
      const vals = (r.values as any[]).map((v) => String(v || ''));
      if (vals.includes('Consecutive Absent Working Days')) {
        foundAbsentHeader = true;
      }
    });
    expect(foundAbsentHeader).toBe(true);

    // 3. Department Analytics Excel
    const deptBuilt = buildAnalyticsGroupExportRows(anaRes.body.departmentWise, 'Department');
    const deptBuf = await buildPremiumExcelWorkbookBuffer({
      rows: deptBuilt.rows,
      columns: deptBuilt.columns,
      fileName: 'Dept_Analytics',
      reportTitle: 'Department-Wise Attendance Analytics',
      periodLabel: '2026-11-18',
      summary: null,
    });
    expect(deptBuf.byteLength).toBeGreaterThan(1000);

    // 4. SSR Smoke Verification for active Attendance History UI modules
    const htmlMain = renderToStaticMarkup(
      React.createElement(AttendanceHistory, {
        floors: [],
        sections: [],
        departments: [],
        shifts: [],
      })
    );
    expect(htmlMain).toContain('ATTENDANCE HISTORY');
    expect(htmlMain).toContain('Employee Attendance Calendar');
    expect(htmlMain).toContain('Daily Attendance');
    expect(htmlMain).toContain('Absent Manpower');
    expect(htmlMain).not.toContain('Attendance Analytics');
    expect(htmlMain).toContain('Total Active');
    expect(htmlMain).toContain('Present Today');
    expect(htmlMain).toContain('Absent Today');

    const htmlCal = renderToStaticMarkup(React.createElement(EmployeeMonthlyCalendar, {}));
    expect(htmlCal).toContain('Search Employee');

    const htmlAbs = renderToStaticMarkup(
      React.createElement(AbsentManpowerPanel, {
        selectedDate: '2026-11-18',
        onDateChange: () => {},
        floors: [],
        sections: [],
        departments: [],
        shifts: [],
      })
    );
    expect(htmlAbs).toContain('Consecutive Absent Working Days');
    expect(htmlAbs).toContain('First Date of Current Absence');
  });
});
