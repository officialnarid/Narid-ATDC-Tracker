import React, { useState, useEffect, useMemo, useRef } from 'react';
import { getSafeErrorText } from '../services/errorHandlingService';
import { 
  FileSpreadsheet, 
  Download, 
  AlertTriangle, 
  RefreshCw,
  RotateCcw,
  ChevronLeft,
  ChevronRight
} from 'lucide-react';
import { AttendanceRecord, Employee, Floor, Section, Department, Shift, UserRoleRecord } from '../types';
import { RolePermissionRecord } from '../services/permissionService';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../firebase';
import { formatDateKey } from '../services/attendanceService';
import { exportTableToExcel, exportTableToCsv } from '../services/exportService';
import { sendServerAuditEvent } from '../services/auditService';
import {
  buildAttendanceReportTable,
  computeAttendanceReportSummary,
  type ReportType,
} from '../utils/attendanceReportBuilder';
import { getAttendanceStatusBadgeClasses } from '../utils/attendanceStatus';
import { TableSkeletonRows } from './Skeletons';
import { recordPerfMetric, subscribeAttendanceCommitted } from '../utils/perfMonitor';
import { useBulkSelection } from '../hooks/useBulkSelection';
import {
  BulkActionBar,
  BulkExecutionSummary,
  BulkProgressState,
  SelectAllCheckbox,
} from './BulkActionBar';
import { CrossPageSelectConfirmModal } from './BulkConfirmModal';
import { exportChunkedToCsv, exportChunkedToExcel } from '../services/bulkActionService';

export type { ReportType };

interface ReportsProps {
  employees: Employee[];
  floors: Floor[];
  sections: Section[];
  departments: Department[];
  shifts: Shift[];
  currentUserRole?: UserRoleRecord | null;
  rolePermissions?: Record<string, RolePermissionRecord>;
}

