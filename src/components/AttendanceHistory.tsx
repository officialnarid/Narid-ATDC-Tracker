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
  RotateCcw,
  ListOrdered,
  LogIn,
  LogOut,
  ArrowRight
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
import {
  classifyCompletedDutyStatus,
  formatDurationClock,
  getAttendanceStatusBadgeClasses,
  resolveAttendanceMetrics,
  STANDARD_DUTY_MINUTES,
} from '../utils/attendanceStatus';

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
  const [viewingPunchesRecord, setViewingPunchesRecord] = useState<AttendanceRecord | null>(null);
  const [correctionOutTime, setCorrectionOutTime] = useState('');
  const [correctionStatus, setCorrectionStatus] = useState<AttendanceStatus>('COMPLETED');
  const [correctionReason, setCorrectionReason] = useState('');
  const [adminName, setAdminName] = useState('Shift Supervisor');
  const [isSubmittingCorrection, setIsSubmittingCorrection] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

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
    const resolved = resolveAttendanceMetrics(rec, nowMs);
    setCorrectingRecord(rec);
    setCorrectionStatus((resolved.status as AttendanceStatus) || rec.attendanceStatus);
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
      if (filterStatus !== 'ALL') {
        const metrics = resolveAttendanceMetrics(rec, nowMs);
        if (filterStatus === 'LATE') {
          if (!metrics.isLate) return false;
        } else if (metrics.status !== filterStatus) {
          return false;
        }
      }
      if (filterPunchOutType !== 'ALL' && rec.punchOutType !== filterPunchOutType) return false;

      return true;
    });
  }, [records, startDate, endDate, searchEmp, filterFloor, filterDept, filterShift, filterStatus, filterPunchOutType, nowMs]);

  const handleExportExcel = () => {
    const exportData = filteredRecords.map(r => {
      const m = resolveAttendanceMetrics(r, nowMs);
      return {
        employeeId: r.employeeId,
        name: r.employeeNameSnapshot,
        type: r.employeeTypeSnapshot,
        floor: r.floorIdSnapshot,
        section: r.sectionIdSnapshot,
        department: r.departmentIdSnapshot,
        shift: r.shiftNameSnapshot,
        shiftDate: r.shiftDate,
        state: m.state,
        punchIn: formatTimeDisplay(r.firstPunchIn || r.punchIn),
        punchOut: m.isOpen ? 'In Progress' : formatTimeDisplay(r.lastPunchOut || r.actualPunchOut || r.effectivePunchOut),
        punchOutType: r.punchOutType,
        dutyHours: m.isOpen
          ? `00:00 Hours (In Progress: ${formatDurationClock(m.accumulatedDutyMinutes)})`
          : formatMinutes(m.completedDutyMinutes),
        otHours: m.overtimeMinutes > 0 ? `${formatDurationClock(m.overtimeMinutes)} OT` : '00:00',
        status: m.status,
      };
    });

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
        { header: 'State', key: 'state' },
        { header: 'First In', key: 'punchIn' },
        { header: 'Last Out', key: 'punchOut' },
        { header: 'Punch Out Type', key: 'punchOutType' },
        { header: 'Completed Duty', key: 'dutyHours' },
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
                <th className="py-3 px-3.5">State</th>
                <th className="py-3 px-3.5">First In</th>
                <th className="py-3 px-3.5">Last Out</th>
                <th className="py-3 px-3.5">Punches</th>
                <th className="py-3 px-3.5">Regular Duty</th>
                <th className="py-3 px-3.5">OT Hours</th>
                <th className="py-3 px-3.5">Status</th>
                <th className="py-3 px-3.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredRecords.length === 0 ? (
                <tr>
                  <td colSpan={12} className="py-8 text-center text-slate-400">
                    No attendance records found for the selected filters.
                  </td>
                </tr>
              ) : (
                filteredRecords.map(rec => {
                  const metrics = resolveAttendanceMetrics(rec, nowMs);
                  const state = metrics.state;
                  const punchCount = rec.punches?.length || (rec.actualPunchOut ? 2 : 1);
                  return (
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
                      <td className="py-3 px-3.5">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase inline-flex items-center gap-1 ${
                          state === 'INSIDE' 
                            ? 'bg-emerald-100 text-emerald-800 border border-emerald-300' 
                            : 'bg-slate-100 text-slate-700 border border-slate-300'
                        }`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${state === 'INSIDE' ? 'bg-emerald-600 animate-pulse' : 'bg-slate-400'}`}></span>
                          {state}
                        </span>
                      </td>
                      <td className="py-3 px-3.5 font-mono text-emerald-700 font-semibold">
                        {formatTimeDisplay(rec.firstPunchIn || rec.punchIn)}
                      </td>
                      <td className="py-3 px-3.5 font-mono font-semibold">
                        {!metrics.isOpen && (rec.lastPunchOut || rec.actualPunchOut) ? (
                          <span className="text-blue-700">{formatTimeDisplay(rec.lastPunchOut || rec.actualPunchOut)}</span>
                        ) : !metrics.isOpen && rec.punchOutType === 'AUTO' ? (
                          <span className="text-orange-700">{formatTimeDisplay(rec.effectivePunchOut)} (Auto)</span>
                        ) : (
                          <span className="text-sky-700">In Progress</span>
                        )}
                      </td>
                      <td className="py-3 px-3.5">
                        <button
                          onClick={() => setViewingPunchesRecord(rec)}
                          className="bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 px-2 py-1 rounded text-[11px] font-bold flex items-center gap-1 transition"
                          title="View all punch events"
                        >
                          <ListOrdered className="w-3 h-3 text-blue-600" />
                          <span>{punchCount} Event{punchCount !== 1 ? 's' : ''}</span>
                        </button>
                      </td>
                      <td className="py-3 px-3.5 font-mono">
                        {metrics.isOpen ? (
                          <div>
                            <span className="font-bold text-slate-400 block">00:00 Hours</span>
                            <span className="text-[10px] font-semibold text-sky-700 block">
                              Elapsed: {formatDurationClock(metrics.accumulatedDutyMinutes)}
                            </span>
                          </div>
                        ) : (
                          <div>
                            <span className="font-bold text-slate-800 block">
                              {formatDurationClock(metrics.completedDutyMinutes)} Hours
                            </span>
                            {metrics.overtimeMinutes > 0 && (
                              <span className="text-[10px] text-slate-500 block">
                                Std: {formatDurationClock(metrics.regularDutyMinutes)}
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-3.5 font-mono font-bold">
                        {metrics.overtimeMinutes > 0 ? (
                          <span className="text-indigo-700 bg-indigo-50 border border-indigo-200 px-1.5 py-0.5 rounded">
                            {metrics.otLabel}
                          </span>
                        ) : (
                          <span className="text-slate-400">00:00</span>
                        )}
                      </td>
                      <td className="py-3 px-3.5">
                        <div className="flex flex-col items-start gap-1">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${getAttendanceStatusBadgeClasses(metrics.status)}`}>
                            {metrics.status}
                          </span>
                          {metrics.isLate && (
                            <span className="text-[9px] font-semibold text-amber-700">
                              Late Arrival
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-3 px-3.5 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={() => setViewingPunchesRecord(rec)}
                            className="p-1.5 rounded hover:bg-blue-50 text-blue-600 border border-blue-200"
                            title="View Detailed Punch Timeline"
                          >
                            <ListOrdered className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => handleOpenCorrection(rec)}
                            className="p-1.5 rounded hover:bg-slate-100 text-slate-700 border border-slate-200"
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
                  onChange={(e) => {
                    const nextTime = e.target.value;
                    setCorrectionOutTime(nextTime);
                    if (nextTime && correctingRecord) {
                      const [h, m] = nextTime.split(':').map(Number);
                      const isNightShift = correctingRecord.shiftId === 'NIGHT' || (correctingRecord.shiftNameSnapshot || '').toUpperCase().includes('NIGHT');
                      const targetDate = (isNightShift && h < 12)
                        ? getNextDateKey(correctingRecord.shiftDate)
                        : correctingRecord.shiftDate;
                      const previewOutIso = `${targetDate}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+05:30`;
                      const inMs = new Date(correctingRecord.firstPunchIn || correctingRecord.punchIn).getTime();
                      const outMs = new Date(previewOutIso).getTime();
                      if (!Number.isNaN(inMs) && !Number.isNaN(outMs) && outMs >= inMs) {
                        const mins = Math.floor((outMs - inMs) / 60000);
                        setCorrectionStatus(classifyCompletedDutyStatus(mins, STANDARD_DUTY_MINUTES));
                      }
                    }
                  }}
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

      {/* DETAILED PUNCH EVENTS TIMELINE MODAL */}
      {viewingPunchesRecord && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-2xl border border-slate-200 flex flex-col max-h-[90vh]">
            {/* Modal Header */}
            <div className="flex items-start justify-between pb-4 border-b border-slate-200">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-blue-50 border border-blue-200 flex items-center justify-center text-blue-600">
                  <ListOrdered className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-bold text-slate-900 text-base">Punch History & Event Timeline</h3>
                  <p className="text-xs text-slate-500">
                    {viewingPunchesRecord.employeeNameSnapshot} ({viewingPunchesRecord.employeeId}) • {viewingPunchesRecord.shiftDate}
                  </p>
                </div>
              </div>
              <button 
                onClick={() => setViewingPunchesRecord(null)} 
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg hover:bg-slate-100"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Daily Official Summary Card */}
            {(() => {
              const modalMetrics = resolveAttendanceMetrics(viewingPunchesRecord, nowMs);
              return (
                <div className="mt-4 bg-slate-50 border border-slate-200 rounded-xl p-3.5 grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs">
                  <div>
                    <span className="text-[10px] text-slate-400 font-semibold uppercase block">Official First In</span>
                    <span className="font-mono font-bold text-emerald-700">
                      {formatTimeDisplay(viewingPunchesRecord.firstPunchIn || viewingPunchesRecord.punchIn)}
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-400 font-semibold uppercase block">Official Last Out</span>
                    <span className="font-mono font-bold text-blue-700">
                      {modalMetrics.isOpen
                        ? 'In Progress'
                        : formatTimeDisplay(viewingPunchesRecord.lastPunchOut || viewingPunchesRecord.actualPunchOut || viewingPunchesRecord.effectivePunchOut)}
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-400 font-semibold uppercase block">
                      {modalMetrics.isOpen ? 'Accumulated (Open)' : 'Completed Duty'}
                    </span>
                    <span className="font-mono font-bold text-slate-800">
                      {modalMetrics.isOpen
                        ? `${formatDurationClock(modalMetrics.accumulatedDutyMinutes)} Hours`
                        : `${formatDurationClock(modalMetrics.completedDutyMinutes)} Hours`}
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-400 font-semibold uppercase block">Overtime (OT)</span>
                    <span className="font-mono font-bold text-indigo-700">
                      {modalMetrics.overtimeMinutes > 0 ? modalMetrics.otLabel : '00:00'}
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-400 font-semibold uppercase block">Status</span>
                    <span className={`inline-block mt-0.5 px-2 py-0.5 rounded text-[10px] font-bold ${getAttendanceStatusBadgeClasses(modalMetrics.status)}`}>
                      {modalMetrics.status}
                    </span>
                  </div>
                </div>
              );
            })()}

            {/* Events Timeline List */}
            <div className="mt-4 flex-1 overflow-y-auto space-y-2.5 pr-1">
              <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">
                All Alternating Punches ({viewingPunchesRecord.punches?.length || (viewingPunchesRecord.actualPunchOut ? 2 : 1)} events)
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
                      <div className={`w-7 h-7 rounded-lg flex items-center justify-center font-bold text-xs ${
                        p.eventType === 'IN' ? 'bg-emerald-600 text-white' : 'bg-indigo-600 text-white'
                      }`}>
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
                /* Fallback for initial records created before multi-event schema */
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

            {/* Modal Footer */}
            <div className="pt-4 border-t border-slate-200 mt-4 flex justify-end">
              <button
                onClick={() => setViewingPunchesRecord(null)}
                className="bg-slate-900 hover:bg-slate-800 text-white font-medium text-xs px-4 py-2 rounded-lg transition"
              >
                Close Timeline
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
