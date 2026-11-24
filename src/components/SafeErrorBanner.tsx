import React, { useState, useEffect } from 'react';
import { AlertTriangle, Copy, Check, RotateCcw, X } from 'lucide-react';
import type { NormalizedAppError } from '../utils/errorRegistry';
import {
  copyReferenceIdToClipboard,
  subscribeGlobalAppErrors,
} from '../services/errorHandlingService';

interface SafeErrorBannerProps {
  error: NormalizedAppError | null;
  onRetry?: () => void;
  onDismiss?: () => void;
  compact?: boolean;
  className?: string;
}

/**
 * Standardized safe error display component.
 * Displays ONLY:
 * - Safe issue category title
 * - Standardized Error Code (e.g. NET-001, DB-001, AUTH-002)
 * - Short non-technical user action
 * - Reference ID (Backend REQ-* or Frontend ERR-*) with Copy button
 * Never displays raw stack traces, API URLs, tokens, or Firestore internals.
 */
export const SafeErrorBanner: React.FC<SafeErrorBannerProps> = ({
  error,
  onRetry,
  onDismiss,
  compact = false,
  className = '',
}) => {
  const [copied, setCopied] = useState(false);

  if (!error) return null;

  const handleCopy = async () => {
    const ok = await copyReferenceIdToClipboard(error.referenceId);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div
      role="alert"
      className={`bg-red-50 border border-red-200 text-red-900 rounded-xl shadow-2xs ${
        compact ? 'px-3.5 py-2.5 text-xs' : 'p-4 text-xs'
      } ${className}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0 flex-1">
          <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-bold text-red-900">{error.userTitle}</span>
              <span className="font-mono font-bold text-[11px] bg-red-100 text-red-800 border border-red-200 px-1.5 py-0.5 rounded">
                Error Code: {error.errorCode}
              </span>
            </div>

            <p className="text-red-800 leading-relaxed">{error.userAction}</p>

            <div className="flex flex-wrap items-center gap-2 pt-0.5 text-[11px] text-red-700">
              <span className="font-mono font-semibold bg-white border border-red-200 px-2 py-0.5 rounded select-all">
                Reference ID: {error.referenceId}
              </span>
              {error.referenceIdSource === 'frontend' && (
                <span className="text-[10px] font-medium text-red-600 bg-red-100/70 px-1.5 py-0.5 rounded">
                  Client Event ID
                </span>
              )}
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-white hover:bg-red-100 border border-red-200 text-red-700 font-semibold transition cursor-pointer"
                title="Copy Reference ID"
              >
                {copied ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
                <span>{copied ? 'Copied' : 'Copy Reference ID'}</span>
              </button>
            </div>

            {!compact && (
              <p className="text-[11px] text-red-700/90 pt-0.5">
                Please share this Reference ID with your administrator for investigation.
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {onRetry && error.retryable && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded bg-white hover:bg-red-100 border border-red-300 text-red-800 font-semibold text-xs transition cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Retry</span>
            </button>
          )}
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss error"
              className="p-1 rounded text-red-500 hover:text-red-800 hover:bg-red-100 transition cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * Global floating error toast stack mounted once at the application root.
 * Captures safe normalized errors dispatched from non-modal actions (replacing raw browser alert() popups).
 */
export const GlobalErrorToastStack: React.FC = () => {
  const [items, setItems] = useState<Array<{ key: string; error: NormalizedAppError }>>([]);

  useEffect(() => {
    return subscribeGlobalAppErrors((err) => {
      const key = `${err.referenceId}_${Date.now()}`;
      setItems((prev) => [{ key, error: err }, ...prev].slice(0, 3));
      window.setTimeout(() => {
        setItems((prev) => prev.filter((item) => item.key !== key));
      }, 9000);
    });
  }, []);

  if (items.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[70] w-full max-w-md px-3 sm:px-0 space-y-2 pointer-events-none">
      {items.map((item) => (
        <div key={item.key} className="pointer-events-auto shadow-xl rounded-xl">
          <SafeErrorBanner
            error={item.error}
            compact
            onDismiss={() => setItems((prev) => prev.filter((x) => x.key !== item.key))}
          />
        </div>
      ))}
    </div>
  );
};
