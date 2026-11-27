import {
  type AttendanceReportSummary,
  type ReportColumn,
  computeAttendanceReportSummary,
} from './attendanceReportBuilder';
import { formatIsoDateTimeKolkata12h } from './attendanceStatus';

export interface PremiumExcelExportOptions {
  rows: Record<string, any>[];
  columns: ReportColumn[];
  fileName: string;
  reportTitle?: string;
  reportType?: string;
  periodLabel?: string;
  sheetName?: string;
  summary?: AttendanceReportSummary | null;
  generatedAtIso?: string;
}

const FONT_FAMILY = 'Calibri';

const COLOR_BANNER_DARK = '0F2443';
const COLOR_NAVY_HEADER = '1B365D';
const COLOR_SUBTITLE_BG = 'F1F5F9';
const COLOR_ZEBRA_ROW = 'F8FAFC';
const COLOR_WHITE = 'FFFFFF';
const COLOR_BORDER_LIGHT = 'CBD5E1';
const COLOR_BORDER_HEADER = '0F2443';
const COLOR_TEXT_DARK = '0F172A';
const COLOR_TEXT_BODY = '1E293B';
const COLOR_TEXT_MUTED = '475569';
const COLOR_OT_FILL = 'EEF2FF';
const COLOR_OT_TEXT = '1E3A8A';
const COLOR_AUTOCLOSE_TEXT = '9A3412';

const MIN_COLUMN_WIDTHS: Record<string, number> = {
  employeeId: 15,
  name: 24,
  floor: 14,
  dept: 18,
  department: 18,
  section: 14,
  date: 16,
  shift: 16,
  scheduledStart: 20,
  scheduledEnd: 20,
  inTime: 16,
  actualOutTime: 17,
  autoCloseTime: 17,
  status: 19,
  autoCloseRecordedAt: 24,
  dutyHours: 14,
  otHours: 13,
  totalWorkingHours: 20,
  type: 16,
  active: 16,
  present: 13,
  absent: 13,
  percent: 16,
};

const LEFT_ALIGN_KEYS = new Set([
  'name',
  'floor',
  'dept',
  'department',
  'section',
  'shift',
  'type',
  'designation',
  'employeeName',
]);

const DURATION_KEY_TO_MINUTES_FIELD: Record<string, string> = {
  dutyHours: '_dutyMinutes',
  otHours: '_otMinutes',
  totalWorkingHours: '_totalWorkingMinutes',
};

