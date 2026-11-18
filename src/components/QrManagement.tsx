import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  QrCode, 
  Printer, 
  Download, 
  Search, 
  RotateCcw, 
  X,
  AlertTriangle,
  RefreshCw,
  ChevronLeft,
  ChevronRight
} from 'lucide-react';
import { Employee, Floor, Department } from '../types';
import { regenerateQrToken } from '../services/employeeService';
import { QrManagementSkeleton } from './Skeletons';
import {
  IDENTITY_CARD_HEADER_TEXT,
  buildEmployeeQrPayload,
  downloadEmployeeIdentityCardPng,
} from '../utils/qrIdentityCard';

interface EmployeeIdentityPrintCardProps {
  employee: Employee;
  qrUrl?: string;
}

export const EmployeeIdentityPrintCard: React.FC<EmployeeIdentityPrintCardProps> = ({
  employee,
  qrUrl,
}) => (
  <div className="qr-identity-print-card border border-slate-300 rounded-lg overflow-hidden flex flex-col items-center text-center bg-white shadow-2xs">
    {/* Top Corporate Bar */}
    <div className="w-full h-1.5 bg-blue-900" />

    {/* HEADER */}
    <div className="w-full bg-slate-50 border-b border-slate-200 px-3 py-2 text-center">
      <div className="text-[9px] font-bold tracking-[0.14em] text-blue-900 uppercase">
        {IDENTITY_CARD_HEADER_TEXT.title}
      </div>
      <div className="text-xs font-extrabold text-slate-900 leading-tight mt-0.5">
        {IDENTITY_CARD_HEADER_TEXT.brand}
      </div>
    </div>

    {/* CENTER: Pure Unobstructed QR Code */}
    <div className="px-4 pt-3 pb-2 flex items-center justify-center">
      <div className="w-32 h-32 bg-white border border-slate-300 p-1.5 rounded flex items-center justify-center">
        {qrUrl ? (
          <img
            src={qrUrl}
            alt={employee.employeeId}
            className="w-full h-full object-contain"
          />
        ) : (
          <div className="w-full h-full bg-slate-100 rounded" />
        )}
      </div>
    </div>

    {/* EMPLOYEE DETAILS BELOW QR */}
    <div className="px-3 pb-2.5 w-full space-y-1">
      <div>
        <div className="text-[8px] font-bold uppercase tracking-wider text-slate-500">
          Employee ID
        </div>
        <div className="font-mono text-sm font-extrabold text-slate-900 leading-tight">
          {employee.employeeId}
        </div>
      </div>
      <div>
        <div className="text-[8px] font-bold uppercase tracking-wider text-slate-500">
          Employee Name
        </div>
        <div className="text-xs font-bold text-slate-900 leading-snug break-words">
          {employee.employeeName}
        </div>
      </div>
      <div>
        <div className="text-[8px] font-bold uppercase tracking-wider text-slate-500">
          Designation
        </div>
        <div className="text-[11px] font-bold text-blue-700 leading-tight break-words">
          {employee.designation || '—'}
        </div>
      </div>
    </div>

    {/* BOTTOM DETAILS */}
    <div className="w-full mt-auto bg-slate-50 border-t border-slate-200 grid grid-cols-3 divide-x divide-slate-200 text-center">
      <div className="px-1.5 py-2">
        <span className="block text-[8px] font-bold uppercase tracking-wider text-slate-500">
          Line
        </span>
        <span className="block text-[10px] font-bold text-slate-900 leading-tight mt-0.5 break-words">
          {employee.floor || '—'}
        </span>
      </div>
      <div className="px-1.5 py-2">
        <span className="block text-[8px] font-bold uppercase tracking-wider text-slate-500">
          Section
        </span>
        <span className="block text-[10px] font-bold text-slate-900 leading-tight mt-0.5 break-words">
          {employee.section || '—'}
        </span>
      </div>
      <div className="px-1.5 py-2">
        <span className="block text-[8px] font-bold uppercase tracking-wider text-slate-500">
          Department
        </span>
        <span className="block text-[10px] font-bold text-slate-900 leading-tight mt-0.5 break-words">
          {employee.department || '—'}
        </span>
      </div>
    </div>
  </div>
);

interface QrManagementProps {
  employees: Employee[];
  floors: Floor[];
  departments: Department[];
  isLoading?: boolean;
  loadError?: string | null;
  onRefresh: () => void;
}

