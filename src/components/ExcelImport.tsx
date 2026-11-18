import React, { useState, useRef } from 'react';
import { 
  UploadCloud, 
  Download, 
  FileSpreadsheet, 
  CheckCircle2, 
  AlertTriangle, 
  XCircle, 
  Check, 
  ArrowRight,
  RefreshCw,
  Info
} from 'lucide-react';
import { Floor, Section, Department } from '../types';
import {
  downloadEmployeeTemplate,
  parseAndValidateEmployeeExcel,
  commitImportedEmployees,
  EmployeeImportCommitError,
  EmployeeImportCommitResult,
  ImportFailureCategory,
  ImportFailedRow,
  ImportValidationResult,
} from '../services/exportService';

interface ExcelImportProps {
  floors: Floor[];
  sections: Section[];
  departments: Department[];
  onImportComplete: () => void;
}

interface ImportCommitErrorState {
  category: ImportFailureCategory;
  message: string;
  partialCommit: boolean;
  savedCount: number;
  insertedCount: number;
  updatedCount: number;
  skippedCount: number;
  failedCount: number;
  failedRows: ImportFailedRow[];
}

function getFailureCategoryLabel(category: ImportFailureCategory): string {
  switch (category) {
    case 'AUTHENTICATION':
      return 'Authentication Error';
    case 'AUTHORIZATION':
      return 'Role / Permission Denied';
    case 'DATABASE_AUTHORIZATION':
      return 'Database Authorization Error';
    case 'VALIDATION':
      return 'Validation Error';
    case 'NETWORK_OR_TIMEOUT':
      return 'Network / Timeout Error';
    default:
      return 'Database Write Error';
  }
}

