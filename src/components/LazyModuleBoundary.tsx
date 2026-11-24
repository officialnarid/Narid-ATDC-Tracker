import React, { Component, type ComponentType, type ErrorInfo, type ReactNode, lazy } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { SafeErrorBanner } from './SafeErrorBanner';
import { handleAppError } from '../services/errorHandlingService';
import type { NormalizedAppError } from '../utils/errorRegistry';

function isDynamicImportError(error: unknown): boolean {
  const msg = String((error as any)?.message || error || '').toLowerCase();
  return (
    msg.includes('failed to fetch dynamically imported module') ||
    msg.includes('error loading dynamically imported module') ||
    msg.includes('importing a module script failed') ||
    msg.includes('chunkloaderror') ||
    msg.includes('loading chunk')
  );
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resilient React.lazy wrapper that retries transient network/dev-server
 * dynamic import glitches and recovers safely if a stale Vite dep or
 * production deployment chunk hash needs a single clean reload.
 */
export function lazyWithRetry<TModule, TProps extends object = any>(
  loader: () => Promise<TModule>,
  pickExport: (mod: TModule) => ComponentType<TProps>,
  moduleKey: string
): React.LazyExoticComponent<ComponentType<TProps>> {
  return lazy(async () => {
    const delays = [0, 250, 700];
    let lastError: unknown;

    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt] > 0) {
        await waitMs(delays[attempt]);
      }
      try {
        const mod = await loader();
        const Exported = pickExport(mod);
        if (typeof window !== 'undefined') {
          try {
            window.sessionStorage.removeItem(`narid_lazy_reload_${moduleKey}`);
          } catch {}
        }
        return { default: Exported };
      } catch (err) {
        lastError = err;
        if (!isDynamicImportError(err)) {
          throw err;
        }
      }
    }

    if (typeof window !== 'undefined' && isDynamicImportError(lastError)) {
      try {
        const storageKey = `narid_lazy_reload_${moduleKey}`;
        const prevTs = Number(window.sessionStorage.getItem(storageKey) || '0');
        const now = Date.now();
        if (!prevTs || now - prevTs > 15_000) {
          window.sessionStorage.setItem(storageKey, String(now));
          window.location.reload();
          // Keep promise pending briefly while browser navigates/reloads cleanly
          await waitMs(5000);
        }
      } catch {
        // Ignore sessionStorage restrictions and fall through to ErrorBoundary
      }
    }

    throw lastError;
  });
}

interface ModuleErrorBoundaryProps {
  resetKey: string;
  children: ReactNode;
}

interface ModuleErrorBoundaryState {
  hasError: boolean;
  safeError: NormalizedAppError | null;
  retryNonce: number;
}

export class ModuleErrorBoundary extends Component<ModuleErrorBoundaryProps, ModuleErrorBoundaryState> {
  state: ModuleErrorBoundaryState = {
    hasError: false,
    safeError: null,
    retryNonce: 0,
  };

  static getDerivedStateFromError(error: Error): Partial<ModuleErrorBoundaryState> {
    const safeError = handleAppError(error, {
      moduleName: 'Module Loader',
      reportToBackend: false,
      notifyGlobalToast: false,
    });
    return {
      hasError: true,
      safeError,
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ModuleErrorBoundary] Caught module error:', error, info);
    handleAppError(error, {
      moduleName: this.props.resetKey || 'Module Loader',
      reportToBackend: true,
      notifyGlobalToast: false,
      extraMetadata: {
        resetKey: this.props.resetKey,
        componentStackPresent: Boolean(info?.componentStack),
      },
    });
  }

  componentDidUpdate(prevProps: ModuleErrorBoundaryProps): void {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false, safeError: null });
    }
  }

  private handleRetry = () => {
    this.setState((prev) => ({
      hasError: false,
      safeError: null,
      retryNonce: prev.retryNonce + 1,
    }));
  };

  private handleReload = () => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="p-6 flex items-center justify-center min-h-[320px]">
          <div className="bg-white border border-amber-200 rounded-xl shadow-sm p-6 max-w-lg w-full space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-amber-100 border border-amber-200 flex items-center justify-center text-amber-700 shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-slate-900">Unable to Open Module</h3>
                <p className="text-xs text-slate-500">
                  A safe recovery boundary prevented this view from interrupting your session.
                </p>
              </div>
            </div>

            {this.state.safeError && (
              <SafeErrorBanner error={this.state.safeError} onRetry={this.handleRetry} />
            )}

            <div className="flex items-center justify-end gap-2.5 pt-1">
              <button
                type="button"
                onClick={this.handleRetry}
                className="bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold px-4 py-2 rounded-lg flex items-center gap-1.5 transition cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Retry Module</span>
              </button>
              <button
                type="button"
                onClick={this.handleReload}
                className="bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold px-4 py-2 rounded-lg transition cursor-pointer"
              >
                Reload Page
              </button>
            </div>
          </div>
        </div>
      );
    }

    return <React.Fragment key={this.state.retryNonce}>{this.props.children}</React.Fragment>;
  }
}
