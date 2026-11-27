export type EmployeeType = 'Permanent' | 'Staff' | 'Offroll';
export type EmployeeStatus = 'Active' | 'Inactive';

export interface Employee {
  employeeId: string; // Unique primary ID, e.g. JMD12345
  employeeName: string;
  employeeType: EmployeeType;
  section: string; // e.g. MI, SMT, FATP, STORE
  sectionId?: string;
  department: string; // e.g. Production, Quality, Store, PPC, R&D, Others
  departmentId?: string;
  line?: string; // Production Line: MI-01, MI-02, FATP-STB, FATP-ITR, SMT-01
  lineId?: string;
  floor: string; // Production Line identifier
  floorId?: string;
  designation: string;
  designationId?: string;
  qrCodeToken?: string;
  hasQrToken?: boolean;
  qrTokenReference?: string;
  employeeStatus: EmployeeStatus;
  createdAt: string;
  updatedAt: string;
}

export type PunchOutType = 'ACTUAL' | 'AUTO' | 'NONE';
export type PunchEventType = 'IN' | 'OUT';
export type ScannerType = 'IN' | 'OUT';
export type CurrentAttendanceState = 'INSIDE' | 'OUTSIDE';

export interface PunchEvent {
  id: string;
  employeeId: string;
  employeeName: string;
  eventType: PunchEventType;
  timestamp: string; // ISO string
  displayTime: string; // "09:05:22 AM"
  shiftDate: string; // YYYY-MM-DD
  shiftId: string;
  shiftName: string;
  floor: string;
  section: string;
  department: string;
  scannerType: ScannerType;
  scannerDevice: string;
  dutyDurationMinutes?: number;
  overtimeMinutes?: number;
  earlyOtMinutes?: number;
  postShiftOtMinutes?: number;
  reconciledFromAutoClose?: boolean;
  previousPunchOutType?: PunchOutType;
  previousAutoCloseEventId?: string | null;
  status: string;
}

