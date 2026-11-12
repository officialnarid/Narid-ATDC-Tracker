import React, { useState, useEffect } from 'react';
import { 
  LayoutDashboard, 
  QrCode, 
  Users, 
  Layers, 
  Network, 
  Building2, 
  Clock, 
  History, 
  FileSpreadsheet, 
  ShieldCheck, 
  Settings, 
  UploadCloud,
  ScanLine,
  LogOut,
  ChevronDown,
  Building,
  X
} from 'lucide-react';
import { UserRoleRecord } from '../types';
import { isModuleAllowedForUser } from '../services/authService';

export type NavItem = 
  | 'dashboard'
  | 'scanner'
  | 'employees'
  | 'excel_import'
  | 'qr_codes'
  | 'floors'
  | 'sections'
  | 'departments'
  | 'shifts'
  | 'history'
  | 'reports'
  | 'user_rights'
  | 'settings';

interface SidebarProps {
  currentTab: NavItem;
  onSelectTab: (tab: NavItem) => void;
  activeEmployeeCount?: number;
  currentUserRole?: UserRoleRecord | null;
  onLogout?: () => void;
  isMobileOpen?: boolean;
  onCloseMobile?: () => void;
}

interface SingleNavConfig {
  type?: 'single';
  id: NavItem;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  highlight?: boolean;
  badge?: string;
  subtext?: string;
}

