import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import {
  type AdminFirestoreLike,
  type VerifiedCaller,
  recordEnterpriseAuditEvent,
} from './serverSecurityAudit.ts';
import {
  getCachedRolePermissionsDoc,
  getCachedShifts,
  getCachedSystemSettings,
} from './serverPerfCache.ts';
import type { AttendanceRecord, Employee, Shift, ShiftRoster } from './src/types/index.ts';
import {
  formatDurationClock,
  formatIsoTimeKolkata12h,
  resolveAttendanceMetrics,
  STANDARD_DUTY_MINUTES,
} from './src/utils/attendanceStatus.ts';
import {
  type AbsentManpowerRow,
  type ApprovedLeaveRecord,
  type ClassificationContext,
  type HolidayRecord,
  type SchedulePolicyConfig,
  buildEmployeeMonthlyCalendar,
  buildSafeEmployeeProfile,
  classifyEmployeeDay,
  computeConsecutiveAbsenceMetrics,
  enumerateDateRangeKeys,
  enumerateMonthDateKeys,
  getDaysInMonth,
  getTodayIstDateKey,
  isValidDateKey,
  shiftDateKeyByDays,
} from './src/utils/attendanceCalendarEngine.ts';

export interface AttendanceHistoryRouterDeps {
  db: AdminFirestoreLike;
  requireVerifiedCaller: (
    req: Request,
    res: Response,
    allowedRoles: string[] | '*',
    actionLabel: string
  ) => Promise<VerifiedCaller | null>;
  nowProvider?: () => number;
}

const DEFAULT_SHIFTS: Shift[] = [
  {
    id: 'DAY',
    name: 'DAY SHIFT',
    startTime: '09:00',
    endTime: '17:30',
    scheduledDurationMinutes: 510,
    punchInWindowStart: '06:00',
    punchInWindowEnd: '18:00',
    isOvernight: false,
    gracePeriodMinutes: 15,
    status: 'Active',
  },
  {
    id: 'NIGHT',
    name: 'NIGHT SHIFT',
    startTime: '20:00',
    endTime: '04:30',
    scheduledDurationMinutes: 510,
    punchInWindowStart: '18:00',
    punchInWindowEnd: '06:00',
    isOvernight: true,
    gracePeriodMinutes: 15,
    status: 'Active',
  },
];

// ============================================================================
// Server-Side RBAC Guard (Independent of Frontend Visibility)
// ============================================================================

async function callerCanViewAttendanceHistory(
  db: AdminFirestoreLike,
  caller: VerifiedCaller
): Promise<boolean> {
  if (caller.role === 'super_admin') return true;

  try {
    const [userPermSnap, rolePermSnap] = await Promise.all([
      db.collection('user_permissions').doc(caller.profileDocId).get(),
      getCachedRolePermissionsDoc(db, caller.role),
    ]);
    const userPermData = userPermSnap.exists ? userPermSnap.data() : undefined;
    const rolePermData = rolePermSnap.exists ? rolePermSnap.data : undefined;

    const checkModule = (moduleKey: string): boolean | null => {
      if (userPermData && userPermData.isCustomOverride !== false) {
        const mod = userPermData.permissions?.[moduleKey];
        if (mod && typeof mod.view === 'boolean') return mod.view === true;
      }
      if (rolePermData) {
        const mod = rolePermData.modulePermissions?.[moduleKey];
        if (mod && typeof mod.view === 'boolean') return mod.view === true;
      }
      return null;
    };

    const historyDecision = checkModule('history');
    if (historyDecision === true) return true;

    const reportsDecision = checkModule('reports');
    if (reportsDecision === true) return true;

    // If explicitly denied in role/user permissions, enforce denial even for admin
    if (historyDecision === false) {
      return false;
    }

    if (caller.role === 'admin') {
      return historyDecision !== false;
    }

    // Fallback to modulesAllowed array on user_roles
    let fallbackModules = caller.modulesAllowed;
    if (fallbackModules === undefined) {
      const userSnap = await db.collection('user_roles').doc(caller.profileDocId).get();
      if (userSnap.exists && Array.isArray(userSnap.data()?.modulesAllowed)) {
        fallbackModules = userSnap.data()!.modulesAllowed;
      }
    }
    if (Array.isArray(fallbackModules)) {
      return (
        fallbackModules.includes('all') ||
        fallbackModules.includes('history') ||
        fallbackModules.includes('reports')
      );
    }

    return false;
  } catch (err) {
    console.error('[AttendanceHistory RBAC] Permission lookup error:', err);
    return caller.role === 'admin';
  }
}

async function requireHistoryReadCaller(
  db: AdminFirestoreLike,
  requireVerifiedCaller: AttendanceHistoryRouterDeps['requireVerifiedCaller'],
  req: Request,
  res: Response,
  actionLabel: string
): Promise<VerifiedCaller | null> {
  const caller = await requireVerifiedCaller(req, res, '*', actionLabel);
  if (!caller) return null;

  const allowed = await callerCanViewAttendanceHistory(db, caller);
  if (!allowed) {
    await recordEnterpriseAuditEvent(db, {
      req,
      action: 'unauthorized_access_attempt',
      category: 'SECURITY',
      severity: 'CRITICAL',
      actorUid: caller.uid,
      actorLoginId: caller.loginId,
      actorRole: caller.role.toUpperCase(),
      targetType: 'ATTENDANCE_HISTORY',
      targetId: req.path,
      actionSource: 'ATTENDANCE_HISTORY_RBAC',
      description: `Unauthorized attempt to access ${actionLabel} by "${caller.loginId}" (${caller.role}).`,
      success: false,
    });
    res.status(403).json({
      success: false,
      error: `Forbidden: Role "${caller.role.toUpperCase()}" does not have permission to view Attendance History.`,
    });
    return null;
  }
  return caller;
}

// ============================================================================
// Firestore Bounded Range Data Loaders
// ============================================================================

async function safeGetCollectionDocs<T = Record<string, any>>(
  db: AdminFirestoreLike,
  collectionName: string
): Promise<T[]> {
  try {
    const snap = await db.collection(collectionName).get();
    return snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as T[];
  } catch {
    return [];
  }
}

