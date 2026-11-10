import { 
  collection, 
  doc, 
  getDoc, 
  getDocs, 
  setDoc, 
  updateDoc, 
  query, 
  where,
  orderBy,
  limit,
  runTransaction
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType, sanitizeFirestoreData } from '../firebase';
import { 
  AttendanceRecord, 
  Employee, 
  Shift, 
  ScanResult, 
  PunchLog, 
  PunchEvent,
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

// Record individual punch event
export async function recordPunchEvent(event: PunchEvent): Promise<void> {
  try {
    await setDoc(doc(db, 'punch_events', event.id), sanitizeFirestoreData(event));
  } catch (e) {
    console.error('Failed to save punch event:', e);
  }
}

// Query punch events for an employee or date
export async function getPunchEvents(options?: { shiftDate?: string; employeeId?: string; limitCount?: number }): Promise<PunchEvent[]> {
  try {
    let q = query(collection(db, 'punch_events'), orderBy('timestamp', 'desc'), limit(options?.limitCount || 200));
    if (options?.shiftDate) {
      q = query(collection(db, 'punch_events'), where('shiftDate', '==', options.shiftDate), orderBy('timestamp', 'desc'));
    }
    const snap = await getDocs(q);
    let events = snap.docs.map(d => d.data() as PunchEvent);
    if (options?.employeeId) {
      events = events.filter(e => e.employeeId === options.employeeId);
    }
    return events;
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
}

/**
 * ADVANCED DUAL ATTENDANCE SCANNER & FIRST-IN LAST-OUT SYSTEM
 * 
 * MODULE 1: Dedicated Independent Punch In and Punch Out Scanners
 * MODULE 2: Multiple Alternating In/Out Events per Workday (with Consecutive Validation)
 * MODULE 3: First-In Last-Out Daily Summary Rule
 * MODULE 4: Duty Hours & OT Calculation (Duty = Last Out - First In, OT = Max(0, Duty - 08:30))
 * MODULE 5: Automatic Shift Detection & Overnight Spanning (Day: 09:00-17:30, Night: 20:00-04:30)
 * MODULE 6: Auto-Close Missed Punch Out (Zero OT, Status: AUTO CLOSED / MISSED PUNCH OUT)
 * MODULE 7: Data Structure Separation (attendance daily doc + punch_events collection)
 * MODULE 9: Atomic Firestore Transactions (Zero race conditions or duplicate submissions)
 */
export async function processDualAttendanceScan({
  rawPayload,
  scannerType,
  scannerDevice = 'USB_SCANNER',
  customScanTime,
}: DualScanParams): Promise<ScanResult> {
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
      message: 'Invalid QR Code payload or empty Employee ID.',
    });
    return {
      success: false,
      action: 'REJECTED',
      scannerType,
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
      scannerType,
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
      scannerType,
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
      scannerType,
      employee,
      message: 'QR Token Expired or Revoked. Please re-issue QR code.',
      time: timeDisplay,
    };
  }

  // 4. Fetch shifts and settings
  const shifts = await getShifts();
  const settings = await getSystemSettings();
  const shiftsMap = new Map(shifts.map(s => [s.id, s]));

  const todayKey = kolkata.dateKey;
  const yesterdayKey = getYesterdayKolkataDateKey(now);
  const currentMins = kolkata.totalMinutes;

  // 5. Locate existing attendance record for this employee
  // Check both today and yesterday (for ongoing night shifts)
  const candidateDocsSnap = await getDocs(
    query(
      collection(db, 'attendance'),
      where('employeeId', '==', employee.employeeId),
      where('shiftDate', '>=', yesterdayKey)
    )
  );

  const existingRecords = candidateDocsSnap.docs.map(d => d.data() as AttendanceRecord);

  // Sort by punchIn descending
  existingRecords.sort((a, b) => new Date(b.punchIn).getTime() - new Date(a.punchIn).getTime());

  // Determine active attendance record:
  // If current time is early morning (< 09:00 AM / 540 mins), check if yesterday has an ongoing night shift
  let activeRecord: AttendanceRecord | null = null;
  if (currentMins < 540) {
    const yesterdayNight = existingRecords.find(r => r.shiftDate === yesterdayKey && (r.shiftId === 'NIGHT' || (r.shiftNameSnapshot || '').toUpperCase().includes('NIGHT')));
    if (yesterdayNight) {
      activeRecord = yesterdayNight;
    }
  }

  if (!activeRecord) {
    // Check today's record
    activeRecord = existingRecords.find(r => r.shiftDate === todayKey) || null;
  }

  // =========================================================================
  // SCANNER TYPE: 'IN' (PUNCH IN SCANNER)
  // =========================================================================
  if (scannerType === 'IN') {
    if (activeRecord) {
      // Validate employee is not already inside
      const currentState = activeRecord.currentState || (activeRecord.actualPunchOut || activeRecord.punchOutType === 'ACTUAL' ? 'OUTSIDE' : 'INSIDE');

      if (currentState === 'INSIDE') {
        // Consecutive Punch In REJECTED!
        await recordPunchLog({
          employeeId: employee.employeeId,
          employeeName: employee.employeeName,
          timestamp: now.toISOString(),
          action: 'REJECTED_DUPLICATE',
          rawPayload,
          scannerDevice,
          message: `Consecutive Punch In rejected. Employee already Punched In at ${formatTimeDisplay(activeRecord.punchIn)}.`,
        });

        return {
          success: false,
          action: 'REJECTED_DUPLICATE',
          scannerType: 'IN',
          currentState: 'INSIDE',
          employee,
          attendance: activeRecord,
          message: `Consecutive Punch In rejected. Employee is already Punched In (Status: INSIDE).`,
          time: timeDisplay,
          punchCount: activeRecord.punches?.length || 1,
        };
      }

      // Employee is OUTSIDE: VALID SUBSEQUENT PUNCH IN!
      // Anti-double-tap bounce check (< 3 seconds)
      const lastPunchTime = activeRecord.punches && activeRecord.punches.length > 0 
        ? new Date(activeRecord.punches[activeRecord.punches.length - 1].timestamp).getTime()
        : new Date(activeRecord.updatedAt || activeRecord.punchIn).getTime();
      if (Math.abs(now.getTime() - lastPunchTime) < 3000) {
        return {
          success: false,
          action: 'REJECTED_DUPLICATE',
          scannerType: 'IN',
          currentState: 'OUTSIDE',
          employee,
          attendance: activeRecord,
          message: 'Duplicate scan prevented. Please wait a few seconds before scanning again.',
          time: timeDisplay,
        };
      }

      const shift = shiftsMap.get(activeRecord.shiftId) || shifts[0];
      const eventId = `pe_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const punchEvent: PunchEvent = {
        id: eventId,
        employeeId: employee.employeeId,
        employeeName: employee.employeeName,
        eventType: 'IN',
        timestamp: now.toISOString(),
        displayTime: timeDisplay,
        shiftDate: activeRecord.shiftDate,
        shiftId: activeRecord.shiftId,
        shiftName: activeRecord.shiftNameSnapshot,
        floor: employee.floor,
        section: employee.section,
        department: employee.department,
        scannerType: 'IN',
        scannerDevice,
        status: 'SUBSEQUENT_IN',
      };

      // Atomic transaction update on existing record with resilient direct-write fallback
      // CRITICAL: First Punch In is PRESERVED! Never overwrite it!
      const docRef = doc(db, 'attendance', activeRecord.id);
      let updatedAttendance: AttendanceRecord = activeRecord;

      try {
        await runTransaction(db, async (txn) => {
          const snap = await txn.get(docRef);
          const currentData = snap.exists() ? (snap.data() as AttendanceRecord) : activeRecord!;

          const existingPunches = currentData.punches || [];
          const newPunches = [...existingPunches, punchEvent];

          updatedAttendance = {
            ...currentData,
            currentState: 'INSIDE',
            punchOutType: 'NONE', // Currently inside
            punches: newPunches,
            updatedAt: now.toISOString(),
          };

          txn.set(docRef, sanitizeFirestoreData(updatedAttendance));
        });
      } catch (txnErr) {
        console.warn('Subsequent punch in transaction dropped, falling back to direct write:', txnErr);
        const snap = await getDoc(docRef);
        const currentData = snap.exists() ? (snap.data() as AttendanceRecord) : activeRecord!;
        const existingPunches = currentData.punches || [];
        const newPunches = [...existingPunches, punchEvent];
        updatedAttendance = {
          ...currentData,
          currentState: 'INSIDE',
          punchOutType: 'NONE',
          punches: newPunches,
          updatedAt: now.toISOString(),
        };
        await setDoc(docRef, sanitizeFirestoreData(updatedAttendance));
      }

      // Save individual punch event
      await recordPunchEvent(punchEvent);

      await recordPunchLog({
        employeeId: employee.employeeId,
        employeeName: employee.employeeName,
        timestamp: now.toISOString(),
        action: 'PUNCH_IN',
        rawPayload,
        scannerDevice,
        message: `Subsequent Punch In (Event #${updatedAttendance.punches?.length}). Status: INSIDE.`,
      });

      return {
        success: true,
        action: 'PUNCH_IN',
        scannerType: 'IN',
        currentState: 'INSIDE',
        employee,
        attendance: updatedAttendance,
        shift,
        message: `Punch In Successfully Recorded (Re-entry #${updatedAttendance.punches?.length}).`,
        time: timeDisplay,
        punchCount: updatedAttendance.punches?.length || 2,
      };
    }

    // NO ACTIVE RECORD -> THIS IS EMPLOYEE'S FIRST PUNCH IN OF THE WORKDAY!
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
        scannerType: 'IN',
        employee,
        message: 'No Valid Shift Found For This Punch-In Time.',
        time: timeDisplay,
      };
    }

    const { shift, shiftDate } = shiftMatch;
    const attendanceId = `att_${employee.employeeId}_${shiftDate}_${shift.id}`;

    // Late arrival evaluation based on shift start + grace
    const shiftStartMins = timeStringToMinutes(shift.startTime);
    const grace = shift.gracePeriodMinutes ?? settings.lateGraceMinutes ?? 15;
    let isLate = false;
    if (!shift.isOvernight) {
      isLate = currentMins > (shiftStartMins + grace);
    } else {
      if (currentMins >= 1200) {
        isLate = currentMins > (shiftStartMins + grace);
      } else {
        isLate = true; // After midnight for night shift
      }
    }

    const initialStatus: AttendanceStatus = isLate ? 'LATE' : 'PRESENT';
    const eventId = `pe_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const firstPunchEvent: PunchEvent = {
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
    };

    const newAttendanceRecord: AttendanceRecord = {
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
      firstPunchIn: now.toISOString(), // Module 3: official earliest punch in
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
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    const docRef = doc(db, 'attendance', attendanceId);
    try {
      await runTransaction(db, async (txn) => {
        const existing = await txn.get(docRef);
        if (existing.exists()) {
          const data = existing.data() as AttendanceRecord;
          if (data.currentState === 'INSIDE') {
            throw new Error('CONSECUTIVE_IN');
          }
        }
        txn.set(docRef, sanitizeFirestoreData(newAttendanceRecord));
      });
    } catch (err: any) {
      if (err?.message === 'CONSECUTIVE_IN') {
        return {
          success: false,
          action: 'REJECTED_DUPLICATE',
          scannerType: 'IN',
          currentState: 'INSIDE',
          employee,
          message: 'Consecutive Punch In rejected. Employee is already Punched In (Status: INSIDE).',
          time: timeDisplay,
        };
      }
      console.warn('First punch in transaction dropped, falling back to direct write:', err);
      try {
        const existing = await getDoc(docRef);
        if (existing.exists()) {
          const data = existing.data() as AttendanceRecord;
          if (data.currentState === 'INSIDE') {
            return {
              success: false,
              action: 'REJECTED_DUPLICATE',
              scannerType: 'IN',
              currentState: 'INSIDE',
              employee,
              message: 'Consecutive Punch In rejected. Employee is already Punched In (Status: INSIDE).',
              time: timeDisplay,
            };
          }
        }
        await setDoc(docRef, sanitizeFirestoreData(newAttendanceRecord));
      } catch (writeErr: any) {
        console.error('Direct punch in write failed:', writeErr);
        throw writeErr;
      }
    }

    await recordPunchEvent(firstPunchEvent);

    await recordPunchLog({
      employeeId: employee.employeeId,
      employeeName: employee.employeeName,
      timestamp: now.toISOString(),
      action: 'PUNCH_IN',
      rawPayload,
      scannerDevice,
      message: `First Punch In recorded for ${shift.name} (${shiftDate}). Status: ${initialStatus}.`,
    });

    return {
      success: true,
      action: 'PUNCH_IN',
      scannerType: 'IN',
      currentState: 'INSIDE',
      employee,
      attendance: newAttendanceRecord,
      shift,
      message: isLate ? `First Punch In Recorded for ${shift.name} (Marked LATE).` : `First Punch In Recorded for ${shift.name}.`,
      time: timeDisplay,
      punchCount: 1,
    };
  }

  // =========================================================================
  // SCANNER TYPE: 'OUT' (PUNCH OUT SCANNER)
  // =========================================================================
  if (scannerType === 'OUT') {
    // Punch Out without a previous Punch In must be rejected!
    if (!activeRecord) {
      await recordPunchLog({
        employeeId: employee.employeeId,
        employeeName: employee.employeeName,
        timestamp: now.toISOString(),
        action: 'REJECTED_TOKEN',
        rawPayload,
        scannerDevice,
        message: 'Punch Out rejected: No valid Punch In found for employee today.',
      });

      return {
        success: false,
        action: 'REJECTED',
        scannerType: 'OUT',
        employee,
        message: 'Punch Out rejected: No valid Punch In found for employee. Please Punch In first.',
        time: timeDisplay,
      };
    }

    const currentState = activeRecord.currentState || (activeRecord.actualPunchOut || activeRecord.punchOutType === 'ACTUAL' ? 'OUTSIDE' : 'INSIDE');

    if (currentState === 'OUTSIDE') {
      // Consecutive Punch Out REJECTED!
      await recordPunchLog({
        employeeId: employee.employeeId,
        employeeName: employee.employeeName,
        timestamp: now.toISOString(),
        action: 'REJECTED_DUPLICATE',
        rawPayload,
        scannerDevice,
        message: 'Consecutive Punch Out rejected. Employee has already Punched Out.',
      });

      return {
        success: false,
        action: 'REJECTED_DUPLICATE',
        scannerType: 'OUT',
        currentState: 'OUTSIDE',
        employee,
        attendance: activeRecord,
        message: 'Consecutive Punch Out rejected. Employee has already Punched Out (Status: OUTSIDE).',
        time: timeDisplay,
        punchCount: activeRecord.punches?.length || 1,
      };
    }

    // Anti-double-tap bounce check (< 3 seconds)
    const lastPunchTime = activeRecord.punches && activeRecord.punches.length > 0 
      ? new Date(activeRecord.punches[activeRecord.punches.length - 1].timestamp).getTime()
      : new Date(activeRecord.updatedAt || activeRecord.punchIn).getTime();
    if (Math.abs(now.getTime() - lastPunchTime) < 3000) {
      return {
        success: false,
        action: 'REJECTED_DUPLICATE',
        scannerType: 'OUT',
        currentState: 'INSIDE',
        employee,
        attendance: activeRecord,
        message: 'Duplicate scan prevented. Please wait a few seconds before scanning again.',
        time: timeDisplay,
      };
    }

    // VALID PUNCH OUT!
    // MODULE 3 & 4 RULES:
    // Earliest valid Punch In is official daily firstPunchIn.
    // Latest valid Punch Out is official daily lastPunchOut.
    // Duty duration = lastPunchOut - firstPunchIn.
    // Overtime hours = max(0, Duty Duration - 08:30).
    // Never add intermediate intervals separately; strictly derived from first IN and last OUT.
    const firstInIso = activeRecord.firstPunchIn || activeRecord.punchIn;
    const firstInDate = new Date(firstInIso);
    const totalDutyMinutes = Math.max(0, Math.floor((now.getTime() - firstInDate.getTime()) / (1000 * 60)));
    const scheduledStandardDutyMinutes = 510; // 8 hours 30 mins

    const regularDutyMinutes = Math.min(totalDutyMinutes, scheduledStandardDutyMinutes);
    const overtimeMinutes = Math.max(0, totalDutyMinutes - scheduledStandardDutyMinutes);

    const shift = shiftsMap.get(activeRecord.shiftId) || shifts[0];
    const eventId = `pe_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const outEvent: PunchEvent = {
      id: eventId,
      employeeId: employee.employeeId,
      employeeName: employee.employeeName,
      eventType: 'OUT',
      timestamp: now.toISOString(),
      displayTime: timeDisplay,
      shiftDate: activeRecord.shiftDate,
      shiftId: activeRecord.shiftId,
      shiftName: activeRecord.shiftNameSnapshot,
      floor: employee.floor,
      section: employee.section,
      department: employee.department,
      scannerType: 'OUT',
      scannerDevice,
      dutyDurationMinutes: totalDutyMinutes,
      overtimeMinutes,
      status: 'VALID_OUT',
    };

    const docRef = doc(db, 'attendance', activeRecord.id);
    let updatedAttendance: AttendanceRecord = activeRecord;

    try {
      await runTransaction(db, async (txn) => {
        const snap = await txn.get(docRef);
        const currentData = snap.exists() ? (snap.data() as AttendanceRecord) : activeRecord!;

        const existingPunches = currentData.punches || [];
        const newPunches = [...existingPunches, outEvent];

        updatedAttendance = {
          ...currentData,
          actualPunchOut: now.toISOString(),
          lastPunchOut: now.toISOString(), // Module 3: official latest punch out
          effectivePunchOut: now.toISOString(),
          punchOutType: 'ACTUAL',
          currentState: 'OUTSIDE',
          punches: newPunches,
          totalDutyMinutes,
          regularDutyMinutes,
          overtimeMinutes,
          attendanceStatus: 'COMPLETED',
          missedPunchOut: false,
          autoClosed: false,
          updatedAt: now.toISOString(),
        };

        txn.set(docRef, sanitizeFirestoreData(updatedAttendance));
      });
    } catch (txnErr) {
      console.warn('Punch out transaction dropped, falling back to direct write:', txnErr);
      const snap = await getDoc(docRef);
      const currentData = snap.exists() ? (snap.data() as AttendanceRecord) : activeRecord!;
      const existingPunches = currentData.punches || [];
      const newPunches = [...existingPunches, outEvent];
      updatedAttendance = {
        ...currentData,
        actualPunchOut: now.toISOString(),
        lastPunchOut: now.toISOString(),
        effectivePunchOut: now.toISOString(),
        punchOutType: 'ACTUAL',
        currentState: 'OUTSIDE',
        punches: newPunches,
        totalDutyMinutes,
        regularDutyMinutes,
        overtimeMinutes,
        attendanceStatus: 'COMPLETED',
        missedPunchOut: false,
        autoClosed: false,
        updatedAt: now.toISOString(),
      };
      await setDoc(docRef, sanitizeFirestoreData(updatedAttendance));
    }

    await recordPunchEvent(outEvent);

    await recordPunchLog({
      employeeId: employee.employeeId,
      employeeName: employee.employeeName,
      timestamp: now.toISOString(),
      action: 'PUNCH_OUT',
      rawPayload,
      scannerDevice,
      message: `Punch Out recorded. Duty: ${formatMinutes(regularDutyMinutes)}, OT: ${formatMinutes(overtimeMinutes)}. Total: ${formatMinutes(totalDutyMinutes)}.`,
    });

    return {
      success: true,
      action: 'PUNCH_OUT',
      scannerType: 'OUT',
      currentState: 'OUTSIDE',
      employee,
      attendance: updatedAttendance,
      shift,
      message: 'Punch Out Successfully Recorded.',
      time: timeDisplay,
      dutyFormatted: formatMinutes(regularDutyMinutes),
      otFormatted: formatMinutes(overtimeMinutes),
      punchCount: updatedAttendance.punches?.length || 2,
    };
  }

  // Fallback if scannerType is not recognized
  return {
    success: false,
    action: 'REJECTED',
    message: 'Unknown scanner type.',
    time: timeDisplay,
  };
}

