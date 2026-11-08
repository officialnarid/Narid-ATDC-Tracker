import { 
  collection, 
  doc, 
  getDoc, 
  getDocs, 
  setDoc, 
  updateDoc, 
  query, 
  where 
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType, sanitizeFirestoreData } from '../firebase';
import { 
  AttendanceRecord, 
  Employee, 
  Shift, 
  ScanResult, 
  PunchLog, 
  AttendanceStatus,
  ShiftRoster
} from '../types';
import { getEmployeeById } from './employeeService';
import { getShifts, getSystemSettings, recordAuditLog } from './masterService';

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
  return (hh * 60) + (mm || 0);
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
  const totalMinutes = (hours * 60) + minutes;

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

// Format ISO string to time string "hh:mm A" in Asia/Kolkata
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

// Parse QR code payload.
// Payloads can be JSON {"id":"JMD12345","token":"..."}, or raw "JMD12345" or "QR_JMD12345_..."
export function parseQrPayload(raw: string): { employeeId: string; token?: string } {
  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed.employeeId || parsed.id) {
      return {
        employeeId: (parsed.employeeId || parsed.id).toUpperCase(),
        token: parsed.token || parsed.qrToken,
      };
    }
  } catch {
    // Not JSON, check if token pattern e.g. QR_JMD12345_...
    if (trimmed.startsWith('QR_')) {
      const parts = trimmed.split('_');
      if (parts.length >= 2) {
        return { employeeId: parts[1].toUpperCase(), token: trimmed };
      }
    }
  }
  // Fallback direct employee ID e.g. JMD12345
  return { employeeId: trimmed.toUpperCase() };
}

/**
 * AUTOMATIC SHIFT IDENTIFICATION BASED ON PUNCH-IN TIME:
 * - Day Shift Window: 09:00 AM to before 08:00 PM (540 <= mins < 1200)
 * - Night Shift Window: 08:00 PM to before 09:00 AM (mins >= 1200 OR mins < 540)
 *   - 20:00 to 23:59: shiftDate is today
 *   - 00:00 to 08:59: shiftDate is yesterday (belongs to the night shift started yesterday evening)
 * 
 * Boundary handling has zero overlap and full 24-hour coverage.
 */
export function identifyShiftForPunchIn(
  shifts: Shift[], 
  now: Date = new Date()
): { shift: Shift; shiftDate: string } | null {
  const kolkata = getKolkataTimeParts(now);
  const currentMins = kolkata.totalMinutes;
  const activeShifts = shifts.filter(s => s.status === 'Active');

  // Match against configured shift punchIn windows if provided
  for (const shift of activeShifts) {
    const winStart = timeStringToMinutes(shift.punchInWindowStart);
    const winEnd = timeStringToMinutes(shift.punchInWindowEnd);

    if (winStart < winEnd) {
      // Normal daytime window (e.g. 09:00 to 20:00)
      if (currentMins >= winStart && currentMins < winEnd) {
        return { shift, shiftDate: kolkata.dateKey };
      }
    } else {
      // Overnight window (e.g. 20:00 to 09:00)
      if (currentMins >= winStart) {
        // 20:00 to 23:59
        return { shift, shiftDate: kolkata.dateKey };
      } else if (currentMins < winEnd) {
        // 00:00 to 08:59: shift started on the previous day
        const yesterdayKey = getYesterdayKolkataDateKey(now);
        return { shift, shiftDate: yesterdayKey };
      }
    }
  }

  // Fallback standards: Day [09:00, 20:00) and Night [20:00, 09:00)
  const dayShift = activeShifts.find(s => !s.isOvernight) || activeShifts[0];
  const nightShift = activeShifts.find(s => s.isOvernight) || activeShifts[activeShifts.length - 1];

  if (currentMins >= 540 && currentMins < 1200) {
    // 09:00 AM to 07:59 PM -> DAY SHIFT
    return dayShift ? { shift: dayShift, shiftDate: kolkata.dateKey } : null;
  } else if (currentMins >= 1200) {
    // 08:00 PM to 11:59 PM -> NIGHT SHIFT (same calendar day)
    return nightShift ? { shift: nightShift, shiftDate: kolkata.dateKey } : null;
  } else {
    // 12:00 AM to 08:59 AM -> NIGHT SHIFT (started previous calendar day)
    return nightShift ? { shift: nightShift, shiftDate: getYesterdayKolkataDateKey(now) } : null;
  }
}

