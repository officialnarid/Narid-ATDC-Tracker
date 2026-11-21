import type { NavItem } from '../components/Sidebar';
import { recordPerfMetric, startPerfTimer, TAB_TO_MODULE_NAME } from '../utils/perfMonitor';

type DynamicModuleLoader = () => Promise<unknown>;

const prefetchedModules = new Map<string, Promise<unknown>>();

export const MODULE_LOADERS: Partial<Record<NavItem, DynamicModuleLoader>> = {
  employees: () => import('../components/EmployeeMaster'),
  excel_import: () => import('../components/ExcelImport'),
  qr_codes: () => import('../components/QrManagement'),
  floors: () => import('../components/FloorManagement'),
  sections: () => import('../components/SectionManagement'),
  departments: () => import('../components/DepartmentManagement'),
  shifts: () => import('../components/ShiftManagement'),
  history: () => import('../components/AttendanceHistory'),
  reports: () => import('../components/Reports'),
  user_rights: () => import('../components/UserRights'),
  audit_logs: () => import('../components/AuditLogsManagement'),
  security_management: () => import('../components/SecurityManagement'),
  company_wifi_access: () => import('../components/CompanyWifiAccessControl'),
  system_performance: () => import('../components/SystemPerformance'),
};

export function prefetchTabModule(tab: NavItem): Promise<unknown> | null {
  const loader = MODULE_LOADERS[tab];
  if (!loader) return null;
  const existing = prefetchedModules.get(tab);
  if (existing) return existing;

  const stopTimer = startPerfTimer();
  const promise = loader()
    .then((mod) => {
      recordPerfMetric('route_prefetch_ms', stopTimer(), TAB_TO_MODULE_NAME[tab] || tab);
      return mod;
    })
    .catch(() => {
      // Remove failed entry so subsequent hover or click can retry cleanly
      prefetchedModules.delete(tab);
      return undefined;
    });
  prefetchedModules.set(tab, promise);
  return promise;
}

export function isTabModulePrefetched(tab: NavItem): boolean {
  return prefetchedModules.has(tab);
}

export function scheduleIdleModulePrefetch(allowedTabs: NavItem[]): () => void {
  if (typeof window === 'undefined') return () => {};
  const nav = typeof navigator !== 'undefined' ? (navigator as any) : null;
  if (nav?.onLine === false || nav?.connection?.saveData === true) {
    return () => {};
  }

  const priorityTabs: NavItem[] = ['employees', 'history', 'reports'].filter((t): t is NavItem =>
    allowedTabs.includes(t as NavItem)
  );
  if (priorityTabs.length === 0) return () => {};

  let cancelled = false;
  let timerId: number | null = null;
  let idleId: number | null = null;

  const runPrefetch = () => {
    if (cancelled) return;
    priorityTabs.forEach((tab, idx) => {
      window.setTimeout(() => {
        if (!cancelled) {
          prefetchTabModule(tab);
        }
      }, idx * 180);
    });
  };

  if (typeof (window as any).requestIdleCallback === 'function') {
    idleId = (window as any).requestIdleCallback(runPrefetch, { timeout: 3000 });
  } else {
    timerId = window.setTimeout(runPrefetch, 2000);
  }

  return () => {
    cancelled = true;
    if (idleId !== null && typeof (window as any).cancelIdleCallback === 'function') {
      (window as any).cancelIdleCallback(idleId);
    }
    if (timerId !== null) {
      window.clearTimeout(timerId);
    }
  };
}

export function resetModulePrefetchForTests(): void {
  prefetchedModules.clear();
}