export interface PunchOutScheduleDisplay {
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

export type AttendanceStatus = 
  | 'IN PROGRESS'
  | 'SHORT LEAVE'
  | 'HALF DAY'
  | 'COMPLETED'
  | 'COMPLETED + OT'
  | 'PRESENT'
  | 'LATE'
  | 'MISSED PUNCH OUT'
  | 'AUTO CLOSED'
  | 'ABSENT'
  | 'LEAVE'
  | 'ON LEAVE'
  | 'WEEKLY_OFF'
  | 'HOLIDAY';

export interface AttendanceRecord {
  id: string; // document ID: att_{employeeId}_{shiftDate}
  employeeId: string;
  employeeNameSnapshot: string;
  employeeTypeSnapshot: EmployeeType;
  floorIdSnapshot: string; // Production line snapshot e.g. MI-01, FATP-STB
  lineIdSnapshot?: string;
  sectionIdSnapshot: string;
  departmentIdSnapshot: string;
  shiftId: string; // e.g. 'DAY' or 'NIGHT'
  shiftNameSnapshot: string;
  shiftDate: string; // YYYY-MM-DD
  punchIn: string; // ISO string (earliest punch in)
  firstPunchIn?: string; // alias to earliest punch in
  scheduledPunchIn?: string; // e.g. '09:00' or '20:00'
  scheduledPunchInIso?: string;
  scheduledPunchOut: string; // e.g. '17:30' or '04:30'
  scheduledPunchOutIso?: string;
  actualPunchOut: string | null; // ISO string if scanned (latest punch out)
  lastPunchOut?: string | null; // alias to latest punch out
  effectivePunchOut: string | null; // ISO string used for calculation
  punchOutType: PunchOutType;
  currentState?: CurrentAttendanceState;
  punches?: PunchEvent[];
  totalDutyMinutes?: number;
  actualPresenceMinutes?: number;
  regularDutyMinutes: number; // Scheduled duty in minutes (max 510 by default)
  overtimeMinutes: number; // Total finalized OT duration in minutes (earlyOtMinutes + postShiftOtMinutes)
  earlyArrivalMinutes?: number;
  provisionalEarlyOtMinutes?: number;
  earlyOtMinutes?: number;
  postShiftOtMinutes?: number;
  totalOtMinutes?: number;
  earlyOtFinalized?: boolean;
  earlyPunchPolicy?: 'OPTION_A_60M';
  attendanceStatus: AttendanceStatus;
  isLate?: boolean;
  arrivalStatus?: 'PRESENT' | 'LATE';
  missedPunchOut?: boolean;
  autoClosed?: boolean;
  autoClosedAt?: string | null;
  autoCloseEventId?: string | null;
  autoCloseEffectivePunchOut?: string | null;
  reconciledFromAutoClose?: boolean;
  reconciledAt?: string | null;
  reconciledByUid?: string | null;
  reconciledByLoginId?: string | null;
  otCapApplied?: boolean;
  qrTokenReference: string;
  correctionReason?: string;
  correctedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Line {
  id: string;
  name: string; // e.g. MI-01, MI-02, FATP-STB, FATP-ITR, SMT-01
  code: string;
  order: number;
  status: 'Active' | 'Inactive';
}

export type Floor = Line;

export interface Section {
  id: string;
  name: string;
  code: string;
  floorId: string;
  status: 'Active' | 'Inactive';
}

export interface Department {
  id: string;
  name: string;
  code: string;
  status: 'Active' | 'Inactive';
}

export interface Shift {
  id: string;
  name: string;
  startTime: string; // '09:00'
  endTime: string; // '17:30'
  scheduledDurationMinutes: number; // 510 minutes (8h 30m)
  punchInWindowStart: string; // '07:30'
  punchInWindowEnd: string; // '11:00'
  isOvernight: boolean; // true for Night shift
  gracePeriodMinutes: number; // e.g. 15 mins for late mark
  status: 'Active' | 'Inactive';
}

export type RosterStatus = 'SCHEDULED' | 'LEAVE' | 'WEEKLY_OFF' | 'HOLIDAY';

export interface ShiftRoster {
  id: string; // roster_{shiftDate}_{shiftId}_{employeeId}
  shiftDate: string; // YYYY-MM-DD
  shiftId: string;
  employeeId: string;
  rosterStatus: RosterStatus;
  remarks?: string;
  updatedAt: string;
}

export interface PunchLog {
  id: string;
  employeeId: string;
  employeeName?: string;
  timestamp: string;
  action: 'PUNCH_IN' | 'PUNCH_OUT' | 'REJECTED_DUPLICATE' | 'REJECTED_INACTIVE' | 'REJECTED_TOKEN' | 'REJECTED_SHIFT' | 'AUTO_CLOSE';
  rawPayload: string;
  scannerDevice: 'USB_SCANNER' | 'WEBCAM' | 'SYSTEM_AUTO' | 'MANUAL';
  message: string;
}

export type AuditSeverity = 'INFO' | 'WARNING' | 'CRITICAL';
export type AuditCategory =
  | 'AUTH'
  | 'ACCOUNT'
  | 'EMPLOYEE'
  | 'ATTENDANCE'
  | 'QR'
  | 'ORG'
  | 'PERMISSIONS'
  | 'EXPORT'
  | 'SETTINGS'
  | 'SECURITY'
  | 'AUDIT_LIFECYCLE'
  | 'SYSTEM';

export interface GeoLocationInfo {
  country: string;
  region: string;
  city: string;
  status: 'resolved' | 'unavailable';
}

export interface UserAgentMeta {
  browser: string;
  os: string;
  deviceType: 'Desktop' | 'Mobile' | 'Tablet' | 'Bot' | 'Unknown';
  raw?: string;
}

export interface AuditLog {
  id: string;
  action: string;
  eventType?: string;
  category?: AuditCategory;
  severity?: AuditSeverity;
  actorUid?: string;
  actorLoginId?: string;
  actorRole?: string;
  loginId?: string;
  performedByUid?: string;
  performedByLoginId?: string;
  targetType?: string;
  targetId?: string;
  targetUid?: string;
  employeeId?: string;
  timestamp: string;
  timestampMs?: number;
  oldValue?: string;
  previousValue?: string;
  newValue?: string;
  actionSource: string;
  reason?: string;
  details?: string;
  description?: string;
  success?: boolean;
  ipAddress?: string;
  geoLocation?: GeoLocationInfo;
  userAgentMeta?: UserAgentMeta;
  sessionId?: string;
  isImportant?: boolean;
  isProtected?: boolean;
  archived?: boolean;
  archivedAt?: string;
  archivedBy?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewNote?: string;
}

export interface LoginHistoryEntry {
  id: string;
  eventType: 'LOGIN_SUCCESS' | 'LOGIN_FAILED' | 'LOGIN_LOCKED' | 'LOGOUT' | 'SESSION_EXPIRED';
  loginId: string;
  authUid?: string;
  role: string;
  timestamp: string;
  timestampMs: number;
  success: boolean;
  failureReason?: string;
  ipAddress: string;
  geoLocation: GeoLocationInfo;
  browser: string;
  os: string;
  deviceType: string;
  sessionId?: string;
}

export interface AuditDeletionRecord {
  id: string;
  deletedLogId: string;
  deletedAction: string;
  deletedCategory: string;
  deletedTimestamp: string;
  deletedActorLoginId: string;
  deletedSummary: string;
  linkedRecordsChecked: string[];
  reason: string;
  approvedByUid: string;
  approvedByLoginId: string;
  deletedAt: string;
  ipAddress: string;
}

export interface SystemSetting {
  id: string;
  companyName: string;
  websiteName: string;
  timezone: string;
  dateFormat: string;
  timeFormat: string;
  autoPunchOutEnabled: boolean;
  lateGraceMinutes: number;
  scheduledDurationMinutes: number;
  overtimeThresholdMinutes: number;
  scannerMode: 'USB_PRIMARY' | 'CAMERA_HYBRID';
  auditRetentionDays?: number;
  protectCriticalLogs?: boolean;
  captureGeoLocation?: boolean;
  failedLoginAlertThreshold?: number;
  superAdminLockoutResetHours?: number;
}

export type UserRoleType = 'SUPER_ADMIN' | 'ADMIN' | 'USER' | 'super_admin' | 'admin' | 'user' | (string & {});

export interface UserRoleRecord {
  id: string;
  loginId: string; // e.g. superadmin, admin, user
  name: string;
  email: string;
  role: UserRoleType;
  status: 'Active' | 'Inactive';
  modulesAllowed: string[]; // ['dashboard', 'scanner', 'employees', 'qr', 'reports', etc.]
  mustChangePassword?: boolean;
  forcePasswordChange?: boolean;
  lockStatus?: 'ACTIVE' | 'LOCKED';
  isLocked?: boolean;
  lockPolicyType?: 'PROGRESSIVE_TEMPORARY' | 'PERMANENT_MANUAL';
  lockoutUntil?: string | null;
  lockedUntil?: string | null;
  lockedUntilMs?: number | null;
  lockDurationMinutes?: number | null;
  progressiveLockLevel?: number;
  consecutiveFailedAttempts?: number;
  passwordLastChangedAt?: string;
  passwordHash?: string;
  authUid?: string;
  linkedAuthUids?: string[];
  emailAliases?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DeviceSummaryInfo {
  browser: string;
  os: string;
  deviceType: string;
}

export interface AccountSecurityRecord {
  id: string;
  roleDocId: string;
  loginId: string;
  name: string;
  email: string;
  role: string;
  firebaseUid: string;
  accountStatus: 'Active' | 'Inactive';
  lockStatus: 'ACTIVE' | 'LOCKED';
  lockPolicyType?: 'PROGRESSIVE_TEMPORARY' | 'PERMANENT_MANUAL';
  lockoutUntil?: string | null;
  lockedUntil?: string | null;
  lockedUntilMs?: number | null;
  lockDurationMinutes?: number | null;
  remainingLockSeconds?: number | null;
  progressiveLockLevel?: number;
  totalLockoutEvents?: number;
  lastLockoutAt?: string | null;
  lastLockExpiredAt?: string | null;
  lockoutExpiredPendingLogin?: boolean;
  cleanWindowStartAt?: string | null;
  cleanLoginsSinceLastLockout?: number;
  lockoutLevelResetAt?: string | null;
  lockoutLevelResetBy?: string | null;
  lockoutLevelResetReason?: string | null;
  consecutiveFailedAttempts: number;
  maxAttemptsAllowed: number;
  totalLoginAttempts: number;
  totalSuccessfulLogins: number;
  totalFailedLogins: number;
  forcePasswordChange: boolean;
  mustChangePassword: boolean;
  lockedAt?: string | null;
  lockReason?: string | null;
  lastSuccessAt?: string | null;
  lastSuccessIp?: string | null;
  lastSuccessGeo?: GeoLocationInfo | null;
  lastSuccessDevice?: DeviceSummaryInfo | null;
  lastFailedAt?: string | null;
  lastFailedIp?: string | null;
  lastFailedGeo?: GeoLocationInfo | null;
  lastFailedDevice?: DeviceSummaryInfo | null;
  lastFailedReason?: string | null;
  unblockedByUid?: string | null;
  unblockedByLoginId?: string | null;
  unblockedAt?: string | null;
  unblockReason?: string | null;
  tempPasswordResetByUid?: string | null;
  tempPasswordResetByLoginId?: string | null;
  tempPasswordResetAt?: string | null;
  passwordLastChangedAt?: string | null;
  updatedAt?: string | null;
}

export interface LoginAttemptRecord {
  id: string;
  loginId: string;
  role: string;
  firebaseUid?: string | null;
  timestamp: string;
  timestampMs: number;
  success: boolean;
  outcome:
    | 'SUCCESS'
    | 'FAILED_PASSWORD'
    | 'BLOCKED_LOCKED'
    | 'BLOCKED_INACTIVE'
    | 'BLOCKED_RATE_LIMIT'
    | 'FIREBASE_TOO_MANY_ATTEMPTS'
    | 'ACCOUNT_NOT_FOUND';
  failureReasonCategory: string;
  failureReason?: string | null;
  attemptNumber?: number | null;
  consecutiveFailedAfter?: number | null;
  triggeredLock?: boolean;
  lockDurationMinutes?: number | null;
  lockoutUntil?: string | null;
  lockedUntil?: string | null;
  ipAddress: string;
  geoLocation?: GeoLocationInfo;
  browser: string;
  os: string;
  deviceType: string;
  sessionId?: string | null;
}

export interface SecurityAuditLogRecord {
  id: string;
  action: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  targetLoginId: string;
  targetRole: string;
  targetUid?: string | null;
  actorUid: string;
  actorLoginId: string;
  actorRole: string;
  timestamp: string;
  timestampMs: number;
  ipAddress: string;
  geoLocation?: GeoLocationInfo;
  deviceInfo?: DeviceSummaryInfo;
  reason: string;
  details: string;
  metadata?: Record<string, any>;
}

export interface SecurityOverviewResponse {
  success: boolean;
  superAdminLockoutResetHours?: number;
  serverNowMs?: number;
  kpis: {
    totalLoginAttempts: number;
    successfulLogins: number;
    failedLogins: number;
    currentlyLockedAccounts: number;
    accountsWithForcePasswordChange: number;
    rateLimitAlerts: number;
  };
  accounts: AccountSecurityRecord[];
  recentAttempts: LoginAttemptRecord[];
  recentSecurityLogs: SecurityAuditLogRecord[];
}

export interface ScanResult {
  success: boolean;
  action: 'PUNCH_IN' | 'PUNCH_OUT' | 'REJECTED' | 'REJECTED_DUPLICATE';
  scannerType?: ScannerType;
  currentState?: CurrentAttendanceState;
  message: string;
  employee?: Employee;
  attendance?: AttendanceRecord;
  shift?: Shift;
  time: string;
  dutyFormatted?: string;
  otFormatted?: string;
  punchCount?: number;
  reconciledFromAutoClose?: boolean;
  punchOutSchedule?: PunchOutScheduleDisplay;
  perf?: {
    qrDetectMs?: number;
    qrParseMs?: number;
    tokenFetchMs?: number;
    tokenVerifyMs?: number;
    callerLookupMs?: number;
    authMs?: number;
    permissionMs?: number;
    employeeLookupMs?: number;
    attendanceLookupMs?: number;
    configLookupMs?: number;
    lookupAndQueryMs?: number;
    tokenValidationMs?: number;
    txMs?: number;
    firestoreOpMs?: number;
    auditMs?: number;
    totalServerMs?: number;
    firestoreReads?: number;
    firestoreWrites?: number;
    parallelPrefetchUsed?: boolean;
    networkApiMs?: number;
    uiDisplayMs?: number;
    totalEndToEndMs?: number;
    totalPunchInMs?: number;
    totalPunchOutMs?: number;
  };
}
