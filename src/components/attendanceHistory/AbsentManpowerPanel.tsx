import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Calendar,
  Download,
  FileSpreadsheet,
  RotateCcw,
  Search,
  UserX,
  X,
} from 'lucide-react';
import type { Department, Floor, Section, Shift } from '../../types';
import {
  type AbsentManpowerResponse,
  type AbsentManpowerRow,
  type EmployeeCalendarResponse,
  fetchAbsentManpower,
  fetchEmployeeMonthlyCalendar,
} from '../../services/attendanceHistoryService';
import { getSafeErrorText } from '../../services/errorHandlingService';
import { exportTableToCsv, exportTableToExcel } from '../../services/exportService';
import {
  ABSENT_MANPOWER_12_COLUMNS,
  buildAbsentManpowerExportRows,
} from '../../utils/attendanceHistoryExportBuilder';
import { EmployeeMonthlyCalendar } from './EmployeeMonthlyCalendar';
import { TableSkeletonRows } from '../Skeletons';

interface AbsentManpowerPanelProps {
  selectedDate: string;
  onDateChange: (date: string) => void;
  floors: Floor[];
  sections: Section[];
  departments: Department[];
  shifts: Shift[];
  onOpenFullCalendar?: (employeeId: string) => void;
  refreshSignal?: number;
}

const CONSECUTIVE_PRESETS: Array<{ label: string; min: number; countKey: keyof AbsentManpowerResponse['presetCounts'] }> = [
  { label: 'Absent Today', min: 1, countKey: 'absentToday' },
  { label: '2+ Working Days', min: 2, countKey: 'consecutive2Plus' },
  { label: '3+ Working Days', min: 3, countKey: 'consecutive3Plus' },
  { label: '5+ Working Days', min: 5, countKey: 'consecutive5Plus' },
  { label: '7+ Working Days', min: 7, countKey: 'consecutive7Plus' },
  { label: '10+ Working Days', min: 10, countKey: 'consecutive10Plus' },
];

