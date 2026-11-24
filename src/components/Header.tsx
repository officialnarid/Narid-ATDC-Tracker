import React, { useState, useEffect } from 'react';
import { Clock, Play, CheckCircle2, ScanLine, LogOut, Menu } from 'lucide-react';
import { runAutoCloseShiftsEngine, getKolkataTimeParts } from '../services/attendanceService';
import { isModuleAllowedForUser } from '../services/authService';
import { getSafeErrorText } from '../services/errorHandlingService';
import { Shift, UserRoleRecord } from '../types';

interface HeaderProps {
  shifts: Shift[];
  onOpenScanner: () => void;
  onRefreshData?: () => void;
  currentUserRole?: UserRoleRecord | null;
  onLogout?: () => void;
  onToggleMobileNav?: () => void;
}

export const Header: React.FC<HeaderProps> = ({ 
  shifts, 
  onOpenScanner, 
  onRefreshData,
  currentUserRole,
  onLogout,
  onToggleMobileNav
}) => {
  const [currentTime, setCurrentTime] = useState<Date>(new Date());
  const [isRunningAutoClose, setIsRunningAutoClose] = useState(false);
  const [autoCloseMessage, setAutoCloseMessage] = useState<string | null>(null);
  const isAutoCloseInFlightRef = React.useRef(false);
  const onRefreshDataRef = React.useRef(onRefreshData);
  onRefreshDataRef.current = onRefreshData;

  const normalizedRole = String(currentUserRole?.role || 'USER').toUpperCase();
  const canRunAutoClose =
    normalizedRole === 'SUPER_ADMIN' ||
    normalizedRole === 'ADMIN' ||
    (normalizedRole !== 'USER' &&
      Array.isArray(currentUserRole?.modulesAllowed) &&
      (currentUserRole.modulesAllowed.includes('all') ||
        currentUserRole.modulesAllowed.includes('shifts') ||
        currentUserRole.modulesAllowed.includes('history')));
  const canOpenScanner = isModuleAllowedForUser(currentUserRole, 'scanner');

  // Live Clock (Asia/Kolkata)
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Periodic automatic shift closing runner (every 60 seconds, Admin / Super Admin only)
  useEffect(() => {
    if (!canRunAutoClose) return;
    const autoCloseInterval = setInterval(async () => {
      if (isAutoCloseInFlightRef.current) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      isAutoCloseInFlightRef.current = true;
      try {
        const res = await runAutoCloseShiftsEngine({ silent: true });
        if (res.closedCount > 0) {
          setAutoCloseMessage(`Auto-closed ${res.closedCount} missed punch-outs`);
          setTimeout(() => setAutoCloseMessage(null), 8000);
          onRefreshDataRef.current?.();
        }
      } catch (err) {
        console.warn('Periodic shift auto close error:', err);
      } finally {
        isAutoCloseInFlightRef.current = false;
      }
    }, 60000);

    return () => clearInterval(autoCloseInterval);
  }, [canRunAutoClose]);

  const handleManualAutoClose = async () => {
    if (!canRunAutoClose || isAutoCloseInFlightRef.current) return;
    isAutoCloseInFlightRef.current = true;
    setIsRunningAutoClose(true);
    setAutoCloseMessage(null);
    try {
      const res = await runAutoCloseShiftsEngine();
      if (res.closedCount > 0) {
        setAutoCloseMessage(`Shift closing check: Automatically closed ${res.closedCount} open records.`);
      } else {
        setAutoCloseMessage('Shift closing check: No open shifts past scheduled end.');
      }
      setTimeout(() => setAutoCloseMessage(null), 6000);
      onRefreshDataRef.current?.();
    } catch (err) {
      setAutoCloseMessage(
        getSafeErrorText(err, {
          moduleName: 'Attendance Auto-Close',
          endpoint: '/api/attendance/auto-close',
        })
      );
    } finally {
      isAutoCloseInFlightRef.current = false;
      setIsRunningAutoClose(false);
    }
  };

  // Determine active shift in Asia/Kolkata
  const kolkata = getKolkataTimeParts(currentTime);
  const currentMinutes = kolkata.totalMinutes;

  let activeShiftLabel = 'DAY SHIFT (09:00 - 17:30)';
  let activeShiftColor = 'bg-blue-100 text-blue-800 border-blue-300';
  if (currentMinutes >= 20 * 60 || currentMinutes < 9 * 60) {
    activeShiftLabel = 'NIGHT SHIFT (20:00 - 04:30)';
    activeShiftColor = 'bg-purple-100 text-purple-800 border-purple-300';
  }

  const formattedDate = currentTime.toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });

  const formattedTime = kolkata.timeWithSeconds;

  return (
    <header className="bg-white border-b border-slate-200 px-4 sm:px-6 py-3 flex items-center justify-between shrink-0 shadow-xs">
      {/* Shift status, Mobile Menu Toggle & Date */}
      <div className="flex items-center gap-3">
        {onToggleMobileNav && (
          <button
            type="button"
            onClick={onToggleMobileNav}
            className="md:hidden p-1.5 rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-100 border border-slate-200 transition cursor-pointer"
            title="Open navigation menu"
          >
            <Menu className="w-5 h-5" />
          </button>
        )}

        <div className={`px-2.5 py-1 rounded text-xs font-semibold border flex items-center gap-1.5 ${activeShiftColor}`}>
          <span className="w-2 h-2 rounded-full bg-current animate-pulse"></span>
          <span>{activeShiftLabel}</span>
        </div>

        <div className="text-sm font-medium text-slate-600 border-l border-slate-200 pl-3 hidden md:block">
          {formattedDate}
        </div>
      </div>

      {/* Auto-Close status notice */}
      {autoCloseMessage && (
        <div className="text-xs bg-emerald-50 text-emerald-800 border border-emerald-300 px-3 py-1 rounded flex items-center gap-1.5 animate-fadeIn">
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
          <span>{autoCloseMessage}</span>
        </div>
      )}

      {/* Right Tools: Live Clock, Auto-close Trigger, Dedicated Scanner Launch */}
      <div className="flex items-center gap-3">
        {/* Live Industrial Clock */}
        <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 px-3 py-1.5 rounded text-slate-800 font-mono text-sm font-semibold tracking-wider">
          <Clock className="w-4 h-4 text-blue-600" />
          <span>{formattedTime}</span>
          <span className="text-[10px] text-slate-500 font-sans uppercase">IST</span>
        </div>

        {/* Scheduled Shift Auto-Close Trigger (Admin / Super Admin Only) */}
        {canRunAutoClose && (
          <button
            onClick={handleManualAutoClose}
            disabled={isRunningAutoClose}
            title="Run Scheduled Auto-Closing check on open attendance past shift end"
            className="flex items-center gap-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 border border-slate-300 px-2.5 py-1.5 rounded transition disabled:opacity-50"
          >
            <Play className={`w-3.5 h-3.5 text-slate-600 ${isRunningAutoClose ? 'animate-spin' : ''}`} />
            <span className="hidden lg:inline">{isRunningAutoClose ? 'Checking...' : 'Run Auto-Close'}</span>
          </button>
        )}

        {/* Dedicated Scanner CTA */}
        {canOpenScanner && (
          <button
            onClick={onOpenScanner}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium text-xs px-3.5 py-1.5 rounded shadow-sm transition cursor-pointer"
          >
            <ScanLine className="w-4 h-4" />
            <span>Open Scanner</span>
          </button>
        )}

        {/* User Profile & Logout */}
        {currentUserRole && (
          <div className="flex items-center gap-2 border-l border-slate-200 pl-3">
            <div className="hidden sm:flex flex-col items-end text-right">
              <span className="text-xs font-bold text-slate-800 leading-tight truncate max-w-[130px]">
                {typeof currentUserRole.name === 'string' ? currentUserRole.name : (currentUserRole.name as any)?.name || currentUserRole.loginId}
              </span>
              <span className="text-[10px] font-mono font-bold text-blue-600 uppercase tracking-wider">
                {String(currentUserRole.role || 'USER').replace('_', ' ').toUpperCase()}
              </span>
            </div>
            {onLogout && (
              <button
                onClick={onLogout}
                title="Sign Out of Narid ATDC Tracker"
                className="p-1.5 rounded-lg text-slate-500 hover:text-red-600 hover:bg-red-50 border border-slate-200 transition flex items-center gap-1 text-xs font-medium"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span className="hidden md:inline">Sign Out</span>
              </button>
            )}
          </div>
        )}
      </div>
    </header>
  );
};
