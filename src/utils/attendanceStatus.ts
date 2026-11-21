export const STANDARD_DUTY_MINUTES = 510; // 08 hours 30 minutes
export const MAX_REGULAR_DUTY_MINUTES = 510; // 08 hours 30 minutes
export const MAX_TOTAL_OT_MINUTES = 210; // 03 hours 30 minutes
export const MAX_CREDITED_TOTAL_MINUTES = 720; // 12 hours 00 minutes
export const HALF_DAY_MIN_MINUTES = 270; // 04 hours 30 minutes
export const EARLY_OT_THRESHOLD_MINUTES = 60; // Option A: >= 60 mins early grants entire early duration as Early OT
export const EARLY_PUNCH_POLICY_ID = 'OPTION_A_60M' as const;

export type DutyClassifiedStatus =
  | 'SHORT LEAVE'
  | 'HALF DAY'
  | 'COMPLETED'
  | 'COMPLETED + OT';

export interface PunchOutScheduleMetrics {
  scheduledShiftEndIso: string;
  scheduledShiftEndDisplay: string;
  regularDutyCompletionIso: string;
  regularDutyCompletionDisplay: string;
  maxEligiblePunchOutIso: string;
  maxEligiblePunchOutDisplay: string;
  maxRegularDutyMinutes: number;
  maxOtMinutes: number;
  maxCreditedWorkingMinutes: number;
  maxOtDisplay: string;
  maxCreditedWorkingDisplay: string;
  eligibleEarlyOtMinutes: number;
  remainingPostShiftOtMinutes: number;
}

export interface ResolvedAttendanceMetrics {
  status: string;
  state: 'INSIDE' | 'OUTSIDE';
  isOpen: boolean;
  isLate: boolean;
  completedDutyMinutes: number;
  regularDutyMinutes: number;
  overtimeMinutes: number;
  accumulatedDutyMinutes: number;
  otLabel: string;
  scheduledPunchIn: string;
  scheduledStartDisplay: string;
  scheduledPunchOut: string;
  scheduledEndDisplay: string;
  earlyArrivalMinutes: number;
  provisionalEarlyOtMinutes: number;
  earlyOtMinutes: number;
  postShiftOtMinutes: number;
  totalOtMinutes: number;
  earlyOtFinalized: boolean;
  isEarlyPunch: boolean;
  otCapApplied: boolean;
  reconciledFromAutoClose: boolean;
  punchOutSchedule: PunchOutScheduleMetrics | null;
}

const KOLKATA_TIME_12H_FORMATTER = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
});

const NON_WORKING_STATUSES = new Set([
  'ABSENT',
  'LEAVE',
  'ON LEAVE',
  'WEEKLY_OFF',
  'WEEKLY OFF',
  'HOLIDAY',
]);

/**
 * Classifies closed-shift completed working minutes according to NARID duty rules:
 * - < 270 mins (< 4h 30m): SHORT LEAVE
 * - == 270 mins (4h 30m): HALF DAY
 * - > 270 && < 510 mins: HALF DAY
 * - == 510 mins (8h 30m): COMPLETED
 * - > 510 mins: COMPLETED + OT
 */
export function classifyCompletedDutyStatus(
  completedDutyMinutes: number,
  standardDutyMinutes: number = STANDARD_DUTY_MINUTES
): DutyClassifiedStatus {
  const safeMinutes = Math.max(0, Math.floor(Number.isFinite(completedDutyMinutes) ? completedDutyMinutes : 0));
  const safeStandard = Math.max(
    1,
    Math.min(
      MAX_REGULAR_DUTY_MINUTES,
      Math.floor(Number.isFinite(standardDutyMinutes) ? standardDutyMinutes : STANDARD_DUTY_MINUTES)
    )
  );

  if (safeMinutes < HALF_DAY_MIN_MINUTES) {
    return 'SHORT LEAVE';
  }
  if (safeMinutes < safeStandard) {
    return 'HALF DAY';
  }
  if (safeMinutes === safeStandard) {
    return 'COMPLETED';
  }
  return 'COMPLETED + OT';
}

export function formatDurationClock(mins: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(mins) ? mins : 0));
  const h = Math.floor(safe / 60);
  const m = safe % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function formatOtBadge(overtimeMinutes: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(overtimeMinutes) ? overtimeMinutes : 0));
  if (safe <= 0) return '00:00';
  return `${formatDurationClock(safe)} OT`;
}

export function formatShiftTimeClock12h(timeStr: string | null | undefined): string {
  const clean = String(timeStr || '').trim();
  if (!clean || !clean.includes(':')) return '--:--';
  const [rawH, rawM] = clean.split(':').map((n) => parseInt(n, 10));
  if (!Number.isFinite(rawH) || !Number.isFinite(rawM)) return '--:--';
  const h24 = ((rawH % 24) + 24) % 24;
  const h12 = h24 % 12 || 12;
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  return `${String(h12).padStart(2, '0')}:${String(rawM).padStart(2, '0')} ${ampm}`;
}

