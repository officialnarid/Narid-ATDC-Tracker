import express, { type Request, type Response } from 'express';
import crypto from 'crypto';
import QRCode from 'qrcode';
import { z } from 'zod';
import { isFirestorePermissionDeniedError } from './serverFirebaseAdmin.ts';
import {
  type AdminDocRefLike,
  type AdminFirestoreLike,
  type VerifiedCaller,
  hashQrTokenReference,
  recordEnterpriseAuditEvent,
  sanitizeEmployeeForApi,
} from './serverSecurityAudit.ts';
import { getCachedRolePermissionsDoc } from './serverPerfCache.ts';
import {
  recordDbOpMetric,
  recordImportExportTelemetry,
  recordActivityTelemetry,
  recordErrorTelemetry,
} from './serverMonitoring.ts';

import {
  type AmbiguousMasterConflict,
  type MasterFieldKey,
  type MasterRecordOption,
  CANONICAL_EMPLOYEE_STATUSES,
  CANONICAL_EMPLOYEE_TYPES,
  DEFAULT_CANONICAL_DEPARTMENTS,
  DEFAULT_CANONICAL_FLOORS,
  DEFAULT_CANONICAL_SECTIONS,
  MASTER_FIELD_LABELS,
  buildMasterLookupIndex,
  buildUnambiguousDesignationMapFromEmployees,
  matchCanonicalMasterValue,
  normalizeMasterLookupKey,
  normalizeWhitespaceAndUnicode,
} from './src/utils/excelMasterNormalizer.ts';

export const EMPLOYEE_ID_PATTERN = /^[A-Za-z0-9_.\-]+$/;
export const EMPLOYEE_BULK_BATCH_SIZE = 400; // Strictly below Firestore's 500 writes/batch limit

const BulkImportRowSchema = z.object({
  employeeId: z
    .string()
    .trim()
    .min(1, 'Employee ID is required.')
    .max(128, 'Employee ID must be 128 characters or fewer.')
    .regex(
      EMPLOYEE_ID_PATTERN,
      'Employee ID may only contain letters, numbers, underscores (_), hyphens (-), and periods (.).'
    ),
  employeeName: z
    .string()
    .trim()
    .min(1, 'Employee Name is required.')
    .max(200, 'Employee Name must be 200 characters or fewer.')
    .optional(),
  employeeType: z.string().trim().min(1).max(60).optional(),
  section: z.string().trim().min(1, 'Section is required.').max(100).optional(),
  sectionId: z.string().trim().min(1).max(128).optional(),
  department: z.string().trim().min(1, 'Department is required.').max(100).optional(),
  departmentId: z.string().trim().min(1).max(128).optional(),
  floor: z.string().trim().min(1, 'Production Line is required.').max(100).optional(),
  floorId: z.string().trim().min(1).max(128).optional(),
  line: z.string().trim().min(1).max(100).optional(),
  lineId: z.string().trim().min(1).max(128).optional(),
  designation: z.string().trim().min(1).max(120).optional(),
  designationId: z.string().trim().min(1).max(128).optional(),
  employeeStatus: z.string().trim().min(1).max(60).optional(),
  rowNumber: z.number().int().positive().optional(),
});

const BulkImportRequestSchema = z.object({
  fileName: z.string().trim().min(1, 'File name is required.').max(255),
  rows: z
    .array(BulkImportRowSchema)
    .min(1, 'At least one employee row is required for import.')
    .max(2000, 'A single import request supports up to 2,000 employee rows.'),
});

function generateServerQrToken(employeeId: string): string {
  const rand = crypto.randomBytes(12).toString('hex').toUpperCase();
  const ts = Date.now().toString(36).toUpperCase();
  return `QR_${employeeId}_${ts}_${rand}`;
}

const ADMIN_EXCEL_DEFAULTS: Record<string, { view: boolean; add: boolean; edit: boolean; delete: boolean }> = {
  excel_import: { view: true, add: true, edit: true, delete: false },
  employees: { view: true, add: true, edit: true, delete: false },
};

function evalModuleAction(
  caller: VerifiedCaller,
  userPermData: Record<string, any> | undefined,
  rolePermData: Record<string, any> | undefined,
  moduleKey: 'excel_import' | 'employees',
  action: 'view' | 'add' | 'edit' | 'delete'
): boolean {
  if (caller.role === 'super_admin') return true;

  if (userPermData && userPermData.isCustomOverride !== false) {
    const mod = userPermData.permissions?.[moduleKey];
    if (mod && typeof mod[action] === 'boolean') {
      return mod[action] === true && (action === 'view' || mod.view !== false);
    }
  }

  if (rolePermData) {
    const mod = rolePermData.modulePermissions?.[moduleKey];
    if (mod && typeof mod[action] === 'boolean') {
      return mod[action] === true && (action === 'view' || mod.view !== false);
    }
  }

  if (caller.role === 'admin') {
    return Boolean(ADMIN_EXCEL_DEFAULTS[moduleKey]?.[action]);
  }

  return false;
}

const BulkEmployeeActionSchema = z.object({
  action: z.enum(['ACTIVATE', 'DEACTIVATE', 'DELETE']),
  employeeIds: z
    .array(z.string().trim().min(1).max(128))
    .min(1, 'At least one Employee ID is required.')
    .max(1000, 'Bulk action supports up to 1,000 employees per request.'),
  confirmed: z.literal(true, {
    message: 'Explicit confirmation is required before executing bulk employee actions.',
  }),
  confirmPhrase: z.string().trim().optional(),
  reason: z.string().trim().max(300).optional(),
});

async function resolveCallerEmployeeActionPermissions(
  db: AdminFirestoreLike,
  caller: VerifiedCaller
): Promise<{ canView: boolean; canEdit: boolean; canDelete: boolean }> {
  if (caller.role === 'super_admin') {
    return { canView: true, canEdit: true, canDelete: true };
  }
  try {
    const [userPermSnap, rolePermSnap] = await Promise.all([
      caller.prefetchedUserPermSnap
        ? Promise.resolve(caller.prefetchedUserPermSnap)
        : db.collection('user_permissions').doc(caller.profileDocId).get(),
      getCachedRolePermissionsDoc(db, caller.role),
    ]);
    const userPermData = userPermSnap.exists ? userPermSnap.data() : undefined;
    const rolePermData = rolePermSnap.exists ? rolePermSnap.data : undefined;
    const canView = evalModuleAction(caller, userPermData, rolePermData, 'employees', 'view');
    const canEdit = canView && evalModuleAction(caller, userPermData, rolePermData, 'employees', 'edit');
    const canDelete = canView && evalModuleAction(caller, userPermData, rolePermData, 'employees', 'delete');
    return { canView, canEdit, canDelete };
  } catch (err: any) {
    console.warn('[Employee Bulk Action Permission Guard] Lookup failed; failing closed:', err?.message || err);
    return { canView: false, canEdit: false, canDelete: false };
  }
}

async function resolveCallerEmployeeImportPermissions(
  db: AdminFirestoreLike,
  caller: VerifiedCaller
): Promise<{ canAdd: boolean; canEdit: boolean }> {
  if (caller.role === 'super_admin') {
    return { canAdd: true, canEdit: true };
  }

  try {
    const [userPermSnap, rolePermSnap] = await Promise.all([
      caller.prefetchedUserPermSnap
        ? Promise.resolve(caller.prefetchedUserPermSnap)
        : db.collection('user_permissions').doc(caller.profileDocId).get(),
      getCachedRolePermissionsDoc(db, caller.role),
    ]);

    const userPermData = userPermSnap.exists ? userPermSnap.data() : undefined;
    const rolePermData = rolePermSnap.exists ? rolePermSnap.data : undefined;

    const canImportView = evalModuleAction(caller, userPermData, rolePermData, 'excel_import', 'view');
    const canImportAdd = evalModuleAction(caller, userPermData, rolePermData, 'excel_import', 'add');
    const canImportEdit = evalModuleAction(caller, userPermData, rolePermData, 'excel_import', 'edit');

    const canEmpAdd = evalModuleAction(caller, userPermData, rolePermData, 'employees', 'add');
    const canEmpEdit = evalModuleAction(caller, userPermData, rolePermData, 'employees', 'edit');

    return {
      canAdd: canImportView && canImportAdd && canEmpAdd,
      canEdit: canImportView && canImportEdit && canEmpEdit,
    };
  } catch (err: any) {
    console.warn('[Employee Import Permission Guard] Lookup failed; failing closed:', err?.message || err);
    return { canAdd: false, canEdit: false };
  }
}

