import { AttendanceRecord, Department, Employee, Floor, Section } from '../types';
import {
  formatDurationClock,
  formatIsoTimeKolkata12h,
  resolveAttendanceMetrics,
} from './attendanceStatus';

export type ReportType =
  | 'daily_attendance'
  | 'monthly_attendance'
  | 'floor_wise'
  | 'section_wise'
  | 'dept_wise'
  | 'emp_type'
  | 'shift_wise'
  | 'employee_wise'
  | 'late_arrival'
  | 'missed_punch_out'
  | 'overtime'
  | 'absent_manpower';

export interface ReportColumn {
  header: string;
  key: string;
}

export interface AttendanceReportSummary {
  totalEmployees: number;
  completedCount: number;
  autoClosedCount: number;
  halfDayCount: number;
  shortLeaveCount: number;
  inProgressCount: number;
  totalOtMinutes: number;
  totalOtHoursFormatted: string;
}

export interface BuildReportTableParams {
  attendanceRecords: AttendanceRecord[];
  activeEmps: Employee[];
  floors: Floor[];
  sections: Section[];
  departments: Department[];
  selectedDate: string;
  selectedMonth?: string;
  nowMs?: number;
}

export interface BuiltReportTable {
  tableColumns: ReportColumn[];
  tableData: Record<string, any>[];
  fileName: string;
  reportTitle: string;
  periodLabel: string;
  summary: AttendanceReportSummary | null;
}

/**
 * Exact 16-column primary schema for Daily Attendance, Monthly Attendance,
 * Employee-wise Attendance, Missed Punch Out, Shift-wise, Late Arrival,
 * Overtime, and Attendance History exports (UI Preview, Excel .xlsx, and CSV).
 */
export const PRIMARY_ATTENDANCE_REPORT_COLUMNS: ReportColumn[] = [
  { header: 'Employee ID', key: 'employeeId' },
  { header: 'Name', key: 'name' },
  { header: 'Line', key: 'floor' },
  { header: 'Department', key: 'dept' },
  { header: 'Attendance Date', key: 'date' },
  { header: 'Shift', key: 'shift' },
  { header: 'Scheduled Shift Start', key: 'scheduledStart' },
  { header: 'Scheduled Shift End', key: 'scheduledEnd' },
  { header: 'Actual Punch-In', key: 'inTime' },
  { header: 'Actual Punch-Out', key: 'actualOutTime' },
  { header: 'Auto-Close Time', key: 'autoCloseTime' },
  { header: 'Attendance Status', key: 'status' },
  { header: 'Auto-Close Recorded At', key: 'autoCloseRecordedAt' },
  { header: 'Duty Hours', key: 'dutyHours' },
  { header: 'OT Hours', key: 'otHours' },
  { header: 'Total Working Hours', key: 'totalWorkingHours' },
];

/**
 * Attendance History Excel (.xlsx) & CSV exports use the exact same 16 primary columns.
 */
export const ATTENDANCE_HISTORY_EXPORT_COLUMNS: ReportColumn[] =
  PRIMARY_ATTENDANCE_REPORT_COLUMNS;

/**
 * Single source of truth for row mapping across Reports, Attendance History exports,
 * Excel (.xlsx), and CSV downloads.
 */