export const Reports: React.FC<ReportsProps> = ({
  employees,
  floors,
  sections,
  departments,
  shifts,
}) => {
  const [activeReport, setActiveReport] = useState<ReportType>('daily_attendance');
  const [selectedDate, setSelectedDate] = useState<string>(formatDateKey(new Date()));
  const [selectedMonth, setSelectedMonth] = useState<string>(formatDateKey(new Date()).substring(0, 7)); // YYYY-MM

  const [attendanceRecords, setAttendanceRecords] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const fetchCounterRef = useRef(0);
  const bgRefreshTimerRef = useRef<number | null>(null);

  // Fetch relevant records for selected date / month
  useEffect(() => {
    const reqId = ++fetchCounterRef.current;
    const isInitial = !hasLoaded && attendanceRecords.length === 0;
    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();

    const fetchReportData = async () => {
      if (isInitial) setLoading(true);
      else setIsRefreshing(true);
      setFetchError(null);

      try {
        let q;
        if (activeReport === 'monthly_attendance' || activeReport === 'employee_wise') {
          q = query(
            collection(db, 'attendance'),
            where('shiftDate', '>=', `${selectedMonth}-01`),
            where('shiftDate', '<=', `${selectedMonth}-31`)
          );
        } else {
          q = query(
            collection(db, 'attendance'),
            where('shiftDate', '==', selectedDate)
          );
        }

        const snap = await getDocs(q);
        if (reqId !== fetchCounterRef.current) return;
        setAttendanceRecords(snap.docs.map(d => d.data() as AttendanceRecord));
        setHasLoaded(true);
        if (!isInitial) {
          const dur = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt;
          recordPerfMetric('background_refresh_ms', dur);
        }
      } catch (err: any) {
        if (reqId !== fetchCounterRef.current) return;
        console.error('Error fetching report data:', err);
        setFetchError(
          getSafeErrorText(err, { moduleName: 'Reports & Export', dbOperationCategory: 'read' })
        );
      } finally {
        if (reqId === fetchCounterRef.current) {
          setLoading(false);
          setIsRefreshing(false);
        }
      }
    };

    fetchReportData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeReport, selectedDate, selectedMonth, reloadTick]);

  // Scoped background refresh when a punch commits and today/current month is active
  useEffect(() => {
    return subscribeAttendanceCommitted((detail) => {
      const todayKey = formatDateKey(new Date());
      const matchesMonthly =
        (activeReport === 'monthly_attendance' || activeReport === 'employee_wise') &&
        selectedMonth === todayKey.substring(0, 7);
      const matchesDaily =
        activeReport !== 'monthly_attendance' &&
        activeReport !== 'employee_wise' &&
        (selectedDate === todayKey || (detail?.shiftDate && detail.shiftDate === selectedDate));

      if (!matchesMonthly && !matchesDaily) return;
      if (bgRefreshTimerRef.current) window.clearTimeout(bgRefreshTimerRef.current);
      bgRefreshTimerRef.current = window.setTimeout(() => {
        setReloadTick((t) => t + 1);
      }, 400);
    });
  }, [activeReport, selectedDate, selectedMonth]);

  useEffect(() => {
    return () => {
      if (bgRefreshTimerRef.current) window.clearTimeout(bgRefreshTimerRef.current);
    };
  }, []);

  const reportList = [
    { id: 'daily_attendance', name: '1. Daily Attendance Report', desc: 'Complete daily log of all employee punches' },
    { id: 'monthly_attendance', name: '2. Monthly Attendance Report', desc: 'Aggregated monthly attendance summary' },
    { id: 'floor_wise', name: '3. Line-wise Manpower Report', desc: 'Availability breakdown by production line (MI-01, MI-02, FATP-STB, FATP-ITR, SMT-01)' },
    { id: 'section_wise', name: '4. Section-wise Manpower Report', desc: 'MI, SMT, FATP & STORE breakdown' },
    { id: 'dept_wise', name: '5. Department-wise Manpower', desc: 'Production, Quality, PPC, Store breakdown' },
    { id: 'emp_type', name: '6. Employee Type Report', desc: 'Permanent vs Staff vs Offroll statistics' },
    { id: 'shift_wise', name: '7. Shift-wise Attendance Report', desc: 'Day vs Night shift attendance comparison' },
    { id: 'employee_wise', name: '8. Employee-wise Attendance', desc: 'Individual monthly duty card and punch records' },
    { id: 'late_arrival', name: '9. Late Arrival Report', desc: 'Employees marked late past grace window' },
    { id: 'missed_punch_out', name: '10. Missed Punch Out Report', desc: 'Auto-closed attendance records' },
    { id: 'overtime', name: '11. Overtime (OT) Report', desc: 'Finalized Early OT (≥60m), Post-shift OT & Total OT breakdown' },
    { id: 'absent_manpower', name: '12. Absent Manpower Report', desc: 'Scheduled employees with no punches' },
  ] as const;

  // Compute Active Employees
  const activeEmps = useMemo(() => employees.filter(e => e.employeeStatus === 'Active'), [employees]);

  // Transform Data according to active report (shared deterministic builder used by Preview, Excel & CSV)
  const { tableColumns, tableData, fileName, reportTitle, periodLabel, summary } = useMemo(() => {
    return buildAttendanceReportTable(activeReport, {
      attendanceRecords,
      activeEmps,
      floors,
      sections,
      departments,
      selectedDate,
      selectedMonth,
    });
  }, [activeReport, attendanceRecords, activeEmps, floors, sections, departments, selectedDate, selectedMonth]);

  const totalPages = Math.max(1, Math.ceil(tableData.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const paginatedRows = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return tableData.slice(start, start + pageSize);
  }, [tableData, safePage, pageSize]);

  const bulk = useBulkSelection<Record<string, any>>({
    items: tableData,
    paginatedItems: paginatedRows,
    getId: (row) => String(row._rowKey),
    resetKey: activeReport,
  });

  const [bulkProgress, setBulkProgress] = useState<BulkProgressState | null>(null);
  const [bulkSummary, setBulkSummary] = useState<BulkExecutionSummary | null>(null);

  const handleBulkExportSelected = async (format: 'xlsx' | 'csv') => {
    const rows = bulk.selectedItems;
    if (rows.length === 0 || bulkProgress) return;
    setBulkSummary(null);
    setBulkProgress({
      label: format === 'xlsx' ? 'Exporting selected report rows to Excel...' : 'Exporting selected report rows to CSV...',
      completed: 0,
      total: rows.length,
    });
    try {
      const fn = format === 'xlsx' ? exportChunkedToExcel : exportChunkedToCsv;
      const out = await fn(rows, tableColumns, `${fileName}_Selected`, {
        onProgress: (completed, total) =>
          setBulkProgress({
            label: format === 'xlsx' ? 'Exporting selected report rows to Excel...' : 'Exporting selected report rows to CSV...',
            completed,
            total,
          }),
        auditTargetType: 'REPORT',
        auditSource: 'REPORTS_MODULE',
        auditDescription: `Bulk exported ${rows.length} selected rows from "${activeReport}" (${periodLabel}) as ${format.toUpperCase()}.`,
        reportTitle: `${reportTitle} (Selected)`,
        periodLabel,
        sheetName: reportTitle,
        summary: summary ? computeAttendanceReportSummary(rows) : null,
      });
      setBulkSummary({
        type: 'success',
        title: `Exported ${out.rowCount} Selected Rows`,
        message: `Downloaded "${out.fileName}". Selection cleared.`,
        savedCount: out.rowCount,
      });
      bulk.clearSelection();
    } catch (err: any) {
      setBulkSummary({
        type: 'error',
        title: 'Selected Report Export Failed',
        message: getSafeErrorText(err, { moduleName: 'Reports & Export', forcedErrorCode: 'FILE-002' }),
      });
    } finally {
      setBulkProgress(null);
    }
  };

  const handleExportXlsx = async () => {
    await exportTableToExcel(tableData, tableColumns, fileName, {
      reportTitle,
      reportType: activeReport,
      periodLabel,
      sheetName: reportTitle,
      summary,
    });
    sendServerAuditEvent({
      action: 'REPORT_EXPORTED',
      category: 'EXPORT',
      targetType: 'REPORT',
      targetId: activeReport,
      newValue: {
        format: 'xlsx',
        fileName,
        rowCount: tableData.length,
        period: periodLabel,
      },
      actionSource: 'REPORTS_MODULE',
      description: `Exported "${activeReport}" report (${tableData.length} rows) as formatted Excel (.xlsx).`,
    });
  };

  const handleExportCsv = () => {
    exportTableToCsv(tableData, tableColumns, fileName);
    sendServerAuditEvent({
      action: 'REPORT_EXPORTED',
      category: 'EXPORT',
      targetType: 'REPORT',
      targetId: activeReport,
      newValue: {
        format: 'csv',
        fileName,
        rowCount: tableData.length,
        period: periodLabel,
      },
      actionSource: 'REPORTS_MODULE',
      description: `Exported "${activeReport}" report (${tableData.length} rows) as CSV.`,
    });
  };

  const showInitialTableSkeleton = loading && !hasLoaded && attendanceRecords.length === 0 && !fetchError;

  return (
    <div className="p-6 bg-slate-50 min-h-full flex flex-col gap-6">
      {/* Title */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
            <FileSpreadsheet className="w-5 h-5 text-emerald-600" />
            <span>ATTENDANCE REPORTS & EXCEL EXPORT</span>
            {isRefreshing && (
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-600 bg-blue-50 px-2 py-0.5 rounded border border-blue-200">
                <RefreshCw className="w-3 h-3 animate-spin" />
                <span>Refreshing</span>
              </span>
            )}
          </h2>
          <p className="text-xs text-slate-500">
            Generate 12 industrial reports and download formatted Excel (.xlsx) and CSV files
          </p>
        </div>

        {/* Export Buttons */}
        <div className="flex items-center gap-2">
          <button
            onClick={handleExportCsv}
            disabled={tableData.length === 0}
            className="bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium text-xs px-3 py-2 rounded border border-slate-300 flex items-center gap-1.5 transition disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Download CSV</span>
          </button>

          <button
            onClick={handleExportXlsx}
            disabled={tableData.length === 0}
            className="bg-emerald-600 hover:bg-emerald-700 text-white font-medium text-xs px-4 py-2 rounded flex items-center gap-1.5 shadow-sm transition disabled:opacity-50"
          >
            <FileSpreadsheet className="w-4 h-4" />
            <span>Export Excel (.xlsx)</span>
          </button>
        </div>
      </div>

      {fetchError && (
        <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-xl text-xs flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
            <span className="font-medium">{fetchError}</span>
          </div>
          <button
            type="button"
            onClick={() => setReloadTick((t) => t + 1)}
            className="px-3 py-1.5 rounded bg-red-600 hover:bg-red-700 text-white font-semibold flex items-center gap-1 shrink-0"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Retry</span>
          </button>
        </div>
      )}

      {/* Main Layout: Left Menu of 12 Reports, Right Table & Filters */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: 12 Reports Selector */}
        <div className="lg:col-span-4 bg-white rounded-xl border border-slate-200 p-3 shadow-2xs">
          <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider px-2 py-1.5 mb-1">
            Available Reports
          </h3>
          <div className="space-y-1">
            {reportList.map(rep => {
              const isActive = activeReport === rep.id;
              return (
                <button
                  key={rep.id}
                  onClick={() => {
                    setActiveReport(rep.id as ReportType);
                    setPage(1);
                  }}
                  className={`w-full text-left p-2.5 rounded text-xs transition ${
                    isActive 
                      ? 'bg-blue-600 text-white font-semibold shadow-xs' 
                      : 'text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  <div className="font-bold">{rep.name}</div>
                  <div className={`text-[10px] mt-0.5 ${isActive ? 'text-blue-100' : 'text-slate-400'}`}>
                    {rep.desc}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Right: Active Report Preview & Filters */}
        <div className="lg:col-span-8 flex flex-col gap-4">
          {/* Filter Bar */}
          <div className="bg-white p-3 rounded-xl border border-slate-200 shadow-2xs flex flex-wrap items-center gap-3 text-xs">
            {activeReport === 'monthly_attendance' || activeReport === 'employee_wise' ? (
              <div className="flex items-center gap-2">
                <span className="font-semibold text-slate-600">Month:</span>
                <input
                  type="month"
                  value={selectedMonth}
                  onChange={(e) => {
                    setSelectedMonth(e.target.value);
                    setPage(1);
                  }}
                  className="bg-slate-50 border border-slate-300 rounded px-2.5 py-1 text-slate-800 font-medium"
                />
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="font-semibold text-slate-600">Date:</span>
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(e) => {
                    setSelectedDate(e.target.value);
                    setPage(1);
                  }}
                  className="bg-slate-50 border border-slate-300 rounded px-2.5 py-1 text-slate-800 font-medium"
                />
              </div>
            )}

            <button
              type="button"
              onClick={() => setReloadTick((t) => t + 1)}
              disabled={isRefreshing || loading}
              className="bg-slate-100 hover:bg-slate-200 border border-slate-300 text-slate-700 px-2.5 py-1 rounded flex items-center gap-1 font-medium disabled:opacity-50"
              title="Refresh report data"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>

            <div className="ml-auto text-xs text-slate-500 font-medium">
              {showInitialTableSkeleton ? 'Loading records...' : `${tableData.length} Records (Export includes all rows)`}
            </div>
          </div>

          <BulkActionBar
            selectedCount={bulk.selectedCount}
            totalFilteredCount={bulk.totalFilteredCount}
            currentPageCount={bulk.currentPageCount}
            isAllFilteredSelected={bulk.isAllFilteredSelected}
            isPageAllSelected={bulk.isPageAllSelected}
            recordLabel="report rows"
            onSelectAllFiltered={bulk.requestSelectAllFiltered}
            onClearSelection={bulk.clearSelection}
            progress={bulkProgress}
            summary={bulkSummary}
            onDismissSummary={() => setBulkSummary(null)}
            actions={[
              {
                id: 'export_selected_xlsx',
                label: 'Export Selected Excel (.xlsx)',
                icon: <FileSpreadsheet className="w-3.5 h-3.5" />,
                tone: 'emerald',
                onClick: () => handleBulkExportSelected('xlsx'),
              },
              {
                id: 'export_selected_csv',
                label: 'Export Selected CSV',
                icon: <Download className="w-3.5 h-3.5" />,
                tone: 'default',
                onClick: () => handleBulkExportSelected('csv'),
              },
            ]}
          />

          {/* Dynamic Executive Summary Strip (mirrors Excel Export KPI block) */}
          {summary && !showInitialTableSkeleton && (
            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-2.5">
              <div className="bg-white rounded-lg border border-slate-200 px-3 py-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Employees</div>
                <div className="text-lg font-bold text-slate-900 font-mono tabular-nums mt-0.5">{summary.totalEmployees}</div>
              </div>
              <div className="bg-white rounded-lg border border-emerald-200/80 px-3 py-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700">Completed</div>
                <div className="text-lg font-bold text-emerald-700 font-mono tabular-nums mt-0.5">{summary.completedCount}</div>
              </div>
              <div className="bg-white rounded-lg border border-amber-200/80 px-3 py-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-amber-800">Auto-Closed</div>
                <div className="text-lg font-bold text-amber-800 font-mono tabular-nums mt-0.5">{summary.autoClosedCount}</div>
              </div>
              <div className="bg-white rounded-lg border border-yellow-200/80 px-3 py-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-yellow-800">Half Day</div>
                <div className="text-lg font-bold text-yellow-800 font-mono tabular-nums mt-0.5">{summary.halfDayCount}</div>
              </div>
              <div className="bg-white rounded-lg border border-red-200/80 px-3 py-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-red-700">Short Leave</div>
                <div className="text-lg font-bold text-red-700 font-mono tabular-nums mt-0.5">{summary.shortLeaveCount}</div>
              </div>
              <div className="bg-white rounded-lg border border-indigo-200/80 px-3 py-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-indigo-700">Total OT Hours</div>
                <div className="text-lg font-bold text-indigo-800 font-mono tabular-nums mt-0.5">{summary.totalOtHoursFormatted}</div>
              </div>
            </div>
          )}

          {/* Table Preview */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
            <div className="overflow-x-auto max-h-[520px]">
              <table className="w-full text-left text-xs border-collapse">
                <thead className="bg-[#1B365D] text-white uppercase text-[11px] font-semibold tracking-wide sticky top-0 z-10">
                  <tr>
                    <th className="py-3 px-3 w-10 text-center">
                      <SelectAllCheckbox
                        checked={bulk.isPageAllSelected}
                        indeterminate={bulk.isPageIndeterminate}
                        disabled={paginatedRows.length === 0 || Boolean(bulkProgress)}
                        onChange={bulk.togglePageSelection}
                        ariaLabel="Select all report rows on current page"
                      />
                    </th>
                    {tableColumns.map((col, idx) => {
                      const isRight =
                        col.key === 'dutyHours' ||
                        col.key === 'otHours' ||
                        col.key === 'totalWorkingHours';
                      return (
                        <th
                          key={idx}
                          className={`py-3 px-3 whitespace-nowrap ${isRight ? 'text-right' : ''}`}
                        >
                          {col.header}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200/75">
                  {showInitialTableSkeleton ? (
                    <TableSkeletonRows
                      rows={8}
                      cols={Math.max(2, tableColumns.length + 1)}
                      rowHeightClass="py-2.5 px-3"
                    />
                  ) : tableData.length === 0 ? (
                    <tr>
                      <td colSpan={tableColumns.length + 1} className="py-10 text-center text-slate-400">
                        No records found for this report and date.
                      </td>
                    </tr>
                  ) : (
                    paginatedRows.map((row, rowIdx) => {
                      const rowId = String(row._rowKey);
                      const isChecked = bulk.isSelected(rowId);
                      return (
                      <tr
                        key={rowId}
                        className={
                          isChecked
                            ? 'bg-blue-50/70 hover:bg-blue-50'
                            : rowIdx % 2 === 1
                              ? 'bg-slate-50/60 hover:bg-slate-100/70'
                              : 'bg-white hover:bg-slate-50'
                        }
                      >
                        <td className="py-2.5 px-3 text-center">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            disabled={Boolean(bulkProgress)}
                            onChange={() => bulk.toggleOne(rowId)}
                            aria-label={`Select report row ${rowId}`}
                            className="rounded text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer"
                          />
                        </td>
                        {tableColumns.map((col, colIdx) => {
                          const val = (row as Record<string, any>)[col.key];

                          if (col.key === 'status' && val) {
                            return (
                              <td key={colIdx} className="py-2.5 px-3 whitespace-nowrap">
                                <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${getAttendanceStatusBadgeClasses(String(val))}`}>
                                  {val}
                                </span>
                              </td>
                            );
                          }

                          const isHighlightedAutoClose =
                            col.key === 'autoCloseTime' && val && val !== 'N/A';
                          const isDuration =
                            col.key === 'dutyHours' ||
                            col.key === 'otHours' ||
                            col.key === 'totalWorkingHours';
                          const isPositiveOt = col.key === 'otHours' && val && val !== '00:00';
                          const isTimeCol =
                            col.key === 'scheduledStart' ||
                            col.key === 'scheduledEnd' ||
                            col.key === 'inTime' ||
                            col.key === 'actualOutTime' ||
                            col.key === 'autoCloseTime' ||
                            col.key === 'autoCloseRecordedAt' ||
                            col.key === 'date';

                          return (
                            <td
                              key={colIdx}
                              className={`py-2.5 px-3 whitespace-nowrap ${
                                col.key === 'employeeId'
                                  ? 'font-mono font-bold text-slate-900 tabular-nums'
                                  : isHighlightedAutoClose
                                    ? 'font-mono font-bold text-amber-800 tabular-nums'
                                    : isPositiveOt
                                      ? 'font-mono font-bold text-indigo-800 bg-indigo-50/70 text-right tabular-nums'
                                      : col.key === 'totalWorkingHours'
                                        ? 'font-mono font-bold text-slate-900 text-right tabular-nums'
                                        : isDuration
                                          ? 'font-mono font-medium text-slate-800 text-right tabular-nums'
                                          : isTimeCol
                                            ? `font-mono tabular-nums ${val === 'N/A' ? 'text-slate-400' : 'text-slate-700'}`
                                            : 'text-slate-700'
                              }`}
                            >
                              {val}
                            </td>
                          );
                        })}
                      </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {tableData.length > 0 && (
              <div className="px-4 py-3 border-t border-slate-200 bg-slate-50/70 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
                <div className="flex items-center gap-2">
                  <span>
                    Showing{' '}
                    <span className="font-semibold text-slate-800">
                      {(safePage - 1) * pageSize + 1}–{Math.min(safePage * pageSize, tableData.length)}
                    </span>{' '}
                    of <span className="font-semibold text-slate-800">{tableData.length}</span> rows
                  </span>
                  <select
                    value={pageSize}
                    onChange={(e) => {
                      setPageSize(Number(e.target.value));
                      setPage(1);
                    }}
                    className="bg-white border border-slate-300 rounded px-2 py-1 text-slate-700"
                    aria-label="Report preview rows per page"
                  >
                    <option value={25}>25 / page</option>
                    <option value={50}>50 / page</option>
                    <option value={100}>100 / page</option>
                  </select>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setPage(Math.max(1, safePage - 1))}
                    disabled={safePage <= 1}
                    className="px-2.5 py-1 rounded border border-slate-300 bg-white hover:bg-slate-100 disabled:opacity-40 flex items-center gap-1"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                    <span>Prev</span>
                  </button>
                  <span className="px-2 font-mono text-[11px] text-slate-700">
                    Page {safePage} / {totalPages}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPage(Math.min(totalPages, safePage + 1))}
                    disabled={safePage >= totalPages}
                    className="px-2.5 py-1 rounded border border-slate-300 bg-white hover:bg-slate-100 disabled:opacity-40 flex items-center gap-1"
                  >
                    <span>Next</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <CrossPageSelectConfirmModal
        isOpen={bulk.isCrossPageConfirmOpen}
        totalFilteredCount={bulk.totalFilteredCount}
        currentPageCount={bulk.currentPageCount}
        recordLabel="report rows"
        onConfirm={bulk.confirmSelectAllFiltered}
        onCancel={bulk.cancelSelectAllFiltered}
      />
    </div>
  );
};
