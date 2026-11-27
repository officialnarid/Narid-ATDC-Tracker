import { auth } from '../firebase';
import {
  Floor,
  Section,
  Department,
  Shift,
  SystemSetting,
  AuditLog,
  Employee,
} from '../types';
import { sendServerAuditEvent, getAuthHeaders, fetchAuditLogs } from './auditService';
import { apiFetchJson } from '../config/api';
import {
  findCaseInsensitiveMasterDuplicate,
  normalizeWhitespaceAndUnicode,
} from '../utils/excelMasterNormalizer';

export const DEFAULT_SETTINGS: SystemSetting = {
  id: 'global',
  companyName: 'PRECISION INDUSTRIAL CORP',
  websiteName: 'Narid ATDC Tracker',
  timezone: 'Asia/Kolkata',
  dateFormat: 'YYYY-MM-DD',
  timeFormat: 'hh:mm A',
  autoPunchOutEnabled: true,
  lateGraceMinutes: 15,
  scheduledDurationMinutes: 510, // 8h 30m
  overtimeThresholdMinutes: 510,
  scannerMode: 'USB_PRIMARY',
  auditRetentionDays: 90,
  protectCriticalLogs: true,
  captureGeoLocation: true,
  failedLoginAlertThreshold: 5,
  superAdminLockoutResetHours: 24,
};

export const DEFAULT_SHIFTS: Shift[] = [
  {
    id: 'DAY',
    name: 'DAY SHIFT',
    startTime: '09:00',
    endTime: '17:30',
    scheduledDurationMinutes: 510, // 8 Hours 30 Minutes
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
    scheduledDurationMinutes: 510, // 8 Hours 30 Minutes
    punchInWindowStart: '18:00',
    punchInWindowEnd: '06:00',
    isOvernight: true,
    gracePeriodMinutes: 15,
    status: 'Active',
  },
];

export const DEFAULT_LINES: Floor[] = [
  { id: 'line_mi_01', name: 'MI-01', code: 'MI-01', order: 1, status: 'Active' },
  { id: 'line_mi_02', name: 'MI-02', code: 'MI-02', order: 2, status: 'Active' },
  { id: 'line_fatp_stb', name: 'FATP-STB', code: 'FATP-STB', order: 3, status: 'Active' },
  { id: 'line_fatp_itr', name: 'FATP-ITR', code: 'FATP-ITR', order: 4, status: 'Active' },
  { id: 'line_smt_01', name: 'SMT-01', code: 'SMT-01', order: 5, status: 'Active' },
];

export const DEFAULT_FLOORS: Floor[] = DEFAULT_LINES;

export const DEFAULT_SECTIONS: Section[] = [
  { id: 'sec_mi', name: 'MI', code: 'MI', floorId: 'line_mi_01', status: 'Active' },
  { id: 'sec_smt', name: 'SMT', code: 'SMT', floorId: 'line_smt_01', status: 'Active' },
  { id: 'sec_fatp', name: 'FATP', code: 'FATP', floorId: 'line_fatp_stb', status: 'Active' },
  { id: 'sec_store', name: 'STORE', code: 'STORE', floorId: 'line_fatp_itr', status: 'Active' },
];

export const DEFAULT_DEPARTMENTS: Department[] = [
  { id: 'dept_prod', name: 'Production', code: 'PROD', status: 'Active' },
  { id: 'dept_qual', name: 'Quality', code: 'QC', status: 'Active' },
  { id: 'dept_store', name: 'Store', code: 'STORE', status: 'Active' },
  { id: 'dept_ppc', name: 'PPC', code: 'PPC', status: 'Active' },
  { id: 'dept_rd', name: 'R&D', code: 'RD', status: 'Active' },
  { id: 'dept_oth', name: 'Others', code: 'OTH', status: 'Active' },
];

