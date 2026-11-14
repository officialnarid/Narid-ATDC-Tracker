import React, { useState, useEffect, useMemo } from 'react';
import { 
  FileSpreadsheet, 
  Download, 
  Calendar, 
  Filter, 
  Layers, 
  Building2, 
  Clock, 
  Users, 
  AlertTriangle, 
  CheckCircle2,
  FileText
} from 'lucide-react';
import { AttendanceRecord, Employee, Floor, Section, Department, Shift } from '../types';
import { collection, getDocs, query, where, orderBy } from 'firebase/firestore';
import { db } from '../firebase';
import { formatDateKey, formatMinutes, formatTimeDisplay } from '../services/attendanceService';
import { exportTableToExcel, exportTableToCsv } from '../services/exportService';
import { sendServerAuditEvent } from '../services/auditService';

interface ReportsProps {
  employees: Employee[];
  floors: Floor[];
  sections: Section[];
  departments: Department[];
  shifts: Shift[];
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
  const [selectedShift, setSelectedShift] = useState<string>('ALL');
  const [selectedEmpId, setSelectedEmpId] = useState<string>('ALL');

  const [attendanceRecords, setAttendanceRecords] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = useState(false);

  // Fetch relevant records for selected date / month
  useEffect(() => {
    const fetchReportData = async () => {
      setLoading(true);
      try {
        let q;
        if (activeReport === 'monthly_attendance' || activeReport === 'employee_wise') {
          // Query for the month
          q = query(
            collection(db, 'attendance'),
            where('shiftDate', '>=', `${selectedMonth}-01`),
            where('shiftDate', '<=', `${selectedMonth}-31`)
          );
        } else {
          // Query for single selectedDate
          q = query(
            collection(db, 'attendance'),
            where('shiftDate', '==', selectedDate)
          );
        }

        const snap = await getDocs(q);
        setAttendanceRecords(snap.docs.map(d => d.data() as AttendanceRecord));
      } catch (err) {
        console.error('Error fetching report data:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchReportData();
  }, [activeReport, selectedDate, selectedMonth]);

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
    { id: 'overtime', name: '11. Overtime (OT) Report', desc: 'Employees who completed beyond 8h30m duty' },
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
          { header: 'First In', key: 'inTime' },
          { header: 'Last Out', key: 'outTime' },
          { header: 'Punches', key: 'punches' },
          { header: 'Out Type', key: 'outType' },
          { header: 'Duty Hours', key: 'duty' },
          { header: 'OT Hours', key: 'ot' },
          { header: 'Status', key: 'status' },
        ];
        rows = attendanceRecords.map(a => ({
          employeeId: a.employeeId,
          name: a.employeeNameSnapshot,
          floor: a.floorIdSnapshot,
          section: a.sectionIdSnapshot,
          dept: a.departmentIdSnapshot,
          shift: a.shiftNameSnapshot,
          state: a.currentState || (a.actualPunchOut ? 'OUTSIDE' : 'INSIDE'),
          inTime: formatTimeDisplay(a.firstPunchIn || a.punchIn),
          outTime: formatTimeDisplay(a.lastPunchOut || a.actualPunchOut || a.effectivePunchOut),
          punches: a.punches?.length || (a.actualPunchOut ? 2 : 1),
          outType: a.punchOutType,
          duty: formatMinutes(a.regularDutyMinutes),
          ot: formatMinutes(a.overtimeMinutes),
          status: a.attendanceStatus,
        }));
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
          .filter(a => a.attendanceStatus === 'LATE')
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
          { header: 'Punch In', key: 'inTime' },
          { header: 'Punch Out', key: 'outTime' },
          { header: 'Regular Duty', key: 'duty' },
          { header: 'OT Duration', key: 'ot' },
        ];
        rows = attendanceRecords
          .filter(a => (a.overtimeMinutes || 0) > 0)
          .map(a => ({
            employeeId: a.employeeId,
            name: a.employeeNameSnapshot,
            floorDept: `${a.floorIdSnapshot} • ${a.departmentIdSnapshot}`,
            inTime: formatTimeDisplay(a.punchIn),
            outTime: formatTimeDisplay(a.actualPunchOut),
            duty: formatMinutes(a.regularDutyMinutes),
            ot: formatMinutes(a.overtimeMinutes),
          }));
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
        // Generic fallback
        cols = [
          { header: 'Employee ID', key: 'employeeId' },
          { header: 'Name', key: 'name' },
          { header: 'Date', key: 'date' },
          { header: 'Duty', key: 'duty' },
          { header: 'OT', key: 'ot' },
        ];
        rows = attendanceRecords.map(a => ({
          employeeId: a.employeeId,
          name: a.employeeNameSnapshot,
          date: a.shiftDate,
          duty: formatMinutes(a.regularDutyMinutes),
          ot: formatMinutes(a.overtimeMinutes),
        }));
    }

    return { tableColumns: cols, tableData: rows, fileName: name };
  }, [activeReport, attendanceRecords, activeEmps, floors, sections, departments, selectedDate]);

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

  return (
    <div className="p-6 bg-slate-50 min-h-full flex flex-col gap-6">
      {/* Title */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
            <FileSpreadsheet className="w-5 h-5 text-emerald-600" />
            <span>ATTENDANCE REPORTS & EXCEL EXPORT</span>
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
                  onClick={() => setActiveReport(rep.id as ReportType)}
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
                  onChange={(e) => setSelectedMonth(e.target.value)}
                  className="bg-slate-50 border border-slate-300 rounded px-2.5 py-1 text-slate-800 font-medium"
                />
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="font-semibold text-slate-600">Date:</span>
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                  className="bg-slate-50 border border-slate-300 rounded px-2.5 py-1 text-slate-800 font-medium"
                />
              </div>
            )}

            <div className="ml-auto text-xs text-slate-500 font-medium">
              Showing {tableData.length} Records
            </div>
          </div>

          {/* Table Preview */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
            <div className="overflow-x-auto max-h-[500px]">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-600 uppercase font-semibold border-b border-slate-200 sticky top-0">
                  <tr>
                    {tableColumns.map((col, idx) => (
                      <th key={idx} className="py-2.5 px-3">
                        {col.header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {tableData.length === 0 ? (
                    <tr>
                      <td colSpan={tableColumns.length} className="py-8 text-center text-slate-400">
                        {loading ? 'Loading report data...' : 'No records found for this report and date.'}
                      </td>
                    </tr>
                  ) : (
                    tableData.map((row, rowIdx) => (
                      <tr key={rowIdx} className="hover:bg-slate-50">
                        {tableColumns.map((col, colIdx) => (
                          <td key={colIdx} className="py-2 px-3 text-slate-700">
                            {row[col.key]}
                          </td>
                        ))}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
