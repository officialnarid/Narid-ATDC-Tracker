import React from 'react';
import { ShieldAlert, ArrowLeft, Lock } from 'lucide-react';
import { UserRoleRecord } from '../types';
import { NavItem } from './Sidebar';

interface UnauthorizedAccessProps {
  currentTab: NavItem;
  currentUserRole: UserRoleRecord;
  onGoHome: () => void;
}

export function UnauthorizedAccess({ currentTab, currentUserRole, onGoHome }: UnauthorizedAccessProps) {
  const roleDisplay = (currentUserRole.role || 'user').toUpperCase().replace('_', ' ');

  const isSuperAdminRestrictedTab =
    currentTab === 'user_rights' ||
    currentTab === 'audit_logs' ||
    currentTab === 'security_management' ||
    currentTab === 'system_performance';

  return (
    <div className="h-full w-full flex items-center justify-center p-6 bg-slate-900 text-white">
      <div className="max-w-md w-full bg-slate-950 border border-red-500/30 rounded-2xl p-8 shadow-2xl text-center flex flex-col items-center">
        <div className="w-16 h-16 rounded-2xl bg-red-500/10 border border-red-500/30 flex items-center justify-center mb-5 text-red-400">
          <ShieldAlert className="w-8 h-8" />
        </div>

        <span className="text-xs font-mono uppercase tracking-widest text-red-400 mb-1">
          HTTP 403 • ACCESS DENIED
        </span>

        <h2 className="text-2xl font-bold text-white mb-2">
          Unauthorized Access
        </h2>

        <p className="text-sm text-slate-400 mb-6 leading-relaxed">
          Your current account role (<span className="text-blue-400 font-semibold">{roleDisplay}</span>) does not possess authorized privileges to access the <span className="text-amber-400 font-mono font-medium uppercase">{currentTab.replace('_', ' ')}</span> module.
        </p>

        <div className="w-full bg-slate-900/80 rounded-xl p-4 border border-slate-800 text-left mb-6 text-xs text-slate-400 space-y-1">
          <div className="flex items-center gap-2 text-slate-300 font-medium pb-1 border-b border-slate-800">
            <Lock className="w-3.5 h-3.5 text-red-400" />
            Security Route Guard Active
          </div>
          <div className="flex justify-between pt-1">
            <span>User ID:</span>
            <span className="font-mono text-slate-200">{currentUserRole.loginId}</span>
          </div>
          <div className="flex justify-between">
            <span>Required Authorization:</span>
            <span className="font-mono text-amber-300">
              {isSuperAdminRestrictedTab ? 'SUPER_ADMIN Only' : 'SUPER_ADMIN / Authorized Role'}
            </span>
          </div>
        </div>

        <button
          onClick={onGoHome}
          className="w-full py-3 px-4 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-medium rounded-xl flex items-center justify-center gap-2 shadow-lg shadow-blue-900/30 transition-all cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          Return to Authorized Station
        </button>
      </div>
    </div>
  );
}
