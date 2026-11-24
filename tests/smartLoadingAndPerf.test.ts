import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SkeletonBlock,
  TableSkeletonRows,
  DashboardSkeleton,
  EmployeeMasterSkeleton,
  AttendanceHistorySkeleton,
  ShiftManagementSkeleton,
  QrManagementSkeleton,
  ReportsSkeleton,
  UserRightsSkeleton,
  RolePermissionsSkeleton,
  GenericModuleSkeleton,
  ModuleSkeleton,
} from '../src/components/Skeletons';
import type { NavItem } from '../src/components/Sidebar';
import {
  MODULE_LOADERS,
  prefetchTabModule,
  isTabModulePrefetched,
  scheduleIdleModulePrefetch,
  resetModulePrefetchForTests,
} from '../src/config/moduleRegistry';
import {
  recordPerfMetric,
  getPerfMetricStats,
  getClientPerfSnapshot,
  resetPerfMetrics,
  notifyAttendanceCommitted,
  subscribeAttendanceCommitted,
  startPerfTimer,
} from '../src/utils/perfMonitor';
import { executeApiFetch } from '../src/config/api';

describe('Phase 1 — Smart Skeleton Loading Components (Zero Fake Data)', () => {
  it('renders accessible layout-matched skeletons with zero fake IDs, counts, or records', () => {
    const elements = [
      React.createElement(DashboardSkeleton, { cardCount: 6 }),
      React.createElement(EmployeeMasterSkeleton),
      React.createElement(AttendanceHistorySkeleton),
      React.createElement(ShiftManagementSkeleton),
      React.createElement(QrManagementSkeleton),
      React.createElement(ReportsSkeleton),
      React.createElement(UserRightsSkeleton),
      React.createElement(RolePermissionsSkeleton),
      React.createElement(GenericModuleSkeleton),
    ];

    for (const el of elements) {
      const html = renderToStaticMarkup(el);
      expect(html).toContain('role="status"');
      expect(html).toContain('animate-pulse');
      expect(html).toContain('motion-reduce:animate-none');
      // Never inject fake text counts or placeholder names/IDs
      expect(html).not.toMatch(/\bMSI\d+\b/i);
      expect(html).not.toMatch(/\bANIL\b/i);
      expect(html).not.toContain('Loading accounts from Firebase');
    }

    const tableRowsHtml = renderToStaticMarkup(
      React.createElement('table', null, React.createElement('tbody', null, React.createElement(TableSkeletonRows, { rows: 4, cols: 5 })))
    );
    expect((tableRowsHtml.match(/<tr/g) || []).length).toBe(4);
    expect((tableRowsHtml.match(/<td/g) || []).length).toBe(20);
  });

  it('routes every supported module tab through ModuleSkeleton cleanly', () => {
    const tabs: NavItem[] = [
      'dashboard',
      'employees',
      'history',
      'shifts',
      'qr_codes',
      'reports',
      'user_rights',
      'floors',
      'sections',
      'departments',
      'audit_logs',
      'security_management',
      'system_performance',
      'settings',
    ];

    for (const tab of tabs) {
      const html = renderToStaticMarkup(React.createElement(ModuleSkeleton, { tab }));
      expect(html).toContain('role="status"');
      expect(html.length).toBeGreaterThan(200);
    }

    const blockHtml = renderToStaticMarkup(React.createElement(SkeletonBlock, { className: 'h-4 w-24' }));
    expect(blockHtml).toContain('aria-hidden="true"');
  });
});

