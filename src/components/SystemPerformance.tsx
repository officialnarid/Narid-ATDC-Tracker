import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Activity,
  Server,
  Database,
  ShieldAlert,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  RefreshCw,
  QrCode,
  Layers,
  Users,
  Search,
  SlidersHorizontal,
  Play,
  Info,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  Wifi,
  WifiOff,
  Gauge,
  ArrowDownToLine,
  ArrowUpFromLine,
  Globe,
  Laptop,
} from 'lucide-react';
import {
  fetchMonitoringOverview,
  flushQueuedClientTelemetry,
  HealthStatus,
  LatencyStatsSummary,
  MonitoringAlertItem,
  MonitoringOverviewResponse,
  MonitoringThresholds,
  MonitoringTimeRange,
  NetworkHistoryBucket,
  performMonitoringAlertAction,
  runMonitoringHealthProbe,
  TimeSeriesBucket,
  updateMonitoringThresholds,
} from '../services/monitoringService';
import {
  runControlledSpeedTest,
  runSingleNetworkProbe,
} from '../services/networkMonitorService';
import { SystemPerformanceSkeleton } from './Skeletons';

type MonitoringSubTab =
  | 'overview'
  | 'network'
  | 'performance'
  | 'api'
  | 'database'
  | 'activity'
  | 'modules'
  | 'errors'
  | 'alerts';

interface SystemPerformanceProps {
  initialData?: MonitoringOverviewResponse | null;
}

const SUB_TABS: Array<{ id: MonitoringSubTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'network', label: 'Internet & Network' },
  { id: 'performance', label: 'Performance Analytics' },
  { id: 'api', label: 'API Monitoring' },
  { id: 'database', label: 'Database Monitoring' },
  { id: 'activity', label: 'User Activity' },
  { id: 'modules', label: 'Module Health' },
  { id: 'errors', label: 'Error & Failure Logs' },
  { id: 'alerts', label: 'Alerts & Notifications' },
];

const TIME_RANGES: Array<{ id: MonitoringTimeRange; label: string }> = [
  { id: '15m', label: '15m' },
  { id: '1h', label: '1h' },
  { id: '24h', label: '24h' },
  { id: '7d', label: '7d' },
  { id: '30d', label: '30d' },
  { id: 'custom', label: 'Custom' },
];

function fmtMs(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${Math.round(value * 10) / 10} ms`;
}

function fmtPct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${Math.round(value * 10) / 10}%`;
}

function fmtCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'Not Available';
  return String(value);
}

function fmtTs(iso: string | null | undefined): string {
  if (!iso) return 'Not Available';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Not Available';
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function getStatusBadgeClasses(status: HealthStatus | string): string {
  switch (status) {
    case 'Healthy':
    case 'Connected':
    case 'Active':
    case 'RESOLVED':
    case 'EXCELLENT':
    case 'GOOD':
    case 'All Systems Nominal':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    case 'Warning':
    case 'Degraded':
    case 'ACKNOWLEDGED':
    case 'WARNING':
    case 'FAIR':
      return 'bg-amber-50 text-amber-800 border-amber-200';
    case 'Critical':
    case 'CRITICAL':
    case 'POOR':
    case 'Error':
    case 'Unavailable':
    case 'ACTIVE':
    case 'User Internet Problem':
    case 'Backend Server Problem':
    case 'Firebase / Database Problem':
    case 'Frontend Problem':
      return 'bg-red-50 text-red-700 border-red-200';
    default:
      return 'bg-slate-100 text-slate-600 border-slate-200';
  }
}

const StatusBadge: React.FC<{ status: string }> = ({ status }) => (
  <span
    className={`inline-flex items-center px-2 py-0.5 rounded border text-[11px] font-semibold tracking-tight ${getStatusBadgeClasses(
      status
    )}`}
  >
    {status}
  </span>
);

const KpiCard: React.FC<{
  label: string;
  value: string;
  subtext?: string;
  tone?: 'default' | 'good' | 'warn' | 'bad' | 'muted';
}> = ({ label, value, subtext, tone = 'default' }) => {
  const toneClass =
    tone === 'good'
      ? 'text-emerald-700'
      : tone === 'warn'
        ? 'text-amber-700'
        : tone === 'bad'
          ? 'text-red-700'
          : tone === 'muted'
            ? 'text-slate-500'
            : 'text-slate-900';
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-3.5 flex flex-col justify-between">
      <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wider truncate">
        {label}
      </div>
      <div className={`text-xl font-bold font-mono tabular-nums mt-1 ${toneClass}`}>{value}</div>
      {subtext && <div className="text-[11px] text-slate-500 mt-1 truncate">{subtext}</div>}
    </div>
  );
};

const LatencyTrendSvgChart: React.FC<{ buckets: TimeSeriesBucket[] }> = ({ buckets }) => {
  const width = 640;
  const height = 190;
  const padL = 42;
  const padR = 14;
  const padT = 16;
  const padB = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const numericVals = buckets.flatMap((b) =>
    [b.apiAvgMs, b.qrAvgMs, b.dbAvgMs].filter((v): v is number => typeof v === 'number' && v >= 0)
  );
  const maxVal = numericVals.length > 0 ? Math.max(100, ...numericVals) : 0;

  if (buckets.length === 0 || numericVals.length === 0) {
    return (
      <div className="h-[190px] flex flex-col items-center justify-center text-xs text-slate-500 border border-dashed border-slate-200 rounded-lg bg-slate-50/50">
        <span>No measured latency samples in selected window.</span>
        <span className="text-[11px] text-slate-400 mt-0.5">Status: Unknown / Not Instrumented</span>
      </div>
    );
  }

  const buildPolyline = (getter: (b: TimeSeriesBucket) => number | null): string => {
    const pts: string[] = [];
    buckets.forEach((b, i) => {
      const val = getter(b);
      if (val === null || !Number.isFinite(val)) return;
      const x = padL + (buckets.length <= 1 ? plotW / 2 : (i / (buckets.length - 1)) * plotW);
      const y = padT + plotH - (Math.min(val, maxVal) / maxVal) * plotH;
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    });
    return pts.join(' ');
  };

  const apiPoints = buildPolyline((b) => b.apiAvgMs);
  const qrPoints = buildPolyline((b) => b.qrAvgMs);
  const dbPoints = buildPolyline((b) => b.dbAvgMs);

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-[190px] select-none">
        {[0, 0.5, 1].map((ratio) => {
          const y = padT + plotH * (1 - ratio);
          const tickVal = Math.round(maxVal * ratio);
          return (
            <g key={ratio}>
              <line x1={padL} y1={y} x2={width - padR} y2={y} stroke="#e2e8f0" strokeWidth="1" />
              <text
                x={padL - 6}
                y={y + 3}
                textAnchor="end"
                fontSize="10"
                fill="#64748b"
                fontFamily="monospace"
              >
                {tickVal}
              </text>
            </g>
          );
        })}

        {apiPoints && (
          <polyline
            fill="none"
            stroke="#2563eb"
            strokeWidth="2"
            strokeLinejoin="round"
            points={apiPoints}
          />
        )}
        {qrPoints && (
          <polyline
            fill="none"
            stroke="#059669"
            strokeWidth="2"
            strokeLinejoin="round"
            points={qrPoints}
          />
        )}
        {dbPoints && (
          <polyline
            fill="none"
            stroke="#d97706"
            strokeWidth="1.75"
            strokeDasharray="4 3"
            strokeLinejoin="round"
            points={dbPoints}
          />
        )}

        {buckets.map((b, i) => {
          const step = Math.max(1, Math.ceil(buckets.length / 6));
          if (i % step !== 0 && i !== buckets.length - 1) return null;
          const x = padL + (buckets.length <= 1 ? plotW / 2 : (i / (buckets.length - 1)) * plotW);
          return (
            <text
              key={`${b.bucketStartIso}_${i}`}
              x={x}
              y={height - 8}
              textAnchor="middle"
              fontSize="10"
              fill="#64748b"
              fontFamily="monospace"
            >
              {b.label}
            </text>
          );
        })}
      </svg>
      <div className="flex flex-wrap items-center gap-4 px-2 pt-1 text-[11px] text-slate-600">
        <span className="inline-flex items-center gap-1.5">
          <span className="w-3 h-0.5 bg-blue-600 inline-block" /> API Avg (ms)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-3 h-0.5 bg-emerald-600 inline-block" /> QR Punch Avg (ms)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-3 h-0.5 bg-amber-600 inline-block" /> Firestore Avg (ms)
        </span>
      </div>
    </div>
  );
};

const VolumeAndErrorSvgChart: React.FC<{ buckets: TimeSeriesBucket[] }> = ({ buckets }) => {
  const width = 640;
  const height = 190;
  const padL = 40;
  const padR = 14;
  const padT = 16;
  const padB = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const maxCalls = Math.max(1, ...buckets.map((b) => b.apiCalls + b.errorCount));
  const totalActivity = buckets.reduce((acc, b) => acc + b.apiCalls + b.errorCount + b.qrPunches, 0);

  if (buckets.length === 0 || totalActivity === 0) {
    return (
      <div className="h-[190px] flex flex-col items-center justify-center text-xs text-slate-500 border border-dashed border-slate-200 rounded-lg bg-slate-50/50">
        <span>No API request or error events recorded in selected window.</span>
        <span className="text-[11px] text-slate-400 mt-0.5">Waiting for measured traffic</span>
      </div>
    );
  }

  const slotW = plotW / Math.max(1, buckets.length);
  const barW = Math.max(6, Math.min(26, slotW * 0.62));

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-[190px] select-none">
        {[0, 0.5, 1].map((ratio) => {
          const y = padT + plotH * (1 - ratio);
          return (
            <g key={ratio}>
              <line x1={padL} y1={y} x2={width - padR} y2={y} stroke="#e2e8f0" strokeWidth="1" />
              <text
                x={padL - 6}
                y={y + 3}
                textAnchor="end"
                fontSize="10"
                fill="#64748b"
                fontFamily="monospace"
              >
                {Math.round(maxCalls * ratio)}
              </text>
            </g>
          );
        })}

        {buckets.map((b, i) => {
          const x = padL + i * slotW + (slotW - barW) / 2;
          const callH = (b.apiCalls / maxCalls) * plotH;
          const errH = (b.errorCount / maxCalls) * plotH;
          return (
            <g key={`${b.bucketStartIso}_${i}`}>
              {callH > 0 && (
                <rect
                  x={x}
                  y={padT + plotH - callH}
                  width={barW}
                  height={Math.max(2, callH)}
                  fill="#93c5fd"
                  rx="2"
                />
              )}
              {errH > 0 && (
                <rect
                  x={x}
                  y={padT + plotH - errH}
                  width={barW}
                  height={Math.max(3, errH)}
                  fill="#dc2626"
                  rx="2"
                />
              )}
            </g>
          );
        })}

        {buckets.map((b, i) => {
          const step = Math.max(1, Math.ceil(buckets.length / 6));
          if (i % step !== 0 && i !== buckets.length - 1) return null;
          const x = padL + i * slotW + slotW / 2;
          return (
            <text
              key={`${b.bucketStartIso}_lbl_${i}`}
              x={x}
              y={height - 8}
              textAnchor="middle"
              fontSize="10"
              fill="#64748b"
              fontFamily="monospace"
            >
              {b.label}
            </text>
          );
        })}
      </svg>
      <div className="flex flex-wrap items-center gap-4 px-2 pt-1 text-[11px] text-slate-600">
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 bg-blue-300 rounded-xs inline-block" /> API Requests
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 bg-red-600 rounded-xs inline-block" /> Errors &amp; Failures
        </span>
      </div>
    </div>
  );
};

