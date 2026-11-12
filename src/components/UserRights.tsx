import React, { useState, useEffect } from 'react';
import { 
  ShieldCheck, 
  Key, 
  CheckCircle2, 
  AlertCircle,
  RefreshCw,
  UserPlus,
  Sliders,
  Trash2,
  Lock,
  Eye,
  EyeOff,
  X,
  Info,
  ShieldAlert,
  Save,
  Check,
  Building,
  User,
  CheckSquare,
  Square,
  KeyRound,
  History,
  Sparkles,
  Unlock,
  RotateCcw
} from 'lucide-react';
import { RolePermissionsManagement } from './RolePermissionsManagement';
import { onSnapshot, collection } from 'firebase/firestore';
import { db } from '../firebase';
import { UserRoleRecord, UserRoleType } from '../types';
import { 
  getAllUserRoles, 
  createUserAccount, 
  adminSetUserPassword, 
  fetchPasswordResetHistory,
  updateUserRolePermissions, 
  deleteUserRole,
  INITIAL_DEFAULT_PASSWORD
} from '../services/authService';
import {
  PERMISSION_MODULES,
  RoleRecord,
  RolePermissionRecord,
  UserPermissionRecord,
  ModulePermission,
  ModuleAction,
  subscribeToRoles,
  subscribeToUserPermissions,
  subscribeToAllRolePermissions,
  saveUserIndividualPermissions,
  getEffectiveModulePermissions,
  DEFAULT_SUPER_ADMIN_PERMISSIONS,
  DEFAULT_ADMIN_PERMISSIONS,
  DEFAULT_USER_PERMISSIONS
} from '../services/permissionService';

const safeStr = (v: any, fallback = ''): string => {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'object') {
    return v.name || v.loginId || v.role || v.status || v.email || JSON.stringify(v);
  }
  return String(v);
};

interface UserRightsProps {
  currentUserRole?: UserRoleRecord | null;
  onRoleProfileUpdated?: (updatedProfile: UserRoleRecord) => void;
}

