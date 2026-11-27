import { Employee, AttendanceRecord, EmployeeType, EmployeeStatus } from '../types';
import { formatMinutes, formatTimeDisplay } from './attendanceService';
import { getEmployees, generateQrToken } from './employeeService';
import { getAuthHeaders } from './auditService';
import {
  apiUrl,
  assertApiBaseConfigured,
  executeApiFetch,
  safeParseJsonResponse,
} from '../config/api';
import { auth } from '../firebase';
import {
  type AmbiguousMasterConflict,
  type FieldNormalizationInfo,
  type MasterFieldKey,
  type MasterRecordOption,
  type NormalizationMappingEntry,
  CANONICAL_EMPLOYEE_STATUSES,
  CANONICAL_EMPLOYEE_TYPES,
  MASTER_FIELD_LABELS,
  buildMasterLookupIndex,
  buildUnambiguousDesignationMapFromEmployees,
  matchCanonicalMasterValue,
  normalizeMasterLookupKey,
  normalizeWhitespaceAndUnicode,
} from '../utils/excelMasterNormalizer';
import {
  buildPremiumExcelWorkbookBuffer,
  downloadPremiumExcelWorkbook,
  type PremiumExcelExportOptions,
} from '../utils/excelReportExporter';
import {
  buildEmployeeTemplateWorkbookBuffer,
  parseSafeSpreadsheetFile,
} from '../utils/safeSpreadsheetParser';
import type { AttendanceReportSummary } from '../utils/attendanceReportBuilder';

export const EMPLOYEE_ID_PATTERN = /^[A-Za-z0-9_.\-]+$/;

export type ImportFailureCategory =
  | 'AUTHENTICATION'
  | 'AUTHORIZATION'
  | 'DATABASE_AUTHORIZATION'
  | 'VALIDATION'
  | 'NETWORK_OR_TIMEOUT'
  | 'DATABASE_WRITE_ERROR';

export interface ImportFailedRow {
  employeeId: string;
  rowNumber?: number;
  actionType?: 'NEW' | 'UPDATE';
  error: string;
}

export interface EmployeeImportCommitResult {
  savedCount: number;
  insertedCount: number;
  updatedCount: number;
  skippedCount: number;
  failedCount: number;
  committedIds: string[];
  insertedIds: string[];
  updatedIds: string[];
  skippedIds: string[];
  failedRows: ImportFailedRow[];
  partialCommit: boolean;
}

export class EmployeeImportCommitError extends Error {
  category: ImportFailureCategory;
  code?: string;
  status?: number;
  partialCommit: boolean;
  savedCount: number;
  insertedCount: number;
  updatedCount: number;
  skippedCount: number;
  failedCount: number;
  committedIds: string[];
  failedRows: ImportFailedRow[];

  constructor(
    message: string,
    details: {
      category: ImportFailureCategory;
      code?: string;
      status?: number;
      partialCommit?: boolean;
      savedCount?: number;
      insertedCount?: number;
      updatedCount?: number;
      skippedCount?: number;
      failedCount?: number;
      committedIds?: string[];
      failedRows?: ImportFailedRow[];
    }
  ) {
    super(message);
    this.name = 'EmployeeImportCommitError';
    this.category = details.category;
    this.code = details.code;
    this.status = details.status;
    this.partialCommit = Boolean(details.partialCommit);
    this.savedCount = Number(details.savedCount || 0);
    this.insertedCount = Number(details.insertedCount || 0);
    this.updatedCount = Number(details.updatedCount || 0);
    this.skippedCount = Number(details.skippedCount || 0);
    this.failedCount = Number(details.failedCount || 0);
    this.committedIds = Array.isArray(details.committedIds) ? details.committedIds : [];
    this.failedRows = Array.isArray(details.failedRows) ? details.failedRows : [];
  }
}

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

export interface ParseEmployeeExcelOptions {
  designations?: ReadonlyArray<MasterRecordOption | string>;
  existingEmployees?: Employee[];
}

