import React, { useState, useEffect, useMemo, useRef } from 'react';
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
import { formatDateKey, formatMinutes, formatTimeDisplay } from '../services/attendanceService';
import { exportTableToExcel, exportTableToCsv } from '../services/exportService';
import { sendServerAuditEvent } from '../services/auditService';
import { formatDurationClock, resolveAttendanceMetrics } from '../utils/attendanceStatus';
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

interface ReportsProps {
  employees: Employee[];
  floors: Floor[];
  sections: Section[];
  departments: Department[];
  shifts: Shift[];
  currentUserRole?: UserRoleRecord | null;
  rolePermissions?: Record<string, RolePermissionRecord>;
}

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
        setFetchError(err?.message || 'Unable to load report records. Please retry.');
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

  // Transform Data according to active report
  const { tableColumns, tableData, fileName } = useMemo(() => {
    let cols: { header: string; key: string }[] = [];
    let rows: Record<string, any>[] = [];
    let name = `${activeReport}_${selectedDate}`;

    switch (activeReport) {
      case 'daily_attendance':
        cols = [
          { header: 'Employee ID', key: 'employeeId' },
          { header: 'Name', key: 'name' },
          { header: 'Line', key: 'floor' },
          { header: 'Section', key: 'section' },
          { header: 'Department', key: 'dept' },
          { header: 'Shift', key: 'shift' },
          { header: 'State', key: 'state' },
          { header: 'Scheduled Shift Start', key: 'scheduledStart' },
          { header: 'Actual Punch In', key: 'inTime' },
          { header: 'Early Arrival Duration', key: 'earlyArrival' },
          { header: 'Last Out', key: 'outTime' },
          { header: 'Punches', key: 'punches' },
          { header: 'Out Type', key: 'outType' },
          { header: 'Duty Hours', key: 'duty' },
          { header: 'Early OT', key: 'earlyOt' },
          { header: 'Post-shift OT', key: 'postShiftOt' },
          { header: 'Total OT', key: 'ot' },
          { header: 'Status', key: 'status' },
        ];
        rows = attendanceRecords.map(a => {
          const m = resolveAttendanceMetrics(a);
          return {
            employeeId: a.employeeId,
            name: a.employeeNameSnapshot,
            floor: a.floorIdSnapshot,
            section: a.sectionIdSnapshot,
            dept: a.departmentIdSnapshot,
            shift: a.shiftNameSnapshot,
            state: m.state,
            scheduledStart: m.scheduledStartDisplay,
            inTime: formatTimeDisplay(a.firstPunchIn || a.punchIn),
            earlyArrival: formatDurationClock(m.earlyArrivalMinutes),
            outTime: m.isOpen ? 'In Progress' : formatTimeDisplay(a.lastPunchOut || a.actualPunchOut || a.effectivePunchOut),
            punches: a.punches?.length || (a.actualPunchOut ? 2 : 1),
            outType: a.punchOutType,
            duty: m.isOpen
              ? `00:00 Hours (Elapsed: ${formatDurationClock(m.accumulatedDutyMinutes)})`
              : `${formatDurationClock(m.completedDutyMinutes)} Hours`,
            earlyOt: m.isOpen
              ? (m.provisionalEarlyOtMinutes > 0 ? `${formatDurationClock(m.provisionalEarlyOtMinutes)} (Provisional)` : '00:00')
              : formatDurationClock(m.earlyOtMinutes),
            postShiftOt: m.isOpen ? '00:00' : formatDurationClock(m.postShiftOtMinutes),
            ot: !m.isOpen && m.overtimeMinutes > 0 ? m.otLabel : '00:00',
            status: m.status,
          };
        });
        break;

      case 'floor_wise':
        cols = [
          { header: 'Production Line', key: 'floor' },
          { header: 'Active Employees', key: 'active' },
          { header: 'Present', key: 'present' },
          { header: 'Absent', key: 'absent' },
          { header: 'Availability %', key: 'percent' },
        ];
        rows = floors.map(fl => {
          const total = activeEmps.filter(e => e.floor === fl.name).length;
          const present = attendanceRecords.filter(a => a.floorIdSnapshot === fl.name).length;
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
        rows = sections.map(sec => {
          const total = activeEmps.filter(e => e.section === sec.name).length;
          const present = attendanceRecords.filter(a => a.sectionIdSnapshot === sec.name).length;
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
        rows = departments.map(d => {
          const total = activeEmps.filter(e => e.department === d.name).length;
          const present = attendanceRecords.filter(a => a.departmentIdSnapshot === d.name).length;
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
        rows = ['Permanent', 'Staff', 'Offroll'].map(type => {
          const total = activeEmps.filter(e => e.employeeType === type).length;
          const present = attendanceRecords.filter(a => a.employeeTypeSnapshot === type).length;
          const absent = Math.max(0, total - present);
          const percent = total > 0 ? `${Math.round((present / total) * 100)}%` : '0%';
          return { type, active: total, present, absent, percent };
        });
        break;

      case 'late_arrival':
        cols = [
          { header: 'Employee ID', key: 'employeeId' },
          { header: 'Name', key: 'name' },
          { header: 'Line', key: 'floor' },
          { header: 'Department', key: 'dept' },
          { header: 'Shift', key: 'shift' },
          { header: 'Punch In Time', key: 'inTime' },
          { header: 'Status', key: 'status' },
        ];
        rows = attendanceRecords
          .filter(a => resolveAttendanceMetrics(a).isLate)
          .map(a => ({
            employeeId: a.employeeId,
            name: a.employeeNameSnapshot,
            floor: a.floorIdSnapshot,
            dept: a.departmentIdSnapshot,
            shift: a.shiftNameSnapshot,
            inTime: formatTimeDisplay(a.punchIn),
            status: 'LATE ARRIVAL',
          }));
        break;

      case 'missed_punch_out':
        cols = [
          { header: 'Employee ID', key: 'employeeId' },
          { header: 'Name', key: 'name' },
          { header: 'Line', key: 'floor' },
          { header: 'Shift', key: 'shift' },
          { header: 'Punch In', key: 'inTime' },
          { header: 'Auto-Close Time', key: 'autoOut' },
          { header: 'Punch Out Type', key: 'outType' },
          { header: 'OT Allocated', key: 'ot' },
          { header: 'Status', key: 'status' },
        ];
        rows = attendanceRecords
          .filter(a => a.punchOutType === 'AUTO')
          .map(a => ({
            employeeId: a.employeeId,
            name: a.employeeNameSnapshot,
            floor: a.floorIdSnapshot,
            shift: a.shiftNameSnapshot,
            inTime: formatTimeDisplay(a.punchIn),
            autoOut: formatTimeDisplay(a.effectivePunchOut),
            outType: 'AUTO',
            ot: '00:00 (Zero)',
            status: 'MISSED PUNCH OUT',
          }));
        break;

      case 'overtime':
        cols = [
          { header: 'Employee ID', key: 'employeeId' },
          { header: 'Name', key: 'name' },
          { header: 'Line / Dept', key: 'floorDept' },
          { header: 'Shift', key: 'shift' },
          { header: 'Scheduled Shift Start', key: 'scheduledStart' },
          { header: 'Actual Punch In', key: 'inTime' },
          { header: 'Punch Out', key: 'outTime' },
          { header: 'Early Arrival Duration', key: 'earlyArrival' },
          { header: 'Regular Duty', key: 'duty' },
          { header: 'Early OT', key: 'earlyOt' },
          { header: 'Post-shift OT', key: 'postShiftOt' },
          { header: 'Total OT', key: 'ot' },
        ];
        rows = attendanceRecords
          .filter(a => {
            const m = resolveAttendanceMetrics(a);
            return !m.isOpen && m.overtimeMinutes > 0;
          })
          .map(a => {
            const m = resolveAttendanceMetrics(a);
            return {
              employeeId: a.employeeId,
              name: a.employeeNameSnapshot,
              floorDept: `${a.floorIdSnapshot} • ${a.departmentIdSnapshot}`,
              shift: a.shiftNameSnapshot,
              scheduledStart: m.scheduledStartDisplay,
              inTime: formatTimeDisplay(a.firstPunchIn || a.punchIn),
              outTime: formatTimeDisplay(a.lastPunchOut || a.actualPunchOut),
              earlyArrival: formatDurationClock(m.earlyArrivalMinutes),
              duty: formatMinutes(m.regularDutyMinutes),
              earlyOt: formatDurationClock(m.earlyOtMinutes),
              postShiftOt: formatDurationClock(m.postShiftOtMinutes),
              ot: m.otLabel,
            };
          });
        break;

      case 'absent_manpower':
        cols = [
          { header: 'Employee ID', key: 'employeeId' },
          { header: 'Name', key: 'name' },
          { header: 'Line', key: 'floor' },
          { header: 'Section', key: 'section' },
          { header: 'Department', key: 'dept' },
          { header: 'Type', key: 'type' },
          { header: 'Status', key: 'status' },
        ];
        const clockedIds = new Set(attendanceRecords.map(a => a.employeeId));
        rows = activeEmps
          .filter(e => !clockedIds.has(e.employeeId))
          .map(e => ({
            employeeId: e.employeeId,
            name: e.employeeName,
            floor: e.floor,
            section: e.section,
            dept: e.department,
            type: e.employeeType,
            status: 'ABSENT (No Punch)',
          }));
        break;

      default:
        // Monthly / Shift-wise / Employee-wise breakdown
        cols = [
          { header: 'Employee ID', key: 'employeeId' },
          { header: 'Name', key: 'name' },
          { header: 'Date', key: 'date' },
          { header: 'Shift', key: 'shift' },
          { header: 'Scheduled Shift Start', key: 'scheduledStart' },
          { header: 'Actual Punch In', key: 'inTime' },
          { header: 'Early Arrival Duration', key: 'earlyArrival' },
          { header: 'Duty', key: 'duty' },
          { header: 'Early OT', key: 'earlyOt' },
          { header: 'Post-shift OT', key: 'postShiftOt' },
          { header: 'Total OT', key: 'ot' },
        ];
        rows = attendanceRecords.map(a => {
          const m = resolveAttendanceMetrics(a);
          return {
            employeeId: a.employeeId,
            name: a.employeeNameSnapshot,
            date: a.shiftDate,
            shift: a.shiftNameSnapshot,
            scheduledStart: m.scheduledStartDisplay,
            inTime: formatTimeDisplay(a.firstPunchIn || a.punchIn),
            earlyArrival: formatDurationClock(m.earlyArrivalMinutes),
            duty: m.isOpen ? '00:00 Hours' : `${formatDurationClock(m.completedDutyMinutes)} Hours`,
            earlyOt: m.isOpen
              ? (m.provisionalEarlyOtMinutes > 0 ? `${formatDurationClock(m.provisionalEarlyOtMinutes)} (Provisional)` : '00:00')
              : formatDurationClock(m.earlyOtMinutes),
            postShiftOt: m.isOpen ? '00:00' : formatDurationClock(m.postShiftOtMinutes),
            ot: !m.isOpen && m.overtimeMinutes > 0 ? m.otLabel : '00:00',
          };
        });
    }

    const keyedRows = rows.map((row, idx) => ({
      ...row,
      _rowKey: `${activeReport}:${row.employeeId || row.floor || row.section || row.department || row.type || 'row'}:${row.date || idx}:${idx}`,
    }));

    return { tableColumns: cols, tableData: keyedRows, fileName: name };
  }, [activeReport, attendanceRecords, activeEmps, floors, sections, departments, selectedDate]);

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
      const period = activeReport === 'monthly_attendance' || activeReport === 'employee_wise' ? selectedMonth : selectedDate;
      const out = await fn(rows, tableColumns, `${fileName}_selected`, {
        onProgress: (completed, total) =>
          setBulkProgress({
            label: format === 'xlsx' ? 'Exporting selected report rows to Excel...' : 'Exporting selected report rows to CSV...',
            completed,
            total,
          }),
        auditTargetType: 'REPORT',
        auditSource: 'REPORTS_MODULE',
        auditDescription: `Bulk exported ${rows.length} selected rows from "${activeReport}" (${period}) as ${format.toUpperCase()}.`,
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
        message: err?.message || 'Unable to export selected rows.',
      });
    } finally {
      setBulkProgress(null);
    }
  };

  const handleExportXlsx = () => {
    exportTableToExcel(tableData, tableColumns, fileName);
    sendServerAuditEvent({
      action: 'REPORT_EXPORTED',
      category: 'EXPORT',
      targetType: 'REPORT',
      targetId: activeReport,
      newValue: {
        format: 'xlsx',
        fileName,
        rowCount: tableData.length,
        period: activeReport === 'monthly_attendance' || activeReport === 'employee_wise' ? selectedMonth : selectedDate,
      },
      actionSource: 'REPORTS_MODULE',
      description: `Exported "${activeReport}" report (${tableData.length} rows) as Excel (.xlsx).`,
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
        period: activeReport === 'monthly_attendance' || activeReport === 'employee_wise' ? selectedMonth : selectedDate,
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

          {/* Table Preview */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
            <div className="overflow-x-auto max-h-[500px]">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-600 uppercase font-semibold border-b border-slate-200 sticky top-0">
                  <tr>
                    <th className="py-2.5 px-3 w-10 text-center">
                      <SelectAllCheckbox
                        checked={bulk.isPageAllSelected}
                        indeterminate={bulk.isPageIndeterminate}
                        disabled={paginatedRows.length === 0 || Boolean(bulkProgress)}
                        onChange={bulk.togglePageSelection}
                        ariaLabel="Select all report rows on current page"
                      />
                    </th>
                    {tableColumns.map((col, idx) => (
                      <th key={idx} className="py-2.5 px-3">
                        {col.header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {showInitialTableSkeleton ? (
                    <TableSkeletonRows
                      rows={8}
                      cols={Math.max(2, tableColumns.length + 1)}
                      rowHeightClass="py-2 px-3"
                    />
                  ) : tableData.length === 0 ? (
                    <tr>
                      <td colSpan={tableColumns.length + 1} className="py-8 text-center text-slate-400">
                        No records found for this report and date.
                      </td>
                    </tr>
                  ) : (
                    paginatedRows.map((row) => {
                      const rowId = String(row._rowKey);
                      const isChecked = bulk.isSelected(rowId);
                      return (
                      <tr key={rowId} className={isChecked ? 'bg-blue-50/60 hover:bg-blue-50/90' : 'hover:bg-slate-50'}>
                        <td className="py-2 px-3 text-center">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            disabled={Boolean(bulkProgress)}
                            onChange={() => bulk.toggleOne(rowId)}
                            aria-label={`Select report row ${rowId}`}
                            className="rounded text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer"
                          />
                        </td>
                        {tableColumns.map((col, colIdx) => (
                          <td key={colIdx} className="py-2 px-3 text-slate-700">
                            {(row as Record<string, any>)[col.key]}
                          </td>
                        ))}
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