function classifyBatchWriteError(err: unknown): {
  status: number;
  code: string;
  category: 'DATABASE_AUTHORIZATION' | 'NETWORK_OR_TIMEOUT' | 'DATABASE_WRITE_ERROR';
  message: string;
} {
  const rawMsg = err instanceof Error ? err.message : String(err || 'Unknown database error');
  const lower = rawMsg.toLowerCase();

  if (isFirestorePermissionDeniedError(err)) {
    return {
      status: 503,
      code: 'FIRESTORE_ADMIN_PERMISSION_DENIED',
      category: 'DATABASE_AUTHORIZATION',
      message:
        'Database authorization failed on server Admin SDK credentials. Contact Super Admin / infrastructure administrator.',
    };
  }

  if (
    lower.includes('deadline') ||
    lower.includes('timeout') ||
    lower.includes('unavailable') ||
    lower.includes('econnreset') ||
    lower.includes('network')
  ) {
    return {
      status: 503,
      code: 'FIRESTORE_TEMPORARY_UNAVAILABLE',
      category: 'NETWORK_OR_TIMEOUT',
      message:
        'Database connection timed out or became temporarily unavailable during batch commit. Verify committed counts before retrying remaining rows.',
    };
  }

  return {
    status: 500,
    code: 'BATCH_COMMIT_FAILED',
    category: 'DATABASE_WRITE_ERROR',
    message: rawMsg || 'Database batch write failed.',
  };
}

export interface EmployeeRoutesDeps {
  db: AdminFirestoreLike;
  requireVerifiedCaller: (
    req: Request,
    res: Response,
    allowedRoles: string[] | '*',
    actionLabel: string,
    options?: { prefetchUserPermission?: boolean }
  ) => Promise<VerifiedCaller | null>;
}

