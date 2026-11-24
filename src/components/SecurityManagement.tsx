import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { getSafeErrorText } from '../services/errorHandlingService';
import {
  ShieldAlert,
  ShieldCheck,
  Lock,
  Unlock,
  KeyRound,
  RefreshCw,
  Eye,
  History,
  Globe,
  Monitor,
  FileSearch,
  CheckCircle2,
  AlertTriangle,
  Copy,
  Check,
  Search,
  X,
  Clock,
  Activity,
  FileSpreadsheet,
  Download,
  RotateCcw,
} from 'lucide-react';
import {
  AccountSecurityRecord,
  LoginAttemptRecord,
  SecurityAuditLogRecord,
  SecurityOverviewResponse,
  UserRoleRecord,
} from '../types';
import {
  fetchSecurityOverview,
  fetchLoginAttempts,
  fetchSecurityAuditLogs,
  unblockLockedAccount,
  generateTemporaryPasswordForAccount,
  resetSuperAdminLockoutLevel,
} from '../services/securityService';
import { UnauthorizedAccess } from './UnauthorizedAccess';
import { useBulkSelection } from '../hooks/useBulkSelection';
import {
  BulkActionBar,
  BulkExecutionSummary,
  BulkProgressState,
  SelectAllCheckbox,
} from './BulkActionBar';
import { exportChunkedToCsv, exportChunkedToExcel } from '../services/bulkActionService';

interface SecurityManagementProps {
  currentUserRole?: UserRoleRecord | null;
}

const formatDateTime = (iso?: string | null): string => {
  if (!iso) return 'Never';
  try {
    return new Date(iso).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return String(iso);
  }
};

const formatGeo = (geo?: { country?: string; region?: string; city?: string; status?: string } | null): string => {
  if (!geo) return 'Unavailable';
  if (geo.status === 'resolved') {
    return [geo.city, geo.region, geo.country].filter(v => v && v !== 'unavailable').join(', ') || 'Resolved';
  }
  if (geo.country && geo.country !== 'unavailable') return geo.country;
  return 'Unavailable';
};

