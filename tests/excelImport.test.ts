import request from 'supertest';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createApp } from '../server.ts';
import {
  InMemoryAdminAuth,
  InMemoryFirestore,
  TEST_CANONICAL_ACCOUNTS,
  seedIsolatedTestEnvironment,
} from './helpers/inMemoryAdmin.ts';

function makeEmployeeRow(index: number, overrides: Partial<Record<string, any>> = {}) {
  const empId = `IMP${String(index).padStart(4, '0')}`;
  return {
    employeeId: empId,
    employeeName: `TEST WORKER ${index}`,
    employeeType: index % 3 === 0 ? 'Staff' : index % 2 === 0 ? 'Offroll' : 'Permanent',
    section: index % 2 === 0 ? 'FATP' : 'MI',
    department: index % 2 === 0 ? 'Quality' : 'Production',
    floor: index % 2 === 0 ? 'FATP-STB' : 'MI-01',
    designation: 'Assembly Operator',
    employeeStatus: 'Active',
    rowNumber: index + 1,
    ...overrides,
  };
}

describe('Employee Master Excel Bulk Import (Server Admin SDK & Safe Batching)', () => {
  let db: InMemoryFirestore;
  let auth: InMemoryAdminAuth;
  let app: ReturnType<typeof createApp>['app'];

  beforeEach(async () => {
    db = new InMemoryFirestore();
    auth = new InMemoryAdminAuth();
    await seedIsolatedTestEnvironment(db, auth);

    // Seed two pre-existing employees: one to be updated/kept unchanged, one completely unrelated
    await db.collection('employees').doc('UNRELATED01').set({
      employeeId: 'UNRELATED01',
      employeeName: 'EXISTING UNRELATED EMP',
      employeeType: 'Permanent',
      section: 'SMT',
      department: 'Production',
      floor: 'SMT-01',
      designation: 'SMT Technician',
      qrCodeToken: 'QR_UNRELATED01_ORIG_TOKEN',
      employeeStatus: 'Active',
      customMetadata: 'KEEP_ME_INTACT',
      createdAt: '2025-01-10T08:00:00.000Z',
      updatedAt: '2025-01-10T08:00:00.000Z',
    });

    await db.collection('employees').doc('EXIST001').set({
      employeeId: 'EXIST001',
      employeeName: 'RAMESH VERMA',
      employeeType: 'Permanent',
      section: 'MI',
      department: 'Production',
      floor: 'MI-01',
      designation: 'Operator',
      qrCodeToken: 'QR_EXIST001_PRESERVED_TOKEN',
      employeeStatus: 'Active',
      badgeNumber: 'B-991',
      createdAt: '2025-02-01T09:00:00.000Z',
      updatedAt: '2025-02-01T09:00:00.000Z',
    });

    app = createApp({
      db,
      auth,
      projectId: 'narid-atdc-tracker',
      databaseId: 'ai-studio-manpowertracker-9b87a863-5c0d-4126-accb-7a3be802b10b',
      credentialMode: 'ADC',
      disableBackgroundBoot: true,
    }).app;
  });

  it('1. Allows Super Admin to import 54 new employees atomically with deterministic IDs and audit trail', async () => {
    const superToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.superadmin.uid);
    const rows54 = Array.from({ length: 54 }, (_, idx) => makeEmployeeRow(idx + 1));

    const res = await request(app)
      .post('/api/employees/bulk-import')
      .set('Authorization', `Bearer ${superToken}`)
      .send({
        fileName: 'manpower_54.xlsx',
        rows: rows54,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.savedCount).toBe(54);
    expect(res.body.insertedCount).toBe(54);
    expect(res.body.updatedCount).toBe(0);
    expect(res.body.skippedCount).toBe(0);
    expect(res.body.failedCount).toBe(0);
    expect(res.body.partialCommit).toBe(false);
    expect(res.body.committedIds).toHaveLength(54);

    const initialCount = 4; // EMP001, EMP002 (from seedIsolatedTestEnvironment) + UNRELATED01 + EXIST001
    // Verify deterministic doc IDs and untouched unrelated employees
    const allEmps = db.getRawCollection('employees');
    expect(Object.keys(allEmps)).toHaveLength(initialCount + 54);
    expect(allEmps['IMP0001'].employeeName).toBe('TEST WORKER 1');
    expect(allEmps['IMP0054'].qrCodeToken).toMatch(/^QR_IMP0054_/);
    expect(allEmps['UNRELATED01']).toEqual({
      employeeId: 'UNRELATED01',
      employeeName: 'EXISTING UNRELATED EMP',
      employeeType: 'Permanent',
      section: 'SMT',
      department: 'Production',
      floor: 'SMT-01',
      designation: 'SMT Technician',
      qrCodeToken: 'QR_UNRELATED01_ORIG_TOKEN',
      employeeStatus: 'Active',
      customMetadata: 'KEEP_ME_INTACT',
      createdAt: '2025-01-10T08:00:00.000Z',
      updatedAt: '2025-01-10T08:00:00.000Z',
    });

    const auditSnap = await db.collection('audit_logs').where('action', '==', 'EXCEL_EMPLOYEE_IMPORT').get();
    expect(auditSnap.size).toBe(1);
    expect(auditSnap.docs[0].data()?.actorLoginId).toBe('superadmin');
  });

  it('2. Blocks unauthenticated callers (401) and unauthorized roles (403) without modifying any data', async () => {
    const sampleRows = [makeEmployeeRow(1)];

    // Unauthenticated
    const unauthRes = await request(app)
      .post('/api/employees/bulk-import')
      .send({ fileName: 'unauth.xlsx', rows: sampleRows });
    expect(unauthRes.status).toBe(401);

    // Scanner USER role
    const userToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.user.uid);
    const userRes = await request(app)
      .post('/api/employees/bulk-import')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ fileName: 'user_attempt.xlsx', rows: sampleRows });
    expect(userRes.status).toBe(403);
    expect(userRes.body.category).toBe('AUTHORIZATION');

    // Admin with excel_import revoked via user_permissions override
    const adminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid);
    await db.collection('user_permissions').doc('role_admin').set({
      id: 'role_admin',
      userId: 'role_admin',
      loginId: 'admin',
      role: 'admin',
      isCustomOverride: true,
      permissions: {
        excel_import: { view: false, add: false, edit: false, delete: false },
        employees: { view: true, add: false, edit: false, delete: false },
      },
    });
    const adminBlockedRes = await request(app)
      .post('/api/employees/bulk-import')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fileName: 'admin_revoked.xlsx', rows: sampleRows });
    expect(adminBlockedRes.status).toBe(403);

    // Ensure IMP0001 was NOT written
    const impDoc = await db.collection('employees').doc('IMP0001').get();
    expect(impDoc.exists).toBe(false);
  });

  it('3. Updates existing Employee IDs cleanly while preserving QR tokens, createdAt, and skipping unchanged rows', async () => {
    const superToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.superadmin.uid);

    const res = await request(app)
      .post('/api/employees/bulk-import')
      .set('Authorization', `Bearer ${superToken}`)
      .send({
        fileName: 'update_and_skip.xlsx',
        rows: [
          // Changed designation & floor for EXIST001 -> UPDATE
          {
            employeeId: 'exist001',
            employeeName: 'RAMESH VERMA',
            employeeType: 'Permanent',
            section: 'MI',
            department: 'Quality',
            floor: 'MI-02',
            designation: 'Senior QC Operator',
            employeeStatus: 'Active',
            rowNumber: 2,
          },
          // Completely identical to UNRELATED01 -> SKIP (UNCHANGED)
          {
            employeeId: 'UNRELATED01',
            employeeName: 'EXISTING UNRELATED EMP',
            employeeType: 'Permanent',
            section: 'SMT',
            department: 'Production',
            floor: 'SMT-01',
            designation: 'SMT Technician',
            employeeStatus: 'Active',
            rowNumber: 3,
          },
          // Brand new -> NEW
          makeEmployeeRow(99, { employeeId: 'NEW099', rowNumber: 4 }),
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.savedCount).toBe(2);
    expect(res.body.insertedCount).toBe(1);
    expect(res.body.updatedCount).toBe(1);
    expect(res.body.skippedCount).toBe(1);
    expect(res.body.insertedIds).toEqual(['NEW099']);
    expect(res.body.updatedIds).toEqual(['EXIST001']);
    expect(res.body.skippedIds).toEqual(['UNRELATED01']);

    const updatedExist = (await db.collection('employees').doc('EXIST001').get()).data()!;
    expect(updatedExist.department).toBe('Quality');
    expect(updatedExist.floor).toBe('MI-02');
    expect(updatedExist.designation).toBe('Senior QC Operator');
    // Strictly preserved existing token, createdAt, and extra field
    expect(updatedExist.qrCodeToken).toBe('QR_EXIST001_PRESERVED_TOKEN');
    expect(updatedExist.createdAt).toBe('2025-02-01T09:00:00.000Z');
    expect(updatedExist.badgeNumber).toBe('B-991');

    // Unchanged doc updatedAt remains untouched
    const skippedDoc = (await db.collection('employees').doc('UNRELATED01').get()).data()!;
    expect(skippedDoc.updatedAt).toBe('2025-01-10T08:00:00.000Z');
  });

  it('4. Rejects duplicate Employee IDs and invalid Employee IDs in payload cleanly with zero writes', async () => {
    const superToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.superadmin.uid);

    const dupRes = await request(app)
      .post('/api/employees/bulk-import')
      .set('Authorization', `Bearer ${superToken}`)
      .send({
        fileName: 'dups.xlsx',
        rows: [
          makeEmployeeRow(10, { employeeId: 'DUP100' }),
          makeEmployeeRow(11, { employeeId: 'dup100' }),
        ],
      });
    expect(dupRes.status).toBe(400);
    expect(dupRes.body.code).toBe('DUPLICATE_EMPLOYEE_IDS_IN_PAYLOAD');
    expect((await db.collection('employees').doc('DUP100').get()).exists).toBe(false);

    const badIdRes = await request(app)
      .post('/api/employees/bulk-import')
      .set('Authorization', `Bearer ${superToken}`)
      .send({
        fileName: 'bad_id.xlsx',
        rows: [makeEmployeeRow(12, { employeeId: 'BAD ID/12' })],
      });
    expect(badIdRes.status).toBe(400);
    expect(badIdRes.body.code).toBe('VALIDATION_ERROR');
  });

  it('5. Respects Firestore batch limits (<=400/batch), detects partial failures without blind retries, and safely retries failed records only', async () => {
    const superToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.superadmin.uid);
    const rows450 = Array.from({ length: 450 }, (_, idx) => makeEmployeeRow(idx + 1));

    // Spy on db.batch(): let chunk #1 (400 rows) succeed and make chunk #2 (50 rows) fail once
    const origBatch = db.batch.bind(db);
    let batchCalls = 0;
    const batchSpy = vi.spyOn(db, 'batch').mockImplementation(() => {
      batchCalls++;
      const realBatch = origBatch();
      if (batchCalls === 2) {
        return {
          set: realBatch.set.bind(realBatch),
          update: realBatch.update.bind(realBatch),
          delete: realBatch.delete.bind(realBatch),
          commit: async () => {
            throw new Error('Simulated DEADLINE_EXCEEDED timeout on batch 2');
          },
        };
      }
      return realBatch;
    });

    const partialRes = await request(app)
      .post('/api/employees/bulk-import')
      .set('Authorization', `Bearer ${superToken}`)
      .send({ fileName: 'batch_450.xlsx', rows: rows450 });

    // Exactly 2 batch calls (no blind retry of failed batch!)
    expect(batchCalls).toBe(2);
    expect(partialRes.status).toBe(503);
    expect(partialRes.body.success).toBe(false);
    expect(partialRes.body.category).toBe('NETWORK_OR_TIMEOUT');
    expect(partialRes.body.partialCommit).toBe(true);
    expect(partialRes.body.savedCount).toBe(400);
    expect(partialRes.body.insertedCount).toBe(400);
    expect(partialRes.body.failedCount).toBe(50);
    expect(partialRes.body.committedIds).toHaveLength(400);
    expect(partialRes.body.failedRows).toHaveLength(50);
    expect(partialRes.body.failedRows[0].employeeId).toBe('IMP0401');
    expect(partialRes.body.failedRows[49].employeeId).toBe('IMP0450');

    const initialCount = 4; // EMP001, EMP002, UNRELATED01, EXIST001
    // Verify first 400 exist in DB and last 50 do not yet exist
    expect(Object.keys(db.getRawCollection('employees'))).toHaveLength(initialCount + 400);

    // Restore normal batch behavior and retry ONLY the 50 failed rows
    batchSpy.mockRestore();
    const failedIdSet = new Set<string>(partialRes.body.failedRows.map((r: any) => r.employeeId));
    const failedSubset = rows450.filter((r) => failedIdSet.has(r.employeeId));

    const retryRes = await request(app)
      .post('/api/employees/bulk-import')
      .set('Authorization', `Bearer ${superToken}`)
      .send({ fileName: 'batch_450.xlsx', rows: failedSubset });

    expect(retryRes.status).toBe(200);
    expect(retryRes.body.success).toBe(true);
    expect(retryRes.body.savedCount).toBe(50);
    expect(retryRes.body.insertedCount).toBe(50);
    expect(retryRes.body.failedCount).toBe(0);

    // Confirm final employee count is exact (4 pre-existing + 450 imported = 454, zero duplicates)
    expect(Object.keys(db.getRawCollection('employees'))).toHaveLength(initialCount + 450);
  });

  it('6. Client parseAndValidateEmployeeExcel rejects invalid Employee ID characters upfront', async () => {
    const ExcelJSMod = await import('exceljs');
    const ExcelJS = (ExcelJSMod as any).default ?? ExcelJSMod;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(['Employee ID', 'Employee Name', 'Employee Type', 'Section', 'Department', 'Line', 'Designation', 'Status']);
    ws.addRow(['VALID_01', 'VALID USER', 'Permanent', 'MI', 'Production', 'MI-01', 'Operator', 'Active']);
    ws.addRow(['BAD ID/02', 'INVALID ID USER', 'Permanent', 'MI', 'Production', 'MI-01', 'Operator', 'Active']);
    const raw = await wb.xlsx.writeBuffer();
    const u8 = new Uint8Array(raw as ArrayLike<number>);
    const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

    // Spy on employeeService.getEmployees to avoid requiring live client network in unit test
    const employeeService = await import('../src/services/employeeService');
    const getEmpsSpy = vi.spyOn(employeeService, 'getEmployees').mockResolvedValue([]);

    try {
      const { parseAndValidateEmployeeExcel } = await import('../src/services/exportService');
      const fakeFile = {
        name: 'test_validation.xlsx',
        size: buf.byteLength,
        arrayBuffer: async () => buf,
      } as unknown as File;

      const parsed = await parseAndValidateEmployeeExcel(
        fakeFile,
        ['MI-01'],
        ['MI'],
        ['Production']
      );

      expect(parsed.summary.total).toBe(2);
      expect(parsed.summary.newCount).toBe(1);
      expect(parsed.summary.rejectedCount).toBe(1);
      expect(parsed.validRows[0].data.employeeId).toBe('VALID_01');
      expect(parsed.invalidRows[0].errors[0]).toContain('Invalid Employee ID');
    } finally {
      getEmpsSpy.mockRestore();
    }
  });

  it('7. Client commitImportedEmployees routes through /api/employees/bulk-import and surfaces structured EmployeeImportCommitError', async () => {
    const { auth: clientAuth } = await import('../src/firebase');
    const prevCurrentUser = clientAuth.currentUser;
    const prevFetch = globalThis.fetch;

    try {
      // Simulate authenticated client Firebase user
      Object.defineProperty(clientAuth, 'currentUser', {
        configurable: true,
        value: {
          uid: TEST_CANONICAL_ACCOUNTS.superadmin.uid,
          getIdToken: async () => 'mock-firebase-id-token-for-unit-test',
        },
      });

      const validItem = {
        actionType: 'NEW' as const,
        rowNumber: 2,
        data: {
          employeeId: 'IMP7001',
          employeeName: 'CLIENT TEST WORKER',
          employeeType: 'Permanent' as const,
          section: 'MI',
          department: 'Production',
          floor: 'MI-01',
          designation: 'Operator',
          qrCodeToken: 'QR_IMP7001_TMP',
          employeeStatus: 'Active' as const,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      };

      // Simulate 403 permission error from backend
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            success: false,
            code: 'IMPORT_FORBIDDEN',
            category: 'AUTHORIZATION',
            error: 'Forbidden: Role "USER" is not authorized to import or update Employee Master records.',
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        )) as typeof fetch;

      const { commitImportedEmployees, EmployeeImportCommitError } = await import(
        '../src/services/exportService'
      );

      let caughtErr: any = null;
      try {
        await commitImportedEmployees([validItem], 'blocked.xlsx');
      } catch (e) {
        caughtErr = e;
      }

      expect(caughtErr).toBeInstanceOf(EmployeeImportCommitError);
      expect(caughtErr.category).toBe('AUTHORIZATION');
      expect(caughtErr.partialCommit).toBe(false);
      expect(caughtErr.savedCount).toBe(0);

      // Simulate successful backend commit returning detailed counts
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            success: true,
            savedCount: 1,
            insertedCount: 1,
            updatedCount: 0,
            skippedCount: 0,
            failedCount: 0,
            committedIds: ['IMP7001'],
            insertedIds: ['IMP7001'],
            updatedIds: [],
            skippedIds: [],
            failedRows: [],
            partialCommit: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )) as typeof fetch;

      const okRes = await commitImportedEmployees([validItem], 'ok.xlsx');
      expect(okRes.savedCount).toBe(1);
      expect(okRes.insertedCount).toBe(1);
      expect(okRes.committedIds).toEqual(['IMP7001']);
    } finally {
      Object.defineProperty(clientAuth, 'currentUser', {
        configurable: true,
        value: prevCurrentUser,
      });
      globalThis.fetch = prevFetch;
    }
  });
});
