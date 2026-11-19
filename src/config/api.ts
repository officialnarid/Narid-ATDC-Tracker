export const AI_STUDIO_PREVIEW_HOSTNAMES = new Set<string>([
  'ais-dev-ffrnx5p5324ee4aajyzxbj-356936239657.asia-southeast1.run.app',
  'ais-pre-ffrnx5p5324ee4aajyzxbj-356936239657.asia-southeast1.run.app',
]);

export const SHARED_VERCEL_BACKEND_URL = 'https://narid-atdc-tracker.vercel.app';

function stripOptionalWrappingQuotes(raw?: string | null): string {
  if (raw === null || raw === undefined) return '';
  let clean = String(raw).trim();
  // Iteratively unwrap matching outer parentheses/quotes (e.g. `("")`, `''`, `()`, `("...")`)
  while (clean.length >= 2) {
    if (
      (clean.startsWith('(') && clean.endsWith(')')) ||
      (clean.startsWith('"') && clean.endsWith('"')) ||
      (clean.startsWith("'") && clean.endsWith("'"))
    ) {
      clean = clean.slice(1, -1).trim();
      continue;
    }
    break;
  }
  const lower = clean.toLowerCase();
  if (!clean || lower === 'undefined' || lower === 'null') {
    return '';
  }
  return clean;
}

export function isAiStudioPreviewHostname(hostname?: string): boolean {
  const cleanHost = String(hostname || '').trim().toLowerCase();
  if (!cleanHost) return false;
  if (AI_STUDIO_PREVIEW_HOSTNAMES.has(cleanHost)) return true;
  return /^ais-(?:dev|pre)-[a-z0-9-]+\.run\.app$/i.test(cleanHost);
}

export function normalizeApiBaseUrl(raw?: string | null): string {
  let clean = stripOptionalWrappingQuotes(raw);
  if (!clean) return '';

  // Only normalize trailing slashes / trailing /api on absolute http(s):// URLs;
  // leave '/' or relative strings intact so validateApiBaseUrl() rejects them explicitly.
  if (!/^https?:\/\//i.test(clean)) {
    return clean;
  }

  clean = clean.replace(/\/+$/, '');
  clean = clean.replace(/\/api$/i, '');
  clean = clean.replace(/\/+$/, '');
  return clean;
}

export function getActiveHostname(): string | undefined {
  return typeof window !== 'undefined' && window.location ? window.location.hostname : undefined;
}

export function getEffectiveApiBaseUrl(
  rawBaseUrl: string | null | undefined = import.meta.env.VITE_API_BASE_URL,
  hostname: string | undefined = getActiveHostname()
): string {
  const normalized = normalizeApiBaseUrl(rawBaseUrl);
  if (normalized) {
    return normalized;
  }
  // In hosted Google AI Studio Preview (where .env.development is not guaranteed),
  // route API requests cleanly to the shared Vercel Serverless backend.
  if (isAiStudioPreviewHostname(hostname)) {
    return SHARED_VERCEL_BACKEND_URL;
  }
  return '';
}

export const API_BASE_URL = getEffectiveApiBaseUrl(import.meta.env.VITE_API_BASE_URL);

