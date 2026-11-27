/**
 * Hardened Spreadsheet & CSV Parser / Template Builder (F-06)
 *
 * Replaces vulnerable `xlsx@0.18.5` (Prototype Pollution & ReDoS advisories) with:
 *  - `exceljs` for strict OOXML (.xlsx) parsing & template generation
 *  - A linear-time, stateful RFC-4180 CSV parser (zero regex backtracking)
 *  - Strict file-type, magic-byte, file-size, sheet-count, row-count, column-count, and cell-length guards
 */

export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_IMPORT_SHEETS = 10;
export const MAX_IMPORT_ROWS = 2500;
export const MAX_IMPORT_COLS = 50;
export const MAX_CELL_LENGTH = 500;

export const ALLOWED_SPREADSHEET_EXTENSIONS = ['.xlsx', '.csv'] as const;

export interface SpreadsheetFileLike {
  name?: string;
  size?: number;
  type?: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

export interface SafeSpreadsheetParseLimits {
  maxFileBytes?: number;
  maxSheets?: number;
  maxRows?: number;
  maxCols?: number;
  maxCellLength?: number;
}

export class SpreadsheetValidationError extends Error {
  code: string;
  constructor(message: string, code = 'SPREADSHEET_INVALID') {
    super(message);
    this.name = 'SpreadsheetValidationError';
    this.code = code;
  }
}

export function getSpreadsheetExtension(fileName: string): string {
  const clean = String(fileName || '').trim().toLowerCase();
  const dotIdx = clean.lastIndexOf('.');
  if (dotIdx < 0) return '';
  return clean.slice(dotIdx);
}

/**
 * Validates file extension and declared size prior to reading.
 */
export function validateSpreadsheetFileMeta(
  file: Pick<SpreadsheetFileLike, 'name' | 'size'>,
  limits?: SafeSpreadsheetParseLimits
): { format: 'xlsx' | 'csv'; extension: string } {
  const maxFileBytes = limits?.maxFileBytes ?? MAX_IMPORT_FILE_BYTES;
  const fileName = String(file?.name || '').trim();
  const ext = getSpreadsheetExtension(fileName);

  if (ext === '.xls') {
    throw new SpreadsheetValidationError(
      'Legacy binary .xls files are not supported for security reasons. Please save the file as .xlsx or .csv and upload again.',
      'UNSUPPORTED_LEGACY_XLS'
    );
  }

  if (ext !== '.xlsx' && ext !== '.csv') {
    throw new SpreadsheetValidationError(
      'Unsupported file format. Only .xlsx and .csv files are accepted.',
      'UNSUPPORTED_FILE_TYPE'
    );
  }

  if (typeof file?.size === 'number') {
    if (file.size <= 0) {
      throw new SpreadsheetValidationError('The uploaded file is empty.', 'EMPTY_FILE');
    }
    if (file.size > maxFileBytes) {
      const mb = (maxFileBytes / (1024 * 1024)).toFixed(0);
      throw new SpreadsheetValidationError(
        `File exceeds maximum allowed size of ${mb} MB.`,
        'FILE_TOO_LARGE'
      );
    }
  }

  return { format: ext === '.csv' ? 'csv' : 'xlsx', extension: ext };
}

/**
 * Verifies OOXML (.xlsx) ZIP local-file / empty-archive magic signature.
 */
export function hasZipMagicHeader(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false;
  // Standard ZIP signatures: PK\x03\x04 (local file header) or PK\x05\x06 (empty archive)
  return (
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06))
  );
}

/**
 * Safely converts an ExcelJS cell value to a bounded plain string without executing formulas or mutating prototypes.
 */
export function extractSafeExcelCellText(
  rawValue: unknown,
  maxCellLength: number = MAX_CELL_LENGTH
): string {
  if (rawValue === null || rawValue === undefined) return '';

  let str = '';
  if (typeof rawValue === 'string') {
    str = rawValue;
  } else if (typeof rawValue === 'number' || typeof rawValue === 'boolean') {
    str = String(rawValue);
  } else if (rawValue instanceof Date) {
    str = Number.isNaN(rawValue.getTime()) ? '' : rawValue.toISOString();
  } else if (typeof rawValue === 'object') {
    const obj = rawValue as Record<string, any>;
    if (Array.isArray(obj.richText)) {
      str = obj.richText.map((part: any) => String(part?.text ?? '')).join('');
    } else if (Object.prototype.hasOwnProperty.call(obj, 'result') && obj.result !== undefined) {
      return extractSafeExcelCellText(obj.result, maxCellLength);
    } else if (typeof obj.text === 'string') {
      str = obj.text;
    } else if (typeof obj.hyperlink === 'string') {
      str = obj.hyperlink;
    } else {
      str = '';
    }
  }

  if (str.length > maxCellLength) {
    throw new SpreadsheetValidationError(
      `Cell value exceeds maximum allowed length of ${maxCellLength} characters.`,
      'CELL_TOO_LONG'
    );
  }
  return str;
}