async function loadBoundedClassificationData(
  db: AdminFirestoreLike,
  rangeStart: string,
  rangeEnd: string,
  nowMs: number,
  options?: { employeeId?: string }
): Promise<{
  employees: (Employee & Record<string, any>)[];
  attendanceRecords: AttendanceRecord[];
  ctx: ClassificationContext;
  shifts: Shift[];
}> {
  const todayIstKey = getTodayIstDateKey(nowMs);

  const empPromise = options?.employeeId
    ? db
        .collection('employees')
        .where('employeeId', '==', options.employeeId)
        .get()
        .then(async (snap) => {
          if (!snap.empty) {
            return snap.docs.map((d) => d.data() as Employee & Record<string, any>);
          }
          const byDoc = await db.collection('employees').doc(options.employeeId!).get();
          return byDoc.exists ? [byDoc.data() as Employee & Record<string, any>] : [];
        })
    : db
        .collection('employees')
        .get()
        .then((snap) => snap.docs.map((d) => d.data() as Employee & Record<string, any>));

  const attQuery = options?.employeeId
    ? db
        .collection('attendance')
        .where('employeeId', '==', options.employeeId)
        .where('shiftDate', '>=', rangeStart)
        .where('shiftDate', '<=', rangeEnd)
        .get()
    : db
        .collection('attendance')
        .where('shiftDate', '>=', rangeStart)
        .where('shiftDate', '<=', rangeEnd)
        .get();

  const rosterQuery = options?.employeeId
    ? db
        .collection('shift_rosters')
        .where('employeeId', '==', options.employeeId)
        .where('shiftDate', '>=', rangeStart)
        .where('shiftDate', '<=', rangeEnd)
        .get()
    : db
        .collection('shift_rosters')
        .where('shiftDate', '>=', rangeStart)
        .where('shiftDate', '<=', rangeEnd)
        .get();

  const [employees, attSnap, rosterSnap, cachedShiftsRes, settingsRes, holidayDocs, leaveDocs] =
    await Promise.all([
      empPromise,
      attQuery,
      rosterQuery,
      getCachedShifts(db, DEFAULT_SHIFTS),
      getCachedSystemSettings(db, {}),
      safeGetCollectionDocs<Record<string, any>>(db, 'holidays'),
      safeGetCollectionDocs<Record<string, any>>(db, 'leaves'),
    ]);

  const rawShifts: Shift[] =
    Array.isArray(cachedShiftsRes?.shifts) && cachedShiftsRes.shifts.length > 0
      ? (cachedShiftsRes.shifts as Shift[])
      : DEFAULT_SHIFTS;

  const settings = settingsRes?.data || {};

  const shiftsById = new Map<string, Shift>();
  for (const s of rawShifts) {
    if (s?.id) shiftsById.set(String(s.id).toUpperCase(), s);
  }

  // Build Schedule Policy from system_settings/global
  const weeklyOffDays: number[] = Array.isArray((settings as any)?.weeklyOffDays)
    ? (settings as any).weeklyOffDays
        .map((n: any) => Number(n))
        .filter((n: number) => Number.isInteger(n) && n >= 0 && n <= 6)
    : [0]; // Default factory policy: Sunday weekly off

  const schedulePolicyMode: 'DEFAULT_WEEKLY' | 'ROSTER_ONLY' =
    String((settings as any)?.schedulePolicyMode || '').toUpperCase() === 'ROSTER_ONLY'
      ? 'ROSTER_ONLY'
      : 'DEFAULT_WEEKLY';

  const policy: SchedulePolicyConfig = {
    weeklyOffDays,
    schedulePolicyMode,
    scheduleUnverified: Boolean((settings as any)?.scheduleUnverified),
    defaultShiftId: String((settings as any)?.defaultShiftId || 'DAY').toUpperCase(),
  };

  // Holidays from collection + optional system_settings.holidays
  const holidaysByDate = new Map<string, HolidayRecord>();
  for (const h of holidayDocs) {
    if (String(h.status || 'Active').toLowerCase() === 'inactive') continue;
    const dKey = String(h.date || h.holidayDate || '').trim();
    if (isValidDateKey(dKey)) {
      holidaysByDate.set(dKey, {
        date: dKey,
        name: String(h.name || h.title || 'Declared Holiday').trim(),
        description: h.description ? String(h.description) : undefined,
        status: 'Active',
      });
    }
  }
  if (Array.isArray((settings as any)?.holidays)) {
    for (const h of (settings as any).holidays) {
      const dKey = String(h?.date || '').trim();
      if (isValidDateKey(dKey) && !holidaysByDate.has(dKey)) {
        holidaysByDate.set(dKey, {
          date: dKey,
          name: String(h?.name || 'Declared Holiday').trim(),
        });
      }
    }
  }

  // Rosters keyed by `${employeeId}__${shiftDate}`
  const rostersByEmpDate = new Map<string, ShiftRoster>();
  const inferredShiftByEmp = new Map<string, string>();
  for (const doc of rosterSnap.docs) {
    const r = doc.data() as ShiftRoster;
    if (r?.employeeId && r?.shiftDate) {
      rostersByEmpDate.set(`${r.employeeId}__${r.shiftDate}`, r);
      if (r.shiftId) {
        inferredShiftByEmp.set(r.employeeId, String(r.shiftId).toUpperCase());
      }
    }
  }

  // Leaves keyed by employeeId
  const leavesByEmp = new Map<string, ApprovedLeaveRecord[]>();
  for (const lv of leaveDocs) {
    const empId = String(lv.employeeId || '').trim();
    const startDate = String(lv.startDate || lv.date || '').trim();
    const endDate = String(lv.endDate || lv.startDate || lv.date || '').trim();
    if (!empId || !isValidDateKey(startDate) || !isValidDateKey(endDate)) continue;
    const status = String(lv.status || 'APPROVED').trim().toUpperCase();
    if (status !== 'APPROVED' && status !== 'SANCTIONED') continue;
    const arr = leavesByEmp.get(empId) || [];
    arr.push({
      id: lv.id,
      employeeId: empId,
      startDate,
      endDate,
      leaveType: lv.leaveType ? String(lv.leaveType) : 'Approved Leave',
      reason: lv.reason ? String(lv.reason) : undefined,
      status,
    });
    leavesByEmp.set(empId, arr);
  }

  // Attendance keyed by `${employeeId}__${shiftDate}` (keep latest updated if duplicate docs exist)
  const attendanceRecords: AttendanceRecord[] = attSnap.docs.map(
    (d) => ({ id: d.id, ...(d.data() as any) }) as AttendanceRecord
  );
  const attendanceByEmpDate = new Map<string, AttendanceRecord>();
  const latestShiftDateByEmp = new Map<string, string>();

  for (const rec of attendanceRecords) {
    if (!rec?.employeeId || !rec?.shiftDate) continue;
    const k = `${rec.employeeId}__${rec.shiftDate}`;
    const existing = attendanceByEmpDate.get(k);
    if (!existing || String(rec.updatedAt || '') >= String(existing.updatedAt || '')) {
      attendanceByEmpDate.set(k, rec);
    }
    const prevDate = latestShiftDateByEmp.get(rec.employeeId);
    if (!prevDate || rec.shiftDate >= prevDate) {
      latestShiftDateByEmp.set(rec.employeeId, rec.shiftDate);
      if (rec.shiftId) {
        inferredShiftByEmp.set(rec.employeeId, String(rec.shiftId).toUpperCase());
      }
    }
  }

  const ctx: ClassificationContext = {
    todayIstKey,
    nowMs,
    shiftsById,
    policy,
    holidaysByDate,
    rostersByEmpDate,
    leavesByEmp,
    attendanceByEmpDate,
    inferredShiftByEmp,
  };

  return {
    employees,
    attendanceRecords,
    ctx,
    shifts: rawShifts,
  };
}

