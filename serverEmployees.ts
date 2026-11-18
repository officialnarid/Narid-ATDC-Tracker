import express, { type Request, type Response } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { isFirestorePermissionDeniedError } from './serverFirebaseAdmin.ts';
import {
  type AdminDocRefLike,
  type AdminFirestoreLike,
  type VerifiedCaller,
  recordEnterpriseAuditEvent,
} from './serverSecurityAudit.ts';
import { getCachedRolePermissionsDoc } from './serverPerfCache.ts';
import {
  recordDbOpMetric,
  recordImportExportTelemetry,
  recordActivityTelemetry,
  recordErrorTelemetry,
} from './serverMonitoring.ts';

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
    .max(200, 'Employee Name must be 200 characters or fewer.'),
  employeeType: z.enum(['Permanent', 'Staff', 'Offroll']),
  section: z.string().trim().min(1, 'Section is required.').max(100),
  department: z.string().trim().min(1, 'Department is required.').max(100),
  floor: z.string().trim().min(1, 'Production Line is required.').max(100),
  designation: z.string().trim().min(1).max(120).default('Operator'),
  employeeStatus: z.enum(['Active', 'Inactive']),
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
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
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

      // Fetch current existing employees from Firestore once via Admin SDK
      const existingSnap = await db.collection('employees').get();
      const existingByUpperId = new Map<string, { docId: string; data: Record<string, any> }>();
      for (const d of existingSnap.docs) {
        const data = d.data() || {};
        const key = String(data.employeeId || d.id).trim().toUpperCase();
        if (key) {
          existingByUpperId.set(key, { docId: d.id, data });
        }
        const docIdUpper = String(d.id).trim().toUpperCase();
        if (docIdUpper && !existingByUpperId.has(docIdUpper)) {
          existingByUpperId.set(docIdUpper, { docId: d.id, data });
        }
      }

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

      for (const row of rows) {
        const cleanId = row.employeeId.trim().toUpperCase();
        const cleanName = row.employeeName.trim().toUpperCase();
        const cleanSection = row.section.trim();
        const cleanDepartment = row.department.trim();
        const cleanFloor = row.floor.trim();
        const cleanDesignation = (row.designation || 'Operator').trim();

        const existing = existingByUpperId.get(cleanId);
        if (!existing) {
          operations.push({
            actionType: 'NEW',
            employeeId: cleanId,
            rowNumber: row.rowNumber,
            ref: db.collection('employees').doc(cleanId),
            payload: {
              employeeId: cleanId,
              employeeName: cleanName,
              employeeType: row.employeeType,
              section: cleanSection,
              department: cleanDepartment,
              floor: cleanFloor,
              designation: cleanDesignation,
              qrCodeToken: generateServerQrToken(cleanId),
              employeeStatus: row.employeeStatus,
              createdAt: now,
              updatedAt: now,
            },
          });
          continue;
        }

        const prev = existing.data;
        const hasChanged =
          String(prev.employeeName || '').trim().toUpperCase() !== cleanName ||
          String(prev.employeeType || '') !== row.employeeType ||
          String(prev.section || '').trim() !== cleanSection ||
          String(prev.department || '').trim() !== cleanDepartment ||
          String(prev.floor || '').trim() !== cleanFloor ||
          String(prev.designation || '').trim() !== cleanDesignation ||
          String(prev.employeeStatus || '') !== row.employeeStatus;

        if (!hasChanged) {
          skippedIds.push(cleanId);
          continue;
        }

        operations.push({
          actionType: 'UPDATE',
          employeeId: cleanId,
          rowNumber: row.rowNumber,
          ref: db.collection('employees').doc(existing.docId),
          payload: {
            ...prev,
            employeeId: cleanId,
            employeeName: cleanName,
            employeeType: row.employeeType,
            section: cleanSection,
            department: cleanDepartment,
            floor: cleanFloor,
            designation: cleanDesignation,
            // Strictly preserve existing QR code token and historical creation timestamp
            qrCodeToken: prev.qrCodeToken || generateServerQrToken(cleanId),
            employeeStatus: row.employeeStatus,
            createdAt: prev.createdAt || now,
            updatedAt: now,
          },
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
}