export function formatIsoTimeKolkata12h(isoString: string | null | undefined): string {
  if (!isoString) return '--:--';
  const dt = new Date(isoString);
  if (Number.isNaN(dt.getTime())) return '--:--';
  return KOLKATA_TIME_12H_FORMATTER.format(dt).toUpperCase();
}

export function getNextCalendarDateKey(dateKey: string): string {
  const [y, m, d] = String(dateKey || '1970-01-01').split('-').map(Number);
  const dt = new Date(Date.UTC(y || 1970, (m || 1) - 1, d || 1));
  dt.setUTCDate(dt.getUTCDate() + 1);
  const nextY = dt.getUTCFullYear();
  const nextM = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const nextD = String(dt.getUTCDate()).padStart(2, '0');
  return `${nextY}-${nextM}-${nextD}`;
}

export function resolveScheduledShiftDefaults(recordOrShift: Record<string, any> | null | undefined): {
  startTime: string;
  endTime: string;
  isOvernight: boolean;
} {
  const shiftIdUpper = String(recordOrShift?.shiftId || recordOrShift?.id || '').toUpperCase();
  const shiftNameUpper = String(recordOrShift?.shiftNameSnapshot || recordOrShift?.name || '').toUpperCase();
  const inferredNight =
    recordOrShift?.isOvernight === true ||
    shiftIdUpper === 'NIGHT' ||
    shiftNameUpper.includes('NIGHT');

  const defaultStart = inferredNight ? '20:00' : '09:00';
  const defaultEnd = inferredNight ? '04:30' : '17:30';

  const startTime = String(recordOrShift?.scheduledPunchIn || recordOrShift?.startTime || defaultStart).trim() || defaultStart;
  const endTime = String(recordOrShift?.scheduledPunchOut || recordOrShift?.endTime || defaultEnd).trim() || defaultEnd;
  return {
    startTime,
    endTime,
    isOvernight: inferredNight,
  };
}

export function resolveShiftScheduleBounds(
  shiftDate: string,
  shiftOrRecord: {
    id?: string;
    shiftId?: string;
    name?: string;
    shiftNameSnapshot?: string;
    startTime?: string;
    scheduledPunchIn?: string;
    endTime?: string;
    scheduledPunchOut?: string;
    isOvernight?: boolean;
  }
): {
  startTime: string;
  endTime: string;
  isOvernight: boolean;
  scheduledStartIso: string;
  scheduledEndIso: string;
  scheduledStartMs: number;
  scheduledEndMs: number;
} {
  const { startTime, endTime, isOvernight } = resolveScheduledShiftDefaults(shiftOrRecord);
  const [sh, sm] = startTime.split(':').map((n) => parseInt(n, 10) || 0);
  const [eh, em] = endTime.split(':').map((n) => parseInt(n, 10) || 0);
  const endDateKey = isOvernight ? getNextCalendarDateKey(shiftDate) : shiftDate;

  const scheduledStartIso = `${shiftDate}T${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}:00+05:30`;
  const scheduledEndIso = `${endDateKey}T${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}:00+05:30`;

  return {
    startTime: `${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}`,
    endTime: `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`,
    isOvernight,
    scheduledStartIso,
    scheduledEndIso,
    scheduledStartMs: new Date(scheduledStartIso).getTime(),
    scheduledEndMs: new Date(scheduledEndIso).getTime(),
  };
}

/**
 * Computes expected Punch-Out timestamps in IST according to shift anchor,
 * Option A Early OT policy (>= 60m), 510m Regular Duty, 210m Max OT, and 720m Max Credited Time:
 * - shiftAnchorMs = firstIn < scheduledStart ? scheduledStart : firstIn
 * - regularDutyCompletionMs = shiftAnchorMs + 510m
 * - eligibleEarlyOtMinutes = earlyArrival >= 60 ? min(earlyArrival, 210) : 0
 * - remainingPostShiftOtMinutes = max(0, 210 - eligibleEarlyOtMinutes)
 * - maxEligiblePunchOutMs = regularDutyCompletionMs + remainingPostShiftOtMinutes
 */
