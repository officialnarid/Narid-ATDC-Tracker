import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  QR_DETECTED_STATUS,
  QR_VERIFYING_STATUS,
  getMaskedQrInputValue,
  applyQrInputChange,
  sanitizeQrErrorMessage,
} from '../src/utils/qrInputMask';
import { Scanner } from '../src/components/Scanner';
import { createApp } from '../server.ts';
import {
  InMemoryAdminAuth,
  InMemoryFirestore,
  TEST_CANONICAL_ACCOUNTS,
  seedIsolatedTestEnvironment,
} from './helpers/inMemoryAdmin.ts';

describe('QR Input Masking & Sanitization (Punch In & Punch Out Scanners)', () => {
  it('displays placeholder when idle, "QR Code Detected ✓" when scanned, and "Verifying QR..." while processing', () => {
    expect(getMaskedQrInputValue(false, false)).toBe('');
    expect(getMaskedQrInputValue(true, false)).toBe(QR_DETECTED_STATUS);
    expect(getMaskedQrInputValue(true, true)).toBe(QR_VERIFYING_STATUS);
    expect(getMaskedQrInputValue(false, true)).toBe(QR_VERIFYING_STATUS);
  });

  it('captures full USB/programmatic QR payload internally while never returning raw QR characters or tokens to UI display', () => {
    const sampleQr = '{"employeeId":"MSI1335","token":"QR_MSI1335_SECRET_991"}';
    let raw = '';
    let detected = false;

    // Simulate incremental character arrival against masked UI value
    for (const ch of sampleQr) {
      const currentMask = getMaskedQrInputValue(detected, false);
      const nextInputValue = currentMask ? `${currentMask}${ch}` : ch;
      const updated = applyQrInputChange(raw, nextInputValue, currentMask);
      raw = updated.nextRawPayload;
      detected = updated.hasDetectedPayload;

      const visibleValue = getMaskedQrInputValue(detected, false);
      expect(visibleValue).toBe(QR_DETECTED_STATUS);
      expect(visibleValue).not.toContain('MSI1335');
      expect(visibleValue).not.toContain('QR_MSI1335_SECRET_991');
      expect(visibleValue).not.toContain('employeeId');
    }

    expect(raw).toBe(sampleQr);
    expect(detected).toBe(true);

    // Simulate Backspace/Clear inside masked field
    const cleared = applyQrInputChange(raw, QR_DETECTED_STATUS.slice(0, -1), QR_DETECTED_STATUS);
    expect(cleared).toEqual({ nextRawPayload: '', hasDetectedPayload: false });
    expect(getMaskedQrInputValue(cleared.hasDetectedPayload, false)).toBe('');
  });

  it('sanitizes QR error messages so raw tokens or JSON payloads never appear in visible UI/console errors', () => {
    const rawJson = '{"employeeId":"MSI1335","token":"QR_MSI1335_TOPSECRET"}';
    const leakedMsg = `Rejected payload ${rawJson} with token QR_MSI1335_TOPSECRET`;
    const sanitized = sanitizeQrErrorMessage(leakedMsg, rawJson);

    expect(sanitized).not.toContain('QR_MSI1335_TOPSECRET');
    expect(sanitized).not.toContain(rawJson);
    expect(sanitized).toContain('[QR_PAYLOAD_REDACTED]');

    // Preserves standard non-sensitive user rejection guidance
    expect(
      sanitizeQrErrorMessage('Invalid QR Payload: Security token is required for this employee.', 'MSI1335')
    ).toBe('Invalid QR Payload: Security token is required for this employee.');
    expect(
      sanitizeQrErrorMessage('Invalid QR Code. Employee "MSI9999" Not Found.', 'MSI9999')
    ).toBe('Invalid QR Code. Employee "MSI9999" Not Found.');
  });

  it('renders both Punch In and Punch Out QR inputs masked while preserving placeholders and Manual Employee ID Entry', () => {
    const html = renderToStaticMarkup(
      React.createElement(Scanner, {
        currentUserRole: {
          id: TEST_CANONICAL_ACCOUNTS.admin.uid,
          name: 'Admin',
          loginId: 'admin',
          email: TEST_CANONICAL_ACCOUNTS.admin.email,
          role: 'admin',
          modulesAllowed: ['scanner'],
          status: 'Active',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        rolePermissions: {
          admin: {
            roleId: 'admin',
            roleName: 'Admin',
            modulePermissions: {
              scanner: { view: true, add: true, edit: true, delete: false },
              'attendance.qr.scan': { view: true, add: true, edit: false, delete: false },
              'attendance.manual.entry': { view: true, add: true, edit: false, delete: false },
            },
            updatedAt: new Date().toISOString(),
            updatedBy: 'superadmin',
          },
        },
      })
    );

    expect(html).toContain('aria-label="Punch In QR Scanner Input"');
    expect(html).toContain('aria-label="Punch Out QR Scanner Input"');
    expect((html.match(/data-qr-masked="true"/g) || []).length).toBe(2);
    expect(html).toContain('placeholder="Scan QR Badge (Punch In Ready)..."');
    expect(html).toContain('placeholder="Scan QR Badge (Punch Out Ready)..."');
    // Manual Employee ID Entry remains completely intact and unmasked
    expect(html).toContain('placeholder="Enter Employee ID (e.g. MSI1335)"');
  });
});

describe('End-to-End QR Punch In / Punch Out & Invalid QR Handling Preservation', () => {
  let rawDb: InMemoryFirestore;
  let rawAuth: InMemoryAdminAuth;

  beforeEach(async () => {
    rawDb = new InMemoryFirestore();
    rawAuth = new InMemoryAdminAuth();
    await seedIsolatedTestEnvironment(rawDb, rawAuth);

    await rawDb.collection('role_permissions').doc('admin').set({
      roleId: 'admin',
      roleName: 'Admin',
      modulePermissions: {
        scanner: { view: true, add: true, edit: true, delete: false },
        'attendance.qr.scan': { view: true, add: true, edit: false, delete: false },
        'attendance.manual.entry': { view: true, add: true, edit: false, delete: false },
      },
      updatedAt: new Date().toISOString(),
      updatedBy: 'superadmin',
    });

    await rawDb.collection('employees').doc('MSI1335').set({
      id: 'MSI1335',
      employeeId: 'MSI1335',
      employeeName: 'ANIL KUMAR',
      employeeType: 'Permanent',
      floor: 'MI-02',
      section: 'MI',
      department: 'Production',
      designation: 'Operator',
      employeeStatus: 'Active',
      qrCodeToken: 'QR_MSI1335_MASKED_TEST_TOKEN',
    });
  });

  it('processes valid USB & Camera Punch In / Punch Out QR scans and rejects invalid QR without exposing token', async () => {
    const { app } = createApp({
      db: rawDb,
      auth: rawAuth,
      projectId: 'narid-atdc-tracker',
      databaseId: 'ai-studio-manpowertracker-9b87a863-5c0d-4126-accb-7a3be802b10b',
      credentialMode: 'ADC',
      disableBackgroundBoot: true,
    });
    const adminToken = rawAuth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid);

    // 1. Valid Punch In via USB_SCANNER
    const resIn = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        rawPayload: JSON.stringify({ employeeId: 'MSI1335', token: 'QR_MSI1335_MASKED_TEST_TOKEN' }),
        scannerType: 'IN',
        scannerDevice: 'USB_SCANNER',
        customScanTime: '2026-11-18T09:00:00+05:30',
      });
    expect(resIn.status).toBe(200);
    expect(resIn.body.success).toBe(true);
    expect(resIn.body.action).toBe('PUNCH_IN');

    // 2. Valid Punch Out via WEBCAM
    const resOut = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        rawPayload: JSON.stringify({ employeeId: 'MSI1335', token: 'QR_MSI1335_MASKED_TEST_TOKEN' }),
        scannerType: 'OUT',
        scannerDevice: 'WEBCAM',
        customScanTime: '2026-11-18T17:30:00+05:30',
      });
    expect(resOut.status).toBe(200);
    expect(resOut.body.success).toBe(true);
    expect(resOut.body.action).toBe('PUNCH_OUT');
    expect(resOut.body.attendance.totalDutyMinutes).toBe(510);

    // 3. Invalid QR returns rejection without leaking expected or scanned token
    const badRaw = '{"employeeId":"MSI1335","token":"WRONG_QR_TOKEN_XYZ"}';
    const resBad = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        rawPayload: badRaw,
        scannerType: 'IN',
        scannerDevice: 'USB_SCANNER',
        customScanTime: '2026-11-18T18:00:00+05:30',
      });
    expect(resBad.status).toBe(403);
    expect(resBad.body.success).toBe(false);
    const safeMsg = sanitizeQrErrorMessage(resBad.body.message, badRaw);
    expect(safeMsg).not.toContain('QR_MSI1335_MASKED_TEST_TOKEN');
    expect(safeMsg).not.toContain('WRONG_QR_TOKEN_XYZ');
  });
});
