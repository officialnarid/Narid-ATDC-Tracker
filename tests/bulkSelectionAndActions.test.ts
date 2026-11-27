import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { computeCrc32, createZipUint8Array } from '../src/utils/zipBuilder';
import {
  downloadQrIdentityCardsZip,
  exportChunkedToCsv,
  exportChunkedToExcel,
} from '../src/services/bulkActionService';
import { Employee, Floor, Section, Department, Shift, UserRoleRecord } from '../src/types';
import { BulkActionBar, SelectAllCheckbox } from '../src/components/BulkActionBar';
import { BulkConfirmModal, CrossPageSelectConfirmModal } from '../src/components/BulkConfirmModal';
import { ShiftManagement } from '../src/components/ShiftManagement';
import { FloorManagement } from '../src/components/FloorManagement';
import { SectionManagement } from '../src/components/SectionManagement';
import { DepartmentManagement } from '../src/components/DepartmentManagement';
import { UserRights } from '../src/components/UserRights';

/**
 * Minimal PKZIP central directory parser to verify archive byte-structure integrity.
 */
function parseZipEntries(zipBytes: Uint8Array): Array<{ name: string; crc32: number; data: Uint8Array }> {
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  // Locate EOCD signature 0x06054b50 from end
  let eocdOffset = -1;
  for (let i = zipBytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  expect(eocdOffset).toBeGreaterThan(-1);

  const entryCount = view.getUint16(eocdOffset + 8, true);
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);
  const decoder = new TextDecoder();

  const results: Array<{ name: string; crc32: number; data: Uint8Array }> = [];
  let cdCursor = centralDirOffset;
  for (let i = 0; i < entryCount; i++) {
    expect(view.getUint32(cdCursor, true)).toBe(0x02014b50);
    const crc32 = view.getUint32(cdCursor + 16, true);
    const compSize = view.getUint32(cdCursor + 20, true);
    const nameLen = view.getUint16(cdCursor + 28, true);
    const extraLen = view.getUint16(cdCursor + 30, true);
    const commentLen = view.getUint16(cdCursor + 32, true);
    const localHeaderOffset = view.getUint32(cdCursor + 42, true);

    const name = decoder.decode(zipBytes.slice(cdCursor + 46, cdCursor + 46 + nameLen));

    expect(view.getUint32(localHeaderOffset, true)).toBe(0x04034b50);
    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const data = zipBytes.slice(dataStart, dataStart + compSize);

    results.push({ name, crc32, data });
    cdCursor += 46 + nameLen + extraLen + commentLen;
  }
  return results;
}

const SAMPLE_EMPLOYEES: Employee[] = [
  {
    employeeId: 'TST_BULK_01',
    employeeName: 'ANANYA SHARMA',
    employeeType: 'Permanent',
    section: 'MI',
    department: 'Production',
    floor: 'MI-01',
    designation: 'Line Leader',
    qrCodeToken: 'QR_TST_BULK_01_FIXED',
    employeeStatus: 'Active',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  },
  {
    employeeId: 'TST_BULK_02',
    employeeName: 'VIKRAM PATEL',
    employeeType: 'Offroll',
    section: 'SMT',
    department: 'Quality',
    floor: 'SMT-01',
    designation: 'Tester',
    qrCodeToken: 'QR_TST_BULK_02_FIXED',
    employeeStatus: 'Active',
    createdAt: '2025-01-02T00:00:00.000Z',
    updatedAt: '2025-01-02T00:00:00.000Z',
  },
  {
    employeeId: 'TST_BULK_NOQR',
    employeeName: 'MISSING TOKEN USER',
    employeeType: 'Staff',
    section: 'STORE',
    department: 'Store',
    floor: 'STORE-01',
    designation: 'Clerk',
    qrCodeToken: '',
    employeeStatus: 'Inactive',
    createdAt: '2025-01-03T00:00:00.000Z',
    updatedAt: '2025-01-03T00:00:00.000Z',
  },
];

