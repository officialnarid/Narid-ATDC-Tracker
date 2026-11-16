import type { IncomingMessage, ServerResponse } from 'http';
import { createApp } from '../server.ts';

type ExpressHandler = (req: IncomingMessage, res: ServerResponse) => unknown;

let cachedHandler: ExpressHandler | null = null;

export function getServerlessAppHandler(): ExpressHandler {
  if (!cachedHandler) {
    // Disable cold-start seeding/migrations so production data & UIDs are strictly preserved
    const { app } = createApp({ disableBackgroundBoot: true });
    cachedHandler = app as unknown as ExpressHandler;
  }
  return cachedHandler;
}

export function resetServerlessAppHandlerForTests(): void {
  cachedHandler = null;
}

export function normalizeServerlessRequestUrl(rawUrl?: string): string {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return '/api/health';
  }

  const queryIdx = rawUrl.indexOf('?');
  let pathPart = queryIdx >= 0 ? rawUrl.slice(0, queryIdx) : rawUrl;
  let queryPart = queryIdx >= 0 ? rawUrl.slice(queryIdx) : '';

  if (!pathPart.startsWith('/')) {
    pathPart = `/${pathPart}`;
  }

  let decodedPath = pathPart;
  try {
    decodedPath = decodeURIComponent(pathPart);
  } catch {
    decodedPath = pathPart;
  }

  if (queryPart) {
    const params = new URLSearchParams(queryPart.slice(1));
    let rewrittenFromQuery = false;

    // Primary Vercel rewrite target: /api/index?__api_path=<subpath>
    if (
      (decodedPath === '/api/index' || decodedPath === '/api' || decodedPath === '/') &&
      params.has('__api_path')
    ) {
      const apiPathValues = params.getAll('__api_path');
      params.delete('__api_path');
      const joined = apiPathValues
        .flatMap((s) => s.split('/'))
        .filter(Boolean)
        .join('/');
      const cleanedJoined = joined.replace(/^(?:api\/)+/i, '').replace(/^api$/i, '');
      pathPart = cleanedJoined ? `/api/${cleanedJoined}` : '/api/health';
      rewrittenFromQuery = true;
    }

    // Defensive cleanup if catch-all params (...all / all) were injected
    if (params.has('...all') || params.has('all')) {
      const catchAllSegments = params.getAll('...all').concat(params.getAll('all'));
      params.delete('...all');
      params.delete('all');
      if (
        !rewrittenFromQuery &&
        (decodedPath === '/api/[...all]' || decodedPath === '/[...all]' || decodedPath === '/api/index') &&
        catchAllSegments.length > 0
      ) {
        const joined = catchAllSegments
          .flatMap((s) => s.split('/'))
          .filter(Boolean)
          .join('/');
        const cleanedJoined = joined.replace(/^(?:api\/)+/i, '').replace(/^api$/i, '');
        pathPart = cleanedJoined ? `/api/${cleanedJoined}` : '/api/health';
      }
    }

    const remainingQuery = params.toString();
    queryPart = remainingQuery ? `?${remainingQuery}` : '';
  }

  // Collapse repeated leading /api segments (e.g., /api/api/auth/login -> /api/auth/login)
  pathPart = pathPart.replace(/^(?:\/api)+(?=\/|$)/i, '/api');

  if (pathPart === '/' || pathPart === '/api' || pathPart === '/api/') {
    return `/api/health${queryPart}`;
  }

  if (pathPart.length > 1) {
    pathPart = pathPart.replace(/\/+$/, '');
  }

  if (pathPart !== '/api' && !pathPart.startsWith('/api/')) {
    pathPart = `/api${pathPart}`;
  }

  return `${pathPart}${queryPart}`;
}

export default function handler(
  req: IncomingMessage & { url?: string; originalUrl?: string },
  res: ServerResponse
) {
  const normalizedUrl = normalizeServerlessRequestUrl(req.url);
  req.url = normalizedUrl;
  if (typeof req.originalUrl === 'string') {
    req.originalUrl = normalizedUrl;
  }

  const appHandler = getServerlessAppHandler();
  return appHandler(req, res);
}