export function buildStandardAttendanceRow(
  a: AttendanceRecord,
  nowMs: number = Date.now()
): Record<string, any> {
  const m = resolveAttendanceMetrics(a, nowMs);
  const dutyMinutes = m.isOpen ? 0 : m.regularDutyMinutes;
  const otMinutes = m.isOpen ? 0 : m.overtimeMinutes;
  const totalWorkingMinutes = m.isOpen ? 0 : m.completedDutyMinutes;

  // Actual Punch-Out: show actual time ONLY when a genuine Punch-Out exists; otherwise 'N/A'.
  const actualOutTime = m.actualPunchOutIso ? m.actualPunchOutDisplay : 'N/A';

  // Auto-Close Time & Auto-Close Recorded At: show ONLY when currently Auto-Closed / Missed Punch Out.
  const autoCloseTime = m.isCurrentlyAutoClosed ? m.autoCloseTimeDisplay : 'N/A';
  const autoCloseRecordedAt = m.isCurrentlyAutoClosed ? m.autoCloseRecordedAtDisplay : 'N/A';

  return {
    employeeId: a.employeeId,
    name: a.employeeNameSnapshot,
    floor: a.floorIdSnapshot,
    dept: a.departmentIdSnapshot,
    date: a.shiftDate,
    shift: a.shiftNameSnapshot,
    scheduledStart: m.scheduledStartDisplay,
    scheduledEnd: m.scheduledEndDisplay,
    inTime: formatIsoTimeKolkata12h(a.firstPunchIn || a.punchIn),
    actualOutTime,
    autoCloseTime,
    status: m.status,
    autoCloseRecordedAt,
    dutyHours: formatDurationClock(dutyMinutes),
    otHours: formatDurationClock(otMinutes),
    totalWorkingHours: formatDurationClock(totalWorkingMinutes),
    // Internal metadata used by styled Excel duration cells & dynamic executive summary
    _dutyMinutes: dutyMinutes,
    _otMinutes: otMinutes,
    _totalWorkingMinutes: totalWorkingMinutes,
    _status: m.status,
    _isAutoClosed: m.isCurrentlyAutoClosed,
    _isOpen: m.isOpen,
  };
}

export function buildAttendanceHistoryExportRows(
  sourceRecords: AttendanceRecord[],
  nowMs: number = Date.now()
): Record<string, any>[] {
  return sourceRecords.map((r) => buildStandardAttendanceRow(r, nowMs));
}

/**
 * Dynamically computes Executive Summary KPIs from exported attendance rows.
 */
export function computeAttendanceReportSummary(
  rows: Record<string, any>[]
): AttendanceReportSummary {
  const uniqueEmployeeIds = new Set<string>();
  let completedCount = 0;
  let autoClosedCount = 0;
  let halfDayCount = 0;
  let shortLeaveCount = 0;
  let inProgressCount = 0;
  let totalOtMinutes = 0;

  for (const row of rows) {
    if (row.employeeId) {
      uniqueEmployeeIds.add(String(row.employeeId).trim().toUpperCase());
    }
    const status = String(row._status || row.status || '').trim().toUpperCase();
    if (status === 'COMPLETED' || status === 'COMPLETED + OT') {
      completedCount += 1;
    } else if (status === 'AUTO CLOSED' || status === 'MISSED PUNCH OUT') {
      autoClosedCount += 1;
    } else if (status === 'HALF DAY') {
      halfDayCount += 1;
    } else if (status === 'SHORT LEAVE') {
      shortLeaveCount += 1;
    } else if (status === 'IN PROGRESS') {
      inProgressCount += 1;
    }

    const rowOt = Number(row._otMinutes || 0);
    if (Number.isFinite(rowOt) && rowOt > 0) {
      totalOtMinutes += Math.floor(rowOt);
    }
  }

  return {
    totalEmployees: uniqueEmployeeIds.size || rows.length,
    completedCount,
    autoClosedCount,
    halfDayCount,
    shortLeaveCount,
    inProgressCount,
    totalOtMinutes,
    totalOtHoursFormatted: formatDurationClock(totalOtMinutes),
  };
}

const REPORT_TITLES: Record<ReportType, string> = {
  daily_attendance: 'Daily Attendance Report',
  monthly_attendance: 'Monthly Attendance Report',
  floor_wise: 'Line-Wise Manpower Report',
  section_wise: 'Section-Wise Manpower Report',
  dept_wise: 'Department-Wise Manpower Report',
  emp_type: 'Employee Type Manpower Report',
  shift_wise: 'Shift-Wise Attendance Report',
  employee_wise: 'Employee-Wise Attendance Report',
  late_arrival: 'Late Arrival Report',
  missed_punch_out: 'Missed Punch Out / Auto-Closed Report',
  overtime: 'Overtime (OT) Report',
  absent_manpower: 'Absent Manpower Report',
};

