import React, { useState, useEffect, useMemo } from 'react';
import { 
  History, 
  Search, 
  Filter, 
  Calendar, 
  Edit3, 
  X, 
  FileSpreadsheet, 
  Clock, 
  User, 
  CheckCircle2, 
  AlertTriangle,
  RotateCcw
} from 'lucide-react';
import { AttendanceRecord, Floor, Section, Department, Shift, AttendanceStatus } from '../types';
import { collection, getDocs, query, orderBy, limit } from 'firebase/firestore';
import { db } from '../firebase';
import { 
  formatMinutes, 
  formatTimeDisplay, 
  formatDateKey, 
  correctAttendanceRecord,
  getKolkataTimeParts,
  getNextDateKey
} from '../services/attendanceService';
import { exportTableToExcel, exportTableToCsv } from '../services/exportService';

interface AttendanceHistoryProps {
  floors: Floor[];
  sections: Section[];
  departments: Department[];
  shifts: Shift[];
}

export const AttendanceHistory: React.FC<AttendanceHistoryProps> = ({
  floors,
  sections,
  departments,
  shifts,
}) => {
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [startDate, setStartDate] = useState(formatDateKey(new Date(Date.now() - 7 * 24 * 3600 * 1000)));
  const [endDate, setEndDate] = useState(formatDateKey(new Date()));
  const [searchEmp, setSearchEmp] = useState('');
  const [filterFloor, setFilterFloor] = useState('ALL');
  const [filterDept, setFilterDept] = useState('ALL');
  const [filterShift, setFilterShift] = useState('ALL');
  const [filterStatus, setFilterStatus] = useState('ALL');
  const [filterPunchOutType, setFilterPunchOutType] = useState('ALL');

  // Correction Modal
  const [correctingRecord, setCorrectingRecord] = useState<AttendanceRecord | null>(null);
  const [correctionOutTime, setCorrectionOutTime] = useState('');
  const [correctionStatus, setCorrectionStatus] = useState<AttendanceStatus>('COMPLETED');
  const [correctionReason, setCorrectionReason] = useState('');
  const [adminName, setAdminName] = useState('Shift Supervisor');
  const [isSubmittingCorrection, setIsSubmittingCorrection] = useState(false);

  const fetchRecords = async () => {
    setLoading(true);
    try {
      const q = query(
        collection(db, 'attendance'),
        orderBy('createdAt', 'desc'),
        limit(500)
      );
      const snap = await getDocs(q);
      setRecords(snap.docs.map(d => d.data() as AttendanceRecord));
    } catch (err) {
      console.error('Error fetching attendance history:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRecords();
  }, []);

  const handleOpenCorrection = (rec: AttendanceRecord) => {
    setCorrectingRecord(rec);
    setCorrectionStatus(rec.attendanceStatus);
    setCorrectionReason(rec.correctionReason || '');
    if (rec.actualPunchOut || rec.effectivePunchOut) {
      const outIso = rec.actualPunchOut || rec.effectivePunchOut;
      const k = getKolkataTimeParts(new Date(outIso!));
      setCorrectionOutTime(`${String(k.hours).padStart(2, '0')}:${String(k.minutes).padStart(2, '0')}`);
    } else {
      setCorrectionOutTime(rec.scheduledPunchOut || '17:30');
    }
  };

  const handleSaveCorrection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!correctingRecord) return;
    if (!correctionReason.trim()) {
      alert('Mandatory reason required for attendance correction.');
      return;
    }

    setIsSubmittingCorrection(true);
    try {
      let finalOutIso: string | undefined = undefined;
      if (correctionOutTime) {
        const [h, m] = correctionOutTime.split(':').map(Number);
        // If it's an overnight shift (e.g. NIGHT) and out time is in morning (h < 12), out date is next day
        const isNightShift = correctingRecord.shiftId === 'NIGHT' || (correctingRecord.shiftNameSnapshot || '').toUpperCase().includes('NIGHT');
        const targetDate = (isNightShift && h < 12) 
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
      await fetchRecords();
    } catch (err: any) {
      alert(`Correction failed: ${err.message}`);
    } finally {
      setIsSubmittingCorrection(false);
    }
  };

  const filteredRecords = useMemo(() => {
    return records.filter(rec => {
      if (rec.shiftDate < startDate || rec.shiftDate > endDate) return false;

      if (searchEmp.trim() !== '') {
        const s = searchEmp.toLowerCase();
        if (
          !rec.employeeId.toLowerCase().includes(s) &&
          !rec.employeeNameSnapshot.toLowerCase().includes(s)
        ) {
          return false;
        }
      }

      if (filterFloor !== 'ALL' && rec.floorIdSnapshot !== filterFloor) return false;
      if (filterDept !== 'ALL' && rec.departmentIdSnapshot !== filterDept) return false;
      if (filterShift !== 'ALL' && rec.shiftId !== filterShift) return false;
      if (filterStatus !== 'ALL' && rec.attendanceStatus !== filterStatus) return false;
      if (filterPunchOutType !== 'ALL' && rec.punchOutType !== filterPunchOutType) return false;

      return true;
    });
  }, [records, startDate, endDate, searchEmp, filterFloor, filterDept, filterShift, filterStatus, filterPunchOutType]);

  const handleExportExcel = () => {
    const exportData = filteredRecords.map(r => ({
      employeeId: r.employeeId,
      name: r.employeeNameSnapshot,
      type: r.employeeTypeSnapshot,
      floor: r.floorIdSnapshot,
      section: r.sectionIdSnapshot,
      department: r.departmentIdSnapshot,
      shift: r.shiftNameSnapshot,
      shiftDate: r.shiftDate,
      punchIn: formatTimeDisplay(r.punchIn),
      punchOut: formatTimeDisplay(r.actualPunchOut),
      punchOutType: r.punchOutType,
      dutyHours: formatMinutes(r.regularDutyMinutes),
      otHours: formatMinutes(r.overtimeMinutes),
      status: r.attendanceStatus,
    }));

    exportTableToExcel(
      exportData,
      [
        { header: 'Employee ID', key: 'employeeId' },
        { header: 'Employee Name', key: 'name' },
        { header: 'Type', key: 'type' },
        { header: 'Line', key: 'floor' },
        { header: 'Section', key: 'section' },
        { header: 'Department', key: 'department' },
        { header: 'Shift', key: 'shift' },
        { header: 'Shift Date', key: 'shiftDate' },
        { header: 'Punch In', key: 'punchIn' },
        { header: 'Punch Out', key: 'punchOut' },
        { header: 'Punch Out Type', key: 'punchOutType' },
        { header: 'Duty Hours', key: 'dutyHours' },
        { header: 'OT Hours', key: 'otHours' },
        { header: 'Attendance Status', key: 'status' },
      ],
      `Attendance_History_${startDate}_to_${endDate}`
    );
  };

  return (
    <div className="p-6 bg-slate-50 min-h-full flex flex-col gap-6">
      {/* Title & Top Bar */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
            <History className="w-5 h-5 text-blue-600" />
            <span>ATTENDANCE HISTORY</span>
          </h2>
          <p className="text-xs text-slate-500">
            Searchable historical attendance records, duty calculations, OT ledger, and supervisor corrections
          </p>
        </div>

        <button
          onClick={handleExportExcel}
          className="bg-emerald-600 hover:bg-emerald-700 text-white font-medium text-xs px-4 py-2 rounded flex items-center gap-2 shadow-sm transition self-start md:self-auto"
        >
          <FileSpreadsheet className="w-4 h-4" />
          <span>Export to Excel</span>
        </button>
      </div>

      {/* Filter Toolbar */}
      <div className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-2xs flex flex-wrap items-center gap-3 text-xs">
        {/* Date Range */}
        <div className="flex items-center gap-1.5 bg-slate-50 border border-slate-300 rounded px-2 py-1">
          <Calendar className="w-3.5 h-3.5 text-blue-600" />
          <span className="text-[10px] text-slate-400">From</span>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="border-none text-xs text-slate-800 font-semibold focus:outline-hidden"
          />
          <span className="text-[10px] text-slate-400">To</span>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="border-none text-xs text-slate-800 font-semibold focus:outline-hidden"
          />
        </div>

        {/* Search ID or Name */}
        <div className="flex items-center gap-2 bg-slate-50 border border-slate-300 rounded px-2.5 py-1.5 min-w-[200px]">
          <Search className="w-3.5 h-3.5 text-slate-400" />
          <input
            type="text"
            placeholder="Search Emp ID / Name..."
            value={searchEmp}
            onChange={(e) => setSearchEmp(e.target.value)}
            className="w-full bg-transparent border-none text-slate-800 focus:outline-hidden"
          />
        </div>

        {/* Line */}
        <select
          value={filterFloor}
          onChange={(e) => setFilterFloor(e.target.value)}
          className="bg-white border border-slate-300 rounded px-2 py-1.5 text-slate-700"
        >
          <option value="ALL">All Lines</option>
          {floors.map(f => <option key={f.id} value={f.name}>{f.name}</option>)}
        </select>

        {/* Department */}
        <select
          value={filterDept}
          onChange={(e) => setFilterDept(e.target.value)}
          className="bg-white border border-slate-300 rounded px-2 py-1.5 text-slate-700"
        >
          <option value="ALL">All Departments</option>
          {departments.map(d => <option key={d.id} value={d.name}>{d.name}</option>)}
        </select>

        {/* Shift */}
        <select
          value={filterShift}
          onChange={(e) => setFilterShift(e.target.value)}
          className="bg-white border border-slate-300 rounded px-2 py-1.5 text-slate-700"
        >
          <option value="ALL">All Shifts</option>
          {shifts.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>

        {/* Attendance Status */}
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="bg-white border border-slate-300 rounded px-2 py-1.5 text-slate-700"
        >
          <option value="ALL">All Statuses</option>
          <option value="PRESENT">PRESENT</option>
          <option value="COMPLETED">COMPLETED</option>
          <option value="LATE">LATE</option>
          <option value="MISSED PUNCH OUT">MISSED PUNCH OUT</option>
        </select>

        {/* Punch Out Type */}
        <select
          value={filterPunchOutType}
          onChange={(e) => setFilterPunchOutType(e.target.value)}
          className="bg-white border border-slate-300 rounded px-2 py-1.5 text-slate-700"
        >
          <option value="ALL">All Out Types</option>
          <option value="ACTUAL">ACTUAL (Scanned)</option>
          <option value="AUTO">AUTO (Missed)</option>
          <option value="NONE">NONE (In Progress)</option>
        </select>
      </div>

      {/* History Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-600 uppercase font-semibold border-b border-slate-200">
              <tr>
                <th className="py-3 px-3.5">Emp ID</th>
                <th className="py-3 px-3.5">Name</th>
                <th className="py-3 px-3.5">Line / Dept</th>
                <th className="py-3 px-3.5">Shift & Date</th>
                <th className="py-3 px-3.5">In Time</th>
                <th className="py-3 px-3.5">Out Time</th>
                <th className="py-3 px-3.5">Out Type</th>
                <th className="py-3 px-3.5">Regular Duty</th>
                <th className="py-3 px-3.5">OT Hours</th>
                <th className="py-3 px-3.5">Status</th>
                <th className="py-3 px-3.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredRecords.length === 0 ? (
                <tr>
                  <td colSpan={11} className="py-8 text-center text-slate-400">
                    No attendance records found for the selected filters.
                  </td>
                </tr>
              ) : (
                filteredRecords.map(rec => (
                  <tr key={rec.id} className="hover:bg-slate-50 transition">
                    <td className="py-3 px-3.5 font-mono font-bold text-slate-900">{rec.employeeId}</td>
                    <td className="py-3 px-3.5 font-semibold text-slate-800">{rec.employeeNameSnapshot}</td>
                    <td className="py-3 px-3.5 text-slate-600">
                      {rec.floorIdSnapshot} • {rec.departmentIdSnapshot}
                    </td>
                    <td className="py-3 px-3.5">
                      <span className="font-semibold text-slate-800 block">{rec.shiftNameSnapshot}</span>
                      <span className="text-[10px] text-slate-400 font-mono">{rec.shiftDate}</span>
                    </td>
                    <td className="py-3 px-3.5 font-mono text-emerald-700 font-semibold">
                      {formatTimeDisplay(rec.punchIn)}
                    </td>
                    <td className="py-3 px-3.5 font-mono font-semibold">
                      {rec.actualPunchOut ? (
                        <span className="text-blue-700">{formatTimeDisplay(rec.actualPunchOut)}</span>
                      ) : rec.punchOutType === 'AUTO' ? (
                        <span className="text-orange-700">{formatTimeDisplay(rec.effectivePunchOut)} (Auto)</span>
                      ) : (
                        <span className="text-slate-400">In Progress</span>
                      )}
                    </td>
                    <td className="py-3 px-3.5">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        rec.punchOutType === 'ACTUAL' ? 'bg-blue-100 text-blue-800' :
                        rec.punchOutType === 'AUTO' ? 'bg-orange-100 text-orange-800' :
                        'bg-slate-100 text-slate-600'
                      }`}>
                        {rec.punchOutType}
                      </span>
                    </td>
                    <td className="py-3 px-3.5 font-mono font-bold text-slate-800">
                      {formatMinutes(rec.regularDutyMinutes)}
                    </td>
                    <td className="py-3 px-3.5 font-mono font-bold">
                      {rec.overtimeMinutes > 0 ? (
                        <span className="text-amber-600">+{formatMinutes(rec.overtimeMinutes)}</span>
                      ) : (
                        <span className="text-slate-400">00:00</span>
                      )}
                    </td>
                    <td className="py-3 px-3.5">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        rec.attendanceStatus === 'PRESENT' || rec.attendanceStatus === 'COMPLETED' ? 'bg-emerald-100 text-emerald-800' :
                        rec.attendanceStatus === 'LATE' ? 'bg-amber-100 text-amber-800' :
                        rec.attendanceStatus === 'MISSED PUNCH OUT' ? 'bg-orange-100 text-orange-800' :
                        'bg-red-100 text-red-800'
                      }`}>
                        {rec.attendanceStatus}
                      </span>
                    </td>
                    <td className="py-3 px-3.5 text-right">
                      <button
                        onClick={() => handleOpenCorrection(rec)}
                        className="p-1.5 rounded hover:bg-slate-100 text-slate-700 border border-slate-200"
                        title="Supervisor Attendance Correction"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* SUPERVISOR CORRECTION MODAL */}
      {correctingRecord && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-xl max-w-md w-full p-5 shadow-2xl border border-slate-200">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200 mb-4">
              <div>
                <h3 className="font-bold text-slate-900 text-sm">Supervisor Attendance Correction</h3>
                <p className="text-xs text-slate-500">
                  {correctingRecord.employeeNameSnapshot} ({correctingRecord.employeeId}) • {correctingRecord.shiftDate}
                </p>
              </div>
              <button onClick={() => setCorrectingRecord(null)} className="text-slate-400 hover:text-slate-600">
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
                  <span className="text-[10px] text-slate-400 block uppercase">Current Out Type</span>
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
                  onChange={(e) => setCorrectionOutTime(e.target.value)}
                  className="w-full border border-slate-300 rounded px-2.5 py-1.5 font-mono"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">
                  Corrected Status
                </label>
                <select
                  value={correctionStatus}
                  onChange={(e) => setCorrectionStatus(e.target.value as AttendanceStatus)}
                  className="w-full border border-slate-300 rounded px-2.5 py-1.5"
                >
                  <option value="COMPLETED">COMPLETED (Normal)</option>
                  <option value="PRESENT">PRESENT</option>
                  <option value="LATE">LATE</option>
                  <option value="MISSED PUNCH OUT">MISSED PUNCH OUT</option>
                </select>
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">
                  Reason for Correction <span className="text-red-500">* (Mandatory for audit trail)</span>
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
                  className="bg-slate-100 text-slate-700 px-3 py-1.5 rounded"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingCorrection}
                  className="bg-blue-600 text-white px-4 py-1.5 rounded font-medium disabled:opacity-50"
                >
                  {isSubmittingCorrection ? 'Applying...' : 'Save Correction'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
