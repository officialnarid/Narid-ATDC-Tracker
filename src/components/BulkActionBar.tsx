import React, { useRef, useEffect } from 'react';
import {
  CheckCircle2,
  AlertTriangle,
  X,
  RotateCcw,
  Layers,
  CheckSquare,
} from 'lucide-react';

export interface SelectAllCheckboxProps {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  onChange: () => void;
  ariaLabel?: string;
  className?: string;
}

export const SelectAllCheckbox: React.FC<SelectAllCheckboxProps> = ({
  checked,
  indeterminate = false,
  disabled = false,
  onChange,
  ariaLabel = 'Select all rows on current page',
  className = 'rounded text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer disabled:opacity-40',
}) => {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = Boolean(indeterminate && !checked);
    }
  }, [indeterminate, checked]);

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      aria-label={ariaLabel}
      className={className}
    />
  );
};

export type BulkActionTone = 'default' | 'primary' | 'emerald' | 'amber' | 'danger';

export interface BulkActionItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  tone?: BulkActionTone;
  disabled?: boolean;
  hidden?: boolean;
  title?: string;
  onClick: () => void;
}

export interface BulkProgressState {
  label: string;
  completed: number;
  total: number;
  detail?: string;
}

export interface BulkExecutionSummary {
  type: 'success' | 'partial' | 'error';
  title: string;
  message: string;
  savedCount?: number;
  skippedCount?: number;
  failedCount?: number;
  canRetryFailed?: boolean;
}

export interface BulkActionBarProps {
  selectedCount: number;
  totalFilteredCount: number;
  currentPageCount: number;
  isAllFilteredSelected: boolean;
  isPageAllSelected: boolean;
  recordLabel?: string;
  actions: BulkActionItem[];
  onSelectAllFiltered?: () => void;
  onClearSelection: () => void;
  progress?: BulkProgressState | null;
  summary?: BulkExecutionSummary | null;
  onRetryFailed?: () => void;
  onDismissSummary?: () => void;
}

const TONE_CLASSES: Record<BulkActionTone, string> = {
  default:
    'bg-white hover:bg-slate-100 text-slate-800 border border-slate-300',
  primary:
    'bg-blue-600 hover:bg-blue-700 text-white border border-blue-600',
  emerald:
    'bg-emerald-600 hover:bg-emerald-700 text-white border border-emerald-600',
  amber:
    'bg-amber-600 hover:bg-amber-700 text-white border border-amber-600',
  danger:
    'bg-red-600 hover:bg-red-700 text-white border border-red-600',
};

