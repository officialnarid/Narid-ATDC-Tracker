export function normalizeApiBaseUrl(raw?: string | null): string {
  let clean = String(raw || '').trim();
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

export const API_BASE_URL = normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL);

export function validateApiBaseUrl(baseUrl?: string | null, _hostname?: string): string | null {
  const raw = String(baseUrl || '').trim();
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

export function getActiveHostname(): string | undefined {
  return typeof window !== 'undefined' && window.location ? window.location.hostname : undefined;
}

export function isApiBaseUsableForCurrentOrigin(): boolean {
  return validateApiBaseUrl(API_BASE_URL, getActiveHostname()) === null;
}

export function assertApiBaseConfigured(): void {
  const errorMsg = validateApiBaseUrl(API_BASE_URL, getActiveHostname());
  if (errorMsg) {
    throw new Error(errorMsg);
  }
}

export function resolveApiUrl(path: string, baseUrl: string | null | undefined = API_BASE_URL): string {
  const err = validateApiBaseUrl(baseUrl);
  if (err) {
    throw new Error(err);
  }

  const cleanBase = normalizeApiBaseUrl(baseUrl);
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
  return resolveApiUrl(path, API_BASE_URL);
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

export async function executeApiFetch(
  url: string,
  init?: RequestInit,
  endpointLabel?: string
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err: any) {
    const label = endpointLabel || url;
    const targetDesc =
      API_BASE_URL || (typeof window !== 'undefined' && window.location ? window.location.origin : 'backend API');
    const detail = err?.message ? ` (${err.message})` : '';
    throw new Error(
      `Unable to reach ${label} at ${targetDesc}${detail}. Verify Vercel /api Serverless Functions (or VITE_API_BASE_URL) are deployed and reachable.`
    );
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
  fallbackMessage: string
): Promise<T> {
  assertApiBaseConfigured();
  const method = (init?.method || 'GET').toUpperCase();
  const label = `${method} ${path}`;
  const res = await executeApiFetch(apiUrl(path), init, label);
  return parseApiJsonOrThrow<T>(res, fallbackMessage, label);
}