export const ExcelImport: React.FC<ExcelImportProps> = ({
  floors,
  sections,
  departments,
  onImportComplete,
}) => {
  const [file, setFile] = useState<File | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [validationResult, setValidationResult] = useState<ImportValidationResult | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [commitSuccess, setCommitSuccess] = useState<EmployeeImportCommitResult | null>(null);
  const [commitError, setCommitError] = useState<ImportCommitErrorState | null>(null);
  const [activeTab, setActiveTab] = useState<'valid' | 'invalid'>('valid');

  const fileInputRef = useRef<HTMLInputElement>(null);

  const validFloorNames = floors.map(f => f.name);
  const validSectionNames = sections.map(s => s.name);
  const validDepartmentNames = departments.map(d => d.name);

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;
    setFile(selected);
    setCommitSuccess(null);
    setCommitError(null);
    setValidationError(null);
    setValidationResult(null);

    setIsValidating(true);
    try {
      const res = await parseAndValidateEmployeeExcel(
        selected,
        validFloorNames,
        validSectionNames,
        validDepartmentNames
      );
      setValidationResult(res);
      if (res.invalidRows.length > 0 && res.validRows.length === 0) {
        setActiveTab('invalid');
      } else {
        setActiveTab('valid');
      }
    } catch (err: any) {
      setValidationError(err?.message || 'Unable to parse the selected spreadsheet.');
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } finally {
      setIsValidating(false);
    }
  };

  const runCommitRows = async (
    rowsToCommit: ImportValidationResult['validRows'],
    sourceFileName: string,
    priorPartial?: ImportCommitErrorState | null
  ) => {
    setIsCommitting(true);
    setCommitError(null);
    setCommitSuccess(null);
    try {
      const res = await commitImportedEmployees(rowsToCommit, sourceFileName);
      const mergedResult: EmployeeImportCommitResult = priorPartial
        ? {
            ...res,
            savedCount: priorPartial.savedCount + res.savedCount,
            insertedCount: priorPartial.insertedCount + res.insertedCount,
            updatedCount: priorPartial.updatedCount + res.updatedCount,
            skippedCount: priorPartial.skippedCount + res.skippedCount,
          }
        : res;

      setCommitSuccess(mergedResult);
      setValidationResult(null);
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      onImportComplete();
    } catch (err: any) {
      if (err instanceof EmployeeImportCommitError) {
        const totalSaved = (priorPartial?.savedCount || 0) + err.savedCount;
        const totalInserted = (priorPartial?.insertedCount || 0) + err.insertedCount;
        const totalUpdated = (priorPartial?.updatedCount || 0) + err.updatedCount;
        const totalSkipped = (priorPartial?.skippedCount || 0) + err.skippedCount;
        const hasPartial = totalSaved > 0;

        setCommitError({
          category: err.category,
          message: err.message,
          partialCommit: hasPartial,
          savedCount: totalSaved,
          insertedCount: totalInserted,
          updatedCount: totalUpdated,
          skippedCount: totalSkipped,
          failedCount: err.failedCount,
          failedRows: err.failedRows,
        });
        if (err.savedCount > 0) {
          onImportComplete();
        }
      } else {
        setCommitError({
          category: 'DATABASE_WRITE_ERROR',
          message: err?.message || 'Unexpected error during database commit.',
          partialCommit: Boolean(priorPartial && priorPartial.savedCount > 0),
          savedCount: priorPartial?.savedCount || 0,
          insertedCount: priorPartial?.insertedCount || 0,
          updatedCount: priorPartial?.updatedCount || 0,
          skippedCount: priorPartial?.skippedCount || 0,
          failedCount: rowsToCommit.filter((r) => r.actionType !== 'UNCHANGED').length,
          failedRows: [],
        });
      }
    } finally {
      setIsCommitting(false);
    }
  };

  const handleCommit = async () => {
    if (!validationResult || !file || isCommitting) return;
    await runCommitRows(validationResult.validRows, file.name, null);
  };

  const handleRetryFailedOnly = async () => {
    if (!validationResult || !file || !commitError || isCommitting) return;
    const failedIdSet = new Set(commitError.failedRows.map((r) => r.employeeId.toUpperCase()));
    const failedSubset =
      failedIdSet.size > 0
        ? validationResult.validRows.filter((row) =>
            failedIdSet.has(row.data.employeeId.toUpperCase())
          )
        : validationResult.validRows;

    if (failedSubset.length === 0) return;
    await runCommitRows(failedSubset, file.name, commitError);
  };

  return (
    <div className="p-6 bg-slate-50 min-h-full flex flex-col gap-6">
      {/* Title & Instructions */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
            <UploadCloud className="w-5 h-5 text-blue-600" />
            <span>EXCEL EMPLOYEE IMPORT & UPDATE</span>
          </h2>
          <p className="text-xs text-slate-500">
            Bulk upload 300–500 employees, sync master records, update departments, and maintain historical attendance
          </p>
        </div>

        {/* Option A: Download Template */}
        <button
          onClick={downloadEmployeeTemplate}
          className="bg-emerald-600 hover:bg-emerald-700 text-white font-medium text-xs px-4 py-2 rounded flex items-center gap-2 shadow-sm transition self-start md:self-auto"
        >
          <Download className="w-4 h-4" />
          <span>Download Excel Template</span>
        </button>
      </div>

      {/* Rules Notice */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-3.5 text-xs text-blue-900 flex items-start gap-3">
        <Info className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <p className="font-semibold">Super Admin Master Import Rules:</p>
          <ul className="list-disc list-inside text-blue-800 space-y-0.5 text-[11px]">
            <li>Matches employees by <strong>Employee ID</strong>. Existing records are updated; new IDs are inserted.</li>
            <li><strong>Data Safety Guarantee:</strong> Updating employee details NEVER deletes or alters past attendance records.</li>
            <li>Existing QR security tokens are securely preserved so physical badges remain valid.</li>
          </ul>
        </div>
      </div>

      {/* Option B: Upload Dropzone */}
      <div className="bg-white rounded-xl border border-dashed border-slate-300 p-8 flex flex-col items-center justify-center text-center shadow-2xs">
        <div className="w-14 h-14 rounded-full bg-blue-50 border border-blue-200 flex items-center justify-center mb-3">
          <FileSpreadsheet className="w-7 h-7 text-blue-600" />
        </div>
        <h3 className="text-base font-bold text-slate-800">
          Upload Employee Master File
        </h3>
        <p className="text-xs text-slate-500 max-w-md mt-1 mb-4">
          Select or drop your filled .xlsx or .csv file. The system will validate all rows and display an import preview before applying changes.
        </p>

        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx, .xls, .csv"
          onChange={handleFileSelected}
          className="hidden"
          id="excel-file-upload"
        />

        <label
          htmlFor="excel-file-upload"
          className="bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold px-5 py-2.5 rounded-lg cursor-pointer transition shadow-sm"
        >
          {isValidating ? 'Validating File...' : 'Select .xlsx / .csv File'}
        </label>

        {file && (
          <div className="mt-3 text-xs font-mono text-slate-600 bg-slate-100 px-3 py-1 rounded">
            Selected: {file.name} ({(file.size / 1024).toFixed(1)} KB)
          </div>
        )}
      </div>

      {/* File Validation Error Banner */}
      {validationError && (
        <div
          role="alert"
          className="bg-red-50 border border-red-300 rounded-xl p-4 text-red-900 text-xs flex items-start gap-3"
        >
          <XCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <div className="font-bold text-sm text-red-900">Spreadsheet Validation Failed</div>
            <p className="text-red-800">{validationError}</p>
          </div>
        </div>
      )}

      {/* Commit Error / Partial Failure Banner */}
      {commitError && (
        <div
          role="alert"
          className="bg-red-50 border border-red-300 rounded-xl p-4 text-red-900 text-xs flex flex-col gap-3"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-bold text-sm text-red-900">Import Commit Failed</span>
                  <span className="px-2 py-0.5 rounded bg-red-100 border border-red-300 text-red-800 font-semibold text-[11px]">
                    {getFailureCategoryLabel(commitError.category)}
                  </span>
                </div>
                <p className="text-red-800">{commitError.message}</p>
                {commitError.partialCommit ? (
                  <p className="text-amber-900 font-semibold">
                    Partial commit detected: {commitError.savedCount} saved ({commitError.insertedCount} new, {commitError.updatedCount} updated, {commitError.skippedCount} skipped), {commitError.failedCount} failed.
                  </p>
                ) : (
                  <p className="text-red-700 font-medium">
                    No database changes were applied (0 records written).
                  </p>
                )}
              </div>
            </div>

            {commitError.partialCommit && commitError.failedRows.length > 0 && validationResult && (
              <button
                type="button"
                onClick={handleRetryFailedOnly}
                disabled={isCommitting}
                className="bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold px-3.5 py-2 rounded-lg flex items-center gap-1.5 shrink-0 transition disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isCommitting ? 'animate-spin' : ''}`} />
                <span>Retry Failed Only ({commitError.failedRows.length})</span>
              </button>
            )}
          </div>

          {commitError.failedRows.length > 0 && (
            <div className="bg-white/80 border border-red-200 rounded-lg p-2.5 max-h-36 overflow-y-auto">
              <div className="text-[11px] font-semibold text-red-900 mb-1">
                Uncommitted Employee Records ({commitError.failedRows.length}):
              </div>
              <ul className="space-y-0.5 text-[11px] text-red-800 font-mono">
                {commitError.failedRows.slice(0, 25).map((fr, idx) => (
                  <li key={`${fr.employeeId}-${idx}`}>
                    {fr.rowNumber ? `Row ${fr.rowNumber} • ` : ''}
                    {fr.employeeId}: {fr.error}
                  </li>
                ))}
                {commitError.failedRows.length > 25 && (
                  <li className="text-red-600 font-sans">
                    ...and {commitError.failedRows.length - 25} more failed record(s).
                  </li>
                )}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Commit Success Alert */}
      {commitSuccess && (
        <div className="bg-emerald-50 border border-emerald-300 rounded-xl p-4 text-emerald-900 text-xs flex items-center gap-3">
          <CheckCircle2 className="w-6 h-6 text-emerald-600 shrink-0" />
          <div>
            <div className="font-semibold text-sm">
              Successfully committed {commitSuccess.savedCount} employee record{commitSuccess.savedCount === 1 ? '' : 's'} to the database!
            </div>
            <div className="text-[11px] text-emerald-800 mt-0.5">
              New Inserted: <strong>{commitSuccess.insertedCount}</strong> • Updated:{' '}
              <strong>{commitSuccess.updatedCount}</strong> • Unchanged Skipped:{' '}
              <strong>{commitSuccess.skippedCount}</strong> • Failed:{' '}
              <strong>{commitSuccess.failedCount}</strong>
            </div>
          </div>
        </div>
      )}

      {/* IMPORT PREVIEW SECTION */}
      {validationResult && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-2xs p-5 flex flex-col gap-5">
          {/* Summary KPI Badges */}
          <div>
            <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide mb-3">
              Import Validation Summary
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                <span className="text-[10px] text-slate-500 uppercase font-medium">Total Rows</span>
                <div className="text-xl font-bold text-slate-900 mt-0.5">{validationResult.summary.total}</div>
              </div>

              <div className="bg-blue-50 p-3 rounded-lg border border-blue-200">
                <span className="text-[10px] text-blue-700 uppercase font-semibold">New Employees</span>
                <div className="text-xl font-bold text-blue-800 mt-0.5">{validationResult.summary.newCount}</div>
              </div>

              <div className="bg-amber-50 p-3 rounded-lg border border-amber-200">
                <span className="text-[10px] text-amber-700 uppercase font-semibold">To Be Updated</span>
                <div className="text-xl font-bold text-amber-800 mt-0.5">{validationResult.summary.updatedCount}</div>
              </div>

              <div className="bg-slate-100 p-3 rounded-lg border border-slate-200">
                <span className="text-[10px] text-slate-600 uppercase font-semibold">Unchanged</span>
                <div className="text-xl font-bold text-slate-700 mt-0.5">{validationResult.summary.unchangedCount}</div>
              </div>

              <div className="bg-red-50 p-3 rounded-lg border border-red-200">
                <span className="text-[10px] text-red-700 uppercase font-semibold">Rejected Records</span>
                <div className="text-xl font-bold text-red-800 mt-0.5">{validationResult.summary.rejectedCount}</div>
              </div>
            </div>
          </div>

          {/* Preview Tabs: Valid vs Invalid */}
          <div className="flex items-center justify-between border-b border-slate-200 pb-2">
            <div className="flex items-center gap-3 text-xs">
              <button
                onClick={() => setActiveTab('valid')}
                className={`pb-2 px-1 font-semibold transition border-b-2 ${
                  activeTab === 'valid'
                    ? 'border-blue-600 text-blue-600'
                    : 'border-transparent text-slate-500 hover:text-slate-800'
                }`}
              >
                Valid Records ({validationResult.validRows.length})
              </button>
              <button
                onClick={() => setActiveTab('invalid')}
                className={`pb-2 px-1 font-semibold transition border-b-2 ${
                  activeTab === 'invalid'
                    ? 'border-red-600 text-red-600'
                    : 'border-transparent text-slate-500 hover:text-slate-800'
                }`}
              >
                Rejected Records ({validationResult.invalidRows.length})
              </button>
            </div>

            {/* Commit Action Button */}
            {validationResult.validRows.length > 0 && (
              <button
                onClick={handleCommit}
                disabled={isCommitting}
                className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold px-4 py-2 rounded shadow-sm flex items-center gap-1.5 transition disabled:opacity-50"
              >
                <Check className="w-4 h-4" />
                <span>
                  {isCommitting ? 'Saving to Database...' : `Apply & Save ${validationResult.summary.newCount + validationResult.summary.updatedCount} Changes`}
                </span>
              </button>
            )}
          </div>

          {/* Table: Valid Rows */}
          {activeTab === 'valid' ? (
            <div className="overflow-x-auto max-h-96">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-600 uppercase font-semibold border-b border-slate-200 sticky top-0">
                  <tr>
                    <th className="py-2.5 px-3">Action</th>
                    <th className="py-2.5 px-3">Emp ID</th>
                    <th className="py-2.5 px-3">Name</th>
                    <th className="py-2.5 px-3">Type</th>
                    <th className="py-2.5 px-3">Line</th>
                    <th className="py-2.5 px-3">Section</th>
                    <th className="py-2.5 px-3">Department</th>
                    <th className="py-2.5 px-3">Status</th>
                    <th className="py-2.5 px-3">Details / Changes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {validationResult.validRows.map((row, i) => (
                    <tr key={i} className="hover:bg-slate-50">
                      <td className="py-2 px-3">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          row.actionType === 'NEW' ? 'bg-blue-100 text-blue-800' :
                          row.actionType === 'UPDATE' ? 'bg-amber-100 text-amber-800' :
                          'bg-slate-100 text-slate-600'
                        }`}>
                          {row.actionType}
                        </span>
                      </td>
                      <td className="py-2 px-3 font-mono font-bold text-slate-900">{row.data.employeeId}</td>
                      <td className="py-2 px-3 font-medium text-slate-800">{row.data.employeeName}</td>
                      <td className="py-2 px-3 text-slate-600">{row.data.employeeType}</td>
                      <td className="py-2 px-3 text-slate-600">{row.data.floor}</td>
                      <td className="py-2 px-3 text-slate-600">{row.data.section}</td>
                      <td className="py-2 px-3 text-slate-600">{row.data.department}</td>
                      <td className="py-2 px-3 text-slate-600">{row.data.employeeStatus}</td>
                      <td className="py-2 px-3 text-[11px] text-slate-500">
                        {row.diffs && row.diffs.length > 0 ? (
                          <span className="text-amber-700">{row.diffs.join('; ')}</span>
                        ) : (
                          'Ready'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            /* Table: Invalid Rows */
            <div className="overflow-x-auto max-h-96">
              <table className="w-full text-left text-xs">
                <thead className="bg-red-50 text-red-800 uppercase font-semibold border-b border-red-200 sticky top-0">
                  <tr>
                    <th className="py-2.5 px-3">Row #</th>
                    <th className="py-2.5 px-3">Raw ID</th>
                    <th className="py-2.5 px-3">Raw Name</th>
                    <th className="py-2.5 px-3">Rejection Errors</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-red-100">
                  {validationResult.invalidRows.map((inv, idx) => (
                    <tr key={idx} className="bg-red-50/30">
                      <td className="py-2 px-3 font-mono font-bold text-red-900">Line {inv.rowNumber}</td>
                      <td className="py-2 px-3 font-mono text-slate-800">{inv.raw.id || '<empty>'}</td>
                      <td className="py-2 px-3 text-slate-800">{inv.raw.name || '<empty>'}</td>
                      <td className="py-2 px-3 text-red-700 font-medium">
                        {inv.errors.join(' • ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
