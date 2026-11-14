import { 
  collection, 
  doc, 
  getDoc, 
  getDocs, 
  setDoc, 
  updateDoc, 
  deleteDoc, 
  query, 
  orderBy, 
  limit 
} from 'firebase/firestore';
import { db, auth, handleFirestoreError, OperationType, sanitizeFirestoreData } from '../firebase';
import { 
  Floor, 
  Section, 
  Department, 
  Shift, 
  SystemSetting, 
  AuditLog, 
  Employee 
} from '../types';
import { sendServerAuditEvent, getAuthHeaders } from './auditService';
import { apiFetchJson } from '../config/api';

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
};

export const DEFAULT_SHIFTS: Shift[] = [
  {
    id: 'DAY',
    name: 'DAY SHIFT',
    startTime: '09:00',
    endTime: '17:30',
    scheduledDurationMinutes: 510, // 8 Hours 30 Minutes
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
    scheduledDurationMinutes: 510, // 8 Hours 30 Minutes
    punchInWindowStart: '20:00',
    punchInWindowEnd: '09:00',
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

// Authentic Industrial Manpower dataset with plant production lines
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

// Initialize database with default collections if empty (strictly guarded on Firebase Auth)
export async function initializeMasterData(): Promise<void> {
  if (!auth.currentUser) return;
  try {
    // 1. Settings
    const settingsRef = doc(db, 'system_settings', 'global');
    const settingsSnap = await getDoc(settingsRef);
    if (!settingsSnap.exists()) {
      await setDoc(settingsRef, DEFAULT_SETTINGS);
    }

    // 2. Shifts (DAY: 09:00-20:00, NIGHT: 20:00-09:00 next day)
    const shiftsSnap = await getDocs(collection(db, 'shifts'));
    if (shiftsSnap.empty) {
      for (const shift of DEFAULT_SHIFTS) {
        await setDoc(doc(db, 'shifts', shift.id), shift);
      }
    } else {
      // Sync default shift windows if they have older configurations
      for (const shift of DEFAULT_SHIFTS) {
        const existing = shiftsSnap.docs.find(d => d.id === shift.id);
        if (!existing) {
          await setDoc(doc(db, 'shifts', shift.id), shift);
        } else {
          const data = existing.data() as Shift;
          if (data.punchInWindowStart === '07:30' || data.punchInWindowStart === '18:30') {
            await setDoc(doc(db, 'shifts', shift.id), shift);
          }
        }
      }
    }

    // 3. Production Lines (MI-01, MI-02, FATP-STB, FATP-ITR, SMT-01)
    const floorsSnap = await getDocs(collection(db, 'floors'));
    const existingNames = floorsSnap.docs.map(d => (d.data() as Floor).name);
    if (floorsSnap.empty || existingNames.some(n => n.includes('Floor'))) {
      for (const d of floorsSnap.docs) {
        await deleteDoc(d.ref);
      }
      for (const line of DEFAULT_LINES) {
        await setDoc(doc(db, 'floors', line.id), line);
      }
    }

    // 4. Sections
    const sectionsSnap = await getDocs(collection(db, 'sections'));
    if (sectionsSnap.empty) {
      for (const sec of DEFAULT_SECTIONS) {
        await setDoc(doc(db, 'sections', sec.id), sec);
      }
    }

    // 5. Departments
    const deptsSnap = await getDocs(collection(db, 'departments'));
    if (deptsSnap.empty) {
      for (const dept of DEFAULT_DEPARTMENTS) {
        await setDoc(doc(db, 'departments', dept.id), dept);
      }
    }

    // 6. Ensure Authentic Industrial Employees exist if database has no employees
    const empSnap = await getDocs(collection(db, 'employees'));
    if (empSnap.empty) {
      await loadAuthenticIndustrialManpower();
    }
  } catch (error) {
    console.error('Error during master data initialization:', error);
  }
}

// System Settings
export async function getSystemSettings(): Promise<SystemSetting> {
  try {
    const snap = await getDoc(doc(db, 'system_settings', 'global'));
    if (snap.exists()) {
      return snap.data() as SystemSetting;
    }
    return DEFAULT_SETTINGS;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, 'system_settings/global');
    return DEFAULT_SETTINGS;
  }
}

export async function updateSystemSettings(settings: Partial<SystemSetting>): Promise<void> {
  try {
    await updateDoc(doc(db, 'system_settings', 'global'), {
      ...settings,
    });
    await recordAuditLog({
      action: 'UPDATE_SYSTEM_SETTINGS',
      newValue: JSON.stringify(settings),
      actionSource: 'SETTINGS_PAGE',
      reason: 'Administrator updated system settings',
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, 'system_settings/global');
  }
}

// Master Getters
export async function getFloors(): Promise<Floor[]> {
  try {
    const snap = await getDocs(collection(db, 'floors'));
    return snap.docs.map(d => d.data() as Floor).sort((a, b) => a.order - b.order);
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'floors');
    return DEFAULT_FLOORS;
  }
}

export async function saveFloor(floor: Floor): Promise<void> {
  try {
    await setDoc(doc(db, 'floors', floor.id), floor);
    await recordAuditLog({
      action: 'SAVE_FLOOR',
      newValue: floor.name,
      actionSource: 'FLOOR_MANAGEMENT',
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `floors/${floor.id}`);
  }
}

export async function getSections(): Promise<Section[]> {
  try {
    const snap = await getDocs(collection(db, 'sections'));
    return snap.docs.map(d => d.data() as Section);
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'sections');
    return DEFAULT_SECTIONS;
  }
}

export async function saveSection(section: Section): Promise<void> {
  try {
    await setDoc(doc(db, 'sections', section.id), section);
    await recordAuditLog({
      action: 'SAVE_SECTION',
      newValue: section.name,
      actionSource: 'SECTION_MANAGEMENT',
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `sections/${section.id}`);
  }
}

export async function getDepartments(): Promise<Department[]> {
  try {
    const snap = await getDocs(collection(db, 'departments'));
    return snap.docs.map(d => d.data() as Department);
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'departments');
    return DEFAULT_DEPARTMENTS;
  }
}

export async function saveDepartment(dept: Department): Promise<void> {
  try {
    await setDoc(doc(db, 'departments', dept.id), dept);
    await recordAuditLog({
      action: 'SAVE_DEPARTMENT',
      newValue: dept.name,
      actionSource: 'DEPARTMENT_MANAGEMENT',
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `departments/${dept.id}`);
  }
}

export async function getShifts(): Promise<Shift[]> {
  try {
    const snap = await getDocs(collection(db, 'shifts'));
    return snap.docs.map(d => d.data() as Shift);
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'shifts');
    return DEFAULT_SHIFTS;
  }
}

export async function saveShift(shift: Shift): Promise<void> {
  try {
    await setDoc(doc(db, 'shifts', shift.id), shift);
    await recordAuditLog({
      action: 'SAVE_SHIFT',
      newValue: `${shift.name} (${shift.startTime}-${shift.endTime})`,
      actionSource: 'SHIFT_MANAGEMENT',
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `shifts/${shift.id}`);
  }
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
    const q = query(collection(db, 'audit_logs'), orderBy('timestamp', 'desc'), limit(max));
    const snap = await getDocs(q);
    return snap.docs.map(d => {
      const data = d.data();
      const stringifyField = (val: any) => {
        if (val === undefined || val === null) return undefined;
        if (typeof val === 'object') {
          try {
            return JSON.stringify(val);
          } catch {
            return '[Object]';
          }
        }
        return String(val);
      };

      return {
        ...data,
        id: d.id,
        action: String(data.action || ''),
        employeeId: stringifyField(data.employeeId),
        timestamp: String(data.timestamp || new Date().toISOString()),
        oldValue: stringifyField(data.oldValue || data.previousValue),
        newValue: stringifyField(data.newValue),
        actionSource: String(data.actionSource || 'SYSTEM'),
        reason: stringifyField(data.reason || data.details || data.description),
      } as AuditLog;
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'audit_logs');
    return [];
  }
}

// Load Authentic Industrial Manpower (Real factory employees)
export async function loadAuthenticIndustrialManpower(): Promise<{ count: number }> {
  let added = 0;
  const now = new Date().toISOString();

  for (const item of AUTHENTIC_INDUSTRIAL_MANPOWER) {
    const fullEmp: Employee = {
      employeeId: item.employeeId!,
      employeeName: item.employeeName!,
      employeeType: (item.employeeType as any) || 'Permanent',
      section: item.section || 'MI',
      department: item.department || 'Production',
      floor: item.floor || '1st Floor',
      designation: item.designation || 'Operator',
      qrCodeToken: `QR_${item.employeeId}_AUTH`,
      employeeStatus: 'Active',
      createdAt: now,
      updatedAt: now,
    };
    await setDoc(doc(db, 'employees', fullEmp.employeeId), fullEmp);
    added++;
  }

  await recordAuditLog({
    action: 'LOAD_AUTHENTIC_MANPOWER',
    newValue: `${added} authentic manpower employee records registered`,
    actionSource: 'MANPOWER_MASTER',
    reason: 'Loaded original industrial manpower records',
  });

  return { count: added };
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