export const SecurityManagement: React.FC<SecurityManagementProps> = ({ currentUserRole }) => {
  const isSuperAdmin = currentUserRole?.role?.toUpperCase() === 'SUPER_ADMIN';

  const [subTab, setSubTab] = useState<'accounts' | 'attempts' | 'audit_logs'>('accounts');
  const [overview, setOverview] = useState<SecurityOverviewResponse | null>(null);
  const [attemptsList, setAttemptsList] = useState<LoginAttemptRecord[]>([]);
  const [auditLogsList, setAuditLogsList] = useState<SecurityAuditLogRecord[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [banner, setBanner] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Attempt & Audit Log Filters
  const [attemptLoginFilter, setAttemptLoginFilter] = useState<string>('ALL');
  const [attemptOutcomeFilter, setAttemptOutcomeFilter] = useState<string>('ALL');
  const [attemptSearch, setAttemptSearch] = useState<string>('');

  const [auditLoginFilter, setAuditLoginFilter] = useState<string>('ALL');
  const [auditSeverityFilter, setAuditSeverityFilter] = useState<string>('ALL');
  const [auditSearch, setAuditSearch] = useState<string>('');

  // Modal States
  const [detailsAccount, setDetailsAccount] = useState<AccountSecurityRecord | null>(null);
  const [historyAccount, setHistoryAccount] = useState<AccountSecurityRecord | null>(null);
  const [historyAttempts, setHistoryAttempts] = useState<LoginAttemptRecord[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState<boolean>(false);
  const [deviceAccount, setDeviceAccount] = useState<AccountSecurityRecord | null>(null);

  // Unblock Confirmation Dialog State
  const [unblockTarget, setUnblockTarget] = useState<AccountSecurityRecord | null>(null);
  const [unblockFailedHistory, setUnblockFailedHistory] = useState<LoginAttemptRecord[]>([]);
  const [unblockReason, setUnblockReason] = useState<string>('');
  const [unblockConfirmed, setUnblockConfirmed] = useState<boolean>(false);
  const [isUnblocking, setIsUnblocking] = useState<boolean>(false);
  const [unblockError, setUnblockError] = useState<string | null>(null);

  // Temporary Password Generation Modal State
  const [tempPwdTarget, setTempPwdTarget] = useState<AccountSecurityRecord | null>(null);
  const [tempPwdReason, setTempPwdReason] = useState<string>('');
  const [freshSuperAdminPassword, setFreshSuperAdminPassword] = useState<string>('');
  const [isGeneratingTempPwd, setIsGeneratingTempPwd] = useState<boolean>(false);
  const [tempPwdError, setTempPwdError] = useState<string | null>(null);
  const [generatedTempResult, setGeneratedTempResult] = useState<{
    targetLoginId: string;
    targetRole: string;
    firebaseUid: string;
    temporaryPassword: string;
    firebaseAuthSynced: boolean;
    generatedAt: string;
  } | null>(null);
  const [copiedTempPwd, setCopiedTempPwd] = useState<boolean>(false);

  // Super Admin Progressive Lockout Level Reset Modal State
  const [resetLevelTarget, setResetLevelTarget] = useState<AccountSecurityRecord | null>(null);
  const [resetLevelReason, setResetLevelReason] = useState<string>('');
  const [resetLevelConfirmed, setResetLevelConfirmed] = useState<boolean>(false);
  const [resetLevelPassword, setResetLevelPassword] = useState<string>('');
  const [isResettingLevel, setIsResettingLevel] = useState<boolean>(false);
  const [resetLevelError, setResetLevelError] = useState<string | null>(null);

  const attemptsBulk = useBulkSelection<LoginAttemptRecord>({
    items: attemptsList,
    paginatedItems: attemptsList,
    getId: (att) => att.id,
    resetKey: subTab,
  });

  const secAuditsBulk = useBulkSelection<SecurityAuditLogRecord>({
    items: auditLogsList,
    paginatedItems: auditLogsList,
    getId: (log) => log.id,
    resetKey: subTab,
  });

  const [bulkProgress, setBulkProgress] = useState<BulkProgressState | null>(null);
  const [bulkSummary, setBulkSummary] = useState<BulkExecutionSummary | null>(null);

  const handleBulkExportAttempts = async (format: 'xlsx' | 'csv') => {
    const selected = attemptsBulk.selectedItems;
    if (selected.length === 0 || bulkProgress) return;
    setBulkSummary(null);
    setBulkProgress({ label: `Exporting ${selected.length} login attempts...`, completed: 0, total: selected.length });
    try {
      const cols = [
        { header: 'Timestamp', key: 'timestamp' },
        { header: 'Login ID', key: 'loginId' },
        { header: 'Role', key: 'role' },
        { header: 'Outcome', key: 'outcome' },
        { header: 'IP Address', key: 'ipAddress' },
        { header: 'Location', key: 'location' },
        { header: 'Device', key: 'device' },
        { header: 'Reason', key: 'reason' },
      ];
      const rows = selected.map((a) => ({
        timestamp: a.timestamp,
        loginId: a.loginId,
        role: a.role,
        outcome: a.outcome,
        ipAddress: a.ipAddress,
        location: formatGeo(a.geoLocation),
        device: `${a.browser} / ${a.os} (${a.deviceType})`,
        reason: a.failureReason || (a.success ? 'Authenticated' : '--'),
      }));
      const fn = format === 'xlsx' ? exportChunkedToExcel : exportChunkedToCsv;
      const out = await fn(rows, cols, 'Security_Login_Attempts_Selected', {
        auditTargetType: 'SECURITY_LOGIN_ATTEMPTS',
        auditSource: 'SECURITY_MANAGEMENT',
      });
      setBulkSummary({ type: 'success', title: `Exported ${out.rowCount} Login Attempts`, message: `Downloaded "${out.fileName}".`, savedCount: out.rowCount });
      attemptsBulk.clearSelection();
    } catch (err: any) {
      setBulkSummary({
        type: 'error',
        title: 'Export Failed',
        message: getSafeErrorText(err, { moduleName: 'Security & Lockouts', forcedErrorCode: 'FILE-002' }),
      });
    } finally {
      setBulkProgress(null);
    }
  };

  const handleBulkExportSecAudits = async (format: 'xlsx' | 'csv') => {
    const selected = secAuditsBulk.selectedItems;
    if (selected.length === 0 || bulkProgress) return;
    setBulkSummary(null);
    setBulkProgress({ label: `Exporting ${selected.length} security audit logs...`, completed: 0, total: selected.length });
    try {
      const cols = [
        { header: 'Timestamp', key: 'timestamp' },
        { header: 'Action', key: 'action' },
        { header: 'Severity', key: 'severity' },
        { header: 'Target Login ID', key: 'targetLoginId' },
        { header: 'Actor Login ID', key: 'actorLoginId' },
        { header: 'IP Address', key: 'ipAddress' },
        { header: 'Details', key: 'details' },
        { header: 'Reason', key: 'reason' },
      ];
      const rows = selected.map((l) => ({
        timestamp: l.timestamp,
        action: l.action,
        severity: l.severity,
        targetLoginId: l.targetLoginId,
        actorLoginId: l.actorLoginId,
        ipAddress: l.ipAddress,
        details: l.details,
        reason: l.reason,
      }));
      const fn = format === 'xlsx' ? exportChunkedToExcel : exportChunkedToCsv;
      const out = await fn(rows, cols, 'Security_Audit_Logs_Selected', {
        auditTargetType: 'SECURITY_AUDIT_LOGS',
        auditSource: 'SECURITY_MANAGEMENT',
      });
      setBulkSummary({ type: 'success', title: `Exported ${out.rowCount} Security Logs`, message: `Downloaded "${out.fileName}".`, savedCount: out.rowCount });
      secAuditsBulk.clearSelection();
    } catch (err: any) {
      setBulkSummary({
        type: 'error',
        title: 'Export Failed',
        message: getSafeErrorText(err, { moduleName: 'Security & Lockouts', forcedErrorCode: 'FILE-002' }),
      });
    } finally {
      setBulkProgress(null);
    }
  };

  const loadSecurityData = useCallback(async () => {
    if (!isSuperAdmin) return;
    setIsLoading(true);
    try {
      const data = await fetchSecurityOverview();
      setOverview(data);
      setAttemptsList(data.recentAttempts || []);
      setAuditLogsList(data.recentSecurityLogs || []);
    } catch (err: any) {
      setBanner({
        type: 'error',
        text: getSafeErrorText(err, { moduleName: 'Security & Lockouts', endpoint: '/api/security/overview' }),
      });
    } finally {
      setIsLoading(false);
    }
  }, [isSuperAdmin]);

  useEffect(() => {
    loadSecurityData();
  }, [loadSecurityData]);

  const handleLoadFilteredAttempts = useCallback(async () => {
    if (!isSuperAdmin) return;
    try {
      const rows = await fetchLoginAttempts({
        loginId: attemptLoginFilter,
        outcome: attemptOutcomeFilter,
        search: attemptSearch,
        limit: 300,
      });
      setAttemptsList(rows);
    } catch (err: any) {
      setBanner({
        type: 'error',
        text: getSafeErrorText(err, { moduleName: 'Security & Lockouts', endpoint: '/api/security/attempts' }),
      });
    }
  }, [isSuperAdmin, attemptLoginFilter, attemptOutcomeFilter, attemptSearch]);

  const handleLoadFilteredAudits = useCallback(async () => {
    if (!isSuperAdmin) return;
    try {
      const rows = await fetchSecurityAuditLogs({
        loginId: auditLoginFilter,
        severity: auditSeverityFilter,
        search: auditSearch,
      });
      setAuditLogsList(rows);
    } catch (err: any) {
      setBanner({
        type: 'error',
        text: getSafeErrorText(err, { moduleName: 'Security & Lockouts', endpoint: '/api/security/audit-logs' }),
      });
    }
  }, [isSuperAdmin, auditLoginFilter, auditSeverityFilter, auditSearch]);

  useEffect(() => {
    if (subTab === 'attempts') {
      handleLoadFilteredAttempts();
    }
  }, [subTab, handleLoadFilteredAttempts]);

  useEffect(() => {
    if (subTab === 'audit_logs') {
      handleLoadFilteredAudits();
    }
  }, [subTab, handleLoadFilteredAudits]);

  const openLoginHistoryModal = async (acc: AccountSecurityRecord) => {
    setHistoryAccount(acc);
    setIsLoadingHistory(true);
    try {
      const rows = await fetchLoginAttempts({ loginId: acc.loginId, limit: 100 });
      setHistoryAttempts(rows);
    } catch {
      setHistoryAttempts(
        (overview?.recentAttempts || []).filter(
          (a) => a.loginId.toLowerCase() === acc.loginId.toLowerCase()
        )
      );
    } finally {
      setIsLoadingHistory(false);
    }
  };

  const openUnblockModal = async (acc: AccountSecurityRecord) => {
    setUnblockTarget(acc);
    setUnblockReason('');
    setUnblockConfirmed(false);
    setUnblockError(null);
    try {
      const rows = await fetchLoginAttempts({
        loginId: acc.loginId,
        outcome: 'FAILURE',
        limit: 15,
      });
      setUnblockFailedHistory(rows);
    } catch {
      setUnblockFailedHistory(
        (overview?.recentAttempts || []).filter(
          (a) => a.loginId.toLowerCase() === acc.loginId.toLowerCase() && !a.success
        )
      );
    }
  };

  const handleConfirmUnblock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!unblockTarget) return;
    setUnblockError(null);

    if (!unblockConfirmed) {
      setUnblockError('Please check the confirmation checkbox to authorize account unblocking.');
      return;
    }
    if (unblockReason.trim().length < 5) {
      setUnblockError('Please enter a brief unblock reason (minimum 5 characters).');
      return;
    }

    setIsUnblocking(true);
    try {
      const res = await unblockLockedAccount({
        targetLoginId: unblockTarget.loginId,
        reason: unblockReason.trim(),
        confirmed: true,
      });
      setBanner({ type: 'success', text: res.message });
      setUnblockTarget(null);
      await loadSecurityData();
    } catch (err: any) {
      setUnblockError(
        getSafeErrorText(err, { moduleName: 'Security & Lockouts', endpoint: '/api/security/unblock' })
      );
    } finally {
      setIsUnblocking(false);
    }
  };

  const openTempPasswordModal = (acc: AccountSecurityRecord) => {
    setTempPwdTarget(acc);
    setTempPwdReason('');
    setFreshSuperAdminPassword('');
    setTempPwdError(null);
    setGeneratedTempResult(null);
    setCopiedTempPwd(false);
  };

  const handleGenerateTempPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tempPwdTarget) return;
    setTempPwdError(null);

    if (tempPwdReason.trim().length < 5) {
      setTempPwdError('Please provide an audit reason (minimum 5 characters).');
      return;
    }
    if (!freshSuperAdminPassword) {
      setTempPwdError('Enter your current Super Admin password to complete fresh authentication.');
      return;
    }

    setIsGeneratingTempPwd(true);
    try {
      const res = await generateTemporaryPasswordForAccount({
        targetLoginId: tempPwdTarget.loginId,
        reason: tempPwdReason.trim(),
        freshSuperAdminPassword,
      });
      setFreshSuperAdminPassword('');
      setGeneratedTempResult({
        targetLoginId: res.targetLoginId,
        targetRole: res.targetRole,
        firebaseUid: res.firebaseUid,
        temporaryPassword: res.temporaryPassword,
        firebaseAuthSynced: res.firebaseAuthSynced,
        generatedAt: res.generatedAt,
      });
      setBanner({
        type: 'success',
        text: `Temporary password generated for "${res.targetLoginId}". Password change will be enforced on next login.`,
      });
      await loadSecurityData();
    } catch (err: any) {
      setTempPwdError(
        getSafeErrorText(err, { moduleName: 'Security & Lockouts', endpoint: '/api/security/temp-password' })
      );
    } finally {
      setIsGeneratingTempPwd(false);
    }
  };

  const handleCopyTempPassword = async () => {
    if (!generatedTempResult?.temporaryPassword) return;
    try {
      await navigator.clipboard.writeText(generatedTempResult.temporaryPassword);
      setCopiedTempPwd(true);
      setTimeout(() => setCopiedTempPwd(false), 2500);
    } catch {}
  };

  const openAuditLogsForAccount = (loginId: string) => {
    setAuditLoginFilter(loginId.toLowerCase());
    setSubTab('audit_logs');
  };

  const openResetLevelModal = (acc: AccountSecurityRecord) => {
    setResetLevelTarget(acc);
    setResetLevelReason('');
    setResetLevelConfirmed(false);
    setResetLevelPassword('');
    setResetLevelError(null);
  };

  const handleConfirmResetLevel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetLevelTarget) return;
    setResetLevelError(null);

    if (!resetLevelConfirmed) {
      setResetLevelError('Please check the confirmation checkbox to authorize resetting the lockout escalation level.');
      return;
    }
    if (resetLevelReason.trim().length < 5) {
      setResetLevelError('Please provide an audit reason (minimum 5 characters).');
      return;
    }
    if (!resetLevelPassword) {
      setResetLevelError('Enter your current Super Admin password to complete fresh authentication.');
      return;
    }

    setIsResettingLevel(true);
    try {
      const res = await resetSuperAdminLockoutLevel({
        reason: resetLevelReason.trim(),
        confirmed: true,
        freshSuperAdminPassword: resetLevelPassword,
      });
      setResetLevelPassword('');
      setBanner({ type: 'success', text: res.message });
      setResetLevelTarget(null);
      await loadSecurityData();
    } catch (err: any) {
      setResetLevelError(
        getSafeErrorText(err, {
          moduleName: 'Security & Lockouts',
          endpoint: '/api/security/reset-lockout-level',
        })
      );
    } finally {
      setIsResettingLevel(false);
    }
  };

  // Distinct IP/device history for currently inspected device modal
  const deviceAccountAttempts = useMemo(() => {
    if (!deviceAccount) return [];
    return (overview?.recentAttempts || []).filter(
      (a) => a.loginId.toLowerCase() === deviceAccount.loginId.toLowerCase()
    );
  }, [deviceAccount, overview]);

  if (!isSuperAdmin) {
    if (!currentUserRole) return null;
    return (
      <UnauthorizedAccess
        currentTab="security_management"
        currentUserRole={currentUserRole}
        onGoHome={() => {}}
      />
    );
  }

  const kpis = overview?.kpis || {
    totalLoginAttempts: 0,
    successfulLogins: 0,
    failedLogins: 0,
    currentlyLockedAccounts: 0,
    accountsWithForcePasswordChange: 0,
    rateLimitAlerts: 0,
  };

  const accounts = overview?.accounts || [];

  return (
    <div className="p-5 sm:p-6 bg-slate-50 min-h-full flex flex-col gap-5">
      {/* Header */}
      <div className="bg-white p-4 sm:p-5 rounded-xl border border-slate-200 shadow-2xs flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-lg bg-slate-900 text-white flex items-center justify-center shrink-0">
              <ShieldAlert className="w-5 h-5 text-amber-400" />
            </div>
            <div>
              <h2 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">
                SECURITY &amp; LOGIN ATTEMPT MANAGEMENT
              </h2>
              <p className="text-xs text-slate-500">
                Super Admin governance console — 3-strike lockout policy, rate limiting, IP/device telemetry, account unblock &amp; temporary password resets
              </p>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={loadSecurityData}
          disabled={isLoading}
          className="self-start sm:self-auto px-3.5 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer disabled:opacity-60"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          <span>Refresh Telemetry</span>
        </button>
      </div>

      {/* Banner */}
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
          <button
            type="button"
            onClick={() => setBanner(null)}
            className="text-slate-500 hover:text-slate-800 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Summary KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {[
          {
            label: 'Total Attempts',
            value: kpis.totalLoginAttempts,
            tone: 'border-slate-200 bg-white text-slate-900',
            accent: 'text-slate-500',
          },
          {
            label: 'Successful Logins',
            value: kpis.successfulLogins,
            tone: 'border-emerald-200 bg-white text-emerald-800',
            accent: 'text-emerald-600',
          },
          {
            label: 'Failed Logins',
            value: kpis.failedLogins,
            tone: kpis.failedLogins > 0 ? 'border-amber-300 bg-amber-50/40 text-amber-900' : 'border-slate-200 bg-white text-slate-900',
            accent: 'text-amber-700',
          },
          {
            label: 'Locked Accounts',
            value: kpis.currentlyLockedAccounts,
            tone: kpis.currentlyLockedAccounts > 0 ? 'border-red-300 bg-red-50/60 text-red-900' : 'border-slate-200 bg-white text-slate-900',
            accent: 'text-red-600',
          },
          {
            label: 'Force Password Change',
            value: kpis.accountsWithForcePasswordChange,
            tone: 'border-blue-200 bg-white text-blue-900',
            accent: 'text-blue-600',
          },
          {
            label: 'Rate-Limit Alerts',
            value: kpis.rateLimitAlerts,
            tone: kpis.rateLimitAlerts > 0 ? 'border-red-300 bg-red-50/40 text-red-900' : 'border-slate-200 bg-white text-slate-900',
            accent: 'text-red-600',
          },
        ].map((card) => (
          <div key={card.label} className={`rounded-xl border p-3.5 shadow-2xs ${card.tone}`}>
            <div className={`text-[10px] font-bold uppercase tracking-wider truncate ${card.accent}`}>
              {card.label}
            </div>
            <div className="text-2xl font-extrabold font-mono tabular-nums mt-1">
              {card.value}
            </div>
          </div>
        ))}
      </div>

      {/* Sub-Tabs */}
      <div className="flex items-center gap-2 border-b border-slate-200 overflow-x-auto">
        <button
          type="button"
          onClick={() => setSubTab('accounts')}
          className={`px-3.5 py-2.5 text-xs font-bold border-b-2 transition flex items-center gap-1.5 shrink-0 cursor-pointer ${
            subTab === 'accounts'
              ? 'border-blue-600 text-blue-700'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <ShieldCheck className="w-4 h-4" />
          <span>Account Security &amp; Lockouts ({accounts.length})</span>
        </button>

        <button
          type="button"
          onClick={() => setSubTab('attempts')}
          className={`px-3.5 py-2.5 text-xs font-bold border-b-2 transition flex items-center gap-1.5 shrink-0 cursor-pointer ${
            subTab === 'attempts'
              ? 'border-blue-600 text-blue-700'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <Activity className="w-4 h-4" />
          <span>Login Attempt History ({attemptsList.length})</span>
        </button>

        <button
          type="button"
          onClick={() => setSubTab('audit_logs')}
          className={`px-3.5 py-2.5 text-xs font-bold border-b-2 transition flex items-center gap-1.5 shrink-0 cursor-pointer ${
            subTab === 'audit_logs'
              ? 'border-slate-900 text-slate-900'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <FileSearch className="w-4 h-4" />
          <span>Security Audit Logs ({auditLogsList.length})</span>
        </button>
      </div>

      {/* ================================================================= */}
      {/* TAB 1: ACCOUNT SECURITY MATRIX                                    */}
      {/* ================================================================= */}
      {subTab === 'accounts' && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-600 uppercase font-bold text-[10px] tracking-wider border-b border-slate-200">
                <tr>
                  <th className="py-3 px-4">Login ID &amp; Role</th>
                  <th className="py-3 px-4">Lock Status</th>
                  <th className="py-3 px-4">Failed Counter</th>
                  <th className="py-3 px-4">Last Success / Failed</th>
                  <th className="py-3 px-4">IP / Geo / Device</th>
                  <th className="py-3 px-4 text-right">Security Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {accounts.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-10 text-center text-slate-400">
                      {isLoading ? 'Loading account security records...' : 'No accounts found.'}
                    </td>
                  </tr>
                ) : (
                  accounts.map((acc) => {
                    const isLocked = acc.lockStatus === 'LOCKED';
                    const isProgressivePolicy = acc.lockPolicyType === 'PROGRESSIVE_TEMPORARY';
                    const progressiveLevel = Number(acc.progressiveLockLevel || 0);
                    const totalLockEvents = Number(acc.totalLockoutEvents || 0);
                    const resetHours = overview?.superAdminLockoutResetHours ?? 24;
                    const latestIp = acc.lastFailedIp && (!acc.lastSuccessAt || (acc.lastFailedAt || '') > acc.lastSuccessAt)
                      ? acc.lastFailedIp
                      : acc.lastSuccessIp || acc.lastFailedIp || 'N/A';
                    const latestGeo = acc.lastFailedGeo && (!acc.lastSuccessAt || (acc.lastFailedAt || '') > acc.lastSuccessAt)
                      ? acc.lastFailedGeo
                      : acc.lastSuccessGeo || acc.lastFailedGeo;
                    const latestDevice = acc.lastFailedDevice && (!acc.lastSuccessAt || (acc.lastFailedAt || '') > acc.lastSuccessAt)
                      ? acc.lastFailedDevice
                      : acc.lastSuccessDevice || acc.lastFailedDevice;

                    return (
                      <tr
                        key={acc.loginId}
                        className={`hover:bg-slate-50/80 transition ${isLocked ? 'bg-red-50/35' : ''}`}
                      >
                        <td className="py-3 px-4">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-mono font-bold text-slate-900 text-sm">
                              {acc.loginId}
                            </span>
                            <span className="px-1.5 py-0.5 rounded bg-slate-800 text-white text-[10px] font-bold uppercase">
                              {acc.role}
                            </span>
                            {isProgressivePolicy && (
                              <span
                                className="px-1.5 py-0.5 rounded bg-blue-50 border border-blue-200 text-blue-800 text-[10px] font-bold uppercase"
                                title={`Progressive temporary lockout: 10m -> 20m -> 30m -> 60m. Auto-resets after ${resetHours}h clean usage.`}
                              >
                                Progressive Temp
                              </span>
                            )}
                            {acc.forcePasswordChange && (
                              <span
                                className="px-1.5 py-0.5 rounded bg-amber-100 border border-amber-300 text-amber-900 text-[10px] font-bold uppercase"
                                title="Mandatory password change required on next login"
                              >
                                Force Change
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-slate-500 mt-0.5">{acc.email}</div>
                          <div className="text-[10px] font-mono text-slate-400 mt-0.5 truncate max-w-[220px]" title={acc.firebaseUid}>
                            UID: {acc.firebaseUid}
                          </div>
                        </td>

                        <td className="py-3 px-4">
                          {isLocked ? (
                            <div>
                              <span
                                className={`inline-flex items-center gap-1 px-2 py-1 rounded font-bold text-[10px] uppercase tracking-wider ${
                                  isProgressivePolicy
                                    ? 'bg-amber-600 text-white'
                                    : 'bg-red-600 text-white'
                                }`}
                              >
                                {isProgressivePolicy ? <Clock className="w-3 h-3" /> : <Lock className="w-3 h-3" />}
                                {isProgressivePolicy
                                  ? `TEMP LOCKED (${acc.lockDurationMinutes || 10}m)`
                                  : 'LOCKED'}
                              </span>
                              {isProgressivePolicy && acc.lockedUntil ? (
                                <div className="text-[10px] text-amber-800 font-mono mt-1">
                                  Until {formatDateTime(acc.lockedUntil)}
                                </div>
                              ) : (
                                acc.lockedAt && (
                                  <div className="text-[10px] text-red-700 font-mono mt-1">
                                    {formatDateTime(acc.lockedAt)}
                                  </div>
                                )
                              )}
                            </div>
                          ) : (
                            <div>
                              <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-emerald-100 text-emerald-800 border border-emerald-200 font-bold text-[10px] uppercase tracking-wider">
                                <ShieldCheck className="w-3 h-3" />
                                ACTIVE
                              </span>
                              {isProgressivePolicy && (
                                <div className="text-[10px] font-mono text-slate-600 mt-1">
                                  Escalation:{' '}
                                  <span className={progressiveLevel > 0 ? 'font-bold text-amber-700' : 'text-emerald-700 font-semibold'}>
                                    L{progressiveLevel}/4
                                  </span>
                                  {totalLockEvents > 0 && (
                                    <span className="text-slate-400"> &bull; {totalLockEvents} hist</span>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </td>

                        <td className="py-3 px-4 font-mono tabular-nums">
                          <div className="font-bold text-slate-900">
                            {acc.consecutiveFailedAttempts} / {acc.maxAttemptsAllowed} consecutive
                          </div>
                          <div className="text-[11px] text-slate-500 mt-0.5">
                            Success: <span className="text-emerald-700 font-semibold">{acc.totalSuccessfulLogins}</span> &bull; Failed:{' '}
                            <span className="text-red-700 font-semibold">{acc.totalFailedLogins}</span>
                          </div>
                          {isProgressivePolicy && progressiveLevel > 0 && (
                            <div className="text-[10px] text-slate-500 mt-0.5">
                              Clean window: {resetHours}h auto-reset
                            </div>
                          )}
                        </td>

                        <td className="py-3 px-4 text-[11px] space-y-1 font-mono tabular-nums">
                          <div className="text-emerald-700">
                            <span className="font-bold">OK:</span> {formatDateTime(acc.lastSuccessAt)}
                          </div>
                          <div className="text-red-700">
                            <span className="font-bold">Fail:</span> {formatDateTime(acc.lastFailedAt)}
                          </div>
                        </td>

                        <td className="py-3 px-4 text-[11px] text-slate-600">
                          <div className="font-mono font-semibold text-slate-800">{latestIp}</div>
                          <div className="text-slate-500 truncate max-w-[180px]">{formatGeo(latestGeo)}</div>
                          {latestDevice && (
                            <div className="text-[10px] text-slate-400">
                              {latestDevice.browser} &bull; {latestDevice.os} ({latestDevice.deviceType})
                            </div>
                          )}
                        </td>

                        <td className="py-3 px-4 text-right">
                          <div className="flex flex-wrap items-center justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() => setDetailsAccount(acc)}
                              title="1. View Details"
                              className="px-2 py-1 rounded border border-slate-200 bg-white hover:bg-slate-100 text-slate-700 font-semibold text-[11px] flex items-center gap-1 cursor-pointer"
                            >
                              <Eye className="w-3 h-3" />
                              <span>Details</span>
                            </button>

                            <button
                              type="button"
                              onClick={() => openLoginHistoryModal(acc)}
                              title="2. View Login History"
                              className="px-2 py-1 rounded border border-slate-200 bg-white hover:bg-slate-100 text-slate-700 font-semibold text-[11px] flex items-center gap-1 cursor-pointer"
                            >
                              <History className="w-3 h-3" />
                              <span>History</span>
                            </button>

                            <button
                              type="button"
                              onClick={() => setDeviceAccount(acc)}
                              title="3. View IP and Device Information"
                              className="px-2 py-1 rounded border border-slate-200 bg-white hover:bg-slate-100 text-slate-700 font-semibold text-[11px] flex items-center gap-1 cursor-pointer"
                            >
                              <Globe className="w-3 h-3" />
                              <span>IP / Device</span>
                            </button>

                            {isProgressivePolicy && (
                              <button
                                type="button"
                                onClick={() => openResetLevelModal(acc)}
                                disabled={progressiveLevel === 0}
                                title="Reset Super Admin progressive lockout escalation level (retains lockout history)"
                                className={`px-2 py-1 rounded font-bold text-[11px] flex items-center gap-1 cursor-pointer ${
                                  progressiveLevel > 0
                                    ? 'bg-blue-600 hover:bg-blue-700 text-white'
                                    : 'bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed'
                                }`}
                              >
                                <RotateCcw className="w-3 h-3" />
                                <span>Reset Level</span>
                              </button>
                            )}

                            <button
                              type="button"
                              onClick={() => openUnblockModal(acc)}
                              disabled={!isLocked && acc.consecutiveFailedAttempts === 0}
                              title="4. Unblock Account"
                              className={`px-2 py-1 rounded font-bold text-[11px] flex items-center gap-1 cursor-pointer ${
                                isLocked || acc.consecutiveFailedAttempts > 0
                                  ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                                  : 'bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed'
                              }`}
                            >
                              <Unlock className="w-3 h-3" />
                              <span>Unblock</span>
                            </button>

                            <button
                              type="button"
                              onClick={() => openTempPasswordModal(acc)}
                              title="5. Generate New Temporary Password"
                              className="px-2 py-1 rounded bg-amber-600 hover:bg-amber-700 text-white font-bold text-[11px] flex items-center gap-1 cursor-pointer"
                            >
                              <KeyRound className="w-3 h-3" />
                              <span>Temp Password</span>
                            </button>

                            <button
                              type="button"
                              onClick={() => openAuditLogsForAccount(acc.loginId)}
                              title="6. View Audit Logs"
                              className="px-2 py-1 rounded border border-slate-300 bg-slate-800 hover:bg-slate-900 text-white font-semibold text-[11px] flex items-center gap-1 cursor-pointer"
                            >
                              <FileSearch className="w-3 h-3" />
                              <span>Audit Logs</span>
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ================================================================= */}
      {/* TAB 2: LOGIN ATTEMPTS HISTORY                                     */}
      {/* ================================================================= */}
      {subTab === 'attempts' && (
        <div className="space-y-4">
          <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs grid grid-cols-1 sm:grid-cols-4 gap-3 text-xs">
            <div className="relative sm:col-span-2">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
              <input
                type="text"
                placeholder="Search Login ID, IP, city, browser, reason..."
                value={attemptSearch}
                onChange={(e) => setAttemptSearch(e.target.value)}
                className="w-full pl-8 pr-3 py-1.5 border border-slate-300 rounded-lg bg-slate-50/50 focus:bg-white"
              />
            </div>

            <select
              value={attemptLoginFilter}
              onChange={(e) => setAttemptLoginFilter(e.target.value)}
              className="px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white"
            >
              <option value="ALL">All Login IDs</option>
              {accounts.map((a) => (
                <option key={a.loginId} value={a.loginId}>
                  {a.loginId} ({a.role})
                </option>
              ))}
            </select>

            <select
              value={attemptOutcomeFilter}
              onChange={(e) => setAttemptOutcomeFilter(e.target.value)}
              className="px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white"
            >
              <option value="ALL">All Outcomes</option>
              <option value="SUCCESS">Success Only</option>
              <option value="FAILURE">All Failures / Blocks</option>
              <option value="FAILED_PASSWORD">Wrong Password</option>
              <option value="BLOCKED_LOCKED">Blocked (Account Locked)</option>
              <option value="BLOCKED_RATE_LIMIT">Blocked (Rate Limit)</option>
              <option value="FIREBASE_TOO_MANY_ATTEMPTS">Firebase Too Many Attempts</option>
            </select>
          </div>

          <BulkActionBar
            selectedCount={attemptsBulk.selectedCount}
            totalFilteredCount={attemptsBulk.totalFilteredCount}
            currentPageCount={attemptsBulk.currentPageCount}
            isAllFilteredSelected={attemptsBulk.isAllFilteredSelected}
            isPageAllSelected={attemptsBulk.isPageAllSelected}
            recordLabel="login attempts"
            onClearSelection={attemptsBulk.clearSelection}
            progress={bulkProgress}
            summary={bulkSummary}
            onDismissSummary={() => setBulkSummary(null)}
            actions={[
              {
                id: 'export_attempts_xlsx',
                label: 'Export Selected Excel',
                icon: <FileSpreadsheet className="w-3.5 h-3.5" />,
                tone: 'emerald',
                onClick: () => handleBulkExportAttempts('xlsx'),
              },
              {
                id: 'export_attempts_csv',
                label: 'Export Selected CSV',
                icon: <Download className="w-3.5 h-3.5" />,
                tone: 'default',
                onClick: () => handleBulkExportAttempts('csv'),
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
                        checked={attemptsBulk.isPageAllSelected}
                        indeterminate={attemptsBulk.isPageIndeterminate}
                        disabled={attemptsList.length === 0 || Boolean(bulkProgress)}
                        onChange={attemptsBulk.togglePageSelection}
                        ariaLabel="Select all login attempts"
                      />
                    </th>
                    <th className="py-3 px-3.5">Timestamp (IST)</th>
                    <th className="py-3 px-3.5">Login ID &amp; Role</th>
                    <th className="py-3 px-3.5">Outcome &amp; Strike</th>
                    <th className="py-3 px-3.5">IP &amp; Geo Location</th>
                    <th className="py-3 px-3.5">Browser / OS / Device</th>
                    <th className="py-3 px-3.5">Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {attemptsList.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-10 text-center text-slate-400">
                        No login attempt records found.
                      </td>
                    </tr>
                  ) : (
                    attemptsList.map((att) => {
                      const isChecked = attemptsBulk.isSelected(att.id);
                      return (
                      <tr
                        key={att.id}
                        className={isChecked ? 'bg-blue-50/60 hover:bg-blue-50/90' : `hover:bg-slate-50/80 ${att.triggeredLock ? 'bg-red-50/40' : ''}`}
                      >
                        <td className="py-2.5 px-3 text-center">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            disabled={Boolean(bulkProgress)}
                            onChange={() => attemptsBulk.toggleOne(att.id)}
                            aria-label={`Select login attempt ${att.id}`}
                            className="rounded text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer"
                          />
                        </td>
                        <td className="py-2.5 px-3.5 font-mono text-[11px] whitespace-nowrap tabular-nums text-slate-600">
                          {formatDateTime(att.timestamp)}
                        </td>
                        <td className="py-2.5 px-3.5">
                          <span className="font-mono font-bold text-slate-900">{att.loginId}</span>
                          <span className="ml-1.5 px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 text-[10px] font-bold">
                            {att.role}
                          </span>
                        </td>
                        <td className="py-2.5 px-3.5">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                              att.success
                                ? 'bg-emerald-100 text-emerald-800'
                                : att.outcome === 'BLOCKED_LOCKED' || att.triggeredLock
                                ? 'bg-red-600 text-white'
                                : 'bg-amber-100 text-amber-900'
                            }`}
                          >
                            {att.outcome}
                          </span>
                          {typeof att.attemptNumber === 'number' && (
                            <span className="ml-1.5 font-mono text-[11px] text-slate-600">
                              (#{att.attemptNumber}/3)
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 px-3.5 text-[11px]">
                          <div className="font-mono font-semibold text-slate-800">{att.ipAddress}</div>
                          <div className="text-slate-500">{formatGeo(att.geoLocation)}</div>
                        </td>
                        <td className="py-2.5 px-3.5 text-[11px] text-slate-600">
                          <div>{att.browser} &bull; {att.os}</div>
                          <div className="text-[10px] text-slate-400">{att.deviceType}</div>
                        </td>
                        <td className="py-2.5 px-3.5 text-[11px] text-slate-700 max-w-xs">
                          <div>{att.failureReason || (att.success ? 'Authenticated' : '--')}</div>
                          <div className="text-[10px] font-mono text-slate-400">
                            Category: {att.failureReasonCategory}
                          </div>
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
      {/* TAB 3: SECURITY AUDIT LOGS                                        */}
      {/* ================================================================= */}
      {subTab === 'audit_logs' && (
        <div className="space-y-4">
          <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs grid grid-cols-1 sm:grid-cols-4 gap-3 text-xs">
            <div className="relative sm:col-span-2">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
              <input
                type="text"
                placeholder="Search security audit action, target, actor, reason, IP..."
                value={auditSearch}
                onChange={(e) => setAuditSearch(e.target.value)}
                className="w-full pl-8 pr-3 py-1.5 border border-slate-300 rounded-lg bg-slate-50/50 focus:bg-white"
              />
            </div>

            <select
              value={auditLoginFilter}
              onChange={(e) => setAuditLoginFilter(e.target.value)}
              className="px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white"
            >
              <option value="ALL">All Target Login IDs</option>
              {accounts.map((a) => (
                <option key={a.loginId} value={a.loginId}>
                  {a.loginId}
                </option>
              ))}
            </select>

            <select
              value={auditSeverityFilter}
              onChange={(e) => setAuditSeverityFilter(e.target.value)}
              className="px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white"
            >
              <option value="ALL">All Severities</option>
              <option value="CRITICAL">CRITICAL</option>
              <option value="WARNING">WARNING</option>
              <option value="INFO">INFO</option>
            </select>
          </div>

          <BulkActionBar
            selectedCount={secAuditsBulk.selectedCount}
            totalFilteredCount={secAuditsBulk.totalFilteredCount}
            currentPageCount={secAuditsBulk.currentPageCount}
            isAllFilteredSelected={secAuditsBulk.isAllFilteredSelected}
            isPageAllSelected={secAuditsBulk.isPageAllSelected}
            recordLabel="security logs"
            onClearSelection={secAuditsBulk.clearSelection}
            progress={bulkProgress}
            summary={bulkSummary}
            onDismissSummary={() => setBulkSummary(null)}
            actions={[
              {
                id: 'export_sec_logs_xlsx',
                label: 'Export Selected Excel',
                icon: <FileSpreadsheet className="w-3.5 h-3.5" />,
                tone: 'emerald',
                onClick: () => handleBulkExportSecAudits('xlsx'),
              },
              {
                id: 'export_sec_logs_csv',
                label: 'Export Selected CSV',
                icon: <Download className="w-3.5 h-3.5" />,
                tone: 'default',
                onClick: () => handleBulkExportSecAudits('csv'),
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
                        checked={secAuditsBulk.isPageAllSelected}
                        indeterminate={secAuditsBulk.isPageIndeterminate}
                        disabled={auditLogsList.length === 0 || Boolean(bulkProgress)}
                        onChange={secAuditsBulk.togglePageSelection}
                        ariaLabel="Select all security audit logs"
                      />
                    </th>
                    <th className="py-3 px-3.5">Timestamp (IST)</th>
                    <th className="py-3 px-3.5">Action &amp; Severity</th>
                    <th className="py-3 px-3.5">Target Account</th>
                    <th className="py-3 px-3.5">Performed By</th>
                    <th className="py-3 px-3.5">IP &amp; Device</th>
                    <th className="py-3 px-3.5">Details &amp; Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {auditLogsList.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-10 text-center text-slate-400">
                        No security audit logs match your current filters.
                      </td>
                    </tr>
                  ) : (
                    auditLogsList.map((log) => {
                      const isChecked = secAuditsBulk.isSelected(log.id);
                      return (
                      <tr
                        key={log.id}
                        className={isChecked ? 'bg-blue-50/60 hover:bg-blue-50/90' : `hover:bg-slate-50/80 ${log.severity === 'CRITICAL' ? 'bg-red-50/25' : ''}`}
                      >
                        <td className="py-2.5 px-3 text-center">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            disabled={Boolean(bulkProgress)}
                            onChange={() => secAuditsBulk.toggleOne(log.id)}
                            aria-label={`Select security log ${log.id}`}
                            className="rounded text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer"
                          />
                        </td>
                        <td className="py-2.5 px-3.5 font-mono text-[11px] whitespace-nowrap tabular-nums text-slate-600">
                          {formatDateTime(log.timestamp)}
                        </td>
                        <td className="py-2.5 px-3.5">
                          <div className="font-mono font-bold text-slate-900">{log.action}</div>
                          <span
                            className={`inline-block mt-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${
                              log.severity === 'CRITICAL'
                                ? 'bg-red-600 text-white'
                                : log.severity === 'WARNING'
                                ? 'bg-amber-100 text-amber-900'
                                : 'bg-slate-100 text-slate-700'
                            }`}
                          >
                            {log.severity}
                          </span>
                        </td>
                        <td className="py-2.5 px-3.5 font-mono">
                          <div className="font-bold text-slate-900">{log.targetLoginId}</div>
                          <div className="text-[10px] text-slate-500">{log.targetRole}</div>
                        </td>
                        <td className="py-2.5 px-3.5 font-mono text-[11px]">
                          <div className="font-semibold text-slate-800">{log.actorLoginId}</div>
                          <div className="text-[10px] text-slate-500">{log.actorRole}</div>
                        </td>
                        <td className="py-2.5 px-3.5 text-[11px]">
                          <div className="font-mono text-slate-800">{log.ipAddress}</div>
                          <div className="text-[10px] text-slate-500">
                            {log.deviceInfo?.browser || 'Unknown'} &bull; {log.deviceInfo?.os || 'Unknown'}
                          </div>
                        </td>
                        <td className="py-2.5 px-3.5 text-[11px] text-slate-700 max-w-sm">
                          <div className="font-medium">{log.details}</div>
                          <div className="text-[10px] text-slate-500 mt-0.5">Reason: {log.reason}</div>
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
      {/* MODAL 1: VIEW ACCOUNT SECURITY DETAILS                            */}
      {/* ================================================================= */}
      {detailsAccount && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-2xl overflow-hidden">
            <div className="px-5 py-4 bg-slate-900 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-blue-400" />
                <h3 className="font-bold text-sm uppercase tracking-wider">
                  Account Security Details — {detailsAccount.loginId}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setDetailsAccount(null)}
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-1.5">
                <div className="font-bold text-slate-700 uppercase text-[10px]">Identity &amp; Lock State</div>
                <div><span className="text-slate-500">Login ID:</span> <strong className="font-mono">{detailsAccount.loginId}</strong></div>
                <div><span className="text-slate-500">Role:</span> <strong>{detailsAccount.role}</strong></div>
                <div><span className="text-slate-500">Email:</span> <span className="font-mono">{detailsAccount.email}</span></div>
                <div><span className="text-slate-500">Firebase UID:</span> <span className="font-mono text-[11px] break-all">{detailsAccount.firebaseUid}</span></div>
                <div><span className="text-slate-500">Lock Status:</span> <strong className={detailsAccount.lockStatus === 'LOCKED' ? 'text-red-700' : 'text-emerald-700'}>{detailsAccount.lockStatus}</strong></div>
                <div><span className="text-slate-500">Consecutive Failures:</span> <strong className="font-mono">{detailsAccount.consecutiveFailedAttempts} / {detailsAccount.maxAttemptsAllowed}</strong></div>
                <div><span className="text-slate-500">Force Password Change:</span> <strong>{detailsAccount.forcePasswordChange ? 'YES (Mandatory)' : 'NO'}</strong></div>
              </div>

              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-1.5">
                <div className="font-bold text-slate-700 uppercase text-[10px]">Authentication &amp; Governance History</div>
                <div><span className="text-slate-500">Total Attempts:</span> <strong className="font-mono">{detailsAccount.totalLoginAttempts}</strong></div>
                <div><span className="text-slate-500">Last Success:</span> <span className="font-mono">{formatDateTime(detailsAccount.lastSuccessAt)}</span></div>
                <div><span className="text-slate-500">Last Failure:</span> <span className="font-mono">{formatDateTime(detailsAccount.lastFailedAt)}</span></div>
                <div><span className="text-slate-500">Last Failure Reason:</span> <span>{detailsAccount.lastFailedReason || '--'}</span></div>
                <div><span className="text-slate-500">Last Unblocked At:</span> <span className="font-mono">{formatDateTime(detailsAccount.unblockedAt)}</span></div>
                <div><span className="text-slate-500">Unblocked By:</span> <span className="font-mono">{detailsAccount.unblockedByLoginId || '--'}</span></div>
                <div><span className="text-slate-500">Last Temp Reset:</span> <span className="font-mono">{formatDateTime(detailsAccount.tempPasswordResetAt)}</span></div>
              </div>
            </div>
            <div className="px-5 py-3 bg-slate-50 border-t border-slate-200 flex justify-end">
              <button
                type="button"
                onClick={() => setDetailsAccount(null)}
                className="px-4 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-semibold cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================================================================= */}
      {/* MODAL 2: ACCOUNT LOGIN HISTORY                                    */}
      {/* ================================================================= */}
      {historyAccount && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-4xl max-h-[85vh] flex flex-col overflow-hidden">
            <div className="px-5 py-4 bg-slate-900 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <History className="w-5 h-5 text-cyan-400" />
                <h3 className="font-bold text-sm uppercase tracking-wider">
                  Login History — {historyAccount.loginId} ({historyAccount.role})
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setHistoryAccount(null)}
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {isLoadingHistory ? (
                <div className="py-12 text-center text-xs text-slate-500">Loading login attempts...</div>
              ) : historyAttempts.length === 0 ? (
                <div className="py-12 text-center text-xs text-slate-500">No login attempts recorded yet for this account.</div>
              ) : (
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 text-slate-600 uppercase text-[10px] border-b border-slate-200">
                    <tr>
                      <th className="py-2 px-3">Timestamp</th>
                      <th className="py-2 px-3">Outcome</th>
                      <th className="py-2 px-3">IP &amp; Geo</th>
                      <th className="py-2 px-3">Device</th>
                      <th className="py-2 px-3">Reason</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {historyAttempts.map((h) => (
                      <tr key={h.id}>
                        <td className="py-2 px-3 font-mono text-[11px]">{formatDateTime(h.timestamp)}</td>
                        <td className="py-2 px-3">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${
                              h.success ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'
                            }`}
                          >
                            {h.outcome}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-[11px]">
                          <div className="font-mono">{h.ipAddress}</div>
                          <div className="text-slate-500">{formatGeo(h.geoLocation)}</div>
                        </td>
                        <td className="py-2 px-3 text-[11px]">{h.browser} &bull; {h.os}</td>
                        <td className="py-2 px-3 text-[11px] text-slate-600">{h.failureReason || '--'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ================================================================= */}
      {/* MODAL 3: IP & DEVICE TELEMETRY INFORMATION                        */}
      {/* ================================================================= */}
      {deviceAccount && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-2xl overflow-hidden">
            <div className="px-5 py-4 bg-slate-900 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Monitor className="w-5 h-5 text-emerald-400" />
                <h3 className="font-bold text-sm uppercase tracking-wider">
                  IP &amp; Device Telemetry — {deviceAccount.loginId}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setDeviceAccount(null)}
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-4 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="p-3 rounded-xl bg-emerald-50/50 border border-emerald-200 space-y-1">
                  <div className="text-[10px] font-bold uppercase text-emerald-800">Last Successful Session</div>
                  <div>IP: <strong className="font-mono">{deviceAccount.lastSuccessIp || 'N/A'}</strong></div>
                  <div>Location: <strong>{formatGeo(deviceAccount.lastSuccessGeo)}</strong></div>
                  <div>Device: <strong>{deviceAccount.lastSuccessDevice ? `${deviceAccount.lastSuccessDevice.browser} / ${deviceAccount.lastSuccessDevice.os} (${deviceAccount.lastSuccessDevice.deviceType})` : 'N/A'}</strong></div>
                  <div>Time: <span className="font-mono">{formatDateTime(deviceAccount.lastSuccessAt)}</span></div>
                </div>

                <div className="p-3 rounded-xl bg-red-50/50 border border-red-200 space-y-1">
                  <div className="text-[10px] font-bold uppercase text-red-800">Last Failed Attempt</div>
                  <div>IP: <strong className="font-mono">{deviceAccount.lastFailedIp || 'N/A'}</strong></div>
                  <div>Location: <strong>{formatGeo(deviceAccount.lastFailedGeo)}</strong></div>
                  <div>Device: <strong>{deviceAccount.lastFailedDevice ? `${deviceAccount.lastFailedDevice.browser} / ${deviceAccount.lastFailedDevice.os} (${deviceAccount.lastFailedDevice.deviceType})` : 'N/A'}</strong></div>
                  <div>Time: <span className="font-mono">{formatDateTime(deviceAccount.lastFailedAt)}</span></div>
                </div>
              </div>

              <div>
                <div className="text-[11px] font-bold uppercase text-slate-600 mb-2">
                  Recent Network &amp; Device Fingerprints Observed ({deviceAccountAttempts.slice(0, 8).length})
                </div>
                <div className="border border-slate-200 rounded-xl divide-y divide-slate-100 max-h-48 overflow-y-auto">
                  {deviceAccountAttempts.slice(0, 8).map((a) => (
                    <div key={a.id} className="px-3 py-2 flex items-center justify-between gap-2 text-[11px]">
                      <div>
                        <span className="font-mono font-semibold text-slate-800">{a.ipAddress}</span>
                        <span className="text-slate-500 ml-2">{formatGeo(a.geoLocation)}</span>
                      </div>
                      <div className="text-slate-600">
                        {a.browser} &bull; {a.os} ({a.deviceType})
                      </div>
                    </div>
                  ))}
                  {deviceAccountAttempts.length === 0 && (
                    <div className="p-4 text-center text-slate-400">No network fingerprints recorded yet.</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ================================================================= */}
      {/* MODAL 4: UNBLOCK ACCOUNT CONFIRMATION DIALOG                      */}
      {/* ================================================================= */}
      {unblockTarget && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4">
          <form
            onSubmit={handleConfirmUnblock}
            className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-lg overflow-hidden"
          >
            <div className="px-5 py-4 bg-emerald-700 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Unlock className="w-5 h-5" />
                <h3 className="font-bold text-sm uppercase tracking-wider">
                  Confirm Super Admin Account Unblock
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setUnblockTarget(null)}
                className="text-emerald-100 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4 text-xs">
              <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-1">
                <div><span className="text-slate-500">Login ID:</span> <strong className="font-mono text-slate-900">{unblockTarget.loginId}</strong></div>
                <div><span className="text-slate-500">Role:</span> <strong>{unblockTarget.role}</strong></div>
                <div><span className="text-slate-500">Firebase UID:</span> <span className="font-mono text-[11px]">{unblockTarget.firebaseUid}</span></div>
                <div><span className="text-slate-500">Lock Reason:</span> <span className="text-red-700 font-semibold">{unblockTarget.lockReason || 'Consecutive failed attempts'}</span></div>
              </div>

              <div>
                <div className="text-[11px] font-bold uppercase text-slate-600 mb-1.5">
                  Recent Failed Attempt History ({unblockFailedHistory.length})
                </div>
                <div className="border border-slate-200 rounded-xl max-h-36 overflow-y-auto divide-y divide-slate-100 bg-slate-50/50">
                  {unblockFailedHistory.slice(0, 6).map((f) => (
                    <div key={f.id} className="px-3 py-1.5 text-[11px] flex items-center justify-between gap-2">
                      <span className="font-mono text-slate-600">{formatDateTime(f.timestamp)}</span>
                      <span className="font-mono text-slate-800">{f.ipAddress}</span>
                      <span className="text-red-700 font-semibold">{f.outcome}</span>
                    </div>
                  ))}
                  {unblockFailedHistory.length === 0 && (
                    <div className="p-3 text-center text-slate-400">No recent failure logs recorded.</div>
                  )}
                </div>
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">
                  Unblock Authorization Reason (Mandatory)
                </label>
                <input
                  type="text"
                  required
                  minLength={5}
                  value={unblockReason}
                  onChange={(e) => setUnblockReason(e.target.value)}
                  placeholder="e.g., Verified employee identity on shift desk"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              <label className="flex items-start gap-2.5 p-3 rounded-xl bg-amber-50 border border-amber-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={unblockConfirmed}
                  onChange={(e) => setUnblockConfirmed(e.target.checked)}
                  className="mt-0.5 rounded border-slate-300"
                />
                <span className="text-[11px] font-semibold text-amber-950 leading-relaxed">
                  I confirm I want to reset consecutive failed attempts to <strong>0</strong> and change account status from <strong>LOCKED</strong> to <strong>ACTIVE</strong>.
                </span>
              </label>

              {unblockError && (
                <div className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-red-700 font-semibold">
                  {unblockError}
                </div>
              )}
            </div>

            <div className="px-5 py-3 bg-slate-50 border-t border-slate-200 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setUnblockTarget(null)}
                className="px-3.5 py-2 rounded-lg border border-slate-300 text-slate-700 text-xs font-semibold cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isUnblocking || !unblockConfirmed || unblockReason.trim().length < 5}
                className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                <Unlock className="w-3.5 h-3.5" />
                <span>{isUnblocking ? 'Unblocking...' : 'Confirm & Unblock Account'}</span>
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ================================================================= */}
      {/* MODAL 5: GENERATE NEW TEMPORARY PASSWORD (SUPER ADMIN RE-AUTH)    */}
      {/* ================================================================= */}
      {tempPwdTarget && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-lg overflow-hidden">
            <div className="px-5 py-4 bg-amber-600 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <KeyRound className="w-5 h-5" />
                <h3 className="font-bold text-sm uppercase tracking-wider">
                  Generate Temporary Password — {tempPwdTarget.loginId}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setTempPwdTarget(null)}
                className="text-amber-100 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {generatedTempResult ? (
              <div className="p-5 space-y-4 text-xs">
                <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-900">
                  <div className="font-bold text-sm flex items-center gap-1.5">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    One-Time Temporary Password Generated
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed">
                    Existing Firebase UID (<span className="font-mono font-bold">{generatedTempResult.firebaseUid}</span>) was updated in-place.{' '}
                    <strong>Mandatory password change on next login is enforced.</strong>
                  </p>
                </div>

                <div className="p-4 rounded-xl bg-slate-900 text-white space-y-2">
                  <div className="text-[10px] uppercase tracking-wider text-amber-300 font-bold">
                    One-Time Display (Never Stored in Database or Logs)
                  </div>
                  <div className="flex items-center justify-between gap-3 bg-slate-800 px-3.5 py-2.5 rounded-lg border border-slate-700">
                    <code className="font-mono text-base font-bold tracking-wider text-emerald-300 select-all">
                      {generatedTempResult.temporaryPassword}
                    </code>
                    <button
                      type="button"
                      onClick={handleCopyTempPassword}
                      className="px-2.5 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white font-semibold flex items-center gap-1 text-[11px] cursor-pointer"
                    >
                      {copiedTempPwd ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copiedTempPwd ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                  <p className="text-[11px] text-slate-300">
                    Share securely with the account holder. Closing this window clears the temporary password from memory permanently.
                  </p>
                </div>

                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => setTempPwdTarget(null)}
                    className="px-4 py-2 rounded-lg bg-slate-900 text-white font-bold text-xs cursor-pointer"
                  >
                    Done &amp; Clear from Screen
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleGenerateTempPassword} className="p-5 space-y-4 text-xs">
                <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-1">
                  <div><span className="text-slate-500">Target Login ID:</span> <strong className="font-mono">{tempPwdTarget.loginId}</strong> ({tempPwdTarget.role})</div>
                  <div><span className="text-slate-500">Preserved UID:</span> <span className="font-mono text-[11px]">{tempPwdTarget.firebaseUid}</span></div>
                  <div className="text-[11px] text-amber-800 font-medium pt-1">
                    Generates a strong 14-character random password, updates the existing Firebase UID in place, revokes prior sessions, and forces password change on next login.
                  </div>
                </div>

                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    Fresh Super Admin Authentication (Your Current Password)
                  </label>
                  <input
                    type="password"
                    required
                    value={freshSuperAdminPassword}
                    onChange={(e) => setFreshSuperAdminPassword(e.target.value)}
                    placeholder="Re-enter Super Admin password to authorize"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-amber-500"
                  />
                </div>

                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    Password Reset Reason (Mandatory Audit Note)
                  </label>
                  <input
                    type="text"
                    required
                    minLength={5}
                    value={tempPwdReason}
                    onChange={(e) => setTempPwdReason(e.target.value)}
                    placeholder="e.g., Operator forgot password after unlock"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-amber-500"
                  />
                </div>

                {tempPwdError && (
                  <div className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-red-700 font-semibold">
                    {tempPwdError}
                  </div>
                )}

                <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={() => setTempPwdTarget(null)}
                    className="px-3.5 py-2 rounded-lg border border-slate-300 text-slate-700 font-semibold cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isGeneratingTempPwd || !freshSuperAdminPassword || tempPwdReason.trim().length < 5}
                    className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                  >
                    <KeyRound className="w-3.5 h-3.5" />
                    <span>{isGeneratingTempPwd ? 'Generating...' : 'Generate Temporary Password'}</span>
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* MODAL: RESET SUPER ADMIN PROGRESSIVE LOCKOUT LEVEL */}
      {resetLevelTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-lg overflow-hidden">
            <div className="px-5 py-4 bg-slate-900 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <RotateCcw className="w-4 h-4 text-blue-400" />
                <h3 className="text-sm font-bold tracking-wide uppercase">
                  Reset Super Admin Progressive Lockout Level
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setResetLevelTarget(null)}
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleConfirmResetLevel} className="p-5 space-y-4 text-xs">
              <div className="p-3 rounded-xl bg-blue-50 border border-blue-200 space-y-1 text-blue-950">
                <div>
                  <span className="text-blue-700">Target Account:</span>{' '}
                  <strong className="font-mono">{resetLevelTarget.loginId}</strong> ({resetLevelTarget.role})
                </div>
                <div>
                  <span className="text-blue-700">Current Escalation Level:</span>{' '}
                  <strong className="font-mono">Level {resetLevelTarget.progressiveLockLevel || 0} / 4</strong>{' '}
                  (Historical Lockouts: <strong>{resetLevelTarget.totalLockoutEvents || 0}</strong>)
                </div>
                <p className="text-[11px] text-blue-800 pt-1">
                  Resets the progressive escalation level back to 0 (next 3-strike lock starts at 10 minutes) while preserving full lockout audit history.
                </p>
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">
                  Fresh Super Admin Authentication (Your Current Password)
                </label>
                <input
                  type="password"
                  required
                  value={resetLevelPassword}
                  onChange={(e) => setResetLevelPassword(e.target.value)}
                  placeholder="Re-enter Super Admin password to authorize"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">
                  Governance Reason (Mandatory Audit Note)
                </label>
                <input
                  type="text"
                  required
                  minLength={5}
                  value={resetLevelReason}
                  onChange={(e) => setResetLevelReason(e.target.value)}
                  placeholder="e.g., Security incident reviewed and resolved"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <label className="flex items-start gap-2 cursor-pointer text-slate-700 font-medium">
                <input
                  type="checkbox"
                  checked={resetLevelConfirmed}
                  onChange={(e) => setResetLevelConfirmed(e.target.checked)}
                  className="mt-0.5 rounded text-blue-600 focus:ring-blue-500 w-4 h-4"
                />
                <span>
                  I confirm this approved security action to reset the canonical Super Admin progressive lockout level to 0.
                </span>
              </label>

              {resetLevelError && (
                <div className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-red-700 font-semibold">
                  {resetLevelError}
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setResetLevelTarget(null)}
                  className="px-3.5 py-2 rounded-lg border border-slate-300 text-slate-700 font-semibold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={
                    isResettingLevel ||
                    !resetLevelConfirmed ||
                    !resetLevelPassword ||
                    resetLevelReason.trim().length < 5
                  }
                  className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>{isResettingLevel ? 'Resetting...' : 'Reset Lockout Level'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