// ============================================================================
// Validation Schemas
// ============================================================================

const OverviewQuerySchema = z.object({
  date: z.string().optional(),
});

const EmployeesSearchQuerySchema = z.object({
  q: z.string().max(120).optional(),
  line: z.string().max(80).optional(),
  department: z.string().max(80).optional(),
  section: z.string().max(80).optional(),
  shift: z.string().max(40).optional(),
  status: z.enum(['ALL', 'Active', 'Inactive']).optional(),
  page: z.coerce.number().int().min(1).max(1000).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});

const CalendarQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
});

const AbsentManpowerQuerySchema = z.object({
  date: z.string().optional(),
  search: z.string().max(120).optional(),
  line: z.string().max(80).optional(),
  section: z.string().max(80).optional(),
  department: z.string().max(80).optional(),
  employeeType: z.string().max(40).optional(),
  shift: z.string().max(40).optional(),
  minConsecutive: z.coerce.number().int().min(1).max(365).optional(),
  sortBy: z
    .enum(['consecutive_desc', 'recent_absence', 'department_asc', 'line_asc', 'name_asc'])
    .optional(),
  page: z.coerce.number().int().min(1).max(1000).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});

const DailyAttendanceQuerySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  search: z.string().max(120).optional(),
  line: z.string().max(80).optional(),
  department: z.string().max(80).optional(),
  shift: z.string().max(40).optional(),
  status: z.string().max(40).optional(),
  punchOutType: z.string().max(20).optional(),
  sortBy: z
    .enum(['date_desc', 'date_asc', 'employeeId_asc', 'name_asc', 'duty_desc', 'ot_desc'])
    .optional(),
  page: z.coerce.number().int().min(1).max(1000).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});

const AnalyticsQuerySchema = z.object({
  date: z.string().optional(),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  line: z.string().max(80).optional(),
  department: z.string().max(80).optional(),
});

// ============================================================================
// Route Registration
// ============================================================================

