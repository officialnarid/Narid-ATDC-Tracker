import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  ScanLine, 
  Camera, 
  CheckCircle2, 
  XCircle, 
  AlertTriangle, 
  Volume2, 
  VolumeX, 
  Maximize2, 
  RefreshCw,
  Clock,
  UserCheck,
  Building,
  Layers,
  Network,
  RotateCcw
} from 'lucide-react';
import { processAttendanceScan } from '../services/attendanceService';
import { ScanResult, Employee, Shift, AttendanceRecord } from '../types';
import { Html5QrcodeScanner } from 'html5-qrcode';

interface ScannerProps {
  onAttendanceUpdated?: () => void;
}

export const Scanner: React.FC<ScannerProps> = ({ onAttendanceUpdated }) => {
  const [scanBuffer, setScanBuffer] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [lastScanResult, setLastScanResult] = useState<ScanResult | null>(null);
  const [isWebcamActive, setIsWebcamActive] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [recentScans, setRecentScans] = useState<ScanResult[]>([]);
  const [manualInput, setManualInput] = useState('');

  const inputRef = useRef<HTMLInputElement>(null);
  const webcamScannerRef = useRef<Html5QrcodeScanner | null>(null);

  // Audio synthesizer for industrial beeps
  const playSound = useCallback((type: 'success' | 'error' | 'warning') => {
    if (!soundEnabled) return;
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.connect(gain);
      gain.connect(ctx.destination);

      if (type === 'success') {
        // High positive double beep
        osc.frequency.setValueAtTime(880, ctx.currentTime); // A5
        osc.frequency.setValueAtTime(1174.66, ctx.currentTime + 0.1); // D6
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
        osc.start();
        osc.stop(ctx.currentTime + 0.25);
      } else if (type === 'warning') {
        // Warning tone
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
      // AudioContext unavailable or blocked by browser policy
    }
  }, [soundEnabled]);

  // Keep USB scanner input focused at all times
  useEffect(() => {
    const keepFocus = () => {
      if (document.activeElement?.tagName !== 'INPUT' || document.activeElement === inputRef.current) {
        inputRef.current?.focus();
      }
    };
    keepFocus();
    const interval = setInterval(keepFocus, 1000);
    return () => clearInterval(interval);
  }, []);

  // Process a QR code payload (from USB scanner or camera)
  const handleProcessPayload = async (payload: string, source: 'USB_SCANNER' | 'WEBCAM' = 'USB_SCANNER') => {
    const clean = payload.trim();
    if (!clean || isProcessing) return;

    setIsProcessing(true);
    try {
      const result = await processAttendanceScan(clean, source);
      setLastScanResult(result);
      setRecentScans(prev => [result, ...prev.slice(0, 7)]);

      if (result.success) {
        if (result.attendance?.attendanceStatus === 'LATE') {
          playSound('warning');
        } else {
          playSound('success');
        }
        onAttendanceUpdated?.();
      } else {
        playSound('error');
      }
    } catch (err) {
      console.error('Scan handling failed:', err);
      const fallbackResult: ScanResult = {
        success: false,
        action: 'REJECTED',
        message: 'System Error Processing Scan. Please try again.',
        time: new Date().toLocaleTimeString(),
      };
      setLastScanResult(fallbackResult);
      playSound('error');
    } finally {
      setIsProcessing(false);
      setScanBuffer('');
      setManualInput('');
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  };

  // Handle USB scanner keystrokes (Enter completes the scan)
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (manualInput.trim()) {
        handleProcessPayload(manualInput, 'USB_SCANNER');
      }
    }
  };

  // Toggle Webcam QR Scanner
  useEffect(() => {
    if (isWebcamActive) {
      const scanner = new Html5QrcodeScanner(
        'qr-reader-container',
        { fps: 10, qrbox: { width: 250, height: 250 } },
        false
      );
      scanner.render(
        (decodedText) => {
          handleProcessPayload(decodedText, 'WEBCAM');
        },
        (error) => {
          // Camera scanning search frames
        }
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
  }, [isWebcamActive]);

  return (
    <div className="flex flex-col h-full bg-slate-900 text-white overflow-y-auto">
      {/* Top Banner & Scanner Status */}
      <div className="bg-slate-950 px-6 py-4 border-b border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-emerald-600 flex items-center justify-center shadow-lg shadow-emerald-900/50">
            <ScanLine className="w-6 h-6 text-white animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-bold tracking-tight text-white">ATTENDANCE SCANNER</h2>
              <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800">
                LIVE TERMINAL
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Point USB barcode/QR scanner or toggle webcam. Instant automatic detection.
            </p>
          </div>
        </div>

        {/* Scanner controls */}
        <div className="flex items-center gap-3">
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
            <span className="text-[11px]">{soundEnabled ? 'Chime ON' : 'Muted'}</span>
          </button>

          <button
            onClick={() => setIsWebcamActive(!isWebcamActive)}
            className={`px-3 py-1.5 rounded border text-xs font-medium flex items-center gap-1.5 transition ${
              isWebcamActive 
                ? 'bg-blue-600 border-blue-500 text-white' 
                : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
            }`}
          >
            <Camera className="w-4 h-4" />
            <span>{isWebcamActive ? 'Hide Camera' : 'Use Webcam'}</span>
          </button>
        </div>
      </div>

      {/* Main Scanner Stage */}
      <div className="flex-1 p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 max-w-7xl mx-auto w-full">
        {/* Left Column: Big Status Card (9 Cols on large) */}
        <div className="lg:col-span-8 flex flex-col gap-6">
          {/* Hidden/Active input field for USB scanner keyboard interception */}
          <div className="bg-slate-800/90 border border-slate-700 rounded-lg p-3 flex items-center gap-3 shadow-inner">
            <ScanLine className="w-5 h-5 text-blue-400 shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={manualInput}
              onChange={(e) => setManualInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isProcessing}
              placeholder="USB Scanner Ready (Scan QR or enter Employee ID / Token and press Enter)..."
              className="w-full bg-transparent border-none text-white text-base placeholder-slate-500 focus:outline-hidden font-mono"
            />
            {manualInput && (
              <button
                onClick={() => handleProcessPayload(manualInput, 'USB_SCANNER')}
                disabled={isProcessing}
                className="bg-blue-600 hover:bg-blue-700 text-white text-xs px-3 py-1.5 rounded font-medium shrink-0"
              >
                Submit
              </button>
            )}
          </div>

          {/* Webcam stream container if active */}
          {isWebcamActive && (
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 flex flex-col items-center">
              <div className="text-xs text-slate-400 mb-2 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
                Webcam QR Reader active. Hold QR code steady in view.
              </div>
              <div id="qr-reader-container" className="w-full max-w-md overflow-hidden rounded-lg"></div>
            </div>
          )}

          {/* BIG SCAN RESULT BADGE */}
          {lastScanResult ? (
            <div 
              className={`rounded-xl border p-6 flex flex-col gap-6 shadow-2xl transition-all duration-300 ${
                lastScanResult.success
                  ? lastScanResult.action === 'PUNCH_IN'
                    ? lastScanResult.attendance?.attendanceStatus === 'LATE'
                      ? 'bg-amber-950/40 border-amber-500 text-amber-100'
                      : 'bg-emerald-950/40 border-emerald-500 text-emerald-100'
                    : 'bg-blue-950/40 border-blue-500 text-blue-100'
                  : 'bg-red-950/40 border-red-500 text-red-100'
              }`}
            >
              {/* Result Status Header */}
              <div className="flex items-center justify-between border-b border-white/10 pb-4">
                <div className="flex items-center gap-3">
                  {lastScanResult.success ? (
                    <CheckCircle2 className={`w-8 h-8 ${lastScanResult.action === 'PUNCH_IN' ? 'text-emerald-400' : 'text-blue-400'}`} />
                  ) : (
                    <XCircle className="w-8 h-8 text-red-400" />
                  )}
                  <div>
                    <span className="text-xs uppercase tracking-wider font-semibold opacity-75">
                      {lastScanResult.action} RESULT
                    </span>
                    <h3 className="text-2xl font-black tracking-wide">
                      {lastScanResult.message}
                    </h3>
                  </div>
                </div>

                <div className="text-right">
                  <div className="text-xs opacity-75">Time Recorded</div>
                  <div className="text-xl font-mono font-bold tracking-tight">{lastScanResult.time}</div>
                </div>
              </div>

              {/* Employee Badge Details */}
              {lastScanResult.employee && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 bg-black/30 p-4 rounded-lg">
                  <div>
                    <div className="text-[11px] text-slate-400 uppercase">Employee ID</div>
                    <div className="text-lg font-mono font-bold text-white">
                      {lastScanResult.employee.employeeId}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] text-slate-400 uppercase">Employee Name</div>
                    <div className="text-lg font-bold text-white truncate">
                      {lastScanResult.employee.employeeName}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] text-slate-400 uppercase">Line & Section</div>
                    <div className="text-sm font-semibold text-slate-200">
                      {lastScanResult.employee.floor} • {lastScanResult.employee.section}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] text-slate-400 uppercase">Department</div>
                    <div className="text-sm font-semibold text-slate-200">
                      {lastScanResult.employee.department}
                    </div>
                  </div>

                  <div>
                    <div className="text-[11px] text-slate-400 uppercase">Category</div>
                    <div className="text-sm font-medium text-slate-300">
                      {lastScanResult.employee.employeeType}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] text-slate-400 uppercase">Designation</div>
                    <div className="text-sm font-medium text-slate-300">
                      {lastScanResult.employee.designation}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] text-slate-400 uppercase">Auto-Detected Shift</div>
                    <div className="text-sm font-semibold text-blue-400 flex items-center gap-1.5">
                      <span>{lastScanResult.shift?.name || lastScanResult.attendance?.shiftNameSnapshot || 'DAY SHIFT'}</span>
                      <span className="text-[10px] bg-blue-500/20 text-blue-300 border border-blue-500/30 px-1 py-0.2 rounded font-mono font-normal">Auto</span>
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] text-slate-400 uppercase">Calculated Hours</div>
                    <div className="text-sm font-mono font-bold text-emerald-400">
                      {lastScanResult.dutyFormatted ? `Duty: ${lastScanResult.dutyFormatted}` : 'In Progress'}
                      {lastScanResult.otFormatted && lastScanResult.otFormatted !== '00:00 Hours' && (
                        <span className="text-amber-400 block text-xs">OT: {lastScanResult.otFormatted}</span>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            /* Standby Card */
            <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-12 text-center flex flex-col items-center justify-center min-h-[320px]">
              <div className="w-20 h-20 rounded-full bg-slate-900 border border-slate-800 flex items-center justify-center mb-4">
                <ScanLine className="w-10 h-10 text-slate-500 animate-pulse" />
              </div>
              <h3 className="text-xl font-bold text-slate-200">Awaiting Scanner Input</h3>
              <p className="text-sm text-slate-400 max-w-md mt-1">
                Scan employee QR card on the connected USB barcode scanner. The system will automatically identify the shift and register Punch In or Punch Out.
              </p>
            </div>
          )}

          {/* Quick Info Grid for Factory Supervisor */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-slate-950 border border-slate-800 p-4 rounded-lg">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-400 uppercase mb-1">
                <UserCheck className="w-4 h-4 text-emerald-400" />
                <span>One In / One Out Rule</span>
              </div>
              <p className="text-xs text-slate-500">
                1st Scan = Punch In. 2nd Scan = Punch Out. 3rd Scan is strictly rejected to prevent duplicate logging.
              </p>
            </div>

            <div className="bg-slate-950 border border-slate-800 p-4 rounded-lg">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-400 uppercase mb-1">
                <Clock className="w-4 h-4 text-blue-400" />
                <span>Scheduled Auto-Closing</span>
              </div>
              <p className="text-xs text-slate-500">
                Missed punch-outs are automatically closed at scheduled shift end with MISSED PUNCH OUT flag and zero OT.
              </p>
            </div>

            <div className="bg-slate-950 border border-slate-800 p-4 rounded-lg">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-400 uppercase mb-1">
                <RotateCcw className="w-4 h-4 text-purple-400" />
                <span>Overnight Night Shift</span>
              </div>
              <p className="text-xs text-slate-500">
                Night shift starts 08:00 PM and ends 04:30 AM next day, tied seamlessly to the shift starting date.
              </p>
            </div>
          </div>
        </div>

        {/* Right Column: Live Recent Activity Feed (4 Cols) */}
        <div className="lg:col-span-4 flex flex-col gap-4">
          <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 flex flex-col h-full">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h4 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                <Clock className="w-4 h-4 text-blue-400" />
                <span>Recent Punches</span>
              </h4>
              <span className="text-[11px] font-mono text-slate-500">Live</span>
            </div>

            <div className="flex-1 overflow-y-auto mt-3 space-y-2.5">
              {recentScans.length === 0 ? (
                <div className="text-center py-10 text-xs text-slate-500">
                  No punches recorded in this session yet.
                </div>
              ) : (
                recentScans.map((scan, i) => (
                  <div 
                    key={i} 
                    className={`p-3 rounded-lg border text-xs flex flex-col gap-1 transition ${
                      scan.success
                        ? scan.action === 'PUNCH_IN'
                          ? 'bg-emerald-950/20 border-emerald-900/60 text-slate-200'
                          : 'bg-blue-950/20 border-blue-900/60 text-slate-200'
                        : 'bg-red-950/20 border-red-900/60 text-red-200'
                    }`}
                  >
                    <div className="flex items-center justify-between font-mono">
                      <span className="font-bold text-white">
                        {scan.employee?.employeeId || 'UNKNOWN'}
                      </span>
                      <span className="text-[10px] text-slate-400">{scan.time}</span>
                    </div>

                    <div className="font-semibold truncate">
                      {scan.employee?.employeeName || scan.message}
                    </div>

                    <div className="flex items-center justify-between text-[11px] text-slate-400 mt-1">
                      <span>{scan.employee ? `${scan.employee.floor} • ${scan.employee.department}` : ''}</span>
                      <span className={`px-1.5 py-0.5 rounded font-bold uppercase text-[9px] ${
                        scan.action === 'PUNCH_IN'
                          ? 'bg-emerald-900 text-emerald-300'
                          : scan.action === 'PUNCH_OUT'
                            ? 'bg-blue-900 text-blue-300'
                            : 'bg-red-900 text-red-300'
                      }`}>
                        {scan.action}
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
