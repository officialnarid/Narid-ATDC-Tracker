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
import {
  findCaseInsensitiveMasterDuplicate,
  normalizeMasterLookupKey,
  normalizeWhitespaceAndUnicode,
} from '../src/utils/excelMasterNormalizer.ts';

function buildExcelFileFromAoA(sheetData: any[][], fileName: string): File {
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

describe('Case-Insensitive Excel Import & Update Normalization (Isolated In-Memory E2E)', () => {
  let db: InMemoryFirestore;
  let auth: InMemoryAdminAuth;
  let server: http.Server;
  let baseUrl: string;
  let origFetch: typeof globalThis.fetch;
  let superAdminToken = '';
  let activeUid = '';
  let activeIdToken = '';

  const MASTER_FLOORS = [
    { id: 'floor_asm', name: 'Assembly Line', code: 'ASM-01' },
    { id: 'floor_mi01', name: 'MI-01', code: 'MI-01' },
    { id: 'floor_smt01', name: 'SMT-01', code: 'SMT-01' },
  ];

  const MASTER_SECTIONS = [
    { id: 'sec_store', name: 'STORE', code: 'STR' },
    { id: 'sec_mi', name: 'MI', code: 'MI' },
    { id: 'sec_smt', name: 'SMT', code: 'SMT' },
  ];

  const MASTER_DEPARTMENTS = [
    { id: 'dept_prod', name: 'Production', code: 'PROD' },
    { id: 'dept_qual', name: 'Quality', code: 'QUAL' },
    { id: 'dept_store', name: 'STORE', code: 'STR' },
  ];

  const MASTER_DESIGNATIONS = [
    { id: 'desig_op', name: 'Assembly Operator', code: 'OP' },
    { id: 'desig_qi', name: 'Quality Inspector', code: 'QI' },
    { id: 'desig_inv', name: 'Inventory Officer', code: 'INV' },
  ];

  const EXISTING_ATTENDANCE_ID = 'ATT_HIST_PRESERVE_001';
  const EXISTING_QR_TOKEN = 'QR_EMP_EXIST_001_IMMUTABLE_BADGE_TOKEN';
  const EXISTING_CREATED_AT = '2025-01-15T04:00:00.000Z';

  beforeAll(async () => {
    db = new InMemoryFirestore();
    auth = new InMemoryAdminAuth();
    await seedIsolatedTestEnvironment(db, auth);

    // Seed isolated master collections with exact website capitalization
    for (const f of MASTER_FLOORS) {
      await db.collection('floors').doc(f.id).set({ ...f, active: true });
    }
    for (const s of MASTER_SECTIONS) {
      await db.collection('sections').doc(s.id).set({ ...s, active: true });
    }
    for (const d of MASTER_DEPARTMENTS) {
      await db.collection('departments').doc(d.id).set({ ...d, active: true });
    }
    for (const des of MASTER_DESIGNATIONS) {
      await db.collection('designations').doc(des.id).set({ ...des, active: true });
    }

    // Seed an existing employee with QR token and historical attendance record
    await db.collection('employees').doc('EMP_EXIST_001').set({
      employeeId: 'EMP_EXIST_001',
      employeeName: 'Priya Nair',
      employeeType: 'Staff',
      section: 'STORE',
      sectionId: 'sec_store',
      department: 'Production',
      departmentId: 'dept_prod',
      floor: 'Assembly Line',
      floorId: 'floor_asm',
      lineId: 'floor_asm',
      designation: 'Inventory Officer',
      designationId: 'desig_inv',
      qrCodeToken: EXISTING_QR_TOKEN,
      employeeStatus: 'Active',
      createdAt: EXISTING_CREATED_AT,
      updatedAt: EXISTING_CREATED_AT,
    });

    await db.collection('attendance').doc(EXISTING_ATTENDANCE_ID).set({
      id: EXISTING_ATTENDANCE_ID,
      employeeId: 'EMP_EXIST_001',
      employeeName: 'Priya Nair',
      date: '2026-11-20',
      shift: 'DAY',
      punchInTime: '2026-11-20T03:30:00.000Z',
      punchOutTime: '2026-11-20T12:00:00.000Z',
      totalWorkMinutes: 510,
      overtimeMinutes: 0,
      attendanceStatus: 'PRESENT',
    });

    const { app } = createApp({
      db,
      auth,
      projectId: 'narid-atdc-tracker',
      databaseId: 'isolated-case-norm-test-db',
      credentialMode: 'ADC',
      disableBackgroundBoot: true,
    });

    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;

    origFetch = globalThis.fetch;
    globalThis.fetch = ((input: any, init?: RequestInit) => {
      if (typeof input === 'string' && input.startsWith('/api/')) {
        return origFetch(`${baseUrl}${input}`, init);
      }
      return origFetch(input, init);
    }) as typeof fetch;

    superAdminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.superadmin.uid, {
      email: TEST_CANONICAL_ACCOUNTS.superadmin.email,
    });
    activeUid = TEST_CANONICAL_ACCOUNTS.superadmin.uid;
    activeIdToken = superAdminToken;

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

  async function mockClientEmployeeRead() {
    const employeeService = await import('../src/services/employeeService');
    return vi.spyOn(employeeService, 'getEmployees').mockImplementation(async () => {
      const raw = db.getRawCollection('employees');
      return Object.entries(raw).map(([docId, d]) => ({
        id: docId,
        employeeId: String(d.employeeId || docId),
        employeeName: String(d.employeeName || ''),
        employeeType: d.employeeType,
        section: String(d.section || ''),
        sectionId: d.sectionId,
        department: String(d.department || ''),
        departmentId: d.departmentId,
        floor: String(d.floor || ''),
        floorId: d.floorId,
        lineId: d.lineId,
        designation: String(d.designation || 'Operator'),
        designationId: d.designationId,
        qrCodeToken: String(d.qrCodeToken || ''),
        employeeStatus: d.employeeStatus,
        createdAt: String(d.createdAt || ''),
        updatedAt: String(d.updatedAt || ''),
      }));
    });
  }

  it('Tests 1–6 & 12: Matches STORE/store, Production/PRODUCTION, Quality/quality, Assembly Line/assembly line, Staff/STAFF, whitespace, mixed-case, and Unicode without error; inserts new & updates existing', async () => {
    const spy = await mockClientEmployeeRead();
    try {
      const { parseAndValidateEmployeeExcel, commitImportedEmployees } = await import(
        '../src/services/exportService'
      );

      // Includes:
      // Row 2 (NEW): store, PRODUCTION, assembly line, STAFF, assembly operator, ACTIVE
      // Row 3 (NEW): leading/trailing & repeated spaces + mixed case: "  sToRe  ", "  quality ", "  Assembly   Line  ", "  pErMaNeNt  ", "  qUaLiTy   iNsPeCtOr ", "  aCtIvE  "
      // Row 4 (NEW): Unicode fullwidth / NBSP normalization + mixed case: "\u00A0Store\u00A0", "pRoDuCtIoN", "mi-01", "offroll", "Inventory\u00A0Officer", "active"
      // Row 5 (UPDATE existing EMP_EXIST_001): changes department from Production -> quality (lowercase) while keeping section "store" & line "assembly line" (no false diff on unchanged case-normalized fields!)
      const sheetData = [
        [
          'Employee ID',
          'Employee Name',
          'Employee Type',
          'Section',
          'Department',
          'Line',
          'Designation',
          'Status',
        ],
        [
          'EMP_NORM_001',
          'Rahul Sharma',
          'STAFF',
          'store',
          'PRODUCTION',
          'assembly line',
          'assembly operator',
          'ACTIVE',
        ],
        [
          'EMP_NORM_002',
          '  Ananya   Verma  ',
          '  pErMaNeNt  ',
          '  sToRe  ',
          '  quality ',
          '  Assembly   Line  ',
          '  qUaLiTy   iNsPeCtOr ',
          '  aCtIvE  ',
        ],
        [
          'EMP_NORM_003',
          'Vikram Singh',
          'offroll',
          '\u00A0Store\u00A0',
          'pRoDuCtIoN',
          'mi-01',
          'Inventory\u00A0Officer',
          'active',
        ],
        [
          'EMP_EXIST_001',
          'Priya Nair',
          'staff',
          'sToRe',
          'quality',
          'assembly line',
          'inventory officer',
          'active',
        ],
      ];

      const file = buildExcelFileFromAoA(sheetData, 'case_normalization_test.xlsx');
      const validation = await parseAndValidateEmployeeExcel(
        file,
        MASTER_FLOORS,
        MASTER_SECTIONS,
        MASTER_DEPARTMENTS,
        { designations: MASTER_DESIGNATIONS }
      );

      expect(validation.invalidRows).toHaveLength(0);
      expect(validation.summary).toEqual({
        total: 4,
        newCount: 3,
        updatedCount: 1,
        unchangedCount: 0,
        rejectedCount: 0,
      });

      // Verify normalization preview transparency metadata
      expect((validation.normalizedCellCount || 0) > 0).toBe(true);
      expect(validation.caseNormalizedRowCount).toBe(4);
      expect(validation.normalizationSummary && validation.normalizationSummary.length > 0).toBe(true);

      // Row 1: Canonical master values & exact master IDs preserved (Website capitalization wins)
      const r1 = validation.validRows.find((r) => r.data.employeeId === 'EMP_NORM_001')!;
      expect(r1.actionType).toBe('NEW');
      expect(r1.data.employeeName).toBe('Rahul Sharma'); // Free-text name capitalization preserved!
      expect(r1.data.employeeType).toBe('Staff');
      expect(r1.data.section).toBe('STORE');
      expect(r1.data.sectionId).toBe('sec_store');
      expect(r1.data.department).toBe('Production');
      expect(r1.data.departmentId).toBe('dept_prod');
      expect(r1.data.floor).toBe('Assembly Line');
      expect(r1.data.floorId).toBe('floor_asm');
      expect(r1.data.lineId).toBe('floor_asm');
      expect(r1.data.designation).toBe('Assembly Operator');
      expect(r1.data.designationId).toBe('desig_op');
      expect(r1.data.employeeStatus).toBe('Active');
      expect(r1.normalizedFields?.section?.originalValue).toBe('store');
      expect(r1.normalizedFields?.section?.canonicalValue).toBe('STORE');
      expect(r1.normalizedFields?.section?.wasNormalized).toBe(true);

      // Row 2: Whitespace + mixed-case normalized cleanly; name whitespace collapsed without uppercasing
      const r2 = validation.validRows.find((r) => r.data.employeeId === 'EMP_NORM_002')!;
      expect(r2.data.employeeName).toBe('Ananya Verma');
      expect(r2.data.employeeType).toBe('Permanent');
      expect(r2.data.section).toBe('STORE');
      expect(r2.data.department).toBe('Quality');
      expect(r2.data.departmentId).toBe('dept_qual');
      expect(r2.data.floor).toBe('Assembly Line');
      expect(r2.data.designation).toBe('Quality Inspector');
      expect(r2.data.employeeStatus).toBe('Active');

      // Row 3: NBSP + mixed case
      const r3 = validation.validRows.find((r) => r.data.employeeId === 'EMP_NORM_003')!;
      expect(r3.data.section).toBe('STORE');
      expect(r3.data.department).toBe('Production');
      expect(r3.data.floor).toBe('MI-01');
      expect(r3.data.floorId).toBe('floor_mi01');
      expect(r3.data.employeeType).toBe('Offroll');

      // Row 4: Existing employee update — only Department genuinely changed (Production -> Quality)
      const r4 = validation.validRows.find((r) => r.data.employeeId === 'EMP_EXIST_001')!;
      expect(r4.actionType).toBe('UPDATE');
      expect(r4.diffs).toEqual(['Dept: Production -> Quality']);
      expect(r4.data.department).toBe('Quality');
      expect(r4.data.departmentId).toBe('dept_qual');
      expect(r4.data.qrCodeToken).toBe(EXISTING_QR_TOKEN);

      // Commit via live backend POST /api/employees/bulk-import
      const commitRes = await commitImportedEmployees(validation.validRows, file.name);
      expect(commitRes.savedCount).toBe(4);
      expect(commitRes.insertedCount).toBe(3);
      expect(commitRes.updatedCount).toBe(1);
      expect(commitRes.failedCount).toBe(0);

      // Verify persisted records in Firestore
      const savedNew1 = (await db.collection('employees').doc('EMP_NORM_001').get()).data()!;
      expect(savedNew1.section).toBe('STORE');
      expect(savedNew1.sectionId).toBe('sec_store');
      expect(savedNew1.department).toBe('Production');
      expect(savedNew1.departmentId).toBe('dept_prod');
      expect(savedNew1.floor).toBe('Assembly Line');
      expect(savedNew1.floorId).toBe('floor_asm');
      expect(savedNew1.designation).toBe('Assembly Operator');
      expect(savedNew1.designationId).toBe('desig_op');
      expect(savedNew1.employeeName).toBe('Rahul Sharma');

      const savedExist = (await db.collection('employees').doc('EMP_EXIST_001').get()).data()!;
      expect(savedExist.employeeId).toBe('EMP_EXIST_001');
      expect(savedExist.department).toBe('Quality');
      expect(savedExist.departmentId).toBe('dept_qual');
      expect(savedExist.qrCodeToken).toBe(EXISTING_QR_TOKEN);
      expect(savedExist.createdAt).toBe(EXISTING_CREATED_AT);
    } finally {
      spy.mockRestore();
    }
  });

  it('Tests 7 & 9: Does NOT create duplicate master records and preserves exact website master capitalization', async () => {
    const floorsRaw = db.getRawCollection('floors');
    const sectionsRaw = db.getRawCollection('sections');
    const deptsRaw = db.getRawCollection('departments');
    const desigsRaw = db.getRawCollection('designations');

    // Exact counts unchanged — zero duplicate master records created
    expect(Object.keys(floorsRaw)).toHaveLength(MASTER_FLOORS.length);
    expect(Object.keys(sectionsRaw)).toHaveLength(MASTER_SECTIONS.length);
    expect(Object.keys(deptsRaw)).toHaveLength(MASTER_DEPARTMENTS.length);
    expect(Object.keys(desigsRaw)).toHaveLength(MASTER_DESIGNATIONS.length);

    // Exact website display capitalization preserved
    expect(sectionsRaw.sec_store.name).toBe('STORE');
    expect(deptsRaw.dept_prod.name).toBe('Production');
    expect(deptsRaw.dept_qual.name).toBe('Quality');
    expect(floorsRaw.floor_asm.name).toBe('Assembly Line');

    // Duplicate prevention helper blocks creating "store", "Store", "sToRe", or "  store  "
    expect(findCaseInsensitiveMasterDuplicate('store', undefined, MASTER_SECTIONS)?.id).toBe('sec_store');
    expect(findCaseInsensitiveMasterDuplicate('Store', undefined, MASTER_SECTIONS)?.id).toBe('sec_store');
    expect(findCaseInsensitiveMasterDuplicate('  sToRe  ', undefined, MASTER_SECTIONS)?.id).toBe('sec_store');
    // Editing the same master record ID is allowed
    expect(findCaseInsensitiveMasterDuplicate('STORE', 'sec_store', MASTER_SECTIONS)).toBeNull();
  });

  it('Tests 10 & 11: Partial Excel update preserves omitted fields, QR tokens, Employee ID, and historical attendance records; casing-only re-upload is UNCHANGED', async () => {
    const spy = await mockClientEmployeeRead();
    try {
      const { parseAndValidateEmployeeExcel, commitImportedEmployees } = await import(
        '../src/services/exportService'
      );

      // Upload a partial Excel file containing ONLY Employee ID, Employee Name, and Department (omitting Section, Line, Type, Designation, Status)
      const partialSheet = [
        ['Employee ID', 'Employee Name', 'Department'],
        ['EMP_EXIST_001', 'Priya Nair', '  production  '],
      ];
      const partialFile = buildExcelFileFromAoA(partialSheet, 'partial_dept_update.xlsx');
      const validation = await parseAndValidateEmployeeExcel(
        partialFile,
        MASTER_FLOORS,
        MASTER_SECTIONS,
        MASTER_DEPARTMENTS,
        { designations: MASTER_DESIGNATIONS }
      );

      expect(validation.invalidRows).toHaveLength(0);
      expect(validation.validRows).toHaveLength(1);
      expect(validation.validRows[0].actionType).toBe('UPDATE');
      expect(validation.validRows[0].diffs).toEqual(['Dept: Quality -> Production']);

      const commitRes = await commitImportedEmployees(validation.validRows, partialFile.name);
      expect(commitRes.updatedCount).toBe(1);

      const updatedDoc = (await db.collection('employees').doc('EMP_EXIST_001').get()).data()!;
      expect(updatedDoc.department).toBe('Production');
      expect(updatedDoc.departmentId).toBe('dept_prod');
      // Omitted columns preserved verbatim!
      expect(updatedDoc.section).toBe('STORE');
      expect(updatedDoc.sectionId).toBe('sec_store');
      expect(updatedDoc.floor).toBe('Assembly Line');
      expect(updatedDoc.floorId).toBe('floor_asm');
      expect(updatedDoc.employeeType).toBe('Staff');
      expect(updatedDoc.designation).toBe('Inventory Officer');
      expect(updatedDoc.employeeStatus).toBe('Active');
      expect(updatedDoc.qrCodeToken).toBe(EXISTING_QR_TOKEN);
      expect(updatedDoc.createdAt).toBe(EXISTING_CREATED_AT);

      // Re-uploading exact same employee with only mixed-case master values -> UNCHANGED (no unnecessary update)
      const casingOnlySheet = [
        ['Employee ID', 'Employee Name', 'Employee Type', 'Section', 'Department', 'Line', 'Designation', 'Status'],
        ['EMP_EXIST_001', 'Priya Nair', 'STAFF', 'store', 'PRODUCTION', 'assembly line', 'INVENTORY OFFICER', 'ACTIVE'],
      ];
      const casingFile = buildExcelFileFromAoA(casingOnlySheet, 'casing_only_reupload.xlsx');
      const recheck = await parseAndValidateEmployeeExcel(
        casingFile,
        MASTER_FLOORS,
        MASTER_SECTIONS,
        MASTER_DEPARTMENTS,
        { designations: MASTER_DESIGNATIONS }
      );
      expect(recheck.summary.unchangedCount).toBe(1);
      expect(recheck.summary.updatedCount).toBe(0);
      expect(recheck.validRows[0].actionType).toBe('UNCHANGED');

      // Test 11: Verify historical attendance record is completely untouched
      const attDoc = (await db.collection('attendance').doc(EXISTING_ATTENDANCE_ID).get()).data()!;
      expect(attDoc).toEqual({
        id: EXISTING_ATTENDANCE_ID,
        employeeId: 'EMP_EXIST_001',
        employeeName: 'Priya Nair',
        date: '2026-11-20',
        shift: 'DAY',
        punchInTime: '2026-11-20T03:30:00.000Z',
        punchOutTime: '2026-11-20T12:00:00.000Z',
        totalWorkMinutes: 510,
        overtimeMinutes: 0,
        attendanceStatus: 'PRESENT',
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('Backend enforces case-insensitive normalization independently even on raw API calls and rejects spoofed master IDs', async () => {
    // 1. Direct API call with raw mixed-case strings (bypassing frontend normalization)
    const directRes = await fetch(`${baseUrl}/api/employees/bulk-import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${superAdminToken}`,
      },
      body: JSON.stringify({
        fileName: 'direct_api_mixed_case.xlsx',
        rows: [
          {
            employeeId: 'EMP_API_DIRECT_01',
            employeeName: 'Meera Joshi',
            employeeType: '  sTaFf ',
            section: '  store ',
            department: '  PRODUCTION ',
            floor: '  assembly   line ',
            designation: '  quality   inspector ',
            employeeStatus: '  aCtIvE ',
          },
        ],
      }),
    });

    const directJson: any = await directRes.json();
    expect(directRes.status).toBe(200);
    expect(directJson.success).toBe(true);
    expect(directJson.insertedCount).toBe(1);
    expect(directJson.normalizedCount).toBe(1);

    const directDoc = (await db.collection('employees').doc('EMP_API_DIRECT_01').get()).data()!;
    expect(directDoc.employeeName).toBe('Meera Joshi');
    expect(directDoc.employeeType).toBe('Staff');
    expect(directDoc.section).toBe('STORE');
    expect(directDoc.sectionId).toBe('sec_store');
    expect(directDoc.department).toBe('Production');
    expect(directDoc.departmentId).toBe('dept_prod');
    expect(directDoc.floor).toBe('Assembly Line');
    expect(directDoc.floorId).toBe('floor_asm');
    expect(directDoc.designation).toBe('Quality Inspector');
    expect(directDoc.designationId).toBe('desig_qi');
    expect(directDoc.employeeStatus).toBe('Active');

    // 2. Backend rejects spoofed/mismatched master ID (e.g., sending department "Production" with departmentId "dept_qual")
    const spoofRes = await fetch(`${baseUrl}/api/employees/bulk-import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${superAdminToken}`,
      },
      body: JSON.stringify({
        fileName: 'spoofed_master_id.xlsx',
        rows: [
          {
            employeeId: 'EMP_SPOOF_999',
            employeeName: 'Spoofed Test',
            employeeType: 'Staff',
            section: 'STORE',
            department: 'production',
            departmentId: 'dept_qual', // Wrong ID for Production!
            floor: 'Assembly Line',
            designation: 'Assembly Operator',
            employeeStatus: 'Active',
          },
        ],
      }),
    });

    const spoofJson: any = await spoofRes.json();
    expect(spoofRes.status).toBe(400);
    expect(spoofJson.code).toBe('MASTER_ID_MISMATCH');
    expect(spoofJson.savedCount).toBe(0);
    expect((await db.collection('employees').doc('EMP_SPOOF_999').get()).exists).toBe(false);
  });

  it('Test 8: Flags ambiguous master data safely in BOTH frontend preview and backend API (never guesses, 0 DB writes)', async () => {
    const spy = await mockClientEmployeeRead();
    // Temporarily add a conflicting duplicate case-variant department in isolated in-memory Firestore
    await db.collection('departments').doc('dept_store_dup').set({
      id: 'dept_store_dup',
      name: 'store',
      code: 'STR2',
      active: true,
    });

    const ambiguousDepartments = [
      ...MASTER_DEPARTMENTS,
      { id: 'dept_store_dup', name: 'store', code: 'STR2' },
    ];

    try {
      const { parseAndValidateEmployeeExcel } = await import('../src/services/exportService');

      const sheet = [
        ['Employee ID', 'Employee Name', 'Employee Type', 'Section', 'Department', 'Line', 'Designation', 'Status'],
        ['EMP_AMBIG_001', 'Conflict Test', 'Staff', 'MI', 'Store', 'MI-01', 'Assembly Operator', 'Active'],
      ];
      const file = buildExcelFileFromAoA(sheet, 'ambiguous_master.xlsx');

      // 1. Frontend preview flags ambiguity instead of guessing
      const preview = await parseAndValidateEmployeeExcel(
        file,
        MASTER_FLOORS,
        MASTER_SECTIONS,
        ambiguousDepartments,
        { designations: MASTER_DESIGNATIONS }
      );

      expect(preview.validRows).toHaveLength(0);
      expect(preview.invalidRows).toHaveLength(1);
      expect(preview.ambiguousRowCount).toBe(1);
      expect(preview.invalidRows[0].hasAmbiguity).toBe(true);
      expect(preview.invalidRows[0].errors[0]).toMatch(/Ambiguous Department/i);
      expect(preview.ambiguities).toHaveLength(1);
      expect(preview.ambiguities![0].candidates.map((c) => c.id).sort()).toEqual([
        'dept_store',
        'dept_store_dup',
      ]);

      // 2. Backend API independently rejects ambiguous master match with 400 AMBIGUOUS_MASTER_MATCH & 0 writes
      const apiRes = await fetch(`${baseUrl}/api/employees/bulk-import`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${superAdminToken}`,
        },
        body: JSON.stringify({
          fileName: 'ambiguous_master.xlsx',
          rows: [
            {
              employeeId: 'EMP_AMBIG_001',
              employeeName: 'Conflict Test',
              employeeType: 'Staff',
              section: 'MI',
              department: 'Store',
              floor: 'MI-01',
              designation: 'Assembly Operator',
              employeeStatus: 'Active',
            },
          ],
        }),
      });

      const apiJson: any = await apiRes.json();
      expect(apiRes.status).toBe(400);
      expect(apiJson.code).toBe('AMBIGUOUS_MASTER_MATCH');
      expect(apiJson.savedCount).toBe(0);
      expect(apiJson.failedRows).toHaveLength(1);
      expect(apiJson.failedRows[0].error).toMatch(/Ambiguous Department/i);
      expect((await db.collection('employees').doc('EMP_AMBIG_001').get()).exists).toBe(false);
    } finally {
      await db.collection('departments').doc('dept_store_dup').delete();
      spy.mockRestore();
    }
  });

  it('Normalization utility handles Unicode NFKC/NFC and whitespace edge cases consistently', () => {
    expect(normalizeWhitespaceAndUnicode('  Priya\u00A0  Nair  ')).toBe('Priya Nair');
    expect(normalizeMasterLookupKey('  ＳＴＯＲＥ  ')).toBe('store'); // Full-width Unicode NFKC
    expect(normalizeMasterLookupKey('  Assembly\t  Line ')).toBe('assembly line');
  });
});