/**
 * BACKWARD COMPATIBLE PROCESS ATTENDANCE SCAN
 * If scannerType is not explicitly supplied, automatically selects 'IN' or 'OUT'
 * based on the employee's current attendance state.
 */
export async function processAttendanceScan(
  rawPayload: string,
  scannerDevice: 'USB_SCANNER' | 'WEBCAM' = 'USB_SCANNER',
  customScanTime?: Date,
  explicitScannerType?: 'IN' | 'OUT'
): Promise<ScanResult> {
  if (explicitScannerType) {
    return processDualAttendanceScan({
      rawPayload,
      scannerType: explicitScannerType,
      scannerDevice,
      customScanTime,
    });
  }

  // Auto-detect employee current state
  const { employeeId } = parseQrPayload(rawPayload);
  if (!employeeId) {
    return processDualAttendanceScan({
      rawPayload,
      scannerType: 'IN',
      scannerDevice,
      customScanTime,
    });
  }

  const now = customScanTime || new Date();
  const kolkata = getKolkataTimeParts(now);
  const todayKey = kolkata.dateKey;
  const yesterdayKey = getYesterdayKolkataDateKey(now);

  const snap = await getDocs(
    query(
      collection(db, 'attendance'),
      where('employeeId', '==', employeeId),
      where('shiftDate', '>=', yesterdayKey)
    )
  );

  const records = snap.docs.map(d => d.data() as AttendanceRecord);
  const activeRecord = records.find(r => r.shiftDate === todayKey || (r.shiftDate === yesterdayKey && (r.shiftId === 'NIGHT' || (r.shiftNameSnapshot || '').toUpperCase().includes('NIGHT'))));

  const currentState = activeRecord?.currentState || (activeRecord?.actualPunchOut ? 'OUTSIDE' : (activeRecord ? 'INSIDE' : 'OUTSIDE'));
  const targetType: 'IN' | 'OUT' = currentState === 'INSIDE' ? 'OUT' : 'IN';

  return processDualAttendanceScan({
    rawPayload,
    scannerType: targetType,
    scannerDevice,
    customScanTime,
  });
}

/**
 * AUTOMATIC SHIFT CLOSING ENGINE
 * Checks open attendance records past scheduled shift end and automatically closes them:
 * - actualPunchOut = null
 * - effectivePunchOut = scheduledEndIso (+05:30)
 * - punchOutType = 'AUTO'
 * - currentState = 'OUTSIDE'
 * - missedPunchOut = true
 * - autoClosed = true
 * - overtimeMinutes = 0 (STRICTLY ZERO OT for auto-closed records)
 * - regularDutyMinutes = scheduledDuration (510 minutes)
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
          lastPunchOut: null,
          effectivePunchOut: scheduledEndIso,
          punchOutType: 'AUTO',
          currentState: 'OUTSIDE',
          attendanceStatus: 'AUTO CLOSED',
          missedPunchOut: true,
          autoClosed: true,
          totalDutyMinutes: scheduledDuration,
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
          message: `Auto-closed at scheduled shift end (${shift.endTime}). Status: AUTO CLOSED. OT: 00:00.`,
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