export function computeExpectedPunchOutTimes(params: {
  firstInIso: string;
  scheduledStartIso: string;
  scheduledEndIso: string;
  standardDutyMinutes?: number;
}): PunchOutScheduleMetrics | null {
  const firstInMs = new Date(params.firstInIso).getTime();
  const scheduledStartMs = new Date(params.scheduledStartIso).getTime();
  const scheduledEndMs = new Date(params.scheduledEndIso).getTime();

  if (!Number.isFinite(firstInMs) || !Number.isFinite(scheduledStartMs) || !Number.isFinite(scheduledEndMs)) {
    return null;
  }

  const maxRegularDutyMinutes = Math.max(
    1,
    Math.min(
      MAX_REGULAR_DUTY_MINUTES,
      Math.floor(Number.isFinite(params.standardDutyMinutes) ? Number(params.standardDutyMinutes) : STANDARD_DUTY_MINUTES)
    )
  );
  const earlyArrivalMinutes =
    firstInMs < scheduledStartMs ? Math.max(0, Math.floor((scheduledStartMs - firstInMs) / 60000)) : 0;
  const eligibleEarlyOtMinutes =
    earlyArrivalMinutes >= EARLY_OT_THRESHOLD_MINUTES
      ? Math.min(earlyArrivalMinutes, MAX_TOTAL_OT_MINUTES)
      : 0;
  const remainingPostShiftOtMinutes = Math.max(0, MAX_TOTAL_OT_MINUTES - eligibleEarlyOtMinutes);

  const shiftAnchorMs = firstInMs < scheduledStartMs ? scheduledStartMs : firstInMs;
  const regularDutyCompletionMs = shiftAnchorMs + maxRegularDutyMinutes * 60000;
  const maxEligiblePunchOutMs = regularDutyCompletionMs + remainingPostShiftOtMinutes * 60000;

  const regularDutyCompletionIso = new Date(regularDutyCompletionMs).toISOString();
  const maxEligiblePunchOutIso = new Date(maxEligiblePunchOutMs).toISOString();

  return {
    scheduledShiftEndIso: params.scheduledEndIso,
    scheduledShiftEndDisplay: formatIsoTimeKolkata12h(params.scheduledEndIso),
    regularDutyCompletionIso,
    regularDutyCompletionDisplay: formatIsoTimeKolkata12h(regularDutyCompletionIso),
    maxEligiblePunchOutIso,
    maxEligiblePunchOutDisplay: formatIsoTimeKolkata12h(maxEligiblePunchOutIso),
    maxRegularDutyMinutes,
    maxOtMinutes: MAX_TOTAL_OT_MINUTES,
    maxCreditedWorkingMinutes: MAX_CREDITED_TOTAL_MINUTES,
    maxOtDisplay: `${formatDurationClock(MAX_TOTAL_OT_MINUTES)} Hours`,
    maxCreditedWorkingDisplay: `${formatDurationClock(MAX_CREDITED_TOTAL_MINUTES)} Hours`,
    eligibleEarlyOtMinutes,
    remainingPostShiftOtMinutes,
  };
}

/**
 * Option A Early Punch Evaluation on Punch In:
 * - < 60 mins before scheduled shift start -> record earlyArrivalMinutes, award 0 Early OT.
 * - >= 60 mins before scheduled shift start -> provisional Early OT equals min(earlyArrivalMinutes, 210).
 * Open shifts remain IN PROGRESS with finalized overtimeMinutes = 0 until Punch Out.
 */
export function evaluateEarlyPunchOnPunchIn(params: {
  firstInIso: string;
  scheduledStartIso: string;
}): {
  earlyArrivalMinutes: number;
  provisionalEarlyOtMinutes: number;
  earlyOtFinalized: false;
  earlyPunchPolicy: typeof EARLY_PUNCH_POLICY_ID;
} {
  const firstInMs = new Date(params.firstInIso).getTime();
  const scheduledStartMs = new Date(params.scheduledStartIso).getTime();

  const earlyArrivalMinutes =
    Number.isFinite(firstInMs) && Number.isFinite(scheduledStartMs) && firstInMs < scheduledStartMs
      ? Math.max(0, Math.floor((scheduledStartMs - firstInMs) / 60000))
      : 0;

  const provisionalEarlyOtMinutes =
    earlyArrivalMinutes >= EARLY_OT_THRESHOLD_MINUTES
      ? Math.min(earlyArrivalMinutes, MAX_TOTAL_OT_MINUTES)
      : 0;

  return {
    earlyArrivalMinutes,
    provisionalEarlyOtMinutes,
    earlyOtFinalized: false,
    earlyPunchPolicy: EARLY_PUNCH_POLICY_ID,
  };
}

