import React, { useState, useEffect, useCallback } from 'react';
import { onAuthStateChanged, signInWithEmailAndPassword, User as FirebaseUser } from 'firebase/auth';
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
  getUserProfileByLoginId,
  getStoredActiveUser,
  logoutUser, 
  getDefaultTabForRole, 
  isModuleAllowedForUser, 
  seedDefaultUserRoles,
  INITIAL_DEFAULT_PASSWORD
} from './services/authService';
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
import { SystemSettingsView } from './components/SystemSettings';
import { UnauthorizedAccess } from './components/UnauthorizedAccess';
import { RolePermissionRecord, subscribeToAllRolePermissions } from './services/permissionService';

export default function App() {
  const [currentUser, setCurrentUser] = useState<FirebaseUser | null>(null);
  const [currentUserRole, setCurrentUserRole] = useState<UserRoleRecord | null>(null);
  const [isAuthChecking, setIsAuthChecking] = useState<boolean>(true);

  const [currentTab, setCurrentTab] = useState<NavItem>('dashboard');
  const [isMobileNavOpen, setIsMobileNavOpen] = useState<boolean>(false);
  const [isFullscreenDashboard, setIsFullscreenDashboard] = useState<boolean>(false);
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

  // Load all master collections (only when authenticated in Firebase Auth)
  const loadAllMasterData = useCallback(async () => {
    if (!auth.currentUser) return;
    setIsLoadingMasterData(true);
    try {
      await testConnection();
      await initializeMasterData();

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
            setCurrentUser(fbUser);
            setCurrentUserRole(profile);
            loadAllMasterData();
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
        // Firebase Auth is not signed in
        const stored = getStoredActiveUser();
        if (stored && stored.loginId) {
          // Attempt silent session reconnect with Firebase Auth
          const candidateEmails = [
            stored.email,
            `${stored.loginId}@narid.com`,
            `${stored.loginId}_root@narid.com`
          ].filter(Boolean);

          let reconnected = false;
          for (const em of candidateEmails) {
            try {
              const res = await signInWithEmailAndPassword(auth, em, INITIAL_DEFAULT_PASSWORD);
              if (res.user) {
                reconnected = true;
                break;
              }
            } catch {
              // Try next candidate
            }
          }

          if (!reconnected) {
            logoutUser();
            setCurrentUser(null);
            setCurrentUserRole(null);
            setIsAuthChecking(false);
          }
        } else {
          setCurrentUser(null);
          setCurrentUserRole(null);
          setIsAuthChecking(false);
        }
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
    const destinationTab = getDefaultTabForRole(profile.role);
    setCurrentTab(destinationTab);
    if (auth.currentUser) {
      loadAllMasterData();
    }
  };

  // Handle logout
  const handleLogout = async () => {
    try {
      await logoutUser();
    } catch (err) {
      console.error('Logout error:', err);
    } finally {
      setCurrentUser(null);
      setCurrentUserRole(null);
    }
  };

  // Handle safe tab navigation with RBAC permission enforcement
  const handleSelectTab = (tab: NavItem) => {
    if (!currentUserRole) return;
    if (!isModuleAllowedForUser(currentUserRole, tab)) {
      console.warn(`Access denied for role ${currentUserRole.role} to module ${tab}`);
      return;
    }
    setCurrentTab(tab);
    setIsMobileNavOpen(false);
  };

  // Full Screen Dashboard Handlers (Native Fullscreen API with fallback support)
  const handleEnterFullscreen = async () => {
    setIsFullscreenDashboard(true);
    try {
      if (document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
      } else if ((document.documentElement as any).webkitRequestFullscreen) {
        await (document.documentElement as any).webkitRequestFullscreen();
      } else if ((document.documentElement as any).msRequestFullscreen) {
        await (document.documentElement as any).msRequestFullscreen();
      }
    } catch (err) {
      // In-app full width works seamlessly even if browser fullscreen is blocked (e.g. inside iframe)
      console.info('[Fullscreen] In-app fullscreen active (native API fallback):', err);
    }
  };

  const handleExitFullscreen = async () => {
    setIsFullscreenDashboard(false);
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
  };

  const handleToggleFullscreen = () => {
    if (isFullscreenDashboard) {
      handleExitFullscreen();
    } else {
      handleEnterFullscreen();
    }
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
      if (!isNativeFs && isFullscreenDashboard) {
        setIsFullscreenDashboard(false);
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isFullscreenDashboard) {
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
  }, [isFullscreenDashboard]);

  // Restore sidebar if user navigates away from Dashboard
  useEffect(() => {
    if (currentTab !== 'dashboard' && isFullscreenDashboard) {
      handleExitFullscreen();
    }
  }, [currentTab, isFullscreenDashboard]);

  // Periodic account status and session validity verification
  useEffect(() => {
    if (!currentUserRole?.loginId) return;
    const checkSession = () => {
      fetch('/api/auth/verify-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginId: currentUserRole.loginId, userId: currentUserRole.id }),
      })
        .then(res => res.json())
        .then(data => {
          if (data && data.success === false) {
            console.warn('[Session Guard] Session revoked or account deactivated.');
            handleLogout();
          }
        })
        .catch(() => {});
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

  // 2.1 First-Time Login Check -> Require individual password change ONLY on first login or forced reset
  if (currentUserRole.mustChangePassword === true) {
    return (
      <PasswordChangeModal 
        userProfile={currentUserRole}
        onPasswordChanged={(updatedProfile) => {
          const cleanProfile: UserRoleRecord = {
            ...updatedProfile,
            mustChangePassword: false,
          };
          localStorage.setItem('narid_active_user', JSON.stringify(cleanProfile));
          sessionStorage.setItem('narid_active_user', JSON.stringify(cleanProfile));
          setCurrentUserRole(cleanProfile);
          setCurrentTab(getDefaultTabForRole(cleanProfile.role));
          loadAllMasterData();
        }}
        onCancelLogout={handleLogout}
      />
    );
  }

  // 3. Authenticated State -> Display authorized application
  const activeEmployeeCount = employees.filter(e => e.employeeStatus === 'Active').length;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-100 font-sans antialiased text-slate-800">
      {/* Industrial Left Sidebar (Filtered by Role, smoothly collapses in Full Screen Mode) */}
      <div 
        className={`transition-all duration-200 ease-in-out shrink-0 ${
          isFullscreenDashboard 
            ? 'w-0 -translate-x-full opacity-0 pointer-events-none hidden' 
            : 'w-64 translate-x-0 opacity-100 block'
        }`}
      >
        <Sidebar 
          currentTab={currentTab} 
          onSelectTab={handleSelectTab} 
          activeEmployeeCount={activeEmployeeCount}
          currentUserRole={currentUserRole}
          onLogout={handleLogout}
          isMobileOpen={isMobileNavOpen}
          onCloseMobile={() => setIsMobileNavOpen(false)}
        />
      </div>

      {/* Main Workspace (Expands to 100% full width smoothly) */}
      <div className="flex-1 flex flex-col h-full overflow-hidden min-w-0 transition-all duration-200 ease-in-out w-full">
        {/* Top Header Bar */}
        <Header 
          shifts={shifts}
          onOpenScanner={() => handleSelectTab('scanner')}
          onRefreshData={loadAllMasterData}
          currentUserRole={currentUserRole}
          onLogout={handleLogout}
          onToggleMobileNav={() => setIsMobileNavOpen(prev => !prev)}
        />

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
              onGoHome={() => setCurrentTab(getDefaultTabForRole(currentUserRole.role))} 
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
                  onRefreshData={loadAllMasterData}
                  currentUserRole={currentUserRole}
                  isFullscreen={isFullscreenDashboard}
                  onToggleFullscreen={handleToggleFullscreen}
                  onExitFullscreen={handleExitFullscreen}
                />
              )}

              {currentTab === 'scanner' && isModuleAllowedForUser(currentUserRole, 'scanner') && (
                <Scanner onAttendanceUpdated={loadAllMasterData} />
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

              {currentTab === 'settings' && isModuleAllowedForUser(currentUserRole, 'settings') && (
                <SystemSettingsView onRefreshData={loadAllMasterData} />
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