function sanitizeSheetName(raw: string): string {
  const cleaned = String(raw || 'Attendance Report')
    .replace(/[\\/?*[\]:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || 'Attendance Report').slice(0, 31);
}

function sanitizeHeaderFooterText(raw: string): string {
  return String(raw || '').replace(/&/g, '&&');
}

function colIndexToLetter(colIndex: number): string {
  let n = colIndex;
  let result = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result || 'A';
}

function getStatusStyle(statusRaw: unknown): { fill: string; font: string } | null {
  const status = String(statusRaw || '').trim().toUpperCase();
  if (status === 'AUTO CLOSED' || status === 'MISSED PUNCH OUT') {
    return { fill: 'FFEDD5', font: '9A3412' }; // Soft Orange
  }
  if (status === 'COMPLETED' || status === 'COMPLETED + OT' || status === 'PRESENT') {
    return { fill: 'DCFCE7', font: '166534' }; // Soft Green
  }
  if (status === 'HALF DAY') {
    return { fill: 'FEF9C3', font: '854D0E' }; // Soft Yellow
  }
  if (status === 'SHORT LEAVE' || status === 'ABSENT' || status.startsWith('ABSENT')) {
    return { fill: 'FEE2E2', font: '991B1B' }; // Soft Light Red
  }
  if (status === 'IN PROGRESS' || status === 'HOLIDAY') {
    return { fill: 'DBEAFE', font: '1E40AF' }; // Soft Blue
  }
  if (status === 'APPROVED LEAVE' || status === 'LEAVE' || status === 'ON LEAVE') {
    return { fill: 'F3E8FF', font: '6B21A8' }; // Soft Purple
  }
  if (status === 'WEEKLY OFF' || status === 'WEEKLY_OFF' || status === 'FUTURE DATE' || status === 'NOT EMPLOYED') {
    return { fill: 'F1F5F9', font: '475569' }; // Neutral Slate
  }
  if (status === 'UNKNOWN') {
    return { fill: 'E2E8F0', font: '334155' };
  }
  return null;
}

function detectAttendanceSummary(
  rows: Record<string, any>[],
  columns: ReportColumn[],
  explicitSummary?: AttendanceReportSummary | null
): AttendanceReportSummary | null {
  if (explicitSummary !== undefined) {
    return explicitSummary;
  }
  const hasAttendanceColumns =
    columns.some((c) => c.key === 'dutyHours') &&
    columns.some((c) => c.key === 'otHours') &&
    columns.some((c) => c.key === 'status');
  if (!hasAttendanceColumns) return null;
  return computeAttendanceReportSummary(rows);
}

/**
 * Builds an enterprise-grade styled Excel (.xlsx) workbook buffer using ExcelJS.
 * Safe in both browser and Node/Vitest environments.
 */
export async function buildPremiumExcelWorkbookBuffer(
  options: PremiumExcelExportOptions
): Promise<ArrayBuffer> {
  const ExcelJSModule = await import('exceljs');
  const ExcelJS = (ExcelJSModule as any).default ?? ExcelJSModule;

  const {
    rows,
    columns,
    reportTitle = 'Attendance Report',
    periodLabel = 'All Records',
    sheetName,
    generatedAtIso,
  } = options;

  const colCount = Math.max(1, columns.length);
  const lastColLetter = colIndexToLetter(colCount);
  const generatedAtDisplay = formatIsoDateTimeKolkata12h(
    generatedAtIso || new Date().toISOString()
  );

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'NARID ATDC TRACKER';
  workbook.lastModifiedBy = 'NARID ATDC TRACKER';
  workbook.created = new Date();
  workbook.modified = new Date();

  const worksheet = workbook.addWorksheet(sanitizeSheetName(sheetName || reportTitle), {
    properties: {
      defaultRowHeight: 21,
      showGridLines: true,
    },
  });

  // ── 1. Corporate Header Banner (Rows 1–3, strictly above data table) ──
  worksheet.mergeCells(`A1:${lastColLetter}1`);
  const titleCell = worksheet.getCell('A1');
  titleCell.value = 'NARID ATDC TRACKER';
  titleCell.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: `FF${COLOR_BANNER_DARK}` },
  };
  titleCell.font = {
    name: FONT_FAMILY,
    size: 15,
    bold: true,
    color: { argb: `FF${COLOR_WHITE}` },
  };
  titleCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  worksheet.getRow(1).height = 30;

  worksheet.mergeCells(`A2:${lastColLetter}2`);
  const subtitleCell = worksheet.getCell('A2');
  subtitleCell.value = `${reportTitle.toUpperCase()}  |  Period: ${periodLabel}`;
  subtitleCell.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: `FF${COLOR_NAVY_HEADER}` },
  };
  subtitleCell.font = {
    name: FONT_FAMILY,
    size: 11,
    bold: true,
    color: { argb: 'FFE2E8F0' },
  };
  subtitleCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  worksheet.getRow(2).height = 22;

  worksheet.mergeCells(`A3:${lastColLetter}3`);
  const metaCell = worksheet.getCell('A3');
  metaCell.value = `Generated On: ${generatedAtDisplay} (IST)  |  Total Records: ${rows.length}  |  Timezone: Asia/Kolkata`;
  metaCell.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: `FF${COLOR_SUBTITLE_BG}` },
  };
  metaCell.font = {
    name: FONT_FAMILY,
    size: 9.5,
    italic: true,
    color: { argb: `FF${COLOR_TEXT_MUTED}` },
  };
  metaCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  metaCell.border = {
    bottom: { style: 'thin', color: { argb: `FF${COLOR_BORDER_LIGHT}` } },
  };
  worksheet.getRow(3).height = 19;

  // ── 2. Optional Dynamic Executive Summary Strip (Rows 5–6, strictly above table) ──
  const resolvedSummary = detectAttendanceSummary(rows, columns, options.summary);
  let headerRowIndex = 5;

  if (resolvedSummary && colCount >= 6) {
    worksheet.getRow(4).height = 8;

    const kpiBlocks: Array<{
      label: string;
      value: string | number;
      valueColor: string;
      fillColor: string;
      numFmt?: string;
    }> = [
      {
        label: 'Total Employees',
        value: resolvedSummary.totalEmployees,
        valueColor: COLOR_TEXT_DARK,
        fillColor: 'F8FAFC',
      },
      {
        label: 'Completed Attendance',
        value: resolvedSummary.completedCount,
        valueColor: '166534',
        fillColor: 'F0FDF4',
      },
      {
        label: 'Auto-Closed Attendance',
        value: resolvedSummary.autoClosedCount,
        valueColor: '9A3412',
        fillColor: 'FFF7ED',
      },
      {
        label: 'Half Day',
        value: resolvedSummary.halfDayCount,
        valueColor: '854D0E',
        fillColor: 'FEFCE8',
      },
      {
        label: 'Short Leave',
        value: resolvedSummary.shortLeaveCount,
        valueColor: '991B1B',
        fillColor: 'FEF2F2',
      },
      {
        label: 'Total OT Hours',
        value: resolvedSummary.totalOtHoursFormatted,
        valueColor: COLOR_OT_TEXT,
        fillColor: COLOR_OT_FILL,
      },
    ];

    const spanPerKpi = colCount >= 12 ? 2 : 1;
    worksheet.getRow(5).height = 18;
    worksheet.getRow(6).height = 24;

    kpiBlocks.forEach((kpi, index) => {
      const startCol = index * spanPerKpi + 1;
      const endCol = startCol + spanPerKpi - 1;
      if (endCol > colCount) return;

      const startLetter = colIndexToLetter(startCol);
      const endLetter = colIndexToLetter(endCol);
      if (spanPerKpi > 1) {
        worksheet.mergeCells(`${startLetter}5:${endLetter}5`);
        worksheet.mergeCells(`${startLetter}6:${endLetter}6`);
      }

      const labelCell = worksheet.getCell(`${startLetter}5`);
      labelCell.value = kpi.label;
      labelCell.font = {
        name: FONT_FAMILY,
        size: 8.5,
        bold: true,
        color: { argb: `FF${COLOR_TEXT_MUTED}` },
      };
      labelCell.alignment = { vertical: 'middle', horizontal: 'center' };

      const valueCell = worksheet.getCell(`${startLetter}6`);
      valueCell.value = kpi.value;
      valueCell.font = {
        name: FONT_FAMILY,
        size: 12,
        bold: true,
        color: { argb: `FF${kpi.valueColor}` },
      };
      valueCell.alignment = { vertical: 'middle', horizontal: 'center' };
      if (kpi.numFmt) {
        valueCell.numFmt = kpi.numFmt;
      }

      for (let c = startCol; c <= endCol; c++) {
        const cTop = worksheet.getRow(5).getCell(c);
        const cBot = worksheet.getRow(6).getCell(c);
        cTop.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: `FF${kpi.fillColor}` },
        };
        cBot.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: `FF${kpi.fillColor}` },
        };
        cTop.border = {
          top: { style: 'thin', color: { argb: `FF${COLOR_BORDER_LIGHT}` } },
          left: c === startCol ? { style: 'thin', color: { argb: `FF${COLOR_BORDER_LIGHT}` } } : undefined,
          right: c === endCol ? { style: 'thin', color: { argb: `FF${COLOR_BORDER_LIGHT}` } } : undefined,
        };
        cBot.border = {
          bottom: { style: 'thin', color: { argb: `FF${COLOR_BORDER_LIGHT}` } },
          left: c === startCol ? { style: 'thin', color: { argb: `FF${COLOR_BORDER_LIGHT}` } } : undefined,
          right: c === endCol ? { style: 'thin', color: { argb: `FF${COLOR_BORDER_LIGHT}` } } : undefined,
        };
      }
    });

    worksheet.getRow(7).height = 10;
    headerRowIndex = 8;
  } else {
    worksheet.getRow(4).height = 10;
    headerRowIndex = 5;
  }

  // ── 3. Styled Column Header Row ──
  const headerRow = worksheet.getRow(headerRowIndex);
  headerRow.height = 28;
  columns.forEach((col, idx) => {
    const cell = headerRow.getCell(idx + 1);
    cell.value = col.header;
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: `FF${COLOR_NAVY_HEADER}` },
    };
    cell.font = {
      name: FONT_FAMILY,
      size: 10,
      bold: true,
      color: { argb: `FF${COLOR_WHITE}` },
    };
    cell.alignment = {
      vertical: 'middle',
      horizontal: LEFT_ALIGN_KEYS.has(col.key) ? 'left' : 'center',
      wrapText: true,
      ...(LEFT_ALIGN_KEYS.has(col.key) ? { indent: 1 } : {}),
    };
    cell.border = {
      top: { style: 'thin', color: { argb: `FF${COLOR_BORDER_HEADER}` } },
      bottom: { style: 'medium', color: { argb: `FF${COLOR_BORDER_HEADER}` } },
      left: { style: 'thin', color: { argb: 'FF2C4A76' } },
      right: { style: 'thin', color: { argb: 'FF2C4A76' } },
    };
  });

  // Track max text width per column for auto-fit sizing
  const maxLengths = columns.map((col) =>
    Math.max(col.header.length + 3, MIN_COLUMN_WIDTHS[col.key] || 13)
  );

  // ── 4. Data Rows (Zero Merged Cells Inside Data Table!) ──
  const firstDataRowIndex = headerRowIndex + 1;
  rows.forEach((rowData, rowIdx) => {
    const excelRow = worksheet.getRow(firstDataRowIndex + rowIdx);
    excelRow.height = 22;
    const isAlt = rowIdx % 2 === 1;
    const baseFillHex = isAlt ? COLOR_ZEBRA_ROW : COLOR_WHITE;

    columns.forEach((col, colIdx) => {
      const cell = excelRow.getCell(colIdx + 1);
      const rawVal = rowData[col.key];
      const durationMinutesField = DURATION_KEY_TO_MINUTES_FIELD[col.key];
      const numericMinutes =
        durationMinutesField && typeof rowData[durationMinutesField] === 'number'
          ? Math.max(0, Math.floor(rowData[durationMinutesField]))
          : null;

      if (numericMinutes !== null) {
        // Native Excel duration fraction (minutes / 1440) formatted cleanly as [hh]:mm
        cell.value = numericMinutes / 1440;
        cell.numFmt = '[hh]:mm';
      } else {
        cell.value = rawVal ?? '';
      }

      // Compute visible text length for auto-fit column width
      const displayStr =
        numericMinutes !== null
          ? String(rawVal || '00:00')
          : String(rawVal ?? '');
      if (displayStr.length + 4 > maxLengths[colIdx]) {
        maxLengths[colIdx] = Math.min(38, displayStr.length + 4);
      }

      // Default zebra fill & subtle border
      let fillHex = baseFillHex;
      let fontColor = COLOR_TEXT_BODY;
      let isBold = false;
      let fontSize = 10;

      if (col.key === 'employeeId') {
        isBold = true;
        fontColor = COLOR_TEXT_DARK;
      } else if (col.key === 'totalWorkingHours') {
        isBold = true;
        fontColor = COLOR_TEXT_DARK;
      } else if (col.key === 'otHours') {
        const hasOt =
          (numericMinutes !== null && numericMinutes > 0) ||
          (numericMinutes === null && rawVal && String(rawVal) !== '00:00');
        if (hasOt) {
          fillHex = COLOR_OT_FILL;
          fontColor = COLOR_OT_TEXT;
          isBold = true;
        }
      } else if (col.key === 'autoCloseTime' && rawVal && String(rawVal) !== 'N/A') {
        fontColor = COLOR_AUTOCLOSE_TEXT;
        isBold = true;
      } else if (col.key === 'status') {
        const badgeStyle = getStatusStyle(rawVal);
        if (badgeStyle) {
          fillHex = badgeStyle.fill;
          fontColor = badgeStyle.font;
          isBold = true;
          fontSize = 9.5;
        }
      }

      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: `FF${fillHex}` },
      };
      cell.font = {
        name: FONT_FAMILY,
        size: fontSize,
        bold: isBold,
        color: { argb: `FF${fontColor}` },
      };
      cell.border = {
        top: { style: 'thin', color: { argb: `FF${COLOR_BORDER_LIGHT}` } },
        bottom: { style: 'thin', color: { argb: `FF${COLOR_BORDER_LIGHT}` } },
        left: { style: 'thin', color: { argb: `FF${COLOR_BORDER_LIGHT}` } },
        right: { style: 'thin', color: { argb: `FF${COLOR_BORDER_LIGHT}` } },
      };

      if (durationMinutesField) {
        cell.alignment = { vertical: 'middle', horizontal: 'right', indent: 1 };
      } else if (LEFT_ALIGN_KEYS.has(col.key)) {
        cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
      } else {
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
      }
    });
  });

  // ── 5. Auto-fit Column Widths (Generous Padding, No ### Clipping) ──
  columns.forEach((_, idx) => {
    worksheet.getColumn(idx + 1).width = Math.max(12, Math.min(38, maxLengths[idx]));
  });

  // ── 6. Freeze Top Header Row & Apply AutoFilter Strictly on Table Range ──
  worksheet.views = [
    {
      state: 'frozen',
      ySplit: headerRowIndex,
      activeCell: `A${firstDataRowIndex}`,
      showGridLines: true,
    },
  ];

  const lastDataRowIndex = Math.max(headerRowIndex, firstDataRowIndex + rows.length - 1);
  worksheet.autoFilter = {
    from: { row: headerRowIndex, column: 1 },
    to: { row: lastDataRowIndex, column: colCount },
  };

  // ── 7. Print & Page Setup (Landscape, Fit 1 Page Wide, Repeating Headers, Page Numbers) ──
  worksheet.pageSetup = {
    orientation: 'landscape',
    paperSize: 9, // A4
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    horizontalCentered: true,
    printTitlesRow: `${headerRowIndex}:${headerRowIndex}`,
    margins: {
      left: 0.35,
      right: 0.35,
      top: 0.55,
      bottom: 0.55,
      header: 0.25,
      footer: 0.25,
    },
  };

  worksheet.headerFooter = {
    oddHeader: `&L&B${sanitizeHeaderFooterText(reportTitle)}&R${sanitizeHeaderFooterText('NARID ATDC TRACKER')}`,
    oddFooter: `&LGenerated: ${sanitizeHeaderFooterText(generatedAtDisplay)} (IST)&RPage &P of &N`,
  };

  const buffer = await workbook.xlsx.writeBuffer();
  if (buffer instanceof ArrayBuffer) {
    return buffer;
  }
  const uint8 = new Uint8Array(buffer as ArrayLike<number>);
  return uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength);
}

/**
 * Generates and downloads a styled enterprise Excel (.xlsx) workbook in the browser.
 */
export async function downloadPremiumExcelWorkbook(
  options: PremiumExcelExportOptions
): Promise<void> {
  const arrayBuffer = await buildPremiumExcelWorkbookBuffer(options);
  const blob = new Blob([arrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const normalizedName = options.fileName.toLowerCase().endsWith('.xlsx')
    ? options.fileName
    : `${options.fileName}.xlsx`;

  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = normalizedName;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
}
