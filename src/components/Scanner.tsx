import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  ScanLine, 
  Camera, 
  CheckCircle2, 
  XCircle, 
  AlertTriangle, 
  Volume2, 
  VolumeX, 
  Clock, 
  UserCheck, 
  LogIn, 
  LogOut, 
  Layers, 
  ArrowRight,
  ShieldAlert,
  Sparkles,
  Smartphone,
  ChevronRight,
  Activity
} from 'lucide-react';
import { processDualAttendanceScan } from '../services/attendanceService';
import { ScanResult, ScannerType } from '../types';
import { Html5QrcodeScanner } from 'html5-qrcode';

interface ScannerProps {
  onAttendanceUpdated?: () => void;
}

export const Scanner: React.FC<ScannerProps> = ({ onAttendanceUpdated }) => {
  // Mode selection: Dual side-by-side or dedicated single station
  const [activeStationMode, setActiveStationMode] = useState<'DUAL' | 'IN_ONLY' | 'OUT_ONLY'>('DUAL');

  // Input states for IN and OUT
  const [inInput, setInInput] = useState('');
  const [outInput, setOutInput] = useState('');
  const [isProcessingIn, setIsProcessingIn] = useState(false);
  const [isProcessingOut, setIsProcessingOut] = useState(false);

  // Results for both stations
  const [lastInResult, setLastInResult] = useState<ScanResult | null>(null);
  const [lastOutResult, setLastOutResult] = useState<ScanResult | null>(null);

  // Active focus target ('IN' or 'OUT')
  const [activeFocus, setActiveFocus] = useState<'IN' | 'OUT'>('IN');

  // Webcam camera state & which scanner owns it
  const [webcamStation, setWebcamStation] = useState<'NONE' | 'IN' | 'OUT'>('NONE');

  const [soundEnabled, setSoundEnabled] = useState(true);
  const [recentEvents, setRecentEvents] = useState<ScanResult[]>([]);

  const inInputRef = useRef<HTMLInputElement>(null);
  const outInputRef = useRef<HTMLInputElement>(null);
  const webcamScannerRef = useRef<Html5QrcodeScanner | null>(null);

  // Audio synthesizer for industrial audio confirmations
  const playSound = useCallback((type: 'success_in' | 'success_out' | 'error' | 'warning') => {
    if (!soundEnabled) return;
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.connect(gain);
      gain.connect(ctx.destination);

      if (type === 'success_in') {
        // High bright double beep for entry
        osc.frequency.setValueAtTime(880, ctx.currentTime); // A5
        osc.frequency.setValueAtTime(1174.66, ctx.currentTime + 0.1); // D6
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
        osc.start();
        osc.stop(ctx.currentTime + 0.25);
      } else if (type === 'success_out') {
        // Melodic triple chime for exit
        osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
        osc.frequency.setValueAtTime(739.99, ctx.currentTime + 0.08); // F#5
        osc.frequency.setValueAtTime(880, ctx.currentTime + 0.16); // A5
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        osc.start();
        osc.stop(ctx.currentTime + 0.3);
      } else if (type === 'warning') {
        osc.frequency.setValueAtTime(600, ctx.currentTime);
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        osc.start();
        osc.stop(ctx.currentTime + 0.3);
      } else {
        // Error low double buzz
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(220, ctx.currentTime);
        osc.frequency.setValueAtTime(160, ctx.currentTime + 0.15);
        gain.gain.setValueAtTime(0.4, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
        osc.start();
        osc.stop(ctx.currentTime + 0.4);
      }
    } catch {
      // AudioContext unavailable
    }
  }, [soundEnabled]);

  // Keep target scanner focused for USB hardware readers
  useEffect(() => {
    const keepFocus = () => {
      const activeEl = document.activeElement;
      if (activeEl?.tagName === 'INPUT' && (activeEl === inInputRef.current || activeEl === outInputRef.current)) {
        return;
      }
      if (activeFocus === 'IN') {
        inInputRef.current?.focus();
      } else {
        outInputRef.current?.focus();
      }
    };
    keepFocus();
    const interval = setInterval(keepFocus, 1000);
    return () => clearInterval(interval);
  }, [activeFocus]);

  // Process Punch In Scan
  const handlePunchIn = async (payload: string, source: 'USB_SCANNER' | 'WEBCAM' | 'MANUAL' = 'USB_SCANNER') => {
    const clean = payload.trim();
    if (!clean || isProcessingIn) return;

    setIsProcessingIn(true);
    try {
      const result = await processDualAttendanceScan({
        rawPayload: clean,
        scannerType: 'IN',
        scannerDevice: source,
      });

      setLastInResult(result);
      setRecentEvents(prev => [result, ...prev.slice(0, 9)]);

      if (result.success) {
        if (result.attendance?.attendanceStatus === 'LATE') {
          playSound('warning');
        } else {
          playSound('success_in');
        }
        onAttendanceUpdated?.();
      } else {
        playSound('error');
      }
    } catch (err: any) {
      console.error('Punch In Error:', err);
      const fallback: ScanResult = {
        success: false,
        action: 'REJECTED',
        scannerType: 'IN',
        message: err.message || 'System error processing Punch In.',
        time: new Date().toLocaleTimeString(),
      };
      setLastInResult(fallback);
      playSound('error');
    } finally {
      setIsProcessingIn(false);
      setInInput('');
      setTimeout(() => inInputRef.current?.focus(), 50);
    }
  };

  // Process Punch Out Scan
  const handlePunchOut = async (payload: string, source: 'USB_SCANNER' | 'WEBCAM' | 'MANUAL' = 'USB_SCANNER') => {
    const clean = payload.trim();
    if (!clean || isProcessingOut) return;

    setIsProcessingOut(true);
    try {
      const result = await processDualAttendanceScan({
        rawPayload: clean,
        scannerType: 'OUT',
        scannerDevice: source,
      });

      setLastOutResult(result);
      setRecentEvents(prev => [result, ...prev.slice(0, 9)]);

      if (result.success) {
        playSound('success_out');
        onAttendanceUpdated?.();
      } else {
        playSound('error');
      }
    } catch (err: any) {
      console.error('Punch Out Error:', err);
      const fallback: ScanResult = {
        success: false,
        action: 'REJECTED',
        scannerType: 'OUT',
        message: err.message || 'System error processing Punch Out.',
        time: new Date().toLocaleTimeString(),
      };
      setLastOutResult(fallback);
      playSound('error');
    } finally {
      setIsProcessingOut(false);
      setOutInput('');
      setTimeout(() => outInputRef.current?.focus(), 50);
    }
  };

  // Setup Webcam QR Reader if activated
  useEffect(() => {
    if (webcamStation !== 'NONE') {
      const scanner = new Html5QrcodeScanner(
        'dual-qr-reader-container',
        { fps: 10, qrbox: { width: 250, height: 250 } },
        false
      );

      scanner.render(
        (decodedText) => {
          if (webcamStation === 'IN') {
            handlePunchIn(decodedText, 'WEBCAM');
          } else if (webcamStation === 'OUT') {
            handlePunchOut(decodedText, 'WEBCAM');
          }
        },
        () => {}
      );
      webcamScannerRef.current = scanner;
    } else {
      if (webcamScannerRef.current) {
        webcamScannerRef.current.clear().catch(console.error);
        webcamScannerRef.current = null;
      }
    }

    return () => {
      if (webcamScannerRef.current) {
        webcamScannerRef.current.clear().catch(console.error);
      }
    };
  }, [webcamStation]);

  return (
    <div className="flex flex-col h-full bg-slate-950 text-white overflow-y-auto">
      {/* Top Header & Dual Scanner Mode Controls */}
      <div className="bg-slate-900 px-6 py-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-emerald-500 to-blue-600 flex items-center justify-center shadow-lg shadow-emerald-900/40">
            <ScanLine className="w-6 h-6 text-white animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-bold tracking-tight text-white">DUAL ATTENDANCE SCANNERS</h2>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800 font-semibold">
                FIRST-IN LAST-OUT ENGINE
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Dedicated entry (Punch In) & exit (Punch Out) scanners. Multiple alternating punches supported with full server timestamps.
            </p>
          </div>
        </div>

        {/* Station Mode Toggle & Controls */}
        <div className="flex items-center gap-2.5">
          {/* Station View Switcher */}
          <div className="flex items-center bg-slate-950 p-1 rounded-lg border border-slate-800 text-xs">
            <button
              onClick={() => setActiveStationMode('DUAL')}
              className={`px-3 py-1.5 rounded font-medium transition ${
                activeStationMode === 'DUAL'
                  ? 'bg-blue-600 text-white shadow'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Dual Gates
            </button>
            <button
              onClick={() => {
                setActiveStationMode('IN_ONLY');
                setActiveFocus('IN');
              }}
              className={`px-3 py-1.5 rounded font-medium transition flex items-center gap-1 ${
                activeStationMode === 'IN_ONLY'
                  ? 'bg-emerald-600 text-white shadow'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <LogIn className="w-3.5 h-3.5" />
              <span>Punch In Only</span>
            </button>
            <button
              onClick={() => {
                setActiveStationMode('OUT_ONLY');
                setActiveFocus('OUT');
              }}
              className={`px-3 py-1.5 rounded font-medium transition flex items-center gap-1 ${
                activeStationMode === 'OUT_ONLY'
                  ? 'bg-indigo-600 text-white shadow'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Punch Out Only</span>
            </button>
          </div>

          {/* Sound Toggle */}
          <button
            onClick={() => setSoundEnabled(!soundEnabled)}
            className={`p-2 rounded border text-xs flex items-center gap-1.5 transition ${
              soundEnabled 
                ? 'bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-700' 
                : 'bg-red-950/80 border-red-800 text-red-300'
            }`}
            title="Toggle sound chime"
          >
            {soundEnabled ? <Volume2 className="w-4 h-4 text-emerald-400" /> : <VolumeX className="w-4 h-4 text-red-400" />}
          </button>
        </div>
      </div>

      {/* Shared Camera Modal if Active */}
      {webcamStation !== 'NONE' && (
        <div className="bg-slate-900 border-b border-slate-800 p-4 flex flex-col items-center">
          <div className="flex items-center justify-between w-full max-w-md mb-2">
            <span className="text-xs font-semibold text-slate-300 flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse"></span>
              Live Webcam active for: <strong className={webcamStation === 'IN' ? 'text-emerald-400' : 'text-blue-400'}>PUNCH {webcamStation}</strong>
            </span>
            <button
              onClick={() => setWebcamStation('NONE')}
              className="text-xs text-slate-400 hover:text-white underline"
            >
              Close Camera
            </button>
          </div>
          <div id="dual-qr-reader-container" className="w-full max-w-md overflow-hidden rounded-lg bg-black"></div>
        </div>
      )}

      {/* Main Dual Scanner Workstation Stage */}
      <div className="flex-1 p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 max-w-7xl mx-auto w-full">
        {/* Left/Middle: Scanners Area (8 or 9 cols) */}
        <div className="lg:col-span-8 flex flex-col gap-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            
            {/* ========================================================================= */}
            {/* SECTION A: PUNCH IN SCANNER (ENTRY GATE) */}
            {/* ========================================================================= */}
            {(activeStationMode === 'DUAL' || activeStationMode === 'IN_ONLY') && (
              <div 
                onClick={() => setActiveFocus('IN')}
                className={`flex flex-col bg-slate-900 rounded-xl border-2 transition-all p-5 shadow-xl cursor-pointer ${
                  activeStationMode === 'IN_ONLY' ? 'md:col-span-2' : ''
                } ${
                  activeFocus === 'IN' 
                    ? 'border-emerald-500 ring-2 ring-emerald-500/20 shadow-emerald-950/30' 
                    : 'border-slate-800 opacity-90 hover:border-slate-700'
                }`}
              >
                {/* Station Banner */}
                <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-lg bg-emerald-600 flex items-center justify-center text-white shadow-md shadow-emerald-900/50">
                      <LogIn className="w-4 h-4" />
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-white tracking-wide flex items-center gap-1.5">
                        <span>PUNCH IN SCANNER</span>
                        {activeFocus === 'IN' && (
                          <span className="text-[9px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-1.5 py-0.2 rounded font-mono">
                            ACTIVE
                          </span>
                        )}
                      </h3>
                      <p className="text-[11px] text-emerald-400 font-medium">ENTRY GATE • WORKDAY COMMENCEMENT</p>
                    </div>
                  </div>

                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setWebcamStation(webcamStation === 'IN' ? 'NONE' : 'IN');
                    }}
                    className={`px-2 py-1 rounded text-[11px] font-medium flex items-center gap-1 border transition ${
                      webcamStation === 'IN'
                        ? 'bg-emerald-600 border-emerald-500 text-white'
                        : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    <Camera className="w-3 h-3" />
                    <span>{webcamStation === 'IN' ? 'Cam ON' : 'Cam'}</span>
                  </button>
                </div>

                {/* USB Scanner Keystroke / Manual Input Field */}
                <div className="mt-4">
                  <label className="text-[11px] text-slate-400 uppercase font-semibold mb-1 block">
                    Scan Employee QR Card or Type ID
                  </label>
                  <div className="relative">
                    <input
                      ref={inInputRef}
                      type="text"
                      value={inInput}
                      onChange={(e) => setInInput(e.target.value)}
                      onFocus={() => setActiveFocus('IN')}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handlePunchIn(inInput, 'USB_SCANNER');
                        }
                      }}
                      disabled={isProcessingIn}
                      placeholder="Punch In Ready (e.g. JMD001)..."
                      className="w-full bg-slate-950 border border-slate-700 focus:border-emerald-500 rounded-lg px-3.5 py-2.5 text-sm text-white font-mono placeholder-slate-500 focus:outline-hidden focus:ring-1 focus:ring-emerald-500 transition"
                    />
                    <button
                      onClick={() => handlePunchIn(inInput, 'USB_SCANNER')}
                      disabled={isProcessingIn || !inInput.trim()}
                      className="absolute right-1.5 top-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-semibold px-3 py-1.5 rounded transition"
                    >
                      Punch In
                    </button>
                  </div>
                </div>

                {/* Latest Punch In Result Badge */}
                <div className="mt-4 flex-1 flex flex-col justify-center">
                  {lastInResult ? (
                    <div 
                      className={`p-4 rounded-lg border flex flex-col gap-3 transition-all ${
                        lastInResult.success
                          ? lastInResult.attendance?.attendanceStatus === 'LATE'
                            ? 'bg-amber-950/30 border-amber-600/70 text-amber-200'
                            : 'bg-emerald-950/30 border-emerald-600/70 text-emerald-200'
                          : 'bg-red-950/40 border-red-700 text-red-200'
                      }`}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-2">
                          {lastInResult.success ? (
                            <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                          ) : (
                            <XCircle className="w-5 h-5 text-red-400 shrink-0" />
                          )}
                          <div>
                            <div className="text-[10px] uppercase font-bold tracking-wider opacity-80">
                              {lastInResult.success ? 'ENTRY CONFIRMED' : 'ENTRY REJECTED'}
                            </div>
                            <div className="text-sm font-bold text-white leading-tight">
                              {lastInResult.message}
                            </div>
                          </div>
                        </div>
                        <span className="text-xs font-mono font-bold text-slate-300">
                          {lastInResult.time}
                        </span>
                      </div>

                      {lastInResult.employee && (
                        <div className="grid grid-cols-2 gap-2 pt-2 border-t border-white/10 text-xs">
                          <div>
                            <span className="text-slate-400 block text-[10px]">EMPLOYEE</span>
                            <span className="font-bold text-white truncate block">
                              {lastInResult.employee.employeeName} ({lastInResult.employee.employeeId})
                            </span>
                          </div>
                          <div>
                            <span className="text-slate-400 block text-[10px]">LINE / SECTION</span>
                            <span className="font-semibold text-slate-200 block truncate">
                              {lastInResult.employee.floor} • {lastInResult.employee.section}
                            </span>
                          </div>
                          <div>
                            <span className="text-slate-400 block text-[10px]">DEPARTMENT</span>
                            <span className="font-semibold text-slate-200 block truncate">
                              {lastInResult.employee.department}
                            </span>
                          </div>
                          <div>
                            <span className="text-slate-400 block text-[10px]">SHIFT / STATUS</span>
                            <span className="font-semibold text-emerald-400 block">
                              {lastInResult.shift?.name || 'DAY SHIFT'} • INSIDE
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="border border-dashed border-slate-800 rounded-lg p-6 text-center text-xs text-slate-500">
                      <LogIn className="w-6 h-6 text-emerald-600/50 mx-auto mb-1.5" />
                      <span>Ready to scan employee entry QR codes</span>
                    </div>
                  )}
                </div>

                {/* Validation Note */}
                <div className="mt-3 text-[11px] text-slate-500 flex items-center gap-1.5">
                  <UserCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>Subsequent Punch In allowed after valid Punch Out. Consecutive IN rejected.</span>
                </div>
              </div>
            )}

            {/* ========================================================================= */}
            {/* SECTION B: PUNCH OUT SCANNER (EXIT GATE) */}
            {/* ========================================================================= */}
            {(activeStationMode === 'DUAL' || activeStationMode === 'OUT_ONLY') && (
              <div 
                onClick={() => setActiveFocus('OUT')}
                className={`flex flex-col bg-slate-900 rounded-xl border-2 transition-all p-5 shadow-xl cursor-pointer ${
                  activeStationMode === 'OUT_ONLY' ? 'md:col-span-2' : ''
                } ${
                  activeFocus === 'OUT' 
                    ? 'border-indigo-500 ring-2 ring-indigo-500/20 shadow-indigo-950/30' 
                    : 'border-slate-800 opacity-90 hover:border-slate-700'
                }`}
              >
                {/* Station Banner */}
                <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white shadow-md shadow-indigo-900/50">
                      <LogOut className="w-4 h-4" />
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-white tracking-wide flex items-center gap-1.5">
                        <span>PUNCH OUT SCANNER</span>
                        {activeFocus === 'OUT' && (
                          <span className="text-[9px] bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 px-1.5 py-0.2 rounded font-mono">
                            ACTIVE
                          </span>
                        )}
                      </h3>
                      <p className="text-[11px] text-indigo-400 font-medium">EXIT GATE • DUTY & OVERTIME CALCULATION</p>
                    </div>
                  </div>

                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setWebcamStation(webcamStation === 'OUT' ? 'NONE' : 'OUT');
                    }}
                    className={`px-2 py-1 rounded text-[11px] font-medium flex items-center gap-1 border transition ${
                      webcamStation === 'OUT'
                        ? 'bg-indigo-600 border-indigo-500 text-white'
                        : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    <Camera className="w-3 h-3" />
                    <span>{webcamStation === 'OUT' ? 'Cam ON' : 'Cam'}</span>
                  </button>
                </div>

                {/* USB Scanner Keystroke / Manual Input Field */}
                <div className="mt-4">
                  <label className="text-[11px] text-slate-400 uppercase font-semibold mb-1 block">
                    Scan Employee QR Card or Type ID
                  </label>
                  <div className="relative">
                    <input
                      ref={outInputRef}
                      type="text"
                      value={outInput}
                      onChange={(e) => setOutInput(e.target.value)}
                      onFocus={() => setActiveFocus('OUT')}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handlePunchOut(outInput, 'USB_SCANNER');
                        }
                      }}
                      disabled={isProcessingOut}
                      placeholder="Punch Out Ready (e.g. JMD001)..."
                      className="w-full bg-slate-950 border border-slate-700 focus:border-indigo-500 rounded-lg px-3.5 py-2.5 text-sm text-white font-mono placeholder-slate-500 focus:outline-hidden focus:ring-1 focus:ring-indigo-500 transition"
                    />
                    <button
                      onClick={() => handlePunchOut(outInput, 'USB_SCANNER')}
                      disabled={isProcessingOut || !outInput.trim()}
                      className="absolute right-1.5 top-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs font-semibold px-3 py-1.5 rounded transition"
                    >
                      Punch Out
                    </button>
                  </div>
                </div>

                {/* Latest Punch Out Result Badge */}
                <div className="mt-4 flex-1 flex flex-col justify-center">
                  {lastOutResult ? (
                    <div 
                      className={`p-4 rounded-lg border flex flex-col gap-3 transition-all ${
                        lastOutResult.success
                          ? 'bg-indigo-950/30 border-indigo-600/70 text-indigo-200'
                          : 'bg-red-950/40 border-red-700 text-red-200'
                      }`}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-2">
                          {lastOutResult.success ? (
                            <CheckCircle2 className="w-5 h-5 text-indigo-400 shrink-0" />
                          ) : (
                            <XCircle className="w-5 h-5 text-red-400 shrink-0" />
                          )}
                          <div>
                            <div className="text-[10px] uppercase font-bold tracking-wider opacity-80">
                              {lastOutResult.success ? 'EXIT CONFIRMED' : 'EXIT REJECTED'}
                            </div>
                            <div className="text-sm font-bold text-white leading-tight">
                              {lastOutResult.message}
                            </div>
                          </div>
                        </div>
                        <span className="text-xs font-mono font-bold text-slate-300">
                          {lastOutResult.time}
                        </span>
                      </div>

                      {lastOutResult.employee && (
                        <div className="grid grid-cols-2 gap-2 pt-2 border-t border-white/10 text-xs">
                          <div>
                            <span className="text-slate-400 block text-[10px]">EMPLOYEE</span>
                            <span className="font-bold text-white truncate block">
                              {lastOutResult.employee.employeeName} ({lastOutResult.employee.employeeId})
                            </span>
                          </div>
                          <div>
                            <span className="text-slate-400 block text-[10px]">DUTY RECORDED</span>
                            <span className="font-bold text-emerald-400 block">
                              {lastOutResult.dutyFormatted || '08:30 Hours'}
                            </span>
                          </div>
                          <div>
                            <span className="text-slate-400 block text-[10px]">OVERTIME (OT)</span>
                            <span className="font-bold text-amber-400 block">
                              {lastOutResult.otFormatted && lastOutResult.otFormatted !== '00:00 Hours' 
                                ? lastOutResult.otFormatted 
                                : '00:00 Hours'}
                            </span>
                          </div>
                          <div>
                            <span className="text-slate-400 block text-[10px]">CURRENT STATE</span>
                            <span className="font-semibold text-slate-300 block">
                              OUTSIDE (Punch #{lastOutResult.punchCount || 2})
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="border border-dashed border-slate-800 rounded-lg p-6 text-center text-xs text-slate-500">
                      <LogOut className="w-6 h-6 text-indigo-600/50 mx-auto mb-1.5" />
                      <span>Ready to scan employee exit QR codes</span>
                    </div>
                  )}
                </div>

                {/* Validation Note */}
                <div className="mt-3 text-[11px] text-slate-500 flex items-center gap-1.5">
                  <ShieldAlert className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <span>Punch Out rejected without open Punch In. Consecutive OUT rejected.</span>
                </div>
              </div>
            )}
          </div>

          {/* Industrial First-In Last-Out Guidance Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl">
              <div className="flex items-center gap-2 text-xs font-bold text-emerald-400 uppercase mb-1">
                <LogIn className="w-4 h-4" />
                <span>First Punch In Rule</span>
              </div>
              <p className="text-xs text-slate-400">
                Earliest valid scan of the day is official daily <strong>firstPunchIn</strong>. Preserved across all multiple punches.
              </p>
            </div>

            <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl">
              <div className="flex items-center gap-2 text-xs font-bold text-indigo-400 uppercase mb-1">
                <LogOut className="w-4 h-4" />
                <span>Last Punch Out Rule</span>
              </div>
              <p className="text-xs text-slate-400">
                Latest valid scan of the day is official daily <strong>lastPunchOut</strong>. Duty = Last Out - First In.
              </p>
            </div>

            <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl">
              <div className="flex items-center gap-2 text-xs font-bold text-amber-400 uppercase mb-1">
                <Clock className="w-4 h-4" />
                <span>Standard 08:30 Duty</span>
              </div>
              <p className="text-xs text-slate-400">
                Standard shift duty is 08h 30m (510 mins). OT = Max(0, Duty - 08:30). Missed punch auto-closes with 0 OT.
              </p>
            </div>
          </div>
        </div>

        {/* Right Column: Live Punch Activity Stream (4 cols) */}
        <div className="lg:col-span-4 flex flex-col gap-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col h-full shadow-lg">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h4 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                <Activity className="w-4 h-4 text-emerald-400" />
                <span>Dual Gate Activity</span>
              </h4>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-blue-950 text-blue-400 border border-blue-900">
                Live Server
              </span>
            </div>

            <div className="flex-1 overflow-y-auto mt-3 space-y-2.5 max-h-[600px] pr-1">
              {recentEvents.length === 0 ? (
                <div className="text-center py-16 text-xs text-slate-500">
                  <ScanLine className="w-8 h-8 text-slate-700 mx-auto mb-2" />
                  No punch activity in this session yet.
                </div>
              ) : (
                recentEvents.map((ev, i) => (
                  <div
                    key={i}
                    className={`p-3 rounded-lg border text-xs flex flex-col gap-1 transition ${
                      ev.success
                        ? ev.action === 'PUNCH_IN'
                          ? 'bg-emerald-950/20 border-emerald-900/60 text-slate-200'
                          : 'bg-indigo-950/20 border-indigo-900/60 text-slate-200'
                        : 'bg-red-950/20 border-red-900/60 text-red-200'
                    }`}
                  >
                    <div className="flex items-center justify-between font-mono">
                      <div className="flex items-center gap-1.5">
                        <span className={`w-2 h-2 rounded-full ${
                          ev.action === 'PUNCH_IN' ? 'bg-emerald-400' : ev.action === 'PUNCH_OUT' ? 'bg-indigo-400' : 'bg-red-400'
                        }`}></span>
                        <span className="font-bold text-white">
                          {ev.employee?.employeeId || 'ID_NOT_FOUND'}
                        </span>
                      </div>
                      <span className="text-[10px] text-slate-400">{ev.time}</span>
                    </div>

                    <div className="font-medium text-slate-300 truncate">
                      {ev.employee?.employeeName || ev.message}
                    </div>

                    <div className="flex items-center justify-between text-[11px] text-slate-400 mt-1 pt-1 border-t border-white/5">
                      <span className="truncate">
                        {ev.employee ? `${ev.employee.floor} • ${ev.employee.department}` : ''}
                      </span>
                      <span className={`px-1.5 py-0.5 rounded font-bold uppercase text-[9px] ${
                        ev.action === 'PUNCH_IN'
                          ? 'bg-emerald-900/80 text-emerald-300'
                          : ev.action === 'PUNCH_OUT'
                            ? 'bg-indigo-900/80 text-indigo-300'
                            : 'bg-red-900/80 text-red-300'
                      }`}>
                        GATE {ev.scannerType || (ev.action === 'PUNCH_IN' ? 'IN' : 'OUT')}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