export function validateApiBaseUrl(baseUrl?: string | null, _hostname?: string): string | null {
  const raw = stripOptionalWrappingQuotes(baseUrl);
  if (!raw) return null; // Empty / undefined -> same-origin /api/* (Vercel Production)

  if (
    /(?:your[_-]?cloud[_-]?run[_-]?url|cloud_run_url|your[_-]?api[_-]?url|<[^>]+>)/i.test(raw) ||
    raw.includes('YOUR_')
  ) {
    return 'Backend API URL placeholder detected in VITE_API_BASE_URL. Leave VITE_API_BASE_URL empty to use same-origin Vercel /api Serverless Functions, or provide a valid https:// URL.';
  }

  // Strictly reject '/', relative URLs ('/api', './api', 'api/v1'), and scheme-less strings
  if (raw === '/' || raw.startsWith('/') || raw.startsWith('.')) {
    return 'Invalid VITE_API_BASE_URL configuration: "/" and relative URLs are not allowed. Leave VITE_API_BASE_URL empty for same-origin /api, or provide a full https:// URL.';
  }

  let rawParsed: URL;
  try {
    rawParsed = new URL(raw);
  } catch {
    return 'Invalid VITE_API_BASE_URL configuration. Leave it empty for same-origin Vercel /api Serverless Functions, or provide a full https:// URL.';
  }

  if (rawParsed.protocol !== 'https:' && rawParsed.protocol !== 'http:') {
    return `Unsupported protocol "${rawParsed.protocol}" in VITE_API_BASE_URL. Only https:// (or http:// for local development) is allowed.`;
  }

  if (!rawParsed.hostname) {
    return 'Invalid VITE_API_BASE_URL configuration: missing hostname.';
  }

  if (rawParsed.username || rawParsed.password || rawParsed.search || rawParsed.hash) {
    return 'Invalid VITE_API_BASE_URL configuration: URL must be an origin without credentials, query parameters, or fragments.';
  }

  const normalizedPath = rawParsed.pathname.replace(/\/+$/, '');
  if (normalizedPath && normalizedPath !== '/api') {
    return 'Invalid VITE_API_BASE_URL configuration: provide the backend origin only (e.g. https://narid-atdc-tracker.vercel.app) without extra path segments.';
  }

  return null;
}

export function isApiBaseUsableForCurrentOrigin(): boolean {
  return validateApiBaseUrl(getEffectiveApiBaseUrl(), getActiveHostname()) === null;
}

export function assertApiBaseConfigured(): void {
  const errorMsg = validateApiBaseUrl(getEffectiveApiBaseUrl(), getActiveHostname());
  if (errorMsg) {
    throw new Error(errorMsg);
  }
}

export function resolveApiUrl(
  path: string,
  baseUrl: string | null | undefined = import.meta.env.VITE_API_BASE_URL,
  hostname: string | undefined = getActiveHostname()
): string {
  const err = validateApiBaseUrl(baseUrl, hostname);
  if (err) {
    throw new Error(err);
  }

  const cleanBase = getEffectiveApiBaseUrl(baseUrl, hostname);
  const rawPath = String(path || '').trim();
  let cleanPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;

  // Prevent accidental /api/api/* duplication regardless of caller or base URL
  cleanPath = cleanPath.replace(/^\/api\/api(?=\/|$|\?)/i, '/api');

  // Ensure same-origin calls never resolve to bare "/"
  if (cleanPath === '/' || cleanPath === '') {
    cleanPath = '/api/health';
  }

  return cleanBase ? `${cleanBase}${cleanPath}` : cleanPath;
}

export function apiUrl(path: string): string {
  return resolveApiUrl(path, import.meta.env.VITE_API_BASE_URL, getActiveHostname());
}

export interface ParsedApiResponse<T = any> {
  ok: boolean;
  status: number;
  data: T | null;
  errorMessage: string;
  isHtmlOrNonJson: boolean;
}

export class ApiRequestError<T = any> extends Error {
  status: number;
  code?: string;
  data: T | null;
  isHtmlOrNonJson: boolean;
  requiresFreshAuth?: boolean;
  firebaseAuthSynced?: boolean;
  adminSdkConfigured?: boolean;

  constructor(message: string, status: number, data: T | null, isHtmlOrNonJson: boolean) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.data = data;
    this.isHtmlOrNonJson = isHtmlOrNonJson;
    if (data && typeof data === 'object') {
      const obj = data as Record<string, any>;
      if (obj.code !== undefined) this.code = String(obj.code);
      if (obj.requiresFreshAuth !== undefined) this.requiresFreshAuth = Boolean(obj.requiresFreshAuth);
      if (obj.firebaseAuthSynced !== undefined) this.firebaseAuthSynced = Boolean(obj.firebaseAuthSynced);
      if (obj.adminSdkConfigured !== undefined) this.adminSdkConfigured = Boolean(obj.adminSdkConfigured);
    }
  }
}

import { queueClientTelemetry } from '../utils/perfMonitor';

