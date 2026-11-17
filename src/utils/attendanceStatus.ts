export const STANDARD_DUTY_MINUTES = 510; // 08 hours 30 minutes
export const HALF_DAY_MIN_MINUTES = 270; // 04 hours 30 minutes

export type DutyClassifiedStatus =
  | 'SHORT LEAVE'
  | 'HALF DAY'
  | 'COMPLETED'
  | 'COMPLETED + OT';

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
}

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
  const safeStandard = Math.max(1, Math.floor(Number.isFinite(standardDutyMinutes) ? standardDutyMinutes : STANDARD_DUTY_MINUTES));

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
 * Authoritatively resolves an attendance record's status, duty breakdown, OT, and accumulated open time.
 * Safe for both new and legacy Firestore records without modifying stored history.
 */
export function resolveAttendanceMetrics(
  record: Record<string, any> | null | undefined,
  nowMs: number = Date.now(),
  standardDutyMinutes: number = STANDARD_DUTY_MINUTES
): ResolvedAttendanceMetrics {
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
    };
  }

  const rawStatus = String(record.attendanceStatus || '').trim().toUpperCase();
  const isLate = isAttendanceLate(record);

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
    };
  }

  // 2. Auto-closed or Missed Punch Out (only when not currently re-entered INSIDE)
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
    const completedDutyMinutes = Math.max(
      0,
      Math.floor(Number(record.totalDutyMinutes ?? record.regularDutyMinutes ?? 0) || 0)
    );
    const regularDutyMinutes = Math.min(completedDutyMinutes, standardDutyMinutes);
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
      overtimeMinutes: 0, // Never calculate OT on open shift
      accumulatedDutyMinutes,
      otLabel: '00:00',
    };
  }

  // 4. Closed shift with valid Punch Out: derive status strictly from completed duty hours
  const firstInIso = record.firstPunchIn || record.punchIn;
  const lastOutIso = record.lastPunchOut || record.actualPunchOut || record.effectivePunchOut;
  const firstInMs = firstInIso ? new Date(firstInIso).getTime() : NaN;
  const lastOutMs = lastOutIso ? new Date(lastOutIso).getTime() : NaN;

  let completedDutyMinutes = 0;
  if (
    typeof record.totalDutyMinutes === 'number' &&
    Number.isFinite(record.totalDutyMinutes) &&
    record.totalDutyMinutes > 0
  ) {
    completedDutyMinutes = Math.floor(record.totalDutyMinutes);
  } else if (Number.isFinite(firstInMs) && Number.isFinite(lastOutMs) && lastOutMs >= firstInMs) {
    completedDutyMinutes = Math.floor((lastOutMs - firstInMs) / 60000);
  } else if (
    typeof record.regularDutyMinutes === 'number' ||
    typeof record.overtimeMinutes === 'number'
  ) {
    completedDutyMinutes = Math.max(
      0,
      Math.floor(Number(record.regularDutyMinutes || 0) + Number(record.overtimeMinutes || 0))
    );
  }

  const regularDutyMinutes = Math.min(completedDutyMinutes, standardDutyMinutes);
  const overtimeMinutes =
    completedDutyMinutes > standardDutyMinutes ? completedDutyMinutes - standardDutyMinutes : 0;
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
