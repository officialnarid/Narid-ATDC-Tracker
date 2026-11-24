import React, { useState, useEffect, useCallback } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Copy,
  Check,
  Database,
  Download,
  Eye,
  FileSpreadsheet,
  Filter,
  GitBranch,
  Globe,
  RefreshCw,
  RotateCcw,
  Search,
  ServerCrash,
  ShieldAlert,
  Wrench,
  X,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import {
  ERROR_CODE_REGISTRY,
  type ErrorResolutionStatus,
  type NormalizedAppError,
  type TechnicalErrorLogRecord,
} from '../utils/errorRegistry';
import {
  type TechnicalErrorKpis,
  type TechnicalErrorQueryFilters,
  copyReferenceIdToClipboard,
  fetchRequestTrace,
  fetchTechnicalErrorLogs,
  handleAppError,
  updateTechnicalErrorStatus,
} from '../services/errorHandlingService';
import { exportTableToCsv, exportTableToExcel } from '../services/exportService';
import { SafeErrorBanner } from './SafeErrorBanner';

const EMPTY_KPIS: TechnicalErrorKpis = {
  totalErrors: 0,
  totalOccurrences: 0,
  networkErrors: 0,
  databaseErrors: 0,
  apiErrors: 0,
  authErrors: 0,
  unresolvedErrors: 0,
  resolvedErrors: 0,
};

const ERROR_CODE_LIST = Object.keys(ERROR_CODE_REGISTRY);

function statusBadgeStyle(status: ErrorResolutionStatus): string {
  if (status === 'RESOLVED') return 'bg-emerald-100 text-emerald-800 border-emerald-200';
  if (status === 'INVESTIGATING') return 'bg-amber-100 text-amber-800 border-amber-200';
  return 'bg-red-100 text-red-800 border-red-200';
}

function confidenceBadgeStyle(conf: TechnicalErrorLogRecord['rootCauseConfidence']): string {
  if (conf === 'CONFIRMED') return 'bg-blue-100 text-blue-800 border-blue-200';
  if (conf === 'SUSPECTED') return 'bg-amber-100 text-amber-800 border-amber-200';
  return 'bg-slate-100 text-slate-700 border-slate-200';
}

function confidenceLabel(conf: TechnicalErrorLogRecord['rootCauseConfidence']): string {
  if (conf === 'CONFIRMED') return 'Confirmed Root Cause';
  if (conf === 'SUSPECTED') return 'Suspected Root Cause';
  return 'Unknown Root Cause';
}

