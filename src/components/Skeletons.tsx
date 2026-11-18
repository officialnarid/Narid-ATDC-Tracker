import React from 'react';
import type { NavItem } from './Sidebar';

interface SkeletonBlockProps {
  className?: string;
}

export const SkeletonBlock: React.FC<SkeletonBlockProps> = ({ className = '' }) => (
  <div
    aria-hidden="true"
    className={`bg-slate-200/85 rounded animate-pulse motion-reduce:animate-none ${className}`}
  />
);

export const TableSkeletonRows: React.FC<{
  rows?: number;
  cols?: number;
  rowHeightClass?: string;
}> = ({ rows = 6, cols = 8, rowHeightClass = 'py-3 px-3.5' }) => (
  <>
    {Array.from({ length: rows }).map((_, rIdx) => (
      <tr key={rIdx} aria-hidden="true" className="bg-white">
        {Array.from({ length: cols }).map((__, cIdx) => (
          <td key={cIdx} className={rowHeightClass}>
            <SkeletonBlock
              className={`h-3.5 ${
                cIdx === 0
                  ? 'w-20'
                  : cIdx === cols - 1
                    ? 'w-14 ml-auto'
                    : cIdx % 2 === 0
                      ? 'w-28'
                      : 'w-24'
              }`}
            />
          </td>
        ))}
      </tr>
    ))}
  </>
);