interface OrgSubmenuItem {
  id: NavItem;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

export const Sidebar: React.FC<SidebarProps> = ({ 
  currentTab, 
  onSelectTab, 
  activeEmployeeCount = 0,
  currentUserRole,
  onLogout,
  isMobileOpen = false,
  onCloseMobile
}) => {
  // Check if one of the organization submodules is currently active
  const isOrgChildActive = currentTab === 'floors' || currentTab === 'sections' || currentTab === 'departments';

  // Expand state for Organization Management parent menu
  // Default to expanded if one of its children is currently active
  const [isOrgExpanded, setIsOrgExpanded] = useState<boolean>(() => isOrgChildActive);

  // Keep parent expanded whenever an organization sub-module is selected or navigated to
  useEffect(() => {
    if (isOrgChildActive) {
      setIsOrgExpanded(true);
    }
  }, [isOrgChildActive]);

  // Submenu configuration for Organization Management
  const orgSubItems: OrgSubmenuItem[] = [
    { id: 'floors', label: 'Line Management', icon: Layers },
    { id: 'sections', label: 'Section Management', icon: Network },
    { id: 'departments', label: 'Department Master', icon: Building2 },
  ];

  // Filter allowed submenus based on role/modulesAllowed
  const allowedOrgSubItems = orgSubItems.filter(item => 
    isModuleAllowedForUser(currentUserRole, item.id)
  );
  const isOrgAllowed = allowedOrgSubItems.length > 0;

  // Top navigation items before Organization Management
  const topNavItems: SingleNavConfig[] = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'scanner', label: 'Attendance Scanner', icon: ScanLine, highlight: true },
    { id: 'employees', label: 'Employee Master', icon: Users, badge: activeEmployeeCount > 0 ? String(activeEmployeeCount) : undefined },
    { id: 'excel_import', label: 'Excel Import / Update', icon: UploadCloud },
    { id: 'qr_codes', label: 'QR Code Management', icon: QrCode },
  ];

  // Bottom navigation items after Organization Management
  const bottomNavItems: SingleNavConfig[] = [
    { id: 'shifts', label: 'Shift Management', icon: Clock },
    { id: 'history', label: 'Attendance History', icon: History },
    { id: 'reports', label: 'Reports & Export', icon: FileSpreadsheet },
    { id: 'user_rights', label: 'User Rights & Auth', icon: ShieldCheck },
    { id: 'settings', label: 'System Settings', icon: Settings },
  ];

  const allowedTopItems = topNavItems.filter(item => isModuleAllowedForUser(currentUserRole, item.id));
  const allowedBottomItems = bottomNavItems.filter(item => isModuleAllowedForUser(currentUserRole, item.id));

  const handleItemClick = (id: NavItem) => {
    onSelectTab(id);
    if (onCloseMobile) {
      onCloseMobile();
    }
  };

  const renderSingleItem = (item: SingleNavConfig) => {
    const Icon = item.icon;
    const isActive = currentTab === item.id;
    const isScanner = item.id === 'scanner';

    return (
      <button
        key={item.id}
        type="button"
        onClick={() => handleItemClick(item.id)}
        className={`w-full flex items-center gap-2.5 px-3 py-2 rounded text-left transition-colors text-[13px] font-medium cursor-pointer ${
          isActive 
            ? 'bg-blue-600 text-white shadow-sm font-semibold' 
            : isScanner
              ? 'text-emerald-400 hover:bg-slate-800/80 hover:text-emerald-300'
              : 'text-slate-300 hover:bg-slate-800/60 hover:text-white'
        }`}
      >
        <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-white' : isScanner ? 'text-emerald-400' : 'text-slate-400'}`} />
        <span className="flex-1 truncate">{item.label}</span>
        
        {item.badge && (
          <span className="text-[10px] bg-slate-800 text-blue-300 px-1.5 py-0.5 rounded font-mono">
            {item.badge}
          </span>
        )}

        {item.subtext && (
          <span className="text-[9px] bg-amber-950 text-amber-300 border border-amber-800/50 px-1 py-0.5 rounded leading-none">
            Draft
          </span>
        )}
      </button>
    );
  };

  return (
    <>
      {/* Mobile Backdrop Overlay */}
      {isMobileOpen && (
        <div 
          onClick={onCloseMobile}
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-xs md:hidden"
          aria-hidden="true"
        />
      )}

      {/* Main Sidebar Component (Responsive: drawer on mobile, static on desktop) */}
      <aside 
        className={`
          fixed inset-y-0 left-0 z-50 md:static md:z-auto
          w-64 bg-[#0a192f] text-slate-200 flex flex-col shrink-0 border-r border-slate-800 select-none h-full overflow-hidden
          transition-transform duration-300 ease-in-out
          ${isMobileOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full md:translate-x-0'}
        `}
      >
        {/* Brand Header with official NARID logo icon */}
        <div className="p-3.5 border-b border-slate-800 bg-[#071324] flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-lg bg-[#212020] border border-slate-700/80 flex items-center justify-center p-1 overflow-hidden shrink-0 shadow-md">
              <img
                src="/assets/narid-icon.png"
                alt="NARID Logo"
                className="w-full h-full object-contain"
              />
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="font-bold text-white text-[14px] tracking-wide leading-tight truncate">
                Narid ATDC Tracker
              </h1>
              <p className="text-[11px] text-blue-400 font-medium truncate mt-0.5">
                Industrial Attendance System
              </p>
            </div>
          </div>

          {/* Mobile Close Button */}
          {onCloseMobile && (
            <button
              onClick={onCloseMobile}
              className="md:hidden p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800/80 transition cursor-pointer"
              title="Close menu"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Navigation List */}
        <nav className="flex-1 overflow-y-auto sidebar-scroll py-2 px-2 space-y-0.5">
          {/* Top navigation items */}
          {allowedTopItems.map(item => renderSingleItem(item))}

          {/* Expandable Organization Management Parent Menu */}
          {isOrgAllowed && (
            <div className="space-y-0.5 pt-0.5">
              {/* Parent Menu Header Button */}
              <button
                type="button"
                onClick={() => setIsOrgExpanded(prev => !prev)}
                className={`w-full flex items-center justify-between px-3 py-2 rounded text-left transition-colors text-[13px] font-medium group cursor-pointer ${
                  isOrgChildActive 
                    ? 'text-white bg-slate-800/70 font-semibold border-l-2 border-blue-500 pl-[10px]' 
                    : 'text-slate-300 hover:bg-slate-800/60 hover:text-white'
                }`}
                title="Toggle Organization Management menu"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <Building className={`w-4 h-4 shrink-0 transition-colors ${isOrgChildActive ? 'text-blue-400' : 'text-slate-400 group-hover:text-slate-200'}`} />
                  <span className="truncate">Organization Management</span>
                </div>
                <ChevronDown 
                  className={`w-4 h-4 shrink-0 text-slate-400 transition-transform duration-200 ${
                    isOrgExpanded ? 'rotate-0 text-slate-300' : '-rotate-90 text-slate-500'
                  }`} 
                />
              </button>

              {/* Submenu Items (Line Management, Section Management, Department Master) */}
              {isOrgExpanded && (
                <div className="pl-3.5 pr-1 py-1 space-y-0.5 border-l border-slate-700/60 ml-4.5 my-0.5">
                  {allowedOrgSubItems.map(subItem => {
                    const SubIcon = subItem.icon;
                    const isSubActive = currentTab === subItem.id;

                    return (
                      <button
                        key={subItem.id}
                        type="button"
                        onClick={() => handleItemClick(subItem.id)}
                        className={`w-full flex items-center gap-2.5 px-3 py-1.5 rounded text-left transition-colors text-[12.5px] cursor-pointer ${
                          isSubActive
                            ? 'bg-blue-600 text-white font-semibold shadow-xs'
                            : 'text-slate-400 hover:bg-slate-800/70 hover:text-white font-medium'
                        }`}
                      >
                        <SubIcon className={`w-3.5 h-3.5 shrink-0 ${isSubActive ? 'text-white' : 'text-slate-400'}`} />
                        <span className="truncate">{subItem.label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Bottom navigation items */}
          {allowedBottomItems.map(item => renderSingleItem(item))}
        </nav>

        {/* Logged in User Bar & Logout */}
        {currentUserRole && (
          <div className="p-3 border-t border-slate-800 bg-[#081527] flex items-center justify-between">
            <div className="min-w-0 flex-1 pr-2">
              <div className="text-xs font-semibold text-white truncate">
                {typeof currentUserRole.name === 'string' ? currentUserRole.name : (currentUserRole.name as any)?.name || currentUserRole.loginId}
              </div>
              <div className="text-[10px] font-mono text-cyan-400 font-bold uppercase tracking-wider">
                {String(currentUserRole.role || 'USER').replace('_', ' ')}
              </div>
            </div>
            {onLogout && (
              <button
                onClick={onLogout}
                title="Sign Out of Narid ATDC Tracker"
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-red-600/90 text-slate-300 hover:text-white transition flex items-center justify-center shrink-0 shadow-xs cursor-pointer"
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}

        {/* Industrial Footer Info */}
        <div className="p-2.5 border-t border-slate-800/60 bg-[#06101e] text-[10px] text-slate-400">
          <div className="flex items-center justify-between">
            <span className="text-slate-500">Database:</span>
            <span className="text-emerald-400 font-mono font-medium flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
              Firestore Connected
            </span>
          </div>
        </div>
      </aside>
    </>
  );
};
