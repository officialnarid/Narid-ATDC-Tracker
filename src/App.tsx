import React, { useState, useEffect, useCallback } from 'react';
import { onAuthStateChanged, User as FirebaseUser } from 'firebase/auth';
import { auth, testConnection } from './firebase';
import { 
  initializeMasterData, 
  getFloors, 
  getSections, 
  getDepartments, 
  getShifts 
} from './services/masterService';
import { getEmployees } from './services/employeeService';
import { 
  getUserProfileByEmail, 
  getStoredActiveUser,
  logoutUser, 
  getDefaultTabForRole, 
  isModuleAllowedForUser, 
} from './services/authService';
import {
  apiUrl,
  executeApiFetch,
  isApiBaseUsableForCurrentOrigin,
  safeParseJsonResponse,
} from './config/api';
import { getAuthHeaders } from './services/auditService';
import { Employee, Floor, Section, Department, Shift, UserRoleRecord } from './types';

// Components
import { Sidebar, NavItem } from './components/Sidebar';
import { Header } from './components/Header';
import { Login } from './components/Login';
import { PasswordChangeModal } from './components/PasswordChangeModal';
import { Dashboard } from './components/Dashboard';
import { Scanner } from './components/Scanner';
import { EmployeeMaster } from './components/EmployeeMaster';
import { ExcelImport } from './components/ExcelImport';
import { QrManagement } from './components/QrManagement';
import { FloorManagement } from './components/FloorManagement';
import { SectionManagement } from './components/SectionManagement';
import { DepartmentManagement } from './components/DepartmentManagement';
import { ShiftManagement } from './components/ShiftManagement';
import { AttendanceHistory } from './components/AttendanceHistory';
import { Reports } from './components/Reports';
import { UserRights } from './components/UserRights';
import { AuditLogsManagement } from './components/AuditLogsManagement';
import { SecurityManagement } from './components/SecurityManagement';
import { SystemSettingsView } from './components/SystemSettings';
import { UnauthorizedAccess } from './components/UnauthorizedAccess';
import { RolePermissionRecord, subscribeToAllRolePermissions } from './services/permissionService';

const VALID_TABS: NavItem[] = [
  'dashboard',
  'scanner',
  'employees',
  'excel_import',
  'qr_codes',
  'floors',
  'sections',
  'departments',
  'shifts',
  'history',
  'reports',
  'user_rights',
  'audit_logs',
  'security_management',
  'settings',
];

function normalizeTabCandidate(raw: string | null | undefined): NavItem | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/^\/+|\/+$/g, '').replace(/-/g, '_').toLowerCase();
  if (VALID_TABS.includes(cleaned as NavItem)) {
    return cleaned as NavItem;
  }
  return null;
}

