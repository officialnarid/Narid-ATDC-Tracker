import { Employee } from '../types';
import { fetchEmployeeQrDataUrls } from '../services/employeeService';

export const IDENTITY_CARD_WIDTH = 900;
export const IDENTITY_CARD_HEIGHT = 1320;

export const IDENTITY_CARD_QR_BOX = {
  x: 195,
  y: 214,
  width: 510,
  height: 510,
  qrDrawX: 215,
  qrDrawY: 234,
  qrDrawSize: 470,
} as const;

export const IDENTITY_CARD_HEADER_TEXT = {
  title: 'FACTORY IDENTITY CARD',
  brand: 'Narid ATDC Tracker',
} as const;

/**
 * Exact QR payload builder preserving existing employeeId & qrCodeToken structure.
 */
export function buildEmployeeQrPayload(
  employee: Pick<Employee, 'employeeId' | 'qrCodeToken'>
): string {
  return JSON.stringify({
    employeeId: employee.employeeId,
    token: employee.qrCodeToken,
  });
}

export function buildIdentityCardFileName(employeeId: string): string {
  const safeId = String(employeeId || 'EMPLOYEE')
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, '_');
  return `QR_ID_Card_${safeId}.png`;
}

export interface Canvas2DLike {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  imageSmoothingEnabled?: boolean;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
  measureText(text: string): { width: number };
  drawImage(image: any, dx: number, dy: number, dw: number, dh: number): void;
}

export interface CanvasLike {
  width: number;
  height: number;
  getContext(contextId: '2d'): Canvas2DLike | null;
  toDataURL?(type?: string): string;
  toBlob?(callback: (blob: Blob | null) => void, type?: string): void;
}

export function wrapCanvasText(
  ctx: Pick<Canvas2DLike, 'measureText'>,
  rawText: string,
  maxWidth: number,
  maxLines = 2
): string[] {
  const clean = String(rawText || '—').trim().replace(/\s+/g, ' ');
  if (!clean) return ['—'];

  const words = clean.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  const pushTruncatedLast = (candidate: string) => {
    let text = candidate;
    while (text.length > 1 && ctx.measureText(`${text}…`).width > maxWidth) {
      text = text.slice(0, -1).trimEnd();
    }
    lines.push(`${text}…`);
  };

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    if (ctx.measureText(testLine).width <= maxWidth) {
      currentLine = testLine;
      continue;
    }

    if (!currentLine) {
      // Single long word without spaces
      if (lines.length + 1 >= maxLines) {
        pushTruncatedLast(word);
        return lines;
      }
      let chunk = word;
      while (chunk.length > 1 && ctx.measureText(chunk).width > maxWidth) {
        chunk = chunk.slice(0, -1);
      }
      lines.push(chunk);
      const remainder = word.slice(chunk.length);
      currentLine = remainder;
    } else {
      lines.push(currentLine);
      if (lines.length >= maxLines) {
        const remaining = [word, ...words.slice(i + 1)].join(' ');
        // Merge ellipsis into last line if more words remained
        const prevLast = lines.pop() || '';
        const merged = `${prevLast} ${remaining}`.trim();
        pushTruncatedLast(merged);
        return lines;
      }
      currentLine = word;
    }
  }

  if (currentLine) {
    if (lines.length >= maxLines) {
      const prevLast = lines.pop() || '';
      pushTruncatedLast(`${prevLast} ${currentLine}`.trim());
    } else {
      lines.push(currentLine);
    }
  }

  return lines.length > 0 ? lines : ['—'];
}

export function fitSingleLineFontSize(
  ctx: Pick<Canvas2DLike, 'font' | 'measureText'>,
  text: string,
  baseSizePx: number,
  minSizePx: number,
  buildFont: (sizePx: number) => string,
  maxWidth: number
): number {
  let size = baseSizePx;
  while (size > minSizePx) {
    ctx.font = buildFont(size);
    if (ctx.measureText(text).width <= maxWidth) {
      return size;
    }
    size -= 2;
  }
  ctx.font = buildFont(minSizePx);
  return minSizePx;
}

/**
 * Generates pure unembellished QR Data URL.
 * When raw qrCodeToken is withheld from API responses (F-01), fetches the server-rendered
 * scannable QR PNG via POST /api/employees/qr-cards/render.
 * When qrCodeToken is locally present (e.g., unit tests), renders directly using qrcode.
 */
export async function generatePureEmployeeQrDataUrl(
  employee: Pick<Employee, 'employeeId' | 'qrCodeToken' | 'hasQrToken'>,
  width = 470
): Promise<string> {
  if (!employee.employeeId) {
    throw new Error('Missing Employee ID for QR code generation.');
  }
  if (!employee.qrCodeToken) {
    if (employee.hasQrToken === false) {
      throw new Error(`Missing QR security token for ${employee.employeeId}.`);
    }
    const rendered = await fetchEmployeeQrDataUrls([employee.employeeId], width);
    const entry = rendered[employee.employeeId.trim().toUpperCase()] || rendered[employee.employeeId];
    if (!entry?.qrDataUrl) {
      throw new Error(`Missing QR security token for ${employee.employeeId}.`);
    }
    return entry.qrDataUrl;
  }
  const QRCodeMod = await import('qrcode');
  const QRCode = QRCodeMod.default || QRCodeMod;
  const payload = buildEmployeeQrPayload(employee);
  return QRCode.toDataURL(payload, {
    width,
    margin: 2,
    color: {
      dark: '#000000',
      light: '#FFFFFF',
    },
  });
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode generated QR code image.'));
    img.src = src;
  });
}