// Record raw punch log
export async function recordPunchLog(log: Omit<PunchLog, 'id'>): Promise<void> {
  try {
    const id = `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    await setDoc(doc(db, 'punch_logs', id), sanitizeFirestoreData({
      ...log,
      id,
    }));
  } catch (e) {
    console.error('Failed to save punch log:', e);
  }
}

/**
 * MAIN PUNCH SCAN PROCESSOR
 * Automatically identifies shift from Punch-In time.
 * Enforces:
 * - 1 Punch In & 1 Punch Out per attendance cycle (duplicate protection).
 * - Automatic shift identification without manual prompts.
 * - Overtime calculated ONLY from actual Punch Out.
 * - Auto-closed attendance has 0 OT.
 */
export async function processAttendanceScan(
  rawPayload: string,
  scannerDevice: 'USB_SCANNER' | 'WEBCAM' = 'USB_SCANNER',
  customScanTime?: Date
): Promise<ScanResult> {
  const now = customScanTime || new Date();
  const kolkata = getKolkataTimeParts(now);
  const timeDisplay = kolkata.timeWithSeconds;

  const { employeeId, token } = parseQrPayload(rawPayload);

  if (!employeeId) {
    await recordPunchLog({
      employeeId: 'UNKNOWN',
      timestamp: now.toISOString(),
      action: 'REJECTED_TOKEN',
      rawPayload,
      scannerDevice,
      message: 'Invalid QR Code payload.',
    });
    return {
      success: false,
      action: 'REJECTED',
      message: 'Invalid QR Code. Employee Not Found.',
      time: timeDisplay,
    };
  }

  // 1. Fetch employee from Firestore
  const employee = await getEmployeeById(employeeId);
  if (!employee) {
    await recordPunchLog({
      employeeId,
      timestamp: now.toISOString(),
      action: 'REJECTED_TOKEN',
      rawPayload,
      scannerDevice,
      message: `Employee ID ${employeeId} not found in database.`,
    });
    return {
      success: false,
      action: 'REJECTED',
      message: `Invalid QR Code. Employee "${employeeId}" Not Found.`,
      time: timeDisplay,
    };
  }

  // 2. Verify Employee is Active
  if (employee.employeeStatus !== 'Active') {
    await recordPunchLog({
      employeeId,
      employeeName: employee.employeeName,
      timestamp: now.toISOString(),
      action: 'REJECTED_INACTIVE',
      rawPayload,
      scannerDevice,
      message: `Employee ${employeeId} is inactive.`,
    });
    return {
      success: false,
      action: 'REJECTED',
      employee,
      message: 'Employee Is Inactive. Attendance Cannot Be Recorded.',
      time: timeDisplay,
    };
  }

  // 3. Verify QR Token if provided in payload
  if (token && employee.qrCodeToken && token !== employee.qrCodeToken) {
    await recordPunchLog({
      employeeId,
      employeeName: employee.employeeName,
      timestamp: now.toISOString(),
      action: 'REJECTED_TOKEN',
      rawPayload,
      scannerDevice,
      message: `Token mismatch: provided ${token}, actual ${employee.qrCodeToken}`,
    });
    return {
      success: false,
      action: 'REJECTED',
      employee,
      message: 'QR Token Expired or Revoked. Please re-issue QR code.',
      time: timeDisplay,
    };
  }

  // 4. Fetch shifts & system settings
  const shifts = await getShifts();
  const settings = await getSystemSettings();
  const shiftsMap = new Map(shifts.map(s => [s.id, s]));

  // 5. Query open attendance records for this employee
  const attQuery = query(
    collection(db, 'attendance'),
    where('employeeId', '==', employee.employeeId),
    where('punchOutType', '==', 'NONE')
  );
  const existingAttDocs = await getDocs(attQuery);
  const openRecords = existingAttDocs.docs
    .map(d => d.data() as AttendanceRecord)
    .filter(a => !a.actualPunchOut && a.punchOutType === 'NONE');

  // Check if there is an active OPEN attendance record
  if (openRecords.length > 0) {
    // Sort so most recent is first
    openRecords.sort((a, b) => new Date(b.punchIn).getTime() - new Date(a.punchIn).getTime());
    const openRecord = openRecords[0];
    const openShift = shiftsMap.get(openRecord.shiftId) || shifts[0];

    // Determine scheduled end timestamp of the open shift
    const scheduledEndIso = getShiftScheduledEndIso(openRecord.shiftDate, openShift);
    const scheduledEndDate = new Date(scheduledEndIso);

    // If an employee punched in just seconds ago (prevent accidental double tap)
    const punchInDate = new Date(openRecord.punchIn);
    const elapsedSinceInMs = now.getTime() - punchInDate.getTime();
    if (elapsedSinceInMs < 60 * 1000) {
      return {
        success: false,
        action: 'REJECTED_DUPLICATE',
        employee,
        attendance: openRecord,
        shift: openShift,
        message: `Duplicate scan prevented. Already Punched In at ${formatTimeDisplay(openRecord.punchIn)}.`,
        time: timeDisplay,
      };
    }

    // Check if the open record is already far expired (e.g. from an earlier day and missed closing)
    // If it expired more than 16 hours ago or is from an earlier cycle, auto-close it now and evaluate new punch
    const maxShiftLifeMs = (openShift.scheduledDurationMinutes + 720) * 60 * 1000; // scheduled + 12h
    if (elapsedSinceInMs > maxShiftLifeMs) {
      // Auto-close stale open record with 0 OT
      const closedStaleRecord: AttendanceRecord = {
        ...openRecord,
        actualPunchOut: null,
        effectivePunchOut: scheduledEndIso,
        punchOutType: 'AUTO',
        attendanceStatus: 'MISSED PUNCH OUT',
        regularDutyMinutes: openShift.scheduledDurationMinutes || 510,
        overtimeMinutes: 0,
        updatedAt: now.toISOString(),
      };
      await setDoc(doc(db, 'attendance', openRecord.id), sanitizeFirestoreData(closedStaleRecord));
      // Now continue down to create a new punch in!
    } else {
      // THIS IS A VALID PUNCH OUT!
      const totalDurationMins = Math.max(0, Math.floor((now.getTime() - punchInDate.getTime()) / (1000 * 60)));
      const scheduledDuration = openShift.scheduledDurationMinutes || settings.scheduledDurationMinutes || 510;

      // Regular duty and overtime (Overtime calculated ONLY from actual Punch Out)
      const regularDutyMins = Math.min(totalDurationMins, scheduledDuration);
      const overtimeMins = Math.max(0, totalDurationMins - scheduledDuration);

      const updatedRecord: AttendanceRecord = {
        ...openRecord,
        actualPunchOut: now.toISOString(),
        effectivePunchOut: now.toISOString(),
        punchOutType: 'ACTUAL',
        regularDutyMinutes: regularDutyMins,
        overtimeMinutes: overtimeMins,
        attendanceStatus: 'COMPLETED',
        updatedAt: now.toISOString(),
      };

      const docRef = doc(db, 'attendance', openRecord.id);
      await setDoc(docRef, sanitizeFirestoreData(updatedRecord));

      await recordPunchLog({
        employeeId: employee.employeeId,
        employeeName: employee.employeeName,
        timestamp: now.toISOString(),
        action: 'PUNCH_OUT',
        rawPayload,
        scannerDevice,
        message: `Punch Out recorded. Duty: ${formatMinutes(regularDutyMins)}, OT: ${formatMinutes(overtimeMins)}`,
      });

      await recordAuditLog({
        action: 'ATTENDANCE_PUNCH_OUT',
        employeeId: employee.employeeId,
        newValue: `Out: ${timeDisplay}, Duty: ${formatMinutes(regularDutyMins)}, OT: ${formatMinutes(overtimeMins)}`,
        actionSource: scannerDevice,
      });

      return {
        success: true,
        action: 'PUNCH_OUT',
        message: 'Attendance Punch Out Successfully Recorded.',
        employee,
        attendance: updatedRecord,
        shift: openShift,
        time: timeDisplay,
        dutyFormatted: formatMinutes(regularDutyMins),
        otFormatted: formatMinutes(overtimeMins),
      };
    }
  }

  // 6. NO OPEN RECORD -> THIS IS A NEW PUNCH IN!
  // Automatically identify shift based on server-validated Punch In timestamp
  const shiftMatch = identifyShiftForPunchIn(shifts, now);
  if (!shiftMatch) {
    await recordPunchLog({
      employeeId: employee.employeeId,
      employeeName: employee.employeeName,
      timestamp: now.toISOString(),
      action: 'REJECTED_SHIFT',
      rawPayload,
      scannerDevice,
      message: 'No shift window matched the punch-in time.',
    });
    return {
      success: false,
      action: 'REJECTED',
      employee,
      message: 'No Valid Shift Found For This Punch-In Time.',
      time: timeDisplay,
    };
  }

  const { shift, shiftDate } = shiftMatch;
  const attendanceId = `att_${employee.employeeId}_${shiftDate}_${shift.id}`;

  // Check if attendance already completed for this cycle (Duplicate Protection)
  const existingDoc = await getDoc(doc(db, 'attendance', attendanceId));
  if (existingDoc.exists()) {
    const existingData = existingDoc.data() as AttendanceRecord;

    if (existingData.punchOutType === 'AUTO') {
      return {
        success: false,
        action: 'REJECTED',
        employee,
        attendance: existingData,
        shift,
        message: `Attendance Auto-Closed At Scheduled Shift End (${shift.endTime}). Contact Supervisor.`,
        time: timeDisplay,
      };
    }

    if (existingData.actualPunchOut || existingData.punchOutType === 'ACTUAL') {
      await recordPunchLog({
        employeeId: employee.employeeId,
        employeeName: employee.employeeName,
        timestamp: now.toISOString(),
        action: 'REJECTED_DUPLICATE',
        rawPayload,
        scannerDevice,
        message: `Duplicate scan: Both Punch In and Punch Out already recorded for ${shift.name}.`,
      });
      return {
        success: false,
        action: 'REJECTED',
        employee,
        attendance: existingData,
        shift,
        message: `Attendance Already Completed for ${shift.name} (${shiftDate}). Duplicate Scan Not Allowed.`,
        time: timeDisplay,
      };
    }

    if (existingData.punchOutType === 'NONE') {
      return {
        success: false,
        action: 'REJECTED_DUPLICATE',
        employee,
        attendance: existingData,
        shift,
        message: `Already Punched In at ${formatTimeDisplay(existingData.punchIn)}.`,
        time: timeDisplay,
      };
    }
  }

  // Calculate Late Arrival based on shift start + grace period
  const shiftStartMins = timeStringToMinutes(shift.startTime);
  const currentMins = kolkata.totalMinutes;
  const grace = shift.gracePeriodMinutes ?? settings.lateGraceMinutes ?? 15;

  let isLate = false;
  if (!shift.isOvernight) {
    // Day Shift: start 09:00 (540). Late if > 09:15 (555)
    isLate = currentMins > (shiftStartMins + grace);
  } else {
    // Night Shift: start 20:00 (1200).
    // If punched in between 20:00 and 23:59:
    if (currentMins >= 1200) {
      isLate = currentMins > (shiftStartMins + grace);
    } else {
      // Punched in after midnight (00:00 - 08:59): definitively late for the overnight shift
      isLate = true;
    }
  }

  const initialStatus: AttendanceStatus = isLate ? 'LATE' : 'PRESENT';

  const newAttendanceRecord: AttendanceRecord = {
    id: attendanceId,
    employeeId: employee.employeeId,
    employeeNameSnapshot: employee.employeeName,
    employeeTypeSnapshot: employee.employeeType,
    floorIdSnapshot: employee.floor,
    sectionIdSnapshot: employee.section,
    departmentIdSnapshot: employee.department,
    shiftId: shift.id,
    shiftNameSnapshot: shift.name,
    shiftDate: shiftDate,
    punchIn: now.toISOString(),
    scheduledPunchOut: shift.endTime,
    actualPunchOut: null,
    effectivePunchOut: null,
    punchOutType: 'NONE',
    regularDutyMinutes: 0,
    overtimeMinutes: 0,
    attendanceStatus: initialStatus,
    qrTokenReference: employee.qrCodeToken,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  try {
    await setDoc(doc(db, 'attendance', attendanceId), sanitizeFirestoreData(newAttendanceRecord));

    await recordPunchLog({
      employeeId: employee.employeeId,
      employeeName: employee.employeeName,
      timestamp: now.toISOString(),
      action: 'PUNCH_IN',
      rawPayload,
      scannerDevice,
      message: `Punch In recorded for ${shift.name} (${shiftDate}). Status: ${initialStatus}`,
    });

    await recordAuditLog({
      action: 'ATTENDANCE_PUNCH_IN',
      employeeId: employee.employeeId,
      newValue: `In: ${timeDisplay}, Shift: ${shift.name}, Status: ${initialStatus}`,
      actionSource: scannerDevice,
    });

    return {
      success: true,
      action: 'PUNCH_IN',
      message: isLate ? `Punch In Recorded for ${shift.name} (Marked LATE).` : `Punch In Recorded for ${shift.name}.`,
      employee,
      attendance: newAttendanceRecord,
      shift,
      time: timeDisplay,
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `attendance/${attendanceId}`);
    throw error;
  }
}

/**
 * AUTOMATIC SHIFT CLOSING ENGINE
 * Checks open attendance records past scheduled shift end and automatically closes them:
 * - actualPunchOut = null
 * - effectivePunchOut = scheduledEndIso (+05:30)
 * - punchOutType = 'AUTO'
 * - overtimeMinutes = 0 (STRICTLY ZERO OT for auto-closed records)
 * - regularDutyMinutes = scheduledDuration
 */
export async function runAutoCloseShiftsEngine(): Promise<{ closedCount: number; closedRecords: AttendanceRecord[] }> {
  try {
    const now = new Date();
    const settings = await getSystemSettings();
    if (!settings.autoPunchOutEnabled) {
      return { closedCount: 0, closedRecords: [] };
    }

    const shifts = await getShifts();
    const shiftsMap = new Map(shifts.map(s => [s.id, s]));

    // Query open attendance records
    const q = query(
      collection(db, 'attendance'),
      where('punchOutType', '==', 'NONE')
    );
    const snap = await getDocs(q);
    const openRecords = snap.docs.map(d => d.data() as AttendanceRecord);

    const closedRecords: AttendanceRecord[] = [];

    for (const record of openRecords) {
      if (record.actualPunchOut || record.punchOutType !== 'NONE') continue;

      const shift = shiftsMap.get(record.shiftId);
      if (!shift) continue;

      // Determine shift scheduled end timestamp in Kolkata timezone
      const scheduledEndIso = getShiftScheduledEndIso(record.shiftDate, shift);
      const scheduledEndDate = new Date(scheduledEndIso);

      // Check if current time is past scheduled shift end
      if (now.getTime() > scheduledEndDate.getTime()) {
        const scheduledDuration = shift.scheduledDurationMinutes || settings.scheduledDurationMinutes || 510;

        const updatedRecord: AttendanceRecord = {
          ...record,
          actualPunchOut: null, // Left null so reports distinguish Actual vs Auto
          effectivePunchOut: scheduledEndIso,
          punchOutType: 'AUTO',
          attendanceStatus: 'MISSED PUNCH OUT',
          regularDutyMinutes: scheduledDuration, // Scheduled duty
          overtimeMinutes: 0, // NEVER add overtime to auto-closed attendance!
          updatedAt: now.toISOString(),
        };

        await setDoc(doc(db, 'attendance', record.id), sanitizeFirestoreData(updatedRecord));

        await recordPunchLog({
          employeeId: record.employeeId,
          employeeName: record.employeeNameSnapshot,
          timestamp: now.toISOString(),
          action: 'AUTO_CLOSE',
          rawPayload: 'SYSTEM_CRON',
          scannerDevice: 'SYSTEM_AUTO',
          message: `Auto-closed at scheduled shift end (${shift.endTime}). Status: MISSED PUNCH OUT. OT: 00:00.`,
        });

        await recordAuditLog({
          action: 'AUTOMATIC_PUNCH_OUT',
          employeeId: record.employeeId,
          newValue: `Auto-closed at ${scheduledEndIso}, Duty: ${formatMinutes(scheduledDuration)}, OT: 00:00`,
          actionSource: 'SYSTEM_SCHEDULER',
          reason: 'Employee missed scanning Punch Out at scheduled shift closing',
        });

        closedRecords.push(updatedRecord);
      }
    }

    return { closedCount: closedRecords.length, closedRecords };
  } catch (error) {
    console.error('Error during auto shift closing execution:', error);
    return { closedCount: 0, closedRecords: [] };
  }
}

// Manual Admin Attendance Correction
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
  const docRef = doc(db, 'attendance', attendanceId);
  const snap = await getDoc(docRef);
  if (!snap.exists()) {
    throw new Error('Attendance record not found.');
  }
  const current = snap.data() as AttendanceRecord;

  let regularDutyMinutes = current.regularDutyMinutes;
  let overtimeMinutes = current.overtimeMinutes;

  if (updates.actualPunchOut) {
    const inTime = new Date(current.punchIn).getTime();
    const outTime = new Date(updates.actualPunchOut).getTime();
    const totalMins = Math.max(0, Math.floor((outTime - inTime) / (60 * 1000)));
    regularDutyMinutes = Math.min(totalMins, 510);
    overtimeMinutes = Math.max(0, totalMins - 510);
  }

  const updated: Partial<AttendanceRecord> = {
    actualPunchOut: updates.actualPunchOut || current.actualPunchOut,
    effectivePunchOut: updates.actualPunchOut || current.effectivePunchOut,
    punchOutType: updates.punchOutType,
    attendanceStatus: updates.attendanceStatus,
    regularDutyMinutes,
    overtimeMinutes,
    correctionReason: updates.reason,
    correctedBy: updates.adminName,
    updatedAt: new Date().toISOString(),
  };

  await updateDoc(docRef, sanitizeFirestoreData(updated));

  await recordAuditLog({
    action: 'CORRECT_ATTENDANCE',
    employeeId: current.employeeId,
    oldValue: `Status: ${current.attendanceStatus}, Out: ${current.actualPunchOut || 'None'}`,
    newValue: `Status: ${updates.attendanceStatus}, Out: ${updates.actualPunchOut || 'None'}`,
    actionSource: 'ADMIN_CORRECTION',
    reason: updates.reason,
  });
}

// Daily Shift Roster Functions (Retained for optional planned leave scheduling)
export async function getShiftRoster(shiftDate: string, shiftId: string): Promise<ShiftRoster[]> {
  try {
    const q = query(
      collection(db, 'shift_rosters'),
      where('shiftDate', '==', shiftDate),
      where('shiftId', '==', shiftId)
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => d.data() as ShiftRoster);
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'shift_rosters');
    return [];
  }
}

// Generate or update shift roster from active employees (if needed for planned leaves)
export async function generateRosterForDate(
  shiftDate: string, 
  shiftId: string, 
  employees: Employee[]
): Promise<{ scheduledCount: number }> {
  let count = 0;
  const now = new Date().toISOString();

  for (const emp of employees) {
    if (emp.employeeStatus !== 'Active') continue;
    const rosterId = `roster_${shiftDate}_${shiftId}_${emp.employeeId}`;
    const rosterRecord: ShiftRoster = {
      id: rosterId,
      shiftDate,
      shiftId,
      employeeId: emp.employeeId,
      rosterStatus: 'SCHEDULED',
      updatedAt: now,
    };
    await setDoc(doc(db, 'shift_rosters', rosterId), sanitizeFirestoreData(rosterRecord));
    count++;
  }

  await recordAuditLog({
    action: 'GENERATE_ROSTER',
    newValue: `Generated roster of ${count} employees for ${shiftDate} (${shiftId})`,
    actionSource: 'ROSTER_MANAGEMENT',
  });

  return { scheduledCount: count };
}