/**
 * Linear-time, stateful RFC-4180 CSV parser (no backtracking regexes).
 * Enforces strict row, column, and cell-length bounds and rejects binary NUL bytes.
 */
export function parseCsvStrict(
  csvText: string,
  limits?: SafeSpreadsheetParseLimits
): string[][] {
  const maxRows = limits?.maxRows ?? MAX_IMPORT_ROWS;
  const maxCols = limits?.maxCols ?? MAX_IMPORT_COLS;
  const maxCellLength = limits?.maxCellLength ?? MAX_CELL_LENGTH;

  if (csvText.includes('\u0000')) {
    throw new SpreadsheetValidationError(
      'Invalid CSV file: binary NUL bytes detected.',
      'BINARY_IN_CSV'
    );
  }

  // Strip UTF-8 BOM if present
  const input = csvText.charCodeAt(0) === 0xfeff ? csvText.slice(1) : csvText;
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = '';
  let inQuotes = false;

  const pushCell = () => {
    if (currentCell.length > maxCellLength) {
      throw new SpreadsheetValidationError(
        `CSV cell exceeds maximum allowed length of ${maxCellLength} characters.`,
        'CELL_TOO_LONG'
      );
    }
    currentRow.push(currentCell);
    if (currentRow.length > maxCols) {
      throw new SpreadsheetValidationError(
        `CSV exceeds maximum allowed column count of ${maxCols}.`,
        'TOO_MANY_COLUMNS'
      );
    }
    currentCell = '';
  };

  const pushRow = () => {
    pushCell();
    // Skip trailing completely empty line at EOF
    rows.push(currentRow);
    if (rows.length > maxRows) {
      throw new SpreadsheetValidationError(
        `Spreadsheet exceeds maximum allowed row limit of ${maxRows} rows.`,
        'TOO_MANY_ROWS'
      );
    }
    currentRow = [];
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < input.length && input[i + 1] === '"') {
          currentCell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        currentCell += ch;
        if (currentCell.length > maxCellLength) {
          throw new SpreadsheetValidationError(
            `CSV cell exceeds maximum allowed length of ${maxCellLength} characters.`,
            'CELL_TOO_LONG'
          );
        }
      }
      continue;
    }

    if (ch === '"') {
      if (currentCell.length === 0) {
        inQuotes = true;
      } else {
        currentCell += ch;
      }
    } else if (ch === ',') {
      pushCell();
    } else if (ch === '\r') {
      if (i + 1 < input.length && input[i + 1] === '\n') {
        i++;
      }
      pushRow();
    } else if (ch === '\n') {
      pushRow();
    } else {
      currentCell += ch;
      if (currentCell.length > maxCellLength) {
        throw new SpreadsheetValidationError(
          `CSV cell exceeds maximum allowed length of ${maxCellLength} characters.`,
          'CELL_TOO_LONG'
        );
      }
    }
  }

  if (inQuotes) {
    throw new SpreadsheetValidationError(
      'Malformed CSV file: unterminated quoted field.',
      'MALFORMED_CSV'
    );
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    pushRow();
  }

  // Drop trailing blank lines
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c.trim() === '')) {
    rows.pop();
  }

  return rows;
}

/**
 * Parses an uploaded .xlsx or .csv file into a 2D array of bounded plain strings
 * using `exceljs` (.xlsx) or the strict RFC-4180 parser (.csv).
 */