export interface ImportValidationResult {
  validRows: {
    data: Employee;
    actionType: 'NEW' | 'UPDATE' | 'UNCHANGED';
    diffs?: string[];
    rowNumber?: number;
    normalizedFields?: Partial<Record<MasterFieldKey, FieldNormalizationInfo>>;
    includedFields?: string[];
  }[];
  invalidRows: {
    rowNumber: number;
    raw: Record<string, any>;
    errors: string[];
    hasAmbiguity?: boolean;
    ambiguityDetails?: AmbiguousMasterConflict[];
  }[];
  summary: {
    total: number;
    newCount: number;
    updatedCount: number;
    unchangedCount: number;
    rejectedCount: number;
  };
  normalizationSummary?: NormalizationMappingEntry[];
  normalizedCellCount?: number;
  caseNormalizedRowCount?: number;
  ambiguousRowCount?: number;
  ambiguities?: AmbiguousMasterConflict[];
}

export type {
  AmbiguousMasterConflict,
  FieldNormalizationInfo,
  MasterFieldKey,
  MasterRecordOption,
  NormalizationMappingEntry,
};

// 1. Download Standard Employee Template (built via ExcelJS — zero xlsx dependency)
export async function downloadEmployeeTemplate(): Promise<void> {
  const arrayBuffer = await buildEmployeeTemplateWorkbookBuffer();
  const blob = new Blob([arrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = 'Employee_Master_Template.xlsx';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
}

// 2. Validate and Parse Uploaded Excel/CSV with Case-Insensitive Master Normalization (F-06 Hardened Parser)
export async function parseAndValidateEmployeeExcel(
  file: File,
  validFloors: ReadonlyArray<MasterRecordOption | string>,
  validSections: ReadonlyArray<MasterRecordOption | string>,
  validDepartments: ReadonlyArray<MasterRecordOption | string>,
  options?: ParseEmployeeExcelOptions
): Promise<ImportValidationResult> {
  const rawJson: string[][] = await parseSafeSpreadsheetFile(file);

  if (rawJson.length < 2) {
    throw new Error('The uploaded file is empty or does not contain data rows.');
  }

  // Headers in first row (Unicode + whitespace normalized, case-insensitive)
  const headers: string[] = rawJson[0].map((h: any) => normalizeMasterLookupKey(h));

  // Find column indices
  const getColIndex = (candidates: string[]) => {
    return headers.findIndex((h) => candidates.some((c) => h === c || h.includes(c)));
  };

  const idIdx = getColIndex(['employee id', 'empid', 'emp id', 'id']);
  const nameIdx = getColIndex(['employee name', 'name']);
  const typeIdx = getColIndex(['employee type', 'emp type', 'type']);
  const secIdx = getColIndex(['section']);
  const deptIdx = getColIndex(['department', 'dept']);
  const lineColIdx = getColIndex(['line']);
  const floorColIdx = getColIndex(['floor']);
  const floorIdx = lineColIdx >= 0 ? lineColIdx : floorColIdx;
  const desigIdx = getColIndex(['designation', 'role']);
  const statusIdx = getColIndex(['status']);

  if (idIdx === -1 || nameIdx === -1) {
    throw new Error('Required columns "Employee ID" and "Employee Name" were not found in the file.');
  }

  // Fetch current existing employees from Firestore (unless injected by caller/test)
  const existingEmployees = options?.existingEmployees ?? (await getEmployees());
  const existingMap = new Map(existingEmployees.map((e) => [e.employeeId.trim().toUpperCase(), e]));

  // Build case-insensitive canonical master indexes (preserving duplicate entries for ambiguity detection)
  const typeIndex = buildMasterLookupIndex(CANONICAL_EMPLOYEE_TYPES);
  const statusIndex = buildMasterLookupIndex(CANONICAL_EMPLOYEE_STATUSES);
  const floorIndex = buildMasterLookupIndex(validFloors);
  const sectionIndex = buildMasterLookupIndex(validSections);
  const departmentIndex = buildMasterLookupIndex(validDepartments);
  const hasExplicitDesignationMaster = Boolean(options?.designations && options.designations.length > 0);
  const designationIndex = hasExplicitDesignationMaster
    ? buildMasterLookupIndex(options!.designations!)
    : null;
  const employeeDesignationMap = !hasExplicitDesignationMaster
    ? buildUnambiguousDesignationMapFromEmployees(existingEmployees)
    : null;

  const validRows: ImportValidationResult['validRows'] = [];
  const invalidRows: ImportValidationResult['invalidRows'] = [];
  const seenFileIds = new Set<string>();

  // Deduplicated summary of all case/whitespace-normalized master mappings across valid rows
  const normalizationSummaryMap = new Map<string, NormalizationMappingEntry>();
  const ambiguityMap = new Map<string, AmbiguousMasterConflict>();
  let normalizedCellCount = 0;
  let caseNormalizedRowCount = 0;
  let ambiguousRowCount = 0;

  const recordNormalizationSummary = (info: FieldNormalizationInfo) => {
    if (!info.wasNormalized) return;
    normalizedCellCount += 1;
    const key = `${info.field}|${info.originalValue}|${info.canonicalValue}`;
    const existingEntry = normalizationSummaryMap.get(key);
    if (existingEntry) {
      existingEntry.occurrenceCount += 1;
    } else {
      normalizationSummaryMap.set(key, {
        field: info.field,
        fieldLabel: info.fieldLabel,
        excelValue: info.originalValue,
        canonicalValue: info.canonicalValue,
        masterId: info.masterId,
        caseNormalized: info.caseNormalized,
        whitespaceNormalized: info.whitespaceNormalized,
        matchStatus: 'MATCHED',
        occurrenceCount: 1,
      });
    }
  };

  const recordAmbiguity = (
    field: MasterFieldKey,
    excelValue: string,
    rowNumber: number,
    candidates: Array<{ id: string; name: string; code?: string }>,
    rowAmbiguities: AmbiguousMasterConflict[]
  ) => {
    const fieldLabel = MASTER_FIELD_LABELS[field];
    const conflictForRow: AmbiguousMasterConflict = {
      field,
      fieldLabel,
      excelValue,
      rowNumbers: [rowNumber],
      candidates,
    };
    rowAmbiguities.push(conflictForRow);

    const key = `${field}|${normalizeMasterLookupKey(excelValue)}`;
    const existing = ambiguityMap.get(key);
    if (existing) {
      if (!existing.rowNumbers.includes(rowNumber)) {
        existing.rowNumbers.push(rowNumber);
      }
    } else {
      ambiguityMap.set(key, {
        field,
        fieldLabel,
        excelValue,
        rowNumbers: [rowNumber],
        candidates,
      });
    }
  };

  const now = new Date().toISOString();

  for (let r = 1; r < rawJson.length; r++) {
    const row = rawJson[r];
    if (!row || row.length === 0 || row.every((c: any) => c === undefined || String(c).trim() === '')) {
      continue; // Skip blank rows
    }

    const rowNum = r + 1;
    const rawId = normalizeWhitespaceAndUnicode(row[idIdx]).toUpperCase();
    // Preserve free-text Employee Name capitalization (trim & collapse repeated whitespace only)
    const rawName = normalizeWhitespaceAndUnicode(row[nameIdx]);

    const existing = rawId ? existingMap.get(rawId) : undefined;
    const isUpdate = Boolean(existing);

    const hasCell = (idx: number): boolean => {
      if (idx < 0) return false;
      const val = row[idx];
      return val !== undefined && val !== null && normalizeWhitespaceAndUnicode(val) !== '';
    };

    const hasTypeCell = hasCell(typeIdx);
    const hasSecCell = hasCell(secIdx);
    const hasDeptCell = hasCell(deptIdx);
    const hasFloorCell = hasCell(floorIdx);
    const hasDesigCell = hasCell(desigIdx);
    const hasStatusCell = hasCell(statusIdx);

    // For EXISTING employees: NEVER overwrite omitted columns with defaults!
    // For NEW employees: use canonical fallback defaults when optional columns are omitted.
    const rawTypeOriginal = hasTypeCell ? String(row[typeIdx]) : isUpdate ? existing!.employeeType : 'Permanent';
    const rawSecOriginal = hasSecCell ? String(row[secIdx]) : isUpdate ? existing!.section : 'MI';
    const rawDeptOriginal = hasDeptCell ? String(row[deptIdx]) : isUpdate ? existing!.department : 'Production';
    const rawFloorOriginal = hasFloorCell ? String(row[floorIdx]) : isUpdate ? existing!.floor : 'MI-01';
    const rawDesigOriginal = hasDesigCell ? String(row[desigIdx]) : isUpdate ? existing!.designation : 'Operator';
    const rawStatusOriginal = hasStatusCell ? String(row[statusIdx]) : isUpdate ? existing!.employeeStatus : 'Active';

    const errors: string[] = [];
    const rowAmbiguities: AmbiguousMasterConflict[] = [];
    const normalizedFields: Partial<Record<MasterFieldKey, FieldNormalizationInfo>> = {};

    // Validation 1: Required & deterministic Employee ID format
    if (!rawId) {
      errors.push('Employee ID is missing');
    } else if (rawId.length > 128) {
      errors.push(`Employee ID "${rawId}" exceeds maximum length of 128 characters`);
    } else if (!EMPLOYEE_ID_PATTERN.test(rawId)) {
      errors.push(
        `Invalid Employee ID "${rawId}". Only letters, numbers, underscores (_), hyphens (-), and periods (.) are allowed (no spaces or slashes).`
      );
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

    // Helper to validate & normalize a controlled master field
    const resolveField = (
      field: MasterFieldKey,
      rawValue: string,
      wasProvidedInExcel: boolean,
      index: ReturnType<typeof buildMasterLookupIndex>,
      enforced: boolean
    ): { canonical: string; masterId: string | null } => {
      if (!enforced || index.options.length === 0) {
        const clean = normalizeWhitespaceAndUnicode(rawValue);
        return { canonical: clean, masterId: null };
      }

      const match = matchCanonicalMasterValue(rawValue, index);
      if (match.status === 'AMBIGUOUS') {
        const list = match.ambiguousCandidates.map((c) => `"${c.name}" (${c.id})`).join(', ');
        errors.push(
          `Ambiguous ${MASTER_FIELD_LABELS[field]} "${match.trimmedValue}": matches multiple existing master records (${list}). Resolve duplicate master records before importing.`
        );
        recordAmbiguity(field, match.originalValue, rowNum, match.ambiguousCandidates, rowAmbiguities);
        return { canonical: match.trimmedValue, masterId: null };
      }

      if (match.status === 'UNMATCHED') {
        const allowed = index.options.map((o) => o.name).join(', ');
        errors.push(`Invalid ${MASTER_FIELD_LABELS[field]} "${match.trimmedValue}". Allowed: ${allowed}`);
        return { canonical: match.trimmedValue, masterId: null };
      }

      if (wasProvidedInExcel) {
        normalizedFields[field] = {
          field,
          fieldLabel: MASTER_FIELD_LABELS[field],
          originalValue: match.originalValue,
          trimmedValue: match.trimmedValue,
          canonicalValue: match.canonicalValue!,
          masterId: match.masterId,
          wasNormalized: match.wasNormalized,
          caseNormalized: match.caseNormalized,
          whitespaceNormalized: match.whitespaceNormalized,
          matchedBy: match.matchedBy,
        };
      }

      return { canonical: match.canonicalValue!, masterId: match.masterId };
    };

    // Validation 4: Employee Type
    const resolvedType = resolveField(
      'employeeType',
      rawTypeOriginal,
      hasTypeCell,
      typeIndex,
      hasTypeCell || !isUpdate
    );

    // Validation 5: Employee Status
    const resolvedStatus = resolveField(
      'employeeStatus',
      rawStatusOriginal,
      hasStatusCell,
      statusIndex,
      hasStatusCell || !isUpdate
    );

    // Validation 6: Production Line / Floor
    const resolvedFloor = resolveField(
      'floor',
      rawFloorOriginal,
      hasFloorCell,
      floorIndex,
      (hasFloorCell || !isUpdate) && floorIndex.options.length > 0
    );

    // Validation 7: Section
    const resolvedSection = resolveField(
      'section',
      rawSecOriginal,
      hasSecCell,
      sectionIndex,
      (hasSecCell || !isUpdate) && sectionIndex.options.length > 0
    );

    // Validation 8: Department
    const resolvedDepartment = resolveField(
      'department',
      rawDeptOriginal,
      hasDeptCell,
      departmentIndex,
      (hasDeptCell || !isUpdate) && departmentIndex.options.length > 0
    );

    // Validation 9: Designation (controlled master if configured; else unambiguous existing designation normalization)
    let resolvedDesignationValue = normalizeWhitespaceAndUnicode(rawDesigOriginal) || 'Operator';
    let resolvedDesignationId: string | null = existing?.designationId ?? null;
    if (designationIndex && (hasDesigCell || !isUpdate)) {
      const resDesig = resolveField('designation', rawDesigOriginal, hasDesigCell, designationIndex, true);
      resolvedDesignationValue = resDesig.canonical;
      resolvedDesignationId = resDesig.masterId;
    } else if (hasDesigCell && employeeDesignationMap) {
      const key = normalizeMasterLookupKey(rawDesigOriginal);
      const canonicalFromExisting = employeeDesignationMap.get(key);
      if (canonicalFromExisting) {
        const trimmedDesig = normalizeWhitespaceAndUnicode(rawDesigOriginal);
        const whitespaceNorm = rawDesigOriginal !== trimmedDesig;
        const caseNorm = trimmedDesig !== canonicalFromExisting;
        resolvedDesignationValue = canonicalFromExisting;
        normalizedFields.designation = {
          field: 'designation',
          fieldLabel: MASTER_FIELD_LABELS.designation,
          originalValue: rawDesigOriginal,
          trimmedValue: trimmedDesig,
          canonicalValue: canonicalFromExisting,
          masterId: null,
          wasNormalized: whitespaceNorm || caseNorm,
          caseNormalized: caseNorm,
          whitespaceNormalized: whitespaceNorm,
          matchedBy: 'name',
        };
      }
    }

    if (errors.length > 0) {
      if (rowAmbiguities.length > 0) {
        ambiguousRowCount += 1;
      }
      invalidRows.push({
        rowNumber: rowNum,
        raw: {
          id: rawId,
          name: rawName,
          type: normalizeWhitespaceAndUnicode(rawTypeOriginal),
          section: normalizeWhitespaceAndUnicode(rawSecOriginal),
          dept: normalizeWhitespaceAndUnicode(rawDeptOriginal),
          floor: normalizeWhitespaceAndUnicode(rawFloorOriginal),
          designation: normalizeWhitespaceAndUnicode(rawDesigOriginal),
          status: normalizeWhitespaceAndUnicode(rawStatusOriginal),
        },
        errors,
        ...(rowAmbiguities.length > 0
          ? { hasAmbiguity: true, ambiguityDetails: rowAmbiguities }
          : {}),
      });
      continue;
    }

    // Track normalization metrics for valid rows
    const rowNormalizedEntries = Object.values(normalizedFields).filter(
      (f): f is FieldNormalizationInfo => Boolean(f && f.wasNormalized)
    );
    if (rowNormalizedEntries.length > 0) {
      caseNormalizedRowCount += 1;
      for (const entry of rowNormalizedEntries) {
        recordNormalizationSummary(entry);
      }
    }

    // Track explicitly included columns for safe partial updates on existing employees
    const includedFields: string[] = ['employeeName'];
    if (hasTypeCell) includedFields.push('employeeType');
    if (hasSecCell) includedFields.push('section');
    if (hasDeptCell) includedFields.push('department');
    if (hasFloorCell) includedFields.push('floor');
    if (hasDesigCell) includedFields.push('designation');
    if (hasStatusCell) includedFields.push('employeeStatus');

    // Determine if NEW, UPDATE, or UNCHANGED
    if (!existing) {
      const newEmp: Employee = {
        employeeId: rawId,
        employeeName: rawName,
        employeeType: (resolvedType.canonical as EmployeeType) || 'Permanent',
        section: resolvedSection.canonical,
        ...(resolvedSection.masterId ? { sectionId: resolvedSection.masterId } : {}),
        department: resolvedDepartment.canonical,
        ...(resolvedDepartment.masterId ? { departmentId: resolvedDepartment.masterId } : {}),
        floor: resolvedFloor.canonical,
        ...(resolvedFloor.masterId ? { floorId: resolvedFloor.masterId, lineId: resolvedFloor.masterId } : {}),
        designation: resolvedDesignationValue,
        ...(resolvedDesignationId ? { designationId: resolvedDesignationId } : {}),
        qrCodeToken: generateQrToken(rawId),
        employeeStatus: (resolvedStatus.canonical as EmployeeStatus) || 'Active',
        createdAt: now,
        updatedAt: now,
      };
      validRows.push({
        data: newEmp,
        actionType: 'NEW',
        rowNumber: rowNum,
        normalizedFields,
        includedFields: ['employeeName', 'employeeType', 'section', 'department', 'floor', 'designation', 'employeeStatus'],
      });
    } else {
      const finalType = hasTypeCell ? (resolvedType.canonical as EmployeeType) : existing.employeeType;
      const finalSection = hasSecCell ? resolvedSection.canonical : existing.section;
      const finalDepartment = hasDeptCell ? resolvedDepartment.canonical : existing.department;
      const finalFloor = hasFloorCell ? resolvedFloor.canonical : existing.floor;
      const finalDesignation = hasDesigCell ? resolvedDesignationValue : existing.designation;
      const finalStatus = hasStatusCell ? (resolvedStatus.canonical as EmployeeStatus) : existing.employeeStatus;

      const diffs: string[] = [];
      if (normalizeWhitespaceAndUnicode(existing.employeeName) !== rawName) {
        diffs.push(`Name: ${existing.employeeName} -> ${rawName}`);
      }
      if (hasTypeCell && existing.employeeType !== finalType) {
        diffs.push(`Type: ${existing.employeeType} -> ${finalType}`);
      }
      if (hasSecCell && existing.section !== finalSection) {
        diffs.push(`Section: ${existing.section} -> ${finalSection}`);
      }
      if (hasDeptCell && existing.department !== finalDepartment) {
        diffs.push(`Dept: ${existing.department} -> ${finalDepartment}`);
      }
      if (hasFloorCell && existing.floor !== finalFloor) {
        diffs.push(`Line: ${existing.floor} -> ${finalFloor}`);
      }
      if (hasDesigCell && existing.designation !== finalDesignation) {
        diffs.push(`Designation: ${existing.designation} -> ${finalDesignation}`);
      }
      if (hasStatusCell && existing.employeeStatus !== finalStatus) {
        diffs.push(`Status: ${existing.employeeStatus} -> ${finalStatus}`);
      }

      const updatedEmp: Employee = {
        ...existing,
        // Preserve existing canonical Employee ID, QR token, and historical creation date!
        employeeId: existing.employeeId,
        employeeName: rawName,
        employeeType: finalType,
        section: finalSection,
        ...(hasSecCell && resolvedSection.masterId
          ? { sectionId: resolvedSection.masterId }
          : existing.sectionId
          ? { sectionId: existing.sectionId }
          : {}),
        department: finalDepartment,
        ...(hasDeptCell && resolvedDepartment.masterId
          ? { departmentId: resolvedDepartment.masterId }
          : existing.departmentId
          ? { departmentId: existing.departmentId }
          : {}),
        floor: finalFloor,
        ...(hasFloorCell && resolvedFloor.masterId
          ? { floorId: resolvedFloor.masterId, lineId: resolvedFloor.masterId }
          : existing.floorId
          ? { floorId: existing.floorId, lineId: existing.lineId || existing.floorId }
          : {}),
        designation: finalDesignation,
        ...(hasDesigCell && resolvedDesignationId
          ? { designationId: resolvedDesignationId }
          : existing.designationId
          ? { designationId: existing.designationId }
          : {}),
        employeeStatus: finalStatus,
        qrCodeToken: existing.qrCodeToken || generateQrToken(rawId),
        updatedAt: now,
      };

      if (diffs.length > 0) {
        validRows.push({
          data: updatedEmp,
          actionType: 'UPDATE',
          diffs,
          rowNumber: rowNum,
          normalizedFields,
          includedFields,
        });
      } else {
        validRows.push({
          data: updatedEmp,
          actionType: 'UNCHANGED',
          rowNumber: rowNum,
          normalizedFields,
          includedFields,
        });
      }
    }
  }

  const newCount = validRows.filter((r) => r.actionType === 'NEW').length;
  const updatedCount = validRows.filter((r) => r.actionType === 'UPDATE').length;
  const unchangedCount = validRows.filter((r) => r.actionType === 'UNCHANGED').length;
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
    normalizationSummary: Array.from(normalizationSummaryMap.values()),
    normalizedCellCount,
    caseNormalizedRowCount,
    ambiguousRowCount,
    ambiguities: Array.from(ambiguityMap.values()),
  };
}

// 3. Commit Validated Rows via Authenticated Server Admin SDK API
export async function commitImportedEmployees(
  items: ImportValidationResult['validRows'],
  fileName: string
): Promise<EmployeeImportCommitResult> {
  const unchangedItems = items.filter((item) => item.actionType === 'UNCHANGED');
  const toSave = items.filter((item) => item.actionType !== 'UNCHANGED');

  if (toSave.length === 0) {
    return {
      savedCount: 0,
      insertedCount: 0,
      updatedCount: 0,
      skippedCount: unchangedItems.length,
      failedCount: 0,
      committedIds: [],
      insertedIds: [],
      updatedIds: [],
      skippedIds: unchangedItems.map((i) => i.data.employeeId),
      failedRows: [],
      partialCommit: false,
    };
  }

  if (!auth.currentUser) {
    throw new EmployeeImportCommitError(
      'Your authentication session is not active. Please sign in again before importing employees.',
      {
        category: 'AUTHENTICATION',
        code: 'AUTH_SESSION_REQUIRED',
        status: 401,
        skippedCount: unchangedItems.length,
        failedCount: toSave.length,
      }
    );
  }

  assertApiBaseConfigured();
  const headers = await getAuthHeaders();
  if (!headers.Authorization) {
    throw new EmployeeImportCommitError(
      'Unable to obtain a verified Firebase authentication token. Please sign out and sign in again.',
      {
        category: 'AUTHENTICATION',
        code: 'AUTH_TOKEN_MISSING',
        status: 401,
        skippedCount: unchangedItems.length,
        failedCount: toSave.length,
      }
    );
  }

  const payloadRows = toSave.map((item) => {
    const inc = item.includedFields && item.actionType === 'UPDATE' ? new Set(item.includedFields) : null;
    const rowPayload: Record<string, any> = {
      employeeId: item.data.employeeId,
      ...(typeof item.rowNumber === 'number' ? { rowNumber: item.rowNumber } : {}),
    };

    if (!inc || inc.has('employeeName')) rowPayload.employeeName = item.data.employeeName;
    if (!inc || inc.has('employeeType')) rowPayload.employeeType = item.data.employeeType;
    if (!inc || inc.has('section')) {
      rowPayload.section = item.data.section;
      if (item.data.sectionId) rowPayload.sectionId = item.data.sectionId;
    }
    if (!inc || inc.has('department')) {
      rowPayload.department = item.data.department;
      if (item.data.departmentId) rowPayload.departmentId = item.data.departmentId;
    }
    if (!inc || inc.has('floor')) {
      rowPayload.floor = item.data.floor;
      if (item.data.floorId) rowPayload.floorId = item.data.floorId;
      if (item.data.lineId) rowPayload.lineId = item.data.lineId;
    }
    if (!inc || inc.has('designation')) {
      rowPayload.designation = item.data.designation;
      if (item.data.designationId) rowPayload.designationId = item.data.designationId;
    }
    if (!inc || inc.has('employeeStatus')) rowPayload.employeeStatus = item.data.employeeStatus;

    return rowPayload;
  });

  let res: Response;
  try {
    res = await executeApiFetch(
      apiUrl('/api/employees/bulk-import'),
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          fileName: fileName || 'employee_import.xlsx',
          rows: payloadRows,
        }),
      },
      'POST /api/employees/bulk-import',
      { timeoutMs: 30000 }
    );
  } catch (networkErr: any) {
    throw new EmployeeImportCommitError(
      networkErr?.message ||
        'Network or timeout error while contacting the import server. Refresh Employee Master before retrying.',
      {
        category: 'NETWORK_OR_TIMEOUT',
        code: 'NETWORK_OR_TIMEOUT',
        skippedCount: unchangedItems.length,
        failedCount: toSave.length,
      }
    );
  }

  const parsed = await safeParseJsonResponse<any>(res, 'POST /api/employees/bulk-import');
  const data = parsed.data || {};

  if (!parsed.ok) {
    let category: ImportFailureCategory = 'DATABASE_WRITE_ERROR';
    if (res.status === 401) category = 'AUTHENTICATION';
    else if (res.status === 403) category = 'AUTHORIZATION';
    else if (res.status === 400) category = 'VALIDATION';
    else if (data.category) category = data.category as ImportFailureCategory;

    throw new EmployeeImportCommitError(
      parsed.errorMessage || data.error || 'Failed to save imported employee records.',
      {
        category,
        code: data.code,
        status: res.status,
        partialCommit: Boolean(data.partialCommit),
        savedCount: Number(data.savedCount || 0),
        insertedCount: Number(data.insertedCount || 0),
        updatedCount: Number(data.updatedCount || 0),
        skippedCount: Number(data.skippedCount ?? unchangedItems.length),
        failedCount: Number(data.failedCount ?? toSave.length),
        committedIds: Array.isArray(data.committedIds) ? data.committedIds : [],
        failedRows: Array.isArray(data.failedRows) ? data.failedRows : [],
      }
    );
  }

  return {
    savedCount: Number(data.savedCount || 0),
    insertedCount: Number(data.insertedCount || 0),
    updatedCount: Number(data.updatedCount || 0),
    skippedCount: Number(data.skippedCount || 0) + unchangedItems.length,
    failedCount: Number(data.failedCount || 0),
    committedIds: Array.isArray(data.committedIds) ? data.committedIds : [],
    insertedIds: Array.isArray(data.insertedIds) ? data.insertedIds : [],
    updatedIds: Array.isArray(data.updatedIds) ? data.updatedIds : [],
    skippedIds: [
      ...unchangedItems.map((i) => i.data.employeeId),
      ...(Array.isArray(data.skippedIds) ? data.skippedIds : []),
    ],
    failedRows: Array.isArray(data.failedRows) ? data.failedRows : [],
    partialCommit: Boolean(data.partialCommit),
  };
}

