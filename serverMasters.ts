import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { isFirestorePermissionDeniedError } from './serverFirebaseAdmin.ts';
import {
  type AdminDocRefLike,
  type AdminFirestoreLike,
  type VerifiedCaller,
  recordEnterpriseAuditEvent,
} from './serverSecurityAudit.ts';
import { getCachedRolePermissionsDoc, invalidateConfigCaches } from './serverPerfCache.ts';
import {
  recordDbOpMetric,
  recordImportExportTelemetry,
  recordActivityTelemetry,
  recordErrorTelemetry,
} from './serverMonitoring.ts';
import {
  findCaseInsensitiveMasterDuplicate,
  normalizeWhitespaceAndUnicode,
} from './src/utils/excelMasterNormalizer.ts';

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
    const masterStartMs = performance.now();
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

      if (resource === 'shifts' && committedIds.length > 0) {
        invalidateConfigCaches(db);
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

      const masterElapsedMs = Math.round((performance.now() - masterStartMs) * 100) / 100;
      const modName = resource === 'shifts' ? 'Shift Management' : 'Organization Management';
      recordDbOpMetric(db, {
        operation: 'BATCH',
        collection: resource,
        durationMs: masterElapsedMs,
        success: true,
        recordCount: Math.max(1, ops.length),
        correlationId: (req as any).correlationId,
      });
      recordImportExportTelemetry(db, {
        type: 'BULK_ACTION',
        module: modName,
        rowCount: uniqueIds.length,
        durationMs: masterElapsedMs,
        success: true,
        actorLoginId: caller.loginId,
        correlationId: (req as any).correlationId,
        detail: `${resource} -> ${status}: ${committedIds.length} committed, ${skippedItems.length} skipped`,
      });
      recordActivityTelemetry(db, {
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        action: `MASTER_BULK_${status.toUpperCase()}`,
        module: modName,
        result: 'Success',
        correlationId: (req as any).correlationId,
        detail: `${resource}: ${committedIds.length} updated`,
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
      recordErrorTelemetry(db, {
        source: 'BULK',
        module: 'Organization Management',
        category: 'MASTER_BULK_ERROR',
        severity: 'CRITICAL',
        message: err?.message || 'Master bulk status update failed.',
        statusCode: 500,
        correlationId: (req as any).correlationId,
      });
      return res.status(500).json({
        success: false,
        error: 'Master bulk status update failed.',
      });
    }
  });

  // ==========================================================================
  // F-02: Server-Authoritative Master Data Read & Write Endpoints
  // (Floors/Lines, Sections, Departments, Shifts, System Settings)
  // ==========================================================================
  const MASTER_ID_RE = /^[A-Za-z0-9_.\-]{1,128}$/;

  const FloorUpsertSchema = z.object({
    id: z.string().trim().min(1).max(128).regex(MASTER_ID_RE, 'Invalid Production Line ID.'),
    name: z.string().trim().min(1, 'Production Line name is required.').max(120),
    code: z.string().trim().max(60).optional(),
    order: z.number().int().min(0).max(10000).optional(),
    status: z.enum(['Active', 'Inactive']).default('Active'),
  });

  const SectionUpsertSchema = z.object({
    id: z.string().trim().min(1).max(128).regex(MASTER_ID_RE, 'Invalid Section ID.'),
    name: z.string().trim().min(1, 'Section name is required.').max(120),
    code: z.string().trim().max(60).optional(),
    floorId: z.string().trim().max(128).optional(),
    status: z.enum(['Active', 'Inactive']).default('Active'),
  });

  const DepartmentUpsertSchema = z.object({
    id: z.string().trim().min(1).max(128).regex(MASTER_ID_RE, 'Invalid Department ID.'),
    name: z.string().trim().min(1, 'Department name is required.').max(120),
    code: z.string().trim().max(60).optional(),
    status: z.enum(['Active', 'Inactive']).default('Active'),
  });

  const ShiftUpsertSchema = z.object({
    id: z.string().trim().min(1).max(128).regex(MASTER_ID_RE, 'Invalid Shift ID.'),
    name: z.string().trim().min(1, 'Shift name is required.').max(120),
    startTime: z.string().trim().regex(/^\d{2}:\d{2}$/, 'Invalid startTime (HH:mm).'),
    endTime: z.string().trim().regex(/^\d{2}:\d{2}$/, 'Invalid endTime (HH:mm).'),
    scheduledDurationMinutes: z.number().int().min(60).max(1440),
    punchInWindowStart: z.string().trim().regex(/^\d{2}:\d{2}$/, 'Invalid punchInWindowStart.'),
    punchInWindowEnd: z.string().trim().regex(/^\d{2}:\d{2}$/, 'Invalid punchInWindowEnd.'),
    isOvernight: z.boolean(),
    gracePeriodMinutes: z.number().int().min(0).max(180).optional(),
    status: z.enum(['Active', 'Inactive']).default('Active'),
  });

  const SystemSettingsUpdateSchema = z.object({
    companyName: z.string().trim().min(1).max(160).optional(),
    websiteName: z.string().trim().min(1).max(160).optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    dateFormat: z.string().trim().min(1).max(32).optional(),
    timeFormat: z.string().trim().min(1).max(32).optional(),
    autoPunchOutEnabled: z.boolean().optional(),
    lateGraceMinutes: z.number().int().min(0).max(180).optional(),
    scheduledDurationMinutes: z.number().int().min(60).max(1440).optional(),
    overtimeThresholdMinutes: z.number().int().min(60).max(1440).optional(),
    scannerMode: z.enum(['USB_PRIMARY', 'WEBCAM', 'HYBRID']).optional(),
    auditRetentionDays: z.number().int().min(7).max(3650).optional(),
    protectCriticalLogs: z.boolean().optional(),
    captureGeoLocation: z.boolean().optional(),
    failedLoginAlertThreshold: z.number().int().min(1).max(100).optional(),
    superAdminLockoutResetHours: z.number().int().min(6).max(720).optional(),
  });

  async function requireMasterEditCaller(
    req: Request,
    res: Response,
    resource: BulkMasterResource,
    actionLabel: string
  ): Promise<VerifiedCaller | null> {
    const caller = await requireVerifiedCaller(req, res, '*', actionLabel, {
      prefetchUserPermission: true,
    });
    if (!caller) return null;
    const allowed = await canCallerEditMasterResource(db, caller, resource);
    if (!allowed) {
      res.status(403).json({
        success: false,
        error: `Forbidden: You do not have permission to modify ${resource}.`,
      });
      return null;
    }
    return caller;
  }

  // GET /api/masters/all — Load floors, sections, departments, shifts, and settings in one authenticated call
  app.get('/api/masters/all', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, '*', 'Load Master Data');
      if (!caller) return;

      const [floorsSnap, sectionsSnap, deptsSnap, shiftsSnap, settingsSnap] = await Promise.all([
        db.collection('floors').get(),
        db.collection('sections').get(),
        db.collection('departments').get(),
        db.collection('shifts').get(),
        db.collection('system_settings').doc('global').get(),
      ]);

      const floors = floorsSnap.docs
        .map((d) => ({ id: d.id, ...(d.data() || {}) }))
        .sort((a: any, b: any) => (Number(a.order) || 0) - (Number(b.order) || 0));
      const sections = sectionsSnap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
      const departments = deptsSnap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
      const shifts = shiftsSnap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
      const settings = settingsSnap.exists ? settingsSnap.data() : null;

      return res.json({ success: true, floors, sections, departments, shifts, settings });
    } catch (err: any) {
      console.error('[API Masters All] Error:', err);
      return res.status(500).json({ success: false, error: 'Failed to load master data.' });
    }
  });

  app.get('/api/masters/floors', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, '*', 'List Production Lines');
      if (!caller) return;
      const snap = await db.collection('floors').get();
      const floors = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() || {}) }))
        .sort((a: any, b: any) => (Number(a.order) || 0) - (Number(b.order) || 0));
      return res.json({ success: true, floors });
    } catch (err: any) {
      console.error('[API List Floors] Error:', err);
      return res.status(500).json({ success: false, error: 'Failed to load production lines.' });
    }
  });

  app.post('/api/masters/floors', async (req: Request, res: Response) => {
    try {
      const caller = await requireMasterEditCaller(req, res, 'floors', 'Save Production Line');
      if (!caller) return;

      const parsed = FloorUpsertSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: parsed.error.issues[0]?.message || 'Invalid production line data.',
        });
      }

      const cleanName = normalizeWhitespaceAndUnicode(parsed.data.name);
      const snap = await db.collection('floors').get();
      const existing = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) })) as any[];
      const dup = findCaseInsensitiveMasterDuplicate(cleanName, parsed.data.id, existing);
      if (dup) {
        return res.status(409).json({
          success: false,
          error: `A Production Line named "${dup.name}" already exists. Case-variant duplicates are not allowed.`,
        });
      }

      const payload = {
        ...parsed.data,
        name: cleanName,
        code: parsed.data.code || cleanName,
        order: parsed.data.order ?? existing.length + 1,
        updatedAt: new Date().toISOString(),
      };
      await db.collection('floors').doc(payload.id).set(payload);
      invalidateConfigCaches(db);

      await recordEnterpriseAuditEvent(db, {
        req,
        action: 'SAVE_FLOOR',
        category: 'ORGANIZATION',
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        targetType: 'FLOOR',
        targetId: payload.id,
        newValue: payload.name,
        actionSource: 'FLOOR_MANAGEMENT',
        captureGeo: false,
      });

      return res.json({ success: true, floor: payload });
    } catch (err: any) {
      console.error('[API Save Floor] Error:', err);
      return res.status(500).json({ success: false, error: 'Failed to save production line.' });
    }
  });

  app.get('/api/masters/sections', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, '*', 'List Sections');
      if (!caller) return;
      const snap = await db.collection('sections').get();
      const sections = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
      return res.json({ success: true, sections });
    } catch (err: any) {
      console.error('[API List Sections] Error:', err);
      return res.status(500).json({ success: false, error: 'Failed to load sections.' });
    }
  });

  app.post('/api/masters/sections', async (req: Request, res: Response) => {
    try {
      const caller = await requireMasterEditCaller(req, res, 'sections', 'Save Section');
      if (!caller) return;

      const parsed = SectionUpsertSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: parsed.error.issues[0]?.message || 'Invalid section data.',
        });
      }

      const cleanName = normalizeWhitespaceAndUnicode(parsed.data.name);
      const snap = await db.collection('sections').get();
      const existing = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) })) as any[];
      const dup = findCaseInsensitiveMasterDuplicate(cleanName, parsed.data.id, existing);
      if (dup) {
        return res.status(409).json({
          success: false,
          error: `A Section named "${dup.name}" already exists. Case-variant duplicates are not allowed.`,
        });
      }

      const payload = {
        ...parsed.data,
        name: cleanName,
        code: parsed.data.code || cleanName,
        updatedAt: new Date().toISOString(),
      };
      await db.collection('sections').doc(payload.id).set(payload);
      invalidateConfigCaches(db);

      await recordEnterpriseAuditEvent(db, {
        req,
        action: 'SAVE_SECTION',
        category: 'ORGANIZATION',
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        targetType: 'SECTION',
        targetId: payload.id,
        newValue: payload.name,
        actionSource: 'SECTION_MANAGEMENT',
        captureGeo: false,
      });

      return res.json({ success: true, section: payload });
    } catch (err: any) {
      console.error('[API Save Section] Error:', err);
      return res.status(500).json({ success: false, error: 'Failed to save section.' });
    }
  });

  app.get('/api/masters/departments', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, '*', 'List Departments');
      if (!caller) return;
      const snap = await db.collection('departments').get();
      const departments = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
      return res.json({ success: true, departments });
    } catch (err: any) {
      console.error('[API List Departments] Error:', err);
      return res.status(500).json({ success: false, error: 'Failed to load departments.' });
    }
  });

  app.post('/api/masters/departments', async (req: Request, res: Response) => {
    try {
      const caller = await requireMasterEditCaller(req, res, 'departments', 'Save Department');
      if (!caller) return;

      const parsed = DepartmentUpsertSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: parsed.error.issues[0]?.message || 'Invalid department data.',
        });
      }

      const cleanName = normalizeWhitespaceAndUnicode(parsed.data.name);
      const snap = await db.collection('departments').get();
      const existing = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) })) as any[];
      const dup = findCaseInsensitiveMasterDuplicate(cleanName, parsed.data.id, existing);
      if (dup) {
        return res.status(409).json({
          success: false,
          error: `A Department named "${dup.name}" already exists. Case-variant duplicates are not allowed.`,
        });
      }

      const payload = {
        ...parsed.data,
        name: cleanName,
        code: parsed.data.code || cleanName,
        updatedAt: new Date().toISOString(),
      };
      await db.collection('departments').doc(payload.id).set(payload);
      invalidateConfigCaches(db);

      await recordEnterpriseAuditEvent(db, {
        req,
        action: 'SAVE_DEPARTMENT',
        category: 'ORGANIZATION',
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        targetType: 'DEPARTMENT',
        targetId: payload.id,
        newValue: payload.name,
        actionSource: 'DEPARTMENT_MANAGEMENT',
        captureGeo: false,
      });

      return res.json({ success: true, department: payload });
    } catch (err: any) {
      console.error('[API Save Department] Error:', err);
      return res.status(500).json({ success: false, error: 'Failed to save department.' });
    }
  });

  app.get('/api/masters/shifts', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, '*', 'List Shifts');
      if (!caller) return;
      const snap = await db.collection('shifts').get();
      const shifts = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
      return res.json({ success: true, shifts });
    } catch (err: any) {
      console.error('[API List Shifts] Error:', err);
      return res.status(500).json({ success: false, error: 'Failed to load shifts.' });
    }
  });

  app.post('/api/masters/shifts', async (req: Request, res: Response) => {
    try {
      const caller = await requireMasterEditCaller(req, res, 'shifts', 'Save Shift');
      if (!caller) return;

      const parsed = ShiftUpsertSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: parsed.error.issues[0]?.message || 'Invalid shift data.',
        });
      }

      const payload = { ...parsed.data, updatedAt: new Date().toISOString() };
      await db.collection('shifts').doc(payload.id).set(payload);
      invalidateConfigCaches(db);

      await recordEnterpriseAuditEvent(db, {
        req,
        action: 'SAVE_SHIFT',
        category: 'SHIFT',
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        targetType: 'SHIFT',
        targetId: payload.id,
        newValue: `${payload.name} (${payload.startTime}-${payload.endTime})`,
        actionSource: 'SHIFT_MANAGEMENT',
        captureGeo: false,
      });

      return res.json({ success: true, shift: payload });
    } catch (err: any) {
      console.error('[API Save Shift] Error:', err);
      return res.status(500).json({ success: false, error: 'Failed to save shift.' });
    }
  });

  app.get('/api/masters/settings', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, '*', 'Get System Settings');
      if (!caller) return;
      const snap = await db.collection('system_settings').doc('global').get();
      return res.json({ success: true, settings: snap.exists ? snap.data() : null });
    } catch (err: any) {
      console.error('[API Get Settings] Error:', err);
      return res.status(500).json({ success: false, error: 'Failed to load system settings.' });
    }
  });

  app.put('/api/masters/settings', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(req, res, ['super_admin'], 'Update System Settings');
      if (!caller) return;

      const parsed = SystemSettingsUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: parsed.error.issues[0]?.message || 'Invalid system settings.',
        });
      }

      const updates = { ...parsed.data, updatedAt: new Date().toISOString() };
      await db.collection('system_settings').doc('global').set(updates, { merge: true });
      invalidateConfigCaches(db);

      await recordEnterpriseAuditEvent(db, {
        req,
        action: 'UPDATE_SYSTEM_SETTINGS',
        category: 'SETTINGS',
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        targetType: 'SYSTEM_SETTINGS',
        targetId: 'global',
        newValue: JSON.stringify(parsed.data),
        actionSource: 'SETTINGS_PAGE',
        reason: 'Super Admin updated system settings',
        captureGeo: false,
      });

      return res.json({ success: true, settings: updates });
    } catch (err: any) {
      console.error('[API Update Settings] Error:', err);
      return res.status(500).json({ success: false, error: 'Failed to update system settings.' });
    }
  });
}