export async function parseSafeSpreadsheetFile(
  file: SpreadsheetFileLike,
  limits?: SafeSpreadsheetParseLimits
): Promise<string[][]> {
  const maxFileBytes = limits?.maxFileBytes ?? MAX_IMPORT_FILE_BYTES;
  const maxSheets = limits?.maxSheets ?? MAX_IMPORT_SHEETS;
  const maxRows = limits?.maxRows ?? MAX_IMPORT_ROWS;
  const maxCols = limits?.maxCols ?? MAX_IMPORT_COLS;
  const maxCellLength = limits?.maxCellLength ?? MAX_CELL_LENGTH;

  const { format } = validateSpreadsheetFileMeta(file, limits);
  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);

  if (bytes.byteLength === 0) {
    throw new SpreadsheetValidationError('The uploaded file is empty.', 'EMPTY_FILE');
  }
  if (bytes.byteLength > maxFileBytes) {
    const mb = (maxFileBytes / (1024 * 1024)).toFixed(0);
    throw new SpreadsheetValidationError(
      `File exceeds maximum allowed size of ${mb} MB.`,
      'FILE_TOO_LARGE'
    );
  }

  if (format === 'csv') {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    return parseCsvStrict(text, limits);
  }

  if (!hasZipMagicHeader(bytes)) {
    throw new SpreadsheetValidationError(
      'Invalid .xlsx file: file signature does not match an Excel OOXML workbook.',
      'INVALID_XLSX_SIGNATURE'
    );
  }

  const ExcelJSModule = await import('exceljs');
  const ExcelJS = (ExcelJSModule as any).default ?? ExcelJSModule;
  const workbook = new ExcelJS.Workbook();

  try {
    await workbook.xlsx.load(arrayBuffer);
  } catch {
    throw new SpreadsheetValidationError(
      'Unable to read Excel workbook. The .xlsx file may be corrupted or password-protected.',
      'CORRUPTED_XLSX'
    );
  }

  const worksheets = workbook.worksheets || [];
  if (worksheets.length === 0) {
    throw new SpreadsheetValidationError(
      'The uploaded Excel workbook does not contain any worksheets.',
      'NO_WORKSHEETS'
    );
  }
  if (worksheets.length > maxSheets) {
    throw new SpreadsheetValidationError(
      `Workbook contains too many worksheets (maximum ${maxSheets} allowed).`,
      'TOO_MANY_SHEETS'
    );
  }

  const sheet = worksheets[0];
  const declaredRowCount = Number(sheet.actualRowCount || sheet.rowCount || 0);
  if (declaredRowCount > maxRows) {
    throw new SpreadsheetValidationError(
      `Spreadsheet exceeds maximum allowed row limit of ${maxRows} rows.`,
      'TOO_MANY_ROWS'
    );
  }
  const declaredColCount = Number(sheet.actualColumnCount || sheet.columnCount || 0);
  if (declaredColCount > maxCols) {
    throw new SpreadsheetValidationError(
      `Spreadsheet exceeds maximum allowed column count of ${maxCols}.`,
      'TOO_MANY_COLUMNS'
    );
  }

  const rows: string[][] = [];
  const totalRows = Math.min(Number(sheet.rowCount || 0), maxRows + 1);

  for (let r = 1; r <= totalRows; r++) {
    const row = sheet.getRow(r);
    const cellCount = Math.min(Math.max(Number(row.cellCount || 0), declaredColCount), maxCols + 1);
    if (cellCount > maxCols) {
      throw new SpreadsheetValidationError(
        `Spreadsheet exceeds maximum allowed column count of ${maxCols}.`,
        'TOO_MANY_COLUMNS'
      );
    }

    const rowValues: string[] = [];
    let hasNonEmpty = false;
    for (let c = 1; c <= cellCount; c++) {
      const cell = row.getCell(c);
      const val = extractSafeExcelCellText(cell?.value, maxCellLength);
      if (val.trim() !== '') hasNonEmpty = true;
      rowValues.push(val);
    }

    // Preserve row position for non-empty rows while trimming trailing blank cells
    if (hasNonEmpty) {
      while (rowValues.length > 0 && rowValues[rowValues.length - 1] === '') {
        rowValues.pop();
      }
      rows.push(rowValues);
      if (rows.length > maxRows) {
        throw new SpreadsheetValidationError(
          `Spreadsheet exceeds maximum allowed row limit of ${maxRows} rows.`,
          'TOO_MANY_ROWS'
        );
      }
    } else if (rows.length > 0) {
      // Keep internal empty row placeholder so Excel row numbers stay accurate
      rows.push([]);
    }
  }

  while (rows.length > 0 && rows[rows.length - 1].length === 0) {
    rows.pop();
  }

  return rows;
}

/**
 * Generates the standard Employee Master Import Template (.xlsx) using ExcelJS (no `xlsx` dependency).
 */
export async function buildEmployeeTemplateWorkbookBuffer(): Promise<ArrayBuffer> {
  const ExcelJSModule = await import('exceljs');
  const ExcelJS = (ExcelJSModule as any).default ?? ExcelJSModule;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'NARID ATDC TRACKER';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Employee_Master_Template');
  sheet.columns = [
    { header: 'Employee ID', key: 'employeeId', width: 15 },
    { header: 'Employee Name', key: 'employeeName', width: 22 },
    { header: 'Employee Type', key: 'employeeType', width: 15 },
    { header: 'Section', key: 'section', width: 12 },
    { header: 'Department', key: 'department', width: 16 },
    { header: 'Line', key: 'line', width: 14 },
    { header: 'Designation', key: 'designation', width: 22 },
    { header: 'Status', key: 'status', width: 12 },
  ];

  const headerRow = sheet.getRow(1);
  headerRow.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B365D' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'left' };
  headerRow.height = 24;

  const sampleRows = [
    ['JMD12345', 'RAHUL SHARMA', 'Offroll', 'MI', 'Production', 'MI-01', 'Assembly Operator', 'Active'],
    ['JMD12346', 'AMIT PATEL', 'Permanent', 'FATP', 'Quality', 'FATP-STB', 'Quality Inspector', 'Active'],
    ['JMD12347', 'SURESH VERMA', 'Staff', 'SMT', 'Production', 'SMT-01', 'Shift Supervisor', 'Active'],
    ['JMD12348', 'PRIYA NAIR', 'Staff', 'STORE', 'Store', 'FATP-ITR', 'Inventory Officer', 'Active'],
  ];

  for (const r of sampleRows) {
    sheet.addRow(r);
  }

  const buffer = await workbook.xlsx.writeBuffer();
  if (buffer instanceof ArrayBuffer) {
    return buffer;
  }
  const uint8 = new Uint8Array(buffer as ArrayLike<number>);
  return uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength);
}
