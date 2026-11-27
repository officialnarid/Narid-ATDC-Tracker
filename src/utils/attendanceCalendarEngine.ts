import type { AttendanceRecord, Employee, Shift, ShiftRoster } from '../types/index.ts';
import {
  formatDurationClock,
  formatIsoTimeKolkata12h,
  resolveAttendanceMetrics,
  resolveShiftScheduleBounds,
  STANDARD_DUTY_MINUTES,
} from './attendanceStatus.ts';

// ============================================================================
// Types & Taxonomies (Authoritative Calendar & Absentee Classification)
// ============================================================================

export type CalendarDayStatus =
  | 'PRESENT'
  | 'ABSENT'
  | 'HALF DAY'
  | 'SHORT LEAVE'
  | 'AUTO CLOSED'
  | 'WEEKLY OFF'
  | 'HOLIDAY'
  | 'APPROVED LEAVE'
  | 'IN PROGRESS'
  | 'FUTURE DATE'
  | 'NOT EMPLOYED'
  | 'UNKNOWN';

export interface HolidayRecord {
  date: string; // YYYY-MM-DD
  name: string;
  description?: string;
  status?: string;
}

export interface ApprovedLeaveRecord {
  id?: string;
  employeeId: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  leaveType?: string;
  reason?: string;
  status: string; // 'APPROVED' | ...
}

export interface SchedulePolicyConfig {
  /** 0 = Sunday, 1 = Monday, ..., 6 = Saturday. Default: [0] (Sunday weekly off). */
  weeklyOffDays: number[];
  /**
   * When 'DEFAULT_WEEKLY' (default for NARID plant shifts), active employees follow the
   * configured weekly schedule unless overridden by shift_rosters / holidays / leaves.
   * When 'ROSTER_ONLY', days without an explicit shift_rosters entry are marked UNKNOWN.
   */
  schedulePolicyMode: 'DEFAULT_WEEKLY' | 'ROSTER_ONLY';
  /** If true, schedule/leave metadata could not be verified — missing days become UNKNOWN instead of ABSENT. */
  scheduleUnverified?: boolean;
  /** Optional default shift ID fallback when employee has no explicit shift assignment. */
  defaultShiftId?: string;
}

export interface SafeEmployeeProfile {
  employeeId: string;
  employeeName: string;
  line: string;
  floor: string;
  section: string;
  department: string;
  employeeType: string;
  designation: string;
  currentShiftId: string;
  currentShiftName: string;
  employeeStatus: 'Active' | 'Inactive';
  joiningDate: string | null;
  exitDate: string | null;
}

export interface CalendarDayDetail {
  date: string; // YYYY-MM-DD
  dayOfMonth: number;
  dayOfWeek: number; // 0 = Sun .. 6 = Sat
  weekdayLabel: string;
  status: CalendarDayStatus;
  rawAttendanceStatus: string | null;
  statusReason: string;
  isScheduledWorkingDay: boolean;
  isAttended: boolean;
  isLate: boolean;
  isAutoClosed: boolean;
  employeeId: string;
  employeeName: string;
  shiftId: string | null;
  shiftName: string;
  scheduledShiftStart: string;
  scheduledShiftEnd: string;
  actualPunchIn: string;
  actualPunchOut: string;
  autoCloseTime: string;
  autoCloseRecordedAt: string;
  dutyMinutes: number;
  otMinutes: number;
  totalWorkingMinutes: number;
  dutyHours: string;
  otHours: string;
  totalWorkingHours: string;
  leaveOrOffDetail: string | null;
  attendanceRecordId: string | null;
}

export interface MonthlyAttendanceSummary {
  year: number;
  month: number; // 1..12
  monthKey: string; // YYYY-MM
  totalCalendarDays: number;
  totalScheduledWorkingDays: number;
  presentDays: number;
  absentDays: number;
  halfDays: number;
  shortLeaveDays: number;
  approvedLeaveDays: number;
  weeklyOffDays: number;
  holidays: number;
  autoClosedDays: number;
  inProgressDays: number;
  futureDays: number;
  notEmployedDays: number;
  unknownDays: number;
  lateDays: number;
  attendedDays: number;
  totalDutyMinutes: number;
  totalOtMinutes: number;
  totalWorkingMinutes: number;
  totalDutyHours: string;
  totalOtHours: string;
  totalWorkingHours: string;
  attendancePercentage: number;
  formulaDescription: string;
}

export interface AbsenceSpell {
  startDate: string;
  endDate: string;
  workingDays: number;
}

export interface ConsecutiveAbsenceMetrics {
  isAbsentOnReferenceDate: boolean;
  referenceDateStatus: CalendarDayStatus;
  consecutiveAbsentWorkingDays: number;
  firstDateOfCurrentAbsence: string | null;
  lastPresentDate: string | null;
  totalAbsentWorkingDaysInMonth: number;
  previousAbsenceSpells: AbsenceSpell[];
}