export const UserRights: React.FC<UserRightsProps> = ({ currentUserRole, onRoleProfileUpdated }) => {
  const [users, setUsers] = useState<UserRoleRecord[]>([]);
  const [isLoadingUsers, setIsLoadingUsers] = useState(false);
  const [activeTab, setActiveTab] = useState<'users' | 'role_permissions' | 'matrix' | 'roles' | 'passwords'>('users');
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Firestore Subscribed Roles & Permissions
  const [rolesList, setRolesList] = useState<RoleRecord[]>([]);
  const [rolePermissionsMap, setRolePermissionsMap] = useState<Record<string, RolePermissionRecord>>({});
  const [userPermissionsMap, setUserPermissionsMap] = useState<Record<string, UserPermissionRecord>>({});

  // Super Admin Password Management Panel State (Section 4)
  const [selectedResetUser, setSelectedResetUser] = useState<UserRoleRecord | null>(null);
  const [panelNewPassword, setPanelNewPassword] = useState('');
  const [showPanelNewPassword, setShowPanelNewPassword] = useState(false);
  const [panelForceChange, setPanelForceChange] = useState(true);
  const [panelUnlockAccount, setPanelUnlockAccount] = useState(true);
  const [panelRevokeSessions, setPanelRevokeSessions] = useState(true);
  const [isSubmittingPanelReset, setIsSubmittingPanelReset] = useState(false);
  const [passwordHistoryList, setPasswordHistoryList] = useState<any[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  // Modal States
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isPasswordModalOpen, setIsPasswordModalOpen] = useState(false);
  const [isPermissionsModalOpen, setIsPermissionsModalOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<UserRoleRecord | null>(null);

  // Deletion Confirmation Modal State (Section 1)
  const [userToDelete, setUserToDelete] = useState<UserRoleRecord | null>(null);
  const [isDeletingUser, setIsDeletingUser] = useState(false);

  // Form States - Create User (Section 2)
  const [createFormData, setCreateFormData] = useState({
    name: '',
    loginId: '',
    email: '',
    role: 'admin' as UserRoleType,
    password: INITIAL_DEFAULT_PASSWORD,
    status: 'Active' as 'Active' | 'Inactive',
    mustChangePassword: true,
    modulesAllowed: ['dashboard', 'scanner', 'employees', 'history', 'reports'] as string[],
  });
  const [isSubmittingCreate, setIsSubmittingCreate] = useState(false);
  const [showCreatePassword, setShowCreatePassword] = useState(false);

  // Form States - Change Password
  const [newPassword, setNewPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [requirePasswordChange, setRequirePasswordChange] = useState(false);
  const [isSubmittingPassword, setIsSubmittingPassword] = useState(false);

  // Form States - Edit Permissions Modal
  const [editModulesAllowed, setEditModulesAllowed] = useState<string[]>([]);
  const [editRole, setEditRole] = useState<UserRoleType>('user');
  const [editStatus, setEditStatus] = useState<'Active' | 'Inactive'>('Active');
  const [isSubmittingPermissions, setIsSubmittingPermissions] = useState(false);

  // Module Permission Matrix Tab State (Section 4)
  const [matrixViewMode, setMatrixViewMode] = useState<'roles' | 'user'>('roles');
  const [selectedMatrixUserId, setSelectedMatrixUserId] = useState<string>('');
  const [workingUserPerms, setWorkingUserPerms] = useState<Record<string, ModulePermission>>({});
  const [isSavingUserMatrix, setIsSavingUserMatrix] = useState<boolean>(false);

  const isSuperAdmin = currentUserRole?.role?.toUpperCase() === 'SUPER_ADMIN' || currentUserRole?.loginId === 'superadmin';

  // Real-time synchronization with Firestore collection 'user_roles'
  useEffect(() => {
    setIsLoadingUsers(true);
    const unsubscribeUsers = onSnapshot(
      collection(db, 'user_roles'),
      (snapshot) => {
        const fetched: UserRoleRecord[] = snapshot.docs.map(doc => {
          const data = doc.data() as UserRoleRecord;
          return { ...data, id: doc.id };
        });

        // Sort: Super Admin first, then admin, then user
        const order: Record<string, number> = { super_admin: 0, admin: 1, user: 2 };
        fetched.sort((a, b) => {
          const aOrder = order[a.role?.toLowerCase()] ?? 3;
          const bOrder = order[b.role?.toLowerCase()] ?? 3;
          if (aOrder !== bOrder) return aOrder - bOrder;
          return (a.loginId || '').localeCompare(b.loginId || '');
        });

        setUsers(fetched);
        setIsLoadingUsers(false);

        // Update default matrix selection if not selected
        if (!selectedMatrixUserId && fetched.length > 0) {
          const firstNonSuper = fetched.find(u => u.role?.toLowerCase() !== 'super_admin') || fetched[0];
          setSelectedMatrixUserId(firstNonSuper.id);
        }

        // Update current session profile if matched
        if (currentUserRole) {
          const currentInDb = fetched.find(u => u.id === currentUserRole.id || u.loginId === currentUserRole.loginId);
          if (currentInDb && onRoleProfileUpdated) {
            onRoleProfileUpdated(currentInDb);
          }
        }
      },
      (err) => {
        console.warn('Real-time user_roles error, falling back to manual fetch:', err);
        loadUsersManual();
      }
    );

    // Subscribe to Firestore roles collection (Section 3)
    const unsubscribeRoles = subscribeToRoles((roles) => {
      setRolesList(roles);
    });

    // Subscribe to role_permissions
    const unsubscribeRolePerms = subscribeToAllRolePermissions((data) => {
      setRolePermissionsMap(data);
    });

    // Subscribe to user_permissions (Section 4)
    const unsubscribeUserPerms = subscribeToUserPermissions((data) => {
      setUserPermissionsMap(data);
    });

    return () => {
      unsubscribeUsers();
      unsubscribeRoles();
      unsubscribeRolePerms();
      unsubscribeUserPerms();
    };
  }, [currentUserRole?.id]);

  // Update working permissions when matrix user changes
  useEffect(() => {
    if (!selectedMatrixUserId) return;
    const targetUser = users.find(u => u.id === selectedMatrixUserId);
    if (!targetUser) return;

    const userOverride = userPermissionsMap[selectedMatrixUserId];
    const roleDefault = rolePermissionsMap[targetUser.role?.toLowerCase()];
    const effective = getEffectiveModulePermissions(targetUser.role, userOverride, roleDefault);
    setWorkingUserPerms(JSON.parse(JSON.stringify(effective)));
  }, [selectedMatrixUserId, userPermissionsMap, rolePermissionsMap, users]);

  const loadUsersManual = async () => {
    setIsLoadingUsers(true);
    try {
      const data = await getAllUserRoles();
      setUsers(data);
    } catch (err) {
      console.error('Failed to load user roles:', err);
    } finally {
      setIsLoadingUsers(false);
    }
  };

  const showToast = (type: 'success' | 'error', text: string) => {
    setStatusMessage({ type, text });
    setTimeout(() => setStatusMessage(null), 5000);
  };

  // Super Admin Password Management Handlers (Section 4)
  const loadPasswordHistory = async () => {
    if (!isSuperAdmin) return;
    setIsLoadingHistory(true);
    try {
      const history = await fetchPasswordResetHistory();
      setPasswordHistoryList(history);
    } catch (err: any) {
      console.warn('Failed to load password reset history:', err.message);
    } finally {
      setIsLoadingHistory(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'passwords' && isSuperAdmin) {
      loadPasswordHistory();
      if (!selectedResetUser && users.length > 0) {
        const defaultTarget = users.find(u => u.loginId !== 'superadmin' && u.role !== 'super_admin') || users[0];
        setSelectedResetUser(defaultTarget);
      }
    }
  }, [activeTab, isSuperAdmin, users]);

  const generateRandomPassword = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    setPanelNewPassword(`Narid@${code}`);
    setShowPanelNewPassword(true);
  };

  const handlePanelResetSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedResetUser) {
      showToast('error', 'Please select a target account to reset.');
      return;
    }
    if (!panelNewPassword || panelNewPassword.length < 6) {
      showToast('error', 'Temporary password must contain at least 6 characters.');
      return;
    }

    setIsSubmittingPanelReset(true);
    try {
      await adminSetUserPassword(
        selectedResetUser.id,
        selectedResetUser.loginId,
        panelNewPassword,
        panelForceChange,
        panelUnlockAccount,
        panelRevokeSessions
      );
      showToast('success', `Password for "${selectedResetUser.loginId}" reset successfully. Force next login change: ${panelForceChange ? 'Enabled' : 'Disabled'}.`);
      setPanelNewPassword('');
      loadPasswordHistory();
      loadUsersManual();
    } catch (err: any) {
      showToast('error', err.message || 'Failed to reset password.');
    } finally {
      setIsSubmittingPanelReset(false);
    }
  };

  // 1. OPEN CREATE USER MODAL
  const handleOpenCreateModal = () => {
    setCreateFormData({
      name: '',
      loginId: '',
      email: '',
      role: 'admin',
      password: INITIAL_DEFAULT_PASSWORD,
      status: 'Active',
      mustChangePassword: true,
      modulesAllowed: ['dashboard', 'scanner', 'employees', 'history', 'reports', 'qr_codes'],
    });
    setShowCreatePassword(false);
    setIsCreateModalOpen(true);
  };

  // 2. SUBMIT CREATE USER (Section 2)
  const handleCreateUserSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!createFormData.loginId.trim()) {
      showToast('error', 'Please enter a Login ID.');
      return;
    }
    if (!createFormData.password || createFormData.password.length < 6) {
      showToast('error', 'Password must be at least 6 characters.');
      return;
    }

    setIsSubmittingCreate(true);
    try {
      const finalModules = createFormData.role === 'super_admin' ? ['all'] : createFormData.modulesAllowed;
      const created = await createUserAccount({
        name: createFormData.name || createFormData.loginId.toUpperCase(),
        loginId: createFormData.loginId.trim().toLowerCase(),
        email: createFormData.email.trim() || undefined,
        password: createFormData.password,
        role: createFormData.role,
        modulesAllowed: finalModules,
        status: createFormData.status,
        mustChangePassword: createFormData.mustChangePassword,
      });

      showToast('success', `Login ID "${created.loginId}" created and synchronized with Firebase!`);
      setIsCreateModalOpen(false);
    } catch (err: any) {
      showToast('error', err.message || 'Failed to create user account.');
    } finally {
      setIsSubmittingCreate(false);
    }
  };

  // 3. OPEN PASSWORD CHANGE MODAL
  const handleOpenPasswordModal = (user: UserRoleRecord) => {
    setSelectedUser(user);
    setNewPassword('');
    setShowNewPassword(false);
    setRequirePasswordChange(false);
    setIsPasswordModalOpen(true);
  };

  // 4. SUBMIT PASSWORD CHANGE
  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUser) return;
    if (!newPassword || newPassword.length < 6) {
      showToast('error', 'Password must be at least 6 characters.');
      return;
    }

    setIsSubmittingPassword(true);
    try {
      await adminSetUserPassword(
        selectedUser.id,
        selectedUser.loginId,
        newPassword,
        requirePasswordChange,
        true,
        true
      );
      showToast('success', `Password for "${selectedUser.loginId}" successfully updated in Firebase! Force next login change: ${requirePasswordChange ? 'Yes' : 'No'}.`);
      setIsPasswordModalOpen(false);
      loadPasswordHistory();
      loadUsersManual();
    } catch (err: any) {
      showToast('error', err.message || 'Failed to update password.');
    } finally {
      setIsSubmittingPassword(false);
    }
  };

  // 5. OPEN PERMISSIONS MODAL
  const handleOpenPermissionsModal = (user: UserRoleRecord) => {
    setSelectedUser(user);
    setEditRole(user.role);
    setEditStatus(user.status || 'Active');
    if (user.modulesAllowed?.includes('all') || user.role === 'super_admin') {
      setEditModulesAllowed(PERMISSION_MODULES.map(m => m.key));
    } else {
      setEditModulesAllowed(user.modulesAllowed || []);
    }
    setIsPermissionsModalOpen(true);
  };

  // 6. SUBMIT PERMISSIONS CHANGE
  const handlePermissionsSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUser) return;

    setIsSubmittingPermissions(true);
    try {
      const finalModules = editRole === 'super_admin' ? ['all'] : editModulesAllowed;
      await updateUserRolePermissions(
        selectedUser.id,
        finalModules,
        editRole,
        editStatus
      );
      showToast('success', `Permissions for "${selectedUser.loginId}" updated in Firebase!`);
      setIsPermissionsModalOpen(false);
    } catch (err: any) {
      showToast('error', err.message || 'Failed to update permissions.');
    } finally {
      setIsSubmittingPermissions(false);
    }
  };

  // 7. OPEN DELETE CONFIRMATION MODAL (Section 1)
  const handleOpenDeleteModal = (user: UserRoleRecord) => {
    if (user.loginId === 'superadmin' || user.id === 'role_superadmin') {
      showToast('error', 'The primary root Super Admin account cannot be deleted.');
      return;
    }
    if (currentUserRole && user.loginId === currentUserRole.loginId) {
      showToast('error', 'Administrators cannot delete their own account.');
      return;
    }
    setUserToDelete(user);
  };

  // 8. EXECUTE ACCOUNT DELETION (Section 1)
  const handleConfirmDeleteUser = async () => {
    if (!userToDelete) return;

    setIsDeletingUser(true);
    try {
      await deleteUserRole(userToDelete.id, userToDelete.loginId);
      showToast('success', `User "${userToDelete.loginId}" (${userToDelete.name}) successfully deleted from Firebase.`);
      setUserToDelete(null);
    } catch (err: any) {
      showToast('error', err.message || 'Failed to delete user.');
    } finally {
      setIsDeletingUser(false);
    }
  };

  // Toggle Module Checkbox Helper
  const toggleModule = (moduleKey: string, currentList: string[], setter: (val: string[]) => void) => {
    if (currentList.includes(moduleKey)) {
      setter(currentList.filter(k => k !== moduleKey));
    } else {
      setter([...currentList, moduleKey]);
    }
  };

  // Toggle Individual Matrix Action
  const toggleMatrixUserAction = (moduleKey: string, action: ModuleAction) => {
    if (!isSuperAdmin) return;
    const targetUser = users.find(u => u.id === selectedMatrixUserId);
    if (targetUser?.role?.toLowerCase() === 'super_admin') return;

    setWorkingUserPerms(prev => {
      const current = prev[moduleKey] || { view: false, add: false, edit: false, delete: false };
      const nextVal = !current[action];
      const updated = { ...current, [action]: nextVal };
      if (nextVal && (action === 'add' || action === 'edit' || action === 'delete')) {
        updated.view = true;
      }
      if (!nextVal && action === 'view') {
        updated.add = false;
        updated.edit = false;
        updated.delete = false;
      }
      return { ...prev, [moduleKey]: updated };
    });
  };

  // Save User Individual Matrix Overrides
  const handleSaveUserMatrix = async () => {
    if (!selectedMatrixUserId) return;
    const targetUser = users.find(u => u.id === selectedMatrixUserId);
    if (!targetUser) return;

    setIsSavingUserMatrix(true);
    try {
      const callerId = currentUserRole?.loginId || 'superadmin';
      // Calculate allowed module keys based on view permission
      const allowedKeys = Object.entries(workingUserPerms)
        .filter(([_, p]) => p.view)
        .map(([k, _]) => k);

      await saveUserIndividualPermissions(
        callerId,
        selectedMatrixUserId,
        workingUserPerms,
        allowedKeys,
        targetUser.role,
        targetUser.status
      );

      showToast('success', `Customized permissions for "${targetUser.loginId}" saved to Firebase!`);
    } catch (err: any) {
      showToast('error', err.message || 'Failed to save individual permissions.');
    } finally {
      setIsSavingUserMatrix(false);
    }
  };

  return (
    <div className="p-6 bg-slate-50 min-h-full flex flex-col gap-6">
      {/* Top Banner / Actions Bar */}
      <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-blue-600 text-white flex items-center justify-center font-bold">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
                USER RIGHTS & AUTHORIZATION
                {isSuperAdmin && (
                  <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700 text-[10px] font-extrabold uppercase tracking-wider">
                    Super Admin Console
                  </span>
                )}
              </h2>
              <p className="text-xs text-slate-500">
                Manage login accounts, passwords, role descriptions, and module permissions with instant Firebase sync
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="px-3 py-1.5 rounded-xl bg-emerald-50 border border-emerald-300 text-emerald-800 text-xs font-semibold flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
            <span>FIREBASE SYNC: LIVE</span>
          </div>

          <button
            onClick={loadUsersManual}
            disabled={isLoadingUsers}
            className="p-2 rounded-xl border border-slate-200 hover:bg-slate-100 text-slate-600 transition cursor-pointer"
            title="Refresh Users"
          >
            <RefreshCw className={`w-4 h-4 ${isLoadingUsers ? 'animate-spin text-blue-600' : ''}`} />
          </button>

          {isSuperAdmin && (
            <button
              onClick={handleOpenCreateModal}
              className="px-4 py-2 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 text-white font-bold text-xs flex items-center gap-2 shadow-md hover:from-blue-700 hover:to-indigo-700 transition active:scale-95 cursor-pointer"
            >
              <UserPlus className="w-4 h-4" />
              <span>+ CREATE NEW LOGIN ID</span>
            </button>
          )}
        </div>
      </div>

      {/* Super Admin Notice if non-superadmin views this */}
      {!isSuperAdmin && (
        <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-xs flex items-start gap-3">
          <Info className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
          <div>
            <span className="font-bold">Read-Only Access: </span>
            <span>
              You are currently viewing user authorizations in view mode. Only the <strong>Super Admin</strong> has privileges to create new Login IDs, delete accounts, modify passwords, and configure permissions.
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

      {/* Navigation Tabs */}
      <div className="flex items-center gap-3 border-b border-slate-200 pb-1 overflow-x-auto">
        <button
          onClick={() => setActiveTab('users')}
          className={`pb-2 px-3 text-xs font-bold transition border-b-2 flex items-center gap-2 shrink-0 cursor-pointer ${
            activeTab === 'users' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <User className="w-4 h-4" />
          <span>Active User Directory ({users.length})</span>
        </button>

        {/* ROLE PERMISSIONS MANAGEMENT SUBMODULE */}
        <button
          onClick={() => setActiveTab('role_permissions')}
          className={`pb-2 px-3 text-xs font-bold transition border-b-2 flex items-center gap-2 shrink-0 cursor-pointer ${
            activeTab === 'role_permissions' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <ShieldCheck className="w-4 h-4 text-indigo-600" />
          <span>Role Permissions Management</span>
          <span className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ${
            activeTab === 'role_permissions' ? 'bg-indigo-100 text-indigo-800' : 'bg-slate-100 text-slate-600'
          }`}>
            Granular View / Add / Edit / Delete
          </span>
        </button>

        {/* MODULE PERMISSION MATRIX SUBMODULE */}
        <button
          onClick={() => setActiveTab('matrix')}
          className={`pb-2 px-3 text-xs font-bold transition border-b-2 flex items-center gap-2 shrink-0 cursor-pointer ${
            activeTab === 'matrix' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <Sliders className="w-4 h-4" />
          <span>Module Permission Matrix</span>
        </button>

        {/* ROLE DESCRIPTIONS SUBMODULE */}
        <button
          onClick={() => setActiveTab('roles')}
          className={`pb-2 px-3 text-xs font-bold transition border-b-2 flex items-center gap-2 shrink-0 cursor-pointer ${
            activeTab === 'roles' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <Building className="w-4 h-4" />
          <span>Role Descriptions ({rolesList.length})</span>
        </button>

        {/* SUPER ADMIN PASSWORD MANAGEMENT & GOVERNANCE SUBMODULE */}
        {isSuperAdmin && (
          <button
            onClick={() => setActiveTab('passwords')}
            className={`pb-2 px-3 text-xs font-bold transition border-b-2 flex items-center gap-2 shrink-0 cursor-pointer ${
              activeTab === 'passwords' ? 'border-amber-600 text-amber-700' : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <Key className="w-4 h-4 text-amber-600" />
            <span>Password Governance & Reset</span>
            <span className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ${
              activeTab === 'passwords' ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-600'
            }`}>
              Super Admin Only
            </span>
          </button>
        )}
      </div>

      {/* ========================================================================= */}
      {/* TAB 1: ACTIVE USER DIRECTORY                                              */}
      {/* ========================================================================= */}
      {activeTab === 'users' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
          <div className="p-4 border-b border-slate-200 bg-slate-50/80 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h3 className="text-xs font-extrabold text-slate-800 uppercase tracking-wider">
                Authorized Personnel Directory ({users.length} Total)
              </h3>
              <p className="text-[11px] text-slate-500">
                Click actions on any row to change password, customize module access, or delete account
              </p>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-600 uppercase font-semibold border-b border-slate-200">
                <tr>
                  <th className="py-3 px-4">Login ID / Username</th>
                  <th className="py-3 px-4">Name / Designation</th>
                  <th className="py-3 px-4">Email</th>
                  <th className="py-3 px-4">Role</th>
                  <th className="py-3 px-4">Module Access</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {isLoadingUsers && users.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-slate-400">
                      <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                      Loading accounts from Firebase...
                    </td>
                  </tr>
                ) : users.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-slate-400">
                      No user accounts found. Click "+ Create New Login ID" to provision an account.
                    </td>
                  </tr>
                ) : (
                  users.map(u => {
                    const isSuper = u.role?.toLowerCase() === 'super_admin';
                    const isAdmin = u.role?.toLowerCase() === 'admin';
                    return (
                      <tr key={u.id} className="hover:bg-slate-50 transition">
                        <td className="py-3 px-4 font-mono font-bold text-blue-700">
                          {safeStr(u.loginId)}
                        </td>
                        <td className="py-3 px-4 font-medium text-slate-800">
                          {safeStr(u.name)}
                        </td>
                        <td className="py-3 px-4 text-slate-500 font-mono text-[11px]">
                          {safeStr(u.email)}
                        </td>
                        <td className="py-3 px-4">
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                            isSuper ? 'bg-red-100 text-red-800' :
                            isAdmin ? 'bg-blue-100 text-blue-800' :
                            'bg-slate-100 text-slate-700'
                          }`}>
                            {isSuper ? 'SUPER ADMIN' : isAdmin ? 'ADMIN' : 'USER'}
                          </span>
                        </td>
                        <td className="py-3 px-4">
                          {isSuper ? (
                            <span className="text-emerald-700 font-semibold text-[11px]">All Modules (Full)</span>
                          ) : (
                            <span className="text-slate-600 text-[11px] font-medium">
                              {u.modulesAllowed?.length || 0} Modules Allowed
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-1.5">
                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                              safeStr(u.status) === 'Active' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600'
                            }`}>
                              {safeStr(u.status, 'Active')}
                            </span>
                            {u.mustChangePassword && (
                              <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-semibold text-[9px]">
                                Password Change
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-right">
                          <div className="inline-flex items-center gap-1.5">
                            {isSuperAdmin && (
                              <>
                                <button
                                  onClick={() => handleOpenPasswordModal(u)}
                                  className="p-1.5 rounded-lg border border-slate-200 hover:border-blue-400 hover:bg-blue-50 text-slate-700 hover:text-blue-700 transition cursor-pointer"
                                  title={`Change password for ${u.loginId}`}
                                >
                                  <Key className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={() => handleOpenPermissionsModal(u)}
                                  className="p-1.5 rounded-lg border border-slate-200 hover:border-indigo-400 hover:bg-indigo-50 text-slate-700 hover:text-indigo-700 transition cursor-pointer"
                                  title={`Configure permissions for ${u.loginId}`}
                                >
                                  <Sliders className="w-3.5 h-3.5" />
                                </button>
                                {u.loginId !== 'superadmin' && u.id !== 'role_superadmin' && (
                                  <button
                                    onClick={() => handleOpenDeleteModal(u)}
                                    className="p-1.5 rounded-lg border border-slate-200 hover:border-red-400 hover:bg-red-50 text-slate-700 hover:text-red-700 transition cursor-pointer"
                                    title={`Delete account ${u.loginId}`}
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </>
                            )}
                            {!isSuperAdmin && (
                              <span className="text-[11px] text-slate-400">View Only</span>
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
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 2: ROLE PERMISSIONS MANAGEMENT (Section 5)                            */}
      {/* ========================================================================= */}
      {activeTab === 'role_permissions' && (
        <RolePermissionsManagement currentUserRole={currentUserRole} users={users} />
      )}

      {/* ========================================================================= */}
      {/* TAB 3: MODULE PERMISSION MATRIX (Section 4)                               */}
      {/* ========================================================================= */}
      {activeTab === 'matrix' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden flex flex-col gap-4 p-5">
          {/* Matrix Header & Mode Switcher */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-200">
            <div>
              <h3 className="text-sm font-extrabold text-slate-900 uppercase tracking-tight flex items-center gap-2">
                <Sliders className="w-4 h-4 text-blue-600" />
                Dynamic Module Permission Matrix
              </h3>
              <p className="text-xs text-slate-500">
                Granular View, Add, Edit and Delete controls across all 11 plant modules with role inheritance and individual overrides
              </p>
            </div>

            <div className="flex items-center gap-2 bg-slate-100 p-1 rounded-xl">
              <button
                type="button"
                onClick={() => setMatrixViewMode('roles')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
                  matrixViewMode === 'roles' ? 'bg-white text-blue-700 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Role-Level Defaults
              </button>
              <button
                type="button"
                onClick={() => setMatrixViewMode('user')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
                  matrixViewMode === 'user' ? 'bg-white text-blue-700 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Account-Level Overrides
              </button>
            </div>
          </div>

          {/* Account Selector when in 'user' mode */}
          {matrixViewMode === 'user' && (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-xl bg-blue-50/60 border border-blue-200">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-slate-700">Select Account to Configure:</span>
                <select
                  value={selectedMatrixUserId}
                  onChange={e => setSelectedMatrixUserId(e.target.value)}
                  className="text-xs px-3 py-1.5 rounded-lg border border-slate-300 bg-white font-mono font-bold text-blue-700"
                >
                  {users.map(u => (
                    <option key={u.id} value={u.id}>
                      {u.loginId} ({u.name} - {u.role.toUpperCase()})
                    </option>
                  ))}
                </select>
              </div>

              {isSuperAdmin && (
                <button
                  type="button"
                  onClick={handleSaveUserMatrix}
                  disabled={isSavingUserMatrix}
                  className="px-4 py-1.5 rounded-xl bg-blue-600 text-white font-bold text-xs flex items-center gap-2 hover:bg-blue-700 transition shadow-xs cursor-pointer disabled:opacity-50"
                >
                  {isSavingUserMatrix ? (
                    <>
                      <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      <span>Saving...</span>
                    </>
                  ) : (
                    <>
                      <Save className="w-3.5 h-3.5" />
                      <span>Save Account Overrides</span>
                    </>
                  )}
                </button>
              )}
            </div>
          )}

          {/* Dynamic Matrix Table */}
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-700 uppercase font-bold border-b border-slate-200">
                <tr>
                  <th className="py-3 px-4 w-1/3">Module Name</th>
                  {matrixViewMode === 'roles' ? (
                    <>
                      <th className="py-3 px-4 text-center">SUPER ADMIN</th>
                      <th className="py-3 px-4 text-center">ADMIN</th>
                      <th className="py-3 px-4 text-center">USER</th>
                    </>
                  ) : (
                    <>
                      <th className="py-3 px-4 text-center">VIEW</th>
                      <th className="py-3 px-4 text-center">ADD</th>
                      <th className="py-3 px-4 text-center">EDIT</th>
                      <th className="py-3 px-4 text-center">DELETE</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {PERMISSION_MODULES.map(mod => {
                  if (matrixViewMode === 'roles') {
                    const superPerm = DEFAULT_SUPER_ADMIN_PERMISSIONS[mod.key] || { view: true, add: true, edit: true, delete: true };
                    const adminPerm = rolePermissionsMap['admin']?.modulePermissions[mod.key] || DEFAULT_ADMIN_PERMISSIONS[mod.key] || { view: false, add: false, edit: false, delete: false };
                    const userPerm = rolePermissionsMap['user']?.modulePermissions[mod.key] || DEFAULT_USER_PERMISSIONS[mod.key] || { view: false, add: false, edit: false, delete: false };

                    const renderPermPills = (p: ModulePermission) => (
                      <div className="flex items-center justify-center gap-1">
                        <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${p.view ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-400'}`}>V</span>
                        <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${p.add ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-400'}`}>A</span>
                        <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${p.edit ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-400'}`}>E</span>
                        <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${p.delete ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-400'}`}>D</span>
                      </div>
                    );

                    return (
                      <tr key={mod.key} className="hover:bg-slate-50">
                        <td className="py-3 px-4">
                          <span className="font-bold text-slate-800 block">{mod.label}</span>
                          <span className="text-[10px] text-slate-400">{mod.description}</span>
                        </td>
                        <td className="py-3 px-4 text-center">{renderPermPills(superPerm)}</td>
                        <td className="py-3 px-4 text-center">{renderPermPills(adminPerm)}</td>
                        <td className="py-3 px-4 text-center">{renderPermPills(userPerm)}</td>
                      </tr>
                    );
                  } else {
                    const currentPerm = workingUserPerms[mod.key] || { view: false, add: false, edit: false, delete: false };
                    const targetUser = users.find(u => u.id === selectedMatrixUserId);
                    const isTargetSuper = targetUser?.role?.toLowerCase() === 'super_admin';

                    const renderActionCheckbox = (action: ModuleAction) => {
                      const checked = isTargetSuper ? true : !!currentPerm[action];
                      return (
                        <button
                          type="button"
                          disabled={!isSuperAdmin || isTargetSuper}
                          onClick={() => toggleMatrixUserAction(mod.key, action)}
                          className={`p-1.5 rounded-lg border transition ${
                            checked ? 'bg-blue-600 text-white border-blue-600' : 'bg-white border-slate-300 text-slate-400 hover:border-slate-400'
                          } ${isTargetSuper ? 'opacity-70 cursor-not-allowed' : 'cursor-pointer'}`}
                        >
                          {checked ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                        </button>
                      );
                    };

                    return (
                      <tr key={mod.key} className="hover:bg-slate-50">
                        <td className="py-3 px-4">
                          <span className="font-bold text-slate-800 block">{mod.label}</span>
                          <span className="text-[10px] text-slate-400">{mod.description}</span>
                        </td>
                        <td className="py-3 px-4 text-center">{renderActionCheckbox('view')}</td>
                        <td className="py-3 px-4 text-center">{renderActionCheckbox('add')}</td>
                        <td className="py-3 px-4 text-center">{renderActionCheckbox('edit')}</td>
                        <td className="py-3 px-4 text-center">{renderActionCheckbox('delete')}</td>
                      </tr>
                    );
                  }
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 4: ROLE DESCRIPTIONS (Section 3 - Stored and Retrieved from Firestore) */}
      {/* ========================================================================= */}
      {activeTab === 'roles' && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {rolesList.map(r => {
            const count = users.filter(u => u.role?.toLowerCase() === r.roleId).length;
            const isSuper = r.roleId === 'super_admin';
            const isAdmin = r.roleId === 'admin';

            return (
              <div 
                key={r.roleId} 
                className={`bg-white rounded-2xl border p-6 shadow-xs flex flex-col justify-between transition-all ${
                  isSuper ? 'border-red-200 hover:border-red-300' :
                  isAdmin ? 'border-blue-200 hover:border-blue-300' :
                  'border-slate-200 hover:border-slate-300'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                    <div>
                      <h3 className="font-black text-slate-900 text-base tracking-wide">
                        {r.roleName}
                      </h3>
                      <span className="text-[10px] text-slate-400 font-mono">
                        roles/{r.roleId}
                      </span>
                    </div>

                    <div className="flex flex-col items-end gap-1">
                      <span className={`text-[10px] px-2.5 py-0.5 rounded-full font-bold uppercase tracking-wider ${
                        isSuper ? 'bg-red-100 text-red-800' :
                        isAdmin ? 'bg-blue-100 text-blue-800' :
                        'bg-slate-100 text-slate-700'
                      }`}>
                        {r.isActive ? 'Active' : 'Inactive'}
                      </span>
                      <span className="text-[11px] font-bold text-slate-600 bg-slate-100 px-2 py-0.5 rounded-md">
                        {count} {count === 1 ? 'Account' : 'Accounts'}
                      </span>
                    </div>
                  </div>

                  {/* Role Description from Firestore */}
                  <p className="text-xs text-slate-600 mt-4 leading-relaxed font-normal">
                    {r.description}
                  </p>
                </div>

                <div className="mt-6 pt-4 border-t border-slate-100">
                  <div className="text-[11px] font-bold text-slate-700 mb-1.5">
                    Default Capabilities:
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {isSuper && (
                      <span className="text-[10px] font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200 px-2 py-0.5 rounded">
                        Full Unrestricted Access
                      </span>
                    )}
                    {isAdmin && (
                      <>
                        <span className="text-[10px] font-semibold bg-blue-50 text-blue-800 border border-blue-200 px-2 py-0.5 rounded">Dashboard</span>
                        <span className="text-[10px] font-semibold bg-blue-50 text-blue-800 border border-blue-200 px-2 py-0.5 rounded">Scanner</span>
                        <span className="text-[10px] font-semibold bg-blue-50 text-blue-800 border border-blue-200 px-2 py-0.5 rounded">Employee Master</span>
                        <span className="text-[10px] font-semibold bg-blue-50 text-blue-800 border border-blue-200 px-2 py-0.5 rounded">Reports</span>
                      </>
                    )}
                    {!isSuper && !isAdmin && (
                      <span className="text-[10px] font-semibold bg-slate-50 text-slate-800 border border-slate-200 px-2 py-0.5 rounded">
                        Attendance Scanner Only
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 5: SUPER ADMIN PASSWORD GOVERNANCE & RESET PANEL                      */}
      {/* ========================================================================= */}
      {activeTab === 'passwords' && isSuperAdmin && (
        <div className="space-y-6">
          {/* Header Card */}
          <div className="bg-gradient-to-r from-[#00183b] via-[#002b66] to-[#00183b] text-white p-6 rounded-2xl shadow-md border border-blue-900/50 flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-amber-500 to-yellow-300 flex items-center justify-center text-slate-950 font-bold shadow-lg shadow-amber-500/20 shrink-0">
                <KeyRound className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-base font-extrabold tracking-tight text-white flex items-center gap-2">
                  <span>Super Admin Password Governance & Reset Control</span>
                  <span className="text-[10px] font-mono uppercase bg-amber-400 text-slate-950 px-2 py-0.5 rounded-full font-bold">
                    Super Admin Exclusive
                  </span>
                </h3>
                <p className="text-xs text-blue-200/90 mt-0.5 max-w-2xl leading-relaxed">
                  Reset account credentials, issue temporary passwords, enforce first-time password changes, clear rate-limiting lockouts, and inspect audit logs.
                </p>
              </div>
            </div>

            <button
              onClick={loadPasswordHistory}
              disabled={isLoadingHistory}
              className="px-3.5 py-2 rounded-xl bg-white/10 hover:bg-white/20 border border-white/20 text-white text-xs font-bold flex items-center gap-2 transition cursor-pointer self-start md:self-auto shrink-0"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoadingHistory ? 'animate-spin' : ''}`} />
              <span>Refresh History</span>
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Left Column: Password Reset Form (5 cols) */}
            <div className="lg:col-span-5 bg-white rounded-2xl border border-slate-200 shadow-xs p-5">
              <div className="flex items-center gap-2.5 pb-4 border-b border-slate-100">
                <div className="w-8 h-8 rounded-lg bg-amber-100 text-amber-800 flex items-center justify-center font-bold">
                  <Key className="w-4 h-4" />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider">
                    Reset Account Password
                  </h4>
                  <p className="text-[11px] text-slate-500">
                    Target account credentials will be updated in Firebase and Firestore
                  </p>
                </div>
              </div>

              <form onSubmit={handlePanelResetSubmit} className="mt-5 space-y-4">
                {/* Account Selector */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5 uppercase tracking-wider">
                    Select Target Account *
                  </label>
                  <select
                    value={selectedResetUser?.id || ''}
                    onChange={(e) => {
                      const user = users.find(u => u.id === e.target.value) || null;
                      setSelectedResetUser(user);
                    }}
                    required
                    className="w-full text-xs px-3.5 py-2.5 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-amber-500 font-semibold bg-slate-50/50"
                  >
                    <option value="" disabled>-- Select an authorized account --</option>
                    {users.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.loginId} - {u.name} ({u.role?.toUpperCase()})
                      </option>
                    ))}
                  </select>
                </div>

                {/* Target Account Info Badge */}
                {selectedResetUser && (
                  <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 space-y-1.5 text-xs font-mono">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">Login ID:</span>
                      <span className="font-bold text-slate-900">{selectedResetUser.loginId}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">System Role:</span>
                      <span className="font-bold text-blue-700 uppercase">{selectedResetUser.role}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">Account Status:</span>
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        selectedResetUser.status === 'Active' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'
                      }`}>
                        {selectedResetUser.status || 'Active'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">Password Change Pending:</span>
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        selectedResetUser.mustChangePassword ? 'bg-amber-100 text-amber-800' : 'bg-slate-200 text-slate-700'
                      }`}>
                        {selectedResetUser.mustChangePassword ? 'YES (Forced on Login)' : 'NO (Normal Access)'}
                      </span>
                    </div>
                  </div>
                )}

                {/* New Temporary Password Input */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider">
                      New Temporary Password *
                    </label>
                    <button
                      type="button"
                      onClick={generateRandomPassword}
                      className="text-[11px] font-bold text-blue-600 hover:text-blue-800 flex items-center gap-1 cursor-pointer"
                    >
                      <Sparkles className="w-3 h-3" />
                      <span>Auto-Generate</span>
                    </button>
                  </div>
                  <div className="relative">
                    <input
                      type={showPanelNewPassword ? 'text' : 'password'}
                      required
                      minLength={6}
                      placeholder="e.g. Narid@2026"
                      value={panelNewPassword}
                      onChange={e => setPanelNewPassword(e.target.value)}
                      className="w-full text-xs px-3.5 py-2.5 pr-10 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-amber-500 font-mono font-bold text-slate-900"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPanelNewPassword(!showPanelNewPassword)}
                      className="absolute right-3 top-2.5 text-slate-400 hover:text-slate-600 cursor-pointer"
                    >
                      {showPanelNewPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <span className="text-[10px] text-slate-400 mt-1 block">
                    Minimum 6 characters. Passwords are cryptographically hashed on the server.
                  </span>
                </div>

                {/* Governance Checkboxes */}
                <div className="space-y-2.5 pt-2 border-t border-slate-100">
                  <label className="flex items-start gap-2.5 cursor-pointer text-xs font-medium text-slate-700">
                    <input
                      type="checkbox"
                      checked={panelForceChange}
                      onChange={e => setPanelForceChange(e.target.checked)}
                      className="mt-0.5 rounded border-slate-300 text-amber-600 focus:ring-amber-500 w-4 h-4 shrink-0"
                    />
                    <div>
                      <span className="font-bold text-slate-800">Force Password Change on Next Login</span>
                      <p className="text-[11px] text-slate-500">
                        Shows First-Time Login Security screen and requires confidential password update before allowing system access.
                      </p>
                    </div>
                  </label>

                  <label className="flex items-start gap-2.5 cursor-pointer text-xs font-medium text-slate-700">
                    <input
                      type="checkbox"
                      checked={panelUnlockAccount}
                      onChange={e => setPanelUnlockAccount(e.target.checked)}
                      className="mt-0.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500 w-4 h-4 shrink-0"
                    />
                    <div>
                      <span className="font-bold text-slate-800">Clear Rate-Limiting Lockout</span>
                      <p className="text-[11px] text-slate-500">
                        Immediately unlocks account if blocked by repeated failed login attempts.
                      </p>
                    </div>
                  </label>

                  <label className="flex items-start gap-2.5 cursor-pointer text-xs font-medium text-slate-700">
                    <input
                      type="checkbox"
                      checked={panelRevokeSessions}
                      onChange={e => setPanelRevokeSessions(e.target.checked)}
                      className="mt-0.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-4 h-4 shrink-0"
                    />
                    <div>
                      <span className="font-bold text-slate-800">Revoke Existing Sessions</span>
                      <p className="text-[11px] text-slate-500">
                        Terminates any currently open active sessions on other workstations.
                      </p>
                    </div>
                  </label>
                </div>

                {/* Submit Button */}
                <div className="pt-3 border-t border-slate-100">
                  <button
                    type="submit"
                    disabled={isSubmittingPanelReset || !selectedResetUser}
                    className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-amber-600 to-amber-700 hover:from-amber-700 hover:to-amber-800 text-white font-bold text-xs uppercase tracking-wider shadow-md shadow-amber-600/20 flex items-center justify-center gap-2 transition active:scale-[0.99] disabled:opacity-50 cursor-pointer"
                  >
                    {isSubmittingPanelReset ? (
                      <>
                        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        <span>Updating Firebase Credentials...</span>
                      </>
                    ) : (
                      <>
                        <Key className="w-4 h-4" />
                        <span>RESET PASSWORD NOW</span>
                      </>
                    )}
                  </button>
                </div>
              </form>
            </div>

            {/* Right Column: Password Reset History Audit Trail (7 cols) */}
            <div className="lg:col-span-7 bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden flex flex-col">
              <div className="p-4 border-b border-slate-200 bg-slate-50/80 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <History className="w-4 h-4 text-slate-700" />
                  <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                    Password Reset Audit Log (Immutable)
                  </h4>
                </div>
                <span className="text-[10px] font-mono text-slate-500">
                  {passwordHistoryList.length} Total Resets
                </span>
              </div>

              <div className="flex-1 overflow-x-auto max-h-[560px]">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="bg-slate-100/75 border-b border-slate-200 text-slate-600 font-bold uppercase text-[10px] tracking-wider">
                      <th className="py-2.5 px-3">Target Account</th>
                      <th className="py-2.5 px-3">Role</th>
                      <th className="py-2.5 px-3">Reset By</th>
                      <th className="py-2.5 px-3">Force Change</th>
                      <th className="py-2.5 px-3">Date & Time</th>
                      <th className="py-2.5 px-3 text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-medium">
                    {isLoadingHistory ? (
                      <tr>
                        <td colSpan={6} className="py-8 text-center text-slate-400">
                          <div className="flex items-center justify-center gap-2">
                            <div className="w-4 h-4 border-2 border-amber-600 border-t-transparent rounded-full animate-spin" />
                            <span>Loading audit logs...</span>
                          </div>
                        </td>
                      </tr>
                    ) : passwordHistoryList.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-10 text-center text-slate-400">
                          <History className="w-8 h-8 mx-auto mb-2 opacity-30" />
                          <p className="font-semibold text-slate-600">No password reset records yet</p>
                          <p className="text-[11px] text-slate-400 mt-0.5">
                            Any administrative password resets will be permanently recorded here.
                          </p>
                        </td>
                      </tr>
                    ) : (
                      passwordHistoryList.map((log: any, idx: number) => {
                        const dateFormatted = log.timestamp 
                          ? new Date(log.timestamp).toLocaleString()
                          : 'Recorded';
                        return (
                          <tr key={log.id || idx} className="hover:bg-slate-50 transition">
                            <td className="py-2.5 px-3">
                              <span className="font-bold text-slate-900 font-mono">
                                {safeStr(log.targetLoginId || log.loginId)}
                              </span>
                              {log.targetName && (
                                <span className="block text-[10px] text-slate-500 font-sans">
                                  {safeStr(log.targetName)}
                                </span>
                              )}
                            </td>
                            <td className="py-2.5 px-3">
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-slate-100 text-slate-700">
                                {safeStr(log.targetRole, 'user')}
                              </span>
                            </td>
                            <td className="py-2.5 px-3 font-mono text-[11px] text-blue-700 font-semibold">
                              {safeStr(log.performedByLoginId, 'superadmin')}
                            </td>
                            <td className="py-2.5 px-3">
                              {log.forcedPasswordChange ? (
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800">
                                  Required
                                </span>
                              ) : (
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-600">
                                  Optional
                                </span>
                              )}
                            </td>
                            <td className="py-2.5 px-3 text-[11px] text-slate-500 font-mono whitespace-nowrap">
                              {dateFormatted}
                            </td>
                            <td className="py-2.5 px-3 text-right">
                              <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700">
                                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                                <span>Verified</span>
                              </span>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              <div className="p-3 bg-slate-50 border-t border-slate-200 text-[11px] text-slate-500 flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
                <span>
                  Passwords are cryptographically secured using memory-hard scrypt. Plain-text credentials are never logged or stored.
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* MODAL 1: CREATE NEW LOGIN ID (SUPER ADMIN ONLY)           */}
      {/* ========================================================= */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-2xl max-h-[92vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            {/* Modal Header */}
            <div className="p-5 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-blue-600 text-white flex items-center justify-center font-bold">
                  <UserPlus className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="font-bold text-slate-900 text-base">Create New Login ID</h3>
                  <p className="text-xs text-slate-500">
                    Provisions account directly in Firebase Authentication and Firestore
                  </p>
                </div>
              </div>
              <button
                onClick={() => setIsCreateModalOpen(false)}
                className="p-1 rounded-lg hover:bg-slate-200 text-slate-500 transition cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Form Body */}
            <form onSubmit={handleCreateUserSubmit} className="flex-1 overflow-y-auto p-6 space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Full Name */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Full Name / Designation *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Rajesh Kumar (Line 2 Lead)"
                    value={createFormData.name}
                    onChange={e => setCreateFormData({ ...createFormData, name: e.target.value })}
                    className="w-full text-xs px-3 py-2 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 font-medium"
                  />
                </div>

                {/* Login ID */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Login ID (Unique) *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. rajesh_line2"
                    value={createFormData.loginId}
                    onChange={e => setCreateFormData({ ...createFormData, loginId: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '') })}
                    className="w-full text-xs px-3 py-2 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono font-bold text-blue-700"
                  />
                  <span className="text-[10px] text-slate-400">Lowercase letters, numbers, underscores only</span>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Role */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    System Role *
                  </label>
                  <select
                    value={createFormData.role}
                    onChange={e => {
                      const newRole = e.target.value as UserRoleType;
                      setCreateFormData({
                        ...createFormData,
                        role: newRole,
                        modulesAllowed: newRole === 'super_admin' ? ['all'] :
                                       newRole === 'admin' ? ['dashboard', 'scanner', 'employees', 'history', 'reports', 'qr_codes'] :
                                       ['scanner']
                      });
                    }}
                    className="w-full text-xs px-3 py-2 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 font-semibold"
                  >
                    <option value="user">USER (Gate Operator / Scanner)</option>
                    <option value="admin">ADMIN (Line Supervisor)</option>
                    <option value="super_admin">SUPER ADMIN (Full Access)</option>
                  </select>
                </div>

                {/* Email */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Official Email (Optional)
                  </label>
                  <input
                    type="email"
                    placeholder="e.g. rajesh@narid.com"
                    value={createFormData.email}
                    onChange={e => setCreateFormData({ ...createFormData, email: e.target.value })}
                    className="w-full text-xs px-3 py-2 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 font-medium"
                  />
                </div>
              </div>

              {/* Password */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Initial Password *
                </label>
                <div className="relative">
                  <input
                    type={showCreatePassword ? 'text' : 'password'}
                    required
                    minLength={6}
                    value={createFormData.password}
                    onChange={e => setCreateFormData({ ...createFormData, password: e.target.value })}
                    className="w-full text-xs px-3 py-2 pr-10 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono font-medium"
                  />
                  <button
                    type="button"
                    onClick={() => setShowCreatePassword(!showCreatePassword)}
                    className="absolute right-3 top-2.5 text-slate-400 hover:text-slate-600 cursor-pointer"
                  >
                    {showCreatePassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <span className="text-[10px] text-slate-400">Default is "Narid@12345" (minimum 6 characters)</span>
              </div>

              <div className="flex items-center gap-6 pt-1">
                <label className="flex items-center gap-2 cursor-pointer text-xs font-medium text-slate-700">
                  <input
                    type="checkbox"
                    checked={createFormData.mustChangePassword}
                    onChange={e => setCreateFormData({ ...createFormData, mustChangePassword: e.target.checked })}
                    className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 w-4 h-4"
                  />
                  <span>Require password change on first sign in</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer text-xs font-medium text-slate-700">
                  <input
                    type="checkbox"
                    checked={createFormData.status === 'Active'}
                    onChange={e => setCreateFormData({ ...createFormData, status: e.target.checked ? 'Active' : 'Inactive' })}
                    className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 w-4 h-4"
                  />
                  <span>Active (Account enabled immediately)</span>
                </label>
              </div>

              {/* Action Buttons */}
              <div className="pt-4 border-t border-slate-100 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="px-4 py-2 rounded-xl border border-slate-200 text-slate-700 hover:bg-slate-100 text-xs font-semibold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingCreate}
                  className="px-5 py-2 rounded-xl bg-blue-600 text-white font-bold text-xs flex items-center gap-2 hover:bg-blue-700 shadow-md disabled:opacity-50 cursor-pointer"
                >
                  {isSubmittingCreate ? (
                    <>
                      <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      <span>Provisioning Firebase...</span>
                    </>
                  ) : (
                    <>
                      <Check className="w-4 h-4" />
                      <span>Create Account</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* MODAL 2: CHANGE / RESET PASSWORD                          */}
      {/* ========================================================= */}
      {isPasswordModalOpen && selectedUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="p-5 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-blue-600 text-white flex items-center justify-center font-bold">
                  <Key className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="font-bold text-slate-900 text-base">Change User Password</h3>
                  <p className="text-xs text-slate-500 font-mono">
                    User: <strong className="text-blue-700">{selectedUser.loginId}</strong>
                  </p>
                </div>
              </div>
              <button
                onClick={() => setIsPasswordModalOpen(false)}
                className="p-1 rounded-lg hover:bg-slate-200 text-slate-500 transition cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handlePasswordSubmit} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  New Password *
                </label>
                <div className="relative">
                  <input
                    type={showNewPassword ? 'text' : 'password'}
                    required
                    minLength={6}
                    placeholder="Enter at least 6 characters"
                    value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                    className="w-full text-xs px-3 py-2 pr-10 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono font-medium"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewPassword(!showNewPassword)}
                    className="absolute right-3 top-2.5 text-slate-400 hover:text-slate-600 cursor-pointer"
                  >
                    {showNewPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <label className="flex items-center gap-2 cursor-pointer text-xs font-medium text-slate-700">
                <input
                  type="checkbox"
                  checked={requirePasswordChange}
                  onChange={e => setRequirePasswordChange(e.target.checked)}
                  className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 w-4 h-4"
                />
                <span>Prompt user to change password on their next sign in</span>
              </label>

              <div className="pt-3 border-t border-slate-100 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setIsPasswordModalOpen(false)}
                  className="px-4 py-2 rounded-xl border border-slate-200 text-slate-700 hover:bg-slate-100 text-xs font-semibold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingPassword}
                  className="px-5 py-2 rounded-xl bg-blue-600 text-white font-bold text-xs flex items-center gap-2 hover:bg-blue-700 shadow-md disabled:opacity-50 cursor-pointer"
                >
                  {isSubmittingPassword ? (
                    <>
                      <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      <span>Updating Firebase...</span>
                    </>
                  ) : (
                    <>
                      <Check className="w-4 h-4" />
                      <span>Update Password</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* MODAL 3: CONFIGURE MODULE ACCESS                          */}
      {/* ========================================================= */}
      {isPermissionsModalOpen && selectedUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-xl max-h-[92vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="p-5 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-indigo-600 text-white flex items-center justify-center font-bold">
                  <Sliders className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="font-bold text-slate-900 text-base">Configure User Access</h3>
                  <p className="text-xs text-slate-500 font-mono">
                    User: <strong className="text-blue-700">{selectedUser.loginId}</strong> ({selectedUser.name})
                  </p>
                </div>
              </div>
              <button
                onClick={() => setIsPermissionsModalOpen(false)}
                className="p-1 rounded-lg hover:bg-slate-200 text-slate-500 transition cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handlePermissionsSubmit} className="flex-1 overflow-y-auto p-6 space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Role */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    System Role
                  </label>
                  <select
                    value={editRole}
                    onChange={e => {
                      const newRole = e.target.value as UserRoleType;
                      setEditRole(newRole);
                      if (newRole === 'super_admin') {
                        setEditModulesAllowed(PERMISSION_MODULES.map(m => m.key));
                      }
                    }}
                    className="w-full text-xs px-3 py-2 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 font-semibold"
                  >
                    <option value="user">USER (Operator)</option>
                    <option value="admin">ADMIN (Supervisor)</option>
                    <option value="super_admin">SUPER ADMIN (Full Access)</option>
                  </select>
                </div>

                {/* Status */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Account Status
                  </label>
                  <select
                    value={editStatus}
                    onChange={e => setEditStatus(e.target.value as any)}
                    className="w-full text-xs px-3 py-2 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 font-semibold"
                  >
                    <option value="Active">Active (Permitted)</option>
                    <option value="Inactive">Inactive (Suspended)</option>
                  </select>
                </div>
              </div>

              {/* Module Checkbox Grid */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-2">
                  Allowed Modules ({editModulesAllowed.length} Selected)
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-56 overflow-y-auto p-1 bg-slate-50 rounded-xl border border-slate-200">
                  {PERMISSION_MODULES.map(m => {
                    const isChecked = editRole === 'super_admin' || editModulesAllowed.includes(m.key);
                    return (
                      <label
                        key={m.key}
                        className={`flex items-start gap-2.5 p-2 rounded-lg border cursor-pointer transition ${
                          isChecked ? 'bg-blue-50/70 border-blue-200 text-blue-900 font-semibold' : 'bg-white border-slate-200 text-slate-700'
                        }`}
                      >
                        <input
                          type="checkbox"
                          disabled={editRole === 'super_admin'}
                          checked={isChecked}
                          onChange={() => toggleModule(m.key, editModulesAllowed, setEditModulesAllowed)}
                          className="mt-0.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500 w-4 h-4"
                        />
                        <div className="text-[11px] leading-tight">
                          <div>{modLabelShort(m.label)}</div>
                          <div className="text-[9px] text-slate-400 font-normal">{m.description}</div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="pt-3 border-t border-slate-100 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setIsPermissionsModalOpen(false)}
                  className="px-4 py-2 rounded-xl border border-slate-200 text-slate-700 hover:bg-slate-100 text-xs font-semibold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingPermissions}
                  className="px-5 py-2 rounded-xl bg-indigo-600 text-white font-bold text-xs flex items-center gap-2 hover:bg-indigo-700 shadow-md disabled:opacity-50 cursor-pointer"
                >
                  {isSubmittingPermissions ? (
                    <>
                      <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      <span>Saving to Firebase...</span>
                    </>
                  ) : (
                    <>
                      <Check className="w-4 h-4" />
                      <span>Update Permissions</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* MODAL 4: CONFIRM ACCOUNT DELETION (Section 1)             */}
      {/* ========================================================= */}
      {userToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
          <div className="bg-white rounded-2xl border border-red-200 shadow-2xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="p-5 border-b border-red-100 bg-red-50 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-red-600 text-white flex items-center justify-center font-bold shadow-md shadow-red-600/30">
                  <ShieldAlert className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-extrabold text-red-950 text-base">Confirm Account Deletion</h3>
                  <p className="text-xs text-red-700">
                    Administrator authorization required
                  </p>
                </div>
              </div>
              <button
                onClick={() => setUserToDelete(null)}
                className="p-1 rounded-lg hover:bg-red-200 text-red-600 transition cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-4">
              <div className="p-3.5 bg-slate-50 rounded-xl border border-slate-200 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-500 font-medium">Login ID:</span>
                  <span className="font-mono font-bold text-red-600 text-sm">{userToDelete.loginId}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-500 font-medium">Full Name / Username:</span>
                  <span className="font-semibold text-slate-800">{userToDelete.name}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-500 font-medium">Assigned Role:</span>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-slate-200 text-slate-800">
                    {userToDelete.role}
                  </span>
                </div>
              </div>

              <div className="p-3 bg-amber-50 rounded-xl border border-amber-200 text-amber-900 text-xs leading-relaxed flex items-start gap-2.5">
                <Info className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <strong>Important Security Guarantee:</strong> This action will delete the login account document and clean up individual permission overrides. Shared role definitions, attendance logs, and employee punch histories are strictly preserved.
                </div>
              </div>

              <div className="pt-3 border-t border-slate-100 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setUserToDelete(null)}
                  disabled={isDeletingUser}
                  className="px-4 py-2 rounded-xl border border-slate-200 text-slate-700 hover:bg-slate-100 text-xs font-semibold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleConfirmDeleteUser}
                  disabled={isDeletingUser}
                  className="px-5 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white font-bold text-xs flex items-center gap-2 shadow-md shadow-red-600/30 cursor-pointer disabled:opacity-50"
                >
                  {isDeletingUser ? (
                    <>
                      <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      <span>Deleting Account...</span>
                    </>
                  ) : (
                    <>
                      <Trash2 className="w-4 h-4" />
                      <span>Permanently Delete Account</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// Helper for cleaner module title
function modLabelShort(label: string): string {
  return label.replace(/^[0-9•\.\s]+/, '');
}
