import { Employee } from '../types';
import { getAuthHeaders, sendServerAuditEvent } from './auditService';
import { apiFetchJson } from '../config/api';
import {
  buildIdentityCardFileName,
  renderEmployeeIdentityCardBlob,
} from '../utils/qrIdentityCard';
import { createZipBlob, ZipEntryInput } from '../utils/zipBuilder';
import { reportUiActivity } from '../utils/perfMonitor';

export interface BulkExportColumn {
  header: string;
  key: string;
}

export interface BulkExportOptions {
  onProgress?: (completed: number, total: number) => void;
  auditTargetType?: string;
  auditSource?: string;
  auditDescription?: string;
}

export function buildTimestampSuffix(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(
    date.getHours()
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function yieldToMainThread(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function triggerBlobDownload(blob: Blob, fullFileName: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = fullFileName;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
}

export async function exportChunkedToExcel(
  rows: Record<string, any>[],
  columns: BulkExportColumn[],
  filePrefix: string,
  options: BulkExportOptions = {}
): Promise<{ fileName: string; rowCount: number }> {
  if (rows.length === 0) {
    throw new Error('Select at least one record before exporting.');
  }

  const XLSX = await import('xlsx');
  const CHUNK_SIZE = 250;
  const wsData: any[][] = [columns.map((c) => c.header)];

  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const slice = rows.slice(i, i + CHUNK_SIZE);
    for (const r of slice) {
      wsData.push(columns.map((c) => r[c.key] ?? ''));
    }
    options.onProgress?.(Math.min(rows.length, i + slice.length), rows.length);
    if (i + CHUNK_SIZE < rows.length) {
      await yieldToMainThread();
    }
  }

  const ws = XLSX.utils.aoa_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Export');

  const fileName = `${filePrefix}_${buildTimestampSuffix()}`;
  XLSX.writeFile(wb, `${fileName}.xlsx`);

  if (options.auditTargetType) {
    sendServerAuditEvent({
      action: 'REPORT_EXPORTED',
      category: 'EXPORT',
      targetType: options.auditTargetType,
      targetId: fileName,
      newValue: { format: 'xlsx', rowCount: rows.length, bulkSelected: true },
      actionSource: options.auditSource || 'BULK_SELECTION_EXPORT',
      description:
        options.auditDescription ||
        `Bulk exported ${rows.length} selected ${options.auditTargetType} records to Excel (.xlsx).`,
    });
  }
  reportUiActivity('EXCEL_EXPORTED', options.auditSource || 'Reports & Export', `Exported ${rows.length} row(s) to Excel`);

  return { fileName: `${fileName}.xlsx`, rowCount: rows.length };
}

function escapeCsvCell(value: unknown): string {
  const s = String(value ?? '');
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export async function exportChunkedToCsv(
  rows: Record<string, any>[],
  columns: BulkExportColumn[],
  filePrefix: string,
  options: BulkExportOptions = {}
): Promise<{ fileName: string; rowCount: number }> {
  if (rows.length === 0) {
    throw new Error('Select at least one record before exporting.');
  }

  const CHUNK_SIZE = 250;
  const lines: string[] = [columns.map((c) => escapeCsvCell(c.header)).join(',')];

  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const slice = rows.slice(i, i + CHUNK_SIZE);
    for (const row of slice) {
      lines.push(columns.map((c) => escapeCsvCell(row[c.key])).join(','));
    }
    options.onProgress?.(Math.min(rows.length, i + slice.length), rows.length);
    if (i + CHUNK_SIZE < rows.length) {
      await yieldToMainThread();
    }
  }

  const csv = lines.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const fileName = `${filePrefix}_${buildTimestampSuffix()}.csv`;
  triggerBlobDownload(blob, fileName);

  if (options.auditTargetType) {
    sendServerAuditEvent({
      action: 'REPORT_EXPORTED',
      category: 'EXPORT',
      targetType: options.auditTargetType,
      targetId: fileName,
      newValue: { format: 'csv', rowCount: rows.length, bulkSelected: true },
      actionSource: options.auditSource || 'BULK_SELECTION_EXPORT',
      description:
        options.auditDescription ||
        `Bulk exported ${rows.length} selected ${options.auditTargetType} records to CSV.`,
    });
  }
  reportUiActivity('CSV_EXPORTED', options.auditSource || 'Reports & Export', `Exported ${rows.length} row(s) to CSV`);

  return { fileName, rowCount: rows.length };
}

export interface BulkQrZipProgress {
  completed: number;
  total: number;
  currentEmployeeId?: string;
}

export interface BulkQrZipFailedItem {
  employeeId: string;
  error: string;
}

export interface BulkQrZipResult {
  fileName: string | null;
  exportedCount: number;
  exportedIds: string[];
  skippedIds: string[];
  failedItems: BulkQrZipFailedItem[];
}

/**
 * Generates individual high-res QR Identity Card PNGs for selected employees (preserving exact
 * existing qrCodeToken & QR payload) and bundles them into a single ZIP archive cleanly.
 */
export async function downloadQrIdentityCardsZip(
  employees: Employee[],
  options: {
    onProgress?: (progress: BulkQrZipProgress) => void;
    renderCardBlob?: (employee: Employee) => Promise<Blob>;
    skipDownloadTrigger?: boolean;
    auditSource?: string;
  } = {}
): Promise<{ result: BulkQrZipResult; zipBlob: Blob | null }> {
  if (employees.length === 0) {
    throw new Error('Select at least one employee to download QR identity cards.');
  }

  const renderFn = options.renderCardBlob || renderEmployeeIdentityCardBlob;
  const entries: ZipEntryInput[] = [];
  const exportedIds: string[] = [];
  const skippedIds: string[] = [];
  const failedItems: BulkQrZipFailedItem[] = [];

  const BATCH_SIZE = 4;
  let processed = 0;

  for (let i = 0; i < employees.length; i += BATCH_SIZE) {
    const chunk = employees.slice(i, i + BATCH_SIZE);
    for (const emp of chunk) {
      if (!emp.employeeId || !emp.qrCodeToken) {
        skippedIds.push(emp.employeeId || 'UNKNOWN');
        processed++;
        options.onProgress?.({
          completed: processed,
          total: employees.length,
          currentEmployeeId: emp.employeeId,
        });
        continue;
      }

      try {
        const pngBlob = await renderFn(emp);
        entries.push({
          name: buildIdentityCardFileName(emp.employeeId),
          data: pngBlob,
        });
        exportedIds.push(emp.employeeId);
      } catch (err: any) {
        failedItems.push({
          employeeId: emp.employeeId,
          error: err?.message || 'QR Identity Card rendering failed.',
        });
      }

      processed++;
      options.onProgress?.({
        completed: processed,
        total: employees.length,
        currentEmployeeId: emp.employeeId,
      });
    }

    if (i + BATCH_SIZE < employees.length) {
      await yieldToMainThread();
    }
  }

  if (entries.length === 0) {
    return {
      result: {
        fileName: null,
        exportedCount: 0,
        exportedIds,
        skippedIds,
        failedItems,
      },
      zipBlob: null,
    };
  }

  const zipBlob = await createZipBlob(entries);
  const fileName = `NARID_QR_ID_Cards_${buildTimestampSuffix()}.zip`;

  if (!options.skipDownloadTrigger) {
    triggerBlobDownload(zipBlob, fileName);
  }

  sendServerAuditEvent({
    action: 'QR_BULK_ZIP_DOWNLOADED',
    category: 'QR',
    targetType: 'EMPLOYEE_QR_CARDS',
    targetId: fileName,
    newValue: {
      exportedCount: exportedIds.length,
      skippedCount: skippedIds.length,
      failedCount: failedItems.length,
    },
    actionSource: options.auditSource || 'QR_MANAGEMENT',
    description: `Downloaded ${exportedIds.length} Employee QR Identity Cards in ZIP archive "${fileName}".`,
  });
  reportUiActivity('QR_ZIP_DOWNLOADED', 'QR Code Management', `Bundled ${exportedIds.length} QR Identity Card(s)`);

  return {
    result: {
      fileName,
      exportedCount: exportedIds.length,
      exportedIds,
      skippedIds,
      failedItems,
    },
    zipBlob,
  };
}

export interface BulkMutationItemOutcome {
  id: string;
  reason?: string;
  error?: string;
}

export interface BulkMutationResponse {
  success: boolean;
  action?: string;
  resource?: string;
  status?: string;
  savedCount: number;
  skippedCount: number;
  failedCount: number;
  partialCommit: boolean;
  committedIds: string[];
  skippedItems: BulkMutationItemOutcome[];
  failedItems: BulkMutationItemOutcome[];
  error?: string;
}

export async function executeEmployeeBulkAction(params: {
  action: 'ACTIVATE' | 'DEACTIVATE' | 'DELETE';
  employeeIds: string[];
  confirmPhrase?: string;
  reason?: string;
}): Promise<BulkMutationResponse> {
  const headers = await getAuthHeaders();
  return apiFetchJson<BulkMutationResponse>(
    '/api/employees/bulk-action',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        action: params.action,
        employeeIds: params.employeeIds,
        confirmed: true,
        ...(params.confirmPhrase ? { confirmPhrase: params.confirmPhrase } : {}),
        ...(params.reason ? { reason: params.reason } : {}),
      }),
    },
    'Employee bulk action failed.'
  );
}

export async function executeMasterBulkStatus(params: {
  resource: 'shifts' | 'floors' | 'sections' | 'departments';
  ids: string[];
  status: 'Active' | 'Inactive';
}): Promise<BulkMutationResponse> {
  const headers = await getAuthHeaders();
  return apiFetchJson<BulkMutationResponse>(
    '/api/masters/bulk-status',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        resource: params.resource,
        ids: params.ids,
        status: params.status,
        confirmed: true,
      }),
    },
    'Master configuration bulk status update failed.'
  );
}

export async function executeUsersBulkStatus(params: {
  userIds: string[];
  status: 'Active' | 'Inactive';
}): Promise<BulkMutationResponse> {
  const headers = await getAuthHeaders();
  return apiFetchJson<BulkMutationResponse>(
    '/api/admin/users/bulk-status',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        userIds: params.userIds,
        status: params.status,
        confirmed: true,
      }),
    },
    'User accounts bulk status update failed.'
  );
}
