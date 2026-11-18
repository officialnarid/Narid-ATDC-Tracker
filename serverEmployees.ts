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

const ADMIN_EXCEL_DEFAULTS: Record<string, { view: boolean; add: boolean; edit: boolean }> = {
  excel_import: { view: true, add: true, edit: true },
  employees: { view: true, add: true, edit: true },
};

function evalModuleAction(
  caller: VerifiedCaller,
  userPermData: Record<string, any> | undefined,
  rolePermData: Record<string, any> | undefined,
  moduleKey: 'excel_import' | 'employees',
  action: 'view' | 'add' | 'edit'
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
      return res.status(classified.status).json({
        success: false,
        code: classified.code,
        category: classified.category,
        error: classified.message,
      });
    }
  });
}