/**
 * Renders the complete high-resolution Employee Identity Card (900x1320) onto a 2D canvas.
 * Separated cleanly from DOM image loading so layout geometry & overlays are 100% unit-testable.
 */
export function drawEmployeeIdentityCardToCanvas(
  canvas: CanvasLike,
  employee: Pick<
    Employee,
    'employeeId' | 'employeeName' | 'designation' | 'floor' | 'section' | 'department'
  >,
  qrImageSource: any
): void {
  canvas.width = IDENTITY_CARD_WIDTH;
  canvas.height = IDENTITY_CARD_HEIGHT;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Unable to initialize 2D graphics context for identity card export.');
  }

  const W = IDENTITY_CARD_WIDTH;
  const H = IDENTITY_CARD_HEIGHT;
  const centerX = W / 2;

  // 1. Crisp White Card Surface & Outer Print Border
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = '#CBD5E1';
  ctx.lineWidth = 3;
  ctx.strokeRect(18, 18, W - 36, H - 36);

  // Top Narid Corporate Navy Accent Bar
  ctx.fillStyle = '#1E3A8A';
  ctx.fillRect(18, 18, W - 36, 16);

  // 2. HEADER: FACTORY IDENTITY CARD + Narid ATDC Tracker
  ctx.fillStyle = '#F8FAFC';
  ctx.fillRect(20, 34, W - 40, 152);

  ctx.strokeStyle = '#E2E8F0';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(20, 186);
  ctx.lineTo(W - 20, 186);
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillStyle = '#1E3A8A';
  ctx.font = '700 22px "Inter", "Segoe UI", Arial, sans-serif';
  ctx.fillText(IDENTITY_CARD_HEADER_TEXT.title, centerX, 82);

  ctx.fillStyle = '#0F172A';
  ctx.font = '800 38px "Inter", "Segoe UI", Arial, sans-serif';
  ctx.fillText(IDENTITY_CARD_HEADER_TEXT.brand, centerX, 134);

  // 3. CENTER: Pure Scannable QR Code (no text, logo, watermark, or decoration inside)
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(
    IDENTITY_CARD_QR_BOX.x,
    IDENTITY_CARD_QR_BOX.y,
    IDENTITY_CARD_QR_BOX.width,
    IDENTITY_CARD_QR_BOX.height
  );

  ctx.strokeStyle = '#CBD5E1';
  ctx.lineWidth = 2;
  ctx.strokeRect(
    IDENTITY_CARD_QR_BOX.x,
    IDENTITY_CARD_QR_BOX.y,
    IDENTITY_CARD_QR_BOX.width,
    IDENTITY_CARD_QR_BOX.height
  );

  if (typeof ctx.imageSmoothingEnabled === 'boolean') {
    ctx.imageSmoothingEnabled = false;
  }
  ctx.drawImage(
    qrImageSource,
    IDENTITY_CARD_QR_BOX.qrDrawX,
    IDENTITY_CARD_QR_BOX.qrDrawY,
    IDENTITY_CARD_QR_BOX.qrDrawSize,
    IDENTITY_CARD_QR_BOX.qrDrawSize
  );
  if (typeof ctx.imageSmoothingEnabled === 'boolean') {
    ctx.imageSmoothingEnabled = true;
  }

  // 4. EMPLOYEE DETAILS BELOW QR: Employee ID, Employee Name, Designation
  const maxContentWidth = W - 112;

  const empIdText = String(employee.employeeId || '').trim() || '—';
  ctx.fillStyle = '#64748B';
  ctx.font = '700 17px "Inter", "Segoe UI", Arial, sans-serif';
  ctx.fillText('EMPLOYEE ID', centerX, 764);

  const idFontSize = fitSingleLineFontSize(
    ctx,
    empIdText,
    46,
    28,
    (sz) => `800 ${sz}px "JetBrains Mono", "Consolas", "Courier New", monospace`,
    maxContentWidth
  );
  ctx.fillStyle = '#0F172A';
  ctx.font = `800 ${idFontSize}px "JetBrains Mono", "Consolas", "Courier New", monospace`;
  ctx.fillText(empIdText, centerX, 814, maxContentWidth);

  const empNameText = String(employee.employeeName || '').trim() || '—';
  ctx.fillStyle = '#64748B';
  ctx.font = '700 16px "Inter", "Segoe UI", Arial, sans-serif';
  ctx.fillText('EMPLOYEE NAME', centerX, 868);

  let nameFontSize = 34;
  ctx.font = `700 ${nameFontSize}px "Inter", "Segoe UI", Arial, sans-serif`;
  let nameLines = wrapCanvasText(ctx, empNameText, maxContentWidth, 2);
  if (nameLines.length > 1 && empNameText.length > 36) {
    nameFontSize = 28;
    ctx.font = `700 ${nameFontSize}px "Inter", "Segoe UI", Arial, sans-serif`;
    nameLines = wrapCanvasText(ctx, empNameText, maxContentWidth, 2);
  }
  ctx.fillStyle = '#0F172A';
  ctx.font = `700 ${nameFontSize}px "Inter", "Segoe UI", Arial, sans-serif`;
  const nameStartY = nameLines.length === 1 ? 912 : 904;
  const nameLineHeight = nameFontSize + 8;
  nameLines.forEach((line, idx) => {
    ctx.fillText(line, centerX, nameStartY + idx * nameLineHeight, maxContentWidth);
  });

  const designationText = String(employee.designation || '').trim() || '—';
  const desigLabelY = nameLines.length === 1 ? 970 : 992;
  ctx.fillStyle = '#64748B';
  ctx.font = '700 16px "Inter", "Segoe UI", Arial, sans-serif';
  ctx.fillText('DESIGNATION', centerX, desigLabelY);

  const desigFontSize = fitSingleLineFontSize(
    ctx,
    designationText,
    26,
    18,
    (sz) => `700 ${sz}px "Inter", "Segoe UI", Arial, sans-serif`,
    maxContentWidth
  );
  ctx.fillStyle = '#1D4ED8';
  ctx.font = `700 ${desigFontSize}px "Inter", "Segoe UI", Arial, sans-serif`;
  ctx.fillText(designationText, centerX, desigLabelY + 38, maxContentWidth);

  // 5. BOTTOM DETAILS: Line, Section, Department
  const footerX = 44;
  const footerY = 1084;
  const footerW = W - 88;
  const footerH = 186;
  const colW = footerW / 3;

  ctx.fillStyle = '#F8FAFC';
  ctx.fillRect(footerX, footerY, footerW, footerH);

  ctx.strokeStyle = '#E2E8F0';
  ctx.lineWidth = 2;
  ctx.strokeRect(footerX, footerY, footerW, footerH);

  // Vertical column dividers
  for (let c = 1; c <= 2; c++) {
    const divX = footerX + colW * c;
    ctx.beginPath();
    ctx.moveTo(divX, footerY + 18);
    ctx.lineTo(divX, footerY + footerH - 18);
    ctx.stroke();
  }

  const bottomColumns: Array<{ label: string; value: string }> = [
    { label: 'LINE', value: String(employee.floor || '').trim() || '—' },
    { label: 'SECTION', value: String(employee.section || '').trim() || '—' },
    { label: 'DEPARTMENT', value: String(employee.department || '').trim() || '—' },
  ];

  const colMaxTextW = colW - 28;
  bottomColumns.forEach((col, idx) => {
    const colCenterX = footerX + colW * idx + colW / 2;

    ctx.fillStyle = '#64748B';
    ctx.font = '700 17px "Inter", "Segoe UI", Arial, sans-serif';
    ctx.fillText(col.label, colCenterX, footerY + 46);

    const valFontSize = fitSingleLineFontSize(
      ctx,
      col.value,
      25,
      17,
      (sz) => `700 ${sz}px "Inter", "Segoe UI", Arial, sans-serif`,
      colMaxTextW
    );
    ctx.font = `700 ${valFontSize}px "Inter", "Segoe UI", Arial, sans-serif`;
    const wrappedVal = wrapCanvasText(ctx, col.value, colMaxTextW, 2);
    ctx.fillStyle = '#0F172A';
    const valStartY = wrappedVal.length === 1 ? footerY + 114 : footerY + 98;
    wrappedVal.forEach((line, lIdx) => {
      ctx.fillText(line, colCenterX, valStartY + lIdx * (valFontSize + 6), colMaxTextW);
    });
  });
}