// Authentic Industrial Manpower reference dataset
export const AUTHENTIC_INDUSTRIAL_MANPOWER: Partial<Employee>[] = [
  { employeeId: 'JMD12345', employeeName: 'RAHUL SHARMA', employeeType: 'Offroll', section: 'MI', department: 'Production', floor: 'MI-01', designation: 'Manual Insertion Operator' },
  { employeeId: 'JMD12346', employeeName: 'AMIT PATEL', employeeType: 'Permanent', section: 'FATP', department: 'Quality', floor: 'FATP-STB', designation: 'Final QC Inspector' },
  { employeeId: 'JMD12347', employeeName: 'SURESH VERMA', employeeType: 'Staff', section: 'SMT', department: 'Production', floor: 'SMT-01', designation: 'SMT Shift Supervisor' },
  { employeeId: 'JMD12348', employeeName: 'PRIYA NAIR', employeeType: 'Staff', section: 'STORE', department: 'Store', floor: 'FATP-ITR', designation: 'Inventory & Dispatch Officer' },
  { employeeId: 'JMD12349', employeeName: 'DEEPAK KUMAR', employeeType: 'Offroll', section: 'MI', department: 'Production', floor: 'MI-01', designation: 'Selective Soldering Tech' },
  { employeeId: 'JMD12350', employeeName: 'ANJALI SINGH', employeeType: 'Permanent', section: 'FATP', department: 'Production', floor: 'FATP-STB', designation: 'Assembly Line Leader' },
  { employeeId: 'JMD12351', employeeName: 'VIKRAM CHOUDHARY', employeeType: 'Offroll', section: 'SMT', department: 'Quality', floor: 'SMT-01', designation: 'Automated Optical Inspector' },
  { employeeId: 'JMD12352', employeeName: 'ROHIT YADAV', employeeType: 'Permanent', section: 'STORE', department: 'Store', floor: 'FATP-ITR', designation: 'Raw Material Handler' },
  { employeeId: 'JMD12353', employeeName: 'MANISH JOSHI', employeeType: 'Staff', section: 'MI', department: 'PPC', floor: 'MI-02', designation: 'Production Planning Engineer' },
  { employeeId: 'JMD12354', employeeName: 'POOJA MEHTA', employeeType: 'Permanent', section: 'FATP', department: 'Quality', floor: 'FATP-STB', designation: 'QA Lead' },
  { employeeId: 'JMD12355', employeeName: 'SANDEEP GUPTA', employeeType: 'Offroll', section: 'MI', department: 'Production', floor: 'MI-02', designation: 'Board Assembly Tech' },
  { employeeId: 'JMD12356', employeeName: 'KAVITA RATHORE', employeeType: 'Staff', section: 'FATP', department: 'R&D', floor: 'FATP-ITR', designation: 'Embedded Test Engineer' },
  { employeeId: 'JMD12357', employeeName: 'MOHIT AGARWAL', employeeType: 'Permanent', section: 'SMT', department: 'Production', floor: 'SMT-01', designation: 'Pick & Place Operator' },
  { employeeId: 'JMD12358', employeeName: 'SUNIL TIWARI', employeeType: 'Offroll', section: 'STORE', department: 'Store', floor: 'FATP-ITR', designation: 'Finished Goods Dispatcher' },
  { employeeId: 'JMD12359', employeeName: 'DINESH MALHOTRA', employeeType: 'Staff', section: 'MI', department: 'Production', floor: 'MI-02', designation: 'Floor Incharge' },
  { employeeId: 'JMD12360', employeeName: 'NEHA SHARMA', employeeType: 'Offroll', section: 'FATP', department: 'Quality', floor: 'FATP-STB', designation: 'Incoming Component Inspector' },
  { employeeId: 'JMD12361', employeeName: 'AJAY CHAUHAN', employeeType: 'Permanent', section: 'SMT', department: 'PPC', floor: 'SMT-01', designation: 'Line Load Scheduler' },
  { employeeId: 'JMD12362', employeeName: 'RAJESH MISHRA', employeeType: 'Offroll', section: 'MI', department: 'Production', floor: 'MI-01', designation: 'ICT Testing Assistant' },
  { employeeId: 'JMD12363', employeeName: 'SNEHA KULKARNI', employeeType: 'Staff', section: 'FATP', department: 'R&D', floor: 'FATP-ITR', designation: 'Hardware Validation Tech' },
  { employeeId: 'JMD12364', employeeName: 'MANOJ KASHYAP', employeeType: 'Permanent', section: 'STORE', department: 'Store', floor: 'FATP-ITR', designation: 'Central Store Incharge' },
  { employeeId: 'JMD12365', employeeName: 'GAURAV PANDEY', employeeType: 'Offroll', section: 'FATP', department: 'Production', floor: 'FATP-STB', designation: 'Packaging Line Operator' },
  { employeeId: 'JMD12366', employeeName: 'JYOTI DESHMUKH', employeeType: 'Permanent', section: 'SMT', department: 'Quality', floor: 'SMT-01', designation: 'SMT Process Quality Auditor' },
  { employeeId: 'JMD12367', employeeName: 'VIVEK SHINDE', employeeType: 'Offroll', section: 'MI', department: 'Production', floor: 'MI-01', designation: 'Wave Soldering Specialist' },
  { employeeId: 'JMD12368', employeeName: 'HARSH BANSAL', employeeType: 'Staff', section: 'FATP', department: 'Others', floor: 'FATP-ITR', designation: 'Plant Maintenance Engineer' },
  { employeeId: 'JMD12369', employeeName: 'ARTI RAWAT', employeeType: 'Permanent', section: 'STORE', department: 'Quality', floor: 'FATP-ITR', designation: 'Component QC Officer' },
  { employeeId: 'JMD12370', employeeName: 'BALRAM SINGH', employeeType: 'Offroll', section: 'MI', department: 'Production', floor: 'MI-01', designation: 'Assembly Wire Harnesser' },
  { employeeId: 'JMD12371', employeeName: 'SHIKHA DIXIT', employeeType: 'Permanent', section: 'FATP', department: 'Production', floor: 'FATP-STB', designation: 'Screen Printing Operator' },
  { employeeId: 'JMD12372', employeeName: 'PANKAJ BISHT', employeeType: 'Offroll', section: 'SMT', department: 'Production', floor: 'SMT-01', designation: 'Feeder Setup Tech' },
  { employeeId: 'JMD12373', employeeName: 'REKHA YADAV', employeeType: 'Staff', section: 'STORE', department: 'Store', floor: 'FATP-ITR', designation: 'Stores Logistics Associate' },
  { employeeId: 'JMD12374', employeeName: 'ARUN PRASAD', employeeType: 'Permanent', section: 'FATP', department: 'Production', floor: 'FATP-STB', designation: 'Functional Testing Incharge' },
];