export interface ExecuteApiFetchOptions {
  timeoutMs?: number;
  noRetryOnNetworkError?: boolean;
  preferSameOriginInPreview?: boolean;
}

function createClientCorrelationId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `cli_${Date.now().toString(36)}_${rand}`;
}

function extractEndpointPath(rawUrl: string): string {
  try {
    if (/^https?:\/\//i.test(rawUrl)) {
      return new URL(rawUrl).pathname;
    }
  } catch {
    // Fallback below
  }
  return String(rawUrl || '/').split('?')[0] || '/';
}

function withCorrelationHeader(init: RequestInit | undefined, correlationId: string): RequestInit {
  const headers = new Headers(init?.headers || {});
  if (!headers.has('X-Correlation-ID')) {
    headers.set('X-Correlation-ID', correlationId);
  }
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json');
  }
  return { ...(init || {}), headers };
}

function isNginxWarmupHtmlBody(htmlText: string): boolean {
  return /<title>\s*Starting Server\.\.\.\s*<\/title>/i.test(htmlText);
}

function isPreviewAuthBridgeHtml(res: Response, htmlText: string): boolean {
  const finalUrl = String(res.url || '').toLowerCase();
  if (
    finalUrl.includes('/__cookie_check.html') ||
    finalUrl.includes('applet-auth-bridge')
  ) {
    return true;
  }
  return /<title>\s*Cookie check\s*<\/title>/i.test(htmlText);
}

