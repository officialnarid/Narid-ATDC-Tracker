import express, { type Request, type Response } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import {
  type AdminFirestoreLike,
  type AdminQuerySnapLike,
  type VerifiedCaller,
  hashQrTokenReference,
  recordEnterpriseAuditEvent,
  redactSensitiveData,
  sanitizeAttendanceForApi,
  sanitizeEmployeeForApi,
} from './serverSecurityAudit.ts';
import {
  getCachedRolePermissionsDoc,
  getCachedShifts,
  getCachedSystemSettings,
  runWithOptionalClientRequestDedup,
  roundMs,
  emitNonSensitivePerfLog,
  type AttendancePerfMetrics,
} from './serverPerfCache.ts';
import {
  classifyCompletedDutyStatus,
  computeExpectedPunchOutTimes,
  EARLY_PUNCH_POLICY_ID,
  evaluateAutoCloseDuty,
  evaluateEarlyPunchOnPunchIn,
  evaluateOptionAPunchOut,
  MAX_REGULAR_DUTY_MINUTES,
  resolveShiftScheduleBounds,
  STANDARD_DUTY_MINUTES,
} from './src/utils/attendanceStatus.ts';
import {
  recordQrPunchTelemetry,
  recordDbOpMetric,
  recordActivityTelemetry,
  recordErrorTelemetry,
} from './serverMonitoring.ts';

const KOLKATA_PARTS_FORMATTER = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const KOLKATA_TIME_DISPLAY_FORMATTER = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
});

// ============================================================================
// Constants & Default Shift / Setting Definitions (100% Preserved from App)
// ============================================================================
const DEFAULT_SHIFTS = [
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

const DEFAULT_SETTINGS = {
  id: 'global',
  autoPunchOutEnabled: true,
  lateGraceMinutes: 15,
  scheduledDurationMinutes: 510,
  overtimeThresholdMinutes: 510,
};

// Per-employee async mutex to serialize burst scans cleanly in addition to Firestore transactions
const employeeScanLocks = new Map<string, Promise<unknown>>();

async function withEmployeeScanLock<T>(
  employeeId: string,
  task: (lockInfo: { waitedForLock: boolean }) => Promise<T>
): Promise<T> {
  const key = employeeId.trim().toUpperCase() || '__UNKNOWN__';
  const existing = employeeScanLocks.get(key);
  const waitedForLock = Boolean(existing);
  const prev = existing || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = prev.then(() => gate);
  employeeScanLocks.set(key, chained);
  try {
    await prev;
    return await task({ waitedForLock });
  } finally {
    release();
    if (employeeScanLocks.get(key) === chained) {
      employeeScanLocks.delete(key);
    }
  }
}

// ============================================================================
// Pure Timezone & Attendance Calculation Helpers (Asia/Kolkata)
// ============================================================================
export function formatMinutes(mins: number): string {
  if (mins <= 0) return '00:00 Hours';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} Hours`;
}

export function timeStringToMinutes(timeStr: string): number {
  if (!timeStr) return 0;
  const [hh, mm] = timeStr.split(':').map(Number);
  return hh * 60 + (mm || 0);
}

export function getKolkataTimeParts(date: Date = new Date()): {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
  seconds: number;
  dateKey: string;
  totalMinutes: number;
  timeDisplay: string;
  timeWithSeconds: string;
} {
  const parts = KOLKATA_PARTS_FORMATTER.formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) {
    map[p.type] = p.value;
  }

  const year = parseInt(map.year, 10);
  const month = parseInt(map.month, 10);
  const day = parseInt(map.day, 10);
  let hours = parseInt(map.hour, 10);
  if (hours === 24) hours = 0;
  const minutes = parseInt(map.minute, 10);
  const seconds = parseInt(map.second, 10);

  const dateKey = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const totalMinutes = hours * 60 + minutes;

  const h12 = hours % 12 || 12;
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const timeDisplay = `${String(h12).padStart(2, '0')}:${String(minutes).padStart(2, '0')} ${ampm}`;
  const timeWithSeconds = `${String(h12).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')} ${ampm}`;

  return {
    year,
    month,
    day,
    hours,
    minutes,
    seconds,
    dateKey,
    totalMinutes,
    timeDisplay,
    timeWithSeconds,
  };
}

export function getYesterdayKolkataDateKey(d: Date = new Date()): string {
  const yesterday = new Date(d.getTime() - 24 * 3600 * 1000);
  return getKolkataTimeParts(yesterday).dateKey;
}

export function getNextDateKey(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  const nextY = dt.getUTCFullYear();
  const nextM = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const nextD = String(dt.getUTCDate()).padStart(2, '0');
  return `${nextY}-${nextM}-${nextD}`;
}

export function getShiftScheduledEndIso(shiftDate: string, shift: any): string {
  const targetDateKey = shift.isOvernight ? getNextDateKey(shiftDate) : shiftDate;
  const [h, m] = String(shift.endTime || '17:30').split(':');
  return `${targetDateKey}T${h.padStart(2, '0')}:${(m || '00').padStart(2, '0')}:00+05:30`;
}

export function formatTimeDisplay(isoString: string | null): string {
  if (!isoString) return '--:--';
  const d = new Date(isoString);
  return KOLKATA_TIME_DISPLAY_FORMATTER.format(d);
}

export type QrPayloadFormat = 'JSON_TOKEN' | 'TOKEN_STRING' | 'LEGACY_EMPLOYEE_ID' | 'INVALID';

const EMPLOYEE_ID_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;

export function parseQrPayload(raw: string): {
  employeeId: string;
  token?: string;
  format: QrPayloadFormat;
} {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    return { employeeId: '', format: 'INVALID' };
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { employeeId: '', format: 'INVALID' };
      }
      const rawId = parsed.employeeId ?? parsed.id;
      if (typeof rawId !== 'string') {
        return { employeeId: '', format: 'INVALID' };
      }
      const cleanId = rawId.trim().toUpperCase();
      if (!EMPLOYEE_ID_PATTERN.test(cleanId)) {
        return { employeeId: '', format: 'INVALID' };
      }
      const rawToken = parsed.token ?? parsed.qrToken;
      const cleanToken = typeof rawToken === 'string' && rawToken.trim() ? rawToken.trim() : undefined;
      return {
        employeeId: cleanId,
        token: cleanToken,
        format: 'JSON_TOKEN',
      };
    } catch {
      return { employeeId: '', format: 'INVALID' };
    }
  }

  if (trimmed.startsWith('QR_')) {
    const parts = trimmed.split('_');
    const cleanId = (parts[1] || '').trim().toUpperCase();
    if (!cleanId || !EMPLOYEE_ID_PATTERN.test(cleanId)) {
      return { employeeId: '', format: 'INVALID' };
    }
    const tokenSuffix = parts.slice(2).join('_').trim();
    return {
      employeeId: cleanId,
      token: parts.length >= 3 && tokenSuffix.length > 0 ? trimmed : undefined,
      format: 'TOKEN_STRING',
    };
  }

  const cleanLegacyId = trimmed.toUpperCase();
  if (!EMPLOYEE_ID_PATTERN.test(cleanLegacyId)) {
    return { employeeId: '', format: 'INVALID' };
  }
  return { employeeId: cleanLegacyId, format: 'LEGACY_EMPLOYEE_ID' };
}

function resolveEffectivePunchInWindow(shift: any): { winStartStr: string; winEndStr: string } {
  const rawStart = String(shift?.punchInWindowStart || '').trim();
  const rawEnd = String(shift?.punchInWindowEnd || '').trim();
  const shiftIdUpper = String(shift?.id || '').toUpperCase();

  // Upgrade legacy default DAY/NIGHT windows dynamically in memory so existing Firestore shift docs
  // accurately classify early punches (Day >= 06:00 AM, Night >= 06:00 PM / 18:00) without DB rewrites.
  if (!shift?.isOvernight && (shiftIdUpper === 'DAY' || shift?.startTime === '09:00') && rawStart === '09:00' && rawEnd === '20:00') {
    return { winStartStr: '06:00', winEndStr: '18:00' };
  }
  if ((shift?.isOvernight || shiftIdUpper === 'NIGHT') && shift?.startTime === '20:00' && rawStart === '20:00' && rawEnd === '09:00') {
    return { winStartStr: '18:00', winEndStr: '06:00' };
  }
  return { winStartStr: rawStart, winEndStr: rawEnd };
}

export function identifyShiftForPunchIn(
  shifts: any[],
  now: Date = new Date()
): { shift: any; shiftDate: string } | null {
  const kolkata = getKolkataTimeParts(now);
  const currentMins = kolkata.totalMinutes;
  const activeShifts = shifts.filter((s) => s.status === 'Active');

  for (const shift of activeShifts) {
    const { winStartStr, winEndStr } = resolveEffectivePunchInWindow(shift);
    const winStart = timeStringToMinutes(winStartStr);
    const winEnd = timeStringToMinutes(winEndStr);

    if (winStart < winEnd) {
      if (currentMins >= winStart && currentMins < winEnd) {
        return { shift, shiftDate: kolkata.dateKey };
      }
    } else {
      if (currentMins >= winStart) {
        return { shift, shiftDate: kolkata.dateKey };
      } else if (currentMins < winEnd) {
        return { shift, shiftDate: getYesterdayKolkataDateKey(now) };
      }
    }
  }

  const dayShift = activeShifts.find((s) => !s.isOvernight) || activeShifts[0];
  const nightShift = activeShifts.find((s) => s.isOvernight) || activeShifts[activeShifts.length - 1];

  if (currentMins >= 360 && currentMins < 1080) {
    return dayShift ? { shift: dayShift, shiftDate: kolkata.dateKey } : null;
  } else if (currentMins >= 1080) {
    return nightShift ? { shift: nightShift, shiftDate: kolkata.dateKey } : null;
  } else {
    return nightShift ? { shift: nightShift, shiftDate: getYesterdayKolkataDateKey(now) } : null;
  }
}

// ============================================================================
// Validation Schemas
// ============================================================================
const AttendanceScanSchema = z.object({
  rawPayload: z.string().trim().min(1, 'Scan payload cannot be empty.').max(256),
  scannerType: z.enum(['IN', 'OUT']).optional(),
  scannerDevice: z.enum(['USB_SCANNER', 'WEBCAM', 'MANUAL', 'SYSTEM_AUTO']).optional(),
  customScanTime: z.string().datetime({ offset: true }).or(z.string().datetime()).optional(),
  clientRequestId: z.string().trim().min(4).max(64).optional(),
});

const ManualPunchSchema = z.object({
  employeeId: z
    .string()
    .trim()
    .min(2, 'Please enter a valid Employee ID.')
    .max(32, 'Employee ID cannot exceed 32 characters.')
    .transform((v) => v.toUpperCase())
    .refine((v) => EMPLOYEE_ID_PATTERN.test(v), {
      message: 'Invalid Employee ID format. Use letters, numbers, hyphens, or underscores only.',
    }),
  scannerType: z.enum(['IN', 'OUT']).optional(),
  reason: z.string().trim().max(250).optional(),
  customScanTime: z.string().datetime({ offset: true }).or(z.string().datetime()).optional(),
  clientRequestId: z.string().trim().min(4).max(64).optional(),
});

const AttendanceCorrectSchema = z.object({
  attendanceId: z.string().trim().min(1, 'Attendance ID is required.').max(128),
  actualPunchOut: z.string().optional(),
  punchOutType: z.enum(['ACTUAL', 'AUTO']),
  attendanceStatus: z.enum([
    'IN PROGRESS',
    'SHORT LEAVE',
    'HALF DAY',
    'COMPLETED',
    'COMPLETED + OT',
    'PRESENT',
    'LATE',
    'AUTO CLOSED',
    'MISSED PUNCH OUT',
    'ABSENT',
    'ON LEAVE',
  ]),
  reason: z.string().trim().min(3, 'A clear correction reason (at least 3 characters) is mandatory.').max(500),
});

const GenerateRosterSchema = z.object({
  shiftDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid shiftDate (expected YYYY-MM-DD).'),
  shiftId: z.string().trim().min(1).max(64),
});

const ClearAttendanceSchema = z.object({
  confirmed: z.literal(true, { message: 'Explicit confirmation is required to clear attendance records.' }),
  confirmPhrase: z.literal('CLEAR_ALL_ATTENDANCE', {
    message: 'Confirmation phrase "CLEAR_ALL_ATTENDANCE" is required to clear attendance records.',
  }),
  reason: z.string().trim().min(5, 'Reason is required for audit trail.').max(500).optional(),
});

// ============================================================================
// Centralized Module Permission Evaluator (Strictly Fail-Closed for All Roles)
// ============================================================================
const ADMIN_FALLBACK_ACTIONS: Record<string, { view?: boolean; add?: boolean; edit?: boolean; delete?: boolean }> = {
  dashboard: { view: true },
  scanner: { view: true, add: true, edit: true },
  employees: { view: true, add: true, edit: true },
  excel_import: { view: true, add: true, edit: true },
  qr_codes: { view: true, add: true, edit: true },
  organization: { view: true, add: true, edit: true },
  floors: { view: true, add: true, edit: true },
  sections: { view: true, add: true, edit: true },
  departments: { view: true, add: true, edit: true },
  shifts: { view: true, add: true, edit: true },
  history: { view: true, edit: true },
  reports: { view: true },
};

function evalModuleActionFromSnapshots(
  caller: VerifiedCaller,
  userPermData: Record<string, any> | undefined,
  rolePermData: Record<string, any> | undefined,
  fallbackModules: string[] | undefined,
  moduleKey: string,
  action: 'view' | 'add' | 'edit' | 'delete'
): boolean {
  if (caller.role === 'super_admin') return true;
  if (moduleKey === 'user_rights' || moduleKey === 'audit_logs' || moduleKey === 'security_management') {
    return false;
  }

  if (userPermData && userPermData.isCustomOverride !== false) {
    const mod = userPermData.permissions?.[moduleKey];
    if (mod && typeof mod[action] === 'boolean') {
      return mod[action] === true && (action === 'view' || mod.view !== false);
    }
  }

  if (rolePermData) {
    const mod = rolePermData.modulePermissions?.[moduleKey];
    if (mod && typeof mod[action] === 'boolean') {
      return mod[action] === true && (action === 'view' || mod.view !== false);
    }
  }

  if (caller.role === 'admin') {
    return Boolean(ADMIN_FALLBACK_ACTIONS[moduleKey]?.[action]);
  }

  if (Array.isArray(fallbackModules)) {
    if (fallbackModules.includes('all') || fallbackModules.includes(moduleKey)) {
      if (action === 'view') return true;
      if (moduleKey === 'scanner' && action === 'add') return true;
    }
  }

  return false;
}

