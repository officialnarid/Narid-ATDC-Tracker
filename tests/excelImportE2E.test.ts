import http from 'http';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as XLSX from 'xlsx';
import { createApp } from '../server.ts';
import {
  InMemoryAdminAuth,
  InMemoryFirestore,
  TEST_CANONICAL_ACCOUNTS,
  seedIsolatedTestEnvironment,
} from './helpers/inMemoryAdmin.ts';

function buildExcelFile(rows: Array<Record<string, any>>, fileName: string): File {
  const headers = [
    'Employee ID',
    'Employee Name',
    'Employee Type',
    'Section',
    'Department',
    'Line',
    'Designation',
    'Status',
  ];

  const sheetData = [
    headers,
    ...rows.map((r) => [
      r.employeeId,
      r.employeeName,
      r.employeeType,
      r.section,
      r.department,
      r.floor,
      r.designation,
      r.employeeStatus,
    ]),
  ];

  const ws = XLSX.utils.aoa_to_sheet(sheetData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Employee_Master');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

  return {
    name: fileName,
    size: buf.byteLength,
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    arrayBuffer: async () => buf,
  } as unknown as File;
}

describe('End-to-End Verification: Employee Master Excel Import (Isolated Sandbox Dataset)', () => {
  let db: InMemoryFirestore;
  let auth: InMemoryAdminAuth;
  let server: http.Server;
  let baseUrl: string;
  let origFetch: typeof globalThis.fetch;
  let activeIdToken = '';
  let activeUid = '';

  const VALID_FLOORS = ['MI-01', 'MI-02', 'FATP-STB', 'SMT-01'];
  const VALID_SECTIONS = ['MI', 'FATP', 'SMT', 'STORE'];
  const VALID_DEPARTMENTS = ['Production', 'Quality', 'Store'];

  let superAdminToken = '';
  let unauthorizedUserToken = '';
  let origToken1 = '';
  let origCreatedAt1 = '';

  const twoEmployeeDataset = [
    {
      employeeId: 'TST_E2E_001',
      employeeName: 'SYNTHETIC TEST WORKER ONE',
      employeeType: 'Permanent',
      section: 'MI',
      department: 'Production',
      floor: 'MI-01',
      designation: 'Assembly Operator',
      employeeStatus: 'Active',
    },
    {
      employeeId: 'TST_E2E_002',
      employeeName: 'SYNTHETIC TEST WORKER TWO',
      employeeType: 'Offroll',
      section: 'SMT',
      department: 'Production',
      floor: 'SMT-01',
      designation: 'SMT Technician',
      employeeStatus: 'Active',
    },
  ];

  beforeAll(async () => {
    db = new InMemoryFirestore();
    auth = new InMemoryAdminAuth();
    await seedIsolatedTestEnvironment(db, auth);

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

    // Route client /api/* calls to our isolated running Express HTTP server
    origFetch = globalThis.fetch;
    globalThis.fetch = ((input: any, init?: RequestInit) => {
      if (typeof input === 'string' && input.startsWith('/api/')) {
        return origFetch(`${baseUrl}${input}`, init);
      }
      return origFetch(input, init);
    }) as typeof fetch;

    // Bind client auth.currentUser dynamically to the currently logged-in E2E actor
    const { auth: clientAuth } = await import('../src/firebase');
    Object.defineProperty(clientAuth, 'currentUser', {
      configurable: true,
      get: () =>
        activeIdToken
          ? {
              uid: activeUid,
              getIdToken: async () => activeIdToken,
            }
          : null,
    });
  });

  afterAll(async () => {
    globalThis.fetch = origFetch;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  async function mockClientEmployeeReadFromIsolatedDb() {
    const employeeService = await import('../src/services/employeeService');
    return vi.spyOn(employeeService, 'getEmployees').mockImplementation(async () => {
      const raw = db.getRawCollection('employees');
      return Object.entries(raw).map(([docId, d]) => ({
        id: docId,
        employeeId: String(d.employeeId || docId),
        employeeName: String(d.employeeName || ''),
        employeeType: d.employeeType,
        section: String(d.section || ''),
        department: String(d.department || ''),
        floor: String(d.floor || ''),
        designation: String(d.designation || 'Operator'),
        qrCodeToken: String(d.qrCodeToken || ''),
        employeeStatus: d.employeeStatus,
        createdAt: String(d.createdAt || ''),
        updatedAt: String(d.updatedAt || ''),
      }));
    });
  }

  it('Step 1: Logs in as canonical Super Admin and verifies active session', async () => {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        loginId: TEST_CANONICAL_ACCOUNTS.superadmin.loginId,
        password: TEST_CANONICAL_ACCOUNTS.superadmin.password,
      }),
    });
    const loginJson: any = await loginRes.json();

    expect(loginRes.status).toBe(200);
    expect(loginJson.success).toBe(true);
    expect(loginJson.profile.role).toBe('super_admin');
    expect(loginJson.profile.loginId).toBe('superadmin');
    expect(loginJson.profile.authUid).toBe(TEST_CANONICAL_ACCOUNTS.superadmin.uid);

    superAdminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.superadmin.uid, {
      email: TEST_CANONICAL_ACCOUNTS.superadmin.email,
    });
    activeUid = TEST_CANONICAL_ACCOUNTS.superadmin.uid;
    activeIdToken = superAdminToken;

    const verifyRes = await fetch(`${baseUrl}/api/auth/verify-session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${superAdminToken}`,
      },
      body: JSON.stringify({ loginId: 'superadmin' }),
    });
    const verifyJson: any = await verifyRes.json();
    expect(verifyRes.status).toBe(200);
    expect(verifyJson.success).toBe(true);
    expect(verifyJson.active).toBe(true);
    expect(verifyJson.profile.role).toBe('super_admin');
  });

  it('Steps 2–6: Uploads 2-employee .xlsx file, passes validation, commits via POST /api/employees/bulk-import, verifies Admin SDK persistence & inserted count', async () => {
    const spy = await mockClientEmployeeReadFromIsolatedDb();
    try {
      const { parseAndValidateEmployeeExcel, commitImportedEmployees } = await import(
        '../src/services/exportService'
      );

      const excelFile = buildExcelFile(twoEmployeeDataset, 'e2e_test_2_employees.xlsx');
      const validation = await parseAndValidateEmployeeExcel(
        excelFile,
        VALID_FLOORS,
        VALID_SECTIONS,
        VALID_DEPARTMENTS
      );

      // Step 3: Validation summary check
      expect(validation.summary).toEqual({
        total: 2,
        newCount: 2,
        updatedCount: 0,
        unchangedCount: 0,
        rejectedCount: 0,
      });
      expect(validation.invalidRows).toHaveLength(0);
      expect(validation.validRows.map((r) => r.actionType)).toEqual(['NEW', 'NEW']);

      // Step 4 & Step 6: Commit via authenticated POST /api/employees/bulk-import & check returned summary
      const commitSummary = await commitImportedEmployees(validation.validRows, excelFile.name);
      expect(commitSummary.savedCount).toBe(2);
      expect(commitSummary.insertedCount).toBe(2);
      expect(commitSummary.updatedCount).toBe(0);
      expect(commitSummary.skippedCount).toBe(0);
      expect(commitSummary.failedCount).toBe(0);
      expect(commitSummary.partialCommit).toBe(false);
      expect(commitSummary.committedIds).toEqual(['TST_E2E_001', 'TST_E2E_002']);

      // Step 5: Verify both records exist in Admin SDK Firestore collection with deterministic IDs & QR tokens
      const doc1 = (await db.collection('employees').doc('TST_E2E_001').get()).data();
      const doc2 = (await db.collection('employees').doc('TST_E2E_002').get()).data();

      expect(doc1).toBeTruthy();
      expect(doc1!.employeeId).toBe('TST_E2E_001');
      expect(doc1!.employeeName).toBe('SYNTHETIC TEST WORKER ONE');
      expect(doc1!.department).toBe('Production');
      expect(doc1!.floor).toBe('MI-01');
      expect(doc1!.qrCodeToken).toMatch(/^QR_TST_E2E_001_/);
      expect(doc1!.createdAt).toBeTruthy();

      expect(doc2).toBeTruthy();
      expect(doc2!.employeeId).toBe('TST_E2E_002');
      expect(doc2!.qrCodeToken).toMatch(/^QR_TST_E2E_002_/);

      origToken1 = doc1!.qrCodeToken;
      origCreatedAt1 = doc1!.createdAt;
    } finally {
      spy.mockRestore();
    }
  });

  it('Step 7: Re-uploads identical 2-employee .xlsx file and verifies duplicate prevention & idempotency (client & server)', async () => {
    const spy = await mockClientEmployeeReadFromIsolatedDb();
    try {
      const { parseAndValidateEmployeeExcel, commitImportedEmployees } = await import(
        '../src/services/exportService'
      );

      const repeatFile = buildExcelFile(twoEmployeeDataset, 'e2e_test_2_employees.xlsx');
      const reValidation = await parseAndValidateEmployeeExcel(
        repeatFile,
        VALID_FLOORS,
        VALID_SECTIONS,
        VALID_DEPARTMENTS
      );

      expect(reValidation.summary).toEqual({
        total: 2,
        newCount: 0,
        updatedCount: 0,
        unchangedCount: 2,
        rejectedCount: 0,
      });

      const clientRepeatRes = await commitImportedEmployees(reValidation.validRows, repeatFile.name);
      expect(clientRepeatRes.savedCount).toBe(0);
      expect(clientRepeatRes.insertedCount).toBe(0);
      expect(clientRepeatRes.updatedCount).toBe(0);
      expect(clientRepeatRes.skippedCount).toBe(2);

      // Also verify direct server-side idempotency when POST /api/employees/bulk-import receives identical rows
      const serverRepeatRes = await fetch(`${baseUrl}/api/employees/bulk-import`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${superAdminToken}`,
        },
        body: JSON.stringify({
          fileName: 'e2e_test_2_employees.xlsx',
          rows: twoEmployeeDataset,
        }),
      });
      const serverRepeatJson: any = await serverRepeatRes.json();

      expect(serverRepeatRes.status).toBe(200);
      expect(serverRepeatJson.success).toBe(true);
      expect(serverRepeatJson.savedCount).toBe(0);
      expect(serverRepeatJson.insertedCount).toBe(0);
      expect(serverRepeatJson.updatedCount).toBe(0);
      expect(serverRepeatJson.skippedCount).toBe(2);
      expect(serverRepeatJson.skippedIds).toEqual(['TST_E2E_001', 'TST_E2E_002']);

      // Confirm no duplicate docs and QR token / createdAt untouched
      const rawEmployees = db.getRawCollection('employees');
      expect(Object.keys(rawEmployees).filter((k) => k.startsWith('TST_E2E_'))).toHaveLength(2);
      expect(rawEmployees['TST_E2E_001'].qrCodeToken).toBe(origToken1);
      expect(rawEmployees['TST_E2E_001'].createdAt).toBe(origCreatedAt1);
    } finally {
      spy.mockRestore();
    }
  });

  it('Step 8: Verifies an unauthorized User cannot perform the import (403) and unauthenticated requests are blocked (401)', async () => {
    const userLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        loginId: TEST_CANONICAL_ACCOUNTS.user.loginId,
        password: TEST_CANONICAL_ACCOUNTS.user.password,
      }),
    });
    expect(userLoginRes.status).toBe(200);

    unauthorizedUserToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.user.uid, {
      email: TEST_CANONICAL_ACCOUNTS.user.email,
    });
    activeUid = TEST_CANONICAL_ACCOUNTS.user.uid;
    activeIdToken = unauthorizedUserToken;

    const { commitImportedEmployees, EmployeeImportCommitError } = await import(
      '../src/services/exportService'
    );

    let caughtErr: any = null;
    try {
      await commitImportedEmployees(
        [
          {
            actionType: 'NEW',
            rowNumber: 2,
            data: {
              employeeId: 'TST_UNAUTH_999',
              employeeName: 'UNAUTHORIZED TARGET',
              employeeType: 'Permanent',
              section: 'MI',
              department: 'Production',
              floor: 'MI-01',
              designation: 'Operator',
              qrCodeToken: 'QR_UNAUTH',
              employeeStatus: 'Active',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          },
        ],
        'unauthorized_attempt.xlsx'
      );
    } catch (e) {
      caughtErr = e;
    }

    expect(caughtErr).toBeInstanceOf(EmployeeImportCommitError);
    expect(caughtErr.status).toBe(403);
    expect(caughtErr.category).toBe('AUTHORIZATION');
    expect(caughtErr.code).toBe('IMPORT_FORBIDDEN');
    expect((await db.collection('employees').doc('TST_UNAUTH_999').get()).exists).toBe(false);

    // Confirm unauthenticated POST returns 401
    const unauthRes = await fetch(`${baseUrl}/api/employees/bulk-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: 'unauth.xlsx', rows: twoEmployeeDataset }),
    });
    expect(unauthRes.status).toBe(401);

    // Restore Super Admin active session for remaining steps
    activeUid = TEST_CANONICAL_ACCOUNTS.superadmin.uid;
    activeIdToken = superAdminToken;
  });

  it('Step 9: Updates an existing test employee and verifies QR token and createdAt remain strictly unchanged', async () => {
    const spy = await mockClientEmployeeReadFromIsolatedDb();
    try {
      const { parseAndValidateEmployeeExcel, commitImportedEmployees } = await import(
        '../src/services/exportService'
      );

      // Modify TST_E2E_001 department, section, floor & designation; keep TST_E2E_002 identical
      const updatedRows = [
        {
          employeeId: 'TST_E2E_001',
          employeeName: 'SYNTHETIC TEST WORKER ONE',
          employeeType: 'Permanent',
          section: 'FATP',
          department: 'Quality',
          floor: 'FATP-STB',
          designation: 'Senior QC Inspector',
          employeeStatus: 'Active',
        },
        twoEmployeeDataset[1],
      ];

      const updateFile = buildExcelFile(updatedRows, 'e2e_update_employee.xlsx');
      const validation = await parseAndValidateEmployeeExcel(
        updateFile,
        VALID_FLOORS,
        VALID_SECTIONS,
        VALID_DEPARTMENTS
      );

      expect(validation.summary).toEqual({
        total: 2,
        newCount: 0,
        updatedCount: 1,
        unchangedCount: 1,
        rejectedCount: 0,
      });

      const commitRes = await commitImportedEmployees(validation.validRows, updateFile.name);
      expect(commitRes.savedCount).toBe(1);
      expect(commitRes.insertedCount).toBe(0);
      expect(commitRes.updatedCount).toBe(1);
      expect(commitRes.skippedCount).toBe(1);
      expect(commitRes.updatedIds).toEqual(['TST_E2E_001']);

      const updatedDoc = (await db.collection('employees').doc('TST_E2E_001').get()).data()!;
      expect(updatedDoc.section).toBe('FATP');
      expect(updatedDoc.department).toBe('Quality');
      expect(updatedDoc.floor).toBe('FATP-STB');
      expect(updatedDoc.designation).toBe('Senior QC Inspector');
      // Critical invariant checks:
      expect(updatedDoc.qrCodeToken).toBe(origToken1);
      expect(updatedDoc.createdAt).toBe(origCreatedAt1);
      expect(updatedDoc.updatedAt).not.toBe(origCreatedAt1);
    } finally {
      spy.mockRestore();
    }
  });

  it('Step 10: Verifies audit logs are recorded correctly for imports and blocked unauthorized attempts', async () => {
    const auditRes = await fetch(`${baseUrl}/api/audit/logs?pageSize=50`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${superAdminToken}` },
    });
    const auditJson: any = await auditRes.json();

    expect(auditRes.status).toBe(200);
    expect(auditJson.success).toBe(true);

    const importLogs = (auditJson.logs || []).filter(
      (l: any) => l.action === 'EXCEL_EMPLOYEE_IMPORT'
    );
    expect(importLogs.length).toBeGreaterThanOrEqual(2);
    expect(importLogs.some((l: any) => l.targetId === 'e2e_test_2_employees.xlsx' && l.actorLoginId === 'superadmin' && l.success === true)).toBe(true);
    expect(importLogs.some((l: any) => l.targetId === 'e2e_update_employee.xlsx' && String(l.newValue || '').includes('Updated: 1') && l.success === true)).toBe(true);

    const unauthLogs = (auditJson.logs || []).filter(
      (l: any) => l.action === 'unauthorized_access_attempt' && l.targetType === 'EMPLOYEE_IMPORT'
    );
    expect(unauthLogs.length).toBeGreaterThanOrEqual(1);
    expect(unauthLogs[0].actorLoginId).toBe('user');
    expect(unauthLogs[0].severity).toBe('CRITICAL');
    expect(unauthLogs[0].success).toBe(false);
  });

  it('Step 11: Verifies a synthetic 54-row Excel file imports cleanly end-to-end after all previous checks', async () => {
    const spy = await mockClientEmployeeReadFromIsolatedDb();
    try {
      const { parseAndValidateEmployeeExcel, commitImportedEmployees } = await import(
        '../src/services/exportService'
      );

      const rows54 = Array.from({ length: 54 }, (_, idx) => {
        const n = idx + 1;
        return {
          employeeId: `TST_54_${String(n).padStart(3, '0')}`,
          employeeName: `SYNTHETIC BATCH WORKER ${n}`,
          employeeType: n % 3 === 0 ? 'Staff' : n % 2 === 0 ? 'Offroll' : 'Permanent',
          section: n % 2 === 0 ? 'FATP' : 'MI',
          department: n % 2 === 0 ? 'Quality' : 'Production',
          floor: n % 2 === 0 ? 'FATP-STB' : 'MI-01',
          designation: 'Operator',
          employeeStatus: 'Active',
        };
      });

      const file54 = buildExcelFile(rows54, 'synthetic_54_employees.xlsx');
      const validation54 = await parseAndValidateEmployeeExcel(
        file54,
        VALID_FLOORS,
        VALID_SECTIONS,
        VALID_DEPARTMENTS
      );

      expect(validation54.summary).toEqual({
        total: 54,
        newCount: 54,
        updatedCount: 0,
        unchangedCount: 0,
        rejectedCount: 0,
      });

      const commit54 = await commitImportedEmployees(validation54.validRows, file54.name);
      expect(commit54.savedCount).toBe(54);
      expect(commit54.insertedCount).toBe(54);
      expect(commit54.updatedCount).toBe(0);
      expect(commit54.skippedCount).toBe(0);
      expect(commit54.failedCount).toBe(0);
      expect(commit54.partialCommit).toBe(false);
      expect(commit54.committedIds).toHaveLength(54);

      const allRaw = db.getRawCollection('employees');
      // 2 seeded (EMP001, EMP002) + 2 E2E (TST_E2E_001, TST_E2E_002) + 54 batch = 58
      expect(Object.keys(allRaw)).toHaveLength(58);
      expect(allRaw['TST_E2E_001'].qrCodeToken).toBe(origToken1);
      expect(allRaw['TST_54_001'].qrCodeToken).toMatch(/^QR_TST_54_001_/);
      expect(allRaw['TST_54_054'].qrCodeToken).toMatch(/^QR_TST_54_054_/);

      // Verify 54-row audit log entry
      const auditSnap = await db
        .collection('audit_logs')
        .where('targetId', '==', 'synthetic_54_employees.xlsx')
        .get();
      expect(auditSnap.size).toBe(1);
      expect(auditSnap.docs[0].data()?.newValue).toContain('Committed 54 employees (New: 54');
    } finally {
      spy.mockRestore();
    }
  });
});