/**
 * F-02: Client-side master initialization is a safe no-op.
 * Production master collections are managed exclusively through authenticated server APIs
 * so ordinary browser sessions can never mutate or delete master configuration documents.
 */
export async function initializeMasterData(): Promise<void> {
  return;
}

// System Settings (authenticated server API)
export async function getSystemSettings(): Promise<SystemSetting> {
  try {
    const headers = await getAuthHeaders();
    const data = await apiFetchJson<{ success: boolean; settings?: SystemSetting | null }>(
      '/api/masters/settings',
      { method: 'GET', headers },
      'Failed to load system settings.',
      { preferSameOriginInPreview: true }
    );
    return data.settings ? { ...DEFAULT_SETTINGS, ...data.settings } : DEFAULT_SETTINGS;
  } catch (error) {
    console.error('Error loading system settings:', error);
    return DEFAULT_SETTINGS;
  }
}

export async function updateSystemSettings(settings: Partial<SystemSetting>): Promise<void> {
  const headers = await getAuthHeaders();
  await apiFetchJson<{ success: boolean }>(
    '/api/masters/settings',
    {
      method: 'PUT',
      headers,
      body: JSON.stringify(settings),
    },
    'Failed to update system settings.',
    { preferSameOriginInPreview: true }
  );
}

