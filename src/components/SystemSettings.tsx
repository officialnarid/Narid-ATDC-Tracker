import React, { useState, useEffect } from 'react';
import { 
  Settings, 
  History, 
  Save, 
  RotateCcw, 
  CheckCircle2, 
  AlertTriangle, 
  Database,
  Building,
  Clock,
  ShieldAlert,
  Trash2,
  Users,
  FileSearch,
  Lock,
  ArrowUpRight
} from 'lucide-react';
import { SystemSetting, AuditLog, UserRoleRecord } from '../types';
import { 
  getSystemSettings, 
  updateSystemSettings, 
  getAuditLogs, 
  loadAuthenticIndustrialManpower,
  clearAllAttendanceRecords 
} from '../services/masterService';
import { AuditKpis, fetchAuditLogs } from '../services/auditService';

interface SystemSettingsProps {
  onRefreshData?: () => void;
  currentUserRole?: UserRoleRecord | null;
  onOpenAuditConsole?: () => void;
}

const safeText = (val: any, fallback = '--'): string => {
  if (val === null || val === undefined || val === '') return fallback;
  if (typeof val === 'object') {
    try {
      return JSON.stringify(val);
    } catch {
      return '[Object]';
    }
  }
  return String(val);
};

export const SystemSettingsView: React.FC<SystemSettingsProps> = ({
  onRefreshData,
  currentUserRole,
  onOpenAuditConsole,
}) => {
  const isSuperAdmin = currentUserRole?.role?.toUpperCase() === 'SUPER_ADMIN';

  const [settings, setSettings] = useState<SystemSetting | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [auditKpis, setAuditKpis] = useState<AuditKpis | null>(null);
  const [loading, setLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isSeeding, setIsSeeding] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [showClearModal, setShowClearModal] = useState(false);
  const [clearConfirmPhrase, setClearConfirmPhrase] = useState('');
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [activeTab, setActiveTab] = useState<'settings' | 'audit'>('settings');

  const loadData = async () => {
    setLoading(true);
    try {
      const s = await getSystemSettings();
      setSettings({
        ...s,
        auditRetentionDays: s.auditRetentionDays ?? 90,
        protectCriticalLogs: s.protectCriticalLogs ?? true,
        captureGeoLocation: s.captureGeoLocation ?? true,
        failedLoginAlertThreshold: s.failedLoginAlertThreshold ?? 5,
      });

      if (isSuperAdmin) {
        try {
          const enriched = await fetchAuditLogs({ pageSize: 50, lifecycle: 'all' });
          setAuditLogs(enriched.logs);
          setAuditKpis(enriched.kpis);
        } catch {
          const logs = await getAuditLogs(100);
          setAuditLogs(logs);
        }
      } else {
        setAuditLogs([]);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [isSuperAdmin]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    setIsSaving(true);
    setActionError(null);
    try {
      await updateSystemSettings(settings);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
      onRefreshData?.();
      await loadData();
    } catch (err: any) {
      setActionError(`Failed to save settings: ${err.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleLoadAuthenticManpower = async () => {
    if (!confirm('This will load authentic industrial manpower records (30 factory employees: Operators, Inspectors, Shift Supervisors, PPC & Store Officers) into Firestore. Continue?')) return;
    setIsSeeding(true);
    setActionError(null);
    try {
      const res = await loadAuthenticIndustrialManpower();
      setActionNotice(`Successfully loaded ${res.count} authentic industrial manpower records!`);
      setTimeout(() => setActionNotice(null), 5000);
      onRefreshData?.();
      await loadData();
    } catch (err: any) {
      setActionError(`Failed to load manpower records: ${err.message}`);
    } finally {
      setIsSeeding(false);
    }
  };

  const handleClearAttendance = () => {
    if (!isSuperAdmin) return;
    setClearConfirmPhrase('');
    setShowClearModal(true);
  };

  const confirmClearAttendance = async () => {
    if (!isSuperAdmin || clearConfirmPhrase.trim() !== 'CLEAR_ALL_ATTENDANCE') return;
    setIsClearing(true);
    setActionError(null);
    try {
      const res = await clearAllAttendanceRecords('CLEAR_ALL_ATTENDANCE');
      setShowClearModal(false);
      setClearConfirmPhrase('');
      setActionNotice(`Cleared ${res.deletedAttendance} attendance records and ${res.deletedLogs} punch logs. Ready for real scanning!`);
      setTimeout(() => setActionNotice(null), 5000);
      onRefreshData?.();
      await loadData();
    } catch (err: any) {
      setShowClearModal(false);
      setActionError(`Clear failed: ${err.message}`);
    } finally {
      setIsClearing(false);
    }
  };

  if (!settings && loading) {
    return <div className="p-8 text-center text-xs text-slate-500">Loading system settings...</div>;
  }

  return (
    <div className="p-6 bg-slate-50 min-h-full flex flex-col gap-6">
      {/* Title */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
            <Settings className="w-5 h-5 text-blue-600" />
            <span>SYSTEM SETTINGS & AUDIT TRAIL</span>
          </h2>
          <p className="text-xs text-slate-500">
            Attendance thresholds, automatic shift closing policies, and database hygiene controls
          </p>
        </div>

        {/* Database Controls */}
        <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
          {isSuperAdmin && (
            <button
              onClick={handleClearAttendance}
              disabled={isClearing}
              title="Wipe test attendance & raw logs (blocked in production unless ALLOW_ATTENDANCE_CLEAR=true)"
              className="bg-slate-100 hover:bg-red-50 text-slate-700 hover:text-red-700 border border-slate-300 hover:border-red-300 font-medium text-xs px-3 py-2 rounded flex items-center gap-1.5 transition disabled:opacity-50"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>{isClearing ? 'Clearing...' : 'Clear Attendance Records'}</span>
            </button>
          )}

          {/* Load Authentic Manpower */}
          <button
            onClick={handleLoadAuthenticManpower}
            disabled={isSeeding}
            className="bg-blue-600 hover:bg-blue-700 text-white font-medium text-xs px-3.5 py-2 rounded flex items-center gap-2 shadow-sm transition disabled:opacity-50"
          >
            <Users className="w-3.5 h-3.5" />
            <span>{isSeeding ? 'Loading...' : 'Load Authentic Manpower (30 Employees)'}</span>
          </button>
        </div>
      </div>

      {actionNotice && (
        <div className="bg-emerald-50 text-emerald-900 border border-emerald-300 px-4 py-2.5 rounded-xl text-xs font-semibold flex items-center gap-2 animate-fadeIn">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
          <span>{actionNotice}</span>
        </div>
      )}

      {actionError && (
        <div className="bg-red-50 text-red-900 border border-red-300 px-4 py-2.5 rounded-xl text-xs font-semibold flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
          <span>{actionError}</span>
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-2 border-b border-slate-200">
        <button
          onClick={() => setActiveTab('settings')}
          className={`pb-2.5 px-3 text-xs font-semibold transition border-b-2 ${
            activeTab === 'settings' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          Attendance Configuration
        </button>
        <button
          onClick={() => setActiveTab('audit')}
          className={`pb-2.5 px-3 text-xs font-semibold transition border-b-2 ${
            activeTab === 'audit' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          System Audit Trail ({auditLogs.length} Events)
        </button>
      </div>

      {activeTab === 'settings' && settings && (
        <form onSubmit={handleSave} className="bg-white rounded-xl border border-slate-200 shadow-2xs p-6 flex flex-col gap-6 max-w-4xl">
          {saveSuccess && (
            <div className="bg-emerald-50 text-emerald-800 p-3 rounded-lg border border-emerald-300 text-xs flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              <span>Settings updated successfully!</span>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 text-xs">
            <div>
              <label className="block text-slate-700 font-semibold mb-1">Company / Plant Name</label>
              <input
                type="text"
                required
                value={settings.companyName}
                onChange={(e) => setSettings({ ...settings, companyName: e.target.value })}
                className="w-full border border-slate-300 rounded px-3 py-2 text-xs"
              />
            </div>

            <div>
              <label className="block text-slate-700 font-semibold mb-1">Website Title</label>
              <input
                type="text"
                required
                value={settings.websiteName}
                onChange={(e) => setSettings({ ...settings, websiteName: e.target.value })}
                className="w-full border border-slate-300 rounded px-3 py-2 text-xs"
              />
            </div>

            <div>
              <label className="block text-slate-700 font-semibold mb-1">Timezone</label>
              <input
                type="text"
                disabled
                value={settings.timezone}
                className="w-full border border-slate-300 bg-slate-100 rounded px-3 py-2 text-xs font-mono"
              />
              <span className="text-[10px] text-slate-400 mt-1 block">Asia/Kolkata (Indian Standard Time)</span>
            </div>

            <div>
              <label className="block text-slate-700 font-semibold mb-1">Late Arrival Grace Period (Minutes)</label>
              <input
                type="number"
                min="0"
                max="60"
                value={settings.lateGraceMinutes}
                onChange={(e) => setSettings({ ...settings, lateGraceMinutes: Number(e.target.value) })}
                className="w-full border border-slate-300 rounded px-3 py-2 text-xs"
              />
              <span className="text-[10px] text-slate-400 mt-1 block">Punches after Shift Start + Grace are marked LATE.</span>
            </div>

            <div>
              <label className="block text-slate-700 font-semibold mb-1">Regular Scheduled Duty (Minutes)</label>
              <input
                type="number"
                min="300"
                max="720"
                value={settings.scheduledDurationMinutes}
                onChange={(e) => setSettings({ ...settings, scheduledDurationMinutes: Number(e.target.value) })}
                className="w-full border border-slate-300 rounded px-3 py-2 text-xs"
              />
              <span className="text-[10px] text-slate-400 mt-1 block">510 minutes = 08 Hours 30 Minutes standard duty.</span>
            </div>

            <div>
              <label className="block text-slate-700 font-semibold mb-1">Overtime Threshold (Minutes)</label>
              <input
                type="number"
                min="300"
                max="720"
                value={settings.overtimeThresholdMinutes}
                onChange={(e) => setSettings({ ...settings, overtimeThresholdMinutes: Number(e.target.value) })}
                className="w-full border border-slate-300 rounded px-3 py-2 text-xs"
              />
              <span className="text-[10px] text-slate-400 mt-1 block">Duration above this threshold qualifies as Overtime.</span>
            </div>
          </div>

          {/* Security Monitoring & Audit Retention Governance */}
          <div className="border-t border-slate-200 pt-5 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
                  <Lock className="w-3.5 h-3.5 text-blue-600" />
                  <span>Security Monitoring &amp; Audit Retention Policy</span>
                </h3>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Controls retention eligibility, critical log immutability, IP geolocation enrichment, and failed login alert thresholds.
                </p>
              </div>
              {isSuperAdmin && onOpenAuditConsole && (
                <button
                  type="button"
                  onClick={onOpenAuditConsole}
                  className="px-3 py-1.5 rounded-lg bg-[#0a192f] hover:bg-slate-800 text-white text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer shrink-0"
                >
                  <FileSearch className="w-3.5 h-3.5 text-blue-400" />
                  <span>Open Security Console</span>
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
              <div>
                <label className="block text-slate-700 font-semibold mb-1">Audit Retention Window (Days)</label>
                <input
                  type="number"
                  min="30"
                  max="3650"
                  value={settings.auditRetentionDays ?? 90}
                  onChange={(e) => setSettings({ ...settings, auditRetentionDays: Math.max(30, Number(e.target.value)) })}
                  className="w-full border border-slate-300 rounded px-3 py-2 text-xs font-mono"
                />
                <span className="text-[10px] text-slate-400 mt-1 block">
                  Default: 90 days before non-critical logs become eligible for Super Admin archival/review.
                </span>
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">Failed Login Security Alert Threshold</label>
                <input
                  type="number"
                  min="3"
                  max="20"
                  value={settings.failedLoginAlertThreshold ?? 5}
                  onChange={(e) => setSettings({ ...settings, failedLoginAlertThreshold: Math.max(3, Number(e.target.value)) })}
                  className="w-full border border-slate-300 rounded px-3 py-2 text-xs font-mono"
                />
                <span className="text-[10px] text-slate-400 mt-1 block">
                  Triggers CRITICAL security alert after consecutive failed login attempts.
                </span>
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">
                  Super Admin Lockout Level Reset (Hours)
                </label>
                <input
                  type="number"
                  min="6"
                  max="720"
                  value={settings.superAdminLockoutResetHours ?? 24}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      superAdminLockoutResetHours: Math.min(720, Math.max(6, Number(e.target.value) || 24)),
                    })
                  }
                  className="w-full border border-slate-300 rounded px-3 py-2 text-xs font-mono"
                />
                <span className="text-[10px] text-slate-400 mt-1 block">
                  Sustained clean usage window (6–720h, default 24h) before Super Admin progressive lockout resets to 10m.
                </span>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center gap-4 text-xs">
              <label className="flex items-center gap-2 cursor-pointer font-medium text-slate-700">
                <input
                  type="checkbox"
                  checked={settings.protectCriticalLogs ?? true}
                  onChange={(e) => setSettings({ ...settings, protectCriticalLogs: e.target.checked })}
                  className="rounded text-blue-600 focus:ring-blue-500 w-4 h-4"
                />
                <span>Enforce immutable protection on CRITICAL security &amp; Important logs</span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer font-medium text-slate-700">
                <input
                  type="checkbox"
                  checked={settings.captureGeoLocation ?? true}
                  onChange={(e) => setSettings({ ...settings, captureGeoLocation: e.target.checked })}
                  className="rounded text-blue-600 focus:ring-blue-500 w-4 h-4"
                />
                <span>Resolve coarse IP GeoLocation on login &amp; audit events</span>
              </label>
            </div>
          </div>

          <div className="border-t border-slate-200 pt-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="auto-punch-out"
                checked={settings.autoPunchOutEnabled}
                onChange={(e) => setSettings({ ...settings, autoPunchOutEnabled: e.target.checked })}
                className="rounded text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer"
              />
              <label htmlFor="auto-punch-out" className="text-xs font-semibold text-slate-800 cursor-pointer">
                Enable Automated Scheduled Shift Closing (Auto-closes open punches past scheduled shift end)
              </label>
            </div>

            <button
              type="submit"
              disabled={isSaving}
              className="bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium px-4 py-2 rounded flex items-center gap-1.5 shadow-sm transition disabled:opacity-50"
            >
              <Save className="w-4 h-4" />
              <span>{isSaving ? 'Saving...' : 'Save Configuration'}</span>
            </button>
          </div>
        </form>
      )}

      {/* TAB 2: SECURITY ACTIVITY & AUDIT TRAIL PREVIEW */}
      {activeTab === 'audit' && (
        <div className="space-y-4">
          {isSuperAdmin && (
            <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 flex-1 text-xs">
                <div>
                  <div className="text-[10px] font-bold uppercase text-slate-500">Total Logs</div>
                  <div className="text-lg font-extrabold font-mono text-slate-900">{auditKpis?.totalLogs ?? auditLogs.length}</div>
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase text-emerald-600">Login Success</div>
                  <div className="text-lg font-extrabold font-mono text-emerald-700">{auditKpis?.successfulLogins ?? 0}</div>
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase text-red-600">Security Alerts</div>
                  <div className="text-lg font-extrabold font-mono text-red-700">{auditKpis?.securityAlerts ?? 0}</div>
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase text-amber-600">Pending &gt;{settings?.auditRetentionDays ?? 90}d</div>
                  <div className="text-lg font-extrabold font-mono text-amber-700">{auditKpis?.pendingLogReviews ?? 0}</div>
                </div>
              </div>

              {onOpenAuditConsole && (
                <button
                  type="button"
                  onClick={onOpenAuditConsole}
                  className="px-4 py-2 rounded-lg bg-[#0a192f] hover:bg-slate-800 text-white text-xs font-bold flex items-center gap-2 shrink-0 cursor-pointer"
                >
                  <FileSearch className="w-4 h-4 text-blue-400" />
                  <span>Open Full Security &amp; Audit Console</span>
                  <ArrowUpRight className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}

          <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
            <div className="overflow-x-auto max-h-[600px]">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-600 uppercase font-semibold border-b border-slate-200 sticky top-0">
                  <tr>
                    <th className="py-2.5 px-3.5">Timestamp</th>
                    <th className="py-2.5 px-3.5">Action / Category</th>
                    <th className="py-2.5 px-3.5">Actor / Target</th>
                    <th className="py-2.5 px-3.5">IP &amp; Source</th>
                    <th className="py-2.5 px-3.5">New Value / Description</th>
                    <th className="py-2.5 px-3.5">Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {auditLogs.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-slate-400">
                        No audit events recorded yet.
                      </td>
                    </tr>
                  ) : (
                    auditLogs.map((log) => (
                      <tr key={log.id} className="hover:bg-slate-50">
                        <td className="py-2.5 px-3.5 font-mono text-slate-500 text-[11px] whitespace-nowrap">
                          {new Date(log.timestamp).toLocaleString('en-IN', {
                            day: '2-digit',
                            month: 'short',
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                            hour12: true,
                          })}
                        </td>
                        <td className="py-2.5 px-3.5">
                          <span className="font-bold text-slate-800">{safeText(log.action)}</span>
                          {log.category && (
                            <span className="ml-1.5 px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-mono text-[9px] font-bold">
                              {log.category}
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 px-3.5 font-mono text-[11px]">
                          <span className="font-bold text-blue-700">{safeText(log.actorLoginId || log.employeeId)}</span>
                          {log.employeeId && log.actorLoginId && (
                            <span className="block text-[10px] text-slate-500">Emp: {log.employeeId}</span>
                          )}
                        </td>
                        <td className="py-2.5 px-3.5 text-slate-600 font-mono text-[11px]">
                          <div>{safeText(log.ipAddress, '--')}</div>
                          <div className="text-[10px] text-slate-400">{safeText(log.actionSource)}</div>
                        </td>
                        <td className="py-2.5 px-3.5 text-slate-700 font-medium font-mono text-[11px] max-w-[280px] truncate" title={safeText(log.description || log.newValue)}>
                          {safeText(log.description || log.newValue)}
                        </td>
                        <td className="py-2.5 px-3.5 text-slate-500 text-[11px] max-w-[200px] truncate" title={safeText(log.reason)}>
                          {safeText(log.reason)}
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

      {showClearModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
          <div className="bg-white rounded-xl border border-red-200 shadow-2xl max-w-md w-full p-5 space-y-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
              <div>
                <h3 className="text-sm font-bold text-slate-900">Confirm Attendance Data Reset</h3>
                <p className="text-xs text-slate-600 mt-1">
                  This permanently deletes all attendance records, punch logs, and shift rosters. Type{' '}
                  <span className="font-mono font-bold text-red-700">CLEAR_ALL_ATTENDANCE</span> to proceed.
                </p>
              </div>
            </div>
            <input
              type="text"
              value={clearConfirmPhrase}
              onChange={(e) => setClearConfirmPhrase(e.target.value)}
              placeholder="Type CLEAR_ALL_ATTENDANCE"
              className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded focus:outline-none focus:ring-2 focus:ring-red-500"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowClearModal(false);
                  setClearConfirmPhrase('');
                }}
                disabled={isClearing}
                className="px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmClearAttendance}
                disabled={isClearing || clearConfirmPhrase.trim() !== 'CLEAR_ALL_ATTENDANCE'}
                className="px-3 py-1.5 text-xs font-bold text-white bg-red-600 hover:bg-red-700 rounded disabled:opacity-40"
              >
                {isClearing ? 'Clearing...' : 'Confirm Wipe'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
