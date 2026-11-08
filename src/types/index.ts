export type EmployeeType = 'Permanent' | 'Staff' | 'Offroll';
export type EmployeeStatus = 'Active' | 'Inactive';

export interface Employee {
  employeeId: string; // Unique primary ID, e.g. JMD12345
  employeeName: string;
  employeeType: EmployeeType;
  section: string; // e.g. MI, SMT, FATP, STORE
  department: string; // e.g. Production, Quality, Store, PPC, R&D, Others
  line?: string; // Production Line: MI-01, MI-02, FATP-STB, FATP-ITR, SMT-01
  floor: string; // Production Line identifier
  designation: string;
  qrCodeToken: string;
  employeeStatus: EmployeeStatus;
  createdAt: string;
  updatedAt: string;
}

export type PunchOutType = 'ACTUAL' | 'AUTO' | 'NONE';

export type AttendanceStatus = 
  | 'PRESENT'
  | 'LATE'
  | 'MISSED PUNCH OUT'
  | 'AUTO CLOSED'
  | 'COMPLETED'
  | 'ABSENT'
  | 'LEAVE'
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
  punchIn: string; // ISO string
  scheduledPunchOut: string; // e.g. 17:30 or 04:30
  actualPunchOut: string | null; // ISO string if scanned
  effectivePunchOut: string | null; // ISO string used for calculation
  punchOutType: PunchOutType;
  regularDutyMinutes: number; // Duration in minutes (max 510 by default)
  overtimeMinutes: number; // OT duration in minutes
  attendanceStatus: AttendanceStatus;
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

export interface AuditLog {
  id: string;
  action: string;
  employeeId?: string;
  timestamp: string;
  oldValue?: string;
  newValue?: string;
  actionSource: string;
  reason?: string;
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
}

export type UserRoleType = 'SUPER_ADMIN' | 'ADMIN' | 'USER';

export interface UserRoleRecord {
  id: string;
  name: string;
  email: string;
  role: UserRoleType;
  status: 'Active' | 'Inactive';
  modulesAllowed: string[]; // ['dashboard', 'scanner', 'employees', 'qr', 'reports', etc.]
  createdAt: string;
  updatedAt: string;
}

export interface ScanResult {
  success: boolean;
  action: 'PUNCH_IN' | 'PUNCH_OUT' | 'REJECTED' | 'REJECTED_DUPLICATE';
  message: string;
  employee?: Employee;
  attendance?: AttendanceRecord;
  shift?: Shift;
  time: string;
  dutyFormatted?: string;
  otFormatted?: string;
}
