import React, { useState } from 'react';
import { 
  KeyRound, 
  Lock, 
  Eye, 
  EyeOff, 
  ShieldCheck, 
  AlertCircle, 
  CheckCircle2,
  Check,
  X
} from 'lucide-react';
import { UserRoleRecord } from '../types';
import { changeInitialPassword } from '../services/authService';

interface PasswordChangeModalProps {
  userProfile: UserRoleRecord;
  onPasswordChanged: (updatedProfile: UserRoleRecord) => void;
  onCancelLogout: () => void;
}

export const PasswordChangeModal: React.FC<PasswordChangeModalProps> = ({
  userProfile,
  onPasswordChanged,
  onCancelLogout,
}) => {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Validation rules
  const hasCurrentPassword = currentPassword.length > 0;
  const hasMinLength = newPassword.length >= 6;
  const isDifferentFromCurrent =
    newPassword.length > 0 && currentPassword.length > 0 && newPassword !== currentPassword;
  const passwordsMatch = newPassword.length > 0 && newPassword === confirmPassword;
  const isValid = hasCurrentPassword && hasMinLength && isDifferentFromCurrent && passwordsMatch;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (!hasCurrentPassword) {
      setErrorMessage('Please enter your current or temporary password to verify your identity.');
      return;
    }
    if (!hasMinLength) {
      setErrorMessage('New password must contain at least 6 characters.');
      return;
    }
    if (!isDifferentFromCurrent) {
      setErrorMessage('Please choose a new password different from your current password.');
      return;
    }
    if (!passwordsMatch) {
      setErrorMessage('Passwords do not match. Please verify both fields.');
      return;
    }

    setIsLoading(true);
    try {
      await changeInitialPassword(newPassword, currentPassword);
      const updatedProfile: UserRoleRecord = {
        ...userProfile,
        mustChangePassword: false,
        forcePasswordChange: false,
        passwordLastChangedAt: new Date().toISOString(),
      };
      onPasswordChanged(updatedProfile);
    } catch (err: any) {
      console.error('Password change error:', err?.message || 'Password update failed');
      setErrorMessage(err?.message || 'Failed to update password. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-[#001433]/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-3xl shadow-[0_25px_60px_-15px_rgba(0,0,0,0.5)] border border-slate-200 overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        
        {/* Header Bar */}
        <div className="bg-[#00183b] p-6 text-white text-center relative">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-blue-600 to-cyan-400 flex items-center justify-center mx-auto mb-3 shadow-lg shadow-blue-500/30">
            <KeyRound className="w-6 h-6 text-white" />
          </div>
          <h2 className="text-xl font-black tracking-wide text-white">
            First-Time Login Security
          </h2>
          <p className="text-xs text-blue-200/90 mt-1 max-w-xs mx-auto leading-relaxed">
            For security compliance, enter your current or temporary password and set a new confidential password before accessing the system.
          </p>

          <div className="mt-3 inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-900/60 border border-blue-400/30 text-xs font-mono text-cyan-300">
            <span>Account:</span>
            <span className="font-bold text-white">{userProfile.loginId}</span>
            <span className="text-blue-300">({userProfile.role})</span>
          </div>
        </div>

        {/* Form Body */}
        <div className="p-6 sm:p-8">
          {errorMessage && (
            <div className="mb-5 p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
              <div className="leading-relaxed font-medium">{errorMessage}</div>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Current / Temporary Password */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5 uppercase tracking-wider">
                Current / Temporary Password
              </label>
              <div className="relative flex items-center rounded-xl border border-slate-200 bg-slate-50 focus-within:bg-white focus-within:border-blue-600 focus-within:ring-2 focus-within:ring-blue-100 transition-all">
                <div className="pl-3.5 pr-2 text-slate-400">
                  <KeyRound className="w-5 h-5" />
                </div>
                <input
                  type={showCurrentPassword ? 'text' : 'password'}
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  placeholder="Enter your current or temporary password"
                  autoComplete="current-password"
                  required
                  className="w-full py-2.5 pr-10 text-sm text-slate-900 bg-transparent border-none focus:outline-hidden font-medium placeholder:text-slate-400"
                />
                <button
                  type="button"
                  onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                  className="absolute right-3 p-1 text-slate-400 hover:text-slate-600 focus:outline-hidden"
                >
                  {showCurrentPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* New Password */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5 uppercase tracking-wider">
                New Password
              </label>
              <div className="relative flex items-center rounded-xl border border-slate-200 bg-slate-50 focus-within:bg-white focus-within:border-blue-600 focus-within:ring-2 focus-within:ring-blue-100 transition-all">
                <div className="pl-3.5 pr-2 text-slate-400">
                  <Lock className="w-5 h-5" />
                </div>
                <input
                  type={showNewPassword ? 'text' : 'password'}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Enter your new confidential password"
                  autoComplete="new-password"
                  required
                  className="w-full py-2.5 pr-10 text-sm text-slate-900 bg-transparent border-none focus:outline-hidden font-medium placeholder:text-slate-400"
                />
                <button
                  type="button"
                  onClick={() => setShowNewPassword(!showNewPassword)}
                  className="absolute right-3 p-1 text-slate-400 hover:text-slate-600 focus:outline-hidden"
                >
                  {showNewPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Confirm New Password */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5 uppercase tracking-wider">
                Confirm New Password
              </label>
              <div className="relative flex items-center rounded-xl border border-slate-200 bg-slate-50 focus-within:bg-white focus-within:border-blue-600 focus-within:ring-2 focus-within:ring-blue-100 transition-all">
                <div className="pl-3.5 pr-2 text-slate-400">
                  <Lock className="w-5 h-5" />
                </div>
                <input
                  type={showConfirmPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Re-enter your new password"
                  autoComplete="new-password"
                  required
                  className="w-full py-2.5 pr-10 text-sm text-slate-900 bg-transparent border-none focus:outline-hidden font-medium placeholder:text-slate-400"
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  className="absolute right-3 p-1 text-slate-400 hover:text-slate-600 focus:outline-hidden"
                >
                  {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Requirement Checklist */}
            <div className="p-3 bg-slate-50 rounded-xl border border-slate-200/60 space-y-1.5 text-xs">
              <div className="flex items-center gap-2">
                {hasCurrentPassword ? (
                  <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                ) : (
                  <div className="w-3.5 h-3.5 rounded-full border border-slate-300 shrink-0" />
                )}
                <span className={hasCurrentPassword ? 'text-emerald-700 font-medium' : 'text-slate-500'}>
                  Current or temporary password entered
                </span>
              </div>

              <div className="flex items-center gap-2">
                {hasMinLength ? (
                  <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                ) : (
                  <div className="w-3.5 h-3.5 rounded-full border border-slate-300 shrink-0" />
                )}
                <span className={hasMinLength ? 'text-emerald-700 font-medium' : 'text-slate-500'}>
                  At least 6 characters
                </span>
              </div>

              <div className="flex items-center gap-2">
                {isDifferentFromCurrent ? (
                  <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                ) : (
                  <div className="w-3.5 h-3.5 rounded-full border border-slate-300 shrink-0" />
                )}
                <span className={isDifferentFromCurrent ? 'text-emerald-700 font-medium' : 'text-slate-500'}>
                  Different from current password
                </span>
              </div>

              <div className="flex items-center gap-2">
                {passwordsMatch ? (
                  <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                ) : (
                  <div className="w-3.5 h-3.5 rounded-full border border-slate-300 shrink-0" />
                )}
                <span className={passwordsMatch ? 'text-emerald-700 font-medium' : 'text-slate-500'}>
                  Passwords match
                </span>
              </div>
            </div>

            {/* Buttons */}
            <div className="pt-2 flex flex-col gap-2">
              <button
                type="submit"
                disabled={isLoading || !isValid}
                className="w-full bg-gradient-to-r from-blue-600 via-blue-700 to-indigo-700 hover:from-blue-700 hover:to-indigo-800 active:scale-[0.99] text-white font-bold py-3 px-4 rounded-xl shadow-lg shadow-blue-600/30 flex items-center justify-center gap-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed text-xs uppercase tracking-wider"
              >
                {isLoading ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span>Updating Password...</span>
                  </>
                ) : (
                  <>
                    <ShieldCheck className="w-4 h-4" />
                    <span>Set Password & Proceed</span>
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={onCancelLogout}
                className="w-full py-2 text-xs font-semibold text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-xl transition"
              >
                Cancel & Sign Out
              </button>
            </div>
          </form>
        </div>

      </div>
    </div>
  );
};