/**
 * Option A Finalized Punch Out / Correction Evaluation with Strict Duty & OT Caps:
 * - Max Regular Duty = 510 mins (08:30 hours)
 * - Max Total OT = 210 mins (03:30 hours)
 * - Max Credited Total Working Time = 720 mins (12:00 hours)
 *
 * Strictly separates non-overlapping intervals:
 * 1. Early Arrival interval: [firstIn, scheduledStart] -> Eligible Early OT iff >= 60m AND regular duty completed (capped to 210m).
 * 2. Regular Duty + Post-Shift interval: [max(firstIn, scheduledStart), lastOut] -> 510m regular + excess as Post-shift OT (capped to remaining OT budget).
 * Total OT = min(earlyOtMinutes + postShiftOtMinutes, 210).
 * Total Credited Duty = min(regularDutyMinutes + totalOtMinutes, 720).
 */
export function evaluateOptionAPunchOut(params: {
  firstInIso: string;
  lastOutIso: string;
  scheduledStartIso: string;
  scheduledEndIso?: string;
  standardDutyMinutes?: number;
}): {
  actualPresenceMinutes: number;
  earlyArrivalMinutes: number;
  provisionalEarlyOtMinutes: number;
  earlyOtMinutes: number;
  postShiftOtMinutes: number;
  overtimeMinutes: number;
  totalOtMinutes: number;
  regularDutyMinutes: number;
  totalDutyMinutes: number;
  otCapApplied: boolean;
  attendanceStatus: DutyClassifiedStatus;
  earlyOtFinalized: true;
  earlyPunchPolicy: typeof EARLY_PUNCH_POLICY_ID;
} {
  const standardDutyMinutes = Math.max(
    1,
    Math.min(
      MAX_REGULAR_DUTY_MINUTES,
      Math.floor(Number.isFinite(params.standardDutyMinutes) ? Number(params.standardDutyMinutes) : STANDARD_DUTY_MINUTES)
    )
  );
  const firstInMs = new Date(params.firstInIso).getTime();
  const lastOutMs = new Date(params.lastOutIso).getTime();
  const scheduledStartMs = new Date(params.scheduledStartIso).getTime();

  if (!Number.isFinite(firstInMs) || !Number.isFinite(lastOutMs) || lastOutMs < firstInMs) {
    return {
      actualPresenceMinutes: 0,
      earlyArrivalMinutes: 0,
      provisionalEarlyOtMinutes: 0,
      earlyOtMinutes: 0,
      postShiftOtMinutes: 0,
      overtimeMinutes: 0,
      totalOtMinutes: 0,
      regularDutyMinutes: 0,
      totalDutyMinutes: 0,
      otCapApplied: false,
      attendanceStatus: 'SHORT LEAVE',
      earlyOtFinalized: true,
      earlyPunchPolicy: EARLY_PUNCH_POLICY_ID,
    };
  }

  const actualPresenceMinutes = Math.max(0, Math.floor((lastOutMs - firstInMs) / 60000));
  const earlyArrivalMinutes =
    Number.isFinite(scheduledStartMs) && firstInMs < scheduledStartMs
      ? Math.max(0, Math.floor((scheduledStartMs - firstInMs) / 60000))
      : 0;
  const rawEarlyOtMinutes =
    earlyArrivalMinutes >= EARLY_OT_THRESHOLD_MINUTES ? earlyArrivalMinutes : 0;
  const provisionalEarlyOtMinutes = Math.min(rawEarlyOtMinutes, MAX_TOTAL_OT_MINUTES);

  const shiftAnchorMs =
    Number.isFinite(scheduledStartMs) && firstInMs < scheduledStartMs ? scheduledStartMs : firstInMs;
  const fromShiftStartMinutes = Math.max(0, Math.floor((lastOutMs - shiftAnchorMs) / 60000));

  if (fromShiftStartMinutes >= standardDutyMinutes) {
    const regularDutyMinutes = Math.min(fromShiftStartMinutes, MAX_REGULAR_DUTY_MINUTES, standardDutyMinutes);
    const rawPostShiftOtMinutes = Math.max(0, fromShiftStartMinutes - standardDutyMinutes);

    // Apply 210-minute total OT cap: Early OT first (never exceeding 210m), Post-Shift OT uses remaining budget
    const earlyOtMinutes = Math.min(rawEarlyOtMinutes, MAX_TOTAL_OT_MINUTES);
    const remainingOtBudget = Math.max(0, MAX_TOTAL_OT_MINUTES - earlyOtMinutes);
    const postShiftOtMinutes = Math.min(rawPostShiftOtMinutes, remainingOtBudget);
    const totalOtMinutes = Math.min(earlyOtMinutes + postShiftOtMinutes, MAX_TOTAL_OT_MINUTES);
    const overtimeMinutes = totalOtMinutes;
    const totalDutyMinutes = Math.min(regularDutyMinutes + totalOtMinutes, MAX_CREDITED_TOTAL_MINUTES);
    const otCapApplied =
      rawEarlyOtMinutes + rawPostShiftOtMinutes > MAX_TOTAL_OT_MINUTES ||
      regularDutyMinutes + rawEarlyOtMinutes + rawPostShiftOtMinutes > MAX_CREDITED_TOTAL_MINUTES;

    return {
      actualPresenceMinutes,
      earlyArrivalMinutes,
      provisionalEarlyOtMinutes,
      earlyOtMinutes,
      postShiftOtMinutes,
      overtimeMinutes,
      totalOtMinutes,
      regularDutyMinutes,
      totalDutyMinutes,
      otCapApplied,
      attendanceStatus: overtimeMinutes > 0 ? 'COMPLETED + OT' : 'COMPLETED',
      earlyOtFinalized: true,
      earlyPunchPolicy: EARLY_PUNCH_POLICY_ID,
    };
  }

  // Did not complete full scheduled duty duration: forfeit Early OT and preserve Half Day / Short Leave classification
  const countedDuty = Math.min(
    earlyArrivalMinutes > 0 ? fromShiftStartMinutes : actualPresenceMinutes,
    MAX_REGULAR_DUTY_MINUTES
  );
  const attendanceStatus = classifyCompletedDutyStatus(countedDuty, standardDutyMinutes);
  return {
    actualPresenceMinutes,
    earlyArrivalMinutes,
    provisionalEarlyOtMinutes,
    earlyOtMinutes: 0,
    postShiftOtMinutes: 0,
    overtimeMinutes: 0,
    totalOtMinutes: 0,
    regularDutyMinutes: countedDuty,
    totalDutyMinutes: countedDuty,
    otCapApplied: false,
    attendanceStatus,
    earlyOtFinalized: true,
    earlyPunchPolicy: EARLY_PUNCH_POLICY_ID,
  };
}

