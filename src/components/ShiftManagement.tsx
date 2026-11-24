import React, { useState, useEffect } from 'react';
import { getSafeErrorText } from '../services/errorHandlingService';
import {
  Clock,
  Plus,
  Edit2,
  CheckCircle,
  CheckCircle2,
  XCircle,
  X,
  AlertCircle,
  AlertTriangle,
  FileSpreadsheet,
  Download,
  Settings,
  Save,
  Lock,
  FileSearch,
} from 'lucide-react';
import { Shift, SystemSetting, UserRoleRecord } from '../types';
import { saveShift, getSystemSettings, updateSystemSettings } from '../services/masterService';
import { isModuleAllowedForUser } from '../services/authService';
import { RolePermissionRecord, hasModulePermission } from '../services/permissionService';
import { formatMinutes } from '../services/attendanceService';
import { ShiftManagementSkeleton } from './Skeletons';
import { useBulkSelection } from '../hooks/useBulkSelection';
import {
  BulkActionBar,
  BulkExecutionSummary,
  BulkProgressState,
  SelectAllCheckbox,
} from './BulkActionBar';
import { BulkConfirmModal } from './BulkConfirmModal';
import {
  executeMasterBulkStatus,
  exportChunkedToCsv,
  exportChunkedToExcel,
} from '../services/bulkActionService';

interface ShiftManagementProps {
  shifts: Shift[];
  isLoading?: boolean;
  loadError?: string | null;
  onRefresh: () => void;
  currentUserRole?: UserRoleRecord | null;
  rolePermissions?: Record<string, RolePermissionRecord>;
  onOpenAuditConsole?: () => void;
}

