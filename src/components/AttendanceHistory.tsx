import React, { useEffect, useMemo, useRef, useState } from 'react';
import { getSafeErrorText, handleAppError } from '../services/errorHandlingService';
import {
  AlertTriangle,
  Calendar,
  CalendarDays,
  CheckCircle2,
  Clock,
  Columns,
  Download,
  Edit3,
  FileSpreadsheet,
  History,
  LayoutDashboard,
  ListOrdered,
  LogIn,
  LogOut,
  Percent,
  RotateCcw,
  Search,
  UserCheck,
  UserX,
  Users,
  X,
} from 'lucide-react';
import type {
  AttendanceRecord,
  AttendanceStatus,
  Department,
  Floor,
  Section,
  Shift,
  UserRoleRecord,
} from '../types';
import type { RolePermissionRecord } from '../services/permissionService';
import {
  correctAttendanceRecord,
  formatDateKey,
  formatTimeDisplay,
  getKolkataTimeParts,
  getNextDateKey,
} from '../services/attendanceService';
import { exportTableToCsv, exportTableToExcel } from '../services/exportService';
import {
  ATTENDANCE_HISTORY_EXPORT_COLUMNS,
  buildAttendanceHistoryExportRows,
  computeAttendanceReportSummary,
} from '../utils/attendanceReportBuilder';
import {
  evaluateOptionAPunchOut,
  formatDurationClock,
  getAttendanceStatusBadgeClasses,
  resolveAttendanceMetrics,
  resolveShiftScheduleBounds,
  STANDARD_DUTY_MINUTES,
} from '../utils/attendanceStatus';
import {
  type AttendanceHistoryOverviewResponse,
  type DailyAttendanceApiItem,
  type SafeEmployeeProfile,
  fetchAttendanceHistoryOverview,
  fetchDailyAttendanceLedger,
  searchAttendanceHistoryEmployees,
} from '../services/attendanceHistoryService';
import { TableSkeletonRows } from './Skeletons';
import {
  recordPerfMetric,
  startPerfTimer,
  subscribeAttendanceCommitted,
} from '../utils/perfMonitor';
import { useBulkSelection } from '../hooks/useBulkSelection';
import {
  BulkActionBar,
  type BulkExecutionSummary,
  type BulkProgressState,
  SelectAllCheckbox,
} from './BulkActionBar';
import { CrossPageSelectConfirmModal } from './BulkConfirmModal';
import { exportChunkedToCsv, exportChunkedToExcel } from '../services/bulkActionService';
import { EmployeeMonthlyCalendar } from './attendanceHistory/EmployeeMonthlyCalendar';
import { AbsentManpowerPanel } from './attendanceHistory/AbsentManpowerPanel';

export type AttendanceHistoryTab =
  | 'overview'
  | 'calendar'
  | 'daily'
  | 'absent';

interface AttendanceHistoryProps {
  floors: Floor[];
  sections: Section[];
  departments: Department[];
  shifts: Shift[];
  currentUserRole?: UserRoleRecord | null;
  rolePermissions?: Record<string, RolePermissionRecord>;
  initialTab?: AttendanceHistoryTab;
}

interface ColumnVisibility {
  lineDept: boolean;
  state: boolean;
  scheduledBounds: boolean;
  earlyArrival: boolean;
  autoCloseRecordedAt: boolean;
  outType: boolean;
  punches: boolean;
  otBreakdown: boolean;
}

const DEFAULT_COLUMN_VISIBILITY: ColumnVisibility = {
  lineDept: true,
  state: true,
  scheduledBounds: true,
  earlyArrival: false,
  autoCloseRecordedAt: false,
  outType: true,
  punches: true,
  otBreakdown: false,
};

