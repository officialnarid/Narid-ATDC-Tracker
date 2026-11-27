import {
  apiFetchJson,
  apiUrl,
  assertApiBaseConfigured,
  executeApiFetch,
  isApiBaseUsableForCurrentOrigin,
  safeParseJsonResponse,
} from '../config/api';
import { getAuthHeaders } from './auditService';
import {
  AttendanceRecord,
  Employee,
  Shift,
  ScanResult,
  PunchEvent,
  AttendanceStatus,
  ShiftRoster,
} from '../types';

// Format minutes to "HH:MM Hours"
export function formatMinutes(mins: number): string {
  if (mins <= 0) return '00:00 Hours';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} Hours`;
}

// Convert "HH:mm" to minutes since midnight
export function timeStringToMinutes(timeStr: string): number {
  if (!timeStr) return 0;
  const [hh, mm] = timeStr.split(':').map(Number);
  return hh * 60 + (mm || 0);
}

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

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * Extract comprehensive date and time components strictly in Asia/Kolkata timezone
 */
export function getKolkataTimeParts(date: Date = new Date()): {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
  seconds: number;
  dateKey: string; // "YYYY-MM-DD"
  totalMinutes: number; // 0 to 1439
  timeDisplay: string; // "hh:mm A"
  timeWithSeconds: string; // "hh:mm:ss A"
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

// Format Date object to "YYYY-MM-DD" in Asia/Kolkata
export function formatDateKey(d: Date = new Date()): string {
  return getKolkataTimeParts(d).dateKey;
}

// Get yesterday's date key "YYYY-MM-DD" in Asia/Kolkata
export function getYesterdayKolkataDateKey(d: Date = new Date()): string {
  const yesterday = new Date(d.getTime() - 24 * 3600 * 1000);
  return getKolkataTimeParts(yesterday).dateKey;
}

// Calculate next calendar day in "YYYY-MM-DD"
export function getNextDateKey(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  const nextY = dt.getUTCFullYear();
  const nextM = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const nextD = String(dt.getUTCDate()).padStart(2, '0');
  return `${nextY}-${nextM}-${nextD}`;
}

// Get scheduled end time in ISO string with Asia/Kolkata (+05:30) offset
export function getShiftScheduledEndIso(shiftDate: string, shift: Shift): string {
  const targetDateKey = shift.isOvernight ? getNextDateKey(shiftDate) : shiftDate;
  const [h, m] = shift.endTime.split(':');
  return `${targetDateKey}T${h.padStart(2, '0')}:${m.padStart(2, '0')}:00+05:30`;
}

// Format ISO string to time string "hh:mm AM/PM" strictly in Asia/Kolkata (IST)
export function formatTimeDisplay(isoString: string | null | undefined): string {
  if (!isoString) return '--:--';
  const dt = new Date(isoString);
  if (Number.isNaN(dt.getTime())) return '--:--';
  return getKolkataTimeParts(dt).timeDisplay;
}

// Format ISO string to full IST date+time string "DD Mon YYYY, hh:mm:ss AM/PM IST" (returns "N/A" if absent)
export function formatDateTimeDisplay(isoString: string | null | undefined): string {
  if (!isoString) return 'N/A';
  const dt = new Date(isoString);
  if (Number.isNaN(dt.getTime())) return 'N/A';
  const parts = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  }).formatToParts(dt);
  const map: Record<string, string> = {};
  for (const p of parts) {
    map[p.type] = p.value;
  }
  const timeParts = getKolkataTimeParts(dt);
  return `${String(map.day || '01').padStart(2, '0')} ${map.month || 'Jan'} ${map.year || '1970'}, ${timeParts.timeWithSeconds} IST`;
}

export type QrPayloadFormat = 'JSON_TOKEN' | 'TOKEN_STRING' | 'LEGACY_EMPLOYEE_ID' | 'INVALID';

const EMPLOYEE_ID_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;

// Parse QR code payload.
// Payloads can be JSON {"employeeId":"JMD12345","token":"..."}, raw "QR_JMD12345_...", or legacy plain "JMD12345"
export function parseQrPayload(raw: string): { employeeId: string; token?: string; format: QrPayloadFormat } {
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

/**
 * Pure helper for automatic shift identification based on punch-in time
 */
export function identifyShiftForPunchIn(
  shifts: Shift[],
  now: Date = new Date()
): { shift: Shift; shiftDate: string } | null {
  const kolkata = getKolkataTimeParts(now);
  const currentMins = kolkata.totalMinutes;
  const activeShifts = shifts.filter((s) => s.status === 'Active');

  for (const shift of activeShifts) {
    const rawStart = String(shift.punchInWindowStart || '').trim();
    const rawEnd = String(shift.punchInWindowEnd || '').trim();
    const idUpper = String(shift.id || '').toUpperCase();
    let winStartStr = rawStart;
    let winEndStr = rawEnd;
    if (!shift.isOvernight && (idUpper === 'DAY' || shift.startTime === '09:00') && rawStart === '09:00' && rawEnd === '20:00') {
      winStartStr = '06:00';
      winEndStr = '18:00';
    } else if ((shift.isOvernight || idUpper === 'NIGHT') && shift.startTime === '20:00' && rawStart === '20:00' && rawEnd === '09:00') {
      winStartStr = '18:00';
      winEndStr = '06:00';
    }

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

// Query attendance records via authenticated, RBAC & Company Wi-Fi enforced backend API (F-02)
export async function getAttendanceRecords(options?: {
  shiftDate?: string;
  fromDate?: string;
  toDate?: string;
  shiftId?: string;
}): Promise<AttendanceRecord[]> {
  const headers = await getAuthHeaders();
  const params = new URLSearchParams();
  if (options?.shiftDate) params.set('shiftDate', options.shiftDate);
  if (options?.fromDate) params.set('fromDate', options.fromDate);
  if (options?.toDate) params.set('toDate', options.toDate);
  if (options?.shiftId && options.shiftId !== 'ALL') params.set('shiftId', options.shiftId);
  const qs = params.toString();
  const data = await apiFetchJson<{ success: boolean; records?: AttendanceRecord[] }>(
    `/api/attendance/records${qs ? `?${qs}` : ''}`,
    { method: 'GET', headers },
    'Failed to load attendance records.',
    { preferSameOriginInPreview: true }
  );
  return Array.isArray(data.records) ? data.records : [];
}

// Query punch events via authenticated backend API (read-only)
export async function getPunchEvents(options?: {
  shiftDate?: string;
  employeeId?: string;
  limitCount?: number;
}): Promise<PunchEvent[]> {
  try {
    const headers = await getAuthHeaders();
    const params = new URLSearchParams();
    if (options?.shiftDate) params.set('shiftDate', options.shiftDate);
    if (options?.employeeId) params.set('employeeId', options.employeeId);
    if (options?.limitCount) params.set('limit', String(options.limitCount));
    const qs = params.toString();
    const data = await apiFetchJson<{ success: boolean; events?: PunchEvent[] }>(
      `/api/attendance/punch-events${qs ? `?${qs}` : ''}`,
      { method: 'GET', headers },
      'Failed to load punch events.',
      { preferSameOriginInPreview: true }
    );
    return Array.isArray(data.events) ? data.events : [];
  } catch (err) {
    console.error('Error fetching punch events:', err);
    return [];
  }
}

export interface DualScanParams {
  rawPayload: string;
  scannerType: 'IN' | 'OUT';
  scannerDevice?: 'USB_SCANNER' | 'WEBCAM' | 'MANUAL' | 'SYSTEM_AUTO';
  customScanTime?: Date;
  clientRequestId?: string;
}

/**
 * Server-Authoritative Dual Attendance Scanner
 * Delegates scan validation, QR token check, First-In/Last-Out OT rules,
 * and atomic Firestore transactions to the authenticated backend Admin SDK API.
 */
export async function processDualAttendanceScan({
  rawPayload,
  scannerType,
  scannerDevice = 'USB_SCANNER',
  customScanTime,
  clientRequestId,
}: DualScanParams): Promise<ScanResult> {
  const apiStart = nowMs();
  const now = customScanTime || new Date();
  const timeDisplay = getKolkataTimeParts(now).timeWithSeconds;

  assertApiBaseConfigured();
  const headers = await getAuthHeaders();
  const tokenFetchMs = Number((nowMs() - apiStart).toFixed(2));
  const res = await executeApiFetch(
    apiUrl('/api/attendance/scan'),
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        rawPayload,
        scannerType,
        scannerDevice,
        ...(clientRequestId ? { clientRequestId } : {}),
        ...(customScanTime ? { customScanTime: customScanTime.toISOString() } : {}),
      }),
    },
    'POST /api/attendance/scan',
    { timeoutMs: 12000, preferSameOriginInPreview: true }
  );

  const parsed = await safeParseJsonResponse<any>(res, 'POST /api/attendance/scan');
  const networkApiMs = Number((nowMs() - apiStart).toFixed(2));
  const data = parsed.data || {};
  const srvPerf = data?.perf && typeof data.perf === 'object' ? data.perf : undefined;
  return {
    success: Boolean(parsed.ok && data?.success),
    action: data?.action || 'REJECTED',
    scannerType: data?.scannerType || scannerType,
    currentState: data?.currentState,
    employee: data?.employee,
    attendance: data?.attendance,
    shift: data?.shift,
    message: data?.message || parsed.errorMessage || data?.error || 'Attendance scan rejected.',
    time: data?.time || timeDisplay,
    dutyFormatted: data?.dutyFormatted,
    otFormatted: data?.otFormatted,
    punchCount: data?.punchCount,
    perf: {
      qrParseMs: typeof srvPerf?.qrParseMs === 'number' ? srvPerf.qrParseMs : undefined,
      tokenFetchMs,
      tokenVerifyMs: typeof srvPerf?.tokenVerifyMs === 'number' ? srvPerf.tokenVerifyMs : undefined,
      callerLookupMs: typeof srvPerf?.callerLookupMs === 'number' ? srvPerf.callerLookupMs : undefined,
      authMs: typeof srvPerf?.authMs === 'number' ? srvPerf.authMs : undefined,
      permissionMs: typeof srvPerf?.permissionMs === 'number' ? srvPerf.permissionMs : undefined,
      employeeLookupMs: typeof srvPerf?.employeeLookupMs === 'number' ? srvPerf.employeeLookupMs : undefined,
      attendanceLookupMs: typeof srvPerf?.attendanceLookupMs === 'number' ? srvPerf.attendanceLookupMs : undefined,
      configLookupMs: typeof srvPerf?.configLookupMs === 'number' ? srvPerf.configLookupMs : undefined,
      lookupAndQueryMs: typeof srvPerf?.lookupAndQueryMs === 'number' ? srvPerf.lookupAndQueryMs : undefined,
      tokenValidationMs: typeof srvPerf?.tokenValidationMs === 'number' ? srvPerf.tokenValidationMs : undefined,
      txMs: typeof srvPerf?.txMs === 'number' ? srvPerf.txMs : undefined,
      firestoreOpMs: typeof srvPerf?.firestoreOpMs === 'number' ? srvPerf.firestoreOpMs : undefined,
      auditMs: typeof srvPerf?.auditMs === 'number' ? srvPerf.auditMs : undefined,
      totalServerMs: typeof srvPerf?.totalServerMs === 'number' ? srvPerf.totalServerMs : undefined,
      firestoreReads: typeof srvPerf?.firestoreReads === 'number' ? srvPerf.firestoreReads : undefined,
      firestoreWrites: typeof srvPerf?.firestoreWrites === 'number' ? srvPerf.firestoreWrites : undefined,
      parallelPrefetchUsed: typeof srvPerf?.parallelPrefetchUsed === 'boolean' ? srvPerf.parallelPrefetchUsed : undefined,
      networkApiMs,
    },
  };
}

export interface ManualPunchParams {
  employeeId: string;
  scannerType: 'IN' | 'OUT';
  reason?: string;
  customScanTime?: Date;
  clientRequestId?: string;
}

/**
 * Dedicated Authorized Manual Employee ID Punch Flow
 * Separate from QR token scanning; validates operator authorization and employee record on the backend.
 */
export async function processManualAttendancePunch({
  employeeId,
  scannerType,
  reason,
  customScanTime,
  clientRequestId,
}: ManualPunchParams): Promise<ScanResult> {
  const apiStart = nowMs();
  const now = customScanTime || new Date();
  const timeDisplay = getKolkataTimeParts(now).timeWithSeconds;

  assertApiBaseConfigured();
  const headers = await getAuthHeaders();
  const tokenFetchMs = Number((nowMs() - apiStart).toFixed(2));
  const res = await executeApiFetch(
    apiUrl('/api/attendance/manual-punch'),
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        employeeId: employeeId.trim().toUpperCase(),
        scannerType,
        ...(clientRequestId ? { clientRequestId } : {}),
        ...(reason ? { reason: reason.trim() } : {}),
        ...(customScanTime ? { customScanTime: customScanTime.toISOString() } : {}),
      }),
    },
    'POST /api/attendance/manual-punch',
    { timeoutMs: 12000, preferSameOriginInPreview: true }
  );

  const parsed = await safeParseJsonResponse<any>(res, 'POST /api/attendance/manual-punch');
  const networkApiMs = Number((nowMs() - apiStart).toFixed(2));
  const data = parsed.data || {};
  const srvPerf = data?.perf && typeof data.perf === 'object' ? data.perf : undefined;
  return {
    success: Boolean(parsed.ok && data?.success),
    action: data?.action || 'REJECTED',
    scannerType: data?.scannerType || scannerType,
    currentState: data?.currentState,
    employee: data?.employee,
    attendance: data?.attendance,
    shift: data?.shift,
    message: data?.message || parsed.errorMessage || data?.error || 'Manual Employee ID punch rejected.',
    time: data?.time || timeDisplay,
    dutyFormatted: data?.dutyFormatted,
    otFormatted: data?.otFormatted,
    punchCount: data?.punchCount,
    perf: {
      tokenFetchMs,
      tokenVerifyMs: typeof srvPerf?.tokenVerifyMs === 'number' ? srvPerf.tokenVerifyMs : undefined,
      callerLookupMs: typeof srvPerf?.callerLookupMs === 'number' ? srvPerf.callerLookupMs : undefined,
      authMs: typeof srvPerf?.authMs === 'number' ? srvPerf.authMs : undefined,
      permissionMs: typeof srvPerf?.permissionMs === 'number' ? srvPerf.permissionMs : undefined,
      employeeLookupMs: typeof srvPerf?.employeeLookupMs === 'number' ? srvPerf.employeeLookupMs : undefined,
      attendanceLookupMs: typeof srvPerf?.attendanceLookupMs === 'number' ? srvPerf.attendanceLookupMs : undefined,
      configLookupMs: typeof srvPerf?.configLookupMs === 'number' ? srvPerf.configLookupMs : undefined,
      lookupAndQueryMs: typeof srvPerf?.lookupAndQueryMs === 'number' ? srvPerf.lookupAndQueryMs : undefined,
      txMs: typeof srvPerf?.txMs === 'number' ? srvPerf.txMs : undefined,
      firestoreOpMs: typeof srvPerf?.firestoreOpMs === 'number' ? srvPerf.firestoreOpMs : undefined,
      auditMs: typeof srvPerf?.auditMs === 'number' ? srvPerf.auditMs : undefined,
      totalServerMs: typeof srvPerf?.totalServerMs === 'number' ? srvPerf.totalServerMs : undefined,
      firestoreReads: typeof srvPerf?.firestoreReads === 'number' ? srvPerf.firestoreReads : undefined,
      firestoreWrites: typeof srvPerf?.firestoreWrites === 'number' ? srvPerf.firestoreWrites : undefined,
      parallelPrefetchUsed: typeof srvPerf?.parallelPrefetchUsed === 'boolean' ? srvPerf.parallelPrefetchUsed : undefined,
      networkApiMs,
    },
  };
}

/**
 * Server-Authoritative Attendance Scan with optional auto-direction detection
 */
export async function processAttendanceScan(
  rawPayload: string,
  scannerDevice: 'USB_SCANNER' | 'WEBCAM' = 'USB_SCANNER',
  customScanTime?: Date,
  explicitScannerType?: 'IN' | 'OUT'
): Promise<ScanResult> {
  const now = customScanTime || new Date();
  const timeDisplay = getKolkataTimeParts(now).timeWithSeconds;

  assertApiBaseConfigured();
  const headers = await getAuthHeaders();
  const res = await executeApiFetch(
    apiUrl('/api/attendance/scan'),
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        rawPayload,
        ...(explicitScannerType ? { scannerType: explicitScannerType } : {}),
        scannerDevice,
        ...(customScanTime ? { customScanTime: customScanTime.toISOString() } : {}),
      }),
    },
    'POST /api/attendance/scan',
    { preferSameOriginInPreview: true }
  );

  const parsed = await safeParseJsonResponse<any>(res, 'POST /api/attendance/scan');
  const data = parsed.data || {};
  return {
    success: Boolean(parsed.ok && data?.success),
    action: data?.action || 'REJECTED',
    scannerType: data?.scannerType || explicitScannerType,
    currentState: data?.currentState,
    employee: data?.employee,
    attendance: data?.attendance,
    shift: data?.shift,
    message: data?.message || parsed.errorMessage || data?.error || 'Attendance scan rejected.',
    time: data?.time || timeDisplay,
    dutyFormatted: data?.dutyFormatted,
    otFormatted: data?.otFormatted,
    punchCount: data?.punchCount,
  };
}

/**
 * Server-Authoritative Automatic Shift Closing Engine (ADMIN / SUPER_ADMIN only)
 */
export async function runAutoCloseShiftsEngine(options?: {
  silent?: boolean;
}): Promise<{
  closedCount: number;
  closedRecords: AttendanceRecord[];
}> {
  if (!isApiBaseUsableForCurrentOrigin()) {
    return { closedCount: 0, closedRecords: [] };
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { closedCount: 0, closedRecords: [] };
  }
  try {
    const headers = await getAuthHeaders();
    if (!headers.Authorization) {
      return { closedCount: 0, closedRecords: [] };
    }
    const res = await executeApiFetch(
      apiUrl('/api/attendance/auto-close'),
      {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      },
      'POST /api/attendance/auto-close',
      { preferSameOriginInPreview: true }
    );
    const parsed = await safeParseJsonResponse<any>(res, 'POST /api/attendance/auto-close');
    if (!parsed.ok || !parsed.data) {
      return { closedCount: 0, closedRecords: [] };
    }
    return {
      closedCount: Number(parsed.data.closedCount || 0),
      closedRecords: Array.isArray(parsed.data.closedRecords) ? parsed.data.closedRecords : [],
    };
  } catch (error) {
    if (options?.silent) {
      console.warn('Auto shift closing check skipped due to transient network error:', error);
    } else {
      console.error('Error during auto shift closing execution:', error);
    }
    return { closedCount: 0, closedRecords: [] };
  }
}

/**
 * Manual Admin Attendance Correction via authenticated backend API
 */
export async function correctAttendanceRecord(
  attendanceId: string,
  updates: {
    actualPunchOut?: string;
    punchOutType: 'ACTUAL' | 'AUTO';
    attendanceStatus: AttendanceStatus;
    reason: string;
    adminName: string;
  }
): Promise<void> {
  const headers = await getAuthHeaders();
  await apiFetchJson(
    '/api/attendance/correct',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        attendanceId,
        actualPunchOut: updates.actualPunchOut,
        punchOutType: updates.punchOutType,
        attendanceStatus: updates.attendanceStatus,
        reason: updates.reason,
      }),
    },
    'Failed to correct attendance record.',
    { preferSameOriginInPreview: true }
  );
}

// Daily Shift Roster Functions (read-only query via authenticated backend API)
export async function getShiftRoster(shiftDate: string, shiftId?: string): Promise<ShiftRoster[]> {
  try {
    const headers = await getAuthHeaders();
    const params = new URLSearchParams({ shiftDate });
    if (shiftId && shiftId !== 'ALL') params.set('shiftId', shiftId);
    const data = await apiFetchJson<{ success: boolean; rosters?: ShiftRoster[] }>(
      `/api/attendance/rosters?${params.toString()}`,
      { method: 'GET', headers },
      'Failed to load shift rosters.',
      { preferSameOriginInPreview: true }
    );
    return Array.isArray(data.rosters) ? data.rosters : [];
  } catch (error) {
    console.error('Error fetching shift rosters:', error);
    return [];
  }
}

// Generate or update shift roster via authenticated backend API
export async function generateRosterForDate(
  shiftDate: string,
  shiftId: string,
  _employees?: Employee[]
): Promise<{ scheduledCount: number }> {
  const headers = await getAuthHeaders();
  const data = await apiFetchJson<{ success: boolean; scheduledCount?: number }>(
    '/api/attendance/roster',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ shiftDate, shiftId }),
    },
    'Failed to generate shift roster.',
    { preferSameOriginInPreview: true }
  );
  return { scheduledCount: Number(data.scheduledCount || 0) };
}
