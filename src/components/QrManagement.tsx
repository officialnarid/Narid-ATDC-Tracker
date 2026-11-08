import React, { useState, useEffect } from 'react';
import { 
  QrCode, 
  Printer, 
  Download, 
  Search, 
  Filter, 
  RotateCcw, 
  Layers, 
  Check, 
  ShieldCheck, 
  Eye, 
  X,
  FileCheck2
} from 'lucide-react';
import { Employee, Floor, Department } from '../types';
import { regenerateQrToken } from '../services/employeeService';
import QRCode from 'qrcode';

interface QrManagementProps {
  employees: Employee[];
  floors: Floor[];
  departments: Department[];
  onRefresh: () => void;
}

export const QrManagement: React.FC<QrManagementProps> = ({
  employees,
  floors,
  departments,
  onRefresh,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [filterFloor, setFilterFloor] = useState('ALL');
  const [filterDept, setFilterDept] = useState('ALL');
  const [qrImages, setQrImages] = useState<Record<string, string>>({});
  const [selectedForPrint, setSelectedForPrint] = useState<Set<string>>(new Set());
  const [isPrintModalOpen, setIsPrintModalOpen] = useState(false);

  // Active employees only
  const activeEmployees = employees.filter(e => e.employeeStatus === 'Active');

  // Generate QR data URLs
  useEffect(() => {
    const generateQrs = async () => {
      const map: Record<string, string> = {};
      for (const emp of activeEmployees.slice(0, 100)) { // Render top 100 on demand
        try {
          const payload = JSON.stringify({
            employeeId: emp.employeeId,
            token: emp.qrCodeToken,
          });
          map[emp.employeeId] = await QRCode.toDataURL(payload, { width: 180, margin: 2 });
        } catch (e) {
          console.error(e);
        }
      }
      setQrImages(map);
    };
    generateQrs();
  }, [employees]);

  const filtered = activeEmployees.filter(emp => {
    if (searchTerm.trim() !== '') {
      const s = searchTerm.toLowerCase();
      if (!emp.employeeId.toLowerCase().includes(s) && !emp.employeeName.toLowerCase().includes(s)) {
        return false;
      }
    }
    if (filterFloor !== 'ALL' && emp.floor !== filterFloor) return false;
    if (filterDept !== 'ALL' && emp.department !== filterDept) return false;
    return true;
  });

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
    if (!confirm(`Revoke and re-issue QR security token for ${empId}?`)) return;
    try {
      await regenerateQrToken(empId);
      onRefresh();
    } catch (e: any) {
      alert(`Error: ${e.message}`);
    }
  };

  const printCards = () => {
    window.print();
  };

  return (
    <div className="p-6 bg-slate-50 min-h-full flex flex-col gap-6">
      {/* Header */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
            <QrCode className="w-5 h-5 text-blue-600" />
            <span>QR CODE MANAGEMENT</span>
          </h2>
          <p className="text-xs text-slate-500">
            Generate, validate, revoke, and print employee QR badges for continuous scanning
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              if (selectedForPrint.size === 0) {
                // Select all filtered by default if none checked
                setSelectedForPrint(new Set(filtered.map(e => e.employeeId)));
              }
              setIsPrintModalOpen(true);
            }}
            className="bg-blue-600 hover:bg-blue-700 text-white font-medium text-xs px-4 py-2 rounded flex items-center gap-2 shadow-sm transition"
          >
            <Printer className="w-4 h-4" />
            <span>Print Selected Cards ({selectedForPrint.size > 0 ? selectedForPrint.size : 'All'})</span>
          </button>
        </div>
      </div>

      {/* Filter and Selection Toolbar */}
      <div className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-2xs flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 bg-slate-50 border border-slate-300 rounded px-2.5 py-1.5 w-60">
            <Search className="w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder="Search by ID or Name..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full bg-transparent border-none text-slate-800 focus:outline-hidden"
            />
          </div>

          <select
            value={filterFloor}
            onChange={(e) => setFilterFloor(e.target.value)}
            className="bg-white border border-slate-300 rounded px-2 py-1.5 text-slate-700"
          >
            <option value="ALL">All Lines</option>
            {floors.map(f => <option key={f.id} value={f.name}>{f.name}</option>)}
          </select>

          <select
            value={filterDept}
            onChange={(e) => setFilterDept(e.target.value)}
            className="bg-white border border-slate-300 rounded px-2 py-1.5 text-slate-700"
          >
            <option value="ALL">All Departments</option>
            {departments.map(d => <option key={d.id} value={d.name}>{d.name}</option>)}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={selectAll}
            className="text-slate-600 hover:text-slate-900 border border-slate-300 px-3 py-1.5 rounded font-medium"
          >
            {selectedForPrint.size === filtered.length ? 'Deselect All' : 'Select All Filtered'}
          </button>
        </div>
      </div>

      {/* QR Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {filtered.map(emp => {
          const isSelected = selectedForPrint.has(emp.employeeId);
          const qrUrl = qrImages[emp.employeeId];

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
                  <div className="text-[10px] text-slate-400">Generating...</div>
                )}
              </div>

              {/* ID & Name */}
              <div className="font-mono text-base font-bold text-slate-900 tracking-wide">
                {emp.employeeId}
              </div>
              <div className="text-sm font-bold text-slate-800 truncate max-w-full">
                {emp.employeeName}
              </div>
              <div className="text-xs text-blue-600 font-semibold mt-0.5">
                {emp.floor} • {emp.section} • {emp.department}
              </div>

              {/* Actions */}
              <div className="w-full flex items-center justify-center gap-2 mt-4 pt-3 border-t border-slate-100 text-xs">
                {qrUrl && (
                  <a
                    href={qrUrl}
                    download={`QR_${emp.employeeId}.png`}
                    className="p-1.5 rounded hover:bg-slate-100 text-slate-600 border border-slate-200"
                    title="Download PNG"
                  >
                    <Download className="w-3.5 h-3.5" />
                  </a>
                )}
                <button
                  onClick={() => handleRegenerate(emp.employeeId)}
                  className="p-1.5 rounded hover:bg-amber-50 text-amber-700 border border-amber-200"
                  title="Revoke & Re-issue Security Token"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* BULK PRINTABLE MODAL / PREVIEW */}
      {isPrintModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-xl max-w-5xl w-full max-h-[90vh] flex flex-col shadow-2xl border border-slate-200 overflow-hidden">
            <div className="p-4 border-b border-slate-200 flex items-center justify-between bg-slate-900 text-white">
              <div>
                <h3 className="text-base font-bold">Print Employee QR ID Cards</h3>
                <p className="text-xs text-slate-400">
                  Ready to print {selectedForPrint.size} selected employee badges
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
                  onClick={() => setIsPrintModalOpen(false)}
                  className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Printable grid layout */}
            <div className="p-6 flex-1 overflow-y-auto bg-slate-100" id="print-sheet-area">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4 bg-white p-6 rounded shadow-sm border border-slate-200">
                {employees
                  .filter(e => selectedForPrint.has(e.employeeId))
                  .map(emp => (
                    <div 
                      key={emp.employeeId} 
                      className="border border-slate-300 rounded-lg p-3 flex flex-col items-center text-center bg-white shadow-2xs"
                    >
                      <div className="w-full text-center border-b border-slate-200 pb-1 mb-2">
                        <span className="text-[10px] font-bold text-blue-900 tracking-wider">Narid ATDC Tracker</span>
                      </div>

                      <div className="w-28 h-28 bg-white border border-slate-200 p-1 rounded flex items-center justify-center mb-2">
                        {qrImages[emp.employeeId] ? (
                          <img src={qrImages[emp.employeeId]} alt={emp.employeeId} className="w-full h-full object-contain" />
                        ) : null}
                      </div>

                      <div className="font-mono text-sm font-bold text-slate-900">
                        {emp.employeeId}
                      </div>
                      <div className="text-xs font-semibold text-slate-800 truncate max-w-full">
                        {emp.employeeName}
                      </div>
                      <div className="text-[11px] text-slate-600 mt-1">
                        {emp.floor} • {emp.section} • {emp.department}
                      </div>
                      <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                        {emp.designation}
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
