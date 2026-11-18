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
  Activity,
  Maximize2,
  Minimize2,
  Keyboard,
  Lock
} from 'lucide-react';
import {
  parseQrPayload,
  processDualAttendanceScan,
  processManualAttendancePunch,
} from '../services/attendanceService';
import {
  RolePermissionRecord,
  UserPermissionRecordWithOverride,
  resolveScannerCapabilities,
} from '../services/permissionService';
import { ScanResult, UserRoleRecord } from '../types';
import {
  formatDurationClock,
  isAttendanceLate,
  resolveAttendanceMetrics,
} from '../utils/attendanceStatus';
import {
  notifyAttendanceCommitted,
  recordPerfMetric,
} from '../utils/perfMonitor';
import {
  applyQrInputChange,
  getMaskedQrInputValue,
  sanitizeQrErrorMessage,
} from '../utils/qrInputMask';

function createClientRequestId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

interface ScannerProps {
  onAttendanceUpdated?: () => void;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  onExitFullscreen?: () => void;
  currentUserRole?: UserRoleRecord | null;
  rolePermissions?: Record<string, RolePermissionRecord> | null;
  userPermissionOverride?: UserPermissionRecordWithOverride | null;
}

export const Scanner: React.FC<ScannerProps> = ({
  onAttendanceUpdated,
  isFullscreen = false,
  onToggleFullscreen,
  onExitFullscreen,
  currentUserRole,
  rolePermissions,
  userPermissionOverride,
}) => {
  const { canQrScan, canManualEntry } = resolveScannerCapabilities({
    profile: currentUserRole,
    rolePermissions,
    userPermissionOverride,
  });
  // Mode selection: Dual side-by-side or dedicated single station
  const [activeStationMode, setActiveStationMode] = useState<'DUAL' | 'IN_ONLY' | 'OUT_ONLY'>('DUAL');

  // Masked QR status flags for IN and OUT (raw QR payloads stay internal in refs)
  const [inQrDetected, setInQrDetected] = useState(false);
  const [outQrDetected, setOutQrDetected] = useState(false);
  const [isProcessingIn, setIsProcessingIn] = useState(false);
  const [isProcessingOut, setIsProcessingOut] = useState(false);

  // Separate Manual Employee ID Entry states for IN and OUT
  const [manualInId, setManualInId] = useState('');
  const [manualOutId, setManualOutId] = useState('');
  const [isProcessingManualIn, setIsProcessingManualIn] = useState(false);
  const [isProcessingManualOut, setIsProcessingManualOut] = useState(false);

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
  const manualInInputRef = useRef<HTMLInputElement>(null);
  const manualOutInputRef = useRef<HTMLInputElement>(null);
  const webcamScannerRef = useRef<any>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Internal QR payload storage (never exposed in visible input value or logs; cleared only after API completes)
  const rawInPayloadRef = useRef('');
  const rawOutPayloadRef = useRef('');
  const usbInScanStartRef = useRef<number | null>(null);
  const usbOutScanStartRef = useRef<number | null>(null);

  // Synchronous ref locks prevent rapid duplicate Enter/click double-submissions in the same frame
  const inFlightInRef = useRef(false);
  const inFlightOutRef = useRef(false);
  const inFlightManualInRef = useRef(false);
  const inFlightManualOutRef = useRef(false);
  const lastWebcamScanRef = useRef<{ key: string; at: number } | null>(null);
  const [pendingGateFeedback, setPendingGateFeedback] = useState<{
    IN?: { mode: 'QR' | 'MANUAL'; detectedAt: number };
    OUT?: { mode: 'QR' | 'MANUAL'; detectedAt: number };
  }>({});

  // Audio synthesizer reusing a single AudioContext instance for zero overhead
  const playSound = useCallback((type: 'success_in' | 'success_out' | 'error' | 'warning') => {
    if (!soundEnabled) return;
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
        audioCtxRef.current = new AudioCtx();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.connect(gain);
      gain.connect(ctx.destination);

      if (type === 'success_in') {
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        osc.frequency.setValueAtTime(1174.66, ctx.currentTime + 0.1);
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
        osc.start();
        osc.stop(ctx.currentTime + 0.25);
      } else if (type === 'success_out') {
        osc.frequency.setValueAtTime(587.33, ctx.currentTime);
        osc.frequency.setValueAtTime(739.99, ctx.currentTime + 0.08);
        osc.frequency.setValueAtTime(880, ctx.currentTime + 0.16);
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

  useEffect(() => {
    return () => {
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
        audioCtxRef.current.close().catch(() => {});
      }
    };
  }, []);

  // Focus active scanner input on mount/mode switch without polling intervals
  const restoreTargetFocus = useCallback((target: 'IN' | 'OUT', mode: 'QR' | 'MANUAL') => {
    const focusFn = () => {
      if (mode === 'QR' && canQrScan) {
        (target === 'IN' ? inInputRef : outInputRef).current?.focus();
      } else if (mode === 'MANUAL' && canManualEntry) {
        (target === 'IN' ? manualInInputRef : manualOutInputRef).current?.focus();
      }
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(focusFn);
    } else {
      focusFn();
    }
  }, [canQrScan, canManualEntry]);

  useEffect(() => {
    const activeEl = document.activeElement;
    if (
      activeEl?.tagName === 'INPUT' &&
      (activeEl === inInputRef.current ||
        activeEl === outInputRef.current ||
        activeEl === manualInInputRef.current ||
        activeEl === manualOutInputRef.current)
    ) {
      return;
    }
    if (canQrScan) {
      restoreTargetFocus(activeFocus, 'QR');
    } else if (canManualEntry) {
      restoreTargetFocus(activeFocus, 'MANUAL');
    }
  }, [activeFocus, canQrScan, canManualEntry, restoreTargetFocus]);

  // Close webcam immediately if QR permission is revoked
  useEffect(() => {
    if (!canQrScan && webcamStation !== 'NONE') {
      setWebcamStation('NONE');
    }
  }, [canQrScan, webcamStation]);

  // Process Punch In Scan
  const handlePunchIn = useCallback(async (payload: string, source: 'USB_SCANNER' | 'WEBCAM' | 'MANUAL' = 'USB_SCANNER') => {
    const detectStart = performance.now();
    const clean = payload.trim();
    if (!clean || inFlightInRef.current) return;
    const usbStart = usbInScanStartRef.current;
    usbInScanStartRef.current = null;

    if (!canQrScan) {
      rawInPayloadRef.current = '';
      setInQrDetected(false);
      setLastInResult({
        success: false,
        action: 'REJECTED',
        scannerType: 'IN',
        message: 'Access denied: Your role lacks QR Code Scanning permission (attendance.qr.scan).',
        time: new Date().toLocaleTimeString(),
      });
      playSound('error');
      return;
    }

    // Keep internal scanned payload preserved until the Punch In API request completes
    rawInPayloadRef.current = clean;
    setInQrDetected(true);
    inFlightInRef.current = true;
    const e2eStart = performance.now();
    const parseStart = performance.now();
    parseQrPayload(clean);
    const clientParseMs = Math.max(0.01, performance.now() - parseStart);
    const qrDetectMs =
      source === 'USB_SCANNER' && usbStart !== null
        ? Math.max(0.01, e2eStart - usbStart)
        : Math.max(0.01, e2eStart - detectStart);
    recordPerfMetric('qr_detect_ms', qrDetectMs);
    recordPerfMetric('qr_parse_ms', clientParseMs);

    setPendingGateFeedback(prev => ({ ...prev, IN: { mode: 'QR', detectedAt: Date.now() } }));
    setIsProcessingIn(true);
    try {
      const result = await processDualAttendanceScan({
        rawPayload: rawInPayloadRef.current,
        scannerType: 'IN',
        scannerDevice: source,
        clientRequestId: createClientRequestId('qrin'),
      });

      const uiDisplayStart = performance.now();
      const networkApiMs = result.perf?.networkApiMs ?? (uiDisplayStart - e2eStart);
      const totalE2eMs = performance.now() - e2eStart;
      const sanitizedMessage = result.success
        ? result.message
        : sanitizeQrErrorMessage(result.message, clean);
      const totalPunchInMs = Number(totalE2eMs.toFixed(2));
      const enriched: ScanResult = {
        ...result,
        message: sanitizedMessage,
        perf: {
          ...result.perf,
          qrDetectMs: Number(qrDetectMs.toFixed(2)),
          qrParseMs: Number(((result.perf?.qrParseMs ?? 0) + clientParseMs).toFixed(2)),
          networkApiMs: Number(networkApiMs.toFixed(2)),
          uiDisplayMs: Number((performance.now() - uiDisplayStart).toFixed(2)),
          totalEndToEndMs: totalPunchInMs,
          totalPunchInMs,
        },
      };

      recordPerfMetric('qr_api_ms', networkApiMs);
      recordPerfMetric('qr_scan_e2e_ms', totalE2eMs);
      recordPerfMetric('qr_punch_in_e2e_ms', totalE2eMs);
      if (typeof result.perf?.totalServerMs === 'number') {
        recordPerfMetric('qr_scan_server_ms', result.perf.totalServerMs);
      }
      if (typeof result.perf?.authMs === 'number') {
        recordPerfMetric('qr_auth_token_ms', result.perf.authMs + (result.perf.tokenValidationMs ?? 0));
      }
      if (typeof result.perf?.firestoreOpMs === 'number') {
        recordPerfMetric('qr_firestore_ms', result.perf.firestoreOpMs);
      }

      setLastInResult(enriched);
      setRecentEvents(prev => [enriched, ...prev.slice(0, 9)]);

      if (enriched.success) {
        if (isAttendanceLate(enriched.attendance)) {
          playSound('warning');
        } else {
          playSound('success_in');
        }
        notifyAttendanceCommitted({
          scannerType: 'IN',
          action: 'PUNCH_IN',
          attendanceId: enriched.attendance?.id,
          shiftDate: enriched.attendance?.shiftDate,
          timestamp: Date.now(),
        });
        onAttendanceUpdated?.();
      } else {
        playSound('error');
      }
    } catch (err: any) {
      const safeErrMsg = sanitizeQrErrorMessage(
        String(err?.message || 'System error processing Punch In.'),
        clean
      );
      console.error('Punch In Error:', safeErrMsg);
      const fallback: ScanResult = {
        success: false,
        action: 'REJECTED',
        scannerType: 'IN',
        message: safeErrMsg.includes('timed out') || safeErrMsg.includes('Unable to reach')
          ? `Network interrupted: ${safeErrMsg}`
          : safeErrMsg,
        time: new Date().toLocaleTimeString(),
      };
      setLastInResult(fallback);
      playSound('error');
    } finally {
      inFlightInRef.current = false;
      rawInPayloadRef.current = '';
      usbInScanStartRef.current = null;
      setInQrDetected(false);
      setIsProcessingIn(false);
      setPendingGateFeedback(prev => ({ ...prev, IN: undefined }));
      restoreTargetFocus('IN', 'QR');
    }
  }, [canQrScan, onAttendanceUpdated, playSound, restoreTargetFocus]);

  // Process Punch Out Scan
  const handlePunchOut = useCallback(async (payload: string, source: 'USB_SCANNER' | 'WEBCAM' | 'MANUAL' = 'USB_SCANNER') => {
    const detectStart = performance.now();
    const clean = payload.trim();
    if (!clean || inFlightOutRef.current) return;
    const usbStart = usbOutScanStartRef.current;
    usbOutScanStartRef.current = null;

    if (!canQrScan) {
      rawOutPayloadRef.current = '';
      setOutQrDetected(false);
      setLastOutResult({
        success: false,
        action: 'REJECTED',
        scannerType: 'OUT',
        message: 'Access denied: Your role lacks QR Code Scanning permission (attendance.qr.scan).',
        time: new Date().toLocaleTimeString(),
      });
      playSound('error');
      return;
    }

    // Keep internal scanned payload preserved until the Punch Out API request completes
    rawOutPayloadRef.current = clean;
    setOutQrDetected(true);
    inFlightOutRef.current = true;
    const e2eStart = performance.now();
    const parseStart = performance.now();
    parseQrPayload(clean);
    const clientParseMs = Math.max(0.01, performance.now() - parseStart);
    const qrDetectMs =
      source === 'USB_SCANNER' && usbStart !== null
        ? Math.max(0.01, e2eStart - usbStart)
        : Math.max(0.01, e2eStart - detectStart);
    recordPerfMetric('qr_detect_ms', qrDetectMs);
    recordPerfMetric('qr_parse_ms', clientParseMs);

    setPendingGateFeedback(prev => ({ ...prev, OUT: { mode: 'QR', detectedAt: Date.now() } }));
    setIsProcessingOut(true);
    try {
      const result = await processDualAttendanceScan({
        rawPayload: rawOutPayloadRef.current,
        scannerType: 'OUT',
        scannerDevice: source,
        clientRequestId: createClientRequestId('qrout'),
      });

      const uiDisplayStart = performance.now();
      const networkApiMs = result.perf?.networkApiMs ?? (uiDisplayStart - e2eStart);
      const totalE2eMs = performance.now() - e2eStart;
      const sanitizedMessage = result.success
        ? result.message
        : sanitizeQrErrorMessage(result.message, clean);
      const totalPunchOutMs = Number(totalE2eMs.toFixed(2));
      const enriched: ScanResult = {
        ...result,
        message: sanitizedMessage,
        perf: {
          ...result.perf,
          qrDetectMs: Number(qrDetectMs.toFixed(2)),
          qrParseMs: Number(((result.perf?.qrParseMs ?? 0) + clientParseMs).toFixed(2)),
          networkApiMs: Number(networkApiMs.toFixed(2)),
          uiDisplayMs: Number((performance.now() - uiDisplayStart).toFixed(2)),
          totalEndToEndMs: totalPunchOutMs,
          totalPunchOutMs,
        },
      };

      recordPerfMetric('qr_api_ms', networkApiMs);
      recordPerfMetric('qr_scan_e2e_ms', totalE2eMs);
      recordPerfMetric('qr_punch_out_e2e_ms', totalE2eMs);
      if (typeof result.perf?.totalServerMs === 'number') {
        recordPerfMetric('qr_scan_server_ms', result.perf.totalServerMs);
      }
      if (typeof result.perf?.authMs === 'number') {
        recordPerfMetric('qr_auth_token_ms', result.perf.authMs + (result.perf.tokenValidationMs ?? 0));
      }
      if (typeof result.perf?.firestoreOpMs === 'number') {
        recordPerfMetric('qr_firestore_ms', result.perf.firestoreOpMs);
      }

      setLastOutResult(enriched);
      setRecentEvents(prev => [enriched, ...prev.slice(0, 9)]);

      if (enriched.success) {
        playSound('success_out');
        notifyAttendanceCommitted({
          scannerType: 'OUT',
          action: 'PUNCH_OUT',
          attendanceId: enriched.attendance?.id,
          shiftDate: enriched.attendance?.shiftDate,
          timestamp: Date.now(),
        });
        onAttendanceUpdated?.();
      } else {
        playSound('error');
      }
    } catch (err: any) {
      const safeErrMsg = sanitizeQrErrorMessage(
        String(err?.message || 'System error processing Punch Out.'),
        clean
      );
      console.error('Punch Out Error:', safeErrMsg);
      const fallback: ScanResult = {
        success: false,
        action: 'REJECTED',
        scannerType: 'OUT',
        message: safeErrMsg.includes('timed out') || safeErrMsg.includes('Unable to reach')
          ? `Network interrupted: ${safeErrMsg}`
          : safeErrMsg,
        time: new Date().toLocaleTimeString(),
      };
      setLastOutResult(fallback);
      playSound('error');
    } finally {
      inFlightOutRef.current = false;
      rawOutPayloadRef.current = '';
      usbOutScanStartRef.current = null;
      setOutQrDetected(false);
      setIsProcessingOut(false);
      setPendingGateFeedback(prev => ({ ...prev, OUT: undefined }));
      restoreTargetFocus('OUT', 'QR');
    }
  }, [canQrScan, onAttendanceUpdated, playSound, restoreTargetFocus]);

  const handlePunchInRef = useRef(handlePunchIn);
  const handlePunchOutRef = useRef(handlePunchOut);
  handlePunchInRef.current = handlePunchIn;
  handlePunchOutRef.current = handlePunchOut;

  // Process Authorized Manual Employee ID Punch In
  const handleManualPunchIn = useCallback(async (empId: string) => {
    const clean = empId.trim().toUpperCase();
    if (!clean || inFlightManualInRef.current) return;
    if (!canManualEntry) {
      setLastInResult({
        success: false,
        action: 'REJECTED',
        scannerType: 'IN',
        message: 'Access denied: Your role lacks Manual Employee ID Entry permission (attendance.manual.entry).',
        time: new Date().toLocaleTimeString(),
      });
      playSound('error');
      return;
    }

    inFlightManualInRef.current = true;
    const e2eStart = performance.now();
    setPendingGateFeedback(prev => ({ ...prev, IN: { mode: 'MANUAL', detectedAt: Date.now() } }));
    setIsProcessingManualIn(true);
    try {
      const result = await processManualAttendancePunch({
        employeeId: clean,
        scannerType: 'IN',
        clientRequestId: createClientRequestId('manin'),
      });

      const uiDisplayStart = performance.now();
      const networkApiMs = result.perf?.networkApiMs ?? (uiDisplayStart - e2eStart);
      const totalE2eMs = performance.now() - e2eStart;
      const enriched: ScanResult = {
        ...result,
        perf: {
          ...result.perf,
          networkApiMs: Number(networkApiMs.toFixed(2)),
          uiDisplayMs: Number((performance.now() - uiDisplayStart).toFixed(2)),
          totalEndToEndMs: Number(totalE2eMs.toFixed(2)),
        },
      };

      recordPerfMetric('manual_punch_e2e_ms', totalE2eMs);
      if (typeof result.perf?.totalServerMs === 'number') {
        recordPerfMetric('manual_punch_server_ms', result.perf.totalServerMs);
      }

      setLastInResult(enriched);
      setRecentEvents(prev => [enriched, ...prev.slice(0, 9)]);

      if (enriched.success) {
        setManualInId('');
        if (isAttendanceLate(enriched.attendance)) {
          playSound('warning');
        } else {
          playSound('success_in');
        }
        notifyAttendanceCommitted({
          scannerType: 'IN',
          action: 'PUNCH_IN',
          attendanceId: enriched.attendance?.id,
          shiftDate: enriched.attendance?.shiftDate,
          timestamp: Date.now(),
        });
        onAttendanceUpdated?.();
      } else {
        playSound('error');
      }
    } catch (err: any) {
      console.error('Manual Punch In Error:', err);
      const msg = String(err?.message || 'System error processing manual Punch In.');
      const fallback: ScanResult = {
        success: false,
        action: 'REJECTED',
        scannerType: 'IN',
        message: msg.includes('timed out') || msg.includes('Unable to reach')
          ? `Network interrupted: ${msg}`
          : msg,
        time: new Date().toLocaleTimeString(),
      };
      setLastInResult(fallback);
      playSound('error');
    } finally {
      inFlightManualInRef.current = false;
      setIsProcessingManualIn(false);
      setPendingGateFeedback(prev => ({ ...prev, IN: undefined }));
      restoreTargetFocus('IN', 'MANUAL');
    }
  }, [canManualEntry, onAttendanceUpdated, playSound, restoreTargetFocus]);

  // Process Authorized Manual Employee ID Punch Out
  const handleManualPunchOut = useCallback(async (empId: string) => {
    const clean = empId.trim().toUpperCase();
    if (!clean || inFlightManualOutRef.current) return;
    if (!canManualEntry) {
      setLastOutResult({
        success: false,
        action: 'REJECTED',
        scannerType: 'OUT',
        message: 'Access denied: Your role lacks Manual Employee ID Entry permission (attendance.manual.entry).',
        time: new Date().toLocaleTimeString(),
      });
      playSound('error');
      return;
    }

    inFlightManualOutRef.current = true;
    const e2eStart = performance.now();
    setPendingGateFeedback(prev => ({ ...prev, OUT: { mode: 'MANUAL', detectedAt: Date.now() } }));
    setIsProcessingManualOut(true);
    try {
      const result = await processManualAttendancePunch({
        employeeId: clean,
        scannerType: 'OUT',
        clientRequestId: createClientRequestId('manout'),
      });

      const uiDisplayStart = performance.now();
      const networkApiMs = result.perf?.networkApiMs ?? (uiDisplayStart - e2eStart);
      const totalE2eMs = performance.now() - e2eStart;
      const enriched: ScanResult = {
        ...result,
        perf: {
          ...result.perf,
          networkApiMs: Number(networkApiMs.toFixed(2)),
          uiDisplayMs: Number((performance.now() - uiDisplayStart).toFixed(2)),
          totalEndToEndMs: Number(totalE2eMs.toFixed(2)),
        },
      };

      recordPerfMetric('manual_punch_e2e_ms', totalE2eMs);
      if (typeof result.perf?.totalServerMs === 'number') {
        recordPerfMetric('manual_punch_server_ms', result.perf.totalServerMs);
      }

      setLastOutResult(enriched);
      setRecentEvents(prev => [enriched, ...prev.slice(0, 9)]);

      if (enriched.success) {
        setManualOutId('');
        playSound('success_out');
        notifyAttendanceCommitted({
          scannerType: 'OUT',
          action: 'PUNCH_OUT',
          attendanceId: enriched.attendance?.id,
          shiftDate: enriched.attendance?.shiftDate,
          timestamp: Date.now(),
        });
        onAttendanceUpdated?.();
      } else {
        playSound('error');
      }
    } catch (err: any) {
      console.error('Manual Punch Out Error:', err);
      const msg = String(err?.message || 'System error processing manual Punch Out.');
      const fallback: ScanResult = {
        success: false,
        action: 'REJECTED',
        scannerType: 'OUT',
        message: msg.includes('timed out') || msg.includes('Unable to reach')
          ? `Network interrupted: ${msg}`
          : msg,
        time: new Date().toLocaleTimeString(),
      };
      setLastOutResult(fallback);
      playSound('error');
    } finally {
      inFlightManualOutRef.current = false;
      setIsProcessingManualOut(false);
      setPendingGateFeedback(prev => ({ ...prev, OUT: undefined }));
      restoreTargetFocus('OUT', 'MANUAL');
    }
  }, [canManualEntry, onAttendanceUpdated, playSound, restoreTargetFocus]);

  // Dynamically load Webcam QR Reader only when webcam camera is opened
  useEffect(() => {
    let cancelled = false;

    const cleanupScanner = () => {
      if (webcamScannerRef.current) {
        webcamScannerRef.current.clear().catch(console.error);
        webcamScannerRef.current = null;
      }
    };

    if (webcamStation === 'NONE') {
      cleanupScanner();
      return cleanupScanner;
    }

    import('html5-qrcode')
      .then(({ Html5QrcodeScanner }) => {
        if (cancelled) return;
        const containerEl = document.getElementById('dual-qr-reader-container');
        if (!containerEl) return;
        const scanner = new Html5QrcodeScanner(
          'dual-qr-reader-container',
          {
            fps: 24,
            qrbox: { width: 250, height: 250 },
            rememberLastUsedCamera: true,
            experimentalFeatures: { useBarCodeDetectorIfSupported: true },
          } as any,
          false
        );

        scanner.render(
          (decodedText: string) => {
            const frameKey = `${webcamStation}:${decodedText.trim()}`;
            const nowTs = Date.now();
            const last = lastWebcamScanRef.current;
            if (last && last.key === frameKey && nowTs - last.at < 1800) {
              return;
            }
            lastWebcamScanRef.current = { key: frameKey, at: nowTs };
            if (webcamStation === 'IN') {
              handlePunchInRef.current(decodedText, 'WEBCAM');
            } else if (webcamStation === 'OUT') {
              handlePunchOutRef.current(decodedText, 'WEBCAM');
            }
          },
          () => {}
        );
        webcamScannerRef.current = scanner;
      })
      .catch((err) => {
        console.error('Failed to load webcam QR scanner:', err);
      });

    return () => {
      cancelled = true;
      cleanupScanner();
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
            type="button"
            onClick={() => setSoundEnabled(!soundEnabled)}
            className={`p-2 rounded border text-xs flex items-center gap-1.5 transition cursor-pointer ${
              soundEnabled 
                ? 'bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-700' 
                : 'bg-red-950/80 border-red-800 text-red-300'
            }`}
            title="Toggle sound chime"
          >
            {soundEnabled ? <Volume2 className="w-4 h-4 text-emerald-400" /> : <VolumeX className="w-4 h-4 text-red-400" />}
          </button>

          {/* Full Screen Mode Toggle Button */}
          {onToggleFullscreen && (
            <button
              type="button"
              onClick={isFullscreen && onExitFullscreen ? onExitFullscreen : onToggleFullscreen}
              className={`px-3 py-1.5 rounded-lg border text-xs font-semibold flex items-center gap-1.5 transition shadow-sm cursor-pointer ${
                isFullscreen
                  ? 'bg-red-600 hover:bg-red-500 border-red-500 text-white'
                  : 'bg-blue-600 hover:bg-blue-500 border-blue-500 text-white'
              }`}
              title={isFullscreen ? 'Exit Full Screen Mode (or press ESC)' : 'Enter Full Screen Attendance Scanner Mode'}
            >
              {isFullscreen ? (
                <>
                  <Minimize2 className="w-4 h-4 shrink-0" />
                  <span>Exit Full Screen</span>
                  <kbd className="hidden sm:inline-block text-[10px] bg-red-800/90 px-1.5 py-0.5 rounded font-mono font-normal">
                    ESC
                  </kbd>
                </>
              ) : (
                <>
                  <Maximize2 className="w-4 h-4 shrink-0" />
                  <span>Full Screen</span>
                </>
              )}
            </button>
          )}
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
      <div className={`flex-1 p-4 sm:p-6 grid grid-cols-1 lg:grid-cols-12 gap-5 sm:gap-6 w-full ${isFullscreen ? 'max-w-none' : 'max-w-7xl mx-auto'}`}>
        {!canQrScan && !canManualEntry && (
          <div className="lg:col-span-12 bg-red-950/50 border border-red-700/80 rounded-xl p-5 flex items-start gap-3 text-red-100 shadow-lg">
            <Lock className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            <div>
              <h3 className="text-sm font-bold text-white uppercase tracking-wide">
                Attendance Entry Methods Restricted
              </h3>
              <p className="text-xs text-red-200 mt-1">
                Your role currently does not have permission for <strong>QR Code Scanning</strong> (<code className="font-mono">attendance.qr.scan</code>) or <strong>Manual Employee ID Entry</strong> (<code className="font-mono">attendance.manual.entry</code>). Contact Super Admin to enable one or both methods in Role Permissions Management.
              </p>
            </div>
          </div>
        )}

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

                  {canQrScan ? (
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
                  ) : (
                    <span className="px-2 py-1 rounded text-[10px] font-mono bg-slate-950 border border-slate-800 text-slate-500 flex items-center gap-1">
                      <Lock className="w-3 h-3" />
                      <span>QR Off</span>
                    </span>
                  )}
                </div>

                {/* USB Scanner / Camera QR Code Input Field */}
                <div className="mt-4">
                  <label className="text-[11px] text-slate-400 uppercase font-semibold mb-1 block">
                    Scan Employee QR Card (USB / Camera)
                  </label>
                  {canQrScan ? (
                    <div className="relative">
                      <input
                        ref={inInputRef}
                        type="text"
                        aria-label="Punch In QR Scanner Input"
                        autoComplete="off"
                        spellCheck={false}
                        data-qr-masked="true"
                        value={getMaskedQrInputValue(inQrDetected, isProcessingIn)}
                        onChange={(e) => {
                          if (isProcessingIn) return;
                          if (!rawInPayloadRef.current && usbInScanStartRef.current === null) {
                            usbInScanStartRef.current = performance.now();
                          }
                          const maskVal = getMaskedQrInputValue(inQrDetected, isProcessingIn);
                          const { nextRawPayload, hasDetectedPayload } = applyQrInputChange(
                            rawInPayloadRef.current,
                            e.target.value,
                            maskVal
                          );
                          rawInPayloadRef.current = nextRawPayload;
                          if (!hasDetectedPayload) {
                            usbInScanStartRef.current = null;
                          }
                          setInQrDetected(hasDetectedPayload);
                          if (hasDetectedPayload && lastInResult && !lastInResult.success) {
                            setLastInResult(null);
                          }
                        }}
                        onPaste={(e) => {
                          e.preventDefault();
                          if (isProcessingIn) return;
                          const pasted = e.clipboardData?.getData('text') || '';
                          if (pasted.trim()) {
                            usbInScanStartRef.current = performance.now();
                            rawInPayloadRef.current = pasted;
                            setInQrDetected(true);
                            if (lastInResult && !lastInResult.success) {
                              setLastInResult(null);
                            }
                          }
                        }}
                        onFocus={() => setActiveFocus('IN')}
                        onKeyDown={(e) => {
                          if (isProcessingIn) {
                            e.preventDefault();
                            return;
                          }
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            if (rawInPayloadRef.current.trim()) {
                              handlePunchIn(rawInPayloadRef.current, 'USB_SCANNER');
                            }
                          } else if (e.key === 'Backspace' || e.key === 'Delete' || e.key === 'Escape') {
                            e.preventDefault();
                            rawInPayloadRef.current = '';
                            usbInScanStartRef.current = null;
                            setInQrDetected(false);
                          } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                            e.preventDefault();
                            if (!rawInPayloadRef.current && usbInScanStartRef.current === null) {
                              usbInScanStartRef.current = performance.now();
                            }
                            rawInPayloadRef.current += e.key;
                            if (!inQrDetected) setInQrDetected(true);
                            if (lastInResult && !lastInResult.success) {
                              setLastInResult(null);
                            }
                          }
                        }}
                        disabled={isProcessingIn}
                        placeholder="Scan QR Badge (Punch In Ready)..."
                        className={`w-full bg-slate-950 border border-slate-700 focus:border-emerald-500 rounded-lg px-3.5 py-2.5 pr-28 text-sm font-mono placeholder-slate-500 focus:outline-hidden focus:ring-1 focus:ring-emerald-500 transition ${
                          isProcessingIn || inQrDetected ? 'text-emerald-300 font-semibold' : 'text-white'
                        }`}
                      />
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (rawInPayloadRef.current.trim()) {
                            handlePunchIn(rawInPayloadRef.current, 'USB_SCANNER');
                          }
                        }}
                        disabled={isProcessingIn || !inQrDetected}
                        className="absolute right-1.5 top-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-semibold px-3 py-1.5 rounded transition"
                      >
                        {isProcessingIn ? 'Verifying...' : 'Scan In'}
                      </button>
                    </div>
                  ) : (
                    <div className="rounded-lg bg-slate-950/70 border border-slate-800 px-3 py-2.5 text-[11px] text-slate-400 flex items-center gap-2">
                      <Lock className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                      <span>QR Code Scanning disabled for your role (<code className="font-mono text-slate-300">attendance.qr.scan</code>).</span>
                    </div>
                  )}
                </div>

                {/* Separate Authorized Manual Employee ID Entry */}
                <div
                  onClick={(e) => {
                    e.stopPropagation();
                    setActiveFocus('IN');
                  }}
                  className="mt-3 p-3 rounded-lg bg-slate-950/70 border border-slate-800/90"
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-[11px] text-emerald-300/90 uppercase font-semibold flex items-center gap-1.5">
                      <Keyboard className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Manual Employee ID Entry</span>
                    </label>
                    <span className={`text-[10px] font-mono ${canManualEntry ? 'text-emerald-400' : 'text-slate-500'}`}>
                      {canManualEntry ? 'Authorized' : 'Restricted'}
                    </span>
                  </div>
                  {canManualEntry ? (
                    <div className="flex items-center gap-2">
                      <input
                        ref={manualInInputRef}
                        type="text"
                        value={manualInId}
                        onChange={(e) => setManualInId(e.target.value.toUpperCase())}
                        onFocus={() => setActiveFocus('IN')}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleManualPunchIn(manualInId);
                          }
                        }}
                        disabled={isProcessingManualIn}
                        placeholder="Enter Employee ID (e.g. MSI1335)"
                        className="flex-1 min-w-0 bg-slate-900 border border-slate-700 focus:border-emerald-500 rounded-lg px-3 py-2 text-xs text-white font-mono uppercase placeholder-slate-500 focus:outline-hidden focus:ring-1 focus:ring-emerald-500 transition"
                      />
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleManualPunchIn(manualInId);
                        }}
                        disabled={isProcessingManualIn || !manualInId.trim()}
                        className="shrink-0 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-white text-xs font-semibold px-3 py-2 rounded-lg transition cursor-pointer"
                      >
                        {isProcessingManualIn ? 'Saving...' : 'Manual In'}
                      </button>
                    </div>
                  ) : (
                    <div className="text-[11px] text-slate-400 flex items-center gap-2 py-1">
                      <Lock className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                      <span>Manual ID entry disabled for your role (<code className="font-mono text-slate-300">attendance.manual.entry</code>).</span>
                    </div>
                  )}
                </div>

                {/* Latest Punch In Result Badge */}
                <div className="mt-4 flex-1 flex flex-col justify-center gap-2.5">
                  {pendingGateFeedback.IN && (
                    <div
                      role="status"
                      className="px-3.5 py-2.5 rounded-lg border border-emerald-500/60 bg-emerald-950/40 text-emerald-200 flex items-center justify-between text-xs"
                    >
                      <span className="flex items-center gap-2 font-semibold">
                        <span className="w-3.5 h-3.5 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin shrink-0" />
                        {pendingGateFeedback.IN.mode === 'QR'
                          ? 'QR Code Detected ✓ — Verifying QR...'
                          : 'Submitting manual Punch In...'}
                      </span>
                      <span className="text-[10px] font-mono text-emerald-300">WAIT</span>
                    </div>
                  )}
                  {lastInResult ? (
                    <div 
                      className={`p-4 rounded-lg border flex flex-col gap-3 transition-all ${
                        lastInResult.success
                          ? isAttendanceLate(lastInResult.attendance)
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
                              {lastInResult.shift?.name || 'DAY SHIFT'} • INSIDE / IN PROGRESS
                              {isAttendanceLate(lastInResult.attendance) ? ' (LATE)' : ''}
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

                  {canQrScan ? (
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
                  ) : (
                    <span className="px-2 py-1 rounded text-[10px] font-mono bg-slate-950 border border-slate-800 text-slate-500 flex items-center gap-1">
                      <Lock className="w-3 h-3" />
                      <span>QR Off</span>
                    </span>
                  )}
                </div>

                {/* USB Scanner / Camera QR Code Input Field */}
                <div className="mt-4">
                  <label className="text-[11px] text-slate-400 uppercase font-semibold mb-1 block">
                    Scan Employee QR Card (USB / Camera)
                  </label>
                  {canQrScan ? (
                    <div className="relative">
                      <input
                        ref={outInputRef}
                        type="text"
                        aria-label="Punch Out QR Scanner Input"
                        autoComplete="off"
                        spellCheck={false}
                        data-qr-masked="true"
                        value={getMaskedQrInputValue(outQrDetected, isProcessingOut)}
                        onChange={(e) => {
                          if (isProcessingOut) return;
                          if (!rawOutPayloadRef.current && usbOutScanStartRef.current === null) {
                            usbOutScanStartRef.current = performance.now();
                          }
                          const maskVal = getMaskedQrInputValue(outQrDetected, isProcessingOut);
                          const { nextRawPayload, hasDetectedPayload } = applyQrInputChange(
                            rawOutPayloadRef.current,
                            e.target.value,
                            maskVal
                          );
                          rawOutPayloadRef.current = nextRawPayload;
                          if (!hasDetectedPayload) {
                            usbOutScanStartRef.current = null;
                          }
                          setOutQrDetected(hasDetectedPayload);
                          if (hasDetectedPayload && lastOutResult && !lastOutResult.success) {
                            setLastOutResult(null);
                          }
                        }}
                        onPaste={(e) => {
                          e.preventDefault();
                          if (isProcessingOut) return;
                          const pasted = e.clipboardData?.getData('text') || '';
                          if (pasted.trim()) {
                            usbOutScanStartRef.current = performance.now();
                            rawOutPayloadRef.current = pasted;
                            setOutQrDetected(true);
                            if (lastOutResult && !lastOutResult.success) {
                              setLastOutResult(null);
                            }
                          }
                        }}
                        onFocus={() => setActiveFocus('OUT')}
                        onKeyDown={(e) => {
                          if (isProcessingOut) {
                            e.preventDefault();
                            return;
                          }
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            if (rawOutPayloadRef.current.trim()) {
                              handlePunchOut(rawOutPayloadRef.current, 'USB_SCANNER');
                            }
                          } else if (e.key === 'Backspace' || e.key === 'Delete' || e.key === 'Escape') {
                            e.preventDefault();
                            rawOutPayloadRef.current = '';
                            usbOutScanStartRef.current = null;
                            setOutQrDetected(false);
                          } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                            e.preventDefault();
                            if (!rawOutPayloadRef.current && usbOutScanStartRef.current === null) {
                              usbOutScanStartRef.current = performance.now();
                            }
                            rawOutPayloadRef.current += e.key;
                            if (!outQrDetected) setOutQrDetected(true);
                            if (lastOutResult && !lastOutResult.success) {
                              setLastOutResult(null);
                            }
                          }
                        }}
                        disabled={isProcessingOut}
                        placeholder="Scan QR Badge (Punch Out Ready)..."
                        className={`w-full bg-slate-950 border border-slate-700 focus:border-indigo-500 rounded-lg px-3.5 py-2.5 pr-28 text-sm font-mono placeholder-slate-500 focus:outline-hidden focus:ring-1 focus:ring-indigo-500 transition ${
                          isProcessingOut || outQrDetected ? 'text-indigo-300 font-semibold' : 'text-white'
                        }`}
                      />
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (rawOutPayloadRef.current.trim()) {
                            handlePunchOut(rawOutPayloadRef.current, 'USB_SCANNER');
                          }
                        }}
                        disabled={isProcessingOut || !outQrDetected}
                        className="absolute right-1.5 top-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs font-semibold px-3 py-1.5 rounded transition"
                      >
                        {isProcessingOut ? 'Verifying...' : 'Scan Out'}
                      </button>
                    </div>
                  ) : (
                    <div className="rounded-lg bg-slate-950/70 border border-slate-800 px-3 py-2.5 text-[11px] text-slate-400 flex items-center gap-2">
                      <Lock className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                      <span>QR Code Scanning disabled for your role (<code className="font-mono text-slate-300">attendance.qr.scan</code>).</span>
                    </div>
                  )}
                </div>

                {/* Separate Authorized Manual Employee ID Entry */}
                <div
                  onClick={(e) => {
                    e.stopPropagation();
                    setActiveFocus('OUT');
                  }}
                  className="mt-3 p-3 rounded-lg bg-slate-950/70 border border-slate-800/90"
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-[11px] text-indigo-300/90 uppercase font-semibold flex items-center gap-1.5">
                      <Keyboard className="w-3.5 h-3.5 text-indigo-400" />
                      <span>Manual Employee ID Entry</span>
                    </label>
                    <span className={`text-[10px] font-mono ${canManualEntry ? 'text-indigo-400' : 'text-slate-500'}`}>
                      {canManualEntry ? 'Authorized' : 'Restricted'}
                    </span>
                  </div>
                  {canManualEntry ? (
                    <div className="flex items-center gap-2">
                      <input
                        ref={manualOutInputRef}
                        type="text"
                        value={manualOutId}
                        onChange={(e) => setManualOutId(e.target.value.toUpperCase())}
                        onFocus={() => setActiveFocus('OUT')}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleManualPunchOut(manualOutId);
                          }
                        }}
                        disabled={isProcessingManualOut}
                        placeholder="Enter Employee ID (e.g. MSI1335)"
                        className="flex-1 min-w-0 bg-slate-900 border border-slate-700 focus:border-indigo-500 rounded-lg px-3 py-2 text-xs text-white font-mono uppercase placeholder-slate-500 focus:outline-hidden focus:ring-1 focus:ring-indigo-500 transition"
                      />
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleManualPunchOut(manualOutId);
                        }}
                        disabled={isProcessingManualOut || !manualOutId.trim()}
                        className="shrink-0 bg-indigo-700 hover:bg-indigo-600 disabled:opacity-40 text-white text-xs font-semibold px-3 py-2 rounded-lg transition cursor-pointer"
                      >
                        {isProcessingManualOut ? 'Saving...' : 'Manual Out'}
                      </button>
                    </div>
                  ) : (
                    <div className="text-[11px] text-slate-400 flex items-center gap-2 py-1">
                      <Lock className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                      <span>Manual ID entry disabled for your role (<code className="font-mono text-slate-300">attendance.manual.entry</code>).</span>
                    </div>
                  )}
                </div>

                {/* Latest Punch Out Result Badge */}
                <div className="mt-4 flex-1 flex flex-col justify-center gap-2.5">
                  {pendingGateFeedback.OUT && (
                    <div
                      role="status"
                      className="px-3.5 py-2.5 rounded-lg border border-indigo-500/60 bg-indigo-950/40 text-indigo-200 flex items-center justify-between text-xs"
                    >
                      <span className="flex items-center gap-2 font-semibold">
                        <span className="w-3.5 h-3.5 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin shrink-0" />
                        {pendingGateFeedback.OUT.mode === 'QR'
                          ? 'QR Code Detected ✓ — Verifying QR...'
                          : 'Submitting manual Punch Out...'}
                      </span>
                      <span className="text-[10px] font-mono text-indigo-300">WAIT</span>
                    </div>
                  )}
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

                      {lastOutResult.employee && (() => {
                        const resolvedOut = resolveAttendanceMetrics(lastOutResult.attendance);
                        return (
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
                                {lastOutResult.attendance
                                  ? `${formatDurationClock(resolvedOut.completedDutyMinutes)} Hours`
                                  : lastOutResult.dutyFormatted || '08:30 Hours'}
                              </span>
                            </div>
                            <div>
                              <span className="text-slate-400 block text-[10px]">OVERTIME (OT)</span>
                              <span className="font-bold text-amber-400 block">
                                {resolvedOut.overtimeMinutes > 0
                                  ? resolvedOut.otLabel
                                  : lastOutResult.otFormatted && lastOutResult.otFormatted !== '00:00 Hours'
                                    ? lastOutResult.otFormatted
                                    : '00:00 Hours'}
                              </span>
                            </div>
                            <div>
                              <span className="text-slate-400 block text-[10px]">STATE &amp; STATUS</span>
                              <span className="font-semibold text-slate-200 block">
                                OUTSIDE • {resolvedOut.status} (Punch #{lastOutResult.punchCount || 2})
                              </span>
                            </div>
                          </div>
                        );
                      })()}
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
