import React, { useState, useEffect, useCallback } from 'react';
import { testConnection } from './firebase';
import { 
  initializeMasterData, 
  getFloors, 
  getSections, 
  getDepartments, 
  getShifts 
} from './services/masterService';
import { getEmployees } from './services/employeeService';
import { Employee, Floor, Section, Department, Shift } from './types';

// Components
import { Sidebar, NavItem } from './components/Sidebar';
import { Header } from './components/Header';
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
import { SplashScreen } from './components/SplashScreen';
import { Sparkles, Database, CheckCircle2 } from 'lucide-react';

export default function App() {
  const [currentTab, setCurrentTab] = useState<NavItem>('dashboard');
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [floors, setFloors] = useState<Floor[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showSplash, setShowSplash] = useState(true);

  // Load all master collections
  const loadAllMasterData = useCallback(async () => {
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
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAllMasterData();
  }, [loadAllMasterData]);

  const activeEmployeeCount = employees.filter(e => e.employeeStatus === 'Active').length;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-100 font-sans antialiased text-slate-800">
      {/* NARID Brand Opening Splash Screen (2000ms + smooth fade out) */}
      {showSplash && (
        <SplashScreen onFinish={() => setShowSplash(false)} />
      )}

      {/* Dark Blue Industrial Left Sidebar */}
      <Sidebar 
        currentTab={currentTab} 
        onSelectTab={(tab) => setCurrentTab(tab)} 
        activeEmployeeCount={activeEmployeeCount}
      />

      {/* Main Workspace */}
      <div className="flex-1 flex flex-col h-full overflow-hidden">
        {/* Top Header Bar */}
        <Header 
          shifts={shifts}
          onOpenScanner={() => setCurrentTab('scanner')}
          onRefreshData={loadAllMasterData}
        />

        {/* Active Page View Body */}
        <main className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-500 gap-3">
              <div className="w-8 h-8 border-3 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
              <p className="text-xs font-mono font-medium tracking-wide">
                INITIALIZING NARID ATDC TRACKER (FIRESTORE)...
              </p>
            </div>
          ) : (
            <>
              {currentTab === 'dashboard' && (
                <Dashboard
                  employees={employees}
                  shifts={shifts}
                  floors={floors}
                  sections={sections}
                  departments={departments}
                  onNavigateToScanner={() => setCurrentTab('scanner')}
                  onNavigateToReports={() => setCurrentTab('reports')}
                  onRefreshData={loadAllMasterData}
                />
              )}

              {currentTab === 'scanner' && (
                <Scanner onAttendanceUpdated={loadAllMasterData} />
              )}

              {currentTab === 'employees' && (
                <EmployeeMaster
                  employees={employees}
                  floors={floors}
                  sections={sections}
                  departments={departments}
                  onRefresh={loadAllMasterData}
                />
              )}

              {currentTab === 'excel_import' && (
                <ExcelImport
                  floors={floors}
                  sections={sections}
                  departments={departments}
                  onImportComplete={loadAllMasterData}
                />
              )}

              {currentTab === 'qr_codes' && (
                <QrManagement
                  employees={employees}
                  floors={floors}
                  departments={departments}
                  onRefresh={loadAllMasterData}
                />
              )}

              {currentTab === 'floors' && (
                <FloorManagement
                  floors={floors}
                  onRefresh={loadAllMasterData}
                />
              )}

              {currentTab === 'sections' && (
                <SectionManagement
                  sections={sections}
                  floors={floors}
                  onRefresh={loadAllMasterData}
                />
              )}

              {currentTab === 'departments' && (
                <DepartmentManagement
                  departments={departments}
                  onRefresh={loadAllMasterData}
                />
              )}

              {currentTab === 'shifts' && (
                <ShiftManagement
                  shifts={shifts}
                  onRefresh={loadAllMasterData}
                />
              )}

              {currentTab === 'history' && (
                <AttendanceHistory
                  floors={floors}
                  sections={sections}
                  departments={departments}
                  shifts={shifts}
                />
              )}

              {currentTab === 'reports' && (
                <Reports
                  employees={employees}
                  floors={floors}
                  sections={sections}
                  departments={departments}
                  shifts={shifts}
                />
              )}

              {currentTab === 'user_rights' && (
                <UserRights />
              )}

              {currentTab === 'settings' && (
                <SystemSettingsView onRefreshData={loadAllMasterData} />
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
