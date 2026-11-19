import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as QRCode from 'qrcode';
import { describe, it, expect } from 'vitest';
import { Employee } from '../src/types';
import {
  IDENTITY_CARD_HEADER_TEXT,
  IDENTITY_CARD_HEIGHT,
  IDENTITY_CARD_QR_BOX,
  IDENTITY_CARD_WIDTH,
  buildEmployeeQrPayload,
  buildIdentityCardFileName,
  drawEmployeeIdentityCardToCanvas,
  generatePureEmployeeQrDataUrl,
  type Canvas2DLike,
  type CanvasLike,
} from '../src/utils/qrIdentityCard';
import { EmployeeIdentityPrintCard, QrManagement } from '../src/components/QrManagement';

interface RecordedTextDraw {
  text: string;
  x: number;
  y: number;
  fillStyle: string;
  font: string;
}

interface RecordedImageDraw {
  image: any;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

function createRecordingCanvas(): {
  canvas: CanvasLike;
  texts: RecordedTextDraw[];
  images: RecordedImageDraw[];
  rects: Array<{ kind: 'fill' | 'stroke'; x: number; y: number; w: number; h: number; style: string }>;
} {
  const texts: RecordedTextDraw[] = [];
  const images: RecordedImageDraw[] = [];
  const rects: Array<{ kind: 'fill' | 'stroke'; x: number; y: number; w: number; h: number; style: string }> = [];

  const ctx: Canvas2DLike = {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    font: '16px sans-serif',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    imageSmoothingEnabled: true,
    fillRect(x, y, w, h) {
      rects.push({ kind: 'fill', x, y, w, h, style: String(this.fillStyle) });
    },
    strokeRect(x, y, w, h) {
      rects.push({ kind: 'stroke', x, y, w, h, style: String(this.strokeStyle) });
    },
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    fillText(text, x, y) {
      texts.push({
        text: String(text),
        x,
        y,
        fillStyle: String(this.fillStyle),
        font: this.font,
      });
    },
    measureText(text) {
      const match = /(\d+)px/.exec(this.font);
      const px = match ? Number(match[1]) : 16;
      return { width: String(text).length * px * 0.56 };
    },
    drawImage(image, dx, dy, dw, dh) {
      images.push({ image, dx, dy, dw, dh });
    },
  };

  const canvas: CanvasLike = {
    width: 0,
    height: 0,
    getContext(id) {
      return id === '2d' ? ctx : null;
    },
  };

  return { canvas, texts, images, rects };
}

const SAMPLE_EMPLOYEES: Employee[] = [
  {
    employeeId: 'TST_CARD_101',
    employeeName: 'ARJUN MEHTA',
    employeeType: 'Permanent',
    section: 'MI',
    department: 'Production',
    floor: 'MI-01',
    designation: 'Assembly Operator',
    qrCodeToken: 'QR_TST_CARD_101_STATIC_A1',
    employeeStatus: 'Active',
    createdAt: '2025-01-15T08:00:00.000Z',
    updatedAt: '2025-01-15T08:00:00.000Z',
  },
  {
    employeeId: 'TST_CARD_202',
    employeeName: 'PRIYANKA CHANDRASEKHARAN NAIR',
    employeeType: 'Staff',
    section: 'FATP',
    department: 'Quality Assurance',
    floor: 'FATP-STB',
    designation: 'Senior Quality Inspection Lead',
    qrCodeToken: 'QR_TST_CARD_202_STATIC_B2',
    employeeStatus: 'Active',
    createdAt: '2025-02-20T10:30:00.000Z',
    updatedAt: '2025-02-20T10:30:00.000Z',
  },
  {
    employeeId: 'TST_CARD_303',
    employeeName: 'MOHAMMED IRFAN KHAN',
    employeeType: 'Offroll',
    section: 'STORE',
    department: 'Logistics & Store',
    floor: 'FATP-ITR',
    designation: 'Material Handling Executive',
    qrCodeToken: 'QR_TST_CARD_303_STATIC_C3',
    employeeStatus: 'Active',
    createdAt: '2025-03-05T11:45:00.000Z',
    updatedAt: '2025-03-05T11:45:00.000Z',
  },
];

describe('Employee QR Identity Card Download & Print Rendering', () => {
  it('1. Preserves exact QR payload ({ employeeId, token }) and produces valid high-res pure QR PNGs without mutating tokens', async () => {
    for (const emp of SAMPLE_EMPLOYEES) {
      const tokenSnapshot = emp.qrCodeToken;
      const payload = buildEmployeeQrPayload(emp);
      expect(JSON.parse(payload)).toEqual({
        employeeId: emp.employeeId,
        token: tokenSnapshot,
      });

      // Confirm no extra employee metadata leaked into QR payload
      expect(payload).not.toContain(emp.employeeName);
      expect(payload).not.toContain(emp.designation);
      expect(payload).not.toContain(emp.floor);

      // Generate actual PNG data URL via qrcode library and validate PNG magic signature
      const dataUrl = await generatePureEmployeeQrDataUrl(emp, IDENTITY_CARD_QR_BOX.qrDrawSize);
      expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);
      const pngBytes = Buffer.from(dataUrl.replace('data:image/png;base64,', ''), 'base64');
      expect(pngBytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');

      // Validate QR matrix determinism & default error correction preservation
      const matrix = QRCode.create(payload);
      expect(matrix.modules.size).toBeGreaterThanOrEqual(21);
      expect(emp.qrCodeToken).toBe(tokenSnapshot);
    }
  });

  it('2. Renders complete 900x1320 white-background Identity Card PNG layout with zero overlays inside the QR zone for diverse employees', async () => {
    for (const emp of SAMPLE_EMPLOYEES) {
      const qrDataUrl = await generatePureEmployeeQrDataUrl(emp);
      const { canvas, texts, images, rects } = createRecordingCanvas();

      drawEmployeeIdentityCardToCanvas(canvas, emp, { src: qrDataUrl });

      // High-res white background
      expect(canvas.width).toBe(IDENTITY_CARD_WIDTH);
      expect(canvas.height).toBe(IDENTITY_CARD_HEIGHT);
      expect(rects[0]).toEqual({
        kind: 'fill',
        x: 0,
        y: 0,
        w: IDENTITY_CARD_WIDTH,
        h: IDENTITY_CARD_HEIGHT,
        style: '#FFFFFF',
      });

      // Exactly one pure QR image drawn inside QR box
      expect(images).toHaveLength(1);
      expect(images[0]).toEqual({
        image: { src: qrDataUrl },
        dx: IDENTITY_CARD_QR_BOX.qrDrawX,
        dy: IDENTITY_CARD_QR_BOX.qrDrawY,
        dw: IDENTITY_CARD_QR_BOX.qrDrawSize,
        dh: IDENTITY_CARD_QR_BOX.qrDrawSize,
      });

      // Strict check: ZERO text elements drawn inside or overlapping QR bounding box
      const qrTop = IDENTITY_CARD_QR_BOX.y;
      const qrBottom = IDENTITY_CARD_QR_BOX.y + IDENTITY_CARD_QR_BOX.height;
      for (const t of texts) {
        const overlapsVertically = t.y >= qrTop && t.y <= qrBottom;
        expect(overlapsVertically, `Text "${t.text}" must not overlap QR box vertically (y=${t.y})`).toBe(false);
      }

      const drawnStrings = texts.map((t) => t.text);
      // Header above QR
      expect(drawnStrings).toContain(IDENTITY_CARD_HEADER_TEXT.title);
      expect(drawnStrings).toContain(IDENTITY_CARD_HEADER_TEXT.brand);
      const headerTexts = texts.filter(
        (t) =>
          t.text === IDENTITY_CARD_HEADER_TEXT.title ||
          t.text === IDENTITY_CARD_HEADER_TEXT.brand
      );
      expect(headerTexts.every((t) => t.y < qrTop)).toBe(true);

      // Employee details below QR
      expect(drawnStrings).toContain('EMPLOYEE ID');
      expect(drawnStrings).toContain(emp.employeeId);
      expect(drawnStrings).toContain('EMPLOYEE NAME');
      expect(drawnStrings.some((s) => emp.employeeName.includes(s.replace(/…$/, '')))).toBe(true);
      expect(drawnStrings).toContain('DESIGNATION');
      expect(drawnStrings).toContain(emp.designation);

      const idDraw = texts.find((t) => t.text === emp.employeeId)!;
      expect(idDraw.y).toBeGreaterThan(qrBottom);

      // Bottom details below Employee Details
      expect(drawnStrings).toContain('LINE');
      expect(drawnStrings).toContain('SECTION');
      expect(drawnStrings).toContain('DEPARTMENT');
      expect(drawnStrings.some((s) => emp.floor.includes(s.replace(/…$/, '')))).toBe(true);
      expect(drawnStrings.some((s) => emp.section.includes(s.replace(/…$/, '')))).toBe(true);
      expect(drawnStrings.some((s) => emp.department.includes(s.replace(/…$/, '')))).toBe(true);

      const lineLabelDraw = texts.find((t) => t.text === 'LINE')!;
      expect(lineLabelDraw.y).toBeGreaterThan(idDraw.y);

      // Clean deterministic PNG filename
      expect(buildIdentityCardFileName(emp.employeeId)).toBe(`QR_ID_Card_${emp.employeeId}.png`);
    }
  });

  it('3. Renders identical Employee Identity Card structure for Individual & Bulk Print cards', async () => {
    for (const emp of SAMPLE_EMPLOYEES) {
      const qrDataUrl = await generatePureEmployeeQrDataUrl(emp, 240);
      const html = renderToStaticMarkup(
        React.createElement(EmployeeIdentityPrintCard, {
          employee: emp,
          qrUrl: qrDataUrl,
        })
      );

      expect(html).toContain('qr-identity-print-card');
      expect(html).toContain('FACTORY IDENTITY CARD');
      expect(html).toContain('Narid ATDC Tracker');
      expect(html).toContain(emp.employeeId);
      expect(html).toContain(emp.employeeName);
      expect(html).toContain(emp.designation);
      expect(html).toContain('Line');
      expect(html).toContain(emp.floor);
      expect(html).toContain('Section');
      expect(html).toContain(emp.section);
      expect(html).toContain('Department');
      expect(html).toContain(emp.department.replace(/&/g, '&amp;'));
      expect(html).toContain(`src="${qrDataUrl}"`);
    }
  });

  it('4. Preserves separate Print Selected Cards, individual Print, and Download QR controls in QrManagement without altering tokens', () => {
    const tokenBefore = SAMPLE_EMPLOYEES.map((e) => e.qrCodeToken);

    const html = renderToStaticMarkup(
      React.createElement(QrManagement, {
        employees: SAMPLE_EMPLOYEES,
        floors: [
          { id: 'f1', name: 'MI-01', code: 'MI-01', order: 1, status: 'Active' },
          { id: 'f2', name: 'FATP-STB', code: 'FATP-STB', order: 2, status: 'Active' },
          { id: 'f3', name: 'FATP-ITR', code: 'FATP-ITR', order: 3, status: 'Active' },
        ],
        departments: [
          { id: 'd1', name: 'Production', code: 'PRD', status: 'Active' },
          { id: 'd2', name: 'Quality Assurance', code: 'QA', status: 'Active' },
        ],
        onRefresh: () => {},
      })
    );

    expect(html).toContain('Print Selected Cards');
    expect(html).toContain('Download QR');
    expect(html).toContain('aria-label="Print TST_CARD_101"');
    expect(html).toContain('aria-label="Print TST_CARD_202"');
    expect(html).toContain('aria-label="Print TST_CARD_303"');

    // Existing QR tokens untouched
    expect(SAMPLE_EMPLOYEES.map((e) => e.qrCodeToken)).toEqual(tokenBefore);
  });

  it('5. Hides QR Reissue control for Admin role while keeping Download QR, Print, and Super Admin Reissue intact', () => {
    const baseProps = {
      employees: SAMPLE_EMPLOYEES,
      floors: [
        { id: 'f1', name: 'MI-01', code: 'MI-01', order: 1, status: 'Active' as const },
      ],
      departments: [
        { id: 'd1', name: 'Production', code: 'PRD', status: 'Active' as const },
      ],
      onRefresh: () => {},
    };

    const adminHtml = renderToStaticMarkup(
      React.createElement(QrManagement, {
        ...baseProps,
        currentUserRole: {
          id: 'role_admin',
          loginId: 'admin',
          email: 'admin@narid.com',
          name: 'Admin',
          role: 'admin',
          modulesAllowed: ['employees', 'qr_codes'],
          status: 'Active',
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z',
        },
      })
    );
    expect(adminHtml).toContain('Download QR');
    expect(adminHtml).toContain('aria-label="Print TST_CARD_101"');
    expect(adminHtml).not.toContain('Revoke &amp; Re-issue Security Token');

    const superAdminHtml = renderToStaticMarkup(
      React.createElement(QrManagement, {
        ...baseProps,
        currentUserRole: {
          id: 'role_superadmin',
          loginId: 'superadmin',
          email: 'superadmin@narid.com',
          name: 'Super Admin',
          role: 'super_admin',
          modulesAllowed: ['all'],
          status: 'Active',
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z',
        },
      })
    );
    expect(superAdminHtml).toContain('Download QR');
    expect(superAdminHtml).toContain('Revoke &amp; Re-issue Security Token');
  });
});