export const AttendanceHistory: React.FC<AttendanceHistoryProps> = ({
  floors,
  sections,
  departments,
  shifts,
  initialTab = 'overview',
}) => {
  const todayIst = useMemo(() => formatDateKey(new Date()), []);

  // Active section tab & global selected date
  const [activeTab, setActiveTab] = useState<AttendanceHistoryTab>(initialTab);
  const [selectedDate, setSelectedDate] = useState<string>(todayIst);
  const [selectedCalendarEmployeeId, setSelectedCalendarEmployeeId] = useState<string | null>(null);
  const [refreshSignal, setRefreshSignal] = useState<number>(0);

  // Global quick employee search bar (jumps straight to Tab 2: Employee Monthly Calendar)
  const [globalEmpSearch, setGlobalEmpSearch] = useState('');
  const [globalEmpResults, setGlobalEmpResults] = useState<SafeEmployeeProfile[]>([]);
  const [globalEmpOpen, setGlobalEmpOpen] = useState(false);
  const [globalEmpSearching, setGlobalEmpSearching] = useState(false);

  // Overview KPI state
  const [overview, setOverview] = useState<AttendanceHistoryOverviewResponse | null>(null);
  const [overviewLoading, setOverviewLoading] = useState<boolean>(true);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  // Daily Attendance Ledger state (server-side paginated)
  const [dailyItems, setDailyItems] = useState<DailyAttendanceApiItem[]>([]);
  const [dailyTotal, setDailyTotal] = useState<number>(0);
  const [dailyTotalPages, setDailyTotalPages] = useState<number>(1);
  const [dailyLoading, setDailyLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [dailyError, setDailyError] = useState<string | null>(null);

  // Daily filters & pagination
  const [startDate, setStartDate] = useState(
    formatDateKey(new Date(Date.now() - 7 * 24 * 3600 * 1000))
  );
  const [endDate, setEndDate] = useState(todayIst);
  const [searchEmp, setSearchEmp] = useState('');
  const [filterFloor, setFilterFloor] = useState('ALL');
  const [filterDept, setFilterDept] = useState('ALL');
  const [filterShift, setFilterShift] = useState('ALL');
  const [filterStatus, setFilterStatus] = useState('ALL');
  const [filterPunchOutType, setFilterPunchOutType] = useState('ALL');
  const [dailySortBy, setDailySortBy] = useState<
    'date_desc' | 'date_asc' | 'employeeId_asc' | 'name_asc' | 'duty_desc' | 'ot_desc'
  >('date_desc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [colVis, setColVis] = useState<ColumnVisibility>(DEFAULT_COLUMN_VISIBILITY);
  const [showColMenu, setShowColMenu] = useState(false);

  // Correction & Punch Timeline Modals
  const [correctingRecord, setCorrectingRecord] = useState<AttendanceRecord | null>(null);
  const [viewingPunchesRecord, setViewingPunchesRecord] = useState<AttendanceRecord | null>(null);
  const [correctionOutTime, setCorrectionOutTime] = useState('');
  const [correctionStatus, setCorrectionStatus] = useState<AttendanceStatus>('COMPLETED');
  const [correctionReason, setCorrectionReason] = useState('');
  const [adminName, setAdminName] = useState('Shift Supervisor');
  const [isSubmittingCorrection, setIsSubmittingCorrection] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const dailyItemsRef = useRef<DailyAttendanceApiItem[]>([]);
  dailyItemsRef.current = dailyItems;

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // Load Top Overview KPIs from backend
  const loadOverview = async (silent = false) => {
    if (!silent) setOverviewLoading(true);
    setOverviewError(null);
    try {
      const res = await fetchAttendanceHistoryOverview(selectedDate);
      setOverview(res);
    } catch (err: any) {
      setOverviewError(
        getSafeErrorText(err, {
          moduleName: 'Attendance History Overview',
          endpoint: '/api/attendance-history/overview',
        })
      );
    } finally {
      setOverviewLoading(false);
    }
  };

  // Load Daily Attendance Ledger from backend (paginated & server-filtered)
  const loadDailyLedger = async (silent = false) => {
    const stopTimer = startPerfTimer();
    const hasExisting = dailyItemsRef.current.length > 0;
    if (silent || hasExisting) {
      setIsRefreshing(true);
    } else {
      setDailyLoading(true);
    }
    setDailyError(null);
    try {
      const res = await fetchDailyAttendanceLedger({
        startDate,
        endDate,
        search: searchEmp.trim(),
        line: filterFloor,
        department: filterDept,
        shift: filterShift,
        status: filterStatus,
        punchOutType: filterPunchOutType,
        sortBy: dailySortBy,
        page,
        pageSize,
      });
      setDailyItems(res.records || []);
      setDailyTotal(res.total || 0);
      setDailyTotalPages(res.totalPages || 1);
      recordPerfMetric('background_refresh_ms', stopTimer());
    } catch (err: any) {
      setDailyError(
        getSafeErrorText(err, {
          moduleName: 'Attendance History',
          endpoint: '/api/attendance-history/daily',
        })
      );
    } finally {
      setDailyLoading(false);
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    loadOverview(false);
  }, [selectedDate, refreshSignal]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      loadDailyLedger(false);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [
    startDate,
    endDate,
    searchEmp,
    filterFloor,
    filterDept,
    filterShift,
    filterStatus,
    filterPunchOutType,
    dailySortBy,
    page,
    pageSize,
    refreshSignal,
  ]);

  // Live refresh when scanner commits a punch
  useEffect(() => {
    let refreshTimer: number | null = null;
    const unsub = subscribeAttendanceCommitted(() => {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        loadOverview(true);
        loadDailyLedger(true);
        setRefreshSignal((s) => s + 1);
      }, 350);
    });
    return () => {
      unsub();
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    };
  }, [selectedDate, startDate, endDate]);

  // Global quick employee search debounce
  useEffect(() => {
    if (!globalEmpOpen && !globalEmpSearch.trim()) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setGlobalEmpSearching(true);
      try {
        const res = await searchAttendanceHistoryEmployees({
          q: globalEmpSearch.trim(),
          page: 1,
          pageSize: 12,
        });
        if (!cancelled) setGlobalEmpResults(res.employees || []);
      } catch {
        if (!cancelled) setGlobalEmpResults([]);
      } finally {
        if (!cancelled) setGlobalEmpSearching(false);
      }
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [globalEmpSearch, globalEmpOpen]);

  const handleGlobalRefresh = () => {
    loadOverview(true);
    loadDailyLedger(true);
    setRefreshSignal((s) => s + 1);
  };

  const handleJumpToEmployeeCalendar = (employeeId: string) => {
    setSelectedCalendarEmployeeId(employeeId);
    setGlobalEmpOpen(false);
    setGlobalEmpSearch('');
    setActiveTab('calendar');
  };

  // Correction modal handlers
  const handleOpenCorrection = (rec: AttendanceRecord) => {
    const resolved = resolveAttendanceMetrics(rec, nowMs);
    setCorrectingRecord(rec);
    setCorrectionStatus((resolved.status as AttendanceStatus) || rec.attendanceStatus);
    setCorrectionReason(rec.correctionReason || '');
    if (rec.actualPunchOut || rec.effectivePunchOut) {
      const outIso = rec.actualPunchOut || rec.effectivePunchOut;
      const k = getKolkataTimeParts(new Date(outIso!));
      setCorrectionOutTime(
        `${String(k.hours).padStart(2, '0')}:${String(k.minutes).padStart(2, '0')}`
      );
    } else {
      setCorrectionOutTime(rec.scheduledPunchOut || '17:30');
    }
  };

  const handleSaveCorrection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!correctingRecord) return;
    if (!correctionReason.trim()) {
      handleAppError('Mandatory reason required for attendance correction.', {
        moduleName: 'Attendance History',
        forcedErrorCode: 'VAL-001',
        reportToBackend: false,
        notifyGlobalToast: true,
      });
      return;
    }

    setIsSubmittingCorrection(true);
    try {
      let finalOutIso: string | undefined = undefined;
      if (correctionOutTime) {
        const [h, m] = correctionOutTime.split(':').map(Number);
        const isNightShift =
          correctingRecord.shiftId === 'NIGHT' ||
          (correctingRecord.shiftNameSnapshot || '').toUpperCase().includes('NIGHT');
        const targetDate =
          isNightShift && h < 12
            ? getNextDateKey(correctingRecord.shiftDate)
            : correctingRecord.shiftDate;
        finalOutIso = `${targetDate}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+05:30`;
      }

      await correctAttendanceRecord(correctingRecord.id, {
        actualPunchOut: finalOutIso,
        punchOutType: 'ACTUAL',
        attendanceStatus: correctionStatus,
        reason: correctionReason,
        adminName: adminName || 'Supervisor',
      });

      setCorrectingRecord(null);
      handleGlobalRefresh();
    } catch (err: any) {
      handleAppError(err, {
        moduleName: 'Attendance History',
        endpoint: '/api/attendance/correct',
        notifyGlobalToast: true,
      });
    } finally {
      setIsSubmittingCorrection(false);
    }
  };

  // Export Daily Attendance (fetches full filtered range up to 200 rows per page cleanly)
  const rawRecordsOnPage = useMemo(() => dailyItems.map((i) => i.record), [dailyItems]);

  const handleExportDaily = async (format: 'xlsx' | 'csv') => {
    try {
      const fullRes = await fetchDailyAttendanceLedger({
        startDate,
        endDate,
        search: searchEmp.trim(),
        line: filterFloor,
        department: filterDept,
        shift: filterShift,
        status: filterStatus,
        punchOutType: filterPunchOutType,
        sortBy: dailySortBy,
        page: 1,
        pageSize: 200,
      });
      const sourceRecords = (fullRes.records || []).map((r) => r.record);
      const exportData = buildAttendanceHistoryExportRows(sourceRecords, nowMs);
      const fileName = `NARID_Attendance_History_${startDate}_to_${endDate}`;
      if (format === 'xlsx') {
        await exportTableToExcel(exportData, ATTENDANCE_HISTORY_EXPORT_COLUMNS, fileName, {
          reportTitle: 'Attendance History Report',
          periodLabel: `${startDate} to ${endDate}`,
          sheetName: 'Attendance History',
          summary: computeAttendanceReportSummary(exportData),
        });
      } else {
        exportTableToCsv(exportData, ATTENDANCE_HISTORY_EXPORT_COLUMNS, fileName);
      }
    } catch (err) {
      handleAppError(err, {
        moduleName: 'Attendance History',
        forcedErrorCode: 'FILE-002',
        notifyGlobalToast: true,
      });
    }
  };

  // Bulk selection over current daily ledger
  const bulk = useBulkSelection<AttendanceRecord>({
    items: rawRecordsOnPage,
    paginatedItems: rawRecordsOnPage,
    getId: (r) => r.id,
  });

  const [bulkProgress, setBulkProgress] = useState<BulkProgressState | null>(null);
  const [bulkSummary, setBulkSummary] = useState<BulkExecutionSummary | null>(null);

  const handleBulkExport = async (format: 'xlsx' | 'csv') => {
    const target = bulk.selectedItems;
    if (target.length === 0 || bulkProgress) return;
    setBulkSummary(null);
    setBulkProgress({
      label:
        format === 'xlsx'
          ? 'Exporting selected attendance records to Excel...'
          : 'Exporting selected attendance records to CSV...',
      completed: 0,
      total: target.length,
    });
    try {
      const rows = buildAttendanceHistoryExportRows(target, nowMs);
      const fn = format === 'xlsx' ? exportChunkedToExcel : exportChunkedToCsv;
      const out = await fn(
        rows,
        ATTENDANCE_HISTORY_EXPORT_COLUMNS,
        `NARID_Attendance_History_Selected_${startDate}_to_${endDate}`,
        {
          onProgress: (completed, total) =>
            setBulkProgress({
              label:
                format === 'xlsx'
                  ? 'Exporting selected attendance records to Excel...'
                  : 'Exporting selected attendance records to CSV...',
              completed,
              total,
            }),
          auditTargetType: 'ATTENDANCE_HISTORY',
          auditSource: 'ATTENDANCE_HISTORY',
          auditDescription: `Bulk exported ${rows.length} selected attendance records (${format.toUpperCase()}).`,
          reportTitle: 'Attendance History Report (Selected)',
          periodLabel: `${startDate} to ${endDate}`,
          sheetName: 'Attendance History',
          summary: computeAttendanceReportSummary(rows),
        }
      );
      setBulkSummary({
        type: 'success',
        title: `Exported ${out.rowCount} Attendance Records`,
        message: `Downloaded "${out.fileName}". Selection cleared.`,
        savedCount: out.rowCount,
      });
      bulk.clearSelection();
    } catch (err: any) {
      setBulkSummary({
        type: 'error',
        title: 'Bulk Export Failed',
        message: getSafeErrorText(err, {
          moduleName: 'Attendance History',
          forcedErrorCode: 'FILE-002',
        }),
      });
    } finally {
      setBulkProgress(null);
    }
  };

  const kpis = overview?.kpis;
  const displayKpiValue = (val: number | undefined, suffix = ''): string => {
    if (overviewLoading && !overview) return '—';
    if (val === undefined || val === null) return '—';
    return `${val}${suffix}`;
  };

  const NAV_TABS: Array<{
    id: AttendanceHistoryTab;
    label: string;
    icon: React.ReactNode;
    badge?: number;
  }> = [
    { id: 'overview', label: 'Overview', icon: <LayoutDashboard className="w-4 h-4" /> },
    {
      id: 'calendar',
      label: 'Employee Attendance Calendar',
      icon: <CalendarDays className="w-4 h-4" />,
    },
    { id: 'daily', label: 'Daily Attendance', icon: <History className="w-4 h-4" /> },
    {
      id: 'absent',
      label: 'Absent Manpower',
      icon: <UserX className="w-4 h-4" />,
      badge: kpis?.absentToday,
    },
  ];

  const activeDailyColCount =
    12 +
    (colVis.lineDept ? 1 : 0) +
    (colVis.state ? 1 : 0) +
    (colVis.scheduledBounds ? 2 : 0) +
    (colVis.earlyArrival ? 1 : 0) +
    (colVis.autoCloseRecordedAt ? 1 : 0) +
    (colVis.outType ? 1 : 0) +
    (colVis.punches ? 1 : 0) +
    (colVis.otBreakdown ? 2 : 0);

  return (
    <div className="p-4 sm:p-6 bg-slate-50 min-h-full flex flex-col gap-5">
      {/* Top Enterprise Header + Prominent Employee Quick Search */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 flex flex-col xl:flex-row xl:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
            <History className="w-5 h-5 text-blue-600 shrink-0" />
            <span>ATTENDANCE HISTORY</span>
            {(isRefreshing || overviewLoading) && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-600 ml-1">
                <RotateCcw className="w-3 h-3 animate-spin" />
                Syncing
              </span>
            )}
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Workforce attendance register, monthly employee calendars, and continuous absence tracking (IST)
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {/* Global Quick Employee Search -> Opens Tab 2 */}
          <div className="relative min-w-[240px] sm:min-w-[280px] flex-1 sm:flex-initial">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={globalEmpSearch}
              onFocus={() => setGlobalEmpOpen(true)}
              onChange={(e) => {
                setGlobalEmpSearch(e.target.value);
                setGlobalEmpOpen(true);
              }}
              placeholder="Quick Employee Calendar Search (ID / Name)..."
              aria-label="Quick search employee for monthly calendar"
              className="w-full pl-8 pr-7 py-2 text-xs bg-slate-50 border border-slate-300 rounded-lg text-slate-800 focus:outline-hidden focus:bg-white focus:border-blue-500"
            />
            {globalEmpSearch && (
              <button
                type="button"
                onClick={() => setGlobalEmpSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 cursor-pointer"
                aria-label="Clear quick employee search"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}

            {globalEmpOpen && (
              <div className="absolute right-0 left-0 mt-1.5 bg-white border border-slate-200 rounded-xl shadow-lg z-40 max-h-72 overflow-y-auto">
                <div className="px-3 py-2 border-b border-slate-100 bg-slate-50 flex items-center justify-between text-[11px] text-slate-500">
                  <span>
                    {globalEmpSearching
                      ? 'Searching...'
                      : 'Select employee to open Monthly Calendar'}
                  </span>
                  <button
                    type="button"
                    onClick={() => setGlobalEmpOpen(false)}
                    className="text-slate-500 hover:text-slate-800 font-semibold cursor-pointer"
                  >
                    Close
                  </button>
                </div>
                {globalEmpResults.length === 0 && !globalEmpSearching ? (
                  <div className="p-4 text-center text-xs text-slate-400">
                    No matching employees found.
                  </div>
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {globalEmpResults.map((emp) => (
                      <li key={emp.employeeId}>
                        <button
                          type="button"
                          onClick={() => handleJumpToEmployeeCalendar(emp.employeeId)}
                          className="w-full text-left px-3 py-2 hover:bg-blue-50/70 transition flex items-center justify-between gap-2 cursor-pointer"
                        >
                          <div className="min-w-0">
                            <div className="text-xs font-semibold text-slate-900 truncate">
                              <span className="font-mono font-bold mr-1.5">{emp.employeeId}</span>
                              {emp.employeeName}
                            </div>
                            <div className="text-[10px] text-slate-500 truncate">
                              {emp.line} • {emp.department} • {emp.currentShiftName}
                            </div>
                          </div>
                          <CalendarDays className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          {/* Reference Date Picker */}
          <div className="flex items-center gap-1.5 bg-slate-50 border border-slate-300 rounded-lg px-2.5 py-1.5">
            <Calendar className="w-3.5 h-3.5 text-blue-600 shrink-0" />
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => {
                if (e.target.value) setSelectedDate(e.target.value);
              }}
              aria-label="Dashboard reference date"
              className="bg-transparent text-xs font-semibold text-slate-800 focus:outline-hidden tabular-nums"
            />
          </div>

          {/* Refresh Button */}
          <button
            type="button"
            onClick={handleGlobalRefresh}
            disabled={isRefreshing}
            className="px-3 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer disabled:opacity-50"
          >
            <RotateCcw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Error Alert Banner */}
      {(overviewError || dailyError) && (
        <div
          role="alert"
          className="bg-red-50 border border-red-200 text-red-800 rounded-xl px-4 py-3 text-xs flex flex-wrap items-center justify-between gap-3"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
            <span>{overviewError || dailyError}</span>
          </div>
          <button
            type="button"
            onClick={handleGlobalRefresh}
            className="bg-white hover:bg-red-100 text-red-700 border border-red-300 px-3 py-1 rounded font-semibold transition cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}

      {/* Top 8 Summary KPI Strip (Real Backend Metrics) */}
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
        <div className="bg-white rounded-xl border border-slate-200 p-3.5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-[11px] font-semibold text-slate-500">
            <span>Total Active</span>
            <Users className="w-3.5 h-3.5 text-slate-400" />
          </div>
          <div className="text-xl font-bold text-slate-900 tabular-nums mt-1.5">
            {displayKpiValue(kpis?.totalActiveEmployees)}
          </div>
          <div className="text-[10px] text-slate-400 mt-0.5">Active workforce</div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-3.5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-[11px] font-semibold text-emerald-700">
            <span>Present Today</span>
            <UserCheck className="w-3.5 h-3.5 text-emerald-600" />
          </div>
          <div className="text-xl font-bold text-emerald-700 tabular-nums mt-1.5">
            {displayKpiValue(kpis?.presentToday)}
          </div>
          <div className="text-[10px] text-slate-400 mt-0.5">{selectedDate}</div>
        </div>

        <button
          type="button"
          onClick={() => setActiveTab('absent')}
          className="bg-white rounded-xl border border-slate-200 hover:border-red-300 p-3.5 flex flex-col justify-between text-left transition cursor-pointer"
        >
          <div className="flex items-center justify-between text-[11px] font-semibold text-red-700">
            <span>Absent Today</span>
            <UserX className="w-3.5 h-3.5 text-red-600" />
          </div>
          <div className="text-xl font-bold text-red-700 tabular-nums mt-1.5">
            {displayKpiValue(kpis?.absentToday)}
          </div>
          <div className="text-[10px] text-red-600 font-medium mt-0.5">View absent list →</div>
        </button>

        <div className="bg-white rounded-xl border border-slate-200 p-3.5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-[11px] font-semibold text-amber-700">
            <span>Late Arrivals</span>
            <Clock className="w-3.5 h-3.5 text-amber-600" />
          </div>
          <div className="text-xl font-bold text-amber-700 tabular-nums mt-1.5">
            {displayKpiValue(kpis?.lateArrivals)}
          </div>
          <div className="text-[10px] text-slate-400 mt-0.5">After grace window</div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-3.5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-[11px] font-semibold text-orange-700">
            <span>Auto-Closed</span>
            <AlertTriangle className="w-3.5 h-3.5 text-orange-600" />
          </div>
          <div className="text-xl font-bold text-orange-700 tabular-nums mt-1.5">
            {displayKpiValue(kpis?.autoClosedAttendance)}
          </div>
          <div className="text-[10px] text-slate-400 mt-0.5">Provisional close</div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-3.5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-[11px] font-semibold text-sky-700">
            <span>Currently IN</span>
            <CheckCircle2 className="w-3.5 h-3.5 text-sky-600" />
          </div>
          <div className="text-xl font-bold text-sky-700 tabular-nums mt-1.5">
            {displayKpiValue(kpis?.currentlyIn)}
          </div>
          <div className="text-[10px] text-slate-400 mt-0.5">Active on shift</div>
        </div>

        <button
          type="button"
          onClick={() => setActiveTab('absent')}
          className="bg-white rounded-xl border border-slate-200 hover:border-red-300 p-3.5 flex flex-col justify-between text-left transition cursor-pointer"
        >
          <div className="flex items-center justify-between text-[11px] font-semibold text-rose-700">
            <span>Consecutive Abs</span>
            <UserX className="w-3.5 h-3.5 text-rose-600" />
          </div>
          <div className="text-xl font-bold text-rose-700 tabular-nums mt-1.5">
            {displayKpiValue(kpis?.consecutiveAbsentees)}
          </div>
          <div className="text-[10px] text-slate-400 mt-0.5">2+ working days</div>
        </button>

        <div className="bg-white rounded-xl border border-slate-200 p-3.5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-[11px] font-semibold text-blue-700">
            <span>Attendance %</span>
            <Percent className="w-3.5 h-3.5 text-blue-600" />
          </div>
          <div className="text-xl font-bold text-blue-700 tabular-nums mt-1.5">
            {kpis ? `${kpis.overallAttendancePercentage.toFixed(1)}%` : '—'}
          </div>
          <div className="text-[10px] text-slate-400 mt-0.5">Of scheduled staff</div>
        </div>
      </div>

      {/* 5-Tab Section Navigation */}
      <div className="bg-white rounded-xl border border-slate-200 px-2 pt-2 flex items-center gap-1 overflow-x-auto">
        {NAV_TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`px-3.5 py-2.5 text-xs font-semibold border-b-2 flex items-center gap-2 whitespace-nowrap transition cursor-pointer ${
                isActive
                  ? 'border-blue-600 text-blue-700 bg-blue-50/40 rounded-t-lg'
                  : 'border-transparent text-slate-600 hover:text-slate-900 hover:bg-slate-50 rounded-t-lg'
              }`}
            >
              {tab.icon}
              <span>{tab.label}</span>
              {typeof tab.badge === 'number' && tab.badge > 0 && (
                <span className="px-1.5 py-0.5 rounded bg-red-100 text-red-800 text-[10px] font-bold tabular-nums">
                  {tab.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ==================================================================== */}
      {/* TAB 1: OVERVIEW                                                      */}
      {/* ==================================================================== */}
      {activeTab === 'overview' && (
        <div className="flex flex-col gap-5">
          {/* Operational Highlights Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            {/* Consecutive Absentees Watchlist */}
            <div className="lg:col-span-2 bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between gap-2">
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                    Continuous Absence Watchlist ({selectedDate})
                  </h3>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    Click any employee to open their full Monthly Attendance Calendar
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveTab('absent')}
                  className="text-xs font-semibold text-blue-600 hover:text-blue-800 cursor-pointer"
                >
                  Open Absent Manpower →
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 text-slate-600 text-[11px] uppercase border-b border-slate-200">
                    <tr>
                      <th className="py-2.5 px-3.5">Emp ID</th>
                      <th className="py-2.5 px-3.5">Employee Name</th>
                      <th className="py-2.5 px-3.5">Line / Dept</th>
                      <th className="py-2.5 px-3.5">Last Present</th>
                      <th className="py-2.5 px-3.5">Absent Since</th>
                      <th className="py-2.5 px-3.5 text-right">Consecutive Days</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {overviewLoading && !overview ? (
                      <TableSkeletonRows rows={4} cols={6} />
                    ) : !overview?.topConsecutiveAbsentees?.length ? (
                      <tr>
                        <td colSpan={6} className="py-8 text-center text-slate-400">
                          No verified absentees on {selectedDate}.
                        </td>
                      </tr>
                    ) : (
                      overview.topConsecutiveAbsentees.map((row) => (
                        <tr
                          key={row.employeeId}
                          onClick={() => handleJumpToEmployeeCalendar(row.employeeId)}
                          className="hover:bg-slate-50 cursor-pointer"
                        >
                          <td className="py-2.5 px-3.5 font-mono font-bold text-slate-900">
                            {row.employeeId}
                          </td>
                          <td className="py-2.5 px-3.5 font-semibold text-slate-800">
                            {row.employeeName}
                          </td>
                          <td className="py-2.5 px-3.5 text-slate-600">
                            {row.line} • {row.department}
                          </td>
                          <td className="py-2.5 px-3.5 font-mono text-slate-700 tabular-nums">
                            {row.lastPresentDate || 'No Record'}
                          </td>
                          <td className="py-2.5 px-3.5 font-mono text-red-700 tabular-nums">
                            {row.firstDateOfCurrentAbsence || selectedDate}
                          </td>
                          <td className="py-2.5 px-3.5 text-right">
                            <span className="px-2 py-0.5 rounded bg-red-100 text-red-800 border border-red-200 font-mono font-bold tabular-nums">
                              {row.consecutiveAbsentWorkingDays}d
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Schedule Coverage & Quick Actions */}
            <div className="bg-white rounded-xl border border-slate-200 p-4 flex flex-col justify-between gap-4">
              <div>
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                  Schedule Coverage ({selectedDate})
                </h3>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Authoritative classification before marking absence
                </p>

                <div className="mt-3 space-y-2 text-xs">
                  <div className="flex items-center justify-between py-1.5 border-b border-slate-100">
                    <span className="text-slate-600">Scheduled Working Employees</span>
                    <span className="font-mono font-bold text-slate-900 tabular-nums">
                      {overview?.scheduleSummary.scheduledWorkingCount ?? '—'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between py-1.5 border-b border-slate-100">
                    <span className="text-slate-600">Weekly Off</span>
                    <span className="font-mono font-semibold text-slate-700 tabular-nums">
                      {overview?.scheduleSummary.weeklyOffCount ?? '—'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between py-1.5 border-b border-slate-100">
                    <span className="text-slate-600">Declared Holidays</span>
                    <span className="font-mono font-semibold text-blue-700 tabular-nums">
                      {overview?.scheduleSummary.holidayCount ?? '—'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between py-1.5 border-b border-slate-100">
                    <span className="text-slate-600">Approved Leave</span>
                    <span className="font-mono font-semibold text-purple-700 tabular-nums">
                      {overview?.scheduleSummary.approvedLeaveCount ?? '—'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between py-1.5">
                    <span className="text-slate-600">Unverified / Unknown Schedule</span>
                    <span className="font-mono font-semibold text-slate-500 tabular-nums">
                      {overview?.scheduleSummary.unknownCount ?? '—'}
                    </span>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setActiveTab('calendar')}
                  className="px-3 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold cursor-pointer"
                >
                  Monthly Calendar
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('daily')}
                  className="px-3 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold cursor-pointer"
                >
                  Daily Attendance
                </button>
              </div>
            </div>
          </div>

          {/* Recent Daily Attendance Preview (Preserves Full Punch & Early OT Columns) */}
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                  Recent Daily Attendance Records ({startDate} to {endDate})
                </h3>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Showing latest punches, early arrival, regular duty, and finalized OT calculations
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleExportDaily('xlsx')}
                  disabled={dailyItems.length === 0}
                  className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  <FileSpreadsheet className="w-3.5 h-3.5" />
                  <span>Export Excel</span>
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('daily')}
                  className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold cursor-pointer"
                >
                  Open Full Daily Register →
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-600 uppercase font-semibold border-b border-slate-200 text-[11px]">
                  <tr>
                    <th className="py-2.5 px-3">Emp ID</th>
                    <th className="py-2.5 px-3">Name</th>
                    <th className="py-2.5 px-3">Line / Dept</th>
                    <th className="py-2.5 px-3">Shift &amp; Date</th>
                    <th className="py-2.5 px-3 whitespace-nowrap">Scheduled Start</th>
                    <th className="py-2.5 px-3 whitespace-nowrap">Scheduled End</th>
                    <th className="py-2.5 px-3 whitespace-nowrap">Actual Punch In</th>
                    <th className="py-2.5 px-3 whitespace-nowrap">Early Arrival</th>
                    <th className="py-2.5 px-3 whitespace-nowrap">Actual Punch-Out</th>
                    <th className="py-2.5 px-3 whitespace-nowrap text-orange-800">Auto-Close Time</th>
                    <th className="py-2.5 px-3 whitespace-nowrap">Duty Hours</th>
                    <th className="py-2.5 px-3 whitespace-nowrap">Early OT</th>
                    <th className="py-2.5 px-3 whitespace-nowrap">Post-shift OT</th>
                    <th className="py-2.5 px-3 whitespace-nowrap">Total OT</th>
                    <th className="py-2.5 px-3 whitespace-nowrap">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {dailyLoading && dailyItems.length === 0 ? (
                    <TableSkeletonRows rows={5} cols={15} />
                  ) : dailyItems.length === 0 ? (
                    <tr>
                      <td colSpan={15} className="py-8 text-center text-slate-400">
                        No attendance records found for {startDate} to {endDate}.
                      </td>
                    </tr>
                  ) : (
                    dailyItems.slice(0, 10).map((item) => {
                      const metrics = resolveAttendanceMetrics(item.record, nowMs);
                      return (
                        <tr key={item.id} className="hover:bg-slate-50">
                          <td className="py-2.5 px-3 font-mono font-bold text-slate-900 whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => handleJumpToEmployeeCalendar(item.employeeId)}
                              className="text-blue-700 hover:underline cursor-pointer"
                            >
                              {item.employeeId}
                            </button>
                          </td>
                          <td className="py-2.5 px-3 font-semibold text-slate-800 whitespace-nowrap">
                            {item.employeeName}
                          </td>
                          <td className="py-2.5 px-3 text-slate-600 whitespace-nowrap">
                            {item.line} • {item.department}
                          </td>
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            <span className="font-semibold text-slate-800 block">
                              {item.shiftName}
                            </span>
                            <span className="text-[10px] font-mono text-slate-400">
                              {item.attendanceDate}
                            </span>
                          </td>
                          <td className="py-2.5 px-3 font-mono text-slate-700 whitespace-nowrap tabular-nums">
                            {item.scheduledShiftStart}
                          </td>
                          <td className="py-2.5 px-3 font-mono text-slate-700 whitespace-nowrap tabular-nums">
                            {item.scheduledShiftEnd}
                          </td>
                          <td className="py-2.5 px-3 font-mono font-semibold text-emerald-700 whitespace-nowrap tabular-nums">
                            {item.actualPunchIn}
                          </td>
                          <td className="py-2.5 px-3 font-mono whitespace-nowrap tabular-nums">
                            {formatDurationClock(metrics.earlyArrivalMinutes)}
                          </td>
                          <td className="py-2.5 px-3 font-mono font-semibold text-blue-700 whitespace-nowrap tabular-nums">
                            {item.actualPunchOut}
                          </td>
                          <td className="py-2.5 px-3 font-mono font-semibold text-orange-800 whitespace-nowrap tabular-nums">
                            {item.autoCloseTime}
                          </td>
                          <td className="py-2.5 px-3 font-mono font-bold text-slate-900 whitespace-nowrap tabular-nums">
                            {item.dutyHours}
                          </td>
                          <td className="py-2.5 px-3 font-mono text-emerald-700 whitespace-nowrap tabular-nums">
                            {formatDurationClock(metrics.earlyOtMinutes)}
                          </td>
                          <td className="py-2.5 px-3 font-mono text-indigo-700 whitespace-nowrap tabular-nums">
                            {formatDurationClock(metrics.postShiftOtMinutes)}
                          </td>
                          <td className="py-2.5 px-3 font-mono font-bold text-indigo-800 whitespace-nowrap tabular-nums">
                            {item.otHours}
                          </td>
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-bold ${getAttendanceStatusBadgeClasses(
                                metrics.status
                              )}`}
                            >
                              {metrics.status}
                            </span>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* TAB 2: EMPLOYEE ATTENDANCE CALENDAR                                  */}
      {/* ==================================================================== */}
      {activeTab === 'calendar' && (
        <EmployeeMonthlyCalendar
          selectedEmployeeId={selectedCalendarEmployeeId}
          onSelectEmployee={(emp) => setSelectedCalendarEmployeeId(emp.employeeId)}
          refreshSignal={refreshSignal}
        />
      )}

      {/* ==================================================================== */}
      {/* TAB 3: DAILY ATTENDANCE REGISTER (ENHANCED 16+ COLUMNS)              */}
      {/* ==================================================================== */}
      {activeTab === 'daily' && (
        <div className="flex flex-col gap-4">
          {/* Daily Filter Toolbar */}
          <div className="bg-white p-4 rounded-xl border border-slate-200 flex flex-col gap-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                {/* Date Range */}
                <div className="flex items-center gap-1.5 bg-slate-50 border border-slate-300 rounded-lg px-2.5 py-1.5">
                  <Calendar className="w-3.5 h-3.5 text-blue-600" />
                  <span className="text-[10px] text-slate-400">From</span>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => {
                      setStartDate(e.target.value);
                      setPage(1);
                    }}
                    className="bg-transparent text-xs text-slate-800 font-semibold focus:outline-hidden"
                  />
                  <span className="text-[10px] text-slate-400">To</span>
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => {
                      setEndDate(e.target.value);
                      setPage(1);
                    }}
                    className="bg-transparent text-xs text-slate-800 font-semibold focus:outline-hidden"
                  />
                </div>

                {/* Search ID or Name */}
                <div className="flex items-center gap-2 bg-slate-50 border border-slate-300 rounded-lg px-2.5 py-1.5 min-w-[210px]">
                  <Search className="w-3.5 h-3.5 text-slate-400" />
                  <input
                    type="text"
                    placeholder="Search Emp ID / Name..."
                    value={searchEmp}
                    onChange={(e) => {
                      setSearchEmp(e.target.value);
                      setPage(1);
                    }}
                    className="w-full bg-transparent text-slate-800 focus:outline-hidden"
                  />
                </div>

                {/* Line */}
                <select
                  value={filterFloor}
                  onChange={(e) => {
                    setFilterFloor(e.target.value);
                    setPage(1);
                  }}
                  className="bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-slate-700"
                >
                  <option value="ALL">All Lines</option>
                  {floors.map((f) => (
                    <option key={f.id} value={f.name}>
                      {f.name}
                    </option>
                  ))}
                </select>

                {/* Department */}
                <select
                  value={filterDept}
                  onChange={(e) => {
                    setFilterDept(e.target.value);
                    setPage(1);
                  }}
                  className="bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-slate-700"
                >
                  <option value="ALL">All Departments</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.name}>
                      {d.name}
                    </option>
                  ))}
                </select>

                {/* Shift */}
                <select
                  value={filterShift}
                  onChange={(e) => {
                    setFilterShift(e.target.value);
                    setPage(1);
                  }}
                  className="bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-slate-700"
                >
                  <option value="ALL">All Shifts</option>
                  {shifts.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>

                {/* Status */}
                <select
                  value={filterStatus}
                  onChange={(e) => {
                    setFilterStatus(e.target.value);
                    setPage(1);
                  }}
                  className="bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-slate-700"
                >
                  <option value="ALL">All Statuses</option>
                  <option value="IN PROGRESS">IN PROGRESS</option>
                  <option value="SHORT LEAVE">SHORT LEAVE (&lt; 04:30)</option>
                  <option value="HALF DAY">HALF DAY (04:30 - 08:29)</option>
                  <option value="COMPLETED">COMPLETED (08:30)</option>
                  <option value="COMPLETED + OT">COMPLETED + OT (&gt; 08:30)</option>
                  <option value="AUTO CLOSED">AUTO CLOSED</option>
                  <option value="MISSED PUNCH OUT">MISSED PUNCH OUT</option>
                  <option value="LATE">LATE ARRIVAL</option>
                </select>

                {/* Punch Out Type */}
                <select
                  value={filterPunchOutType}
                  onChange={(e) => {
                    setFilterPunchOutType(e.target.value);
                    setPage(1);
                  }}
                  className="bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-slate-700"
                >
                  <option value="ALL">All Out Types</option>
                  <option value="ACTUAL">ACTUAL (Scanned)</option>
                  <option value="AUTO">AUTO (Missed)</option>
                  <option value="NONE">NONE (In Progress)</option>
                </select>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100">
              <div className="flex items-center gap-2">
                <span className="text-slate-500 font-medium">Sort:</span>
                <select
                  value={dailySortBy}
                  onChange={(e) => {
                    setDailySortBy(e.target.value as any);
                    setPage(1);
                  }}
                  aria-label="Sort daily attendance"
                  className="bg-white border border-slate-300 rounded-lg px-2.5 py-1 text-slate-800 font-semibold"
                >
                  <option value="date_desc">Latest Date First</option>
                  <option value="date_asc">Oldest Date First</option>
                  <option value="employeeId_asc">Employee ID (A–Z)</option>
                  <option value="name_asc">Name (A–Z)</option>
                  <option value="duty_desc">Highest Duty Hours</option>
                  <option value="ot_desc">Highest OT Hours</option>
                </select>

                {/* Column Visibility Control */}
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setShowColMenu((v) => !v)}
                    className="px-2.5 py-1 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 font-semibold flex items-center gap-1.5 cursor-pointer"
                  >
                    <Columns className="w-3.5 h-3.5" />
                    <span>Columns</span>
                  </button>
                  {showColMenu && (
                    <div className="absolute left-0 mt-1.5 w-56 bg-white border border-slate-200 rounded-xl shadow-lg p-3 z-30 flex flex-col gap-2">
                      <div className="flex items-center justify-between text-[11px] font-bold text-slate-700 pb-1 border-b border-slate-100">
                        <span>Visible Columns</span>
                        <button
                          type="button"
                          onClick={() => setShowColMenu(false)}
                          className="text-slate-400 hover:text-slate-700 cursor-pointer"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      {(
                        [
                          ['lineDept', 'Line & Department'],
                          ['state', 'Inside/Outside State'],
                          ['scheduledBounds', 'Scheduled Start & End'],
                          ['earlyArrival', 'Early Arrival'],
                          ['autoCloseRecordedAt', 'Auto-Close Recorded At'],
                          ['outType', 'Out Type'],
                          ['punches', 'Punch Events Count'],
                          ['otBreakdown', 'Early OT & Post-shift OT'],
                        ] as Array<[keyof ColumnVisibility, string]>
                      ).map(([key, label]) => (
                        <label
                          key={key}
                          className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={colVis[key]}
                            onChange={(e) =>
                              setColVis((prev) => ({ ...prev, [key]: e.target.checked }))
                            }
                            className="rounded text-blue-600"
                          />
                          <span>{label}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleExportDaily('csv')}
                  disabled={dailyItems.length === 0}
                  className="bg-white hover:bg-slate-50 text-slate-700 font-semibold text-xs px-3 py-1.5 rounded-lg border border-slate-300 flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>CSV</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleExportDaily('xlsx')}
                  disabled={dailyItems.length === 0}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-xs px-3.5 py-1.5 rounded-lg flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  <FileSpreadsheet className="w-3.5 h-3.5" />
                  <span>Export Daily Excel</span>
                </button>
              </div>
            </div>
          </div>

          {/* Bulk Selection Bar */}
          <BulkActionBar
            selectedCount={bulk.selectedCount}
            totalFilteredCount={bulk.totalFilteredCount}
            currentPageCount={bulk.currentPageCount}
            isAllFilteredSelected={bulk.isAllFilteredSelected}
            isPageAllSelected={bulk.isPageAllSelected}
            recordLabel="attendance records"
            onSelectAllFiltered={bulk.requestSelectAllFiltered}
            onClearSelection={bulk.clearSelection}
            progress={bulkProgress}
            summary={bulkSummary}
            onDismissSummary={() => setBulkSummary(null)}
            actions={[
              {
                id: 'export_excel',
                label: 'Export Selected Excel',
                icon: <FileSpreadsheet className="w-3.5 h-3.5" />,
                tone: 'emerald',
                onClick: () => handleBulkExport('xlsx'),
              },
              {
                id: 'export_csv',
                label: 'Export Selected CSV',
                icon: <Download className="w-3.5 h-3.5" />,
                tone: 'default',
                onClick: () => handleBulkExport('csv'),
              },
            ]}
          />

          {/* Daily Attendance Table (16 Core Columns + Optional Toggleable Columns) */}
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-600 uppercase font-semibold border-b border-slate-200 text-[11px]">
                  <tr>
                    <th className="py-3 px-3 w-10 text-center">
                      <SelectAllCheckbox
                        checked={bulk.isPageAllSelected}
                        indeterminate={bulk.isPageIndeterminate}
                        disabled={dailyItems.length === 0 || Boolean(bulkProgress)}
                        onChange={bulk.togglePageSelection}
                        ariaLabel="Select all attendance records on current page"
                      />
                    </th>
                    <th className="py-3 px-3 whitespace-nowrap">Employee ID</th>
                    <th className="py-3 px-3 whitespace-nowrap">Name</th>
                    {colVis.lineDept && (
                      <th className="py-3 px-3 whitespace-nowrap">Line / Department</th>
                    )}
                    <th className="py-3 px-3 whitespace-nowrap">Attendance Date</th>
                    <th className="py-3 px-3 whitespace-nowrap">Shift</th>
                    {colVis.state && <th className="py-3 px-3 whitespace-nowrap">State</th>}
                    {colVis.scheduledBounds && (
                      <>
                        <th className="py-3 px-3 whitespace-nowrap">Scheduled Shift Start</th>
                        <th className="py-3 px-3 whitespace-nowrap">Scheduled Shift End</th>
                      </>
                    )}
                    <th className="py-3 px-3 whitespace-nowrap">Actual Punch-In</th>
                    {colVis.earlyArrival && (
                      <th className="py-3 px-3 whitespace-nowrap">Early Arrival</th>
                    )}
                    <th className="py-3 px-3 whitespace-nowrap">Actual Punch-Out</th>
                    <th className="py-3 px-3 whitespace-nowrap text-orange-800">Auto-Close Time</th>
                    {colVis.autoCloseRecordedAt && (
                      <th className="py-3 px-3 whitespace-nowrap text-orange-800">
                        Auto-Close Recorded At
                      </th>
                    )}
                    {colVis.outType && <th className="py-3 px-3 whitespace-nowrap">Out Type</th>}
                    {colVis.punches && <th className="py-3 px-3 whitespace-nowrap">Punches</th>}
                    <th className="py-3 px-3 whitespace-nowrap">Attendance Status</th>
                    <th className="py-3 px-3 whitespace-nowrap">Duty Hours</th>
                    {colVis.otBreakdown && (
                      <>
                        <th className="py-3 px-3 whitespace-nowrap">Early OT</th>
                        <th className="py-3 px-3 whitespace-nowrap">Post-shift OT</th>
                      </>
                    )}
                    <th className="py-3 px-3 whitespace-nowrap">OT Hours</th>
                    <th className="py-3 px-3 whitespace-nowrap">Total Working Hours</th>
                    <th className="py-3 px-3 text-right whitespace-nowrap">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {dailyLoading && dailyItems.length === 0 ? (
                    <TableSkeletonRows rows={8} cols={activeDailyColCount} />
                  ) : dailyItems.length === 0 ? (
                    <tr>
                      <td
                        colSpan={activeDailyColCount}
                        className="py-10 text-center text-slate-400"
                      >
                        No daily attendance records matched the selected filters.
                      </td>
                    </tr>
                  ) : (
                    dailyItems.map((item) => {
                      const rec = item.record;
                      const metrics = resolveAttendanceMetrics(rec, nowMs);
                      const punchCount = rec.punches?.length || (rec.actualPunchOut ? 2 : 1);
                      const isChecked = bulk.isSelected(rec.id);
                      return (
                        <tr
                          key={rec.id}
                          className={`transition ${
                            isChecked ? 'bg-blue-50/60 hover:bg-blue-50/90' : 'hover:bg-slate-50'
                          }`}
                        >
                          <td className="py-3 px-3 text-center">
                            <input
                              type="checkbox"
                              checked={isChecked}
                              disabled={Boolean(bulkProgress)}
                              onChange={() => bulk.toggleOne(rec.id)}
                              aria-label={`Select attendance record ${rec.employeeId} ${rec.shiftDate}`}
                              className="rounded text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer"
                            />
                          </td>
                          <td className="py-3 px-3 font-mono font-bold text-slate-900 whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => handleJumpToEmployeeCalendar(item.employeeId)}
                              className="text-blue-700 hover:underline cursor-pointer"
                              title="Open Employee Monthly Attendance Calendar"
                            >
                              {item.employeeId}
                            </button>
                          </td>
                          <td className="py-3 px-3 font-semibold text-slate-800 whitespace-nowrap">
                            {item.employeeName}
                          </td>
                          {colVis.lineDept && (
                            <td className="py-3 px-3 text-slate-600 whitespace-nowrap">
                              {item.line} • {item.department}
                            </td>
                          )}
                          <td className="py-3 px-3 font-mono text-slate-700 whitespace-nowrap tabular-nums">
                            {item.attendanceDate}
                          </td>
                          <td className="py-3 px-3 font-semibold text-slate-800 whitespace-nowrap">
                            {item.shiftName}
                          </td>
                          {colVis.state && (
                            <td className="py-3 px-3 whitespace-nowrap">
                              <span
                                className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase inline-flex items-center gap-1 border ${
                                  metrics.state === 'INSIDE'
                                    ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                                    : 'bg-slate-100 text-slate-700 border-slate-200'
                                }`}
                              >
                                <span
                                  className={`w-1.5 h-1.5 rounded-full ${
                                    metrics.state === 'INSIDE' ? 'bg-emerald-600' : 'bg-slate-400'
                                  }`}
                                />
                                {metrics.state}
                              </span>
                            </td>
                          )}
                          {colVis.scheduledBounds && (
                            <>
                              <td className="py-3 px-3 font-mono text-slate-700 whitespace-nowrap tabular-nums">
                                {item.scheduledShiftStart}
                              </td>
                              <td className="py-3 px-3 font-mono text-slate-700 whitespace-nowrap tabular-nums">
                                {item.scheduledShiftEnd}
                              </td>
                            </>
                          )}
                          <td className="py-3 px-3 font-mono text-emerald-700 font-semibold whitespace-nowrap tabular-nums">
                            {item.actualPunchIn}
                          </td>
                          {colVis.earlyArrival && (
                            <td className="py-3 px-3 font-mono whitespace-nowrap tabular-nums">
                              {metrics.earlyArrivalMinutes > 0 ? (
                                <span className="text-sky-700 font-semibold">
                                  {formatDurationClock(metrics.earlyArrivalMinutes)}
                                </span>
                              ) : (
                                <span className="text-slate-400">00:00</span>
                              )}
                            </td>
                          )}
                          <td className="py-3 px-3 font-mono font-semibold whitespace-nowrap tabular-nums">
                            {metrics.isOpen ? (
                              <span className="text-sky-700">In Progress</span>
                            ) : metrics.actualPunchOutIso ? (
                              <span className="text-blue-700">{item.actualPunchOut}</span>
                            ) : (
                              <span className="text-slate-400">N/A</span>
                            )}
                          </td>
                          <td className="py-3 px-3 font-mono whitespace-nowrap tabular-nums">
                            {metrics.isCurrentlyAutoClosed ? (
                              <span className="font-bold text-orange-800">{item.autoCloseTime}</span>
                            ) : (
                              <span className="text-slate-400">N/A</span>
                            )}
                          </td>
                          {colVis.autoCloseRecordedAt && (
                            <td className="py-3 px-3 font-mono text-[11px] whitespace-nowrap tabular-nums">
                              {metrics.isCurrentlyAutoClosed && item.autoCloseRecordedAt !== 'N/A' ? (
                                <span className="text-slate-700">{item.autoCloseRecordedAt}</span>
                              ) : (
                                <span className="text-slate-400">N/A</span>
                              )}
                            </td>
                          )}
                          {colVis.outType && (
                            <td className="py-3 px-3 whitespace-nowrap">
                              <span
                                className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${
                                  metrics.punchOutTypeResolved === 'AUTO'
                                    ? 'bg-orange-50 text-orange-800 border-orange-200'
                                    : metrics.punchOutTypeResolved === 'ACTUAL'
                                      ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                                      : 'bg-slate-100 text-slate-600 border-slate-200'
                                }`}
                              >
                                {metrics.punchOutTypeResolved}
                              </span>
                            </td>
                          )}
                          {colVis.punches && (
                            <td className="py-3 px-3 whitespace-nowrap">
                              <button
                                type="button"
                                onClick={() => setViewingPunchesRecord(rec)}
                                className="bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 px-2 py-1 rounded text-[11px] font-bold flex items-center gap-1 transition cursor-pointer"
                                title="View all punch events"
                              >
                                <ListOrdered className="w-3 h-3 text-blue-600" />
                                <span>
                                  {punchCount} Event{punchCount !== 1 ? 's' : ''}
                                </span>
                              </button>
                            </td>
                          )}
                          <td className="py-3 px-3 whitespace-nowrap">
                            <div className="flex flex-col items-start gap-0.5">
                              <span
                                className={`px-2 py-0.5 rounded text-[10px] font-bold ${getAttendanceStatusBadgeClasses(
                                  metrics.status
                                )}`}
                              >
                                {metrics.status}
                              </span>
                              {metrics.isLate && (
                                <span className="text-[9px] font-semibold text-amber-700">
                                  Late Arrival
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="py-3 px-3 font-mono font-bold text-slate-900 whitespace-nowrap tabular-nums">
                            {metrics.isOpen ? (
                              <div>
                                <span className="text-slate-400 block">00:00</span>
                                <span className="text-[10px] font-semibold text-sky-700 block">
                                  Elapsed: {formatDurationClock(metrics.accumulatedDutyMinutes)}
                                </span>
                              </div>
                            ) : (
                              item.dutyHours
                            )}
                          </td>
                          {colVis.otBreakdown && (
                            <>
                              <td className="py-3 px-3 font-mono text-emerald-700 whitespace-nowrap tabular-nums">
                                {formatDurationClock(metrics.earlyOtMinutes)}
                              </td>
                              <td className="py-3 px-3 font-mono text-indigo-700 whitespace-nowrap tabular-nums">
                                {formatDurationClock(metrics.postShiftOtMinutes)}
                              </td>
                            </>
                          )}
                          <td className="py-3 px-3 font-mono font-bold whitespace-nowrap tabular-nums">
                            {!metrics.isOpen && metrics.overtimeMinutes > 0 ? (
                              <span className="text-indigo-700 bg-indigo-50 border border-indigo-200 px-1.5 py-0.5 rounded">
                                {item.otHours}
                              </span>
                            ) : (
                              <span className="text-slate-400">00:00</span>
                            )}
                          </td>
                          <td className="py-3 px-3 font-mono font-bold text-slate-900 whitespace-nowrap tabular-nums">
                            {item.totalWorkingHours}
                          </td>
                          <td className="py-3 px-3 text-right whitespace-nowrap">
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                type="button"
                                onClick={() => handleJumpToEmployeeCalendar(item.employeeId)}
                                className="p-1.5 rounded hover:bg-blue-50 text-blue-600 border border-blue-200 cursor-pointer"
                                title="Open Employee Monthly Calendar"
                              >
                                <CalendarDays className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setViewingPunchesRecord(rec)}
                                className="p-1.5 rounded hover:bg-slate-100 text-slate-700 border border-slate-200 cursor-pointer"
                                title="View Detailed Punch Timeline"
                              >
                                <ListOrdered className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleOpenCorrection(rec)}
                                className="p-1.5 rounded hover:bg-slate-100 text-slate-700 border border-slate-200 cursor-pointer"
                                title="Supervisor Attendance Correction"
                              >
                                <Edit3 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {dailyTotal > 0 && (
              <div className="px-4 py-3 border-t border-slate-200 bg-slate-50/70 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
                <div className="tabular-nums">
                  Showing{' '}
                  <span className="font-semibold text-slate-800">
                    {(page - 1) * pageSize + 1}
                  </span>
                  –
                  <span className="font-semibold text-slate-800">
                    {Math.min(page * pageSize, dailyTotal)}
                  </span>{' '}
                  of <span className="font-semibold text-slate-800">{dailyTotal}</span> attendance
                  records
                </div>
                <div className="flex items-center gap-2">
                  <select
                    value={pageSize}
                    onChange={(e) => {
                      setPageSize(Number(e.target.value));
                      setPage(1);
                    }}
                    aria-label="History rows per page"
                    className="bg-white border border-slate-300 rounded px-2 py-1 text-xs"
                  >
                    <option value={25}>25 / page</option>
                    <option value={50}>50 / page</option>
                    <option value={100}>100 / page</option>
                  </select>
                  <button
                    type="button"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="px-2.5 py-1 rounded border border-slate-300 bg-white hover:bg-slate-100 disabled:opacity-40 cursor-pointer"
                  >
                    Prev
                  </button>
                  <span className="font-mono text-[11px] tabular-nums">
                    {page} / {dailyTotalPages}
                  </span>
                  <button
                    type="button"
                    disabled={page >= dailyTotalPages}
                    onClick={() => setPage((p) => Math.min(dailyTotalPages, p + 1))}
                    className="px-2.5 py-1 rounded border border-slate-300 bg-white hover:bg-slate-100 disabled:opacity-40 cursor-pointer"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* TAB 4: ABSENT MANPOWER                                               */}
      {/* ==================================================================== */}
      {activeTab === 'absent' && (
        <AbsentManpowerPanel
          selectedDate={selectedDate}
          onDateChange={setSelectedDate}
          floors={floors}
          sections={sections}
          departments={departments}
          shifts={shifts}
          onOpenFullCalendar={handleJumpToEmployeeCalendar}
          refreshSignal={refreshSignal}
        />
      )}

      {/* ==================================================================== */}
      {/* SUPERVISOR ATTENDANCE CORRECTION MODAL (PRESERVED)                   */}
      {/* ==================================================================== */}
      {correctingRecord && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-xl max-w-md w-full p-5 shadow-2xl border border-slate-200">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200 mb-4">
              <div>
                <h3 className="font-bold text-slate-900 text-sm">
                  Supervisor Attendance Correction
                </h3>
                <p className="text-xs text-slate-500">
                  {correctingRecord.employeeNameSnapshot} ({correctingRecord.employeeId}) •{' '}
                  {correctingRecord.shiftDate}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setCorrectingRecord(null)}
                className="text-slate-400 hover:text-slate-600 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveCorrection} className="flex flex-col gap-3 text-xs">
              <div className="grid grid-cols-2 gap-3 bg-slate-50 p-2.5 rounded border border-slate-200">
                <div>
                  <span className="text-[10px] text-slate-400 block uppercase">Punch In</span>
                  <span className="font-mono font-bold text-slate-800">
                    {formatTimeDisplay(correctingRecord.punchIn)}
                  </span>
                </div>
                <div>
                  <span className="text-[10px] text-slate-400 block uppercase">
                    Current Out Type
                  </span>
                  <span className="font-semibold text-slate-800">
                    {correctingRecord.punchOutType}
                  </span>
                </div>
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">
                  Corrected Punch Out Time (HH:mm)
                </label>
                <input
                  type="time"
                  required
                  value={correctionOutTime}
                  onChange={(e) => {
                    const nextTime = e.target.value;
                    setCorrectionOutTime(nextTime);
                    if (nextTime && correctingRecord) {
                      const [h, m] = nextTime.split(':').map(Number);
                      const isNightShift =
                        correctingRecord.shiftId === 'NIGHT' ||
                        (correctingRecord.shiftNameSnapshot || '').toUpperCase().includes('NIGHT');
                      const targetDate =
                        isNightShift && h < 12
                          ? getNextDateKey(correctingRecord.shiftDate)
                          : correctingRecord.shiftDate;
                      const previewOutIso = `${targetDate}T${String(h).padStart(2, '0')}:${String(
                        m
                      ).padStart(2, '0')}:00+05:30`;
                      const firstInIso = correctingRecord.firstPunchIn || correctingRecord.punchIn;
                      const bounds = resolveShiftScheduleBounds(
                        correctingRecord.shiftDate,
                        correctingRecord
                      );
                      const evalPreview = evaluateOptionAPunchOut({
                        firstInIso,
                        lastOutIso: previewOutIso,
                        scheduledStartIso:
                          correctingRecord.scheduledPunchInIso || bounds.scheduledStartIso,
                        scheduledEndIso:
                          correctingRecord.scheduledPunchOutIso || bounds.scheduledEndIso,
                        standardDutyMinutes: STANDARD_DUTY_MINUTES,
                      });
                      setCorrectionStatus(evalPreview.attendanceStatus);
                    }
                  }}
                  className="w-full border border-slate-300 rounded px-2.5 py-1.5 font-mono"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">Corrected Status</label>
                <select
                  value={correctionStatus}
                  onChange={(e) => setCorrectionStatus(e.target.value as AttendanceStatus)}
                  className="w-full border border-slate-300 rounded px-2.5 py-1.5"
                >
                  <option value="COMPLETED">COMPLETED (08:30)</option>
                  <option value="COMPLETED + OT">COMPLETED + OT (&gt; 08:30)</option>
                  <option value="HALF DAY">HALF DAY (04:30 - 08:29)</option>
                  <option value="SHORT LEAVE">SHORT LEAVE (&lt; 04:30)</option>
                  <option value="MISSED PUNCH OUT">MISSED PUNCH OUT</option>
                  <option value="AUTO CLOSED">AUTO CLOSED</option>
                </select>
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">
                  Reason for Correction{' '}
                  <span className="text-red-500">* (Mandatory for audit trail)</span>
                </label>
                <textarea
                  required
                  rows={2}
                  placeholder="e.g. Employee forgot to scan at shift end; verified with line supervisor."
                  value={correctionReason}
                  onChange={(e) => setCorrectionReason(e.target.value)}
                  className="w-full border border-slate-300 rounded px-2.5 py-1.5"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">Supervisor Name</label>
                <input
                  type="text"
                  required
                  value={adminName}
                  onChange={(e) => setAdminName(e.target.value)}
                  className="w-full border border-slate-300 rounded px-2.5 py-1.5"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100 mt-2">
                <button
                  type="button"
                  onClick={() => setCorrectingRecord(null)}
                  className="bg-slate-100 text-slate-700 px-3 py-1.5 rounded cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingCorrection}
                  className="bg-blue-600 text-white px-4 py-1.5 rounded font-medium disabled:opacity-50 cursor-pointer"
                >
                  {isSubmittingCorrection ? 'Applying...' : 'Save Correction'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* DETAILED PUNCH EVENTS TIMELINE MODAL (PRESERVED)                     */}
      {/* ==================================================================== */}
      {viewingPunchesRecord && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-2xl border border-slate-200 flex flex-col max-h-[90vh]">
            <div className="flex items-start justify-between pb-4 border-b border-slate-200">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-blue-50 border border-blue-200 flex items-center justify-center text-blue-600">
                  <ListOrdered className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-bold text-slate-900 text-base">
                    Punch History &amp; Event Timeline
                  </h3>
                  <p className="text-xs text-slate-500">
                    {viewingPunchesRecord.employeeNameSnapshot} ({viewingPunchesRecord.employeeId})
                    • {viewingPunchesRecord.shiftDate}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setViewingPunchesRecord(null)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {(() => {
              const modalMetrics = resolveAttendanceMetrics(viewingPunchesRecord, nowMs);
              return (
                <div className="mt-4 bg-slate-50 border border-slate-200 rounded-xl p-3.5 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                  <div>
                    <span className="text-[10px] text-slate-400 font-semibold uppercase block">
                      Scheduled Shift Start
                    </span>
                    <span className="font-mono font-bold text-slate-700">
                      {modalMetrics.scheduledStartDisplay}
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-400 font-semibold uppercase block">
                      Scheduled Shift End
                    </span>
                    <span className="font-mono font-bold text-slate-700">
                      {modalMetrics.scheduledEndDisplay}
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-400 font-semibold uppercase block">
                      Actual Punch-In
                    </span>
                    <span className="font-mono font-bold text-emerald-700">
                      {formatTimeDisplay(
                        viewingPunchesRecord.firstPunchIn || viewingPunchesRecord.punchIn
                      )}
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-400 font-semibold uppercase block">
                      Actual Punch-Out
                    </span>
                    <span className="font-mono font-bold text-blue-700">
                      {modalMetrics.actualPunchOutDisplay}
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] text-orange-700 font-semibold uppercase block">
                      Auto-Close Time
                    </span>
                    <span
                      className={`font-mono font-bold ${
                        modalMetrics.isCurrentlyAutoClosed ? 'text-orange-800' : 'text-slate-400'
                      }`}
                    >
                      {modalMetrics.autoCloseTimeDisplay}
                    </span>
                  </div>
                  <div className="col-span-2">
                    <span className="text-[10px] text-orange-700 font-semibold uppercase block">
                      Auto-Close Recorded At
                    </span>
                    <span
                      className={`font-mono text-[11px] font-semibold ${
                        modalMetrics.isCurrentlyAutoClosed &&
                        modalMetrics.autoCloseRecordedAtDisplay !== 'N/A'
                          ? 'text-slate-800'
                          : 'text-slate-400'
                      }`}
                    >
                      {modalMetrics.autoCloseRecordedAtDisplay}
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-400 font-semibold uppercase block">
                      Punch-Out Type
                    </span>
                    <span className="font-mono font-bold text-slate-800">
                      {modalMetrics.punchOutTypeResolved}
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-400 font-semibold uppercase block">
                      Early Arrival
                    </span>
                    <span className="font-mono font-bold text-sky-700">
                      {formatDurationClock(modalMetrics.earlyArrivalMinutes)}
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-400 font-semibold uppercase block">
                      Early OT
                    </span>
                    <span className="font-mono font-bold text-emerald-700">
                      {modalMetrics.isOpen
                        ? modalMetrics.provisionalEarlyOtMinutes > 0
                          ? `${formatDurationClock(modalMetrics.provisionalEarlyOtMinutes)} (Provisional)`
                          : '00:00'
                        : formatDurationClock(modalMetrics.earlyOtMinutes)}
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-400 font-semibold uppercase block">
                      Post-shift OT
                    </span>
                    <span className="font-mono font-bold text-indigo-700">
                      {modalMetrics.isOpen
                        ? '00:00'
                        : formatDurationClock(modalMetrics.postShiftOtMinutes)}
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-400 font-semibold uppercase block">
                      Status
                    </span>
                    <span
                      className={`inline-block mt-0.5 px-2 py-0.5 rounded text-[10px] font-bold ${getAttendanceStatusBadgeClasses(
                        modalMetrics.status
                      )}`}
                    >
                      {modalMetrics.status}
                    </span>
                  </div>
                </div>
              );
            })()}

            <div className="mt-4 flex-1 overflow-y-auto space-y-2.5 pr-1">
              <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">
                All Alternating Punches (
                {viewingPunchesRecord.punches?.length ||
                  (viewingPunchesRecord.actualPunchOut ? 2 : 1)}{' '}
                events)
              </div>

              {viewingPunchesRecord.punches && viewingPunchesRecord.punches.length > 0 ? (
                viewingPunchesRecord.punches.map((p, idx) => (
                  <div
                    key={p.id || idx}
                    className={`p-3 rounded-xl border flex items-center justify-between text-xs transition ${
                      p.eventType === 'IN'
                        ? 'bg-emerald-50/60 border-emerald-200 text-emerald-950'
                        : 'bg-indigo-50/60 border-indigo-200 text-indigo-950'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className={`w-7 h-7 rounded-lg flex items-center justify-center font-bold text-xs ${
                          p.eventType === 'IN'
                            ? 'bg-emerald-600 text-white'
                            : 'bg-indigo-600 text-white'
                        }`}
                      >
                        {idx + 1}
                      </div>
                      <div>
                        <div className="flex items-center gap-1.5 font-bold">
                          {p.eventType === 'IN' ? (
                            <span className="text-emerald-700 flex items-center gap-1">
                              <LogIn className="w-3.5 h-3.5" /> PUNCH IN
                            </span>
                          ) : (
                            <span className="text-indigo-700 flex items-center gap-1">
                              <LogOut className="w-3.5 h-3.5" /> PUNCH OUT
                            </span>
                          )}
                          <span className="text-[10px] text-slate-400 font-normal">
                            ({p.scannerType === 'IN' ? 'Entry Gate' : 'Exit Gate'})
                          </span>
                        </div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          Device: {p.scannerDevice || 'USB Scanner'}
                        </div>
                      </div>
                    </div>

                    <div className="text-right">
                      <div className="font-mono font-bold text-sm text-slate-900">
                        {p.displayTime || formatTimeDisplay(p.timestamp)}
                      </div>
                      <div className="text-[10px] text-slate-400 font-mono">
                        {p.timestamp.substring(11, 19)}
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="space-y-2">
                  <div className="p-3 rounded-xl border bg-emerald-50/60 border-emerald-200 flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-lg bg-emerald-600 text-white flex items-center justify-center font-bold">
                        1
                      </div>
                      <div>
                        <div className="font-bold text-emerald-800 flex items-center gap-1">
                          <LogIn className="w-3.5 h-3.5" /> First Punch In
                        </div>
                        <span className="text-[10px] text-slate-500">Entry Gate</span>
                      </div>
                    </div>
                    <span className="font-mono font-bold text-slate-900">
                      {formatTimeDisplay(viewingPunchesRecord.punchIn)}
                    </span>
                  </div>

                  {viewingPunchesRecord.actualPunchOut && (
                    <div className="p-3 rounded-xl border bg-indigo-50/60 border-indigo-200 flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2.5">
                        <div className="w-7 h-7 rounded-lg bg-indigo-600 text-white flex items-center justify-center font-bold">
                          2
                        </div>
                        <div>
                          <div className="font-bold text-indigo-800 flex items-center gap-1">
                            <LogOut className="w-3.5 h-3.5" /> Final Punch Out
                          </div>
                          <span className="text-[10px] text-slate-500">Exit Gate</span>
                        </div>
                      </div>
                      <span className="font-mono font-bold text-slate-900">
                        {formatTimeDisplay(viewingPunchesRecord.actualPunchOut)}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="pt-4 border-t border-slate-200 mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => setViewingPunchesRecord(null)}
                className="bg-slate-900 hover:bg-slate-800 text-white font-medium text-xs px-4 py-2 rounded-lg transition cursor-pointer"
              >
                Close Timeline
              </button>
            </div>
          </div>
        </div>
      )}

      <CrossPageSelectConfirmModal
        isOpen={bulk.isCrossPageConfirmOpen}
        totalFilteredCount={bulk.totalFilteredCount}
        currentPageCount={bulk.currentPageCount}
        recordLabel="attendance records"
        onConfirm={bulk.confirmSelectAllFiltered}
        onCancel={bulk.cancelSelectAllFiltered}
      />
    </div>
  );
};
