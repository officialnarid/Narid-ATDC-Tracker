import React, { useState, useEffect } from 'react';
import { AlertTriangle, CheckCircle2, ShieldAlert, X } from 'lucide-react';

export interface BulkConfirmModalProps {
  isOpen: boolean;
  title: string;
  description: string;
  selectedCount: number;
  confirmLabel: string;
  tone?: 'primary' | 'amber' | 'danger';
  warningDetails?: string[];
  requireCheckboxLabel?: string;
  requireConfirmPhrase?: string;
  isBusy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export const BulkConfirmModal: React.FC<BulkConfirmModalProps> = ({
  isOpen,
  title,
  description,
  selectedCount,
  confirmLabel,
  tone = 'primary',
  warningDetails = [],
  requireCheckboxLabel,
  requireConfirmPhrase,
  isBusy = false,
  onConfirm,
  onCancel,
}) => {
  const [checked, setChecked] = useState(false);
  const [phraseInput, setPhraseInput] = useState('');

  useEffect(() => {
    if (isOpen) {
      setChecked(false);
      setPhraseInput('');
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const needsCheck = Boolean(requireCheckboxLabel);
  const needsPhrase = Boolean(requireConfirmPhrase);
  const phraseMatches =
    !needsPhrase ||
    phraseInput.trim().toUpperCase() === String(requireConfirmPhrase).trim().toUpperCase();
  const canConfirm = (!needsCheck || checked) && phraseMatches && !isBusy;

  const headerClasses =
    tone === 'danger'
      ? 'bg-red-50 border-red-200 text-red-900'
      : tone === 'amber'
        ? 'bg-amber-50 border-amber-200 text-amber-900'
        : 'bg-blue-50 border-blue-200 text-slate-900';

  const confirmBtnClasses =
    tone === 'danger'
      ? 'bg-red-600 hover:bg-red-700 text-white'
      : tone === 'amber'
        ? 'bg-amber-600 hover:bg-amber-700 text-white'
        : 'bg-blue-600 hover:bg-blue-700 text-white';

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bulk-confirm-title"
    >
      <div className="bg-white rounded-2xl max-w-md w-full border border-slate-200 shadow-2xl overflow-hidden">
        <div className={`px-5 py-4 border-b flex items-center justify-between gap-3 ${headerClasses}`}>
          <div className="flex items-center gap-2.5">
            {tone === 'danger' ? (
              <ShieldAlert className="w-5 h-5 text-red-600 shrink-0" />
            ) : tone === 'amber' ? (
              <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
            ) : (
              <CheckCircle2 className="w-5 h-5 text-blue-600 shrink-0" />
            )}
            <h3 id="bulk-confirm-title" className="text-sm font-bold tracking-tight">
              {title}
            </h3>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={isBusy}
            className="text-slate-500 hover:text-slate-800 p-1 rounded cursor-pointer disabled:opacity-40"
            aria-label="Close confirmation dialog"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 text-xs text-slate-700">
          <div className="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-xl px-3.5 py-2.5">
            <span className="font-semibold text-slate-600">Affected Records</span>
            <span className="font-mono text-sm font-extrabold text-slate-900">
              {selectedCount} {selectedCount === 1 ? 'record' : 'records'}
            </span>
          </div>

          <p className="leading-relaxed text-slate-700">{description}</p>

          {warningDetails.length > 0 && (
            <ul className="bg-amber-50/80 border border-amber-200 rounded-xl p-3 space-y-1.5 text-[11px] text-amber-900 list-disc pl-6">
              {warningDetails.map((w, idx) => (
                <li key={idx}>{w}</li>
              ))}
            </ul>
          )}

          {needsCheck && (
            <label className="flex items-start gap-2.5 p-3 rounded-xl border border-slate-200 bg-slate-50 cursor-pointer">
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => setChecked(e.target.checked)}
                className="mt-0.5 rounded text-blue-600 focus:ring-blue-500 w-4 h-4"
              />
              <span className="text-[11px] font-semibold text-slate-800 leading-snug">
                {requireCheckboxLabel}
              </span>
            </label>
          )}

          {needsPhrase && (
            <div>
              <label className="block text-[11px] font-bold text-slate-700 mb-1">
                Type <span className="font-mono text-red-700">{requireConfirmPhrase}</span> to authorize:
              </label>
              <input
                type="text"
                value={phraseInput}
                onChange={(e) => setPhraseInput(e.target.value)}
                placeholder={requireConfirmPhrase}
                autoComplete="off"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 font-mono text-xs uppercase focus:outline-hidden focus:ring-2 focus:ring-red-500"
              />
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={onCancel}
              disabled={isBusy}
              className="px-3.5 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-slate-700 font-semibold cursor-pointer disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={!canConfirm}
              className={`px-4 py-2 rounded-lg font-bold shadow-xs transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${confirmBtnClasses}`}
            >
              {isBusy ? 'Processing...' : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export interface CrossPageSelectConfirmModalProps {
  isOpen: boolean;
  totalFilteredCount: number;
  currentPageCount: number;
  recordLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export const CrossPageSelectConfirmModal: React.FC<CrossPageSelectConfirmModalProps> = ({
  isOpen,
  totalFilteredCount,
  currentPageCount,
  recordLabel = 'records',
  onConfirm,
  onCancel,
}) => {
  return (
    <BulkConfirmModal
      isOpen={isOpen}
      title="Select All Filtered Records Across Pages?"
      description={`The current page shows ${currentPageCount} ${recordLabel}, while your active filters match ${totalFilteredCount} ${recordLabel} across multiple pages. Confirm to include all ${totalFilteredCount} filtered ${recordLabel} in your batch selection.`}
      selectedCount={totalFilteredCount}
      confirmLabel={`Select All ${totalFilteredCount} Filtered`}
      tone="primary"
      warningDetails={[
        'Bulk actions will apply to every matching filtered record across all pages.',
        'You can inspect or clear the selection at any time from the bulk action bar.',
      ]}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
};