// Master Getters & Mutators (authenticated server APIs)
export async function getFloors(): Promise<Floor[]> {
  try {
    const headers = await getAuthHeaders();
    const data = await apiFetchJson<{ success: boolean; floors?: Floor[] }>(
      '/api/masters/floors',
      { method: 'GET', headers },
      'Failed to load production lines.',
      { preferSameOriginInPreview: true }
    );
    const list = Array.isArray(data.floors) ? data.floors : [];
    return list.length > 0 ? list.sort((a, b) => (a.order || 0) - (b.order || 0)) : DEFAULT_FLOORS;
  } catch (error) {
    console.error('Error loading floors:', error);
    return DEFAULT_FLOORS;
  }
}

export async function saveFloor(floor: Floor): Promise<void> {
  const cleanName = normalizeWhitespaceAndUnicode(floor.name);
  const existing = await getFloors();
  const duplicate = findCaseInsensitiveMasterDuplicate(cleanName, floor.id, existing);
  if (duplicate) {
    throw new Error(
      `A Production Line named "${duplicate.name}" already exists. Case-variant duplicates are not allowed.`
    );
  }
  const normalizedFloor: Floor = { ...floor, name: cleanName };
  const headers = await getAuthHeaders();
  await apiFetchJson<{ success: boolean }>(
    '/api/masters/floors',
    {
      method: 'POST',
      headers,
      body: JSON.stringify(normalizedFloor),
    },
    'Failed to save production line.',
    { preferSameOriginInPreview: true }
  );
}

export async function getSections(): Promise<Section[]> {
  try {
    const headers = await getAuthHeaders();
    const data = await apiFetchJson<{ success: boolean; sections?: Section[] }>(
      '/api/masters/sections',
      { method: 'GET', headers },
      'Failed to load sections.',
      { preferSameOriginInPreview: true }
    );
    const list = Array.isArray(data.sections) ? data.sections : [];
    return list.length > 0 ? list : DEFAULT_SECTIONS;
  } catch (error) {
    console.error('Error loading sections:', error);
    return DEFAULT_SECTIONS;
  }
}

export async function saveSection(section: Section): Promise<void> {
  const cleanName = normalizeWhitespaceAndUnicode(section.name);
  const existing = await getSections();
  const duplicate = findCaseInsensitiveMasterDuplicate(cleanName, section.id, existing);
  if (duplicate) {
    throw new Error(
      `A Section named "${duplicate.name}" already exists. Case-variant duplicates are not allowed.`
    );
  }
  const normalizedSection: Section = { ...section, name: cleanName };
  const headers = await getAuthHeaders();
  await apiFetchJson<{ success: boolean }>(
    '/api/masters/sections',
    {
      method: 'POST',
      headers,
      body: JSON.stringify(normalizedSection),
    },
    'Failed to save section.',
    { preferSameOriginInPreview: true }
  );
}

export async function getDepartments(): Promise<Department[]> {
  try {
    const headers = await getAuthHeaders();
    const data = await apiFetchJson<{ success: boolean; departments?: Department[] }>(
      '/api/masters/departments',
      { method: 'GET', headers },
      'Failed to load departments.',
      { preferSameOriginInPreview: true }
    );
    const list = Array.isArray(data.departments) ? data.departments : [];
    return list.length > 0 ? list : DEFAULT_DEPARTMENTS;
  } catch (error) {
    console.error('Error loading departments:', error);
    return DEFAULT_DEPARTMENTS;
  }
}

export async function saveDepartment(dept: Department): Promise<void> {
  const cleanName = normalizeWhitespaceAndUnicode(dept.name);
  const existing = await getDepartments();
  const duplicate = findCaseInsensitiveMasterDuplicate(cleanName, dept.id, existing);
  if (duplicate) {
    throw new Error(
      `A Department named "${duplicate.name}" already exists. Case-variant duplicates are not allowed.`
    );
  }
  const normalizedDept: Department = { ...dept, name: cleanName };
  const headers = await getAuthHeaders();
  await apiFetchJson<{ success: boolean }>(
    '/api/masters/departments',
    {
      method: 'POST',
      headers,
      body: JSON.stringify(normalizedDept),
    },
    'Failed to save department.',
    { preferSameOriginInPreview: true }
  );
}