export const BulkActionBar: React.FC<BulkActionBarProps> = ({
  selectedCount,
  totalFilteredCount,
  currentPageCount,
  isAllFilteredSelected,
  isPageAllSelected,
  recordLabel = 'records',
  actions,
  onSelectAllFiltered,
  onClearSelection,
  progress = null,
  summary = null,
  onRetryFailed,
  onDismissSummary,
}) => {
  const visibleActions = actions.filter((a) => !a.hidden);
  const hasSelection = selectedCount > 0;

  if (!hasSelection && !progress && !summary) {
    return null;
  }

  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.completed / progress.total) * 100))
      : 0;

  const canOfferSelectAllFiltered =
    hasSelection &&
    isPageAllSelected &&
    !isAllFilteredSelected &&
    totalFilteredCount > currentPageCount &&
    Boolean(onSelectAllFiltered);

  return (
    <div className="space-y-2" role="region" aria-label="Bulk selection actions">
      {(hasSelection || progress) && (
        <div className="sticky top-2 z-30 bg-slate-900 text-white rounded-xl border border-slate-700 shadow-lg px-3.5 py-2.5 flex flex-col gap-2.5">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-2.5">
            {/* Count + Cross-Page Prompt */}
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-blue-600/25 border border-blue-400/40 text-blue-200 font-bold">
                <CheckSquare className="w-3.5 h-3.5 text-blue-300" />
                <span className="font-mono tabular-nums">{selectedCount}</span>
                <span>Selected</span>
              </span>
              <span className="text-[11px] text-slate-300 font-mono">
                of {totalFilteredCount} filtered {recordLabel}
              </span>

              {canOfferSelectAllFiltered && !progress && (
                <button
                  type="button"
                  onClick={onSelectAllFiltered}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-indigo-500/20 hover:bg-indigo-500/35 border border-indigo-400/40 text-indigo-200 text-[11px] font-semibold transition cursor-pointer"
                >
                  <Layers className="w-3 h-3" />
                  <span>Select all {totalFilteredCount} filtered</span>
                </button>
              )}

              {isAllFilteredSelected && totalFilteredCount > currentPageCount && (
                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-400/40 text-emerald-200">
                  All Filtered Selected
                </span>
              )}
            </div>

            {/* Action Buttons */}
            <div className="flex flex-wrap items-center gap-1.5">
              {visibleActions.map((act) => {
                const tone = act.tone || 'default';
                return (
                  <button
                    key={act.id}
                    type="button"
                    disabled={Boolean(act.disabled || progress)}
                    onClick={act.onClick}
                    title={act.title || act.label}
                    className={`px-2.5 py-1.5 rounded-lg text-[11px] font-bold inline-flex items-center gap-1.5 transition cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed ${TONE_CLASSES[tone]}`}
                  >
                    {act.icon}
                    <span>{act.label}</span>
                  </button>
                );
              })}

              <button
                type="button"
                disabled={Boolean(progress)}
                onClick={onClearSelection}
                className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 inline-flex items-center gap-1 transition cursor-pointer disabled:opacity-40"
              >
                <X className="w-3.5 h-3.5" />
                <span>Clear Selection</span>
              </button>
            </div>
          </div>

          {/* Live Batch Progress Bar */}
          {progress && (
            <div className="bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 space-y-1.5">
              <div className="flex items-center justify-between text-[11px] font-semibold text-slate-200">
                <span>{progress.label}</span>
                <span className="font-mono tabular-nums text-blue-300">
                  Processing {progress.completed} / {progress.total} {recordLabel} ({pct}%)
                </span>
              </div>
              <div className="w-full h-1.5 bg-slate-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 transition-all duration-150"
                  style={{ width: `${pct}%` }}
                />
              </div>
              {progress.detail && (
                <div className="text-[10px] text-slate-400 font-mono truncate">
                  {progress.detail}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Batch Execution Summary / Partial Failure & Retry Banner */}
      {summary && (
        <div
          role={summary.type === 'error' ? 'alert' : 'status'}
          className={`px-4 py-3 rounded-xl border text-xs flex flex-wrap items-center justify-between gap-3 ${
            summary.type === 'success'
              ? 'bg-emerald-50 border-emerald-300 text-emerald-900'
              : summary.type === 'partial'
                ? 'bg-amber-50 border-amber-300 text-amber-900'
                : 'bg-red-50 border-red-300 text-red-900'
          }`}
        >
          <div className="flex items-start gap-2.5">
            {summary.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            ) : (
              <AlertTriangle
                className={`w-4 h-4 shrink-0 mt-0.5 ${
                  summary.type === 'partial' ? 'text-amber-600' : 'text-red-600'
                }`}
              />
            )}
            <div>
              <div className="font-bold">{summary.title}</div>
              <div className="text-[11px] mt-0.5">{summary.message}</div>
              {(summary.savedCount !== undefined ||
                summary.skippedCount !== undefined ||
                summary.failedCount !== undefined) && (
                <div className="flex flex-wrap items-center gap-3 mt-1 font-mono text-[10px] font-semibold">
                  {summary.savedCount !== undefined && (
                    <span>Succeeded: {summary.savedCount}</span>
                  )}
                  {summary.skippedCount !== undefined && summary.skippedCount > 0 && (
                    <span>Skipped / Protected: {summary.skippedCount}</span>
                  )}
                  {summary.failedCount !== undefined && summary.failedCount > 0 && (
                    <span className="text-red-700">Failed: {summary.failedCount}</span>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {summary.canRetryFailed && onRetryFailed && (
              <button
                type="button"
                onClick={onRetryFailed}
                className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-[11px] font-bold inline-flex items-center gap-1 cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Retry Failed Only</span>
              </button>
            )}
            {onDismissSummary && (
              <button
                type="button"
                onClick={onDismissSummary}
                className="px-2.5 py-1.5 rounded-lg border border-current/20 hover:bg-black/5 text-[11px] font-semibold cursor-pointer"
              >
                Dismiss
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