export interface AbsentManpowerRow {
  employeeId: string;
  employeeName: string;
  line: string;
  section: string;
  department: string;
  employeeType: string;
  lastPresentDate: string | null;
  firstDateOfCurrentAbsence: string | null;
  consecutiveAbsentWorkingDays: number;
  totalAbsentWorkingDaysInMonth: number;
  currentShift: string;
  currentShiftId: string;
  attendanceStatus: CalendarDayStatus;
  employeeStatus: 'Active' | 'Inactive';
}

export interface ClassificationContext {
  todayIstKey: string;
  nowMs: number;
  shiftsById: Map<string, Shift>;
  policy: SchedulePolicyConfig;
  holidaysByDate: Map<string, HolidayRecord>;
  /** Key: `${employeeId}__${dateKey}` */
  rostersByEmpDate: Map<string, ShiftRoster>;
  /** Key: employeeId -> array of approved leave records */
  leavesByEmp: Map<string, ApprovedLeaveRecord[]>;
  /** Key: `${employeeId}__${dateKey}` -> AttendanceRecord */
  attendanceByEmpDate: Map<string, AttendanceRecord>;
  /** Optional map of employeeId -> most recent shiftId seen in attendance/roster */
  inferredShiftByEmp?: Map<string, string>;
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

const IST_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// ============================================================================
// IST Date Utilities (Zero DST / Local Timezone Drift)
// ============================================================================

export function isValidDateKey(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return false;
  const [y, m, d] = trimmed.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === m - 1 &&
    probe.getUTCDate() === d
  );
}

export function getTodayIstDateKey(nowMs: number = Date.now()): string {
  return IST_DATE_FORMATTER.format(new Date(nowMs));
}

export function extractIstDateKey(input: unknown): string | null {
  if (!input) return null;
  const str = String(input).trim();
  if (!str) return null;
  if (isValidDateKey(str)) return str;
  const prefix = str.slice(0, 10);
  if (isValidDateKey(prefix) && (str.length === 10 || str[10] === 'T' || str[10] === ' ')) {
    // If full ISO timestamp, convert accurately in IST
    const parsed = new Date(str);
    if (!Number.isNaN(parsed.getTime())) {
      return IST_DATE_FORMATTER.format(parsed);
    }
    return prefix;
  }
  const parsed = new Date(str);
  if (!Number.isNaN(parsed.getTime())) {
    return IST_DATE_FORMATTER.format(parsed);
  }
  return null;
}

