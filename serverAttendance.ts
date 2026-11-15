import express, { type Request, type Response } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import {
  type AdminFirestoreLike,
  type VerifiedCaller,
  recordEnterpriseAuditEvent,
} from './serverSecurityAudit.ts';

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
    punchInWindowStart: '09:00',
    punchInWindowEnd: '20:00',
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
    punchInWindowStart: '20:00',
    punchInWindowEnd: '09:00',
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

async function withEmployeeScanLock<T>(employeeId: string, task: () => Promise<T>): Promise<T> {
  const key = employeeId.trim().toUpperCase() || '__UNKNOWN__';
  const prev = employeeScanLocks.get(key) || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = prev.then(() => gate);
  employeeScanLocks.set(key, chained);
  try {
    await prev;
    return await task();
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
  const formatter = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
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
  return d.toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

export function parseQrPayload(raw: string): { employeeId: string; token?: string } {
  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed.employeeId || parsed.id) {
      return {
        employeeId: String(parsed.employeeId || parsed.id).trim().toUpperCase(),
        token: parsed.token || parsed.qrToken,
      };
    }
  } catch {
    if (trimmed.startsWith('QR_')) {
      const parts = trimmed.split('_');
      if (parts.length >= 2) {
        return { employeeId: parts[1].trim().toUpperCase(), token: trimmed };
      }
    }
  }
  return { employeeId: trimmed.toUpperCase() };
}