const NetworkRttAndApiChart: React.FC<{ buckets: NetworkHistoryBucket[] }> = ({ buckets }) => {
  const width = 640;
  const height = 190;
  const padL = 44;
  const padR = 14;
  const padT = 16;
  const padB = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const vals = buckets.flatMap((b) => [b.rttAvgMs ?? 0, b.apiAvgMs ?? 0]);
  const hasData = buckets.some((b) => b.rttAvgMs !== null || b.apiAvgMs !== null);
  const maxVal = Math.max(100, ...vals);

  const buildPath = (getter: (b: NetworkHistoryBucket) => number | null) => {
    const pts: string[] = [];
    buckets.forEach((b, idx) => {
      const v = getter(b);
      if (v === null) return;
      const x = padL + (buckets.length <= 1 ? plotW / 2 : (idx / (buckets.length - 1)) * plotW);
      const y = padT + plotH - Math.min(1, v / maxVal) * plotH;
      pts.push(`${pts.length === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`);
    });
    return pts.join(' ');
  };

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-44 select-none">
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const y = padT + plotH - t * plotH;
          return (
            <g key={t}>
              <line x1={padL} y1={y} x2={width - padR} y2={y} stroke="#e2e8f0" strokeWidth="1" />
              <text
                x={padL - 6}
                y={y + 3}
                textAnchor="end"
                fontSize="10"
                fill="#64748b"
                fontFamily="monospace"
              >
                {Math.round(maxVal * t)}
              </text>
            </g>
          );
        })}

        {!hasData ? (
          <text
            x={width / 2}
            y={height / 2}
            textAnchor="middle"
            fontSize="12"
            fill="#64748b"
          >
            Waiting for HTTP RTT probe samples in selected window
          </text>
        ) : (
          <>
            <path d={buildPath((b) => b.rttAvgMs)} fill="none" stroke="#059669" strokeWidth="2.2" />
            <path d={buildPath((b) => b.apiAvgMs)} fill="none" stroke="#d97706" strokeWidth="2" />
          </>
        )}

        {buckets.map((b, i) => {
          const step = Math.max(1, Math.ceil(buckets.length / 6));
          if (i % step !== 0 && i !== buckets.length - 1) return null;
          const x = padL + (buckets.length <= 1 ? plotW / 2 : (i / (buckets.length - 1)) * plotW);
          return (
            <text
              key={`${b.bucketStartIso}_net_lbl_${i}`}
              x={x}
              y={height - 8}
              textAnchor="middle"
              fontSize="10"
              fill="#64748b"
              fontFamily="monospace"
            >
              {b.label}
            </text>
          );
        })}
      </svg>
      <div className="flex flex-wrap items-center gap-4 px-2 pt-1 text-[11px] text-slate-600">
        <span className="inline-flex items-center gap-1.5">
          <span className="w-3 h-0.5 bg-emerald-600 inline-block" /> Application Network RTT (ms)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-3 h-0.5 bg-amber-600 inline-block" /> Backend API Avg (ms)
        </span>
      </div>
    </div>
  );
};

const NetworkStabilityAndSpeedChart: React.FC<{ buckets: NetworkHistoryBucket[] }> = ({ buckets }) => {
  const width = 640;
  const height = 190;
  const padL = 44;
  const padR = 14;
  const padT = 16;
  const padB = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const vals = buckets.flatMap((b) => [b.jitterMs ?? 0, b.downloadMbps ?? 0, b.uploadMbps ?? 0]);
  const hasData = buckets.some(
    (b) => b.jitterMs !== null || b.downloadMbps !== null || b.uploadMbps !== null || b.disconnections > 0
  );
  const maxVal = Math.max(25, ...vals);

  const buildPath = (getter: (b: NetworkHistoryBucket) => number | null) => {
    const pts: string[] = [];
    buckets.forEach((b, idx) => {
      const v = getter(b);
      if (v === null) return;
      const x = padL + (buckets.length <= 1 ? plotW / 2 : (idx / (buckets.length - 1)) * plotW);
      const y = padT + plotH - Math.min(1, v / maxVal) * plotH;
      pts.push(`${pts.length === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`);
    });
    return pts.join(' ');
  };

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-44 select-none">
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const y = padT + plotH - t * plotH;
          return (
            <g key={t}>
              <line x1={padL} y1={y} x2={width - padR} y2={y} stroke="#e2e8f0" strokeWidth="1" />
              <text
                x={padL - 6}
                y={y + 3}
                textAnchor="end"
                fontSize="10"
                fill="#64748b"
                fontFamily="monospace"
              >
                {Math.round(maxVal * t)}
              </text>
            </g>
          );
        })}

        {!hasData ? (
          <text
            x={width / 2}
            y={height / 2}
            textAnchor="middle"
            fontSize="12"
            fill="#64748b"
          >
            Waiting for jitter (&gt;=3 probes) or speed test history
          </text>
        ) : (
          <>
            <path d={buildPath((b) => b.jitterMs)} fill="none" stroke="#dc2626" strokeWidth="2" />
            <path d={buildPath((b) => b.downloadMbps)} fill="none" stroke="#2563eb" strokeWidth="2" />
            <path d={buildPath((b) => b.uploadMbps)} fill="none" stroke="#7c3aed" strokeWidth="2" />
            {buckets.map((b, idx) => {
              if (b.disconnections <= 0) return null;
              const x = padL + (buckets.length <= 1 ? plotW / 2 : (idx / (buckets.length - 1)) * plotW);
              return (
                <circle
                  key={`${b.bucketStartIso}_disc_${idx}`}
                  cx={x}
                  cy={padT + 8}
                  r={4}
                  fill="#b91c1c"
                />
              );
            })}
          </>
        )}

        {buckets.map((b, i) => {
          const step = Math.max(1, Math.ceil(buckets.length / 6));
          if (i % step !== 0 && i !== buckets.length - 1) return null;
          const x = padL + (buckets.length <= 1 ? plotW / 2 : (i / (buckets.length - 1)) * plotW);
          return (
            <text
              key={`${b.bucketStartIso}_spd_lbl_${i}`}
              x={x}
              y={height - 8}
              textAnchor="middle"
              fontSize="10"
              fill="#64748b"
              fontFamily="monospace"
            >
              {b.label}
            </text>
          );
        })}
      </svg>
      <div className="flex flex-wrap items-center gap-4 px-2 pt-1 text-[11px] text-slate-600">
        <span className="inline-flex items-center gap-1.5">
          <span className="w-3 h-0.5 bg-red-600 inline-block" /> Jitter (ms)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-3 h-0.5 bg-blue-600 inline-block" /> Download (Mbps)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-3 h-0.5 bg-violet-600 inline-block" /> Upload (Mbps)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-red-700 inline-block" /> Disconnection Event
        </span>
      </div>
    </div>
  );
};

const LatencyMetricRow: React.FC<{ label: string; stats: LatencyStatsSummary }> = ({
  label,
  stats,
}) => (
  <tr className="hover:bg-slate-50/70">
    <td className="py-2.5 px-3 font-medium text-slate-800">{label}</td>
    <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-600">{stats.count}</td>
    <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-700">
      {fmtMs(stats.avgMs)}
    </td>
    <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-700">
      {fmtMs(stats.p50Ms)}
    </td>
    <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-900 font-semibold">
      {fmtMs(stats.p95Ms)}
    </td>
    <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-600">
      {fmtMs(stats.maxMs)}
    </td>
  </tr>
);