function getTabFromLocation(): NavItem | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const queryTab = normalizeTabCandidate(params.get('tab'));
  if (queryTab) return queryTab;

  const hashTab = normalizeTabCandidate(window.location.hash.replace(/^#/, ''));
  if (hashTab) return hashTab;

  const pathTab = normalizeTabCandidate(window.location.pathname.split('/')[1]);
  if (pathTab) return pathTab;

  return null;
}

export default function App() {
  const [currentUser, setCurrentUser] = useState<FirebaseUser | null>(null);
  const [currentUserRole, setCurrentUserRole] = useState<UserRoleRecord | null>(null);
  const [isAuthChecking, setIsAuthChecking] = useState<boolean>(true);

  const [currentTab, setCurrentTab] = useState<NavItem>(() => getTabFromLocation() || 'dashboard');
  const [isMobileNavOpen, setIsMobileNavOpen] = useState<boolean>(false);
  const [fullscreenTab, setFullscreenTab] = useState<'dashboard' | 'scanner' | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [floors, setFloors] = useState<Floor[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [isLoadingMasterData, setIsLoadingMasterData] = useState<boolean>(false);
  const [rolePermissions, setRolePermissions] = useState<Record<string, RolePermissionRecord>>({});

  // Real-time synchronization of Role Permissions matrix (only when authenticated)
  useEffect(() => {
    if (!currentUser || !auth.currentUser) return;
    const unsub = subscribeToAllRolePermissions(setRolePermissions);
    return () => unsub();
  }, [currentUser]);

  // Synchronize direct URL navigation / browser Back-Forward
  useEffect(() => {
    const syncFromUrl = () => {
      const targetTab = getTabFromLocation();
      if (targetTab) {
        setCurrentTab(targetTab);
      } else {
        setCurrentTab('dashboard');
      }
    };
    window.addEventListener('popstate', syncFromUrl);
    window.addEventListener('hashchange', syncFromUrl);
    return () => {
      window.removeEventListener('popstate', syncFromUrl);
      window.removeEventListener('hashchange', syncFromUrl);
    };
  }, []);

  // Load all master collections (only when authenticated in Firebase Auth)
  const loadAllMasterData = useCallback(async (allowSeed: boolean = false) => {
    if (!auth.currentUser) return;
    setIsLoadingMasterData(true);
    try {
      await testConnection();
      if (allowSeed) {
        await initializeMasterData();
      }

      const [empsData, flsData, secsData, deptsData, sftsData] = await Promise.all([
        getEmployees(),
        getFloors(),
        getSections(),
        getDepartments(),
        getShifts(),
      ]);

      setEmployees(empsData);
      setFloors(flsData);
      setSections(secsData);
      setDepartments(deptsData);
      setShifts(sftsData);
    } catch (err) {
      console.error('Failed to load initial data:', err);
    } finally {
      setIsLoadingMasterData(false);
    }
  }, []);

  // Initialize and observe Authentication Session
  useEffect(() => {
    let isMounted = true;

    const unsubscribe = onAuthStateChanged(auth, async (fbUser) => {
      if (!isMounted) return;

      if (fbUser && fbUser.email) {
        try {
          const profile = await getUserProfileByEmail(fbUser.email);
          if (profile && profile.status === 'Active') {
            try {
              if (localStorage.getItem('narid_active_user')) {
                localStorage.setItem('narid_active_user', JSON.stringify(profile));
              }
              if (sessionStorage.getItem('narid_active_user')) {
                sessionStorage.setItem('narid_active_user', JSON.stringify(profile));
              }
            } catch {}
            setCurrentUser(fbUser);
            setCurrentUserRole(profile);
            const isPrivileged = profile.role === 'super_admin' || profile.role === 'admin';
            loadAllMasterData(isPrivileged);
          } else {
            logoutUser();
            setCurrentUser(null);
            setCurrentUserRole(null);
          }
        } catch (err) {
          console.error('Error fetching user profile:', err);
        }
        setIsAuthChecking(false);
      } else {
        // Firebase Auth is not signed in — do NOT issue automatic password-guessing retries.
        // Clear any stale cached browser metadata and cleanly render the Login screen.
        const stored = getStoredActiveUser();
        if (stored) {
          try {
            localStorage.removeItem('narid_active_user');
            sessionStorage.removeItem('narid_active_user');
            localStorage.removeItem('narid_session_id');
            sessionStorage.removeItem('narid_session_id');
          } catch {}
        }
        setCurrentUser(null);
        setCurrentUserRole(null);
        setIsAuthChecking(false);
      }
    });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, [loadAllMasterData]);

  // Handle successful login
  const handleLoginSuccess = (profile: UserRoleRecord) => {
    const fbUser = auth.currentUser || ({ uid: profile.id, email: profile.email } as any);
    setCurrentUser(fbUser);
    setCurrentUserRole(profile);
    const requestedUrlTab = getTabFromLocation();
    const destinationTab = requestedUrlTab || getDefaultTabForRole(profile.role, profile);
    setCurrentTab(destinationTab);
    try {
      window.history.replaceState(null, '', `/${destinationTab}`);
    } catch {}
    if (auth.currentUser) {
      const isPrivileged = profile.role === 'super_admin' || profile.role === 'admin';
      loadAllMasterData(isPrivileged);
    }
  };

  // Full Screen Handlers (Native Fullscreen API with in-app fallback support)
  const handleEnterFullscreen = useCallback(async (target: 'dashboard' | 'scanner') => {
    setFullscreenTab(target);
    try {
      if (document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
      } else if ((document.documentElement as any).webkitRequestFullscreen) {
        await (document.documentElement as any).webkitRequestFullscreen();
      } else if ((document.documentElement as any).msRequestFullscreen) {
        await (document.documentElement as any).msRequestFullscreen();
      }
    } catch (err) {
      // In-app full screen works seamlessly even if browser fullscreen is blocked (e.g. inside iframe)
      console.info('[Fullscreen] In-app fullscreen active (native API fallback):', err);
    }
  }, []);

  const handleExitFullscreen = useCallback(async () => {
    setFullscreenTab(null);
    try {
      if (
        document.fullscreenElement ||
        (document as any).webkitFullscreenElement ||
        (document as any).mozFullScreenElement ||
        (document as any).msFullscreenElement
      ) {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else if ((document as any).webkitExitFullscreen) {
          await (document as any).webkitExitFullscreen();
        } else if ((document as any).msExitFullscreen) {
          await (document as any).msExitFullscreen();
        }
      }
    } catch (err) {
      console.info('[Fullscreen] Exit notice:', err);
    }
  }, []);

  const handleToggleFullscreen = useCallback((target: 'dashboard' | 'scanner') => {
    if (fullscreenTab === target) {
      handleExitFullscreen();
    } else {
      handleEnterFullscreen(target);
    }
  }, [fullscreenTab, handleEnterFullscreen, handleExitFullscreen]);

  // Handle logout
  const handleLogout = useCallback(async (reason: 'logout' | 'session_expired' = 'logout') => {
    const safeReason = reason === 'session_expired' ? 'session_expired' : 'logout';
    await handleExitFullscreen();
    try {
      await logoutUser(safeReason);
    } catch (err) {
      console.error('Logout error:', err);
    } finally {
      setCurrentUser(null);
      setCurrentUserRole(null);
      try {
        window.history.replaceState(null, '', '/');
      } catch {}
    }
  }, [handleExitFullscreen]);

  // Handle safe tab navigation with RBAC permission enforcement
  const handleSelectTab = (tab: NavItem) => {
    if (!currentUserRole) return;
    if (!isModuleAllowedForUser(currentUserRole, tab)) {
      console.warn(`Access denied for role ${currentUserRole.role} to module ${tab}`);
      return;
    }
    setCurrentTab(tab);
    setIsMobileNavOpen(false);
    try {
      if (window.location.pathname !== `/${tab}`) {
        window.history.pushState(null, '', `/${tab}`);
      }
    } catch {}
  };

  // Synchronize layout with browser fullscreenchange and ESC key
  useEffect(() => {
    const onFullscreenChange = () => {
      const isNativeFs = !!(
        document.fullscreenElement ||
        (document as any).webkitFullscreenElement ||
        (document as any).mozFullScreenElement ||
        (document as any).msFullscreenElement
      );
      if (!isNativeFs && fullscreenTab !== null) {
        setFullscreenTab(null);
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && fullscreenTab !== null) {
        handleExitFullscreen();
      }
    };

    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    document.addEventListener('mozfullscreenchange', onFullscreenChange);
    document.addEventListener('MSFullscreenChange', onFullscreenChange);
    window.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
      document.removeEventListener('mozfullscreenchange', onFullscreenChange);
      document.removeEventListener('MSFullscreenChange', onFullscreenChange);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [fullscreenTab, handleExitFullscreen]);

  // Restore sidebar and exit fullscreen if user navigates away from the fullscreen tab
  useEffect(() => {
    if (fullscreenTab && currentTab !== fullscreenTab) {
      handleExitFullscreen();
    }
  }, [currentTab, fullscreenTab, handleExitFullscreen]);

  // Periodic account status and session validity verification
  useEffect(() => {
    if (!currentUserRole?.loginId || !auth.currentUser) return;
    const checkSession = async () => {
      if (!auth.currentUser || !isApiBaseUsableForCurrentOrigin()) return;
      try {
        const headers = await getAuthHeaders();
        const res = await executeApiFetch(
          apiUrl('/api/auth/verify-session'),
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ loginId: currentUserRole.loginId, userId: currentUserRole.id }),
          },
          'POST /api/auth/verify-session'
        );
        if (res.status === 401) {
          console.warn('[Session Guard] Token rejected or revoked.');
          handleLogout('session_expired');
          return;
        }
        const parsed = await safeParseJsonResponse<{ success?: boolean }>(
          res,
          'POST /api/auth/verify-session'
        );
        if (!parsed.isHtmlOrNonJson && parsed.data && parsed.data.success === false) {
          console.warn('[Session Guard] Session revoked or account deactivated.');
          handleLogout('session_expired');
        }
      } catch {
        // Transient network hiccup ignored until next check
      }
    };
    const timer = setInterval(checkSession, 30000);
    return () => clearInterval(timer);
  }, [currentUserRole, handleLogout]);

  // 1. Initial Authentication Check Loader (Instant, clean, no 5s splash screen)
  if (isAuthChecking) {
    return (
      <div className="h-screen w-screen flex flex-col items-center justify-center bg-[#00183b] text-white">
        <div className="w-10 h-10 border-3 border-blue-500 border-t-transparent rounded-full animate-spin mb-4" />
        <p className="text-xs font-mono tracking-widest text-blue-200 uppercase">
          INITIALIZING NARID ATDC TRACKER...
        </p>
      </div>
    );
  }

  // 2. Unauthenticated State -> Immediately show Reference Login Page
  if (!currentUser || !currentUserRole || !auth.currentUser) {
    return <Login onLoginSuccess={handleLoginSuccess} />;
  }

  // 2.1 First-Time / Temporary Password Login Check -> Require individual password change when flagged
  if (currentUserRole.mustChangePassword === true || currentUserRole.forcePasswordChange === true) {
    return (
      <PasswordChangeModal 
        userProfile={currentUserRole}
        onPasswordChanged={(updatedProfile) => {
          const cleanProfile: UserRoleRecord = {
            ...updatedProfile,
            mustChangePassword: false,
            forcePasswordChange: false,
          };
          localStorage.setItem('narid_active_user', JSON.stringify(cleanProfile));
          sessionStorage.setItem('narid_active_user', JSON.stringify(cleanProfile));
          setCurrentUserRole(cleanProfile);
          const nextTab = getDefaultTabForRole(cleanProfile.role, cleanProfile);
          setCurrentTab(nextTab);
          try {
            window.history.replaceState(null, '', `/${nextTab}`);
          } catch {}
          loadAllMasterData(cleanProfile.role === 'super_admin' || cleanProfile.role === 'admin');
        }}
        onCancelLogout={handleLogout}
      />
    );
  }

  // 3. Authenticated State -> Display authorized application
  const activeEmployeeCount = employees.filter(e => e.employeeStatus === 'Active').length;
  const isFullscreenDashboard = fullscreenTab === 'dashboard' && currentTab === 'dashboard';
  const isFullscreenScanner = fullscreenTab === 'scanner' && currentTab === 'scanner';
  const isFullscreenAny = isFullscreenDashboard || isFullscreenScanner;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-100 font-sans antialiased text-slate-800">
      {/* Industrial Left Sidebar (Filtered by Role, hides completely in Full Screen Mode) */}
      <div 
        className={`transition-all duration-200 ease-in-out shrink-0 ${
          isFullscreenAny
            ? 'w-0 -translate-x-full opacity-0 pointer-events-none hidden' 
            : 'w-64 translate-x-0 opacity-100 block'
        }`}
      >
        <Sidebar 
          currentTab={currentTab} 
          onSelectTab={handleSelectTab} 
          activeEmployeeCount={activeEmployeeCount}
          currentUserRole={currentUserRole}
          onLogout={() => handleLogout('logout')}
          isMobileOpen={isMobileNavOpen}
          onCloseMobile={() => setIsMobileNavOpen(false)}
        />
      </div>

      {/* Main Workspace (Expands to 100% full width smoothly) */}
      <div className="flex-1 flex flex-col h-full overflow-hidden min-w-0 transition-all duration-200 ease-in-out w-full">
        {/* Top Header Bar (Hidden completely in Attendance Scanner Full Screen Mode) */}
        {!isFullscreenScanner && (
          <Header 
            shifts={shifts}
            onOpenScanner={() => handleSelectTab('scanner')}
            onRefreshData={() => loadAllMasterData(false)}
            currentUserRole={currentUserRole}
            onLogout={() => handleLogout('logout')}
            onToggleMobileNav={() => setIsMobileNavOpen(prev => !prev)}
          />
        )}

        {/* Active Page View Body */}
        <main className="flex-1 overflow-y-auto transition-all duration-200 ease-in-out">
          {isLoadingMasterData && employees.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-500 gap-3">
              <div className="w-8 h-8 border-3 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
              <p className="text-xs font-mono font-medium tracking-wide">
                SYNCHRONIZING PRODUCTION MASTER DATA...
              </p>
            </div>
          ) : !isModuleAllowedForUser(currentUserRole, currentTab) ? (
            <UnauthorizedAccess 
              currentTab={currentTab} 
              currentUserRole={currentUserRole} 
              onGoHome={() => handleSelectTab(getDefaultTabForRole(currentUserRole.role, currentUserRole))} 
            />
          ) : (
            <>
              {currentTab === 'dashboard' && (
                <Dashboard
                  employees={employees}
                  shifts={shifts}
                  floors={floors}
                  sections={sections}
                  departments={departments}
                  onNavigateToScanner={() => handleSelectTab('scanner')}
                  onNavigateToReports={() => handleSelectTab('reports')}
                  onRefreshData={() => loadAllMasterData(false)}
                  currentUserRole={currentUserRole}
                  rolePermissions={rolePermissions}
                  isFullscreen={isFullscreenDashboard}
                  onToggleFullscreen={() => handleToggleFullscreen('dashboard')}
                  onExitFullscreen={handleExitFullscreen}
                />
              )}

              {currentTab === 'scanner' && isModuleAllowedForUser(currentUserRole, 'scanner') && (
                <Scanner
                  onAttendanceUpdated={() => loadAllMasterData(false)}
                  isFullscreen={isFullscreenScanner}
                  onToggleFullscreen={() => handleToggleFullscreen('scanner')}
                  onExitFullscreen={handleExitFullscreen}
                />
              )}

              {currentTab === 'employees' && isModuleAllowedForUser(currentUserRole, 'employees') && (
                <EmployeeMaster
                  employees={employees}
                  floors={floors}
                  sections={sections}
                  departments={departments}
                  onRefresh={loadAllMasterData}
                  currentUserRole={currentUserRole}
                  rolePermissions={rolePermissions}
                />
              )}

              {currentTab === 'excel_import' && isModuleAllowedForUser(currentUserRole, 'excel_import') && (
                <ExcelImport
                  floors={floors}
                  sections={sections}
                  departments={departments}
                  onImportComplete={loadAllMasterData}
                />
              )}

              {currentTab === 'qr_codes' && isModuleAllowedForUser(currentUserRole, 'qr_codes') && (
                <QrManagement
                  employees={employees}
                  floors={floors}
                  departments={departments}
                  onRefresh={loadAllMasterData}
                />
              )}

              {currentTab === 'floors' && isModuleAllowedForUser(currentUserRole, 'floors') && (
                <FloorManagement
                  floors={floors}
                  onRefresh={loadAllMasterData}
                />
              )}

              {currentTab === 'sections' && isModuleAllowedForUser(currentUserRole, 'sections') && (
                <SectionManagement
                  sections={sections}
                  floors={floors}
                  onRefresh={loadAllMasterData}
                />
              )}

              {currentTab === 'departments' && isModuleAllowedForUser(currentUserRole, 'departments') && (
                <DepartmentManagement
                  departments={departments}
                  onRefresh={loadAllMasterData}
                />
              )}

              {currentTab === 'shifts' && isModuleAllowedForUser(currentUserRole, 'shifts') && (
                <ShiftManagement
                  shifts={shifts}
                  onRefresh={loadAllMasterData}
                />
              )}

              {currentTab === 'history' && isModuleAllowedForUser(currentUserRole, 'history') && (
                <AttendanceHistory
                  floors={floors}
                  sections={sections}
                  departments={departments}
                  shifts={shifts}
                />
              )}

              {currentTab === 'reports' && isModuleAllowedForUser(currentUserRole, 'reports') && (
                <Reports
                  employees={employees}
                  floors={floors}
                  sections={sections}
                  departments={departments}
                  shifts={shifts}
                />
              )}

              {currentTab === 'user_rights' && isModuleAllowedForUser(currentUserRole, 'user_rights') && (
                <UserRights 
                  currentUserRole={currentUserRole}
                  onRoleProfileUpdated={(updatedProfile) => {
                    if (updatedProfile.id === currentUserRole.id) {
                      setCurrentUserRole(updatedProfile);
                    }
                  }}
                />
              )}

              {currentTab === 'audit_logs' && isModuleAllowedForUser(currentUserRole, 'audit_logs') && (
                currentUserRole.role?.toUpperCase() === 'SUPER_ADMIN' ? (
                  <AuditLogsManagement currentUserRole={currentUserRole} />
                ) : (
                  <UnauthorizedAccess
                    currentTab={currentTab}
                    currentUserRole={currentUserRole}
                    onGoHome={() => setCurrentTab(getDefaultTabForRole(currentUserRole.role, currentUserRole))}
                  />
                )
              )}

              {currentTab === 'security_management' && isModuleAllowedForUser(currentUserRole, 'security_management') && (
                currentUserRole.role?.toUpperCase() === 'SUPER_ADMIN' ? (
                  <SecurityManagement currentUserRole={currentUserRole} />
                ) : (
                  <UnauthorizedAccess
                    currentTab={currentTab}
                    currentUserRole={currentUserRole}
                    onGoHome={() => setCurrentTab(getDefaultTabForRole(currentUserRole.role, currentUserRole))}
                  />
                )
              )}

              {currentTab === 'settings' && isModuleAllowedForUser(currentUserRole, 'settings') && (
                <SystemSettingsView
                  onRefreshData={loadAllMasterData}
                  currentUserRole={currentUserRole}
                  onOpenAuditConsole={() => handleSelectTab('audit_logs')}
                />
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