export function isAttendanceLate(record: Record<string, any> | null | undefined): boolean {
  if (!record) return false;
  if (record.isLate === true) return true;
  if (String(record.arrivalStatus || '').toUpperCase() === 'LATE') return true;
  if (String(record.attendanceStatus || '').toUpperCase() === 'LATE') return true;
  if (Array.isArray(record.punches)) {
    return record.punches.some((p: any) => String(p?.status || '').toUpperCase() === 'FIRST_IN_LATE');
  }
  return false;
}

export function isAttendanceRecordOpen(record: Record<string, any> | null | undefined): boolean {
  if (!record) return false;
  const rawStatus = String(record.attendanceStatus || '').toUpperCase();
  if (NON_WORKING_STATUSES.has(rawStatus)) return false;

  const state = String(record.currentState || '').toUpperCase();
  if (state === 'INSIDE') return true;
  if (state === 'OUTSIDE') return false;

  if (record.actualPunchOut || record.lastPunchOut) return false;
  if (record.autoClosed === true || record.punchOutType === 'AUTO' || record.punchOutType === 'ACTUAL') {
    return false;
  }
  if (rawStatus === 'AUTO CLOSED' || rawStatus === 'MISSED PUNCH OUT') {
    return false;
  }

  return Boolean(record.firstPunchIn || record.punchIn);
}

/**
 * Authoritatively resolves an attendance record's status, duty breakdown, OT, early punch breakdown,
 * and expected Punch-Out schedule. Safe for both new Option A records and legacy Firestore records.
 */