async function callerHasModuleAction(
  db: AdminFirestoreLike,
  caller: VerifiedCaller,
  moduleKey: string,
  action: 'view' | 'add' | 'edit' | 'delete'
): Promise<boolean> {
  if (caller.role === 'super_admin') return true;
  if (moduleKey === 'user_rights' || moduleKey === 'audit_logs' || moduleKey === 'security_management') {
    return false;
  }

  try {
    const [userPermSnap, rolePermSnap] = await Promise.all([
      db.collection('user_permissions').doc(caller.profileDocId).get(),
      getCachedRolePermissionsDoc(db, caller.role),
    ]);
    const userPermData = userPermSnap.exists ? userPermSnap.data() : undefined;
    const rolePermData = rolePermSnap.exists ? rolePermSnap.data : undefined;

    let fallbackModules = caller.modulesAllowed;
    if (fallbackModules === undefined && caller.role !== 'admin') {
      const userSnap = await db.collection('user_roles').doc(caller.profileDocId).get();
      if (userSnap.exists && Array.isArray(userSnap.data()?.modulesAllowed)) {
        fallbackModules = userSnap.data()!.modulesAllowed;
      }
    }

    return evalModuleActionFromSnapshots(
      caller,
      userPermData,
      rolePermData,
      fallbackModules,
      moduleKey,
      action
    );
  } catch (err) {
    console.warn(`[Attendance Permission Guard] Lookup failed (${moduleKey}.${action}); failing closed:`, (err as any)?.message || err);
    return false;
  }
}

function isScannerCapabilityEntryEnabled(entry: any): boolean {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.view === false) return false;
  if (typeof entry.add === 'boolean') {
    return entry.add === true;
  }
  return entry.view === true;
}

async function resolveCallerAttendancePermissions(
  db: AdminFirestoreLike,
  caller: VerifiedCaller
): Promise<{
  canQrScan: boolean;
  canManualEntry: boolean;
  canCustomTime: boolean;
  cacheHitRolePerms: boolean;
  extraReads: number;
}> {
  if (caller.role === 'super_admin') {
    return {
      canQrScan: true,
      canManualEntry: true,
      canCustomTime: true,
      cacheHitRolePerms: true,
      extraReads: 0,
    };
  }

  let extraReads = 0;
  try {
    const hasPrefetchedRolePerm =
      Boolean(caller.prefetchedRolePerm) && caller.prefetchedRolePerm!.role === caller.role;
    const [userPermSnap, rolePermSnap] = await Promise.all([
      caller.prefetchedUserPermSnap
        ? Promise.resolve(caller.prefetchedUserPermSnap)
        : (extraReads += 1, db.collection('user_permissions').doc(caller.profileDocId).get()),
      hasPrefetchedRolePerm
        ? Promise.resolve({
            exists: caller.prefetchedRolePerm!.exists,
            data: caller.prefetchedRolePerm!.data,
            cacheHit: caller.prefetchedRolePerm!.cacheHit,
          })
        : getCachedRolePermissionsDoc(db, caller.role).then((res) => {
            if (!res.cacheHit) extraReads += 1;
            return res;
          }),
    ]);

    const userPermData = userPermSnap.exists ? userPermSnap.data() : undefined;
    const rolePermData = rolePermSnap.exists ? rolePermSnap.data : undefined;

    let fallbackModules = caller.modulesAllowed;
    if (fallbackModules === undefined && caller.role !== 'admin') {
      extraReads += 1;
      const userSnap = await db.collection('user_roles').doc(caller.profileDocId).get();
      if (userSnap.exists && Array.isArray(userSnap.data()?.modulesAllowed)) {
        fallbackModules = userSnap.data()!.modulesAllowed;
      }
    }

    // Resolve QR Scan access with exact legacy fallback rules
    let canQrScan: boolean | null = null;
    if (userPermData && userPermData.isCustomOverride !== false) {
      const perms = userPermData.permissions || {};
      const qrEntry = perms['attendance.qr.scan'];
      if (qrEntry && typeof qrEntry === 'object' && (typeof qrEntry.view === 'boolean' || typeof qrEntry.add === 'boolean')) {
        canQrScan = isScannerCapabilityEntryEnabled(qrEntry);
      } else if (perms.scanner && typeof perms.scanner === 'object') {
        canQrScan = isScannerCapabilityEntryEnabled(perms.scanner);
      }
    }
    if (canQrScan === null && rolePermData) {
      const modPerms = rolePermData.modulePermissions || {};
      const qrEntry = modPerms['attendance.qr.scan'];
      if (qrEntry && typeof qrEntry === 'object' && (typeof qrEntry.view === 'boolean' || typeof qrEntry.add === 'boolean')) {
        canQrScan = isScannerCapabilityEntryEnabled(qrEntry);
      } else if (modPerms.scanner && typeof modPerms.scanner === 'object') {
        canQrScan = isScannerCapabilityEntryEnabled(modPerms.scanner);
      }
    }
    if (canQrScan === null) {
      canQrScan =
        evalModuleActionFromSnapshots(caller, userPermData, rolePermData, fallbackModules, 'scanner', 'view') &&
        evalModuleActionFromSnapshots(caller, userPermData, rolePermData, fallbackModules, 'scanner', 'add');
    }

    // Resolve Manual Employee ID Entry access (strictly deny-by-default)
    let canManualEntry: boolean | null = null;
    if (userPermData && userPermData.isCustomOverride !== false) {
      const perms = userPermData.permissions || {};
      const manualEntry = perms['attendance.manual.entry'];
      if (
        manualEntry &&
        typeof manualEntry === 'object' &&
        (typeof manualEntry.view === 'boolean' || typeof manualEntry.add === 'boolean')
      ) {
        canManualEntry = isScannerCapabilityEntryEnabled(manualEntry);
      } else if (perms.scanner?.view === false) {
        canManualEntry = false;
      }
    }
    if (canManualEntry === null && rolePermData) {
      const modPerms = rolePermData.modulePermissions || {};
      const manualEntry = modPerms['attendance.manual.entry'];
      if (
        manualEntry &&
        typeof manualEntry === 'object' &&
        (typeof manualEntry.view === 'boolean' || typeof manualEntry.add === 'boolean')
      ) {
        canManualEntry = isScannerCapabilityEntryEnabled(manualEntry);
      }
    }
    if (canManualEntry === null) {
      canManualEntry = false;
    }

    const canCustomTime =
      evalModuleActionFromSnapshots(caller, userPermData, rolePermData, fallbackModules, 'scanner', 'edit') ||
      evalModuleActionFromSnapshots(caller, userPermData, rolePermData, fallbackModules, 'history', 'edit');

    return {
      canQrScan,
      canManualEntry,
      canCustomTime,
      cacheHitRolePerms: rolePermSnap.cacheHit,
      extraReads,
    };
  } catch (err) {
    console.warn('[Attendance Permission Context] Lookup failed; failing closed:', (err as any)?.message || err);
    return {
      canQrScan: false,
      canManualEntry: false,
      canCustomTime: false,
      cacheHitRolePerms: false,
      extraReads,
    };
  }
}

export interface AttendanceRoutesDeps {
  db: AdminFirestoreLike;
  requireVerifiedCaller: (
    req: Request,
    res: Response,
    allowedRoles: string[] | '*',
    actionLabel: string,
    options?: {
      prefetchUserPermission?: boolean;
      onTokenVerified?: (verifiedUid: string) => void;
    }
  ) => Promise<VerifiedCaller | null>;
}

