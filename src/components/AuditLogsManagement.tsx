import React, { useState, useEffect, useCallback } from 'react';
import {
  ShieldAlert,
  FileSearch,
  RefreshCw,
  Download,
  FileSpreadsheet,
  Search,
  Star,
  Archive,
  Trash2,
  Eye,
  X,
  CheckCircle2,
  AlertTriangle,
  Lock,
  Globe,
  Monitor,
  Clock,
  ChevronLeft,
  ChevronRight,
  LogIn,
  ShieldCheck,
  Filter,
  RotateCcw,
} from 'lucide-react';
import { AuditDeletionRecord, AuditLog, LoginHistoryEntry, UserRoleRecord } from '../types';
import {
  AuditKpis,
  AuditQueryFilters,
  LogDependencyReview,
  archiveAuditLog,
  controlledDeleteAuditLog,
  fetchAuditDeletions,
  fetchAuditLogs,
  fetchLoginHistory,
  reviewAuditLogDependencies,
  sendServerAuditEvent,
  toggleAuditImportant,
} from '../services/auditService';
import { exportTableToCsv, exportTableToExcel } from '../services/exportService';
import { useBulkSelection } from '../hooks/useBulkSelection';
import {
  BulkActionBar,
  BulkExecutionSummary,
  BulkProgressState,
  SelectAllCheckbox,
} from './BulkActionBar';
import { exportChunkedToCsv, exportChunkedToExcel } from '../services/bulkActionService';

interface AuditLogsManagementProps {
  currentUserRole: UserRoleRecord;
}

type SubTab = 'trail' | 'login_history' | 'retention_queue' | 'deletion_ledger';

const EMPTY_KPIS: AuditKpis = {
  totalLogs: 0,
  todayActivities: 0,
  successfulLogins: 0,
  failedLogins: 0,
  employeeChanges: 0,
  attendanceEvents: 0,
  securityAlerts: 0,
  archivedLogs: 0,
  pendingLogReviews: 0,
  permanentDeletionsCount: 0,
};

function formatDateTime(iso?: string): string {
  if (!iso) return '--';
  try {
    return new Date(iso).toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
  } catch {
    return iso;
  }
}

