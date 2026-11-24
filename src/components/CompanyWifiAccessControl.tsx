import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { getSafeErrorText } from '../services/errorHandlingService';
import {
  Wifi,
  WifiOff,
  ShieldCheck,
  ShieldAlert,
  Plus,
  Pencil,
  Trash2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  History,
  Save,
  Info,
  Power,
  Globe,
  Clock,
  Users,
  UserCheck,
  Search,
  Lock,
  Unlock,
} from 'lucide-react';
import type { UserRoleRecord } from '../types';
import { UnauthorizedAccess } from './UnauthorizedAccess';
import {
  type CompanyWifiAccessLog,
  type CompanyWifiAccessMode,
  type CompanyWifiDashboardResponse,
  type CompanyWifiManagedRoleId,
  type CompanyWifiNetwork,
  type CompanyWifiNetworkStatus,
  getNetworkMatchTarget,
  validatePublicCompanyWifiIpOrCidr,
} from '../utils/companyWifiUtils';
import {
  createCompanyWifiNetwork,
  deleteCompanyWifiNetwork,
  emergencyDisableCompanyWifi,
  fetchCompanyWifiDashboard,
  fetchCompanyWifiLogs,
  saveRoleCompanyWifiPolicy,
  toggleCompanyWifiNetworkStatus,
  updateCompanyWifiNetwork,
  updateCompanyWifiSettings,
} from '../services/companyWifiService';

type WifiTabId = 'overview' | 'networks' | 'admin_access' | 'user_access' | 'history';

interface CompanyWifiAccessControlProps {
  currentUserRole: UserRoleRecord;
}

function formatTimestampIST(iso: string | null | undefined): string {
  if (!iso) return 'Never';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return 'Never';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).format(dt);
}

const EVENT_TYPE_LABELS: Record<string, string> = {
  NETWORK_ADDED: 'Network Added',
  NETWORK_UPDATED: 'Network Edited',
  NETWORK_STATUS_CHANGED: 'Status Changed',
  NETWORK_DELETED: 'Network Deleted',
  POLICY_UPDATED: 'Role Policy Updated',
  ENFORCEMENT_ENABLED: 'Enforcement ON',
  ENFORCEMENT_DISABLED: 'Enforcement OFF',
  EMERGENCY_DISABLED: 'Emergency Recovery OFF',
  ACCESS_BLOCKED: 'Blocked Access Attempt',
};

