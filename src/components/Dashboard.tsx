import React, { useState, useEffect, useMemo } from 'react';
import { 
  Users, 
  UserCheck, 
  UserX, 
  Clock, 
  Calendar, 
  Filter, 
  Layers, 
  Building2, 
  Network, 
  Briefcase, 
  AlertTriangle, 
  CheckCircle2, 
  ChevronRight, 
  X, 
  FileSpreadsheet, 
  RefreshCw,
  ShieldAlert,
  Maximize2,
  Minimize2
} from 'lucide-react';
import { 
  Employee, 
  AttendanceRecord, 
  Shift, 
  Floor, 
  Section, 
  Department, 
  ShiftRoster,
  UserRoleRecord 
} from '../types';
import { collection, doc, getDocs, onSnapshot, query, where } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { formatDateKey, formatMinutes } from '../services/attendanceService';
import { isModuleAllowedForUser } from '../services/authService';
import { 
  DashboardCardId, 
  getPermittedCardIdsForRole,
  isDashboardCardVisible, 
  normalizeUserRole 
} from '../config/dashboardCardsConfig';

interface DashboardProps {
  employees: Employee[];
  shifts: Shift[];
  floors: Floor[];
  sections: Section[];
  departments: Department[];
  onNavigateToScanner: () => void;
  onNavigateToReports: () => void;
  onRefreshData?: () => void;
  currentUserRole?: UserRoleRecord | null;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  onExitFullscreen?: () => void;
}

