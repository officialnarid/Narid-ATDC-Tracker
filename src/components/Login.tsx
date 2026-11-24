import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  User, 
  Lock, 
  Eye, 
  EyeOff, 
  LogIn, 
  ShieldCheck, 
  AlertCircle, 
  Calendar,
  QrCode,
  Users,
  BarChart3,
  Clock,
  CheckCircle2,
  RefreshCw
} from 'lucide-react';
import {
  loginWithLoginIdAndPassword,
  fetchSuperAdminLockoutStatus,
  LoginAuthError,
} from '../services/authService';
import { UserRoleRecord } from '../types';
import { getSafeErrorText } from '../services/errorHandlingService';
import { containsRawTechnicalLeak } from '../utils/errorRegistry';

export interface ServerTempLockoutState {
  loginId: string;
  lockoutUntil: string;
  lockedUntilMs: number;
  lockDurationMinutes: number | null;
  clockOffsetMs: number;
}

export interface ServerLockoutPayload {
  locked?: boolean;
  temporaryLock?: boolean;
  loginId?: string;
  lockoutUntil?: string | null;
  lockedUntil?: string | null;
  lockedUntilMs?: number | null;
  serverNowMs?: number | null;
  remainingSeconds?: number | null;
  lockDurationMinutes?: number | null;
}

