import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { isFirestorePermissionDeniedError } from './serverFirebaseAdmin.ts';
import {
  type AdminDocRefLike,
  type AdminFirestoreLike,
  type VerifiedCaller,
  recordEnterpriseAuditEvent,
} from './serverSecurityAudit.ts';
import { getCachedRolePermissionsDoc } from './serverPerfCache.ts';

export const MASTER_BULK_BATCH_SIZE = 400; // Strictly below Firestore's 500 writes/batch limit

export type BulkMasterResource = 'shifts' | 'floors' | 'sections' | 'departments';

const BulkMasterStatusSchema = z.object({
  resource: z.enum(['shifts', 'floors', 'sections', 'departments']),
  ids: z
    .array(z.string().trim().min(1).max(160))
    .min(1, 'At least one record ID is required.')
    .max(200, 'Bulk master status update supports up to 200 records per request.'),
  status: z.enum(['Active', 'Inactive']),
  confirmed: z.literal(true, {
    message: 'Explicit confirmation is required for bulk status updates.',
  }),
});

const ADMIN_DEFAULT_EDIT_MODULES = new Set(['shifts', 'floors', 'sections', 'departments']);

function evalMasterEditPermission(
  caller: VerifiedCaller,
  userPermData: Record<string, any> | undefined,
  rolePermData: Record<string, any> | undefined,
  moduleKey: BulkMasterResource
): boolean {
  if (caller.role === 'super_admin') return true;

  if (userPermData && userPermData.isCustomOverride !== false) {
    const mod = userPermData.permissions?.[moduleKey];
    if (mod && typeof mod.edit === 'boolean') {
      return mod.edit === true && mod.view !== false;
    }
  }

  if (rolePermData) {
    const mod = rolePermData.modulePermissions?.[moduleKey];
    if (mod && typeof mod.edit === 'boolean') {
      return mod.edit === true && mod.view !== false;
    }
  }

  if (caller.role === 'admin') {
    return ADMIN_DEFAULT_EDIT_MODULES.has(moduleKey);
  }

  return false;
}

async function canCallerEditMasterResource(
  db: AdminFirestoreLike,
  caller: VerifiedCaller,
  resource: BulkMasterResource
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
    return evalMasterEditPermission(caller, userPermData, rolePermData, resource);
  } catch (err: any) {
    console.warn('[Master Bulk RBAC] Permission lookup failed; failing closed:', err?.message || err);
    return false;
  }
}

export interface MasterRoutesDeps {
  db: AdminFirestoreLike;
  requireVerifiedCaller: (
    req: Request,
    res: Response,
    allowedRoles: string[] | '*',
    actionLabel: string,
    options?: { prefetchUserPermission?: boolean }
  ) => Promise<VerifiedCaller | null>;
}

