import React, { useState } from 'react';
import { WifiOff, RefreshCw, LogOut, ShieldAlert } from 'lucide-react';
import type { UserRoleRecord } from '../types';
import { COMPANY_WIFI_DENIED_MESSAGE } from '../utils/companyWifiUtils';
import {
  checkMyCompanyWifiAccess,
  type CompanyWifiBlockedState,
} from '../services/companyWifiService';

interface CompanyWifiBlockedScreenProps {
  currentUserRole: UserRoleRecord;
  blockedState: CompanyWifiBlockedState;
  onAccessRestored: () => void;
  onLogout: () => void;
}

export const CompanyWifiBlockedScreen: React.FC<CompanyWifiBlockedScreenProps> = ({
  currentUserRole,
  blockedState,
  onAccessRestored,
  onLogout,
}) => {
  const [isRechecking, setIsRechecking] = useState(false);
  const [statusNote, setStatusNote] = useState<string | null>(null);

  const handleRecheck = async () => {
    setIsRechecking(true);
    setStatusNote(null);
    try {
      const res = await checkMyCompanyWifiAccess();
      if (res.allowed) {
        onAccessRestored();
      } else {
        setStatusNote(res.error || COMPANY_WIFI_DENIED_MESSAGE);
      }
    } catch {
      setStatusNote(COMPANY_WIFI_DENIED_MESSAGE);
    } finally {
      setIsRechecking(false);
    }
  };

  return (
    <div className="min-h-screen w-screen bg-slate-100 flex items-center justify-center p-4 font-sans antialiased">
      <div className="max-w-md w-full bg-white rounded-2xl border border-slate-200 shadow-lg overflow-hidden">
        <div className="bg-[#0a192f] px-6 py-5 flex items-center gap-3 text-white">
          <div className="w-11 h-11 rounded-xl bg-red-500/20 border border-red-400/30 flex items-center justify-center shrink-0">
            <WifiOff className="w-6 h-6 text-red-300" />
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight">Company Wi-Fi Required</h1>
            <p className="text-xs text-slate-300">NARID ATDC Tracker Access Control</p>
          </div>
        </div>

        <div className="p-6 space-y-4">
          <div className="p-4 rounded-xl bg-red-50 border border-red-200 flex items-start gap-3">
            <ShieldAlert className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
            <div className="text-sm text-red-900 font-medium leading-relaxed">
              {statusNote || blockedState.message || COMPANY_WIFI_DENIED_MESSAGE}
            </div>
          </div>

          <div className="text-xs text-slate-600 bg-slate-50 rounded-lg p-3.5 border border-slate-200 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-slate-500">Signed-in Account:</span>
              <span className="font-semibold text-slate-800">{currentUserRole.loginId}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500">Assigned Role:</span>
              <span className="font-mono font-bold uppercase text-slate-800">
                {String(currentUserRole.role || '').replace('_', ' ')}
              </span>
            </div>
          </div>

          <p className="text-xs text-slate-500 leading-relaxed">
            Connect your device to an authorized Company Wi-Fi network, then click <strong>Re-check Connection</strong>. If you believe this is an error, contact your Super Admin.
          </p>

          <div className="flex flex-col sm:flex-row gap-2.5 pt-1">
            <button
              type="button"
              disabled={isRechecking}
              onClick={() => void handleRecheck()}
              className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-xs font-semibold shadow-xs transition cursor-pointer"
            >
              <RefreshCw className={`w-4 h-4 ${isRechecking ? 'animate-spin' : ''}`} />
              {isRechecking ? 'Checking Network...' : 'Re-check Connection'}
            </button>

            <button
              type="button"
              onClick={onLogout}
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold transition cursor-pointer"
            >
              <LogOut className="w-4 h-4" />
              Sign Out
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
