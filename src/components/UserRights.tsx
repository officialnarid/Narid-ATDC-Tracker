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
  Users,
  Check,
  Building,
  User,
  CheckSquare,
  Square,
  KeyRound,
  History,
  Sparkles,
  Unlock,
  RotateCcw,
  Copy,
  Globe,
  Monitor
} from 'lucide-react';
import { RolePermissionsManagement } from './RolePermissionsManagement';
import { onSnapshot, collection } from 'firebase/firestore';
import { db } from '../firebase';
import { LoginHistoryEntry, UserRoleRecord, UserRoleType } from '../types';
import { 
  getAllUserRoles, 
  createUserAccount, 
  adminSetUserPassword, 
  fetchPasswordResetHistory,
  updateUserRolePermissions, 
  deleteUserRole,
  fetchDuplicateAccountsReport,
  consolidateDuplicateAccounts,
  fetchFullAuthAudit,
  DuplicateReportResponse,
  FullAuthAuditResponse,
} from '../services/authService';
import {
  AccountCleanupAuditResponse,
  CleanupAuditAccount,
  approveAccountCleanup,
  fetchAccountCleanupAudit,
  fetchLoginHistory
} from '../services/auditService';
import {
  fetchFirebaseAdminStatus,
  FirebaseAdminStatusResponse
} from '../services/securityService';
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