export const QrManagement: React.FC<QrManagementProps> = ({
  employees,
  floors,
  departments,
  isLoading = false,
  loadError = null,
  onRefresh,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [filterFloor, setFilterFloor] = useState('ALL');
  const [filterDept, setFilterDept] = useState('ALL');
  const [qrImages, setQrImages] = useState<Record<string, string>>({});
  const [selectedForPrint, setSelectedForPrint] = useState<Set<string>>(new Set());
  const [singlePrintEmpId, setSinglePrintEmpId] = useState<string | null>(null);
  const [isPrintModalOpen, setIsPrintModalOpen] = useState(false);
  const [confirmRegenId, setConfirmRegenId] = useState<string | null>(null);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(24);
  const qrCacheRef = useRef<Map<string, string>>(new Map());

  // Active employees only (memoized)
  const activeEmployees = useMemo(
    () => employees.filter(e => e.employeeStatus === 'Active'),
    [employees]
  );

  const filtered = useMemo(() => {
    const s = searchTerm.trim().toLowerCase();
    return activeEmployees.filter(emp => {
      if (s !== '') {
        if (!emp.employeeId.toLowerCase().includes(s) && !emp.employeeName.toLowerCase().includes(s)) {
          return false;
        }
      }
      if (filterFloor !== 'ALL' && emp.floor !== filterFloor) return false;
      if (filterDept !== 'ALL' && emp.department !== filterDept) return false;
      return true;
    });
  }, [activeEmployees, searchTerm, filterFloor, filterDept]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const paginatedFiltered = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return filtered.slice(start, start + pageSize);
  }, [filtered, safePage, pageSize]);

  const printEmployees = useMemo(() => {
    if (!isPrintModalOpen) return [];
    if (singlePrintEmpId) {
      return employees.filter((e) => e.employeeId === singlePrintEmpId);
    }
    return employees.filter((e) => selectedForPrint.has(e.employeeId));
  }, [isPrintModalOpen, singlePrintEmpId, employees, selectedForPrint]);

  // Target list for QR image generation: current visible page, plus any print cards when print modal opens
  const qrRenderTargets = useMemo(() => {
    if (!isPrintModalOpen) {
      return paginatedFiltered;
    }
    const seen = new Set<string>();
    const combined: Employee[] = [];
    for (const emp of paginatedFiltered) {
      seen.add(emp.employeeId);
      combined.push(emp);
    }
    for (const emp of printEmployees) {
      if (!seen.has(emp.employeeId)) {
        seen.add(emp.employeeId);
        combined.push(emp);
      }
    }
    return combined;
  }, [paginatedFiltered, isPrintModalOpen, printEmployees]);

  // Generate QR data URLs in parallel batches for visible/selected employees with cache keyed by employeeId + qrCodeToken
  useEffect(() => {
    let cancelled = false;
    const generateQrs = async () => {
      const targetList = qrRenderTargets;
      if (targetList.length === 0) {
        return;
      }

      const QRCodeMod = await import('qrcode');
      const QRCode = QRCodeMod.default || QRCodeMod;
      if (cancelled) return;

      const map: Record<string, string> = {};
      const pending: Employee[] = [];

      for (const emp of targetList) {
        const cacheKey = `${emp.employeeId}:${emp.qrCodeToken}`;
        const cached = qrCacheRef.current.get(cacheKey);
        if (cached) {
          map[emp.employeeId] = cached;
        } else {
          pending.push(emp);
        }
      }

      if (pending.length === 0) {
        setQrImages((prev) => ({ ...prev, ...map }));
        return;
      }

      const BATCH_SIZE = 20;
      for (let i = 0; i < pending.length; i += BATCH_SIZE) {
        if (cancelled) return;
        const batch = pending.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(
          batch.map(async (emp) => {
            try {
              const payload = buildEmployeeQrPayload(emp);
              const dataUrl = await QRCode.toDataURL(payload, { width: 240, margin: 2 });
              return { emp, dataUrl };
            } catch (e) {
              console.error(e);
              return { emp, dataUrl: '' };
            }
          })
        );
        for (const { emp, dataUrl } of results) {
          if (dataUrl) {
            qrCacheRef.current.set(`${emp.employeeId}:${emp.qrCodeToken}`, dataUrl);
            map[emp.employeeId] = dataUrl;
          }
        }
      }

      if (!cancelled) {
        setQrImages((prev) => ({ ...prev, ...map }));
      }
    };
    generateQrs();
    return () => {
      cancelled = true;
    };
  }, [qrRenderTargets]);

  const toggleSelect = (empId: string) => {
    const next = new Set(selectedForPrint);
    if (next.has(empId)) next.delete(empId);
    else next.add(empId);
    setSelectedForPrint(next);
  };

  const selectAll = () => {
    if (selectedForPrint.size === filtered.length) {
      setSelectedForPrint(new Set());
    } else {
      setSelectedForPrint(new Set(filtered.map(e => e.employeeId)));
    }
  };

  const handleRegenerate = async (empId: string) => {
    setActionError(null);
    setRegeneratingId(empId);
    try {
      await regenerateQrToken(empId);
      setConfirmRegenId(null);
      onRefresh();
    } catch (e: any) {
      setActionError(e?.message || `Failed to re-issue QR security token for ${empId}.`);
    } finally {
      setRegeneratingId(null);
    }
  };

  const handleDownloadCard = async (emp: Employee) => {
    setActionError(null);
    setDownloadingId(emp.employeeId);
    try {
      await downloadEmployeeIdentityCardPng(emp);
    } catch (e: any) {
      setActionError(e?.message || `Failed to download QR identity card for ${emp.employeeId}.`);
    } finally {
      setDownloadingId(null);
    }
  };

  const handleOpenSinglePrint = (empId: string) => {
    setSinglePrintEmpId(empId);
    setIsPrintModalOpen(true);
  };

  const handleOpenBulkPrint = () => {
    setSinglePrintEmpId(null);
    if (selectedForPrint.size === 0) {
      setSelectedForPrint(new Set(filtered.map(e => e.employeeId)));
    }
    setIsPrintModalOpen(true);
  };

  const handleClosePrintModal = () => {
    setIsPrintModalOpen(false);
    setSinglePrintEmpId(null);
  };

  const printCards = () => {
    window.print();
  };

  if (isLoading && employees.length === 0 && !loadError) {
    return <QrManagementSkeleton />;
  }

  return (
    <div className="p-6 bg-slate-50 min-h-full flex flex-col gap-6">
      {/* Header */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
            <QrCode className="w-5 h-5 text-blue-600" />
            <span>QR CODE MANAGEMENT</span>
            {isLoading && (
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-600 bg-blue-50 px-2 py-0.5 rounded border border-blue-200">
                <RefreshCw className="w-3 h-3 animate-spin" />
                <span>Refreshing</span>
              </span>
            )}
          </h2>
          <p className="text-xs text-slate-500">
            Generate, validate, revoke, and print employee QR badges for continuous scanning
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleOpenBulkPrint}
            disabled={filtered.length === 0}
            className="bg-blue-600 hover:bg-blue-700 text-white font-medium text-xs px-4 py-2 rounded flex items-center gap-2 shadow-sm transition disabled:opacity-50"
          >
            <Printer className="w-4 h-4" />
            <span>Print Selected Cards ({selectedForPrint.size > 0 ? selectedForPrint.size : 'All'})</span>
          </button>
        </div>
      </div>

      {(loadError || actionError) && (
        <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-xl text-xs flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
            <span className="font-medium">{actionError || loadError}</span>
          </div>
          <div className="flex items-center gap-2">
            {loadError && (
              <button
                type="button"
                onClick={onRefresh}
                className="px-3 py-1.5 rounded bg-red-600 hover:bg-red-700 text-white font-semibold flex items-center gap-1 shrink-0"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Retry</span>
              </button>
            )}
            {actionError && (
              <button
                type="button"
                onClick={() => setActionError(null)}
                className="px-2 py-1 rounded border border-red-300 hover:bg-red-100 text-red-700 font-semibold"
              >
                Dismiss
              </button>
            )}
          </div>
        </div>
      )}

      {/* Filter and Selection Toolbar */}
      <div className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-2xs flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 bg-slate-50 border border-slate-300 rounded px-2.5 py-1.5 w-60">
            <Search className="w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder="Search by ID or Name..."
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                setPage(1);
              }}
              className="w-full bg-transparent border-none text-slate-800 focus:outline-hidden"
            />
          </div>

          <select
            value={filterFloor}
            onChange={(e) => {
              setFilterFloor(e.target.value);
              setPage(1);
            }}
            className="bg-white border border-slate-300 rounded px-2 py-1.5 text-slate-700"
          >
            <option value="ALL">All Lines</option>
            {floors.map(f => <option key={f.id} value={f.name}>{f.name}</option>)}
          </select>

          <select
            value={filterDept}
            onChange={(e) => {
              setFilterDept(e.target.value);
              setPage(1);
            }}
            className="bg-white border border-slate-300 rounded px-2 py-1.5 text-slate-700"
          >
            <option value="ALL">All Departments</option>
            {departments.map(d => <option key={d.id} value={d.name}>{d.name}</option>)}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[11px] text-slate-500">
            {filtered.length} Active {filtered.length === 1 ? 'Employee' : 'Employees'}
          </span>
          <button
            onClick={selectAll}
            disabled={filtered.length === 0}
            className="text-slate-600 hover:text-slate-900 border border-slate-300 px-3 py-1.5 rounded font-medium disabled:opacity-50"
          >
            {selectedForPrint.size === filtered.length && filtered.length > 0 ? 'Deselect All' : 'Select All Filtered'}
          </button>
        </div>
      </div>

      {/* Empty State or QR Cards Grid */}
      {filtered.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 p-10 text-center text-xs text-slate-400 shadow-2xs">
          No active employee QR badges match the selected filters.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {paginatedFiltered.map(emp => {
            const isSelected = selectedForPrint.has(emp.employeeId);
            const qrUrl = qrImages[emp.employeeId];
            const isConfirming = confirmRegenId === emp.employeeId;
            const isRegenerating = regeneratingId === emp.employeeId;

            return (
              <div
                key={emp.employeeId}
                className={`bg-white rounded-xl border p-4 shadow-2xs flex flex-col items-center text-center transition ${
                  isSelected ? 'border-blue-600 ring-2 ring-blue-500/20' : 'border-slate-200'
                }`}
              >
                {/* Select checkbox & Token status */}
                <div className="w-full flex items-center justify-between mb-2">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelect(emp.employeeId)}
                    className="rounded text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer"
                  />
                  <span className="text-[10px] bg-emerald-50 text-emerald-700 border border-emerald-200 px-1.5 py-0.5 rounded font-semibold">
                    Valid Token
                  </span>
                </div>

                {/* QR Code Canvas/Image */}
                <div className="w-36 h-36 bg-slate-50 border border-slate-200 rounded-lg p-2 flex items-center justify-center mb-3">
                  {qrUrl ? (
                    <img src={qrUrl} alt={emp.employeeId} className="w-full h-full object-contain" />
                  ) : (
                    <div className="w-full h-full bg-slate-200/70 rounded animate-pulse motion-reduce:animate-none" />
                  )}
                </div>

                {/* ID, Name & Designation */}
                <div className="font-mono text-base font-bold text-slate-900 tracking-wide">
                  {emp.employeeId}
                </div>
                <div className="text-sm font-bold text-slate-800 truncate max-w-full">
                  {emp.employeeName}
                </div>
                <div className="text-[11px] text-slate-500 font-medium truncate max-w-full">
                  {emp.designation || '—'}
                </div>
                <div className="text-xs text-blue-600 font-semibold mt-0.5">
                  {emp.floor} • {emp.section} • {emp.department}
                </div>

                {/* Actions */}
                <div className="w-full flex flex-wrap items-center justify-center gap-2 mt-4 pt-3 border-t border-slate-100 text-xs">
                  <button
                    type="button"
                    onClick={() => handleDownloadCard(emp)}
                    disabled={downloadingId === emp.employeeId || !emp.qrCodeToken}
                    className="px-2.5 py-1.5 rounded bg-slate-50 hover:bg-slate-100 text-slate-700 border border-slate-200 font-medium flex items-center gap-1.5 transition disabled:opacity-50"
                    title="Download Employee QR Identity Card (PNG)"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>{downloadingId === emp.employeeId ? 'Generating...' : 'Download QR'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleOpenSinglePrint(emp.employeeId)}
                    className="p-1.5 rounded hover:bg-blue-50 text-blue-700 border border-blue-200 transition"
                    title="Print Employee Identity Card"
                    aria-label={`Print ${emp.employeeId}`}
                  >
                    <Printer className="w-3.5 h-3.5" />
                  </button>
                  {isConfirming ? (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => handleRegenerate(emp.employeeId)}
                        disabled={isRegenerating}
                        className="px-2 py-1 rounded bg-amber-600 hover:bg-amber-700 text-white text-[10px] font-semibold disabled:opacity-50"
                      >
                        {isRegenerating ? 'Updating...' : 'Confirm'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmRegenId(null)}
                        disabled={isRegenerating}
                        className="px-2 py-1 rounded border border-slate-300 text-slate-600 hover:bg-slate-100 text-[10px]"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmRegenId(emp.employeeId)}
                      className="p-1.5 rounded hover:bg-amber-50 text-amber-700 border border-amber-200"
                      title="Revoke & Re-issue Security Token"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination Bar */}
      {filtered.length > 0 && (
        <div className="px-4 py-3 bg-white rounded-xl border border-slate-200 shadow-2xs flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
          <div className="flex items-center gap-2">
            <span>
              Showing{' '}
              <span className="font-semibold text-slate-800">
                {(safePage - 1) * pageSize + 1}–{Math.min(safePage * pageSize, filtered.length)}
              </span>{' '}
              of <span className="font-semibold text-slate-800">{filtered.length}</span> badges
            </span>
            <select
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(1);
              }}
              className="bg-white border border-slate-300 rounded px-2 py-1 text-slate-700"
              aria-label="Badges per page"
            >
              <option value={24}>24 / page</option>
              <option value={48}>48 / page</option>
              <option value={96}>96 / page</option>
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setPage(Math.max(1, safePage - 1))}
              disabled={safePage <= 1}
              className="px-2.5 py-1 rounded border border-slate-300 bg-white hover:bg-slate-100 disabled:opacity-40 flex items-center gap-1"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              <span>Prev</span>
            </button>
            <span className="px-2 font-mono text-[11px] text-slate-700">
              Page {safePage} / {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setPage(Math.min(totalPages, safePage + 1))}
              disabled={safePage >= totalPages}
              className="px-2.5 py-1 rounded border border-slate-300 bg-white hover:bg-slate-100 disabled:opacity-40 flex items-center gap-1"
            >
              <span>Next</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* INDIVIDUAL / BULK PRINTABLE IDENTITY CARDS MODAL */}
      {isPrintModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 qr-print-overlay">
          <style>{`
            @media print {
              body * {
                visibility: hidden !important;
              }
              #print-sheet-area,
              #print-sheet-area * {
                visibility: visible !important;
                -webkit-print-color-adjust: exact !important;
                print-color-adjust: exact !important;
              }
              #print-sheet-area {
                position: fixed !important;
                inset: 0 !important;
                width: 100% !important;
                height: auto !important;
                overflow: visible !important;
                background: #ffffff !important;
                padding: 8mm !important;
              }
              .qr-identity-print-card {
                break-inside: avoid !important;
                page-break-inside: avoid !important;
              }
            }
          `}</style>
          <div className="bg-white rounded-xl max-w-5xl w-full max-h-[90vh] flex flex-col shadow-2xl border border-slate-200 overflow-hidden">
            <div className="p-4 border-b border-slate-200 flex items-center justify-between bg-slate-900 text-white">
              <div>
                <h3 className="text-base font-bold">Print Employee QR ID Cards</h3>
                <p className="text-xs text-slate-400">
                  Ready to print {printEmployees.length} employee identity {printEmployees.length === 1 ? 'card' : 'cards'}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={printCards}
                  className="bg-blue-600 hover:bg-blue-700 text-white font-medium text-xs px-4 py-2 rounded flex items-center gap-1.5 shadow"
                >
                  <Printer className="w-4 h-4" />
                  <span>Send to Printer (A4 Sheet Layout)</span>
                </button>
                <button
                  onClick={handleClosePrintModal}
                  className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white"
                  aria-label="Close Print Preview"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Printable grid layout matching the downloaded Identity Card */}
            <div className="p-6 flex-1 overflow-y-auto bg-slate-100" id="print-sheet-area">
              <div
                className={`grid gap-4 bg-white p-6 rounded shadow-sm border border-slate-200 ${
                  printEmployees.length === 1
                    ? 'grid-cols-1 max-w-xs mx-auto'
                    : 'grid-cols-2 md:grid-cols-3'
                }`}
              >
                {printEmployees.map(emp => (
                  <EmployeeIdentityPrintCard
                    key={emp.employeeId}
                    employee={emp}
                    qrUrl={qrImages[emp.employeeId]}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
