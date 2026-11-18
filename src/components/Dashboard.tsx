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
  formatDurationClock,
  getAttendanceStatusBadgeClasses,
  resolveAttendanceMetrics,
} from '../utils/attendanceStatus';
import { 
  DashboardCardId, 
  DashboardSectionId,
  resolveDashboardVisibility,
  normalizeUserRole 
} from '../config/dashboardCardsConfig';
import {
  RolePermissionRecord,
  UserPermissionRecordWithOverride,
  normalizeRoleId,
} from '../services/permissionService';
import { DashboardSkeleton } from './Skeletons';
import { recordPerfMetric } from '../utils/perfMonitor';

interface DashboardProps {
  employees: Employee[];
  shifts: Shift[];
  floors: Floor[];
  sections: Section[];
  departments: Department[];
  isLoadingMasterData?: boolean;
  masterDataError?: string | null;
  onNavigateToScanner: () => void;
  onNavigateToReports: () => void;
  onRefreshData?: () => void;
  currentUserRole?: UserRoleRecord | null;
  rolePermissions?: Record<string, RolePermissionRecord>;
  userPermissionOverride?: UserPermissionRecordWithOverride | null;
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
  isLoadingMasterData = false,
  masterDataError = null,
  onNavigateToScanner,
  onNavigateToReports,
  onRefreshData,
  currentUserRole,
  rolePermissions,
  userPermissionOverride,
  isFullscreen = false,
  onToggleFullscreen,
  onExitFullscreen,
}) => {
  // Authoritative Role Resolution directly from Firestore
  const [verifiedRole, setVerifiedRole] = useState<string>(() => {
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
  const [hasLoadedAttendance, setHasLoadedAttendance] = useState(false);
  const [attendanceError, setAttendanceError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const skeletonStartRef = React.useRef<number | null>(performance.now());

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
    setAttendanceError(null);
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
      setHasLoadedAttendance(true);
      setLoading(false);
    }, (err) => {
      console.error('[Dashboard] Real-time attendance error:', err);
      setAttendanceError(err?.message || 'Unable to synchronize attendance stream.');
      setLoading(false);
    });

    return () => unsubscribe();
  }, [selectedDate, selectedShift, retryNonce]);

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
    setRetryNonce((n) => n + 1);
    loadRosterData();
    if (onRefreshData) onRefreshData();
  };

  // O(1) employee lookup by employeeId
  const employeeByIdMap = useMemo(() => {
    const map = new Map<string, Employee>();
    for (const emp of employees) {
      map.set(emp.employeeId, emp);
    }
    return map;
  }, [employees]);

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

  // O(N + M) Present records + single-pass KPI & breakdown aggregations
  const presentRecords = useMemo(() => {
    return attendanceRecords.filter(a => {
      if (!employeeByIdMap.has(a.employeeId)) return false;
      if (selectedFloor !== 'ALL' && a.floorIdSnapshot !== selectedFloor) return false;
      if (selectedSection !== 'ALL' && a.sectionIdSnapshot !== selectedSection) return false;
      if (selectedDept !== 'ALL' && a.departmentIdSnapshot !== selectedDept) return false;
      if (selectedType !== 'ALL' && a.employeeTypeSnapshot !== selectedType) return false;
      return true;
    });
  }, [attendanceRecords, employeeByIdMap, selectedFloor, selectedSection, selectedDept, selectedType]);

  const dashboardMetrics = useMemo(() => {
    let firstInCount = 0;
    let finalOutCount = 0;
    let currentlyInsideCount = 0;
    let currentlyOutsideCount = 0;
    let autoClosedCount = 0;
    let missedPunchOutCount = 0;
    let totalDutyMinutes = 0;
    let totalOtMinutes = 0;

    const floorPresentCounts = new Map<string, number>();
    const sectionPresentCounts = new Map<string, number>();
    const deptPresentCounts = new Map<string, number>();
    const typePresentCounts = new Map<string, number>();

    for (const a of presentRecords) {
      if (a.firstPunchIn || a.punchIn) firstInCount++;
      if (a.lastPunchOut || a.actualPunchOut) finalOutCount++;
      if (a.currentState === 'INSIDE' || (!a.actualPunchOut && a.punchOutType === 'NONE')) {
        currentlyInsideCount++;
      }
      if (a.currentState === 'OUTSIDE' || !!a.actualPunchOut || a.punchOutType === 'ACTUAL') {
        currentlyOutsideCount++;
      }
      if (a.punchOutType === 'AUTO' || a.autoClosed) autoClosedCount++;
      if (a.missedPunchOut || a.attendanceStatus === 'MISSED PUNCH OUT' || a.punchOutType === 'AUTO') {
        missedPunchOutCount++;
      }
      const resolved = resolveAttendanceMetrics(a);
      if (!resolved.isOpen) {
        totalDutyMinutes += resolved.completedDutyMinutes;
        totalOtMinutes += resolved.overtimeMinutes;
      }

      if (a.floorIdSnapshot) {
        floorPresentCounts.set(a.floorIdSnapshot, (floorPresentCounts.get(a.floorIdSnapshot) || 0) + 1);
      }
      if (a.sectionIdSnapshot) {
        sectionPresentCounts.set(a.sectionIdSnapshot, (sectionPresentCounts.get(a.sectionIdSnapshot) || 0) + 1);
      }
      if (a.departmentIdSnapshot) {
        deptPresentCounts.set(a.departmentIdSnapshot, (deptPresentCounts.get(a.departmentIdSnapshot) || 0) + 1);
      }
      if (a.employeeTypeSnapshot) {
        typePresentCounts.set(a.employeeTypeSnapshot, (typePresentCounts.get(a.employeeTypeSnapshot) || 0) + 1);
      }
    }

    const floorActiveCounts = new Map<string, number>();
    const sectionActiveCounts = new Map<string, number>();
    const deptActiveCounts = new Map<string, number>();
    const typeActiveCounts = new Map<string, number>();

    for (const emp of activeEmployees) {
      if (emp.floor) floorActiveCounts.set(emp.floor, (floorActiveCounts.get(emp.floor) || 0) + 1);
      if (emp.section) sectionActiveCounts.set(emp.section, (sectionActiveCounts.get(emp.section) || 0) + 1);
      if (emp.department) deptActiveCounts.set(emp.department, (deptActiveCounts.get(emp.department) || 0) + 1);
      if (emp.employeeType) typeActiveCounts.set(emp.employeeType, (typeActiveCounts.get(emp.employeeType) || 0) + 1);
    }

    return {
      firstInCount,
      finalOutCount,
      currentlyInsideCount,
      currentlyOutsideCount,
      autoClosedCount,
      missedPunchOutCount,
      totalDutyMinutes,
      totalOtMinutes,
      floorActiveCounts,
      floorPresentCounts,
      sectionActiveCounts,
      sectionPresentCounts,
      deptActiveCounts,
      deptPresentCounts,
      typeActiveCounts,
      typePresentCounts,
    };
  }, [presentRecords, activeEmployees]);

  const {
    firstInCount,
    finalOutCount,
    currentlyInsideCount,
    currentlyOutsideCount,
    autoClosedCount,
    missedPunchOutCount,
    totalDutyMinutes,
    totalOtMinutes,
    floorActiveCounts,
    floorPresentCounts,
    sectionActiveCounts,
    sectionPresentCounts,
    deptActiveCounts,
    deptPresentCounts,
    typeActiveCounts,
    typePresentCounts,
  } = dashboardMetrics;

  // Expected manpower calculation from Roster (single pass)
  const { isRosterConfigured, scheduledCount, leaveCount } = useMemo(() => {
    let scheduled = 0;
    let leave = 0;
    for (const r of rosterRecords) {
      if (r.rosterStatus === 'SCHEDULED') scheduled++;
      else if (r.rosterStatus === 'LEAVE') leave++;
    }
    return {
      isRosterConfigured: rosterRecords.length > 0,
      scheduledCount: scheduled,
      leaveCount: leave,
    };
  }, [rosterRecords]);

  const expectedManpower = isRosterConfigured
    ? Math.max(0, scheduledCount)
    : activeEmployees.length;

  const presentCount = presentRecords.length;
  const absentCount = isRosterConfigured
    ? Math.max(0, expectedManpower - presentCount)
    : Math.max(0, activeEmployees.length - presentCount);

  const activeRoleModulePerms = rolePermissions?.[normalizeRoleId(verifiedRole)]?.modulePermissions || null;
  const resolvedVisibility = resolveDashboardVisibility({
    role: verifiedRole,
    modulesAllowed: currentUserRole?.modulesAllowed,
    rolePermissions: activeRoleModulePerms,
    userPermissionOverride,
  });
  const permittedCardIds = resolvedVisibility.permittedCards;
  const visibleCardSet = new Set<DashboardCardId>(permittedCardIds);
  const visibleSectionSet = new Set<DashboardSectionId>(resolvedVisibility.permittedSections);
  const canShowDutyHours = visibleCardSet.has('duty_hours');
  const canShowOtHours = visibleCardSet.has('ot_hours');

  // Protected Drilldown handler
  const handleOpenDrilldown = (
    source: { type: 'card'; cardId: DashboardCardId } | { type: 'section'; sectionId: DashboardSectionId },
    title: string,
    filterFn: (emp: Employee, att?: AttendanceRecord) => boolean
  ) => {
    // Role Authorization Check: block drilldown if card/section is hidden for this role
    const isAuthorized =
      source.type === 'card'
        ? visibleCardSet.has(source.cardId)
        : visibleSectionSet.has(source.sectionId);
    if (!isAuthorized) {
      const targetId = source.type === 'card' ? source.cardId : source.sectionId;
      console.warn(`[Security] Drilldown for ${targetId} is unauthorized for role ${verifiedRole}`);
      return;
    }

    const list = activeEmployees
      .map(emp => {
        const att = attendanceMap.get(emp.employeeId);
        let status = 'ABSENT';
        if (att) {
          status = resolveAttendanceMetrics(att).status;
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
            onClick={() => handleOpenDrilldown({ type: 'card', cardId: 'active_total' }, 'Total Active Manpower', (emp) => emp.employeeStatus === 'Active')}
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
            onClick={() => handleOpenDrilldown({ type: 'card', cardId: 'total_present' }, 'Total Present Manpower', (emp, att) => !!att)}
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
            onClick={() => handleOpenDrilldown({ type: 'card', cardId: 'currently_inside' }, 'Currently Inside Factory', (emp, att) => !!att && (att.currentState === 'INSIDE' || (!att.actualPunchOut && att.punchOutType === 'NONE')))}
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
            onClick={() => handleOpenDrilldown({ type: 'card', cardId: 'currently_outside' }, 'Currently Outside Factory', (emp, att) => !!att && (att.currentState === 'OUTSIDE' || !!att.actualPunchOut || att.punchOutType === 'ACTUAL'))}
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
            onClick={() => handleOpenDrilldown({ type: 'card', cardId: 'absent' }, 'Absent Manpower', (emp, att) => !att)}
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
            onClick={() => handleOpenDrilldown({ type: 'card', cardId: 'on_leave' }, 'Employees On Leave', (emp) => {
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
            onClick={() => handleOpenDrilldown({ type: 'card', cardId: 'first_in' }, 'First Punch In Recorded', (emp, att) => !!(att?.firstPunchIn || att?.punchIn))}
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
            onClick={() => handleOpenDrilldown({ type: 'card', cardId: 'final_out' }, 'Final Punch Out Recorded', (emp, att) => !!(att?.lastPunchOut || att?.actualPunchOut))}
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
            onClick={() => handleOpenDrilldown({ type: 'card', cardId: 'duty_hours' }, 'Employees with Completed Duty', (emp, att) => {
              if (!att) return false;
              const m = resolveAttendanceMetrics(att);
              return !m.isOpen && m.completedDutyMinutes > 0;
            })}
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
            onClick={() => handleOpenDrilldown({ type: 'card', cardId: 'ot_hours' }, 'Employees with Overtime', (emp, att) => !!att && resolveAttendanceMetrics(att).overtimeMinutes > 0)}
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
            onClick={() => handleOpenDrilldown({ type: 'card', cardId: 'auto_closed' }, 'Auto-Closed Attendance', (emp, att) => att?.punchOutType === 'AUTO' || !!att?.autoClosed)}
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
            onClick={() => handleOpenDrilldown({ type: 'card', cardId: 'missed_punch_out' }, 'Missed Punch Out', (emp, att) => !!att?.missedPunchOut || att?.attendanceStatus === 'MISSED PUNCH OUT')}
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

  const showInitialSkeleton =
    (loading || isLoadingMasterData) &&
    !hasLoadedAttendance &&
    employees.length === 0 &&
    attendanceRecords.length === 0 &&
    !attendanceError &&
    !masterDataError;

  useEffect(() => {
    if (!showInitialSkeleton && skeletonStartRef.current !== null) {
      recordPerfMetric('skeleton_visible_ms', performance.now() - skeletonStartRef.current);
      skeletonStartRef.current = null;
    }
  }, [showInitialSkeleton]);

  if (showInitialSkeleton) {
    return <DashboardSkeleton cardCount={permittedCardIds.length || 6} />;
  }

  const combinedError = attendanceError || masterDataError;

  return (
    <div className="p-4 sm:p-6 bg-slate-50 min-h-full flex flex-col gap-6 transition-all duration-200 ease-in-out w-full relative">
      {combinedError && (
        <div
          role="alert"
          className="bg-red-50 border border-red-200 text-red-800 rounded-xl px-4 py-3 text-xs flex flex-wrap items-center justify-between gap-3"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
            <span>{combinedError}</span>
          </div>
          <button
            type="button"
            onClick={handleManualRefresh}
            className="bg-white hover:bg-red-100 text-red-700 border border-red-300 px-3 py-1 rounded font-semibold transition cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}
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
                  : verifiedRole === 'USER'
                    ? 'bg-emerald-100 text-emerald-700 border border-emerald-200'
                    : 'bg-indigo-100 text-indigo-700 border border-indigo-200'
            }`}>
              {verifiedRole === 'SUPER_ADMIN'
                ? 'Super Admin View (All 12 Cards)'
                : verifiedRole === 'ADMIN'
                  ? permittedCardIds.length === 12
                    ? 'Admin View (All 12 Cards)'
                    : `Admin View (${permittedCardIds.length} Cards)`
                  : verifiedRole === 'USER'
                    ? permittedCardIds.length === 6 && visibleSectionSet.size === 5
                      ? 'User View (Read-Only)'
                      : `User View (${permittedCardIds.length} Cards)`
                    : `${verifiedRole.replace(/_/g, ' ')} View (${permittedCardIds.length} Cards)`}
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
      {visibleSectionSet.has('shift_banner') && (
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
      )}

      {/* REAL-TIME ATTENDANCE MONITORING CARDS (Filtered dynamically by Role / User Visibility Permissions) */}
      {permittedCardIds.length > 0 && (
        <div
          className={
            permittedCardIds.length === 1
              ? 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3'
              : permittedCardIds.length === 2
                ? 'grid grid-cols-1 sm:grid-cols-2 gap-3'
                : permittedCardIds.length <= 4
                  ? 'grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3'
                  : 'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3'
          }
        >
          {permittedCardIds.map(cardId => renderCard(cardId))}
        </div>
      )}

      {/* INDUSTRIAL BREAKDOWN TABLES (Floor, Section, Department, Employee Type) */}
      {(() => {
        const visibleBreakdownCount = (
          ['line_wise', 'section_wise', 'department_wise', 'employee_type_wise'] as DashboardSectionId[]
        ).filter((id) => visibleSectionSet.has(id)).length;

        if (permittedCardIds.length === 0 && visibleSectionSet.size === 0) {
          return (
            <div className="bg-white rounded-xl border border-slate-200 p-8 text-center shadow-2xs">
              <ShieldAlert className="w-8 h-8 text-slate-400 mx-auto mb-2" />
              <h3 className="text-sm font-bold text-slate-800">No Dashboard Cards or Sections Enabled</h3>
              <p className="text-xs text-slate-500 mt-1">
                Dashboard KPI cards and breakdown sections are currently hidden for your role. Contact Super Admin if access is required.
              </p>
            </div>
          );
        }

        if (visibleBreakdownCount === 0) {
          return null;
        }

        return (
          <div className={visibleBreakdownCount === 1 ? 'grid grid-cols-1 gap-6' : 'grid grid-cols-1 lg:grid-cols-2 gap-6'}>
        {/* FLOOR-WISE REPORT */}
        {visibleSectionSet.has('line_wise') && (
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
                  const floorActive = floorActiveCounts.get(floor.name) || 0;
                  const floorPresent = floorPresentCounts.get(floor.name) || 0;
                  const floorAbsent = Math.max(0, floorActive - floorPresent);
                  const percent = floorActive > 0 ? Math.round((floorPresent / floorActive) * 100) : 0;

                  return (
                    <tr
                      key={floor.id}
                      onClick={() => handleOpenDrilldown({ type: 'section', sectionId: 'line_wise' }, `${floor.name} Line Manpower`, (emp) => emp.floor === floor.name)}
                      className="hover:bg-blue-50/50 cursor-pointer transition font-medium"
                    >
                      <td className="py-2.5 px-3 font-semibold text-slate-800">{floor.name}</td>
                      <td className="py-2.5 px-3 text-center text-slate-600">{floorActive}</td>
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
        )}

        {/* SECTION-WISE REPORT */}
        {visibleSectionSet.has('section_wise') && (
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
                  const secActive = sectionActiveCounts.get(sec.name) || 0;
                  const secPresent = sectionPresentCounts.get(sec.name) || 0;
                  const secAbsent = Math.max(0, secActive - secPresent);
                  const percent = secActive > 0 ? Math.round((secPresent / secActive) * 100) : 0;

                  return (
                    <tr
                      key={sec.id}
                      onClick={() => handleOpenDrilldown({ type: 'section', sectionId: 'section_wise' }, `${sec.name} Section Manpower`, (emp) => emp.section === sec.name)}
                      className="hover:bg-indigo-50/50 cursor-pointer transition font-medium"
                    >
                      <td className="py-2.5 px-3 font-semibold text-slate-800">{sec.name}</td>
                      <td className="py-2.5 px-3 text-center text-slate-600">{secActive}</td>
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
        )}

        {/* DEPARTMENT-WISE REPORT */}
        {visibleSectionSet.has('department_wise') && (
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
                  const deptActive = deptActiveCounts.get(dept.name) || 0;
                  const deptPresent = deptPresentCounts.get(dept.name) || 0;
                  const deptAbsent = Math.max(0, deptActive - deptPresent);
                  const percent = deptActive > 0 ? Math.round((deptPresent / deptActive) * 100) : 0;

                  return (
                    <tr
                      key={dept.id}
                      onClick={() => handleOpenDrilldown({ type: 'section', sectionId: 'department_wise' }, `${dept.name} Dept Manpower`, (emp) => emp.department === dept.name)}
                      className="hover:bg-cyan-50/50 cursor-pointer transition font-medium"
                    >
                      <td className="py-2.5 px-3 font-semibold text-slate-800">{dept.name}</td>
                      <td className="py-2.5 px-3 text-center text-slate-600">{deptActive}</td>
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
        )}

        {/* EMPLOYEE TYPE WISE REPORT */}
        {visibleSectionSet.has('employee_type_wise') && (
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
                  const typeActive = typeActiveCounts.get(type) || 0;
                  const typePresent = typePresentCounts.get(type) || 0;
                  const typeAbsent = Math.max(0, typeActive - typePresent);
                  const percent = typeActive > 0 ? Math.round((typePresent / typeActive) * 100) : 0;

                  return (
                    <tr
                      key={type}
                      onClick={() => handleOpenDrilldown({ type: 'section', sectionId: 'employee_type_wise' }, `${type} Employees List`, (emp) => emp.employeeType === type)}
                      className="hover:bg-purple-50/50 cursor-pointer transition font-medium"
                    >
                      <td className="py-2.5 px-3 font-semibold text-slate-800">{type}</td>
                      <td className="py-2.5 px-3 text-center text-slate-600">{typeActive}</td>
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
        )}
          </div>
        );
      })()}

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
                    <th className="py-2 px-3 text-right">
                      {canShowDutyHours && canShowOtHours
                        ? 'Duty / OT'
                        : canShowDutyHours
                          ? 'Duty'
                          : canShowOtHours
                            ? 'OT'
                            : 'Attendance'}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {drilldownEmployees.map(({ employee, attendance, status }) => {
                    const resolved = attendance ? resolveAttendanceMetrics(attendance) : null;
                    return (
                      <tr key={employee.employeeId} className="hover:bg-slate-50">
                        <td className="py-2 px-3 font-mono font-bold text-slate-800">{employee.employeeId}</td>
                        <td className="py-2 px-3 font-medium text-slate-900">{employee.employeeName}</td>
                        <td className="py-2 px-3 text-slate-600">{employee.floor} • {employee.section}</td>
                        <td className="py-2 px-3 text-slate-600">{employee.department}</td>
                        <td className="py-2 px-3 text-slate-600">{employee.employeeType}</td>
                        <td className="py-2 px-3">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${getAttendanceStatusBadgeClasses(status)}`}>
                            {status}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-right font-mono text-[11px]">
                          {attendance && resolved ? (
                            resolved.isOpen ? (
                              <span className="text-sky-700">
                                {canShowDutyHours ? `In Progress (${formatDurationClock(resolved.accumulatedDutyMinutes)})` : 'INSIDE'}
                              </span>
                            ) : (
                              <span>
                                {canShowDutyHours && (
                                  <span>{formatDurationClock(resolved.completedDutyMinutes)}h</span>
                                )}
                                {canShowOtHours && resolved.overtimeMinutes > 0 && (
                                  <span className={`text-indigo-700 font-bold ${canShowDutyHours ? 'ml-1.5' : ''}`}>
                                    ({resolved.otLabel})
                                  </span>
                                )}
                                {!canShowDutyHours && (!canShowOtHours || resolved.overtimeMinutes <= 0) && (
                                  <span className="text-slate-400">Recorded</span>
                                )}
                              </span>
                            )
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