export async function getShifts(): Promise<Shift[]> {
  try {
    const headers = await getAuthHeaders();
    const data = await apiFetchJson<{ success: boolean; shifts?: Shift[] }>(
      '/api/masters/shifts',
      { method: 'GET', headers },
      'Failed to load shifts.',
      { preferSameOriginInPreview: true }
    );
    const list = Array.isArray(data.shifts) ? data.shifts : [];
    return list.length > 0 ? list : DEFAULT_SHIFTS;
  } catch (error) {
    console.error('Error loading shifts:', error);
    return DEFAULT_SHIFTS;
  }
}

export async function saveShift(shift: Shift): Promise<void> {
  const headers = await getAuthHeaders();
  await apiFetchJson<{ success: boolean }>(
    '/api/masters/shifts',
    {
      method: 'POST',
      headers,
      body: JSON.stringify(shift),
    },
    'Failed to save shift.',
    { preferSameOriginInPreview: true }
  );
}

// Audit Log — routes exclusively through authenticated server endpoint for IP/Geo/UA enrichment & redaction
export async function recordAuditLog(log: Omit<AuditLog, 'id' | 'timestamp'>): Promise<void> {
  if (!auth.currentUser) return;
  try {
    await sendServerAuditEvent({
      action: log.action || 'GENERAL_ACTION',
      category: log.category,
      targetType: log.targetType || (log.employeeId ? 'EMPLOYEE' : 'SYSTEM'),
      targetId: log.targetId || log.employeeId,
      employeeId: log.employeeId,
      oldValue: log.oldValue ?? log.previousValue,
      newValue: log.newValue,
      actionSource: log.actionSource || 'CLIENT_APP',
      reason: log.reason,
      description: log.description || log.reason || log.newValue || log.action,
      success: log.success !== undefined ? log.success : true,
    });
  } catch (err) {
    console.warn('Failed to forward audit log to server:', err);
  }
}

export async function getAuditLogs(max: number = 100): Promise<AuditLog[]> {
  if (!auth.currentUser) return [];
  try {
    const res = await fetchAuditLogs({ pageSize: max });
    return Array.isArray(res.logs) ? res.logs : [];
  } catch (error) {
    console.error('Error fetching audit logs:', error);
    return [];
  }
}

// Load Authentic Industrial Manpower via authenticated server bulk-import API (server generates CSPRNG QR tokens)
export async function loadAuthenticIndustrialManpower(): Promise<{ count: number }> {
  const headers = await getAuthHeaders();
  const rows = AUTHENTIC_INDUSTRIAL_MANPOWER.map((item) => ({
    employeeId: item.employeeId!,
    employeeName: item.employeeName!,
    employeeType: (item.employeeType as any) || 'Permanent',
    section: item.section || 'MI',
    department: item.department || 'Production',
    floor: item.floor || 'MI-01',
    designation: item.designation || 'Operator',
    employeeStatus: 'Active',
  }));

  const data = await apiFetchJson<{ success: boolean; savedCount?: number }>(
    '/api/employees/bulk-import',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        fileName: 'authentic_industrial_manpower_seed.json',
        rows,
      }),
    },
    'Failed to load industrial manpower records.'
  );

  return { count: Number(data.savedCount || 0) };
}

// Wipe out mock / dummy attendance records through authenticated Super Admin backend endpoint
export async function clearAllAttendanceRecords(
  confirmPhrase: string = 'CLEAR_ALL_ATTENDANCE'
): Promise<{ deletedAttendance: number; deletedLogs: number }> {
  const headers = await getAuthHeaders();
  const data = await apiFetchJson<{
    success: boolean;
    deletedAttendance?: number;
    deletedLogs?: number;
  }>(
    '/api/attendance/clear',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        confirmed: true,
        confirmPhrase,
        reason: 'Super Admin requested controlled reset to fresh attendance state',
      }),
    },
    'Failed to clear attendance records.'
  );
  return {
    deletedAttendance: Number(data.deletedAttendance || 0),
    deletedLogs: Number(data.deletedLogs || 0),
  };
}

export const getLines = getFloors;
export const saveLine = saveFloor;