export const SystemPerformance: React.FC<SystemPerformanceProps> = ({ initialData = null }) => {
  const [activeSubTab, setActiveSubTab] = useState<MonitoringSubTab>('overview');
  const [range, setRange] = useState<MonitoringTimeRange>('24h');
  const [customFrom, setCustomFrom] = useState<string>('');
  const [customTo, setCustomTo] = useState<string>('');
  const [autoRefreshSec, setAutoRefreshSec] = useState<number>(30);

  const [data, setData] = useState<MonitoringOverviewResponse | null>(initialData);
  const [isLoading, setIsLoading] = useState<boolean>(!initialData);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [isProbing, setIsProbing] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [actionBanner, setActionBanner] = useState<string | null>(null);

  // Filters & Pagination state across views
  const [apiSearch, setApiSearch] = useState('');
  const [apiOnlyFailed, setApiOnlyFailed] = useState(false);
  const [apiPage, setApiPage] = useState(1);

  const [activitySearch, setActivitySearch] = useState('');
  const [activityModuleFilter, setActivityModuleFilter] = useState('ALL');
  const [activityPage, setActivityPage] = useState(1);

  const [errSearch, setErrSearch] = useState('');
  const [errSourceFilter, setErrSourceFilter] = useState('ALL');
  const [errSeverityFilter, setErrSeverityFilter] = useState('ALL');
  const [errPage, setErrPage] = useState(1);

  const [alertFilterStatus, setAlertFilterStatus] = useState<'ALL' | 'ACTIVE' | 'ACKNOWLEDGED' | 'RESOLVED'>('ALL');
  const [busyAlertKey, setBusyAlertKey] = useState<string | null>(null);
  const [showThresholdPanel, setShowThresholdPanel] = useState(false);
  const [showNetThresholdPanel, setShowNetThresholdPanel] = useState(false);
  const [isRunningSpeedTest, setIsRunningSpeedTest] = useState(false);
  const [isProbingNetwork, setIsProbingNetwork] = useState(false);
  const [thresholdDraft, setThresholdDraft] = useState<MonitoringThresholds | null>(
    initialData?.thresholds ?? null
  );
  const [isSavingThresholds, setIsSavingThresholds] = useState(false);

  const loadMonitoringData = useCallback(
    async (silent = false) => {
      if (range === 'custom' && !customFrom) {
        return;
      }
      if (!silent) {
        setIsLoading(true);
      } else {
        setIsRefreshing(true);
      }
      setErrorMessage(null);
      try {
        await flushQueuedClientTelemetry();
        const res = await fetchMonitoringOverview({
          range,
          from: customFrom ? new Date(customFrom).toISOString() : undefined,
          to: customTo ? new Date(customTo).toISOString() : undefined,
        });
        setData(res);
        setThresholdDraft(res.thresholds);
      } catch (err: any) {
        setErrorMessage(err?.message || 'Unable to load live system telemetry.');
      } finally {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    },
    [range, customFrom, customTo]
  );

  useEffect(() => {
    if (initialData) return;
    void loadMonitoringData(false);
  }, [initialData, loadMonitoringData]);

  useEffect(() => {
    if (autoRefreshSec <= 0 || initialData) return;
    const id = window.setInterval(() => {
      void loadMonitoringData(true);
    }, autoRefreshSec * 1000);
    return () => window.clearInterval(id);
  }, [autoRefreshSec, initialData, loadMonitoringData]);

  const handleRunLiveProbe = async () => {
    setIsProbing(true);
    setActionBanner(null);
    try {
      const probeRes = await runMonitoringHealthProbe();
      setActionBanner(
        `Live Firestore & Backend probe passed (${probeRes.firestoreProbeMs} ms at ${fmtTs(
          probeRes.checkedAt
        )}).`
      );
      await loadMonitoringData(true);
    } catch (err: any) {
      setErrorMessage(err?.message || 'Live health probe failed.');
    } finally {
      setIsProbing(false);
    }
  };

  const handleAlertAction = async (
    groupKey: string,
    action: 'ACKNOWLEDGE' | 'RESOLVE' | 'REOPEN'
  ) => {
    setBusyAlertKey(groupKey);
    setActionBanner(null);
    try {
      await performMonitoringAlertAction(groupKey, action);
      setActionBanner(`Alert "${groupKey}" updated (${action}).`);
      await loadMonitoringData(true);
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to update alert status.');
    } finally {
      setBusyAlertKey(null);
    }
  };

  const handleSaveThresholds = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!thresholdDraft) return;
    setIsSavingThresholds(true);
    setActionBanner(null);
    try {
      const res = await updateMonitoringThresholds(thresholdDraft);
      setThresholdDraft(res.thresholds);
      setActionBanner('Alert thresholds and telemetry retention updated.');
      await loadMonitoringData(true);
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to save monitoring thresholds.');
    } finally {
      setIsSavingThresholds(false);
    }
  };

  const handleRunNetworkProbeBurst = async () => {
    setIsProbingNetwork(true);
    setActionBanner(null);
    setErrorMessage(null);
    try {
      const results = [];
      for (let i = 0; i < 3; i++) {
        const res = await runSingleNetworkProbe();
        if (res) results.push(res);
        if (i < 2) await new Promise((r) => setTimeout(r, 150));
      }
      await flushQueuedClientTelemetry();
      const okRtts = results.filter((r) => r.probeSucceeded && r.rttMs !== null).map((r) => r.rttMs as number);
      setActionBanner(
        okRtts.length > 0
          ? `3 HTTP RTT probes completed (${okRtts.map((v) => `${v}ms`).join(', ')}).`
          : 'Network probe burst completed (offline or unreachable).'
      );
      await loadMonitoringData(true);
    } catch (err: any) {
      setErrorMessage(err?.message || 'Network probe burst failed.');
    } finally {
      setIsProbingNetwork(false);
    }
  };

  const handleRunManualSpeedTest = async () => {
    setIsRunningSpeedTest(true);
    setActionBanner(null);
    setErrorMessage(null);
    try {
      const res = await runControlledSpeedTest(262_144);
      setActionBanner(
        `Controlled Speed Test (256 KB × 2): Download ↓${res.downloadMbps ?? '—'} Mbps • Upload ↑${res.uploadMbps ?? '—'} Mbps.`
      );
      await loadMonitoringData(true);
    } catch (err: any) {
      setErrorMessage(err?.message || 'Controlled speed test failed.');
    } finally {
      setIsRunningSpeedTest(false);
    }
  };

  // Derived filtered collections
  const filteredApiTraces = useMemo(() => {
    if (!data) return [];
    const q = apiSearch.trim().toLowerCase();
    return data.apiMonitoring.recentTraces.filter((t) => {
      if (apiOnlyFailed && t.success) return false;
      if (!q) return true;
      return (
        t.endpoint.toLowerCase().includes(q) ||
        t.method.toLowerCase().includes(q) ||
        t.correlationId.toLowerCase().includes(q) ||
        t.errorCategory.toLowerCase().includes(q)
      );
    });
  }, [data, apiSearch, apiOnlyFailed]);

  const filteredActivities = useMemo(() => {
    if (!data) return [];
    const q = activitySearch.trim().toLowerCase();
    return data.userActivity.filter((a) => {
      if (activityModuleFilter !== 'ALL' && a.module !== activityModuleFilter) return false;
      if (!q) return true;
      return (
        a.actorLoginId.toLowerCase().includes(q) ||
        a.action.toLowerCase().includes(q) ||
        a.module.toLowerCase().includes(q) ||
        (a.detail || '').toLowerCase().includes(q) ||
        (a.correlationId || '').toLowerCase().includes(q)
      );
    });
  }, [data, activitySearch, activityModuleFilter]);

  const filteredErrors = useMemo(() => {
    if (!data) return [];
    const q = errSearch.trim().toLowerCase();
    return data.errorLogs.filter((e) => {
      if (errSourceFilter !== 'ALL' && e.source !== errSourceFilter) return false;
      if (errSeverityFilter !== 'ALL' && e.severity !== errSeverityFilter) return false;
      if (!q) return true;
      return (
        e.message.toLowerCase().includes(q) ||
        e.module.toLowerCase().includes(q) ||
        e.category.toLowerCase().includes(q) ||
        (e.correlationId || '').toLowerCase().includes(q)
      );
    });
  }, [data, errSearch, errSourceFilter, errSeverityFilter]);

  const filteredAlerts = useMemo(() => {
    if (!data) return [];
    if (alertFilterStatus === 'ALL') return data.alerts;
    return data.alerts.filter((a) => a.status === alertFilterStatus);
  }, [data, alertFilterStatus]);

  if (isLoading && !data) {
    return <SystemPerformanceSkeleton />;
  }

  const PAGE_SIZE = 15;
  const paginate = <T,>(items: T[], page: number) => {
    const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    const safePage = Math.max(1, Math.min(page, totalPages));
    return {
      rows: items.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
      totalPages,
      safePage,
    };
  };

  const apiPaged = paginate(filteredApiTraces, apiPage);
  const actPaged = paginate(filteredActivities, activityPage);
  const errPaged = paginate(filteredErrors, errPage);

  const activityModules = Array.from(
    new Set((data?.userActivity || []).map((a) => a.module))
  ).sort();

  const overview = data?.overview;

  return (
    <div className="p-4 sm:p-6 bg-slate-50 min-h-full flex flex-col gap-5">
      {/* Top Command Header */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col xl:flex-row xl:items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <Activity className="w-5 h-5 text-blue-600 shrink-0" />
            <h1 className="text-lg font-bold text-slate-900 tracking-tight">
              System Performance &amp; Live Monitoring Center
            </h1>
            {overview && <StatusBadge status={overview.overallHealth} />}
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Real measured runtime telemetry (API, Firestore Admin SDK, QR punch pipeline, browser timing &amp; operational activity). Last updated:{' '}
            <span className="font-mono text-slate-700">{fmtTs(data?.generatedAt)}</span> • Last DB probe:{' '}
            <span className="font-mono text-slate-700">
              {fmtTs(overview?.lastSuccessfulHealthCheck)}
            </span>
          </p>
        </div>

        {/* Time Window + Live Controls */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200">
            {TIME_RANGES.map((tr) => (
              <button
                key={tr.id}
                type="button"
                onClick={() => setRange(tr.id)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition cursor-pointer ${
                  range === tr.id
                    ? 'bg-white text-slate-900 shadow-2xs font-semibold'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {tr.label}
              </button>
            ))}
          </div>

          {range === 'custom' && (
            <div className="flex items-center gap-1.5 text-xs">
              <input
                type="datetime-local"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                aria-label="Custom start time"
                className="px-2 py-1 border border-slate-300 rounded-md bg-white font-mono text-[11px]"
              />
              <span className="text-slate-400">to</span>
              <input
                type="datetime-local"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                aria-label="Custom end time"
                className="px-2 py-1 border border-slate-300 rounded-md bg-white font-mono text-[11px]"
              />
            </div>
          )}

          <select
            value={autoRefreshSec}
            onChange={(e) => setAutoRefreshSec(Number(e.target.value))}
            aria-label="Auto refresh interval"
            className="text-xs px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white text-slate-700 font-medium"
          >
            <option value={0}>Auto: Off</option>
            <option value={10}>Auto: 10s</option>
            <option value={30}>Auto: 30s</option>
            <option value={60}>Auto: 60s</option>
          </select>

          <button
            type="button"
            onClick={handleRunLiveProbe}
            disabled={isProbing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50 cursor-pointer"
          >
            <Play className="w-3.5 h-3.5 text-emerald-600" />
            {isProbing ? 'Probing...' : 'Run Probe'}
          </button>

          <button
            type="button"
            onClick={() => void loadMonitoringData(true)}
            disabled={isRefreshing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Banners */}
      {errorMessage && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg px-4 py-2.5 text-xs flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <XCircle className="w-4 h-4 shrink-0 text-red-600" />
            <span>{errorMessage}</span>
          </div>
          <button
            type="button"
            onClick={() => setErrorMessage(null)}
            className="text-red-600 hover:text-red-800 font-semibold cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {actionBanner && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg px-4 py-2.5 text-xs flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" />
            <span>{actionBanner}</span>
          </div>
          <button
            type="button"
            onClick={() => setActionBanner(null)}
            className="text-emerald-700 hover:text-emerald-900 font-semibold cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* 8-Section Sub-Navigation Strip */}
      <div className="bg-white border border-slate-200 rounded-xl p-1.5 flex flex-wrap gap-1">
        {SUB_TABS.map((st) => {
          const isActive = activeSubTab === st.id;
          const badgeCount =
            st.id === 'alerts' && overview && overview.activeAlertsCount > 0
              ? overview.activeAlertsCount
              : st.id === 'errors' && overview && overview.applicationErrorCount > 0
                ? overview.applicationErrorCount
                : 0;
          return (
            <button
              key={st.id}
              type="button"
              onClick={() => setActiveSubTab(st.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition flex items-center gap-1.5 cursor-pointer ${
                isActive
                  ? 'bg-slate-900 text-white font-semibold'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              <span>{st.label}</span>
              {badgeCount > 0 && (
                <span
                  className={`px-1.5 py-0.2 rounded text-[10px] font-mono font-bold ${
                    isActive ? 'bg-red-500 text-white' : 'bg-red-100 text-red-700'
                  }`}
                >
                  {badgeCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ====================================================================
          VIEW 1: SYSTEM OVERVIEW
          ==================================================================== */}
      {activeSubTab === 'overview' && data && overview && (
        <div className="flex flex-col gap-5">
          {/* Runtime Connectivity Strip */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="bg-white border border-slate-200 rounded-lg p-3.5 flex items-center justify-between">
              <div>
                <div className="text-[11px] font-medium text-slate-500 uppercase">Backend API</div>
                <div className="mt-1">
                  <StatusBadge status={overview.backendStatus} />
                </div>
                <div className="text-[11px] text-slate-500 mt-1 font-mono">
                  {overview.totalApiRequests} reqs • {overview.failedApiRequests} failed
                </div>
              </div>
              <Server className="w-5 h-5 text-slate-400" />
            </div>

            <div className="bg-white border border-slate-200 rounded-lg p-3.5 flex items-center justify-between">
              <div>
                <div className="text-[11px] font-medium text-slate-500 uppercase">
                  Firebase / Firestore
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <StatusBadge status={overview.firebaseConnectivity} />
                  <span className="text-xs font-mono font-semibold text-slate-800">
                    {fmtMs(overview.firebasePingMs)}
                  </span>
                </div>
                <div className="text-[11px] text-slate-500 mt-1 truncate max-w-[200px]" title={overview.databaseId}>
                  DB: {overview.databaseId || 'default'} ({overview.credentialMode})
                </div>
              </div>
              <Database className="w-5 h-5 text-slate-400" />
            </div>

            <div className="bg-white border border-slate-200 rounded-lg p-3.5 flex items-center justify-between">
              <div>
                <div className="text-[11px] font-medium text-slate-500 uppercase">
                  Frontend Telemetry
                </div>
                <div className="mt-1">
                  <StatusBadge status={overview.frontendStatus} />
                </div>
                <div className="text-[11px] text-slate-500 mt-1 font-mono">
                  Bg Refresh: {overview.backgroundRefreshStatus} (
                  {fmtMs(overview.backgroundRefreshAvgMs)})
                </div>
              </div>
              <Layers className="w-5 h-5 text-slate-400" />
            </div>

            <div className="bg-white border border-slate-200 rounded-lg p-3.5 flex items-center justify-between">
              <div>
                <div className="text-[11px] font-medium text-slate-500 uppercase">
                  Active User Sessions
                </div>
                <div className="text-xl font-bold font-mono tabular-nums text-slate-900 mt-0.5">
                  {fmtCount(overview.activeUserSessions)}
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5 font-mono">
                  {overview.totalActiveUserAccounts !== null
                    ? `${overview.totalActiveUserAccounts} active accounts (8h login window)`
                    : 'Account count Not Available'}
                </div>
              </div>
              <Users className="w-5 h-5 text-slate-400" />
            </div>
          </div>

          {/* Primary Measured KPI Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <KpiCard
              label="API Avg Response"
              value={fmtMs(overview.apiAvgMs)}
              subtext={`P50 ${fmtMs(overview.apiP50Ms)}`}
            />
            <KpiCard
              label="API P95 Response"
              value={fmtMs(overview.apiP95Ms)}
              subtext={`Timeouts: ${overview.timeoutApiRequests}`}
              tone={
                overview.apiP95Ms !== null && overview.apiP95Ms >= data.thresholds.apiP95WarningMs
                  ? 'warn'
                  : 'default'
              }
            />
            <KpiCard
              label="App Error Count"
              value={String(overview.applicationErrorCount)}
              subtext={`${overview.activeAlertsCount} active alert(s)`}
              tone={overview.applicationErrorCount > 0 ? 'bad' : 'good'}
            />
            <KpiCard
              label="QR Punch Avg Speed"
              value={fmtMs(overview.qrPunchAvgMs)}
              subtext={`P95 ${fmtMs(overview.qrPunchP95Ms)} • ${overview.qrPunchTotal} scans`}
              tone={
                overview.qrPunchAvgMs !== null &&
                overview.qrPunchAvgMs >= data.thresholds.qrPunchAvgWarningMs
                  ? 'warn'
                  : 'default'
              }
            />
            <KpiCard
              label="QR Failure Rate"
              value={fmtPct(overview.qrPunchFailureRatePct)}
              subtext={`Success: ${fmtPct(overview.qrPunchSuccessRatePct)}`}
              tone={
                overview.qrPunchFailureRatePct !== null && overview.qrPunchFailureRatePct > 5
                  ? 'bad'
                  : 'default'
              }
            />
            <KpiCard
              label="Last Telemetry"
              value={
                overview.lastMonitoringUpdate
                  ? new Date(overview.lastMonitoringUpdate).toLocaleTimeString('en-IN', {
                      timeZone: 'Asia/Kolkata',
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                      hour12: false,
                    })
                  : '—'
              }
              subtext={`Project: ${overview.projectId || 'default'}`}
              tone={overview.lastMonitoringUpdate ? 'default' : 'muted'}
            />
          </div>

          {/* Charts Row */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-slate-900">
                  Latency Trend (API, QR Punch, Firestore)
                </h2>
                <span className="text-[11px] font-mono text-slate-500">
                  Window: {data.window.range}
                </span>
              </div>
              <LatencyTrendSvgChart buckets={data.timeSeries} />
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-slate-900">
                  API Traffic vs Errors &amp; Failures
                </h2>
                <span className="text-[11px] font-mono text-slate-500">
                  {overview.totalApiRequests} API • {overview.applicationErrorCount} Errors
                </span>
              </div>
              <VolumeAndErrorSvgChart buckets={data.timeSeries} />
            </div>
          </div>

          {/* QR Punch Stage Telemetry Breakdown & Recent Active Alerts */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <QrCode className="w-4 h-4 text-emerald-600" />
                  <h2 className="text-sm font-semibold text-slate-900">
                    QR Scanner &amp; Attendance Pipeline Timings
                  </h2>
                </div>
                <span className="text-[11px] font-mono text-slate-500">
                  Dup Rejects: {data.qrPerformance.duplicateRejections} • Timeouts:{' '}
                  {data.qrPerformance.timeoutCount}
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold">
                    <tr>
                      <th className="py-2 px-3">Pipeline Stage</th>
                      <th className="py-2 px-3 text-right">Samples</th>
                      <th className="py-2 px-3 text-right">Avg</th>
                      <th className="py-2 px-3 text-right">P50</th>
                      <th className="py-2 px-3 text-right">P95</th>
                      <th className="py-2 px-3 text-right">Max</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    <LatencyMetricRow label="QR Detection (Client)" stats={data.qrPerformance.stages.qrDetect} />
                    <LatencyMetricRow label="QR Payload Parse (Client)" stats={data.qrPerformance.stages.qrParse} />
                    <LatencyMetricRow label="API Network Request (Client)" stats={data.qrPerformance.stages.apiRequest} />
                    <LatencyMetricRow label="Auth Token Verify (Server)" stats={data.qrPerformance.stages.authTokenVerify} />
                    <LatencyMetricRow label="QR Token Validation" stats={data.qrPerformance.stages.tokenValidation} />
                    <LatencyMetricRow label="Firestore Transaction" stats={data.qrPerformance.stages.firestoreTx} />
                    <LatencyMetricRow label="Total QR Punch In" stats={data.qrPerformance.stages.totalPunchIn} />
                    <LatencyMetricRow label="Total QR Punch Out" stats={data.qrPerformance.stages.totalPunchOut} />
                    <LatencyMetricRow label="Manual Entry Punch" stats={data.qrPerformance.stages.manualPunch} />
                  </tbody>
                </table>
              </div>
            </div>

            <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl flex flex-col">
              <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-600" />
                  <h2 className="text-sm font-semibold text-slate-900">Active &amp; Recent Alerts</h2>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveSubTab('alerts')}
                  className="text-xs text-blue-600 hover:underline font-medium cursor-pointer"
                >
                  Manage all ({data.alerts.length})
                </button>
              </div>
              <div className="p-3 flex-1 space-y-2.5 overflow-y-auto max-h-[340px]">
                {data.alerts.length === 0 ? (
                  <div className="py-10 text-center text-xs text-slate-500">
                    No alerts triggered from measured thresholds.
                  </div>
                ) : (
                  data.alerts.slice(0, 6).map((alert) => (
                    <div
                      key={alert.groupKey}
                      className="border border-slate-200 rounded-lg p-3 space-y-1.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-slate-900 truncate">
                          {alert.title}
                        </span>
                        <div className="flex items-center gap-1 shrink-0">
                          <StatusBadge status={alert.severity} />
                          <StatusBadge status={alert.status} />
                        </div>
                      </div>
                      <p className="text-[11px] text-slate-600 leading-snug">{alert.description}</p>
                      <div className="flex items-center justify-between text-[11px] text-slate-400 font-mono">
                        <span>
                          {alert.module} • x{alert.occurrenceCount}
                        </span>
                        <span>{fmtTs(alert.lastTriggeredAt)}</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Internet Health & Root-Cause Summary Strip on Overview */}
          {data.networkMonitoring && (
            <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
              <div className="flex items-start gap-3 min-w-0">
                {data.networkMonitoring.online ? (
                  <Wifi className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
                ) : (
                  <WifiOff className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                )}
                <div className="space-y-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-slate-900">
                      Internet Health &amp; Network Diagnostics
                    </span>
                    <StatusBadge status={data.networkMonitoring.healthScore.tier} />
                    <StatusBadge status={data.networkMonitoring.diagnostics.primaryCause} />
                  </div>
                  <p className="text-xs text-slate-600">
                    {data.networkMonitoring.diagnostics.summary}
                  </p>
                  <div className="flex flex-wrap items-center gap-4 text-[11px] font-mono tabular-nums text-slate-500">
                    <span>
                      Score:{' '}
                      <strong className="text-slate-900">
                        {data.networkMonitoring.healthScore.score !== null
                          ? `${data.networkMonitoring.healthScore.score}/100`
                          : 'UNKNOWN'}
                      </strong>
                    </span>
                    <span>App HTTP RTT Avg: {fmtMs(data.networkMonitoring.rttStats.avgMs)}</span>
                    <span>Jitter: {fmtMs(data.networkMonitoring.jitter.valueMs)}</span>
                    <span>
                      Packet Loss:{' '}
                      {fmtPct(data.networkMonitoring.packetLoss.reportablePacketLossPct)}
                    </span>
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setActiveSubTab('network')}
                className="shrink-0 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                Open Network Diagnostics
              </button>
            </div>
          )}
        </div>
      )}

      {/* ====================================================================
          VIEW 2: INTERNET & NETWORK PERFORMANCE MONITORING
          ==================================================================== */}
      {activeSubTab === 'network' && data && (() => {
        const net = data.networkMonitoring;
        if (!net) {
          return (
            <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-xs text-slate-500">
              Network monitoring telemetry structure is initializing. Run a probe or refresh.
            </div>
          );
        }

        const networkAlerts = data.alerts.filter(
          (a) => a.groupKey.startsWith('NET_ALERT_') || a.module === 'Internet & Network'
        );

        return (
          <div className="flex flex-col gap-5">
            {/* Disclosure Banner + Controlled Actions */}
            <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Globe className="w-4 h-4 text-blue-600 shrink-0" />
                  <h2 className="text-sm font-semibold text-slate-900">
                    Application Network Performance &amp; Bottleneck Isolation
                  </h2>
                  <StatusBadge status={net.indicatorStatuses.connectivity} />
                </div>
                <p className="text-xs text-slate-600">
                  Measures <strong>Application HTTP RTT</strong> (not raw ICMP ping), Jitter, multi-probe Packet Loss, Resource Timing DNS/TCP/TLS (where uncached), and manual 256 KB speed tests. Browser <code className="font-mono text-[11px] bg-slate-100 px-1 rounded">navigator.connection</code> values are marked strictly as browser estimates.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => void handleRunNetworkProbeBurst()}
                  disabled={isProbingNetwork}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 cursor-pointer"
                >
                  <Wifi className="w-3.5 h-3.5 text-emerald-600" />
                  {isProbingNetwork ? 'Probing (3x)...' : 'Run HTTP RTT Probe (3x)'}
                </button>
                <button
                  type="button"
                  onClick={() => void handleRunManualSpeedTest()}
                  disabled={isRunningSpeedTest}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 disabled:opacity-50 cursor-pointer"
                >
                  <Gauge className="w-3.5 h-3.5" />
                  {isRunningSpeedTest ? 'Testing 256 KB × 2...' : 'Run Manual Speed Test (256 KB)'}
                </button>
              </div>
            </div>

            {/* Section A: Health Score & Network vs Server Root-Cause Diagnostics */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
              {/* Left: Internet Health Score (0-100) + Formula */}
              <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-4 flex flex-col justify-between gap-3">
                <div className="flex items-start justify-between gap-3 border-b border-slate-100 pb-3">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                      Internet Health Score (0–100)
                    </div>
                    <div className="flex items-baseline gap-2.5 mt-1">
                      <span className="text-3xl font-bold font-mono tabular-nums text-slate-900">
                        {net.healthScore.score !== null ? net.healthScore.score : '—'}
                      </span>
                      <span className="text-xs font-mono text-slate-400">/ 100</span>
                      <StatusBadge status={net.healthScore.tier} />
                    </div>
                  </div>
                  <Gauge className="w-5 h-5 text-slate-400" />
                </div>

                <p className="text-xs text-slate-600 leading-relaxed">
                  {net.healthScore.formulaSummary}
                </p>

                {net.healthScore.factors.length > 0 && (
                  <div className="overflow-x-auto border border-slate-200 rounded-lg">
                    <table className="w-full text-left text-[11px]">
                      <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold">
                        <tr>
                          <th className="py-1.5 px-2.5">Factor</th>
                          <th className="py-1.5 px-2.5 text-right">Measured</th>
                          <th className="py-1.5 px-2.5 text-right">Weight</th>
                          <th className="py-1.5 px-2.5 text-right">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {net.healthScore.factors.map((f) => (
                          <tr key={f.factor}>
                            <td className="py-1.5 px-2.5 font-medium text-slate-800">{f.factor}</td>
                            <td className="py-1.5 px-2.5 text-right font-mono tabular-nums text-slate-700">
                              {f.measuredValue}
                            </td>
                            <td className="py-1.5 px-2.5 text-right font-mono tabular-nums text-slate-500">
                              {f.included ? `${f.weightPct}%` : 'Excluded'}
                            </td>
                            <td className="py-1.5 px-2.5 text-right">
                              <StatusBadge status={f.status} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Right: Network vs Server Diagnostics */}
              <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-4 flex flex-col justify-between gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                      Network vs Server Diagnostics (Automatic Root-Cause Isolation)
                    </div>
                    <div className="flex flex-wrap items-center gap-2 mt-1">
                      <StatusBadge status={net.diagnostics.primaryCause} />
                      <span className="text-xs font-mono text-slate-500">
                        Confidence: <strong className="text-slate-800">{net.diagnostics.confidence}</strong>
                      </span>
                    </div>
                  </div>
                  <StatusBadge status={net.indicatorStatuses.backendVsNetwork} />
                </div>

                <p className="text-xs text-slate-700 leading-relaxed">{net.diagnostics.summary}</p>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                  <div className="border border-slate-200 rounded-lg p-2.5">
                    <div className="text-[10px] uppercase text-slate-500 font-semibold">App HTTP RTT</div>
                    <div className="text-sm font-bold font-mono tabular-nums text-slate-900 mt-0.5">
                      {fmtMs(net.diagnostics.comparison.appRttAvgMs)}
                    </div>
                  </div>
                  <div className="border border-slate-200 rounded-lg p-2.5">
                    <div className="text-[10px] uppercase text-slate-500 font-semibold">Backend API P95</div>
                    <div className="text-sm font-bold font-mono tabular-nums text-slate-900 mt-0.5">
                      {fmtMs(net.diagnostics.comparison.backendApiP95Ms)}
                    </div>
                  </div>
                  <div className="border border-slate-200 rounded-lg p-2.5">
                    <div className="text-[10px] uppercase text-slate-500 font-semibold">Firestore P95</div>
                    <div className="text-sm font-bold font-mono tabular-nums text-slate-900 mt-0.5">
                      {fmtMs(net.diagnostics.comparison.firestoreP95Ms)}
                    </div>
                  </div>
                  <div className="border border-slate-200 rounded-lg p-2.5">
                    <div className="text-[10px] uppercase text-slate-500 font-semibold">UI Slow Render Avg</div>
                    <div className="text-sm font-bold font-mono tabular-nums text-slate-900 mt-0.5">
                      {fmtMs(net.diagnostics.comparison.frontendSlowRenderAvgMs)}
                    </div>
                  </div>
                </div>

                {net.diagnostics.evidenceBullets.length > 0 && (
                  <ul className="space-y-1 text-[11px] text-slate-600 list-disc list-inside bg-slate-50 border border-slate-200 rounded-lg p-2.5">
                    {net.diagnostics.evidenceBullets.map((b, i) => (
                      <li key={i}>{b}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            {/* Section B: Measured Network Metrics & Indicator Strip */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              <KpiCard
                label="Internet Connection"
                value={net.online ? 'Online' : 'Offline'}
                subtext={`Disconnections: ${net.disconnectionCount}`}
                tone={net.online ? 'good' : 'bad'}
              />
              <KpiCard
                label="App HTTP RTT (Current)"
                value={fmtMs(net.rttStats.currentMs)}
                subtext={`Avg ${fmtMs(net.rttStats.avgMs)} • ${net.rttStats.rating}`}
                tone={
                  net.indicatorStatuses.latency === 'CRITICAL'
                    ? 'bad'
                    : net.indicatorStatuses.latency === 'WARNING'
                      ? 'warn'
                      : net.indicatorStatuses.latency === 'GOOD'
                        ? 'good'
                        : 'muted'
                }
              />
              <KpiCard
                label="RTT Percentiles"
                value={`P95 ${fmtMs(net.rttStats.p95Ms)}`}
                subtext={`P50 ${fmtMs(net.rttStats.p50Ms)} • Max ${fmtMs(net.rttStats.maxMs)}`}
              />
              <KpiCard
                label="Jitter (Measured)"
                value={fmtMs(net.jitter.valueMs)}
                subtext={`${net.jitter.rating} (${net.jitter.sampleCount} probes)`}
                tone={
                  net.jitter.rating === 'CRITICAL'
                    ? 'bad'
                    : net.jitter.rating === 'WARNING'
                      ? 'warn'
                      : net.jitter.rating === 'GOOD'
                        ? 'good'
                        : 'muted'
                }
              />
              <KpiCard
                label="Packet Loss (Multi-Probe)"
                value={fmtPct(net.packetLoss.reportablePacketLossPct)}
                subtext={`${net.packetLoss.failedProbes}/${net.packetLoss.totalProbes} failed • ${net.packetLoss.rating}`}
                tone={
                  net.packetLoss.rating === 'CRITICAL'
                    ? 'bad'
                    : net.packetLoss.rating === 'WARNING'
                      ? 'warn'
                      : net.packetLoss.rating === 'GOOD'
                        ? 'good'
                        : 'muted'
                }
              />
              <KpiCard
                label="Req Failure Rate"
                value={fmtPct(net.networkRequestFailureRatePct)}
                subtext={`Server ping proc: ${fmtMs(net.avgServerProbeProcessMs)}`}
                tone={
                  net.networkRequestFailureRatePct !== null && net.networkRequestFailureRatePct >= 10
                    ? 'bad'
                    : 'default'
                }
              />
            </div>

            {/* DNS / TCP / TLS + Packet Loss Safeguard + Speed Test Panel */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
              {/* Resource Timing DNS / TCP / TLS & Safeguard Disclosure */}
              <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
                  <h3 className="text-sm font-semibold text-slate-900">
                    Connection Setup &amp; Packet Loss Safeguard
                  </h3>
                  <StatusBadge status={net.indicatorStatuses.packetLoss} />
                </div>

                <div className="grid grid-cols-3 gap-2.5">
                  <div className="border border-slate-200 rounded-lg p-2.5">
                    <div className="text-[10px] uppercase text-slate-500 font-semibold">DNS Lookup</div>
                    <div className="text-sm font-bold font-mono tabular-nums text-slate-900 mt-0.5">
                      {net.dnsMs !== null ? fmtMs(net.dnsMs) : 'Cached / N/A'}
                    </div>
                  </div>
                  <div className="border border-slate-200 rounded-lg p-2.5">
                    <div className="text-[10px] uppercase text-slate-500 font-semibold">TCP Connect</div>
                    <div className="text-sm font-bold font-mono tabular-nums text-slate-900 mt-0.5">
                      {net.tcpConnectMs !== null ? fmtMs(net.tcpConnectMs) : 'Reused / N/A'}
                    </div>
                  </div>
                  <div className="border border-slate-200 rounded-lg p-2.5">
                    <div className="text-[10px] uppercase text-slate-500 font-semibold">HTTPS / TLS</div>
                    <div className="text-sm font-bold font-mono tabular-nums text-slate-900 mt-0.5">
                      {net.tlsHandshakeMs !== null ? fmtMs(net.tlsHandshakeMs) : 'Reused / N/A'}
                    </div>
                  </div>
                </div>

                <p className="text-[11px] text-slate-600 leading-relaxed">
                  {net.timingMeasurementNote}
                </p>

                <div className="bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-[11px] text-slate-700 space-y-1">
                  <div className="font-semibold text-slate-900">Packet Loss Classification Status</div>
                  <div>{net.packetLoss.note}</div>
                  <div className="text-[10px] font-mono text-slate-500">
                    Last Successful Probe: {fmtTs(net.lastSuccessfulMeasurementAt)} • Last Disconnection:{' '}
                    {fmtTs(net.lastDisconnectionAt)}
                  </div>
                </div>
              </div>

              {/* Controlled Manual Download / Upload Speed Test Panel */}
              <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2.5">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900">
                      Controlled Download / Upload Throughput Test (Manual)
                    </h3>
                    <p className="text-[11px] text-slate-500">{net.speedTest.disclosure}</p>
                  </div>
                  <StatusBadge status={net.indicatorStatuses.throughput} />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="border border-slate-200 rounded-lg p-3 flex items-center justify-between">
                    <div>
                      <div className="text-[10px] uppercase text-slate-500 font-semibold">
                        Download Speed
                      </div>
                      <div className="text-xl font-bold font-mono tabular-nums text-slate-900 mt-0.5">
                        {net.speedTest.latestDownloadMbps !== null
                          ? `${net.speedTest.latestDownloadMbps} Mbps`
                          : 'Not Tested'}
                      </div>
                      <div className="mt-1">
                        <StatusBadge status={net.speedTest.downloadRating} />
                      </div>
                    </div>
                    <ArrowDownToLine className="w-5 h-5 text-blue-600" />
                  </div>

                  <div className="border border-slate-200 rounded-lg p-3 flex items-center justify-between">
                    <div>
                      <div className="text-[10px] uppercase text-slate-500 font-semibold">
                        Upload Speed
                      </div>
                      <div className="text-xl font-bold font-mono tabular-nums text-slate-900 mt-0.5">
                        {net.speedTest.latestUploadMbps !== null
                          ? `${net.speedTest.latestUploadMbps} Mbps`
                          : 'Not Tested'}
                      </div>
                      <div className="mt-1">
                        <StatusBadge status={net.speedTest.uploadRating} />
                      </div>
                    </div>
                    <ArrowUpFromLine className="w-5 h-5 text-violet-600" />
                  </div>

                  <div className="border border-slate-200 rounded-lg p-3 flex flex-col justify-between">
                    <div className="text-[10px] uppercase text-slate-500 font-semibold">
                      Last Manual Test
                    </div>
                    <div className="text-xs font-mono text-slate-800 mt-1">
                      {fmtTs(net.speedTest.lastTestedAt)}
                    </div>
                    <div className="text-[10px] text-slate-500 mt-1">
                      DL ≥10 GOOD • UL ≥5 GOOD
                    </div>
                  </div>
                </div>

                {net.speedTest.recentTests.length > 0 && (
                  <div className="overflow-x-auto border border-slate-200 rounded-lg">
                    <table className="w-full text-left text-[11px]">
                      <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold">
                        <tr>
                          <th className="py-1.5 px-2.5">Timestamp</th>
                          <th className="py-1.5 px-2.5">Session</th>
                          <th className="py-1.5 px-2.5 text-right">Download</th>
                          <th className="py-1.5 px-2.5 text-right">Upload</th>
                          <th className="py-1.5 px-2.5 text-right">Payloads</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {net.speedTest.recentTests.slice(0, 5).map((st) => (
                          <tr key={st.id}>
                            <td className="py-1.5 px-2.5 font-mono text-slate-700">
                              {fmtTs(st.timestamp)}
                            </td>
                            <td className="py-1.5 px-2.5 font-mono text-slate-500">{st.actorLoginId}</td>
                            <td className="py-1.5 px-2.5 text-right font-mono font-semibold text-slate-900">
                              {st.downloadMbps !== null ? `${st.downloadMbps} Mbps` : '—'}
                            </td>
                            <td className="py-1.5 px-2.5 text-right font-mono font-semibold text-slate-900">
                              {st.uploadMbps !== null ? `${st.uploadMbps} Mbps` : '—'}
                            </td>
                            <td className="py-1.5 px-2.5 text-right font-mono text-slate-500">
                              {Math.round(st.downloadBytes / 1024)}KB / {Math.round(st.uploadBytes / 1024)}KB
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

            {/* Section D: Network Performance History Charts */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <div className="bg-white border border-slate-200 rounded-xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-slate-900">
                    Network RTT vs Backend API Latency History
                  </h3>
                  <span className="text-[11px] font-mono text-slate-500">
                    Window: {data.window.range} • {net.totalProbeSamplesInWindow} probes
                  </span>
                </div>
                <NetworkRttAndApiChart buckets={net.historyBuckets} />
              </div>

              <div className="bg-white border border-slate-200 rounded-xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-slate-900">
                    Jitter, Speed Tests &amp; Disconnection History
                  </h3>
                  <span className="text-[11px] font-mono text-slate-500">
                    Disconnections: {net.disconnectionCount}
                  </span>
                </div>
                <NetworkStabilityAndSpeedChart buckets={net.historyBuckets} />
              </div>
            </div>

            {/* Section E: Live Network Alerts + Configurable Network Thresholds */}
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-600" />
                  <h3 className="text-sm font-semibold text-slate-900">
                    Live Network Alerts &amp; Threshold Configuration
                  </h3>
                  <span className="text-[11px] font-mono text-slate-500">
                    {networkAlerts.length} network alert(s)
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setShowNetThresholdPanel((p) => !p)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                  {showNetThresholdPanel ? 'Hide Network Thresholds' : 'Configure Network Thresholds'}
                </button>
              </div>

              {showNetThresholdPanel && thresholdDraft && (
                <form
                  onSubmit={handleSaveThresholds}
                  className="p-4 border-b border-slate-200 bg-slate-50/70 space-y-3"
                >
                  <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 text-xs">
                    <ThresholdInput
                      label="RTT Excellent Max (ms)"
                      value={thresholdDraft.netLatencyGoodMaxMs}
                      min={5}
                      max={5000}
                      onChange={(v) =>
                        setThresholdDraft((prev) => (prev ? { ...prev, netLatencyGoodMaxMs: v } : prev))
                      }
                    />
                    <ThresholdInput
                      label="RTT Warn Max (ms)"
                      value={thresholdDraft.netLatencyWarnMaxMs}
                      min={10}
                      max={5000}
                      onChange={(v) =>
                        setThresholdDraft((prev) => (prev ? { ...prev, netLatencyWarnMaxMs: v } : prev))
                      }
                    />
                    <ThresholdInput
                      label="RTT Poor Max (ms)"
                      value={thresholdDraft.netLatencyPoorMaxMs}
                      min={20}
                      max={10000}
                      onChange={(v) =>
                        setThresholdDraft((prev) => (prev ? { ...prev, netLatencyPoorMaxMs: v } : prev))
                      }
                    />
                    <ThresholdInput
                      label="RTT Critical Min (ms)"
                      value={thresholdDraft.netLatencyCriticalMinMs}
                      min={50}
                      max={20000}
                      onChange={(v) =>
                        setThresholdDraft((prev) => (prev ? { ...prev, netLatencyCriticalMinMs: v } : prev))
                      }
                    />
                    <ThresholdInput
                      label="Jitter Good Max (ms)"
                      value={thresholdDraft.netJitterGoodMaxMs}
                      min={1}
                      max={2000}
                      onChange={(v) =>
                        setThresholdDraft((prev) => (prev ? { ...prev, netJitterGoodMaxMs: v } : prev))
                      }
                    />
                    <ThresholdInput
                      label="Jitter Warn Max (ms)"
                      value={thresholdDraft.netJitterWarnMaxMs}
                      min={5}
                      max={5000}
                      onChange={(v) =>
                        setThresholdDraft((prev) => (prev ? { ...prev, netJitterWarnMaxMs: v } : prev))
                      }
                    />
                    <ThresholdInput
                      label="Probe Interval (sec)"
                      value={thresholdDraft.netProbeIntervalSec}
                      min={10}
                      max={300}
                      onChange={(v) =>
                        setThresholdDraft((prev) => (prev ? { ...prev, netProbeIntervalSec: v } : prev))
                      }
                    />
                    <ThresholdInput
                      label="Packet Loss Good (%)"
                      value={thresholdDraft.netPacketLossGoodMaxPct}
                      min={0}
                      max={100}
                      onChange={(v) =>
                        setThresholdDraft((prev) => (prev ? { ...prev, netPacketLossGoodMaxPct: v } : prev))
                      }
                    />
                    <ThresholdInput
                      label="Packet Loss Warn (%)"
                      value={thresholdDraft.netPacketLossWarnMaxPct}
                      min={0}
                      max={100}
                      onChange={(v) =>
                        setThresholdDraft((prev) => (prev ? { ...prev, netPacketLossWarnMaxPct: v } : prev))
                      }
                    />
                    <ThresholdInput
                      label="DL Good Min (Mbps)"
                      value={thresholdDraft.netDownloadGoodMinMbps}
                      min={1}
                      max={1000}
                      onChange={(v) =>
                        setThresholdDraft((prev) => (prev ? { ...prev, netDownloadGoodMinMbps: v } : prev))
                      }
                    />
                    <ThresholdInput
                      label="DL Warn Min (Mbps)"
                      value={thresholdDraft.netDownloadWarnMinMbps}
                      min={1}
                      max={1000}
                      onChange={(v) =>
                        setThresholdDraft((prev) => (prev ? { ...prev, netDownloadWarnMinMbps: v } : prev))
                      }
                    />
                    <ThresholdInput
                      label="UL Good Min (Mbps)"
                      value={thresholdDraft.netUploadGoodMinMbps}
                      min={1}
                      max={1000}
                      onChange={(v) =>
                        setThresholdDraft((prev) => (prev ? { ...prev, netUploadGoodMinMbps: v } : prev))
                      }
                    />
                    <ThresholdInput
                      label="UL Warn Min (Mbps)"
                      value={thresholdDraft.netUploadWarnMinMbps}
                      min={1}
                      max={1000}
                      onChange={(v) =>
                        setThresholdDraft((prev) => (prev ? { ...prev, netUploadWarnMinMbps: v } : prev))
                      }
                    />
                    <ThresholdInput
                      label="Net Failure Spike (cnt)"
                      value={thresholdDraft.netNetworkFailureSpikeCount}
                      min={1}
                      max={100}
                      onChange={(v) =>
                        setThresholdDraft((prev) =>
                          prev ? { ...prev, netNetworkFailureSpikeCount: v } : prev
                        )
                      }
                    />
                  </div>
                  <div className="flex justify-end">
                    <button
                      type="submit"
                      disabled={isSavingThresholds}
                      className="px-4 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 disabled:opacity-50 cursor-pointer"
                    >
                      {isSavingThresholds ? 'Saving...' : 'Save Network Thresholds'}
                    </button>
                  </div>
                </form>
              )}

              <div className="p-4 space-y-2.5">
                {networkAlerts.length === 0 ? (
                  <div className="text-center py-6 text-xs text-slate-500">
                    No active or historical network alerts triggered in current monitoring buffer.
                  </div>
                ) : (
                  networkAlerts.map((alert) => (
                    <div
                      key={alert.groupKey}
                      className="border border-slate-200 rounded-lg p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div className="space-y-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <StatusBadge status={alert.severity} />
                          <StatusBadge status={alert.status} />
                          <span className="text-xs font-semibold text-slate-900">{alert.title}</span>
                          <span className="text-[11px] font-mono bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded">
                            x{alert.occurrenceCount}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-600">{alert.description}</p>
                        <div className="text-[10px] font-mono text-slate-500">
                          {alert.affectedOperation} • Last: {fmtTs(alert.lastTriggeredAt)}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {alert.status === 'ACTIVE' && (
                          <button
                            type="button"
                            disabled={busyAlertKey === alert.groupKey}
                            onClick={() => void handleAlertAction(alert.groupKey, 'ACKNOWLEDGE')}
                            className="px-2.5 py-1 rounded border border-amber-300 bg-amber-50 text-amber-800 text-[11px] font-semibold hover:bg-amber-100 disabled:opacity-50 cursor-pointer"
                          >
                            Acknowledge
                          </button>
                        )}
                        {alert.status !== 'RESOLVED' ? (
                          <button
                            type="button"
                            disabled={busyAlertKey === alert.groupKey}
                            onClick={() => void handleAlertAction(alert.groupKey, 'RESOLVE')}
                            className="px-2.5 py-1 rounded border border-emerald-300 bg-emerald-50 text-emerald-800 text-[11px] font-semibold hover:bg-emerald-100 disabled:opacity-50 cursor-pointer"
                          >
                            Resolve
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={busyAlertKey === alert.groupKey}
                            onClick={() => void handleAlertAction(alert.groupKey, 'REOPEN')}
                            className="px-2.5 py-1 rounded border border-slate-300 bg-white text-slate-700 text-[11px] font-semibold hover:bg-slate-50 disabled:opacity-50 cursor-pointer"
                          >
                            Reopen
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Section F: Super Admin User & Device Session Network View */}
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Laptop className="w-4 h-4 text-slate-600" />
                  <h3 className="text-sm font-semibold text-slate-900">
                    Active Sessions &amp; Device Network Quality (Super Admin Only)
                  </h3>
                </div>
                <span className="text-[11px] text-slate-500">
                  Zero location/IP/tokens collected • Browser Network Information API values are estimates
                </span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold">
                    <tr>
                      <th className="py-2.5 px-3">Session / User</th>
                      <th className="py-2.5 px-3">Browser / OS</th>
                      <th className="py-2.5 px-3">Conn Type (Browser Est.)</th>
                      <th className="py-2.5 px-3 text-right">Browser Est. Downlink / RTT</th>
                      <th className="py-2.5 px-3 text-right">Measured App RTT (Avg / Last)</th>
                      <th className="py-2.5 px-3 text-right">Probes</th>
                      <th className="py-2.5 px-3">Last Sample</th>
                      <th className="py-2.5 px-3 text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {net.activeDeviceSessions.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="py-8 text-center text-slate-500">
                          No active device network sessions recorded in selected window yet.
                        </td>
                      </tr>
                    ) : (
                      net.activeDeviceSessions.map((sess) => (
                        <tr key={sess.sessionId} className="hover:bg-slate-50/70">
                          <td className="py-2 px-3">
                            <div className="font-mono font-semibold text-slate-900">
                              {sess.actorLoginId}
                            </div>
                            <div className="text-[10px] font-mono text-slate-500">
                              {sess.sessionId} • {sess.actorRole}
                            </div>
                          </td>
                          <td className="py-2 px-3 text-slate-700">{sess.userAgentShort}</td>
                          <td className="py-2 px-3 font-mono text-slate-600">
                            {sess.connectionType} / {sess.effectiveType}
                          </td>
                          <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-600">
                            {sess.browserEstimatedDownlinkMbps !== null
                              ? `~${sess.browserEstimatedDownlinkMbps} Mbps`
                              : 'Unavailable'}{' '}
                            •{' '}
                            {sess.browserEstimatedRttMs !== null
                              ? `~${sess.browserEstimatedRttMs} ms`
                              : 'Unavailable'}
                          </td>
                          <td className="py-2 px-3 text-right font-mono tabular-nums font-semibold text-slate-900">
                            {fmtMs(sess.measuredRttAvgMs)} / {fmtMs(sess.measuredRttLastMs)}
                          </td>
                          <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-600">
                            {sess.probeCount}
                          </td>
                          <td className="py-2 px-3 font-mono text-[11px] text-slate-500">
                            {fmtTs(sess.lastSampleAt)}
                          </td>
                          <td className="py-2 px-3 text-right">
                            <StatusBadge status={sess.networkStatus} />
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ====================================================================
          VIEW 3: PERFORMANCE ANALYTICS (Client + Historical Daily/Weekly/Monthly)
          ==================================================================== */}
      {activeSubTab === 'performance' && data && (
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <KpiCard
              label="Frontend JS Errors"
              value={String(data.websitePerf.jsErrorsCount)}
              subtext="window error listener"
              tone={data.websitePerf.jsErrorsCount > 0 ? 'bad' : 'default'}
            />
            <KpiCard
              label="Unhandled Promise Rejections"
              value={String(data.websitePerf.promiseRejectionsCount)}
              subtext="window unhandledrejection"
              tone={data.websitePerf.promiseRejectionsCount > 0 ? 'bad' : 'default'}
            />
            <KpiCard
              label="Client Network / Timeout Errors"
              value={String(data.websitePerf.networkFailuresCount)}
              subtext="executeApiFetch telemetry"
              tone={data.websitePerf.networkFailuresCount > 0 ? 'warn' : 'default'}
            />
          </div>

          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">
                Website &amp; Frontend Timing Breakdown (Real Client Measurements)
              </h2>
              <span className="text-[11px] text-slate-500">
                Zero samples indicate navigation/action has not occurred yet
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold">
                  <tr>
                    <th className="py-2.5 px-3">Client Performance Metric</th>
                    <th className="py-2.5 px-3 text-right">Samples</th>
                    <th className="py-2.5 px-3 text-right">Avg</th>
                    <th className="py-2.5 px-3 text-right">P50</th>
                    <th className="py-2.5 px-3 text-right">P95</th>
                    <th className="py-2.5 px-3 text-right">Max</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  <LatencyMetricRow label="Initial App Load Time" stats={data.websitePerf.initialLoad} />
                  <LatencyMetricRow label="Page / Module Navigation" stats={data.websitePerf.navigation} />
                  <LatencyMetricRow label="Skeleton Visible Duration" stats={data.websitePerf.skeletonDuration} />
                  <LatencyMetricRow label="Route Chunk Prefetch" stats={data.websitePerf.routePrefetch} />
                  <LatencyMetricRow label="Background Data Refresh" stats={data.websitePerf.backgroundRefresh} />
                  <LatencyMetricRow label="Slow Main-Thread Tasks (>=150ms)" stats={data.websitePerf.slowRender} />
                </tbody>
              </table>
            </div>
          </div>

          {/* Historical Daily Rollups */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">
                Historical Daily Rollups (Persisted in monitoring_rollups)
              </h2>
              <span className="text-[11px] font-mono text-slate-500">
                {data.historicalRollups.length} day record(s)
              </span>
            </div>
            {data.historicalRollups.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-500">
                No daily monitoring rollup documents stored yet. Rollups persist automatically as traffic is measured.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold">
                    <tr>
                      <th className="py-2.5 px-3">Date (IST)</th>
                      <th className="py-2.5 px-3">Week / Month</th>
                      <th className="py-2.5 px-3 text-right">API Calls</th>
                      <th className="py-2.5 px-3 text-right">API Errors</th>
                      <th className="py-2.5 px-3 text-right">API Avg / P95</th>
                      <th className="py-2.5 px-3 text-right">QR Punches</th>
                      <th className="py-2.5 px-3 text-right">QR Avg</th>
                      <th className="py-2.5 px-3 text-right">DB Ops</th>
                      <th className="py-2.5 px-3 text-right">Total Errors</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-mono tabular-nums">
                    {data.historicalRollups.map((r, i) => (
                      <tr key={r.dateKey || i} className="hover:bg-slate-50/70">
                        <td className="py-2 px-3 font-semibold text-slate-800">{r.dateKey || '—'}</td>
                        <td className="py-2 px-3 text-slate-500">
                          {r.weekKey || '—'} / {r.monthKey || '—'}
                        </td>
                        <td className="py-2 px-3 text-right">{r.apiTotalCalls ?? 0}</td>
                        <td className="py-2 px-3 text-right text-red-700">{r.apiErrorCount ?? 0}</td>
                        <td className="py-2 px-3 text-right">
                          {fmtMs(r.apiAvgMs)} / {fmtMs(r.apiP95Ms)}
                        </td>
                        <td className="py-2 px-3 text-right">{r.qrTotalPunches ?? 0}</td>
                        <td className="py-2 px-3 text-right">{fmtMs(r.qrAvgMs)}</td>
                        <td className="py-2 px-3 text-right">{r.dbOpsCount ?? 0}</td>
                        <td className="py-2 px-3 text-right">{r.errorCount ?? 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ====================================================================
          VIEW 3: API MONITORING
          ==================================================================== */}
      {activeSubTab === 'api' && data && (
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <KpiCard label="Measured API Calls" value={String(data.apiMonitoring.totalRequests)} />
            <KpiCard
              label="Failed Calls"
              value={String(data.apiMonitoring.failedRequests)}
              tone={data.apiMonitoring.failedRequests > 0 ? 'bad' : 'good'}
            />
            <KpiCard
              label="Timeouts"
              value={String(data.apiMonitoring.timeoutCount)}
              tone={data.apiMonitoring.timeoutCount > 0 ? 'bad' : 'default'}
            />
            <KpiCard label="Avg Latency" value={fmtMs(data.apiMonitoring.summary.avgMs)} />
            <KpiCard label="P95 Latency" value={fmtMs(data.apiMonitoring.summary.p95Ms)} />
          </div>

          {/* Endpoints Summary Table */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">
                Endpoints Performance Summary (Sorted by Slowest P95)
              </h2>
              <span className="text-[11px] font-mono text-slate-500">
                {data.apiMonitoring.endpoints.length} endpoint(s)
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold">
                  <tr>
                    <th className="py-2.5 px-3">Method &amp; Endpoint</th>
                    <th className="py-2.5 px-3 text-right">Calls</th>
                    <th className="py-2.5 px-3 text-right">Errors</th>
                    <th className="py-2.5 px-3 text-right">Avg</th>
                    <th className="py-2.5 px-3 text-right">P50</th>
                    <th className="py-2.5 px-3 text-right">P95</th>
                    <th className="py-2.5 px-3 text-right">Max</th>
                    <th className="py-2.5 px-3 text-right">Last HTTP</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-mono tabular-nums">
                  {data.apiMonitoring.endpoints.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-6 text-center text-slate-500 font-sans">
                        No API endpoint traces recorded in this window.
                      </td>
                    </tr>
                  ) : (
                    data.apiMonitoring.endpoints.map((ep) => (
                      <tr key={`${ep.method}_${ep.endpoint}`} className="hover:bg-slate-50/70">
                        <td className="py-2 px-3 text-slate-900 font-semibold">
                          <span className="text-blue-700 mr-1.5">{ep.method}</span>
                          {ep.endpoint}
                        </td>
                        <td className="py-2 px-3 text-right">{ep.count}</td>
                        <td className="py-2 px-3 text-right text-red-700">{ep.errorCount}</td>
                        <td className="py-2 px-3 text-right">{fmtMs(ep.avgMs)}</td>
                        <td className="py-2 px-3 text-right">{fmtMs(ep.p50Ms)}</td>
                        <td className="py-2 px-3 text-right font-semibold">{fmtMs(ep.p95Ms)}</td>
                        <td className="py-2 px-3 text-right">{fmtMs(ep.maxMs)}</td>
                        <td className="py-2 px-3 text-right">{ep.lastStatus}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Recent Traces (Sanitized, No Auth Headers or Payloads) */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-slate-900">
                Recent HTTP API Traces (Sanitized Metadata Only)
              </h2>
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={apiSearch}
                    onChange={(e) => {
                      setApiSearch(e.target.value);
                      setApiPage(1);
                    }}
                    placeholder="Filter endpoint or correlation ID..."
                    className="pl-8 pr-3 py-1 text-xs border border-slate-300 rounded-lg w-60"
                  />
                </div>
                <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={apiOnlyFailed}
                    onChange={(e) => {
                      setApiOnlyFailed(e.target.checked);
                      setApiPage(1);
                    }}
                    className="rounded border-slate-300"
                  />
                  Failed only
                </label>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold">
                  <tr>
                    <th className="py-2 px-3">Timestamp (IST)</th>
                    <th className="py-2 px-3">Request</th>
                    <th className="py-2 px-3 text-center">HTTP</th>
                    <th className="py-2 px-3 text-right">Duration</th>
                    <th className="py-2 px-3">Category</th>
                    <th className="py-2 px-3">Correlation ID</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-mono tabular-nums">
                  {apiPaged.rows.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-6 text-center text-slate-500 font-sans">
                        No matching API traces found.
                      </td>
                    </tr>
                  ) : (
                    apiPaged.rows.map((t) => (
                      <tr key={t.id} className="hover:bg-slate-50/70">
                        <td className="py-2 px-3 text-slate-500">{fmtTs(t.timestamp)}</td>
                        <td className="py-2 px-3 text-slate-900">
                          <span className="font-semibold text-blue-700 mr-1.5">{t.method}</span>
                          {t.endpoint}
                        </td>
                        <td className="py-2 px-3 text-center">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[11px] font-semibold ${
                              t.success ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'
                            }`}
                          >
                            {t.status}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-right">{fmtMs(t.durationMs)}</td>
                        <td className="py-2 px-3 text-slate-600">{t.errorCategory}</td>
                        <td className="py-2 px-3 text-slate-500">{t.correlationId}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <PaginationBar
              page={apiPaged.safePage}
              totalPages={apiPaged.totalPages}
              totalItems={filteredApiTraces.length}
              onChange={setApiPage}
            />
          </div>
        </div>
      )}

      {/* ====================================================================
          VIEW 4: DATABASE MONITORING
          ==================================================================== */}
      {activeSubTab === 'database' && data && (
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
            <KpiCard
              label="Firestore Status"
              value={data.databaseMonitoring.connectivity}
              subtext={`Probe: ${fmtMs(data.databaseMonitoring.probeLatencyMs)}`}
              tone={data.databaseMonitoring.connectivity === 'Connected' ? 'good' : 'bad'}
            />
            <KpiCard
              label="Measured Reads / Queries"
              value={String(data.databaseMonitoring.measuredReads)}
              subtext="Admin SDK instrumented"
            />
            <KpiCard
              label="Measured Writes / Batches"
              value={String(data.databaseMonitoring.measuredWrites)}
              subtext="Admin SDK instrumented"
            />
            <KpiCard
              label="Transactions (Failed)"
              value={`${data.databaseMonitoring.transactionCount} (${data.databaseMonitoring.failedTransactionCount})`}
              tone={data.databaseMonitoring.failedTransactionCount > 0 ? 'bad' : 'default'}
            />
            <KpiCard
              label="Permission Denied Errors"
              value={String(data.databaseMonitoring.permissionDeniedCount)}
              tone={data.databaseMonitoring.permissionDeniedCount > 0 ? 'bad' : 'good'}
            />
            <KpiCard
              label="DB P95 Latency"
              value={fmtMs(data.databaseMonitoring.p95OpDurationMs)}
              subtext={`Avg ${fmtMs(data.databaseMonitoring.avgOpDurationMs)}`}
            />
          </div>

          {/* Explicit Cloud Billing / Quota Limitation Card (Honest Ground-Truth Disclosure) */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-start gap-3">
              <Info className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" />
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-slate-900">
                    Project-Wide GCP Firestore Billing &amp; Daily Quota Counters
                  </span>
                  <StatusBadge status={data.databaseMonitoring.cloudBillingUsageStatus} />
                </div>
                <p className="text-xs text-slate-600 mt-1">
                  {data.databaseMonitoring.cloudBillingRequirement}
                </p>
              </div>
            </div>
          </div>

          {/* Slow Database Operations (>= 500 ms) */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">
                Slow Firestore Operations (&gt;= 500 ms)
              </h2>
              <span className="text-[11px] font-mono text-slate-500">
                {data.databaseMonitoring.slowOperations.length} slow op(s)
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold">
                  <tr>
                    <th className="py-2 px-3">Timestamp</th>
                    <th className="py-2 px-3">Operation</th>
                    <th className="py-2 px-3">Collection</th>
                    <th className="py-2 px-3 text-right">Docs</th>
                    <th className="py-2 px-3 text-right">Duration</th>
                    <th className="py-2 px-3">Correlation ID</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-mono tabular-nums">
                  {data.databaseMonitoring.slowOperations.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-6 text-center text-slate-500 font-sans">
                        No slow Firestore operations (&gt;= 500 ms) recorded in this window.
                      </td>
                    </tr>
                  ) : (
                    data.databaseMonitoring.slowOperations.map((op) => (
                      <tr key={op.id} className="hover:bg-slate-50/70">
                        <td className="py-2 px-3 text-slate-500">{fmtTs(op.timestamp)}</td>
                        <td className="py-2 px-3 font-semibold text-slate-900">{op.operation}</td>
                        <td className="py-2 px-3 text-slate-700">{op.collection}</td>
                        <td className="py-2 px-3 text-right">{op.recordCount}</td>
                        <td className="py-2 px-3 text-right text-amber-700 font-semibold">
                          {fmtMs(op.durationMs)}
                        </td>
                        <td className="py-2 px-3 text-slate-500">{op.correlationId || '—'}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Bulk & Excel Import/Export Batch Metrics */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">
                Measured Import, Export &amp; Bulk Batch Executions
              </h2>
              <span className="text-[11px] font-mono text-slate-500">
                {data.databaseMonitoring.bulkAndImportBatches.length} batch(es)
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold">
                  <tr>
                    <th className="py-2 px-3">Timestamp</th>
                    <th className="py-2 px-3">Type</th>
                    <th className="py-2 px-3">Module</th>
                    <th className="py-2 px-3">Actor</th>
                    <th className="py-2 px-3 text-right">Rows</th>
                    <th className="py-2 px-3 text-right">Duration</th>
                    <th className="py-2 px-3 text-center">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-mono tabular-nums">
                  {data.databaseMonitoring.bulkAndImportBatches.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-6 text-center text-slate-500 font-sans">
                        No Excel import, export, or bulk batch operations recorded yet.
                      </td>
                    </tr>
                  ) : (
                    data.databaseMonitoring.bulkAndImportBatches.map((b) => (
                      <tr key={b.id} className="hover:bg-slate-50/70">
                        <td className="py-2 px-3 text-slate-500">{fmtTs(b.timestamp)}</td>
                        <td className="py-2 px-3 font-semibold text-slate-800">{b.type}</td>
                        <td className="py-2 px-3 font-sans text-slate-700">{b.module}</td>
                        <td className="py-2 px-3 text-slate-600">{b.actorLoginId}</td>
                        <td className="py-2 px-3 text-right">{b.rowCount}</td>
                        <td className="py-2 px-3 text-right">{fmtMs(b.durationMs)}</td>
                        <td className="py-2 px-3 text-center">
                          <StatusBadge status={b.success ? 'Healthy' : 'Critical'} />
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ====================================================================
          VIEW 5: USER ACTIVITY MONITORING (Live Operational Feed, Separate from Audit Logs)
          ==================================================================== */}
      {activeSubTab === 'activity' && data && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                Live User &amp; Operational Activity Feed
              </h2>
              <p className="text-[11px] text-slate-500">
                Operational navigation &amp; workflow telemetry (kept separate from tamper-evident Compliance Audit Logs).
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={activitySearch}
                  onChange={(e) => {
                    setActivitySearch(e.target.value);
                    setActivityPage(1);
                  }}
                  placeholder="Search user, action, correlation..."
                  className="pl-8 pr-3 py-1 text-xs border border-slate-300 rounded-lg w-56"
                />
              </div>
              <select
                value={activityModuleFilter}
                onChange={(e) => {
                  setActivityModuleFilter(e.target.value);
                  setActivityPage(1);
                }}
                className="text-xs px-2.5 py-1 border border-slate-300 rounded-lg bg-white"
              >
                <option value="ALL">All Modules</option>
                {activityModules.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold">
                <tr>
                  <th className="py-2 px-3">Timestamp (IST)</th>
                  <th className="py-2 px-3">User / Role</th>
                  <th className="py-2 px-3">Module</th>
                  <th className="py-2 px-3">Action</th>
                  <th className="py-2 px-3 text-center">Result</th>
                  <th className="py-2 px-3">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {actPaged.rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-6 text-center text-slate-500">
                      No operational user activity recorded in this window.
                    </td>
                  </tr>
                ) : (
                  actPaged.rows.map((act) => (
                    <tr key={act.id} className="hover:bg-slate-50/70">
                      <td className="py-2 px-3 font-mono text-slate-500 whitespace-nowrap">
                        {fmtTs(act.timestamp)}
                      </td>
                      <td className="py-2 px-3">
                        <span className="font-semibold text-slate-900 font-mono">
                          {act.actorLoginId}
                        </span>{' '}
                        <span className="text-[10px] text-slate-500 font-mono">
                          ({act.actorRole})
                        </span>
                      </td>
                      <td className="py-2 px-3 text-slate-700">{act.module}</td>
                      <td className="py-2 px-3 font-mono font-medium text-slate-800">{act.action}</td>
                      <td className="py-2 px-3 text-center">
                        <StatusBadge status={act.result === 'Success' ? 'Healthy' : 'Critical'} />
                      </td>
                      <td className="py-2 px-3 text-slate-600 max-w-xs truncate">
                        {act.detail || '—'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <PaginationBar
            page={actPaged.safePage}
            totalPages={actPaged.totalPages}
            totalItems={filteredActivities.length}
            onChange={setActivityPage}
          />
        </div>
      )}

      {/* ====================================================================
          VIEW 6: MODULE HEALTH MATRIX (All 14 Enterprise Modules)
          ==================================================================== */}
      {activeSubTab === 'modules' && data && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {data.moduleHealth.map((mod) => (
            <div
              key={mod.module}
              className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col justify-between gap-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">{mod.module}</h3>
                  <p className="text-xs text-slate-500 mt-0.5">{mod.reason}</p>
                </div>
                <StatusBadge status={mod.status} />
              </div>

              <div className="grid grid-cols-3 gap-2 pt-2 border-t border-slate-100 text-xs">
                <div>
                  <div className="text-[10px] text-slate-400 uppercase">Samples</div>
                  <div className="font-mono font-semibold text-slate-800">{mod.sampleCount}</div>
                </div>
                <div>
                  <div className="text-[10px] text-slate-400 uppercase">Errors</div>
                  <div
                    className={`font-mono font-semibold ${
                      mod.errorCount > 0 ? 'text-red-700' : 'text-slate-800'
                    }`}
                  >
                    {mod.errorCount}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-slate-400 uppercase">P95 Latency</div>
                  <div className="font-mono font-semibold text-slate-800">
                    {fmtMs(mod.p95LatencyMs)}
                  </div>
                </div>
              </div>

              <div className="text-[11px] text-slate-400 font-mono flex items-center justify-between pt-1">
                <span>Last activity: {mod.lastActivityAt ? fmtTs(mod.lastActivityAt) : 'None'}</span>
                {mod.lastErrorAt && (
                  <span className="text-red-600">Last err: {fmtTs(mod.lastErrorAt)}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ====================================================================
          VIEW 7: ERROR & FAILURE LOGS
          ==================================================================== */}
      {activeSubTab === 'errors' && data && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-slate-900">
              Runtime Errors, Exceptions &amp; Failure Trace Viewer
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={errSearch}
                  onChange={(e) => {
                    setErrSearch(e.target.value);
                    setErrPage(1);
                  }}
                  placeholder="Search message or correlation..."
                  className="pl-8 pr-3 py-1 text-xs border border-slate-300 rounded-lg w-56"
                />
              </div>
              <select
                value={errSourceFilter}
                onChange={(e) => {
                  setErrSourceFilter(e.target.value);
                  setErrPage(1);
                }}
                className="text-xs px-2.5 py-1 border border-slate-300 rounded-lg bg-white"
              >
                <option value="ALL">All Sources</option>
                <option value="BACKEND">BACKEND</option>
                <option value="FRONTEND">FRONTEND</option>
                <option value="DATABASE">DATABASE</option>
                <option value="QR">QR</option>
                <option value="IMPORT_EXPORT">IMPORT_EXPORT</option>
                <option value="BULK">BULK</option>
                <option value="AUTH">AUTH</option>
              </select>
              <select
                value={errSeverityFilter}
                onChange={(e) => {
                  setErrSeverityFilter(e.target.value);
                  setErrPage(1);
                }}
                className="text-xs px-2.5 py-1 border border-slate-300 rounded-lg bg-white"
              >
                <option value="ALL">All Severities</option>
                <option value="CRITICAL">CRITICAL</option>
                <option value="WARNING">WARNING</option>
              </select>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold">
                <tr>
                  <th className="py-2 px-3">Timestamp (IST)</th>
                  <th className="py-2 px-3">Source / Module</th>
                  <th className="py-2 px-3">Severity</th>
                  <th className="py-2 px-3">Category</th>
                  <th className="py-2 px-3">Sanitized Message</th>
                  <th className="py-2 px-3">Correlation ID</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {errPaged.rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-6 text-center text-slate-500">
                      No runtime errors or failures recorded in this filter window.
                    </td>
                  </tr>
                ) : (
                  errPaged.rows.map((errItem) => (
                    <tr key={errItem.id} className="hover:bg-slate-50/70">
                      <td className="py-2 px-3 font-mono text-slate-500 whitespace-nowrap">
                        {fmtTs(errItem.timestamp)}
                      </td>
                      <td className="py-2 px-3">
                        <div className="font-mono font-semibold text-slate-800">
                          {errItem.source}
                        </div>
                        <div className="text-[11px] text-slate-500">{errItem.module}</div>
                      </td>
                      <td className="py-2 px-3">
                        <StatusBadge status={errItem.severity} />
                      </td>
                      <td className="py-2 px-3 font-mono text-slate-700">
                        {errItem.category}
                        {errItem.statusCode ? ` (${errItem.statusCode})` : ''}
                      </td>
                      <td className="py-2 px-3 text-slate-800 max-w-md break-words">
                        {errItem.message}
                      </td>
                      <td className="py-2 px-3 font-mono text-slate-500">
                        {errItem.correlationId || '—'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <PaginationBar
            page={errPaged.safePage}
            totalPages={errPaged.totalPages}
            totalItems={filteredErrors.length}
            onChange={setErrPage}
          />
        </div>
      )}

      {/* ====================================================================
          VIEW 8: ALERTS & THRESHOLD CONFIGURATION
          ==================================================================== */}
      {activeSubTab === 'alerts' && data && (
        <div className="flex flex-col gap-5">
          <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {(['ALL', 'ACTIVE', 'ACKNOWLEDGED', 'RESOLVED'] as const).map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setAlertFilterStatus(st)}
                  className={`px-3 py-1 rounded-lg text-xs font-medium cursor-pointer ${
                    alertFilterStatus === st
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {st}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setShowThresholdPanel((prev) => !prev)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              {showThresholdPanel ? 'Hide Alert Thresholds' : 'Configure Alert Thresholds'}
            </button>
          </div>

          {showThresholdPanel && thresholdDraft && (
            <form
              onSubmit={handleSaveThresholds}
              className="bg-white border border-slate-200 rounded-xl p-4 space-y-4"
            >
              <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
                <h3 className="text-sm font-semibold text-slate-900">
                  Live Alert Thresholds &amp; Retention Policy
                </h3>
                <span className="text-[11px] text-slate-500">
                  Saved in monitoring_config/thresholds (Audit Logged)
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 text-xs">
                <ThresholdInput
                  label="API P95 Warning (ms)"
                  value={thresholdDraft.apiP95WarningMs}
                  min={100}
                  max={30000}
                  onChange={(v) =>
                    setThresholdDraft((prev) => (prev ? { ...prev, apiP95WarningMs: v } : prev))
                  }
                />
                <ThresholdInput
                  label="API Error Rate (%)"
                  value={thresholdDraft.apiErrorRateWarningPct}
                  min={1}
                  max={100}
                  onChange={(v) =>
                    setThresholdDraft((prev) =>
                      prev ? { ...prev, apiErrorRateWarningPct: v } : prev
                    )
                  }
                />
                <ThresholdInput
                  label="QR Punch Avg Warn (ms)"
                  value={thresholdDraft.qrPunchAvgWarningMs}
                  min={100}
                  max={30000}
                  onChange={(v) =>
                    setThresholdDraft((prev) => (prev ? { ...prev, qrPunchAvgWarningMs: v } : prev))
                  }
                />
                <ThresholdInput
                  label="QR Failure Spike (cnt)"
                  value={thresholdDraft.qrFailureSpikeCount}
                  min={1}
                  max={500}
                  onChange={(v) =>
                    setThresholdDraft((prev) => (prev ? { ...prev, qrFailureSpikeCount: v } : prev))
                  }
                />
                <ThresholdInput
                  label="Alert Cooldown (min)"
                  value={thresholdDraft.alertCooldownMinutes}
                  min={1}
                  max={1440}
                  onChange={(v) =>
                    setThresholdDraft((prev) =>
                      prev ? { ...prev, alertCooldownMinutes: v } : prev
                    )
                  }
                />
              </div>
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={isSavingThresholds}
                  className="px-4 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 disabled:opacity-50 cursor-pointer"
                >
                  {isSavingThresholds ? 'Saving...' : 'Save Thresholds'}
                </button>
              </div>
            </form>
          )}

          <div className="space-y-3">
            {filteredAlerts.length === 0 ? (
              <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-xs text-slate-500">
                No alerts match the selected filter.
              </div>
            ) : (
              filteredAlerts.map((alert: MonitoringAlertItem) => (
                <div
                  key={alert.groupKey}
                  className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                >
                  <div className="space-y-1.5 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={alert.severity} />
                      <StatusBadge status={alert.status} />
                      <span className="text-sm font-semibold text-slate-900">{alert.title}</span>
                      <span className="text-[11px] font-mono bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded">
                        x{alert.occurrenceCount}
                      </span>
                    </div>
                    <p className="text-xs text-slate-600">{alert.description}</p>
                    <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono text-slate-500">
                      <span>Module: {alert.module}</span>
                      <span>Op: {alert.affectedOperation}</span>
                      <span>First: {fmtTs(alert.firstTriggeredAt)}</span>
                      <span>Last: {fmtTs(alert.lastTriggeredAt)}</span>
                      {alert.acknowledgedBy && <span>Ack by {alert.acknowledgedBy}</span>}
                      {alert.resolvedBy && <span>Resolved by {alert.resolvedBy}</span>}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {alert.status === 'ACTIVE' && (
                      <button
                        type="button"
                        disabled={busyAlertKey === alert.groupKey}
                        onClick={() => void handleAlertAction(alert.groupKey, 'ACKNOWLEDGE')}
                        className="px-2.5 py-1.5 rounded-lg border border-amber-300 bg-amber-50 text-amber-800 text-xs font-semibold hover:bg-amber-100 disabled:opacity-50 cursor-pointer"
                      >
                        Acknowledge
                      </button>
                    )}
                    {alert.status !== 'RESOLVED' ? (
                      <button
                        type="button"
                        disabled={busyAlertKey === alert.groupKey}
                        onClick={() => void handleAlertAction(alert.groupKey, 'RESOLVE')}
                        className="px-2.5 py-1.5 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-800 text-xs font-semibold hover:bg-emerald-100 disabled:opacity-50 cursor-pointer"
                      >
                        Resolve
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busyAlertKey === alert.groupKey}
                        onClick={() => void handleAlertAction(alert.groupKey, 'REOPEN')}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-700 text-xs font-semibold hover:bg-slate-50 disabled:opacity-50 cursor-pointer"
                      >
                        <RotateCcw className="w-3 h-3" />
                        Reopen
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const ThresholdInput: React.FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (val: number) => void;
}> = ({ label, value, min, max, onChange }) => (
  <label className="flex flex-col gap-1">
    <span className="font-medium text-slate-700">{label}</span>
    <input
      type="number"
      min={min}
      max={max}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="px-2.5 py-1.5 border border-slate-300 rounded-lg font-mono text-slate-900"
    />
  </label>
);

const PaginationBar: React.FC<{
  page: number;
  totalPages: number;
  totalItems: number;
  onChange: (nextPage: number) => void;
}> = ({ page, totalPages, totalItems, onChange }) => (
  <div className="px-4 py-2.5 border-t border-slate-200 bg-slate-50 flex items-center justify-between text-xs text-slate-600">
    <span className="font-mono">
      {totalItems} record(s) • Page {page} of {totalPages}
    </span>
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
        className="p-1 rounded border border-slate-300 bg-white disabled:opacity-40 cursor-pointer"
        aria-label="Previous page"
      >
        <ChevronLeft className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        disabled={page >= totalPages}
        onClick={() => onChange(page + 1)}
        className="p-1 rounded border border-slate-300 bg-white disabled:opacity-40 cursor-pointer"
        aria-label="Next page"
      >
        <ChevronRight className="w-3.5 h-3.5" />
      </button>
    </div>
  </div>
);

export default SystemPerformance;