// 4. Export Generic Table Data to Premium Styled Excel (.xlsx) & CSV
export interface ExcelExportMetadata {
  reportTitle?: string;
  reportType?: string;
  periodLabel?: string;
  sheetName?: string;
  summary?: AttendanceReportSummary | null;
  generatedAtIso?: string;
}

export async function buildExcelWorkbookBuffer(
  data: Record<string, any>[],
  columns: { header: string; key: string }[],
  sheetNameOrOptions: string | ExcelExportMetadata = 'Report'
): Promise<ArrayBuffer> {
  const meta: ExcelExportMetadata =
    typeof sheetNameOrOptions === 'string'
      ? { sheetName: sheetNameOrOptions, reportTitle: sheetNameOrOptions }
      : sheetNameOrOptions;

  const opts: PremiumExcelExportOptions = {
    rows: data,
    columns,
    fileName: meta.sheetName || 'NARID_Report',
    reportTitle: meta.reportTitle || meta.sheetName || 'Attendance Report',
    reportType: meta.reportType,
    periodLabel: meta.periodLabel,
    sheetName: meta.sheetName || meta.reportTitle || 'Report',
    summary: meta.summary,
    generatedAtIso: meta.generatedAtIso,
  };

  return buildPremiumExcelWorkbookBuffer(opts);
}

export async function exportTableToExcel(
  data: Record<string, any>[],
  columns: { header: string; key: string }[],
  fileName: string,
  metadata?: ExcelExportMetadata
): Promise<void> {
  await downloadPremiumExcelWorkbook({
    rows: data,
    columns,
    fileName,
    reportTitle: metadata?.reportTitle || fileName.replace(/_/g, ' '),
    reportType: metadata?.reportType,
    periodLabel: metadata?.periodLabel,
    sheetName: metadata?.sheetName || metadata?.reportTitle || 'Report',
    summary: metadata?.summary,
    generatedAtIso: metadata?.generatedAtIso,
  });
}

function escapeCsvCell(value: unknown): string {
  const s = String(value ?? '');
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function buildCsvContent(
  data: Record<string, any>[],
  columns: { header: string; key: string }[]
): string {
  const lines: string[] = [columns.map((c) => escapeCsvCell(c.header)).join(',')];
  for (const row of data) {
    lines.push(columns.map((c) => escapeCsvCell(row[c.key])).join(','));
  }
  return lines.join('\r\n');
}

export function exportTableToCsv(
  data: Record<string, any>[],
  columns: { header: string; key: string }[],
  fileName: string
): void {
  const csv = buildCsvContent(data, columns);

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