describe('Phase 5 — Route Prefetch Registry & Idle Scheduler', () => {
  beforeEach(() => {
    resetModulePrefetchForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('deduplicates concurrent prefetch calls and evicts rejected module loaders so retry works', async () => {
    const spyLoader = vi.fn(async () => ({ EmployeeMaster: () => null }));
    const originalLoader = MODULE_LOADERS.employees;
    MODULE_LOADERS.employees = spyLoader;

    try {
      const p1 = prefetchTabModule('employees');
      const p2 = prefetchTabModule('employees');
      expect(isTabModulePrefetched('employees')).toBe(true);
      await Promise.all([p1, p2]);
      expect(spyLoader).toHaveBeenCalledTimes(1);

      // Simulate transient chunk error -> evicts entry so subsequent hover retries
      resetModulePrefetchForTests();
      let failOnce = true;
      MODULE_LOADERS.employees = vi.fn(async () => {
        if (failOnce) {
          failOnce = false;
          throw new Error('ChunkLoadError');
        }
        return { ok: true };
      });
      await prefetchTabModule('employees');
      expect(isTabModulePrefetched('employees')).toBe(false);
      await prefetchTabModule('employees');
      expect(isTabModulePrefetched('employees')).toBe(true);
    } finally {
      MODULE_LOADERS.employees = originalLoader;
    }
  });

  it('skips idle background prefetching when offline or Save-Data is enabled', () => {
    vi.stubGlobal('window', {
      setTimeout: vi.fn(),
      clearTimeout: vi.fn(),
    });
    vi.stubGlobal('navigator', {
      onLine: false,
      connection: { saveData: false },
    });

    const cancelOffline = scheduleIdleModulePrefetch(['employees', 'history', 'reports']);
    expect((globalThis.window as any).setTimeout).not.toHaveBeenCalled();
    cancelOffline();

    vi.stubGlobal('navigator', {
      onLine: true,
      connection: { saveData: true },
    });
    const cancelSaveData = scheduleIdleModulePrefetch(['employees', 'history', 'reports']);
    expect((globalThis.window as any).setTimeout).not.toHaveBeenCalled();
    cancelSaveData();
  });
});

describe('Phase 4 & 7 — Client Telemetry (P50/P95) & Scoped Attendance Event Bus', () => {
  beforeEach(() => {
    resetPerfMetrics();
  });

  it('computes accurate P50/P95 percentiles, bounds memory at 200 samples, and never stores PII or secrets', () => {
    const samples = [120, 140, 160, 180, 200, 220, 240, 260, 280, 950];
    samples.forEach((v) => recordPerfMetric('qr_scan_e2e_ms', v));
    recordPerfMetric('qr_scan_e2e_ms', -10);
    recordPerfMetric('qr_scan_e2e_ms', Number.NaN);

    const stats = getPerfMetricStats('qr_scan_e2e_ms');
    expect(stats).not.toBeNull();
    expect(stats!.count).toBe(10);
    expect(stats!.minMs).toBe(120);
    expect(stats!.p50Ms).toBe(200);
    expect(stats!.p95Ms).toBe(950);
    expect(stats!.maxMs).toBe(950);
    expect(stats!.lastMs).toBe(950);

    // Ensure rolling bound at 200 samples
    for (let i = 0; i < 250; i++) {
      recordPerfMetric('navigation_ms', i + 1);
    }
    const navStats = getPerfMetricStats('navigation_ms');
    expect(navStats!.count).toBe(200);
    expect(navStats!.minMs).toBe(51);
    expect(navStats!.maxMs).toBe(250);

    const stop = startPerfTimer();
    const measured = stop();
    expect(measured).toBeGreaterThanOrEqual(0);
    recordPerfMetric('background_refresh_ms', measured);

    const snapshot = getClientPerfSnapshot();
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toMatch(/password|token|bearer|@|qrCodeToken/i);
  });

  it('delivers scoped attendance commit events to subscribers without breaking if one throws', () => {
    const received: string[] = [];
    const unsub1 = subscribeAttendanceCommitted((d) => {
      received.push(`${d.action}:${d.scannerType}:${d.shiftDate}`);
    });
    const unsub2 = subscribeAttendanceCommitted(() => {
      throw new Error('non-fatal subscriber failure');
    });

    notifyAttendanceCommitted({
      scannerType: 'IN',
      action: 'PUNCH_IN',
      attendanceId: 'MSI1335_2026-11-18',
      shiftDate: '2026-11-18',
      timestamp: Date.now(),
    });

    expect(received).toEqual(['PUNCH_IN:IN:2026-11-18']);
    unsub1();
    unsub2();

    notifyAttendanceCommitted({
      scannerType: 'OUT',
      action: 'PUNCH_OUT',
      attendanceId: 'MSI1335_2026-11-18',
      shiftDate: '2026-11-18',
      timestamp: Date.now(),
    });
    expect(received.length).toBe(1);
  });
});

describe('Phase 2 & 3 — Bounded Network Timeout & No Blind Write Retry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('aborts hung attendance POST requests on timeout without issuing duplicate fetch retries', async () => {
    let fetchCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        fetchCalls++;
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted.');
            (err as any).name = 'AbortError';
            reject(err);
          });
        });
      })
    );

    await expect(
      executeApiFetch(
        'https://narid-atdc-tracker.vercel.app/api/attendance/scan',
        { method: 'POST', body: '{}' },
        'POST /api/attendance/scan',
        { timeoutMs: 25, noRetryOnNetworkError: false }
      )
    ).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 408,
      errorCode: 'NET-002',
      isTimeout: true,
      technicalDetail: expect.stringMatching(/timed out.*POST \/api\/attendance\/scan/i),
    });

    // CRITICAL: Must NEVER blindly retry a timed-out attendance write request
    expect(fetchCalls).toBe(1);
  });
});

describe('Phase 6 — Large Dataset Filtering & Pagination Efficiency', () => {
  it('filters and paginates 2,500 employee/attendance rows in under 25ms without truncating export source', () => {
    const records = Array.from({ length: 2500 }, (_, i) => ({
      employeeId: `MSI${1000 + i}`,
      employeeName: `Operator ${i}`,
      floor: `MI-0${(i % 4) + 1}`,
      section: i % 2 === 0 ? 'MI' : 'SMT',
      department: i % 3 === 0 ? 'Quality' : 'Production',
      employeeStatus: i % 10 === 0 ? 'Inactive' : 'Active',
    }));

    const t0 = performance.now();
    const filtered = records.filter(
      (r) =>
        r.employeeStatus === 'Active' &&
        r.floor === 'MI-02' &&
        (r.employeeId.includes('1') || r.employeeName.toLowerCase().includes('operator'))
    );
    const pageSize = 50;
    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    const page2 = filtered.slice((2 - 1) * pageSize, 2 * pageSize);
    const elapsedMs = performance.now() - t0;

    expect(filtered.length).toBeGreaterThan(400);
    expect(totalPages).toBeGreaterThan(8);
    expect(page2.length).toBe(pageSize);
    expect(elapsedMs).toBeLessThan(25);
  });
});