export function resolveAttendanceMetrics(
  record: Record<string, any> | null | undefined,
  nowMs: number = Date.now(),
  standardDutyMinutes: number = STANDARD_DUTY_MINUTES
): ResolvedAttendanceMetrics {
  const { startTime: defaultStart, endTime: defaultEnd } = resolveScheduledShiftDefaults(record);
  const scheduledStartDisplay = formatShiftTimeClock12h(defaultStart);
  const scheduledEndDisplay = formatShiftTimeClock12h(defaultEnd);

  if (!record) {
    return {
      status: 'ABSENT',
      state: 'OUTSIDE',
      isOpen: false,
      isLate: false,
      completedDutyMinutes: 0,
      regularDutyMinutes: 0,
      overtimeMinutes: 0,
      accumulatedDutyMinutes: 0,
      otLabel: '00:00',
      scheduledPunchIn: defaultStart,
      scheduledStartDisplay,
      scheduledPunchOut: defaultEnd,
      scheduledEndDisplay,
      earlyArrivalMinutes: 0,
      provisionalEarlyOtMinutes: 0,
      earlyOtMinutes: 0,
      postShiftOtMinutes: 0,
      totalOtMinutes: 0,
      earlyOtFinalized: false,
      isEarlyPunch: false,
      otCapApplied: false,
      reconciledFromAutoClose: false,
      punchOutSchedule: null,
    };
  }

  const rawStatus = String(record.attendanceStatus || '').trim().toUpperCase();
  const isLate = isAttendanceLate(record);
  const reconciledFromAutoClose = Boolean(record.reconciledFromAutoClose);

  // Compute expected Punch-Out schedule when first punch-in & shift schedule are known
  const firstInForSchedule = record.firstPunchIn || record.punchIn;
  let punchOutSchedule: PunchOutScheduleMetrics | null = null;
  if (firstInForSchedule && (record.scheduledPunchInIso || record.shiftDate)) {
    const bounds = record.shiftDate
      ? resolveShiftScheduleBounds(record.shiftDate, record)
      : null;
    const schedStartIso = record.scheduledPunchInIso || bounds?.scheduledStartIso;
    const schedEndIso = record.scheduledPunchOutIso || bounds?.scheduledEndIso;
    if (schedStartIso && schedEndIso) {
      punchOutSchedule = computeExpectedPunchOutTimes({
        firstInIso: firstInForSchedule,
        scheduledStartIso: schedStartIso,
        scheduledEndIso: schedEndIso,
        standardDutyMinutes,
      });
    }
  }

  // 1. Non-working explicit statuses (ABSENT, LEAVE, WEEKLY_OFF, HOLIDAY)
  if (NON_WORKING_STATUSES.has(rawStatus)) {
    return {
      status: rawStatus,
      state: 'OUTSIDE',
      isOpen: false,
      isLate: false,
      completedDutyMinutes: 0,
      regularDutyMinutes: 0,
      overtimeMinutes: 0,
      accumulatedDutyMinutes: 0,
      otLabel: '00:00',
      scheduledPunchIn: defaultStart,
      scheduledStartDisplay,
      scheduledPunchOut: defaultEnd,
      scheduledEndDisplay,
      earlyArrivalMinutes: 0,
      provisionalEarlyOtMinutes: 0,
      earlyOtMinutes: 0,
      postShiftOtMinutes: 0,
      totalOtMinutes: 0,
      earlyOtFinalized: false,
      isEarlyPunch: false,
      otCapApplied: false,
      reconciledFromAutoClose: false,
      punchOutSchedule: null,
    };
  }

  const storedEarlyArrival = Math.max(0, Math.floor(Number(record.earlyArrivalMinutes || 0) || 0));
  const computedProvisionalEarlyOt =
    typeof record.provisionalEarlyOtMinutes === 'number' && Number.isFinite(record.provisionalEarlyOtMinutes)
      ? Math.min(Math.max(0, Math.floor(record.provisionalEarlyOtMinutes)), MAX_TOTAL_OT_MINUTES)
      : storedEarlyArrival >= EARLY_OT_THRESHOLD_MINUTES
      ? Math.min(storedEarlyArrival, MAX_TOTAL_OT_MINUTES)
      : 0;

  // 2. Auto-closed or Missed Punch Out (only when not currently re-entered INSIDE and not reconciled to ACTUAL)
  const reenteredInside =
    String(record.currentState || '').toUpperCase() === 'INSIDE' &&
    String(record.punchOutType || '').toUpperCase() === 'NONE';
  if (
    !reenteredInside &&
    (record.autoClosed === true ||
      String(record.punchOutType || '').toUpperCase() === 'AUTO' ||
      rawStatus === 'AUTO CLOSED' ||
      rawStatus === 'MISSED PUNCH OUT' ||
      record.missedPunchOut === true)
  ) {
    const rawCompleted = Math.max(
      0,
      Math.floor(Number(record.totalDutyMinutes ?? record.regularDutyMinutes ?? 0) || 0)
    );
    const regularDutyMinutes = Math.min(rawCompleted, MAX_REGULAR_DUTY_MINUTES, standardDutyMinutes);
    const completedDutyMinutes = regularDutyMinutes;
    return {
      status: rawStatus === 'MISSED PUNCH OUT' ? 'MISSED PUNCH OUT' : 'AUTO CLOSED',
      state: 'OUTSIDE',
      isOpen: false,
      isLate,
      completedDutyMinutes,
      regularDutyMinutes,
      overtimeMinutes: 0, // Strictly zero OT on auto-closed / missed punch out
      accumulatedDutyMinutes: 0,
      otLabel: '00:00',
      scheduledPunchIn: defaultStart,
      scheduledStartDisplay,
      scheduledPunchOut: defaultEnd,
      scheduledEndDisplay,
      earlyArrivalMinutes: storedEarlyArrival,
      provisionalEarlyOtMinutes: 0,
      earlyOtMinutes: 0,
      postShiftOtMinutes: 0,
      totalOtMinutes: 0,
      earlyOtFinalized: false,
      isEarlyPunch: storedEarlyArrival > 0,
      otCapApplied: false,
      reconciledFromAutoClose: false,
      punchOutSchedule,
    };
  }

  // 3. Open shift (Punched IN without final Punch Out / currently INSIDE)
  if (isAttendanceRecordOpen(record)) {
    const firstInIso = record.firstPunchIn || record.punchIn;
    const firstInMs = firstInIso ? new Date(firstInIso).getTime() : NaN;
    const accumulatedDutyMinutes =
      Number.isFinite(firstInMs) && nowMs >= firstInMs
        ? Math.max(0, Math.floor((nowMs - firstInMs) / 60000))
        : 0;

    return {
      status: 'IN PROGRESS',
      state: 'INSIDE',
      isOpen: true,
      isLate,
      completedDutyMinutes: 0, // Never count open shift as finalized completed duty
      regularDutyMinutes: 0,
      overtimeMinutes: 0, // Never finalize OT on open shift
      accumulatedDutyMinutes,
      otLabel: '00:00',
      scheduledPunchIn: defaultStart,
      scheduledStartDisplay,
      scheduledPunchOut: defaultEnd,
      scheduledEndDisplay,
      earlyArrivalMinutes: storedEarlyArrival,
      provisionalEarlyOtMinutes: computedProvisionalEarlyOt,
      earlyOtMinutes: 0,
      postShiftOtMinutes: 0,
      totalOtMinutes: 0,
      earlyOtFinalized: false,
      isEarlyPunch: storedEarlyArrival > 0,
      otCapApplied: false,
      reconciledFromAutoClose,
      punchOutSchedule,
    };
  }

  // 4. Closed shift with valid Actual Punch Out
  const firstInIso = record.firstPunchIn || record.punchIn;
  const lastOutIso = record.lastPunchOut || record.actualPunchOut || record.effectivePunchOut;
  const firstInMs = firstInIso ? new Date(firstInIso).getTime() : NaN;
  const lastOutMs = lastOutIso ? new Date(lastOutIso).getTime() : NaN;

  const isOptionARecord =
    record.earlyPunchPolicy === EARLY_PUNCH_POLICY_ID ||
    typeof record.earlyOtMinutes === 'number' ||
    typeof record.postShiftOtMinutes === 'number';

  if (isOptionARecord) {
    let earlyArrivalMinutes = storedEarlyArrival;
    let earlyOtMinutes = Math.min(Math.max(0, Math.floor(Number(record.earlyOtMinutes || 0) || 0)), MAX_TOTAL_OT_MINUTES);
    let postShiftOtMinutes = Math.min(
      Math.max(0, Math.floor(Number(record.postShiftOtMinutes || 0) || 0)),
      Math.max(0, MAX_TOTAL_OT_MINUTES - earlyOtMinutes)
    );
    let regularDutyMinutes = Math.min(
      Math.max(0, Math.floor(Number(record.regularDutyMinutes || 0) || 0)),
      MAX_REGULAR_DUTY_MINUTES
    );
    let overtimeMinutes = Math.min(earlyOtMinutes + postShiftOtMinutes, MAX_TOTAL_OT_MINUTES);
    let completedDutyMinutes = Math.min(
      Math.max(0, Math.floor(Number(record.totalDutyMinutes || 0) || 0)),
      MAX_CREDITED_TOTAL_MINUTES
    );
    let otCapApplied = Boolean(record.otCapApplied);

    const scheduledStartIso =
      record.scheduledPunchInIso ||
      (record.shiftDate ? resolveShiftScheduleBounds(record.shiftDate, record).scheduledStartIso : undefined);

    if (scheduledStartIso && firstInIso && lastOutIso && Number.isFinite(firstInMs) && Number.isFinite(lastOutMs)) {
      const evaluated = evaluateOptionAPunchOut({
        firstInIso,
        lastOutIso,
        scheduledStartIso,
        standardDutyMinutes,
      });
      earlyArrivalMinutes = evaluated.earlyArrivalMinutes;
      earlyOtMinutes = evaluated.earlyOtMinutes;
      postShiftOtMinutes = evaluated.postShiftOtMinutes;
      overtimeMinutes = evaluated.overtimeMinutes;
      regularDutyMinutes = evaluated.regularDutyMinutes;
      completedDutyMinutes = evaluated.totalDutyMinutes;
      otCapApplied = evaluated.otCapApplied;
    } else if (overtimeMinutes === 0 && typeof record.overtimeMinutes === 'number') {
      overtimeMinutes = Math.min(Math.max(0, Math.floor(record.overtimeMinutes)), MAX_TOTAL_OT_MINUTES);
    }

    const status = classifyCompletedDutyStatus(completedDutyMinutes, standardDutyMinutes);
    return {
      status,
      state: 'OUTSIDE',
      isOpen: false,
      isLate,
      completedDutyMinutes,
      regularDutyMinutes,
      overtimeMinutes,
      accumulatedDutyMinutes: 0,
      otLabel: formatOtBadge(overtimeMinutes),
      scheduledPunchIn: defaultStart,
      scheduledStartDisplay,
      scheduledPunchOut: defaultEnd,
      scheduledEndDisplay,
      earlyArrivalMinutes,
      provisionalEarlyOtMinutes:
        earlyArrivalMinutes >= EARLY_OT_THRESHOLD_MINUTES
          ? Math.min(earlyArrivalMinutes, MAX_TOTAL_OT_MINUTES)
          : 0,
      earlyOtMinutes,
      postShiftOtMinutes,
      totalOtMinutes: overtimeMinutes,
      earlyOtFinalized: true,
      isEarlyPunch: earlyArrivalMinutes > 0,
      otCapApplied,
      reconciledFromAutoClose,
      punchOutSchedule,
    };
  }

  // Legacy closed record fallback (preserves historical classification while respecting caps)
  let rawCompleted = 0;
  if (
    typeof record.totalDutyMinutes === 'number' &&
    Number.isFinite(record.totalDutyMinutes) &&
    record.totalDutyMinutes > 0
  ) {
    rawCompleted = Math.floor(record.totalDutyMinutes);
  } else if (Number.isFinite(firstInMs) && Number.isFinite(lastOutMs) && lastOutMs >= firstInMs) {
    rawCompleted = Math.floor((lastOutMs - firstInMs) / 60000);
  } else if (
    typeof record.regularDutyMinutes === 'number' ||
    typeof record.overtimeMinutes === 'number'
  ) {
    rawCompleted = Math.max(
      0,
      Math.floor(Number(record.regularDutyMinutes || 0) + Number(record.overtimeMinutes || 0))
    );
  }

  const regularDutyMinutes = Math.min(rawCompleted, MAX_REGULAR_DUTY_MINUTES, standardDutyMinutes);
  const rawOt = rawCompleted > regularDutyMinutes ? rawCompleted - regularDutyMinutes : 0;
  const overtimeMinutes = Math.min(rawOt, MAX_TOTAL_OT_MINUTES);
  const completedDutyMinutes = Math.min(regularDutyMinutes + overtimeMinutes, MAX_CREDITED_TOTAL_MINUTES);
  const status = classifyCompletedDutyStatus(completedDutyMinutes, standardDutyMinutes);

  return {
    status,
    state: 'OUTSIDE',
    isOpen: false,
    isLate,
    completedDutyMinutes,
    regularDutyMinutes,
    overtimeMinutes,
    accumulatedDutyMinutes: 0,
    otLabel: formatOtBadge(overtimeMinutes),
    scheduledPunchIn: defaultStart,
    scheduledStartDisplay,
    scheduledPunchOut: defaultEnd,
    scheduledEndDisplay,
    earlyArrivalMinutes: 0,
    provisionalEarlyOtMinutes: 0,
    earlyOtMinutes: 0,
    postShiftOtMinutes: overtimeMinutes,
    totalOtMinutes: overtimeMinutes,
    earlyOtFinalized: true,
    isEarlyPunch: false,
    otCapApplied: rawOt > MAX_TOTAL_OT_MINUTES || rawCompleted > MAX_CREDITED_TOTAL_MINUTES,
    reconciledFromAutoClose,
    punchOutSchedule,
  };
}