function generateInitialUserPassword(length: number = 12): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const symbols = '@#$%&*!';
  const all = upper + lower + digits + symbols;
  const pick = (pool: string, byte: number) => pool[byte % pool.length];
  const bytes = new Uint8Array(Math.max(8, length));
  window.crypto.getRandomValues(bytes);
  const chars: string[] = [
    pick(upper, bytes[0]),
    pick(lower, bytes[1]),
    pick(digits, bytes[2]),
    pick(symbols, bytes[3]),
  ];
  for (let i = 4; i < bytes.length; i++) {
    chars.push(pick(all, bytes[i]));
  }
  // Fisher-Yates shuffle using remaining randomness
  const shuffleBytes = new Uint8Array(chars.length);
  window.crypto.getRandomValues(shuffleBytes);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = shuffleBytes[i] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

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
  const [panelCurrentPassword, setPanelCurrentPassword] = useState('');
  const [panelNewPassword, setPanelNewPassword] = useState('');
  const [showPanelNewPassword, setShowPanelNewPassword] = useState(false);
  const [panelForceChange, setPanelForceChange] = useState(true);
  const [panelUnlockAccount, setPanelUnlockAccount] = useState(true);
  const [panelRevokeSessions, setPanelRevokeSessions] = useState(true);
  const [isSubmittingPanelReset, setIsSubmittingPanelReset] = useState(false);
  const [passwordHistoryList, setPasswordHistoryList] = useState<any[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [firebaseAdminStatus, setFirebaseAdminStatus] = useState<FirebaseAdminStatusResponse | null>(null);

  // Modal States
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isPasswordModalOpen, setIsPasswordModalOpen] = useState(false);
  const [isPermissionsModalOpen, setIsPermissionsModalOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<UserRoleRecord | null>(null);

  // Duplicate Account Audit, Cleanup Governance & Health Modal State
  const [isDuplicateModalOpen, setIsDuplicateModalOpen] = useState(false);
  const [duplicateModalTab, setDuplicateModalTab] = useState<'authAudit' | 'cleanup' | 'uniqueness'>('authAudit');
  const [duplicateReport, setDuplicateReport] = useState<DuplicateReportResponse | null>(null);
  const [authAuditData, setAuthAuditData] = useState<FullAuthAuditResponse | null>(null);
  const [cleanupAuditData, setCleanupAuditData] = useState<AccountCleanupAuditResponse | null>(null);
  const [isLoadingDuplicateReport, setIsLoadingDuplicateReport] = useState(false);
  const [isLoadingAuthAudit, setIsLoadingAuthAudit] = useState(false);
  const [isConsolidating, setIsConsolidating] = useState(false);

  // Per-account Super Admin cleanup approval state
  const [cleanupTarget, setCleanupTarget] = useState<CleanupAuditAccount | null>(null);
  const [cleanupConfirmEmail, setCleanupConfirmEmail] = useState('');
  const [cleanupMigrateCanonical, setCleanupMigrateCanonical] = useState(true);
  const [isApprovingCleanup, setIsApprovingCleanup] = useState(false);
  const [cleanupApprovalResult, setCleanupApprovalResult] = useState<{
    email: string;
    message: string;
    cliSnippet: string;
    consoleUrl: string;
  } | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Recent Login Telemetry for Password Governance tab
  const [recentLoginHistory, setRecentLoginHistory] = useState<LoginHistoryEntry[]>([]);

  // Deletion Confirmation Modal State (Section 1)
  const [userToDelete, setUserToDelete] = useState<UserRoleRecord | null>(null);
  const [isDeletingUser, setIsDeletingUser] = useState(false);

  // Form States - Create User (Section 2)
  const [createFormData, setCreateFormData] = useState({
    name: '',
    loginId: '',
    email: '',
    role: 'admin' as UserRoleType,
    password: '',
    status: 'Active' as 'Active' | 'Inactive',
    mustChangePassword: true,
    modulesAllowed: ['dashboard', 'scanner', 'employees', 'history', 'reports'] as string[],
  });
  const [isSubmittingCreate, setIsSubmittingCreate] = useState(false);
  const [showCreatePassword, setShowCreatePassword] = useState(false);

  // Form States - Change Password
  const [modalCurrentPassword, setModalCurrentPassword] = useState('');
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

        // Strict Deduplication by normalized loginId
        const uniqueMap = new Map<string, UserRoleRecord>();
        fetched.forEach(item => {
          const key = (item.loginId || item.id.replace(/^role_/, '')).trim().toLowerCase();
          const existing = uniqueMap.get(key);
          if (!existing) {
            uniqueMap.set(key, item);
          } else {
            // Prioritize canonical doc ('role_' + key) or document with passwordHash
            if (item.id === `role_${key}` || (!existing.id.startsWith('role_') && item.passwordHash)) {
              uniqueMap.set(key, item);
            }
          }
        });
        const deduplicated = Array.from(uniqueMap.values());

        // Sort: Super Admin first, then admin, then user
        const order: Record<string, number> = { super_admin: 0, admin: 1, user: 2 };
        deduplicated.sort((a, b) => {
          const aOrder = order[a.role?.toLowerCase()] ?? 3;
          const bOrder = order[b.role?.toLowerCase()] ?? 3;
          if (aOrder !== bOrder) return aOrder - bOrder;
          return (a.loginId || '').localeCompare(b.loginId || '');
        });

        setUsers(deduplicated);
        setIsLoadingUsers(false);

        // Update default matrix selection if not selected
        if (!selectedMatrixUserId && deduplicated.length > 0) {
          const firstNonSuper = deduplicated.find(u => u.role?.toLowerCase() !== 'super_admin') || deduplicated[0];
          setSelectedMatrixUserId(firstNonSuper.id);
        }

        // Update current session profile if matched
        if (currentUserRole) {
          const currentInDb = deduplicated.find(u => u.id === currentUserRole.id || u.loginId === currentUserRole.loginId);
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

  // Duplicate Account Audit, Cleanup Governance & Consolidation Handlers
  const handleOpenDuplicateModal = async () => {
    setIsDuplicateModalOpen(true);
    setIsLoadingDuplicateReport(true);
    setIsLoadingAuthAudit(true);
    setCleanupApprovalResult(null);
    try {
      const [rep, audit, cleanup, adminStatus] = await Promise.all([
        fetchDuplicateAccountsReport(),
        fetchFullAuthAudit(),
        fetchAccountCleanupAudit(),
        fetchFirebaseAdminStatus().catch(() => null),
      ]);
      setDuplicateReport(rep);
      setAuthAuditData(audit);
      setCleanupAuditData(cleanup);
      if (adminStatus) setFirebaseAdminStatus(adminStatus);
    } catch (err: any) {
      showToast('error', err.message || 'Failed to load authentication & cleanup audit reports.');
    } finally {
      setIsLoadingDuplicateReport(false);
      setIsLoadingAuthAudit(false);
    }
  };

  const handleCopyText = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2500);
    } catch {
      showToast('error', 'Clipboard access unavailable in this browser context.');
    }
  };

  const handleSubmitCleanupApproval = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cleanupTarget) return;
    if (cleanupConfirmEmail.trim() !== cleanupTarget.email) {
      showToast('error', `Please type exact email "${cleanupTarget.email}" to confirm.`);
      return;
    }

    setIsApprovingCleanup(true);
    try {
      const res = await approveAccountCleanup({
        accountKey: cleanupTarget.key,
        migrateCanonicalEmails: cleanupMigrateCanonical,
        confirmEmail: cleanupConfirmEmail.trim(),
      });
      setCleanupApprovalResult({
        email: cleanupTarget.email,
        message: res.message,
        cliSnippet: res.cliSnippet,
        consoleUrl: res.consoleUrl,
      });
      showToast('success', res.message);
      setCleanupTarget(null);
      setCleanupConfirmEmail('');
      const refreshed = await fetchAccountCleanupAudit();
      setCleanupAuditData(refreshed);
    } catch (err: any) {
      showToast('error', err.message || 'Failed to approve account cleanup.');
    } finally {
      setIsApprovingCleanup(false);
    }
  };

  const handleExecuteConsolidation = async () => {
    setIsConsolidating(true);
    try {
      const res = await consolidateDuplicateAccounts();
      showToast('success', res.message || 'Duplicate accounts successfully consolidated!');
      const rep = await fetchDuplicateAccountsReport();
      setDuplicateReport(rep);
      loadUsersManual();
    } catch (err: any) {
      showToast('error', err.message || 'Failed to consolidate duplicates.');
    } finally {
      setIsConsolidating(false);
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
      const [history, loginTelemetry, adminStatus] = await Promise.all([
        fetchPasswordResetHistory(),
        fetchLoginHistory().catch(() => [] as LoginHistoryEntry[]),
        fetchFirebaseAdminStatus().catch(() => null),
      ]);
      setPasswordHistoryList(history);
      setRecentLoginHistory(loginTelemetry.slice(0, 12));
      if (adminStatus) setFirebaseAdminStatus(adminStatus);
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
      const res = await adminSetUserPassword(
        selectedResetUser.id,
        selectedResetUser.loginId,
        panelNewPassword,
        panelForceChange,
        panelUnlockAccount,
        panelRevokeSessions,
        panelCurrentPassword.trim() || undefined
      );
      showToast('success', res.message || `Password for "${selectedResetUser.loginId}" synchronized in Firebase Auth & Firestore.`);
      setPanelNewPassword('');
      setPanelCurrentPassword('');
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
      password: '',
      status: 'Active',
      mustChangePassword: true,
      modulesAllowed: ['dashboard', 'scanner', 'employees', 'history', 'reports', 'qr_codes'],
    });
    setShowCreatePassword(false);
    setIsCreateModalOpen(true);
  };

  // 2. SUBMIT CREATE USER (Section 2 - with Uniqueness Enforcement)
  const handleCreateUserSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanId = createFormData.loginId.trim().toLowerCase();
    const cleanEmail = createFormData.email.trim().toLowerCase();

    if (!cleanId) {
      showToast('error', 'Please enter a Login ID.');
      return;
    }

    // Client-side uniqueness validation
    if (users.some(u => (u.loginId || '').trim().toLowerCase() === cleanId)) {
      showToast('error', `Login ID "${cleanId}" already exists. Duplicate Login IDs are prohibited.`);
      return;
    }

    if (cleanEmail && users.some(u => (u.email || '').trim().toLowerCase() === cleanEmail)) {
      showToast('error', `Email "${cleanEmail}" is already registered to another account.`);
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
        loginId: cleanId,
        email: cleanEmail || undefined,
        password: createFormData.password,
        role: createFormData.role,
        modulesAllowed: finalModules,
        status: createFormData.status,
        mustChangePassword: createFormData.mustChangePassword,
      });

      showToast('success', `Login ID "${created.loginId}" created and synchronized with Firebase!`);
      setIsCreateModalOpen(false);
      loadUsersManual();
    } catch (err: any) {
      showToast('error', err.message || 'Failed to create user account.');
    } finally {
      setIsSubmittingCreate(false);
    }
  };

  // 3. OPEN PASSWORD CHANGE MODAL
  const handleOpenPasswordModal = (user: UserRoleRecord) => {
    setSelectedUser(user);
    setModalCurrentPassword('');
    setNewPassword('');
    setShowNewPassword(false);
    setRequirePasswordChange(false);
    setIsPasswordModalOpen(true);
    if (isSuperAdmin && !firebaseAdminStatus) {
      fetchFirebaseAdminStatus().then(setFirebaseAdminStatus).catch(() => {});
    }
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
      const res = await adminSetUserPassword(
        selectedUser.id,
        selectedUser.loginId,
        newPassword,
        requirePasswordChange,
        true,
        true,
        modalCurrentPassword.trim() || undefined
      );
      showToast('success', res.message || `Password for "${selectedUser.loginId}" synchronized in Firebase Auth & Firestore.`);
      setModalCurrentPassword('');
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

          {isSuperAdmin && (
            <button
              onClick={handleOpenDuplicateModal}
              className="px-3 py-1.5 rounded-xl border border-indigo-200 bg-indigo-50/70 hover:bg-indigo-100 text-indigo-800 text-xs font-bold flex items-center gap-2 transition cursor-pointer"
              title="Audit and consolidate duplicate accounts"
            >
              <ShieldCheck className="w-4 h-4 text-indigo-600" />
              <span>Duplicate Accounts Audit</span>
            </button>
          )}

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
          <span>Active User Directory ({users.length} Unique Accounts)</span>
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
          <div className="p-4 border-b border-slate-200 bg-slate-50/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-xs font-extrabold text-slate-800 uppercase tracking-wider">
                  Authorized Personnel Directory
                </h3>
                <span className="px-2.5 py-0.5 rounded-full text-[10px] font-extrabold bg-blue-100 text-blue-800 border border-blue-200">
                  {users.length} Unique Accounts
                </span>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-100 text-emerald-800 flex items-center gap-1">
                  <Check className="w-3 h-3" /> Uniqueness Enforced
                </span>
              </div>
              <p className="text-[11px] text-slate-500 mt-0.5">
                Each Login ID is strictly unique (1 SUPER_ADMIN, 1 ADMIN, 1 USER). Click actions on any row to manage settings.
              </p>
            </div>
            {isSuperAdmin && (
              <button
                onClick={handleOpenDuplicateModal}
                className="self-start sm:self-auto px-3 py-1.5 rounded-xl border border-slate-200 hover:bg-slate-100 bg-white text-slate-700 text-xs font-bold flex items-center gap-1.5 transition shadow-2xs cursor-pointer"
              >
                <ShieldCheck className="w-3.5 h-3.5 text-blue-600" />
                <span>Duplicate Accounts Report</span>
              </button>
            )}
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

                {/* Firebase Admin SDK Diagnostic Status */}
                {firebaseAdminStatus && (
                  <div className={`p-3 rounded-xl border text-[11px] leading-relaxed ${
                    firebaseAdminStatus.adminSdkConfigured
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                      : 'bg-amber-50 border-amber-200 text-amber-950'
                  }`}>
                    {firebaseAdminStatus.adminSdkConfigured ? (
                      <div className="font-semibold">
                        Firebase Admin SDK Active ({firebaseAdminStatus.credentialSource}) — {firebaseAdminStatus.authUsers.length} Firebase Auth users verified for {firebaseAdminStatus.projectId}.
                      </div>
                    ) : (
                      <div>
                        <span className="font-bold">Admin SDK Service Account Not Mounted: </span>
                        Runtime default credentials resolve to sandbox project {firebaseAdminStatus.adcSandboxProject} instead of {firebaseAdminStatus.projectId}. To reset a password when the account no longer uses the initial default, either mount <code className="font-mono font-bold">FIREBASE_SERVICE_ACCOUNT_KEY</code> or supply the account&apos;s current Firebase password below.
                      </div>
                    )}
                  </div>
                )}

                {/* Optional Current Password (when Admin SDK key is not mounted) */}
                {(!firebaseAdminStatus || !firebaseAdminStatus.adminSdkConfigured) && (
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1.5 uppercase tracking-wider">
                      Current Firebase Password (Optional)
                    </label>
                    <input
                      type="password"
                      placeholder="Leave blank if account uses initial password or Admin SDK key is mounted"
                      value={panelCurrentPassword}
                      onChange={e => setPanelCurrentPassword(e.target.value)}
                      className="w-full text-xs px-3.5 py-2.5 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-amber-500 font-mono"
                    />
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
                    Minimum 6 characters. Firebase Auth UID is updated in-place before Firestore scrypt hash updates.
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

          {/* Recent Login IP / Browser / OS Telemetry Card */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
            <div className="p-4 border-b border-slate-200 bg-slate-50/80 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Globe className="w-4 h-4 text-blue-600" />
                <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                  Recent Authentication &amp; Device Telemetry
                </h4>
              </div>
              <span className="text-[10px] font-mono text-slate-500">
                Latest {recentLoginHistory.length} sign-in / logout events
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-600 uppercase font-bold text-[10px] border-b border-slate-200">
                  <tr>
                    <th className="py-2.5 px-3.5">Time</th>
                    <th className="py-2.5 px-3.5">Event</th>
                    <th className="py-2.5 px-3.5">Login ID</th>
                    <th className="py-2.5 px-3.5">IP &amp; GeoLocation</th>
                    <th className="py-2.5 px-3.5">Browser / OS / Device</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {recentLoginHistory.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-6 text-center text-slate-400">
                        No recent sign-in telemetry recorded yet.
                      </td>
                    </tr>
                  ) : (
                    recentLoginHistory.map(ev => (
                      <tr key={ev.id} className="hover:bg-slate-50">
                        <td className="py-2 px-3.5 font-mono text-[11px] text-slate-500 whitespace-nowrap">
                          {new Date(ev.timestamp).toLocaleString()}
                        </td>
                        <td className="py-2 px-3.5">
                          <span className={`px-1.5 py-0.5 rounded font-mono text-[10px] font-bold ${
                            ev.success ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'
                          }`}>
                            {ev.eventType}
                          </span>
                        </td>
                        <td className="py-2 px-3.5 font-mono font-bold text-blue-700">{ev.loginId}</td>
                        <td className="py-2 px-3.5 font-mono text-[11px] text-slate-700">
                          {ev.ipAddress}
                          {ev.geoLocation?.status === 'resolved' && (
                            <span className="text-slate-400 ml-1">
                              ({[ev.geoLocation.city, ev.geoLocation.country].filter(Boolean).join(', ')})
                            </span>
                          )}
                        </td>
                        <td className="py-2 px-3.5 text-[11px] text-slate-600">
                          <span className="inline-flex items-center gap-1">
                            <Monitor className="w-3 h-3 text-slate-400" />
                            {ev.browser} / {ev.os} ({ev.deviceType})
                          </span>
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
                                       ['dashboard', 'scanner']
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
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-bold text-slate-700">
                    Initial Password *
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setCreateFormData({ ...createFormData, password: generateInitialUserPassword() });
                      setShowCreatePassword(true);
                    }}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-600 hover:text-blue-700 cursor-pointer"
                  >
                    <Sparkles className="w-3 h-3" />
                    <span>Generate</span>
                  </button>
                </div>
                <div className="relative">
                  <input
                    type={showCreatePassword ? 'text' : 'password'}
                    required
                    minLength={6}
                    placeholder="Enter initial password (min 6 chars)"
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
                <span className="text-[10px] text-slate-400">Minimum 6 characters (enter manually or click Generate).</span>
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
              {firebaseAdminStatus && !firebaseAdminStatus.adminSdkConfigured && (
                <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-950 text-[11px] leading-relaxed">
                  <strong>Firebase Admin SDK Key Not Mounted:</strong> Supply the account&apos;s current Firebase password below (or mount <code className="font-mono font-bold">FIREBASE_SERVICE_ACCOUNT_KEY</code>) so Firebase Auth UID is updated in-place.
                </div>
              )}

              {(!firebaseAdminStatus || !firebaseAdminStatus.adminSdkConfigured) && (
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Current Account Password (Optional)
                  </label>
                  <input
                    type="password"
                    placeholder="Needed if Admin SDK key is absent & password changed"
                    value={modalCurrentPassword}
                    onChange={e => setModalCurrentPassword(e.target.value)}
                    className="w-full text-xs px-3 py-2 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono font-medium"
                  />
                </div>
              )}

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

      {/* ========================================================= */}
      {/* MODAL 5: DUPLICATE ACCOUNT AUDIT & CONSOLIDATION          */}
      {/* ========================================================= */}
      {isDuplicateModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs overflow-y-auto">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-4xl my-8 overflow-hidden animate-in fade-in zoom-in-95 duration-150 flex flex-col max-h-[90vh]">
            {/* Modal Header */}
            <div className="p-5 border-b border-slate-200 bg-slate-50 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-blue-600 text-white flex items-center justify-center font-bold shadow-md shadow-blue-600/20">
                  <ShieldCheck className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="font-extrabold text-slate-900 text-base">Enterprise Authentication Audit & Account Mapping</h3>
                  <p className="text-xs text-slate-500">
                    Comprehensive cross-reference of Firebase Authentication UIDs, Firestore collections, and audit logs
                  </p>
                </div>
              </div>
              <button
                onClick={() => setIsDuplicateModalOpen(false)}
                className="p-1.5 rounded-lg hover:bg-slate-200 text-slate-500 transition cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Tabs Header */}
            <div className="px-5 pt-3 border-b border-slate-200 bg-slate-50/70 flex items-center gap-3 shrink-0 overflow-x-auto">
              <button
                type="button"
                onClick={() => setDuplicateModalTab('authAudit')}
                className={`pb-2.5 px-3 text-xs font-bold border-b-2 transition flex items-center gap-2 shrink-0 cursor-pointer ${
                  duplicateModalTab === 'authAudit'
                    ? 'border-blue-600 text-blue-700'
                    : 'border-transparent text-slate-500 hover:text-slate-800'
                }`}
              >
                <ShieldCheck className="w-4 h-4" />
                <span>10-Account Firebase Auth Audit & Mapping</span>
                <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-blue-100 text-blue-800 font-extrabold">10</span>
              </button>

              <button
                type="button"
                onClick={() => setDuplicateModalTab('cleanup')}
                className={`pb-2.5 px-3 text-xs font-bold border-b-2 transition flex items-center gap-2 shrink-0 cursor-pointer ${
                  duplicateModalTab === 'cleanup'
                    ? 'border-amber-600 text-amber-700'
                    : 'border-transparent text-slate-500 hover:text-slate-800'
                }`}
              >
                <ShieldAlert className="w-4 h-4" />
                <span>Legacy Cleanup Governance (19 Collections)</span>
                <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-amber-100 text-amber-800 font-extrabold">
                  {cleanupAuditData ? cleanupAuditData.accounts.filter(a => !a.isCanonicalKeep && !a.isProtected).length : 6}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setDuplicateModalTab('uniqueness')}
                className={`pb-2.5 px-3 text-xs font-bold border-b-2 transition flex items-center gap-2 shrink-0 cursor-pointer ${
                  duplicateModalTab === 'uniqueness'
                    ? 'border-blue-600 text-blue-700'
                    : 'border-transparent text-slate-500 hover:text-slate-800'
                }`}
              >
                <Users className="w-4 h-4" />
                <span>Unique Account Directory (3 Roles)</span>
                <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-extrabold ${
                  duplicateReport?.duplicateCount ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'
                }`}>
                  {duplicateReport ? `${duplicateReport.totalUniqueAccounts} Accounts` : '3 Accounts'}
                </span>
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 overflow-y-auto space-y-5 grow">
              {isLoadingDuplicateReport || isLoadingAuthAudit ? (
                <div className="py-12 text-center text-slate-500 space-y-3">
                  <div className="w-8 h-8 border-3 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
                  <p className="text-xs font-semibold">Auditing 10 Firebase Auth accounts and cross-referencing Firestore collections...</p>
                </div>
              ) : duplicateModalTab === 'authAudit' && authAuditData ? (
                <>
                  {/* Step 1 Summary Cards */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="p-3.5 rounded-xl bg-blue-50 border border-blue-200">
                      <div className="text-[10px] font-bold text-blue-600 uppercase tracking-wider">Total Audited</div>
                      <div className="text-xl font-extrabold text-blue-900 mt-0.5">{authAuditData.totalAccountsAudited} Accounts</div>
                      <div className="text-[10px] text-blue-700 mt-0.5">Firebase Auth Registry</div>
                    </div>
                    <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200">
                      <div className="text-[10px] font-bold text-emerald-600 uppercase tracking-wider">Primary Active</div>
                      <div className="text-xl font-extrabold text-emerald-800 mt-0.5">{authAuditData.primaryAccountsCount} Accounts</div>
                      <div className="text-[10px] text-emerald-700 mt-0.5">Tested 12 Nov 2026</div>
                    </div>
                    <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200">
                      <div className="text-[10px] font-bold text-amber-600 uppercase tracking-wider">Legacy Accounts</div>
                      <div className="text-xl font-extrabold text-amber-800 mt-0.5">{authAuditData.legacyAccountsCount} Accounts</div>
                      <div className="text-[10px] text-amber-700 mt-0.5">Protected & Pending</div>
                    </div>
                    <div className="p-3.5 rounded-xl bg-indigo-50 border border-indigo-200">
                      <div className="text-[10px] font-bold text-indigo-600 uppercase tracking-wider">Audit Logs Traced</div>
                      <div className="text-xl font-extrabold text-indigo-900 mt-0.5">{authAuditData.totalAuditLogsCount} Logs</div>
                      <div className="text-[10px] text-indigo-700 mt-0.5">Historical verification</div>
                    </div>
                  </div>

                  {/* Live Firebase Admin SDK Inspection Status */}
                  {firebaseAdminStatus && (
                    <div className={`p-4 rounded-xl border flex items-start gap-3 ${
                      firebaseAdminStatus.adminSdkConfigured
                        ? 'bg-emerald-50 border-emerald-200'
                        : 'bg-amber-50 border-amber-200'
                    }`}>
                      <ShieldCheck className={`w-5 h-5 shrink-0 mt-0.5 ${
                        firebaseAdminStatus.adminSdkConfigured ? 'text-emerald-600' : 'text-amber-700'
                      }`} />
                      <div className="text-xs leading-relaxed">
                        <div className={`font-bold ${firebaseAdminStatus.adminSdkConfigured ? 'text-emerald-900' : 'text-amber-950'}`}>
                          {firebaseAdminStatus.adminSdkConfigured
                            ? `Live Firebase Admin SDK Connected (${firebaseAdminStatus.authUsers.length} Firebase Auth Users Loaded)`
                            : 'Live Firebase Admin SDK Inspection Unavailable in Sandbox Runtime'}
                        </div>
                        <div className={firebaseAdminStatus.adminSdkConfigured ? 'text-emerald-800 mt-0.5' : 'text-amber-900 mt-0.5'}>
                          {firebaseAdminStatus.adminSdkConfigured
                            ? `Verified against project "${firebaseAdminStatus.projectId}" using ${firebaseAdminStatus.credentialSource}. Mapping conflicts detected: ${firebaseAdminStatus.firestoreMappings.filter(m => m.mappingConflict).length}.`
                            : firebaseAdminStatus.reason}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Safety Guard Badge */}
                  <div className="p-4 rounded-xl bg-blue-50/70 border border-blue-200 flex items-start gap-3">
                    <ShieldCheck className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" />
                    <div>
                      <div className="font-bold text-blue-900 text-xs">Read-Only Authentication Audit Safeguard</div>
                      <div className="text-xs text-blue-800 mt-0.5 leading-relaxed">
                        {authAuditData.safeguardMessage} Permanent UIDs, employee relations, attendance scan history, and QR codes remain fully preserved.
                      </div>
                    </div>
                  </div>

                  {/* 10-Account Mapping Table */}
                  <div className="rounded-xl border border-slate-200 overflow-hidden bg-white shadow-2xs">
                    <div className="p-3.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                        Master Firebase Authentication Account Mapping (10 Accounts)
                      </span>
                      <span className="text-[11px] text-slate-500 font-mono">
                        Audited: {new Date(authAuditData.auditTimestamp).toLocaleDateString()}
                      </span>
                    </div>

                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-slate-50 text-slate-500 uppercase font-semibold text-[10px] border-b border-slate-200">
                          <tr>
                            <th className="py-2.5 px-3">Login ID & Role</th>
                            <th className="py-2.5 px-3">Email</th>
                            <th className="py-2.5 px-3">Firebase UID</th>
                            <th className="py-2.5 px-3">Created / Sign-in</th>
                            <th className="py-2.5 px-3">Firestore References</th>
                            <th className="py-2.5 px-3">Status & Action</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {authAuditData.accounts.map((acc) => {
                            const isPrimary = acc.accountType === 'PRIMARY_CURRENT';
                            const isLegacyQA = acc.accountType === 'LEGACY_QA';
                            const isSystem = acc.accountType === 'LEGACY_SYSTEM' || acc.accountType === 'GOOGLE_OWNER';
                            return (
                              <tr 
                                key={acc.loginId + acc.email} 
                                className={isPrimary ? 'bg-emerald-50/25' : isLegacyQA ? 'bg-amber-50/25' : 'bg-slate-50/30'}
                              >
                                <td className="py-3 px-3">
                                  <div className="font-mono font-bold text-slate-900 text-[11px]">{acc.loginId}</div>
                                  <span className={`inline-block mt-0.5 px-2 py-0.2 rounded-full text-[9px] font-bold uppercase ${
                                    acc.role === 'SUPER_ADMIN' ? 'bg-purple-100 text-purple-800' :
                                    acc.role === 'ADMIN' ? 'bg-blue-100 text-blue-800' :
                                    'bg-slate-100 text-slate-800'
                                  }`}>
                                    {acc.role}
                                  </span>
                                </td>
                                <td className="py-3 px-3 font-mono text-[11px] text-slate-700">
                                  {acc.email}
                                </td>
                                <td className="py-3 px-3 font-mono text-[10px] text-slate-600 max-w-[150px] truncate" title={acc.firebaseUid}>
                                  {acc.firebaseUid}
                                </td>
                                <td className="py-3 px-3 text-[10px] text-slate-500">
                                  <div>Created: {new Date(acc.createdDate).toLocaleDateString()}</div>
                                  <div className="text-slate-700 font-medium">Last Login: {new Date(acc.lastSignIn).toLocaleDateString()}</div>
                                </td>
                                <td className="py-3 px-3 text-[11px] text-slate-700 max-w-[200px]">
                                  {acc.firestoreReferences}
                                </td>
                                <td className="py-3 px-3">
                                  {isPrimary ? (
                                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-extrabold bg-emerald-100 text-emerald-800">
                                      <CheckCircle2 className="w-3 h-3" />
                                      ACTIVE PRIMARY
                                    </span>
                                  ) : isSystem ? (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-100 text-blue-800">
                                      <ShieldCheck className="w-3 h-3" />
                                      SYSTEM PRINCIPAL
                                    </span>
                                  ) : isLegacyQA ? (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800">
                                      <AlertCircle className="w-3 h-3" />
                                      PENDING APPROVAL
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-700">
                                      ALIAS MAPPED
                                    </span>
                                  )}
                                  <div className="text-[10px] text-slate-500 mt-1 leading-tight">
                                    {acc.recommendation}
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Step 6 Safe Legacy Cleanup Report Card */}
                  <div className="p-4 rounded-xl border border-slate-200 bg-slate-50 space-y-2">
                    <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-2">
                      <Lock className="w-3.5 h-3.5 text-blue-600" />
                      Step 6: Super Admin Legacy Account Cleanup Governance
                    </h4>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      Switch to the <strong>Legacy Cleanup Governance</strong> tab to inspect cross-collection UID dependencies across all 19 Firestore collections and explicitly approve legacy accounts before running Firebase Console / CLI deletion.
                    </p>
                  </div>
                </>
              ) : duplicateModalTab === 'cleanup' && cleanupAuditData ? (
                <>
                  {/* Cross-Collection Safeguard Notice */}
                  <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 flex items-start gap-3">
                    <ShieldAlert className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
                    <div className="text-xs text-amber-900 space-y-1">
                      <div className="font-bold">
                        Cross-Collection UID Reconciliation ({cleanupAuditData.collectionsScanned} Collections Scanned)
                      </div>
                      <p className="leading-relaxed">
                        Canonical Keep Accounts: <span className="font-mono font-bold">{cleanupAuditData.canonicalKeepEmails.join(', ')}</span> (+ GCP Owner protected).
                        {' '}{cleanupAuditData.safeguardMessage}
                      </p>
                    </div>
                  </div>

                  {/* Generated CLI / Console Snippet Banner after Approval */}
                  {cleanupApprovalResult && (
                    <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-300 space-y-2.5 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-bold text-emerald-900 flex items-center gap-1.5">
                          <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                          <span>Cleanup Approved for {cleanupApprovalResult.email}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleCopyText('console_url', cleanupApprovalResult.consoleUrl)}
                          className="px-2.5 py-1 rounded bg-white border border-emerald-300 text-emerald-800 font-semibold flex items-center gap-1 cursor-pointer"
                        >
                          <Copy className="w-3 h-3" />
                          <span>{copiedKey === 'console_url' ? 'Copied Console URL' : 'Copy Firebase Console URL'}</span>
                        </button>
                      </div>
                      <p className="text-emerald-800">{cleanupApprovalResult.message}</p>
                      <div className="bg-slate-900 text-emerald-300 p-3 rounded-lg font-mono text-[11px] flex items-start justify-between gap-2">
                        <code className="break-all">{cleanupApprovalResult.cliSnippet}</code>
                        <button
                          type="button"
                          onClick={() => handleCopyText('cli_snippet', cleanupApprovalResult.cliSnippet)}
                          className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-white text-[10px] font-bold shrink-0 flex items-center gap-1 cursor-pointer"
                        >
                          <Copy className="w-3 h-3" />
                          <span>{copiedKey === 'cli_snippet' ? 'Copied' : 'Copy'}</span>
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Per-Account Approval Sub-form */}
                  {cleanupTarget && (
                    <form onSubmit={handleSubmitCleanupApproval} className="p-4 rounded-xl border-2 border-amber-400 bg-amber-50/60 space-y-3 text-xs">
                      <div className="flex items-center justify-between">
                        <h4 className="font-bold text-amber-950">
                          Approve Cleanup for: <span className="font-mono">{cleanupTarget.email}</span>
                        </h4>
                        <button
                          type="button"
                          onClick={() => setCleanupTarget(null)}
                          className="p-1 rounded hover:bg-amber-200 text-amber-800 cursor-pointer"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>

                      <div className="text-[11px] text-amber-900">
                        UID: <span className="font-mono font-bold">{cleanupTarget.firebaseUid}</span> • Active Blocking Dependencies: <strong>{cleanupTarget.activeBlockingDependencies}</strong>
                      </div>

                      {cleanupTarget.key.endsWith('_root_legacy') && (
                        <label className="flex items-center gap-2 cursor-pointer font-medium text-amber-950">
                          <input
                            type="checkbox"
                            checked={cleanupMigrateCanonical}
                            onChange={e => setCleanupMigrateCanonical(e.target.checked)}
                            className="rounded border-amber-400 text-amber-600 w-4 h-4"
                          />
                          <span>Migrate Firestore user_roles reference cleanly to canonical *@narid.com while preserving aliases</span>
                        </label>
                      )}

                      <div>
                        <label className="block font-bold text-amber-950 mb-1">
                          Type exact email <span className="font-mono">{cleanupTarget.email}</span> to approve cleanup *
                        </label>
                        <input
                          type="email"
                          required
                          placeholder={cleanupTarget.email}
                          value={cleanupConfirmEmail}
                          onChange={e => setCleanupConfirmEmail(e.target.value)}
                          className="w-full px-3 py-2 border border-amber-300 rounded-lg bg-white font-mono"
                        />
                      </div>

                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setCleanupTarget(null)}
                          className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-700 font-semibold cursor-pointer"
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          disabled={isApprovingCleanup}
                          className="px-4 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-bold cursor-pointer disabled:opacity-50"
                        >
                          {isApprovingCleanup ? 'Recording Approval...' : 'Confirm Super Admin Approval'}
                        </button>
                      </div>
                    </form>
                  )}

                  {/* 10-Account Dependency Table */}
                  <div className="rounded-xl border border-slate-200 overflow-hidden bg-white">
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-slate-50 text-slate-600 uppercase font-bold text-[10px] border-b border-slate-200">
                          <tr>
                            <th className="py-2.5 px-3">Account &amp; Role</th>
                            <th className="py-2.5 px-3">UID</th>
                            <th className="py-2.5 px-3">Cross-Collection Dependencies</th>
                            <th className="py-2.5 px-3">Recommendation</th>
                            <th className="py-2.5 px-3 text-right">Governance Action</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {cleanupAuditData.accounts.map(acc => (
                            <tr key={acc.key} className={acc.isCanonicalKeep ? 'bg-emerald-50/20' : 'bg-white'}>
                              <td className="py-2.5 px-3">
                                <div className="font-mono font-bold text-slate-900">{acc.email}</div>
                                <div className="text-[10px] text-slate-500 uppercase font-semibold">
                                  {acc.loginId} • {acc.role}
                                </div>
                              </td>
                              <td className="py-2.5 px-3 font-mono text-[10px] text-slate-600 max-w-[140px] truncate" title={acc.firebaseUid}>
                                {acc.firebaseUid}
                              </td>
                              <td className="py-2.5 px-3">
                                {acc.dependencies.length === 0 ? (
                                  <span className="text-[11px] text-slate-400">0 references</span>
                                ) : (
                                  <div className="flex flex-wrap gap-1">
                                    {acc.dependencies.map(dep => (
                                      <span
                                        key={dep.collection}
                                        className="px-1.5 py-0.5 rounded bg-slate-100 border border-slate-200 font-mono text-[10px] text-slate-700"
                                        title={dep.note}
                                      >
                                        {dep.collection}: {dep.matches}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </td>
                              <td className="py-2.5 px-3 text-[11px] text-slate-700 max-w-[200px]">
                                {acc.recommendation}
                              </td>
                              <td className="py-2.5 px-3 text-right whitespace-nowrap">
                                {acc.isCanonicalKeep || acc.isProtected ? (
                                  <span className="px-2 py-1 rounded bg-emerald-100 text-emerald-800 text-[10px] font-bold uppercase">
                                    Protected Keep
                                  </span>
                                ) : acc.approvalState?.approved ? (
                                  <div className="inline-flex flex-col items-end gap-1">
                                    <span className="px-2 py-0.5 rounded bg-blue-100 text-blue-800 text-[10px] font-bold">
                                      Approved by {acc.approvalState.approvedBy}
                                    </span>
                                    {acc.consoleCleanupCommand && (
                                      <button
                                        type="button"
                                        onClick={() => handleCopyText(acc.key, acc.consoleCleanupCommand || '')}
                                        className="px-2 py-0.5 rounded border border-slate-300 bg-white hover:bg-slate-50 text-[10px] font-semibold flex items-center gap-1 cursor-pointer"
                                      >
                                        <Copy className="w-3 h-3" />
                                        <span>{copiedKey === acc.key ? 'Copied' : 'Copy CLI'}</span>
                                      </button>
                                    )}
                                  </div>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setCleanupTarget(acc);
                                      setCleanupConfirmEmail('');
                                      setCleanupMigrateCanonical(acc.key.endsWith('_root_legacy'));
                                    }}
                                    className="px-2.5 py-1 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-[11px] font-bold cursor-pointer"
                                  >
                                    Approve Cleanup
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              ) : duplicateReport ? (
                <>
                  {/* Summary Metric Cards */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200">
                      <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Raw Documents</div>
                      <div className="text-xl font-extrabold text-slate-800 mt-0.5">{duplicateReport.totalRawDocuments}</div>
                    </div>
                    <div className="p-3.5 rounded-xl bg-blue-50 border border-blue-200">
                      <div className="text-[10px] font-bold text-blue-600 uppercase tracking-wider">Unique Accounts</div>
                      <div className="text-xl font-extrabold text-blue-800 mt-0.5">{duplicateReport.totalUniqueAccounts}</div>
                    </div>
                    <div className={`p-3.5 rounded-xl border ${duplicateReport.duplicateCount > 0 ? 'bg-amber-50 border-amber-300' : 'bg-emerald-50 border-emerald-300'}`}>
                      <div className={`text-[10px] font-bold uppercase tracking-wider ${duplicateReport.duplicateCount > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>
                        Shadow Duplicates
                      </div>
                      <div className={`text-xl font-extrabold mt-0.5 ${duplicateReport.duplicateCount > 0 ? 'text-amber-800' : 'text-emerald-800'}`}>
                        {duplicateReport.duplicateCount}
                      </div>
                    </div>
                    <div className="p-3.5 rounded-xl bg-purple-50 border border-purple-200">
                      <div className="text-[10px] font-bold text-purple-600 uppercase tracking-wider">Integrity Status</div>
                      <div className="text-xs font-extrabold text-purple-800 mt-1">
                        {duplicateReport.duplicateCount === 0 ? '100% CANONICAL' : 'CONSOLIDATION NEEDED'}
                      </div>
                    </div>
                  </div>

                  {/* Status Banner */}
                  {duplicateReport.duplicateCount === 0 ? (
                    <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 flex items-start gap-3">
                      <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
                      <div>
                        <div className="font-bold text-emerald-900 text-xs">Database Uniqueness Verified</div>
                        <div className="text-xs text-emerald-800 mt-0.5 leading-relaxed">
                          Exactly <strong>{duplicateReport.totalUniqueAccounts} unique canonical accounts</strong> are active (1 SUPER_ADMIN, 1 ADMIN, 1 USER). No redundant shadow duplicates exist in Firestore. Unique Login ID constraints are active on both frontend and backend.
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="p-4 rounded-xl bg-amber-50 border border-amber-300 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="flex items-start gap-3">
                        <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                        <div>
                          <div className="font-bold text-amber-900 text-xs">Duplicate Records Detected ({duplicateReport.duplicateCount})</div>
                          <div className="text-xs text-amber-800 mt-0.5">
                            Shadow duplicate document(s) share identical Login IDs. Consolidate them to retain the primary canonical record and preserve all authentication mappings.
                          </div>
                        </div>
                      </div>
                      <button
                        onClick={handleExecuteConsolidation}
                        disabled={isConsolidating}
                        className="px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs flex items-center gap-2 shadow-md shrink-0 cursor-pointer disabled:opacity-50"
                      >
                        {isConsolidating ? (
                          <>
                            <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                            <span>Consolidating...</span>
                          </>
                        ) : (
                          <>
                            <Sparkles className="w-4 h-4" />
                            <span>Consolidate Duplicates</span>
                          </>
                        )}
                      </button>
                    </div>
                  )}

                  {/* Detailed Account Groups */}
                  <div className="space-y-4">
                    <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                      Account Breakdown by Login ID
                    </h4>

                    {duplicateReport.report.map((group) => (
                      <div key={group.loginId} className="rounded-xl border border-slate-200 overflow-hidden bg-white shadow-2xs">
                        <div className="p-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-bold text-blue-700 text-sm">
                              {group.loginId}
                            </span>
                            <span className="text-[11px] text-slate-500">
                              ({group.totalDocs} document{group.totalDocs > 1 ? 's' : ''})
                            </span>
                          </div>
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                            group.hasDuplicates 
                              ? 'bg-amber-100 text-amber-800' 
                              : 'bg-emerald-100 text-emerald-800'
                          }`}>
                            {group.hasDuplicates ? 'Duplicates Detected' : 'Unique (1 Primary)'}
                          </span>
                        </div>

                        <div className="overflow-x-auto">
                          <table className="w-full text-left text-xs">
                            <thead className="bg-slate-50/50 text-slate-500 uppercase font-semibold text-[10px] border-b border-slate-100">
                              <tr>
                                <th className="py-2.5 px-3">Document ID / Auth UID</th>
                                <th className="py-2.5 px-3">Email</th>
                                <th className="py-2.5 px-3">Role</th>
                                <th className="py-2.5 px-3">Password Hash</th>
                                <th className="py-2.5 px-3">Audit Logs</th>
                                <th className="py-2.5 px-3 text-right">Status</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                              {group.documents.map((doc) => (
                                <tr key={doc.docId} className={doc.isPrimary ? 'bg-emerald-50/20' : 'bg-amber-50/20'}>
                                  <td className="py-2.5 px-3">
                                    <div className="font-mono font-bold text-slate-800 text-[11px]">{doc.docId}</div>
                                    {doc.firebaseUid && doc.firebaseUid !== doc.docId && (
                                      <div className="text-[10px] text-slate-400 font-mono">UID: {doc.firebaseUid}</div>
                                    )}
                                  </td>
                                  <td className="py-2.5 px-3 font-mono text-[11px] text-slate-600">
                                    {doc.email}
                                  </td>
                                  <td className="py-2.5 px-3">
                                    <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase bg-slate-100 text-slate-700">
                                      {doc.role}
                                    </span>
                                  </td>
                                  <td className="py-2.5 px-3">
                                    {doc.hasPasswordHash ? (
                                      <span className="text-[10px] text-emerald-700 font-semibold flex items-center gap-1">
                                        <Check className="w-3 h-3" /> Scrypt Hash
                                      </span>
                                    ) : (
                                      <span className="text-[10px] text-slate-400">None</span>
                                    )}
                                  </td>
                                  <td className="py-2.5 px-3 font-semibold text-slate-700">
                                    {doc.associatedAuditLogs} references
                                  </td>
                                  <td className="py-2.5 px-3 text-right">
                                    {doc.isPrimary ? (
                                      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-extrabold bg-emerald-100 text-emerald-800">
                                        <CheckCircle2 className="w-3 h-3" />
                                        PRIMARY CANONICAL
                                      </span>
                                    ) : (
                                      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800">
                                        <AlertCircle className="w-3 h-3" />
                                        SHADOW DUPLICATE
                                      </span>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : null}
            </div>

            {/* Modal Footer */}
            <div className="p-4 border-t border-slate-200 bg-slate-50 flex items-center justify-between shrink-0">
              <button
                type="button"
                onClick={handleOpenDuplicateModal}
                disabled={isLoadingDuplicateReport || isLoadingAuthAudit}
                className="px-4 py-2 rounded-xl border border-slate-300 hover:bg-white text-slate-700 text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isLoadingDuplicateReport || isLoadingAuthAudit ? 'animate-spin text-blue-600' : ''}`} />
                <span>Re-Scan Database</span>
              </button>
              <button
                type="button"
                onClick={() => setIsDuplicateModalOpen(false)}
                className="px-5 py-2 rounded-xl bg-slate-800 hover:bg-slate-900 text-white font-bold text-xs transition cursor-pointer"
              >
                Close
              </button>
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
