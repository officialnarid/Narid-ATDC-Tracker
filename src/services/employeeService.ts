import { 
  collection, 
  doc, 
  getDoc, 
  getDocs, 
  setDoc, 
  updateDoc, 
  deleteDoc, 
  query, 
  where 
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import { Employee, EmployeeStatus, EmployeeType } from '../types';
import { recordAuditLog } from './masterService';

export interface EmployeeFilters {
  search?: string;
  floor?: string;
  section?: string;
  department?: string;
  employeeType?: EmployeeType | 'All';
  employeeStatus?: EmployeeStatus | 'All';
}

export function generateQrToken(employeeId: string): string {
  const rand = Math.random().toString(36).substring(2, 9).toUpperCase();
  const ts = Date.now().toString(36).toUpperCase();
  return `QR_${employeeId}_${ts}_${rand}`;
}

export async function getEmployees(filters?: EmployeeFilters): Promise<Employee[]> {
  try {
    const snap = await getDocs(collection(db, 'employees'));
    let list: Employee[] = snap.docs.map(d => d.data() as Employee);

    if (filters) {
      if (filters.search && filters.search.trim() !== '') {
        const s = filters.search.toLowerCase().trim();
        list = list.filter(e => 
          e.employeeId.toLowerCase().includes(s) || 
          e.employeeName.toLowerCase().includes(s) ||
          e.designation.toLowerCase().includes(s)
        );
      }
      if (filters.floor && filters.floor !== 'All') {
        list = list.filter(e => e.floor === filters.floor);
      }
      if (filters.section && filters.section !== 'All') {
        list = list.filter(e => e.section === filters.section);
      }
      if (filters.department && filters.department !== 'All') {
        list = list.filter(e => e.department === filters.department);
      }
      if (filters.employeeType && filters.employeeType !== 'All') {
        list = list.filter(e => e.employeeType === filters.employeeType);
      }
      if (filters.employeeStatus && filters.employeeStatus !== 'All') {
        list = list.filter(e => e.employeeStatus === filters.employeeStatus);
      }
    }

    // Sort by employeeId
    return list.sort((a, b) => a.employeeId.localeCompare(b.employeeId));
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'employees');
    return [];
  }
}

export async function getEmployeeById(employeeId: string): Promise<Employee | null> {
  try {
    const cleanId = employeeId.trim();
    const snap = await getDoc(doc(db, 'employees', cleanId));
    if (snap.exists()) {
      return snap.data() as Employee;
    }
    return null;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, `employees/${employeeId}`);
    return null;
  }
}

export async function saveEmployee(employee: Partial<Employee>, isNew: boolean): Promise<Employee> {
  if (!employee.employeeId || employee.employeeId.trim() === '') {
    throw new Error('Employee ID is required.');
  }
  const cleanId = employee.employeeId.trim().toUpperCase();

  if (isNew) {
    const existing = await getEmployeeById(cleanId);
    if (existing) {
      throw new Error(`Employee ID "${cleanId}" already exists. ID must be unique.`);
    }
  }

  const now = new Date().toISOString();
  const qrCodeToken = employee.qrCodeToken || generateQrToken(cleanId);

  const fullEmployee: Employee = {
    employeeId: cleanId,
    employeeName: (employee.employeeName || '').trim().toUpperCase(),
    employeeType: employee.employeeType || 'Permanent',
    section: employee.section || 'MI',
    department: employee.department || 'Production',
    floor: employee.floor || '1st Floor',
    designation: (employee.designation || 'Operator').trim(),
    qrCodeToken: qrCodeToken,
    employeeStatus: employee.employeeStatus || 'Active',
    createdAt: employee.createdAt || now,
    updatedAt: now,
  };

  try {
    await setDoc(doc(db, 'employees', cleanId), fullEmployee);
    await recordAuditLog({
      action: isNew ? 'CREATE_EMPLOYEE' : 'UPDATE_EMPLOYEE',
      employeeId: cleanId,
      newValue: `${fullEmployee.employeeName} (${fullEmployee.department} - ${fullEmployee.floor})`,
      actionSource: 'EMPLOYEE_MASTER',
    });
    return fullEmployee;
  } catch (error) {
    handleFirestoreError(error, isNew ? OperationType.CREATE : OperationType.UPDATE, `employees/${cleanId}`);
    throw error;
  }
}

export async function toggleEmployeeStatus(employeeId: string, newStatus: EmployeeStatus): Promise<void> {
  const cleanId = employeeId.trim();
  try {
    const empRef = doc(db, 'employees', cleanId);
    const existing = await getDoc(empRef);
    if (!existing.exists()) {
      throw new Error(`Employee ${cleanId} not found.`);
    }
    const oldStatus = existing.data()?.employeeStatus;
    await updateDoc(empRef, {
      employeeStatus: newStatus,
      updatedAt: new Date().toISOString(),
    });
    await recordAuditLog({
      action: 'TOGGLE_EMPLOYEE_STATUS',
      employeeId: cleanId,
      oldValue: oldStatus || 'Active',
      newValue: newStatus,
      actionSource: 'EMPLOYEE_MASTER',
      reason: `Super Admin toggled status to ${newStatus}`,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `employees/${cleanId}`);
  }
}

export async function deleteEmployee(employeeId: string): Promise<void> {
  const cleanId = employeeId.trim();
  try {
    const empRef = doc(db, 'employees', cleanId);
    const existing = await getDoc(empRef);
    const empData = existing.exists() ? existing.data() : null;
    await deleteDoc(empRef);
    await recordAuditLog({
      action: 'DELETE_EMPLOYEE',
      employeeId: cleanId,
      oldValue: empData ? `${empData.employeeName} (${empData.department} - ${empData.floor})` : 'Employee Record',
      newValue: 'DELETED',
      actionSource: 'EMPLOYEE_MASTER',
      reason: 'Administrator permanently deleted employee record',
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `employees/${cleanId}`);
    throw error;
  }
}

export async function regenerateQrToken(employeeId: string): Promise<string> {
  const cleanId = employeeId.trim();
  const newToken = generateQrToken(cleanId);
  try {
    const empRef = doc(db, 'employees', cleanId);
    await updateDoc(empRef, {
      qrCodeToken: newToken,
      updatedAt: new Date().toISOString(),
    });
    await recordAuditLog({
      action: 'REGENERATE_QR_TOKEN',
      employeeId: cleanId,
      newValue: newToken,
      actionSource: 'QR_MANAGEMENT',
      reason: 'Administrator regenerated QR security token',
    });
    return newToken;
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `employees/${cleanId}`);
    throw error;
  }
}
