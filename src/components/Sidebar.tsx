import React from 'react';
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
  ScanLine
} from 'lucide-react';

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
}

interface NavConfig {
  id: NavItem;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  highlight?: boolean;
  badge?: string;
  subtext?: string;
}

export const Sidebar: React.FC<SidebarProps> = ({ currentTab, onSelectTab, activeEmployeeCount = 0 }) => {
  const navItems: NavConfig[] = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'scanner', label: 'Attendance Scanner', icon: ScanLine, highlight: true },
    { id: 'employees', label: 'Employee Master', icon: Users, badge: activeEmployeeCount > 0 ? String(activeEmployeeCount) : undefined },
    { id: 'excel_import', label: 'Excel Import / Update', icon: UploadCloud },
    { id: 'qr_codes', label: 'QR Code Management', icon: QrCode },
    { id: 'floors', label: 'Line Management', icon: Layers },
    { id: 'sections', label: 'Section Management', icon: Network },
    { id: 'departments', label: 'Department Master', icon: Building2 },
    { id: 'shifts', label: 'Shift Management', icon: Clock },
    { id: 'history', label: 'Attendance History', icon: History },
    { id: 'reports', label: 'Reports & Export', icon: FileSpreadsheet },
    { id: 'user_rights', label: 'User Rights & Auth', icon: ShieldCheck, subtext: 'Pending Activation' },
    { id: 'settings', label: 'System Settings', icon: Settings },
  ];

  return (
    <aside className="w-64 bg-[#0a192f] text-slate-200 flex flex-col shrink-0 border-r border-slate-800 select-none h-full overflow-hidden">
      {/* Brand Header with official NARID logo icon */}
      <div className="p-3.5 border-b border-slate-800 bg-[#071324] flex items-center gap-3">
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

      {/* Navigation List */}
      <nav className="flex-1 overflow-y-auto sidebar-scroll py-2 px-2 space-y-0.5">
        {navItems.map(item => {
          const Icon = item.icon;
          const isActive = currentTab === item.id;
          const isScanner = item.id === 'scanner';

          return (
            <button
              key={item.id}
              onClick={() => onSelectTab(item.id as NavItem)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded text-left transition-colors text-[13px] font-medium ${
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
        })}
      </nav>

      {/* Industrial Footer Info */}
      <div className="p-3 border-t border-slate-800/80 bg-[#071324] text-[11px] text-slate-400">
        <div className="flex items-center justify-between mb-1">
          <span className="text-slate-500">Database:</span>
          <span className="text-emerald-400 font-mono font-medium flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
            Firestore Connected
          </span>
        </div>
        <div className="flex items-center justify-between text-[10px] text-slate-500">
          <span>Capacity:</span>
          <span>300–500 Manpower</span>
        </div>
      </div>
    </aside>
  );
};