export const Dashboard: React.FC<DashboardProps> = ({
  employees,
  shifts,
  floors,
  sections,
  departments,
  onNavigateToScanner,
  onNavigateToReports,
  onRefreshData,
  currentUserRole,
  isFullscreen = false,
  onToggleFullscreen,
  onExitFullscreen,
}) => {
  // Authoritative Role Resolution directly from Firestore
  const [verifiedRole, setVerifiedRole] = useState<'SUPER_ADMIN' | 'ADMIN' | 'USER'>(() => {
    return normalizeUserRole(currentUserRole?.role);
  });

  const [selectedDate, setSelectedDate] = useState<string>(formatDateKey(new Date()));
  const [selectedShift, setSelectedShift] = useState<string>('ALL');
  const [selectedFloor, setSelectedFloor] = useState<string>('ALL');
  const [selectedSection, setSelectedSection] = useState<string>('ALL');
  const [selectedDept, setSelectedDept] = useState<string>('ALL');
  const [selectedType, setSelectedType] = useState<string>('ALL');

  const [attendanceRecords, setAttendanceRecords] = useState<AttendanceRecord[]>([]);
  const [rosterRecords, setRosterRecords] = useState<ShiftRoster[]>([]);
  const [loading, setLoading] = useState(true);

  // Drilldown modal state
  const [drilldownTitle, setDrilldownTitle] = useState<string | null>(null);
  const [drilldownEmployees, setDrilldownEmployees] = useState<{
    employee: Employee;
    attendance?: AttendanceRecord;
    status: string;
  }[]>([]);

  // Keep verifiedRole synced with currentUserRole prop
  useEffect(() => {
    setVerifiedRole(normalizeUserRole(currentUserRole?.role));
  }, [currentUserRole?.role]);

  // 1. Authoritative Role Verification from Firestore user_roles collection
  useEffect(() => {
    const rawLoginId = currentUserRole?.loginId;
    if (!rawLoginId || !auth.currentUser) return;

    const cleanLoginId = rawLoginId.trim().toLowerCase();
    const docRef = doc(db, 'user_roles', `role_${cleanLoginId}`);

    const unsubscribe = onSnapshot(docRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        const role = normalizeUserRole(data.role);
        setVerifiedRole(role);
      }
    }, (error) => {
      console.warn('[Dashboard] Real-time role subscription note:', error);
    });

    return () => unsubscribe();
  }, [currentUserRole?.loginId]);

  // 2. Real-time Attendance Stream from Firestore
  useEffect(() => {
    if (!auth.currentUser) return;
    setLoading(true);
    let attQuery = query(
      collection(db, 'attendance'),
      where('shiftDate', '==', selectedDate)
    );
    if (selectedShift !== 'ALL') {
      attQuery = query(
        collection(db, 'attendance'),
        where('shiftDate', '==', selectedDate),
        where('shiftId', '==', selectedShift)
      );
    }

    const unsubscribe = onSnapshot(attQuery, (snapshot) => {
      const records = snapshot.docs.map(d => d.data() as AttendanceRecord);
      setAttendanceRecords(records);
      setLoading(false);
    }, (err) => {
      console.error('[Dashboard] Real-time attendance error:', err);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [selectedDate, selectedShift]);

  // 3. Fetch Roster records for selected date
  const loadRosterData = async () => {
    if (!auth.currentUser) return;
    try {
      const rosterQuery = query(
        collection(db, 'shift_rosters'),
        where('shiftDate', '==', selectedDate)
      );
      const rosterSnap = await getDocs(rosterQuery);
      setRosterRecords(rosterSnap.docs.map(d => d.data() as ShiftRoster));
    } catch (err) {
      console.error('[Dashboard] Error fetching roster records:', err);
    }
  };

  useEffect(() => {
    if (auth.currentUser) {
      loadRosterData();
    }
  }, [selectedDate]);

  // Handle manual refresh
  const handleManualRefresh = () => {
    loadRosterData();
    if (onRefreshData) onRefreshData();
  };

  // Filtered employees list
  const filteredEmployees = useMemo(() => {
    return employees.filter(emp => {
      if (selectedFloor !== 'ALL' && emp.floor !== selectedFloor) return false;
      if (selectedSection !== 'ALL' && emp.section !== selectedSection) return false;
      if (selectedDept !== 'ALL' && emp.department !== selectedDept) return false;
      if (selectedType !== 'ALL' && emp.employeeType !== selectedType) return false;
      return true;
    });
  }, [employees, selectedFloor, selectedSection, selectedDept, selectedType]);

  const activeEmployees = useMemo(() => {
    return filteredEmployees.filter(e => e.employeeStatus === 'Active');
  }, [filteredEmployees]);

  // Attendance lookup by employeeId
  const attendanceMap = useMemo(() => {
    const map = new Map<string, AttendanceRecord>();
    for (const att of attendanceRecords) {
      map.set(att.employeeId, att);
    }
    return map;
  }, [attendanceRecords]);

  // Roster lookup by employeeId
  const rosterMap = useMemo(() => {
    const map = new Map<string, ShiftRoster>();
    for (const r of rosterRecords) {
      map.set(r.employeeId, r);
    }
    return map;
  }, [rosterRecords]);

  // Calculations
  const presentRecords = useMemo(() => {
    return attendanceRecords.filter(a => {
      const emp = employees.find(e => e.employeeId === a.employeeId);
      if (!emp) return false;
      if (selectedFloor !== 'ALL' && a.floorIdSnapshot !== selectedFloor) return false;
      if (selectedSection !== 'ALL' && a.sectionIdSnapshot !== selectedSection) return false;
      if (selectedDept !== 'ALL' && a.departmentIdSnapshot !== selectedDept) return false;
      if (selectedType !== 'ALL' && a.employeeTypeSnapshot !== selectedType) return false;
      return true;
    });
  }, [attendanceRecords, employees, selectedFloor, selectedSection, selectedDept, selectedType]);

  // First-In Last-Out Dashboard Metrics
  const firstInCount = useMemo(() => {
    return presentRecords.filter(a => !!(a.firstPunchIn || a.punchIn)).length;
  }, [presentRecords]);

  const finalOutCount = useMemo(() => {
    return presentRecords.filter(a => !!(a.lastPunchOut || a.actualPunchOut)).length;
  }, [presentRecords]);

  const currentlyInsideCount = useMemo(() => {
    return presentRecords.filter(a => a.currentState === 'INSIDE' || (!a.actualPunchOut && a.punchOutType === 'NONE')).length;
  }, [presentRecords]);

  const currentlyOutsideCount = useMemo(() => {
    return presentRecords.filter(a => a.currentState === 'OUTSIDE' || (!!a.actualPunchOut || a.punchOutType === 'ACTUAL')).length;
  }, [presentRecords]);

  const autoClosedCount = useMemo(() => {
    return presentRecords.filter(a => a.punchOutType === 'AUTO' || a.autoClosed).length;
  }, [presentRecords]);

  const missedPunchOutCount = useMemo(() => {
    return presentRecords.filter(a => a.missedPunchOut || a.attendanceStatus === 'MISSED PUNCH OUT' || a.punchOutType === 'AUTO').length;
  }, [presentRecords]);

  const totalDutyMinutes = useMemo(() => {
    return presentRecords.reduce((acc, curr) => acc + (curr.totalDutyMinutes || curr.regularDutyMinutes || 0), 0);
  }, [presentRecords]);

  const totalOtMinutes = useMemo(() => {
    return presentRecords.reduce((acc, curr) => acc + (curr.overtimeMinutes || 0), 0);
  }, [presentRecords]);

  // Expected manpower calculation from Roster
  const isRosterConfigured = rosterRecords.length > 0;
  const scheduledCount = rosterRecords.filter(r => r.rosterStatus === 'SCHEDULED').length;
  const leaveCount = rosterRecords.filter(r => r.rosterStatus === 'LEAVE').length;

  const expectedManpower = isRosterConfigured
    ? Math.max(0, scheduledCount)
    : activeEmployees.length;

  const presentCount = presentRecords.length;
  const absentCount = isRosterConfigured
    ? Math.max(0, expectedManpower - presentCount)
    : Math.max(0, activeEmployees.length - presentCount);

  // Protected Drilldown handler
  const handleOpenDrilldown = (
    cardId: DashboardCardId,
    title: string,
    filterFn: (emp: Employee, att?: AttendanceRecord) => boolean
  ) => {
    // Role Authorization Check: block drilldown if card is hidden for this role
    if (!isDashboardCardVisible(verifiedRole, cardId)) {
      console.warn(`[Security] Drilldown for ${cardId} is unauthorized for role ${verifiedRole}`);
      return;
    }

    const list = activeEmployees
      .map(emp => {
        const att = attendanceMap.get(emp.employeeId);
        let status = 'ABSENT';
        if (att) {
          status = att.attendanceStatus;
        } else {
          const r = rosterMap.get(emp.employeeId);
          if (r?.rosterStatus === 'LEAVE') status = 'LEAVE';
          else if (r?.rosterStatus === 'WEEKLY_OFF') status = 'WEEKLY OFF';
        }
        return { employee: emp, attendance: att, status };
      })
      .filter(item => filterFn(item.employee, item.attendance));

    setDrilldownTitle(title);
    setDrilldownEmployees(list);
  };

  const canOpenScanner = isModuleAllowedForUser(currentUserRole, 'scanner');

  // Registry of all 12 Dashboard Cards
  const renderCard = (cardId: DashboardCardId) => {
    switch (cardId) {
      case 'active_total':
        return (
          <div 
            key="active_total"
            onClick={() => handleOpenDrilldown('active_total', 'Total Active Manpower', (emp) => emp.employeeStatus === 'Active')}
            className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-2xs hover:border-blue-400 cursor-pointer transition"
          >
            <div className="text-[11px] font-medium text-slate-500 uppercase">Active Total</div>
            <div className="text-2xl font-bold text-slate-900 mt-1">{activeEmployees.length}</div>
            <div className="text-[10px] text-blue-600 font-medium mt-1 flex items-center gap-0.5">
              View All <ChevronRight className="w-3 h-3" />
            </div>
          </div>
        );

      case 'total_present':
        return (
          <div 
            key="total_present"
            onClick={() => handleOpenDrilldown('total_present', 'Total Present Manpower', (emp, att) => !!att)}
            className="bg-emerald-50/70 p-3.5 rounded-xl border border-emerald-300 shadow-2xs hover:border-emerald-500 cursor-pointer transition"
          >
            <div className="text-[11px] font-semibold text-emerald-800 uppercase">Total Present</div>
            <div className="text-2xl font-bold text-emerald-700 mt-1">{presentCount}</div>
            <div className="text-[10px] text-emerald-600 font-medium mt-1">
              {expectedManpower > 0 ? `${Math.round((presentCount / expectedManpower) * 100)}% Avail` : '0%'}
            </div>
          </div>
        );

      case 'currently_inside':
        return (
          <div 
            key="currently_inside"
            onClick={() => handleOpenDrilldown('currently_inside', 'Currently Inside Factory', (emp, att) => !!att && (att.currentState === 'INSIDE' || (!att.actualPunchOut && att.punchOutType === 'NONE')))}
            className="bg-teal-50/70 p-3.5 rounded-xl border border-teal-300 shadow-2xs hover:border-teal-500 cursor-pointer transition"
          >
            <div className="text-[11px] font-semibold text-teal-800 uppercase flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-teal-500 animate-pulse"></span>
              Currently Inside
            </div>
            <div className="text-2xl font-bold text-teal-700 mt-1">{currentlyInsideCount}</div>
            <div className="text-[10px] text-teal-600 font-medium mt-1">On Factory Floor</div>
          </div>
        );

      case 'currently_outside':
        return (
          <div 
            key="currently_outside"
            onClick={() => handleOpenDrilldown('currently_outside', 'Currently Outside Factory', (emp, att) => !!att && (att.currentState === 'OUTSIDE' || !!att.actualPunchOut || att.punchOutType === 'ACTUAL'))}
            className="bg-slate-50 p-3.5 rounded-xl border border-slate-300 shadow-2xs hover:border-slate-500 cursor-pointer transition"
          >
            <div className="text-[11px] font-semibold text-slate-700 uppercase">Currently Outside</div>
            <div className="text-2xl font-bold text-slate-700 mt-1">{currentlyOutsideCount}</div>
            <div className="text-[10px] text-slate-500 font-medium mt-1">Punched Out / Exit</div>
          </div>
        );

      case 'absent':
        return (
          <div 
            key="absent"
            onClick={() => handleOpenDrilldown('absent', 'Absent Manpower', (emp, att) => !att)}
            className="bg-red-50/70 p-3.5 rounded-xl border border-red-300 shadow-2xs hover:border-red-500 cursor-pointer transition"
          >
            <div className="text-[11px] font-semibold text-red-800 uppercase">Absent</div>
            <div className="text-2xl font-bold text-red-700 mt-1">{absentCount}</div>
            <div className="text-[10px] text-red-600 font-medium mt-1">No Punches</div>
          </div>
        );

      case 'on_leave':
        return (
          <div 
            key="on_leave"
            onClick={() => handleOpenDrilldown('on_leave', 'Employees On Leave', (emp) => {
              const r = rosterMap.get(emp.employeeId);
              return r?.rosterStatus === 'LEAVE';
            })}
            className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-2xs hover:border-blue-400 cursor-pointer transition"
          >
            <div className="text-[11px] font-medium text-slate-500 uppercase">On Leave</div>
            <div className="text-2xl font-bold text-slate-700 mt-1">{leaveCount}</div>
            <div className="text-[10px] text-slate-500 mt-1">Sanctioned</div>
          </div>
        );

      case 'first_in':
        return (
          <div 
            key="first_in"
            onClick={() => handleOpenDrilldown('first_in', 'First Punch In Recorded', (emp, att) => !!(att?.firstPunchIn || att?.punchIn))}
            className="bg-emerald-50/50 p-3.5 rounded-xl border border-emerald-200 shadow-2xs hover:border-emerald-400 cursor-pointer transition"
          >
            <div className="text-[11px] font-semibold text-emerald-800 uppercase">First In</div>
            <div className="text-2xl font-bold text-emerald-700 mt-1">{firstInCount}</div>
            <div className="text-[10px] text-emerald-600 font-medium mt-1">Initial Entry Punch</div>
          </div>
        );

      case 'final_out':
        return (
          <div 
            key="final_out"
            onClick={() => handleOpenDrilldown('final_out', 'Final Punch Out Recorded', (emp, att) => !!(att?.lastPunchOut || att?.actualPunchOut))}
            className="bg-indigo-50/50 p-3.5 rounded-xl border border-indigo-200 shadow-2xs hover:border-indigo-400 cursor-pointer transition"
          >
            <div className="text-[11px] font-semibold text-indigo-800 uppercase">Final Out</div>
            <div className="text-2xl font-bold text-indigo-700 mt-1">{finalOutCount}</div>
            <div className="text-[10px] text-indigo-600 font-medium mt-1">Actual Exit Scanned</div>
          </div>
        );

      case 'duty_hours':
        return (
          <div 
            key="duty_hours"
            onClick={() => handleOpenDrilldown('duty_hours', 'Employees with Completed Duty', (emp, att) => (att?.totalDutyMinutes || att?.regularDutyMinutes || 0) > 0)}
            className="bg-blue-50/50 p-3.5 rounded-xl border border-blue-200 shadow-2xs hover:border-blue-400 cursor-pointer transition"
          >
            <div className="text-[11px] font-semibold text-blue-800 uppercase">Duty Hours</div>
            <div className="text-2xl font-bold text-blue-700 mt-1">
              {formatMinutes(totalDutyMinutes).replace(' Hours', '')}
            </div>
            <div className="text-[10px] text-blue-600 font-medium mt-1">Last Out - First In</div>
          </div>
        );

      case 'ot_hours':
        return (
          <div 
            key="ot_hours"
            onClick={() => handleOpenDrilldown('ot_hours', 'Employees with Overtime', (emp, att) => (att?.overtimeMinutes || 0) > 0)}
            className="bg-amber-50/50 p-3.5 rounded-xl border border-amber-200 shadow-2xs hover:border-amber-400 cursor-pointer transition"
          >
            <div className="text-[11px] font-semibold text-amber-800 uppercase">OT Hours</div>
            <div className="text-2xl font-bold text-amber-700 mt-1">
              {formatMinutes(totalOtMinutes).replace(' Hours', '')}
            </div>
            <div className="text-[10px] text-amber-600 font-medium mt-1">Beyond 08:30</div>
          </div>
        );

      case 'auto_closed':
        return (
          <div 
            key="auto_closed"
            onClick={() => handleOpenDrilldown('auto_closed', 'Auto-Closed Attendance', (emp, att) => att?.punchOutType === 'AUTO' || !!att?.autoClosed)}
            className="bg-purple-50/50 p-3.5 rounded-xl border border-purple-200 shadow-2xs hover:border-purple-400 cursor-pointer transition"
          >
            <div className="text-[11px] font-semibold text-purple-800 uppercase">Auto Closed</div>
            <div className="text-2xl font-bold text-purple-700 mt-1">{autoClosedCount}</div>
            <div className="text-[10px] text-purple-600 font-medium mt-1">Closed at Shift End</div>
          </div>
        );

      case 'missed_punch_out':
        return (
          <div 
            key="missed_punch_out"
            onClick={() => handleOpenDrilldown('missed_punch_out', 'Missed Punch Out', (emp, att) => !!att?.missedPunchOut || att?.attendanceStatus === 'MISSED PUNCH OUT')}
            className="bg-orange-50/50 p-3.5 rounded-xl border border-orange-200 shadow-2xs hover:border-orange-400 cursor-pointer transition"
          >
            <div className="text-[11px] font-semibold text-orange-800 uppercase">Missed Punch Out</div>
            <div className="text-2xl font-bold text-orange-700 mt-1">{missedPunchOutCount}</div>
            <div className="text-[10px] text-orange-600 font-medium mt-1">0 Overtime Flagged</div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="p-4 sm:p-6 bg-slate-50 min-h-full flex flex-col gap-6 transition-all duration-200 ease-in-out w-full relative">
      {/* Floating Exit Full Screen Button in Top-Right Corner */}
      {isFullscreen && onExitFullscreen && (
        <div className="fixed top-3 right-4 z-50 animate-fadeIn flex items-center gap-2 drop-shadow-md">
          <div className="hidden lg:flex items-center gap-1.5 bg-[#0a192f] text-white text-[11px] font-mono px-2.5 py-1.5 rounded-lg border border-slate-700 shadow-md">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            <span className="tracking-wide">FULL SCREEN MODE</span>
          </div>
          <button
            type="button"
            onClick={onExitFullscreen}
            className="flex items-center gap-1.5 bg-red-600 hover:bg-red-700 text-white font-bold text-xs px-3.5 py-1.5 rounded-lg shadow-xl border border-red-500 transition cursor-pointer"
            title="Exit Full Screen Mode (or press ESC)"
          >
            <Minimize2 className="w-3.5 h-3.5 text-white" />
            <span>Exit Full Screen</span>
            <kbd className="hidden sm:inline-block text-[10px] bg-red-800/80 px-1.5 py-0.2 rounded font-mono ml-0.5 font-normal">
              ESC
            </kbd>
          </button>
        </div>
      )}
      {/* Top Controls: Title, Filter Bar, Date Selector */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-xl font-bold text-slate-800 tracking-tight">MANPOWER DASHBOARD</h2>
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wider ${
              verifiedRole === 'SUPER_ADMIN'
                ? 'bg-red-100 text-red-700 border border-red-200'
                : verifiedRole === 'ADMIN'
                  ? 'bg-blue-100 text-blue-700 border border-blue-200'
                  : 'bg-emerald-100 text-emerald-700 border border-emerald-200'
            }`}>
              {verifiedRole === 'SUPER_ADMIN'
                ? 'Super Admin View (All 12 Cards)'
                : verifiedRole === 'ADMIN'
                  ? 'Admin View (All 12 Cards)'
                  : 'User View (Read-Only)'}
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            Real-time line, section and department manpower availability
          </p>
        </div>

        {/* Global Filter Toolbar */}
        <div className="flex flex-wrap items-center gap-2.5 text-xs">
          {/* Date Picker */}
          <div className="flex items-center gap-1.5 bg-slate-100 border border-slate-300 rounded px-2.5 py-1.5 font-medium text-slate-700">
            <Calendar className="w-3.5 h-3.5 text-blue-600" />
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="bg-transparent border-none text-xs text-slate-800 font-semibold focus:outline-hidden"
            />
          </div>

          {/* Shift Filter */}
          <select
            value={selectedShift}
            onChange={(e) => setSelectedShift(e.target.value)}
            className="bg-white border border-slate-300 rounded px-2.5 py-1.5 text-slate-700 font-medium focus:ring-1 focus:ring-blue-500"
          >
            <option value="ALL">All Shifts</option>
            {shifts.map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>

          {/* Line Filter */}
          <select
            value={selectedFloor}
            onChange={(e) => setSelectedFloor(e.target.value)}
            className="bg-white border border-slate-300 rounded px-2.5 py-1.5 text-slate-700 font-medium focus:ring-1 focus:ring-blue-500"
          >
            <option value="ALL">All Lines</option>
            {floors.map(f => (
              <option key={f.id} value={f.name}>{f.name}</option>
            ))}
          </select>

          {/* Section Filter */}
          <select
            value={selectedSection}
            onChange={(e) => setSelectedSection(e.target.value)}
            className="bg-white border border-slate-300 rounded px-2.5 py-1.5 text-slate-700 font-medium focus:ring-1 focus:ring-blue-500"
          >
            <option value="ALL">All Sections</option>
            {sections.map(s => (
              <option key={s.id} value={s.name}>{s.name}</option>
            ))}
          </select>

          {/* Department Filter */}
          <select
            value={selectedDept}
            onChange={(e) => setSelectedDept(e.target.value)}
            className="bg-white border border-slate-300 rounded px-2.5 py-1.5 text-slate-700 font-medium focus:ring-1 focus:ring-blue-500"
          >
            <option value="ALL">All Departments</option>
            {departments.map(d => (
              <option key={d.id} value={d.name}>{d.name}</option>
            ))}
          </select>

          {/* Employee Type Filter */}
          <select
            value={selectedType}
            onChange={(e) => setSelectedType(e.target.value)}
            className="bg-white border border-slate-300 rounded px-2.5 py-1.5 text-slate-700 font-medium focus:ring-1 focus:ring-blue-500"
          >
            <option value="ALL">All Types</option>
            <option value="Permanent">Permanent</option>
            <option value="Staff">Staff</option>
            <option value="Offroll">Offroll</option>
          </select>

          <button
            onClick={handleManualRefresh}
            className="p-1.5 rounded bg-slate-100 hover:bg-slate-200 text-slate-600 border border-slate-300 cursor-pointer transition"
            title="Refresh records"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>

          {/* Full Screen Mode Button */}
          {onToggleFullscreen && (
            <button
              type="button"
              onClick={isFullscreen ? onExitFullscreen : onToggleFullscreen}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold border transition cursor-pointer shadow-2xs ${
                isFullscreen
                  ? 'bg-red-50 text-red-700 border-red-300 hover:bg-red-100'
                  : 'bg-blue-50 text-blue-700 border-blue-300 hover:bg-blue-100 hover:text-blue-800'
              }`}
              title={isFullscreen ? 'Exit Full Screen Mode (ESC)' : 'Full Screen Dashboard Mode (Maximize screen width)'}
            >
              {isFullscreen ? (
                <>
                  <Minimize2 className="w-3.5 h-3.5 text-red-600 shrink-0" />
                  <span>Exit Full Screen</span>
                </>
              ) : (
                <>
                  <Maximize2 className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                  <span>Full Screen</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Automatic Shift Allocation Banner */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-blue-900 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2 shadow-2xs">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-blue-600 shrink-0" />
          <span>
            <strong>Automatic Shift Allocation Active:</strong> Shifts are identified automatically based on QR Punch-In time. (<strong>Day Shift:</strong> 09:00 AM – 08:00 PM | <strong>Night Shift:</strong> 08:00 PM – 09:00 AM next day).
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="inline-flex items-center gap-1 bg-white border border-blue-300 text-blue-700 font-mono text-[11px] px-2 py-0.5 rounded font-medium">
            <Clock className="w-3 h-3 text-blue-500" /> Auto-Closing: Enabled
          </span>
          {canOpenScanner && (
            <button
              onClick={onNavigateToScanner}
              className="bg-blue-600 hover:bg-blue-700 text-white font-medium px-2.5 py-1 rounded text-xs transition flex items-center gap-1 shadow-xs cursor-pointer"
            >
              Open Scanner
            </button>
          )}
        </div>
      </div>

      {/*
        REAL-TIME ATTENDANCE MONITORING CARDS
        - SUPER_ADMIN & ADMIN: All 12 KPIs across 2 rows of 6
        - USER (Read-Only): Strictly 6 permitted KPIs (Active Total, Total Present, Absent, Duty Hours, OT Hours, Missed Punch Out)
      */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {getPermittedCardIdsForRole(verifiedRole).map(cardId => (
          renderCard(cardId)
        ))}
      </div>

      {/* INDUSTRIAL BREAKDOWN TABLES (Floor, Section, Department, Employee Type) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* FLOOR-WISE REPORT */}
        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs">
          <div className="flex items-center justify-between pb-3 border-b border-slate-100">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-blue-600" />
              <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide">
                Line-Wise Manpower Availability
              </h3>
            </div>
            <span className="text-[11px] text-slate-400">MI-01, MI-02, FATP-STB, FATP-ITR, SMT-01</span>
          </div>

          <div className="overflow-x-auto mt-3">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-600 uppercase font-semibold border-y border-slate-200">
                <tr>
                  <th className="py-2.5 px-3">Production Line</th>
                  <th className="py-2.5 px-3 text-center">Active</th>
                  <th className="py-2.5 px-3 text-center text-emerald-700">Present</th>
                  <th className="py-2.5 px-3 text-center text-red-700">Absent</th>
                  <th className="py-2.5 px-3 text-right">Availability</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {floors.map(floor => {
                  const floorEmps = activeEmployees.filter(e => e.floor === floor.name);
                  const floorPresent = presentRecords.filter(a => a.floorIdSnapshot === floor.name).length;
                  const floorAbsent = Math.max(0, floorEmps.length - floorPresent);
                  const percent = floorEmps.length > 0 ? Math.round((floorPresent / floorEmps.length) * 100) : 0;

                  return (
                    <tr
                      key={floor.id}
                      onClick={() => handleOpenDrilldown('active_total', `${floor.name} Line Manpower`, (emp) => emp.floor === floor.name)}
                      className="hover:bg-blue-50/50 cursor-pointer transition font-medium"
                    >
                      <td className="py-2.5 px-3 font-semibold text-slate-800">{floor.name}</td>
                      <td className="py-2.5 px-3 text-center text-slate-600">{floorEmps.length}</td>
                      <td className="py-2.5 px-3 text-center font-bold text-emerald-600">{floorPresent}</td>
                      <td className="py-2.5 px-3 text-center font-bold text-red-600">{floorAbsent}</td>
                      <td className="py-2.5 px-3 text-right">
                        <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                          percent >= 80 ? 'bg-emerald-100 text-emerald-800' :
                          percent >= 50 ? 'bg-amber-100 text-amber-800' : 'bg-red-100 text-red-800'
                        }`}>
                          {percent}%
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* SECTION-WISE REPORT */}
        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs">
          <div className="flex items-center justify-between pb-3 border-b border-slate-100">
            <div className="flex items-center gap-2">
              <Network className="w-4 h-4 text-indigo-600" />
              <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide">
                Section-Wise Manpower Availability
              </h3>
            </div>
            <span className="text-[11px] text-slate-400">MI, SMT, FATP, STORE</span>
          </div>

          <div className="overflow-x-auto mt-3">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-600 uppercase font-semibold border-y border-slate-200">
                <tr>
                  <th className="py-2.5 px-3">Section</th>
                  <th className="py-2.5 px-3 text-center">Active</th>
                  <th className="py-2.5 px-3 text-center text-emerald-700">Present</th>
                  <th className="py-2.5 px-3 text-center text-red-700">Absent</th>
                  <th className="py-2.5 px-3 text-right">Availability</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sections.map(sec => {
                  const secEmps = activeEmployees.filter(e => e.section === sec.name);
                  const secPresent = presentRecords.filter(a => a.sectionIdSnapshot === sec.name).length;
                  const secAbsent = Math.max(0, secEmps.length - secPresent);
                  const percent = secEmps.length > 0 ? Math.round((secPresent / secEmps.length) * 100) : 0;

                  return (
                    <tr
                      key={sec.id}
                      onClick={() => handleOpenDrilldown('active_total', `${sec.name} Section Manpower`, (emp) => emp.section === sec.name)}
                      className="hover:bg-indigo-50/50 cursor-pointer transition font-medium"
                    >
                      <td className="py-2.5 px-3 font-semibold text-slate-800">{sec.name}</td>
                      <td className="py-2.5 px-3 text-center text-slate-600">{secEmps.length}</td>
                      <td className="py-2.5 px-3 text-center font-bold text-emerald-600">{secPresent}</td>
                      <td className="py-2.5 px-3 text-center font-bold text-red-600">{secAbsent}</td>
                      <td className="py-2.5 px-3 text-right">
                        <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                          percent >= 80 ? 'bg-emerald-100 text-emerald-800' :
                          percent >= 50 ? 'bg-amber-100 text-amber-800' : 'bg-red-100 text-red-800'
                        }`}>
                          {percent}%
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* DEPARTMENT-WISE REPORT */}
        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs">
          <div className="flex items-center justify-between pb-3 border-b border-slate-100">
            <div className="flex items-center gap-2">
              <Building2 className="w-4 h-4 text-cyan-600" />
              <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide">
                Department-Wise Manpower Availability
              </h3>
            </div>
            <span className="text-[11px] text-slate-400">Production, Quality, PPC, R&D...</span>
          </div>

          <div className="overflow-x-auto mt-3">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-600 uppercase font-semibold border-y border-slate-200">
                <tr>
                  <th className="py-2.5 px-3">Department</th>
                  <th className="py-2.5 px-3 text-center">Active</th>
                  <th className="py-2.5 px-3 text-center text-emerald-700">Present</th>
                  <th className="py-2.5 px-3 text-center text-red-700">Absent</th>
                  <th className="py-2.5 px-3 text-right">Availability</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {departments.map(dept => {
                  const deptEmps = activeEmployees.filter(e => e.department === dept.name);
                  const deptPresent = presentRecords.filter(a => a.departmentIdSnapshot === dept.name).length;
                  const deptAbsent = Math.max(0, deptEmps.length - deptPresent);
                  const percent = deptEmps.length > 0 ? Math.round((deptPresent / deptEmps.length) * 100) : 0;

                  return (
                    <tr
                      key={dept.id}
                      onClick={() => handleOpenDrilldown('active_total', `${dept.name} Dept Manpower`, (emp) => emp.department === dept.name)}
                      className="hover:bg-cyan-50/50 cursor-pointer transition font-medium"
                    >
                      <td className="py-2.5 px-3 font-semibold text-slate-800">{dept.name}</td>
                      <td className="py-2.5 px-3 text-center text-slate-600">{deptEmps.length}</td>
                      <td className="py-2.5 px-3 text-center font-bold text-emerald-600">{deptPresent}</td>
                      <td className="py-2.5 px-3 text-center font-bold text-red-600">{deptAbsent}</td>
                      <td className="py-2.5 px-3 text-right">
                        <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                          percent >= 80 ? 'bg-emerald-100 text-emerald-800' :
                          percent >= 50 ? 'bg-amber-100 text-amber-800' : 'bg-red-100 text-red-800'
                        }`}>
                          {percent}%
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* EMPLOYEE TYPE WISE REPORT */}
        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs">
          <div className="flex items-center justify-between pb-3 border-b border-slate-100">
            <div className="flex items-center gap-2">
              <Briefcase className="w-4 h-4 text-purple-600" />
              <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide">
                Employee-Type Manpower Availability
              </h3>
            </div>
            <span className="text-[11px] text-slate-400">Permanent, Staff, Offroll</span>
          </div>

          <div className="overflow-x-auto mt-3">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-600 uppercase font-semibold border-y border-slate-200">
                <tr>
                  <th className="py-2.5 px-3">Type</th>
                  <th className="py-2.5 px-3 text-center">Active</th>
                  <th className="py-2.5 px-3 text-center text-emerald-700">Present</th>
                  <th className="py-2.5 px-3 text-center text-red-700">Absent</th>
                  <th className="py-2.5 px-3 text-right">Availability</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(['Permanent', 'Staff', 'Offroll'] as const).map(type => {
                  const typeEmps = activeEmployees.filter(e => e.employeeType === type);
                  const typePresent = presentRecords.filter(a => a.employeeTypeSnapshot === type).length;
                  const typeAbsent = Math.max(0, typeEmps.length - typePresent);
                  const percent = typeEmps.length > 0 ? Math.round((typePresent / typeEmps.length) * 100) : 0;

                  return (
                    <tr
                      key={type}
                      onClick={() => handleOpenDrilldown('active_total', `${type} Employees List`, (emp) => emp.employeeType === type)}
                      className="hover:bg-purple-50/50 cursor-pointer transition font-medium"
                    >
                      <td className="py-2.5 px-3 font-semibold text-slate-800">{type}</td>
                      <td className="py-2.5 px-3 text-center text-slate-600">{typeEmps.length}</td>
                      <td className="py-2.5 px-3 text-center font-bold text-emerald-600">{typePresent}</td>
                      <td className="py-2.5 px-3 text-center font-bold text-red-600">{typeAbsent}</td>
                      <td className="py-2.5 px-3 text-right">
                        <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                          percent >= 80 ? 'bg-emerald-100 text-emerald-800' :
                          percent >= 50 ? 'bg-amber-100 text-amber-800' : 'bg-red-100 text-red-800'
                        }`}>
                          {percent}%
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* DRILLDOWN MODAL */}
      {drilldownTitle && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-xl max-w-4xl w-full max-h-[85vh] flex flex-col shadow-2xl border border-slate-200">
            <div className="p-4 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-slate-900">{drilldownTitle}</h3>
                <p className="text-xs text-slate-500">Showing {drilldownEmployees.length} employees</p>
              </div>
              <button
                onClick={() => setDrilldownTitle(null)}
                className="p-1 rounded hover:bg-slate-100 text-slate-500 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 flex-1 overflow-y-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-600 uppercase font-semibold border-y border-slate-200">
                  <tr>
                    <th className="py-2 px-3">Emp ID</th>
                    <th className="py-2 px-3">Name</th>
                    <th className="py-2 px-3">Line / Sec</th>
                    <th className="py-2 px-3">Department</th>
                    <th className="py-2 px-3">Type</th>
                    <th className="py-2 px-3">Status</th>
                    <th className="py-2 px-3 text-right">Duty / OT</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {drilldownEmployees.map(({ employee, attendance, status }) => {
                    return (
                      <tr key={employee.employeeId} className="hover:bg-slate-50">
                        <td className="py-2 px-3 font-mono font-bold text-slate-800">{employee.employeeId}</td>
                        <td className="py-2 px-3 font-medium text-slate-900">{employee.employeeName}</td>
                        <td className="py-2 px-3 text-slate-600">{employee.floor} • {employee.section}</td>
                        <td className="py-2 px-3 text-slate-600">{employee.department}</td>
                        <td className="py-2 px-3 text-slate-600">{employee.employeeType}</td>
                        <td className="py-2 px-3">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            status === 'PRESENT' || status === 'COMPLETED' ? 'bg-emerald-100 text-emerald-800' :
                            status === 'LATE' ? 'bg-amber-100 text-amber-800' :
                            status === 'MISSED PUNCH OUT' ? 'bg-orange-100 text-orange-800' :
                            'bg-red-100 text-red-800'
                          }`}>
                            {status}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-right font-mono text-[11px]">
                          {attendance ? (
                            <span>
                              {isDashboardCardVisible(verifiedRole, 'duty_hours') && (
                                <span>{formatMinutes(attendance.regularDutyMinutes).replace(' Hours', 'h')}</span>
                              )}
                              {attendance.overtimeMinutes > 0 && (
                                <span className="text-amber-600 ml-1">+{formatMinutes(attendance.overtimeMinutes).replace(' Hours', 'h')} OT</span>
                              )}
                              {!isDashboardCardVisible(verifiedRole, 'duty_hours') && attendance.overtimeMinutes <= 0 && (
                                <span className="text-slate-400">Recorded</span>
                              )}
                            </span>
                          ) : (
                            <span className="text-slate-400">--</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="p-3 border-t border-slate-200 bg-slate-50 flex justify-end">
              <button
                onClick={() => setDrilldownTitle(null)}
                className="bg-slate-200 hover:bg-slate-300 text-slate-800 text-xs px-4 py-2 rounded font-medium cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