export function getAttendanceStatusBadgeClasses(status: string): string {
  const normalized = String(status || '').trim().toUpperCase();
  switch (normalized) {
    case 'COMPLETED + OT':
      return 'bg-indigo-100 text-indigo-800 border border-indigo-200';
    case 'COMPLETED':
    case 'PRESENT':
      return 'bg-emerald-100 text-emerald-800 border border-emerald-200';
    case 'HALF DAY':
      return 'bg-amber-100 text-amber-800 border border-amber-200';
    case 'SHORT LEAVE':
      return 'bg-rose-100 text-rose-800 border border-rose-200';
    case 'IN PROGRESS':
      return 'bg-sky-100 text-sky-800 border border-sky-200';
    case 'AUTO CLOSED':
    case 'MISSED PUNCH OUT':
      return 'bg-orange-100 text-orange-800 border border-orange-200';
    case 'LATE':
      return 'bg-amber-100 text-amber-800 border border-amber-200';
    case 'LEAVE':
    case 'ON LEAVE':
    case 'WEEKLY OFF':
    case 'WEEKLY_OFF':
    case 'HOLIDAY':
      return 'bg-slate-100 text-slate-700 border border-slate-200';
    case 'ABSENT':
    default:
      return 'bg-red-100 text-red-800 border border-red-200';
  }
}
