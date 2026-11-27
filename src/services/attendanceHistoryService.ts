import { apiFetchJson } from '../config/api';
import { getAuthHeaders } from './auditService';
import type { AttendanceRecord } from '../types';
import type {
  AbsentManpowerRow,
  AbsenceSpell,
  CalendarDayDetail,
  ConsecutiveAbsenceMetrics,
  MonthlyAttendanceSummary,
  SafeEmployeeProfile,
} from '../utils/attendanceCalendarEngine';

export interface AttendanceHistoryOverviewResponse {
  success: boolean;
  date: string;
  todayIst: string;
  kpis: {
    totalActiveEmployees: number;
    presentToday: number;
    absentToday: number;
    lateArrivals: number;
    autoClosedAttendance: number;
    currentlyIn: number;
    consecutiveAbsentees: number;
    overallAttendancePercentage: number;
  };
  scheduleSummary: {
    scheduledWorkingCount: number;
    weeklyOffCount: number;
    holidayCount: number;
    approvedLeaveCount: number;
    unknownCount: number;
    weeklyOffDays: number[];
    schedulePolicyMode: 'DEFAULT_WEEKLY' | 'ROSTER_ONLY';
  };
  topConsecutiveAbsentees: AbsentManpowerRow[];
}

export interface EmployeesSearchResponse {
  success: boolean;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  employees: SafeEmployeeProfile[];
}

export interface EmployeeCalendarResponse {
  success: boolean;
  todayIst: string;
  year: number;
  month: number;
  employee: SafeEmployeeProfile;
  summary: MonthlyAttendanceSummary;
  days: CalendarDayDetail[];
  consecutiveAbsence: ConsecutiveAbsenceMetrics;
}

export interface AbsentManpowerResponse {
  success: boolean;
  date: string;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  presetCounts: {
    absentToday: number;
    consecutive2Plus: number;
    consecutive3Plus: number;
    consecutive5Plus: number;
    consecutive7Plus: number;
    consecutive10Plus: number;
  };
  records: AbsentManpowerRow[];
}

export interface DailyAttendanceApiItem {
  id: string;
  employeeId: string;
  employeeName: string;
  line: string;
  department: string;
  section: string;
  employeeType: string;
  attendanceDate: string;
  shiftId: string;
  shiftName: string;
  state: 'INSIDE' | 'OUTSIDE';
  scheduledShiftStart: string;
  scheduledShiftEnd: string;
  actualPunchIn: string;
  actualPunchOut: string;
  autoCloseTime: string;
  autoCloseRecordedAt: string;
  punchOutType: 'ACTUAL' | 'AUTO' | 'NONE';
  attendanceStatus: string;
  isLate: boolean;
  earlyArrivalMinutes: number;
  earlyOtMinutes: number;
  postShiftOtMinutes: number;
  dutyMinutes: number;
  otMinutes: number;
  totalWorkingMinutes: number;
  dutyHours: string;
  otHours: string;
  totalWorkingHours: string;
  record: AttendanceRecord;
}

export interface DailyAttendanceResponse {
  success: boolean;
  startDate: string;
  endDate: string;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  records: DailyAttendanceApiItem[];
}

export interface AnalyticsGroupRow {
  key: string;
  totalActive: number;
  scheduled: number;
  present: number;
  absent: number;
  autoClosed: number;
  late: number;
  leave: number;
  weeklyOff: number;
  attendancePercentage: number;
}

export interface AttendanceAnalyticsResponse {
  success: boolean;
  date: string;
  month: string;
  totalActiveEmployees: number;
  dailyTrend: Array<{
    date: string;
    present: number;
    absent: number;
    scheduled: number;
    autoClosed: number;
    leave: number;
    weeklyOff: number;
    holiday: number;
    attendancePercentage: number;
  }>;
  monthlyTrend: Array<{
    label: string;
    startDate: string;
    endDate: string;
    present: number;
    absent: number;
    scheduled: number;
    attendancePercentage: number;
  }>;
  departmentWise: AnalyticsGroupRow[];
  lineWise: AnalyticsGroupRow[];
  shiftWise: AnalyticsGroupRow[];
  employeeTypeWise: AnalyticsGroupRow[];
  longestContinuousAbsence: AbsentManpowerRow[];
  topAbsenceEmployees: Array<{
    employeeId: string;
    employeeName: string;
    line: string;
    department: string;
    employeeType: string;
    absentDaysInMonth: number;
    scheduledDaysInMonth: number;
    consecutiveAbsentWorkingDays: number;
    lastPresentDate: string | null;
  }>;
}

