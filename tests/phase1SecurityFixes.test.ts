import fs from 'fs';
import path from 'path';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../server.ts';
import {
  extractAuthoritativePublicIp,
  extractTrustedClientIp,
  hashQrTokenReference,
  redactSensitiveData,
  sanitizeEmployeeForApi,
} from '../serverSecurityAudit.ts';
import {
  MAX_IMPORT_FILE_BYTES,
  SpreadsheetValidationError,
  buildEmployeeTemplateWorkbookBuffer,
  parseCsvStrict,
  parseSafeSpreadsheetFile,
} from '../src/utils/safeSpreadsheetParser.ts';
import {
  InMemoryAdminAuth,
  InMemoryFirestore,
  TEST_CANONICAL_ACCOUNTS,
  seedIsolatedTestEnvironment,
} from './helpers/inMemoryAdmin.ts';

function mockReq(opts: {
  headers?: Record<string, string>;
  remoteAddress?: string;
}): any {
  const normalizedHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers || {})) {
    normalizedHeaders[k.toLowerCase()] = v;
  }
  return {
    headers: normalizedHeaders,
    socket: { remoteAddress: opts.remoteAddress || '127.0.0.1' },
    ip: opts.remoteAddress || '127.0.0.1',
  };
}

describe('Phase 1 Critical Security Fixes Verification (F-01 through F-06)', () => {
  let db: InMemoryFirestore;
  let auth: InMemoryAdminAuth;
  let app: ReturnType<typeof createApp>['app'];
  let superToken: string;
  let adminToken: string;
  let userToken: string;

  const EXISTING_RAW_QR_TOKEN = 'QR_EMP001_ORIGINAL_SECRET_TOKEN_999';

  beforeEach(async () => {
    db = new InMemoryFirestore();
    auth = new InMemoryAdminAuth();
    await seedIsolatedTestEnvironment(db, auth);

    // Seed an employee with a known pre-existing QR token to prove preservation & zero leakage
    await db.collection('employees').doc('EMP001').set({
      employeeId: 'EMP001',
      employeeName: 'RAHUL SHARMA',
      employeeType: 'Permanent',
      section: 'MI',
      department: 'Production',
      floor: 'MI-01',
      designation: 'Operator',
      qrCodeToken: EXISTING_RAW_QR_TOKEN,
      employeeStatus: 'Active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    app = createApp({ db: db as any, auth: auth as any }).app;
    superToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.superadmin.uid);
    adminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid);
    userToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.user.uid);
  });

  // ==========================================================================
  // F-01: QR Token Leakage Prevention & Server-Side QR Rendering
  // ==========================================================================
  describe('F-01 — QR Token Leakage Prevention', () => {
    it('strips raw qrCodeToken from GET /api/employees, GET /api/employees/:id, and attendance scan responses', async () => {
      const listRes = await request(app)
        .get('/api/employees')
        .set('Authorization', `Bearer ${superToken}`);
      expect(listRes.status).toBe(200);
      const emp = listRes.body.employees.find((e: any) => e.employeeId === 'EMP001');
      expect(emp).toBeDefined();
      expect(emp.qrCodeToken).toBeUndefined();
      expect(emp.hasQrToken).toBe(true);
      expect(emp.qrTokenReference).toMatch(/^qrref_[0-9a-f]{16}$/);
      expect(JSON.stringify(listRes.body)).not.toContain(EXISTING_RAW_QR_TOKEN);

      const singleRes = await request(app)
        .get('/api/employees/EMP001')
        .set('Authorization', `Bearer ${userToken}`);
      expect(singleRes.status).toBe(200);
      expect(singleRes.body.employee.qrCodeToken).toBeUndefined();
      expect(singleRes.body.employee.qrTokenReference).toBe(hashQrTokenReference(EXISTING_RAW_QR_TOKEN));
      expect(JSON.stringify(singleRes.body)).not.toContain(EXISTING_RAW_QR_TOKEN);

      // Rejected scan with wrong token MUST NOT act as a QR token oracle!
      const badScan = await request(app)
        .post('/api/attendance/scan')
        .set('Authorization', `Bearer ${superToken}`)
        .send({
          rawPayload: JSON.stringify({ employeeId: 'EMP001', token: 'QR_EMP001_WRONG' }),
          scannerType: 'IN',
        });
      expect(badScan.status).toBe(403);
      expect(JSON.stringify(badScan.body)).not.toContain(EXISTING_RAW_QR_TOKEN);
      expect(badScan.body.employee?.qrCodeToken).toBeUndefined();

      // Valid scan MUST NOT return raw qrCodeToken or store raw token in attendance / punch_logs
      const goodScan = await request(app)
        .post('/api/attendance/scan')
        .set('Authorization', `Bearer ${superToken}`)
        .send({
          rawPayload: JSON.stringify({ employeeId: 'EMP001', token: EXISTING_RAW_QR_TOKEN }),
          scannerType: 'IN',
          customScanTime: '2026-11-22T09:02:00+05:30',
        });
      expect(goodScan.status).toBe(200);
      expect(goodScan.body.success).toBe(true);
      expect(JSON.stringify(goodScan.body)).not.toContain(EXISTING_RAW_QR_TOKEN);
      expect(goodScan.body.employee?.qrCodeToken).toBeUndefined();
      expect(goodScan.body.attendance?.qrTokenReference).toBe(hashQrTokenReference(EXISTING_RAW_QR_TOKEN));

      // Verify stored Firestore attendance & punch_logs contain zero raw QR tokens
      const attDocs = Object.values(db.getRawCollection('attendance'));
      expect(attDocs.length).toBeGreaterThan(0);
      expect(JSON.stringify(attDocs)).not.toContain(EXISTING_RAW_QR_TOKEN);

      const punchLogs = Object.values(db.getRawCollection('punch_logs'));
      expect(JSON.stringify(punchLogs)).not.toContain(EXISTING_RAW_QR_TOKEN);

      // Verify existing employee's raw QR token in Firestore was preserved untouched (no auto-rotation)
      const storedEmp = (await db.collection('employees').doc('EMP001').get()).data()!;
      expect(storedEmp.qrCodeToken).toBe(EXISTING_RAW_QR_TOKEN);
    });

    it('renders QR PNGs server-side for qr_codes.view authorized users without exposing raw token, and blocks ordinary users', async () => {
      // Ordinary USER does NOT have qr_codes.view -> 403 QR_ACCESS_DENIED
      const denied = await request(app)
        .post('/api/employees/qr-cards/render')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ employeeIds: ['EMP001'], size: 240 });
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('QR_ACCESS_DENIED');

      // Authorized Super Admin receives PNG data URL & non-reversible hash, zero raw token
      const allowed = await request(app)
        .post('/api/employees/qr-cards/render')
        .set('Authorization', `Bearer ${superToken}`)
        .send({ employeeIds: ['EMP001'], size: 240 });
      expect(allowed.status).toBe(200);
      expect(allowed.body.items.EMP001.qrDataUrl).toMatch(/^data:image\/png;base64,/);
      expect(allowed.body.items.EMP001.qrTokenReference).toBe(hashQrTokenReference(EXISTING_RAW_QR_TOKEN));
      expect(JSON.stringify(allowed.body)).not.toContain(EXISTING_RAW_QR_TOKEN);
    });

    it('logs only hashed QR token references on manual regenerate-qr and redacts inline QR tokens in audit logs', async () => {
      const regenRes = await request(app)
        .post('/api/employees/EMP001/regenerate-qr')
        .set('Authorization', `Bearer ${superToken}`)
        .send({});
      expect(regenRes.status).toBe(200);
      expect(regenRes.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
      expect(regenRes.body.qrTokenReference).toMatch(/^qrref_[0-9a-f]{16}$/);
      expect(regenRes.body.qrCodeToken).toBeUndefined();

      const updatedEmp = (await db.collection('employees').doc('EMP001').get()).data()!;
      expect(updatedEmp.qrCodeToken).not.toBe(EXISTING_RAW_QR_TOKEN);
      expect(JSON.stringify(regenRes.body)).not.toContain(updatedEmp.qrCodeToken);

      const auditLogs = Object.values(db.getRawCollection('audit_logs'));
      const regenLog = auditLogs.find((l: any) => l.action === 'REGENERATE_QR_TOKEN') as any;
      expect(regenLog).toBeDefined();
      expect(regenLog.oldValue).toBe(hashQrTokenReference(EXISTING_RAW_QR_TOKEN));
      expect(regenLog.newValue).toBe(hashQrTokenReference(updatedEmp.qrCodeToken));
      expect(JSON.stringify(auditLogs)).not.toContain(EXISTING_RAW_QR_TOKEN);
      expect(JSON.stringify(auditLogs)).not.toContain(updatedEmp.qrCodeToken);

      // Direct redaction check
      const redacted = redactSensitiveData({
        msg: `Scanned QR_EMP001_12345_SECRET99 on gate`,
        nested: { qrCodeToken: 'QR_EMP001_ABCDEF' },
      });
      expect(JSON.stringify(redacted)).not.toContain('QR_EMP001_12345_SECRET99');
      expect(JSON.stringify(redacted)).not.toContain('QR_EMP001_ABCDEF');

      // Sanitize helper check
      const safe = sanitizeEmployeeForApi({ employeeId: 'E1', qrCodeToken: 'QR_E1_RAW' });
      expect((safe as Record<string, unknown>).qrCodeToken).toBeUndefined();
      expect(safe.hasQrToken).toBe(true);
      expect(safe.qrTokenReference).toBe(hashQrTokenReference('QR_E1_RAW'));
    });
  });

  // ==========================================================================
  // F-02: Authenticated Server APIs & Company Wi-Fi Enforcement on Operational Routes
  // ==========================================================================
  describe('F-02 — Authenticated APIs, RBAC & Company Wi-Fi Coverage', () => {
    it('enforces authentication and RBAC on employee, master, and attendance read/write endpoints', async () => {
      // Unauthenticated -> 401
      expect((await request(app).get('/api/employees')).status).toBe(401);
      expect((await request(app).get('/api/masters/floors')).status).toBe(401);
      expect((await request(app).get('/api/attendance/records')).status).toBe(401);

      // Ordinary USER can read sanitized employees, masters, and attendance records
      expect(
        (await request(app).get('/api/employees').set('Authorization', `Bearer ${userToken}`)).status
      ).toBe(200);
      expect(
        (await request(app).get('/api/masters/all').set('Authorization', `Bearer ${userToken}`)).status
      ).toBe(200);
      expect(
        (await request(app).get('/api/attendance/records?shiftDate=2026-11-22').set('Authorization', `Bearer ${userToken}`)).status
      ).toBe(200);

      // Ordinary USER CANNOT mutate employees, masters, or settings
      expect(
        (
          await request(app)
            .post('/api/employees')
            .set('Authorization', `Bearer ${userToken}`)
            .send({
              employeeId: 'HACK01',
              employeeName: 'UNAUTHORIZED',
              employeeType: 'Permanent',
              section: 'MI',
              department: 'Production',
              floor: 'MI-01',
              designation: 'Operator',
              employeeStatus: 'Active',
            })
        ).status
      ).toBe(403);
      expect(
        (
          await request(app)
            .put('/api/masters/settings')
            .set('Authorization', `Bearer ${userToken}`)
            .send({ companyName: 'HACKED' })
        ).status
      ).toBe(403);
      expect(
        (
          await request(app)
            .post('/api/masters/floors')
            .set('Authorization', `Bearer ${userToken}`)
            .send({ id: 'f_hack', name: 'HACK', code: 'HACK', order: 99, status: 'Active' })
        ).status
      ).toBe(403);
    });

    it('enforces Company Wi-Fi IP policy on /api/employees, /api/masters/*, and /api/attendance/records while preserving office Wi-Fi access', async () => {
      const OFFICE_IP = '203.0.113.42';
      const OUTSIDE_IP = '198.51.100.88';

      // Configure office network & enable Company Wi-Fi enforcement for ADMIN/USER
      const addNet = await request(app)
        .post('/api/company-wifi/networks')
        .set('Authorization', `Bearer ${superToken}`)
        .set('X-Forwarded-For', OFFICE_IP)
        .send({
          networkName: 'Main Office Wi-Fi',
          ipOrCidr: OFFICE_IP,
          status: 'Active',
        });
      expect(addNet.status).toBe(201);
      const netId = addNet.body.network.networkId;

      for (const roleId of ['admin', 'user'] as const) {
        const pol = await request(app)
          .put(`/api/company-wifi/policies/${roleId}`)
          .set('Authorization', `Bearer ${superToken}`)
          .set('X-Forwarded-For', OFFICE_IP)
          .send({ accessMode: 'RESTRICTED', allowedNetworkIds: [netId] });
        expect(pol.status).toBe(200);
      }

      const enable = await request(app)
        .put('/api/company-wifi/settings')
        .set('Authorization', `Bearer ${superToken}`)
        .set('X-Forwarded-For', OFFICE_IP)
        .send({
          enforcementEnabled: true,
          confirmEnable: true,
        });
      expect(enable.status).toBe(200);

      // Outside IP blocked across all new F-02 endpoints for non-exempt roles
      expect(
        (
          await request(app)
            .get('/api/employees')
            .set('Authorization', `Bearer ${userToken}`)
            .set('X-Forwarded-For', OUTSIDE_IP)
        ).status
      ).toBe(403);
      expect(
        (
          await request(app)
            .get('/api/attendance/records?shiftDate=2026-11-22')
            .set('Authorization', `Bearer ${userToken}`)
            .set('X-Forwarded-For', OUTSIDE_IP)
        ).status
      ).toBe(403);
      expect(
        (
          await request(app)
            .get('/api/masters/floors')
            .set('Authorization', `Bearer ${adminToken}`)
            .set('X-Forwarded-For', OUTSIDE_IP)
        ).status
      ).toBe(403);

      // Legitimate Office Wi-Fi IP allowed seamlessly
      expect(
        (
          await request(app)
            .get('/api/employees')
            .set('Authorization', `Bearer ${userToken}`)
            .set('X-Forwarded-For', OFFICE_IP)
        ).status
      ).toBe(200);
      expect(
        (
          await request(app)
            .get('/api/attendance/records?shiftDate=2026-11-22')
            .set('Authorization', `Bearer ${userToken}`)
            .set('X-Forwarded-For', OFFICE_IP)
        ).status
      ).toBe(200);

      // Super Admin can always reach emergency disable even from outside IP
      const disable = await request(app)
        .post('/api/company-wifi/emergency-disable')
        .set('Authorization', `Bearer ${superToken}`)
        .set('X-Forwarded-For', OUTSIDE_IP)
        .send({ reason: 'Emergency ISP failover test' });
      expect(disable.status).toBe(200);
    });
  });

  // ==========================================================================
  // F-03: Hardening POST /api/auth/firebase-throttle-signal
  // ==========================================================================
  describe('F-03 — Throttle Signal DoS & Firestore Flood Protection', () => {
    it('rejects unauthenticated or forged throttle signals with 403 and zero Firestore writes', async () => {
      const beforeRateLimits = Object.keys(db.getRawCollection('ip_rate_limits')).length;
      const beforeAttempts = Object.keys(db.getRawCollection('login_attempts')).length;

      // Missing token
      const res1 = await request(app)
        .post('/api/auth/firebase-throttle-signal')
        .set('X-Forwarded-For', '203.0.113.55')
        .send({ loginId: 'admin' });
      expect(res1.status).toBe(403);
      expect(res1.body.code).toBe('UNAUTHORIZED_THROTTLE_SIGNAL');

      // Forged token
      const res2 = await request(app)
        .post('/api/auth/firebase-throttle-signal')
        .set('X-Forwarded-For', '203.0.113.55')
        .send({ loginId: 'admin', throttleSignalToken: 'forged.invalid.token' });
      expect(res2.status).toBe(403);

      // Zero writes to Firestore!
      expect(Object.keys(db.getRawCollection('ip_rate_limits')).length).toBe(beforeRateLimits);
      expect(Object.keys(db.getRawCollection('login_attempts')).length).toBe(beforeAttempts);
    });

    it('accepts single-use IP-bound throttle token once without mutating ip_rate_limits, and rejects replay or cross-IP reuse', async () => {
      const clientIp = '203.0.113.77';

      // Authenticate via POST /api/auth/login to receive a valid signed throttleSignalToken
      const loginRes = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', clientIp)
        .send({
          loginId: TEST_CANONICAL_ACCOUNTS.user.loginId,
          password: TEST_CANONICAL_ACCOUNTS.user.password,
        });
      expect(loginRes.status).toBe(200);
      const token = loginRes.body.throttleSignalToken;
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(20);

      // Cross-IP use is rejected
      const wrongIp = await request(app)
        .post('/api/auth/firebase-throttle-signal')
        .set('X-Forwarded-For', '198.51.100.99')
        .send({ loginId: TEST_CANONICAL_ACCOUNTS.user.loginId, throttleSignalToken: token });
      expect(wrongIp.status).toBe(403);

      // Valid IP first use succeeds
      const validUse = await request(app)
        .post('/api/auth/firebase-throttle-signal')
        .set('X-Forwarded-For', clientIp)
        .send({ loginId: TEST_CANONICAL_ACCOUNTS.user.loginId, throttleSignalToken: token });
      expect(validUse.status).toBe(200);
      expect(validUse.body.success).toBe(true);

      // Crucially: ip_rate_limits MUST NOT have any failure/lockout recorded for clientIp
      const rateLimitDocs = Object.values(db.getRawCollection('ip_rate_limits'));
      expect(rateLimitDocs.length).toBe(0);

      // Replay of same single-use token is rejected with 403
      const replay = await request(app)
        .post('/api/auth/firebase-throttle-signal')
        .set('X-Forwarded-For', clientIp)
        .send({ loginId: TEST_CANONICAL_ACCOUNTS.user.loginId, throttleSignalToken: token });
      expect(replay.status).toBe(403);
    });
  });

  // ==========================================================================
  // F-04 & F-05: Unified Authoritative IP Extraction & Proxy Header Hardening
  // ==========================================================================
  describe('F-04 & F-05 — Unified Trusted-Proxy IP Extraction', () => {
    it('ignores spoofed cf-connecting-ip, x-real-ip, leftmost XFF, and non-Vercel x-vercel-forwarded-for', () => {
      const prevVercel = process.env.VERCEL;
      const prevVercelEnv = process.env.VERCEL_ENV;
      delete process.env.VERCEL;
      delete process.env.VERCEL_ENV;

      try {
        // Behind 1 trusted local proxy (127.0.0.1): real client IP is rightmost entry in XFF
        const reqBehindProxy = mockReq({
          remoteAddress: '127.0.0.1',
          headers: {
            'cf-connecting-ip': '203.0.113.1',
            'x-real-ip': '203.0.113.2',
            'x-vercel-forwarded-for': '203.0.113.3',
            'x-forwarded-for': '203.0.113.4, 198.51.100.22',
          },
        });
        expect(extractAuthoritativePublicIp(reqBehindProxy).ip).toBe('198.51.100.22');
        expect(extractTrustedClientIp(reqBehindProxy)).toBe('198.51.100.22');

        // Direct public TCP peer: MUST ignore all forwarded headers completely
        const directPublicReq = mockReq({
          remoteAddress: '198.51.100.77',
          headers: {
            'x-forwarded-for': '203.0.113.10',
            'x-vercel-forwarded-for': '203.0.113.10',
            'cf-connecting-ip': '203.0.113.10',
          },
        });
        expect(extractAuthoritativePublicIp(directPublicReq).ip).toBe('198.51.100.77');
        expect(extractTrustedClientIp(directPublicReq)).toBe('198.51.100.77');

        // Verified Vercel runtime: trusts x-vercel-forwarded-for over XFF
        process.env.VERCEL = '1';
        const vercelReq = mockReq({
          remoteAddress: '10.0.0.1',
          headers: {
            'x-forwarded-for': '203.0.113.10',
            'x-vercel-forwarded-for': '198.51.100.55',
          },
        });
        expect(extractAuthoritativePublicIp(vercelReq).ip).toBe('198.51.100.55');
        expect(extractTrustedClientIp(vercelReq)).toBe('198.51.100.55');
      } finally {
        if (prevVercel === undefined) delete process.env.VERCEL;
        else process.env.VERCEL = prevVercel;
        if (prevVercelEnv === undefined) delete process.env.VERCEL_ENV;
        else process.env.VERCEL_ENV = prevVercelEnv;
      }
    });
  });

  // ==========================================================================
  // F-06: Vulnerable `xlsx` Dependency Removed & Safe Parser Limits Enforced
  // ==========================================================================
  describe('F-06 — Safe Spreadsheet Parser & xlsx Removal', () => {
    it('removes xlsx from package.json and parses ExcelJS templates & RFC-4180 CSVs cleanly', async () => {
      const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8'));
      expect(pkg.dependencies?.xlsx).toBeUndefined();
      expect(pkg.devDependencies?.xlsx).toBeUndefined();

      // Template builder produces a valid .xlsx workbook parsed by safeSpreadsheetParser
      const tplBuf = await buildEmployeeTemplateWorkbookBuffer();
      const tplRows = await parseSafeSpreadsheetFile({
        name: 'Employee_Master_Template.xlsx',
        size: tplBuf.byteLength,
        arrayBuffer: async () => tplBuf,
      });
      expect(tplRows[0]).toEqual([
        'Employee ID',
        'Employee Name',
        'Employee Type',
        'Section',
        'Department',
        'Line',
        'Designation',
        'Status',
      ]);
      expect(tplRows.length).toBe(5); // header + 4 sample rows

      // Strict RFC-4180 CSV with UTF-8 BOM, quoted comma & escaped quotes
      const csvRaw = '\uFEFFEmployee ID,Employee Name,Designation\r\nEMP01,"SHARMA, ""RAHUL""",Operator\r\n';
      const csvBuf = new TextEncoder().encode(csvRaw).buffer;
      const csvRows = await parseSafeSpreadsheetFile({
        name: 'employees.csv',
        size: csvBuf.byteLength,
        arrayBuffer: async () => csvBuf,
      });
      expect(csvRows).toEqual([
        ['Employee ID', 'Employee Name', 'Designation'],
        ['EMP01', 'SHARMA, "RAHUL"', 'Operator'],
      ]);
    });

    it('rejects unsupported extensions, oversized files, fake xlsx magic bytes, binary CSVs, and row/col/sheet/cell limit breaches', async () => {
      // 1. Legacy .xls rejected
      await expect(
        parseSafeSpreadsheetFile({
          name: 'legacy.xls',
          size: 100,
          arrayBuffer: async () => new ArrayBuffer(100),
        })
      ).rejects.toThrow(SpreadsheetValidationError);

      // 2. Oversized file rejected
      await expect(
        parseSafeSpreadsheetFile({
          name: 'huge.xlsx',
          size: MAX_IMPORT_FILE_BYTES + 1,
          arrayBuffer: async () => new ArrayBuffer(16),
        })
      ).rejects.toThrow(/maximum allowed size/i);

      // 3. Fake .xlsx without ZIP magic bytes rejected
      const fakeBytes = new TextEncoder().encode('<html>not an xlsx file</html>').buffer;
      await expect(
        parseSafeSpreadsheetFile({
          name: 'spoof.xlsx',
          size: fakeBytes.byteLength,
          arrayBuffer: async () => fakeBytes,
        })
      ).rejects.toThrow(/signature/i);

      // 4. CSV with binary NUL byte rejected
      expect(() => parseCsvStrict('a,b\n1,\u0000evil')).toThrow(/NUL/i);

      // 5. Row limit enforced
      expect(() => parseCsvStrict('a\n1\n2\n3', { maxRows: 2 })).toThrow(/row limit/i);

      // 6. Column limit enforced
      expect(() => parseCsvStrict('c1,c2,c3,c4', { maxCols: 3 })).toThrow(/column count/i);

      // 7. Cell length limit enforced
      expect(() => parseCsvStrict(`id,name\n1,${'A'.repeat(25)}`, { maxCellLength: 20 })).toThrow(/length/i);

      // 8. Sheet count limit enforced on .xlsx
      const wb = new ExcelJS.Workbook();
      wb.addWorksheet('S1').addRow(['A']);
      wb.addWorksheet('S2').addRow(['B']);
      wb.addWorksheet('S3').addRow(['C']);
      const multiRaw = await wb.xlsx.writeBuffer();
      const u8 = new Uint8Array(multiRaw as unknown as Uint8Array);
      const multiBuf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
      await expect(
        parseSafeSpreadsheetFile(
          { name: 'many_sheets.xlsx', size: multiBuf.byteLength, arrayBuffer: async () => multiBuf },
          { maxSheets: 2 }
        )
      ).rejects.toThrow(/worksheets/i);
    });
  });
});