export const TechnicalErrorLogs: React.FC = () => {
  const [records, setRecords] = useState<TechnicalErrorLogRecord[]>([]);
  const [kpis, setKpis] = useState<TechnicalErrorKpis>(EMPTY_KPIS);
  const [availableModules, setAvailableModules] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<NormalizedAppError | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  const [filters, setFilters] = useState<TechnicalErrorQueryFilters>({
    search: '',
    requestId: '',
    errorCode: 'ALL',
    category: 'ALL',
    module: 'ALL',
    userId: '',
    role: 'ALL',
    status: 'ALL',
    from: '',
    to: '',
    page: 1,
    pageSize: 25,
  });
  const [totalFiltered, setTotalFiltered] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  // Quick Request ID Trace Search
  const [traceQuery, setTraceQuery] = useState('');
  const [traceLoading, setTraceLoading] = useState(false);
  const [traceResult, setTraceResult] = useState<{
    referenceId: string;
    records: TechnicalErrorLogRecord[];
  } | null>(null);

  // Detail & Resolution Modal
  const [selectedRecord, setSelectedRecord] = useState<TechnicalErrorLogRecord | null>(null);
  const [resolutionNotesDraft, setResolutionNotesDraft] = useState('');
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const loadLogs = useCallback(async (overrideFilters?: TechnicalErrorQueryFilters) => {
    const active = overrideFilters || filters;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetchTechnicalErrorLogs(active);
      setRecords(res.errors || []);
      setKpis(res.kpis || EMPTY_KPIS);
      setAvailableModules(res.availableModules || []);
      setTotalFiltered(res.pagination?.totalFiltered ?? 0);
      setTotalPages(res.pagination?.totalPages ?? 1);
    } catch (err) {
      setLoadError(
        handleAppError(err, {
          moduleName: 'Technical Error Logs',
          endpoint: '/api/diagnostics/errors',
          reportToServer: false,
        })
      );
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void loadLogs();
  }, [
    filters.errorCode,
    filters.category,
    filters.module,
    filters.role,
    filters.status,
    filters.page,
    filters.pageSize,
  ]);

  const handleApplyFilters = (e: React.FormEvent) => {
    e.preventDefault();
    const next = { ...filters, page: 1 };
    setFilters(next);
    void loadLogs(next);
  };

  const handleResetFilters = () => {
    const reset: TechnicalErrorQueryFilters = {
      search: '',
      requestId: '',
      errorCode: 'ALL',
      category: 'ALL',
      module: 'ALL',
      userId: '',
      role: 'ALL',
      status: 'ALL',
      from: '',
      to: '',
      page: 1,
      pageSize: 25,
    };
    setFilters(reset);
    setTraceResult(null);
    setTraceQuery('');
    void loadLogs(reset);
  };

  const handleLookupTrace = async (e?: React.FormEvent, explicitRef?: string) => {
    e?.preventDefault();
    const target = (explicitRef ?? traceQuery).trim();
    if (!target) return;
    setTraceLoading(true);
    setLoadError(null);
    try {
      const res = await fetchRequestTrace(target);
      setTraceResult({ referenceId: res.referenceId, records: res.records || [] });
    } catch (err) {
      setLoadError(
        handleAppError(err, {
          moduleName: 'Technical Error Logs',
          endpoint: '/api/diagnostics/trace',
          reportToServer: false,
        })
      );
    } finally {
      setTraceLoading(false);
    }
  };

  const handleCopyId = async (id: string) => {
    const ok = await copyReferenceIdToClipboard(id);
    if (ok) {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1800);
    }
  };

  const handleOpenDetail = (rec: TechnicalErrorLogRecord) => {
    setSelectedRecord(rec);
    setResolutionNotesDraft(rec.resolutionNotes || '');
  };

  const handleUpdateStatus = async (nextStatus: ErrorResolutionStatus) => {
    if (!selectedRecord) return;
    setUpdatingStatus(true);
    setLoadError(null);
    try {
      const res = await updateTechnicalErrorStatus(selectedRecord.errorId, {
        resolutionStatus: nextStatus,
        resolutionNotes: resolutionNotesDraft,
      });
      setSelectedRecord(res.errorRecord);
      setRecords((prev) =>
        prev.map((r) => (r.errorId === res.errorRecord.errorId ? res.errorRecord : r))
      );
      if (traceResult) {
        setTraceResult({
          ...traceResult,
          records: traceResult.records.map((r) =>
            r.errorId === res.errorRecord.errorId ? res.errorRecord : r
          ),
        });
      }
      setActionSuccess(`Error ${res.errorRecord.errorCode} (${res.errorRecord.referenceId}) marked as ${nextStatus}.`);
      setTimeout(() => setActionSuccess(null), 3500);
      void loadLogs();
    } catch (err) {
      setLoadError(
        handleAppError(err, {
          moduleName: 'Technical Error Logs',
          endpoint: '/api/diagnostics/errors/status',
          reportToServer: false,
        })
      );
    } finally {
      setUpdatingStatus(false);
    }
  };

  const handleExport = async (format: 'csv' | 'xlsx') => {
    if (records.length === 0) return;
    try {
      const columns = [
        { header: 'Error ID', key: 'errorId' },
        { header: 'Reference ID', key: 'referenceId' },
        { header: 'ID Source', key: 'referenceIdSource' },
        { header: 'Error Code', key: 'errorCode' },
        { header: 'Category', key: 'errorCategoryLabel' },
        { header: 'First Seen (IST)', key: 'timestampIst' },
        { header: 'First Seen (UTC)', key: 'timestampUtc' },
        { header: 'Last Seen (IST)', key: 'lastSeenAtIst' },
        { header: 'Occurrences', key: 'occurrenceCount' },
        { header: 'Module', key: 'moduleName' },
        { header: 'API Endpoint', key: 'apiEndpoint' },
        { header: 'HTTP Status', key: 'httpStatus' },
        { header: 'User Login', key: 'affectedUserLoginId' },
        { header: 'User UID', key: 'affectedUserUid' },
        { header: 'Role', key: 'userRole' },
        { header: 'Root Cause Confidence', key: 'rootCauseConfidence' },
        { header: 'Root Cause Details', key: 'rootCauseDetails' },
        { header: 'Technical Message (Sanitized)', key: 'technicalMessage' },
        { header: 'Network Class', key: 'networkFailureClass' },
        { header: 'DB Class', key: 'dbFailureClass' },
        { header: 'DB Operation', key: 'dbOperationCategory' },
        { header: 'Retry Count', key: 'retryCount' },
        { header: 'Resolution Status', key: 'resolutionStatus' },
        { header: 'Resolved By', key: 'resolvedBy' },
        { header: 'Resolution Notes', key: 'resolutionNotes' },
      ];
      const rows = records.map((r) => ({
        errorId: r.errorId,
        referenceId: r.referenceId,
        referenceIdSource: r.referenceIdSource === 'backend' ? 'Backend Request ID' : 'Frontend Event ID',
        errorCode: r.errorCode,
        errorCategoryLabel: r.errorCategoryLabel,
        timestampIst: r.timestampIst,
        timestampUtc: r.timestampUtc,
        lastSeenAtIst: r.lastSeenAtIst,
        occurrenceCount: r.occurrenceCount,
        moduleName: r.moduleName,
        apiEndpoint: r.apiEndpoint,
        httpStatus: r.httpStatus ?? '--',
        affectedUserLoginId: r.affectedUserLoginId,
        affectedUserUid: r.affectedUserUid,
        userRole: r.userRole,
        rootCauseConfidence: r.rootCauseConfidence,
        rootCauseDetails: r.rootCauseDetails,
        technicalMessage: r.technicalMessage,
        networkFailureClass: r.networkFailureClass,
        dbFailureClass: r.dbFailureClass,
        dbOperationCategory: r.dbOperationCategory || '--',
        retryCount: r.retryCount,
        resolutionStatus: r.resolutionStatus,
        resolvedBy: r.resolvedBy || '--',
        resolutionNotes: r.resolutionNotes || '--',
      }));
      const baseName = `NARID_Technical_Error_Logs_${new Date().toISOString().slice(0, 10)}`;
      if (format === 'xlsx') {
        await exportTableToExcel(rows, columns, baseName);
      } else {
        exportTableToCsv(rows, columns, baseName);
      }
      setActionSuccess(`Exported ${rows.length} sanitized diagnostic record(s) to ${format.toUpperCase()}.`);
      setTimeout(() => setActionSuccess(null), 3500);
    } catch (err) {
      setLoadError(
        handleAppError(err, {
          moduleName: 'Technical Error Logs',
          operation: 'Export Diagnostics',
          reportToServer: false,
        })
      );
    }
  };

  return (
    <div className="space-y-4">
      {loadError && (
        <SafeErrorBanner
          error={loadError}
          onRetry={() => void loadLogs()}
          onDismiss={() => setLoadError(null)}
        />
      )}

      {actionSuccess && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-xl px-4 py-2.5 text-xs font-semibold flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
          <span>{actionSuccess}</span>
        </div>
      )}

      {/* 7 Diagnostic KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
        {[
          { label: 'Total Errors', value: kpis.totalErrors, sub: `${kpis.totalOccurrences} occurrences`, icon: AlertTriangle, tone: 'text-slate-900' },
          { label: 'Network Errors', value: kpis.networkErrors, sub: 'NET-001 / NET-002', icon: Globe, tone: 'text-blue-700' },
          { label: 'Database Errors', value: kpis.databaseErrors, sub: 'DB-001 / DB-002', icon: Database, tone: 'text-indigo-700' },
          { label: 'API / Sys Errors', value: kpis.apiErrors, sub: 'API-001 / SYS-*', icon: ServerCrash, tone: 'text-purple-700' },
          { label: 'Auth / Perm', value: kpis.authErrors, sub: 'AUTH-* / PERM-001', icon: ShieldAlert, tone: 'text-rose-700' },
          { label: 'Unresolved', value: kpis.unresolvedErrors, sub: 'Open / Investigating', icon: Clock, tone: 'text-amber-700' },
          { label: 'Resolved', value: kpis.resolvedErrors, sub: 'Closed with notes', icon: CheckCircle2, tone: 'text-emerald-700' },
        ].map((card) => {
          const Icon = card.icon;
          return (
            <div key={card.label} className="bg-white rounded-xl border border-slate-200 p-3.5 shadow-2xs">
              <div className="flex items-center justify-between text-[11px] font-semibold text-slate-500">
                <span className="truncate">{card.label}</span>
                <Icon className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              </div>
              <div className={`text-xl font-extrabold font-mono mt-1 ${card.tone}`}>{card.value}</div>
              <div className="text-[10px] text-slate-400 truncate mt-0.5">{card.sub}</div>
            </div>
          );
        })}
      </div>

      {/* Dedicated Request ID / Reference Trace Lookup Bar */}
      <form
        onSubmit={(e) => void handleLookupTrace(e)}
        className="bg-[#0a192f] text-white rounded-xl p-4 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-3"
      >
        <div className="flex items-start gap-2.5">
          <GitBranch className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
          <div>
            <div className="text-xs font-bold tracking-wide uppercase text-cyan-300">
              Request ID &amp; Error Event Traceability Search
            </div>
            <p className="text-[11px] text-slate-300 mt-0.5">
              Enter any user-shared Reference ID (e.g. <span className="font-mono text-white">REQ-20261123-A8F91C2D4E7B</span> or{' '}
              <span className="font-mono text-white">ERR-...</span>) to view the chronological request trace and root cause.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 w-full md:w-auto">
          <input
            type="text"
            value={traceQuery}
            onChange={(e) => setTraceQuery(e.target.value)}
            placeholder="Paste Reference / Request ID..."
            className="flex-1 md:w-72 bg-slate-900/90 border border-slate-700 text-white placeholder:text-slate-400 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-cyan-400"
          />
          <button
            type="submit"
            disabled={traceLoading || !traceQuery.trim()}
            className="bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs px-4 py-2 rounded-lg transition disabled:opacity-50 cursor-pointer shrink-0"
          >
            {traceLoading ? 'Tracing...' : 'Trace Request'}
          </button>
        </div>
      </form>

      {/* Request Trace Chronological Panel (when a trace search was executed) */}
      {traceResult && (
        <div className="bg-white rounded-xl border-2 border-cyan-500/40 p-4 shadow-sm space-y-3">
          <div className="flex items-center justify-between gap-2 border-b border-slate-100 pb-2.5">
            <div className="flex items-center gap-2 text-xs">
              <GitBranch className="w-4 h-4 text-cyan-600" />
              <span className="font-bold text-slate-900">
                Chronological Trace for{' '}
                <span className="font-mono text-cyan-700">{traceResult.referenceId}</span>
              </span>
              <span className="px-2 py-0.5 rounded bg-cyan-50 text-cyan-800 border border-cyan-200 font-mono text-[10px] font-bold">
                {traceResult.records.length} matching log(s)
              </span>
            </div>
            <button
              type="button"
              onClick={() => setTraceResult(null)}
              className="text-slate-400 hover:text-slate-700 p-1 rounded cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {traceResult.records.length === 0 ? (
            <div className="text-xs text-slate-500 py-4 text-center">
              No diagnostic error records matched Reference ID <span className="font-mono font-bold">{traceResult.referenceId}</span>.
            </div>
          ) : (
            <div className="space-y-2">
              {traceResult.records.map((rec, idx) => (
                <div
                  key={rec.errorId}
                  className="border border-slate-200 rounded-lg p-3 bg-slate-50/70 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
                >
                  <div className="space-y-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[10px] font-bold bg-slate-800 text-white px-1.5 py-0.5 rounded">
                        #{idx + 1}
                      </span>
                      <span className="font-mono font-bold text-red-700">{rec.errorCode}</span>
                      <span className="font-semibold text-slate-800">{rec.moduleName}</span>
                      <span className="font-mono text-[11px] text-slate-500">{rec.apiEndpoint}</span>
                      <span className={`px-1.5 py-0.5 rounded border text-[10px] font-bold ${confidenceBadgeStyle(rec.rootCauseConfidence)}`}>
                        {confidenceLabel(rec.rootCauseConfidence)}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-700 font-mono truncate">{rec.technicalMessage}</div>
                    <div className="text-[10px] text-slate-500">
                      IST: {rec.timestampIst} | UTC: {rec.timestampUtc} | User: {rec.affectedUserLoginId} ({rec.userRole})
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleOpenDetail(rec)}
                    className="px-3 py-1.5 rounded-lg bg-white hover:bg-blue-50 border border-slate-300 text-blue-700 font-semibold text-xs inline-flex items-center gap-1.5 shrink-0 cursor-pointer"
                  >
                    <Eye className="w-3.5 h-3.5" />
                    <span>Inspect Full Trace</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Filters & Export Toolbar */}
      <form
        onSubmit={handleApplyFilters}
        className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs space-y-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs font-bold text-slate-700">
            <Filter className="w-3.5 h-3.5 text-blue-600" />
            <span>Diagnostic Filters</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void loadLogs()}
              disabled={loading}
              className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>
            <button
              type="button"
              onClick={() => void handleExport('csv')}
              disabled={records.length === 0}
              className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-40 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export CSV</span>
            </button>
            <button
              type="button"
              onClick={() => void handleExport('xlsx')}
              disabled={records.length === 0}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-40 cursor-pointer"
            >
              <FileSpreadsheet className="w-3.5 h-3.5" />
              <span>Export Excel</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 text-xs">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
            <input
              type="text"
              value={filters.search || ''}
              onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
              placeholder="Search Request ID, code, message..."
              className="w-full pl-8 pr-3 py-2 border border-slate-300 rounded-lg text-xs"
            />
          </div>

          <select
            value={filters.errorCode || 'ALL'}
            onChange={(e) => setFilters((f) => ({ ...f, errorCode: e.target.value, page: 1 }))}
            className="border border-slate-300 rounded-lg px-2.5 py-2 text-xs bg-white"
          >
            <option value="ALL">All Error Codes</option>
            {ERROR_CODE_LIST.map((code) => (
              <option key={code} value={code}>
                {code} — {ERROR_CODE_REGISTRY[code as keyof typeof ERROR_CODE_REGISTRY].categoryLabel}
              </option>
            ))}
          </select>

          <select
            value={filters.category || 'ALL'}
            onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value, page: 1 }))}
            className="border border-slate-300 rounded-lg px-2.5 py-2 text-xs bg-white"
          >
            <option value="ALL">All Categories</option>
            <option value="NETWORK">Network</option>
            <option value="DATABASE">Database</option>
            <option value="AUTH">Authentication</option>
            <option value="PERMISSION">Permission</option>
            <option value="API">API</option>
            <option value="SYSTEM">System</option>
            <option value="FILE">File Upload/Download</option>
            <option value="QR">QR Scanning</option>
            <option value="ATTENDANCE">Attendance</option>
            <option value="VALIDATION">Validation</option>
            <option value="UNKNOWN">Unknown</option>
          </select>

          <select
            value={filters.status || 'ALL'}
            onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value, page: 1 }))}
            className="border border-slate-300 rounded-lg px-2.5 py-2 text-xs bg-white"
          >
            <option value="ALL">All Resolution Statuses</option>
            <option value="OPEN">Open</option>
            <option value="INVESTIGATING">Investigating</option>
            <option value="RESOLVED">Resolved</option>
          </select>

          <select
            value={filters.module || 'ALL'}
            onChange={(e) => setFilters((f) => ({ ...f, module: e.target.value, page: 1 }))}
            className="border border-slate-300 rounded-lg px-2.5 py-2 text-xs bg-white"
          >
            <option value="ALL">All Modules</option>
            {availableModules.map((mod) => (
              <option key={mod} value={mod}>
                {mod}
              </option>
            ))}
          </select>

          <input
            type="text"
            value={filters.userId || ''}
            onChange={(e) => setFilters((f) => ({ ...f, userId: e.target.value }))}
            placeholder="Filter by User Login / UID"
            className="border border-slate-300 rounded-lg px-2.5 py-2 text-xs"
          />

          <select
            value={filters.role || 'ALL'}
            onChange={(e) => setFilters((f) => ({ ...f, role: e.target.value, page: 1 }))}
            className="border border-slate-300 rounded-lg px-2.5 py-2 text-xs bg-white"
          >
            <option value="ALL">All Roles</option>
            <option value="SUPER_ADMIN">SUPER_ADMIN</option>
            <option value="ADMIN">ADMIN</option>
            <option value="USER">USER</option>
            <option value="ANONYMOUS">ANONYMOUS</option>
          </select>

          <div className="flex items-center gap-1.5">
            <input
              type="date"
              value={filters.from || ''}
              onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
              title="From date"
              className="w-full border border-slate-300 rounded-lg px-2 py-2 text-xs"
            />
            <input
              type="date"
              value={filters.to || ''}
              onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
              title="To date"
              className="w-full border border-slate-300 rounded-lg px-2 py-2 text-xs"
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={handleResetFilters}
            className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 text-xs font-semibold inline-flex items-center gap-1 cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset</span>
          </button>
          <button
            type="submit"
            className="px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold cursor-pointer"
          >
            Apply Filters
          </button>
        </div>
      </form>

      {/* Diagnostic Logs Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-600 uppercase font-semibold border-b border-slate-200 text-[11px]">
              <tr>
                <th className="py-2.5 px-3">Timestamp (IST / UTC)</th>
                <th className="py-2.5 px-3">Code &amp; Category</th>
                <th className="py-2.5 px-3">Reference / Request ID</th>
                <th className="py-2.5 px-3">Module &amp; Endpoint</th>
                <th className="py-2.5 px-3">User / Role</th>
                <th className="py-2.5 px-3">Root Cause &amp; Count</th>
                <th className="py-2.5 px-3">Status</th>
                <th className="py-2.5 px-3 text-right">Inspect</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && records.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-10 text-center text-slate-400">
                    Loading technical diagnostic logs...
                  </td>
                </tr>
              ) : records.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-10 text-center text-slate-400">
                    No technical error logs match the selected filters.
                  </td>
                </tr>
              ) : (
                records.map((rec) => (
                  <tr key={rec.errorId} className="hover:bg-slate-50/90 transition">
                    <td className="py-2.5 px-3 font-mono text-[11px] whitespace-nowrap">
                      <div className="font-semibold text-slate-800">{rec.lastSeenAtIst || rec.timestampIst}</div>
                      <div className="text-[10px] text-slate-400">{rec.lastSeenAtUtc || rec.timestampUtc}</div>
                    </td>
                    <td className="py-2.5 px-3 whitespace-nowrap">
                      <span className="font-mono font-bold text-red-700 bg-red-50 border border-red-200 px-1.5 py-0.5 rounded text-[11px]">
                        {rec.errorCode}
                      </span>
                      <div className="text-[11px] font-medium text-slate-700 mt-1">{rec.errorCategoryLabel}</div>
                    </td>
                    <td className="py-2.5 px-3 font-mono text-[11px] whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setTraceQuery(rec.referenceId);
                            void handleLookupTrace(undefined, rec.referenceId);
                          }}
                          className="text-blue-700 hover:underline font-semibold cursor-pointer"
                          title="Trace all related logs for this Reference ID"
                        >
                          {rec.referenceId}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleCopyId(rec.referenceId)}
                          className="text-slate-400 hover:text-slate-700 cursor-pointer"
                          title="Copy Reference ID"
                        >
                          {copiedId === rec.referenceId ? (
                            <Check className="w-3 h-3 text-emerald-600" />
                          ) : (
                            <Copy className="w-3 h-3" />
                          )}
                        </button>
                      </div>
                      <div className="text-[10px] text-slate-400 mt-0.5">
                        {rec.referenceIdSource === 'backend' ? 'Backend Request ID' : 'Frontend Event ID'}
                      </div>
                    </td>
                    <td className="py-2.5 px-3 max-w-[220px]">
                      <div className="font-semibold text-slate-800 truncate">{rec.moduleName}</div>
                      <div className="font-mono text-[10px] text-slate-500 truncate" title={rec.apiEndpoint}>
                        {rec.apiEndpoint} {rec.httpStatus ? `(HTTP ${rec.httpStatus})` : ''}
                      </div>
                    </td>
                    <td className="py-2.5 px-3 font-mono text-[11px] whitespace-nowrap">
                      <div className="font-semibold text-slate-800">{rec.affectedUserLoginId}</div>
                      <div className="text-[10px] text-slate-500">{rec.userRole}</div>
                    </td>
                    <td className="py-2.5 px-3 max-w-[260px]">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span
                          className={`px-1.5 py-0.5 rounded border text-[10px] font-bold ${confidenceBadgeStyle(
                            rec.rootCauseConfidence
                          )}`}
                        >
                          {confidenceLabel(rec.rootCauseConfidence)}
                        </span>
                        {rec.occurrenceCount > 1 && (
                          <span className="px-1.5 py-0.5 rounded bg-slate-800 text-white font-mono text-[10px] font-bold">
                            ×{rec.occurrenceCount}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-600 truncate mt-1" title={rec.rootCauseDetails}>
                        {rec.rootCauseDetails}
                      </div>
                    </td>
                    <td className="py-2.5 px-3 whitespace-nowrap">
                      <span
                        className={`px-2 py-0.5 rounded border text-[10px] font-bold ${statusBadgeStyle(
                          rec.resolutionStatus
                        )}`}
                      >
                        {rec.resolutionStatus}
                      </span>
                    </td>
                    <td className="py-2.5 px-3 text-right whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => handleOpenDetail(rec)}
                        className="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-blue-600 hover:text-white text-slate-700 font-semibold text-[11px] inline-flex items-center gap-1 transition cursor-pointer"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        <span>Details</span>
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="px-4 py-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-600">
          <div>
            Showing <strong>{records.length}</strong> of <strong>{totalFiltered}</strong> diagnostic record(s)
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={(filters.page || 1) <= 1}
              onClick={() => setFilters((f) => ({ ...f, page: Math.max(1, (f.page || 1) - 1) }))}
              className="p-1.5 rounded border border-slate-300 hover:bg-slate-100 disabled:opacity-40 cursor-pointer"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="font-mono font-semibold">
              Page {filters.page || 1} / {totalPages}
            </span>
            <button
              type="button"
              disabled={(filters.page || 1) >= totalPages}
              onClick={() => setFilters((f) => ({ ...f, page: Math.min(totalPages, (f.page || 1) + 1) }))}
              className="p-1.5 rounded border border-slate-300 hover:bg-slate-100 disabled:opacity-40 cursor-pointer"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Diagnostic Detail & Resolution Modal */}
      {selectedRecord && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl max-w-3xl w-full max-h-[90vh] flex flex-col overflow-hidden">
            <div className="px-5 py-4 bg-[#0a192f] text-white flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono font-bold text-xs bg-red-600 px-2 py-0.5 rounded">
                    {selectedRecord.errorCode}
                  </span>
                  <h3 className="font-bold text-sm truncate">{selectedRecord.errorCategoryLabel}</h3>
                  <span className="font-mono text-[11px] text-cyan-300">{selectedRecord.referenceId}</span>
                </div>
                <p className="text-[11px] text-slate-300 mt-0.5">
                  Error ID: {selectedRecord.errorId} •{' '}
                  {selectedRecord.referenceIdSource === 'backend' ? 'Backend-Generated Request ID' : 'Frontend-Generated Event ID'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedRecord(null)}
                className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 overflow-y-auto space-y-4 text-xs">
              {/* Root Cause Classification Banner */}
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 space-y-1.5">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span
                    className={`px-2 py-0.5 rounded border text-[11px] font-bold ${confidenceBadgeStyle(
                      selectedRecord.rootCauseConfidence
                    )}`}
                  >
                    {confidenceLabel(selectedRecord.rootCauseConfidence)}
                  </span>
                  <span className="font-mono text-[11px] text-slate-500">
                    Stage: {selectedRecord.failureStage} • Occurrences: {selectedRecord.occurrenceCount}
                  </span>
                </div>
                <p className="text-slate-800 font-medium leading-relaxed">{selectedRecord.rootCauseDetails}</p>
              </div>

              {/* Technical Message */}
              <div>
                <div className="text-[11px] font-bold uppercase text-slate-500 mb-1">
                  Sanitized Technical Error Message
                </div>
                <div className="font-mono text-[11px] bg-slate-900 text-slate-100 rounded-lg p-3 break-words">
                  {selectedRecord.technicalMessage}
                </div>
              </div>

              {/* Metadata Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {[
                  ['First Seen (IST)', selectedRecord.timestampIst],
                  ['First Seen (UTC)', selectedRecord.timestampUtc],
                  ['Last Seen (IST)', selectedRecord.lastSeenAtIst],
                  ['Module Name', selectedRecord.moduleName],
                  ['API Endpoint', selectedRecord.apiEndpoint],
                  ['HTTP Status', selectedRecord.httpStatus !== null ? String(selectedRecord.httpStatus) : 'N/A (Before Backend)'],
                  ['Affected User', `${selectedRecord.affectedUserLoginId} (UID: ${selectedRecord.affectedUserUid})`],
                  ['User Role', selectedRecord.userRole],
                  ['Exception Type', selectedRecord.exceptionType],
                  ['Network Classification', selectedRecord.networkFailureClass],
                  ['Database Classification', selectedRecord.dbFailureClass],
                  ['DB Operation / Collection', `${selectedRecord.dbOperationCategory || 'N/A'} / ${selectedRecord.dbCollectionSafe || 'N/A'}`],
                  ['Retry Count', String(selectedRecord.retryCount)],
                  ['Browser / Device', selectedRecord.browserDeviceInfo],
                ].map(([label, value]) => (
                  <div key={label} className="bg-slate-50 rounded-lg border border-slate-200 p-2.5">
                    <div className="text-[10px] font-bold uppercase text-slate-500">{label}</div>
                    <div className="font-mono text-[11px] text-slate-800 break-words mt-0.5">{value}</div>
                  </div>
                ))}
              </div>

              {/* Request Lifecycle Timeline */}
              {selectedRecord.lifecycleEvents && selectedRecord.lifecycleEvents.length > 0 && (
                <div>
                  <div className="text-[11px] font-bold uppercase text-slate-500 mb-1.5">
                    Request Lifecycle Timeline
                  </div>
                  <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
                    {selectedRecord.lifecycleEvents.map((ev, i) => (
                      <div key={`${ev.stage}_${i}`} className="px-3 py-2 flex items-center justify-between gap-2 text-[11px]">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-mono font-bold text-blue-700">{ev.stage}</span>
                          {ev.detail && <span className="text-slate-600 truncate">{ev.detail}</span>}
                        </div>
                        <span className="font-mono text-slate-400 shrink-0">+{ev.elapsedMs}ms</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Grouped Occurrences History */}
              {selectedRecord.occurrences && selectedRecord.occurrences.length > 1 && (
                <div>
                  <div className="text-[11px] font-bold uppercase text-slate-500 mb-1.5">
                    Grouped Occurrences ({selectedRecord.occurrenceCount} total, showing recent {selectedRecord.occurrences.length})
                  </div>
                  <div className="border border-slate-200 rounded-lg max-h-40 overflow-y-auto divide-y divide-slate-100">
                    {selectedRecord.occurrences.slice().reverse().map((occ, idx) => (
                      <div key={`${occ.timestampUtc}_${idx}`} className="px-3 py-1.5 flex items-center justify-between text-[11px] font-mono">
                        <span className="text-slate-700">{occ.requestId || occ.errorEventId || '—'}</span>
                        <span className="text-slate-500">{occ.userLoginId} ({occ.userRole})</span>
                        <span className="text-slate-400">{occ.timestampIst}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Admin Resolution Controls */}
              <div className="border-t border-slate-200 pt-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                    <Wrench className="w-4 h-4 text-blue-600" />
                    <span>Investigation &amp; Resolution</span>
                  </div>
                  <span className={`px-2 py-0.5 rounded border text-[10px] font-bold ${statusBadgeStyle(selectedRecord.resolutionStatus)}`}>
                    Current: {selectedRecord.resolutionStatus}
                  </span>
                </div>

                {selectedRecord.resolvedBy && (
                  <div className="text-[11px] text-emerald-700">
                    Resolved by <strong>{selectedRecord.resolvedBy}</strong> on {selectedRecord.resolvedAtIst}
                  </div>
                )}

                <textarea
                  rows={3}
                  value={resolutionNotesDraft}
                  onChange={(e) => setResolutionNotesDraft(e.target.value)}
                  placeholder="Add root cause findings, mitigation steps, or resolution notes..."
                  className="w-full border border-slate-300 rounded-lg p-2.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
                />

                <div className="flex flex-wrap items-center justify-end gap-2">
                  <button
                    type="button"
                    disabled={updatingStatus}
                    onClick={() => void handleUpdateStatus('OPEN')}
                    className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold text-xs disabled:opacity-40 cursor-pointer"
                  >
                    Mark Open
                  </button>
                  <button
                    type="button"
                    disabled={updatingStatus}
                    onClick={() => void handleUpdateStatus('INVESTIGATING')}
                    className="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-white font-semibold text-xs disabled:opacity-40 cursor-pointer"
                  >
                    Mark Investigating
                  </button>
                  <button
                    type="button"
                    disabled={updatingStatus}
                    onClick={() => void handleUpdateStatus('RESOLVED')}
                    className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-xs disabled:opacity-40 cursor-pointer"
                  >
                    Mark Resolved
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
