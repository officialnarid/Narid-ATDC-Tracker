import type { ReportColumn } from './attendanceReportBuilder';
import type {
  AbsentManpowerRow,
  CalendarDayDetail,
  MonthlyAttendanceSummary,
  SafeEmployeeProfile,
} from './attendanceCalendarEngine';
import type { AnalyticsGroupRow } from '../services/attendanceHistoryService';

export const EMPLOYEE_MONTHLY_CALENDAR_EXPORT_COLUMNS: ReportColumn[] = [
  { header: 'Attendance Date', key: 'date' },
  { header: 'Day', key: 'weekday' },
  { header: 'Employee ID', key: 'employeeId' },
  { header: 'Name', key: 'name' },
  { header: 'Line', key: 'floor' },
  { header: 'Department', key: 'dept' },
  { header: 'Shift', key: 'shift' },
  { header: 'Scheduled Shift Start', key: 'scheduledStart' },
  { header: 'Scheduled Shift End', key: 'scheduledEnd' },
  { header: 'Actual Punch-In', key: 'inTime' },
  { header: 'Actual Punch-Out', key: 'actualOutTime' },
  { header: 'Auto-Close Time', key: 'autoCloseTime' },
  { header: 'Attendance Status', key: 'status' },
  { header: 'Duty Hours', key: 'dutyHours' },
  { header: 'OT Hours', key: 'otHours' },
  { header: 'Total Working Hours', key: 'totalWorkingHours' },
  { header: 'Remarks / Off Detail', key: 'remarks' },
];

export const ABSENT_MANPOWER_12_COLUMNS: ReportColumn[] = [
  { header: 'Employee ID', key: 'employeeId' },
  { header: 'Employee Name', key: 'employeeName' },
  { header: 'Line', key: 'line' },
  { header: 'Section', key: 'section' },
  { header: 'Department', key: 'department' },
  { header: 'Employee Type', key: 'employeeType' },
  { header: 'Last Present Date', key: 'lastPresentDate' },
  { header: 'First Date of Current Absence', key: 'firstDateOfCurrentAbsence' },
  { header: 'Consecutive Absent Working Days', key: 'consecutiveAbsentWorkingDays' },
  { header: 'Total Absent Working Days in Selected Month', key: 'totalAbsentWorkingDaysInMonth' },
  { header: 'Current Shift', key: 'currentShift' },
  { header: 'Attendance Status', key: 'status' },
];

export const ANALYTICS_GROUP_EXPORT_COLUMNS: ReportColumn[] = [
  { header: 'Group Name', key: 'name' },
  { header: 'Active Employees', key: 'active' },
  { header: 'Scheduled Working', key: 'scheduled' },
  { header: 'Present', key: 'present' },
  { header: 'Absent', key: 'absent' },
  { header: 'Auto-Closed', key: 'autoClosed' },
  { header: 'Late Arrivals', key: 'late' },
  { header: 'Approved Leave', key: 'leave' },
  { header: 'Weekly Off', key: 'weeklyOff' },
  { header: 'Attendance %', key: 'percent' },
];

export function buildEmployeeMonthlyCalendarExportRows(
  employee: SafeEmployeeProfile,
  days: CalendarDayDetail[],
  _summary?: MonthlyAttendanceSummary
): Record<string, any>[] {
  return days.map((d) => ({
    date: d.date,
    weekday: d.weekdayLabel,
    employeeId: employee.employeeId,
    name: employee.employeeName,
    floor: employee.line,
    dept: employee.department,
    shift: d.shiftName,
    scheduledStart: d.scheduledShiftStart,
    scheduledEnd: d.scheduledShiftEnd,
    inTime: d.actualPunchIn,
    actualOutTime: d.actualPunchOut,
    autoCloseTime: d.autoCloseTime,
    status: d.status,
    dutyHours: d.dutyHours,
    otHours: d.otHours,
    totalWorkingHours: d.totalWorkingHours,
    remarks: d.leaveOrOffDetail || (d.status === 'ABSENT' ? 'ABSENT – NO ATTENDANCE RECORD' : d.statusReason),
    _dutyMinutes: d.dutyMinutes,
    _otMinutes: d.otMinutes,
    _totalWorkingMinutes: d.totalWorkingMinutes,
    _status: d.status,
    _isAutoClosed: d.isAutoClosed,
  }));
}

export function buildAbsentManpowerExportRows(rows: AbsentManpowerRow[]): Record<string, any>[] {
  return rows.map((r) => ({
    employeeId: r.employeeId,
    employeeName: r.employeeName,
    line: r.line,
    section: r.section,
    department: r.department,
    employeeType: r.employeeType,
    lastPresentDate: r.lastPresentDate || 'No Record',
    firstDateOfCurrentAbsence: r.firstDateOfCurrentAbsence || 'N/A',
    consecutiveAbsentWorkingDays: r.consecutiveAbsentWorkingDays,
    totalAbsentWorkingDaysInMonth: r.totalAbsentWorkingDaysInMonth,
    currentShift: r.currentShift,
    status: r.attendanceStatus,
  }));
}

export function buildAnalyticsGroupExportRows(
  rows: AnalyticsGroupRow[],
  labelHeader: string
): { columns: ReportColumn[]; rows: Record<string, any>[] } {
  const columns = ANALYTICS_GROUP_EXPORT_COLUMNS.map((c) =>
    c.key === 'name' ? { ...c, header: labelHeader } : c
  );
  const mapped = rows.map((r) => ({
    name: r.key,
    active: r.totalActive,
    scheduled: r.scheduled,
    present: r.present,
    absent: r.absent,
    autoClosed: r.autoClosed,
    late: r.late,
    leave: r.leave,
    weeklyOff: r.weeklyOff,
    percent: `${r.attendancePercentage.toFixed(1)}%`,
  }));
  return { columns, rows: mapped };
}