export function formatCountdownSeconds(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function computeRemainingLockoutSeconds(
  lockedUntilMs: number,
  clockOffsetMs = 0,
  clientNowMs = Date.now()
): number {
  const estimatedServerNowMs = clientNowMs + clockOffsetMs;
  const remainingMs = lockedUntilMs - estimatedServerNowMs;
  if (remainingMs <= 0) return 0;
  return Math.ceil(remainingMs / 1000);
}

export function deriveServerLockoutState(
  payload: ServerLockoutPayload | null | undefined,
  clientNowMs = Date.now()
): ServerTempLockoutState | null {
  if (!payload || !payload.temporaryLock || payload.locked === false) {
    return null;
  }

  const rawIso = payload.lockoutUntil || payload.lockedUntil || null;
  let lockedUntilMs: number | null =
    typeof payload.lockedUntilMs === 'number' && Number.isFinite(payload.lockedUntilMs) && payload.lockedUntilMs > 0
      ? payload.lockedUntilMs
      : null;

  if (lockedUntilMs === null && rawIso) {
    const parsed = Date.parse(rawIso);
    if (Number.isFinite(parsed) && parsed > 0) {
      lockedUntilMs = parsed;
    }
  }

  const effectiveServerNowMs =
    typeof payload.serverNowMs === 'number' && Number.isFinite(payload.serverNowMs)
      ? payload.serverNowMs
      : clientNowMs;

  if (
    lockedUntilMs === null &&
    typeof payload.remainingSeconds === 'number' &&
    Number.isFinite(payload.remainingSeconds) &&
    payload.remainingSeconds > 0
  ) {
    lockedUntilMs = effectiveServerNowMs + Math.ceil(payload.remainingSeconds) * 1000;
  }

  if (lockedUntilMs === null) {
    return null;
  }

  const clockOffsetMs =
    typeof payload.serverNowMs === 'number' && Number.isFinite(payload.serverNowMs)
      ? payload.serverNowMs - clientNowMs
      : 0;

  const remaining = computeRemainingLockoutSeconds(lockedUntilMs, clockOffsetMs, clientNowMs);
  if (remaining <= 0) {
    return null;
  }

  return {
    loginId: (payload.loginId || 'superadmin').trim().toLowerCase(),
    lockoutUntil: rawIso || new Date(lockedUntilMs).toISOString(),
    lockedUntilMs,
    lockDurationMinutes:
      typeof payload.lockDurationMinutes === 'number' && Number.isFinite(payload.lockDurationMinutes)
        ? payload.lockDurationMinutes
        : null,
    clockOffsetMs,
  };
}

interface LoginProps {
  onLoginSuccess: (profile: UserRoleRecord) => void;
}

interface LoginAlertState {
  message: string;
  tone: 'error' | 'warning' | 'locked' | 'ratelimit' | 'ready';
  attemptNumber?: number;
  maxAttempts?: number;
  remainingAttempts?: number;
}

export const Login: React.FC<LoginProps> = ({ onLoginSuccess }) => {
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [alertState, setAlertState] = useState<LoginAlertState | null>(null);
  const [tempLockout, setTempLockout] = useState<ServerTempLockoutState | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState<number>(0);
  const [isVerifyingExpiry, setIsVerifyingExpiry] = useState(false);
  const [expiryVerificationError, setExpiryVerificationError] = useState<string | null>(null);

  const isMountedRef = useRef(true);
  const verifyingExpiryRef = useRef(false);
  const retryTimerRef = useRef<number | null>(null);
  const lastQueriedLoginIdRef = useRef<string>('');

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
      }
    };
  }, []);

  const syncLockoutStatusFromServer = useCallback(
    async (opts?: { isExpiryRecheck?: boolean; targetLoginId?: string }): Promise<boolean> => {
      const isExpiryRecheck = Boolean(opts?.isExpiryRecheck);
      if (isExpiryRecheck) {
        if (verifyingExpiryRef.current) return false;
        verifyingExpiryRef.current = true;
        if (isMountedRef.current) {
          setIsVerifyingExpiry(true);
          setExpiryVerificationError(null);
        }
      }

      try {
        const status = await fetchSuperAdminLockoutStatus(opts?.targetLoginId ?? 'superadmin');
        if (!isMountedRef.current) return false;

        if (!status) {
          if (isExpiryRecheck) {
            // Never blindly unlock if server could not be reached — retry shortly
            setExpiryVerificationError('Unable to verify expiry with server. Retrying...');
            retryTimerRef.current = window.setTimeout(() => {
              verifyingExpiryRef.current = false;
              void syncLockoutStatusFromServer({
                isExpiryRecheck: true,
                targetLoginId: 'superadmin',
              });
            }, 2000);
          }
          return false;
        }

        const clientNowMs = Date.now();
        const derived = deriveServerLockoutState(status, clientNowMs);

        if (derived) {
          const rem = computeRemainingLockoutSeconds(
            derived.lockedUntilMs,
            derived.clockOffsetMs,
            clientNowMs
          );
          setTempLockout(derived);
          setRemainingSeconds(rem);
          setExpiryVerificationError(null);
          setAlertState((prev) => (prev?.tone === 'locked' ? null : prev));
          if (isExpiryRecheck) {
            setIsVerifyingExpiry(false);
            verifyingExpiryRef.current = false;
          }
          return true;
        }

        // If backend still asserts locked=true at a sub-second boundary, NEVER unlock prematurely
        if (status.locked && status.temporaryLock) {
          retryTimerRef.current = window.setTimeout(() => {
            verifyingExpiryRef.current = false;
            void syncLockoutStatusFromServer({
              isExpiryRecheck: true,
              targetLoginId: 'superadmin',
            });
          }, 1000);
          return true;
        }

        // Backend independently confirmed account is NOT locked (or lockoutUntil <= serverNowMs)
        setTempLockout(null);
        setRemainingSeconds(0);
        setExpiryVerificationError(null);
        if (isExpiryRecheck) {
          setIsVerifyingExpiry(false);
          verifyingExpiryRef.current = false;
          setAlertState({
            tone: 'ready',
            message: 'Account is now active. You may sign in again.',
          });
        }
        return false;
      } catch {
        if (!isMountedRef.current) return false;
        if (isExpiryRecheck) {
          setExpiryVerificationError('Unable to verify expiry with server. Retrying...');
          retryTimerRef.current = window.setTimeout(() => {
            verifyingExpiryRef.current = false;
            void syncLockoutStatusFromServer({
              isExpiryRecheck: true,
              targetLoginId: 'superadmin',
            });
          }, 2000);
        }
        return false;
      }
    },
    []
  );

  // Hydrate authoritative Super Admin lockout status from backend on mount
  // (Handles browser refresh & multi-device sync without using browser storage)
  useEffect(() => {
    void syncLockoutStatusFromServer({ targetLoginId: 'superadmin' });
  }, [syncLockoutStatusFromServer]);

  // Query backend lockout-status whenever canonical "superadmin" login ID is entered
  useEffect(() => {
    const clean = loginId.trim().toLowerCase();
    if (clean !== 'superadmin') {
      lastQueriedLoginIdRef.current = clean;
      return;
    }
    if (lastQueriedLoginIdRef.current === 'superadmin') {
      return;
    }
    const timer = window.setTimeout(() => {
      lastQueriedLoginIdRef.current = 'superadmin';
      void syncLockoutStatusFromServer({ targetLoginId: 'superadmin' });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [loginId, syncLockoutStatusFromServer]);

  // Live 1-second server-offset countdown; MUST re-verify with backend at 00:00 before enabling login
  useEffect(() => {
    if (!tempLockout) {
      setRemainingSeconds(0);
      return;
    }

    const tick = () => {
      const rem = computeRemainingLockoutSeconds(
        tempLockout.lockedUntilMs,
        tempLockout.clockOffsetMs
      );
      setRemainingSeconds(rem);
      if (rem <= 0 && !verifyingExpiryRef.current) {
        void syncLockoutStatusFromServer({
          isExpiryRecheck: true,
          targetLoginId: 'superadmin',
        });
      }
    };

    tick();
    const intervalId = window.setInterval(tick, 1000);
    return () => window.clearInterval(intervalId);
  }, [tempLockout, syncLockoutStatusFromServer]);

  const cleanLoginId = loginId.trim().toLowerCase();
  const showSuperAdminTempLockout = Boolean(
    tempLockout && (cleanLoginId === '' || cleanLoginId === 'superadmin')
  );
  const isTempLockBlockingSubmit = Boolean(
    tempLockout &&
      (remainingSeconds > 0 || isVerifyingExpiry) &&
      (cleanLoginId === '' || cleanLoginId === 'superadmin')
  );

  // Handle Sign In submission
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isTempLockBlockingSubmit) {
      return;
    }
    setAlertState(null);

    if (!loginId.trim()) {
      setAlertState({ message: 'Please enter your Login ID.', tone: 'error' });
      return;
    }
    if (!password) {
      setAlertState({ message: 'Please enter your password.', tone: 'error' });
      return;
    }

    setIsLoading(true);
    try {
      const { profile } = await loginWithLoginIdAndPassword(loginId, password, true);
      setTempLockout(null);
      setRemainingSeconds(0);
      setIsVerifyingExpiry(false);
      verifyingExpiryRef.current = false;
      onLoginSuccess(profile);
    } catch (err: any) {
      const authErr = err as LoginAuthError;
      const rawMsg = authErr?.message || 'Invalid password, check again';

      const derived = deriveServerLockoutState(
        {
          locked: authErr?.locked,
          temporaryLock: authErr?.temporaryLock,
          loginId: loginId.trim().toLowerCase(),
          lockoutUntil: authErr?.lockoutUntil || authErr?.lockedUntil,
          lockedUntil: authErr?.lockedUntil,
          lockedUntilMs: authErr?.lockedUntilMs,
          serverNowMs: authErr?.serverNowMs,
          remainingSeconds: authErr?.remainingSeconds,
          lockDurationMinutes: authErr?.lockDurationMinutes,
        },
        Date.now()
      );

      if (derived) {
        const rem = computeRemainingLockoutSeconds(derived.lockedUntilMs, derived.clockOffsetMs);
        setTempLockout(derived);
        setRemainingSeconds(rem);
        setIsVerifyingExpiry(false);
        setExpiryVerificationError(null);
        verifyingExpiryRef.current = false;
        setAlertState(null);
      } else if (
        authErr?.locked ||
        authErr?.code === 'ACCOUNT_LOCKED' ||
        authErr?.status === 423 ||
        rawMsg.includes('temporarily blocked')
      ) {
        // If canonical Super Admin received 423 without timer metadata, verify authoritative status from backend
        if (loginId.trim().toLowerCase() === 'superadmin') {
          const recoveredTempLock = await syncLockoutStatusFromServer({
            targetLoginId: 'superadmin',
          });
          if (recoveredTempLock) {
            return;
          }
        }
        setAlertState({
          message: rawMsg,
          tone: 'locked',
          attemptNumber: authErr.attemptNumber,
          maxAttempts: authErr.maxAttempts,
          remainingAttempts: 0,
        });
      } else if (authErr?.warning || authErr?.code === 'SECOND_FAILED_WARNING') {
        setAlertState({
          message: rawMsg,
          tone: 'warning',
          attemptNumber: authErr.attemptNumber,
          maxAttempts: authErr.maxAttempts,
          remainingAttempts: authErr.remainingAttempts,
        });
      } else if (
        authErr?.firebaseAbuseProtection ||
        authErr?.code === 'RATE_LIMITED' ||
        authErr?.code === 'TOO_MANY_ATTEMPTS_TRY_LATER'
      ) {
        setAlertState({
          message: rawMsg,
          tone: 'ratelimit',
        });
      } else if (
        authErr?.code === 'FIREBASE_ADMIN_PERMISSION_DENIED' ||
        authErr?.code === 'FIREBASE_ADMIN_UNCONFIGURED'
      ) {
        setAlertState({
          message: getSafeErrorText(err, {
            moduleName: 'Authentication',
            endpoint: '/api/auth/login',
            forcedErrorCode: 'DB-001',
          }),
          tone: 'warning',
        });
      } else {
        const safeMessage = containsRawTechnicalLeak(rawMsg)
          ? getSafeErrorText(err, {
              moduleName: 'Authentication',
              endpoint: '/api/auth/login',
            })
          : rawMsg;
        setAlertState({
          message: safeMessage,
          tone: 'error',
          attemptNumber: authErr.attemptNumber,
          maxAttempts: authErr.maxAttempts,
          remainingAttempts: authErr.remainingAttempts,
        });
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen w-screen flex flex-col lg:flex-row bg-[#edf2f7] text-slate-800 font-sans overflow-x-hidden select-none">
      
      {/* ================= LEFT SECTION (60% Width on Desktop): Industrial Hero Design ================= */}
      <div className="lg:w-[60%] relative bg-[#001438] flex flex-col justify-between overflow-hidden p-6 sm:p-8 lg:p-10 text-white z-10 shadow-2xl">
        
        {/* Background Multi-Layer Deep Industrial Blue Gradients & Waves */}
        <div className="absolute inset-0 bg-gradient-to-br from-[#000e29] via-[#001740] to-[#00245e] pointer-events-none" />
        <div className="absolute -top-24 -left-24 w-96 h-96 rounded-full bg-blue-500/15 blur-3xl pointer-events-none" />
        <div className="absolute top-1/3 -right-20 w-80 h-80 rounded-full bg-cyan-500/10 blur-3xl pointer-events-none" />

        {/* Top Branding Section */}
        <div className="relative z-10 flex flex-col items-start">
          <div className="flex items-center gap-3.5">
            {/* Original Uploaded ENR Logo */}
            <div className="p-1 rounded-lg bg-black/60 border border-white/20 shadow-md">
              <img 
                src="/assets/aistudio/image_f76489f6.png" 
                alt="NARID ENR" 
                className="h-10 sm:h-12 w-auto object-contain"
              />
            </div>
            
            {/* Vertical Divider & Corporate Subtext */}
            <div className="border-l border-white/30 pl-3.5">
              <span className="text-[10px] sm:text-[11px] tracking-widest uppercase text-slate-200 font-semibold block leading-tight">
                BUILT FOR A BRIGHTER TOMORROW
              </span>
              <span className="text-xs sm:text-sm text-white font-bold tracking-wider block mt-0.5">
                PRECISION INDUSTRIAL CORP
              </span>
            </div>
          </div>

          {/* Main Heading */}
          <h1 className="text-3xl sm:text-4xl lg:text-[40px] font-black text-white tracking-wide mt-4 drop-shadow-md">
            NARID ATDC TRACKER
          </h1>

          {/* Industrial Attendance System Badge / Subtitle */}
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 mt-2 rounded-full bg-blue-600/30 border border-blue-400/40 text-blue-200 text-xs sm:text-sm font-bold tracking-wider uppercase backdrop-blur-xs">
            <span className="text-cyan-400">///</span>
            <span>INDUSTRIAL ATTENDANCE SYSTEM</span>
            <span className="text-cyan-400">///</span>
          </div>
        </div>

        {/* Main Industrial Image Container (Separate Container, object-cover, No Text Overlap) */}
        <div className="relative z-10 my-6 flex-1 flex items-center justify-center min-h-[300px] lg:min-h-[380px]">
          <div className="relative w-full h-full max-h-[50vh] rounded-2xl overflow-hidden shadow-[0_20px_50px_rgba(0,0,0,0.7)] border border-blue-400/25 bg-slate-950 group">
            <img
              src="/assets/factory-scanner-hero.png"
              alt="Industrial Factory Attendance Terminal with QR Scanner and Safety Employee"
              className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-[1.02]"
              draggable={false}
            />
            {/* Subtle Vignette to integrate seamlessly into dark navy card */}
            <div className="absolute inset-0 bg-gradient-to-t from-[#001438]/50 via-transparent to-black/20 pointer-events-none" />
            <div className="absolute inset-0 border border-white/10 rounded-2xl pointer-events-none" />
          </div>
        </div>

        {/* Bottom Feature Highlights Bar (4 Distinct Blocks with subtle dividers) */}
        <div className="relative z-10 grid grid-cols-2 sm:grid-cols-4 gap-2 pt-4 border-t border-blue-400/20 bg-[#001233]/40 rounded-xl px-2 py-3 backdrop-blur-xs">
          
          {/* Feature 1: Attendance Tracking */}
          <div className="flex flex-col items-center text-center p-2 sm:border-r sm:border-blue-400/20">
            <div className="w-8 h-8 rounded-lg bg-cyan-500/10 border border-cyan-400/20 flex items-center justify-center mb-1.5">
              <Calendar className="w-5 h-5 text-cyan-400" />
            </div>
            <span className="text-xs font-bold text-slate-100 leading-tight">
              Attendance
            </span>
            <span className="text-[11px] font-medium text-slate-300">
              Tracking
            </span>
          </div>

          {/* Feature 2: QR Based Punch In/Out */}
          <div className="flex flex-col items-center text-center p-2 sm:border-r sm:border-blue-400/20">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-400/20 flex items-center justify-center mb-1.5">
              <QrCode className="w-5 h-5 text-emerald-400" />
            </div>
            <span className="text-xs font-bold text-slate-100 leading-tight">
              QR Based
            </span>
            <span className="text-[11px] font-medium text-slate-300">
              Punch In/Out
            </span>
          </div>

          {/* Feature 3: Manpower Monitoring */}
          <div className="flex flex-col items-center text-center p-2 sm:border-r sm:border-blue-400/20">
            <div className="w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-400/20 flex items-center justify-center mb-1.5">
              <Users className="w-5 h-5 text-sky-400" />
            </div>
            <span className="text-xs font-bold text-slate-100 leading-tight">
              Manpower
            </span>
            <span className="text-[11px] font-medium text-slate-300">
              Monitoring
            </span>
          </div>

          {/* Feature 4: Reports & Analytics */}
          <div className="flex flex-col items-center text-center p-2">
            <div className="w-8 h-8 rounded-lg bg-amber-500/10 border border-amber-400/20 flex items-center justify-center mb-1.5">
              <BarChart3 className="w-5 h-5 text-amber-400" />
            </div>
            <span className="text-xs font-bold text-slate-100 leading-tight">
              Reports &
            </span>
            <span className="text-[11px] font-medium text-slate-300">
              Analytics
            </span>
          </div>
        </div>

        {/* Dynamic Curved Wave Graphic Divider on Desktop (Swooping gracefully toward right section) */}
        <div className="hidden lg:block absolute -right-1 top-0 bottom-0 w-16 pointer-events-none z-20 overflow-hidden">
          <svg 
            className="h-full w-full fill-[#edf2f7]" 
            viewBox="0 0 100 1000" 
            preserveAspectRatio="none"
          >
            <path d="M100,0 C60,250 85,500 20,750 C-10,870 5,950 100,1000 L100,0 Z" />
          </svg>
        </div>
        
        {/* Layered Blue Wave Accent across bottom curve */}
        <div className="absolute -bottom-8 -right-8 w-80 h-32 bg-gradient-to-r from-blue-600/40 via-cyan-500/30 to-transparent rounded-full blur-2xl pointer-events-none" />
      </div>

      {/* ================= RIGHT SECTION (40% Width on Desktop): Login Form Card ================= */}
      <div className="lg:w-[40%] flex items-center justify-center p-6 sm:p-10 lg:p-12 bg-gradient-to-br from-[#edf2f7] via-[#f1f5f9] to-[#e2e8f0] relative">
        
        {/* Centered Floating White Login Card */}
        <div className="w-full max-w-md bg-white rounded-3xl shadow-[0_20px_60px_-15px_rgba(0,20,56,0.18)] border border-slate-200/90 p-8 sm:p-10 flex flex-col justify-between relative z-10 transition-all">
          
          {/* Card Header */}
          <div className="text-center mb-8">
            <h2 className="text-3xl sm:text-[32px] font-black text-[#0a192f] tracking-tight">
              Welcome Back
            </h2>
            <p className="text-sm text-slate-500 mt-1.5 font-medium">
              Sign in to your account
            </p>
            {/* Modern Blue Accent Line */}
            <div className="w-16 h-1.5 bg-gradient-to-r from-blue-600 via-sky-500 to-cyan-400 rounded-full mx-auto mt-3.5 shadow-sm" />
          </div>

          {/* Canonical Super Admin Live Temporary Lockout Countdown Panel (Server-Authoritative) */}
          {showSuperAdminTempLockout && tempLockout && (
            <div
              role="alert"
              data-testid="superadmin-temp-lockout-panel"
              className="mb-6 p-4 rounded-xl border border-amber-400 bg-amber-50 text-amber-950 shadow-xs"
            >
              <div className="flex items-start gap-2.5">
                <Clock className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs sm:text-sm uppercase tracking-wider font-extrabold text-amber-950">
                      ACCOUNT TEMPORARILY LOCKED
                    </span>
                    <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-amber-200/80 text-amber-900">
                      Super Admin
                    </span>
                  </div>

                  <div className="mt-3 rounded-lg bg-white/90 border border-amber-300/80 px-3.5 py-2.5 flex items-center justify-between gap-3">
                    <span className="text-xs font-bold uppercase tracking-wider text-amber-900">
                      Time Remaining:
                    </span>
                    <span
                      data-testid="temp-lockout-countdown"
                      className="font-mono tabular-nums text-xl sm:text-2xl font-black text-amber-950 tracking-wider"
                    >
                      {formatCountdownSeconds(remainingSeconds)}
                    </span>
                  </div>

                  {typeof tempLockout.lockDurationMinutes === 'number' && (
                    <div className="mt-2.5 text-xs font-semibold text-amber-900 flex items-center justify-between">
                      <span>Lockout Duration:</span>
                      <span data-testid="temp-lockout-duration" className="font-bold">
                        {tempLockout.lockDurationMinutes}{' '}
                        {tempLockout.lockDurationMinutes === 1 ? 'Minute' : 'Minutes'}
                      </span>
                    </div>
                  )}

                  <div className="mt-2.5 pt-2.5 border-t border-amber-300/70 text-[11px] sm:text-xs font-medium text-amber-900">
                    {isVerifyingExpiry ? (
                      <div className="flex items-center gap-2 font-semibold text-amber-950">
                        <RefreshCw className="w-3.5 h-3.5 animate-spin shrink-0" />
                        <span>
                          {expiryVerificationError || 'Verifying lockout expiry with server...'}
                        </span>
                      </div>
                    ) : (
                      <span>
                        Account will automatically become active when the timer expires.
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Standard Security Alert / Permanent Lockout / Warning Message Box */}
          {!showSuperAdminTempLockout && alertState && (
            <div
              role="alert"
              className={`mb-6 p-3.5 rounded-xl border text-xs sm:text-sm flex items-start gap-2.5 shadow-xs ${
                alertState.tone === 'ready'
                  ? 'bg-emerald-50 border-emerald-300 text-emerald-900'
                  : alertState.tone === 'warning' || alertState.tone === 'ratelimit'
                    ? 'bg-amber-50 border-amber-300 text-amber-900'
                    : 'bg-red-50 border-red-300 text-red-800'
              }`}
            >
              {alertState.tone === 'ready' ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
              ) : alertState.tone === 'locked' ? (
                <Lock className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
              ) : (
                <AlertCircle
                  className={`w-4 h-4 shrink-0 mt-0.5 ${
                    alertState.tone === 'warning' || alertState.tone === 'ratelimit'
                      ? 'text-amber-600'
                      : 'text-red-500'
                  }`}
                />
              )}
              <div className="leading-relaxed font-semibold flex-1">
                {alertState.tone === 'locked' && (
                  <div className="text-[11px] uppercase tracking-wider font-extrabold text-red-700 mb-0.5">
                    Account Temporarily Blocked
                  </div>
                )}
                {alertState.tone === 'warning' && (
                  <div className="text-[11px] uppercase tracking-wider font-extrabold text-amber-800 mb-0.5">
                    Security Warning — 1 Attempt Remaining
                  </div>
                )}
                {alertState.tone === 'ready' && (
                  <div className="text-[11px] uppercase tracking-wider font-extrabold text-emerald-800 mb-0.5">
                    Account Automatically Reactivated
                  </div>
                )}
                <div>{alertState.message}</div>
              </div>
            </div>
          )}

          {/* Sign In Form */}
          <form onSubmit={handleSubmit} className="space-y-5">
            
            {/* Login ID Input */}
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-2 uppercase tracking-wider">
                LOGIN ID / USERNAME
              </label>
              <div className="relative flex items-center rounded-2xl border border-slate-200 bg-slate-50/80 hover:bg-white focus-within:bg-white focus-within:border-blue-600 focus-within:ring-3 focus-within:ring-blue-100 transition-all">
                <div className="pl-4 pr-2 text-slate-400">
                  <User className="w-5 h-5" />
                </div>
                <input
                  type="text"
                  value={loginId}
                  onChange={(e) => setLoginId(e.target.value)}
                  placeholder="Enter your Login ID"
                  autoComplete="username"
                  required
                  className="w-full py-3.5 pr-4 text-sm text-slate-900 bg-transparent border-none focus:outline-hidden font-medium placeholder:text-slate-400"
                />
              </div>
            </div>

            {/* Password Input with Show/Hide Toggle */}
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-2 uppercase tracking-wider">
                PASSWORD
              </label>
              <div className="relative flex items-center rounded-2xl border border-slate-200 bg-slate-50/80 hover:bg-white focus-within:bg-white focus-within:border-blue-600 focus-within:ring-3 focus-within:ring-blue-100 transition-all">
                <div className="pl-4 pr-2 text-slate-400">
                  <Lock className="w-5 h-5" />
                </div>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  autoComplete="current-password"
                  required
                  className="w-full py-3.5 pr-11 text-sm text-slate-900 bg-transparent border-none focus:outline-hidden font-medium placeholder:text-slate-400"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3.5 p-1 text-slate-400 hover:text-slate-700 focus:outline-hidden cursor-pointer transition-colors"
                  title={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Modern Blue Gradient SIGN IN Button */}
            <button
              type="submit"
              disabled={isLoading || isTempLockBlockingSubmit}
              className="w-full mt-3 bg-gradient-to-r from-blue-600 via-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 active:scale-[0.99] text-white font-bold py-3.5 px-6 rounded-2xl shadow-lg shadow-blue-600/30 flex items-center justify-center gap-2.5 transition-all disabled:opacity-70 disabled:cursor-not-allowed text-sm uppercase tracking-wider cursor-pointer"
            >
              {isLoading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span>Verifying Account...</span>
                </>
              ) : isVerifyingExpiry && showSuperAdminTempLockout ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>Verifying Lockout Expiry...</span>
                </>
              ) : isTempLockBlockingSubmit ? (
                <>
                  <Clock className="w-4 h-4" />
                  <span>LOCKED ({formatCountdownSeconds(remainingSeconds)})</span>
                </>
              ) : (
                <>
                  <LogIn className="w-4 h-4" />
                  <span>SIGN IN</span>
                </>
              )}
            </button>
          </form>

          {/* Footer Security Badge: Authorized Personnel Only */}
          <div className="mt-8 pt-6 border-t border-slate-100 flex items-center justify-center gap-2 text-slate-600 text-xs sm:text-sm font-semibold">
            <ShieldCheck className="w-4 h-4 text-blue-600 shrink-0" />
            <span>Authorized Personnel Only</span>
          </div>

        </div>
      </div>

    </div>
  );
};