export async function renderEmployeeIdentityCardBlob(
  employee: Employee,
  options?: { preRenderedQrDataUrl?: string }
): Promise<Blob> {
  if (typeof document === 'undefined') {
    throw new Error('Identity card PNG rendering requires a browser canvas environment.');
  }

  const qrDataUrl =
    options?.preRenderedQrDataUrl ||
    (await generatePureEmployeeQrDataUrl(employee, IDENTITY_CARD_QR_BOX.qrDrawSize));
  const qrImg = await loadImageElement(qrDataUrl);

  const canvas = document.createElement('canvas');
  drawEmployeeIdentityCardToCanvas(canvas, employee, qrImg);

  const blob = await new Promise<Blob | null>((resolve) => {
    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob((b) => resolve(b), 'image/png');
    } else {
      resolve(null);
    }
  });

  if (blob) return blob;

  const dataUrl = canvas.toDataURL('image/png');
  const res = await fetch(dataUrl);
  return res.blob();
}

export async function downloadEmployeeIdentityCardPng(
  employee: Employee,
  options?: { preRenderedQrDataUrl?: string }
): Promise<string> {
  const blob = await renderEmployeeIdentityCardBlob(employee, options);
  const fileName = buildIdentityCardFileName(employee.employeeId);
  const url = URL.createObjectURL(blob);

  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  return fileName;
}
