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

  // If Vercel invokes catch-all as /api/[...all]?...all=auth/login, reconstruct the true route path
  const decodedPath = decodeURIComponent(pathPart);
  if ((decodedPath === '/api/[...all]' || decodedPath === '/[...all]') && queryPart) {
    const params = new URLSearchParams(queryPart.slice(1));
    const catchAllSegments = params.getAll('...all').concat(params.getAll('all'));
    if (catchAllSegments.length > 0) {
      params.delete('...all');
      params.delete('all');
      const joined = catchAllSegments
        .flatMap((s) => s.split('/'))
        .filter(Boolean)
        .join('/');
      pathPart = joined ? `/api/${joined}` : '/api/health';
      const remainingQuery = params.toString();
      queryPart = remainingQuery ? `?${remainingQuery}` : '';
    }
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

export default function handler(req: IncomingMessage & { url?: string }, res: ServerResponse) {
  req.url = normalizeServerlessRequestUrl(req.url);

  const appHandler = getServerlessAppHandler();
  return appHandler(req, res);
}
