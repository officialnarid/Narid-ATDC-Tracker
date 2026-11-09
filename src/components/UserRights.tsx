import React, { useState, useEffect } from 'react';
import { 
  ShieldCheck, 
  UserCheck, 
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
  Sparkles,
  Info,
  ShieldAlert,
  Save,
  Check,
  Building,
  User
} from 'lucide-react';
import { RolePermissionsManagement } from './RolePermissionsManagement';
import { onSnapshot, collection } from 'firebase/firestore';
import { db } from '../firebase';
import { UserRoleRecord, UserRoleType } from '../types';
import { 
  getAllUserRoles, 
  createUserAccount, 
  adminSetUserPassword, 
  updateUserRolePermissions, 
  deleteUserRole,
  sendUserPasswordReset,
  INITIAL_DEFAULT_PASSWORD
} from '../services/authService';

interface UserRightsProps {
  currentUserRole?: UserRoleRecord | null;
  onRoleProfileUpdated?: (updatedProfile: UserRoleRecord) => void;
}

const SYSTEM_MODULES = [
  { key: 'dashboard', label: '1. Dashboard & Analytics', desc: 'Real-time headcounts, attendance %, live line status' },
  { key: 'scanner', label: '2. Attendance Scanner', desc: 'Continuous camera QR scan for Punch In / Out' },
  { key: 'employees', label: '3. Employee Master', desc: 'Personnel registration, biometric ID, line assignment' },
  { key: 'excel_import', label: '4. Excel Import / Update', desc: 'Bulk import and update employee database via spreadsheet' },
  { key: 'qr_codes', label: '5. QR Code Management', desc: 'Batch PDF card print, single QR generation' },
  { key: 'floors', label: '6. Production Line Master', desc: 'Line creation, supervisors, capacity configuration' },
  { key: 'sections', label: '7. Section Master', desc: 'Plant floor sub-sections and operational zones' },
  { key: 'departments', label: '8. Department Master', desc: 'Department taxonomy, code assignment, leads' },
  { key: 'shifts', label: '9. Shift Management', desc: 'Shift timings, grace periods, auto-punch window' },
  { key: 'history', label: '10. Attendance History', desc: 'Search logs, audit trails, manual punch adjustments' },
  { key: 'reports', label: '11. Reports & Data Export', desc: 'Daily muster, overtime, absenteeism, Excel exports' },
  { key: 'user_rights', label: '12. User Rights & Authorization', desc: 'Manage login accounts, passwords, module access' },
  { key: 'settings', label: '13. System Settings', desc: 'Camera parameters, company branding, sync interval' },
];

