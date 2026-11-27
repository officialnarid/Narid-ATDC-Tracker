import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  FileSpreadsheet,
  Info,
  RotateCcw,
  Search,
  User,
  X,
} from 'lucide-react';
import {
  type EmployeeCalendarResponse,
  type SafeEmployeeProfile,
  fetchEmployeeMonthlyCalendar,
  searchAttendanceHistoryEmployees,
} from '../../services/attendanceHistoryService';
import type {
  CalendarDayDetail,
  CalendarDayStatus,
} from '../../utils/attendanceCalendarEngine';
import { getSafeErrorText } from '../../services/errorHandlingService';
import { exportTableToCsv, exportTableToExcel } from '../../services/exportService';
import {
  EMPLOYEE_MONTHLY_CALENDAR_EXPORT_COLUMNS,
  buildEmployeeMonthlyCalendarExportRows,
} from '../../utils/attendanceHistoryExportBuilder';
import { computeAttendanceReportSummary } from '../../utils/attendanceReportBuilder';

interface EmployeeMonthlyCalendarProps {
  selectedEmployeeId?: string | null;
  onSelectEmployee?: (emp: SafeEmployeeProfile) => void;
  initialYear?: number;
  initialMonth?: number;
  /** Embedded mode hides the outer search bar when shown inside Absent Manpower Detail modal */
  embedded?: boolean;
  refreshSignal?: number;
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const WEEKDAY_HEADERS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export interface CalendarStatusVisual {
  label: string;
  shortLabel: string;
  dotClass: string;
  cellClass: string;
  badgeClass: string;
  surfaceClass: string;
  topBarClass: string;
  textClass: string;
  swatchClass: string;
}

export function getCalendarStatusVisual(status: CalendarDayStatus): CalendarStatusVisual {
  switch (status) {
    case 'PRESENT':
      return {
        label: 'Present',
        shortLabel: 'Present',
        dotClass: 'bg-emerald-500',
        cellClass: 'bg-emerald-50/70 border-emerald-200 hover:border-emerald-400',
        badgeClass: 'bg-emerald-100 text-emerald-800 border-emerald-200',
        surfaceClass: 'bg-emerald-50/40 hover:bg-emerald-50/75',
        topBarClass: 'bg-emerald-500',
        textClass: 'text-emerald-800',
        swatchClass: 'bg-emerald-500',
      };
    case 'ABSENT':
      return {
        label: 'Absent',
        shortLabel: 'Absent',
        dotClass: 'bg-red-500',
        cellClass: 'bg-red-50/80 border-red-200 hover:border-red-400',
        badgeClass: 'bg-red-100 text-red-800 border-red-200',
        surfaceClass: 'bg-rose-50/55 hover:bg-rose-50/90',
        topBarClass: 'bg-rose-500',
        textClass: 'text-rose-700',
        swatchClass: 'bg-rose-500',
      };
    case 'HALF DAY':
      return {
        label: 'Half Day',
        shortLabel: 'Half Day',
        dotClass: 'bg-amber-400',
        cellClass: 'bg-amber-50/80 border-amber-200 hover:border-amber-400',
        badgeClass: 'bg-amber-100 text-amber-800 border-amber-200',
        surfaceClass: 'bg-amber-50/55 hover:bg-amber-50/90',
        topBarClass: 'bg-amber-500',
        textClass: 'text-amber-800',
        swatchClass: 'bg-amber-500',
      };
    case 'SHORT LEAVE':
      return {
        label: 'Short Leave',
        shortLabel: 'Short Leave',
        dotClass: 'bg-orange-500',
        cellClass: 'bg-orange-50/80 border-orange-200 hover:border-orange-400',
        badgeClass: 'bg-orange-100 text-orange-800 border-orange-200',
        surfaceClass: 'bg-orange-50/50 hover:bg-orange-50/85',
        topBarClass: 'bg-orange-400',
        textClass: 'text-orange-800',
        swatchClass: 'bg-orange-400',
      };
    case 'AUTO CLOSED':
      return {
        label: 'Auto Closed',
        shortLabel: 'Auto Closed',
        dotClass: 'bg-orange-600 ring-2 ring-orange-200',
        cellClass: 'bg-orange-50/60 border-orange-300 hover:border-orange-500',
        badgeClass: 'bg-orange-100 text-orange-900 border-orange-300',
        surfaceClass: 'bg-orange-50/60 hover:bg-orange-50/95',
        topBarClass: 'bg-orange-600',
        textClass: 'text-orange-900',
        swatchClass: 'bg-orange-600',
      };
    case 'WEEKLY OFF':
      return {
        label: 'Weekly Off',
        shortLabel: 'Weekly Off',
        dotClass: 'bg-slate-400',
        cellClass: 'bg-slate-100/80 border-slate-200 hover:border-slate-400',
        badgeClass: 'bg-slate-200 text-slate-700 border-slate-300',
        surfaceClass: 'bg-slate-50/90 hover:bg-slate-100/80',
        topBarClass: 'bg-slate-300',
        textClass: 'text-slate-500',
        swatchClass: 'bg-slate-400',
      };
    case 'HOLIDAY':
      return {
        label: 'Holiday',
        shortLabel: 'Holiday',
        dotClass: 'bg-blue-500',
        cellClass: 'bg-blue-50/75 border-blue-200 hover:border-blue-400',
        badgeClass: 'bg-blue-100 text-blue-800 border-blue-200',
        surfaceClass: 'bg-blue-50/50 hover:bg-blue-50/85',
        topBarClass: 'bg-blue-500',
        textClass: 'text-blue-700',
        swatchClass: 'bg-blue-500',
      };
    case 'APPROVED LEAVE':
      return {
        label: 'Approved Leave',
        shortLabel: 'Leave',
        dotClass: 'bg-purple-500',
        cellClass: 'bg-purple-50/75 border-purple-200 hover:border-purple-400',
        badgeClass: 'bg-purple-100 text-purple-800 border-purple-200',
        surfaceClass: 'bg-violet-50/55 hover:bg-violet-50/90',
        topBarClass: 'bg-violet-500',
        textClass: 'text-violet-700',
        swatchClass: 'bg-violet-500',
      };
    case 'IN PROGRESS':
      return {
        label: 'In Progress',
        shortLabel: 'In Progress',
        dotClass: 'bg-sky-500',
        cellClass: 'bg-sky-50/75 border-sky-200 hover:border-sky-400',
        badgeClass: 'bg-sky-100 text-sky-800 border-sky-200',
        surfaceClass: 'bg-sky-50/55 hover:bg-sky-50/90',
        topBarClass: 'bg-sky-500',
        textClass: 'text-sky-700',
        swatchClass: 'bg-sky-500',
      };
    case 'FUTURE DATE':
      return {
        label: 'Future Date',
        shortLabel: 'Upcoming',
        dotClass: 'bg-slate-300',
        cellClass: 'bg-white border-slate-200/80 text-slate-400 hover:border-slate-300',
        badgeClass: 'bg-slate-100 text-slate-500 border-slate-200',
        surfaceClass: 'bg-white hover:bg-slate-50/70',
        topBarClass: 'bg-transparent',
        textClass: 'text-slate-400',
        swatchClass: 'bg-slate-200 border border-slate-300',
      };
    case 'NOT EMPLOYED':
      return {
        label: 'Pre-Joining / Inactive',
        shortLabel: 'N/A',
        dotClass: 'bg-slate-300',
        cellClass: 'bg-slate-50/60 border-slate-200/70 text-slate-400 hover:border-slate-300',
        badgeClass: 'bg-slate-100 text-slate-500 border-slate-200',
        surfaceClass: 'bg-slate-50/50 hover:bg-slate-100/50',
        topBarClass: 'bg-transparent',
        textClass: 'text-slate-400',
        swatchClass: 'bg-slate-300',
      };
    case 'UNKNOWN':
    default:
      return {
        label: 'Unknown / Not Verified',
        shortLabel: 'Unverified',
        dotClass: 'bg-slate-400 border border-dashed border-slate-600',
        cellClass: 'bg-slate-50 border-dashed border-slate-300 hover:border-slate-400',
        badgeClass: 'bg-slate-100 text-slate-700 border-slate-300',
        surfaceClass: 'bg-slate-50/70 hover:bg-slate-100/80',
        topBarClass: 'bg-slate-400/70',
        textClass: 'text-slate-600',
        swatchClass: 'bg-slate-400',
      };
  }
}

const LEGEND_ITEMS: Array<{ status: CalendarDayStatus; label: string }> = [
  { status: 'PRESENT', label: 'Present' },
  { status: 'ABSENT', label: 'Absent' },
  { status: 'HALF DAY', label: 'Half Day' },
  { status: 'SHORT LEAVE', label: 'Short Leave' },
  { status: 'AUTO CLOSED', label: 'Auto Closed' },
  { status: 'WEEKLY OFF', label: 'Weekly Off' },
  { status: 'HOLIDAY', label: 'Holiday' },
  { status: 'APPROVED LEAVE', label: 'Approved Leave' },
  { status: 'IN PROGRESS', label: 'In Progress' },
  { status: 'FUTURE DATE', label: 'Future Date' },
  { status: 'UNKNOWN', label: 'Unknown / Not Verified' },
];

export const EmployeeMonthlyCalendar: React.FC<EmployeeMonthlyCalendarProps> = ({
  selectedEmployeeId,
  onSelectEmployee,
  initialYear,
  initialMonth,
  embedded = false,
  refreshSignal = 0,
}) => {
  const nowIst = useMemo(() => {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
    }).format(new Date());
    const [y, m] = fmt.split('-').map(Number);
    return { year: y || new Date().getFullYear(), month: m || new Date().getMonth() + 1 };
  }, []);

  const [year, setYear] = useState<number>(initialYear || nowIst.year);
  const [month, setMonth] = useState<number>(initialMonth || nowIst.month);
  const [activeEmployeeId, setActiveEmployeeId] = useState<string>(selectedEmployeeId || '');

  // Employee search combobox state
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<SafeEmployeeProfile[]>([]);
  const [searchingEmployees, setSearchingEmployees] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  // Calendar fetch state
  const [calendarData, setCalendarData] = useState<EmployeeCalendarResponse | null>(null);
  const [loadingCalendar, setLoadingCalendar] = useState(false);
  const [calendarError, setCalendarError] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<CalendarDayDetail | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (selectedEmployeeId && selectedEmployeeId !== activeEmployeeId) {
      setActiveEmployeeId(selectedEmployeeId);
    }
  }, [selectedEmployeeId]);

  // Initial employee directory load (top 25) & live search
  useEffect(() => {
    if (embedded) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setSearchingEmployees(true);
      try {
        const res = await searchAttendanceHistoryEmployees({
          q: searchTerm.trim(),
          page: 1,
          pageSize: 25,
        });
        if (!cancelled) {
          setSearchResults(res.employees || []);
          if (!activeEmployeeId && res.employees?.length > 0 && !searchTerm.trim()) {
            setActiveEmployeeId(res.employees[0].employeeId);
          }
        }
      } catch {
        if (!cancelled) setSearchResults([]);
      } finally {
        if (!cancelled) setSearchingEmployees(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [searchTerm, embedded]);

  // Fetch Monthly Calendar for selected employee + month/year
  const loadCalendar = async (empId: string, targetYear: number, targetMonth: number) => {
    if (!empId) return;
    setLoadingCalendar(true);
    setCalendarError(null);
    try {
      const data = await fetchEmployeeMonthlyCalendar(empId, targetYear, targetMonth);
      setCalendarData(data);
      setSelectedDay(null);
    } catch (err: any) {
      setCalendarError(
        getSafeErrorText(err, {
          moduleName: 'Employee Attendance Calendar',
          endpoint: `/api/attendance-history/employee/${empId}/calendar`,
        })
      );
    } finally {
      setLoadingCalendar(false);
    }
  };

  useEffect(() => {
    if (activeEmployeeId) {
      loadCalendar(activeEmployeeId, year, month);
    }
  }, [activeEmployeeId, year, month, refreshSignal]);

  const handlePrevMonth = () => {
    if (month === 1) {
      setMonth(12);
      setYear((y) => y - 1);
    } else {
      setMonth((m) => m - 1);
    }
  };

  const handleNextMonth = () => {
    if (month === 12) {
      setMonth(1);
      setYear((y) => y + 1);
    } else {
      setMonth((m) => m + 1);
    }
  };

  const handleCurrentMonth = () => {
    setYear(nowIst.year);
    setMonth(nowIst.month);
  };

  const handlePickEmployee = (emp: SafeEmployeeProfile) => {
    setActiveEmployeeId(emp.employeeId);
    setSearchTerm('');
    setSearchOpen(false);
    onSelectEmployee?.(emp);
  };

  const handleExportMonthly = async (format: 'xlsx' | 'csv') => {
    if (!calendarData) return;
    setExporting(true);
    try {
      const rows = buildEmployeeMonthlyCalendarExportRows(
        calendarData.employee,
        calendarData.days,
        calendarData.summary
      );
      const monthLabel = `${MONTH_NAMES[month - 1]} ${year}`;
      const fileBase = `NARID_Employee_Calendar_${calendarData.employee.employeeId}_${calendarData.summary.monthKey}`;
      if (format === 'xlsx') {
        await exportTableToExcel(
          rows,
          EMPLOYEE_MONTHLY_CALENDAR_EXPORT_COLUMNS,
          fileBase,
          {
            reportTitle: `Monthly Attendance Calendar — ${calendarData.employee.employeeName} (${calendarData.employee.employeeId})`,
            periodLabel: monthLabel,
            sheetName: `${calendarData.employee.employeeId} ${calendarData.summary.monthKey}`,
            summary: computeAttendanceReportSummary(rows),
          }
        );
      } else {
        exportTableToCsv(rows, EMPLOYEE_MONTHLY_CALENDAR_EXPORT_COLUMNS, fileBase);
      }
    } finally {
      setExporting(false);
    }
  };

  const { leadingDays, trailingDays, statusCounts } = useMemo(() => {
    const counts = new Map<CalendarDayStatus, number>();
    if (!calendarData?.days?.length) {
      return { leadingDays: [] as number[], trailingDays: [] as number[], statusCounts: counts };
    }
    for (const d of calendarData.days) {
      counts.set(d.status, (counts.get(d.status) || 0) + 1);
    }
    const firstDow = calendarData.days[0].dayOfWeek;
    const prevMonthTotal = new Date(year, month - 1, 0).getDate();
    const leading: number[] = [];
    for (let i = firstDow - 1; i >= 0; i--) {
      leading.push(prevMonthTotal - i);
    }
    const totalCells = leading.length + calendarData.days.length;
    const trailingLen = (7 - (totalCells % 7)) % 7;
    const trailing: number[] = [];
    for (let i = 1; i <= trailingLen; i++) {
      trailing.push(i);
    }
    return { leadingDays: leading, trailingDays: trailing, statusCounts: counts };
  }, [calendarData, year, month]);

  const yearOptions = useMemo(() => {
    const out: number[] = [];
    for (let y = nowIst.year - 3; y <= nowIst.year + 1; y++) {
      out.push(y);
    }
    return out;
  }, [nowIst.year]);

  return (
    <div className="flex flex-col gap-5">
      {/* Standalone Employee Search Bar */}
      {!embedded && (
        <div className="bg-white rounded-xl border border-slate-200 p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="relative flex-1 max-w-xl">
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">
              Search Employee (ID, Name, Line, or Department)
            </label>
            <div className="relative flex items-center">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 pointer-events-none" />
              <input
                type="text"
                value={searchTerm}
                onFocus={() => setSearchOpen(true)}
                onChange={(e) => {
                  setSearchTerm(e.target.value);
                  setSearchOpen(true);
                }}
                placeholder="Type Employee ID (e.g. JMD101), Name, Line, or Department..."
                className="w-full pl-9 pr-8 py-2 text-xs bg-slate-50 border border-slate-300 rounded-lg text-slate-900 focus:outline-hidden focus:bg-white focus:border-blue-500"
              />
              {searchTerm && (
                <button
                  type="button"
                  onClick={() => setSearchTerm('')}
                  className="absolute right-2.5 text-slate-400 hover:text-slate-600 cursor-pointer"
                  aria-label="Clear employee search"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {searchOpen && (
              <div className="absolute left-0 right-0 mt-1.5 bg-white border border-slate-200 rounded-xl shadow-lg z-30 max-h-72 overflow-y-auto">
                <div className="px-3 py-2 border-b border-slate-100 flex items-center justify-between text-[11px] text-slate-500 bg-slate-50/70">
                  <span>
                    {searchingEmployees
                      ? 'Searching employees...'
                      : `${searchResults.length} matching employee${searchResults.length === 1 ? '' : 's'}`}
                  </span>
                  <button
                    type="button"
                    onClick={() => setSearchOpen(false)}
                    className="text-slate-400 hover:text-slate-700 font-semibold cursor-pointer"
                  >
                    Close
                  </button>
                </div>
                {searchResults.length === 0 && !searchingEmployees ? (
                  <div className="p-4 text-center text-xs text-slate-400">
                    No matching employee found.
                  </div>
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {searchResults.map((emp) => (
                      <li key={emp.employeeId}>
                        <button
                          type="button"
                          onClick={() => handlePickEmployee(emp)}
                          className={`w-full text-left px-3.5 py-2.5 flex items-center justify-between gap-3 hover:bg-blue-50/60 transition cursor-pointer ${
                            emp.employeeId === activeEmployeeId ? 'bg-blue-50/80' : ''
                          }`}
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-mono font-bold text-xs text-slate-900">
                                {emp.employeeId}
                              </span>
                              <span className="font-semibold text-xs text-slate-800 truncate">
                                {emp.employeeName}
                              </span>
                            </div>
                            <div className="text-[11px] text-slate-500 mt-0.5 truncate">
                              {emp.line} • {emp.section} • {emp.department} • {emp.employeeType}
                            </div>
                          </div>
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-semibold border shrink-0 ${
                              emp.employeeStatus === 'Active'
                                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                : 'bg-slate-100 text-slate-600 border-slate-200'
                            }`}
                          >
                            {emp.employeeStatus}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          {/* Month & Year Navigation Controls */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handlePrevMonth}
              className="p-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 cursor-pointer"
              title="Previous Month"
              aria-label="Previous Month"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <select
              value={month}
              onChange={(e) => setMonth(Number(e.target.value))}
              aria-label="Select Month"
              className="bg-white border border-slate-300 rounded-lg px-3 py-2 text-xs font-semibold text-slate-800"
            >
              {MONTH_NAMES.map((name, idx) => (
                <option key={name} value={idx + 1}>
                  {name}
                </option>
              ))}
            </select>
            <select
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              aria-label="Select Year"
              className="bg-white border border-slate-300 rounded-lg px-3 py-2 text-xs font-semibold text-slate-800 tabular-nums"
            >
              {yearOptions.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleNextMonth}
              className="p-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 cursor-pointer"
              title="Next Month"
              aria-label="Next Month"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={handleCurrentMonth}
              className="px-3 py-2 rounded-lg border border-slate-300 bg-slate-50 hover:bg-slate-100 text-xs font-semibold text-slate-700 cursor-pointer"
            >
              Current Month
            </button>
            <button
              type="button"
              onClick={() => handleExportMonthly('xlsx')}
              disabled={!calendarData || exporting}
              className="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <FileSpreadsheet className="w-3.5 h-3.5" />
              <span>Export Excel</span>
            </button>
            <button
              type="button"
              onClick={() => handleExportMonthly('csv')}
              disabled={!calendarData || exporting}
              className="px-3 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <Download className="w-3.5 h-3.5" />
              <span>CSV</span>
            </button>
          </div>
        </div>
      )}

      {/* Embedded Compact Month Navigation */}
      {embedded && (
        <div className="flex flex-wrap items-center justify-between gap-2 pb-1">
          <div className="flex items-center gap-2">
            <CalendarIcon className="w-4 h-4 text-blue-600" />
            <h4 className="text-sm font-bold text-slate-900">
              Monthly Attendance Calendar — {MONTH_NAMES[month - 1]} {year}
            </h4>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={handlePrevMonth}
              className="p-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 cursor-pointer"
              aria-label="Previous Month"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <select
              value={month}
              onChange={(e) => setMonth(Number(e.target.value))}
              aria-label="Select Month"
              className="bg-white border border-slate-300 rounded-lg px-2 py-1 text-xs font-semibold text-slate-800"
            >
              {MONTH_NAMES.map((name, idx) => (
                <option key={name} value={idx + 1}>
                  {name}
                </option>
              ))}
            </select>
            <select
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              aria-label="Select Year"
              className="bg-white border border-slate-300 rounded-lg px-2 py-1 text-xs font-semibold text-slate-800 tabular-nums"
            >
              {yearOptions.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleNextMonth}
              className="p-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 cursor-pointer"
              aria-label="Next Month"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={handleCurrentMonth}
              className="px-2.5 py-1 rounded-lg border border-slate-300 bg-slate-50 hover:bg-slate-100 text-[11px] font-semibold text-slate-700 cursor-pointer"
            >
              Today
            </button>
          </div>
        </div>
      )}

      {/* Error State */}
      {calendarError && (
        <div
          role="alert"
          className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-xs text-red-800 flex items-center justify-between gap-3"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
            <span>{calendarError}</span>
          </div>
          <button
            type="button"
            onClick={() => loadCalendar(activeEmployeeId, year, month)}
            className="px-3 py-1 rounded bg-white border border-red-300 text-red-700 font-semibold hover:bg-red-100 cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}

      {/* Empty State when no employee selected */}
      {!activeEmployeeId && !loadingCalendar && (
        <div className="bg-white rounded-xl border border-slate-200 p-10 text-center">
          <User className="w-9 h-9 text-slate-300 mx-auto mb-2.5" />
          <p className="text-sm font-semibold text-slate-700">Select an employee to view their Monthly Attendance Calendar</p>
          <p className="text-xs text-slate-500 mt-1">
            Use the search bar above to find an employee by ID, Name, Production Line, or Department.
          </p>
        </div>
      )}

      {/* Loading Skeleton */}
      {loadingCalendar && (
        <div className="bg-white rounded-xl border border-slate-200 p-6 flex items-center justify-center gap-2.5 text-xs text-slate-500">
          <RotateCcw className="w-4 h-4 animate-spin text-blue-600" />
          <span>Loading schedule-validated monthly attendance calendar...</span>
        </div>
      )}

      {/* Employee Attendance Profile + Monthly Summary + Calendar */}
      {!loadingCalendar && calendarData && (
        <>
          {/* Employee Profile Header (Standalone mode) */}
          {!embedded && (
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-3 border-b border-slate-100">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-slate-900 text-white font-bold text-sm flex items-center justify-center shrink-0">
                    {calendarData.employee.employeeName.slice(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-base font-bold text-slate-900">
                        {calendarData.employee.employeeName}
                      </h3>
                      <span className="font-mono text-xs font-bold px-2 py-0.5 rounded bg-slate-100 text-slate-800 border border-slate-200">
                        {calendarData.employee.employeeId}
                      </span>
                      <span
                        className={`text-[11px] font-semibold px-2 py-0.5 rounded border ${
                          calendarData.employee.employeeStatus === 'Active'
                            ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                            : 'bg-slate-100 text-slate-600 border-slate-200'
                        }`}
                      >
                        {calendarData.employee.employeeStatus}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {MONTH_NAMES[month - 1]} {year} Attendance Profile • Authoritative IST Schedule
                    </p>
                  </div>
                </div>

                {calendarData.consecutiveAbsence.consecutiveAbsentWorkingDays > 0 && (
                  <div className="px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
                    <span className="font-bold tabular-nums">
                      {calendarData.consecutiveAbsence.consecutiveAbsentWorkingDays} Consecutive Absent Working Day
                      {calendarData.consecutiveAbsence.consecutiveAbsentWorkingDays === 1 ? '' : 's'}
                    </span>
                    {calendarData.consecutiveAbsence.firstDateOfCurrentAbsence && (
                      <span className="text-red-700 ml-1.5">
                        (Since {calendarData.consecutiveAbsence.firstDateOfCurrentAbsence})
                      </span>
                    )}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 pt-3 text-xs">
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-slate-400 block">Line</span>
                  <span className="font-semibold text-slate-800">{calendarData.employee.line}</span>
                </div>
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-slate-400 block">Section</span>
                  <span className="font-semibold text-slate-800">{calendarData.employee.section}</span>
                </div>
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-slate-400 block">Department</span>
                  <span className="font-semibold text-slate-800">{calendarData.employee.department}</span>
                </div>
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-slate-400 block">Employee Type</span>
                  <span className="font-semibold text-slate-800">{calendarData.employee.employeeType}</span>
                </div>
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-slate-400 block">Current Shift</span>
                  <span className="font-semibold text-slate-800">{calendarData.employee.currentShiftName}</span>
                </div>
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-slate-400 block">Employment Status</span>
                  <span className="font-semibold text-slate-800">{calendarData.employee.employeeStatus}</span>
                </div>
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-slate-400 block">Joining / Active From</span>
                  <span className="font-mono font-semibold text-slate-800 tabular-nums">
                    {calendarData.employee.joiningDate || 'N/A'}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Monthly Attendance Summary Strip */}
          <div className="bg-white rounded-xl border border-slate-200 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-600">
                Monthly Attendance Summary — {MONTH_NAMES[month - 1]} {year}
              </h4>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">Attendance Rate:</span>
                <span className="text-sm font-bold text-slate-900 tabular-nums">
                  {calendarData.summary.attendancePercentage.toFixed(1)}%
                </span>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2.5 text-xs">
              <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200/80">
                <div className="text-[10px] text-slate-500 uppercase font-semibold">Scheduled Working</div>
                <div className="text-lg font-bold text-slate-900 tabular-nums mt-0.5">
                  {calendarData.summary.totalScheduledWorkingDays}
                </div>
              </div>
              <div className="p-2.5 rounded-lg bg-emerald-50/70 border border-emerald-200/80">
                <div className="text-[10px] text-emerald-700 uppercase font-semibold">Present Days</div>
                <div className="text-lg font-bold text-emerald-800 tabular-nums mt-0.5">
                  {calendarData.summary.presentDays}
                </div>
              </div>
              <div className="p-2.5 rounded-lg bg-red-50/70 border border-red-200/80">
                <div className="text-[10px] text-red-700 uppercase font-semibold">Absent Days</div>
                <div className="text-lg font-bold text-red-800 tabular-nums mt-0.5">
                  {calendarData.summary.absentDays}
                </div>
              </div>
              <div className="p-2.5 rounded-lg bg-amber-50/70 border border-amber-200/80">
                <div className="text-[10px] text-amber-800 uppercase font-semibold">Half / Short Lv</div>
                <div className="text-lg font-bold text-amber-900 tabular-nums mt-0.5">
                  {calendarData.summary.halfDays} / {calendarData.summary.shortLeaveDays}
                </div>
              </div>
              <div className="p-2.5 rounded-lg bg-orange-50/70 border border-orange-200/80">
                <div className="text-[10px] text-orange-800 uppercase font-semibold">Auto-Closed</div>
                <div className="text-lg font-bold text-orange-900 tabular-nums mt-0.5">
                  {calendarData.summary.autoClosedDays}
                </div>
              </div>
              <div className="p-2.5 rounded-lg bg-purple-50/70 border border-purple-200/80">
                <div className="text-[10px] text-purple-800 uppercase font-semibold">Leave / Off / Hol</div>
                <div className="text-lg font-bold text-purple-900 tabular-nums mt-0.5">
                  {calendarData.summary.approvedLeaveDays} / {calendarData.summary.weeklyOffDays} /{' '}
                  {calendarData.summary.holidays}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 mt-2.5 pt-2.5 border-t border-slate-100 text-xs">
              <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-slate-50 border border-slate-200/70">
                <span className="text-slate-500 font-medium">Total Duty Hours</span>
                <span className="font-mono font-bold text-slate-900 tabular-nums">
                  {calendarData.summary.totalDutyHours}
                </span>
              </div>
              <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-indigo-50/60 border border-indigo-200/70">
                <span className="text-indigo-700 font-medium">Total OT Hours</span>
                <span className="font-mono font-bold text-indigo-900 tabular-nums">
                  {calendarData.summary.totalOtHours}
                </span>
              </div>
              <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-slate-50 border border-slate-200/70">
                <span className="text-slate-500 font-medium">Attendance Percentage</span>
                <span className="font-mono font-bold text-slate-900 tabular-nums">
                  {calendarData.summary.attendancePercentage.toFixed(1)}%
                </span>
              </div>
            </div>

            <div className="mt-2.5 flex items-start gap-1.5 text-[11px] text-slate-500">
              <Info className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
              <span>{calendarData.summary.formulaDescription}</span>
            </div>
          </div>

          {/* Premium 7-Column Architectural Monthly Calendar */}
          <div className="bg-white rounded-2xl border border-slate-200/90 shadow-xs overflow-hidden">
            {/* Integrated Calendar Chrome Header */}
            <div className="px-5 py-4 border-b border-slate-200/80 bg-white flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-baseline gap-2.5 flex-wrap">
                  <h4 className="text-lg sm:text-xl font-bold tracking-tight text-slate-900">
                    {MONTH_NAMES[month - 1]} <span className="tabular-nums font-semibold text-slate-500">{year}</span>
                  </h4>
                  <span className="text-xs text-slate-400 hidden sm:inline" aria-hidden="true">·</span>
                  <span className="text-xs font-medium text-slate-500 truncate">
                    {calendarData.employee.employeeName} ({calendarData.employee.employeeId})
                  </span>
                </div>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Sun – Sat · Asia/Kolkata (IST) · Click any day to inspect punches, duty &amp; OT details
                </p>
              </div>

              <div className="flex items-center gap-4 shrink-0">
                {/* Inline Monthly Attendance Progress Gauge */}
                <div className="hidden md:flex flex-col items-end gap-1 min-w-[136px]">
                  <div className="flex items-center justify-between w-full text-[11px]">
                    <span className="text-slate-500 font-medium">Attendance</span>
                    <span className="font-mono font-bold text-slate-900 tabular-nums">
                      {calendarData.summary.attendancePercentage.toFixed(1)}%
                    </span>
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-slate-100 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${
                        calendarData.summary.attendancePercentage >= 85
                          ? 'bg-emerald-500'
                          : calendarData.summary.attendancePercentage >= 60
                            ? 'bg-amber-500'
                            : 'bg-rose-500'
                      }`}
                      style={{
                        width: `${Math.min(100, Math.max(0, calendarData.summary.attendancePercentage))}%`,
                      }}
                    />
                  </div>
                </div>

                {/* Compact Segmented Month Stepper */}
                <div className="inline-flex items-center rounded-lg border border-slate-200 bg-slate-50/80 p-0.5">
                  <button
                    type="button"
                    onClick={handlePrevMonth}
                    className="p-1.5 rounded-md text-slate-600 hover:bg-white hover:text-slate-900 hover:shadow-2xs transition cursor-pointer"
                    title="Previous Month"
                    aria-label="Calendar Previous Month"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={handleCurrentMonth}
                    className="px-2.5 py-1 rounded-md text-xs font-semibold text-slate-700 hover:bg-white hover:text-slate-900 hover:shadow-2xs transition cursor-pointer whitespace-nowrap"
                  >
                    Today
                  </button>
                  <button
                    type="button"
                    onClick={handleNextMonth}
                    className="p-1.5 rounded-md text-slate-600 hover:bg-white hover:text-slate-900 hover:shadow-2xs transition cursor-pointer"
                    title="Next Month"
                    aria-label="Calendar Next Month"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>

            {/* Weekday Column Headers */}
            <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50/90">
              {WEEKDAY_HEADERS.map((wd, idx) => (
                <div
                  key={wd}
                  className={`py-2.5 px-2 sm:px-3 text-center sm:text-left text-[11px] font-semibold tracking-wide ${
                    idx === 0 ? 'text-rose-500/80' : 'text-slate-500'
                  }`}
                >
                  {wd}
                </div>
              ))}
            </div>

            {/* Symmetrical Architectural 7-Column Date Matrix */}
            <div className="grid grid-cols-7 gap-px bg-slate-200/80">
              {/* Leading Previous-Month Ghost Cells */}
              {leadingDays.map((prevNum) => (
                <div
                  key={`prev-${prevNum}`}
                  aria-hidden="true"
                  className="min-h-[86px] sm:min-h-[108px] bg-slate-50/60 p-2 sm:p-3 flex flex-col justify-between select-none"
                >
                  <span className="text-xs font-medium text-slate-300 tabular-nums">
                    {prevNum}
                  </span>
                </div>
              ))}

              {/* Active Month Day Cells */}
              {calendarData.days.map((day) => {
                const visual = getCalendarStatusVisual(day.status);
                const isToday = day.date === calendarData.todayIst;
                const isSelected = selectedDay?.date === day.date;
                const isMutedDay =
                  day.status === 'FUTURE DATE' || day.status === 'NOT EMPLOYED';
                const hasPunchIn =
                  day.actualPunchIn &&
                  day.actualPunchIn !== 'N/A' &&
                  day.actualPunchIn !== 'In Progress';

                return (
                  <button
                    key={day.date}
                    type="button"
                    onClick={() => setSelectedDay(day)}
                    className={`group relative min-h-[86px] sm:min-h-[108px] p-2 sm:p-3 text-left flex flex-col justify-between transition-all duration-150 cursor-pointer focus-visible:outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-inset ${visual.surfaceClass} ${
                      isSelected
                        ? 'z-10 ring-2 ring-blue-600 ring-inset bg-white'
                        : 'hover:z-10 hover:ring-1 hover:ring-slate-400/70 hover:ring-inset'
                    }`}
                    title={`${day.date} — ${visual.label}`}
                  >
                    {/* Razor-thin top semantic status indicator bar */}
                    <span
                      aria-hidden="true"
                      className={`absolute inset-x-0 top-0 h-[2.5px] ${visual.topBarClass}`}
                    />

                    {/* Top Row: Date Number + Today / Late marker */}
                    <div className="flex items-start justify-between gap-1 pt-0.5">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`inline-flex items-center justify-center tabular-nums leading-none transition-colors ${
                            isToday
                              ? 'w-7 h-7 rounded-full bg-slate-900 text-white text-xs font-bold shadow-xs'
                              : isMutedDay
                                ? 'text-xs sm:text-sm font-medium text-slate-400'
                                : day.dayOfWeek === 0
                                  ? 'text-xs sm:text-sm font-semibold text-slate-500'
                                  : 'text-xs sm:text-sm font-bold text-slate-900 group-hover:text-blue-700'
                          }`}
                        >
                          {day.dayOfMonth}
                        </span>
                        {isToday && (
                          <span className="hidden lg:inline text-[10px] font-semibold text-slate-700 tracking-tight">
                            Today
                          </span>
                        )}
                      </div>

                      {day.isLate && (
                        <span className="text-[10px] font-semibold text-amber-700 tracking-tight shrink-0">
                          Late
                        </span>
                      )}
                    </div>

                    {/* Bottom Block: Semantic Status Label + Punch / Duty / OT Telemetry */}
                    <div className="mt-2 flex flex-col gap-0.5 min-w-0">
                      <div className="flex items-center gap-1.5 min-w-0">
                        {!isMutedDay && (
                          <span
                            aria-hidden="true"
                            className={`w-1.5 h-1.5 rounded-full shrink-0 ${visual.swatchClass}`}
                          />
                        )}
                        <span
                          className={`text-[11px] sm:text-xs font-semibold leading-tight truncate ${visual.textClass}`}
                        >
                          {visual.shortLabel}
                        </span>
                      </div>

                      {day.isAttended ? (
                        <div className="hidden sm:flex items-center gap-1.5 text-[10px] font-mono tabular-nums text-slate-600 truncate mt-0.5">
                          <span>{day.dutyHours}</span>
                          {day.otMinutes > 0 && (
                            <>
                              <span aria-hidden="true" className="text-slate-300">·</span>
                              <span className="font-semibold text-indigo-700">+{day.otHours}</span>
                            </>
                          )}
                          {day.otMinutes === 0 && hasPunchIn && (
                            <>
                              <span aria-hidden="true" className="text-slate-300 hidden xl:inline">·</span>
                              <span className="text-slate-500 hidden xl:inline truncate">
                                {day.actualPunchIn}
                              </span>
                            </>
                          )}
                        </div>
                      ) : day.leaveOrOffDetail && (day.status === 'HOLIDAY' || day.status === 'APPROVED LEAVE') ? (
                        <div className="hidden sm:block text-[10px] text-slate-500 truncate mt-0.5">
                          {day.leaveOrOffDetail}
                        </div>
                      ) : null}
                    </div>
                  </button>
                );
              })}

              {/* Trailing Next-Month Ghost Cells */}
              {trailingDays.map((nextNum) => (
                <div
                  key={`next-${nextNum}`}
                  aria-hidden="true"
                  className="min-h-[86px] sm:min-h-[108px] bg-slate-50/60 p-2 sm:p-3 flex flex-col justify-between select-none"
                >
                  <span className="text-xs font-medium text-slate-300 tabular-nums">
                    {nextNum}
                  </span>
                </div>
              ))}
            </div>

            {/* Clean Architectural Legend Strip with Live Monthly Counts */}
            <div className="px-5 py-3.5 border-t border-slate-200/80 bg-slate-50/50 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] text-slate-600">
              <span className="font-semibold text-slate-500 text-[11px]">
                Status Key
              </span>
              {LEGEND_ITEMS.map((item) => {
                const v = getCalendarStatusVisual(item.status);
                const count = statusCounts.get(item.status) || 0;
                return (
                  <span
                    key={item.status}
                    className={`inline-flex items-center gap-1.5 ${
                      count > 0 ? 'text-slate-800 font-medium' : 'text-slate-400'
                    }`}
                  >
                    <span className={`w-2 h-2 rounded-[2px] shrink-0 ${v.swatchClass}`} />
                    <span>{item.label}</span>
                    {count > 0 && (
                      <span className="font-mono text-[10px] font-semibold text-slate-500 tabular-nums">
                        ({count})
                      </span>
                    )}
                  </span>
                );
              })}
            </div>
          </div>
        </>
      )}

      {/* Calendar Day Details Modal */}
      {selectedDay && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4"
          onClick={() => setSelectedDay(null)}
        >
          <div
            className="bg-white rounded-xl max-w-lg w-full border border-slate-200 shadow-xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-slate-200 flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4 text-blue-600" />
                  <h4 className="text-sm font-bold text-slate-900">
                    Attendance Day Details — {selectedDay.date} ({selectedDay.weekdayLabel})
                  </h4>
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  {selectedDay.employeeName} ({selectedDay.employeeId})
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedDay(null)}
                className="text-slate-400 hover:text-slate-700 cursor-pointer"
                aria-label="Close day details"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 flex flex-col gap-4 text-xs">
              {/* Primary Status Callout */}
              <div
                className={`px-3.5 py-2.5 rounded-lg border flex items-center justify-between gap-3 ${
                  getCalendarStatusVisual(selectedDay.status).badgeClass
                }`}
              >
                <div>
                  <div className="text-[10px] uppercase font-bold opacity-80">Attendance Status</div>
                  <div className="text-sm font-bold mt-0.5">{selectedDay.status}</div>
                </div>
                <div className="text-right font-semibold">{selectedDay.statusReason}</div>
              </div>

              {/* Structured 14-Field Grid */}
              <div className="grid grid-cols-2 gap-3">
                <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200/80">
                  <span className="text-[10px] uppercase text-slate-400 block">Attendance Date</span>
                  <span className="font-mono font-semibold text-slate-900 tabular-nums">
                    {selectedDay.date}
                  </span>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200/80">
                  <span className="text-[10px] uppercase text-slate-400 block">Shift</span>
                  <span className="font-semibold text-slate-900">{selectedDay.shiftName}</span>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200/80">
                  <span className="text-[10px] uppercase text-slate-400 block">Scheduled Shift Start</span>
                  <span className="font-mono font-semibold text-slate-800 tabular-nums">
                    {selectedDay.scheduledShiftStart}
                  </span>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200/80">
                  <span className="text-[10px] uppercase text-slate-400 block">Scheduled Shift End</span>
                  <span className="font-mono font-semibold text-slate-800 tabular-nums">
                    {selectedDay.scheduledShiftEnd}
                  </span>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200/80">
                  <span className="text-[10px] uppercase text-slate-400 block">Actual Punch-In</span>
                  <span className="font-mono font-semibold text-emerald-700 tabular-nums">
                    {selectedDay.actualPunchIn}
                  </span>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200/80">
                  <span className="text-[10px] uppercase text-slate-400 block">Actual Punch-Out</span>
                  <span className="font-mono font-semibold text-blue-700 tabular-nums">
                    {selectedDay.actualPunchOut}
                  </span>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200/80">
                  <span className="text-[10px] uppercase text-slate-400 block">Auto-Close Time</span>
                  <span className="font-mono font-semibold text-orange-800 tabular-nums">
                    {selectedDay.autoCloseTime}
                  </span>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200/80">
                  <span className="text-[10px] uppercase text-slate-400 block">Auto-Close Recorded At</span>
                  <span className="font-mono text-[11px] font-medium text-slate-700 tabular-nums">
                    {selectedDay.autoCloseRecordedAt}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2.5 pt-2 border-t border-slate-100">
                <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200/80 text-center">
                  <span className="text-[10px] uppercase text-slate-400 block">Duty Hours</span>
                  <span className="font-mono font-bold text-slate-900 text-sm tabular-nums">
                    {selectedDay.dutyHours}
                  </span>
                </div>
                <div className="p-2.5 rounded-lg bg-indigo-50/70 border border-indigo-200/80 text-center">
                  <span className="text-[10px] uppercase text-indigo-600 block">OT Hours</span>
                  <span className="font-mono font-bold text-indigo-900 text-sm tabular-nums">
                    {selectedDay.otHours}
                  </span>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200/80 text-center">
                  <span className="text-[10px] uppercase text-slate-400 block">Total Working Hours</span>
                  <span className="font-mono font-bold text-slate-900 text-sm tabular-nums">
                    {selectedDay.totalWorkingHours}
                  </span>
                </div>
              </div>

              {selectedDay.leaveOrOffDetail && (
                <div className="px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-slate-700">
                  <span className="font-semibold">Schedule / Leave Detail: </span>
                  <span>{selectedDay.leaveOrOffDetail}</span>
                </div>
              )}

              <div className="flex justify-end pt-1">
                <button
                  type="button"
                  onClick={() => setSelectedDay(null)}
                  className="px-4 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white font-semibold cursor-pointer"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