// ============================================================================
// Register Authenticated Server-Side Attendance Endpoints
// ============================================================================
export function registerAttendanceRoutes(app: express.Express, deps: AttendanceRoutesDeps) {
  const { db, requireVerifiedCaller } = deps;

  async function writePunchLog(entry: Record<string, any>) {
    const id = `log_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const safeEntry = {
      ...entry,
      rawPayload:
        typeof entry.rawPayload === 'string'
          ? String(redactSensitiveData(entry.rawPayload) ?? '')
          : entry.rawPayload,
      message:
        typeof entry.message === 'string'
          ? String(redactSensitiveData(entry.message) ?? '')
          : entry.message,
      id,
    };
    await db.collection('punch_logs').doc(id).set(safeEntry);
  }

  // --------------------------------------------------------------------------
  // 1. POST /api/attendance/scan — Authenticated Atomic First-In / Last-Out Engine
  // --------------------------------------------------------------------------
  app.post('/api/attendance/scan', async (req: Request, res: Response) => {
    const reqStartMs = performance.now();
    try {
      // Pure CPU pre-parse of body & QR payload so that strictly AFTER Firebase ID token
      // verification succeeds (verifyIdToken(token, true)), independent employee/attendance/config
      // reads can overlap with user_roles + user_permissions lookup (saving 1 full Firestore RTT).
      // HTTP status precedence remains unchanged: 401 -> 403 -> 400.
      const parsed = AttendanceScanSchema.safeParse(req.body);
      let preQrParseMs = 0;
      let preQr: ReturnType<typeof parseQrPayload> | null = null;
      let preNow: Date | null = null;
      let preYesterdayKey: string | null = null;
      if (parsed.success) {
        const qrParseStart = performance.now();
        preQr = parseQrPayload(parsed.data.rawPayload);
        preQrParseMs = roundMs(performance.now() - qrParseStart);
        const candidateNow = parsed.data.customScanTime ? new Date(parsed.data.customScanTime) : new Date();
        if (!Number.isNaN(candidateNow.getTime())) {
          preNow = candidateNow;
          preYesterdayKey = getYesterdayKolkataDateKey(candidateNow);
        }
      }

      let prefetchedEmployee: Promise<{ snap: any; ms: number }> | null = null;
      let prefetchedAttendance: Promise<{ snap: AdminQuerySnapLike; ms: number; yesterdayKey: string }> | null = null;
      let prefetchedConfig: Promise<{
        shiftsRes: { shifts: any[]; cacheHit: boolean };
        settingsRes: { exists: boolean; data: Record<string, any>; cacheHit: boolean };
        ms: number;
      }> | null = null;

      const caller = await requireVerifiedCaller(
        req,
        res,
        '*',
        'Attendance Scan Processing',
        {
          prefetchUserPermission: true,
          onTokenVerified: () => {
            if (!preQr || preQr.format === 'INVALID' || !preQr.employeeId) return;
            const empId = preQr.employeeId;
            const empStart = performance.now();
            prefetchedEmployee = db
              .collection('employees')
              .doc(empId)
              .get()
              .then((snap) => ({ snap, ms: roundMs(performance.now() - empStart) }));
            prefetchedEmployee.catch(() => {});

            // Concurrency safety: ONLY prefetch attendance query when no other scan for
            // this employee holds the mutex; if another scan arrives concurrently, the
            // mutex callback discards this snapshot and queries Firestore fresh.
            if (preYesterdayKey && !employeeScanLocks.has(empId)) {
              const attStart = performance.now();
              const yKey = preYesterdayKey;
              prefetchedAttendance = db
                .collection('attendance')
                .where('employeeId', '==', empId)
                .where('shiftDate', '>=', yKey)
                .get()
                .then((snap) => ({ snap, ms: roundMs(performance.now() - attStart), yesterdayKey: yKey }));
              prefetchedAttendance.catch(() => {});
            }

            const cfgStart = performance.now();
            prefetchedConfig = Promise.all([
              getCachedShifts(db, DEFAULT_SHIFTS),
              getCachedSystemSettings(db, DEFAULT_SETTINGS),
            ]).then(([shiftsRes, settingsRes]) => ({
              shiftsRes,
              settingsRes,
              ms: roundMs(performance.now() - cfgStart),
            }));
            prefetchedConfig.catch(() => {});
          },
        }
      );
      if (!caller) return;
      const authDoneMs = performance.now();

      const perms = await resolveCallerAttendancePermissions(db, caller);
      const permDoneMs = performance.now();

      if (!perms.canQrScan) {
        await recordEnterpriseAuditEvent(db, {
          req,
          action: 'unauthorized_access_attempt',
          category: 'SECURITY',
          severity: 'CRITICAL',
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: caller.role.toUpperCase(),
          targetType: 'ATTENDANCE_SCANNER',
          targetId: '/api/attendance/scan',
          actionSource: 'ATTENDANCE_PERMISSION_GUARD',
          description: `User "${caller.loginId}" (${caller.role}) blocked from /api/attendance/scan due to missing attendance.qr.scan permission.`,
          success: false,
          captureGeo: false,
        });
        return res.status(403).json({
          success: false,
          action: 'REJECTED',
          error: 'Forbidden: Your role does not have QR Code Scanning permission (attendance.qr.scan).',
          message: 'Forbidden: Your role does not have QR Code Scanning permission (attendance.qr.scan).',
        });
      }

      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          action: 'REJECTED',
          error: parsed.error.issues[0]?.message || 'Invalid scan payload.',
          message: parsed.error.issues[0]?.message || 'Invalid scan payload.',
        });
      }

      const { rawPayload, scannerDevice = 'USB_SCANNER', customScanTime, clientRequestId } = parsed.data;
      const { scannerType } = parsed.data;

      // Only roles permitted scanner.edit or history.edit can submit customScanTime (prevents operator timestamp spoofing)
      if (customScanTime && !perms.canCustomTime) {
        return res.status(403).json({
          success: false,
          error: 'Forbidden: Your role is not permitted to submit custom scan timestamps.',
        });
      }

      const now = preNow || (customScanTime ? new Date(customScanTime) : new Date());
      if (Number.isNaN(now.getTime())) {
        return res.status(400).json({ success: false, error: 'Invalid customScanTime timestamp.' });
      }

      const kolkata = getKolkataTimeParts(now);
      const timeDisplay = kolkata.timeWithSeconds;
      let qrParseMs = preQrParseMs;
      let qrParsed = preQr;
      if (!qrParsed) {
        const qrParseStartMs = performance.now();
        qrParsed = parseQrPayload(rawPayload);
        qrParseMs = roundMs(performance.now() - qrParseStartMs);
      }
      const { employeeId, token, format } = qrParsed;

      if (format === 'INVALID' || !employeeId) {
        await writePunchLog({
          employeeId: 'UNKNOWN',
          timestamp: now.toISOString(),
          action: 'REJECTED_TOKEN',
          rawPayload,
          scannerDevice,
          performedByUid: caller.uid,
          performedByLoginId: caller.loginId,
          message: 'Invalid QR Code payload format.',
        });
        return res.status(400).json({
          success: false,
          action: 'REJECTED',
          scannerType: scannerType || 'IN',
          error: 'Invalid QR payload. Please scan a valid Employee QR code or Employee ID.',
          message: 'Invalid QR payload. Please scan a valid Employee QR code or Employee ID.',
          time: timeDisplay,
        });
      }

      const dedupKey = clientRequestId ? `scan:${caller.uid}:${employeeId}:${clientRequestId}` : null;
      const outcome = await runWithOptionalClientRequestDedup(db, dedupKey, () =>
        withEmployeeScanLock(employeeId, async ({ waitedForLock }) => {
          const lookupStartMs = performance.now();
          const yesterdayKey = getYesterdayKolkataDateKey(now);

          const canReuseEmployee = Boolean(prefetchedEmployee);
          const canReuseAttendance = !waitedForLock && Boolean(prefetchedAttendance) && preYesterdayKey === yesterdayKey;
          const canReuseConfig = Boolean(prefetchedConfig);
          const parallelPrefetchUsed = canReuseEmployee && canReuseAttendance;

          const empTask = canReuseEmployee
            ? prefetchedEmployee!
            : (() => {
                const s = performance.now();
                return db
                  .collection('employees')
                  .doc(employeeId)
                  .get()
                  .then((snap) => ({ snap, ms: roundMs(performance.now() - s) }));
              })();

          const attTask = canReuseAttendance
            ? prefetchedAttendance!
            : (() => {
                const s = performance.now();
                return db
                  .collection('attendance')
                  .where('employeeId', '==', employeeId)
                  .where('shiftDate', '>=', yesterdayKey)
                  .get()
                  .then((snap) => ({ snap, ms: roundMs(performance.now() - s), yesterdayKey }));
              })();

          const cfgTask = canReuseConfig
            ? prefetchedConfig!
            : (() => {
                const s = performance.now();
                return Promise.all([
                  getCachedShifts(db, DEFAULT_SHIFTS),
                  getCachedSystemSettings(db, DEFAULT_SETTINGS),
                ]).then(([shiftsRes, settingsRes]) => ({
                  shiftsRes,
                  settingsRes,
                  ms: roundMs(performance.now() - s),
                }));
              })();

          // Single parallel batch (or near-zero await if already overlapped with caller lookup)
          const [empResult, attResult, cfgResult] = await Promise.all([empTask, attTask, cfgTask]);
          const empSnap = empResult.snap;
          const candidateSnap = attResult.snap;
          const { shiftsRes, settingsRes } = cfgResult;
          const lookupDoneMs = performance.now();

          if (!empSnap.exists) {
            await writePunchLog({
              employeeId,
              timestamp: now.toISOString(),
              action: 'REJECTED_TOKEN',
              rawPayload,
              scannerDevice,
              performedByUid: caller.uid,
              performedByLoginId: caller.loginId,
              message: `Employee ID ${employeeId} not found in database.`,
            });
            return {
              httpStatus: 404,
              body: {
                success: false,
                action: 'REJECTED',
                scannerType: scannerType || 'IN',
                error: `Invalid QR Code. Employee "${employeeId}" Not Found.`,
                message: `Invalid QR Code. Employee "${employeeId}" Not Found.`,
                time: timeDisplay,
              },
            };
          }

          const tokenValStartMs = performance.now();
          const employee = empSnap.data()!;
          if (employee.employeeStatus !== 'Active') {
            await writePunchLog({
              employeeId: employee.employeeId,
              employeeName: employee.employeeName,
              timestamp: now.toISOString(),
              action: 'REJECTED_INACTIVE',
              rawPayload,
              scannerDevice,
              performedByUid: caller.uid,
              performedByLoginId: caller.loginId,
              message: `Employee ${employeeId} is inactive.`,
            });
            return {
              httpStatus: 400,
              body: {
                success: false,
                action: 'REJECTED',
                scannerType: scannerType || 'IN',
                employee: sanitizeEmployeeForApi(employee),
                error: 'Employee Is Inactive. Attendance Cannot Be Recorded.',
                message: 'Employee Is Inactive. Attendance Cannot Be Recorded.',
                time: timeDisplay,
              },
            };
          }

          // Strict QR security token validation (unchanged for QR scans):
          if (employee.qrCodeToken && (!token || token !== employee.qrCodeToken)) {
            await writePunchLog({
              employeeId: employee.employeeId,
              employeeName: employee.employeeName,
              timestamp: now.toISOString(),
              action: 'REJECTED_TOKEN',
              rawPayload: '[REDACTED_QR_PAYLOAD]',
              scannerDevice,
              qrVerificationMode: 'TOKEN_REJECTED',
              performedByUid: caller.uid,
              performedByLoginId: caller.loginId,
              message: token
                ? 'Token mismatch: provided QR security token did not match employee record.'
                : 'Missing required QR security token for employee with configured qrCodeToken.',
            });
            return {
              httpStatus: 403,
              body: {
                success: false,
                action: 'REJECTED',
                scannerType: scannerType || 'IN',
                employee: sanitizeEmployeeForApi(employee),
                error: token
                  ? 'QR Token Expired or Revoked. Please re-issue QR code.'
                  : 'Invalid QR Payload: Security token is required for this employee.',
                message: token
                  ? 'QR Token Expired or Revoked. Please re-issue QR code.'
                  : 'Invalid QR Payload: Security token is required for this employee.',
                time: timeDisplay,
              },
            };
          }
          const tokenValDoneMs = performance.now();

          const qrVerificationMode = token ? 'TOKEN_VERIFIED' : 'UNTOKENIZED_EMPLOYEE';
          const txStartMs = performance.now();
          const punchRes = await executePunchForVerifiedEmployee({
            req,
            employee,
            caller,
            now,
            kolkata,
            timeDisplay,
            scannerType,
            scannerDevice,
            rawPayload,
            qrVerificationMode,
            shifts: shiftsRes.shifts,
            settings: settingsRes.data,
            candidateSnap,
          });
          const txDoneMs = performance.now();

          const lookupDuration = lookupDoneMs - lookupStartMs;
          const txDuration = txDoneMs - txStartMs;
          const isCommittedPunch =
            punchRes.httpStatus === 200 && Boolean(punchRes.body?.success);
          const isDuplicateReject = punchRes.body?.action === 'REJECTED_DUPLICATE';
          const txReads = isCommittedPunch || isDuplicateReject ? 1 : 0;
          const txWrites = isCommittedPunch ? 3 : 1;
          const configReads = (shiftsRes.cacheHit ? 0 : 1) + (settingsRes.cacheHit ? 0 : 1);
          const totalFirestoreReads =
            (caller.authFirestoreReads ?? 0) +
            perms.extraReads +
            1 + // employees/{id}
            1 + // attendance query
            configReads +
            txReads;
          const totalFirestoreWrites = (caller.authFirestoreWrites ?? 0) + txWrites;

          const perf: AttendancePerfMetrics = {
            qrParseMs,
            tokenVerifyMs: caller.tokenVerifyMs,
            callerLookupMs: caller.callerLookupMs,
            authMs: roundMs(authDoneMs - reqStartMs),
            permissionMs: roundMs(permDoneMs - authDoneMs),
            employeeLookupMs: empResult.ms,
            attendanceLookupMs: attResult.ms,
            configLookupMs: cfgResult.ms,
            lookupAndQueryMs: roundMs(lookupDuration),
            tokenValidationMs: roundMs(tokenValDoneMs - tokenValStartMs),
            txMs: roundMs(txDuration),
            firestoreOpMs: roundMs(lookupDuration + txDuration),
            auditMs: 0,
            totalServerMs: roundMs(txDoneMs - reqStartMs),
            firestoreReads: totalFirestoreReads,
            firestoreWrites: totalFirestoreWrites,
            parallelPrefetchUsed,
            cacheHitRolePerms: perms.cacheHitRolePerms,
            cacheHitConfig: shiftsRes.cacheHit && settingsRes.cacheHit,
            cacheHitUidRoute: Boolean(caller.cacheHitUidRoute),
          };
          emitNonSensitivePerfLog('attendance.scan', {
            status: punchRes.httpStatus,
            ...perf,
          });
          return {
            httpStatus: punchRes.httpStatus,
            body: { ...punchRes.body, perf },
          };
        })
      );

      const scanTotalMs = roundMs(performance.now() - reqStartMs);
      const outcomePerf = (outcome.body as any)?.perf;
      const outcomeAction = String((outcome.body as any)?.action || 'REJECTED');
      const resolvedDir: 'IN' | 'OUT' =
        (outcome.body as any)?.scannerType === 'OUT' || scannerType === 'OUT' ? 'OUT' : 'IN';
      const isSuccess = outcome.httpStatus >= 200 && outcome.httpStatus < 300 && Boolean((outcome.body as any)?.success);
      const isDuplicate = outcomeAction === 'REJECTED_DUPLICATE';

      recordQrPunchTelemetry(db, {
        mode: resolvedDir === 'OUT' ? 'QR_OUT' : 'QR_IN',
        action: outcomeAction,
        success: isSuccess,
        isDuplicateRejection: isDuplicate,
        timedOut: outcome.httpStatus === 408 || outcome.httpStatus === 504,
        qrParseMs,
        tokenVerifyMs: outcomePerf?.tokenVerifyMs ?? caller.tokenVerifyMs,
        callerLookupMs: outcomePerf?.callerLookupMs ?? caller.callerLookupMs,
        authMs: outcomePerf?.authMs ?? roundMs(authDoneMs - reqStartMs),
        permissionMs: outcomePerf?.permissionMs ?? roundMs(permDoneMs - authDoneMs),
        employeeLookupMs: outcomePerf?.employeeLookupMs,
        attendanceLookupMs: outcomePerf?.attendanceLookupMs,
        configLookupMs: outcomePerf?.configLookupMs,
        lookupAndQueryMs: outcomePerf?.lookupAndQueryMs,
        tokenValidationMs: outcomePerf?.tokenValidationMs,
        txMs: outcomePerf?.txMs,
        firestoreOpMs: outcomePerf?.firestoreOpMs,
        auditMs: outcomePerf?.auditMs ?? 0,
        firestoreReads: outcomePerf?.firestoreReads,
        firestoreWrites: outcomePerf?.firestoreWrites,
        totalServerMs: outcomePerf?.totalServerMs ?? scanTotalMs,
        reasonCode: isSuccess ? undefined : outcomeAction,
        correlationId: (req as any).correlationId,
      });

      if (typeof outcomePerf?.lookupAndQueryMs === 'number') {
        recordDbOpMetric(db, {
          operation: 'QUERY',
          collection: 'employees+attendance',
          durationMs: outcomePerf.lookupAndQueryMs,
          success: true,
          correlationId: (req as any).correlationId,
        });
      }
      if (typeof outcomePerf?.txMs === 'number') {
        recordDbOpMetric(db, {
          operation: 'TRANSACTION',
          collection: 'attendance',
          durationMs: outcomePerf.txMs,
          success: outcome.httpStatus < 500,
          correlationId: (req as any).correlationId,
        });
      }

      recordActivityTelemetry(db, {
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        action: isSuccess
          ? resolvedDir === 'OUT'
            ? 'QR_PUNCH_OUT'
            : 'QR_PUNCH_IN'
          : `QR_SCAN_${outcomeAction}`,
        module: 'Attendance Scanner',
        result: isSuccess ? 'Success' : 'Failed',
        correlationId: (req as any).correlationId,
        detail: `${resolvedDir} scan via ${scannerDevice} (${outcome.httpStatus})`,
      });

      return res.status(outcome.httpStatus).json(outcome.body);
    } catch (err: any) {
      console.error('[API Attendance Scan] Error:', err);
      const errMsg = String(err?.message || 'Attendance scan processing failed.');
      recordDbOpMetric(db, {
        operation: 'TRANSACTION',
        collection: 'attendance',
        durationMs: roundMs(performance.now() - reqStartMs),
        success: false,
        isPermissionDenied: errMsg.toLowerCase().includes('permission'),
        isNetworkError: errMsg.toLowerCase().includes('timeout') || errMsg.toLowerCase().includes('unavailable'),
        errorMessage: errMsg,
        correlationId: (req as any).correlationId,
      });
      recordQrPunchTelemetry(db, {
        mode: 'QR_IN',
        action: 'SYSTEM_ERROR',
        success: false,
        isDuplicateRejection: false,
        timedOut: errMsg.toLowerCase().includes('timeout'),
        totalServerMs: roundMs(performance.now() - reqStartMs),
        reasonCode: 'SYSTEM_ERROR',
        correlationId: (req as any).correlationId,
      });
      return res.status(500).json({
        success: false,
        action: 'REJECTED',
        error: 'Attendance scan processing failed.',
        message: 'Attendance scan processing failed.',
      });
    }
  });

  // --------------------------------------------------------------------------
  // 1b. POST /api/attendance/manual-punch — Authorized Manual Employee ID Entry
  //     Separate from QR token verification; enforces caller RBAC + employee validation + attendance rules.
  // --------------------------------------------------------------------------
  app.post('/api/attendance/manual-punch', async (req: Request, res: Response) => {
    const reqStartMs = performance.now();
    try {
      const parsed = ManualPunchSchema.safeParse(req.body);
      let preNow: Date | null = null;
      let preYesterdayKey: string | null = null;
      if (parsed.success) {
        const candidateNow = parsed.data.customScanTime ? new Date(parsed.data.customScanTime) : new Date();
        if (!Number.isNaN(candidateNow.getTime())) {
          preNow = candidateNow;
          preYesterdayKey = getYesterdayKolkataDateKey(candidateNow);
        }
      }

      let prefetchedEmployee: Promise<{ snap: any; ms: number }> | null = null;
      let prefetchedAttendance: Promise<{ snap: AdminQuerySnapLike; ms: number; yesterdayKey: string }> | null = null;
      let prefetchedConfig: Promise<{
        shiftsRes: { shifts: any[]; cacheHit: boolean };
        settingsRes: { exists: boolean; data: Record<string, any>; cacheHit: boolean };
        ms: number;
      }> | null = null;

      const caller = await requireVerifiedCaller(
        req,
        res,
        '*',
        'Manual Employee ID Punch',
        {
          prefetchUserPermission: true,
          onTokenVerified: () => {
            if (!parsed.success) return;
            const empId = parsed.data.employeeId;
            const empStart = performance.now();
            prefetchedEmployee = db
              .collection('employees')
              .doc(empId)
              .get()
              .then((snap) => ({ snap, ms: roundMs(performance.now() - empStart) }));
            prefetchedEmployee.catch(() => {});

            if (preYesterdayKey && !employeeScanLocks.has(empId)) {
              const attStart = performance.now();
              const yKey = preYesterdayKey;
              prefetchedAttendance = db
                .collection('attendance')
                .where('employeeId', '==', empId)
                .where('shiftDate', '>=', yKey)
                .get()
                .then((snap) => ({ snap, ms: roundMs(performance.now() - attStart), yesterdayKey: yKey }));
              prefetchedAttendance.catch(() => {});
            }

            const cfgStart = performance.now();
            prefetchedConfig = Promise.all([
              getCachedShifts(db, DEFAULT_SHIFTS),
              getCachedSystemSettings(db, DEFAULT_SETTINGS),
            ]).then(([shiftsRes, settingsRes]) => ({
              shiftsRes,
              settingsRes,
              ms: roundMs(performance.now() - cfgStart),
            }));
            prefetchedConfig.catch(() => {});
          },
        }
      );
      if (!caller) return;
      const authDoneMs = performance.now();

      const perms = await resolveCallerAttendancePermissions(db, caller);
      const permDoneMs = performance.now();

      if (!perms.canManualEntry) {
        await recordEnterpriseAuditEvent(db, {
          req,
          action: 'unauthorized_access_attempt',
          category: 'SECURITY',
          severity: 'CRITICAL',
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: caller.role.toUpperCase(),
          targetType: 'ATTENDANCE_MANUAL_PUNCH',
          targetId: '/api/attendance/manual-punch',
          actionSource: 'ATTENDANCE_PERMISSION_GUARD',
          description: `User "${caller.loginId}" (${caller.role}) blocked from /api/attendance/manual-punch due to missing attendance.manual.entry permission.`,
          success: false,
          captureGeo: false,
        });
        return res.status(403).json({
          success: false,
          action: 'REJECTED',
          error: 'Forbidden: Your role does not have Manual Employee ID Entry permission (attendance.manual.entry).',
          message: 'Forbidden: Your role does not have Manual Employee ID Entry permission (attendance.manual.entry).',
        });
      }

      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          action: 'REJECTED',
          error: parsed.error.issues[0]?.message || 'Invalid Employee ID.',
          message: parsed.error.issues[0]?.message || 'Invalid Employee ID.',
        });
      }

      const { employeeId, scannerType, reason, customScanTime, clientRequestId } = parsed.data;

      if (customScanTime && !perms.canCustomTime) {
        return res.status(403).json({
          success: false,
          error: 'Forbidden: Your role is not permitted to submit custom punch timestamps.',
        });
      }

      const now = preNow || (customScanTime ? new Date(customScanTime) : new Date());
      if (Number.isNaN(now.getTime())) {
        return res.status(400).json({ success: false, error: 'Invalid customScanTime timestamp.' });
      }

      const kolkata = getKolkataTimeParts(now);
      const timeDisplay = kolkata.timeWithSeconds;
      const rawPayload = `MANUAL:${employeeId}`;

      const dedupKey = clientRequestId ? `manual:${caller.uid}:${employeeId}:${clientRequestId}` : null;
      const outcome = await runWithOptionalClientRequestDedup(db, dedupKey, () =>
        withEmployeeScanLock(employeeId, async ({ waitedForLock }) => {
          const lookupStartMs = performance.now();
          const yesterdayKey = getYesterdayKolkataDateKey(now);

          const canReuseEmployee = Boolean(prefetchedEmployee);
          const canReuseAttendance = !waitedForLock && Boolean(prefetchedAttendance) && preYesterdayKey === yesterdayKey;
          const canReuseConfig = Boolean(prefetchedConfig);
          const parallelPrefetchUsed = canReuseEmployee && canReuseAttendance;

          const empTask = canReuseEmployee
            ? prefetchedEmployee!
            : (() => {
                const s = performance.now();
                return db
                  .collection('employees')
                  .doc(employeeId)
                  .get()
                  .then((snap) => ({ snap, ms: roundMs(performance.now() - s) }));
              })();

          const attTask = canReuseAttendance
            ? prefetchedAttendance!
            : (() => {
                const s = performance.now();
                return db
                  .collection('attendance')
                  .where('employeeId', '==', employeeId)
                  .where('shiftDate', '>=', yesterdayKey)
                  .get()
                  .then((snap) => ({ snap, ms: roundMs(performance.now() - s), yesterdayKey }));
              })();

          const cfgTask = canReuseConfig
            ? prefetchedConfig!
            : (() => {
                const s = performance.now();
                return Promise.all([
                  getCachedShifts(db, DEFAULT_SHIFTS),
                  getCachedSystemSettings(db, DEFAULT_SETTINGS),
                ]).then(([shiftsRes, settingsRes]) => ({
                  shiftsRes,
                  settingsRes,
                  ms: roundMs(performance.now() - s),
                }));
              })();

          const [empResult, attResult, cfgResult] = await Promise.all([empTask, attTask, cfgTask]);
          const empSnap = empResult.snap;
          const candidateSnap = attResult.snap;
          const { shiftsRes, settingsRes } = cfgResult;
          const lookupDoneMs = performance.now();

          if (!empSnap.exists) {
            await writePunchLog({
              employeeId,
              timestamp: now.toISOString(),
              action: 'REJECTED_TOKEN',
              rawPayload,
              scannerDevice: 'MANUAL',
              qrVerificationMode: 'MANUAL_EMPLOYEE_ID',
              performedByUid: caller.uid,
              performedByLoginId: caller.loginId,
              message: `Manual entry rejected: Employee ID ${employeeId} not found in database.`,
            });
            return {
              httpStatus: 404,
              body: {
                success: false,
                action: 'REJECTED',
                scannerType: scannerType || 'IN',
                error: `Employee "${employeeId}" Not Found.`,
                message: `Employee "${employeeId}" Not Found.`,
                time: timeDisplay,
              },
            };
          }

          const employee = empSnap.data()!;
          if (employee.employeeStatus !== 'Active') {
            await writePunchLog({
              employeeId: employee.employeeId,
              employeeName: employee.employeeName,
              timestamp: now.toISOString(),
              action: 'REJECTED_INACTIVE',
              rawPayload,
              scannerDevice: 'MANUAL',
              qrVerificationMode: 'MANUAL_EMPLOYEE_ID',
              performedByUid: caller.uid,
              performedByLoginId: caller.loginId,
              message: `Manual entry rejected: Employee ${employeeId} is inactive.`,
            });
            return {
              httpStatus: 400,
              body: {
                success: false,
                action: 'REJECTED',
                scannerType: scannerType || 'IN',
                employee: sanitizeEmployeeForApi(employee),
                error: 'Employee Is Inactive. Attendance Cannot Be Recorded.',
                message: 'Employee Is Inactive. Attendance Cannot Be Recorded.',
                time: timeDisplay,
              },
            };
          }

          const txStartMs = performance.now();
          const result = await executePunchForVerifiedEmployee({
            req,
            employee,
            caller,
            now,
            kolkata,
            timeDisplay,
            scannerType,
            scannerDevice: 'MANUAL',
            rawPayload,
            qrVerificationMode: 'MANUAL_EMPLOYEE_ID',
            shifts: shiftsRes.shifts,
            settings: settingsRes.data,
            candidateSnap,
          });
          const txDoneMs = performance.now();

          let auditDoneMs = txDoneMs;
          let auditWrites = 0;
          if (result.httpStatus === 200 && result.body.success) {
            await recordEnterpriseAuditEvent(db, {
              req,
              action: 'MANUAL_ATTENDANCE_PUNCH',
              category: 'ATTENDANCE',
              actorUid: caller.uid,
              actorLoginId: caller.loginId,
              actorRole: caller.role.toUpperCase(),
              employeeId: employee.employeeId,
              targetType: 'ATTENDANCE',
              targetId: result.body.attendance?.id || employee.employeeId,
              newValue: `${result.body.action} via manual ID entry (${employee.employeeId})`,
              actionSource: 'MANUAL_SCANNER_ENTRY',
              reason: reason || 'Authorized operator manual Employee ID punch',
              captureGeo: false,
            });
            auditWrites = 1;
            auditDoneMs = performance.now();
          }

          const lookupDuration = lookupDoneMs - lookupStartMs;
          const txDuration = txDoneMs - txStartMs;
          const isCommittedPunch =
            result.httpStatus === 200 && Boolean(result.body?.success);
          const isDuplicateReject = result.body?.action === 'REJECTED_DUPLICATE';
          const txReads = isCommittedPunch || isDuplicateReject ? 1 : 0;
          const txWrites = isCommittedPunch ? 3 : 1;
          const configReads = (shiftsRes.cacheHit ? 0 : 1) + (settingsRes.cacheHit ? 0 : 1);
          const totalFirestoreReads =
            (caller.authFirestoreReads ?? 0) +
            perms.extraReads +
            1 +
            1 +
            configReads +
            txReads;
          const totalFirestoreWrites = (caller.authFirestoreWrites ?? 0) + txWrites + auditWrites;

          const perf: AttendancePerfMetrics = {
            tokenVerifyMs: caller.tokenVerifyMs,
            callerLookupMs: caller.callerLookupMs,
            authMs: roundMs(authDoneMs - reqStartMs),
            permissionMs: roundMs(permDoneMs - authDoneMs),
            employeeLookupMs: empResult.ms,
            attendanceLookupMs: attResult.ms,
            configLookupMs: cfgResult.ms,
            lookupAndQueryMs: roundMs(lookupDuration),
            txMs: roundMs(txDuration),
            firestoreOpMs: roundMs(lookupDuration + txDuration),
            auditMs: roundMs(auditDoneMs - txDoneMs),
            totalServerMs: roundMs(auditDoneMs - reqStartMs),
            firestoreReads: totalFirestoreReads,
            firestoreWrites: totalFirestoreWrites,
            parallelPrefetchUsed,
            cacheHitRolePerms: perms.cacheHitRolePerms,
            cacheHitConfig: shiftsRes.cacheHit && settingsRes.cacheHit,
            cacheHitUidRoute: Boolean(caller.cacheHitUidRoute),
          };
          emitNonSensitivePerfLog('attendance.manual_punch', {
            status: result.httpStatus,
            ...perf,
          });

          return {
            httpStatus: result.httpStatus,
            body: { ...result.body, perf },
          };
        })
      );

      const manualTotalMs = roundMs(performance.now() - reqStartMs);
      const outcomePerf = (outcome.body as any)?.perf;
      const outcomeAction = String((outcome.body as any)?.action || 'REJECTED');
      const isSuccess = outcome.httpStatus >= 200 && outcome.httpStatus < 300 && Boolean((outcome.body as any)?.success);
      const isDuplicate = outcomeAction === 'REJECTED_DUPLICATE';

      recordQrPunchTelemetry(db, {
        mode: scannerType === 'OUT' ? 'MANUAL_OUT' : 'MANUAL_IN',
        action: outcomeAction,
        success: isSuccess,
        isDuplicateRejection: isDuplicate,
        timedOut: outcome.httpStatus === 408 || outcome.httpStatus === 504,
        tokenVerifyMs: outcomePerf?.tokenVerifyMs ?? caller.tokenVerifyMs,
        callerLookupMs: outcomePerf?.callerLookupMs ?? caller.callerLookupMs,
        authMs: outcomePerf?.authMs ?? roundMs(authDoneMs - reqStartMs),
        permissionMs: outcomePerf?.permissionMs ?? roundMs(permDoneMs - authDoneMs),
        employeeLookupMs: outcomePerf?.employeeLookupMs,
        attendanceLookupMs: outcomePerf?.attendanceLookupMs,
        configLookupMs: outcomePerf?.configLookupMs,
        lookupAndQueryMs: outcomePerf?.lookupAndQueryMs,
        txMs: outcomePerf?.txMs,
        firestoreOpMs: outcomePerf?.firestoreOpMs,
        auditMs: outcomePerf?.auditMs,
        firestoreReads: outcomePerf?.firestoreReads,
        firestoreWrites: outcomePerf?.firestoreWrites,
        totalServerMs: outcomePerf?.totalServerMs ?? manualTotalMs,
        reasonCode: isSuccess ? undefined : outcomeAction,
        correlationId: (req as any).correlationId,
      });

      if (typeof outcomePerf?.txMs === 'number') {
        recordDbOpMetric(db, {
          operation: 'TRANSACTION',
          collection: 'attendance',
          durationMs: outcomePerf.txMs,
          success: outcome.httpStatus < 500,
          correlationId: (req as any).correlationId,
        });
      }

      recordActivityTelemetry(db, {
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        action: isSuccess ? `MANUAL_PUNCH_${scannerType}` : `MANUAL_PUNCH_${outcomeAction}`,
        module: 'Attendance Scanner',
        result: isSuccess ? 'Success' : 'Failed',
        correlationId: (req as any).correlationId,
        detail: `Manual ${scannerType} entry (${outcome.httpStatus})`,
      });

      return res.status(outcome.httpStatus).json(outcome.body);
    } catch (err: any) {
      console.error('[API Manual Punch] Error:', err);
      recordErrorTelemetry(db, {
        source: 'BACKEND',
        module: 'Attendance Scanner',
        category: 'MANUAL_PUNCH_ERROR',
        severity: 'CRITICAL',
        message: err?.message || 'Manual attendance punch processing failed.',
        statusCode: 500,
        correlationId: (req as any).correlationId,
      });
      return res.status(500).json({
        success: false,
        action: 'REJECTED',
        error: 'Manual attendance punch processing failed.',
        message: 'Manual attendance punch processing failed.',
      });
    }
  });

  async function executePunchForVerifiedEmployee(params: {
    req?: Request;
    employee: Record<string, any>;
    caller: VerifiedCaller;
    now: Date;
    kolkata: ReturnType<typeof getKolkataTimeParts>;
    timeDisplay: string;
    scannerType?: 'IN' | 'OUT';
    scannerDevice: 'USB_SCANNER' | 'WEBCAM' | 'MANUAL' | 'SYSTEM_AUTO';
    rawPayload: string;
    qrVerificationMode: string;
    shifts: any[];
    settings: Record<string, any>;
    candidateSnap: AdminQuerySnapLike;
  }): Promise<{ httpStatus: number; body: Record<string, any> }> {
    const {
      req,
      employee,
      caller,
      now,
      kolkata,
      timeDisplay,
      scannerDevice,
      rawPayload,
      qrVerificationMode,
      shifts,
      settings,
      candidateSnap,
    } = params;
    let { scannerType } = params;
    const safeEmployee = sanitizeEmployeeForApi(employee);
    const safeRawPayload = String(redactSensitiveData(rawPayload) ?? '');

        const shiftsMap = new Map(shifts.map((s) => [s.id, s]));

        const todayKey = kolkata.dateKey;
        const yesterdayKey = getYesterdayKolkataDateKey(now);
        const currentMins = kolkata.totalMinutes;

        const existingRecords = candidateSnap.docs
          .map((d) => d.data()!)
          .sort((a, b) => new Date(b.punchIn).getTime() - new Date(a.punchIn).getTime());

        const isNightRecord = (r: Record<string, any>) =>
          r.shiftId === 'NIGHT' || String(r.shiftNameSnapshot || '').toUpperCase().includes('NIGHT');
        const isOpenRecord = (r: Record<string, any>) =>
          r.currentState === 'INSIDE' || (!r.actualPunchOut && r.punchOutType === 'NONE');
        const isAutoClosedReconcilableRecord = (r: Record<string, any>) =>
          r.punchOutType === 'AUTO' &&
          r.autoClosed === true &&
          !r.actualPunchOut &&
          r.reconciledFromAutoClose !== true;

        const todayRecords = existingRecords.filter((r) => r.shiftDate === todayKey);
        const yesterdayNight = existingRecords.find(
          (r) => r.shiftDate === yesterdayKey && isNightRecord(r)
        );
        // Night shift continuation window on date D+1 extends up to 18:00 IST (before next Night Shift window starts),
        // ensuring genuine post-09:00 AM Night Shift Punch-Outs still attach to date D's Night Shift.
        const isWithinNightContinuationWindow = Boolean(
          yesterdayNight &&
            currentMins < 18 * 60 &&
            now.getTime() >= new Date(yesterdayNight.firstPunchIn || yesterdayNight.punchIn).getTime()
        );

        let activeRecord: Record<string, any> | null = null;
        if (scannerType === 'OUT') {
          // Priority 1: Open record on todayKey
          const todayOpen = todayRecords.find(isOpenRecord);
          if (todayOpen) {
            activeRecord = todayOpen;
          } else if (yesterdayNight && isOpenRecord(yesterdayNight) && isWithinNightContinuationWindow) {
            // Priority 2: Open Night Shift record from yesterdayKey (including after 09:00 AM)
            activeRecord = yesterdayNight;
          } else {
            // Priority 3: Reconcilable provisional AUTO CLOSED record on todayKey
            const todayAutoClosed = todayRecords.find(isAutoClosedReconcilableRecord);
            if (todayAutoClosed) {
              activeRecord = todayAutoClosed;
            } else if (
              todayRecords.length === 0 &&
              yesterdayNight &&
              isAutoClosedReconcilableRecord(yesterdayNight) &&
              isWithinNightContinuationWindow
            ) {
              // Priority 4: Reconcilable provisional AUTO CLOSED Night Shift record from yesterdayKey
              // (only when employee has NOT started a new shift on todayKey)
              activeRecord = yesterdayNight;
            } else if (todayRecords.length > 0) {
              // Priority 5: Already-closed today record (for clean duplicate OUT 409 rejection)
              activeRecord = todayRecords[0];
            } else if (yesterdayNight && isWithinNightContinuationWindow) {
              // Priority 6: Already-closed yesterday Night Shift record (for clean duplicate OUT 409 rejection)
              activeRecord = yesterdayNight;
            }
          }
        } else {
          // ScannerType 'IN' or auto-detect
          if (yesterdayNight && isWithinNightContinuationWindow) {
            const isYesterdayNightOpen = isOpenRecord(yesterdayNight);
            // Attach to yesterday's Night shift if still open OR before 06:00 AM (cross-midnight Night shift window)
            if (isYesterdayNightOpen || currentMins < 360) {
              activeRecord = yesterdayNight;
            }
          }
          if (!activeRecord) {
            const todayOpenRecord = todayRecords.find(isOpenRecord);
            if (todayOpenRecord) {
              activeRecord = todayOpenRecord;
            } else {
              const expectedShiftMatch = identifyShiftForPunchIn(shifts, now);
              const expectedShiftId = expectedShiftMatch?.shift?.id;
              activeRecord =
                todayRecords.find(
                  (r) => !expectedShiftId || r.shiftId === expectedShiftId
                ) || null;
            }
          }
        }

        // Auto-detect scannerType if omitted
        if (!scannerType) {
          const derivedState =
            activeRecord?.currentState ||
            (activeRecord?.actualPunchOut ? 'OUTSIDE' : activeRecord ? 'INSIDE' : 'OUTSIDE');
          scannerType = derivedState === 'INSIDE' ? 'OUT' : 'IN';
        }

        // ------------------------------------------------------------------
        // SCANNER TYPE: 'IN'
        // ------------------------------------------------------------------
        if (scannerType === 'IN') {
          if (activeRecord) {
            const docRef = db.collection('attendance').doc(activeRecord.id);
            const eventId = `pe_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
            const logId = `log_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

            const txRes = await db.runTransaction(async (tx) => {
              const snap = await tx.get(docRef);
              const currentData = snap.exists ? snap.data()! : activeRecord!;
              const currentState =
                currentData.currentState ||
                (currentData.actualPunchOut || currentData.punchOutType === 'ACTUAL' ? 'OUTSIDE' : 'INSIDE');

              if (currentState === 'INSIDE') {
                return { kind: 'CONSECUTIVE_IN' as const, record: currentData };
              }

              const lastPunchTime =
                Array.isArray(currentData.punches) && currentData.punches.length > 0
                  ? new Date(currentData.punches[currentData.punches.length - 1].timestamp).getTime()
                  : new Date(currentData.updatedAt || currentData.punchIn).getTime();

              if (Math.abs(now.getTime() - lastPunchTime) < 3000) {
                return { kind: 'BOUNCE' as const, record: currentData };
              }

              const punchEvent = {
                id: eventId,
                employeeId: employee.employeeId,
                employeeName: employee.employeeName,
                eventType: 'IN',
                timestamp: now.toISOString(),
                displayTime: timeDisplay,
                shiftDate: currentData.shiftDate,
                shiftId: currentData.shiftId,
                shiftName: currentData.shiftNameSnapshot,
                floor: employee.floor,
                section: employee.section,
                department: employee.department,
                scannerType: 'IN',
                scannerDevice,
                status: 'SUBSEQUENT_IN',
                recordedByUid: caller.uid,
                recordedByLoginId: caller.loginId,
              };

              const existingPunches = Array.isArray(currentData.punches) ? currentData.punches : [];
              const updatedAttendance: Record<string, any> = {
                ...currentData,
                currentState: 'INSIDE',
                punchOutType: 'NONE',
                attendanceStatus: 'IN PROGRESS',
                totalDutyMinutes: 0,
                regularDutyMinutes: 0,
                overtimeMinutes: 0,
                earlyOtMinutes: 0,
                postShiftOtMinutes: 0,
                totalOtMinutes: 0,
                earlyOtFinalized: false,
                punches: [...existingPunches, punchEvent],
                updatedAt: now.toISOString(),
              };

              tx.set(docRef, updatedAttendance);
              tx.set(db.collection('punch_events').doc(eventId), punchEvent);
              tx.set(db.collection('punch_logs').doc(logId), {
                id: logId,
                employeeId: employee.employeeId,
                employeeName: employee.employeeName,
                timestamp: now.toISOString(),
                action: 'PUNCH_IN',
                rawPayload,
                scannerDevice,
                qrVerificationMode,
                performedByUid: caller.uid,
                performedByLoginId: caller.loginId,
                message: `Subsequent Punch In (Event #${updatedAttendance.punches.length}). State: INSIDE, Status: IN PROGRESS.`,
              });

              return { kind: 'RECORDED' as const, record: updatedAttendance };
            });

            if (txRes.kind === 'CONSECUTIVE_IN') {
              await writePunchLog({
                employeeId: employee.employeeId,
                employeeName: employee.employeeName,
                timestamp: now.toISOString(),
                action: 'REJECTED_DUPLICATE',
                rawPayload,
                scannerDevice,
                performedByUid: caller.uid,
                performedByLoginId: caller.loginId,
                message: `Consecutive Punch In rejected. Employee already Punched In at ${formatTimeDisplay(txRes.record.punchIn)}.`,
              });
              return {
                httpStatus: 409,
                body: {
                  success: false,
                  action: 'REJECTED_DUPLICATE',
                  scannerType: 'IN',
                  currentState: 'INSIDE',
                  employee: safeEmployee,
                  attendance: sanitizeAttendanceForApi(txRes.record),
                  message: 'Consecutive Punch In rejected. Employee is already Punched In (Status: INSIDE).',
                  time: timeDisplay,
                  punchCount: txRes.record.punches?.length || 1,
                },
              };
            }

            if (txRes.kind === 'BOUNCE') {
              return {
                httpStatus: 429,
                body: {
                  success: false,
                  action: 'REJECTED_DUPLICATE',
                  scannerType: 'IN',
                  currentState: 'OUTSIDE',
                  employee: safeEmployee,
                  attendance: sanitizeAttendanceForApi(txRes.record),
                  message: 'Duplicate scan prevented. Please wait a few seconds before scanning again.',
                  time: timeDisplay,
                },
              };
            }

            const shift = shiftsMap.get(txRes.record.shiftId) || shifts[0];
            const reentryBounds = resolveShiftScheduleBounds(txRes.record.shiftDate || todayKey, {
              ...shift,
              shiftId: txRes.record.shiftId,
              shiftNameSnapshot: txRes.record.shiftNameSnapshot,
              scheduledPunchIn: txRes.record.scheduledPunchIn || shift?.startTime,
              scheduledPunchOut: txRes.record.scheduledPunchOut || shift?.endTime,
            });
            const reentrySchedule = computeExpectedPunchOutTimes({
              firstInIso: txRes.record.firstPunchIn || txRes.record.punchIn,
              scheduledStartIso: txRes.record.scheduledPunchInIso || reentryBounds.scheduledStartIso,
              scheduledEndIso: txRes.record.scheduledPunchOutIso || reentryBounds.scheduledEndIso,
              standardDutyMinutes: STANDARD_DUTY_MINUTES,
            });
            return {
              httpStatus: 200,
              body: {
                success: true,
                action: 'PUNCH_IN',
                scannerType: 'IN',
                currentState: 'INSIDE',
                employee: safeEmployee,
                attendance: sanitizeAttendanceForApi(txRes.record),
                shift,
                punchOutSchedule: reentrySchedule || undefined,
                message: `Punch In Successfully Recorded (Re-entry #${txRes.record.punches.length}).`,
                time: timeDisplay,
                punchCount: txRes.record.punches.length,
              },
            };
          }

          // First Punch In of the workday
          const shiftMatch = identifyShiftForPunchIn(shifts, now);
          if (!shiftMatch) {
            await writePunchLog({
              employeeId: employee.employeeId,
              employeeName: employee.employeeName,
              timestamp: now.toISOString(),
              action: 'REJECTED_SHIFT',
              rawPayload: safeRawPayload,
              scannerDevice,
              performedByUid: caller.uid,
              performedByLoginId: caller.loginId,
              message: 'No shift window matched the punch-in time.',
            });
            return {
              httpStatus: 400,
              body: {
                success: false,
                action: 'REJECTED',
                scannerType: 'IN',
                employee: safeEmployee,
                message: 'No Valid Shift Found For This Punch-In Time.',
                time: timeDisplay,
              },
            };
          }

          const { shift, shiftDate } = shiftMatch;
          const attendanceId = `att_${employee.employeeId}_${shiftDate}_${shift.id}`;
          const scheduleBounds = resolveShiftScheduleBounds(shiftDate, shift);
          const grace = shift.gracePeriodMinutes ?? settings.lateGraceMinutes ?? 15;
          const isLate = now.getTime() > scheduleBounds.scheduledStartMs + grace * 60000;
          const earlyEval = evaluateEarlyPunchOnPunchIn({
            firstInIso: now.toISOString(),
            scheduledStartIso: scheduleBounds.scheduledStartIso,
          });

          const arrivalStatus = isLate ? 'LATE' : 'PRESENT';
          const eventId = `pe_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
          const logId = `log_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

          const firstPunchEvent = {
            id: eventId,
            employeeId: employee.employeeId,
            employeeName: employee.employeeName,
            eventType: 'IN',
            timestamp: now.toISOString(),
            displayTime: timeDisplay,
            shiftDate,
            shiftId: shift.id,
            shiftName: shift.name,
            floor: employee.floor,
            section: employee.section,
            department: employee.department,
            scannerType: 'IN',
            scannerDevice,
            status: isLate ? 'FIRST_IN_LATE' : 'FIRST_IN',
            recordedByUid: caller.uid,
            recordedByLoginId: caller.loginId,
          };

          const newAttendanceRecord = {
            id: attendanceId,
            employeeId: employee.employeeId,
            employeeNameSnapshot: employee.employeeName,
            employeeTypeSnapshot: employee.employeeType,
            floorIdSnapshot: employee.floor,
            lineIdSnapshot: employee.floor,
            sectionIdSnapshot: employee.section,
            departmentIdSnapshot: employee.department,
            shiftId: shift.id,
            shiftNameSnapshot: shift.name,
            shiftDate,
            punchIn: now.toISOString(),
            firstPunchIn: now.toISOString(),
            scheduledPunchIn: scheduleBounds.startTime,
            scheduledPunchInIso: scheduleBounds.scheduledStartIso,
            scheduledPunchOut: scheduleBounds.endTime,
            scheduledPunchOutIso: scheduleBounds.scheduledEndIso,
            actualPunchOut: null,
            lastPunchOut: null,
            effectivePunchOut: null,
            punchOutType: 'NONE',
            currentState: 'INSIDE',
            punches: [firstPunchEvent],
            totalDutyMinutes: 0,
            regularDutyMinutes: 0,
            overtimeMinutes: 0,
            earlyArrivalMinutes: earlyEval.earlyArrivalMinutes,
            provisionalEarlyOtMinutes: earlyEval.provisionalEarlyOtMinutes,
            earlyOtMinutes: 0,
            postShiftOtMinutes: 0,
            totalOtMinutes: 0,
            earlyOtFinalized: false,
            earlyPunchPolicy: earlyEval.earlyPunchPolicy,
            attendanceStatus: 'IN PROGRESS',
            isLate,
            arrivalStatus,
            missedPunchOut: false,
            autoClosed: false,
            qrTokenReference: hashQrTokenReference(employee.qrCodeToken),
            qrVerificationMode,
            createdByUid: caller.uid,
            createdByLoginId: caller.loginId,
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
          };

          const docRef = db.collection('attendance').doc(attendanceId);
          const txRes = await db.runTransaction(async (tx) => {
            const existing = await tx.get(docRef);
            if (existing.exists) {
              const data = existing.data()!;
              if (data.currentState === 'INSIDE' || (!data.actualPunchOut && data.punchOutType === 'NONE')) {
                return { kind: 'CONSECUTIVE_IN' as const, record: data };
              }
            }

            tx.set(docRef, newAttendanceRecord);
            tx.set(db.collection('punch_events').doc(eventId), firstPunchEvent);
            tx.set(db.collection('punch_logs').doc(logId), {
              id: logId,
              employeeId: employee.employeeId,
              employeeName: employee.employeeName,
              timestamp: now.toISOString(),
              action: 'PUNCH_IN',
              rawPayload: safeRawPayload,
              scannerDevice,
              qrVerificationMode,
              performedByUid: caller.uid,
              performedByLoginId: caller.loginId,
              message: `First Punch In recorded for ${shift.name} (${shiftDate}). Arrival: ${arrivalStatus}${earlyEval.earlyArrivalMinutes > 0 ? `, Early: ${earlyEval.earlyArrivalMinutes}m (Provisional Early OT: ${earlyEval.provisionalEarlyOtMinutes}m)` : ''}. Status: IN PROGRESS.`,
            });
            return { kind: 'RECORDED' as const, record: newAttendanceRecord };
          });

          if (txRes.kind === 'CONSECUTIVE_IN') {
            return {
              httpStatus: 409,
              body: {
                success: false,
                action: 'REJECTED_DUPLICATE',
                scannerType: 'IN',
                currentState: 'INSIDE',
                employee: safeEmployee,
                attendance: sanitizeAttendanceForApi(txRes.record),
                message: 'Consecutive Punch In rejected. Employee is already Punched In (Status: INSIDE).',
                time: timeDisplay,
              },
            };
          }

          const firstInSchedule = computeExpectedPunchOutTimes({
            firstInIso: newAttendanceRecord.firstPunchIn,
            scheduledStartIso: scheduleBounds.scheduledStartIso,
            scheduledEndIso: scheduleBounds.scheduledEndIso,
            standardDutyMinutes: STANDARD_DUTY_MINUTES,
          });

          return {
            httpStatus: 200,
            body: {
              success: true,
              action: 'PUNCH_IN',
              scannerType: 'IN',
              currentState: 'INSIDE',
              employee: safeEmployee,
              attendance: sanitizeAttendanceForApi(newAttendanceRecord),
              shift,
              punchOutSchedule: firstInSchedule || undefined,
              message: isLate
                ? `First Punch In Recorded for ${shift.name} (Marked LATE).`
                : earlyEval.provisionalEarlyOtMinutes > 0
                ? `First Punch In Recorded for ${shift.name} (Early ${formatMinutes(earlyEval.earlyArrivalMinutes)} • Provisional Early OT).`
                : earlyEval.earlyArrivalMinutes > 0
                ? `First Punch In Recorded for ${shift.name} (Early ${formatMinutes(earlyEval.earlyArrivalMinutes)} • <60m: 0 Early OT).`
                : `First Punch In Recorded for ${shift.name}.`,
              time: timeDisplay,
              punchCount: 1,
            },
          };
        }

        // ------------------------------------------------------------------
        // SCANNER TYPE: 'OUT'
        // ------------------------------------------------------------------
        if (!activeRecord) {
          await writePunchLog({
            employeeId: employee.employeeId,
            employeeName: employee.employeeName,
            timestamp: now.toISOString(),
            action: 'REJECTED_TOKEN',
            rawPayload: safeRawPayload,
            scannerDevice,
            performedByUid: caller.uid,
            performedByLoginId: caller.loginId,
            message: 'Punch Out rejected: No valid Punch In found for employee today.',
          });
          return {
            httpStatus: 400,
            body: {
              success: false,
              action: 'REJECTED',
              scannerType: 'OUT',
              employee: safeEmployee,
              message: 'Punch Out rejected: No valid Punch In found for employee. Please Punch In first.',
              time: timeDisplay,
            },
          };
        }

        const docRef = db.collection('attendance').doc(activeRecord.id);
        const eventId = `pe_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
        const logId = `log_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

        const txOutRes = await db.runTransaction(async (tx) => {
          const snap = await tx.get(docRef);
          const currentData = snap.exists ? snap.data()! : activeRecord!;

          if (String(currentData.employeeId || '').toUpperCase() !== String(employee.employeeId || '').toUpperCase()) {
            return { kind: 'EMPLOYEE_MISMATCH' as const, record: currentData };
          }

          const currentState =
            currentData.currentState ||
            (currentData.actualPunchOut || currentData.punchOutType === 'ACTUAL' ? 'OUTSIDE' : 'INSIDE');

          // Provisional AUTO CLOSED record can be atomically reconciled exactly once by a genuine Actual Punch-Out.
          const isAutoClosedReconcilable =
            currentData.punchOutType === 'AUTO' &&
            currentData.autoClosed === true &&
            !currentData.actualPunchOut &&
            currentData.reconciledFromAutoClose !== true;

          if (currentState === 'OUTSIDE' && !isAutoClosedReconcilable) {
            return { kind: 'CONSECUTIVE_OUT' as const, record: currentData };
          }

          const firstInIso = currentData.firstPunchIn || currentData.punchIn;
          const firstInMs = new Date(firstInIso).getTime();
          if (!Number.isFinite(firstInMs) || now.getTime() < firstInMs) {
            return { kind: 'INVALID_TIME' as const, record: currentData };
          }

          // Compare bounce against actual employee punch events (never against auto-close updatedAt)
          const lastEmployeePunchTime =
            Array.isArray(currentData.punches) && currentData.punches.length > 0
              ? new Date(currentData.punches[currentData.punches.length - 1].timestamp).getTime()
              : firstInMs;

          if (!isAutoClosedReconcilable && Math.abs(now.getTime() - lastEmployeePunchTime) < 3000) {
            return { kind: 'BOUNCE' as const, record: currentData };
          }

          const recordShift = shiftsMap.get(currentData.shiftId) || shifts[0];
          const bounds = resolveShiftScheduleBounds(currentData.shiftDate || todayKey, {
            ...recordShift,
            shiftId: currentData.shiftId,
            shiftNameSnapshot: currentData.shiftNameSnapshot,
            scheduledPunchIn: currentData.scheduledPunchIn || recordShift?.startTime,
            scheduledPunchOut: currentData.scheduledPunchOut || recordShift?.endTime,
          });
          const scheduledStartIso = currentData.scheduledPunchInIso || bounds.scheduledStartIso;
          const scheduledEndIso = currentData.scheduledPunchOutIso || bounds.scheduledEndIso;

          const otEval = evaluateOptionAPunchOut({
            firstInIso,
            lastOutIso: now.toISOString(),
            scheduledStartIso,
            scheduledEndIso,
            standardDutyMinutes: STANDARD_DUTY_MINUTES,
          });

          const totalDutyMinutes = otEval.totalDutyMinutes;
          const regularDutyMinutes = otEval.regularDutyMinutes;
          const overtimeMinutes = otEval.overtimeMinutes;
          const computedStatus = otEval.attendanceStatus;

          const outEvent = {
            id: eventId,
            employeeId: employee.employeeId,
            employeeName: employee.employeeName,
            eventType: 'OUT',
            timestamp: now.toISOString(),
            displayTime: timeDisplay,
            shiftDate: currentData.shiftDate,
            shiftId: currentData.shiftId,
            shiftName: currentData.shiftNameSnapshot,
            floor: employee.floor,
            section: employee.section,
            department: employee.department,
            scannerType: 'OUT',
            scannerDevice,
            dutyDurationMinutes: totalDutyMinutes,
            overtimeMinutes,
            earlyOtMinutes: otEval.earlyOtMinutes,
            postShiftOtMinutes: otEval.postShiftOtMinutes,
            reconciledFromAutoClose: isAutoClosedReconcilable,
            previousPunchOutType: isAutoClosedReconcilable ? 'AUTO' : 'NONE',
            previousAutoCloseEventId: isAutoClosedReconcilable ? (currentData.autoCloseEventId || null) : null,
            status: isAutoClosedReconcilable ? 'RECONCILED_ACTUAL_OUT' : 'VALID_OUT',
            recordedByUid: caller.uid,
            recordedByLoginId: caller.loginId,
          };

          const existingPunches = Array.isArray(currentData.punches) ? currentData.punches : [];
          const updatedAttendance: Record<string, any> = {
            ...currentData,
            firstPunchIn: firstInIso,
            punchIn: currentData.punchIn || firstInIso,
            scheduledPunchIn: currentData.scheduledPunchIn || bounds.startTime,
            scheduledPunchInIso: scheduledStartIso,
            scheduledPunchOut: currentData.scheduledPunchOut || bounds.endTime,
            scheduledPunchOutIso: scheduledEndIso,
            actualPunchOut: now.toISOString(),
            lastPunchOut: now.toISOString(),
            effectivePunchOut: now.toISOString(),
            punchOutType: 'ACTUAL',
            currentState: 'OUTSIDE',
            punches: [...existingPunches, outEvent],
            actualPresenceMinutes: otEval.actualPresenceMinutes,
            totalDutyMinutes,
            regularDutyMinutes,
            overtimeMinutes,
            earlyArrivalMinutes: otEval.earlyArrivalMinutes,
            provisionalEarlyOtMinutes: otEval.provisionalEarlyOtMinutes,
            earlyOtMinutes: otEval.earlyOtMinutes,
            postShiftOtMinutes: otEval.postShiftOtMinutes,
            totalOtMinutes: otEval.totalOtMinutes,
            earlyOtFinalized: true,
            earlyPunchPolicy: EARLY_PUNCH_POLICY_ID,
            otCapApplied: otEval.otCapApplied,
            attendanceStatus: computedStatus,
            missedPunchOut: false,
            autoClosed: false,
            ...(isAutoClosedReconcilable
              ? {
                  reconciledFromAutoClose: true,
                  reconciledAt: now.toISOString(),
                  reconciledByUid: caller.uid,
                  reconciledByLoginId: caller.loginId,
                }
              : {}),
            updatedByUid: caller.uid,
            updatedByLoginId: caller.loginId,
            updatedAt: now.toISOString(),
          };

          tx.set(docRef, updatedAttendance);
          tx.set(db.collection('punch_events').doc(eventId), outEvent);
          tx.set(db.collection('punch_logs').doc(logId), {
            id: logId,
            employeeId: employee.employeeId,
            employeeName: employee.employeeName,
            timestamp: now.toISOString(),
            action: 'PUNCH_OUT',
            rawPayload,
            scannerDevice,
            qrVerificationMode,
            performedByUid: caller.uid,
            performedByLoginId: caller.loginId,
            message: isAutoClosedReconcilable
              ? `Actual Punch Out reconciled from provisional AUTO CLOSED (${computedStatus}). Duty: ${formatMinutes(regularDutyMinutes)}, Early OT: ${formatMinutes(otEval.earlyOtMinutes)}, Post OT: ${formatMinutes(otEval.postShiftOtMinutes)}, Total OT: ${formatMinutes(overtimeMinutes)}. Total: ${formatMinutes(totalDutyMinutes)}.`
              : `Punch Out recorded (${computedStatus}). Duty: ${formatMinutes(regularDutyMinutes)}, Early OT: ${formatMinutes(otEval.earlyOtMinutes)}, Post OT: ${formatMinutes(otEval.postShiftOtMinutes)}, Total OT: ${formatMinutes(overtimeMinutes)}. Total: ${formatMinutes(totalDutyMinutes)}.`,
          });

          return {
            kind: 'RECORDED' as const,
            record: updatedAttendance,
            regularDutyMinutes,
            overtimeMinutes,
            reconciledFromAutoClose: isAutoClosedReconcilable,
            previousAutoCloseEffective: currentData.autoCloseEffectivePunchOut || currentData.effectivePunchOut || null,
            scheduledStartIso,
            scheduledEndIso,
          };
        });

        if (txOutRes.kind === 'EMPLOYEE_MISMATCH' || txOutRes.kind === 'INVALID_TIME') {
          return {
            httpStatus: 400,
            body: {
              success: false,
              action: 'REJECTED',
              scannerType: 'OUT',
              employee: safeEmployee,
              message:
                txOutRes.kind === 'EMPLOYEE_MISMATCH'
                  ? 'Punch Out rejected: Attendance record does not match scanned employee.'
                  : 'Punch Out rejected: Punch-Out timestamp cannot be earlier than Punch-In.',
              time: timeDisplay,
            },
          };
        }

        if (txOutRes.kind === 'CONSECUTIVE_OUT') {
          await writePunchLog({
            employeeId: employee.employeeId,
            employeeName: employee.employeeName,
            timestamp: now.toISOString(),
            action: 'REJECTED_DUPLICATE',
            rawPayload: safeRawPayload,
            scannerDevice,
            performedByUid: caller.uid,
            performedByLoginId: caller.loginId,
            message: 'Consecutive Punch Out rejected. Employee has already Punched Out.',
          });
          return {
            httpStatus: 409,
            body: {
              success: false,
              action: 'REJECTED_DUPLICATE',
              scannerType: 'OUT',
              currentState: 'OUTSIDE',
              employee: safeEmployee,
              attendance: sanitizeAttendanceForApi(txOutRes.record),
              message: 'Consecutive Punch Out rejected. Employee has already Punched Out (Status: OUTSIDE).',
              time: timeDisplay,
              punchCount: txOutRes.record.punches?.length || 1,
            },
          };
        }

        if (txOutRes.kind === 'BOUNCE') {
          return {
            httpStatus: 429,
            body: {
              success: false,
              action: 'REJECTED_DUPLICATE',
              scannerType: 'OUT',
              currentState: 'INSIDE',
              employee: safeEmployee,
              attendance: sanitizeAttendanceForApi(txOutRes.record),
              message: 'Duplicate scan prevented. Please wait a few seconds before scanning again.',
              time: timeDisplay,
            },
          };
        }

        if (txOutRes.reconciledFromAutoClose) {
          await recordEnterpriseAuditEvent(db, {
            req,
            action: 'RECONCILE_AUTO_CLOSED_PUNCH_OUT',
            category: 'ATTENDANCE',
            actorUid: caller.uid,
            actorLoginId: caller.loginId,
            actorRole: caller.role.toUpperCase(),
            employeeId: employee.employeeId,
            targetType: 'ATTENDANCE',
            targetId: txOutRes.record.id,
            oldValue: `AUTO CLOSED (Effective Out: ${txOutRes.previousAutoCloseEffective || 'Scheduled End'}, OT: 00:00)`,
            newValue: `ACTUAL (${txOutRes.record.attendanceStatus}, Out: ${txOutRes.record.actualPunchOut}, Duty: ${formatMinutes(txOutRes.record.totalDutyMinutes)}, OT: ${formatMinutes(txOutRes.overtimeMinutes)})`,
            actionSource: scannerDevice === 'MANUAL' ? 'MANUAL_SCANNER_RECONCILIATION' : 'QR_SCANNER_RECONCILIATION',
            reason: 'Genuine actual Punch-Out received after provisional shift auto-close',
            captureGeo: false,
          });
        }

        const shift = shiftsMap.get(txOutRes.record.shiftId) || shifts[0];
        const outSchedule = computeExpectedPunchOutTimes({
          firstInIso: txOutRes.record.firstPunchIn || txOutRes.record.punchIn,
          scheduledStartIso: txOutRes.scheduledStartIso,
          scheduledEndIso: txOutRes.scheduledEndIso,
          standardDutyMinutes: STANDARD_DUTY_MINUTES,
        });
        return {
          httpStatus: 200,
          body: {
            success: true,
            action: 'PUNCH_OUT',
            scannerType: 'OUT',
            currentState: 'OUTSIDE',
            reconciledFromAutoClose: txOutRes.reconciledFromAutoClose,
            employee: safeEmployee,
            attendance: sanitizeAttendanceForApi(txOutRes.record),
            shift,
            punchOutSchedule: outSchedule || undefined,
            message: txOutRes.reconciledFromAutoClose
              ? 'Actual Punch Out Recorded (Reconciled from Auto-Close).'
              : 'Punch Out Successfully Recorded.',
            time: timeDisplay,
            dutyFormatted: formatMinutes(txOutRes.regularDutyMinutes),
            otFormatted: formatMinutes(txOutRes.overtimeMinutes),
            punchCount: txOutRes.record.punches.length,
          },
        };
  }

  // --------------------------------------------------------------------------
  // 2. POST /api/attendance/auto-close — Automatic Shift Closing Engine (ADMIN / SUPER_ADMIN)
  // --------------------------------------------------------------------------
  app.post('/api/attendance/auto-close', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        '*',
        'Auto Close Expired Shifts'
      );
      if (!caller) return;

      const canAutoClose =
        (await callerHasModuleAction(db, caller, 'history', 'edit')) ||
        (await callerHasModuleAction(db, caller, 'shifts', 'edit'));
      if (!canAutoClose) {
        await recordEnterpriseAuditEvent(db, {
          req,
          action: 'unauthorized_access_attempt',
          category: 'SECURITY',
          severity: 'CRITICAL',
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: caller.role.toUpperCase(),
          targetType: 'ATTENDANCE_AUTO_CLOSE',
          targetId: '/api/attendance/auto-close',
          actionSource: 'ATTENDANCE_PERMISSION_GUARD',
          description: `Unauthorized auto-close attempt by "${caller.loginId}" (${caller.role}).`,
          success: false,
        });
        return res.status(403).json({
          success: false,
          error: `Forbidden: Role "${caller.role.toUpperCase()}" is not permitted for Auto Close Expired Shifts.`,
        });
      }

      const now = new Date();
      const [settingsRes, shiftsRes, openSnap] = await Promise.all([
        getCachedSystemSettings(db, DEFAULT_SETTINGS),
        getCachedShifts(db, DEFAULT_SHIFTS),
        db.collection('attendance').where('punchOutType', '==', 'NONE').get(),
      ]);

      const settings = settingsRes.data || DEFAULT_SETTINGS;
      if (!settings.autoPunchOutEnabled) {
        return res.json({ success: true, closedCount: 0, closedRecords: [] });
      }

      const shifts = shiftsRes.shifts;
      const shiftsMap = new Map(shifts.map((s) => [s.id, s]));
      const closedRecords: any[] = [];
      const MAX_AUTO_CLOSE_PER_INVOCATION = 25;
      const startTimeMs = Date.now();
      const SOFT_TIME_BUDGET_MS = 6500;

      for (const docSnap of openSnap.docs) {
        if (
          closedRecords.length >= MAX_AUTO_CLOSE_PER_INVOCATION ||
          Date.now() - startTimeMs >= SOFT_TIME_BUDGET_MS
        ) {
          break;
        }
        const record = docSnap.data()!;
        if (record.actualPunchOut || record.punchOutType !== 'NONE' || record.autoClosed === true) continue;

        const shift = shiftsMap.get(record.shiftId);
        if (!shift) continue;

        const bounds = resolveShiftScheduleBounds(record.shiftDate, {
          ...shift,
          shiftId: record.shiftId,
          shiftNameSnapshot: record.shiftNameSnapshot,
          scheduledPunchIn: record.scheduledPunchIn || shift.startTime,
          scheduledPunchOut: record.scheduledPunchOut || shift.endTime,
        });
        const scheduledStartIso = record.scheduledPunchInIso || bounds.scheduledStartIso;
        const scheduledEndIso = record.scheduledPunchOutIso || bounds.scheduledEndIso;
        const scheduledEndDate = new Date(scheduledEndIso);

        if (now.getTime() >= scheduledEndDate.getTime()) {
          const maxShiftRegularDuration = Math.min(
            shift.scheduledDurationMinutes || settings.scheduledDurationMinutes || STANDARD_DUTY_MINUTES,
            MAX_REGULAR_DUTY_MINUTES
          );
          const docRef = db.collection('attendance').doc(record.id);
          const autoEventId = `pe_auto_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
          const autoDisplayTime = getKolkataTimeParts(scheduledEndDate).timeWithSeconds;
          const autoCloseRecordedAtIso = now.toISOString();

          const updatedRecord = await withEmployeeScanLock(record.employeeId, () =>
            db.runTransaction(async (tx) => {
              const freshSnap = await tx.get(docRef);
              if (!freshSnap.exists) return null;
              const fresh = freshSnap.data()!;
              // Atomic concurrency guard: if Actual Punch-Out or another Auto-Close already committed, never overwrite.
              if (
                fresh.actualPunchOut ||
                fresh.punchOutType !== 'NONE' ||
                fresh.autoClosed === true ||
                fresh.currentState === 'OUTSIDE'
              ) {
                return null;
              }

              const freshFirstInIso = fresh.firstPunchIn || fresh.punchIn;
              const freshScheduledStartIso = fresh.scheduledPunchInIso || scheduledStartIso;
              const autoDutyEval = evaluateAutoCloseDuty({
                firstInIso: freshFirstInIso,
                scheduledStartIso: freshScheduledStartIso,
                scheduledEndIso,
                standardDutyMinutes: maxShiftRegularDuration,
              });

              const autoCloseEvent = {
                id: autoEventId,
                employeeId: fresh.employeeId,
                employeeName: fresh.employeeNameSnapshot || '',
                eventType: 'OUT',
                timestamp: autoCloseRecordedAtIso,
                effectivePunchOut: scheduledEndIso,
                displayTime: autoDisplayTime,
                shiftDate: fresh.shiftDate,
                shiftId: fresh.shiftId,
                shiftName: fresh.shiftNameSnapshot || shift.name,
                floor: fresh.floorIdSnapshot || '',
                section: fresh.sectionIdSnapshot || '',
                department: fresh.departmentIdSnapshot || '',
                scannerType: 'OUT',
                scannerDevice: 'SYSTEM_AUTO',
                dutyDurationMinutes: autoDutyEval.regularDutyMinutes,
                overtimeMinutes: 0,
                earlyOtMinutes: 0,
                postShiftOtMinutes: 0,
                status: 'AUTO_CLOSE',
                recordedByUid: caller.uid,
                recordedByLoginId: caller.loginId,
              };

              const next = {
                ...fresh,
                firstPunchIn: freshFirstInIso,
                punchIn: fresh.punchIn || freshFirstInIso,
                scheduledPunchIn: fresh.scheduledPunchIn || bounds.startTime,
                scheduledPunchInIso: freshScheduledStartIso,
                scheduledPunchOut: fresh.scheduledPunchOut || bounds.endTime,
                scheduledPunchOutIso: scheduledEndIso,
                actualPunchOut: null,
                lastPunchOut: null,
                effectivePunchOut: scheduledEndIso,
                punchOutType: 'AUTO',
                currentState: 'OUTSIDE',
                attendanceStatus: 'AUTO CLOSED',
                missedPunchOut: true,
                autoClosed: true,
                autoClosedAt: autoCloseRecordedAtIso,
                autoCloseEventId: autoEventId,
                autoCloseEffectivePunchOut: scheduledEndIso,
                actualPresenceMinutes: autoDutyEval.actualPresenceMinutes,
                totalDutyMinutes: autoDutyEval.totalDutyMinutes,
                regularDutyMinutes: autoDutyEval.regularDutyMinutes,
                overtimeMinutes: 0, // Strictly zero OT on auto-closed shifts
                earlyOtMinutes: 0,
                postShiftOtMinutes: 0,
                totalOtMinutes: 0,
                earlyOtFinalized: false,
                otCapApplied: false,
                updatedAt: autoCloseRecordedAtIso,
              };
              tx.set(docRef, next);
              tx.set(db.collection('punch_events').doc(autoEventId), autoCloseEvent);
              return next;
            })
          );

          if (updatedRecord) {
            closedRecords.push(updatedRecord);
            await Promise.all([
              writePunchLog({
                employeeId: record.employeeId,
                employeeName: record.employeeNameSnapshot,
                timestamp: now.toISOString(),
                action: 'AUTO_CLOSE',
                rawPayload: 'SYSTEM_CRON',
                scannerDevice: 'SYSTEM_AUTO',
                performedByUid: caller.uid,
                performedByLoginId: caller.loginId,
                message: `Provisional auto-close at scheduled shift end (${shift.endTime}). Duty: ${formatMinutes(updatedRecord.regularDutyMinutes)}, Status: AUTO CLOSED. OT: 00:00.`,
              }),
              recordEnterpriseAuditEvent(db, {
                req,
                action: 'AUTOMATIC_PUNCH_OUT',
                category: 'ATTENDANCE',
                actorUid: caller.uid,
                actorLoginId: caller.loginId,
                actorRole: caller.role.toUpperCase(),
                employeeId: record.employeeId,
                targetType: 'ATTENDANCE',
                targetId: record.id,
                newValue: `Auto-closed at ${scheduledEndIso}, Duty: ${formatMinutes(updatedRecord.regularDutyMinutes)}, OT: 00:00`,
                actionSource: 'SYSTEM_SCHEDULER',
                reason: 'Provisional auto-close at scheduled shift end (reconcilable by genuine Punch-Out)',
                captureGeo: false,
              }),
            ]);
          }
        }
      }

      return res.json({
        success: true,
        closedCount: closedRecords.length,
        closedRecords: closedRecords.map((rec) => sanitizeAttendanceForApi(rec)),
      });
    } catch (err: any) {
      console.error('[API Auto Close] Error:', err);
      return res.status(500).json({ success: false, error: 'Failed to execute shift auto-closing engine.' });
    }
  });

  // --------------------------------------------------------------------------
  // 3. POST /api/attendance/correct — Manual Attendance Correction (ADMIN / SUPER_ADMIN)
  // --------------------------------------------------------------------------
  app.post('/api/attendance/correct', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        '*',
        'Manual Attendance Correction'
      );
      if (!caller) return;

      const canCorrect = await callerHasModuleAction(db, caller, 'history', 'edit');
      if (!canCorrect) {
        await recordEnterpriseAuditEvent(db, {
          req,
          action: 'unauthorized_access_attempt',
          category: 'SECURITY',
          severity: 'CRITICAL',
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: caller.role.toUpperCase(),
          targetType: 'ATTENDANCE_CORRECTION',
          targetId: '/api/attendance/correct',
          actionSource: 'ATTENDANCE_PERMISSION_GUARD',
          description: `Unauthorized attendance correction attempt by "${caller.loginId}" (${caller.role}).`,
          success: false,
        });
        return res.status(403).json({
          success: false,
          error: `Forbidden: Role "${caller.role.toUpperCase()}" is not permitted for Manual Attendance Correction.`,
        });
      }

      const parsed = AttendanceCorrectSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: parsed.error.issues[0]?.message || 'Invalid correction payload.',
        });
      }

      const { attendanceId, actualPunchOut, punchOutType, attendanceStatus, reason } = parsed.data;
      const docRef = db.collection('attendance').doc(attendanceId);

      const txResult = await db.runTransaction(async (tx) => {
        const snap = await tx.get(docRef);
        if (!snap.exists) {
          return { notFound: true as const };
        }
        const current = snap.data()!;
        let regularDutyMinutes = Number(current.regularDutyMinutes || 0);
        let overtimeMinutes = Number(current.overtimeMinutes || 0);
        let totalDutyMinutes = Number(current.totalDutyMinutes || 0);
        let earlyArrivalMinutes = Number(current.earlyArrivalMinutes || 0);
        let provisionalEarlyOtMinutes = Number(current.provisionalEarlyOtMinutes || 0);
        let earlyOtMinutes = Number(current.earlyOtMinutes || 0);
        let postShiftOtMinutes = Number(current.postShiftOtMinutes || 0);
        let earlyOtFinalized = Boolean(current.earlyOtFinalized);
        let actualPresenceMinutes = Number(current.actualPresenceMinutes || totalDutyMinutes || 0);

        const bounds = resolveShiftScheduleBounds(current.shiftDate || '', current);
        const scheduledStartIso = current.scheduledPunchInIso || bounds.scheduledStartIso;

        if (actualPunchOut) {
          const firstInIso = current.firstPunchIn || current.punchIn;
          const inTime = new Date(firstInIso).getTime();
          const outTime = new Date(actualPunchOut).getTime();
          if (Number.isNaN(outTime)) {
            throw new Error('INVALID_PUNCH_OUT');
          }
          let otCapApplied = Boolean(current.otCapApplied);
          if (punchOutType === 'AUTO') {
            const autoEval = evaluateAutoCloseDuty({
              firstInIso,
              scheduledStartIso,
              scheduledEndIso: actualPunchOut || current.scheduledPunchOutIso || bounds.scheduledEndIso,
              standardDutyMinutes: STANDARD_DUTY_MINUTES,
            });
            actualPresenceMinutes = autoEval.actualPresenceMinutes;
            regularDutyMinutes = autoEval.regularDutyMinutes;
            totalDutyMinutes = autoEval.totalDutyMinutes;
            overtimeMinutes = 0;
            earlyOtMinutes = 0;
            postShiftOtMinutes = 0;
            earlyOtFinalized = false;
            otCapApplied = false;
          } else {
            const otEval = evaluateOptionAPunchOut({
              firstInIso,
              lastOutIso: actualPunchOut,
              scheduledStartIso,
              scheduledEndIso: current.scheduledPunchOutIso || bounds.scheduledEndIso,
              standardDutyMinutes: STANDARD_DUTY_MINUTES,
            });
            actualPresenceMinutes = otEval.actualPresenceMinutes;
            totalDutyMinutes = otEval.totalDutyMinutes;
            regularDutyMinutes = otEval.regularDutyMinutes;
            overtimeMinutes = otEval.overtimeMinutes;
            earlyArrivalMinutes = otEval.earlyArrivalMinutes;
            provisionalEarlyOtMinutes = otEval.provisionalEarlyOtMinutes;
            earlyOtMinutes = otEval.earlyOtMinutes;
            postShiftOtMinutes = otEval.postShiftOtMinutes;
            earlyOtFinalized = true;
            otCapApplied = otEval.otCapApplied;
          }

          const autoClassifySet = new Set([
            'COMPLETED',
            'COMPLETED + OT',
            'HALF DAY',
            'SHORT LEAVE',
            'PRESENT',
          ]);
          const finalAttendanceStatus =
            punchOutType === 'ACTUAL' && actualPunchOut && autoClassifySet.has(attendanceStatus)
              ? classifyCompletedDutyStatus(totalDutyMinutes, STANDARD_DUTY_MINUTES, overtimeMinutes)
              : attendanceStatus;

          const updatedFields = {
            actualPunchOut: punchOutType === 'AUTO' ? null : actualPunchOut,
            lastPunchOut: punchOutType === 'AUTO' ? null : actualPunchOut,
            effectivePunchOut: actualPunchOut || current.effectivePunchOut || null,
            punchOutType,
            currentState: actualPunchOut ? 'OUTSIDE' : current.currentState || 'OUTSIDE',
            attendanceStatus: finalAttendanceStatus,
            autoClosed: punchOutType === 'AUTO',
            missedPunchOut: punchOutType === 'AUTO' || finalAttendanceStatus === 'MISSED PUNCH OUT',
            scheduledPunchIn: current.scheduledPunchIn || bounds.startTime,
            scheduledPunchInIso: scheduledStartIso,
            scheduledPunchOut: current.scheduledPunchOut || bounds.endTime,
            scheduledPunchOutIso: current.scheduledPunchOutIso || bounds.scheduledEndIso,
            actualPresenceMinutes,
            totalDutyMinutes,
            regularDutyMinutes,
            overtimeMinutes,
            earlyArrivalMinutes,
            provisionalEarlyOtMinutes,
            earlyOtMinutes,
            postShiftOtMinutes,
            totalOtMinutes: overtimeMinutes,
            earlyOtFinalized,
            otCapApplied,
            earlyPunchPolicy: EARLY_PUNCH_POLICY_ID,
            correctionReason: reason.trim(),
            correctedBy: caller.loginId,
            correctedByUid: caller.uid,
            updatedAt: new Date().toISOString(),
          };

          tx.update(docRef, updatedFields);
          return {
            notFound: false as const,
            current,
            updated: { ...current, ...updatedFields },
          };
        } else if (punchOutType === 'AUTO') {
          regularDutyMinutes = Math.min(regularDutyMinutes || STANDARD_DUTY_MINUTES, MAX_REGULAR_DUTY_MINUTES);
          totalDutyMinutes = regularDutyMinutes;
          overtimeMinutes = 0;
          earlyOtMinutes = 0;
          postShiftOtMinutes = 0;
          earlyOtFinalized = false;
        }

        const autoClassifySet = new Set([
          'COMPLETED',
          'COMPLETED + OT',
          'HALF DAY',
          'SHORT LEAVE',
          'PRESENT',
        ]);
        const finalAttendanceStatus =
          punchOutType === 'ACTUAL' && actualPunchOut && autoClassifySet.has(attendanceStatus)
            ? classifyCompletedDutyStatus(totalDutyMinutes, STANDARD_DUTY_MINUTES)
            : attendanceStatus;

        const updatedFields = {
          actualPunchOut: punchOutType === 'AUTO' ? null : (actualPunchOut || current.actualPunchOut || null),
          lastPunchOut: punchOutType === 'AUTO' ? null : (actualPunchOut || current.lastPunchOut || null),
          effectivePunchOut: actualPunchOut || current.effectivePunchOut || null,
          punchOutType,
          currentState: actualPunchOut ? 'OUTSIDE' : current.currentState || 'OUTSIDE',
          attendanceStatus: finalAttendanceStatus,
          autoClosed: punchOutType === 'AUTO',
          missedPunchOut: punchOutType === 'AUTO' || finalAttendanceStatus === 'MISSED PUNCH OUT',
          scheduledPunchIn: current.scheduledPunchIn || bounds.startTime,
          scheduledPunchInIso: scheduledStartIso,
          scheduledPunchOut: current.scheduledPunchOut || bounds.endTime,
          scheduledPunchOutIso: current.scheduledPunchOutIso || bounds.scheduledEndIso,
          actualPresenceMinutes,
          totalDutyMinutes,
          regularDutyMinutes,
          overtimeMinutes,
          earlyArrivalMinutes,
          provisionalEarlyOtMinutes,
          earlyOtMinutes,
          postShiftOtMinutes,
          totalOtMinutes: overtimeMinutes,
          earlyOtFinalized,
          otCapApplied: Boolean(current.otCapApplied),
          earlyPunchPolicy: EARLY_PUNCH_POLICY_ID,
          correctionReason: reason.trim(),
          correctedBy: caller.loginId,
          correctedByUid: caller.uid,
          updatedAt: new Date().toISOString(),
        };

        tx.update(docRef, updatedFields);
        return {
          notFound: false as const,
          current,
          updated: { ...current, ...updatedFields },
        };
      });

      if (txResult.notFound) {
        return res.status(404).json({ success: false, error: 'Attendance record not found.' });
      }

      await recordEnterpriseAuditEvent(db, {
        req,
        action: 'CORRECT_ATTENDANCE',
        category: 'ATTENDANCE',
        severity: 'WARNING',
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        employeeId: txResult.current.employeeId,
        targetType: 'ATTENDANCE',
        targetId: attendanceId,
        oldValue: `Status: ${txResult.current.attendanceStatus}, Out: ${txResult.current.actualPunchOut || 'None'}`,
        newValue: `Status: ${txResult.updated.attendanceStatus}, Out: ${actualPunchOut || 'None'}`,
        actionSource: 'ADMIN_CORRECTION',
        reason: reason.trim(),
        description: `Attendance record ${attendanceId} corrected by "${caller.loginId}".`,
      });

      recordDbOpMetric(db, {
        operation: 'TRANSACTION',
        collection: 'attendance',
        durationMs: 0,
        success: true,
        correlationId: (req as any).correlationId,
      });
      recordActivityTelemetry(db, {
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        action: 'ATTENDANCE_CORRECTION',
        module: 'Attendance History',
        result: 'Success',
        correlationId: (req as any).correlationId,
        detail: `Corrected attendance ${attendanceId} -> ${txResult.updated.attendanceStatus}`,
      });

      return res.json({ success: true, record: txResult.updated });
    } catch (err: any) {
      if (err?.message === 'INVALID_PUNCH_OUT') {
        return res.status(400).json({ success: false, error: 'Invalid actualPunchOut timestamp.' });
      }
      console.error('[API Attendance Correct] Error:', err);
      recordErrorTelemetry(db, {
        source: 'BACKEND',
        module: 'Attendance History',
        category: 'CORRECTION_ERROR',
        severity: 'CRITICAL',
        message: err?.message || 'Failed to correct attendance record.',
        statusCode: 500,
        correlationId: (req as any).correlationId,
      });
      return res.status(500).json({ success: false, error: 'Failed to correct attendance record.' });
    }
  });

  // --------------------------------------------------------------------------
  // 4. POST /api/attendance/roster — Generate Shift Roster (ADMIN / SUPER_ADMIN)
  // --------------------------------------------------------------------------
  app.post('/api/attendance/roster', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        '*',
        'Generate Shift Roster'
      );
      if (!caller) return;

      const canGenerateRoster =
        (await callerHasModuleAction(db, caller, 'shifts', 'add')) ||
        (await callerHasModuleAction(db, caller, 'shifts', 'edit')) ||
        (caller.role === 'admin' && (await callerHasModuleAction(db, caller, 'shifts', 'view')));
      if (!canGenerateRoster) {
        await recordEnterpriseAuditEvent(db, {
          req,
          action: 'unauthorized_access_attempt',
          category: 'SECURITY',
          severity: 'CRITICAL',
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: caller.role.toUpperCase(),
          targetType: 'SHIFT_ROSTER',
          targetId: '/api/attendance/roster',
          actionSource: 'ATTENDANCE_PERMISSION_GUARD',
          description: `Unauthorized shift roster generation attempt by "${caller.loginId}" (${caller.role}).`,
          success: false,
        });
        return res.status(403).json({
          success: false,
          error: `Forbidden: Role "${caller.role.toUpperCase()}" is not permitted for Generate Shift Roster.`,
        });
      }

      const parsed = GenerateRosterSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: parsed.error.issues[0]?.message || 'Invalid roster parameters.',
        });
      }

      const { shiftDate, shiftId } = parsed.data;
      const empSnap = await db.collection('employees').where('employeeStatus', '==', 'Active').get();
      const now = new Date().toISOString();
      const entries = empSnap.docs.map((empDoc) => {
        const emp = empDoc.data()!;
        const empId = String(emp.employeeId || empDoc.id);
        const rosterId = `roster_${shiftDate}_${shiftId}_${empId}`;
        return {
          ref: db.collection('shift_rosters').doc(rosterId),
          payload: {
            id: rosterId,
            shiftDate,
            shiftId,
            employeeId: empId,
            rosterStatus: 'SCHEDULED',
            updatedByUid: caller.uid,
            updatedByLoginId: caller.loginId,
            updatedAt: now,
          },
        };
      });

      const count = entries.length;
      if (typeof db.batch === 'function') {
        for (let i = 0; i < entries.length; i += 400) {
          const batch = db.batch();
          for (const item of entries.slice(i, i + 400)) {
            batch.set(item.ref, item.payload);
          }
          await batch.commit();
        }
      } else {
        await Promise.all(entries.map((item) => item.ref.set(item.payload)));
      }

      await recordEnterpriseAuditEvent(db, {
        req,
        action: 'GENERATE_ROSTER',
        category: 'ATTENDANCE',
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        targetType: 'ROSTER',
        targetId: `${shiftDate}_${shiftId}`,
        newValue: `Generated roster of ${count} employees for ${shiftDate} (${shiftId})`,
        actionSource: 'ROSTER_MANAGEMENT',
      });

      return res.json({ success: true, scheduledCount: count });
    } catch (err: any) {
      console.error('[API Generate Roster] Error:', err);
      return res.status(500).json({ success: false, error: 'Failed to generate shift roster.' });
    }
  });

  // --------------------------------------------------------------------------
  // 5. POST /api/attendance/clear — Super Admin Only Controlled Reset
  // --------------------------------------------------------------------------
  app.post('/api/attendance/clear', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        ['super_admin'],
        'Clear All Attendance Records'
      );
      if (!caller) return;

      const isProductionEnv =
        process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
      if (isProductionEnv && process.env.ALLOW_ATTENDANCE_CLEAR !== 'true') {
        return res.status(403).json({
          success: false,
          code: 'PRODUCTION_WIPE_BLOCKED',
          error:
            'Bulk clearing attendance records is disabled in production. Set ALLOW_ATTENDANCE_CLEAR=true only for authorized maintenance.',
        });
      }

      const parsed = ClearAttendanceSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: parsed.error.issues[0]?.message || 'Explicit confirmation is required.',
        });
      }

      const [attSnap, logSnap, rosterSnap] = await Promise.all([
        db.collection('attendance').get(),
        db.collection('punch_logs').get(),
        db.collection('shift_rosters').get(),
      ]);

      const refsToDelete = [
        ...attSnap.docs.map((d) => db.collection('attendance').doc(d.id)),
        ...logSnap.docs.map((d) => db.collection('punch_logs').doc(d.id)),
        ...rosterSnap.docs.map((d) => db.collection('shift_rosters').doc(d.id)),
      ];

      if (typeof db.batch === 'function') {
        for (let i = 0; i < refsToDelete.length; i += 400) {
          const batch = db.batch();
          for (const ref of refsToDelete.slice(i, i + 400)) {
            batch.delete(ref);
          }
          await batch.commit();
        }
      } else {
        await Promise.all(refsToDelete.map((ref) => ref.delete()));
      }

      await recordEnterpriseAuditEvent(db, {
        req,
        action: 'CLEAR_ATTENDANCE_RECORDS',
        category: 'ATTENDANCE',
        severity: 'CRITICAL',
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: 'SUPER_ADMIN',
        newValue: `Cleared ${attSnap.size} attendance records & ${logSnap.size} punch logs`,
        actionSource: 'SYSTEM_SETTINGS',
        reason: parsed.data.reason || 'Super Admin executed controlled attendance state reset',
      });

      return res.json({
        success: true,
        deletedAttendance: attSnap.size,
        deletedLogs: logSnap.size,
      });
    } catch (err: any) {
      console.error('[API Clear Attendance] Error:', err);
      return res.status(500).json({ success: false, error: 'Failed to clear attendance records.' });
    }
  });

  // --------------------------------------------------------------------------
  // 6. GET /api/attendance/records — Authenticated & Wi-Fi Enforced Attendance Read (F-01 / F-02)
  // --------------------------------------------------------------------------
  async function callerCanReadAttendanceData(
    caller: VerifiedCaller,
    allowedModules: ReadonlyArray<string>
  ): Promise<boolean> {
    if (caller.role === 'super_admin') return true;
    try {
      const [userPermSnap, rolePermSnap] = await Promise.all([
        caller.prefetchedUserPermSnap
          ? Promise.resolve(caller.prefetchedUserPermSnap)
          : db.collection('user_permissions').doc(caller.profileDocId).get(),
        getCachedRolePermissionsDoc(db, caller.role),
      ]);
      const userPermData = userPermSnap.exists ? userPermSnap.data() : undefined;
      const rolePermData = rolePermSnap.exists ? rolePermSnap.data : undefined;

      for (const mod of allowedModules) {
        if (userPermData && userPermData.isCustomOverride !== false) {
          const overrideMod = userPermData.permissions?.[mod];
          if (overrideMod && typeof overrideMod.view === 'boolean') {
            if (overrideMod.view) return true;
            continue;
          }
        }
        const roleMod = rolePermData?.modulePermissions?.[mod];
        if (roleMod && typeof roleMod.view === 'boolean') {
          if (roleMod.view) return true;
          continue;
        }
        if (caller.role === 'admin') {
          return true;
        }
        if (Array.isArray(caller.modulesAllowed) && caller.modulesAllowed.includes(mod)) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

  app.get('/api/attendance/records', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        '*',
        'View Attendance Records',
        { prefetchUserPermission: true }
      );
      if (!caller) return;

      const allowed = await callerCanReadAttendanceData(caller, [
        'dashboard',
        'reports',
        'history',
        'attendance',
      ]);
      if (!allowed) {
        return res.status(403).json({
          success: false,
          error: 'Forbidden: Your role does not have permission to view attendance records.',
        });
      }

      const shiftDate = typeof req.query.shiftDate === 'string' ? req.query.shiftDate.trim() : '';
      const fromDate = typeof req.query.fromDate === 'string' ? req.query.fromDate.trim() : '';
      const toDate = typeof req.query.toDate === 'string' ? req.query.toDate.trim() : '';
      const shiftId = typeof req.query.shiftId === 'string' ? req.query.shiftId.trim() : '';

      let docs: Record<string, any>[] = [];
      if (shiftDate) {
        if (!DATE_KEY_RE.test(shiftDate)) {
          return res.status(400).json({ success: false, error: 'Invalid shiftDate format (YYYY-MM-DD).' });
        }
        const snap = await db.collection('attendance').where('shiftDate', '==', shiftDate).get();
        docs = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
      } else if (fromDate && toDate) {
        if (!DATE_KEY_RE.test(fromDate) || !DATE_KEY_RE.test(toDate) || fromDate > toDate) {
          return res.status(400).json({ success: false, error: 'Invalid date range.' });
        }
        const diffDays =
          Math.ceil((new Date(`${toDate}T00:00:00Z`).getTime() - new Date(`${fromDate}T00:00:00Z`).getTime()) / 86400000) + 1;
        if (diffDays > 93) {
          return res.status(400).json({ success: false, error: 'Date range cannot exceed 93 days.' });
        }
        const snap = await db
          .collection('attendance')
          .where('shiftDate', '>=', fromDate)
          .where('shiftDate', '<=', toDate)
          .get();
        docs = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
      } else {
        const todayKey = getKolkataTimeParts(new Date()).dateKey;
        const snap = await db.collection('attendance').where('shiftDate', '==', todayKey).get();
        docs = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
      }

      if (shiftId && shiftId !== 'ALL') {
        docs = docs.filter((r) => String(r.shiftId || '') === shiftId);
      }

      return res.json({
        success: true,
        records: docs.map((r) => sanitizeAttendanceForApi(r)),
      });
    } catch (err: any) {
      console.error('[API Attendance Records] Error:', err);
      return res.status(500).json({ success: false, error: 'Failed to load attendance records.' });
    }
  });

  app.get('/api/attendance/punch-events', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        '*',
        'View Punch Events',
        { prefetchUserPermission: true }
      );
      if (!caller) return;

      const allowed = await callerCanReadAttendanceData(caller, [
        'dashboard',
        'history',
        'attendance',
        'reports',
      ]);
      if (!allowed) {
        return res.status(403).json({
          success: false,
          error: 'Forbidden: Your role does not have permission to view punch events.',
        });
      }

      const shiftDate = typeof req.query.shiftDate === 'string' ? req.query.shiftDate.trim() : '';
      const employeeId = typeof req.query.employeeId === 'string' ? req.query.employeeId.trim().toUpperCase() : '';
      const rawLimit = Number(req.query.limit || 200);
      const maxLimit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(500, Math.floor(rawLimit))) : 200;

      let snap: AdminQuerySnapLike;
      if (shiftDate) {
        if (!DATE_KEY_RE.test(shiftDate)) {
          return res.status(400).json({ success: false, error: 'Invalid shiftDate format.' });
        }
        snap = await db.collection('punch_events').where('shiftDate', '==', shiftDate).get();
      } else {
        snap = await db.collection('punch_events').get();
      }

      let events = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() || {}) }))
        .sort((a: any, b: any) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));

      if (employeeId) {
        events = events.filter((e: any) => String(e.employeeId || '').toUpperCase() === employeeId);
      }

      return res.json({
        success: true,
        events: events.slice(0, maxLimit),
      });
    } catch (err: any) {
      console.error('[API Punch Events] Error:', err);
      return res.status(500).json({ success: false, error: 'Failed to load punch events.' });
    }
  });

  app.get('/api/attendance/rosters', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        '*',
        'View Shift Rosters',
        { prefetchUserPermission: true }
      );
      if (!caller) return;

      const allowed = await callerCanReadAttendanceData(caller, [
        'dashboard',
        'shifts',
        'attendance',
        'reports',
      ]);
      if (!allowed) {
        return res.status(403).json({
          success: false,
          error: 'Forbidden: Your role does not have permission to view shift rosters.',
        });
      }

      const shiftDate = typeof req.query.shiftDate === 'string' ? req.query.shiftDate.trim() : '';
      const shiftId = typeof req.query.shiftId === 'string' ? req.query.shiftId.trim() : '';

      if (shiftDate && !DATE_KEY_RE.test(shiftDate)) {
        return res.status(400).json({ success: false, error: 'Invalid shiftDate format.' });
      }

      const targetDate = shiftDate || getKolkataTimeParts(new Date()).dateKey;
      const snap = await db.collection('shift_rosters').where('shiftDate', '==', targetDate).get();
      let rosters = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
      if (shiftId && shiftId !== 'ALL') {
        rosters = rosters.filter((r: any) => String(r.shiftId || '') === shiftId);
      }

      return res.json({
        success: true,
        rosters,
      });
    } catch (err: any) {
      console.error('[API Shift Rosters] Error:', err);
      return res.status(500).json({ success: false, error: 'Failed to load shift rosters.' });
    }
  });
}