export const UserRights: React.FC<UserRightsProps> = ({ currentUserRole, onRoleProfileUpdated }) => {
  const [users, setUsers] = useState<UserRoleRecord[]>([]);
  const [isLoadingUsers, setIsLoadingUsers] = useState(false);
  const [activeTab, setActiveTab] = useState<'users' | 'role_permissions' | 'matrix' | 'roles'>('users');
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Modal States
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isPasswordModalOpen, setIsPasswordModalOpen] = useState(false);
  const [isPermissionsModalOpen, setIsPermissionsModalOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<UserRoleRecord | null>(null);

  // Form States - Create User
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

  // Form States - Edit Permissions
  const [editModulesAllowed, setEditModulesAllowed] = useState<string[]>([]);
  const [editRole, setEditRole] = useState<UserRoleType>('user');
  const [editStatus, setEditStatus] = useState<'Active' | 'Inactive'>('Active');
  const [isSubmittingPermissions, setIsSubmittingPermissions] = useState(false);

  const isSuperAdmin = currentUserRole?.role?.toUpperCase() === 'SUPER_ADMIN' || currentUserRole?.loginId === 'superadmin';

  // Real-time synchronization with Firestore collection 'user_roles'
  useEffect(() => {
    setIsLoadingUsers(true);
    const unsubscribe = onSnapshot(
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

        // Update current session profile if matched
        if (currentUserRole) {
          const currentInDb = fetched.find(u => u.id === currentUserRole.id || u.loginId === currentUserRole.loginId);
          if (currentInDb && onRoleProfileUpdated) {
            onRoleProfileUpdated(currentInDb);
          }
        }
      },
      (err) => {
        console.warn('Real-time snapshot error, falling back to manual fetch:', err);
        loadUsersManual();
      }
    );

    return () => unsubscribe();
  }, [currentUserRole?.id]);

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
      modulesAllowed: ['dashboard', 'scanner', 'employees', 'history', 'reports'],
    });
    setShowCreatePassword(false);
    setIsCreateModalOpen(true);
  };

  // 2. SUBMIT CREATE USER
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
        requirePasswordChange
      );
      showToast('success', `Password for "${selectedUser.loginId}" successfully updated in Firebase!`);
      setIsPasswordModalOpen(false);
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
      setEditModulesAllowed(SYSTEM_MODULES.map(m => m.key));
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

  // 7. DELETE USER
  const handleDeleteUser = async (user: UserRoleRecord) => {
    if (user.loginId === 'superadmin' || user.id === 'role_superadmin') {
      showToast('error', 'The primary Super Admin account cannot be deleted.');
      return;
    }

    const confirmed = window.confirm(
      `Are you sure you want to delete Login ID "${user.loginId}" (${user.name})? This will immediately remove their access from Firebase.`
    );
    if (!confirmed) return;

    try {
      await deleteUserRole(user.id);
      showToast('success', `User "${user.loginId}" successfully deleted from Firebase.`);
    } catch (err: any) {
      showToast('error', err.message || 'Failed to delete user.');
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

  // Presets
  const applyPreset = (preset: 'all' | 'supervisor' | 'scanner' | 'clear', setter: (val: string[]) => void) => {
    if (preset === 'all') {
      setter(SYSTEM_MODULES.map(m => m.key));
    } else if (preset === 'supervisor') {
      setter(['dashboard', 'scanner', 'employees', 'excel_import', 'qr_codes', 'floors', 'sections', 'departments', 'shifts', 'history', 'reports']);
    } else if (preset === 'scanner') {
      setter(['scanner']);
    } else if (preset === 'clear') {
      setter([]);
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
                Create Login IDs, reset passwords, grant or revoke individual module permissions with instant Firebase sync
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
            className="p-2 rounded-xl border border-slate-200 hover:bg-slate-100 text-slate-600 transition"
            title="Refresh Users"
          >
            <RefreshCw className={`w-4 h-4 ${isLoadingUsers ? 'animate-spin text-blue-600' : ''}`} />
          </button>

          {isSuperAdmin && (
            <button
              onClick={handleOpenCreateModal}
              className="px-4 py-2 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 text-white font-bold text-xs flex items-center gap-2 shadow-md hover:from-blue-700 hover:to-indigo-700 transition active:scale-95"
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
              You are currently viewing user authorizations in view mode. Only the <strong>Super Admin</strong> has privileges to create new Login IDs, modify passwords, and configure permissions.
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

        {/* NEW SUBMODULE TAB: Role Permissions Management */}
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

        <button
          onClick={() => setActiveTab('matrix')}
          className={`pb-2 px-3 text-xs font-bold transition border-b-2 flex items-center gap-2 shrink-0 cursor-pointer ${
            activeTab === 'matrix' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <Sliders className="w-4 h-4" />
          <span>Module Permission Matrix</span>
        </button>

        <button
          onClick={() => setActiveTab('roles')}
          className={`pb-2 px-3 text-xs font-bold transition border-b-2 flex items-center gap-2 shrink-0 cursor-pointer ${
            activeTab === 'roles' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <Building className="w-4 h-4" />
          <span>Role Descriptions</span>
        </button>
      </div>

      {/* TAB 1: ACTIVE USER DIRECTORY */}
      {activeTab === 'users' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
          <div className="p-4 border-b border-slate-200 bg-slate-50/80 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h3 className="text-xs font-extrabold text-slate-800 uppercase tracking-wider">
                Authorized Personnel Directory
              </h3>
              <p className="text-[11px] text-slate-500">
                Click actions on any row to change password or adjust module permissions
              </p>
            </div>
            <span className="text-xs font-mono bg-blue-50 text-blue-700 px-2.5 py-1 rounded-lg border border-blue-200">
              Total Accounts: {users.length}
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-600 uppercase font-semibold border-b border-slate-200">
                <tr>
                  <th className="py-3 px-4">Login ID</th>
                  <th className="py-3 px-4">Name / Title</th>
                  <th className="py-3 px-4">Role</th>
                  <th className="py-3 px-4">Allowed Modules</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {users.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-slate-400">
                      <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                      <span>Loading accounts from Firebase Firestore...</span>
                    </td>
                  </tr>
                ) : (
                  users.map(u => {
                    const isAll = u.modulesAllowed?.includes('all') || u.role?.toLowerCase() === 'super_admin';
                    const allowedCount = isAll ? 13 : (u.modulesAllowed?.length || 0);

                    return (
                      <tr key={u.id} className="hover:bg-blue-50/40 transition">
                        <td className="py-3 px-4 font-mono font-bold text-blue-700">
                          {u.loginId}
                        </td>
                        <td className="py-3 px-4">
                          <div className="font-semibold text-slate-900">{u.name}</div>
                          <div className="text-[11px] font-mono text-slate-400">{u.email.replace('_auth@', '@')}</div>
                        </td>
                        <td className="py-3 px-4">
                          <span className={`px-2.5 py-1 rounded-lg font-bold text-[10px] tracking-wide uppercase inline-flex items-center gap-1 ${
                            u.role?.toLowerCase() === 'super_admin' ? 'bg-red-100 text-red-800 border border-red-200' :
                            u.role?.toLowerCase() === 'admin' ? 'bg-blue-100 text-blue-800 border border-blue-200' :
                            'bg-slate-100 text-slate-800 border border-slate-200'
                          }`}>
                            {u.role}
                          </span>
                        </td>
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className={`px-2 py-0.5 rounded-full font-bold text-[10px] ${
                              isAll 
                                ? 'bg-purple-100 text-purple-800' 
                                : 'bg-slate-100 text-slate-700'
                            }`}>
                              {isAll ? 'All 13 Modules' : `${allowedCount} Modules`}
                            </span>
                            {!isAll && allowedCount > 0 && (
                              <span className="text-[10px] text-slate-400 font-mono">
                                ({u.modulesAllowed?.slice(0, 3).join(', ')}{allowedCount > 3 ? '...' : ''})
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className={`px-2 py-0.5 rounded-full font-bold text-[10px] ${
                              u.status === 'Active' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'
                            }`}>
                              {u.status}
                            </span>
                            {u.mustChangePassword && (
                              <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-semibold text-[9px]">
                                Password Change Required
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
                                  className="p-1.5 rounded-lg border border-slate-200 hover:border-blue-400 hover:bg-blue-50 text-slate-700 hover:text-blue-700 transition"
                                  title={`Change password for ${u.loginId}`}
                                >
                                  <Key className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={() => handleOpenPermissionsModal(u)}
                                  className="p-1.5 rounded-lg border border-slate-200 hover:border-indigo-400 hover:bg-indigo-50 text-slate-700 hover:text-indigo-700 transition"
                                  title={`Configure permissions for ${u.loginId}`}
                                >
                                  <Sliders className="w-3.5 h-3.5" />
                                </button>
                                {u.loginId !== 'superadmin' && u.id !== 'role_superadmin' && (
                                  <button
                                    onClick={() => handleDeleteUser(u)}
                                    className="p-1.5 rounded-lg border border-slate-200 hover:border-red-400 hover:bg-red-50 text-slate-700 hover:text-red-700 transition"
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

      {/* TAB 2: PERMISSION MATRIX */}
      {activeTab === 'matrix' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
          <div className="p-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
            <h3 className="text-xs font-extrabold text-slate-800 uppercase tracking-wider">
              System Module Matrix & Default Role Allocations
            </h3>
            <span className="text-[11px] text-slate-500">Super Admin can customize permissions per user</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-600 uppercase font-semibold border-b border-slate-200">
                <tr>
                  <th className="py-3 px-4">System Module</th>
                  <th className="py-3 px-4">Scope & Function</th>
                  <th className="py-3 px-4 text-center">SUPER ADMIN</th>
                  <th className="py-3 px-4 text-center">ADMIN (Supervisor)</th>
                  <th className="py-3 px-4 text-center">USER (Operator)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {SYSTEM_MODULES.map(mod => (
                  <tr key={mod.key} className="hover:bg-slate-50">
                    <td className="py-3 px-4 font-bold text-slate-800">{mod.label}</td>
                    <td className="py-3 px-4 text-slate-500 text-[11px]">{mod.desc}</td>
                    <td className="py-3 px-4 text-center">
                      <span className="w-5 h-5 mx-auto rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center font-bold">✓</span>
                    </td>
                    <td className="py-3 px-4 text-center">
                      {mod.key !== 'user_rights' && mod.key !== 'settings' ? (
                        <span className="w-5 h-5 mx-auto rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center font-bold">✓</span>
                      ) : (
                        <span className="w-5 h-5 mx-auto rounded-full bg-slate-100 text-slate-400 flex items-center justify-center">✕</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-center">
                      {mod.key === 'scanner' ? (
                        <span className="w-5 h-5 mx-auto rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center font-bold">✓</span>
                      ) : (
                        <span className="w-5 h-5 mx-auto rounded-full bg-slate-100 text-slate-400 flex items-center justify-center">✕</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 3: ROLES OVERVIEW */}
      {activeTab === 'roles' && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <h3 className="font-extrabold text-slate-900 text-sm">SUPER ADMIN</h3>
              <span className="text-[10px] bg-red-100 text-red-800 px-2.5 py-0.5 rounded-full font-bold">Unrestricted</span>
            </div>
            <p className="text-xs text-slate-600 mt-3 leading-relaxed">
              Complete administrative authority over the entire NARID ATDC platform. Holds exclusive power to create new Login IDs, reset passwords, change user module permissions, and manage plant system configuration.
            </p>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <h3 className="font-extrabold text-slate-900 text-sm">ADMIN (Supervisor)</h3>
              <span className="text-[10px] bg-blue-100 text-blue-800 px-2.5 py-0.5 rounded-full font-bold">Operations</span>
            </div>
            <p className="text-xs text-slate-600 mt-3 leading-relaxed">
              Plant Floor Supervisors and Production Line Managers. Can view real-time headcount, manage employees, perform Excel imports, generate QR cards, manage lines, and export reports.
            </p>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <h3 className="font-extrabold text-slate-900 text-sm">USER (Gate Operator)</h3>
              <span className="text-[10px] bg-slate-100 text-slate-700 px-2.5 py-0.5 rounded-full font-bold">Scanner Only</span>
            </div>
            <p className="text-xs text-slate-600 mt-3 leading-relaxed">
              Security Gate and Production Line Operators. Restricted exclusively to the high-speed Attendance QR Scanner for rapid employee Punch In and Punch Out.
            </p>
          </div>
        </div>
      )}

      {/* TAB: ROLE PERMISSIONS MANAGEMENT (NEW SUBMODULE) */}
      {activeTab === 'role_permissions' && (
        <RolePermissionsManagement currentUserRole={currentUserRole} />
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
                className="p-1 rounded-lg hover:bg-slate-200 text-slate-500 transition"
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

                {/* Status */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Account Status
                  </label>
                  <select
                    value={createFormData.status}
                    onChange={e => setCreateFormData({ ...createFormData, status: e.target.value as any })}
                    className="w-full text-xs px-3 py-2 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 font-semibold"
                  >
                    <option value="Active">Active (Permitted to log in)</option>
                    <option value="Inactive">Inactive (Suspended)</option>
                  </select>
                </div>
              </div>

              {/* Password */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Initial Password *
                  </label>
                  <div className="relative">
                    <input
                      type={showCreatePassword ? 'text' : 'password'}
                      required
                      value={createFormData.password}
                      onChange={e => setCreateFormData({ ...createFormData, password: e.target.value })}
                      className="w-full text-xs px-3 py-2 pr-10 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => setShowCreatePassword(!showCreatePassword)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                    >
                      {showCreatePassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <span className="text-[10px] text-slate-400">Default: Narid@12345</span>
                </div>

                {/* Email (Optional) */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Email (Optional)
                  </label>
                  <input
                    type="email"
                    placeholder={`Optional (defaults to ${createFormData.loginId || 'id'}@narid.com)`}
                    value={createFormData.email}
                    onChange={e => setCreateFormData({ ...createFormData, email: e.target.value })}
                    className="w-full text-xs px-3 py-2 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                  />
                </div>
              </div>

              {/* Require Password Change Checkbox */}
              <label className="flex items-center gap-2 cursor-pointer bg-slate-50 p-2.5 rounded-xl border border-slate-200">
                <input
                  type="checkbox"
                  checked={createFormData.mustChangePassword}
                  onChange={e => setCreateFormData({ ...createFormData, mustChangePassword: e.target.checked })}
                  className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 w-4 h-4"
                />
                <span className="text-xs text-slate-700 font-medium">
                  Require user to set a new personal password on first login
                </span>
              </label>

              {/* Module Permissions Selection */}
              <div className="pt-2 border-t border-slate-200">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
                  <div>
                    <h4 className="text-xs font-extrabold text-slate-800 uppercase tracking-wide">
                      Module Access Permissions (Firebase Sync)
                    </h4>
                    <p className="text-[11px] text-slate-500">
                      Choose which parts of the application this user can access
                    </p>
                  </div>

                  {/* Preset quick buttons */}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <button
                      type="button"
                      onClick={() => applyPreset('all', val => setCreateFormData({ ...createFormData, modulesAllowed: val }))}
                      className="px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 text-[10px] font-bold"
                    >
                      All Modules
                    </button>
                    <button
                      type="button"
                      onClick={() => applyPreset('supervisor', val => setCreateFormData({ ...createFormData, modulesAllowed: val }))}
                      className="px-2 py-1 rounded bg-blue-50 hover:bg-blue-100 text-blue-700 text-[10px] font-bold"
                    >
                      Supervisor
                    </button>
                    <button
                      type="button"
                      onClick={() => applyPreset('scanner', val => setCreateFormData({ ...createFormData, modulesAllowed: val }))}
                      className="px-2 py-1 rounded bg-emerald-50 hover:bg-emerald-100 text-emerald-700 text-[10px] font-bold"
                    >
                      Scanner Only
                    </button>
                    <button
                      type="button"
                      onClick={() => applyPreset('clear', val => setCreateFormData({ ...createFormData, modulesAllowed: val }))}
                      className="px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 text-[10px] font-bold"
                    >
                      Clear
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-48 overflow-y-auto p-1 bg-slate-50 rounded-xl border border-slate-200">
                  {SYSTEM_MODULES.map(m => {
                    const isChecked = createFormData.role === 'super_admin' || createFormData.modulesAllowed.includes(m.key);
                    return (
                      <label
                        key={m.key}
                        className={`flex items-start gap-2.5 p-2 rounded-lg border cursor-pointer transition ${
                          isChecked ? 'bg-blue-50/70 border-blue-200 text-blue-900 font-semibold' : 'bg-white border-slate-200 text-slate-700'
                        }`}
                      >
                        <input
                          type="checkbox"
                          disabled={createFormData.role === 'super_admin'}
                          checked={isChecked}
                          onChange={() => toggleModule(
                            m.key, 
                            createFormData.modulesAllowed, 
                            val => setCreateFormData({ ...createFormData, modulesAllowed: val })
                          )}
                          className="mt-0.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500 w-4 h-4"
                        />
                        <div className="text-[11px] leading-tight">
                          <div>{m.label}</div>
                          <div className="text-[9px] text-slate-400 font-normal">{m.desc}</div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>

              {/* Submit Buttons */}
              <div className="pt-4 border-t border-slate-100 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="px-4 py-2 rounded-xl border border-slate-200 text-slate-700 hover:bg-slate-100 text-xs font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingCreate}
                  className="px-5 py-2 rounded-xl bg-blue-600 text-white font-bold text-xs flex items-center gap-2 hover:bg-blue-700 shadow-md disabled:opacity-50"
                >
                  {isSubmittingCreate ? (
                    <>
                      <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      <span>Creating in Firebase...</span>
                    </>
                  ) : (
                    <>
                      <Check className="w-4 h-4" />
                      <span>Save & Provision Account</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* MODAL 2: CHANGE PASSWORD (SUPER ADMIN FOR ANY USER)       */}
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
                  <h3 className="font-bold text-slate-900 text-base">Change Password</h3>
                  <p className="text-xs text-slate-500 font-mono">
                    Login ID: <strong className="text-blue-700">{selectedUser.loginId}</strong> ({selectedUser.name})
                  </p>
                </div>
              </div>
              <button
                onClick={() => setIsPasswordModalOpen(false)}
                className="p-1 rounded-lg hover:bg-slate-200 text-slate-500 transition"
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
                    placeholder="Enter new password (min. 6 chars)"
                    value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                    className="w-full text-xs px-3 py-2 pr-10 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewPassword(!showNewPassword)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  >
                    {showNewPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <span className="text-[10px] text-slate-400">Min. 6 characters (e.g. Narid@12345)</span>
              </div>

              <label className="flex items-center gap-2 cursor-pointer bg-slate-50 p-2.5 rounded-xl border border-slate-200">
                <input
                  type="checkbox"
                  checked={requirePasswordChange}
                  onChange={e => setRequirePasswordChange(e.target.checked)}
                  className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 w-4 h-4"
                />
                <span className="text-xs text-slate-700 font-medium">
                  Require user to update password on next login
                </span>
              </label>

              <div className="pt-3 border-t border-slate-100 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setIsPasswordModalOpen(false)}
                  className="px-4 py-2 rounded-xl border border-slate-200 text-slate-700 hover:bg-slate-100 text-xs font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingPassword}
                  className="px-5 py-2 rounded-xl bg-blue-600 text-white font-bold text-xs flex items-center gap-2 hover:bg-blue-700 shadow-md disabled:opacity-50"
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
      {/* MODAL 3: EDIT PERMISSIONS (GRANT / REVOKE ACCESS)         */}
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
                  <h3 className="font-bold text-slate-900 text-base">Configure User Permissions</h3>
                  <p className="text-xs text-slate-500 font-mono">
                    User: <strong className="text-blue-700">{selectedUser.loginId}</strong> ({selectedUser.name})
                  </p>
                </div>
              </div>
              <button
                onClick={() => setIsPermissionsModalOpen(false)}
                className="p-1 rounded-lg hover:bg-slate-200 text-slate-500 transition"
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
                        setEditModulesAllowed(SYSTEM_MODULES.map(m => m.key));
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
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
                  <label className="text-xs font-bold text-slate-700">
                    Grant / Revoke Module Access ({editModulesAllowed.length} Selected)
                  </label>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <button
                      type="button"
                      onClick={() => applyPreset('all', setEditModulesAllowed)}
                      className="px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 text-[10px] font-bold"
                    >
                      All
                    </button>
                    <button
                      type="button"
                      onClick={() => applyPreset('supervisor', setEditModulesAllowed)}
                      className="px-2 py-1 rounded bg-blue-50 hover:bg-blue-100 text-blue-700 text-[10px] font-bold"
                    >
                      Supervisor
                    </button>
                    <button
                      type="button"
                      onClick={() => applyPreset('scanner', setEditModulesAllowed)}
                      className="px-2 py-1 rounded bg-emerald-50 hover:bg-emerald-100 text-emerald-700 text-[10px] font-bold"
                    >
                      Scanner
                    </button>
                    <button
                      type="button"
                      onClick={() => applyPreset('clear', setEditModulesAllowed)}
                      className="px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 text-[10px] font-bold"
                    >
                      Clear
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-56 overflow-y-auto p-1 bg-slate-50 rounded-xl border border-slate-200">
                  {SYSTEM_MODULES.map(m => {
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
                          <div>{m.label}</div>
                          <div className="text-[9px] text-slate-400 font-normal">{m.desc}</div>
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
                  className="px-4 py-2 rounded-xl border border-slate-200 text-slate-700 hover:bg-slate-100 text-xs font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingPermissions}
                  className="px-5 py-2 rounded-xl bg-indigo-600 text-white font-bold text-xs flex items-center gap-2 hover:bg-indigo-700 shadow-md disabled:opacity-50"
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
    </div>
  );
};