export function registerEmployeeRoutes(app: express.Express, deps: EmployeeRoutesDeps) {
  const { db, requireVerifiedCaller } = deps;

  // ==========================================================================
  // POST /api/employees/bulk-import
  // Authenticated, RBAC-enforced, atomic chunked Admin SDK employee import
  // ==========================================================================
  app.post('/api/employees/bulk-import', async (req: Request, res: Response) => {
    const routeStartMs = performance.now();
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        '*',
        'Employee Master Excel Bulk Import',
        { prefetchUserPermission: true }
      );
      if (!caller) return;

      const perms = await resolveCallerEmployeeImportPermissions(db, caller);
      if (!perms.canAdd && !perms.canEdit) {
        await recordEnterpriseAuditEvent(db, {
          req,
          action: 'unauthorized_access_attempt',
          category: 'SECURITY',
          severity: 'CRITICAL',
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: caller.role.toUpperCase(),
          targetType: 'EMPLOYEE_IMPORT',
          targetId: '/api/employees/bulk-import',
          actionSource: 'EMPLOYEE_IMPORT_RBAC_GUARD',
          description: `User "${caller.loginId}" (${caller.role}) blocked from Employee Master Excel import due to missing excel_import/employees write permissions.`,
          success: false,
        });
        return res.status(403).json({
          success: false,
          code: 'IMPORT_FORBIDDEN',
          category: 'AUTHORIZATION',
          error: `Forbidden: Role "${caller.role.toUpperCase()}" is not authorized to import or update Employee Master records.`,
        });
      }

      const parsed = BulkImportRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const firstIssue = parsed.error.issues[0];
        return res.status(400).json({
          success: false,
          code: 'VALIDATION_ERROR',
          category: 'VALIDATION',
          error: firstIssue?.message || 'Invalid employee import payload.',
          issues: parsed.error.issues.slice(0, 10).map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        });
      }

      const { fileName, rows } = parsed.data;

      // Reject duplicate Employee IDs inside the submitted payload deterministically
      const seenIds = new Set<string>();
      const duplicateIds: string[] = [];
      for (const row of rows) {
        const cleanId = row.employeeId.trim().toUpperCase();
        if (seenIds.has(cleanId)) {
          duplicateIds.push(cleanId);
        } else {
          seenIds.add(cleanId);
        }
      }
      if (duplicateIds.length > 0) {
        return res.status(400).json({
          success: false,
          code: 'DUPLICATE_EMPLOYEE_IDS_IN_PAYLOAD',
          category: 'VALIDATION',
          error: `Duplicate Employee ID(s) found in import batch: ${Array.from(new Set(duplicateIds)).slice(0, 5).join(', ')}`,
          duplicateIds: Array.from(new Set(duplicateIds)),
        });
      }

      // Fetch existing employees and authoritative master collections in parallel via Admin SDK
      const [existingSnap, floorsSnap, sectionsSnap, departmentsSnap, designationsSnap] =
        await Promise.all([
          db.collection('employees').get(),
          db.collection('floors').get(),
          db.collection('sections').get(),
          db.collection('departments').get(),
          db.collection('designations').get(),
        ]);

      const extractMasterRecords = (
        snap: { docs: Array<{ id: string; data: () => Record<string, any> | undefined }> },
        fallback: MasterRecordOption[]
      ): MasterRecordOption[] => {
        if (!snap.docs || snap.docs.length === 0) return fallback;
        return snap.docs
          .map((d) => {
            const data = d.data() || {};
            return {
              id: String(data.id || d.id),
              name: String(data.name || ''),
              code: data.code ? String(data.code) : undefined,
              status: data.status ? String(data.status) : undefined,
            };
          })
          .filter((item) => Boolean(item.name.trim()));
      };

      const floorMasterRecords = extractMasterRecords(floorsSnap, DEFAULT_CANONICAL_FLOORS);
      const sectionMasterRecords = extractMasterRecords(sectionsSnap, DEFAULT_CANONICAL_SECTIONS);
      const departmentMasterRecords = extractMasterRecords(
        departmentsSnap,
        DEFAULT_CANONICAL_DEPARTMENTS
      );
      const designationMasterRecords = extractMasterRecords(designationsSnap, []);

      const typeIndex = buildMasterLookupIndex(CANONICAL_EMPLOYEE_TYPES);
      const statusIndex = buildMasterLookupIndex(CANONICAL_EMPLOYEE_STATUSES);
      const floorIndex = buildMasterLookupIndex(floorMasterRecords);
      const sectionIndex = buildMasterLookupIndex(sectionMasterRecords);
      const departmentIndex = buildMasterLookupIndex(departmentMasterRecords);
      const designationIndex =
        designationMasterRecords.length > 0
          ? buildMasterLookupIndex(designationMasterRecords)
          : null;

      const existingByUpperId = new Map<string, { docId: string; data: Record<string, any> }>();
      const existingEmployeesList: Array<{ designation?: string | null }> = [];
      for (const d of existingSnap.docs) {
        const data = d.data() || {};
        existingEmployeesList.push({ designation: data.designation });
        const key = String(data.employeeId || d.id).trim().toUpperCase();
        if (key) {
          existingByUpperId.set(key, { docId: d.id, data });
        }
        const docIdUpper = String(d.id).trim().toUpperCase();
        if (docIdUpper && !existingByUpperId.has(docIdUpper)) {
          existingByUpperId.set(docIdUpper, { docId: d.id, data });
        }
      }
      const employeeDesignationMap = !designationIndex
        ? buildUnambiguousDesignationMapFromEmployees(existingEmployeesList)
        : null;

      const now = new Date().toISOString();
      interface PreparedOp {
        actionType: 'NEW' | 'UPDATE';
        employeeId: string;
        rowNumber?: number;
        ref: AdminDocRefLike;
        payload: Record<string, any>;
      }

      const operations: PreparedOp[] = [];
      const skippedIds: string[] = [];
      const validationErrors: Array<{
        employeeId: string;
        rowNumber?: number;
        code: 'AMBIGUOUS_MASTER_MATCH' | 'INVALID_MASTER_VALUE' | 'MASTER_ID_MISMATCH' | 'VALIDATION_ERROR';
        error: string;
      }> = [];
      const ambiguities: AmbiguousMasterConflict[] = [];
      let normalizedCount = 0;
      let normalizedFieldsCount = 0;

      for (const row of rows) {
        const cleanId = row.employeeId.trim().toUpperCase();
        const existing = existingByUpperId.get(cleanId);
        const isUpdate = Boolean(existing);

        const rowErrors: Array<{
          code: 'AMBIGUOUS_MASTER_MATCH' | 'INVALID_MASTER_VALUE' | 'MASTER_ID_MISMATCH' | 'VALIDATION_ERROR';
          error: string;
        }> = [];
        let rowWasNormalized = false;

        // Preserve free-text Employee Name capitalization (NFC + trim + collapse repeated whitespace)
        const providedName =
          row.employeeName !== undefined ? normalizeWhitespaceAndUnicode(row.employeeName) : undefined;
        if (!isUpdate && !providedName) {
          rowErrors.push({ code: 'VALIDATION_ERROR', error: 'Employee Name is required for new employee.' });
        }

        const resolveBackendMaster = (
          field: MasterFieldKey,
          rawVal: string | undefined,
          clientMasterId: string | undefined,
          index: ReturnType<typeof buildMasterLookupIndex>,
          requiredForNew: boolean
        ): { provided: boolean; canonical?: string; masterId?: string | null } => {
          if (rawVal === undefined) {
            if (!isUpdate && requiredForNew) {
              rowErrors.push({
                code: 'VALIDATION_ERROR',
                error: `${MASTER_FIELD_LABELS[field]} is required for new employee.`,
              });
            }
            return { provided: false };
          }

          const match = matchCanonicalMasterValue(rawVal, index);
          if (match.status === 'AMBIGUOUS') {
            const list = match.ambiguousCandidates.map((c) => `"${c.name}" (${c.id})`).join(', ');
            rowErrors.push({
              code: 'AMBIGUOUS_MASTER_MATCH',
              error: `Ambiguous ${MASTER_FIELD_LABELS[field]} "${match.trimmedValue}": matches multiple existing master records (${list}). Resolve duplicate master records before importing.`,
            });
            ambiguities.push({
              field,
              fieldLabel: MASTER_FIELD_LABELS[field],
              excelValue: match.originalValue,
              rowNumbers: row.rowNumber ? [row.rowNumber] : [],
              candidates: match.ambiguousCandidates,
            });
            return { provided: true };
          }

          if (match.status === 'UNMATCHED' || !match.canonicalValue) {
            rowErrors.push({
              code: 'INVALID_MASTER_VALUE',
              error: `Invalid ${MASTER_FIELD_LABELS[field]} "${match.trimmedValue}". Must match an existing website master record.`,
            });
            return { provided: true };
          }

          // Validate client-provided master ID against server-resolved canonical master ID
          if (
            clientMasterId !== undefined &&
            match.masterId !== null &&
            clientMasterId.trim() !== match.masterId
          ) {
            rowErrors.push({
              code: 'MASTER_ID_MISMATCH',
              error: `${MASTER_FIELD_LABELS[field]} ID "${clientMasterId}" does not match canonical master record "${match.canonicalValue}" (${match.masterId}).`,
            });
            return { provided: true };
          }

          if (match.wasNormalized) {
            rowWasNormalized = true;
            normalizedFieldsCount += 1;
          }

          return {
            provided: true,
            canonical: match.canonicalValue,
            masterId: match.masterId,
          };
        };

        const rawFloorInput = row.floor ?? row.line;
        const clientFloorId = row.floorId ?? row.lineId;

        const resType = resolveBackendMaster('employeeType', row.employeeType, undefined, typeIndex, true);
        const resStatus = resolveBackendMaster('employeeStatus', row.employeeStatus, undefined, statusIndex, true);
        const resSection = resolveBackendMaster('section', row.section, row.sectionId, sectionIndex, true);
        const resDepartment = resolveBackendMaster('department', row.department, row.departmentId, departmentIndex, true);
        const resFloor = resolveBackendMaster('floor', rawFloorInput, clientFloorId, floorIndex, true);

        let resDesignation: { provided: boolean; canonical?: string; masterId?: string | null };
        if (designationIndex) {
          resDesignation = resolveBackendMaster(
            'designation',
            row.designation ?? (!isUpdate ? 'Operator' : undefined),
            row.designationId,
            designationIndex,
            false
          );
        } else if (row.designation !== undefined) {
          const trimmedDesig = normalizeWhitespaceAndUnicode(row.designation);
          const mappedDesig = employeeDesignationMap?.get(normalizeMasterLookupKey(trimmedDesig));
          const finalDesig = mappedDesig || trimmedDesig || 'Operator';
          if (finalDesig !== row.designation) {
            rowWasNormalized = true;
            normalizedFieldsCount += 1;
          }
          resDesignation = { provided: true, canonical: finalDesig, masterId: null };
        } else if (!isUpdate) {
          resDesignation = { provided: true, canonical: 'Operator', masterId: null };
        } else {
          resDesignation = { provided: false };
        }

        if (rowErrors.length > 0) {
          const primaryCode = rowErrors.some((e) => e.code === 'AMBIGUOUS_MASTER_MATCH')
            ? 'AMBIGUOUS_MASTER_MATCH'
            : rowErrors[0].code;
          validationErrors.push({
            employeeId: cleanId,
            rowNumber: row.rowNumber,
            code: primaryCode,
            error: rowErrors.map((e) => e.error).join(' | '),
          });
          continue;
        }

        if (rowWasNormalized) {
          normalizedCount += 1;
        }

        if (!existing) {
          const newPayload: Record<string, any> = {
            employeeId: cleanId,
            employeeName: providedName!,
            employeeType: resType.canonical!,
            section: resSection.canonical!,
            department: resDepartment.canonical!,
            floor: resFloor.canonical!,
            designation: resDesignation.canonical || 'Operator',
            qrCodeToken: generateServerQrToken(cleanId),
            employeeStatus: resStatus.canonical!,
            createdAt: now,
            updatedAt: now,
          };
          if (resSection.masterId) newPayload.sectionId = resSection.masterId;
          if (resDepartment.masterId) newPayload.departmentId = resDepartment.masterId;
          if (resFloor.masterId) {
            newPayload.floorId = resFloor.masterId;
            newPayload.lineId = resFloor.masterId;
          }
          if (resDesignation.masterId) newPayload.designationId = resDesignation.masterId;

          operations.push({
            actionType: 'NEW',
            employeeId: cleanId,
            rowNumber: row.rowNumber,
            ref: db.collection('employees').doc(cleanId),
            payload: newPayload,
          });
          continue;
        }

        // EXISTING EMPLOYEE UPDATE: strictly preserve omitted fields, Employee ID, QR token, createdAt, and unrelated data
        const prev = existing.data;
        const nextName = providedName !== undefined ? providedName : String(prev.employeeName || '');
        const nextType = resType.provided ? resType.canonical! : String(prev.employeeType || '');
        const nextSection = resSection.provided ? resSection.canonical! : String(prev.section || '');
        const nextDepartment = resDepartment.provided ? resDepartment.canonical! : String(prev.department || '');
        const nextFloor = resFloor.provided ? resFloor.canonical! : String(prev.floor || '');
        const nextDesignation = resDesignation.provided ? resDesignation.canonical! : String(prev.designation || '');
        const nextStatus = resStatus.provided ? resStatus.canonical! : String(prev.employeeStatus || '');

        const hasChanged =
          normalizeWhitespaceAndUnicode(prev.employeeName) !== nextName ||
          String(prev.employeeType || '') !== nextType ||
          String(prev.section || '').trim() !== nextSection ||
          String(prev.department || '').trim() !== nextDepartment ||
          String(prev.floor || '').trim() !== nextFloor ||
          String(prev.designation || '').trim() !== nextDesignation ||
          String(prev.employeeStatus || '') !== nextStatus;

        if (!hasChanged) {
          skippedIds.push(cleanId);
          continue;
        }

        const updatedPayload: Record<string, any> = {
          ...prev,
          // Preserve canonical existing Employee ID, QR security token, and historical creation date
          employeeId: String(prev.employeeId || cleanId),
          employeeName: nextName,
          employeeType: nextType,
          section: nextSection,
          department: nextDepartment,
          floor: nextFloor,
          designation: nextDesignation,
          qrCodeToken: prev.qrCodeToken || generateServerQrToken(cleanId),
          employeeStatus: nextStatus,
          createdAt: prev.createdAt || now,
          updatedAt: now,
        };
        if (resSection.provided && resSection.masterId) updatedPayload.sectionId = resSection.masterId;
        if (resDepartment.provided && resDepartment.masterId) updatedPayload.departmentId = resDepartment.masterId;
        if (resFloor.provided && resFloor.masterId) {
          updatedPayload.floorId = resFloor.masterId;
          updatedPayload.lineId = resFloor.masterId;
        }
        if (resDesignation.provided && resDesignation.masterId) {
          updatedPayload.designationId = resDesignation.masterId;
        }

        operations.push({
          actionType: 'UPDATE',
          employeeId: cleanId,
          rowNumber: row.rowNumber,
          ref: db.collection('employees').doc(existing.docId),
          payload: updatedPayload,
        });
      }

      if (validationErrors.length > 0) {
        const hasAmbiguity = validationErrors.some((e) => e.code === 'AMBIGUOUS_MASTER_MATCH');
        const hasIdMismatch = validationErrors.some((e) => e.code === 'MASTER_ID_MISMATCH');
        const primaryCode = hasAmbiguity
          ? 'AMBIGUOUS_MASTER_MATCH'
          : hasIdMismatch
          ? 'MASTER_ID_MISMATCH'
          : validationErrors[0].code;

        return res.status(400).json({
          success: false,
          code: primaryCode,
          category: 'VALIDATION',
          error: validationErrors[0].error,
          partialCommit: false,
          savedCount: 0,
          insertedCount: 0,
          updatedCount: 0,
          skippedCount: 0,
          failedCount: validationErrors.length,
          committedIds: [],
          failedRows: validationErrors.map((e) => ({
            employeeId: e.employeeId,
            rowNumber: e.rowNumber,
            error: e.error,
          })),
          ambiguities,
        });
      }

      const needsInsert = operations.some((op) => op.actionType === 'NEW');
      const needsUpdate = operations.some((op) => op.actionType === 'UPDATE');

      if ((needsInsert && !perms.canAdd) || (needsUpdate && !perms.canEdit)) {
        await recordEnterpriseAuditEvent(db, {
          req,
          action: 'unauthorized_access_attempt',
          category: 'SECURITY',
          severity: 'CRITICAL',
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: caller.role.toUpperCase(),
          targetType: 'EMPLOYEE_IMPORT',
          targetId: '/api/employees/bulk-import',
          actionSource: 'EMPLOYEE_IMPORT_RBAC_GUARD',
          description: `User "${caller.loginId}" (${caller.role}) attempted unauthorized employee import action (needsInsert=${needsInsert}, needsUpdate=${needsUpdate}).`,
          success: false,
        });
        return res.status(403).json({
          success: false,
          code: 'IMPORT_ACTION_FORBIDDEN',
          category: 'AUTHORIZATION',
          error: 'Forbidden: Missing permission for the requested employee insert/update operation.',
        });
      }

      const insertedIds: string[] = [];
      const updatedIds: string[] = [];
      const committedIds: string[] = [];
      const failedRows: Array<{
        employeeId: string;
        rowNumber?: number;
        actionType: 'NEW' | 'UPDATE';
        error: string;
      }> = [];

      // Commit atomically in chunks <= 400 ops (strictly below Firestore's 500-op batch cap)
      for (let i = 0; i < operations.length; i += EMPLOYEE_BULK_BATCH_SIZE) {
        const chunk = operations.slice(i, i + EMPLOYEE_BULK_BATCH_SIZE);
        try {
          if (typeof db.batch === 'function') {
            const batch = db.batch();
            for (const op of chunk) {
              batch.set(op.ref, op.payload);
            }
            await batch.commit();
          } else {
            await Promise.all(chunk.map((op) => op.ref.set(op.payload)));
          }

          for (const op of chunk) {
            committedIds.push(op.employeeId);
            if (op.actionType === 'NEW') {
              insertedIds.push(op.employeeId);
            } else {
              updatedIds.push(op.employeeId);
            }
          }
        } catch (batchErr: any) {
          const classified = classifyBatchWriteError(batchErr);
          const remainingOps = operations.slice(i);
          for (const rem of remainingOps) {
            failedRows.push({
              employeeId: rem.employeeId,
              rowNumber: rem.rowNumber,
              actionType: rem.actionType,
              error: classified.message,
            });
          }

          const partialCommit = committedIds.length > 0;
          await recordEnterpriseAuditEvent(db, {
            req,
            action: partialCommit ? 'EXCEL_EMPLOYEE_IMPORT_PARTIAL' : 'EXCEL_EMPLOYEE_IMPORT_FAILED',
            category: 'EMPLOYEE',
            severity: 'WARNING',
            actorUid: caller.uid,
            actorLoginId: caller.loginId,
            actorRole: caller.role.toUpperCase(),
            targetType: 'EMPLOYEE',
            targetId: fileName,
            newValue: `Committed ${committedIds.length} (New: ${insertedIds.length}, Updated: ${updatedIds.length}), Skipped: ${skippedIds.length}, Failed: ${failedRows.length} from ${fileName}`,
            actionSource: 'EXCEL_IMPORT',
            reason: classified.message,
            success: false,
          }).catch(() => {});

          const batchElapsedMs = Math.round((performance.now() - routeStartMs) * 100) / 100;
          recordDbOpMetric(db, {
            operation: 'BATCH',
            collection: 'employees',
            durationMs: batchElapsedMs,
            success: false,
            isPermissionDenied: isFirestorePermissionDeniedError(batchErr),
            isNetworkError: classified.category === 'NETWORK_OR_TIMEOUT',
            recordCount: chunk.length,
            errorMessage: classified.message,
            correlationId: (req as any).correlationId,
          });
          recordImportExportTelemetry(db, {
            type: 'EXCEL_IMPORT',
            module: 'Excel Import / Update',
            rowCount: rows.length,
            durationMs: batchElapsedMs,
            success: false,
            actorLoginId: caller.loginId,
            correlationId: (req as any).correlationId,
            detail: classified.message,
          });
          recordActivityTelemetry(db, {
            actorUid: caller.uid,
            actorLoginId: caller.loginId,
            actorRole: caller.role.toUpperCase(),
            action: 'EXCEL_IMPORT_FAILED',
            module: 'Excel Import / Update',
            result: 'Failed',
            correlationId: (req as any).correlationId,
            detail: `${fileName}: ${committedIds.length} committed, ${failedRows.length} failed`,
          });

          return res.status(classified.status).json({
            success: false,
            code: classified.code,
            category: classified.category,
            error: classified.message,
            partialCommit,
            savedCount: committedIds.length,
            insertedCount: insertedIds.length,
            updatedCount: updatedIds.length,
            skippedCount: skippedIds.length,
            failedCount: failedRows.length,
            committedIds,
            insertedIds,
            updatedIds,
            skippedIds,
            failedRows,
          });
        }
      }

      // Record compliance audit log after confirmed database commit
      await recordEnterpriseAuditEvent(db, {
        req,
        action: 'EXCEL_EMPLOYEE_IMPORT',
        category: 'EMPLOYEE',
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        targetType: 'EMPLOYEE',
        targetId: fileName,
        newValue: `Committed ${committedIds.length} employees (New: ${insertedIds.length}, Updated: ${updatedIds.length}, Skipped: ${skippedIds.length}) from ${fileName}`,
        actionSource: 'EXCEL_IMPORT',
        reason: `File upload: ${rows.length} validated rows`,
        success: true,
      });

      const totalImportMs = Math.round((performance.now() - routeStartMs) * 100) / 100;
      recordDbOpMetric(db, {
        operation: 'BATCH',
        collection: 'employees',
        durationMs: totalImportMs,
        success: true,
        recordCount: Math.max(1, operations.length),
        correlationId: (req as any).correlationId,
      });
      recordImportExportTelemetry(db, {
        type: 'EXCEL_IMPORT',
        module: 'Excel Import / Update',
        rowCount: rows.length,
        durationMs: totalImportMs,
        success: true,
        actorLoginId: caller.loginId,
        correlationId: (req as any).correlationId,
        detail: `${fileName}: ${insertedIds.length} inserted, ${updatedIds.length} updated, ${skippedIds.length} skipped`,
      });
      recordActivityTelemetry(db, {
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        action: 'EXCEL_IMPORT_COMMITTED',
        module: 'Excel Import / Update',
        result: 'Success',
        correlationId: (req as any).correlationId,
        detail: `${fileName} (${committedIds.length} committed)`,
      });

      return res.json({
        success: true,
        savedCount: committedIds.length,
        insertedCount: insertedIds.length,
        updatedCount: updatedIds.length,
        skippedCount: skippedIds.length,
        failedCount: 0,
        normalizedCount,
        normalizedFieldsCount,
        committedIds,
        insertedIds,
        updatedIds,
        skippedIds,
        failedRows: [],
        partialCommit: false,
      });
    } catch (err: any) {
      console.error('[Employee Bulk Import API] Error:', err);
      const classified = classifyBatchWriteError(err);
      recordErrorTelemetry(db, {
        source: 'IMPORT_EXPORT',
        module: 'Excel Import / Update',
        category: classified.code,
        severity: 'CRITICAL',
        message: classified.message,
        statusCode: classified.status,
        correlationId: (req as any).correlationId,
      });
      return res.status(classified.status).json({
        success: false,
        code: classified.code,
        category: classified.category,
        error: classified.message,
      });
    }
  });

  // ==========================================================================
  // POST /api/employees/bulk-action
  // Authenticated, RBAC-enforced chunked Admin SDK bulk ACTIVATE / DEACTIVATE / DELETE
  // with historical attendance integrity protection before deletion.
  // ==========================================================================
  app.post('/api/employees/bulk-action', async (req: Request, res: Response) => {
    const bulkStartMs = performance.now();
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        '*',
        'Employee Master Bulk Action',
        { prefetchUserPermission: true }
      );
      if (!caller) return;

      const parsed = BulkEmployeeActionSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          code: 'VALIDATION_ERROR',
          error: parsed.error.issues[0]?.message || 'Invalid employee bulk action payload.',
        });
      }

      const { action, confirmPhrase, reason } = parsed.data;
      const uniqueIds = Array.from(
        new Set(parsed.data.employeeIds.map((id) => id.trim().toUpperCase()).filter(Boolean))
      );
      if (uniqueIds.length === 0) {
        return res.status(400).json({
          success: false,
          code: 'VALIDATION_ERROR',
          error: 'At least one valid Employee ID is required.',
        });
      }

      const perms = await resolveCallerEmployeeActionPermissions(db, caller);
      const isAuthorized =
        action === 'DELETE' ? perms.canDelete : perms.canEdit;

      if (!isAuthorized) {
        await recordEnterpriseAuditEvent(db, {
          req,
          action: 'unauthorized_access_attempt',
          category: 'SECURITY',
          severity: 'CRITICAL',
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: caller.role.toUpperCase(),
          targetType: 'EMPLOYEE',
          targetId: '/api/employees/bulk-action',
          actionSource: 'EMPLOYEE_BULK_RBAC_GUARD',
          description: `User "${caller.loginId}" (${caller.role}) blocked from Employee bulk ${action} due to missing employees.${action === 'DELETE' ? 'delete' : 'edit'} permission.`,
          success: false,
        });
        return res.status(403).json({
          success: false,
          code: 'EMPLOYEE_BULK_FORBIDDEN',
          error: `Forbidden: Role "${caller.role.toUpperCase()}" is not authorized to perform bulk ${action} on employees.`,
        });
      }

      if (action === 'DELETE' && String(confirmPhrase || '').trim().toUpperCase() !== 'DELETE') {
        return res.status(400).json({
          success: false,
          code: 'CONFIRMATION_PHRASE_REQUIRED',
          error: 'Permanent bulk deletion requires confirmPhrase="DELETE".',
        });
      }

      // Fetch current employees map
      const existingSnap = await db.collection('employees').get();
      const empByUpperId = new Map<string, { docId: string; ref: AdminDocRefLike; data: Record<string, any> }>();
      for (const d of existingSnap.docs) {
        const data = d.data() || {};
        const key = String(data.employeeId || d.id).trim().toUpperCase();
        const entry = { docId: d.id, ref: db.collection('employees').doc(d.id), data };
        if (key) empByUpperId.set(key, entry);
        const docUpper = String(d.id).trim().toUpperCase();
        if (docUpper && !empByUpperId.has(docUpper)) {
          empByUpperId.set(docUpper, entry);
        }
      }

      // For permanent deletion: protect employees with historical attendance/punch records
      const protectedHistoryIds = new Set<string>();
      if (action === 'DELETE') {
        const presentIds = uniqueIds.filter((id) => empByUpperId.has(id));
        const QUERY_IN_LIMIT = 30;
        for (let i = 0; i < presentIds.length; i += QUERY_IN_LIMIT) {
          const chunk = presentIds.slice(i, i + QUERY_IN_LIMIT);
          if (chunk.length === 0) continue;
          const attSnap = await db
            .collection('attendance')
            .where('employeeId', 'in', chunk)
            .get();
          for (const attDoc of attSnap.docs) {
            const empIdVal = String(attDoc.data()?.employeeId || '').trim().toUpperCase();
            if (empIdVal) protectedHistoryIds.add(empIdVal);
          }
        }
      }

      const now = new Date().toISOString();
      const targetStatus = action === 'ACTIVATE' ? 'Active' : 'Inactive';

      const ops: Array<{ employeeId: string; ref: AdminDocRefLike }> = [];
      const skippedItems: Array<{ id: string; reason: string }> = [];

      for (const empId of uniqueIds) {
        const found = empByUpperId.get(empId);
        if (!found) {
          skippedItems.push({ id: empId, reason: 'Employee record not found.' });
          continue;
        }
        if (action === 'DELETE') {
          if (protectedHistoryIds.has(empId)) {
            skippedItems.push({
              id: empId,
              reason:
                'Protected: Employee has linked historical attendance/punch records. Deactivate/archive instead.',
            });
            continue;
          }
          ops.push({ employeeId: empId, ref: found.ref });
        } else {
          if (found.data.employeeStatus === targetStatus) {
            skippedItems.push({
              id: empId,
              reason: `Employee is already ${targetStatus}.`,
            });
            continue;
          }
          ops.push({ employeeId: empId, ref: found.ref });
        }
      }

      const committedIds: string[] = [];
      const failedItems: Array<{ id: string; error: string }> = [];

      for (let i = 0; i < ops.length; i += EMPLOYEE_BULK_BATCH_SIZE) {
        const chunk = ops.slice(i, i + EMPLOYEE_BULK_BATCH_SIZE);
        try {
          if (typeof db.batch === 'function') {
            const batch = db.batch();
            for (const op of chunk) {
              if (action === 'DELETE') {
                batch.delete(op.ref);
              } else {
                batch.update(op.ref, {
                  employeeStatus: targetStatus,
                  updatedAt: now,
                });
              }
            }
            await batch.commit();
          } else {
            await Promise.all(
              chunk.map((op) =>
                action === 'DELETE'
                  ? op.ref.delete()
                  : op.ref.update({ employeeStatus: targetStatus, updatedAt: now })
              )
            );
          }

          for (const op of chunk) {
            committedIds.push(op.employeeId);
          }
        } catch (batchErr: any) {
          const classified = classifyBatchWriteError(batchErr);
          for (const rem of ops.slice(i)) {
            failedItems.push({ id: rem.employeeId, error: classified.message });
          }

          await recordEnterpriseAuditEvent(db, {
            req,
            action: `EMPLOYEE_BULK_${action}_PARTIAL`,
            category: 'EMPLOYEE',
            severity: 'WARNING',
            actorUid: caller.uid,
            actorLoginId: caller.loginId,
            actorRole: caller.role.toUpperCase(),
            targetType: 'EMPLOYEE',
            targetId: uniqueIds.slice(0, 10).join(','),
            newValue: {
              action,
              savedCount: committedIds.length,
              skippedCount: skippedItems.length,
              failedCount: failedItems.length,
            },
            actionSource: 'EMPLOYEE_MASTER_BULK',
            reason: classified.message,
            success: false,
          }).catch(() => {});

          return res.status(classified.status).json({
            success: false,
            code: classified.code,
            action,
            savedCount: committedIds.length,
            skippedCount: skippedItems.length,
            failedCount: failedItems.length,
            partialCommit: committedIds.length > 0,
            committedIds,
            skippedItems,
            failedItems,
            error: classified.message,
          });
        }
      }

      await recordEnterpriseAuditEvent(db, {
        req,
        action: `EMPLOYEE_BULK_${action}`,
        category: 'EMPLOYEE',
        severity: action === 'DELETE' ? 'WARNING' : 'INFO',
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        targetType: 'EMPLOYEE',
        targetId: committedIds.slice(0, 10).join(',') || 'EMPLOYEE_BATCH',
        newValue: {
          action,
          savedCount: committedIds.length,
          skippedCount: skippedItems.length,
          sampleIds: committedIds.slice(0, 20),
        },
        actionSource: 'EMPLOYEE_MASTER_BULK',
        reason: reason || `Bulk ${action.toLowerCase()} executed from Employee Master`,
        description: `Bulk ${action} processed ${committedIds.length} employees (${skippedItems.length} skipped/protected).`,
        success: true,
      });

      const totalBulkMs = Math.round((performance.now() - bulkStartMs) * 100) / 100;
      recordDbOpMetric(db, {
        operation: 'BATCH',
        collection: 'employees',
        durationMs: totalBulkMs,
        success: true,
        recordCount: Math.max(1, ops.length),
        correlationId: (req as any).correlationId,
      });
      recordImportExportTelemetry(db, {
        type: 'BULK_ACTION',
        module: 'Employee Master',
        rowCount: uniqueIds.length,
        durationMs: totalBulkMs,
        success: true,
        actorLoginId: caller.loginId,
        correlationId: (req as any).correlationId,
        detail: `Bulk ${action}: ${committedIds.length} saved, ${skippedItems.length} skipped`,
      });
      recordActivityTelemetry(db, {
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        action: `EMPLOYEE_BULK_${action}`,
        module: 'Employee Master',
        result: 'Success',
        correlationId: (req as any).correlationId,
        detail: `${committedIds.length} updated (${skippedItems.length} skipped)`,
      });

      return res.json({
        success: true,
        action,
        savedCount: committedIds.length,
        skippedCount: skippedItems.length,
        failedCount: 0,
        partialCommit: false,
        committedIds,
        skippedItems,
        failedItems: [],
      });
    } catch (err: any) {
      console.error('[Employee Bulk Action API] Error:', err);
      const classified = classifyBatchWriteError(err);
      recordErrorTelemetry(db, {
        source: 'BULK',
        module: 'Employee Master',
        category: classified.code,
        severity: 'CRITICAL',
        message: classified.message,
        statusCode: classified.status,
        correlationId: (req as any).correlationId,
      });
      return res.status(classified.status).json({
        success: false,
        code: classified.code,
        error: classified.message,
      });
    }
  });

  // ==========================================================================
  // F-01 & F-02: Server-Authoritative Employee Directory, Single-Record CRUD
  // & Server-Side QR Image Rendering (Zero Raw qrCodeToken Exposure)
  // ==========================================================================
  const SingleEmployeeUpsertSchema = z.object({
    employeeId: z
      .string()
      .trim()
      .min(1, 'Employee ID is required.')
      .max(128, 'Employee ID must be 128 characters or fewer.')
      .regex(EMPLOYEE_ID_PATTERN, 'Invalid Employee ID characters.'),
    employeeName: z.string().trim().min(1, 'Employee Name is required.').max(200),
    employeeType: z.enum(['Permanent', 'Offroll', 'Staff']).default('Permanent'),
    section: z.string().trim().min(1).max(100).default('MI'),
    department: z.string().trim().min(1).max(100).default('Production'),
    floor: z.string().trim().min(1).max(100).default('MI-01'),
    designation: z.string().trim().min(1).max(120).default('Operator'),
    employeeStatus: z.enum(['Active', 'Inactive']).default('Active'),
  });

  const SingleEmployeeStatusSchema = z.object({
    employeeStatus: z.enum(['Active', 'Inactive']),
  });

  const RenderQrCardsSchema = z.object({
    employeeIds: z.array(z.string().trim().min(1).max(128)).min(1).max(200),
    size: z.number().int().min(120).max(600).optional(),
  });

  async function callerHasAnyModuleAction(
    caller: VerifiedCaller,
    checks: Array<{ module: string; action: 'view' | 'add' | 'edit' | 'delete' }>
  ): Promise<boolean> {
    if (caller.role === 'super_admin') return true;
    try {
      const [userPermSnap, rolePermSnap] = await Promise.all([
        caller.prefetchedUserPermSnap
          ? Promise.resolve(caller.prefetchedUserPermSnap)
          : db.collection('user_permissions').doc(caller.profileDocId).get(),
        getCachedRolePermissionsDoc(db, caller.role),
      ]);
      const userPermData = userPermSnap.exists ? userPermSnap.data() : undefined;
      const rolePermData = rolePermSnap.exists ? rolePermSnap.data : undefined;

      for (const { module: mod, action } of checks) {
        if (userPermData && userPermData.isCustomOverride !== false) {
          const m = userPermData.permissions?.[mod];
          if (m && typeof m[action] === 'boolean') {
            if (m[action] === true && (action === 'view' || m.view !== false)) return true;
            continue;
          }
        }
        const rm = rolePermData?.modulePermissions?.[mod];
        if (rm && typeof rm[action] === 'boolean') {
          if (rm[action] === true && (action === 'view' || rm.view !== false)) return true;
          continue;
        }
        if (caller.role === 'admin' && action !== 'delete') {
          return true;
        }
        if (
          action === 'view' &&
          Array.isArray(caller.modulesAllowed) &&
          caller.modulesAllowed.includes(mod)
        ) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  async function callerCanAccessQrSecrets(
    caller: VerifiedCaller,
    action: 'view' | 'edit'
  ): Promise<boolean> {
    if (caller.role === 'super_admin') return true;
    try {
      const [userPermSnap, rolePermSnap] = await Promise.all([
        caller.prefetchedUserPermSnap
          ? Promise.resolve(caller.prefetchedUserPermSnap)
          : db.collection('user_permissions').doc(caller.profileDocId).get(),
        getCachedRolePermissionsDoc(db, caller.role),
      ]);
      const userPermData = userPermSnap.exists ? userPermSnap.data() : undefined;
      const rolePermData = rolePermSnap.exists ? rolePermSnap.data : undefined;

      if (userPermData && userPermData.isCustomOverride !== false) {
        const m = userPermData.permissions?.qr_codes;
        if (m && typeof m[action] === 'boolean') {
          return m[action] === true && (action === 'view' || m.view !== false);
        }
      }
      const rm = rolePermData?.modulePermissions?.qr_codes;
      if (rm && typeof rm[action] === 'boolean') {
        return rm[action] === true && (action === 'view' || rm.view !== false);
      }
      // Admin defaults to QR view/edit unless explicitly revoked; ordinary users default DENIED.
      if (caller.role === 'admin') {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async function renderQrPngDataUrlServer(employeeId: string, qrCodeToken: string, width = 240): Promise<string> {
    const payload = JSON.stringify({
      employeeId: employeeId.trim().toUpperCase(),
      token: qrCodeToken.trim(),
    });
    return QRCode.toDataURL(payload, {
      width,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#0f172a', light: '#ffffff' },
    });
  }

  // GET /api/employees — Sanitized employee directory (NEVER exposes raw qrCodeToken)
  app.get('/api/employees', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, '*', 'List Employees', {
        prefetchUserPermission: true,
      });
      if (!caller) return;

      const allowed = await callerHasAnyModuleAction(caller, [
        { module: 'employees', action: 'view' },
        { module: 'qr_codes', action: 'view' },
        { module: 'dashboard', action: 'view' },
        { module: 'history', action: 'view' },
        { module: 'reports', action: 'view' },
        { module: 'excel_import', action: 'view' },
        { module: 'shifts', action: 'view' },
        { module: 'attendance', action: 'view' },
      ]);
      if (!allowed) {
        return res.status(403).json({
          success: false,
          error: 'Forbidden: You do not have permission to view employee records.',
        });
      }

      const snap = await db.collection('employees').get();
      let list = snap.docs.map((d) => sanitizeEmployeeForApi({ id: d.id, ...(d.data() || {}) }));

      const search = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : '';
      const floor = typeof req.query.floor === 'string' ? req.query.floor.trim() : '';
      const section = typeof req.query.section === 'string' ? req.query.section.trim() : '';
      const department = typeof req.query.department === 'string' ? req.query.department.trim() : '';
      const employeeType = typeof req.query.employeeType === 'string' ? req.query.employeeType.trim() : '';
      const employeeStatus = typeof req.query.employeeStatus === 'string' ? req.query.employeeStatus.trim() : '';

      if (search) {
        list = list.filter(
          (e: any) =>
            String(e.employeeId || '').toLowerCase().includes(search) ||
            String(e.employeeName || '').toLowerCase().includes(search) ||
            String(e.designation || '').toLowerCase().includes(search)
        );
      }
      if (floor && floor !== 'All') list = list.filter((e: any) => e.floor === floor);
      if (section && section !== 'All') list = list.filter((e: any) => e.section === section);
      if (department && department !== 'All') list = list.filter((e: any) => e.department === department);
      if (employeeType && employeeType !== 'All') list = list.filter((e: any) => e.employeeType === employeeType);
      if (employeeStatus && employeeStatus !== 'All') list = list.filter((e: any) => e.employeeStatus === employeeStatus);

      list.sort((a: any, b: any) => String(a.employeeId || '').localeCompare(String(b.employeeId || '')));

      return res.json({ success: true, employees: list });
    } catch (err: any) {
      console.error('[API List Employees] Error:', err);
      return res.status(500).json({ success: false, error: 'Failed to load employees.' });
    }
  });

  // POST /api/employees/qr-cards/render — Server-Side QR PNG Rendering (Strictly qr_codes.view; ZERO raw token in response)
  app.post('/api/employees/qr-cards/render', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, '*', 'Render Employee QR Cards', {
        prefetchUserPermission: true,
      });
      if (!caller) return;

      const canViewQr = await callerCanAccessQrSecrets(caller, 'view');
      if (!canViewQr) {
        return res.status(403).json({
          success: false,
          code: 'QR_ACCESS_DENIED',
          error: 'Forbidden: QR Code Management view permission is required.',
        });
      }

      const parsed = RenderQrCardsSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: parsed.error.issues[0]?.message || 'Invalid QR card render request.',
        });
      }

      const uniqueIds = Array.from(
        new Set(parsed.data.employeeIds.map((id) => id.trim().toUpperCase()).filter(Boolean))
      );
      const size = parsed.data.size || 240;

      const items: Record<string, { qrDataUrl: string; qrTokenReference: string; hasQrToken: boolean }> = {};
      const missingIds: string[] = [];

      const snaps = await Promise.all(uniqueIds.map((id) => db.collection('employees').doc(id).get()));
      await Promise.all(
        snaps.map(async (snap, idx) => {
          const empId = uniqueIds[idx];
          if (!snap.exists) {
            missingIds.push(empId);
            return;
          }
          const data = snap.data() || {};
          const rawToken = typeof data.qrCodeToken === 'string' ? data.qrCodeToken.trim() : '';
          if (!rawToken) {
            missingIds.push(empId);
            return;
          }
          const qrDataUrl = await renderQrPngDataUrlServer(empId, rawToken, size);
          items[empId] = {
            qrDataUrl,
            qrTokenReference: hashQrTokenReference(rawToken),
            hasQrToken: true,
          };
        })
      );

      return res.json({ success: true, items, missingIds });
    } catch (err: any) {
      console.error('[API Render QR Cards] Error:', err);
      return res.status(500).json({ success: false, error: 'Failed to render QR codes.' });
    }
  });

  // GET /api/employees/:employeeId — Sanitized single employee (NEVER exposes raw qrCodeToken)
  app.get('/api/employees/:employeeId', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, '*', 'Get Employee', {
        prefetchUserPermission: true,
      });
      if (!caller) return;

      const allowed = await callerHasAnyModuleAction(caller, [
        { module: 'employees', action: 'view' },
        { module: 'qr_codes', action: 'view' },
        { module: 'dashboard', action: 'view' },
        { module: 'history', action: 'view' },
        { module: 'reports', action: 'view' },
      ]);
      if (!allowed) {
        return res.status(403).json({ success: false, error: 'Forbidden: Insufficient permissions.' });
      }

      const cleanId = String(req.params.employeeId || '').trim().toUpperCase();
      if (!cleanId || !EMPLOYEE_ID_PATTERN.test(cleanId)) {
        return res.status(400).json({ success: false, error: 'Invalid Employee ID.' });
      }

      const snap = await db.collection('employees').doc(cleanId).get();
      if (!snap.exists) {
        return res.status(404).json({ success: false, error: `Employee ${cleanId} not found.` });
      }
      return res.json({ success: true, employee: sanitizeEmployeeForApi(snap.data()!) });
    } catch (err: any) {
      console.error('[API Get Employee] Error:', err);
      return res.status(500).json({ success: false, error: 'Failed to load employee.' });
    }
  });

  // POST /api/employees — Create new employee (Server-side CSPRNG QR token; sanitized response)
  app.post('/api/employees', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, '*', 'Create Employee', {
        prefetchUserPermission: true,
      });
      if (!caller) return;

      const canAdd = await callerHasAnyModuleAction(caller, [{ module: 'employees', action: 'add' }]);
      if (!canAdd) {
        return res.status(403).json({
          success: false,
          error: 'Forbidden: Employee creation permission is required.',
        });
      }

      const parsed = SingleEmployeeUpsertSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: parsed.error.issues[0]?.message || 'Invalid employee data.',
        });
      }

      const cleanId = parsed.data.employeeId.trim().toUpperCase();
      const empRef = db.collection('employees').doc(cleanId);
      const existing = await empRef.get();
      if (existing.exists) {
        return res.status(409).json({
          success: false,
          error: `Employee ID "${cleanId}" already exists. ID must be unique.`,
        });
      }

      const now = new Date().toISOString();
      const newToken = generateServerQrToken(cleanId);
      const fullEmployee = {
        employeeId: cleanId,
        employeeName: parsed.data.employeeName.trim().toUpperCase(),
        employeeType: parsed.data.employeeType,
        section: parsed.data.section,
        department: parsed.data.department,
        floor: parsed.data.floor,
        designation: parsed.data.designation,
        qrCodeToken: newToken,
        employeeStatus: parsed.data.employeeStatus,
        createdAt: now,
        updatedAt: now,
      };

      await empRef.set(fullEmployee);
      await recordEnterpriseAuditEvent(db, {
        req,
        action: 'CREATE_EMPLOYEE',
        category: 'EMPLOYEE',
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        employeeId: cleanId,
        targetType: 'EMPLOYEE',
        targetId: cleanId,
        newValue: `${fullEmployee.employeeName} (${fullEmployee.department} - ${fullEmployee.floor})`,
        actionSource: 'EMPLOYEE_MASTER',
        captureGeo: false,
      });

      return res.status(201).json({ success: true, employee: sanitizeEmployeeForApi(fullEmployee) });
    } catch (err: any) {
      console.error('[API Create Employee] Error:', err);
      return res.status(500).json({ success: false, error: 'Failed to create employee.' });
    }
  });

  // PUT /api/employees/:employeeId — Update employee while STRICTLY preserving existing qrCodeToken
  app.put('/api/employees/:employeeId', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, '*', 'Update Employee', {
        prefetchUserPermission: true,
      });
      if (!caller) return;

      const canEdit = await callerHasAnyModuleAction(caller, [{ module: 'employees', action: 'edit' }]);
      if (!canEdit) {
        return res.status(403).json({
          success: false,
          error: 'Forbidden: Employee edit permission is required.',
        });
      }

      const cleanId = String(req.params.employeeId || '').trim().toUpperCase();
      if (!cleanId || !EMPLOYEE_ID_PATTERN.test(cleanId)) {
        return res.status(400).json({ success: false, error: 'Invalid Employee ID.' });
      }

      const parsed = SingleEmployeeUpsertSchema.safeParse({ ...req.body, employeeId: cleanId });
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: parsed.error.issues[0]?.message || 'Invalid employee data.',
        });
      }

      const empRef = db.collection('employees').doc(cleanId);
      const existingSnap = await empRef.get();
      if (!existingSnap.exists) {
        return res.status(404).json({ success: false, error: `Employee ${cleanId} not found.` });
      }

      const prev = existingSnap.data() || {};
      const now = new Date().toISOString();
      const updatedEmployee = {
        ...prev,
        employeeId: cleanId,
        employeeName: parsed.data.employeeName.trim().toUpperCase(),
        employeeType: parsed.data.employeeType,
        section: parsed.data.section,
        department: parsed.data.department,
        floor: parsed.data.floor,
        designation: parsed.data.designation,
        employeeStatus: parsed.data.employeeStatus,
        // Strictly preserve existing qrCodeToken — never rotate during profile edits
        qrCodeToken: prev.qrCodeToken || generateServerQrToken(cleanId),
        createdAt: prev.createdAt || now,
        updatedAt: now,
      };

      await empRef.set(updatedEmployee);
      await recordEnterpriseAuditEvent(db, {
        req,
        action: 'UPDATE_EMPLOYEE',
        category: 'EMPLOYEE',
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        employeeId: cleanId,
        targetType: 'EMPLOYEE',
        targetId: cleanId,
        oldValue: `${prev.employeeName || cleanId} (${prev.department || ''} - ${prev.floor || ''})`,
        newValue: `${updatedEmployee.employeeName} (${updatedEmployee.department} - ${updatedEmployee.floor})`,
        actionSource: 'EMPLOYEE_MASTER',
        captureGeo: false,
      });

      return res.json({ success: true, employee: sanitizeEmployeeForApi(updatedEmployee) });
    } catch (err: any) {
      console.error('[API Update Employee] Error:', err);
      return res.status(500).json({ success: false, error: 'Failed to update employee.' });
    }
  });

  // PATCH /api/employees/:employeeId/status — Toggle Active/Inactive while preserving qrCodeToken
  app.patch('/api/employees/:employeeId/status', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, '*', 'Toggle Employee Status', {
        prefetchUserPermission: true,
      });
      if (!caller) return;

      const canEdit = await callerHasAnyModuleAction(caller, [{ module: 'employees', action: 'edit' }]);
      if (!canEdit) {
        return res.status(403).json({
          success: false,
          error: 'Forbidden: Employee edit permission is required.',
        });
      }

      const cleanId = String(req.params.employeeId || '').trim().toUpperCase();
      if (!cleanId || !EMPLOYEE_ID_PATTERN.test(cleanId)) {
        return res.status(400).json({ success: false, error: 'Invalid Employee ID.' });
      }

      const parsed = SingleEmployeeStatusSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: 'Invalid status value.' });
      }

      const empRef = db.collection('employees').doc(cleanId);
      const existing = await empRef.get();
      if (!existing.exists) {
        return res.status(404).json({ success: false, error: `Employee ${cleanId} not found.` });
      }

      const prev = existing.data() || {};
      const oldStatus = prev.employeeStatus || 'Active';
      const now = new Date().toISOString();
      await empRef.update({
        employeeStatus: parsed.data.employeeStatus,
        updatedAt: now,
      });

      await recordEnterpriseAuditEvent(db, {
        req,
        action: 'TOGGLE_EMPLOYEE_STATUS',
        category: 'EMPLOYEE',
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        employeeId: cleanId,
        targetType: 'EMPLOYEE',
        targetId: cleanId,
        oldValue: oldStatus,
        newValue: parsed.data.employeeStatus,
        actionSource: 'EMPLOYEE_MASTER',
        reason: `Status toggled to ${parsed.data.employeeStatus}`,
        captureGeo: false,
      });

      return res.json({
        success: true,
        employee: sanitizeEmployeeForApi({
          ...prev,
          employeeStatus: parsed.data.employeeStatus,
          updatedAt: now,
        }),
      });
    } catch (err: any) {
      console.error('[API Toggle Employee Status] Error:', err);
      return res.status(500).json({ success: false, error: 'Failed to update employee status.' });
    }
  });

  // DELETE /api/employees/:employeeId — Authenticated delete with RBAC + audit
  app.delete('/api/employees/:employeeId', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, '*', 'Delete Employee', {
        prefetchUserPermission: true,
      });
      if (!caller) return;

      const canDelete = await callerHasAnyModuleAction(caller, [{ module: 'employees', action: 'delete' }]);
      if (!canDelete) {
        return res.status(403).json({
          success: false,
          error: 'Forbidden: Employee delete permission is required.',
        });
      }

      const cleanId = String(req.params.employeeId || '').trim().toUpperCase();
      if (!cleanId || !EMPLOYEE_ID_PATTERN.test(cleanId)) {
        return res.status(400).json({ success: false, error: 'Invalid Employee ID.' });
      }

      const empRef = db.collection('employees').doc(cleanId);
      const existing = await empRef.get();
      if (!existing.exists) {
        return res.status(404).json({ success: false, error: `Employee ${cleanId} not found.` });
      }

      const empData = existing.data() || {};
      await empRef.delete();
      await recordEnterpriseAuditEvent(db, {
        req,
        action: 'DELETE_EMPLOYEE',
        category: 'EMPLOYEE',
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        employeeId: cleanId,
        targetType: 'EMPLOYEE',
        targetId: cleanId,
        oldValue: `${empData.employeeName || cleanId} (${empData.department || ''} - ${empData.floor || ''})`,
        newValue: 'DELETED',
        actionSource: 'EMPLOYEE_MASTER',
        reason: 'Administrator permanently deleted employee record',
        captureGeo: false,
      });

      return res.json({ success: true, employeeId: cleanId });
    } catch (err: any) {
      console.error('[API Delete Employee] Error:', err);
      return res.status(500).json({ success: false, error: 'Failed to delete employee.' });
    }
  });

  // POST /api/employees/:employeeId/regenerate-qr — Authorized manual QR re-issue (NEVER exposes raw token)
  app.post('/api/employees/:employeeId/regenerate-qr', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, '*', 'Regenerate Employee QR Token', {
        prefetchUserPermission: true,
      });
      if (!caller) return;

      const canReissue = await callerCanAccessQrSecrets(caller, 'edit');
      if (!canReissue) {
        return res.status(403).json({
          success: false,
          code: 'QR_ACCESS_DENIED',
          error: 'Forbidden: QR Code Management edit permission is required to regenerate QR tokens.',
        });
      }

      const cleanId = String(req.params.employeeId || '').trim().toUpperCase();
      if (!cleanId || !EMPLOYEE_ID_PATTERN.test(cleanId)) {
        return res.status(400).json({ success: false, error: 'Invalid Employee ID.' });
      }

      const empRef = db.collection('employees').doc(cleanId);
      const existing = await empRef.get();
      if (!existing.exists) {
        return res.status(404).json({ success: false, error: `Employee ${cleanId} not found.` });
      }

      const prev = existing.data() || {};
      const oldRef = hashQrTokenReference(prev.qrCodeToken);
      const newToken = generateServerQrToken(cleanId);
      const newRef = hashQrTokenReference(newToken);
      const now = new Date().toISOString();

      await empRef.update({
        qrCodeToken: newToken,
        updatedAt: now,
      });

      const qrDataUrl = await renderQrPngDataUrlServer(cleanId, newToken, 240);

      // F-01: Log ONLY non-reversible SHA-256 reference in audit_logs (never raw qrCodeToken)
      await recordEnterpriseAuditEvent(db, {
        req,
        action: 'REGENERATE_QR_TOKEN',
        category: 'EMPLOYEE',
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        employeeId: cleanId,
        targetType: 'EMPLOYEE',
        targetId: cleanId,
        oldValue: oldRef || 'NONE',
        newValue: newRef,
        actionSource: 'QR_MANAGEMENT',
        reason: 'Administrator manually regenerated QR security token',
        captureGeo: false,
      });

      return res.json({
        success: true,
        employeeId: cleanId,
        hasQrToken: true,
        qrTokenReference: newRef,
        qrDataUrl,
      });
    } catch (err: any) {
      console.error('[API Regenerate QR] Error:', err);
      return res.status(500).json({ success: false, error: 'Failed to regenerate QR token.' });
    }
  });
}