export function identifyShiftForPunchIn(
  shifts: any[],
  now: Date = new Date()
): { shift: any; shiftDate: string } | null {
  const kolkata = getKolkataTimeParts(now);
  const currentMins = kolkata.totalMinutes;
  const activeShifts = shifts.filter((s) => s.status === 'Active');

  for (const shift of activeShifts) {
    const winStart = timeStringToMinutes(shift.punchInWindowStart);
    const winEnd = timeStringToMinutes(shift.punchInWindowEnd);

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

  if (currentMins >= 540 && currentMins < 1200) {
    return dayShift ? { shift: dayShift, shiftDate: kolkata.dateKey } : null;
  } else if (currentMins >= 1200) {
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
});

const AttendanceCorrectSchema = z.object({
  attendanceId: z.string().trim().min(1, 'Attendance ID is required.').max(128),
  actualPunchOut: z.string().optional(),
  punchOutType: z.enum(['ACTUAL', 'AUTO']),
  attendanceStatus: z.enum([
    'PRESENT',
    'LATE',
    'COMPLETED',
    'AUTO CLOSED',
    'MISSED PUNCH OUT',
    'HALF DAY',
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
// Module Permission Evaluator for Scanner Enforcement (Strictly Fail-Closed)
// ============================================================================
async function callerHasScannerAccess(db: AdminFirestoreLike, caller: VerifiedCaller): Promise<boolean> {
  if (caller.role === 'super_admin') return true;

  try {
    const userPermSnap = await db.collection('user_permissions').doc(caller.profileDocId).get();
    if (userPermSnap.exists) {
      const mod = userPermSnap.data()?.permissions?.scanner;
      if (mod && (mod.view === false || mod.add === false)) {
        return false;
      }
      if (mod && mod.view === true) {
        return true;
      }
    }

    const rolePermSnap = await db.collection('role_permissions').doc(caller.role).get();
    if (rolePermSnap.exists) {
      const mod = rolePermSnap.data()?.modulePermissions?.scanner;
      if (mod) {
        return Boolean(mod.view && mod.add !== false);
      }
    }

    const userSnap = await db.collection('user_roles').doc(caller.profileDocId).get();
    if (userSnap.exists) {
      const mods: any[] = Array.isArray(userSnap.data()?.modulesAllowed)
        ? userSnap.data()!.modulesAllowed
        : [];
      return mods.includes('all') || mods.includes('scanner');
    }

    // No explicit user_roles or permissions document resolved -> fail closed
    return false;
  } catch (err) {
    console.warn('[Scanner Permission Guard] Lookup failed; failing closed:', (err as any)?.message || err);
    return false;
  }
}

export interface AttendanceRoutesDeps {
  db: AdminFirestoreLike;
  requireVerifiedCaller: (
    req: Request,
    res: Response,
    allowedRoles: Array<'super_admin' | 'admin' | 'user'>,
    actionLabel: string
  ) => Promise<VerifiedCaller | null>;
}

// ============================================================================
// Register Authenticated Server-Side Attendance Endpoints
// ============================================================================
export function registerAttendanceRoutes(app: express.Express, deps: AttendanceRoutesDeps) {
  const { db, requireVerifiedCaller } = deps;

  async function writePunchLog(entry: Record<string, any>) {
    const id = `log_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    await db.collection('punch_logs').doc(id).set({ ...entry, id });
  }

  // --------------------------------------------------------------------------
  // 1. POST /api/attendance/scan — Authenticated Atomic First-In / Last-Out Engine
  // --------------------------------------------------------------------------
  app.post('/api/attendance/scan', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        ['super_admin', 'admin', 'user'],
        'Attendance Scan Processing'
      );
      if (!caller) return;

      const canScan = await callerHasScannerAccess(db, caller);
      if (!canScan) {
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
          description: `User "${caller.loginId}" (${caller.role}) blocked from /api/attendance/scan due to missing scanner permission.`,
          success: false,
        });
        return res.status(403).json({
          success: false,
          error: 'Forbidden: Your account does not have Attendance Scanner permission.',
        });
      }

      const parsed = AttendanceScanSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          action: 'REJECTED',
          error: parsed.error.issues[0]?.message || 'Invalid scan payload.',
          message: parsed.error.issues[0]?.message || 'Invalid scan payload.',
        });
      }

      const { rawPayload, scannerDevice = 'USB_SCANNER', customScanTime } = parsed.data;
      let { scannerType } = parsed.data;

      // Only ADMIN or SUPER_ADMIN can specify customScanTime (prevents floor operator timestamp spoofing)
      if (customScanTime && caller.role === 'user') {
        return res.status(403).json({
          success: false,
          error: 'Forbidden: Only Admin or Super Admin can submit custom scan timestamps.',
        });
      }

      const now = customScanTime ? new Date(customScanTime) : new Date();
      if (Number.isNaN(now.getTime())) {
        return res.status(400).json({ success: false, error: 'Invalid customScanTime timestamp.' });
      }

      const kolkata = getKolkataTimeParts(now);
      const timeDisplay = kolkata.timeWithSeconds;
      const { employeeId, token } = parseQrPayload(rawPayload);

      if (!employeeId) {
        await writePunchLog({
          employeeId: 'UNKNOWN',
          timestamp: now.toISOString(),
          action: 'REJECTED_TOKEN',
          rawPayload,
          scannerDevice,
          performedByUid: caller.uid,
          performedByLoginId: caller.loginId,
          message: 'Invalid QR Code payload or empty Employee ID.',
        });
        return res.status(400).json({
          success: false,
          action: 'REJECTED',
          scannerType: scannerType || 'IN',
          error: 'Invalid QR Code. Employee Not Found.',
          message: 'Invalid QR Code. Employee Not Found.',
          time: timeDisplay,
        });
      }

      const outcome = await withEmployeeScanLock(employeeId, async () => {
        const empSnap = await db.collection('employees').doc(employeeId).get();
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
              employee,
              error: 'Employee Is Inactive. Attendance Cannot Be Recorded.',
              message: 'Employee Is Inactive. Attendance Cannot Be Recorded.',
              time: timeDisplay,
            },
          };
        }

        if (employee.qrCodeToken && (!token || token !== employee.qrCodeToken)) {
          await writePunchLog({
            employeeId: employee.employeeId,
            employeeName: employee.employeeName,
            timestamp: now.toISOString(),
            action: 'REJECTED_TOKEN',
            rawPayload,
            scannerDevice,
            performedByUid: caller.uid,
            performedByLoginId: caller.loginId,
            message: token
              ? `Token mismatch: provided ${token}, expected configured qrCodeToken`
              : 'Missing required QR security token for employee with configured qrCodeToken',
          });
          return {
            httpStatus: 403,
            body: {
              success: false,
              action: 'REJECTED',
              scannerType: scannerType || 'IN',
              employee,
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

        const [shiftsSnap, settingsSnap] = await Promise.all([
          db.collection('shifts').get(),
          db.collection('system_settings').doc('global').get(),
        ]);

        const shifts = shiftsSnap.empty ? DEFAULT_SHIFTS : shiftsSnap.docs.map((d) => d.data()!);
        const settings = settingsSnap.exists ? (settingsSnap.data() || DEFAULT_SETTINGS) : DEFAULT_SETTINGS;
        const shiftsMap = new Map(shifts.map((s) => [s.id, s]));

        const todayKey = kolkata.dateKey;
        const yesterdayKey = getYesterdayKolkataDateKey(now);
        const currentMins = kolkata.totalMinutes;

        const candidateSnap = await db
          .collection('attendance')
          .where('employeeId', '==', employee.employeeId)
          .where('shiftDate', '>=', yesterdayKey)
          .get();

        const existingRecords = candidateSnap.docs
          .map((d) => d.data()!)
          .sort((a, b) => new Date(b.punchIn).getTime() - new Date(a.punchIn).getTime());

        let activeRecord: Record<string, any> | null = null;
        if (currentMins < 540) {
          const yesterdayNight = existingRecords.find(
            (r) =>
              r.shiftDate === yesterdayKey &&
              (r.shiftId === 'NIGHT' || String(r.shiftNameSnapshot || '').toUpperCase().includes('NIGHT'))
          );
          if (yesterdayNight) {
            activeRecord = yesterdayNight;
          }
        }
        if (!activeRecord) {
          activeRecord = existingRecords.find((r) => r.shiftDate === todayKey) || null;
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
                performedByUid: caller.uid,
                performedByLoginId: caller.loginId,
                message: `Subsequent Punch In (Event #${updatedAttendance.punches.length}). Status: INSIDE.`,
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
                  employee,
                  attendance: txRes.record,
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
                  employee,
                  attendance: txRes.record,
                  message: 'Duplicate scan prevented. Please wait a few seconds before scanning again.',
                  time: timeDisplay,
                },
              };
            }

            const shift = shiftsMap.get(txRes.record.shiftId) || shifts[0];
            return {
              httpStatus: 200,
              body: {
                success: true,
                action: 'PUNCH_IN',
                scannerType: 'IN',
                currentState: 'INSIDE',
                employee,
                attendance: txRes.record,
                shift,
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
              rawPayload,
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
                employee,
                message: 'No Valid Shift Found For This Punch-In Time.',
                time: timeDisplay,
              },
            };
          }

          const { shift, shiftDate } = shiftMatch;
          const attendanceId = `att_${employee.employeeId}_${shiftDate}_${shift.id}`;
          const shiftStartMins = timeStringToMinutes(shift.startTime);
          const grace = shift.gracePeriodMinutes ?? settings.lateGraceMinutes ?? 15;
          const isLate = !shift.isOvernight
            ? currentMins > shiftStartMins + grace
            : currentMins >= 1200
            ? currentMins > shiftStartMins + grace
            : true;

          const initialStatus = isLate ? 'LATE' : 'PRESENT';
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
            scheduledPunchOut: shift.endTime,
            actualPunchOut: null,
            lastPunchOut: null,
            effectivePunchOut: null,
            punchOutType: 'NONE',
            currentState: 'INSIDE',
            punches: [firstPunchEvent],
            totalDutyMinutes: 0,
            regularDutyMinutes: 0,
            overtimeMinutes: 0,
            attendanceStatus: initialStatus,
            missedPunchOut: false,
            autoClosed: false,
            qrTokenReference: employee.qrCodeToken || '',
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
              rawPayload,
              scannerDevice,
              performedByUid: caller.uid,
              performedByLoginId: caller.loginId,
              message: `First Punch In recorded for ${shift.name} (${shiftDate}). Status: ${initialStatus}.`,
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
                employee,
                attendance: txRes.record,
                message: 'Consecutive Punch In rejected. Employee is already Punched In (Status: INSIDE).',
                time: timeDisplay,
              },
            };
          }

          return {
            httpStatus: 200,
            body: {
              success: true,
              action: 'PUNCH_IN',
              scannerType: 'IN',
              currentState: 'INSIDE',
              employee,
              attendance: newAttendanceRecord,
              shift,
              message: isLate
                ? `First Punch In Recorded for ${shift.name} (Marked LATE).`
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
            rawPayload,
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
              employee,
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
          const currentState =
            currentData.currentState ||
            (currentData.actualPunchOut || currentData.punchOutType === 'ACTUAL' ? 'OUTSIDE' : 'INSIDE');

          if (currentState === 'OUTSIDE') {
            return { kind: 'CONSECUTIVE_OUT' as const, record: currentData };
          }

          const lastPunchTime =
            Array.isArray(currentData.punches) && currentData.punches.length > 0
              ? new Date(currentData.punches[currentData.punches.length - 1].timestamp).getTime()
              : new Date(currentData.updatedAt || currentData.punchIn).getTime();

          if (Math.abs(now.getTime() - lastPunchTime) < 3000) {
            return { kind: 'BOUNCE' as const, record: currentData };
          }

          const firstInIso = currentData.firstPunchIn || currentData.punchIn;
          const firstInDate = new Date(firstInIso);
          const totalDutyMinutes = Math.max(
            0,
            Math.floor((now.getTime() - firstInDate.getTime()) / (1000 * 60))
          );
          const scheduledStandardDutyMinutes = 510;
          const regularDutyMinutes = Math.min(totalDutyMinutes, scheduledStandardDutyMinutes);
          const overtimeMinutes = Math.max(0, totalDutyMinutes - scheduledStandardDutyMinutes);

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
            status: 'VALID_OUT',
            recordedByUid: caller.uid,
            recordedByLoginId: caller.loginId,
          };

          const existingPunches = Array.isArray(currentData.punches) ? currentData.punches : [];
          const updatedAttendance: Record<string, any> = {
            ...currentData,
            actualPunchOut: now.toISOString(),
            lastPunchOut: now.toISOString(),
            effectivePunchOut: now.toISOString(),
            punchOutType: 'ACTUAL',
            currentState: 'OUTSIDE',
            punches: [...existingPunches, outEvent],
            totalDutyMinutes,
            regularDutyMinutes,
            overtimeMinutes,
            attendanceStatus: 'COMPLETED',
            missedPunchOut: false,
            autoClosed: false,
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
            performedByUid: caller.uid,
            performedByLoginId: caller.loginId,
            message: `Punch Out recorded. Duty: ${formatMinutes(regularDutyMinutes)}, OT: ${formatMinutes(overtimeMinutes)}. Total: ${formatMinutes(totalDutyMinutes)}.`,
          });

          return {
            kind: 'RECORDED' as const,
            record: updatedAttendance,
            regularDutyMinutes,
            overtimeMinutes,
          };
        });

        if (txOutRes.kind === 'CONSECUTIVE_OUT') {
          await writePunchLog({
            employeeId: employee.employeeId,
            employeeName: employee.employeeName,
            timestamp: now.toISOString(),
            action: 'REJECTED_DUPLICATE',
            rawPayload,
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
              employee,
              attendance: txOutRes.record,
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
              employee,
              attendance: txOutRes.record,
              message: 'Duplicate scan prevented. Please wait a few seconds before scanning again.',
              time: timeDisplay,
            },
          };
        }

        const shift = shiftsMap.get(txOutRes.record.shiftId) || shifts[0];
        return {
          httpStatus: 200,
          body: {
            success: true,
            action: 'PUNCH_OUT',
            scannerType: 'OUT',
            currentState: 'OUTSIDE',
            employee,
            attendance: txOutRes.record,
            shift,
            message: 'Punch Out Successfully Recorded.',
            time: timeDisplay,
            dutyFormatted: formatMinutes(txOutRes.regularDutyMinutes),
            otFormatted: formatMinutes(txOutRes.overtimeMinutes),
            punchCount: txOutRes.record.punches.length,
          },
        };
      });

      return res.status(outcome.httpStatus).json(outcome.body);
    } catch (err: any) {
      console.error('[API Attendance Scan] Error:', err);
      return res.status(500).json({
        success: false,
        action: 'REJECTED',
        error: 'Attendance scan processing failed.',
        message: 'Attendance scan processing failed.',
      });
    }
  });

  // --------------------------------------------------------------------------
  // 2. POST /api/attendance/auto-close — Automatic Shift Closing Engine (ADMIN / SUPER_ADMIN)
  // --------------------------------------------------------------------------
  app.post('/api/attendance/auto-close', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        ['super_admin', 'admin'],
        'Auto Close Expired Shifts'
      );
      if (!caller) return;

      const now = new Date();
      const [settingsSnap, shiftsSnap, openSnap] = await Promise.all([
        db.collection('system_settings').doc('global').get(),
        db.collection('shifts').get(),
        db.collection('attendance').where('punchOutType', '==', 'NONE').get(),
      ]);

      const settings = settingsSnap.exists ? (settingsSnap.data() || DEFAULT_SETTINGS) : DEFAULT_SETTINGS;
      if (!settings.autoPunchOutEnabled) {
        return res.json({ success: true, closedCount: 0, closedRecords: [] });
      }

      const shifts = shiftsSnap.empty ? DEFAULT_SHIFTS : shiftsSnap.docs.map((d) => d.data()!);
      const shiftsMap = new Map(shifts.map((s) => [s.id, s]));
      const closedRecords: any[] = [];

      for (const docSnap of openSnap.docs) {
        const record = docSnap.data()!;
        if (record.actualPunchOut || record.punchOutType !== 'NONE') continue;

        const shift = shiftsMap.get(record.shiftId);
        if (!shift) continue;

        const scheduledEndIso = getShiftScheduledEndIso(record.shiftDate, shift);
        const scheduledEndDate = new Date(scheduledEndIso);

        if (now.getTime() > scheduledEndDate.getTime()) {
          const scheduledDuration = shift.scheduledDurationMinutes || settings.scheduledDurationMinutes || 510;
          const docRef = db.collection('attendance').doc(record.id);

          const updatedRecord = await db.runTransaction(async (tx) => {
            const freshSnap = await tx.get(docRef);
            if (!freshSnap.exists) return null;
            const fresh = freshSnap.data()!;
            if (fresh.actualPunchOut || fresh.punchOutType !== 'NONE') return null;

            const next = {
              ...fresh,
              actualPunchOut: null,
              lastPunchOut: null,
              effectivePunchOut: scheduledEndIso,
              punchOutType: 'AUTO',
              currentState: 'OUTSIDE',
              attendanceStatus: 'AUTO CLOSED',
              missedPunchOut: true,
              autoClosed: true,
              totalDutyMinutes: scheduledDuration,
              regularDutyMinutes: scheduledDuration,
              overtimeMinutes: 0, // Zero OT on auto-closed shifts
              updatedAt: now.toISOString(),
            };
            tx.set(docRef, next);
            return next;
          });

          if (updatedRecord) {
            closedRecords.push(updatedRecord);
            await writePunchLog({
              employeeId: record.employeeId,
              employeeName: record.employeeNameSnapshot,
              timestamp: now.toISOString(),
              action: 'AUTO_CLOSE',
              rawPayload: 'SYSTEM_CRON',
              scannerDevice: 'SYSTEM_AUTO',
              performedByUid: caller.uid,
              performedByLoginId: caller.loginId,
              message: `Auto-closed at scheduled shift end (${shift.endTime}). Status: AUTO CLOSED. OT: 00:00.`,
            });
            await recordEnterpriseAuditEvent(db, {
              req,
              action: 'AUTOMATIC_PUNCH_OUT',
              category: 'ATTENDANCE',
              actorUid: caller.uid,
              actorLoginId: caller.loginId,
              actorRole: caller.role.toUpperCase(),
              employeeId: record.employeeId,
              targetType: 'ATTENDANCE',
              targetId: record.id,
              newValue: `Auto-closed at ${scheduledEndIso}, Duty: ${formatMinutes(scheduledDuration)}, OT: 00:00`,
              actionSource: 'SYSTEM_SCHEDULER',
              reason: 'Employee missed scanning Punch Out at scheduled shift closing',
              captureGeo: false,
            });
          }
        }
      }

      return res.json({
        success: true,
        closedCount: closedRecords.length,
        closedRecords,
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
        ['super_admin', 'admin'],
        'Manual Attendance Correction'
      );
      if (!caller) return;

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

        if (actualPunchOut) {
          const inTime = new Date(current.firstPunchIn || current.punchIn).getTime();
          const outTime = new Date(actualPunchOut).getTime();
          if (Number.isNaN(outTime)) {
            throw new Error('INVALID_PUNCH_OUT');
          }
          totalDutyMinutes = Math.max(0, Math.floor((outTime - inTime) / (60 * 1000)));
          regularDutyMinutes = Math.min(totalDutyMinutes, 510);
          overtimeMinutes = punchOutType === 'AUTO' ? 0 : Math.max(0, totalDutyMinutes - 510);
        } else if (punchOutType === 'AUTO') {
          overtimeMinutes = 0;
        }

        const updatedFields = {
          actualPunchOut: actualPunchOut || current.actualPunchOut || null,
          lastPunchOut: actualPunchOut || current.lastPunchOut || null,
          effectivePunchOut: actualPunchOut || current.effectivePunchOut || null,
          punchOutType,
          currentState: actualPunchOut ? 'OUTSIDE' : current.currentState || 'OUTSIDE',
          attendanceStatus,
          totalDutyMinutes,
          regularDutyMinutes,
          overtimeMinutes,
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
        newValue: `Status: ${attendanceStatus}, Out: ${actualPunchOut || 'None'}`,
        actionSource: 'ADMIN_CORRECTION',
        reason: reason.trim(),
        description: `Attendance record ${attendanceId} corrected by "${caller.loginId}".`,
      });

      return res.json({ success: true, record: txResult.updated });
    } catch (err: any) {
      if (err?.message === 'INVALID_PUNCH_OUT') {
        return res.status(400).json({ success: false, error: 'Invalid actualPunchOut timestamp.' });
      }
      console.error('[API Attendance Correct] Error:', err);
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
        ['super_admin', 'admin'],
        'Generate Shift Roster'
      );
      if (!caller) return;

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
}