export function registerAttendanceHistoryRoutes(
  app: Express,
  deps: AttendanceHistoryRouterDeps
): void {
  const { db, requireVerifiedCaller, nowProvider } = deps;
  const getNowMs = () => (nowProvider ? nowProvider() : Date.now());

  // --------------------------------------------------------------------------
  // 1. GET /api/attendance-history/overview
  // --------------------------------------------------------------------------
  app.get('/api/attendance-history/overview', async (req: Request, res: Response) => {
    try {
      const caller = await requireHistoryReadCaller(
        db,
        requireVerifiedCaller,
        req,
        res,
        'View Attendance History Overview'
      );
      if (!caller) return;

      const parsed = OverviewQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: 'Invalid overview query parameters.' });
      }

      const nowMs = getNowMs();
      const todayIst = getTodayIstDateKey(nowMs);
      const selectedDate =
        parsed.data.date && isValidDateKey(parsed.data.date) ? parsed.data.date : todayIst;

      const lookbackStart = shiftDateKeyByDays(selectedDate, -45);
      const { employees, ctx } = await loadBoundedClassificationData(
        db,
        lookbackStart,
        selectedDate,
        nowMs
      );

      const activeEmployees = employees.filter(
        (e) => String(e.employeeStatus || 'Active').toLowerCase() === 'active'
      );

      let presentToday = 0;
      let absentToday = 0;
      let lateArrivals = 0;
      let autoClosedAttendance = 0;
      let currentlyIn = 0;
      let consecutiveAbsentees = 0;
      let scheduledWorkingCount = 0;
      let weeklyOffCount = 0;
      let holidayCount = 0;
      let approvedLeaveCount = 0;
      let unknownCount = 0;

      const topConsecutiveAbsentees: AbsentManpowerRow[] = [];

      for (const emp of activeEmployees) {
        const day = classifyEmployeeDay(emp, selectedDate, ctx);
        if (day.isScheduledWorkingDay) scheduledWorkingCount += 1;
        if (day.isAttended) presentToday += 1;
        if (day.isLate) lateArrivals += 1;
        if (day.isAutoClosed || day.status === 'AUTO CLOSED') autoClosedAttendance += 1;
        if (day.status === 'IN PROGRESS') currentlyIn += 1;
        if (day.status === 'WEEKLY OFF') weeklyOffCount += 1;
        if (day.status === 'HOLIDAY') holidayCount += 1;
        if (day.status === 'APPROVED LEAVE') approvedLeaveCount += 1;
        if (day.status === 'UNKNOWN') unknownCount += 1;

        if (day.status === 'ABSENT') {
          absentToday += 1;
          const consec = computeConsecutiveAbsenceMetrics(emp, selectedDate, ctx, {
            lookbackDays: 45,
          });
          if (consec.consecutiveAbsentWorkingDays >= 2) {
            consecutiveAbsentees += 1;
          }
          const profile = buildSafeEmployeeProfile(
            emp,
            ctx.shiftsById,
            ctx.inferredShiftByEmp?.get(emp.employeeId),
            ctx.policy.defaultShiftId
          );
          topConsecutiveAbsentees.push({
            employeeId: profile.employeeId,
            employeeName: profile.employeeName,
            line: profile.line,
            section: profile.section,
            department: profile.department,
            employeeType: profile.employeeType,
            lastPresentDate: consec.lastPresentDate,
            firstDateOfCurrentAbsence: consec.firstDateOfCurrentAbsence,
            consecutiveAbsentWorkingDays: consec.consecutiveAbsentWorkingDays,
            totalAbsentWorkingDaysInMonth: consec.totalAbsentWorkingDaysInMonth,
            currentShift: profile.currentShiftName,
            currentShiftId: profile.currentShiftId,
            attendanceStatus: day.status,
            employeeStatus: profile.employeeStatus,
          });
        }
      }

      topConsecutiveAbsentees.sort(
        (a, b) =>
          b.consecutiveAbsentWorkingDays - a.consecutiveAbsentWorkingDays ||
          b.totalAbsentWorkingDaysInMonth - a.totalAbsentWorkingDaysInMonth ||
          a.employeeName.localeCompare(b.employeeName)
      );

      const overallAttendancePercentage =
        scheduledWorkingCount > 0
          ? Math.round((presentToday / scheduledWorkingCount) * 1000) / 10
          : 0;

      return res.json({
        success: true,
        date: selectedDate,
        todayIst,
        kpis: {
          totalActiveEmployees: activeEmployees.length,
          presentToday,
          absentToday,
          lateArrivals,
          autoClosedAttendance,
          currentlyIn,
          consecutiveAbsentees,
          overallAttendancePercentage,
        },
        scheduleSummary: {
          scheduledWorkingCount,
          weeklyOffCount,
          holidayCount,
          approvedLeaveCount,
          unknownCount,
          weeklyOffDays: ctx.policy.weeklyOffDays,
          schedulePolicyMode: ctx.policy.schedulePolicyMode,
        },
        topConsecutiveAbsentees: topConsecutiveAbsentees.slice(0, 8),
      });
    } catch (err) {
      console.error('[API Attendance History Overview] Error:', err);
      return res.status(500).json({
        success: false,
        error: 'Failed to load Attendance History overview.',
      });
    }
  });

  // --------------------------------------------------------------------------
  // 2. GET /api/attendance-history/employees — Safe Paginated Employee Search
  // --------------------------------------------------------------------------
  app.get('/api/attendance-history/employees', async (req: Request, res: Response) => {
    try {
      const caller = await requireHistoryReadCaller(
        db,
        requireVerifiedCaller,
        req,
        res,
        'Search Employees for Attendance History'
      );
      if (!caller) return;

      const parsed = EmployeesSearchQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: 'Invalid employee search parameters.' });
      }

      const {
        q = '',
        line = 'ALL',
        department = 'ALL',
        section = 'ALL',
        shift = 'ALL',
        status = 'ALL',
        page = 1,
        pageSize = 25,
      } = parsed.data;

      const [empSnap, cachedShiftsRes, settingsRes] = await Promise.all([
        db.collection('employees').get(),
        getCachedShifts(db, DEFAULT_SHIFTS),
        getCachedSystemSettings(db, {}),
      ]);

      const rawShifts: Shift[] =
        Array.isArray(cachedShiftsRes?.shifts) && cachedShiftsRes.shifts.length > 0
          ? (cachedShiftsRes.shifts as Shift[])
          : DEFAULT_SHIFTS;
      const shiftsById = new Map<string, Shift>();
      for (const s of rawShifts) {
        if (s?.id) shiftsById.set(String(s.id).toUpperCase(), s);
      }
      const defaultShiftId = String((settingsRes?.data as any)?.defaultShiftId || 'DAY').toUpperCase();

      const searchLower = q.trim().toLowerCase();
      const profiles = empSnap.docs
        .map((d) =>
          buildSafeEmployeeProfile(
            d.data() as Employee & Record<string, any>,
            shiftsById,
            null,
            defaultShiftId
          )
        )
        .filter((p) => {
          if (status !== 'ALL' && p.employeeStatus !== status) return false;
          if (line !== 'ALL' && p.line !== line && p.floor !== line) return false;
          if (department !== 'ALL' && p.department !== department) return false;
          if (section !== 'ALL' && p.section !== section) return false;
          if (shift !== 'ALL' && p.currentShiftId !== shift.toUpperCase()) return false;
          if (searchLower) {
            const hay = `${p.employeeId} ${p.employeeName} ${p.line} ${p.department} ${p.section}`.toLowerCase();
            if (!hay.includes(searchLower)) return false;
          }
          return true;
        })
        .sort((a, b) => a.employeeId.localeCompare(b.employeeId));

      const total = profiles.length;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const safePage = Math.min(page, totalPages);
      const items = profiles.slice((safePage - 1) * pageSize, safePage * pageSize);

      return res.json({
        success: true,
        total,
        page: safePage,
        pageSize,
        totalPages,
        employees: items,
      });
    } catch (err) {
      console.error('[API Attendance History Employees] Error:', err);
      return res.status(500).json({
        success: false,
        error: 'Failed to search employees.',
      });
    }
  });

  // --------------------------------------------------------------------------
  // 3. GET /api/attendance-history/employee/:employeeId/calendar
  // --------------------------------------------------------------------------
  app.get(
    '/api/attendance-history/employee/:employeeId/calendar',
    async (req: Request, res: Response) => {
      try {
        const caller = await requireHistoryReadCaller(
          db,
          requireVerifiedCaller,
          req,
          res,
          'View Employee Monthly Attendance Calendar'
        );
        if (!caller) return;

        const employeeId = String(req.params.employeeId || '').trim();
        if (!employeeId || employeeId.length > 64) {
          return res.status(400).json({ success: false, error: 'Invalid employeeId.' });
        }

        const parsed = CalendarQuerySchema.safeParse(req.query);
        if (!parsed.success) {
          return res.status(400).json({ success: false, error: 'Invalid calendar month/year.' });
        }

        const nowMs = getNowMs();
        const todayIst = getTodayIstDateKey(nowMs);
        const year = parsed.data.year ?? parseInt(todayIst.slice(0, 4), 10);
        const month = parsed.data.month ?? parseInt(todayIst.slice(5, 7), 10);

        const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
        const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(
          getDaysInMonth(year, month)
        ).padStart(2, '0')}`;

        // Extend lookback window by 60 days before monthStart for consecutive absence & previous absence history
        const referenceDate = monthEnd < todayIst ? monthEnd : todayIst;
        const lookbackStart = shiftDateKeyByDays(
          monthStart < referenceDate ? monthStart : referenceDate,
          -60
        );
        const queryEnd = monthEnd > todayIst ? monthEnd : todayIst;

        const { employees, ctx } = await loadBoundedClassificationData(
          db,
          lookbackStart,
          queryEnd,
          nowMs,
          { employeeId }
        );

        const emp = employees[0];
        if (!emp) {
          return res.status(404).json({
            success: false,
            error: `Employee "${employeeId}" not found.`,
          });
        }

        const profile = buildSafeEmployeeProfile(
          emp,
          ctx.shiftsById,
          ctx.inferredShiftByEmp?.get(emp.employeeId),
          ctx.policy.defaultShiftId
        );

        const { days, summary } = buildEmployeeMonthlyCalendar(emp, year, month, ctx);
        const consecutiveAbsence = computeConsecutiveAbsenceMetrics(emp, referenceDate, ctx, {
          lookbackDays: 60,
        });

        return res.json({
          success: true,
          todayIst,
          year,
          month,
          employee: profile,
          summary,
          days,
          consecutiveAbsence,
        });
      } catch (err) {
        console.error('[API Employee Monthly Calendar] Error:', err);
        return res.status(500).json({
          success: false,
          error: 'Failed to load employee monthly attendance calendar.',
        });
      }
    }
  );

  // --------------------------------------------------------------------------
  // 4. GET /api/attendance-history/absent-manpower
  // --------------------------------------------------------------------------
  app.get('/api/attendance-history/absent-manpower', async (req: Request, res: Response) => {
    try {
      const caller = await requireHistoryReadCaller(
        db,
        requireVerifiedCaller,
        req,
        res,
        'View Absent Manpower List'
      );
      if (!caller) return;

      const parsed = AbsentManpowerQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: 'Invalid absent manpower filter parameters.',
        });
      }

      const nowMs = getNowMs();
      const todayIst = getTodayIstDateKey(nowMs);
      const selectedDate =
        parsed.data.date && isValidDateKey(parsed.data.date) ? parsed.data.date : todayIst;

      const {
        search = '',
        line = 'ALL',
        section = 'ALL',
        department = 'ALL',
        employeeType = 'ALL',
        shift = 'ALL',
        minConsecutive = 1,
        sortBy = 'consecutive_desc',
        page = 1,
        pageSize = 25,
      } = parsed.data;

      const lookbackDays = 65;
      const monthStart = `${selectedDate.slice(0, 7)}-01`;
      const lookbackStart = shiftDateKeyByDays(selectedDate, -(lookbackDays - 1));
      const rangeStart = lookbackStart < monthStart ? lookbackStart : monthStart;

      const { employees, ctx } = await loadBoundedClassificationData(
        db,
        rangeStart,
        selectedDate,
        nowMs
      );

      const activeEmployees = employees.filter(
        (e) => String(e.employeeStatus || 'Active').toLowerCase() === 'active'
      );

      const allAbsentRows: AbsentManpowerRow[] = [];

      for (const emp of activeEmployees) {
        const refDay = classifyEmployeeDay(emp, selectedDate, ctx);
        if (refDay.status !== 'ABSENT') continue;

        const consec = computeConsecutiveAbsenceMetrics(emp, selectedDate, ctx, {
          lookbackDays,
        });
        const profile = buildSafeEmployeeProfile(
          emp,
          ctx.shiftsById,
          ctx.inferredShiftByEmp?.get(emp.employeeId),
          ctx.policy.defaultShiftId
        );

        allAbsentRows.push({
          employeeId: profile.employeeId,
          employeeName: profile.employeeName,
          line: profile.line,
          section: profile.section,
          department: profile.department,
          employeeType: profile.employeeType,
          lastPresentDate: consec.lastPresentDate,
          firstDateOfCurrentAbsence: consec.firstDateOfCurrentAbsence,
          consecutiveAbsentWorkingDays: consec.consecutiveAbsentWorkingDays,
          totalAbsentWorkingDaysInMonth: consec.totalAbsentWorkingDaysInMonth,
          currentShift: profile.currentShiftName,
          currentShiftId: profile.currentShiftId,
          attendanceStatus: refDay.status,
          employeeStatus: profile.employeeStatus,
        });
      }

      // Compute preset counts BEFORE applying minConsecutive filter (after org/search filters)
      const searchLower = search.trim().toLowerCase();
      const orgFiltered = allAbsentRows.filter((row) => {
        if (line !== 'ALL' && row.line !== line) return false;
        if (section !== 'ALL' && row.section !== section) return false;
        if (department !== 'ALL' && row.department !== department) return false;
        if (employeeType !== 'ALL' && row.employeeType !== employeeType) return false;
        if (shift !== 'ALL' && row.currentShiftId !== shift.toUpperCase()) return false;
        if (searchLower) {
          const hay = `${row.employeeId} ${row.employeeName} ${row.line} ${row.section} ${row.department}`.toLowerCase();
          if (!hay.includes(searchLower)) return false;
        }
        return true;
      });

      const presetCounts = {
        absentToday: orgFiltered.length,
        consecutive2Plus: orgFiltered.filter((r) => r.consecutiveAbsentWorkingDays >= 2).length,
        consecutive3Plus: orgFiltered.filter((r) => r.consecutiveAbsentWorkingDays >= 3).length,
        consecutive5Plus: orgFiltered.filter((r) => r.consecutiveAbsentWorkingDays >= 5).length,
        consecutive7Plus: orgFiltered.filter((r) => r.consecutiveAbsentWorkingDays >= 7).length,
        consecutive10Plus: orgFiltered.filter((r) => r.consecutiveAbsentWorkingDays >= 10).length,
      };

      const filtered = orgFiltered.filter(
        (r) => r.consecutiveAbsentWorkingDays >= minConsecutive
      );

      filtered.sort((a, b) => {
        switch (sortBy) {
          case 'recent_absence':
            return (
              String(b.firstDateOfCurrentAbsence || '').localeCompare(
                String(a.firstDateOfCurrentAbsence || '')
              ) || b.consecutiveAbsentWorkingDays - a.consecutiveAbsentWorkingDays
            );
          case 'department_asc':
            return (
              a.department.localeCompare(b.department) ||
              b.consecutiveAbsentWorkingDays - a.consecutiveAbsentWorkingDays
            );
          case 'line_asc':
            return (
              a.line.localeCompare(b.line) ||
              b.consecutiveAbsentWorkingDays - a.consecutiveAbsentWorkingDays
            );
          case 'name_asc':
            return a.employeeName.localeCompare(b.employeeName);
          case 'consecutive_desc':
          default:
            return (
              b.consecutiveAbsentWorkingDays - a.consecutiveAbsentWorkingDays ||
              b.totalAbsentWorkingDaysInMonth - a.totalAbsentWorkingDaysInMonth ||
              a.employeeName.localeCompare(b.employeeName)
            );
        }
      });

      const total = filtered.length;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const safePage = Math.min(page, totalPages);
      const records = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

      return res.json({
        success: true,
        date: selectedDate,
        total,
        page: safePage,
        pageSize,
        totalPages,
        presetCounts,
        records,
      });
    } catch (err) {
      console.error('[API Absent Manpower] Error:', err);
      return res.status(500).json({
        success: false,
        error: 'Failed to load absent manpower list.',
      });
    }
  });

  // --------------------------------------------------------------------------
  // 5. GET /api/attendance-history/daily — Server-Side Paginated Daily Ledger
  // --------------------------------------------------------------------------
  app.get('/api/attendance-history/daily', async (req: Request, res: Response) => {
    try {
      const caller = await requireHistoryReadCaller(
        db,
        requireVerifiedCaller,
        req,
        res,
        'View Daily Attendance History'
      );
      if (!caller) return;

      const parsed = DailyAttendanceQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: 'Invalid daily attendance query parameters.',
        });
      }

      const nowMs = getNowMs();
      const todayIst = getTodayIstDateKey(nowMs);
      const endDate =
        parsed.data.endDate && isValidDateKey(parsed.data.endDate)
          ? parsed.data.endDate
          : todayIst;
      const startDate =
        parsed.data.startDate && isValidDateKey(parsed.data.startDate)
          ? parsed.data.startDate
          : shiftDateKeyByDays(endDate, -7);

      if (startDate > endDate) {
        return res.status(400).json({
          success: false,
          error: 'startDate cannot be after endDate.',
        });
      }

      const {
        search = '',
        line = 'ALL',
        department = 'ALL',
        shift = 'ALL',
        status = 'ALL',
        punchOutType = 'ALL',
        sortBy = 'date_desc',
        page = 1,
        pageSize = 50,
      } = parsed.data;

      const attSnap = await db
        .collection('attendance')
        .where('shiftDate', '>=', startDate)
        .where('shiftDate', '<=', endDate)
        .get();

      const searchLower = search.trim().toLowerCase();

      const enriched = attSnap.docs
        .map((d) => {
          const rec = { id: d.id, ...(d.data() as any) } as AttendanceRecord;
          const m = resolveAttendanceMetrics(rec, nowMs, STANDARD_DUTY_MINUTES);
          const dutyMinutes = m.isOpen ? 0 : m.regularDutyMinutes;
          const otMinutes = m.isOpen ? 0 : m.overtimeMinutes;
          const totalWorkingMinutes = m.isOpen ? 0 : m.completedDutyMinutes;

          return {
            id: rec.id,
            employeeId: rec.employeeId,
            employeeName: rec.employeeNameSnapshot,
            line: rec.floorIdSnapshot || rec.lineIdSnapshot || '',
            department: rec.departmentIdSnapshot || '',
            section: rec.sectionIdSnapshot || '',
            employeeType: rec.employeeTypeSnapshot || '',
            attendanceDate: rec.shiftDate,
            shiftId: rec.shiftId,
            shiftName: rec.shiftNameSnapshot,
            state: m.state,
            scheduledShiftStart: m.scheduledStartDisplay,
            scheduledShiftEnd: m.scheduledEndDisplay,
            actualPunchIn: formatIsoTimeKolkata12h(rec.firstPunchIn || rec.punchIn),
            actualPunchOut: m.isOpen
              ? 'In Progress'
              : m.actualPunchOutIso
                ? m.actualPunchOutDisplay
                : 'N/A',
            autoCloseTime: m.isCurrentlyAutoClosed ? m.autoCloseTimeDisplay : 'N/A',
            autoCloseRecordedAt: m.isCurrentlyAutoClosed ? m.autoCloseRecordedAtDisplay : 'N/A',
            punchOutType: m.punchOutTypeResolved,
            attendanceStatus: m.status,
            isLate: m.isLate,
            earlyArrivalMinutes: m.earlyArrivalMinutes,
            earlyOtMinutes: m.earlyOtMinutes,
            postShiftOtMinutes: m.postShiftOtMinutes,
            dutyMinutes,
            otMinutes,
            totalWorkingMinutes,
            dutyHours: formatDurationClock(dutyMinutes),
            otHours: formatDurationClock(otMinutes),
            totalWorkingHours: formatDurationClock(totalWorkingMinutes),
            record: rec,
          };
        })
        .filter((item) => {
          if (line !== 'ALL' && item.line !== line) return false;
          if (department !== 'ALL' && item.department !== department) return false;
          if (shift !== 'ALL' && item.shiftId !== shift) return false;
          if (punchOutType !== 'ALL' && item.punchOutType !== punchOutType) return false;
          if (status !== 'ALL') {
            if (status === 'LATE') {
              if (!item.isLate) return false;
            } else if (item.attendanceStatus !== status) {
              return false;
            }
          }
          if (searchLower) {
            const hay = `${item.employeeId} ${item.employeeName} ${item.line} ${item.department}`.toLowerCase();
            if (!hay.includes(searchLower)) return false;
          }
          return true;
        });

      enriched.sort((a, b) => {
        switch (sortBy) {
          case 'date_asc':
            return (
              a.attendanceDate.localeCompare(b.attendanceDate) ||
              a.employeeId.localeCompare(b.employeeId)
            );
          case 'employeeId_asc':
            return (
              a.employeeId.localeCompare(b.employeeId) ||
              b.attendanceDate.localeCompare(a.attendanceDate)
            );
          case 'name_asc':
            return (
              a.employeeName.localeCompare(b.employeeName) ||
              b.attendanceDate.localeCompare(a.attendanceDate)
            );
          case 'duty_desc':
            return b.dutyMinutes - a.dutyMinutes || b.attendanceDate.localeCompare(a.attendanceDate);
          case 'ot_desc':
            return b.otMinutes - a.otMinutes || b.attendanceDate.localeCompare(a.attendanceDate);
          case 'date_desc':
          default:
            return (
              b.attendanceDate.localeCompare(a.attendanceDate) ||
              String(b.record.createdAt || '').localeCompare(String(a.record.createdAt || ''))
            );
        }
      });

      const total = enriched.length;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const safePage = Math.min(page, totalPages);
      const items = enriched.slice((safePage - 1) * pageSize, safePage * pageSize);

      return res.json({
        success: true,
        startDate,
        endDate,
        total,
        page: safePage,
        pageSize,
        totalPages,
        records: items,
      });
    } catch (err) {
      console.error('[API Daily Attendance] Error:', err);
      return res.status(500).json({
        success: false,
        error: 'Failed to load daily attendance records.',
      });
    }
  });

  // --------------------------------------------------------------------------
  // 6. GET /api/attendance-history/analytics — Real Backend Aggregation
  // --------------------------------------------------------------------------
  app.get('/api/attendance-history/analytics', async (req: Request, res: Response) => {
    try {
      const caller = await requireHistoryReadCaller(
        db,
        requireVerifiedCaller,
        req,
        res,
        'View Attendance Analytics'
      );
      if (!caller) return;

      const parsed = AnalyticsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: 'Invalid analytics query parameters.',
        });
      }

      const nowMs = getNowMs();
      const todayIst = getTodayIstDateKey(nowMs);
      const selectedDate =
        parsed.data.date && isValidDateKey(parsed.data.date) ? parsed.data.date : todayIst;
      const selectedMonth = parsed.data.month || selectedDate.slice(0, 7);
      const filterLine = parsed.data.line || 'ALL';
      const filterDept = parsed.data.department || 'ALL';

      const [mYear, mMonth] = selectedMonth.split('-').map(Number);
      const monthStart = `${selectedMonth}-01`;
      const monthEnd = `${selectedMonth}-${String(getDaysInMonth(mYear, mMonth)).padStart(2, '0')}`;
      const trendStart = shiftDateKeyByDays(selectedDate, -13); // 14-day daily trend
      const lookbackStart = shiftDateKeyByDays(selectedDate, -45);

      const rangeStart = [monthStart, trendStart, lookbackStart].sort()[0];
      const rangeEnd = selectedDate > monthEnd ? selectedDate : monthEnd;

      const { employees, ctx } = await loadBoundedClassificationData(
        db,
        rangeStart,
        rangeEnd,
        nowMs
      );

      const scopedEmployees = employees.filter((e) => {
        if (String(e.employeeStatus || 'Active').toLowerCase() !== 'active') return false;
        const empLine = String(e.line || e.floor || 'Unassigned').trim();
        const empDept = String(e.department || 'Unassigned').trim();
        if (filterLine !== 'ALL' && empLine !== filterLine) return false;
        if (filterDept !== 'ALL' && empDept !== filterDept) return false;
        return true;
      });

      // 1. Daily Present vs Absent Trend (14 days ending at selectedDate)
      const trendDates = enumerateDateRangeKeys(trendStart, selectedDate);
      const dailyTrend = trendDates.map((dk) => {
        let present = 0;
        let absent = 0;
        let scheduled = 0;
        let autoClosed = 0;
        let leave = 0;
        let weeklyOff = 0;
        let holiday = 0;

        for (const emp of scopedEmployees) {
          const d = classifyEmployeeDay(emp, dk, ctx);
          if (d.isScheduledWorkingDay) scheduled += 1;
          if (d.isAttended) present += 1;
          if (d.status === 'ABSENT') absent += 1;
          if (d.status === 'AUTO CLOSED') autoClosed += 1;
          if (d.status === 'APPROVED LEAVE') leave += 1;
          if (d.status === 'WEEKLY OFF') weeklyOff += 1;
          if (d.status === 'HOLIDAY') holiday += 1;
        }

        const attendancePercentage =
          scheduled > 0 ? Math.round((present / scheduled) * 1000) / 10 : 0;

        return {
          date: dk,
          present,
          absent,
          scheduled,
          autoClosed,
          leave,
          weeklyOff,
          holiday,
          attendancePercentage,
        };
      });

      // 2. Monthly Attendance Trend (weekly buckets across the selected month up to todayIst)
      const monthDates = enumerateMonthDateKeys(mYear, mMonth).filter((dk) => dk <= todayIst);
      const weeklyBuckets = new Map<
        string,
        { label: string; startDate: string; endDate: string; present: number; absent: number; scheduled: number }
      >();

      for (const dk of monthDates) {
        const dayNum = parseInt(dk.slice(8, 10), 10);
        const weekIdx = Math.ceil(dayNum / 7);
        const bucketKey = `W${weekIdx}`;
        let bucket = weeklyBuckets.get(bucketKey);
        if (!bucket) {
          bucket = {
            label: `Week ${weekIdx}`,
            startDate: dk,
            endDate: dk,
            present: 0,
            absent: 0,
            scheduled: 0,
          };
          weeklyBuckets.set(bucketKey, bucket);
        }
        bucket.endDate = dk;

        for (const emp of scopedEmployees) {
          const d = classifyEmployeeDay(emp, dk, ctx);
          if (d.isScheduledWorkingDay) bucket.scheduled += 1;
          if (d.isAttended) bucket.present += 1;
          if (d.status === 'ABSENT') bucket.absent += 1;
        }
      }

      const monthlyTrend = Array.from(weeklyBuckets.values()).map((b) => ({
        ...b,
        attendancePercentage:
          b.scheduled > 0 ? Math.round((b.present / b.scheduled) * 1000) / 10 : 0,
      }));

      // 3-6. Breakdowns on selectedDate (Department, Line, Shift, Employee Type)
      type GroupStats = {
        key: string;
        totalActive: number;
        scheduled: number;
        present: number;
        absent: number;
        autoClosed: number;
        late: number;
        leave: number;
        weeklyOff: number;
        attendancePercentage: number;
      };

      const bumpGroup = (
        map: Map<string, GroupStats>,
        groupKey: string,
        day: ReturnType<typeof classifyEmployeeDay>
      ) => {
        const k = groupKey || 'Unassigned';
        let g = map.get(k);
        if (!g) {
          g = {
            key: k,
            totalActive: 0,
            scheduled: 0,
            present: 0,
            absent: 0,
            autoClosed: 0,
            late: 0,
            leave: 0,
            weeklyOff: 0,
            attendancePercentage: 0,
          };
          map.set(k, g);
        }
        g.totalActive += 1;
        if (day.isScheduledWorkingDay) g.scheduled += 1;
        if (day.isAttended) g.present += 1;
        if (day.status === 'ABSENT') g.absent += 1;
        if (day.status === 'AUTO CLOSED') g.autoClosed += 1;
        if (day.isLate) g.late += 1;
        if (day.status === 'APPROVED LEAVE') g.leave += 1;
        if (day.status === 'WEEKLY OFF') g.weeklyOff += 1;
      };

      const deptMap = new Map<string, GroupStats>();
      const lineMap = new Map<string, GroupStats>();
      const shiftMap = new Map<string, GroupStats>();
      const typeMap = new Map<string, GroupStats>();

      const longestContinuousAbsence: AbsentManpowerRow[] = [];
      const topAbsenceEmployees: Array<{
        employeeId: string;
        employeeName: string;
        line: string;
        department: string;
        employeeType: string;
        absentDaysInMonth: number;
        scheduledDaysInMonth: number;
        consecutiveAbsentWorkingDays: number;
        lastPresentDate: string | null;
      }> = [];

      for (const emp of scopedEmployees) {
        const profile = buildSafeEmployeeProfile(
          emp,
          ctx.shiftsById,
          ctx.inferredShiftByEmp?.get(emp.employeeId),
          ctx.policy.defaultShiftId
        );
        const refDay = classifyEmployeeDay(emp, selectedDate, ctx);

        bumpGroup(deptMap, profile.department, refDay);
        bumpGroup(lineMap, profile.line, refDay);
        bumpGroup(shiftMap, profile.currentShiftName, refDay);
        bumpGroup(typeMap, profile.employeeType, refDay);

        const consec = computeConsecutiveAbsenceMetrics(emp, selectedDate, ctx, {
          lookbackDays: 45,
        });

        if (refDay.status === 'ABSENT' && consec.consecutiveAbsentWorkingDays > 0) {
          longestContinuousAbsence.push({
            employeeId: profile.employeeId,
            employeeName: profile.employeeName,
            line: profile.line,
            section: profile.section,
            department: profile.department,
            employeeType: profile.employeeType,
            lastPresentDate: consec.lastPresentDate,
            firstDateOfCurrentAbsence: consec.firstDateOfCurrentAbsence,
            consecutiveAbsentWorkingDays: consec.consecutiveAbsentWorkingDays,
            totalAbsentWorkingDaysInMonth: consec.totalAbsentWorkingDaysInMonth,
            currentShift: profile.currentShiftName,
            currentShiftId: profile.currentShiftId,
            attendanceStatus: refDay.status,
            employeeStatus: profile.employeeStatus,
          });
        }

        // Compute monthly absent working days for Top Absence Employees
        let absentInMonth = 0;
        let scheduledInMonth = 0;
        for (const dk of monthDates) {
          const md = classifyEmployeeDay(emp, dk, ctx);
          if (md.isScheduledWorkingDay) scheduledInMonth += 1;
          if (md.status === 'ABSENT') absentInMonth += 1;
        }
        if (absentInMonth > 0) {
          topAbsenceEmployees.push({
            employeeId: profile.employeeId,
            employeeName: profile.employeeName,
            line: profile.line,
            department: profile.department,
            employeeType: profile.employeeType,
            absentDaysInMonth: absentInMonth,
            scheduledDaysInMonth: scheduledInMonth,
            consecutiveAbsentWorkingDays: consec.consecutiveAbsentWorkingDays,
            lastPresentDate: consec.lastPresentDate,
          });
        }
      }

      const finalizeGroups = (map: Map<string, GroupStats>): GroupStats[] =>
        Array.from(map.values())
          .map((g) => ({
            ...g,
            attendancePercentage:
              g.scheduled > 0 ? Math.round((g.present / g.scheduled) * 1000) / 10 : 0,
          }))
          .sort((a, b) => b.totalActive - a.totalActive || a.key.localeCompare(b.key));

      longestContinuousAbsence.sort(
        (a, b) =>
          b.consecutiveAbsentWorkingDays - a.consecutiveAbsentWorkingDays ||
          b.totalAbsentWorkingDaysInMonth - a.totalAbsentWorkingDaysInMonth
      );

      topAbsenceEmployees.sort(
        (a, b) =>
          b.absentDaysInMonth - a.absentDaysInMonth ||
          b.consecutiveAbsentWorkingDays - a.consecutiveAbsentWorkingDays
      );

      return res.json({
        success: true,
        date: selectedDate,
        month: selectedMonth,
        totalActiveEmployees: scopedEmployees.length,
        dailyTrend,
        monthlyTrend,
        departmentWise: finalizeGroups(deptMap),
        lineWise: finalizeGroups(lineMap),
        shiftWise: finalizeGroups(shiftMap),
        employeeTypeWise: finalizeGroups(typeMap),
        longestContinuousAbsence: longestContinuousAbsence.slice(0, 15),
        topAbsenceEmployees: topAbsenceEmployees.slice(0, 15),
      });
    } catch (err) {
      console.error('[API Attendance Analytics] Error:', err);
      return res.status(500).json({
        success: false,
        error: 'Failed to load attendance analytics.',
      });
    }
  });
}
