import { Employee, AttendanceRecord, EmployeeType, EmployeeStatus } from '../types';
import { formatMinutes, formatTimeDisplay } from './attendanceService';
import { getEmployees, generateQrToken } from './employeeService';
import { recordAuditLog } from './masterService';
import { doc, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';

export interface ExcelImportRow {
  employeeId: string;
  employeeName: string;
  employeeType: string;
  section: string;
  department: string;
  floor: string;
  designation: string;
  status: string;
  rowNumber: number;
}

export interface ImportValidationResult {
  validRows: {
    data: Employee;
    actionType: 'NEW' | 'UPDATE' | 'UNCHANGED';
    diffs?: string[];
  }[];
  invalidRows: {
    rowNumber: number;
    raw: Record<string, any>;
    errors: string[];
  }[];
  summary: {
    total: number;
    newCount: number;
    updatedCount: number;
    unchangedCount: number;
    rejectedCount: number;
  };
}

// 1. Download Standard Employee Template
export async function downloadEmployeeTemplate(): Promise<void> {
  const XLSX = await import('xlsx');
  const templateHeaders = [
    'Employee ID',
    'Employee Name',
    'Employee Type',
    'Section',
    'Department',
    'Line',
    'Designation',
    'Status',
  ];

  const sampleRows = [
    ['JMD12345', 'RAHUL SHARMA', 'Offroll', 'MI', 'Production', 'MI-01', 'Assembly Operator', 'Active'],
    ['JMD12346', 'AMIT PATEL', 'Permanent', 'FATP', 'Quality', 'FATP-STB', 'Quality Inspector', 'Active'],
    ['JMD12347', 'SURESH VERMA', 'Staff', 'SMT', 'Production', 'SMT-01', 'Shift Supervisor', 'Active'],
    ['JMD12348', 'PRIYA NAIR', 'Staff', 'STORE', 'Store', 'FATP-ITR', 'Inventory Officer', 'Active'],
  ];

  const wsData = [templateHeaders, ...sampleRows];
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  // Column width styling
  ws['!cols'] = [
    { wch: 15 },
    { wch: 22 },
    { wch: 15 },
    { wch: 12 },
    { wch: 16 },
    { wch: 14 },
    { wch: 20 },
    { wch: 12 },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Employee_Master_Template');

  XLSX.writeFile(wb, 'Employee_Master_Template.xlsx');
}

// 2. Validate and Parse Uploaded Excel/CSV
export async function parseAndValidateEmployeeExcel(
  file: File,
  validFloors: string[],
  validSections: string[],
  validDepartments: string[]
): Promise<ImportValidationResult> {
  const [XLSX, buffer] = await Promise.all([import('xlsx'), file.arrayBuffer()]);
  const wb = XLSX.read(buffer, { type: 'array' });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const rawJson: any[] = XLSX.utils.sheet_to_json(sheet, { header: 1 });

  if (rawJson.length < 2) {
    throw new Error('The uploaded file is empty or does not contain data rows.');
  }

  // Headers in first row
  const headers: string[] = rawJson[0].map((h: any) => String(h || '').trim().toLowerCase());
  
  // Find column indices
  const getColIndex = (candidates: string[]) => {
    return headers.findIndex(h => candidates.some(c => h.includes(c)));
  };

  const idIdx = getColIndex(['employee id', 'empid', 'id']);
  const nameIdx = getColIndex(['employee name', 'name']);
  const typeIdx = getColIndex(['employee type', 'type']);
  const secIdx = getColIndex(['section']);
  const deptIdx = getColIndex(['department', 'dept']);
  const floorIdx = getColIndex(['line', 'floor']);
  const desigIdx = getColIndex(['designation', 'role']);
  const statusIdx = getColIndex(['status']);

  if (idIdx === -1 || nameIdx === -1) {
    throw new Error('Required columns "Employee ID" and "Employee Name" were not found in the file.');
  }

  // Fetch current existing employees from Firestore
  const existingEmployees = await getEmployees();
  const existingMap = new Map(existingEmployees.map(e => [e.employeeId.toUpperCase(), e]));

  const validRows: ImportValidationResult['validRows'] = [];
  const invalidRows: ImportValidationResult['invalidRows'] = [];
  const seenFileIds = new Set<string>();

  const validTypes = ['Permanent', 'Staff', 'Offroll'];
  const validStatuses = ['Active', 'Inactive'];

  const now = new Date().toISOString();

  for (let r = 1; r < rawJson.length; r++) {
    const row = rawJson[r];
    if (!row || row.length === 0 || row.every((c: any) => c === undefined || String(c).trim() === '')) {
      continue; // Skip blank rows
    }

    const rowNum = r + 1;
    const rawId = String(row[idIdx] || '').trim().toUpperCase();
    const rawName = String(row[nameIdx] || '').trim().toUpperCase();
    const rawType = String(typeIdx >= 0 ? row[typeIdx] || 'Permanent' : 'Permanent').trim();
    const rawSec = String(secIdx >= 0 ? row[secIdx] || 'MI' : 'MI').trim();
    const rawDept = String(deptIdx >= 0 ? row[deptIdx] || 'Production' : 'Production').trim();
    const rawFloor = String(floorIdx >= 0 ? row[floorIdx] || 'MI-01' : 'MI-01').trim();
    const rawDesig = String(desigIdx >= 0 ? row[desigIdx] || 'Operator' : 'Operator').trim();
    const rawStatus = String(statusIdx >= 0 ? row[statusIdx] || 'Active' : 'Active').trim();

    const errors: string[] = [];

    // Validation 1: Required Employee ID
    if (!rawId) {
      errors.push('Employee ID is missing');
    }

    // Validation 2: Required Employee Name
    if (!rawName) {
      errors.push('Employee Name is missing');
    }

    // Validation 3: Duplicate in file
    if (seenFileIds.has(rawId)) {
      errors.push(`Duplicate Employee ID "${rawId}" found within uploaded file`);
    } else if (rawId) {
      seenFileIds.add(rawId);
    }

    // Validation 4: Type validation
    const matchedType = validTypes.find(t => t.toLowerCase() === rawType.toLowerCase());
    if (!matchedType) {
      errors.push(`Invalid Employee Type "${rawType}". Allowed: ${validTypes.join(', ')}`);
    }

    // Validation 5: Status validation
    const matchedStatus = validStatuses.find(s => s.toLowerCase() === rawStatus.toLowerCase());
    if (!matchedStatus) {
      errors.push(`Invalid Status "${rawStatus}". Allowed: Active, Inactive`);
    }

    // Validation 6: Line validation (supports Line names like MI-01, MI-02, FATP-STB, FATP-ITR, SMT-01)
    if (validFloors.length > 0 && !validFloors.some(f => f.toLowerCase() === rawFloor.toLowerCase())) {
      errors.push(`Invalid Production Line "${rawFloor}". Allowed: ${validFloors.join(', ')}`);
    }

    // Validation 7: Section validation
    if (validSections.length > 0 && !validSections.some(s => s.toLowerCase() === rawSec.toLowerCase())) {
      errors.push(`Invalid Section "${rawSec}". Allowed: ${validSections.join(', ')}`);
    }

    // Validation 8: Department validation
    if (validDepartments.length > 0 && !validDepartments.some(d => d.toLowerCase() === rawDept.toLowerCase())) {
      errors.push(`Invalid Department "${rawDept}". Allowed: ${validDepartments.join(', ')}`);
    }

    if (errors.length > 0) {
      invalidRows.push({
        rowNumber: rowNum,
        raw: { id: rawId, name: rawName, type: rawType, section: rawSec, dept: rawDept, floor: rawFloor, status: rawStatus },
        errors,
      });
      continue;
    }

    // Determine if NEW, UPDATE, or UNCHANGED
    const existing = existingMap.get(rawId);
    if (!existing) {
      const newEmp: Employee = {
        employeeId: rawId,
        employeeName: rawName,
        employeeType: (matchedType as EmployeeType) || 'Permanent',
        section: rawSec,
        department: rawDept,
        floor: rawFloor,
        designation: rawDesig,
        qrCodeToken: generateQrToken(rawId),
        employeeStatus: (matchedStatus as EmployeeStatus) || 'Active',
        createdAt: now,
        updatedAt: now,
      };
      validRows.push({ data: newEmp, actionType: 'NEW' });
    } else {
      const diffs: string[] = [];
      if (existing.employeeName !== rawName) diffs.push(`Name: ${existing.employeeName} -> ${rawName}`);
      if (existing.employeeType !== matchedType) diffs.push(`Type: ${existing.employeeType} -> ${matchedType}`);
      if (existing.section !== rawSec) diffs.push(`Section: ${existing.section} -> ${rawSec}`);
      if (existing.department !== rawDept) diffs.push(`Dept: ${existing.department} -> ${rawDept}`);
      if (existing.floor !== rawFloor) diffs.push(`Line: ${existing.floor} -> ${rawFloor}`);
      if (existing.designation !== rawDesig) diffs.push(`Designation: ${existing.designation} -> ${rawDesig}`);
      if (existing.employeeStatus !== matchedStatus) diffs.push(`Status: ${existing.employeeStatus} -> ${matchedStatus}`);

      const updatedEmp: Employee = {
        ...existing,
        employeeName: rawName,
        employeeType: (matchedType as EmployeeType) || existing.employeeType,
        section: rawSec,
        department: rawDept,
        floor: rawFloor,
        designation: rawDesig,
        employeeStatus: (matchedStatus as EmployeeStatus) || existing.employeeStatus,
        // CRITICAL: Preserve existing QR token and historical creation date!
        qrCodeToken: existing.qrCodeToken || generateQrToken(rawId),
        updatedAt: now,
      };

      if (diffs.length > 0) {
        validRows.push({ data: updatedEmp, actionType: 'UPDATE', diffs });
      } else {
        validRows.push({ data: updatedEmp, actionType: 'UNCHANGED' });
      }
    }
  }

  const newCount = validRows.filter(r => r.actionType === 'NEW').length;
  const updatedCount = validRows.filter(r => r.actionType === 'UPDATE').length;
  const unchangedCount = validRows.filter(r => r.actionType === 'UNCHANGED').length;
  const rejectedCount = invalidRows.length;

  return {
    validRows,
    invalidRows,
    summary: {
      total: validRows.length + invalidRows.length,
      newCount,
      updatedCount,
      unchangedCount,
      rejectedCount,
    },
  };
}

// 3. Commit Validated Rows to Firestore using batched writes
export async function commitImportedEmployees(
  items: ImportValidationResult['validRows'],
  fileName: string
): Promise<{ savedCount: number }> {
  const toSave = items.filter((item) => item.actionType !== 'UNCHANGED');
  const BATCH_CHUNK_SIZE = 400;
  for (let i = 0; i < toSave.length; i += BATCH_CHUNK_SIZE) {
    const chunk = toSave.slice(i, i + BATCH_CHUNK_SIZE);
    const batch = writeBatch(db);
    for (const item of chunk) {
      batch.set(doc(db, 'employees', item.data.employeeId), item.data);
    }
    await batch.commit();
  }

  const savedCount = toSave.length;
  await recordAuditLog({
    action: 'EXCEL_EMPLOYEE_IMPORT',
    newValue: `Committed ${savedCount} employees from ${fileName}`,
    actionSource: 'EXCEL_IMPORT',
    reason: `File upload: ${items.length} validated rows`,
  });

  return { savedCount };
}

// 4. Export Generic Table Data to Excel (.xlsx) & CSV
export async function exportTableToExcel(
  data: Record<string, any>[],
  columns: { header: string; key: string }[],
  fileName: string
): Promise<void> {
  const XLSX = await import('xlsx');
  const wsData = [
    columns.map(c => c.header),
    ...data.map(row => columns.map(c => row[c.key] ?? '')),
  ];

  const ws = XLSX.utils.aoa_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Report');

  XLSX.writeFile(wb, `${fileName}.xlsx`);
}

function escapeCsvCell(value: unknown): string {
  const s = String(value ?? '');
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function exportTableToCsv(
  data: Record<string, any>[],
  columns: { header: string; key: string }[],
  fileName: string
): void {
  const lines: string[] = [columns.map((c) => escapeCsvCell(c.header)).join(',')];
  for (const row of data) {
    lines.push(columns.map((c) => escapeCsvCell(row[c.key])).join(','));
  }
  const csv = lines.join('\r\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `${fileName}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