export const AbsentManpowerPanel: React.FC<AbsentManpowerPanelProps> = ({
  selectedDate,
  onDateChange,
  floors,
  sections,
  departments,
  shifts,
  onOpenFullCalendar,
  refreshSignal = 0,
}) => {
  const [search, setSearch] = useState('');
  const [filterLine, setFilterLine] = useState('ALL');
  const [filterSection, setFilterSection] = useState('ALL');
  const [filterDept, setFilterDept] = useState('ALL');
  const [filterType, setFilterType] = useState('ALL');
  const [filterShift, setFilterShift] = useState('ALL');
  const [minConsecutive, setMinConsecutive] = useState<number>(1);
  const [sortBy, setSortBy] = useState<
    'consecutive_desc' | 'recent_absence' | 'department_asc' | 'line_asc' | 'name_asc'
  >('consecutive_desc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [data, setData] = useState<AbsentManpowerResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  // Absent Manpower Detail View Modal
  const [selectedAbsentee, setSelectedAbsentee] = useState<AbsentManpowerRow | null>(null);
  const [detailCalendar, setDetailCalendar] = useState<EmployeeCalendarResponse | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const loadAbsentManpower = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchAbsentManpower({
        date: selectedDate,
        search: search.trim(),
        line: filterLine,
        section: filterSection,
        department: filterDept,
        employeeType: filterType,
        shift: filterShift,
        minConsecutive,
        sortBy,
        page,
        pageSize,
      });
      setData(res);
    } catch (err: any) {
      setError(
        getSafeErrorText(err, {
          moduleName: 'Absent Manpower',
          endpoint: '/api/attendance-history/absent-manpower',
        })
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      loadAbsentManpower();
    }, 150);
    return () => window.clearTimeout(timer);
  }, [
    selectedDate,
    search,
    filterLine,
    filterSection,
    filterDept,
    filterType,
    filterShift,
    minConsecutive,
    sortBy,
    page,
    pageSize,
    refreshSignal,
  ]);

  const handleOpenDetail = async (row: AbsentManpowerRow) => {
    setSelectedAbsentee(row);
    setDetailCalendar(null);
    setLoadingDetail(true);
    try {
      const [y, m] = selectedDate.split('-').map(Number);
      const res = await fetchEmployeeMonthlyCalendar(row.employeeId, y, m);
      setDetailCalendar(res);
    } catch {
      setDetailCalendar(null);
    } finally {
      setLoadingDetail(false);
    }
  };

  const handleExport = async (format: 'xlsx' | 'csv') => {
    setExporting(true);
    try {
      // Fetch full filtered list (up to 200 per page) for export
      const fullRes = await fetchAbsentManpower({
        date: selectedDate,
        search: search.trim(),
        line: filterLine,
        section: filterSection,
        department: filterDept,
        employeeType: filterType,
        shift: filterShift,
        minConsecutive,
        sortBy,
        page: 1,
        pageSize: 200,
      });
      const rows = buildAbsentManpowerExportRows(fullRes.records || []);
      const fileName = `NARID_Absent_Manpower_${selectedDate}${
        minConsecutive > 1 ? `_${minConsecutive}PlusDays` : ''
      }`;
      if (format === 'xlsx') {
        await exportTableToExcel(rows, ABSENT_MANPOWER_12_COLUMNS, fileName, {
          reportTitle: `Absent Manpower Report${
            minConsecutive > 1 ? ` (${minConsecutive}+ Consecutive Working Days)` : ''
          }`,
          periodLabel: selectedDate,
          sheetName: 'Absent Manpower',
          summary: null,
        });
      } else {
        exportTableToCsv(rows, ABSENT_MANPOWER_12_COLUMNS, fileName);
      }
    } finally {
      setExporting(false);
    }
  };

  const records = data?.records || [];
  const presetCounts = data?.presetCounts || {
    absentToday: 0,
    consecutive2Plus: 0,
    consecutive3Plus: 0,
    consecutive5Plus: 0,
    consecutive7Plus: 0,
    consecutive10Plus: 0,
  };

  const [detailYear, detailMonth] = selectedDate.split('-').map(Number);

  return (
    <div className="flex flex-col gap-4">
      {/* Quick Consecutive Absence Presets */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
              <UserX className="w-4 h-4 text-red-600" />
              <span>Absent Manpower &amp; Continuous Absence Tracking</span>
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Schedule-validated absences only. Weekly offs, declared holidays, approved leave, and pre-joining dates are excluded from consecutive working day counts.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => handleExport('csv')}
              disabled={records.length === 0 || exporting}
              className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <Download className="w-3.5 h-3.5" />
              <span>CSV</span>
            </button>
            <button
              type="button"
              onClick={() => handleExport('xlsx')}
              disabled={records.length === 0 || exporting}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <FileSpreadsheet className="w-3.5 h-3.5" />
              <span>Export Absent List</span>
            </button>
          </div>
        </div>

        {/* Preset Filter Buttons */}
        <div className="flex flex-wrap items-center gap-2">
          {CONSECUTIVE_PRESETS.map((preset) => {
            const active = minConsecutive === preset.min;
            const count = presetCounts[preset.countKey];
            return (
              <button
                key={preset.min}
                type="button"
                onClick={() => {
                  setMinConsecutive(preset.min);
                  setPage(1);
                }}
                className={`px-3 py-1.5 rounded-lg border text-xs font-semibold flex items-center gap-2 transition cursor-pointer ${
                  active
                    ? 'bg-red-600 text-white border-red-600'
                    : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                }`}
              >
                <span>{preset.label}</span>
                <span
                  className={`px-1.5 py-0.5 rounded text-[10px] font-bold tabular-nums ${
                    active ? 'bg-red-700 text-white' : 'bg-white text-slate-700 border border-slate-200'
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {/* Filter Toolbar */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8 gap-2.5 pt-2 border-t border-slate-100 text-xs">
          <div className="flex items-center gap-1.5 bg-slate-50 border border-slate-300 rounded-lg px-2.5 py-1.5">
            <Calendar className="w-3.5 h-3.5 text-slate-500 shrink-0" />
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => {
                if (e.target.value) {
                  onDateChange(e.target.value);
                  setPage(1);
                }
              }}
              aria-label="Absent manpower reference date"
              className="w-full bg-transparent text-xs font-semibold text-slate-800 focus:outline-hidden"
            />
          </div>

          <div className="flex items-center gap-1.5 bg-slate-50 border border-slate-300 rounded-lg px-2.5 py-1.5 xl:col-span-2">
            <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <input
              type="text"
              placeholder="Search ID, Name, Line, Dept..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="w-full bg-transparent text-slate-800 focus:outline-hidden"
            />
          </div>

          <select
            value={filterLine}
            onChange={(e) => {
              setFilterLine(e.target.value);
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

          <select
            value={filterSection}
            onChange={(e) => {
              setFilterSection(e.target.value);
              setPage(1);
            }}
            className="bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-slate-700"
          >
            <option value="ALL">All Sections</option>
            {sections.map((s) => (
              <option key={s.id} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>

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

          <select
            value={filterType}
            onChange={(e) => {
              setFilterType(e.target.value);
              setPage(1);
            }}
            className="bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-slate-700"
          >
            <option value="ALL">All Emp Types</option>
            <option value="Permanent">Permanent</option>
            <option value="Staff">Staff</option>
            <option value="Offroll">Offroll</option>
          </select>

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
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-slate-500 font-medium">Sort by:</span>
            <select
              value={sortBy}
              onChange={(e) => {
                setSortBy(e.target.value as any);
                setPage(1);
              }}
              aria-label="Sort absent manpower"
              className="bg-white border border-slate-300 rounded-lg px-2.5 py-1 text-slate-800 font-semibold"
            >
              <option value="consecutive_desc">Highest Consecutive Absence First</option>
              <option value="recent_absence">Most Recent Absence</option>
              <option value="department_asc">Department (A–Z)</option>
              <option value="line_asc">Line (A–Z)</option>
              <option value="name_asc">Employee Name (A–Z)</option>
            </select>
          </div>
          <span className="text-slate-500 tabular-nums">
            Showing <strong className="text-slate-800">{records.length}</strong> of{' '}
            <strong className="text-slate-800">{data?.total ?? 0}</strong> verified absent employees
          </span>
        </div>
      </div>

      {/* Error State */}
      {error && (
        <div
          role="alert"
          className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-xs text-red-800 flex items-center justify-between gap-3"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
            <span>{error}</span>
          </div>
          <button
            type="button"
            onClick={loadAbsentManpower}
            className="px-3 py-1 rounded bg-white border border-red-300 text-red-700 font-semibold hover:bg-red-100 cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}

      {/* Exact 12-Column Absent Manpower Table */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-600 uppercase font-semibold border-b border-slate-200 text-[11px]">
              <tr>
                <th className="py-3 px-3.5 whitespace-nowrap">Employee ID</th>
                <th className="py-3 px-3.5 whitespace-nowrap">Employee Name</th>
                <th className="py-3 px-3.5 whitespace-nowrap">Line</th>
                <th className="py-3 px-3.5 whitespace-nowrap">Section</th>
                <th className="py-3 px-3.5 whitespace-nowrap">Department</th>
                <th className="py-3 px-3.5 whitespace-nowrap">Employee Type</th>
                <th className="py-3 px-3.5 whitespace-nowrap">Last Present Date</th>
                <th className="py-3 px-3.5 whitespace-nowrap">First Date of Current Absence</th>
                <th className="py-3 px-3.5 whitespace-nowrap text-right">Consecutive Absent Working Days</th>
                <th className="py-3 px-3.5 whitespace-nowrap text-right">Total Absent Working Days in Selected Month</th>
                <th className="py-3 px-3.5 whitespace-nowrap">Current Shift</th>
                <th className="py-3 px-3.5 whitespace-nowrap">Attendance Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <TableSkeletonRows rows={6} cols={12} />
              ) : records.length === 0 ? (
                <tr>
                  <td colSpan={12} className="py-10 text-center text-slate-400">
                    No absent employees matched the selected filters for {selectedDate}.
                  </td>
                </tr>
              ) : (
                records.map((row) => (
                  <tr
                    key={row.employeeId}
                    onClick={() => handleOpenDetail(row)}
                    className="hover:bg-red-50/40 transition cursor-pointer"
                  >
                    <td className="py-3 px-3.5 font-mono font-bold text-slate-900 whitespace-nowrap">
                      {row.employeeId}
                    </td>
                    <td className="py-3 px-3.5 font-semibold text-slate-800 whitespace-nowrap">
                      {row.employeeName}
                    </td>
                    <td className="py-3 px-3.5 text-slate-700 whitespace-nowrap">{row.line}</td>
                    <td className="py-3 px-3.5 text-slate-600 whitespace-nowrap">{row.section}</td>
                    <td className="py-3 px-3.5 text-slate-700 whitespace-nowrap">{row.department}</td>
                    <td className="py-3 px-3.5 text-slate-600 whitespace-nowrap">{row.employeeType}</td>
                    <td className="py-3 px-3.5 font-mono text-slate-700 whitespace-nowrap tabular-nums">
                      {row.lastPresentDate || 'No Record'}
                    </td>
                    <td className="py-3 px-3.5 font-mono text-red-700 font-semibold whitespace-nowrap tabular-nums">
                      {row.firstDateOfCurrentAbsence || selectedDate}
                    </td>
                    <td className="py-3 px-3.5 text-right whitespace-nowrap">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded font-mono font-bold tabular-nums border ${
                          row.consecutiveAbsentWorkingDays >= 5
                            ? 'bg-red-100 text-red-900 border-red-300'
                            : row.consecutiveAbsentWorkingDays >= 3
                              ? 'bg-orange-100 text-orange-900 border-orange-300'
                              : 'bg-red-50 text-red-700 border-red-200'
                        }`}
                      >
                        {row.consecutiveAbsentWorkingDays}d
                      </span>
                    </td>
                    <td className="py-3 px-3.5 text-right font-mono font-semibold text-slate-800 whitespace-nowrap tabular-nums">
                      {row.totalAbsentWorkingDaysInMonth}d
                    </td>
                    <td className="py-3 px-3.5 text-slate-700 whitespace-nowrap">{row.currentShift}</td>
                    <td className="py-3 px-3.5 whitespace-nowrap">
                      <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-red-100 text-red-800 border border-red-200">
                        {row.attendanceStatus}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {(data?.total ?? 0) > 0 && (
          <div className="px-4 py-3 border-t border-slate-200 bg-slate-50/70 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
            <div className="tabular-nums">
              Page <strong className="text-slate-900">{data?.page ?? 1}</strong> of{' '}
              <strong className="text-slate-900">{data?.totalPages ?? 1}</strong> ({data?.total ?? 0}{' '}
              absent employees)
            </div>
            <div className="flex items-center gap-2">
              <select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(1);
                }}
                aria-label="Absent manpower rows per page"
                className="bg-white border border-slate-300 rounded px-2 py-1 text-xs"
              >
                <option value={25}>25 / page</option>
                <option value={50}>50 / page</option>
                <option value={100}>100 / page</option>
              </select>
              <button
                type="button"
                disabled={(data?.page ?? 1) <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="px-2.5 py-1 rounded border border-slate-300 bg-white hover:bg-slate-100 disabled:opacity-40 cursor-pointer"
              >
                Prev
              </button>
              <button
                type="button"
                disabled={(data?.page ?? 1) >= (data?.totalPages ?? 1)}
                onClick={() => setPage((p) => p + 1)}
                className="px-2.5 py-1 rounded border border-slate-300 bg-white hover:bg-slate-100 disabled:opacity-40 cursor-pointer"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Absent Manpower Detail View Modal */}
      {selectedAbsentee && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/55 backdrop-blur-xs flex items-center justify-center p-4"
          onClick={() => setSelectedAbsentee(null)}
        >
          <div
            className="bg-white rounded-xl max-w-4xl w-full max-h-[90vh] flex flex-col border border-slate-200 shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="px-5 py-4 border-b border-slate-200 flex items-start justify-between gap-4 bg-slate-50/70">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-base font-bold text-slate-900">
                    {selectedAbsentee.employeeName}
                  </h3>
                  <span className="font-mono text-xs font-bold px-2 py-0.5 rounded bg-white border border-slate-300 text-slate-800">
                    {selectedAbsentee.employeeId}
                  </span>
                  <span className="text-[11px] font-bold px-2 py-0.5 rounded bg-red-100 text-red-800 border border-red-200">
                    {selectedAbsentee.consecutiveAbsentWorkingDays} Consecutive Absent Working Day
                    {selectedAbsentee.consecutiveAbsentWorkingDays === 1 ? '' : 's'}
                  </span>
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  {selectedAbsentee.line} • {selectedAbsentee.section} • {selectedAbsentee.department} •{' '}
                  {selectedAbsentee.employeeType} • {selectedAbsentee.currentShift}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {onOpenFullCalendar && (
                  <button
                    type="button"
                    onClick={() => {
                      const empId = selectedAbsentee.employeeId;
                      setSelectedAbsentee(null);
                      onOpenFullCalendar(empId);
                    }}
                    className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold cursor-pointer"
                  >
                    Open Full Calendar Tab
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setSelectedAbsentee(null)}
                  className="p-1.5 text-slate-400 hover:text-slate-700 cursor-pointer"
                  aria-label="Close absent detail modal"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Modal Scrollable Body */}
            <div className="p-5 overflow-y-auto flex flex-col gap-5">
              {/* Absence Key Metrics */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                  <span className="text-[10px] uppercase text-slate-500 font-semibold block">
                    Last Present Date
                  </span>
                  <span className="text-sm font-mono font-bold text-slate-900 tabular-nums mt-1 block">
                    {selectedAbsentee.lastPresentDate || 'No Record'}
                  </span>
                </div>
                <div className="p-3 rounded-lg bg-red-50/70 border border-red-200">
                  <span className="text-[10px] uppercase text-red-700 font-semibold block">
                    First Date of Current Absence
                  </span>
                  <span className="text-sm font-mono font-bold text-red-900 tabular-nums mt-1 block">
                    {selectedAbsentee.firstDateOfCurrentAbsence || selectedDate}
                  </span>
                </div>
                <div className="p-3 rounded-lg bg-red-50/70 border border-red-200">
                  <span className="text-[10px] uppercase text-red-700 font-semibold block">
                    Consecutive Absent Working Days
                  </span>
                  <span className="text-sm font-mono font-bold text-red-900 tabular-nums mt-1 block">
                    {selectedAbsentee.consecutiveAbsentWorkingDays} Days
                  </span>
                </div>
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                  <span className="text-[10px] uppercase text-slate-500 font-semibold block">
                    Total Absences in Month
                  </span>
                  <span className="text-sm font-mono font-bold text-slate-900 tabular-nums mt-1 block">
                    {selectedAbsentee.totalAbsentWorkingDaysInMonth} Working Days
                  </span>
                </div>
              </div>

              {/* Previous Absence History */}
              <div className="rounded-xl border border-slate-200 p-4">
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-600 mb-2.5">
                  Previous Absence History (Last 60 Days)
                </h4>
                {loadingDetail ? (
                  <div className="flex items-center gap-2 text-xs text-slate-500 py-2">
                    <RotateCcw className="w-3.5 h-3.5 animate-spin" />
                    <span>Loading prior absence spells...</span>
                  </div>
                ) : detailCalendar?.consecutiveAbsence?.previousAbsenceSpells?.length ? (
                  <div className="flex flex-wrap gap-2">
                    {detailCalendar.consecutiveAbsence.previousAbsenceSpells.map((sp, idx) => (
                      <div
                        key={`${sp.startDate}-${idx}`}
                        className="px-3 py-1.5 rounded-lg bg-slate-50 border border-slate-200 text-xs flex items-center gap-2"
                      >
                        <span className="font-mono font-semibold text-slate-800 tabular-nums">
                          {sp.startDate}
                          {sp.endDate !== sp.startDate ? ` → ${sp.endDate}` : ''}
                        </span>
                        <span className="px-1.5 py-0.5 rounded bg-red-100 text-red-800 font-bold text-[10px] tabular-nums">
                          {sp.workingDays}d
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-slate-400">
                    No prior separate absence spells recorded in the last 60 days.
                  </p>
                )}
              </div>

              {/* Embedded Monthly Attendance Calendar */}
              <EmployeeMonthlyCalendar
                selectedEmployeeId={selectedAbsentee.employeeId}
                initialYear={detailYear}
                initialMonth={detailMonth}
                embedded
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