function toQueryString(params: Record<string, string | number | undefined | null>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      qs.set(k, String(v));
    }
  }
  const str = qs.toString();
  return str ? `?${str}` : '';
}

export async function fetchAttendanceHistoryOverview(
  date?: string
): Promise<AttendanceHistoryOverviewResponse> {
  const headers = await getAuthHeaders();
  return apiFetchJson<AttendanceHistoryOverviewResponse>(
    `/api/attendance-history/overview${toQueryString({ date })}`,
    { method: 'GET', headers },
    'Failed to load Attendance History overview.',
    { preferSameOriginInPreview: true }
  );
}

export async function searchAttendanceHistoryEmployees(params: {
  q?: string;
  line?: string;
  department?: string;
  section?: string;
  shift?: string;
  status?: 'ALL' | 'Active' | 'Inactive';
  page?: number;
  pageSize?: number;
}): Promise<EmployeesSearchResponse> {
  const headers = await getAuthHeaders();
  return apiFetchJson<EmployeesSearchResponse>(
    `/api/attendance-history/employees${toQueryString(params)}`,
    { method: 'GET', headers },
    'Failed to search employees.',
    { preferSameOriginInPreview: true }
  );
}

export async function fetchEmployeeMonthlyCalendar(
  employeeId: string,
  year: number,
  month: number
): Promise<EmployeeCalendarResponse> {
  const headers = await getAuthHeaders();
  const safeEmpId = encodeURIComponent(employeeId.trim());
  return apiFetchJson<EmployeeCalendarResponse>(
    `/api/attendance-history/employee/${safeEmpId}/calendar${toQueryString({ year, month })}`,
    { method: 'GET', headers },
    'Failed to load employee monthly calendar.',
    { preferSameOriginInPreview: true }
  );
}

export async function fetchAbsentManpower(params: {
  date?: string;
  search?: string;
  line?: string;
  section?: string;
  department?: string;
  employeeType?: string;
  shift?: string;
  minConsecutive?: number;
  sortBy?: 'consecutive_desc' | 'recent_absence' | 'department_asc' | 'line_asc' | 'name_asc';
  page?: number;
  pageSize?: number;
}): Promise<AbsentManpowerResponse> {
  const headers = await getAuthHeaders();
  return apiFetchJson<AbsentManpowerResponse>(
    `/api/attendance-history/absent-manpower${toQueryString(params)}`,
    { method: 'GET', headers },
    'Failed to load absent manpower data.',
    { preferSameOriginInPreview: true }
  );
}

export async function fetchDailyAttendanceLedger(params: {
  startDate?: string;
  endDate?: string;
  search?: string;
  line?: string;
  department?: string;
  shift?: string;
  status?: string;
  punchOutType?: string;
  sortBy?: 'date_desc' | 'date_asc' | 'employeeId_asc' | 'name_asc' | 'duty_desc' | 'ot_desc';
  page?: number;
  pageSize?: number;
}): Promise<DailyAttendanceResponse> {
  const headers = await getAuthHeaders();
  return apiFetchJson<DailyAttendanceResponse>(
    `/api/attendance-history/daily${toQueryString(params)}`,
    { method: 'GET', headers },
    'Failed to load daily attendance ledger.',
    { preferSameOriginInPreview: true }
  );
}

export async function fetchAttendanceAnalytics(params: {
  date?: string;
  month?: string;
  line?: string;
  department?: string;
}): Promise<AttendanceAnalyticsResponse> {
  const headers = await getAuthHeaders();
  return apiFetchJson<AttendanceAnalyticsResponse>(
    `/api/attendance-history/analytics${toQueryString(params)}`,
    { method: 'GET', headers },
    'Failed to load attendance analytics.',
    { preferSameOriginInPreview: true }
  );
}

export type { AbsenceSpell, AbsentManpowerRow, CalendarDayDetail, SafeEmployeeProfile };