export function registerMasterRoutes(app: express.Express, deps: MasterRoutesDeps) {
  const { db, requireVerifiedCaller } = deps;

  // ============================================================================
  // POST /api/masters/bulk-status
  // Authenticated, RBAC-enforced chunked Admin SDK status toggle for
  // Shifts, Production Lines (floors), Sections, and Departments.
  // ============================================================================
  app.post('/api/masters/bulk-status', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        '*',
        'Master Configuration Bulk Status Update',
        { prefetchUserPermission: true }
      );
      if (!caller) return;

      const parsed = BulkMasterStatusSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          code: 'VALIDATION_ERROR',
          error: parsed.error.issues[0]?.message || 'Invalid bulk status update payload.',
        });
      }

      const { resource, status } = parsed.data;
      const uniqueIds = Array.from(new Set(parsed.data.ids.map((id) => id.trim()).filter(Boolean)));
      if (uniqueIds.length === 0) {
        return res.status(400).json({
          success: false,
          code: 'VALIDATION_ERROR',
          error: 'At least one valid record ID is required.',
        });
      }

      const allowed = await canCallerEditMasterResource(db, caller, resource);
      if (!allowed) {
        await recordEnterpriseAuditEvent(db, {
          req,
          action: 'unauthorized_access_attempt',
          category: 'SECURITY',
          severity: 'CRITICAL',
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: caller.role.toUpperCase(),
          targetType: resource.toUpperCase(),
          targetId: '/api/masters/bulk-status',
          actionSource: 'MASTER_BULK_RBAC_GUARD',
          description: `User "${caller.loginId}" (${caller.role}) blocked from bulk updating "${resource}" status due to missing edit permission.`,
          success: false,
        });
        return res.status(403).json({
          success: false,
          code: 'MASTER_BULK_FORBIDDEN',
          error: `Forbidden: Role "${caller.role.toUpperCase()}" does not have edit permission for ${resource}.`,
        });
      }

      const existingSnap = await db.collection(resource).get();
      const existingById = new Map<string, { ref: AdminDocRefLike; data: Record<string, any> }>();
      for (const docSnap of existingSnap.docs) {
        existingById.set(docSnap.id, {
          ref: db.collection(resource).doc(docSnap.id),
          data: docSnap.data() || {},
        });
      }

      const now = new Date().toISOString();
      const ops: Array<{ id: string; ref: AdminDocRefLike }> = [];
      const skippedItems: Array<{ id: string; reason: string }> = [];

      for (const id of uniqueIds) {
        const entry = existingById.get(id);
        if (!entry) {
          skippedItems.push({ id, reason: 'Record not found in database.' });
          continue;
        }
        if (entry.data.status === status) {
          skippedItems.push({ id, reason: `Already ${status}.` });
          continue;
        }
        ops.push({ id, ref: entry.ref });
      }

      const committedIds: string[] = [];
      const failedItems: Array<{ id: string; error: string }> = [];

      for (let i = 0; i < ops.length; i += MASTER_BULK_BATCH_SIZE) {
        const chunk = ops.slice(i, i + MASTER_BULK_BATCH_SIZE);
        try {
          if (typeof db.batch === 'function') {
            const batch = db.batch();
            for (const op of chunk) {
              batch.update(op.ref, { status, updatedAt: now });
            }
            await batch.commit();
          } else {
            await Promise.all(chunk.map((op) => op.ref.update({ status, updatedAt: now })));
          }
          for (const op of chunk) {
            committedIds.push(op.id);
          }
        } catch (batchErr: any) {
          const msg = isFirestorePermissionDeniedError(batchErr)
            ? 'Database Admin SDK permission denied.'
            : batchErr?.message || 'Batch commit failed.';
          for (const rem of ops.slice(i)) {
            failedItems.push({ id: rem.id, error: msg });
          }

          await recordEnterpriseAuditEvent(db, {
            req,
            action: 'MASTER_BULK_STATUS_PARTIAL',
            category: 'ORG',
            severity: 'WARNING',
            actorUid: caller.uid,
            actorLoginId: caller.loginId,
            actorRole: caller.role.toUpperCase(),
            targetType: resource.toUpperCase(),
            targetId: uniqueIds.slice(0, 10).join(','),
            newValue: { resource, status, savedCount: committedIds.length, failedCount: failedItems.length },
            actionSource: 'MASTER_BULK_STATUS',
            reason: msg,
            success: false,
          }).catch(() => {});

          return res.status(isFirestorePermissionDeniedError(batchErr) ? 503 : 500).json({
            success: false,
            resource,
            status,
            savedCount: committedIds.length,
            skippedCount: skippedItems.length,
            failedCount: failedItems.length,
            partialCommit: committedIds.length > 0,
            committedIds,
            skippedItems,
            failedItems,
            error: msg,
          });
        }
      }

      await recordEnterpriseAuditEvent(db, {
        req,
        action: 'MASTER_BULK_STATUS_UPDATE',
        category: 'ORG',
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        targetType: resource.toUpperCase(),
        targetId: committedIds.slice(0, 10).join(',') || resource,
        newValue: {
          resource,
          status,
          savedCount: committedIds.length,
          skippedCount: skippedItems.length,
        },
        actionSource: 'MASTER_BULK_STATUS',
        description: `Bulk updated ${committedIds.length} ${resource} record(s) to ${status} (skipped ${skippedItems.length}).`,
        success: true,
      });

      return res.json({
        success: true,
        resource,
        status,
        savedCount: committedIds.length,
        skippedCount: skippedItems.length,
        failedCount: 0,
        partialCommit: false,
        committedIds,
        skippedItems,
        failedItems: [],
      });
    } catch (err: any) {
      console.error('[Master Bulk Status API] Error:', err);
      return res.status(500).json({
        success: false,
        error: err?.message || 'Master bulk status update failed.',
      });
    }
  });
}