const REPORT_FILE_PREFIXES: Record<ReportType, string> = {
  daily_attendance: 'NARID_Daily_Attendance',
  monthly_attendance: 'NARID_Monthly_Attendance',
  floor_wise: 'NARID_Line_Manpower',
  section_wise: 'NARID_Section_Manpower',
  dept_wise: 'NARID_Department_Manpower',
  emp_type: 'NARID_Employee_Type_Manpower',
  shift_wise: 'NARID_Shift_Attendance',
  employee_wise: 'NARID_Employee_Attendance',
  late_arrival: 'NARID_Late_Arrival',
  missed_punch_out: 'NARID_Missed_Punch_Out',
  overtime: 'NARID_Overtime_Report',
  absent_manpower: 'NARID_Absent_Manpower',
};

/**
 * Pure, deterministic builder for all 12 Attendance Reports & Exports (UI preview, Excel .xlsx, and CSV).
 */
export function buildAttendanceReportTable(
  activeReport: ReportType,
  params: BuildReportTableParams
): BuiltReportTable {
  const {
    attendanceRecords,
    activeEmps,
    floors,
    sections,
    departments,
    selectedDate,
    selectedMonth,
    nowMs = Date.now(),
  } = params;

  let cols: ReportColumn[] = [];
  let rows: Record<string, any>[] = [];
  let includeAttendanceSummary = false;

  const periodLabel =
    activeReport === 'monthly_attendance' || activeReport === 'employee_wise'
      ? selectedMonth || selectedDate.substring(0, 7)
      : selectedDate;

  const reportTitle = REPORT_TITLES[activeReport] || 'Attendance Report';
  const fileName = `${REPORT_FILE_PREFIXES[activeReport] || 'NARID_Attendance_Report'}_${periodLabel}`;

  switch (activeReport) {
    case 'daily_attendance':
      cols = PRIMARY_ATTENDANCE_REPORT_COLUMNS;
      rows = [...attendanceRecords]
        .sort((a, b) => String(a.employeeId || '').localeCompare(String(b.employeeId || '')))
        .map((a) => buildStandardAttendanceRow(a, nowMs));
      includeAttendanceSummary = true;
      break;

    case 'floor_wise':
      cols = [
        { header: 'Production Line', key: 'floor' },
        { header: 'Active Employees', key: 'active' },
        { header: 'Present', key: 'present' },
        { header: 'Absent', key: 'absent' },
        { header: 'Availability %', key: 'percent' },
      ];
      rows = floors.map((fl) => {
        const total = activeEmps.filter((e) => e.floor === fl.name).length;
        const present = attendanceRecords.filter((a) => a.floorIdSnapshot === fl.name).length;
        const absent = Math.max(0, total - present);
        const percent = total > 0 ? `${Math.round((present / total) * 100)}%` : '0%';
        return { floor: fl.name, active: total, present, absent, percent };
      });
      break;

    case 'section_wise':
      cols = [
        { header: 'Section', key: 'section' },
        { header: 'Active Employees', key: 'active' },
        { header: 'Present', key: 'present' },
        { header: 'Absent', key: 'absent' },
        { header: 'Availability %', key: 'percent' },
      ];
      rows = sections.map((sec) => {
        const total = activeEmps.filter((e) => e.section === sec.name).length;
        const present = attendanceRecords.filter((a) => a.sectionIdSnapshot === sec.name).length;
        const absent = Math.max(0, total - present);
        const percent = total > 0 ? `${Math.round((present / total) * 100)}%` : '0%';
        return { section: sec.name, active: total, present, absent, percent };
      });
      break;

    case 'dept_wise':
      cols = [
        { header: 'Department', key: 'department' },
        { header: 'Active Employees', key: 'active' },
        { header: 'Present', key: 'present' },
        { header: 'Absent', key: 'absent' },
        { header: 'Availability %', key: 'percent' },
      ];
      rows = departments.map((d) => {
        const total = activeEmps.filter((e) => e.department === d.name).length;
        const present = attendanceRecords.filter((a) => a.departmentIdSnapshot === d.name).length;
        const absent = Math.max(0, total - present);
        const percent = total > 0 ? `${Math.round((present / total) * 100)}%` : '0%';
        return { department: d.name, active: total, present, absent, percent };
      });
      break;

    case 'emp_type':
      cols = [
        { header: 'Employee Type', key: 'type' },
        { header: 'Active Employees', key: 'active' },
        { header: 'Present', key: 'present' },
        { header: 'Absent', key: 'absent' },
        { header: 'Availability %', key: 'percent' },
      ];
      rows = ['Permanent', 'Staff', 'Offroll'].map((type) => {
        const total = activeEmps.filter((e) => e.employeeType === type).length;
        const present = attendanceRecords.filter((a) => a.employeeTypeSnapshot === type).length;
        const absent = Math.max(0, total - present);
        const percent = total > 0 ? `${Math.round((present / total) * 100)}%` : '0%';
        return { type, active: total, present, absent, percent };
      });
      break;

    case 'late_arrival':
      cols = PRIMARY_ATTENDANCE_REPORT_COLUMNS;
      rows = attendanceRecords
        .filter((a) => resolveAttendanceMetrics(a, nowMs).isLate)
        .map((a) => buildStandardAttendanceRow(a, nowMs));
      includeAttendanceSummary = true;
      break;

    case 'missed_punch_out':
      cols = PRIMARY_ATTENDANCE_REPORT_COLUMNS;
      rows = attendanceRecords
        .filter((a) => resolveAttendanceMetrics(a, nowMs).isCurrentlyAutoClosed)
        .map((a) => buildStandardAttendanceRow(a, nowMs));
      includeAttendanceSummary = true;
      break;

    case 'overtime':
      cols = PRIMARY_ATTENDANCE_REPORT_COLUMNS;
      rows = attendanceRecords
        .filter((a) => {
          const m = resolveAttendanceMetrics(a, nowMs);
          return !m.isOpen && m.overtimeMinutes > 0;
        })
        .map((a) => buildStandardAttendanceRow(a, nowMs));
      includeAttendanceSummary = true;
      break;

    case 'absent_manpower': {
      cols = [
        { header: 'Employee ID', key: 'employeeId' },
        { header: 'Name', key: 'name' },
        { header: 'Line', key: 'floor' },
        { header: 'Section', key: 'section' },
        { header: 'Department', key: 'dept' },
        { header: 'Type', key: 'type' },
        { header: 'Status', key: 'status' },
      ];
      const clockedIds = new Set(attendanceRecords.map((a) => a.employeeId));
      rows = activeEmps
        .filter((e) => !clockedIds.has(e.employeeId))
        .map((e) => ({
          employeeId: e.employeeId,
          name: e.employeeName,
          floor: e.floor,
          section: e.section,
          dept: e.department,
          type: e.employeeType,
          status: 'ABSENT',
        }));
      break;
    }

    default: {
      // Monthly Attendance, Shift-wise Attendance, and Employee-wise Attendance reports
      cols = PRIMARY_ATTENDANCE_REPORT_COLUMNS;
      const sortedRecords = [...attendanceRecords];
      if (activeReport === 'shift_wise') {
        sortedRecords.sort(
          (a, b) =>
            String(a.shiftId || '').localeCompare(String(b.shiftId || '')) ||
            String(a.employeeId || '').localeCompare(String(b.employeeId || ''))
        );
      } else if (activeReport === 'employee_wise') {
        sortedRecords.sort(
          (a, b) =>
            String(a.employeeId || '').localeCompare(String(b.employeeId || '')) ||
            String(a.shiftDate || '').localeCompare(String(b.shiftDate || ''))
        );
      } else {
        sortedRecords.sort(
          (a, b) =>
            String(a.shiftDate || '').localeCompare(String(b.shiftDate || '')) ||
            String(a.employeeId || '').localeCompare(String(b.employeeId || ''))
        );
      }

      rows = sortedRecords.map((a) => buildStandardAttendanceRow(a, nowMs));
      includeAttendanceSummary = true;
      break;
    }
  }

  const keyedRows = rows.map((row, idx) => ({
    ...row,
    _rowKey: `${activeReport}:${row.employeeId || row.floor || row.section || row.department || row.type || 'row'}:${row.date || idx}:${idx}`,
  }));

  return {
    tableColumns: cols,
    tableData: keyedRows,
    fileName,
    reportTitle,
    periodLabel,
    summary: includeAttendanceSummary ? computeAttendanceReportSummary(keyedRows) : null,
  };
}