function formatJsonPreview(raw?: string): string {
  if (!raw) return '--';
  try {
    const parsed = JSON.parse(raw);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}

export const AuditLogsManagement: React.FC<AuditLogsManagementProps> = ({ currentUserRole }) => {
  const isSuperAdmin = currentUserRole?.role?.toUpperCase() === 'SUPER_ADMIN';

  const [subTab, setSubTab] = useState<SubTab>('trail');
  const [banner, setBanner] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Audit Trail State
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [kpis, setKpis] = useState<AuditKpis>(EMPTY_KPIS);
  const [retentionDays, setRetentionDays] = useState<number>(90);
  const [totalFiltered, setTotalFiltered] = useState<number>(0);
  const [totalPages, setTotalPages] = useState<number>(1);
  const [availableActions, setAvailableActions] = useState<string[]>([]);
  const [availableActors, setAvailableActors] = useState<string[]>([]);
  const [isLoadingLogs, setIsLoadingLogs] = useState<boolean>(false);

  const [filters, setFilters] = useState<AuditQueryFilters>({
    search: '',
    from: '',
    to: '',
    loginId: 'ALL',
    role: 'ALL',
    category: 'ALL',
    action: 'ALL',
    ip: '',
    success: 'ALL',
    importance: 'ALL',
    lifecycle: 'active',
    page: 1,
    pageSize: 25,
  });

  // Login History State
  const [loginHistory, setLoginHistory] = useState<LoginHistoryEntry[]>([]);
  const [isLoadingLoginHistory, setIsLoadingLoginHistory] = useState<boolean>(false);
  const [loginFilters, setLoginFilters] = useState({
    loginId: 'ALL',
    eventType: 'ALL',
    status: 'ALL',
    search: '',
  });

  // Permanent Deletion Ledger State
  const [deletions, setDeletions] = useState<AuditDeletionRecord[]>([]);
  const [isLoadingDeletions, setIsLoadingDeletions] = useState<boolean>(false);

  // Inspect Details Modal State
  const [detailLog, setDetailLog] = useState<AuditLog | null>(null);
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);

  // Controlled Delete Review Modal State
  const [deleteTargetLog, setDeleteTargetLog] = useState<AuditLog | null>(null);
  const [dependencyReview, setDependencyReview] = useState<LogDependencyReview | null>(null);
  const [isLoadingReview, setIsLoadingReview] = useState<boolean>(false);
  const [deleteReason, setDeleteReason] = useState<string>('');
  const [confirmLogIdInput, setConfirmLogIdInput] = useState<string>('');
  const [superAdminConfirmed, setSuperAdminConfirmed] = useState<boolean>(false);
  const [isDeletingLog, setIsDeletingLog] = useState<boolean>(false);

  const logsBulk = useBulkSelection<AuditLog>({
    items: logs,
    paginatedItems: logs,
    getId: (l) => l.id,
    resetKey: subTab,
  });

  const loginHistoryBulk = useBulkSelection<LoginHistoryEntry>({
    items: loginHistory,
    paginatedItems: loginHistory,
    getId: (item) => item.id,
    resetKey: subTab,
  });

  const [bulkProgress, setBulkProgress] = useState<BulkProgressState | null>(null);
  const [bulkSummary, setBulkSummary] = useState<BulkExecutionSummary | null>(null);

  const handleBulkExportLogs = async (format: 'xlsx' | 'csv') => {
    const target = logsBulk.selectedItems;
    if (target.length === 0 || bulkProgress) return;
    setBulkSummary(null);
    setBulkProgress({ label: `Exporting ${target.length} audit logs...`, completed: 0, total: target.length });
    try {
      const columns = [
        { header: 'Log ID', key: 'id' },
        { header: 'Timestamp', key: 'timestamp' },
        { header: 'Action', key: 'action' },
        { header: 'Category', key: 'category' },
        { header: 'Severity', key: 'severity' },
        { header: 'Actor Login ID', key: 'actorLoginId' },
        { header: 'Actor Role', key: 'actorRole' },
        { header: 'IP Address', key: 'ipAddress' },
        { header: 'Location', key: 'location' },
        { header: 'Browser / OS', key: 'device' },
        { header: 'Target', key: 'target' },
        { header: 'Success', key: 'success' },
        { header: 'Important', key: 'important' },
        { header: 'Description', key: 'description' },
      ];
      const rows = target.map((l) => ({
        id: l.id,
        timestamp: l.timestamp,
        action: l.action,
        category: l.category || 'SYSTEM',
        severity: l.severity || 'INFO',
        actorLoginId: l.actorLoginId || l.loginId || 'system',
        actorRole: l.actorRole || 'SYSTEM',
        ipAddress: l.ipAddress || 'unknown',
        location:
          l.geoLocation?.status === 'resolved'
            ? [l.geoLocation.city, l.geoLocation.region, l.geoLocation.country].filter(Boolean).join(', ')
            : 'unavailable',
        device: l.userAgentMeta
          ? `${l.userAgentMeta.browser} / ${l.userAgentMeta.os} (${l.userAgentMeta.deviceType})`
          : 'Unknown',
        target: [l.targetType, l.targetId || l.employeeId].filter(Boolean).join(': ') || '--',
        success: l.success === false ? 'FAILURE' : 'SUCCESS',
        important: l.isImportant ? 'YES' : 'NO',
        description: l.description || l.reason || l.newValue || '--',
      }));
      const fn = format === 'xlsx' ? exportChunkedToExcel : exportChunkedToCsv;
      const out = await fn(rows, columns, 'Audit_Logs_Selected', {
        auditTargetType: 'AUDIT_LOGS',
        auditSource: 'AUDIT_LOGS_CONSOLE',
      });
      setBulkSummary({ type: 'success', title: `Exported ${out.rowCount} Audit Logs`, message: `Downloaded "${out.fileName}".`, savedCount: out.rowCount });
      logsBulk.clearSelection();
    } catch (err: any) {
      setBulkSummary({ type: 'error', title: 'Audit Export Failed', message: err?.message || 'Unable to export selected logs.' });
    } finally {
      setBulkProgress(null);
    }
  };

  const handleBulkExportLoginHistory = async (format: 'xlsx' | 'csv') => {
    const target = loginHistoryBulk.selectedItems;
    if (target.length === 0 || bulkProgress) return;
    setBulkSummary(null);
    setBulkProgress({ label: `Exporting ${target.length} login history entries...`, completed: 0, total: target.length });
    try {
      const columns = [
        { header: 'Timestamp', key: 'timestamp' },
        { header: 'Event Type', key: 'eventType' },
        { header: 'Login ID', key: 'loginId' },
        { header: 'Role', key: 'role' },
        { header: 'IP Address', key: 'ipAddress' },
        { header: 'Geo Location', key: 'location' },
        { header: 'Device', key: 'device' },
        { header: 'Session / Reason', key: 'detail' },
      ];
      const rows = target.map((item) => ({
        timestamp: item.timestamp,
        eventType: item.eventType,
        loginId: item.loginId,
        role: item.role,
        ipAddress: item.ipAddress,
        location:
          item.geoLocation?.status === 'resolved'
            ? [item.geoLocation.city, item.geoLocation.region, item.geoLocation.country].filter(Boolean).join(', ')
            : 'unavailable',
        device: `${item.browser} / ${item.os} (${item.deviceType})`,
        detail: item.failureReason || item.sessionId || '--',
      }));
      const fn = format === 'xlsx' ? exportChunkedToExcel : exportChunkedToCsv;
      const out = await fn(rows, columns, 'Login_History_Selected', {
        auditTargetType: 'LOGIN_HISTORY',
        auditSource: 'AUDIT_LOGS_CONSOLE',
      });
      setBulkSummary({ type: 'success', title: `Exported ${out.rowCount} Login Events`, message: `Downloaded "${out.fileName}".`, savedCount: out.rowCount });
      loginHistoryBulk.clearSelection();
    } catch (err: any) {
      setBulkSummary({ type: 'error', title: 'Login History Export Failed', message: err?.message || 'Unable to export selected events.' });
    } finally {
      setBulkProgress(null);
    }
  };

  const showBanner = (type: 'success' | 'error', text: string) => {
    setBanner({ type, text });
    setTimeout(() => setBanner(null), 6000);
  };

  const loadAuditLogs = useCallback(async (overrideFilters?: AuditQueryFilters) => {
    if (!isSuperAdmin) return;
    setIsLoadingLogs(true);
    try {
      const effective = overrideFilters || filters;
      const res = await fetchAuditLogs(effective);
      setLogs(res.logs);
      setKpis(res.kpis);
      setRetentionDays(res.retentionDays || 90);
      setTotalFiltered(res.pagination.totalFiltered);
      setTotalPages(res.pagination.totalPages);
      setAvailableActions(res.facets.actions);
      setAvailableActors(res.facets.actors);
    } catch (err: any) {
      showBanner('error', err.message || 'Failed to load enterprise audit logs.');
    } finally {
      setIsLoadingLogs(false);
    }
  }, [filters, isSuperAdmin]);

  const loadLoginHistoryData = useCallback(async () => {
    if (!isSuperAdmin) return;
    setIsLoadingLoginHistory(true);
    try {
      const entries = await fetchLoginHistory(loginFilters);
      setLoginHistory(entries);
    } catch (err: any) {
      showBanner('error', err.message || 'Failed to load login history.');
    } finally {
      setIsLoadingLoginHistory(false);
    }
  }, [isSuperAdmin, loginFilters]);

  const loadDeletionsData = useCallback(async () => {
    if (!isSuperAdmin) return;
    setIsLoadingDeletions(true);
    try {
      const data = await fetchAuditDeletions();
      setDeletions(data);
    } catch (err: any) {
      showBanner('error', err.message || 'Failed to load permanent deletion ledger.');
    } finally {
      setIsLoadingDeletions(false);
    }
  }, [isSuperAdmin]);

  useEffect(() => {
    if (!isSuperAdmin) return;
    if (subTab === 'trail') {
      loadAuditLogs(filters);
    } else if (subTab === 'retention_queue') {
      loadAuditLogs({ ...filters, lifecycle: 'pending_review', page: 1 });
    } else if (subTab === 'login_history') {
      loadLoginHistoryData();
    } else if (subTab === 'deletion_ledger') {
      loadDeletionsData();
    }
  }, [subTab, filters, loadAuditLogs, loadLoginHistoryData, loadDeletionsData, isSuperAdmin]);

  const handleSubTabChange = (nextTab: SubTab) => {
    setSubTab(nextTab);
    if (nextTab === 'trail' && filters.lifecycle === 'pending_review') {
      setFilters(prev => ({ ...prev, lifecycle: 'active', page: 1 }));
    }
  };

  const handleResetFilters = () => {
    setFilters({
      search: '',
      from: '',
      to: '',
      loginId: 'ALL',
      role: 'ALL',
      category: 'ALL',
      action: 'ALL',
      ip: '',
      success: 'ALL',
      importance: 'ALL',
      lifecycle: subTab === 'retention_queue' ? 'pending_review' : 'active',
      page: 1,
      pageSize: 25,
    });
  };

  const handleToggleImportant = async (log: AuditLog) => {
    setActionBusyId(log.id);
    try {
      const next = !log.isImportant;
      await toggleAuditImportant(
        log.id,
        next,
        next ? 'Flagged Important by Super Admin' : 'Importance flag cleared by Super Admin'
      );
      showBanner('success', `Log "${log.id}" ${next ? 'marked Important (protected from deletion)' : 'unmarked'}.`);
      await loadAuditLogs(
        subTab === 'retention_queue' ? { ...filters, lifecycle: 'pending_review' } : filters
      );
    } catch (err: any) {
      showBanner('error', err.message || 'Failed to update importance status.');
    } finally {
      setActionBusyId(null);
    }
  };

  const handleArchiveLog = async (log: AuditLog) => {
    setActionBusyId(log.id);
    try {
      await archiveAuditLog(log.id, 'Reviewed & archived by Super Admin');
      showBanner('success', `Log "${log.id}" moved to long-term compliance archive.`);
      await loadAuditLogs(
        subTab === 'retention_queue' ? { ...filters, lifecycle: 'pending_review' } : filters
      );
    } catch (err: any) {
      showBanner('error', err.message || 'Failed to archive audit log.');
    } finally {
      setActionBusyId(null);
    }
  };

  const handleOpenDeleteReview = async (log: AuditLog) => {
    setDeleteTargetLog(log);
    setDependencyReview(null);
    setDeleteReason('');
    setConfirmLogIdInput('');
    setSuperAdminConfirmed(false);
    setIsLoadingReview(true);
    try {
      const review = await reviewAuditLogDependencies(log.id);
      setDependencyReview(review);
    } catch (err: any) {
      showBanner('error', err.message || 'Failed to run dependency review.');
      setDeleteTargetLog(null);
    } finally {
      setIsLoadingReview(false);
    }
  };

  const handleConfirmControlledDelete = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deleteTargetLog || !dependencyReview?.canDelete) return;
    if (deleteReason.trim().length < 10) {
      showBanner('error', 'Deletion reason must be at least 10 characters.');
      return;
    }
    if (confirmLogIdInput.trim() !== deleteTargetLog.id) {
      showBanner('error', `Confirmation ID mismatch. Enter exact Log ID "${deleteTargetLog.id}".`);
      return;
    }
    if (!superAdminConfirmed) {
      showBanner('error', 'Please check the Super Admin confirmation checkbox.');
      return;
    }

    setIsDeletingLog(true);
    try {
      const res = await controlledDeleteAuditLog(deleteTargetLog.id, {
        reason: deleteReason.trim(),
        confirmLogId: confirmLogIdInput.trim(),
        superAdminConfirmed: true,
      });
      showBanner('success', res.message || `Controlled deletion recorded (${res.deletionId}).`);
      setDeleteTargetLog(null);
      setDependencyReview(null);
      await loadAuditLogs(
        subTab === 'retention_queue' ? { ...filters, lifecycle: 'pending_review' } : filters
      );
    } catch (err: any) {
      showBanner('error', err.message || 'Controlled deletion blocked.');
    } finally {
      setIsDeletingLog(false);
    }
  };

  const handleExportAudit = (format: 'xlsx' | 'csv') => {
    const columns = [
      { header: 'Log ID', key: 'id' },
      { header: 'Timestamp', key: 'timestamp' },
      { header: 'Action', key: 'action' },
      { header: 'Category', key: 'category' },
      { header: 'Severity', key: 'severity' },
      { header: 'Actor Login ID', key: 'actorLoginId' },
      { header: 'Actor Role', key: 'actorRole' },
      { header: 'IP Address', key: 'ipAddress' },
      { header: 'Location', key: 'location' },
      { header: 'Browser / OS', key: 'device' },
      { header: 'Target', key: 'target' },
      { header: 'Success', key: 'success' },
      { header: 'Important', key: 'important' },
      { header: 'Description', key: 'description' },
    ];
    const rows = logs.map(l => ({
      id: l.id,
      timestamp: l.timestamp,
      action: l.action,
      category: l.category || 'SYSTEM',
      severity: l.severity || 'INFO',
      actorLoginId: l.actorLoginId || l.loginId || 'system',
      actorRole: l.actorRole || 'SYSTEM',
      ipAddress: l.ipAddress || 'unknown',
      location:
        l.geoLocation?.status === 'resolved'
          ? [l.geoLocation.city, l.geoLocation.region, l.geoLocation.country].filter(Boolean).join(', ')
          : 'unavailable',
      device: l.userAgentMeta
        ? `${l.userAgentMeta.browser} / ${l.userAgentMeta.os} (${l.userAgentMeta.deviceType})`
        : 'Unknown',
      target: [l.targetType, l.targetId || l.employeeId].filter(Boolean).join(': ') || '--',
      success: l.success === false ? 'FAILURE' : 'SUCCESS',
      important: l.isImportant ? 'YES' : 'NO',
      description: l.description || l.reason || l.newValue || '--',
    }));

    const fileName = `narid_audit_logs_${new Date().toISOString().slice(0, 10)}`;
    if (format === 'xlsx') {
      exportTableToExcel(rows, columns, fileName);
    } else {
      exportTableToCsv(rows, columns, fileName);
    }

    sendServerAuditEvent({
      action: 'REPORT_EXPORTED',
      category: 'EXPORT',
      targetType: 'AUDIT_LOGS',
      targetId: fileName,
      newValue: { format, rowCount: rows.length, lifecycle: filters.lifecycle },
      actionSource: 'AUDIT_LOGS_CONSOLE',
      description: `Super Admin exported ${rows.length} audit log records as ${format.toUpperCase()}.`,
    });
  };

  if (!isSuperAdmin) {
    return (
      <div className="p-8 bg-slate-50 min-h-full flex items-center justify-center">
        <div className="bg-white border border-red-200 rounded-xl p-6 max-w-md text-center space-y-2 shadow-xs">
          <ShieldAlert className="w-8 h-8 text-red-600 mx-auto" />
          <h3 className="text-sm font-bold text-slate-900">Super Admin Authorization Required</h3>
          <p className="text-xs text-slate-500">
            Access to Enterprise Audit Logs, IP/Geo Telemetry, and Controlled Retention Governance is strictly limited to Super Admin accounts.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 bg-slate-50 min-h-full flex flex-col gap-5">
      {/* Header */}
      <div className="bg-[#0a192f] text-white p-5 rounded-xl border border-slate-800 shadow-xs flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="flex items-start gap-3.5">
          <div className="w-10 h-10 rounded-lg bg-blue-600/20 border border-blue-500/40 text-blue-400 flex items-center justify-center shrink-0">
            <FileSearch className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2.5 flex-wrap">
              <h2 className="text-lg font-bold tracking-tight text-white">
                ENTERPRISE AUDIT LOGS & SECURITY MONITORING
              </h2>
              <span className="px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-400/30 text-emerald-300 font-mono text-[10px] font-bold uppercase">
                Retention: {retentionDays} Days
              </span>
              <span className="px-2 py-0.5 rounded bg-blue-500/20 border border-blue-400/30 text-blue-300 font-mono text-[10px] font-bold uppercase">
                Immutable Governance
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Cryptographically authenticated audit trail, IP & Geo telemetry, 90-day retention review queue, and Super Admin controlled deletion ledger
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => handleExportAudit('csv')}
            disabled={logs.length === 0}
            className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1.5 transition disabled:opacity-40 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export CSV</span>
          </button>
          <button
            type="button"
            onClick={() => handleExportAudit('xlsx')}
            disabled={logs.length === 0}
            className="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold flex items-center gap-1.5 transition disabled:opacity-40 cursor-pointer"
          >
            <FileSpreadsheet className="w-3.5 h-3.5" />
            <span>Export Excel</span>
          </button>
          <button
            type="button"
            onClick={() => {
              if (subTab === 'login_history') loadLoginHistoryData();
              else if (subTab === 'deletion_ledger') loadDeletionsData();
              else loadAuditLogs(subTab === 'retention_queue' ? { ...filters, lifecycle: 'pending_review' } : filters);
            }}
            className="px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${(isLoadingLogs || isLoadingLoginHistory || isLoadingDeletions) ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Status Banner */}
      {banner && (
        <div
          className={`px-4 py-3 rounded-xl border text-xs font-semibold flex items-center justify-between gap-3 ${
            banner.type === 'success'
              ? 'bg-emerald-50 border-emerald-300 text-emerald-900'
              : 'bg-red-50 border-red-300 text-red-900'
          }`}
        >
          <div className="flex items-center gap-2">
            {banner.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            ) : (
              <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
            )}
            <span>{banner.text}</span>
          </div>
          <button type="button" onClick={() => setBanner(null)} className="text-slate-500 hover:text-slate-800 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* 9 KPI Grid (+ Deletions Ledger indicator) */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9 gap-3">
        {[
          { label: 'Total Logs', value: kpis.totalLogs, tone: 'border-slate-200 bg-white text-slate-900', accent: 'text-slate-500' },
          { label: "Today's Events", value: kpis.todayActivities, tone: 'border-blue-200 bg-white text-blue-800', accent: 'text-blue-600' },
          { label: 'Login Success', value: kpis.successfulLogins, tone: 'border-emerald-200 bg-white text-emerald-800', accent: 'text-emerald-600' },
          { label: 'Failed Logins', value: kpis.failedLogins, tone: kpis.failedLogins > 0 ? 'border-amber-300 bg-amber-50/40 text-amber-900' : 'border-slate-200 bg-white text-slate-800', accent: 'text-amber-600' },
          { label: 'Employee Changes', value: kpis.employeeChanges, tone: 'border-slate-200 bg-white text-slate-900', accent: 'text-indigo-600' },
          { label: 'Attendance', value: kpis.attendanceEvents, tone: 'border-slate-200 bg-white text-slate-900', accent: 'text-cyan-600' },
          { label: 'Security Alerts', value: kpis.securityAlerts, tone: kpis.securityAlerts > 0 ? 'border-red-300 bg-red-50/40 text-red-900' : 'border-slate-200 bg-white text-slate-800', accent: 'text-red-600' },
          { label: 'Archived Logs', value: kpis.archivedLogs, tone: 'border-slate-200 bg-white text-slate-800', accent: 'text-slate-500' },
          {
            label: `Pending >${retentionDays}d`,
            value: kpis.pendingLogReviews,
            tone: kpis.pendingLogReviews > 0 ? 'border-amber-300 bg-amber-50/40 text-amber-900' : 'border-slate-200 bg-white text-slate-800',
            accent: 'text-amber-700',
            sub: `${kpis.permanentDeletionsCount} deleted`,
          },
        ].map((card) => (
          <div key={card.label} className={`rounded-xl border p-3 shadow-2xs ${card.tone}`}>
            <div className={`text-[10px] font-bold uppercase tracking-wider truncate ${card.accent}`}>
              {card.label}
            </div>
            <div className="text-xl font-extrabold font-mono tabular-nums mt-1">{card.value}</div>
            {card.sub && <div className="text-[10px] text-slate-500 font-mono mt-0.5">{card.sub}</div>}
          </div>
        ))}
      </div>

      {/* Sub-tabs */}
      <div className="flex items-center gap-2 border-b border-slate-200 overflow-x-auto">
        <button
          type="button"
          onClick={() => handleSubTabChange('trail')}
          className={`px-3.5 py-2.5 text-xs font-bold border-b-2 transition flex items-center gap-1.5 shrink-0 cursor-pointer ${
            subTab === 'trail' ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <FileSearch className="w-4 h-4" />
          <span>Audit Trail</span>
        </button>

        <button
          type="button"
          onClick={() => handleSubTabChange('login_history')}
          className={`px-3.5 py-2.5 text-xs font-bold border-b-2 transition flex items-center gap-1.5 shrink-0 cursor-pointer ${
            subTab === 'login_history' ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <LogIn className="w-4 h-4" />
          <span>Login History & IP / Geo</span>
        </button>

        <button
          type="button"
          onClick={() => handleSubTabChange('retention_queue')}
          className={`px-3.5 py-2.5 text-xs font-bold border-b-2 transition flex items-center gap-1.5 shrink-0 cursor-pointer ${
            subTab === 'retention_queue' ? 'border-amber-600 text-amber-700' : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <Clock className="w-4 h-4" />
          <span>Retention Review Queue (&gt;{retentionDays}d)</span>
          <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-mono text-[10px]">
            {kpis.pendingLogReviews}
          </span>
        </button>

        <button
          type="button"
          onClick={() => handleSubTabChange('deletion_ledger')}
          className={`px-3.5 py-2.5 text-xs font-bold border-b-2 transition flex items-center gap-1.5 shrink-0 cursor-pointer ${
            subTab === 'deletion_ledger' ? 'border-slate-900 text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <Lock className="w-4 h-4" />
          <span>Permanent Deletion Ledger</span>
          <span className="px-1.5 py-0.5 rounded bg-slate-200 text-slate-700 font-mono text-[10px]">
            {kpis.permanentDeletionsCount}
          </span>
        </button>
      </div>

      {/* ================================================================= */}
      {/* TAB 1 & TAB 3: AUDIT TRAIL & RETENTION REVIEW QUEUE               */}
      {/* ================================================================= */}
      {(subTab === 'trail' || subTab === 'retention_queue') && (
        <div className="space-y-4">
          {subTab === 'retention_queue' && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-xs text-amber-900 flex items-start gap-3">
              <Clock className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
              <div>
                <div className="font-bold">90-Day Audit Retention Governance Queue</div>
                <p className="text-amber-800 mt-0.5 leading-relaxed">
                  Only non-critical, non-important active logs older than <strong>{retentionDays} days</strong> appear here for Super Admin review. Security alerts, authentication lockouts, password resets, and marked Important records are permanently protected from deletion.
                </p>
              </div>
            </div>
          )}

          {/* Filter Toolbar */}
          <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-slate-100">
              <div className="flex items-center gap-2 text-xs font-bold text-slate-700">
                <Filter className="w-3.5 h-3.5 text-blue-600" />
                <span>Filter Enterprise Audit Records</span>
              </div>

              <div className="flex items-center gap-2">
                {subTab === 'trail' && (
                  <div className="flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200">
                    {(['active', 'archived', 'all'] as const).map(lc => (
                      <button
                        key={lc}
                        type="button"
                        onClick={() => setFilters(prev => ({ ...prev, lifecycle: lc, page: 1 }))}
                        className={`px-2.5 py-1 rounded-md text-[11px] font-bold uppercase transition cursor-pointer ${
                          filters.lifecycle === lc ? 'bg-white text-blue-700 shadow-2xs' : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {lc}
                      </button>
                    ))}
                  </div>
                )}

                <button
                  type="button"
                  onClick={handleResetFilters}
                  className="px-2.5 py-1 rounded-lg border border-slate-200 hover:bg-slate-100 text-slate-600 text-[11px] font-semibold flex items-center gap-1 cursor-pointer"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>Reset</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5 text-xs">
              <div className="relative lg:col-span-2">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
                <input
                  type="text"
                  placeholder="Search ID, action, employee, actor, IP, description..."
                  value={filters.search || ''}
                  onChange={e => setFilters(prev => ({ ...prev, search: e.target.value, page: 1 }))}
                  className="w-full pl-8 pr-3 py-1.5 border border-slate-300 rounded-lg bg-slate-50/50 focus:bg-white focus:outline-hidden focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <input
                type="date"
                value={filters.from || ''}
                onChange={e => setFilters(prev => ({ ...prev, from: e.target.value, page: 1 }))}
                title="From Date"
                className="px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white text-slate-700"
              />

              <input
                type="date"
                value={filters.to || ''}
                onChange={e => setFilters(prev => ({ ...prev, to: e.target.value, page: 1 }))}
                title="To Date"
                className="px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white text-slate-700"
              />

              <input
                type="text"
                placeholder="Filter IP (e.g. 192.168)"
                value={filters.ip || ''}
                onChange={e => setFilters(prev => ({ ...prev, ip: e.target.value, page: 1 }))}
                className="px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white font-mono text-slate-700"
              />

              <select
                value={filters.loginId || 'ALL'}
                onChange={e => setFilters(prev => ({ ...prev, loginId: e.target.value, page: 1 }))}
                className="px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white text-slate-700"
              >
                <option value="ALL">All Actors</option>
                {availableActors.map(a => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>

              <select
                value={filters.role || 'ALL'}
                onChange={e => setFilters(prev => ({ ...prev, role: e.target.value, page: 1 }))}
                className="px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white text-slate-700"
              >
                <option value="ALL">All Roles</option>
                <option value="SUPER_ADMIN">SUPER_ADMIN</option>
                <option value="ADMIN">ADMIN</option>
                <option value="USER">USER</option>
                <option value="SYSTEM">SYSTEM</option>
              </select>

              <select
                value={filters.category || 'ALL'}
                onChange={e => setFilters(prev => ({ ...prev, category: e.target.value, page: 1 }))}
                className="px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white text-slate-700"
              >
                <option value="ALL">All Categories</option>
                <option value="AUTH">AUTH</option>
                <option value="ACCOUNT">ACCOUNT</option>
                <option value="EMPLOYEE">EMPLOYEE</option>
                <option value="ATTENDANCE">ATTENDANCE</option>
                <option value="QR">QR</option>
                <option value="ORG">ORG</option>
                <option value="PERMISSIONS">PERMISSIONS</option>
                <option value="EXPORT">EXPORT</option>
                <option value="SETTINGS">SETTINGS</option>
                <option value="SECURITY">SECURITY</option>
                <option value="AUDIT_LIFECYCLE">AUDIT_LIFECYCLE</option>
                <option value="SYSTEM">SYSTEM</option>
              </select>

              <select
                value={filters.action || 'ALL'}
                onChange={e => setFilters(prev => ({ ...prev, action: e.target.value, page: 1 }))}
                className="px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white text-slate-700"
              >
                <option value="ALL">All Event Actions</option>
                {availableActions.map(act => (
                  <option key={act} value={act}>{act}</option>
                ))}
              </select>

              <div className="flex items-center gap-2">
                <select
                  value={filters.success || 'ALL'}
                  onChange={e => setFilters(prev => ({ ...prev, success: e.target.value as any, page: 1 }))}
                  className="w-1/2 px-2 py-1.5 border border-slate-300 rounded-lg bg-white text-slate-700"
                >
                  <option value="ALL">All Outcomes</option>
                  <option value="SUCCESS">Success</option>
                  <option value="FAILURE">Failure</option>
                </select>

                <select
                  value={filters.importance || 'ALL'}
                  onChange={e => setFilters(prev => ({ ...prev, importance: e.target.value as any, page: 1 }))}
                  className="w-1/2 px-2 py-1.5 border border-slate-300 rounded-lg bg-white text-slate-700"
                >
                  <option value="ALL">All Importance</option>
                  <option value="IMPORTANT">Important</option>
                  <option value="NORMAL">Standard</option>
                </select>
              </div>
            </div>
          </div>

          <BulkActionBar
            selectedCount={logsBulk.selectedCount}
            totalFilteredCount={logsBulk.totalFilteredCount}
            currentPageCount={logsBulk.currentPageCount}
            isAllFilteredSelected={logsBulk.isAllFilteredSelected}
            isPageAllSelected={logsBulk.isPageAllSelected}
            recordLabel="audit logs"
            onClearSelection={logsBulk.clearSelection}
            progress={bulkProgress}
            summary={bulkSummary}
            onDismissSummary={() => setBulkSummary(null)}
            actions={[
              {
                id: 'export_logs_xlsx',
                label: 'Export Selected Excel',
                icon: <FileSpreadsheet className="w-3.5 h-3.5" />,
                tone: 'emerald',
                onClick: () => handleBulkExportLogs('xlsx'),
              },
              {
                id: 'export_logs_csv',
                label: 'Export Selected CSV',
                icon: <Download className="w-3.5 h-3.5" />,
                tone: 'default',
                onClick: () => handleBulkExportLogs('csv'),
              },
            ]}
          />

          {/* Audit Logs Table */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-600 uppercase font-bold text-[10px] tracking-wider border-b border-slate-200">
                  <tr>
                    <th className="py-3 px-3 w-10 text-center">
                      <SelectAllCheckbox
                        checked={logsBulk.isPageAllSelected}
                        indeterminate={logsBulk.isPageIndeterminate}
                        disabled={logs.length === 0 || Boolean(bulkProgress)}
                        onChange={logsBulk.togglePageSelection}
                        ariaLabel="Select all audit logs on current page"
                      />
                    </th>
                    <th className="py-3 px-3.5">Timestamp (IST)</th>
                    <th className="py-3 px-3.5">Event & Category</th>
                    <th className="py-3 px-3.5">Actor</th>
                    <th className="py-3 px-3.5">IP & Geo / Device</th>
                    <th className="py-3 px-3.5">Summary / Target</th>
                    <th className="py-3 px-3.5">Status</th>
                    <th className="py-3 px-3.5 text-right">Governance Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {isLoadingLogs ? (
                    <tr>
                      <td colSpan={8} className="py-12 text-center text-slate-400">
                        <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                        Loading audit records...
                      </td>
                    </tr>
                  ) : logs.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-12 text-center text-slate-400">
                        No matching audit logs found for the current filters.
                      </td>
                    </tr>
                  ) : (
                    logs.map(log => {
                      const isCritical = log.severity === 'CRITICAL';
                      const isWarning = log.severity === 'WARNING';
                      const geoText =
                        log.geoLocation?.status === 'resolved'
                          ? [log.geoLocation.city, log.geoLocation.country].filter(Boolean).join(', ')
                          : 'Geo unavailable';
                      const isBusy = actionBusyId === log.id;
                      const isChecked = logsBulk.isSelected(log.id);

                      return (
                        <tr
                          key={log.id}
                          className={`transition ${
                            isChecked
                              ? 'bg-blue-50/60 hover:bg-blue-50/90'
                              : isCritical
                                ? 'bg-red-50/20 hover:bg-slate-50/90'
                                : log.isImportant
                                  ? 'bg-amber-50/20 hover:bg-slate-50/90'
                                  : 'hover:bg-slate-50/90'
                          }`}
                        >
                          <td className="py-2.5 px-3 text-center">
                            <input
                              type="checkbox"
                              checked={isChecked}
                              disabled={Boolean(bulkProgress)}
                              onChange={() => logsBulk.toggleOne(log.id)}
                              aria-label={`Select audit log ${log.id}`}
                              className="rounded text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer"
                            />
                          </td>
                          <td className="py-2.5 px-3.5 font-mono text-[11px] text-slate-600 whitespace-nowrap tabular-nums">
                            <div>{formatDateTime(log.timestamp)}</div>
                            <div className="text-[10px] text-slate-400 truncate max-w-[160px]" title={log.id}>
                              {log.id}
                            </div>
                          </td>

                          <td className="py-2.5 px-3.5">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="font-mono font-bold text-slate-900">{log.action}</span>
                              {log.isProtected && (
                                <span
                                  className="px-1.5 py-0.5 rounded bg-slate-900 text-white text-[9px] font-bold uppercase"
                                  title="Protected from deletion"
                                >
                                  Protected
                                </span>
                              )}
                              {log.isImportant && (
                                <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-900 text-[9px] font-bold uppercase">
                                  Important
                                </span>
                              )}
                              {log.archived && (
                                <span className="px-1.5 py-0.5 rounded bg-slate-200 text-slate-700 text-[9px] font-bold uppercase">
                                  Archived
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-1.5 mt-1">
                              <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-mono text-[9px] font-bold">
                                {log.category || 'SYSTEM'}
                              </span>
                              <span
                                className={`px-1.5 py-0.5 rounded font-mono text-[9px] font-bold ${
                                  isCritical
                                    ? 'bg-red-100 text-red-800'
                                    : isWarning
                                    ? 'bg-amber-100 text-amber-800'
                                    : 'bg-blue-50 text-blue-700'
                                }`}
                              >
                                {log.severity || 'INFO'}
                              </span>
                            </div>
                          </td>

                          <td className="py-2.5 px-3.5">
                            <div className="font-mono font-bold text-blue-700">{log.actorLoginId || log.loginId || 'system'}</div>
                            <div className="text-[10px] text-slate-500 uppercase font-semibold">{log.actorRole || 'SYSTEM'}</div>
                          </td>

                          <td className="py-2.5 px-3.5 text-[11px]">
                            <div className="font-mono text-slate-800 flex items-center gap-1">
                              <Globe className="w-3 h-3 text-slate-400 shrink-0" />
                              <span>{log.ipAddress || 'unknown'}</span>
                            </div>
                            <div className="text-[10px] text-slate-500 truncate max-w-[190px]">
                              {geoText}
                              {log.userAgentMeta ? ` • ${log.userAgentMeta.browser} / ${log.userAgentMeta.os}` : ''}
                            </div>
                          </td>

                          <td className="py-2.5 px-3.5 max-w-[260px]">
                            <div className="text-slate-800 font-medium truncate" title={log.description || log.newValue || ''}>
                              {log.description || log.newValue || '--'}
                            </div>
                            {(log.targetId || log.employeeId) && (
                              <div className="text-[10px] font-mono text-slate-500 truncate mt-0.5">
                                Target: {log.targetType ? `${log.targetType}: ` : ''}{log.targetId || log.employeeId}
                              </div>
                            )}
                          </td>

                          <td className="py-2.5 px-3.5 whitespace-nowrap">
                            {log.success === false ? (
                              <span className="px-2 py-0.5 rounded bg-red-100 text-red-800 font-bold text-[10px] uppercase">
                                Failed
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-bold text-[10px] uppercase">
                                Success
                              </span>
                            )}
                          </td>

                          <td className="py-2.5 px-3.5 text-right whitespace-nowrap">
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => setDetailLog(log)}
                                className="p-1.5 rounded-lg border border-slate-200 hover:bg-slate-100 text-slate-700 transition cursor-pointer"
                                title="Inspect Full Telemetry"
                              >
                                <Eye className="w-3.5 h-3.5" />
                              </button>

                              {!log.archived && (
                                <>
                                  <button
                                    type="button"
                                    disabled={isBusy}
                                    onClick={() => handleToggleImportant(log)}
                                    className={`p-1.5 rounded-lg border transition cursor-pointer disabled:opacity-40 ${
                                      log.isImportant
                                        ? 'border-amber-300 bg-amber-100 text-amber-800'
                                        : 'border-slate-200 hover:bg-amber-50 text-slate-600 hover:text-amber-700'
                                    }`}
                                    title={log.isImportant ? 'Unmark Important' : 'Mark Important (Protect from deletion)'}
                                  >
                                    <Star className="w-3.5 h-3.5" />
                                  </button>

                                  <button
                                    type="button"
                                    disabled={isBusy}
                                    onClick={() => handleArchiveLog(log)}
                                    className="p-1.5 rounded-lg border border-slate-200 hover:bg-blue-50 text-slate-600 hover:text-blue-700 transition cursor-pointer disabled:opacity-40"
                                    title="Archive Log"
                                  >
                                    <Archive className="w-3.5 h-3.5" />
                                  </button>

                                  <button
                                    type="button"
                                    disabled={isBusy}
                                    onClick={() => handleOpenDeleteReview(log)}
                                    className={`p-1.5 rounded-lg border transition cursor-pointer disabled:opacity-40 ${
                                      log.isProtected || log.isImportant || log.severity === 'CRITICAL'
                                        ? 'border-slate-200 text-slate-400 hover:bg-slate-100'
                                        : 'border-red-200 text-red-700 hover:bg-red-50'
                                    }`}
                                    title="Review Dependencies & Controlled Delete"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination Footer */}
            <div className="px-4 py-3 border-t border-slate-200 bg-slate-50 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
              <div className="text-slate-600 font-mono">
                Showing page <strong>{filters.page || 1}</strong> of <strong>{totalPages}</strong> ({totalFiltered} matching records)
              </div>

              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5">
                  <span className="text-slate-500">Rows:</span>
                  <select
                    value={filters.pageSize || 25}
                    onChange={e => setFilters(prev => ({ ...prev, pageSize: Number(e.target.value), page: 1 }))}
                    className="border border-slate-300 rounded px-2 py-1 bg-white font-mono text-xs"
                  >
                    <option value={25}>25</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                  </select>
                </div>

                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={(filters.page || 1) <= 1}
                    onClick={() => setFilters(prev => ({ ...prev, page: Math.max(1, (prev.page || 1) - 1) }))}
                    className="px-2.5 py-1 rounded border border-slate-300 bg-white hover:bg-slate-100 disabled:opacity-40 flex items-center gap-1 cursor-pointer"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                    <span>Prev</span>
                  </button>
                  <button
                    type="button"
                    disabled={(filters.page || 1) >= totalPages}
                    onClick={() => setFilters(prev => ({ ...prev, page: Math.min(totalPages, (prev.page || 1) + 1) }))}
                    className="px-2.5 py-1 rounded border border-slate-300 bg-white hover:bg-slate-100 disabled:opacity-40 flex items-center gap-1 cursor-pointer"
                  >
                    <span>Next</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ================================================================= */}
      {/* TAB 2: LOGIN HISTORY & IP / GEO TELEMETRY                         */}
      {/* ================================================================= */}
      {subTab === 'login_history' && (
        <div className="space-y-4">
          <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
              <input
                type="text"
                placeholder="Search Login ID, IP, city, browser..."
                value={loginFilters.search}
                onChange={e => setLoginFilters(prev => ({ ...prev, search: e.target.value }))}
                className="w-full pl-8 pr-3 py-1.5 border border-slate-300 rounded-lg"
              />
            </div>

            <select
              value={loginFilters.loginId}
              onChange={e => setLoginFilters(prev => ({ ...prev, loginId: e.target.value }))}
              className="px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white"
            >
              <option value="ALL">All Login IDs</option>
              <option value="superadmin">superadmin</option>
              <option value="admin">admin</option>
              <option value="user">user</option>
            </select>

            <select
              value={loginFilters.eventType}
              onChange={e => setLoginFilters(prev => ({ ...prev, eventType: e.target.value }))}
              className="px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white"
            >
              <option value="ALL">All Auth Events</option>
              <option value="LOGIN_SUCCESS">LOGIN_SUCCESS</option>
              <option value="LOGIN_FAILED">LOGIN_FAILED</option>
              <option value="LOGIN_LOCKED">LOGIN_LOCKED</option>
              <option value="LOGOUT">LOGOUT</option>
              <option value="SESSION_EXPIRED">SESSION_EXPIRED</option>
            </select>

            <select
              value={loginFilters.status}
              onChange={e => setLoginFilters(prev => ({ ...prev, status: e.target.value }))}
              className="px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white"
            >
              <option value="ALL">All Statuses</option>
              <option value="SUCCESS">Success Only</option>
              <option value="FAILURE">Failure Only</option>
            </select>
          </div>

          <BulkActionBar
            selectedCount={loginHistoryBulk.selectedCount}
            totalFilteredCount={loginHistoryBulk.totalFilteredCount}
            currentPageCount={loginHistoryBulk.currentPageCount}
            isAllFilteredSelected={loginHistoryBulk.isAllFilteredSelected}
            isPageAllSelected={loginHistoryBulk.isPageAllSelected}
            recordLabel="login events"
            onClearSelection={loginHistoryBulk.clearSelection}
            progress={bulkProgress}
            summary={bulkSummary}
            onDismissSummary={() => setBulkSummary(null)}
            actions={[
              {
                id: 'export_login_xlsx',
                label: 'Export Selected Excel',
                icon: <FileSpreadsheet className="w-3.5 h-3.5" />,
                tone: 'emerald',
                onClick: () => handleBulkExportLoginHistory('xlsx'),
              },
              {
                id: 'export_login_csv',
                label: 'Export Selected CSV',
                icon: <Download className="w-3.5 h-3.5" />,
                tone: 'default',
                onClick: () => handleBulkExportLoginHistory('csv'),
              },
            ]}
          />

          <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-600 uppercase font-bold text-[10px] tracking-wider border-b border-slate-200">
                  <tr>
                    <th className="py-3 px-3 w-10 text-center">
                      <SelectAllCheckbox
                        checked={loginHistoryBulk.isPageAllSelected}
                        indeterminate={loginHistoryBulk.isPageIndeterminate}
                        disabled={loginHistory.length === 0 || Boolean(bulkProgress)}
                        onChange={loginHistoryBulk.togglePageSelection}
                        ariaLabel="Select all login history events"
                      />
                    </th>
                    <th className="py-3 px-3.5">Timestamp (IST)</th>
                    <th className="py-3 px-3.5">Event Type</th>
                    <th className="py-3 px-3.5">Login ID & Role</th>
                    <th className="py-3 px-3.5">IP Address</th>
                    <th className="py-3 px-3.5">Geo Location</th>
                    <th className="py-3 px-3.5">Browser / OS / Device</th>
                    <th className="py-3 px-3.5">Session / Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {isLoadingLoginHistory ? (
                    <tr>
                      <td colSpan={8} className="py-10 text-center text-slate-400">
                        Loading login history telemetry...
                      </td>
                    </tr>
                  ) : loginHistory.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-10 text-center text-slate-400">
                        No login history events recorded yet.
                      </td>
                    </tr>
                  ) : (
                    loginHistory.map(item => {
                      const isChecked = loginHistoryBulk.isSelected(item.id);
                      return (
                      <tr key={item.id} className={isChecked ? 'bg-blue-50/60 hover:bg-blue-50/90' : `hover:bg-slate-50 ${!item.success ? 'bg-red-50/20' : ''}`}>
                        <td className="py-2.5 px-3 text-center">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            disabled={Boolean(bulkProgress)}
                            onChange={() => loginHistoryBulk.toggleOne(item.id)}
                            aria-label={`Select login event ${item.id}`}
                            className="rounded text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer"
                          />
                        </td>
                        <td className="py-2.5 px-3.5 font-mono text-[11px] text-slate-600 whitespace-nowrap tabular-nums">
                          {formatDateTime(item.timestamp)}
                        </td>
                        <td className="py-2.5 px-3.5">
                          <span
                            className={`px-2 py-0.5 rounded font-mono text-[10px] font-bold ${
                              item.eventType === 'LOGIN_SUCCESS'
                                ? 'bg-emerald-100 text-emerald-800'
                                : item.eventType === 'LOGOUT'
                                ? 'bg-slate-200 text-slate-800'
                                : 'bg-red-100 text-red-800'
                            }`}
                          >
                            {item.eventType}
                          </span>
                        </td>
                        <td className="py-2.5 px-3.5">
                          <div className="font-mono font-bold text-blue-700">{item.loginId}</div>
                          <div className="text-[10px] text-slate-500 uppercase">{item.role}</div>
                        </td>
                        <td className="py-2.5 px-3.5 font-mono text-slate-800">{item.ipAddress}</td>
                        <td className="py-2.5 px-3.5 text-slate-600">
                          {item.geoLocation?.status === 'resolved'
                            ? [item.geoLocation.city, item.geoLocation.region, item.geoLocation.country]
                                .filter(Boolean)
                                .join(', ')
                            : 'unavailable'}
                        </td>
                        <td className="py-2.5 px-3.5 text-slate-700">
                          <div className="flex items-center gap-1.5">
                            <Monitor className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                            <span>{item.browser} / {item.os} ({item.deviceType})</span>
                          </div>
                        </td>
                        <td className="py-2.5 px-3.5 text-[11px]">
                          {item.failureReason ? (
                            <span className="text-red-700 font-medium">{item.failureReason}</span>
                          ) : (
                            <span className="font-mono text-slate-500">{item.sessionId || '--'}</span>
                          )}
                        </td>
                      </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ================================================================= */}
      {/* TAB 4: PERMANENT DELETION LEDGER (READ-ONLY)                      */}
      {/* ================================================================= */}
      {subTab === 'deletion_ledger' && (
        <div className="space-y-4">
          <div className="bg-slate-900 text-slate-200 rounded-xl p-4 text-xs flex items-start gap-3">
            <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            <div>
              <div className="font-bold text-white">Immutable Audit Deletion Compliance Ledger</div>
              <p className="text-slate-400 mt-0.5">
                Every Super Admin-approved controlled deletion of an eligible old non-critical log is permanently recorded here with its deletion reason, checked dependencies, and approver identity.
              </p>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-600 uppercase font-bold text-[10px] tracking-wider border-b border-slate-200">
                  <tr>
                    <th className="py-3 px-3.5">Deleted At</th>
                    <th className="py-3 px-3.5">Deletion ID</th>
                    <th className="py-3 px-3.5">Deleted Log ID</th>
                    <th className="py-3 px-3.5">Original Action & Actor</th>
                    <th className="py-3 px-3.5">Linked Records Checked</th>
                    <th className="py-3 px-3.5">Mandatory Reason</th>
                    <th className="py-3 px-3.5">Approved By & IP</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {isLoadingDeletions ? (
                    <tr>
                      <td colSpan={7} className="py-10 text-center text-slate-400">
                        Loading immutable deletion ledger...
                      </td>
                    </tr>
                  ) : deletions.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-10 text-center text-slate-400">
                        No controlled audit log deletions have been executed.
                      </td>
                    </tr>
                  ) : (
                    deletions.map(d => (
                      <tr key={d.id} className="hover:bg-slate-50">
                        <td className="py-2.5 px-3.5 font-mono text-[11px] text-slate-600 whitespace-nowrap">
                          {formatDateTime(d.deletedAt)}
                        </td>
                        <td className="py-2.5 px-3.5 font-mono text-[11px] font-bold text-slate-800">{d.id}</td>
                        <td className="py-2.5 px-3.5 font-mono text-[11px] text-blue-700">{d.deletedLogId}</td>
                        <td className="py-2.5 px-3.5">
                          <div className="font-mono font-bold text-slate-900">{d.deletedAction}</div>
                          <div className="text-[10px] text-slate-500">
                            Actor: {d.deletedActorLoginId} • {d.deletedCategory}
                          </div>
                        </td>
                        <td className="py-2.5 px-3.5 text-[11px] text-slate-600 max-w-[200px]">
                          {(d.linkedRecordsChecked || []).join(', ') || 'None'}
                        </td>
                        <td className="py-2.5 px-3.5 text-slate-800 max-w-[240px]">{d.reason}</td>
                        <td className="py-2.5 px-3.5 font-mono text-[11px]">
                          <div className="font-bold text-slate-900">{d.approvedByLoginId}</div>
                          <div className="text-[10px] text-slate-500">{d.ipAddress}</div>
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

      {/* ================================================================= */}
      {/* MODAL: FULL AUDIT LOG INSPECTION                                  */}
      {/* ================================================================= */}
      {detailLog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden">
            <div className="p-4 border-b border-slate-200 bg-[#0a192f] text-white flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold flex items-center gap-2">
                  <FileSearch className="w-4 h-4 text-blue-400" />
                  <span>Audit Telemetry Details: {detailLog.action}</span>
                </h3>
                <p className="text-[11px] font-mono text-slate-400 mt-0.5">{detailLog.id}</p>
              </div>
              <button
                type="button"
                onClick={() => setDetailLog(null)}
                className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-300 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 overflow-y-auto space-y-4 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-slate-50 p-3.5 rounded-xl border border-slate-200">
                <div><span className="text-slate-500 font-semibold">Timestamp:</span> <span className="font-mono text-slate-900">{formatDateTime(detailLog.timestamp)}</span></div>
                <div><span className="text-slate-500 font-semibold">Category / Severity:</span> <span className="font-mono font-bold text-slate-900">{detailLog.category} • {detailLog.severity}</span></div>
                <div><span className="text-slate-500 font-semibold">Actor Login ID:</span> <span className="font-mono font-bold text-blue-700">{detailLog.actorLoginId || detailLog.loginId}</span></div>
                <div><span className="text-slate-500 font-semibold">Actor UID / Role:</span> <span className="font-mono text-slate-800">{detailLog.actorUid || '--'} ({detailLog.actorRole})</span></div>
                <div><span className="text-slate-500 font-semibold">IP Address:</span> <span className="font-mono text-slate-900">{detailLog.ipAddress || 'unknown'}</span></div>
                <div>
                  <span className="text-slate-500 font-semibold">Geo Location:</span>{' '}
                  <span className="text-slate-800">
                    {detailLog.geoLocation?.status === 'resolved'
                      ? [detailLog.geoLocation.city, detailLog.geoLocation.region, detailLog.geoLocation.country].filter(Boolean).join(', ')
                      : 'unavailable'}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 font-semibold">Client Device:</span>{' '}
                  <span className="text-slate-800">
                    {detailLog.userAgentMeta
                      ? `${detailLog.userAgentMeta.browser} / ${detailLog.userAgentMeta.os} (${detailLog.userAgentMeta.deviceType})`
                      : 'Unknown'}
                  </span>
                </div>
                <div><span className="text-slate-500 font-semibold">Session ID:</span> <span className="font-mono text-slate-800">{detailLog.sessionId || '--'}</span></div>
                <div><span className="text-slate-500 font-semibold">Target:</span> <span className="font-mono text-slate-800">{detailLog.targetType || '--'} / {detailLog.targetId || detailLog.employeeId || '--'}</span></div>
                <div><span className="text-slate-500 font-semibold">Source:</span> <span className="font-mono text-slate-800">{detailLog.actionSource}</span></div>
              </div>

              <div>
                <div className="font-bold text-slate-700 mb-1">Description / Reason</div>
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-slate-800">
                  {detailLog.description || detailLog.reason || '--'}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <div className="font-bold text-slate-700 mb-1">Previous Value (Redacted)</div>
                  <pre className="p-3 rounded-lg bg-slate-900 text-slate-200 font-mono text-[11px] overflow-x-auto max-h-48">
                    {formatJsonPreview(detailLog.oldValue || detailLog.previousValue)}
                  </pre>
                </div>
                <div>
                  <div className="font-bold text-slate-700 mb-1">New Value / Outcome (Redacted)</div>
                  <pre className="p-3 rounded-lg bg-slate-900 text-emerald-300 font-mono text-[11px] overflow-x-auto max-h-48">
                    {formatJsonPreview(detailLog.newValue)}
                  </pre>
                </div>
              </div>

              {(detailLog.reviewedBy || detailLog.archivedBy) && (
                <div className="p-3 rounded-xl bg-blue-50 border border-blue-200 text-blue-900 space-y-1">
                  <div className="font-bold">Governance Review Record</div>
                  <div>Reviewed By: <span className="font-mono">{detailLog.reviewedBy || detailLog.archivedBy}</span> at {formatDateTime(detailLog.reviewedAt || detailLog.archivedAt)}</div>
                  {detailLog.reviewNote && <div>Note: {detailLog.reviewNote}</div>}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ================================================================= */}
      {/* MODAL: CONTROLLED DELETE DEPENDENCY REVIEW (SUPER ADMIN ONLY)     */}
      {/* ================================================================= */}
      {deleteTargetLog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
          <div className="bg-white rounded-2xl border border-red-200 shadow-2xl w-full max-w-lg overflow-hidden">
            <div className="p-4 border-b border-red-100 bg-red-50 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <ShieldAlert className="w-5 h-5 text-red-600" />
                <div>
                  <h3 className="text-sm font-bold text-red-950">Controlled Audit Deletion Review</h3>
                  <p className="text-[11px] text-red-700 font-mono">{deleteTargetLog.id}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setDeleteTargetLog(null);
                  setDependencyReview(null);
                }}
                className="p-1 rounded-lg hover:bg-red-200 text-red-700 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4 text-xs">
              {isLoadingReview ? (
                <div className="py-8 text-center text-slate-500">
                  <div className="w-6 h-6 border-2 border-red-600 border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                  Checking protection policy, age ({retentionDays}d), and linked records...
                </div>
              ) : dependencyReview ? (
                <>
                  <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-1.5">
                    <div className="flex justify-between">
                      <span className="text-slate-500">Event Action:</span>
                      <span className="font-mono font-bold text-slate-900">{dependencyReview.log.action}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Record Age / Policy:</span>
                      <span className="font-mono font-bold text-slate-900">
                        {dependencyReview.ageDays} days / {dependencyReview.retentionDays} days min
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Linked Records:</span>
                      <span className="font-mono text-slate-800">
                        {dependencyReview.linkedRecords.length > 0
                          ? dependencyReview.linkedRecords.join(', ')
                          : 'No active blocking references'}
                      </span>
                    </div>
                  </div>

                  {!dependencyReview.canDelete ? (
                    <div className="p-4 rounded-xl bg-red-50 border border-red-200 text-red-900 space-y-2">
                      <div className="font-bold flex items-center gap-1.5">
                        <Lock className="w-4 h-4 text-red-600" />
                        <span>Deletion Blocked by Enterprise Compliance Policy</span>
                      </div>
                      <ul className="list-disc pl-5 space-y-1 text-[11px]">
                        {dependencyReview.protectionReasons.map((reason, idx) => (
                          <li key={idx}>{reason}</li>
                        ))}
                      </ul>
                      <p className="text-[11px] text-red-700 pt-1">
                        You may archive this log for long-term compliance storage instead of deleting it.
                      </p>
                      <div className="pt-2 flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setDeleteTargetLog(null);
                            setDependencyReview(null);
                          }}
                          className="px-4 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-700 font-semibold cursor-pointer"
                        >
                          Close
                        </button>
                      </div>
                    </div>
                  ) : (
                    <form onSubmit={handleConfirmControlledDelete} className="space-y-3.5">
                      <div>
                        <label className="block font-bold text-slate-700 mb-1">
                          Mandatory Deletion Reason (min 10 characters) *
                        </label>
                        <textarea
                          rows={2}
                          required
                          minLength={10}
                          placeholder="Document business/compliance justification for permanent deletion..."
                          value={deleteReason}
                          onChange={e => setDeleteReason(e.target.value)}
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-red-500"
                        />
                      </div>

                      <div>
                        <label className="block font-bold text-slate-700 mb-1">
                          Type Exact Log ID to Confirm: <span className="font-mono text-red-700">{deleteTargetLog.id}</span> *
                        </label>
                        <input
                          type="text"
                          required
                          placeholder={deleteTargetLog.id}
                          value={confirmLogIdInput}
                          onChange={e => setConfirmLogIdInput(e.target.value)}
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono focus:outline-hidden focus:ring-2 focus:ring-red-500"
                        />
                      </div>

                      <label className="flex items-start gap-2 cursor-pointer p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-amber-950">
                        <input
                          type="checkbox"
                          checked={superAdminConfirmed}
                          onChange={e => setSuperAdminConfirmed(e.target.checked)}
                          className="mt-0.5 rounded border-amber-400 text-red-600 w-4 h-4"
                        />
                        <span className="text-[11px] leading-snug">
                          I confirm as Super Admin that dependencies have been reviewed and this controlled deletion will be permanently logged in <strong>audit_log_deletions</strong>.
                        </span>
                      </label>

                      <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
                        <button
                          type="button"
                          onClick={() => {
                            setDeleteTargetLog(null);
                            setDependencyReview(null);
                          }}
                          className="px-4 py-2 rounded-lg border border-slate-300 text-slate-700 font-semibold cursor-pointer"
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          disabled={isDeletingLog}
                          className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white font-bold flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>{isDeletingLog ? 'Deleting...' : 'Execute Controlled Delete'}</span>
                        </button>
                      </div>
                    </form>
                  )}
                </>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