function isFrontendSpaIndexHtml(htmlText: string): boolean {
  return (
    /<div\s+id=["']root["']\s*>/i.test(htmlText) ||
    /src=["']\/src\/main\.tsx["']/i.test(htmlText) ||
    /<title>[^<]*Narid ATDC Tracker[^<]*<\/title>/i.test(htmlText)
  );
}

export async function executeApiFetch(
  url: string,
  init?: RequestInit,
  endpointLabel?: string,
  options?: ExecuteApiFetchOptions
): Promise<Response> {
  const isPreviewToVercel =
    typeof window !== 'undefined' &&
    isAiStudioPreviewHostname(window.location?.hostname) &&
    url.startsWith(SHARED_VERCEL_BACKEND_URL);
  const sameOriginPath = isPreviewToVercel
    ? url.slice(SHARED_VERCEL_BACKEND_URL.length) || '/api/health'
    : '';

  const endpointPath = extractEndpointPath(url);
  const skipClientTelemetry = endpointPath.startsWith('/api/monitoring/ingest');
  const existingHeaders = new Headers(init?.headers || {});
  const correlationId = existingHeaders.get('X-Correlation-ID') || createClientCorrelationId();
  const method = (init?.method || 'GET').toUpperCase();
  const fetchStartMs =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();

  const timeoutMs = options?.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 0;
  const controller =
    timeoutMs > 0 && !init?.signal && typeof AbortController !== 'undefined'
      ? new AbortController()
      : null;
  const timeoutId = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  const baseInit = withCorrelationHeader(init, correlationId);
  const effectiveInit: RequestInit = controller
    ? { ...baseInit, signal: controller.signal }
    : baseInit;

  const getElapsedMs = () =>
    Math.max(
      0,
      Math.round(
        ((typeof performance !== 'undefined' && typeof performance.now === 'function'
          ? performance.now()
          : Date.now()) -
          fetchStartMs) *
          100
      ) / 100
    );

  const useStrictLocalPreviewBackend = Boolean(
    isPreviewToVercel && sameOriginPath && options?.preferSameOriginInPreview
  );
  const sameOriginInit: RequestInit = {
    ...effectiveInit,
    credentials: effectiveInit.credentials ?? 'include',
  };

  try {
    let res: Response;
    if (useStrictLocalPreviewBackend) {
      // Strictly target the local Preview Express backend with iframe cookie credentials.
      // NEVER silently fall back to the older Vercel Production backend for Preview auth requests.
      res = await fetch(sameOriginPath, sameOriginInit);

      // For idempotent GET requests only (e.g. /api/auth/lockout-status), retry once briefly
      // if AI Studio nginx served the transient /warmup.html page while Express was booting.
      if (method === 'GET') {
        const ct = (res.headers?.get?.('content-type') || '').toLowerCase();
        if (ct.includes('text/html')) {
          try {
            const previewText = await res.clone().text();
            if (isNginxWarmupHtmlBody(previewText)) {
              await new Promise((r) => setTimeout(r, 600));
              res = await fetch(sameOriginPath, sameOriginInit);
            }
          } catch {
            // Leave original response intact
          }
        }
      }
    } else {
      const targetInit: RequestInit =
        url.startsWith('/') ? sameOriginInit : effectiveInit;
      res = await fetch(url, targetInit);
      if (isPreviewToVercel && res.status === 404 && sameOriginPath) {
        try {
          const clonedBody = await res.clone().json();
          if (clonedBody && clonedBody.error === 'API endpoint not found.') {
            res = await fetch(sameOriginPath, sameOriginInit);
          }
        } catch {
          // Non-JSON 404: return original response cleanly
        }
      }
    }
    if (!skipClientTelemetry && res.status >= 500) {
      queueClientTelemetry({
        kind: 'API_CLIENT',
        module: 'Backend APIs',
        endpoint: endpointPath,
        method,
        status: res.status,
        durationMs: getElapsedMs(),
        timedOut: false,
        correlationId,
        message: `${method} ${endpointPath} returned HTTP ${res.status}`,
      });
    }
    return res;
  } catch (err: any) {
    const isAborted = err?.name === 'AbortError' || controller?.signal?.aborted;
    // NEVER blindly retry aborted/timed-out attendance requests — server may have already started/committed.
    if (isAborted) {
      if (!skipClientTelemetry) {
        queueClientTelemetry({
          kind: 'API_CLIENT',
          module: 'Backend APIs',
          endpoint: endpointPath,
          method,
          status: 408,
          durationMs: getElapsedMs(),
          timedOut: true,
          correlationId,
          message: `Client request timeout (${timeoutMs}ms) on ${method} ${endpointPath}`,
        });
      }
      const label = endpointLabel || url;
      throw new Error(
        `Request timed out for ${label}. Do not assume failure — verify Dual Gate Activity or Attendance History before retrying.`
      );
    }

    // In Google AI Studio Preview, non-auth calls that target Vercel may retry same-origin /api/*
    // if cross-origin Vercel fetch fails at the network layer. Strict Preview local backend calls
    // (preferSameOriginInPreview) NEVER fall back to Vercel or hide local backend errors.
    if (
      !useStrictLocalPreviewBackend &&
      isPreviewToVercel &&
      sameOriginPath &&
      !options?.noRetryOnNetworkError
    ) {
      try {
        return await fetch(sameOriginPath, {
          ...baseInit,
          credentials: baseInit.credentials ?? 'include',
        });
      } catch {
        // Fall through to structured connectivity error below
      }
    }

    if (!skipClientTelemetry) {
      queueClientTelemetry({
        kind: 'API_CLIENT',
        module: 'Backend APIs',
        endpoint: endpointPath,
        method,
        status: 0,
        durationMs: getElapsedMs(),
        timedOut: false,
        correlationId,
        message: err?.message || `Network failure reaching ${method} ${endpointPath}`,
      });
    }

    const label = endpointLabel || url;
    const targetDesc = useStrictLocalPreviewBackend
      ? (typeof window !== 'undefined' && window.location ? window.location.origin : 'local Preview backend')
      : getEffectiveApiBaseUrl() ||
        (typeof window !== 'undefined' && window.location ? window.location.origin : 'backend API');
    const detail = err?.message ? ` (${err.message})` : '';
    throw new Error(
      useStrictLocalPreviewBackend
        ? `Unable to reach local Preview backend for ${label} at ${targetDesc}${detail}. Verify the local Express server is running on port 3000.`
        : `Unable to reach ${label} at ${targetDesc}${detail}. Verify Vercel /api Serverless Functions (or VITE_API_BASE_URL) are deployed and reachable.`
    );
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}

export async function safeParseJsonResponse<T = any>(
  res: Response,
  endpointLabel?: string
): Promise<ParsedApiResponse<T>> {
  const status = res.status;
  const contentType = (res.headers?.get?.('content-type') || '').toLowerCase();
  let rawText = '';

  try {
    rawText = await res.text();
  } catch (readErr: any) {
    return {
      ok: false,
      status,
      data: null,
      errorMessage: `HTTP ${status} (${endpointLabel || 'API request'}): failed to read response body (${readErr?.message || 'stream error'}).`,
      isHtmlOrNonJson: true,
    };
  }

  const trimmed = rawText.trim();
  const looksLikeHtml =
    contentType.includes('text/html') ||
    /^<!doctype\s+html/i.test(trimmed) ||
    /^<html[\s>]/i.test(trimmed);

  let parsed: any = null;
  let jsonValid = false;

  if (trimmed && !looksLikeHtml) {
    try {
      parsed = JSON.parse(trimmed);
      jsonValid = parsed !== null && typeof parsed === 'object';
    } catch {
      jsonValid = false;
    }
  }

  if (!jsonValid || looksLikeHtml) {
    const label = endpointLabel || res.url || 'API endpoint';
    let errorMessage = '';
    if (status === 404) {
      errorMessage = `HTTP 404 Not Found from ${label} (received ${contentType || (looksLikeHtml ? 'text/html' : 'non-JSON')} instead of backend JSON). Verify Vercel Serverless Function routing (/api/*) and vercel.json rewrites.`;
    } else if (status >= 500) {
      errorMessage = `Backend service error (HTTP ${status}${res.statusText ? ` ${res.statusText}` : ''} from ${label}). Received non-JSON response (${contentType || 'text/plain'}).`;
    } else if (looksLikeHtml && isPreviewAuthBridgeHtml(res, trimmed)) {
      errorMessage = `AI Studio Preview session authentication check intercepted ${label} (HTTP ${status} text/html). Please refresh the Preview window and sign in again.`;
    } else if (looksLikeHtml && isNginxWarmupHtmlBody(trimmed)) {
      errorMessage = `Local Preview backend server is starting up or returned HTTP 502/503 (${label} received warmup HTML instead of JSON). Please wait a moment and try again.`;
    } else if (looksLikeHtml && isFrontendSpaIndexHtml(trimmed)) {
      errorMessage = `API routing error: ${label} returned frontend HTML (index.html, HTTP ${status}) instead of backend JSON. Verify Express /api middleware order and proxy routing.`;
    } else {
      errorMessage = `Unexpected non-JSON response (HTTP ${status}${res.statusText ? ` ${res.statusText}` : ''} from ${label}, content-type: ${contentType || 'unknown'}).`;
    }
    return {
      ok: false,
      status,
      data: null,
      errorMessage,
      isHtmlOrNonJson: true,
    };
  }

  const apiSuccessFlag = parsed.success !== false;
  const ok = res.ok && apiSuccessFlag;
  const errorMessage = ok
    ? ''
    : String(
        parsed.error ||
          parsed.message ||
          `HTTP ${status}${res.statusText ? ` ${res.statusText}` : ''} (${endpointLabel || 'API request'})`
      );

  return {
    ok,
    status,
    data: parsed as T,
    errorMessage,
    isHtmlOrNonJson: false,
  };
}

export async function parseApiJsonOrThrow<T = any>(
  res: Response,
  fallbackMessage: string,
  endpointLabel?: string
): Promise<T> {
  const parsed = await safeParseJsonResponse<T>(res, endpointLabel);
  if (!parsed.ok || !parsed.data) {
    throw new ApiRequestError<T>(
      parsed.errorMessage || fallbackMessage,
      parsed.status,
      parsed.data,
      parsed.isHtmlOrNonJson
    );
  }
  return parsed.data;
}

export async function apiFetchJson<T = any>(
  path: string,
  init: RequestInit | undefined,
  fallbackMessage: string,
  options?: ExecuteApiFetchOptions
): Promise<T> {
  assertApiBaseConfigured();
  const method = (init?.method || 'GET').toUpperCase();
  const label = `${method} ${path}`;
  const res = await executeApiFetch(apiUrl(path), init, label, options);
  return parseApiJsonOrThrow<T>(res, fallbackMessage, label);
}