export const CompanyWifiAccessControl: React.FC<CompanyWifiAccessControlProps> = ({
  currentUserRole,
}) => {
  const isSuperAdmin =
    currentUserRole?.role?.toUpperCase() === 'SUPER_ADMIN' ||
    currentUserRole?.loginId?.toLowerCase() === 'superadmin';

  const [activeTab, setActiveTab] = useState<WifiTabId>('overview');
  const [dashboard, setDashboard] = useState<CompanyWifiDashboardResponse | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Add / Edit Company Wi-Fi Modal / Form State
  const [isFormOpen, setIsFormOpen] = useState<boolean>(false);
  const [editingNetwork, setEditingNetwork] = useState<CompanyWifiNetwork | null>(null);
  const [formName, setFormName] = useState<string>('');
  const [formIpOrCidr, setFormIpOrCidr] = useState<string>('');
  const [formStatus, setFormStatus] = useState<CompanyWifiNetworkStatus>('Active');
  const [formError, setFormError] = useState<string | null>(null);
  const [isSavingNetwork, setIsSavingNetwork] = useState<boolean>(false);
  const [pendingDeleteNetwork, setPendingDeleteNetwork] = useState<CompanyWifiNetwork | null>(null);

  // Role Policy Draft State (ADMIN & USER)
  const [adminMode, setAdminMode] = useState<CompanyWifiAccessMode>('RESTRICTED');
  const [adminSelectedIds, setAdminSelectedIds] = useState<string[]>([]);
  const [userMode, setUserMode] = useState<CompanyWifiAccessMode>('RESTRICTED');
  const [userSelectedIds, setUserSelectedIds] = useState<string[]>([]);
  const [isSavingRole, setIsSavingRole] = useState<CompanyWifiManagedRoleId | null>(null);

  // Enforcement Enable Confirmation Modal
  const [showEnableConfirm, setShowEnableConfirm] = useState<boolean>(false);
  const [isUpdatingSettings, setIsUpdatingSettings] = useState<boolean>(false);

  // Access History State
  const [logs, setLogs] = useState<CompanyWifiAccessLog[]>([]);
  const [isLoadingLogs, setIsLoadingLogs] = useState<boolean>(false);
  const [logEventFilter, setLogEventFilter] = useState<string>('ALL');
  const [logResultFilter, setLogResultFilter] = useState<string>('all');
  const [logSearch, setLogSearch] = useState<string>('');

  const showToast = useCallback((msg: string) => {
    setSuccessMessage(msg);
    setErrorMessage(null);
    window.setTimeout(() => {
      setSuccessMessage((curr) => (curr === msg ? null : curr));
    }, 4500);
  }, []);

  const loadDashboard = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const data = await fetchCompanyWifiDashboard();
      setDashboard(data);
      setAdminMode(data.policies.admin.accessMode);
      setAdminSelectedIds(data.policies.admin.allowedNetworkIds);
      setUserMode(data.policies.user.accessMode);
      setUserSelectedIds(data.policies.user.allowedNetworkIds);
    } catch (err: any) {
      setErrorMessage(
        getSafeErrorText(err, { moduleName: 'Network Security', endpoint: '/api/company-wifi/dashboard' })
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  const loadLogs = useCallback(async () => {
    setIsLoadingLogs(true);
    try {
      const res = await fetchCompanyWifiLogs({
        eventType: logEventFilter,
        result: logResultFilter,
        search: logSearch.trim() || undefined,
        limit: 150,
      });
      setLogs(res.logs);
    } catch (err: any) {
      setErrorMessage(
        getSafeErrorText(err, { moduleName: 'Network Security', endpoint: '/api/company-wifi/logs' })
      );
    } finally {
      setIsLoadingLogs(false);
    }
  }, [logEventFilter, logResultFilter, logSearch]);

  useEffect(() => {
    if (isSuperAdmin) {
      void loadDashboard();
    }
  }, [isSuperAdmin, loadDashboard]);

  useEffect(() => {
    if (isSuperAdmin && activeTab === 'history') {
      void loadLogs();
    }
  }, [isSuperAdmin, activeTab, loadLogs]);

  const activeNetworkIds = useMemo(
    () =>
      new Set(
        (dashboard?.networks || [])
          .filter((n) => n.status === 'Active')
          .map((n) => n.networkId)
      ),
    [dashboard?.networks]
  );

  const adminActiveAssignedCount = useMemo(
    () => adminSelectedIds.filter((id) => activeNetworkIds.has(id)).length,
    [adminSelectedIds, activeNetworkIds]
  );

  const userActiveAssignedCount = useMemo(
    () => userSelectedIds.filter((id) => activeNetworkIds.has(id)).length,
    [userSelectedIds, activeNetworkIds]
  );

  if (!isSuperAdmin) {
    return (
      <UnauthorizedAccess
        currentTab="company_wifi_access"
        currentUserRole={currentUserRole}
        onGoHome={() => {}}
      />
    );
  }

  const openAddNetworkForm = () => {
    setEditingNetwork(null);
    setFormName('');
    setFormIpOrCidr('');
    setFormStatus('Active');
    setFormError(null);
    setIsFormOpen(true);
  };

  const openEditNetworkForm = (net: CompanyWifiNetwork) => {
    setEditingNetwork(net);
    setFormName(net.networkName);
    setFormIpOrCidr(getNetworkMatchTarget(net));
    setFormStatus(net.status);
    setFormError(null);
    setIsFormOpen(true);
  };

  const handleSaveNetwork = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const cleanName = formName.trim();
    if (cleanName.length < 2) {
      setFormError('Enter a recognizable Company Wi-Fi name (at least 2 characters).');
      return;
    }

    const validation = validatePublicCompanyWifiIpOrCidr(formIpOrCidr);
    if (!validation.valid) {
      setFormError(validation.error || 'Enter a valid Public IPv4/IPv6 address or CIDR range.');
      return;
    }

    setIsSavingNetwork(true);
    try {
      if (editingNetwork) {
        await updateCompanyWifiNetwork(editingNetwork.networkId, {
          networkName: cleanName,
          ipOrCidr: validation.normalized,
          status: formStatus,
        });
        showToast(`Updated "${cleanName}" (${validation.normalized}).`);
      } else {
        await createCompanyWifiNetwork({
          networkName: cleanName,
          ipOrCidr: validation.normalized,
          status: formStatus,
        });
        showToast(`Added "${cleanName}" (${validation.normalized}).`);
      }
      setIsFormOpen(false);
      setEditingNetwork(null);
      await loadDashboard();
    } catch (err: any) {
      setFormError(
        getSafeErrorText(err, { moduleName: 'Network Security', endpoint: '/api/company-wifi/networks' })
      );
    } finally {
      setIsSavingNetwork(false);
    }
  };

  const handleToggleNetworkStatus = async (net: CompanyWifiNetwork) => {
    const nextStatus: CompanyWifiNetworkStatus = net.status === 'Active' ? 'Inactive' : 'Active';
    try {
      await toggleCompanyWifiNetworkStatus(net.networkId, nextStatus);
      showToast(
        `"${net.networkName}" is now ${nextStatus}. ${
          nextStatus === 'Inactive' ? 'It can no longer authorize access.' : ''
        }`
      );
      await loadDashboard();
    } catch (err: any) {
      setErrorMessage(
        getSafeErrorText(err, { moduleName: 'Network Security', endpoint: '/api/company-wifi/networks' })
      );
    }
  };

  const handleConfirmDeleteNetwork = async () => {
    if (!pendingDeleteNetwork) return;
    try {
      await deleteCompanyWifiNetwork(pendingDeleteNetwork.networkId);
      showToast(`Deleted "${pendingDeleteNetwork.networkName}" and removed it from role assignments.`);
      setPendingDeleteNetwork(null);
      await loadDashboard();
    } catch (err: any) {
      setErrorMessage(
        getSafeErrorText(err, { moduleName: 'Network Security', endpoint: '/api/company-wifi/networks' })
      );
    }
  };

  const handleSaveRolePolicy = async (roleId: CompanyWifiManagedRoleId) => {
    setIsSavingRole(roleId);
    setErrorMessage(null);
    try {
      const accessMode = roleId === 'admin' ? adminMode : userMode;
      const allowedNetworkIds = roleId === 'admin' ? adminSelectedIds : userSelectedIds;
      await saveRoleCompanyWifiPolicy(roleId, { accessMode, allowedNetworkIds });
      showToast(
        `${roleId.toUpperCase()} Wi-Fi access configuration saved. Active sessions will enforce this on their next request.`
      );
      await loadDashboard();
    } catch (err: any) {
      setErrorMessage(
        getSafeErrorText(err, { moduleName: 'Network Security', endpoint: '/api/company-wifi/policies' })
      );
    } finally {
      setIsSavingRole(null);
    }
  };

  const handleToggleEnforcement = async (enable: boolean) => {
    if (enable) {
      setShowEnableConfirm(true);
      return;
    }
    setIsUpdatingSettings(true);
    setErrorMessage(null);
    try {
      await updateCompanyWifiSettings({ enforcementEnabled: false });
      showToast('Company Wi-Fi enforcement turned OFF. All roles can now access without Wi-Fi blocking.');
      await loadDashboard();
    } catch (err: any) {
      setErrorMessage(
        getSafeErrorText(err, { moduleName: 'Network Security', endpoint: '/api/company-wifi/settings' })
      );
    } finally {
      setIsUpdatingSettings(false);
    }
  };

  const handleConfirmEnableEnforcement = async () => {
    setIsUpdatingSettings(true);
    setErrorMessage(null);
    try {
      await updateCompanyWifiSettings({ enforcementEnabled: true, confirmEnable: true });
      setShowEnableConfirm(false);
      showToast('Company Wi-Fi Access Control enforcement is now ON. Super Admin remains unrestricted.');
      await loadDashboard();
    } catch (err: any) {
      setErrorMessage(
        getSafeErrorText(err, { moduleName: 'Network Security', endpoint: '/api/company-wifi/settings' })
      );
    } finally {
      setIsUpdatingSettings(false);
    }
  };

  const handleEmergencyDisable = async () => {
    setIsUpdatingSettings(true);
    setErrorMessage(null);
    try {
      await emergencyDisableCompanyWifi();
      showToast('Emergency Recovery executed: Company Wi-Fi enforcement is now OFF.');
      await loadDashboard();
    } catch (err: any) {
      setErrorMessage(
        getSafeErrorText(err, {
          moduleName: 'Network Security',
          endpoint: '/api/company-wifi/emergency-disable',
        })
      );
    } finally {
      setIsUpdatingSettings(false);
    }
  };

  const renderRoleConfigTab = (roleId: CompanyWifiManagedRoleId) => {
    const isAdminTab = roleId === 'admin';
    const mode = isAdminTab ? adminMode : userMode;
    const setMode = isAdminTab ? setAdminMode : setUserMode;
    const selectedIds = isAdminTab ? adminSelectedIds : userSelectedIds;
    const setSelectedIds = isAdminTab ? setAdminSelectedIds : setUserSelectedIds;
    const networks = dashboard?.networks || [];
    const activeAssigned = isAdminTab ? adminActiveAssignedCount : userActiveAssignedCount;
    const enforcementOn = Boolean(dashboard?.settings.enforcementEnabled);

    const toggleNetworkId = (networkId: string) => {
      setSelectedIds((prev) =>
        prev.includes(networkId) ? prev.filter((id) => id !== networkId) : [...prev, networkId]
      );
    };

    return (
      <div className="bg-white rounded-xl border border-slate-200 shadow-xs overflow-hidden">
        <div className="p-5 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-50/70">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="inline-flex items-center px-2.5 py-0.5 rounded text-xs font-bold tracking-wider uppercase bg-[#0a192f] text-white">
                ROLE: {roleId.toUpperCase()}
              </span>
              <span
                className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded text-xs font-semibold ${
                  mode === 'RESTRICTED'
                    ? 'bg-amber-100 text-amber-800 border border-amber-200'
                    : 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                }`}
              >
                {mode === 'RESTRICTED' ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                {mode === 'RESTRICTED' ? 'Restricted to Assigned Wi-Fi' : 'Unrestricted (Any Network)'}
              </span>
            </div>
            <p className="text-xs text-slate-600 mt-1.5">
              {isAdminTab
                ? 'Select which Company Wi-Fi networks are permitted for ADMIN accounts. Changes take effect on their next API request.'
                : 'Independently select which Company Wi-Fi networks are permitted for USER accounts. Changes take effect on their next API request.'}
            </p>
          </div>
          <button
            type="button"
            disabled={isSavingRole === roleId}
            onClick={() => void handleSaveRolePolicy(roleId)}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-sm font-semibold shadow-xs transition cursor-pointer shrink-0"
          >
            <Save className="w-4 h-4" />
            {isSavingRole === roleId ? 'Saving...' : 'Save Configuration'}
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Access Mode Selector */}
          <div>
            <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-2">
              Access Mode
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-2xl">
              <button
                type="button"
                onClick={() => setMode('RESTRICTED')}
                className={`p-3.5 rounded-lg border text-left transition cursor-pointer ${
                  mode === 'RESTRICTED'
                    ? 'border-blue-600 bg-blue-50/70 ring-1 ring-blue-600'
                    : 'border-slate-200 hover:border-slate-300 bg-white'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                    <Lock className="w-4 h-4 text-blue-600" />
                    Restricted
                  </span>
                  <span
                    className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                      mode === 'RESTRICTED' ? 'border-blue-600' : 'border-slate-300'
                    }`}
                  >
                    {mode === 'RESTRICTED' && <span className="w-2 h-2 rounded-full bg-blue-600" />}
                  </span>
                </div>
                <p className="text-xs text-slate-600 mt-1">
                  Allow access only from the selected Active Company Wi-Fi networks below.
                </p>
              </button>

              <button
                type="button"
                onClick={() => setMode('UNRESTRICTED')}
                className={`p-3.5 rounded-lg border text-left transition cursor-pointer ${
                  mode === 'UNRESTRICTED'
                    ? 'border-emerald-600 bg-emerald-50/70 ring-1 ring-emerald-600'
                    : 'border-slate-200 hover:border-slate-300 bg-white'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                    <Unlock className="w-4 h-4 text-emerald-600" />
                    Unrestricted
                  </span>
                  <span
                    className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                      mode === 'UNRESTRICTED' ? 'border-emerald-600' : 'border-slate-300'
                    }`}
                  >
                    {mode === 'UNRESTRICTED' && (
                      <span className="w-2 h-2 rounded-full bg-emerald-600" />
                    )}
                  </span>
                </div>
                <p className="text-xs text-slate-600 mt-1">
                  Permit {roleId.toUpperCase()} accounts from any network even while enforcement is ON.
                </p>
              </button>
            </div>
          </div>

          {/* Empty Restricted Policy Warning */}
          {mode === 'RESTRICTED' && activeAssigned === 0 && (
            <div className="p-3.5 rounded-lg bg-amber-50 border border-amber-300 flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div className="text-xs text-amber-900">
                <p className="font-bold">
                  No Active Company Wi-Fi Assigned to {roleId.toUpperCase()}
                </p>
                <p className="mt-0.5">
                  {enforcementOn
                    ? `Global enforcement is currently ON. Because ${roleId.toUpperCase()} is Restricted with 0 active networks, all ${roleId.toUpperCase()} requests are blocked (deny-by-default) until at least one active Company Wi-Fi is selected and saved.`
                    : `When global enforcement is turned ON, ${roleId.toUpperCase()} will be blocked by default until you assign at least one Active Company Wi-Fi network.`}
                </p>
              </div>
            </div>
          )}

          {/* Allowed Company Wi-Fi Networks Checklist */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                Allowed Company Wi-Fi Networks ({activeAssigned} active selected)
              </label>
              {networks.length > 0 && mode === 'RESTRICTED' && (
                <div className="flex items-center gap-3 text-xs">
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedIds(
                        networks.filter((n) => n.status === 'Active').map((n) => n.networkId)
                      )
                    }
                    className="text-blue-600 hover:text-blue-800 font-medium cursor-pointer"
                  >
                    Select All Active
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedIds([])}
                    className="text-slate-500 hover:text-slate-700 font-medium cursor-pointer"
                  >
                    Clear All
                  </button>
                </div>
              )}
            </div>

            {networks.length === 0 ? (
              <div className="p-6 rounded-lg border border-dashed border-slate-300 bg-slate-50 text-center">
                <WifiOff className="w-7 h-7 text-slate-400 mx-auto mb-2" />
                <p className="text-sm font-semibold text-slate-700">
                  No Company Wi-Fi Networks Configured Yet
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  Add your company&apos;s Public IP / CIDR networks in Company Wi-Fi Master first.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setActiveTab('networks');
                    openAddNetworkForm();
                  }}
                  className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add Company Wi-Fi
                </button>
              </div>
            ) : (
              <div
                className={`grid grid-cols-1 md:grid-cols-2 gap-3 ${
                  mode === 'UNRESTRICTED' ? 'opacity-60' : ''
                }`}
              >
                {networks.map((net) => {
                  const checked = selectedIds.includes(net.networkId);
                  const isActiveNet = net.status === 'Active';
                  return (
                    <label
                      key={net.networkId}
                      className={`flex items-start gap-3 p-3.5 rounded-lg border transition cursor-pointer ${
                        checked
                          ? 'border-blue-500 bg-blue-50/50'
                          : 'border-slate-200 hover:border-slate-300 bg-white'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={mode === 'UNRESTRICTED'}
                        onChange={() => toggleNetworkId(net.networkId)}
                        className="mt-0.5 w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold text-slate-900 truncate">
                            {net.networkName}
                          </span>
                          <span
                            className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded shrink-0 ${
                              isActiveNet
                                ? 'bg-emerald-100 text-emerald-700'
                                : 'bg-slate-200 text-slate-600'
                            }`}
                          >
                            {net.status}
                          </span>
                        </div>
                        <div className="text-xs font-mono text-slate-600 mt-1">
                          {getNetworkMatchTarget(net)}
                        </div>
                        {!isActiveNet && checked && (
                          <p className="text-[11px] text-amber-700 mt-1">
                            Disabled networks cannot authorize access until re-enabled.
                          </p>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  const summary = dashboard?.summary;
  const enforcementOn = Boolean(dashboard?.settings.enforcementEnabled);

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-5">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-lg bg-[#0a192f] text-cyan-400 flex items-center justify-center shadow-xs">
              <Wifi className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-900 tracking-tight">
                Company Wi-Fi Access Control
              </h1>
              <p className="text-xs text-slate-500">
                Super Admin network governance — restrict ADMIN and USER access to approved Company Wi-Fi Public IPs
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void loadDashboard()}
            disabled={isLoading}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold transition cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveTab('networks');
              openAddNetworkForm();
            }}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shadow-xs transition cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Company Wi-Fi
          </button>
        </div>
      </div>

      {/* Feedback Alerts */}
      {errorMessage && (
        <div className="p-3.5 rounded-lg bg-red-50 border border-red-200 text-red-800 text-xs font-medium flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <XCircle className="w-4 h-4 text-red-600 shrink-0" />
            <span>{errorMessage}</span>
          </div>
          <button
            type="button"
            onClick={() => setErrorMessage(null)}
            className="text-red-500 hover:text-red-700 text-xs font-bold cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {successMessage && (
        <div className="p-3.5 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-medium flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
          <span>{successMessage}</span>
        </div>
      )}

      {/* 8 Dashboard Summary KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {/* 1. Global Enforcement Status */}
        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-xs">
          <div className="flex items-center justify-between text-xs text-slate-500 font-medium">
            <span>Global Enforcement</span>
            <Power className={`w-4 h-4 ${enforcementOn ? 'text-emerald-600' : 'text-slate-400'}`} />
          </div>
          <div className="mt-2 flex items-center gap-2">
            <span
              className={`inline-flex items-center px-2.5 py-0.5 rounded text-sm font-bold ${
                enforcementOn
                  ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                  : 'bg-slate-100 text-slate-700 border border-slate-200'
              }`}
            >
              {enforcementOn ? 'ON' : 'OFF'}
            </span>
            <span className="text-[11px] text-slate-500">
              {enforcementOn ? 'Enforcing policies' : 'Setup mode'}
            </span>
          </div>
        </div>

        {/* 2. Total Company Wi-Fi Networks */}
        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-xs">
          <div className="flex items-center justify-between text-xs text-slate-500 font-medium">
            <span>Total Company Wi-Fi</span>
            <Wifi className="w-4 h-4 text-blue-600" />
          </div>
          <div className="mt-2 text-2xl font-bold text-slate-900">
            {summary?.totalNetworks ?? 0}
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">Registered company networks</div>
        </div>

        {/* 3. Active Networks */}
        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-xs">
          <div className="flex items-center justify-between text-xs text-slate-500 font-medium">
            <span>Active Networks</span>
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
          </div>
          <div className="mt-2 text-2xl font-bold text-emerald-700">
            {summary?.activeNetworks ?? 0}
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            {(summary?.totalNetworks ?? 0) - (summary?.activeNetworks ?? 0)} inactive
          </div>
        </div>

        {/* 4. ADMIN Allowed Networks */}
        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-xs">
          <div className="flex items-center justify-between text-xs text-slate-500 font-medium">
            <span>ADMIN Allowed</span>
            <UserCheck className="w-4 h-4 text-indigo-600" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-slate-900">
              {dashboard?.policies.admin.accessMode === 'UNRESTRICTED'
                ? 'All'
                : summary?.adminAllowedCount ?? 0}
            </span>
            <span className="text-[11px] font-semibold uppercase text-slate-500">
              {dashboard?.policies.admin.accessMode === 'UNRESTRICTED'
                ? 'Unrestricted'
                : 'Active Wi-Fi'}
            </span>
          </div>
        </div>

        {/* 5. USER Allowed Networks */}
        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-xs">
          <div className="flex items-center justify-between text-xs text-slate-500 font-medium">
            <span>USER Allowed</span>
            <Users className="w-4 h-4 text-sky-600" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-slate-900">
              {dashboard?.policies.user.accessMode === 'UNRESTRICTED'
                ? 'All'
                : summary?.userAllowedCount ?? 0}
            </span>
            <span className="text-[11px] font-semibold uppercase text-slate-500">
              {dashboard?.policies.user.accessMode === 'UNRESTRICTED'
                ? 'Unrestricted'
                : 'Active Wi-Fi'}
            </span>
          </div>
        </div>

        {/* 6. Current Observed Public IP */}
        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-xs">
          <div className="flex items-center justify-between text-xs text-slate-500 font-medium">
            <span>Observed Public IP</span>
            <Globe className="w-4 h-4 text-slate-500" />
          </div>
          <div className="mt-2 text-sm font-mono font-bold text-slate-900 truncate">
            {summary?.currentObservedIp || 'Detecting...'}
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            {summary?.currentObservedIpIsPublic
              ? 'Server-verified Public IP'
              : 'Local / non-public address'}
          </div>
        </div>

        {/* 7. Current Network Match Status */}
        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-xs">
          <div className="flex items-center justify-between text-xs text-slate-500 font-medium">
            <span>Current Match Status</span>
            <ShieldCheck
              className={`w-4 h-4 ${
                summary?.currentNetworkMatched ? 'text-emerald-600' : 'text-amber-500'
              }`}
            />
          </div>
          <div className="mt-2 text-sm font-bold text-slate-900 truncate">
            {summary?.currentNetworkMatched
              ? summary.currentMatchedNetworkName
              : 'No Active Match'}
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            {summary?.currentNetworkMatched
              ? 'Matches registered Company Wi-Fi'
              : 'Super Admin bypass active'}
          </div>
        </div>

        {/* 8. Last Policy Update */}
        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-xs">
          <div className="flex items-center justify-between text-xs text-slate-500 font-medium">
            <span>Last Policy Update</span>
            <Clock className="w-4 h-4 text-slate-500" />
          </div>
          <div className="mt-2 text-xs font-semibold text-slate-800 leading-snug">
            {formatTimestampIST(summary?.lastPolicyUpdate)}
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            Updated by {dashboard?.settings.updatedBy || 'system'}
          </div>
        </div>
      </div>

      {/* 5 Simple Navigation Tabs */}
      <div className="border-b border-slate-200 bg-white rounded-t-xl px-2 pt-2 flex flex-wrap gap-1">
        {(
          [
            { id: 'overview', label: 'Overview', icon: ShieldCheck },
            { id: 'networks', label: 'Wi-Fi Master', icon: Wifi },
            { id: 'admin_access', label: 'ADMIN Access', icon: UserCheck },
            { id: 'user_access', label: 'USER Access', icon: Users },
            { id: 'history', label: 'Access History', icon: History },
          ] as Array<{ id: WifiTabId; label: string; icon: React.ComponentType<{ className?: string }> }>
        ).map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold border-b-2 transition cursor-pointer ${
                active
                  ? 'border-blue-600 text-blue-700 bg-blue-50/40'
                  : 'border-transparent text-slate-600 hover:text-slate-900 hover:bg-slate-50'
              }`}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* TAB 1: OVERVIEW */}
      {activeTab === 'overview' && (
        <div className="space-y-4">
          {/* Global Enforcement Control Panel */}
          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-slate-900">
                  Global Company Wi-Fi Enforcement
                </h2>
                <span
                  className={`px-2 py-0.5 rounded text-xs font-bold ${
                    enforcementOn
                      ? 'bg-emerald-100 text-emerald-800'
                      : 'bg-slate-200 text-slate-700'
                  }`}
                >
                  {enforcementOn ? 'ENABLED (ON)' : 'DISABLED (OFF)'}
                </span>
              </div>
              <p className="text-xs text-slate-600 max-w-2xl">
                {enforcementOn
                  ? 'Backend APIs are actively verifying server-observed Public IPs for ADMIN and USER requests against their assigned Company Wi-Fi networks.'
                  : 'Enforcement is currently OFF. Configure and verify your Company Wi-Fi networks and role assignments before turning enforcement ON.'}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {enforcementOn ? (
                <>
                  <button
                    type="button"
                    disabled={isUpdatingSettings}
                    onClick={() => void handleToggleEnforcement(false)}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-900 text-white text-xs font-semibold cursor-pointer"
                  >
                    <Power className="w-3.5 h-3.5" />
                    Turn Enforcement OFF
                  </button>
                  <button
                    type="button"
                    disabled={isUpdatingSettings}
                    onClick={() => void handleEmergencyDisable()}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-semibold cursor-pointer"
                  >
                    <ShieldAlert className="w-3.5 h-3.5" />
                    Emergency Disable
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={isUpdatingSettings}
                  onClick={() => void handleToggleEnforcement(true)}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold shadow-xs cursor-pointer"
                >
                  <Power className="w-3.5 h-3.5" />
                  Enable Enforcement (ON)
                </button>
              )}
            </div>
          </div>

          {/* Super Admin Unrestricted Guarantee + Role Summary Matrix */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="bg-[#0a192f] text-white rounded-xl p-5 shadow-xs space-y-2.5">
              <div className="flex items-center gap-2 text-cyan-400 text-xs font-bold uppercase tracking-wider">
                <ShieldCheck className="w-4 h-4" />
                Super Admin Always Unrestricted
              </div>
              <p className="text-sm font-semibold">
                Guaranteed Emergency Access
              </p>
              <p className="text-xs text-slate-300 leading-relaxed">
                SUPER_ADMIN accounts permanently bypass all Company Wi-Fi restrictions on the backend. Even if all company networks are disabled or ISP IPs change, Super Admin can always sign in from any network to update IPs or disable enforcement.
              </p>
            </div>

            {/* Quick Role Policy Matrix */}
            <div className="lg:col-span-2 bg-white rounded-xl border border-slate-200 p-5 shadow-xs">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-bold text-slate-900">
                  Role-Wise Wi-Fi Authorization Summary
                </h3>
                <span className="text-[11px] text-slate-500">
                  Applies immediately to active sessions
                </span>
              </div>

              {(dashboard?.networks || []).length === 0 ? (
                <p className="text-xs text-slate-500 py-4 text-center">
                  No Company Wi-Fi networks added yet. Open <strong>Company Wi-Fi Master</strong> to register your first company public IP.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 text-slate-500 uppercase text-[11px]">
                        <th className="py-2 pr-3 font-semibold">Company Wi-Fi</th>
                        <th className="py-2 px-3 font-semibold">Public IP / CIDR</th>
                        <th className="py-2 px-3 font-semibold">Status</th>
                        <th className="py-2 px-3 font-semibold text-center">ADMIN</th>
                        <th className="py-2 pl-3 font-semibold text-center">USER</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {(dashboard?.networks || []).map((net) => {
                        const isActiveNet = net.status === 'Active';
                        const adminAllowed =
                          isActiveNet &&
                          (dashboard?.policies.admin.accessMode === 'UNRESTRICTED' ||
                            dashboard?.policies.admin.allowedNetworkIds.includes(net.networkId));
                        const userAllowed =
                          isActiveNet &&
                          (dashboard?.policies.user.accessMode === 'UNRESTRICTED' ||
                            dashboard?.policies.user.allowedNetworkIds.includes(net.networkId));
                        return (
                          <tr key={net.networkId} className="hover:bg-slate-50/70">
                            <td className="py-2.5 pr-3 font-semibold text-slate-800">
                              {net.networkName}
                            </td>
                            <td className="py-2.5 px-3 font-mono text-slate-600">
                              {getNetworkMatchTarget(net)}
                            </td>
                            <td className="py-2.5 px-3">
                              <span
                                className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                                  isActiveNet
                                    ? 'bg-emerald-100 text-emerald-700'
                                    : 'bg-slate-200 text-slate-600'
                                }`}
                              >
                                {net.status}
                              </span>
                            </td>
                            <td className="py-2.5 px-3 text-center">
                              <span
                                className={`inline-block px-2 py-0.5 rounded text-[11px] font-semibold ${
                                  adminAllowed
                                    ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                    : 'bg-slate-100 text-slate-500'
                                }`}
                              >
                                {adminAllowed ? 'Allowed' : 'Not Allowed'}
                              </span>
                            </td>
                            <td className="py-2.5 pl-3 text-center">
                              <span
                                className={`inline-block px-2 py-0.5 rounded text-[11px] font-semibold ${
                                  userAllowed
                                    ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                    : 'bg-slate-100 text-slate-500'
                                }`}
                              >
                                {userAllowed ? 'Allowed' : 'Not Allowed'}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          {/* Transparent Technical Note on Network Identification */}
          <div className="bg-blue-50/70 border border-blue-200 rounded-xl p-4 flex items-start gap-3">
            <Info className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" />
            <div className="text-xs text-blue-950 space-y-1">
              <p className="font-bold">How Company Wi-Fi Identification Works</p>
              <p className="leading-relaxed text-blue-900">
                Web browsers cannot directly read Wi-Fi SSID names, Wi-Fi passwords, or router MAC addresses. Instead, the backend server verifies each request&apos;s authoritative externally observed <strong>Public IP address or CIDR range</strong>. Wi-Fi networks that share the same ISP public IP are treated as one network, and if your ISP changes a dynamic public IP, Super Admin can update the entry here immediately.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: COMPANY WI-FI MASTER */}
      {activeTab === 'networks' && (
        <div className="space-y-4">
          <div className="bg-white rounded-xl border border-slate-200 shadow-xs overflow-hidden">
            <div className="p-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-50/70">
              <div>
                <h2 className="text-sm font-bold text-slate-900">Company Wi-Fi Master</h2>
                <p className="text-xs text-slate-500">
                  Register routable Public IPv4/IPv6 addresses or CIDR ranges for your plant and office Wi-Fi networks. Private LAN and loopback IPs are rejected.
                </p>
              </div>
              <button
                type="button"
                onClick={openAddNetworkForm}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shadow-xs cursor-pointer shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Company Wi-Fi
              </button>
            </div>

            {isFormOpen && (
              <form
                onSubmit={handleSaveNetwork}
                className="p-5 border-b border-slate-200 bg-blue-50/30 space-y-4"
              >
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold text-slate-900">
                    {editingNetwork ? `Edit "${editingNetwork.networkName}"` : 'Add New Company Wi-Fi'}
                  </h3>
                  <button
                    type="button"
                    onClick={() => {
                      setIsFormOpen(false);
                      setEditingNetwork(null);
                    }}
                    className="text-xs text-slate-500 hover:text-slate-800 font-medium cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>

                {formError && (
                  <div className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs font-medium">
                    {formError}
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Company Wi-Fi Name
                    </label>
                    <input
                      type="text"
                      value={formName}
                      onChange={(e) => setFormName(e.target.value)}
                      placeholder="e.g., Company Main Wi-Fi, Plant 1 Wi-Fi"
                      maxLength={80}
                      required
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-semibold text-slate-700">
                        Public IPv4 / IPv6 or CIDR Range
                      </label>
                      {summary?.currentObservedIpIsPublic && (
                        <button
                          type="button"
                          onClick={() => setFormIpOrCidr(summary.currentObservedIp)}
                          className="text-[11px] text-blue-600 hover:text-blue-800 font-semibold cursor-pointer"
                        >
                          Use My Current IP
                        </button>
                      )}
                    </div>
                    <input
                      type="text"
                      value={formIpOrCidr}
                      onChange={(e) => setFormIpOrCidr(e.target.value)}
                      placeholder="e.g., 203.0.113.10 or 203.0.113.0/24"
                      maxLength={64}
                      required
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 bg-white font-mono text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Status
                    </label>
                    <select
                      value={formStatus}
                      onChange={(e) => setFormStatus(e.target.value as CompanyWifiNetworkStatus)}
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="Active">Active (Authorized)</option>
                      <option value="Inactive">Inactive (Disabled)</option>
                    </select>
                  </div>
                </div>

                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setIsFormOpen(false);
                      setEditingNetwork(null);
                    }}
                    className="px-3.5 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isSavingNetwork}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-xs font-semibold cursor-pointer"
                  >
                    <Save className="w-3.5 h-3.5" />
                    {isSavingNetwork
                      ? 'Saving...'
                      : editingNetwork
                      ? 'Update Network'
                      : 'Save Company Wi-Fi'}
                  </button>
                </div>
              </form>
            )}

            {(dashboard?.networks || []).length === 0 ? (
              <div className="p-10 text-center text-slate-500">
                <Wifi className="w-8 h-8 mx-auto mb-2 text-slate-300" />
                <p className="text-sm font-semibold text-slate-700">No Company Wi-Fi networks registered</p>
                <p className="text-xs mt-1">
                  Add networks like &ldquo;Company Main Wi-Fi&rdquo;, &ldquo;Plant 1 Wi-Fi&rdquo;, or &ldquo;Office Wi-Fi&rdquo; using their public IP or CIDR range.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 uppercase text-[11px]">
                      <th className="py-3 px-4 font-semibold">Network Name</th>
                      <th className="py-3 px-4 font-semibold">Public IP / CIDR</th>
                      <th className="py-3 px-4 font-semibold">Status</th>
                      <th className="py-3 px-4 font-semibold">Updated</th>
                      <th className="py-3 px-4 font-semibold text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {(dashboard?.networks || []).map((net) => {
                      const isActive = net.status === 'Active';
                      return (
                        <tr key={net.networkId} className="hover:bg-slate-50/70">
                          <td className="py-3 px-4 font-semibold text-slate-900">
                            <div className="flex items-center gap-2">
                              <Wifi
                                className={`w-4 h-4 shrink-0 ${
                                  isActive ? 'text-emerald-600' : 'text-slate-400'
                                }`}
                              />
                              <span>{net.networkName}</span>
                            </div>
                          </td>
                          <td className="py-3 px-4 font-mono text-slate-700">
                            {getNetworkMatchTarget(net)}
                          </td>
                          <td className="py-3 px-4">
                            <span
                              className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded text-[11px] font-bold ${
                                isActive
                                  ? 'bg-emerald-100 text-emerald-800'
                                  : 'bg-slate-200 text-slate-600'
                              }`}
                            >
                              {isActive ? 'Active' : 'Inactive'}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-slate-500">
                            {formatTimestampIST(net.updatedAt)}
                          </td>
                          <td className="py-3 px-4">
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                type="button"
                                onClick={() => void handleToggleNetworkStatus(net)}
                                className={`px-2.5 py-1 rounded text-[11px] font-semibold border transition cursor-pointer ${
                                  isActive
                                    ? 'border-amber-300 text-amber-800 bg-amber-50 hover:bg-amber-100'
                                    : 'border-emerald-300 text-emerald-800 bg-emerald-50 hover:bg-emerald-100'
                                }`}
                              >
                                {isActive ? 'Disable' : 'Enable'}
                              </button>
                              <button
                                type="button"
                                onClick={() => openEditNetworkForm(net)}
                                title="Edit network"
                                className="p-1.5 rounded border border-slate-200 hover:bg-slate-100 text-slate-600 cursor-pointer"
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setPendingDeleteNetwork(net)}
                                title="Delete network"
                                className="p-1.5 rounded border border-red-200 hover:bg-red-50 text-red-600 cursor-pointer"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: ADMIN ACCESS */}
      {activeTab === 'admin_access' && renderRoleConfigTab('admin')}

      {/* TAB 4: USER ACCESS */}
      {activeTab === 'user_access' && renderRoleConfigTab('user')}

      {/* TAB 5: ACCESS HISTORY */}
      {activeTab === 'history' && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-xs overflow-hidden">
          <div className="p-4 border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-3 bg-slate-50/70">
            <div>
              <h2 className="text-sm font-bold text-slate-900">Company Wi-Fi Access History</h2>
              <p className="text-xs text-slate-500">
                Audit trail of network changes, role policy updates, enforcement toggles, and blocked access attempts (Super Admin only).
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={logSearch}
                  onChange={(e) => setLogSearch(e.target.value)}
                  placeholder="Search user, IP, detail..."
                  className="pl-8 pr-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <select
                value={logEventFilter}
                onChange={(e) => setLogEventFilter(e.target.value)}
                className="px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white text-xs text-slate-800"
              >
                <option value="ALL">All Events</option>
                <option value="ACCESS_BLOCKED">Blocked Access</option>
                <option value="POLICY_UPDATED">Policy Updated</option>
                <option value="NETWORK_ADDED">Network Added</option>
                <option value="NETWORK_UPDATED">Network Edited</option>
                <option value="NETWORK_STATUS_CHANGED">Status Changed</option>
                <option value="NETWORK_DELETED">Network Deleted</option>
                <option value="ENFORCEMENT_ENABLED">Enforcement ON</option>
                <option value="ENFORCEMENT_DISABLED">Enforcement OFF</option>
                <option value="EMERGENCY_DISABLED">Emergency Disabled</option>
              </select>
              <select
                value={logResultFilter}
                onChange={(e) => setLogResultFilter(e.target.value)}
                className="px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white text-xs text-slate-800"
              >
                <option value="all">All Results</option>
                <option value="Blocked">Blocked</option>
                <option value="Updated">Updated</option>
                <option value="Allowed">Allowed</option>
              </select>
              <button
                type="button"
                onClick={() => void loadLogs()}
                className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700 cursor-pointer"
              >
                Refresh
              </button>
            </div>
          </div>

          {isLoadingLogs ? (
            <div className="p-8 text-center text-xs text-slate-500">Loading access history...</div>
          ) : logs.length === 0 ? (
            <div className="p-10 text-center text-xs text-slate-500">
              No Company Wi-Fi access history records found matching your filters.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 uppercase text-[11px]">
                    <th className="py-2.5 px-4 font-semibold">Timestamp (IST)</th>
                    <th className="py-2.5 px-4 font-semibold">Event</th>
                    <th className="py-2.5 px-4 font-semibold">Actor</th>
                    <th className="py-2.5 px-4 font-semibold">Observed IP</th>
                    <th className="py-2.5 px-4 font-semibold">Result</th>
                    <th className="py-2.5 px-4 font-semibold">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {logs.map((log) => (
                    <tr key={log.id} className="hover:bg-slate-50/70">
                      <td className="py-2.5 px-4 whitespace-nowrap text-slate-600">
                        {formatTimestampIST(log.timestamp)}
                      </td>
                      <td className="py-2.5 px-4 font-semibold text-slate-800 whitespace-nowrap">
                        {EVENT_TYPE_LABELS[log.eventType] || log.eventType}
                      </td>
                      <td className="py-2.5 px-4 whitespace-nowrap">
                        <div className="font-semibold text-slate-900">{log.actorLoginId}</div>
                        <div className="text-[10px] font-mono text-slate-500">{log.actorRole}</div>
                      </td>
                      <td className="py-2.5 px-4 font-mono text-slate-700 whitespace-nowrap">
                        {log.observedIp}
                      </td>
                      <td className="py-2.5 px-4 whitespace-nowrap">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                            log.result === 'Blocked'
                              ? 'bg-red-100 text-red-700'
                              : log.result === 'Allowed'
                              ? 'bg-emerald-100 text-emerald-700'
                              : 'bg-blue-100 text-blue-700'
                          }`}
                        >
                          {log.result}
                        </span>
                      </td>
                      <td className="py-2.5 px-4 text-slate-600 max-w-md">{log.detail || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Confirmation Modal: Enable Global Enforcement */}
      {showEnableConfirm && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-xl border border-slate-200 max-w-md w-full p-5 shadow-xl space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  Enable Company Wi-Fi Enforcement?
                </h3>
                <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                  Once enabled, ADMIN and USER accounts will only be able to access protected APIs from their assigned Active Company Wi-Fi Public IPs.
                </p>
              </div>
            </div>

            <div className="bg-slate-50 rounded-lg p-3 border border-slate-200 text-xs space-y-1.5">
              <div className="flex justify-between">
                <span className="text-slate-600">ADMIN Policy:</span>
                <span className="font-semibold text-slate-900">
                  {dashboard?.policies.admin.accessMode === 'UNRESTRICTED'
                    ? 'Unrestricted'
                    : `${summary?.adminAllowedCount ?? 0} Active Wi-Fi assigned`}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">USER Policy:</span>
                <span className="font-semibold text-slate-900">
                  {dashboard?.policies.user.accessMode === 'UNRESTRICTED'
                    ? 'Unrestricted'
                    : `${summary?.userAllowedCount ?? 0} Active Wi-Fi assigned`}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">SUPER_ADMIN:</span>
                <span className="font-semibold text-emerald-700">Always Unrestricted</span>
              </div>
            </div>

            {((dashboard?.policies.admin.accessMode === 'RESTRICTED' &&
              (summary?.adminAllowedCount ?? 0) === 0) ||
              (dashboard?.policies.user.accessMode === 'RESTRICTED' &&
                (summary?.userAllowedCount ?? 0) === 0)) && (
              <div className="p-3 rounded-lg bg-amber-50 border border-amber-300 text-xs text-amber-900">
                <strong>Warning:</strong> At least one Restricted role currently has <strong>0 active Company Wi-Fi networks</strong> assigned and will be blocked by default until networks are assigned.
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowEnableConfirm(false)}
                className="px-3.5 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isUpdatingSettings}
                onClick={() => void handleConfirmEnableEnforcement()}
                className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white text-xs font-semibold cursor-pointer"
              >
                {isUpdatingSettings ? 'Enabling...' : 'Confirm & Enable Enforcement'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Modal: Delete Company Wi-Fi */}
      {pendingDeleteNetwork && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-xl border border-slate-200 max-w-md w-full p-5 shadow-xl space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg bg-red-100 text-red-700 flex items-center justify-center shrink-0">
                <Trash2 className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  Delete &ldquo;{pendingDeleteNetwork.networkName}&rdquo;?
                </h3>
                <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                  This network ({getNetworkMatchTarget(pendingDeleteNetwork)}) will be removed from Company Wi-Fi Master and automatically unassigned from ADMIN and USER access policies.
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDeleteNetwork(null)}
                className="px-3.5 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmDeleteNetwork()}
                className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-semibold cursor-pointer"
              >
                Delete Network
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
