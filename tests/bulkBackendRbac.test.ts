import http from 'http';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createApp } from '../server.ts';
import {
  InMemoryAdminAuth,
  InMemoryFirestore,
  TEST_CANONICAL_ACCOUNTS,
  seedIsolatedTestEnvironment,
} from './helpers/inMemoryAdmin.ts';

describe('Backend Bulk Operations, Chunking, Data Safety & RBAC Guards', () => {
  let db: InMemoryFirestore;
  let auth: InMemoryAdminAuth;
  let server: http.Server;
  let baseUrl: string;

  let superAdminToken = '';
  let adminToken = '';
  let userToken = '';

  beforeAll(async () => {
    db = new InMemoryFirestore();
    auth = new InMemoryAdminAuth();
    await seedIsolatedTestEnvironment(db, auth);

    // Seed an extra non-protected super_admin & normal operator in user_roles + Auth for bulk-status tests
    const now = new Date().toISOString();
    auth.seedUser({ uid: 'uid_extra_op1', email: 'op1@narid.com', password: 'OpPassword#1' });
    auth.seedUser({ uid: 'uid_extra_op2', email: 'op2@narid.com', password: 'OpPassword#2' });

    await db.collection('user_roles').doc('role_op1').set({
      id: 'role_op1',
      loginId: 'op1',
      name: 'Operator One',
      email: 'op1@narid.com',
      authUid: 'uid_extra_op1',
      role: 'user',
      status: 'Active',
      modulesAllowed: ['dashboard', 'scanner'],
      createdAt: now,
      updatedAt: now,
    });
    await db.collection('user_roles').doc('role_op2').set({
      id: 'role_op2',
      loginId: 'op2',
      name: 'Operator Two',
      email: 'op2@narid.com',
      authUid: 'uid_extra_op2',
      role: 'user',
      status: 'Active',
      modulesAllowed: ['dashboard', 'scanner'],
      createdAt: now,
      updatedAt: now,
    });

    // Seed Floors, Sections, Departments for master bulk status tests
    await db.collection('floors').doc('f_mi01').set({ id: 'f_mi01', name: 'MI-01', code: 'F1', order: 1, status: 'Active', createdAt: now });
    await db.collection('floors').doc('f_mi02').set({ id: 'f_mi02', name: 'MI-02', code: 'F2', order: 2, status: 'Active', createdAt: now });
    await db.collection('sections').doc('sec_mi').set({ id: 'sec_mi', name: 'MI', status: 'Active', createdAt: now });
    await db.collection('departments').doc('dept_prod').set({ id: 'dept_prod', name: 'Production', status: 'Active', createdAt: now });

    // Seed an employee with attendance history + an employee with NO attendance history
    await db.collection('employees').doc('TST_CLEAN_DEL_1').set({
      id: 'TST_CLEAN_DEL_1',
      employeeId: 'TST_CLEAN_DEL_1',
      employeeName: 'CLEAN DELETE ONE',
      employeeType: 'Permanent',
      section: 'MI',
      department: 'Production',
      floor: 'MI-01',
      designation: 'Operator',
      employeeStatus: 'Active',
      qrCodeToken: 'QR_CLEAN_1',
      createdAt: '2025-01-10T00:00:00.000Z',
    });

    await db.collection('attendance').doc('att_emp001_20250115').set({
      id: 'att_emp001_20250115',
      employeeId: 'EMP001',
      date: '2025-01-15',
      punchInTime: '2025-01-15T09:00:00.000Z',
      punchOutTime: '2025-01-15T17:30:00.000Z',
    });

    const { app } = createApp({
      db,
      auth,
      projectId: 'narid-atdc-tracker',
      databaseId: 'ai-studio-manpowertracker-9b87a863-5c0d-4126-accb-7a3be802b10b',
      credentialMode: 'ADC',
      disableBackgroundBoot: true,
    });

    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;

    superAdminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.superadmin.uid);
    adminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid);
    userToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.user.uid);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function apiPost(path: string, token: string, body: Record<string, any>) {
    const resp = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    return { status: resp.status, data };
  }

  it('1. POST /api/employees/bulk-action enforces authentication and RBAC permissions', async () => {
    // Standard operator ('user') blocked 403
    const userRes = await apiPost('/api/employees/bulk-action', userToken, {
      action: 'DEACTIVATE',
      employeeIds: ['EMP001'],
      confirmed: true,
    });
    expect(userRes.status).toBe(403);
    expect(userRes.data.code).toBe('EMPLOYEE_BULK_FORBIDDEN');

    // Admin has employees.edit=true by default, employees.delete=false by default
    const adminDelRes = await apiPost('/api/employees/bulk-action', adminToken, {
      action: 'DELETE',
      employeeIds: ['TST_CLEAN_DEL_1'],
      confirmed: true,
      confirmPhrase: 'DELETE',
    });
    expect(adminDelRes.status).toBe(403);
    expect(adminDelRes.data.code).toBe('EMPLOYEE_BULK_FORBIDDEN');

    // Verify unauthorized attempt logged
    const audits = Object.values(db.getRawCollection('audit_logs'));
    expect(audits.some((a) => a.action === 'unauthorized_access_attempt')).toBe(true);
  });

  it('2. POST /api/employees/bulk-action updates status while strictly preserving qrCodeToken & createdAt', async () => {
    const res = await apiPost('/api/employees/bulk-action', superAdminToken, {
      action: 'DEACTIVATE',
      employeeIds: ['EMP001', 'EMP002', 'MISSING_ID'],
      confirmed: true,
    });
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.savedCount).toBe(1); // EMP001 updated; EMP002 already Inactive; MISSING_ID not found
    expect(res.data.skippedCount).toBe(2);
    expect(res.data.committedIds).toEqual(['EMP001']);

    const emp1 = (await db.collection('employees').doc('EMP001').get()).data()!;
    expect(emp1.employeeStatus).toBe('Inactive');
    expect(emp1.qrCodeToken).toBe('QR_EMP001_VALID');

    // Re-activate EMP001
    const actRes = await apiPost('/api/employees/bulk-action', superAdminToken, {
      action: 'ACTIVATE',
      employeeIds: ['EMP001'],
      confirmed: true,
    });
    expect(actRes.status).toBe(200);
    expect(actRes.data.savedCount).toBe(1);
    const emp1Restored = (await db.collection('employees').doc('EMP001').get()).data()!;
    expect(emp1Restored.employeeStatus).toBe('Active');
    expect(emp1Restored.qrCodeToken).toBe('QR_EMP001_VALID');
  });

  it('3. POST /api/employees/bulk-action DELETE requires confirmPhrase="DELETE" and protects employees with attendance history', async () => {
    const missingPhrase = await apiPost('/api/employees/bulk-action', superAdminToken, {
      action: 'DELETE',
      employeeIds: ['TST_CLEAN_DEL_1'],
      confirmed: true,
    });
    expect(missingPhrase.status).toBe(400);
    expect(missingPhrase.data.code).toBe('CONFIRMATION_PHRASE_REQUIRED');

    // Attempt to delete both EMP001 (has attendance history) and TST_CLEAN_DEL_1 (no attendance history)
    const delRes = await apiPost('/api/employees/bulk-action', superAdminToken, {
      action: 'DELETE',
      employeeIds: ['EMP001', 'TST_CLEAN_DEL_1'],
      confirmed: true,
      confirmPhrase: 'DELETE',
    });

    expect(delRes.status).toBe(200);
    expect(delRes.data.savedCount).toBe(1);
    expect(delRes.data.committedIds).toEqual(['TST_CLEAN_DEL_1']);
    expect(delRes.data.skippedCount).toBe(1);
    expect(delRes.data.skippedItems[0].id).toBe('EMP001');
    expect(delRes.data.skippedItems[0].reason).toContain('historical attendance');

    // Protected EMP001 and QR remain intact; TST_CLEAN_DEL_1 deleted
    expect((await db.collection('employees').doc('EMP001').get()).exists).toBe(true);
    expect((await db.collection('employees').doc('TST_CLEAN_DEL_1').get()).exists).toBe(false);
  });

  it('4. POST /api/employees/bulk-action handles >400 records across Firestore batch chunks AND supports partial retry', async () => {
    const bulkIds: string[] = [];
    for (let i = 1; i <= 425; i++) {
      const id = `TST_SCALE_${String(i).padStart(3, '0')}`;
      bulkIds.push(id);
      await db.collection('employees').doc(id).set({
        id,
        employeeId: id,
        employeeName: `SCALE WORKER ${i}`,
        employeeType: 'Permanent',
        section: 'MI',
        department: 'Production',
        floor: 'MI-01',
        designation: 'Operator',
        employeeStatus: 'Active',
        qrCodeToken: `QR_${id}`,
      });
    }

    // Force failure on 2nd batch chunk (indices 400..424)
    const origBatch = db.batch.bind(db);
    let batchCallCount = 0;
    const batchSpy = vi.spyOn(db, 'batch').mockImplementation(() => {
      batchCallCount++;
      const realBatch = origBatch();
      if (batchCallCount === 2) {
        return {
          set: realBatch.set.bind(realBatch),
          update: realBatch.update.bind(realBatch),
          delete: realBatch.delete.bind(realBatch),
          commit: async () => {
            throw new Error('Transient simulated Firestore chunk 2 failure');
          },
        };
      }
      return realBatch;
    });

    const partialRes = await apiPost('/api/employees/bulk-action', superAdminToken, {
      action: 'DEACTIVATE',
      employeeIds: bulkIds,
      confirmed: true,
    });

    batchSpy.mockRestore();

    expect(partialRes.status).toBe(500);
    expect(partialRes.data.partialCommit).toBe(true);
    expect(partialRes.data.savedCount).toBe(400);
    expect(partialRes.data.failedCount).toBe(25);
    expect(partialRes.data.committedIds).toHaveLength(400);
    expect(partialRes.data.failedItems).toHaveLength(25);

    // Retry only failedItems
    const retryIds = partialRes.data.failedItems.map((x: { id: string }) => x.id);
    const retryRes = await apiPost('/api/employees/bulk-action', superAdminToken, {
      action: 'DEACTIVATE',
      employeeIds: retryIds,
      confirmed: true,
    });
    expect(retryRes.status).toBe(200);
    expect(retryRes.data.savedCount).toBe(25);
    expect(retryRes.data.failedCount).toBe(0);
    expect((await db.collection('employees').doc('TST_SCALE_425').get()).data()?.employeeStatus).toBe('Inactive');
  });

  it('5. POST /api/masters/bulk-status enforces RBAC and preserves Night Shift timings', async () => {
    const userBlocked = await apiPost('/api/masters/bulk-status', userToken, {
      resource: 'shifts',
      ids: ['NIGHT'],
      status: 'Inactive',
      confirmed: true,
    });
    expect(userBlocked.status).toBe(403);
    expect(userBlocked.data.code).toBe('MASTER_BULK_FORBIDDEN');

    const adminShiftRes = await apiPost('/api/masters/bulk-status', adminToken, {
      resource: 'shifts',
      ids: ['NIGHT'],
      status: 'Inactive',
      confirmed: true,
    });
    expect(adminShiftRes.status).toBe(200);
    expect(adminShiftRes.data.savedCount).toBe(1);

    const nightShift = (await db.collection('shifts').doc('NIGHT').get()).data()!;
    expect(nightShift.status).toBe('Inactive');
    expect(nightShift.isOvernight).toBe(true);
    expect(nightShift.startTime).toBe('20:00');
    expect(nightShift.endTime).toBe('04:30');
    expect(nightShift.scheduledDurationMinutes).toBe(510);

    // Restore Active status + test floors, sections, departments
    await apiPost('/api/masters/bulk-status', superAdminToken, {
      resource: 'shifts',
      ids: ['NIGHT'],
      status: 'Active',
      confirmed: true,
    });
    const floorRes = await apiPost('/api/masters/bulk-status', adminToken, {
      resource: 'floors',
      ids: ['f_mi01', 'f_mi02'],
      status: 'Inactive',
      confirmed: true,
    });
    expect(floorRes.status).toBe(200);
    expect(floorRes.data.savedCount).toBe(2);

    const secRes = await apiPost('/api/masters/bulk-status', adminToken, {
      resource: 'sections',
      ids: ['sec_mi'],
      status: 'Inactive',
      confirmed: true,
    });
    expect(secRes.status).toBe(200);
    expect(secRes.data.savedCount).toBe(1);

    const deptRes = await apiPost('/api/masters/bulk-status', adminToken, {
      resource: 'departments',
      ids: ['dept_prod'],
      status: 'Inactive',
      confirmed: true,
    });
    expect(deptRes.status).toBe(200);
    expect(deptRes.data.savedCount).toBe(1);
  });

  it('6. POST /api/admin/users/bulk-status is Super Admin only and protects root/self/last-super-admin accounts', async () => {
    const adminBlocked = await apiPost('/api/admin/users/bulk-status', adminToken, {
      userIds: ['role_op1'],
      status: 'Inactive',
      confirmed: true,
    });
    expect(adminBlocked.status).toBe(403);

    const userBlocked = await apiPost('/api/admin/users/bulk-status', userToken, {
      userIds: ['role_op1'],
      status: 'Inactive',
      confirmed: true,
    });
    expect(userBlocked.status).toBe(403);

    // Attempt bulk deactivate including protected root 'role_superadmin' + two normal operators
    const res = await apiPost('/api/admin/users/bulk-status', superAdminToken, {
      userIds: ['role_superadmin', 'role_op1', 'role_op2'],
      status: 'Inactive',
      confirmed: true,
    });
    expect(res.status).toBe(200);
    expect(res.data.savedCount).toBe(2);
    expect(res.data.committedIds).toEqual(['role_op1', 'role_op2']);
    expect(res.data.skippedCount).toBe(1);
    expect(res.data.skippedItems[0].id).toBe('role_superadmin');

    // Root superadmin remains Active
    expect((await db.collection('user_roles').doc('role_superadmin').get()).data()?.status).toBe('Active');

    // Normal operators synced to Inactive in Firestore + Auth disabled
    expect((await db.collection('user_roles').doc('role_op1').get()).data()?.status).toBe('Inactive');
    expect((await auth.getUser('uid_extra_op1')).disabled).toBe(true);

    // Re-activate operators cleanly
    const reactivateRes = await apiPost('/api/admin/users/bulk-status', superAdminToken, {
      userIds: ['role_op1', 'role_op2'],
      status: 'Active',
      confirmed: true,
    });
    expect(reactivateRes.status).toBe(200);
    expect(reactivateRes.data.savedCount).toBe(2);
    expect((await auth.getUser('uid_extra_op1')).disabled).toBe(false);
  });
});
