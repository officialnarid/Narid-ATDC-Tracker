import React, { useState, useEffect } from 'react';
import { 
  ShieldCheck, 
  CheckCircle2, 
  AlertCircle, 
  RefreshCw, 
  Save, 
  RotateCcw, 
  CheckSquare, 
  Square, 
  Lock, 
  Eye, 
  PlusCircle, 
  Edit3, 
  Trash2, 
  Info, 
  ShieldAlert,
  Sliders,
  Check,
  X
} from 'lucide-react';
import { UserRoleRecord } from '../types';
import { 
  PERMISSION_MODULES, 
  RoleRecord,
  RolePermissionRecord, 
  ModulePermission, 
  ModuleAction,
  saveRolePermissions, 
  subscribeToRoles,
  subscribeToAllRolePermissions,
  DEFAULT_SUPER_ADMIN_PERMISSIONS,
  DEFAULT_ADMIN_PERMISSIONS,
  DEFAULT_USER_PERMISSIONS,
  EMPTY_MODULE_PERMISSIONS,
  normalizeRoleId,
  seedInitialRolePermissions
} from '../services/permissionService';

interface RolePermissionsManagementProps {
  currentUserRole?: UserRoleRecord | null;
  users?: UserRoleRecord[];
}

export const RolePermissionsManagement: React.FC<RolePermissionsManagementProps> = ({ currentUserRole, users }) => {
  const isSuperAdmin = currentUserRole?.role?.toLowerCase() === 'super_admin' || currentUserRole?.loginId?.toLowerCase() === 'superadmin';

  // Live roles registry & selected role tab for permission configuration
  const [rolesList, setRolesList] = useState<RoleRecord[]>([]);
  const [selectedRole, setSelectedRole] = useState<string>('admin');

  // Authoritative permissions matrix by roleId
  const [permissionsState, setPermissionsState] = useState<Record<string, RolePermissionRecord>>({});
  const [workingPermissions, setWorkingPermissions] = useState<Record<string, ModulePermission>>({});

  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [showConfirmModal, setShowConfirmModal] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Initialize and subscribe to real-time roles + role permissions
  useEffect(() => {
    seedInitialRolePermissions().catch(() => {});

    setIsLoading(true);
    const unsubRoles = subscribeToRoles((roles) => {
      setRolesList(roles);
    });
    const unsubscribe = subscribeToAllRolePermissions((data) => {
      setPermissionsState(data);
      setIsLoading(false);
    });

    return () => {
      unsubRoles();
      unsubscribe();
    };
  }, []);

  const orderedRoles = React.useMemo(() => {
    const priority: Record<string, number> = { admin: 0, user: 1, super_admin: 999 };
    const source = rolesList.length > 0
      ? rolesList
      : ([
          { roleId: 'admin', roleName: 'ADMIN', description: '', isActive: true, isSystemRole: true, updatedAt: '' },
          { roleId: 'user', roleName: 'USER', description: '', isActive: true, isSystemRole: true, updatedAt: '' },
          { roleId: 'super_admin', roleName: 'SUPER_ADMIN', description: '', isActive: true, isSystemRole: true, updatedAt: '' },
        ] as RoleRecord[]);
    return [...source].sort((a, b) => {
      const pA = priority[a.roleId] ?? 10;
      const pB = priority[b.roleId] ?? 10;
      if (pA !== pB) return pA - pB;
      return String(a.roleName || a.roleId).localeCompare(String(b.roleName || b.roleId));
    });
  }, [rolesList]);

  const selectedRoleRecord = orderedRoles.find((r) => r.roleId === selectedRole);
  const selectedRoleLabel =
    selectedRole === 'super_admin'
      ? 'Super Admin'
      : selectedRole === 'admin'
        ? 'Admin'
        : selectedRole === 'user'
          ? 'User'
          : selectedRoleRecord?.roleName || selectedRole.toUpperCase();

  // Update working copy when selectedRole changes or permissions load
  useEffect(() => {
    if (selectedRole === 'super_admin') {
      setWorkingPermissions(DEFAULT_SUPER_ADMIN_PERMISSIONS);
    } else if (permissionsState[selectedRole]) {
      setWorkingPermissions(JSON.parse(JSON.stringify(permissionsState[selectedRole].modulePermissions || {})));
    } else if (selectedRoleRecord?.defaultPermissions) {
      setWorkingPermissions(JSON.parse(JSON.stringify(selectedRoleRecord.defaultPermissions)));
    } else {
      const defaults =
        selectedRole === 'admin'
          ? DEFAULT_ADMIN_PERMISSIONS
          : selectedRole === 'user'
            ? DEFAULT_USER_PERMISSIONS
            : EMPTY_MODULE_PERMISSIONS;
      setWorkingPermissions(JSON.parse(JSON.stringify(defaults)));
    }
  }, [selectedRole, permissionsState, selectedRoleRecord]);

  // Handle individual toggle
  const handleToggle = (moduleKey: string, action: ModuleAction) => {
    if (!isSuperAdmin || selectedRole === 'super_admin') return;

    setWorkingPermissions(prev => {
      const currentMod = prev[moduleKey] || { view: false, add: false, edit: false, delete: false };
      const nextValue = !currentMod[action];

      const updated = {
        ...currentMod,
        [action]: nextValue,
      };

      // If user enables add/edit/delete, automatically enable view
      if (nextValue && (action === 'add' || action === 'edit' || action === 'delete')) {
        updated.view = true;
      }

      // If user disables view, automatically disable add/edit/delete
      if (!nextValue && action === 'view') {
        updated.add = false;
        updated.edit = false;
        updated.delete = false;
      }

      return {
        ...prev,
        [moduleKey]: updated,
      };
    });
  };

  // Select all permissions for selected role
  const handleSelectAll = () => {
    if (!isSuperAdmin || selectedRole === 'super_admin') return;

    const allSelected: Record<string, ModulePermission> = {};
    PERMISSION_MODULES.forEach(m => {
      allSelected[m.key] = { view: true, add: true, edit: true, delete: true };
    });
    setWorkingPermissions(allSelected);
  };

  // Deselect all permissions for selected role
  const handleDeselectAll = () => {
    if (!isSuperAdmin || selectedRole === 'super_admin') return;

    const allDeselected: Record<string, ModulePermission> = {};
    PERMISSION_MODULES.forEach(m => {
      allDeselected[m.key] = { view: false, add: false, edit: false, delete: false };
    });
    setWorkingPermissions(allDeselected);
  };

  // Reset to default matrix
  const handleResetToDefault = () => {
    if (!isSuperAdmin || selectedRole === 'super_admin') return;

    const defaults =
      selectedRole === 'admin'
        ? DEFAULT_ADMIN_PERMISSIONS
        : selectedRole === 'user'
          ? DEFAULT_USER_PERMISSIONS
          : selectedRoleRecord?.defaultPermissions || EMPTY_MODULE_PERMISSIONS;
    setWorkingPermissions(JSON.parse(JSON.stringify(defaults)));
    setStatusMessage({
      type: 'success',
      text: `Reset working matrix to default for ${selectedRoleLabel.toUpperCase()}. Click "Save Permissions" to persist.`,
    });
    setTimeout(() => setStatusMessage(null), 5000);
  };

  // Trigger Save with confirmation
  const handleInitiateSave = () => {
    if (!isSuperAdmin || selectedRole === 'super_admin') return;
    setShowConfirmModal(true);
  };

  // Execute Save
  const handleConfirmSave = async () => {
    setShowConfirmModal(false);
    setIsSaving(true);
    setStatusMessage(null);

    try {
      const callerId = currentUserRole?.loginId || 'superadmin';
      await saveRolePermissions(callerId, selectedRole, workingPermissions);

      setStatusMessage({
        type: 'success',
        text: `Role permissions for ${selectedRoleLabel.toUpperCase()} saved successfully! Dynamic policies applied to all active sessions.`,
      });
      setTimeout(() => setStatusMessage(null), 6000);
    } catch (err: any) {
      console.error('[RolePermissionsManagement] Save failed:', err);
      setStatusMessage({
        type: 'error',
        text: err.message || 'Failed to update role permissions. Please try again.',
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Top Title Banner */}
      <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-50 border border-indigo-200 flex items-center justify-center text-indigo-600">
              <Sliders className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-extrabold text-slate-800 tracking-tight">
                ROLE PERMISSIONS MANAGEMENT
              </h2>
              <p className="text-xs text-slate-500">
                Independent granular control over View, Add, Edit and Delete permissions per role
              </p>
            </div>
          </div>
        </div>

        {/* Super Admin Session Badge */}
        <div className="flex items-center gap-2">
          {isSuperAdmin ? (
            <span className="inline-flex items-center gap-1.5 bg-emerald-50 border border-emerald-300 text-emerald-800 text-xs font-semibold px-3 py-1.5 rounded-xl shadow-2xs">
              <ShieldCheck className="w-4 h-4 text-emerald-600" />
              <span>Super Admin Authorization Active</span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 bg-amber-50 border border-amber-300 text-amber-800 text-xs font-semibold px-3 py-1.5 rounded-xl">
              <Lock className="w-4 h-4 text-amber-600" />
              <span>Read-Only Mode (Super Admin Required)</span>
            </span>
          )}
        </div>
      </div>

      {/* Non-Super Admin Warning */}
      {!isSuperAdmin && (
        <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-xs flex items-start gap-3">
          <Info className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
          <div>
            <span className="font-bold">Privilege Notice: </span>
            <span>
              Admin and User roles cannot modify permissions or elevate privileges. Only the <strong>Super Admin</strong> can configure and save module access controls.
            </span>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {statusMessage && (
        <div className={`p-3.5 rounded-xl text-xs font-medium flex items-center gap-2 transition ${
          statusMessage.type === 'success' 
            ? 'bg-emerald-50 border border-emerald-200 text-emerald-900' 
            : 'bg-red-50 border border-red-200 text-red-900'
        }`}>
          {statusMessage.type === 'success' ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
          )}
          <span>{statusMessage.text}</span>
        </div>
      )}

      {/* Role Selection & Actions Toolbar */}
      <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        {/* Dynamic Role Selector Tabs */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-bold text-slate-500 uppercase tracking-wider mr-1">Configure Role:</span>
          {orderedRoles.map((roleObj) => {
            const isSuper = roleObj.roleId === 'super_admin';
            const isSelected = selectedRole === roleObj.roleId;
            const roleCount = users
              ? users.filter((u) => normalizeRoleId(u.role) === roleObj.roleId).length
              : isSuper
                ? 1
                : 0;
            const tabLabel =
              roleObj.roleId === 'super_admin'
                ? 'Super Admin'
                : roleObj.roleId === 'admin'
                  ? 'Admin'
                  : roleObj.roleId === 'user'
                    ? 'User'
                    : roleObj.roleName || roleObj.roleId.toUpperCase();

            return (
              <button
                key={roleObj.roleId}
                type="button"
                onClick={() => setSelectedRole(roleObj.roleId)}
                className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-2 cursor-pointer ${
                  isSelected
                    ? isSuper
                      ? 'bg-slate-800 text-white shadow-md'
                      : 'bg-blue-600 text-white shadow-md'
                    : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200'
                }`}
              >
                {isSuper && <Lock className="w-3.5 h-3.5 text-amber-400" />}
                <span>{tabLabel} ({roleCount})</span>
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                    isSelected
                      ? isSuper
                        ? 'bg-slate-900 text-amber-300'
                        : 'bg-blue-700 text-white'
                      : 'bg-slate-200 text-slate-600'
                  }`}
                >
                  {isSuper ? 'Unrestricted' : roleObj.isActive === false ? 'Inactive' : 'Configurable'}
                </span>
              </button>
            );
          })}
        </div>

        {/* Action Controls for Selected Role */}
        <div className="flex flex-wrap items-center gap-2">
          {selectedRole !== 'super_admin' && isSuperAdmin && (
            <>
              <button
                type="button"
                onClick={handleSelectAll}
                className="px-2.5 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold flex items-center gap-1.5 border border-slate-200 transition cursor-pointer"
                title="Grant all permissions for this role"
              >
                <CheckSquare className="w-3.5 h-3.5 text-blue-600" />
                <span>Select All</span>
              </button>

              <button
                type="button"
                onClick={handleDeselectAll}
                className="px-2.5 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold flex items-center gap-1.5 border border-slate-200 transition cursor-pointer"
                title="Revoke all permissions for this role"
              >
                <Square className="w-3.5 h-3.5 text-slate-500" />
                <span>Deselect All</span>
              </button>

              <button
                type="button"
                onClick={handleResetToDefault}
                className="px-2.5 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold flex items-center gap-1.5 border border-slate-200 transition cursor-pointer"
                title="Reset to recommended default configuration"
              >
                <RotateCcw className="w-3.5 h-3.5 text-amber-600" />
                <span>Reset to Default</span>
              </button>

              <button
                type="button"
                onClick={handleInitiateSave}
                disabled={isSaving}
                className="px-4 py-1.5 rounded-lg bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white text-xs font-bold flex items-center gap-2 shadow-sm transition cursor-pointer active:scale-95 disabled:opacity-50"
              >
                <Save className={`w-3.5 h-3.5 ${isSaving ? 'animate-spin' : ''}`} />
                <span>{isSaving ? 'Saving...' : 'Save Permissions'}</span>
              </button>
            </>
          )}

          {selectedRole === 'super_admin' && (
            <div className="text-xs text-slate-500 italic flex items-center gap-1.5 bg-slate-50 px-3 py-1.5 rounded-lg border border-slate-200">
              <Lock className="w-3.5 h-3.5 text-amber-500" />
              <span>Super Admin permissions are permanent and cannot be modified.</span>
            </div>
          )}
        </div>
      </div>

      {/* Permissions Matrix Table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
        <div className="p-4 border-b border-slate-200 bg-slate-50/80 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h3 className="text-xs font-extrabold text-slate-800 uppercase tracking-wider flex items-center gap-2">
              <span>Configuring:</span>
              <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                selectedRole === 'super_admin' ? 'bg-slate-900 text-white' :
                selectedRole === 'admin' ? 'bg-blue-100 text-blue-800' :
                selectedRole === 'user' ? 'bg-emerald-100 text-emerald-800' :
                'bg-indigo-100 text-indigo-800'
              }`}>
                {selectedRoleLabel}
              </span>
            </h3>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Control View (page visibility), Add (records creation), Edit (updates) and Delete (removal)
            </p>
          </div>
          <span className="text-[11px] text-slate-400 font-mono">
            {PERMISSION_MODULES.length} modules configured
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="bg-slate-50 text-slate-600 uppercase font-semibold border-b border-slate-200">
              <tr>
                <th className="py-3 px-4 w-1/3">Module / Section</th>
                <th className="py-3 px-4 text-center w-1/6">
                  <div className="flex items-center justify-center gap-1.5">
                    <Eye className="w-3.5 h-3.5 text-blue-600" />
                    <span>View</span>
                  </div>
                </th>
                <th className="py-3 px-4 text-center w-1/6">
                  <div className="flex items-center justify-center gap-1.5">
                    <PlusCircle className="w-3.5 h-3.5 text-emerald-600" />
                    <span>Add</span>
                  </div>
                </th>
                <th className="py-3 px-4 text-center w-1/6">
                  <div className="flex items-center justify-center gap-1.5">
                    <Edit3 className="w-3.5 h-3.5 text-amber-600" />
                    <span>Edit</span>
                  </div>
                </th>
                <th className="py-3 px-4 text-center w-1/6">
                  <div className="flex items-center justify-center gap-1.5">
                    <Trash2 className="w-3.5 h-3.5 text-red-600" />
                    <span>Delete</span>
                  </div>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {PERMISSION_MODULES.map((module) => {
                const perms = workingPermissions[module.key] || { view: false, add: false, edit: false, delete: false };
                const isSuper = selectedRole === 'super_admin';
                const isReadOnly = !isSuperAdmin || isSuper;

                return (
                  <tr 
                    key={module.key}
                    className={`hover:bg-slate-50/80 transition ${module.submodule ? 'bg-slate-50/30' : ''}`}
                  >
                    {/* Module Info */}
                    <td className="py-3 px-4">
                      <div className={`flex flex-col ${module.submodule ? 'pl-6 border-l-2 border-slate-200 ml-2' : ''}`}>
                        <div className="flex items-center gap-2">
                          <span className={`font-semibold text-slate-800 ${module.isParent ? 'text-slate-900 font-bold' : ''}`}>
                            {module.label}
                          </span>
                          <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 font-mono">
                            {module.category}
                          </span>
                        </div>
                        <span className="text-[11px] text-slate-400 mt-0.5">
                          {module.description}
                        </span>
                      </div>
                    </td>

                    {/* VIEW TOGGLE */}
                    <td className="py-3 px-4 text-center">
                      <label className="inline-flex items-center justify-center cursor-pointer">
                        <input
                          type="checkbox"
                          checked={isSuper ? true : perms.view}
                          disabled={isReadOnly}
                          onChange={() => handleToggle(module.key, 'view')}
                          className="w-4 h-4 text-blue-600 rounded border-slate-300 focus:ring-blue-500 cursor-pointer disabled:cursor-not-allowed"
                        />
                      </label>
                    </td>

                    {/* ADD TOGGLE */}
                    <td className="py-3 px-4 text-center">
                      <label className="inline-flex items-center justify-center cursor-pointer">
                        <input
                          type="checkbox"
                          checked={isSuper ? true : perms.add}
                          disabled={isReadOnly}
                          onChange={() => handleToggle(module.key, 'add')}
                          className="w-4 h-4 text-emerald-600 rounded border-slate-300 focus:ring-emerald-500 cursor-pointer disabled:cursor-not-allowed"
                        />
                      </label>
                    </td>

                    {/* EDIT TOGGLE */}
                    <td className="py-3 px-4 text-center">
                      <label className="inline-flex items-center justify-center cursor-pointer">
                        <input
                          type="checkbox"
                          checked={isSuper ? true : perms.edit}
                          disabled={isReadOnly}
                          onChange={() => handleToggle(module.key, 'edit')}
                          className="w-4 h-4 text-amber-600 rounded border-slate-300 focus:ring-amber-500 cursor-pointer disabled:cursor-not-allowed"
                        />
                      </label>
                    </td>

                    {/* DELETE TOGGLE */}
                    <td className="py-3 px-4 text-center">
                      <label className="inline-flex items-center justify-center cursor-pointer">
                        <input
                          type="checkbox"
                          checked={isSuper ? true : perms.delete}
                          disabled={isReadOnly}
                          onChange={() => handleToggle(module.key, 'delete')}
                          className="w-4 h-4 text-red-600 rounded border-slate-300 focus:ring-red-500 cursor-pointer disabled:cursor-not-allowed"
                        />
                      </label>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Matrix Footer Note */}
        <div className="p-3 border-t border-slate-200 bg-slate-50 flex flex-col sm:flex-row sm:items-center justify-between text-[11px] text-slate-500 gap-2">
          <span>
            * Enabling Add, Edit, or Delete automatically enables View. Disabling View revokes write permissions for that module.
          </span>
          <span className="font-mono text-slate-400">
            Backend Authorization: Enforced
          </span>
        </div>
      </div>

      {/* CONFIRMATION MODAL */}
      {showConfirmModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 animate-fadeIn">
          <div className="bg-white rounded-2xl max-w-md w-full shadow-2xl border border-slate-200 overflow-hidden">
            <div className="p-5 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <div className="flex items-center gap-2 text-slate-800">
                <ShieldAlert className="w-5 h-5 text-indigo-600" />
                <h3 className="text-sm font-bold uppercase tracking-wider">Confirm Role Permission Update</h3>
              </div>
              <button 
                onClick={() => setShowConfirmModal(false)}
                className="p-1 rounded-lg hover:bg-slate-200 text-slate-400 hover:text-slate-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-3 text-xs text-slate-600">
              <p>
                Are you sure you want to apply these permission updates to role{' '}
                <strong className="text-slate-900 font-bold uppercase">{selectedRoleLabel}</strong>?
              </p>
              <div className="p-3 bg-blue-50 border border-blue-200 rounded-xl text-blue-900 space-y-1">
                <p className="font-semibold">Dynamic Updates:</p>
                <ul className="list-disc pl-4 space-y-0.5 text-[11px]">
                  <li>Changes are stored securely in Firestore (<code className="font-mono">role_permissions/{selectedRole}</code>).</li>
                  <li>All users with role "{selectedRoleLabel}" will have their navigation and action capabilities updated in real time.</li>
                  <li>Unauthorized action buttons (Add, Edit, Delete) will be dynamically hidden and blocked.</li>
                </ul>
              </div>
            </div>

            <div className="p-4 border-t border-slate-200 bg-slate-50 flex justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setShowConfirmModal(false)}
                className="px-4 py-2 rounded-xl border border-slate-300 text-slate-700 hover:bg-slate-100 font-semibold text-xs cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmSave}
                className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs shadow-md transition cursor-pointer"
              >
                Yes, Save Permissions
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