export function shiftDateKeyByDays(dateKey: string, deltaDays: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

export function getDayOfWeekFromDateKey(dateKey: string): number {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function getDaysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function enumerateMonthDateKeys(year: number, month: number): string[] {
  const total = getDaysInMonth(year, month);
  const ym = `${year}-${String(month).padStart(2, '0')}`;
  const out: string[] = [];
  for (let day = 1; day <= total; day++) {
    out.push(`${ym}-${String(day).padStart(2, '0')}`);
  }
  return out;
}

export function enumerateDateRangeKeys(startDate: string, endDate: string): string[] {
  if (!isValidDateKey(startDate) || !isValidDateKey(endDate) || startDate > endDate) {
    return [];
  }
  const out: string[] = [];
  let cursor = startDate;
  let guard = 0;
  while (cursor <= endDate && guard < 400) {
    out.push(cursor);
    cursor = shiftDateKeyByDays(cursor, 1);
    guard += 1;
  }
  return out;
}

// ============================================================================
// Safe Employee Profile & Employment Period Helpers (Strips PII)
// ============================================================================

export function resolveEmployeeJoiningDate(emp: Record<string, any>): string | null {
  const explicitJoining =
    extractIstDateKey(emp.joiningDate) ||
    extractIstDateKey(emp.dateOfJoining) ||
    extractIstDateKey(emp.doj);
  if (explicitJoining) return explicitJoining;
  return extractIstDateKey(emp.createdAt);
}

export function resolveEmployeeExitDate(emp: Record<string, any>): string | null {
  const explicitExit =
    extractIstDateKey(emp.exitDate) ||
    extractIstDateKey(emp.relievingDate) ||
    extractIstDateKey(emp.deactivatedAt);
  if (explicitExit) return explicitExit;
  if (String(emp.employeeStatus || '').toLowerCase() === 'inactive') {
    return extractIstDateKey(emp.updatedAt);
  }
  return null;
}

export function resolveEmployeeWeeklyOffDays(
  emp: Record<string, any>,
  policy: SchedulePolicyConfig
): number[] {
  if (Array.isArray(emp.weeklyOffDays) && emp.weeklyOffDays.length > 0) {
    return emp.weeklyOffDays
      .map((n: any) => Number(n))
      .filter((n: number) => Number.isInteger(n) && n >= 0 && n <= 6);
  }
  if (typeof emp.weeklyOffDay === 'number' && emp.weeklyOffDay >= 0 && emp.weeklyOffDay <= 6) {
    return [emp.weeklyOffDay];
  }
  if (typeof emp.weeklyOffDay === 'string') {
    const map: Record<string, number> = {
      SUN: 0, SUNDAY: 0,
      MON: 1, MONDAY: 1,
      TUE: 2, TUESDAY: 2,
      WED: 3, WEDNESDAY: 3,
      THU: 4, THURSDAY: 4,
      FRI: 5, FRIDAY: 5,
      SAT: 6, SATURDAY: 6,
    };
    const key = emp.weeklyOffDay.trim().toUpperCase();
    if (key in map) return [map[key]];
  }
  return policy.weeklyOffDays;
}

export function buildSafeEmployeeProfile(
  emp: Employee & Record<string, any>,
  shiftsById: Map<string, Shift>,
  inferredShiftId?: string | null,
  defaultShiftId: string = 'DAY'
): SafeEmployeeProfile {
  const shiftId =
    String(emp.currentShiftId || emp.shiftId || emp.defaultShiftId || inferredShiftId || defaultShiftId || 'DAY')
      .trim()
      .toUpperCase() || 'DAY';
  const shiftObj = shiftsById.get(shiftId);
  const shiftName = shiftObj?.name || (shiftId === 'NIGHT' ? 'NIGHT SHIFT' : 'DAY SHIFT');
  const line = String(emp.line || emp.floor || 'Unassigned').trim() || 'Unassigned';

  return {
    employeeId: String(emp.employeeId || '').trim(),
    employeeName: String(emp.employeeName || '').trim(),
    line,
    floor: String(emp.floor || line).trim(),
    section: String(emp.section || 'Unassigned').trim() || 'Unassigned',
    department: String(emp.department || 'Unassigned').trim() || 'Unassigned',
    employeeType: String(emp.employeeType || 'Permanent').trim(),
    designation: String(emp.designation || '').trim(),
    currentShiftId: shiftId,
    currentShiftName: shiftName,
    employeeStatus: String(emp.employeeStatus || 'Active').toLowerCase() === 'inactive' ? 'Inactive' : 'Active',
    joiningDate: resolveEmployeeJoiningDate(emp),
    exitDate: resolveEmployeeExitDate(emp),
  };
}

function findApprovedLeaveForDate(
  leaves: ApprovedLeaveRecord[] | undefined,
  dateKey: string
): ApprovedLeaveRecord | null {
  if (!leaves || leaves.length === 0) return null;
  for (const lv of leaves) {
    const st = String(lv.status || '').trim().toUpperCase();
    if (st && st !== 'APPROVED' && st !== 'SANCTIONED') continue;
    if (isValidDateKey(lv.startDate) && isValidDateKey(lv.endDate)) {
      if (dateKey >= lv.startDate && dateKey <= lv.endDate) {
        return lv;
      }
    }
  }
  return null;
}

// ============================================================================
// Authoritative Single-Day Classifier (Single Source of Truth)
// ============================================================================

export function classifyEmployeeDay(
  emp: Employee & Record<string, any>,
  dateKey: string,
  ctx: ClassificationContext
): CalendarDayDetail {
  const empId = String(emp.employeeId || '').trim();
  const empName = String(emp.employeeName || '').trim();
  const dayOfMonth = parseInt(dateKey.slice(8, 10), 10) || 1;
  const dayOfWeek = getDayOfWeekFromDateKey(dateKey);
  const weekdayLabel = WEEKDAY_SHORT[dayOfWeek] || 'Sun';

  const key = `${empId}__${dateKey}`;
  const att = ctx.attendanceByEmpDate.get(key) || null;
  const roster = ctx.rostersByEmpDate.get(key) || null;
  const holiday = ctx.holidaysByDate.get(dateKey) || null;
  const approvedLeave = findApprovedLeaveForDate(ctx.leavesByEmp.get(empId), dateKey);

  const inferredShiftId =
    att?.shiftId ||
    roster?.shiftId ||
    emp.currentShiftId ||
    emp.shiftId ||
    emp.defaultShiftId ||
    ctx.inferredShiftByEmp?.get(empId) ||
    ctx.policy.defaultShiftId ||
    'DAY';
  const shiftObj = ctx.shiftsById.get(String(inferredShiftId).toUpperCase()) || null;
  const shiftName =
    att?.shiftNameSnapshot ||
    shiftObj?.name ||
    (String(inferredShiftId).toUpperCase() === 'NIGHT' ? 'NIGHT SHIFT' : 'DAY SHIFT');

  const bounds = resolveShiftScheduleBounds(dateKey, {
    id: shiftObj?.id || String(inferredShiftId),
    shiftId: att?.shiftId || String(inferredShiftId),
    name: shiftName,
    startTime: att?.scheduledPunchIn || shiftObj?.startTime,
    endTime: att?.scheduledPunchOut || shiftObj?.endTime,
    isOvernight: shiftObj?.isOvernight,
  });
  const defaultSchedStart = formatIsoTimeKolkata12h(bounds.scheduledStartIso);
  const defaultSchedEnd = formatIsoTimeKolkata12h(bounds.scheduledEndIso);

  const base: Omit<
    CalendarDayDetail,
    | 'status'
    | 'rawAttendanceStatus'
    | 'statusReason'
    | 'isScheduledWorkingDay'
    | 'isAttended'
    | 'isLate'
    | 'isAutoClosed'
    | 'scheduledShiftStart'
    | 'scheduledShiftEnd'
    | 'actualPunchIn'
    | 'actualPunchOut'
    | 'autoCloseTime'
    | 'autoCloseRecordedAt'
    | 'dutyMinutes'
    | 'otMinutes'
    | 'totalWorkingMinutes'
    | 'dutyHours'
    | 'otHours'
    | 'totalWorkingHours'
    | 'leaveOrOffDetail'
    | 'attendanceRecordId'
  > = {
    date: dateKey,
    dayOfMonth,
    dayOfWeek,
    weekdayLabel,
    employeeId: empId,
    employeeName: empName,
    shiftId: String(inferredShiftId).toUpperCase(),
    shiftName,
  };

  // 1. Actual Attendance Record ALWAYS wins (using existing authoritative resolveAttendanceMetrics untouched)
  if (att) {
    const metrics = resolveAttendanceMetrics(att, ctx.nowMs, STANDARD_DUTY_MINUTES);
    const rawUp = String(metrics.status || '').trim().toUpperCase();

    if (rawUp === 'LEAVE' || rawUp === 'ON LEAVE') {
      return {
        ...base,
        status: 'APPROVED LEAVE',
        rawAttendanceStatus: rawUp,
        statusReason: 'Approved leave recorded in attendance register',
        isScheduledWorkingDay: false,
        isAttended: false,
        isLate: false,
        isAutoClosed: false,
        scheduledShiftStart: metrics.scheduledStartDisplay,
        scheduledShiftEnd: metrics.scheduledEndDisplay,
        actualPunchIn: 'N/A',
        actualPunchOut: 'N/A',
        autoCloseTime: 'N/A',
        autoCloseRecordedAt: 'N/A',
        dutyMinutes: 0,
        otMinutes: 0,
        totalWorkingMinutes: 0,
        dutyHours: '00:00',
        otHours: '00:00',
        totalWorkingHours: '00:00',
        leaveOrOffDetail: roster?.remarks || 'Approved Leave',
        attendanceRecordId: att.id || null,
      };
    }

    if (rawUp === 'WEEKLY_OFF' || rawUp === 'WEEKLY OFF') {
      return {
        ...base,
        status: 'WEEKLY OFF',
        rawAttendanceStatus: rawUp,
        statusReason: 'Weekly off',
        isScheduledWorkingDay: false,
        isAttended: false,
        isLate: false,
        isAutoClosed: false,
        scheduledShiftStart: '--:--',
        scheduledShiftEnd: '--:--',
        actualPunchIn: 'N/A',
        actualPunchOut: 'N/A',
        autoCloseTime: 'N/A',
        autoCloseRecordedAt: 'N/A',
        dutyMinutes: 0,
        otMinutes: 0,
        totalWorkingMinutes: 0,
        dutyHours: '00:00',
        otHours: '00:00',
        totalWorkingHours: '00:00',
        leaveOrOffDetail: roster?.remarks || 'Scheduled Weekly Off',
        attendanceRecordId: att.id || null,
      };
    }

    if (rawUp === 'HOLIDAY') {
      return {
        ...base,
        status: 'HOLIDAY',
        rawAttendanceStatus: rawUp,
        statusReason: holiday?.name || 'Declared Holiday',
        isScheduledWorkingDay: false,
        isAttended: false,
        isLate: false,
        isAutoClosed: false,
        scheduledShiftStart: '--:--',
        scheduledShiftEnd: '--:--',
        actualPunchIn: 'N/A',
        actualPunchOut: 'N/A',
        autoCloseTime: 'N/A',
        autoCloseRecordedAt: 'N/A',
        dutyMinutes: 0,
        otMinutes: 0,
        totalWorkingMinutes: 0,
        dutyHours: '00:00',
        otHours: '00:00',
        totalWorkingHours: '00:00',
        leaveOrOffDetail: holiday?.name || roster?.remarks || 'Declared Holiday',
        attendanceRecordId: att.id || null,
      };
    }

    if (rawUp === 'ABSENT') {
      return {
        ...base,
        status: 'ABSENT',
        rawAttendanceStatus: rawUp,
        statusReason: 'ABSENT – NO ATTENDANCE RECORD',
        isScheduledWorkingDay: true,
        isAttended: false,
        isLate: false,
        isAutoClosed: false,
        scheduledShiftStart: metrics.scheduledStartDisplay,
        scheduledShiftEnd: metrics.scheduledEndDisplay,
        actualPunchIn: 'N/A',
        actualPunchOut: 'N/A',
        autoCloseTime: 'N/A',
        autoCloseRecordedAt: 'N/A',
        dutyMinutes: 0,
        otMinutes: 0,
        totalWorkingMinutes: 0,
        dutyHours: '00:00',
        otHours: '00:00',
        totalWorkingHours: '00:00',
        leaveOrOffDetail: null,
        attendanceRecordId: att.id || null,
      };
    }

    let calStatus: CalendarDayStatus = 'PRESENT';
    if (metrics.isOpen || rawUp === 'IN PROGRESS') {
      calStatus = 'IN PROGRESS';
    } else if (metrics.isCurrentlyAutoClosed || rawUp === 'AUTO CLOSED' || rawUp === 'MISSED PUNCH OUT') {
      calStatus = 'AUTO CLOSED';
    } else if (rawUp === 'HALF DAY') {
      calStatus = 'HALF DAY';
    } else if (rawUp === 'SHORT LEAVE') {
      calStatus = 'SHORT LEAVE';
    } else {
      calStatus = 'PRESENT';
    }

    const dutyMinutes = metrics.isOpen ? 0 : metrics.regularDutyMinutes;
    const otMinutes = metrics.isOpen ? 0 : metrics.overtimeMinutes;
    const totalWorkingMinutes = metrics.isOpen ? 0 : metrics.completedDutyMinutes;

    return {
      ...base,
      status: calStatus,
      rawAttendanceStatus: metrics.status,
      statusReason:
        calStatus === 'AUTO CLOSED'
          ? `Provisional Auto-Close at ${metrics.autoCloseTimeDisplay}`
          : calStatus === 'IN PROGRESS'
            ? 'Employee currently clocked IN'
            : metrics.status,
      isScheduledWorkingDay: true,
      isAttended: true,
      isLate: metrics.isLate,
      isAutoClosed: metrics.isCurrentlyAutoClosed,
      scheduledShiftStart: metrics.scheduledStartDisplay,
      scheduledShiftEnd: metrics.scheduledEndDisplay,
      actualPunchIn: formatIsoTimeKolkata12h(att.firstPunchIn || att.punchIn),
      actualPunchOut: metrics.isOpen
        ? 'In Progress'
        : metrics.actualPunchOutIso
          ? metrics.actualPunchOutDisplay
          : 'N/A',
      autoCloseTime: metrics.isCurrentlyAutoClosed ? metrics.autoCloseTimeDisplay : 'N/A',
      autoCloseRecordedAt: metrics.isCurrentlyAutoClosed ? metrics.autoCloseRecordedAtDisplay : 'N/A',
      dutyMinutes,
      otMinutes,
      totalWorkingMinutes,
      dutyHours: formatDurationClock(dutyMinutes),
      otHours: formatDurationClock(otMinutes),
      totalWorkingHours: formatDurationClock(totalWorkingMinutes),
      leaveOrOffDetail: null,
      attendanceRecordId: att.id || null,
    };
  }

  // 2. Future Date (strictly never marked ABSENT)
  if (dateKey > ctx.todayIstKey) {
    const preNote = holiday
      ? `Upcoming Holiday: ${holiday.name}`
      : roster?.rosterStatus === 'HOLIDAY'
        ? `Upcoming Holiday${roster.remarks ? `: ${roster.remarks}` : ''}`
        : approvedLeave
          ? `Upcoming Approved Leave${approvedLeave.leaveType ? ` (${approvedLeave.leaveType})` : ''}`
          : roster?.rosterStatus === 'LEAVE'
            ? `Upcoming Approved Leave${roster.remarks ? `: ${roster.remarks}` : ''}`
            : null;
    return {
      ...base,
      status: 'FUTURE DATE',
      rawAttendanceStatus: null,
      statusReason: preNote || 'Future date — attendance not yet applicable',
      isScheduledWorkingDay: false,
      isAttended: false,
      isLate: false,
      isAutoClosed: false,
      scheduledShiftStart: defaultSchedStart,
      scheduledShiftEnd: defaultSchedEnd,
      actualPunchIn: 'N/A',
      actualPunchOut: 'N/A',
      autoCloseTime: 'N/A',
      autoCloseRecordedAt: 'N/A',
      dutyMinutes: 0,
      otMinutes: 0,
      totalWorkingMinutes: 0,
      dutyHours: '00:00',
      otHours: '00:00',
      totalWorkingHours: '00:00',
      leaveOrOffDetail: preNote,
      attendanceRecordId: null,
    };
  }

  // 3. Employment Period Bounds (never mark pre-joining or post-exit dates as ABSENT)
  const joiningDate = resolveEmployeeJoiningDate(emp);
  if (joiningDate && dateKey < joiningDate) {
    return {
      ...base,
      status: 'NOT EMPLOYED',
      rawAttendanceStatus: null,
      statusReason: `Before employee joining date (${joiningDate})`,
      isScheduledWorkingDay: false,
      isAttended: false,
      isLate: false,
      isAutoClosed: false,
      scheduledShiftStart: '--:--',
      scheduledShiftEnd: '--:--',
      actualPunchIn: 'N/A',
      actualPunchOut: 'N/A',
      autoCloseTime: 'N/A',
      autoCloseRecordedAt: 'N/A',
      dutyMinutes: 0,
      otMinutes: 0,
      totalWorkingMinutes: 0,
      dutyHours: '00:00',
      otHours: '00:00',
      totalWorkingHours: '00:00',
      leaveOrOffDetail: `Joined on ${joiningDate}`,
      attendanceRecordId: null,
    };
  }

  const exitDate = resolveEmployeeExitDate(emp);
  if (
    (exitDate && dateKey > exitDate) ||
    (String(emp.employeeStatus || '').toLowerCase() === 'inactive' && !exitDate)
  ) {
    return {
      ...base,
      status: 'NOT EMPLOYED',
      rawAttendanceStatus: null,
      statusReason: exitDate
        ? `Employee inactive / outside employment period after ${exitDate}`
        : 'Employee status is Inactive',
      isScheduledWorkingDay: false,
      isAttended: false,
      isLate: false,
      isAutoClosed: false,
      scheduledShiftStart: '--:--',
      scheduledShiftEnd: '--:--',
      actualPunchIn: 'N/A',
      actualPunchOut: 'N/A',
      autoCloseTime: 'N/A',
      autoCloseRecordedAt: 'N/A',
      dutyMinutes: 0,
      otMinutes: 0,
      totalWorkingMinutes: 0,
      dutyHours: '00:00',
      otHours: '00:00',
      totalWorkingHours: '00:00',
      leaveOrOffDetail: exitDate ? `Inactive after ${exitDate}` : 'Inactive employee',
      attendanceRecordId: null,
    };
  }

  // 4. Declared Holiday (never marked ABSENT)
  if (holiday || roster?.rosterStatus === 'HOLIDAY') {
    const label = holiday?.name || roster?.remarks || 'Declared Holiday';
    return {
      ...base,
      status: 'HOLIDAY',
      rawAttendanceStatus: 'HOLIDAY',
      statusReason: label,
      isScheduledWorkingDay: false,
      isAttended: false,
      isLate: false,
      isAutoClosed: false,
      scheduledShiftStart: '--:--',
      scheduledShiftEnd: '--:--',
      actualPunchIn: 'N/A',
      actualPunchOut: 'N/A',
      autoCloseTime: 'N/A',
      autoCloseRecordedAt: 'N/A',
      dutyMinutes: 0,
      otMinutes: 0,
      totalWorkingMinutes: 0,
      dutyHours: '00:00',
      otHours: '00:00',
      totalWorkingHours: '00:00',
      leaveOrOffDetail: label,
      attendanceRecordId: null,
    };
  }

  // 5. Approved Leave (never marked ABSENT)
  if (approvedLeave || roster?.rosterStatus === 'LEAVE') {
    const label =
      approvedLeave
        ? `${approvedLeave.leaveType || 'Approved Leave'}${approvedLeave.reason ? ` — ${approvedLeave.reason}` : ''}`
        : roster?.remarks || 'Approved Leave (Shift Roster)';
    return {
      ...base,
      status: 'APPROVED LEAVE',
      rawAttendanceStatus: 'LEAVE',
      statusReason: label,
      isScheduledWorkingDay: false,
      isAttended: false,
      isLate: false,
      isAutoClosed: false,
      scheduledShiftStart: defaultSchedStart,
      scheduledShiftEnd: defaultSchedEnd,
      actualPunchIn: 'N/A',
      actualPunchOut: 'N/A',
      autoCloseTime: 'N/A',
      autoCloseRecordedAt: 'N/A',
      dutyMinutes: 0,
      otMinutes: 0,
      totalWorkingMinutes: 0,
      dutyHours: '00:00',
      otHours: '00:00',
      totalWorkingHours: '00:00',
      leaveOrOffDetail: label,
      attendanceRecordId: null,
    };
  }

  // 6. Weekly Off (never marked ABSENT)
  const weeklyOffDays = resolveEmployeeWeeklyOffDays(emp, ctx.policy);
  if (roster?.rosterStatus === 'WEEKLY_OFF' || weeklyOffDays.includes(dayOfWeek)) {
    const label = roster?.remarks || `Weekly Off (${weekdayLabel})`;
    return {
      ...base,
      status: 'WEEKLY OFF',
      rawAttendanceStatus: 'WEEKLY_OFF',
      statusReason: label,
      isScheduledWorkingDay: false,
      isAttended: false,
      isLate: false,
      isAutoClosed: false,
      scheduledShiftStart: '--:--',
      scheduledShiftEnd: '--:--',
      actualPunchIn: 'N/A',
      actualPunchOut: 'N/A',
      autoCloseTime: 'N/A',
      autoCloseRecordedAt: 'N/A',
      dutyMinutes: 0,
      otMinutes: 0,
      totalWorkingMinutes: 0,
      dutyHours: '00:00',
      otHours: '00:00',
      totalWorkingHours: '00:00',
      leaveOrOffDetail: label,
      attendanceRecordId: null,
    };
  }

  // 7. Schedule Verification Guard — if schedule or leave data cannot be verified, classify as UNKNOWN instead of assuming ABSENT
  const scheduleMissing =
    ctx.policy.scheduleUnverified === true ||
    emp.scheduleUnverified === true ||
    (ctx.policy.schedulePolicyMode === 'ROSTER_ONLY' && !roster) ||
    ctx.shiftsById.size === 0;

  if (scheduleMissing) {
    return {
      ...base,
      status: 'UNKNOWN',
      rawAttendanceStatus: null,
      statusReason: 'UNKNOWN / NOT VERIFIED — Schedule or leave verification data unavailable',
      isScheduledWorkingDay: false,
      isAttended: false,
      isLate: false,
      isAutoClosed: false,
      scheduledShiftStart: defaultSchedStart,
      scheduledShiftEnd: defaultSchedEnd,
      actualPunchIn: 'N/A',
      actualPunchOut: 'N/A',
      autoCloseTime: 'N/A',
      autoCloseRecordedAt: 'N/A',
      dutyMinutes: 0,
      otMinutes: 0,
      totalWorkingMinutes: 0,
      dutyHours: '00:00',
      otHours: '00:00',
      totalWorkingHours: '00:00',
      leaveOrOffDetail: 'Schedule not verified',
      attendanceRecordId: null,
    };
  }

  // 8. Verified Scheduled Working Day with no attendance record -> ABSENT
  return {
    ...base,
    status: 'ABSENT',
    rawAttendanceStatus: 'ABSENT',
    statusReason: 'ABSENT – NO ATTENDANCE RECORD',
    isScheduledWorkingDay: true,
    isAttended: false,
    isLate: false,
    isAutoClosed: false,
    scheduledShiftStart: defaultSchedStart,
    scheduledShiftEnd: defaultSchedEnd,
    actualPunchIn: 'N/A',
    actualPunchOut: 'N/A',
    autoCloseTime: 'N/A',
    autoCloseRecordedAt: 'N/A',
    dutyMinutes: 0,
    otMinutes: 0,
    totalWorkingMinutes: 0,
    dutyHours: '00:00',
    otHours: '00:00',
    totalWorkingHours: '00:00',
    leaveOrOffDetail: null,
    attendanceRecordId: null,
  };
}

// ============================================================================
// Monthly Calendar & Summary Builder
// ============================================================================

export function buildEmployeeMonthlyCalendar(
  emp: Employee & Record<string, any>,
  year: number,
  month: number,
  ctx: ClassificationContext
): {
  days: CalendarDayDetail[];
  summary: MonthlyAttendanceSummary;
} {
  const dateKeys = enumerateMonthDateKeys(year, month);
  const days: CalendarDayDetail[] = dateKeys.map((dk) => classifyEmployeeDay(emp, dk, ctx));

  let totalScheduledWorkingDays = 0;
  let presentDays = 0;
  let absentDays = 0;
  let halfDays = 0;
  let shortLeaveDays = 0;
  let approvedLeaveDays = 0;
  let weeklyOffDays = 0;
  let holidays = 0;
  let autoClosedDays = 0;
  let inProgressDays = 0;
  let futureDays = 0;
  let notEmployedDays = 0;
  let unknownDays = 0;
  let lateDays = 0;
  let totalDutyMinutes = 0;
  let totalOtMinutes = 0;
  let totalWorkingMinutes = 0;

  for (const day of days) {
    if (day.isScheduledWorkingDay) {
      totalScheduledWorkingDays += 1;
    }
    if (day.isLate) {
      lateDays += 1;
    }
    totalDutyMinutes += day.dutyMinutes;
    totalOtMinutes += day.otMinutes;
    totalWorkingMinutes += day.totalWorkingMinutes;

    switch (day.status) {
      case 'PRESENT':
        presentDays += 1;
        break;
      case 'ABSENT':
        absentDays += 1;
        break;
      case 'HALF DAY':
        halfDays += 1;
        break;
      case 'SHORT LEAVE':
        shortLeaveDays += 1;
        break;
      case 'APPROVED LEAVE':
        approvedLeaveDays += 1;
        break;
      case 'WEEKLY OFF':
        weeklyOffDays += 1;
        break;
      case 'HOLIDAY':
        holidays += 1;
        break;
      case 'AUTO CLOSED':
        autoClosedDays += 1;
        break;
      case 'IN PROGRESS':
        inProgressDays += 1;
        break;
      case 'FUTURE DATE':
        futureDays += 1;
        break;
      case 'NOT EMPLOYED':
        notEmployedDays += 1;
        break;
      case 'UNKNOWN':
        unknownDays += 1;
        break;
    }
  }

  const attendedDays = presentDays + halfDays + shortLeaveDays + autoClosedDays + inProgressDays;
  const attendancePercentage =
    totalScheduledWorkingDays > 0
      ? Math.round((attendedDays / totalScheduledWorkingDays) * 1000) / 10
      : 0;

  const summary: MonthlyAttendanceSummary = {
    year,
    month,
    monthKey: `${year}-${String(month).padStart(2, '0')}`,
    totalCalendarDays: days.length,
    totalScheduledWorkingDays,
    presentDays,
    absentDays,
    halfDays,
    shortLeaveDays,
    approvedLeaveDays,
    weeklyOffDays,
    holidays,
    autoClosedDays,
    inProgressDays,
    futureDays,
    notEmployedDays,
    unknownDays,
    lateDays,
    attendedDays,
    totalDutyMinutes,
    totalOtMinutes,
    totalWorkingMinutes,
    totalDutyHours: formatDurationClock(totalDutyMinutes),
    totalOtHours: formatDurationClock(totalOtMinutes),
    totalWorkingHours: formatDurationClock(totalWorkingMinutes),
    attendancePercentage,
    formulaDescription:
      'Attendance % = (Present + Half Day + Short Leave + Auto-Closed + In Progress) ÷ Scheduled Working Days × 100 (excludes Weekly Offs, Holidays, Approved Leave, Future Dates, Pre-Joining & Unverified Days)',
  };

  return { days, summary };
}

// ============================================================================
// Consecutive Absence Working Days Engine
// ============================================================================

export function computeConsecutiveAbsenceMetrics(
  emp: Employee & Record<string, any>,
  referenceDate: string,
  ctx: ClassificationContext,
  options?: {
    lookbackDays?: number;
    knownLastPresentDate?: string | null;
  }
): ConsecutiveAbsenceMetrics {
  const lookbackDays = Math.max(31, Math.min(180, options?.lookbackDays ?? 65));
  const refDay = classifyEmployeeDay(emp, referenceDate, ctx);

  // Month bounds for totalAbsentWorkingDaysInMonth
  const refYear = parseInt(referenceDate.slice(0, 4), 10);
  const refMonth = parseInt(referenceDate.slice(5, 7), 10);
  const monthStart = `${refYear}-${String(refMonth).padStart(2, '0')}-01`;
  const monthEnd = `${refYear}-${String(refMonth).padStart(2, '0')}-${String(getDaysInMonth(refYear, refMonth)).padStart(2, '0')}`;

  // Walk backwards from referenceDate
  let consecutiveAbsentWorkingDays = 0;
  let firstDateOfCurrentAbsence: string | null = null;
  let streakBroken = refDay.status !== 'ABSENT';
  let lastPresentDate: string | null = null;

  // Track previous absence spells across lookback window (excluding current ongoing streak if any)
  const lookbackStart = shiftDateKeyByDays(referenceDate, -(lookbackDays - 1));
  const scanStart = lookbackStart < monthStart ? lookbackStart : monthStart;

  const classifiedBackward: CalendarDayDetail[] = [];
  let cursor = referenceDate;
  let guard = 0;
  while (cursor >= scanStart && guard < 220) {
    const day = cursor === referenceDate ? refDay : classifyEmployeeDay(emp, cursor, ctx);
    classifiedBackward.push(day);

    if (!lastPresentDate && day.isAttended) {
      lastPresentDate = day.date;
    }

    if (!streakBroken) {
      if (day.status === 'ABSENT') {
        consecutiveAbsentWorkingDays += 1;
        firstDateOfCurrentAbsence = day.date;
      } else if (day.isAttended || day.status === 'NOT EMPLOYED' || day.status === 'UNKNOWN') {
        streakBroken = true;
      }
      // WEEKLY OFF, HOLIDAY, APPROVED LEAVE do NOT increment streak and do NOT reset an unbroken absence streak
    }

    cursor = shiftDateKeyByDays(cursor, -1);
    guard += 1;
  }

  // Fallback to known historical last present date if none inside lookback window
  if (!lastPresentDate && options?.knownLastPresentDate && options.knownLastPresentDate <= referenceDate) {
    lastPresentDate = options.knownLastPresentDate;
  }

  // Count total absent working days in selected month (up to monthEnd / todayIstKey)
  let totalAbsentWorkingDaysInMonth = 0;
  const monthDateKeys = enumerateMonthDateKeys(refYear, refMonth);
  for (const dk of monthDateKeys) {
    if (dk > ctx.todayIstKey) continue;
    const d = classifyEmployeeDay(emp, dk, ctx);
    if (d.status === 'ABSENT') {
      totalAbsentWorkingDaysInMonth += 1;
    }
  }

  // Compute all absence spells chronologically across the lookback window
  const chronological = [...classifiedBackward].reverse();
  const spells: AbsenceSpell[] = [];
  let currentSpell: AbsenceSpell | null = null;
  for (const day of chronological) {
    if (day.status === 'ABSENT') {
      if (!currentSpell) {
        currentSpell = { startDate: day.date, endDate: day.date, workingDays: 1 };
      } else {
        currentSpell.endDate = day.date;
        currentSpell.workingDays += 1;
      }
    } else if (day.isAttended || day.status === 'NOT EMPLOYED' || day.status === 'UNKNOWN') {
      if (currentSpell) {
        spells.push(currentSpell);
        currentSpell = null;
      }
    }
    // WEEKLY OFF, HOLIDAY, APPROVED LEAVE keep a spell intact without adding working days
  }
  if (currentSpell) {
    spells.push(currentSpell);
  }

  // Previous absence spells (most recent first, excluding the active ongoing streak if referenceDate is absent)
  const previousAbsenceSpells = [...spells]
    .filter((sp) => !(refDay.status === 'ABSENT' && sp.startDate === firstDateOfCurrentAbsence))
    .reverse();

  return {
    isAbsentOnReferenceDate: refDay.status === 'ABSENT',
    referenceDateStatus: refDay.status,
    consecutiveAbsentWorkingDays,
    firstDateOfCurrentAbsence,
    lastPresentDate,
    totalAbsentWorkingDaysInMonth,
    previousAbsenceSpells,
  };
}