export const ShiftManagement: React.FC<ShiftManagementProps> = ({
  shifts,
  isLoading = false,
  loadError = null,
  onRefresh,
  currentUserRole,
  rolePermissions,
  onOpenAuditConsole,
}) => {
  const isSuperAdmin = currentUserRole?.role?.toUpperCase() === 'SUPER_ADMIN';
  const canViewAttendanceConfig =
    isSuperAdmin || isModuleAllowedForUser(currentUserRole, 'settings');
  const [activeSubTab, setActiveSubTab] = useState<'shifts' | 'attendance_config'>('shifts');

  // Attendance Configuration state (moved from System Settings)
  const [attendanceConfig, setAttendanceConfig] = useState<SystemSetting | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [configSaveSuccess, setConfigSaveSuccess] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);

  const loadAttendanceConfig = async () => {
    setConfigLoading(true);
    setConfigError(null);
    try {
      const s = await getSystemSettings();
      setAttendanceConfig({
        ...s,
        auditRetentionDays: s.auditRetentionDays ?? 90,
        protectCriticalLogs: s.protectCriticalLogs ?? true,
        captureGeoLocation: s.captureGeoLocation ?? true,
        failedLoginAlertThreshold: s.failedLoginAlertThreshold ?? 5,
      });
    } catch (err: any) {
      setConfigError(getSafeErrorText(err, { moduleName: 'Shift Management', endpoint: '/api/settings' }));
    } finally {
      setConfigLoading(false);
    }
  };

  useEffect(() => {
    if (activeSubTab === 'attendance_config' && canViewAttendanceConfig && !attendanceConfig && !configLoading) {
      void loadAttendanceConfig();
    }
  }, [activeSubTab, canViewAttendanceConfig]);

  const handleSaveAttendanceConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!attendanceConfig) return;
    setIsSavingConfig(true);
    setConfigError(null);
    try {
      await updateSystemSettings(attendanceConfig);
      setConfigSaveSuccess(true);
      setTimeout(() => setConfigSaveSuccess(false), 3000);
      onRefresh();
      await loadAttendanceConfig();
    } catch (err: any) {
      setConfigError(getSafeErrorText(err, { moduleName: 'Shift Management', endpoint: '/api/settings' }));
    } finally {
      setIsSavingConfig(false);
    }
  };

  const canAddShift = currentUserRole
    ? hasModulePermission(currentUserRole.role, 'shifts', 'add', rolePermissions)
    : true;
  const canEditShift = currentUserRole
    ? hasModulePermission(currentUserRole.role, 'shifts', 'edit', rolePermissions)
    : true;
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingShift, setEditingShift] = useState<Partial<Shift>>({
    id: '',
    name: '',
    startTime: '09:00',
    endTime: '17:30',
    scheduledDurationMinutes: 510,
    punchInWindowStart: '07:30',
    punchInWindowEnd: '12:00',
    isOvernight: false,
    gracePeriodMinutes: 15,
    status: 'Active',
  });
  const [isSaving, setIsSaving] = useState(false);
  const [togglingShiftId, setTogglingShiftId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const handleOpenAdd = () => {
    setEditingShift({
      id: `SHIFT_${Date.now()}`,
      name: '',
      startTime: '06:00',
      endTime: '14:30',
      scheduledDurationMinutes: 510,
      punchInWindowStart: '05:00',
      punchInWindowEnd: '08:00',
      isOvernight: false,
      gracePeriodMinutes: 15,
      status: 'Active',
    });
    setIsModalOpen(true);
  };

  const handleOpenEdit = (shift: Shift) => {
    setEditingShift({ ...shift });
    setIsModalOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingShift.name || !editingShift.startTime || !editingShift.endTime) return;
    setIsSaving(true);
    setActionError(null);
    try {
      await saveShift(editingShift as Shift);
      setIsModalOpen(false);
      onRefresh();
    } catch (err: any) {
      setActionError(getSafeErrorText(err, { moduleName: 'Shift Management', endpoint: '/api/masters/shifts' }));
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleStatus = async (shift: Shift) => {
    const nextStatus = shift.status === 'Active' ? 'Inactive' : 'Active';
    setTogglingShiftId(shift.id);
    setActionError(null);
    try {
      await saveShift({ ...shift, status: nextStatus });
      onRefresh();
    } catch (err: any) {
      setActionError(getSafeErrorText(err, { moduleName: 'Shift Management', endpoint: '/api/masters/shifts' }));
    } finally {
      setTogglingShiftId(null);
    }
  };

  const bulk = useBulkSelection<Shift>({
    items: shifts,
    paginatedItems: shifts,
    getId: (s) => s.id,
  });

  const [bulkProgress, setBulkProgress] = useState<BulkProgressState | null>(null);
  const [bulkSummary, setBulkSummary] = useState<BulkExecutionSummary | null>(null);
  const [pendingBulkStatus, setPendingBulkStatus] = useState<'Active' | 'Inactive' | null>(null);
  const [isBulkExecuting, setIsBulkExecuting] = useState(false);
  const [retryFailedStatus, setRetryFailedStatus] = useState<{
    status: 'Active' | 'Inactive';
    ids: string[];
  } | null>(null);

  const handleBulkExportShifts = async (format: 'xlsx' | 'csv') => {
    const selected = bulk.selectedItems;
    if (selected.length === 0 || isBulkExecuting) return;
    setIsBulkExecuting(true);
    setBulkSummary(null);
    setBulkProgress({
      label: `Exporting ${selected.length} shifts...`,
      completed: 0,
      total: selected.length,
    });
    try {
      const cols = [
        { header: 'Shift ID', key: 'id' },
        { header: 'Shift Name', key: 'name' },
        { header: 'Start Time', key: 'startTime' },
        { header: 'End Time', key: 'endTime' },
        { header: 'Duration (Mins)', key: 'scheduledDurationMinutes' },
        { header: 'Punch-In Start', key: 'punchInWindowStart' },
        { header: 'Punch-In End', key: 'punchInWindowEnd' },
        { header: 'Overnight', key: 'isOvernight' },
        { header: 'Status', key: 'status' },
      ];
      const rows = selected.map((s) => ({
        id: s.id,
        name: s.name,
        startTime: s.startTime,
        endTime: s.endTime,
        scheduledDurationMinutes: s.scheduledDurationMinutes,
        punchInWindowStart: s.punchInWindowStart,
        punchInWindowEnd: s.punchInWindowEnd,
        isOvernight: s.isOvernight ? 'Yes' : 'No',
        status: s.status,
      }));
      const fn = format === 'xlsx' ? exportChunkedToExcel : exportChunkedToCsv;
      const out = await fn(rows, cols, 'Shifts_Selected', {
        auditTargetType: 'SHIFTS',
        auditSource: 'SHIFT_MANAGEMENT',
      });
      setBulkSummary({
        type: 'success',
        title: `Exported ${out.rowCount} Shifts`,
        message: `Downloaded "${out.fileName}". Selection cleared.`,
        savedCount: out.rowCount,
      });
      bulk.clearSelection();
    } catch (err: any) {
      setBulkSummary({
        type: 'error',
        title: 'Shift Export Failed',
        message: getSafeErrorText(err, { moduleName: 'Shift Management', forcedErrorCode: 'FILE-002' }),
      });
    } finally {
      setBulkProgress(null);
      setIsBulkExecuting(false);
    }
  };

  const handleExecuteBulkStatus = async (
    statusOverride?: 'Active' | 'Inactive',
    overrideIds?: string[]
  ) => {
    const status = statusOverride || pendingBulkStatus;
    if (!status) return;
    const ids = overrideIds || bulk.selectedIdArray;
    if (ids.length === 0) return;

    setIsBulkExecuting(true);
    setBulkSummary(null);
    setRetryFailedStatus(null);
    setBulkProgress({
      label: `${status === 'Active' ? 'Activating' : 'Deactivating'} selected shifts...`,
      completed: 0,
      total: ids.length,
    });
    try {
      const res = await executeMasterBulkStatus({
        resource: 'shifts',
        ids,
        status,
      });
      const failedIds = (res.failedItems || []).map((f) => f.id);
      if (failedIds.length > 0) {
        setRetryFailedStatus({ status, ids: failedIds });
        bulk.setSelectedIdList(failedIds);
        setBulkSummary({
          type: res.savedCount > 0 ? 'partial' : 'error',
          title: 'Shift Bulk Update Partially Completed',
          message: `Updated ${res.savedCount} shift(s); ${res.failedCount} failed.`,
          savedCount: res.savedCount,
          failedCount: res.failedCount,
          canRetryFailed: true,
        });
      } else {
        setBulkSummary({
          type: 'success',
          title: `Updated ${res.savedCount} Shift(s)`,
          message: `Status set to ${status}. Overnight Night Shift rules remain preserved.`,
          savedCount: res.savedCount,
        });
        bulk.clearSelection();
      }
      setPendingBulkStatus(null);
      onRefresh();
    } catch (err: any) {
      setBulkSummary({
        type: 'error',
        title: 'Shift Bulk Update Blocked',
        message: getSafeErrorText(err, { moduleName: 'Shift Management', endpoint: '/api/masters/shifts/bulk' }),
      });
    } finally {
      setBulkProgress(null);
      setIsBulkExecuting(false);
    }
  };

  if (isLoading && shifts.length === 0 && !loadError) {
    return <ShiftManagementSkeleton />;
  }

  const effectiveError = loadError || actionError;

  return (
    <div className="p-6 bg-slate-50 min-h-full flex flex-col gap-6">
      {effectiveError && (
        <div role="alert" className="bg-red-50 border border-red-200 text-red-800 rounded-xl px-4 py-3 text-xs flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
            <span>{effectiveError}</span>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            className="bg-white hover:bg-red-100 text-red-700 border border-red-300 px-3 py-1 rounded font-semibold transition cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
            <Clock className="w-5 h-5 text-blue-600" />
            <span>SHIFT MANAGEMENT</span>
          </h2>
          <p className="text-xs text-slate-500">
            Configure shift timings, overnight cycles, scheduled duty duration (8h30m), and scan windows
          </p>
        </div>

        {activeSubTab === 'shifts' && (
          <div className="flex flex-wrap items-center gap-2.5">
            {shifts.length > 0 && (
              <label className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-100 border border-slate-200 text-xs font-semibold text-slate-700 cursor-pointer">
                <SelectAllCheckbox
                  checked={bulk.isPageAllSelected}
                  indeterminate={bulk.isPageIndeterminate}
                  disabled={shifts.length === 0 || isBulkExecuting}
                  onChange={bulk.togglePageSelection}
                  ariaLabel="Select all shifts"
                />
                <span>Select All Shifts</span>
              </label>
            )}
            {canAddShift && (
              <button
                onClick={handleOpenAdd}
                className="bg-blue-600 hover:bg-blue-700 text-white font-medium text-xs px-4 py-2 rounded flex items-center gap-1.5 shadow-sm transition cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>Add Custom Shift</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Sub-navigation Tabs under Shift Management */}
      {canViewAttendanceConfig && (
        <div className="flex items-center gap-2 border-b border-slate-200">
          <button
            type="button"
            onClick={() => setActiveSubTab('shifts')}
            className={`pb-2.5 px-3 text-xs font-semibold transition border-b-2 inline-flex items-center gap-1.5 cursor-pointer ${
              activeSubTab === 'shifts'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <Clock className="w-3.5 h-3.5" />
            <span>Shift Schedules</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveSubTab('attendance_config')}
            className={`pb-2.5 px-3 text-xs font-semibold transition border-b-2 inline-flex items-center gap-1.5 cursor-pointer ${
              activeSubTab === 'attendance_config'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <Settings className="w-3.5 h-3.5" />
            <span>Attendance Configuration</span>
          </button>
        </div>
      )}

      {activeSubTab === 'attendance_config' && canViewAttendanceConfig ? (
        <div className="flex flex-col gap-4">
          {configError && (
            <div className="bg-red-50 text-red-900 border border-red-300 px-4 py-2.5 rounded-xl text-xs font-semibold flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
              <span>{configError}</span>
            </div>
          )}

          {configLoading && !attendanceConfig ? (
            <div className="p-8 text-center text-xs text-slate-500 bg-white rounded-xl border border-slate-200">
              Loading attendance configuration...
            </div>
          ) : attendanceConfig ? (
            <form
              onSubmit={handleSaveAttendanceConfig}
              className="bg-white rounded-xl border border-slate-200 shadow-2xs p-6 flex flex-col gap-6 max-w-4xl"
            >
              {configSaveSuccess && (
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
                    value={attendanceConfig.companyName}
                    onChange={(e) => setAttendanceConfig({ ...attendanceConfig, companyName: e.target.value })}
                    className="w-full border border-slate-300 rounded px-3 py-2 text-xs"
                  />
                </div>

                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Website Title</label>
                  <input
                    type="text"
                    required
                    value={attendanceConfig.websiteName}
                    onChange={(e) => setAttendanceConfig({ ...attendanceConfig, websiteName: e.target.value })}
                    className="w-full border border-slate-300 rounded px-3 py-2 text-xs"
                  />
                </div>

                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Timezone</label>
                  <input
                    type="text"
                    disabled
                    value={attendanceConfig.timezone}
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
                    value={attendanceConfig.lateGraceMinutes}
                    onChange={(e) => setAttendanceConfig({ ...attendanceConfig, lateGraceMinutes: Number(e.target.value) })}
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
                    value={attendanceConfig.scheduledDurationMinutes}
                    onChange={(e) => setAttendanceConfig({ ...attendanceConfig, scheduledDurationMinutes: Number(e.target.value) })}
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
                    value={attendanceConfig.overtimeThresholdMinutes}
                    onChange={(e) => setAttendanceConfig({ ...attendanceConfig, overtimeThresholdMinutes: Number(e.target.value) })}
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
                      value={attendanceConfig.auditRetentionDays ?? 90}
                      onChange={(e) =>
                        setAttendanceConfig({ ...attendanceConfig, auditRetentionDays: Math.max(30, Number(e.target.value)) })
                      }
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
                      value={attendanceConfig.failedLoginAlertThreshold ?? 5}
                      onChange={(e) =>
                        setAttendanceConfig({ ...attendanceConfig, failedLoginAlertThreshold: Math.max(3, Number(e.target.value)) })
                      }
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
                      value={attendanceConfig.superAdminLockoutResetHours ?? 24}
                      onChange={(e) =>
                        setAttendanceConfig({
                          ...attendanceConfig,
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
                      checked={attendanceConfig.protectCriticalLogs ?? true}
                      onChange={(e) => setAttendanceConfig({ ...attendanceConfig, protectCriticalLogs: e.target.checked })}
                      className="rounded text-blue-600 focus:ring-blue-500 w-4 h-4"
                    />
                    <span>Enforce immutable protection on CRITICAL security &amp; Important logs</span>
                  </label>

                  <label className="flex items-center gap-2 cursor-pointer font-medium text-slate-700">
                    <input
                      type="checkbox"
                      checked={attendanceConfig.captureGeoLocation ?? true}
                      onChange={(e) => setAttendanceConfig({ ...attendanceConfig, captureGeoLocation: e.target.checked })}
                      className="rounded text-blue-600 focus:ring-blue-500 w-4 h-4"
                    />
                    <span>Resolve coarse IP GeoLocation on login &amp; audit events</span>
                  </label>
                </div>
              </div>

              <div className="border-t border-slate-200 pt-4 flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="auto-punch-out"
                    checked={attendanceConfig.autoPunchOutEnabled}
                    onChange={(e) => setAttendanceConfig({ ...attendanceConfig, autoPunchOutEnabled: e.target.checked })}
                    className="rounded text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer"
                  />
                  <label htmlFor="auto-punch-out" className="text-xs font-semibold text-slate-800 cursor-pointer">
                    Enable Automated Scheduled Shift Closing (Auto-closes open punches past scheduled shift end)
                  </label>
                </div>

                <button
                  type="submit"
                  disabled={isSavingConfig || !isSuperAdmin}
                  className="bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium px-4 py-2 rounded flex items-center gap-1.5 shadow-sm transition disabled:opacity-50 cursor-pointer"
                >
                  <Save className="w-4 h-4" />
                  <span>{isSavingConfig ? 'Saving...' : 'Save Configuration'}</span>
                </button>
              </div>
            </form>
          ) : null}
        </div>
      ) : (
      <>

      <BulkActionBar
        selectedCount={bulk.selectedCount}
        totalFilteredCount={bulk.totalFilteredCount}
        currentPageCount={bulk.currentPageCount}
        isAllFilteredSelected={bulk.isAllFilteredSelected}
        isPageAllSelected={bulk.isPageAllSelected}
        recordLabel="shifts"
        onClearSelection={bulk.clearSelection}
        progress={bulkProgress}
        summary={bulkSummary}
        onDismissSummary={() => setBulkSummary(null)}
        onRetryFailed={
          retryFailedStatus
            ? () => handleExecuteBulkStatus(retryFailedStatus.status, retryFailedStatus.ids)
            : undefined
        }
        actions={[
          {
            id: 'export_shifts_xlsx',
            label: 'Export Excel',
            icon: <FileSpreadsheet className="w-3.5 h-3.5" />,
            tone: 'emerald',
            onClick: () => handleBulkExportShifts('xlsx'),
          },
          {
            id: 'export_shifts_csv',
            label: 'Export CSV',
            icon: <Download className="w-3.5 h-3.5" />,
            tone: 'default',
            onClick: () => handleBulkExportShifts('csv'),
          },
          {
            id: 'activate_shifts',
            label: 'Activate',
            icon: <CheckCircle className="w-3.5 h-3.5" />,
            tone: 'primary',
            hidden: !canEditShift,
            onClick: () => setPendingBulkStatus('Active'),
          },
          {
            id: 'deactivate_shifts',
            label: 'Deactivate',
            icon: <XCircle className="w-3.5 h-3.5" />,
            tone: 'amber',
            hidden: !canEditShift,
            onClick: () => setPendingBulkStatus('Inactive'),
          },
        ]}
      />

      {/* Shifts Card Grid */}
      {shifts.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-xs text-slate-500 shadow-2xs">
          No shifts configured yet. Click &ldquo;Add Custom Shift&rdquo; or retry loading master configuration.
        </div>
      ) : (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {shifts.map(shift => {
          const isSelected = bulk.isSelected(shift.id);
          return (
          <div
            key={shift.id}
            className={`bg-white rounded-xl border p-5 shadow-2xs flex flex-col justify-between gap-4 transition ${
              isSelected
                ? 'border-blue-500 ring-2 ring-blue-500/20 bg-blue-50/20'
                : 'border-slate-200 hover:border-blue-400'
            }`}
          >
            <div>
              <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                <div className="flex items-center gap-2.5">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    disabled={isBulkExecuting}
                    onChange={() => bulk.toggleOne(shift.id)}
                    aria-label={`Select shift ${shift.name}`}
                    className="rounded text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer"
                  />
                  <div className={`w-3 h-3 rounded-full ${shift.isOvernight ? 'bg-purple-600' : 'bg-blue-600'}`}></div>
                  <h3 className="font-bold text-slate-900 text-base">{shift.name}</h3>
                </div>
                <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                  shift.isOvernight ? 'bg-purple-100 text-purple-800' : 'bg-blue-100 text-blue-800'
                }`}>
                  {shift.isOvernight ? 'Overnight Shift' : 'Day Shift'}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-4 mt-4 text-xs">
                <div>
                  <span className="text-slate-400 block text-[11px] uppercase">Shift Timing</span>
                  <span className="font-mono text-sm font-bold text-slate-800">
                    {shift.startTime} — {shift.endTime} {shift.isOvernight ? '(+1 Day)' : ''}
                  </span>
                </div>

                <div>
                  <span className="text-slate-400 block text-[11px] uppercase">Scheduled Duration</span>
                  <span className="font-mono text-sm font-bold text-emerald-700">
                    {formatMinutes(shift.scheduledDurationMinutes)}
                  </span>
                </div>

                <div>
                  <span className="text-slate-400 block text-[11px] uppercase">Punch-In Window</span>
                  <span className="font-mono text-xs font-semibold text-slate-700">
                    {shift.punchInWindowStart} to {shift.punchInWindowEnd}
                  </span>
                </div>

                <div>
                  <span className="text-slate-400 block text-[11px] uppercase">Grace Period</span>
                  <span className="font-mono text-xs font-semibold text-slate-700">
                    {shift.gracePeriodMinutes || 15} Minutes (for Late mark)
                  </span>
                </div>
              </div>

              {shift.isOvernight && (
                <div className="mt-4 p-2.5 rounded bg-purple-50 border border-purple-200 text-[11px] text-purple-900 flex items-start gap-2">
                  <AlertCircle className="w-3.5 h-3.5 text-purple-600 shrink-0 mt-0.5" />
                  <span>
                    <strong>Night Shift Rule:</strong> Begins 08:00 PM and ends 04:30 AM next calendar day. Attendance cycle is preserved against starting date.
                  </span>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between pt-3 border-t border-slate-100 text-xs">
              <button
                onClick={() => canEditShift && handleToggleStatus(shift)}
                disabled={!canEditShift || togglingShiftId === shift.id}
                className={`px-2.5 py-1 rounded text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50 ${
                  shift.status === 'Active' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-700'
                }`}
              >
                {shift.status === 'Active' ? <CheckCircle className="w-3.5 h-3.5 text-emerald-600" /> : <XCircle className="w-3.5 h-3.5 text-slate-500" />}
                <span>{togglingShiftId === shift.id ? 'Updating...' : shift.status}</span>
              </button>

              {canEditShift && (
                <button
                  onClick={() => handleOpenEdit(shift)}
                  className="bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium px-3 py-1 rounded flex items-center gap-1 cursor-pointer"
                >
                  <Edit2 className="w-3 h-3" />
                  <span>Edit Configuration</span>
                </button>
              )}
            </div>
          </div>
          );
        })}
      </div>
      )}
      </>
      )}

      {/* EDIT / CREATE MODAL */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-xl max-w-md w-full p-5 shadow-2xl border border-slate-200">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200 mb-4">
              <h3 className="font-bold text-slate-800 text-sm">
                {editingShift.name ? 'Edit Shift Configuration' : 'Add Custom Shift'}
              </h3>
              <button onClick={() => setIsModalOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSave} className="flex flex-col gap-3 text-xs">
              <div>
                <label className="block text-slate-700 font-semibold mb-1">Shift Name *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. MORNING SHIFT"
                  value={editingShift.name || ''}
                  onChange={(e) => setEditingShift({ ...editingShift, name: e.target.value.toUpperCase() })}
                  className="w-full border border-slate-300 rounded px-2.5 py-1.5 uppercase font-semibold"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Start Time (HH:mm)</label>
                  <input
                    type="time"
                    required
                    value={editingShift.startTime || '09:00'}
                    onChange={(e) => setEditingShift({ ...editingShift, startTime: e.target.value })}
                    className="w-full border border-slate-300 rounded px-2.5 py-1.5 font-mono"
                  />
                </div>

                <div>
                  <label className="block text-slate-700 font-semibold mb-1">End Time (HH:mm)</label>
                  <input
                    type="time"
                    required
                    value={editingShift.endTime || '17:30'}
                    onChange={(e) => setEditingShift({ ...editingShift, endTime: e.target.value })}
                    className="w-full border border-slate-300 rounded px-2.5 py-1.5 font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Punch-In Window Start</label>
                  <input
                    type="time"
                    required
                    value={editingShift.punchInWindowStart || '07:30'}
                    onChange={(e) => setEditingShift({ ...editingShift, punchInWindowStart: e.target.value })}
                    className="w-full border border-slate-300 rounded px-2.5 py-1.5 font-mono"
                  />
                </div>

                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Punch-In Window End</label>
                  <input
                    type="time"
                    required
                    value={editingShift.punchInWindowEnd || '12:00'}
                    onChange={(e) => setEditingShift({ ...editingShift, punchInWindowEnd: e.target.value })}
                    className="w-full border border-slate-300 rounded px-2.5 py-1.5 font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Scheduled Duty (Mins)</label>
                  <input
                    type="number"
                    value={editingShift.scheduledDurationMinutes || 510}
                    onChange={(e) => setEditingShift({ ...editingShift, scheduledDurationMinutes: Number(e.target.value) })}
                    className="w-full border border-slate-300 rounded px-2.5 py-1.5"
                  />
                  <span className="text-[10px] text-slate-400 mt-0.5 block">510 mins = 8h 30m</span>
                </div>

                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Grace Period (Mins)</label>
                  <input
                    type="number"
                    value={editingShift.gracePeriodMinutes || 15}
                    onChange={(e) => setEditingShift({ ...editingShift, gracePeriodMinutes: Number(e.target.value) })}
                    className="w-full border border-slate-300 rounded px-2.5 py-1.5"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <input
                  type="checkbox"
                  id="overnight-check"
                  checked={editingShift.isOvernight || false}
                  onChange={(e) => setEditingShift({ ...editingShift, isOvernight: e.target.checked })}
                  className="rounded text-blue-600 focus:ring-blue-500 w-4 h-4"
                />
                <label htmlFor="overnight-check" className="text-slate-800 font-semibold cursor-pointer">
                  Is Overnight Shift (Crosses midnight into next day)
                </label>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100 mt-2">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="bg-slate-100 text-slate-700 px-3 py-1.5 rounded"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="bg-blue-600 text-white px-4 py-1.5 rounded font-medium disabled:opacity-50"
                >
                  {isSaving ? 'Saving...' : 'Save Shift'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <BulkConfirmModal
        isOpen={Boolean(pendingBulkStatus)}
        title={pendingBulkStatus === 'Active' ? 'Bulk Activate Shifts?' : 'Bulk Deactivate Shifts?'}
        description={`Update status to ${pendingBulkStatus} for ${bulk.selectedCount} selected shift(s). Shift timings and Night Shift cross-midnight rules remain unchanged.`}
        selectedCount={bulk.selectedCount}
        confirmLabel={`${pendingBulkStatus === 'Active' ? 'Activate' : 'Deactivate'} ${bulk.selectedCount} Shift(s)`}
        tone={pendingBulkStatus === 'Inactive' ? 'amber' : 'primary'}
        isBusy={isBulkExecuting}
        onConfirm={() => handleExecuteBulkStatus()}
        onCancel={() => {
          if (!isBulkExecuting) setPendingBulkStatus(null);
        }}
      />
    </div>
  );
};