describe('Global Bulk Selection, ZIP Builder & Chunked Export Engine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as any).document;
  });

  it('1. computes IEEE CRC-32 and builds valid PKZIP archives with duplicate-name deduplication', async () => {
    const encoder = new TextEncoder();
    const checkVal = computeCrc32(encoder.encode('123456789'));
    expect(checkVal).toBe(0xcbf43926);

    const payloadA = encoder.encode('PNG_CARD_DATA_ONE');
    const payloadB = encoder.encode('PNG_CARD_DATA_TWO');

    const zipBytes = await createZipUint8Array([
      { name: 'QR_ID_Card_EMP1.png', data: payloadA },
      { name: 'QR_ID_Card_EMP1.png', data: payloadB },
    ]);

    const parsed = parseZipEntries(zipBytes);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].name).toBe('QR_ID_Card_EMP1.png');
    expect(parsed[0].crc32).toBe(computeCrc32(payloadA));
    expect(parsed[0].data).toEqual(payloadA);

    expect(parsed[1].name).toBe('QR_ID_Card_EMP1_2.png');
    expect(parsed[1].crc32).toBe(computeCrc32(payloadB));
    expect(parsed[1].data).toEqual(payloadB);
  });

  it('2. bundles Employee QR Identity Cards into a ZIP while preserving exact QR tokens and isolating failures', async () => {
    const seenTokens: string[] = [];
    const progressSteps: Array<{ completed: number; total: number }> = [];

    const { result, zipBlob } = await downloadQrIdentityCardsZip(SAMPLE_EMPLOYEES, {
      skipDownloadTrigger: true,
      auditSource: 'TEST_SUITE',
      onProgress: (p) => progressSteps.push({ completed: p.completed, total: p.total }),
      renderCardBlob: async (emp) => {
        seenTokens.push(emp.qrCodeToken || '');
        if (emp.employeeId === 'TST_BULK_02') {
          throw new Error('Simulated canvas render failure');
        }
        return new Blob([`MOCK_PNG_${emp.employeeId}_${emp.qrCodeToken}`], { type: 'image/png' });
      },
    });

    // Exact existing tokens passed through untouched; missing-token employee skipped safely
    expect(seenTokens).toEqual(['QR_TST_BULK_01_FIXED', 'QR_TST_BULK_02_FIXED']);
    expect(result.exportedCount).toBe(1);
    expect(result.exportedIds).toEqual(['TST_BULK_01']);
    expect(result.skippedIds).toEqual(['TST_BULK_NOQR']);
    expect(result.failedItems).toEqual([
      { employeeId: 'TST_BULK_02', error: 'Simulated canvas render failure' },
    ]);
    expect(progressSteps).toEqual([
      { completed: 1, total: 3 },
      { completed: 2, total: 3 },
      { completed: 3, total: 3 },
    ]);
    expect(zipBlob).not.toBeNull();

    const zipArray = new Uint8Array(await zipBlob!.arrayBuffer());
    const entries = parseZipEntries(zipArray);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('QR_ID_Card_TST_BULK_01.png');
    expect(new TextDecoder().decode(entries[0].data)).toContain('QR_TST_BULK_01_FIXED');

    // Retry-Failed-Only workflow recovers TST_BULK_02 cleanly
    const failedOnly = SAMPLE_EMPLOYEES.filter((e) =>
      result.failedItems.some((f) => f.employeeId === e.employeeId)
    );
    const retryRes = await downloadQrIdentityCardsZip(failedOnly, {
      skipDownloadTrigger: true,
      renderCardBlob: async (emp) =>
        new Blob([`RETRIED_PNG_${emp.employeeId}_${emp.qrCodeToken}`], { type: 'image/png' }),
    });
    expect(retryRes.result.exportedCount).toBe(1);
    expect(retryRes.result.failedItems).toHaveLength(0);
    expect(retryRes.result.exportedIds).toEqual(['TST_BULK_02']);
  });

  it('3. enforces empty-selection guard and executes chunked CSV & Excel export cleanly at >250 rows', async () => {
    await expect(
      exportChunkedToCsv([], [{ header: 'ID', key: 'id' }], 'EmptyTest')
    ).rejects.toThrow('Select at least one record before exporting.');

    await expect(
      exportChunkedToExcel([], [{ header: 'ID', key: 'id' }], 'EmptyTest')
    ).rejects.toThrow('Select at least one record before exporting.');

    // Stub minimal DOM anchors & URL object helpers for Node execution
    const clickedDownloads: string[] = [];
    const fakeAnchor = {
      href: '',
      download: '',
      style: { display: '' },
      click: () => clickedDownloads.push(fakeAnchor.download),
    };
    (globalThis as any).document = {
      createElement: () => fakeAnchor,
      body: {
        appendChild: () => {},
        removeChild: () => {},
      },
    };
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-bulk-csv');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    const rows = Array.from({ length: 550 }, (_, idx) => ({
      id: `ROW_${idx + 1}`,
      note: idx === 0 ? 'Contains, "quotes" & comma' : `Note ${idx + 1}`,
    }));

    const csvProgress: number[] = [];
    const csvResult = await exportChunkedToCsv(
      rows,
      [
        { header: 'ID', key: 'id' },
        { header: 'Note', key: 'note' },
      ],
      'Bulk_Chunk_Test',
      {
        onProgress: (done) => csvProgress.push(done),
      }
    );

    expect(csvResult.rowCount).toBe(550);
    expect(csvResult.fileName).toMatch(/^Bulk_Chunk_Test_\d{8}_\d{6}\.csv$/);
    expect(clickedDownloads).toEqual([csvResult.fileName]);
    // Chunked into 250 + 250 + 50
    expect(csvProgress).toEqual([250, 500, 550]);
  });

  it('4. renders BulkActionBar, modals, and updated bulk-enabled components cleanly without runtime errors', () => {
    const barHtml = renderToStaticMarkup(
      React.createElement(BulkActionBar, {
        selectedCount: 15,
        totalFilteredCount: 54,
        currentPageCount: 15,
        isAllFilteredSelected: false,
        isPageAllSelected: true,
        recordLabel: 'employees',
        onSelectAllFiltered: () => {},
        onClearSelection: () => {},
        actions: [
          { id: 'excel', label: 'Export Excel', onClick: () => {} },
          { id: 'zip', label: 'Download QR ZIP', tone: 'primary', onClick: () => {} },
        ],
      })
    );
    expect(barHtml).toContain('15');
    expect(barHtml).toContain('Select all 54 filtered');
    expect(barHtml).toContain('Download QR ZIP');

    const checkboxHtml = renderToStaticMarkup(
      React.createElement(SelectAllCheckbox, {
        checked: false,
        indeterminate: true,
        onChange: () => {},
      })
    );
    expect(checkboxHtml).toContain('type="checkbox"');

    const confirmHtml = renderToStaticMarkup(
      React.createElement(BulkConfirmModal, {
        isOpen: true,
        title: 'Bulk Delete Employees?',
        description: 'Permanent delete warning.',
        selectedCount: 4,
        confirmLabel: 'Delete Permanently',
        tone: 'danger',
        requireConfirmPhrase: 'DELETE',
        onConfirm: () => {},
        onCancel: () => {},
      })
    );
    expect(confirmHtml).toContain('Bulk Delete Employees?');
    expect(confirmHtml).toContain('DELETE');

    const crossPageHtml = renderToStaticMarkup(
      React.createElement(CrossPageSelectConfirmModal, {
        isOpen: true,
        totalFilteredCount: 54,
        currentPageCount: 15,
        recordLabel: 'employees',
        onConfirm: () => {},
        onCancel: () => {},
      })
    );
    expect(crossPageHtml).toContain('Select All 54 Filtered');

    const superUserRole: UserRoleRecord = {
      id: 'role_superadmin',
      loginId: 'superadmin',
      name: 'SUPER ADMIN',
      email: 'superadmin@narid.com',
      role: 'super_admin',
      status: 'Active',
      modulesAllowed: ['all'],
      createdAt: '',
      updatedAt: '',
    };

    const sampleShifts: Shift[] = [
      {
        id: 'DAY',
        name: 'DAY SHIFT',
        startTime: '09:00',
        endTime: '17:30',
        scheduledDurationMinutes: 510,
        punchInWindowStart: '08:00',
        punchInWindowEnd: '20:00',
        isOvernight: false,
        gracePeriodMinutes: 15,
        status: 'Active',
      },
    ];
    const shiftsHtml = renderToStaticMarkup(
      React.createElement(ShiftManagement, {
        shifts: sampleShifts,
        currentUserRole: superUserRole,
        onRefresh: () => {},
      })
    );
    expect(shiftsHtml).toContain('DAY SHIFT');
    expect(shiftsHtml).toContain('Select All Shifts');

    const sampleFloors: Floor[] = [
      { id: 'f1', name: 'MI-01', code: 'F-MI01', order: 1, status: 'Active' },
    ];
    const floorsHtml = renderToStaticMarkup(
      React.createElement(FloorManagement, {
        floors: sampleFloors,
        currentUserRole: superUserRole,
        onRefresh: () => {},
      })
    );
    expect(floorsHtml).toContain('MI-01');

    const sampleSections: Section[] = [
      { id: 's1', name: 'MI', code: 'SEC-MI', floorId: 'f1', status: 'Active' },
    ];
    const sectionsHtml = renderToStaticMarkup(
      React.createElement(SectionManagement, {
        sections: sampleSections,
        floors: sampleFloors,
        currentUserRole: superUserRole,
        onRefresh: () => {},
      })
    );
    expect(sectionsHtml).toContain('MI');

    const sampleDepts: Department[] = [
      { id: 'd1', name: 'Production', code: 'DEPT-PROD', status: 'Active' },
    ];
    const deptsHtml = renderToStaticMarkup(
      React.createElement(DepartmentManagement, {
        departments: sampleDepts,
        currentUserRole: superUserRole,
        onRefresh: () => {},
      })
    );
    expect(deptsHtml).toContain('Production');

    const usersHtml = renderToStaticMarkup(
      React.createElement(UserRights, {
        currentUserRole: superUserRole,
      })
    );
    expect(usersHtml).toContain('Authorized Personnel Directory');
    expect(usersHtml).toContain('Select all manageable user accounts');
  });
});