export const DashboardSkeleton: React.FC<{ cardCount?: number }> = ({ cardCount = 6 }) => {
  const safeCount = Math.max(1, Math.min(12, cardCount));
  const gridClass =
    safeCount === 1
      ? 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3'
      : safeCount === 2
        ? 'grid grid-cols-1 sm:grid-cols-2 gap-3'
        : safeCount <= 4
          ? 'grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3'
          : 'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3';

  return (
    <div
      role="status"
      aria-label="Loading dashboard metrics"
      className="p-4 sm:p-6 bg-slate-50 min-h-full flex flex-col gap-6 w-full"
    >
      {/* Top Toolbar Skeleton */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-2">
          <SkeletonBlock className="h-6 w-56" />
          <SkeletonBlock className="h-3.5 w-72" />
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <SkeletonBlock className="h-8 w-32" />
          <SkeletonBlock className="h-8 w-24" />
          <SkeletonBlock className="h-8 w-24" />
          <SkeletonBlock className="h-8 w-28" />
          <SkeletonBlock className="h-8 w-8" />
        </div>
      </div>

      {/* Shift Banner Skeleton */}
      <div className="bg-white border border-slate-200 rounded-lg p-3 flex items-center justify-between gap-3 shadow-2xs">
        <SkeletonBlock className="h-4 w-3/5" />
        <SkeletonBlock className="h-7 w-28" />
      </div>

      {/* KPI Card Grid Skeleton (Zero fake counts or values) */}
      <div className={gridClass}>
        {Array.from({ length: safeCount }).map((_, idx) => (
          <div
            key={idx}
            className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-2xs space-y-2.5"
          >
            <SkeletonBlock className="h-3 w-20" />
            <SkeletonBlock className="h-7 w-14" />
            <SkeletonBlock className="h-2.5 w-16" />
          </div>
        ))}
      </div>

      {/* Breakdown Tables Grid Skeleton */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {Array.from({ length: 4 }).map((_, cardIdx) => (
          <div key={cardIdx} className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs space-y-3">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <SkeletonBlock className="h-4 w-48" />
              <SkeletonBlock className="h-3 w-28" />
            </div>
            <div className="space-y-2.5 pt-1">
              {Array.from({ length: 4 }).map((__, rIdx) => (
                <div key={rIdx} className="grid grid-cols-5 gap-3 py-1.5">
                  <SkeletonBlock className="h-3.5 w-20" />
                  <SkeletonBlock className="h-3.5 w-10 mx-auto" />
                  <SkeletonBlock className="h-3.5 w-10 mx-auto" />
                  <SkeletonBlock className="h-3.5 w-10 mx-auto" />
                  <SkeletonBlock className="h-3.5 w-12 ml-auto" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export const EmployeeMasterSkeleton: React.FC = () => (
  <div
    role="status"
    aria-label="Loading employee directory"
    className="p-6 bg-slate-50 min-h-full flex flex-col gap-6"
  >
    <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs flex flex-col md:flex-row md:items-center justify-between gap-4">
      <div className="space-y-2">
        <SkeletonBlock className="h-6 w-48" />
        <SkeletonBlock className="h-3.5 w-40" />
      </div>
      <SkeletonBlock className="h-9 w-36" />
    </div>
    <div className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-2xs flex flex-wrap items-center gap-3">
      <SkeletonBlock className="h-8 flex-1 min-w-[220px]" />
      <SkeletonBlock className="h-8 w-28" />
      <SkeletonBlock className="h-8 w-28" />
      <SkeletonBlock className="h-8 w-32" />
      <SkeletonBlock className="h-8 w-24" />
    </div>
    <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
      <table className="w-full text-left text-xs">
        <thead className="bg-slate-50 border-b border-slate-200">
          <tr>
            {Array.from({ length: 9 }).map((_, idx) => (
              <th key={idx} className="py-3 px-3.5">
                <SkeletonBlock className="h-3 w-16" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          <TableSkeletonRows rows={8} cols={9} />
        </tbody>
      </table>
    </div>
  </div>
);

export const AttendanceHistorySkeleton: React.FC = () => (
  <div
    role="status"
    aria-label="Loading attendance history"
    className="p-6 bg-slate-50 min-h-full flex flex-col gap-6"
  >
    <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs flex flex-col md:flex-row md:items-center justify-between gap-4">
      <div className="space-y-2">
        <SkeletonBlock className="h-6 w-52" />
        <SkeletonBlock className="h-3.5 w-80" />
      </div>
      <SkeletonBlock className="h-9 w-36" />
    </div>
    <div className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-2xs flex flex-wrap items-center gap-3">
      <SkeletonBlock className="h-8 w-64" />
      <SkeletonBlock className="h-8 w-48" />
      <SkeletonBlock className="h-8 w-28" />
      <SkeletonBlock className="h-8 w-32" />
      <SkeletonBlock className="h-8 w-32" />
    </div>
    <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
      <table className="w-full text-left text-xs">
        <thead className="bg-slate-50 border-b border-slate-200">
          <tr>
            {Array.from({ length: 12 }).map((_, idx) => (
              <th key={idx} className="py-3 px-3.5">
                <SkeletonBlock className="h-3 w-14" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          <TableSkeletonRows rows={8} cols={12} />
        </tbody>
      </table>
    </div>
  </div>
);

export const ShiftManagementSkeleton: React.FC = () => (
  <div
    role="status"
    aria-label="Loading shift configuration"
    className="p-6 bg-slate-50 min-h-full flex flex-col gap-6"
  >
    <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs flex flex-col sm:flex-row sm:items-center justify-between gap-4">
      <div className="space-y-2">
        <SkeletonBlock className="h-6 w-48" />
        <SkeletonBlock className="h-3.5 w-72" />
      </div>
      <SkeletonBlock className="h-9 w-36" />
    </div>
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      {Array.from({ length: 2 }).map((_, idx) => (
        <div key={idx} className="bg-white rounded-xl border border-slate-200 p-5 shadow-2xs space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-slate-100">
            <SkeletonBlock className="h-5 w-36" />
            <SkeletonBlock className="h-5 w-24" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <SkeletonBlock className="h-9 w-full" />
            <SkeletonBlock className="h-9 w-full" />
            <SkeletonBlock className="h-9 w-full" />
            <SkeletonBlock className="h-9 w-full" />
          </div>
          <div className="flex items-center justify-between pt-3 border-t border-slate-100">
            <SkeletonBlock className="h-7 w-20" />
            <SkeletonBlock className="h-7 w-32" />
          </div>
        </div>
      ))}
    </div>
  </div>
);

export const QrManagementSkeleton: React.FC = () => (
  <div
    role="status"
    aria-label="Loading QR management"
    className="p-6 bg-slate-50 min-h-full flex flex-col gap-6"
  >
    <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs flex flex-col md:flex-row md:items-center justify-between gap-4">
      <div className="space-y-2">
        <SkeletonBlock className="h-6 w-52" />
        <SkeletonBlock className="h-3.5 w-72" />
      </div>
      <SkeletonBlock className="h-9 w-44" />
    </div>
    <div className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-2xs flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <SkeletonBlock className="h-8 w-60" />
        <SkeletonBlock className="h-8 w-28" />
        <SkeletonBlock className="h-8 w-32" />
      </div>
      <SkeletonBlock className="h-8 w-32" />
    </div>
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
      {Array.from({ length: 8 }).map((_, idx) => (
        <div key={idx} className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs flex flex-col items-center gap-3">
          <div className="w-full flex items-center justify-between">
            <SkeletonBlock className="h-4 w-4" />
            <SkeletonBlock className="h-4 w-16" />
          </div>
          <SkeletonBlock className="w-36 h-36 rounded-lg" />
          <SkeletonBlock className="h-4 w-24" />
          <SkeletonBlock className="h-4 w-32" />
          <SkeletonBlock className="h-3 w-40" />
        </div>
      ))}
    </div>
  </div>
);

export const ReportsSkeleton: React.FC = () => (
  <div
    role="status"
    aria-label="Loading reports"
    className="p-6 bg-slate-50 min-h-full flex flex-col gap-6"
  >
    <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs flex flex-col md:flex-row md:items-center justify-between gap-4">
      <div className="space-y-2">
        <SkeletonBlock className="h-6 w-64" />
        <SkeletonBlock className="h-3.5 w-72" />
      </div>
      <div className="flex items-center gap-2">
        <SkeletonBlock className="h-9 w-32" />
        <SkeletonBlock className="h-9 w-36" />
      </div>
    </div>
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      <div className="lg:col-span-4 bg-white rounded-xl border border-slate-200 p-3 shadow-2xs space-y-2">
        {Array.from({ length: 8 }).map((_, idx) => (
          <SkeletonBlock key={idx} className="h-12 w-full rounded" />
        ))}
      </div>
      <div className="lg:col-span-8 flex flex-col gap-4">
        <div className="bg-white p-3 rounded-xl border border-slate-200 shadow-2xs flex items-center justify-between">
          <SkeletonBlock className="h-8 w-44" />
          <SkeletonBlock className="h-4 w-28" />
        </div>
        <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                {Array.from({ length: 6 }).map((_, idx) => (
                  <th key={idx} className="py-2.5 px-3">
                    <SkeletonBlock className="h-3 w-20" />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              <TableSkeletonRows rows={8} cols={6} rowHeightClass="py-2.5 px-3" />
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
);

export const UserRightsSkeleton: React.FC = () => (
  <div
    role="status"
    aria-label="Loading role and user permissions"
    className="p-6 bg-slate-50 min-h-full flex flex-col gap-6"
  >
    <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs flex flex-col md:flex-row md:items-center justify-between gap-4">
      <div className="space-y-2">
        <SkeletonBlock className="h-6 w-64" />
        <SkeletonBlock className="h-3.5 w-80" />
      </div>
      <div className="flex items-center gap-2">
        <SkeletonBlock className="h-9 w-32" />
        <SkeletonBlock className="h-9 w-40" />
      </div>
    </div>
    <div className="bg-white p-2 rounded-xl border border-slate-200 shadow-2xs flex flex-wrap gap-2">
      {Array.from({ length: 5 }).map((_, idx) => (
        <SkeletonBlock key={idx} className="h-9 w-36 rounded-lg" />
      ))}
    </div>
    <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
      <table className="w-full text-left text-xs">
        <thead className="bg-slate-50 border-b border-slate-200">
          <tr>
            {Array.from({ length: 7 }).map((_, idx) => (
              <th key={idx} className="py-3 px-4">
                <SkeletonBlock className="h-3 w-20" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          <TableSkeletonRows rows={6} cols={7} rowHeightClass="py-3 px-4" />
        </tbody>
      </table>
    </div>
  </div>
);

export const RolePermissionsSkeleton: React.FC = () => (
  <div role="status" aria-label="Loading permission matrix" className="space-y-4">
    <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <SkeletonBlock className="h-9 w-32 rounded-xl" />
        <SkeletonBlock className="h-9 w-28 rounded-xl" />
        <SkeletonBlock className="h-9 w-28 rounded-xl" />
      </div>
      <div className="flex items-center gap-2">
        <SkeletonBlock className="h-8 w-24 rounded-lg" />
        <SkeletonBlock className="h-8 w-28 rounded-lg" />
        <SkeletonBlock className="h-8 w-32 rounded-lg" />
      </div>
    </div>
    <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
      <table className="w-full text-left text-xs">
        <thead className="bg-slate-50 border-b border-slate-200">
          <tr>
            {Array.from({ length: 5 }).map((_, idx) => (
              <th key={idx} className="py-3 px-4">
                <SkeletonBlock className="h-3 w-20" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          <TableSkeletonRows rows={8} cols={5} rowHeightClass="py-3 px-4" />
        </tbody>
      </table>
    </div>
  </div>
);

export const SystemPerformanceSkeleton: React.FC = () => (
  <div
    role="status"
    aria-label="Loading system performance monitoring center"
    className="p-6 bg-slate-50 min-h-full flex flex-col gap-6"
  >
    <div className="bg-white p-4 rounded-xl border border-slate-200 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
      <div className="space-y-2">
        <SkeletonBlock className="h-6 w-72" />
        <SkeletonBlock className="h-3.5 w-96" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SkeletonBlock className="h-8 w-44" />
        <SkeletonBlock className="h-8 w-28" />
        <SkeletonBlock className="h-8 w-24" />
      </div>
    </div>
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
      {Array.from({ length: 6 }).map((_, idx) => (
        <div key={idx} className="bg-white p-4 rounded-xl border border-slate-200 space-y-2">
          <SkeletonBlock className="h-3 w-24" />
          <SkeletonBlock className="h-7 w-16" />
          <SkeletonBlock className="h-2.5 w-20" />
        </div>
      ))}
    </div>
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="bg-white p-4 rounded-xl border border-slate-200 space-y-3">
        <SkeletonBlock className="h-4 w-48" />
        <SkeletonBlock className="h-44 w-full" />
      </div>
      <div className="bg-white p-4 rounded-xl border border-slate-200 space-y-3">
        <SkeletonBlock className="h-4 w-48" />
        <SkeletonBlock className="h-44 w-full" />
      </div>
    </div>
  </div>
);

export const GenericModuleSkeleton: React.FC = () => (
  <div role="status" aria-label="Loading module" className="p-6 bg-slate-50 min-h-full flex flex-col gap-6">
    <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs flex items-center justify-between gap-4">
      <div className="space-y-2">
        <SkeletonBlock className="h-6 w-52" />
        <SkeletonBlock className="h-3.5 w-72" />
      </div>
      <SkeletonBlock className="h-9 w-36" />
    </div>
    <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
      <table className="w-full text-left text-xs">
        <thead className="bg-slate-50 border-b border-slate-200">
          <tr>
            {Array.from({ length: 5 }).map((_, idx) => (
              <th key={idx} className="py-3 px-4">
                <SkeletonBlock className="h-3 w-20" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          <TableSkeletonRows rows={6} cols={5} rowHeightClass="py-3 px-4" />
        </tbody>
      </table>
    </div>
  </div>
);

export const ModuleSkeleton: React.FC<{ tab: NavItem }> = ({ tab }) => {
  switch (tab) {
    case 'dashboard':
      return <DashboardSkeleton />;
    case 'employees':
      return <EmployeeMasterSkeleton />;
    case 'history':
      return <AttendanceHistorySkeleton />;
    case 'shifts':
      return <ShiftManagementSkeleton />;
    case 'qr_codes':
      return <QrManagementSkeleton />;
    case 'reports':
      return <ReportsSkeleton />;
    case 'user_rights':
      return <UserRightsSkeleton />;
    case 'system_performance':
      return <SystemPerformanceSkeleton />;
    default:
      return <GenericModuleSkeleton />;
  }
};
