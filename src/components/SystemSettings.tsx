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
  Users
} from 'lucide-react';
import { SystemSetting, AuditLog } from '../types';
import { 
  getSystemSettings, 
  updateSystemSettings, 
  getAuditLogs, 
  loadAuthenticIndustrialManpower,
  clearAllAttendanceRecords 
} from '../services/masterService';
import { formatTimeDisplay } from '../services/attendanceService';

interface SystemSettingsProps {
  onRefreshData?: () => void;
}

export const SystemSettingsView: React.FC<SystemSettingsProps> = ({ onRefreshData }) => {
  const [settings, setSettings] = useState<SystemSetting | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isSeeding, setIsSeeding] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [activeTab, setActiveTab] = useState<'settings' | 'audit'>('settings');

  const loadData = async () => {
    setLoading(true);
    try {
      const s = await getSystemSettings();
      setSettings(s);
      const logs = await getAuditLogs(100);
      setAuditLogs(logs);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    setIsSaving(true);
    try {
      await updateSystemSettings(settings);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
      onRefreshData?.();
      await loadData();
    } catch (err: any) {
      alert(`Failed to save settings: ${err.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleLoadAuthenticManpower = async () => {
    if (!confirm('This will load authentic industrial manpower records (30 factory employees: Operators, Inspectors, Shift Supervisors, PPC & Store Officers) into Firestore. Continue?')) return;
    setIsSeeding(true);
    try {
      const res = await loadAuthenticIndustrialManpower();
      setActionNotice(`Successfully loaded ${res.count} authentic industrial manpower records!`);
      setTimeout(() => setActionNotice(null), 5000);
      onRefreshData?.();
      await loadData();
    } catch (err: any) {
      alert(`Failed to load manpower records: ${err.message}`);
    } finally {
      setIsSeeding(false);
    }
  };

  const handleClearAttendance = async () => {
    if (!confirm('Are you sure you want to remove all attendance and punch logs? This will leave your Employee Master intact and reset the attendance board to 0 for real live scanning.')) return;
    setIsClearing(true);
    try {
      const res = await clearAllAttendanceRecords();
      setActionNotice(`Cleared ${res.deletedAttendance} attendance records and ${res.deletedLogs} punch logs. Ready for real scanning!`);
      setTimeout(() => setActionNotice(null), 5000);
      onRefreshData?.();
      await loadData();
    } catch (err: any) {
      alert(`Clear failed: ${err.message}`);
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
          {/* Wipe Test Attendance */}
          <button
            onClick={handleClearAttendance}
            disabled={isClearing}
            title="Wipe test attendance & raw logs for a clean production day"
            className="bg-slate-100 hover:bg-red-50 text-slate-700 hover:text-red-700 border border-slate-300 hover:border-red-300 font-medium text-xs px-3 py-2 rounded flex items-center gap-1.5 transition disabled:opacity-50"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>{isClearing ? 'Clearing...' : 'Clear Attendance Records'}</span>
          </button>

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

      {/* TAB 2: IMMUTABLE AUDIT TRAIL */}
      {activeTab === 'audit' && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
          <div className="overflow-x-auto max-h-[600px]">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-600 uppercase font-semibold border-b border-slate-200 sticky top-0">
                <tr>
                  <th className="py-2.5 px-3.5">Timestamp</th>
                  <th className="py-2.5 px-3.5">Action</th>
                  <th className="py-2.5 px-3.5">Employee ID</th>
                  <th className="py-2.5 px-3.5">Source</th>
                  <th className="py-2.5 px-3.5">New Value / Outcome</th>
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
                      <td className="py-2.5 px-3.5 font-mono text-slate-500 text-[11px]">
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
                        <span className="font-bold text-slate-800">{log.action}</span>
                      </td>
                      <td className="py-2.5 px-3.5 font-mono font-bold text-blue-700">
                        {log.employeeId || '--'}
                      </td>
                      <td className="py-2.5 px-3.5 text-slate-600 font-mono text-[11px]">
                        {log.actionSource}
                      </td>
                      <td className="py-2.5 px-3.5 text-slate-700 font-medium">
                        {log.newValue || '--'}
                      </td>
                      <td className="py-2.5 px-3.5 text-slate-500 text-[11px]">
                        {log.reason || '--'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
