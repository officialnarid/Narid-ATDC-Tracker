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

export default function handler(req: IncomingMessage & { url?: string }, res: ServerResponse) {
  if (typeof req.url === 'string') {
    const queryIdx = req.url.indexOf('?');
    const pathPart = queryIdx >= 0 ? req.url.slice(0, queryIdx) : req.url;
    const queryPart = queryIdx >= 0 ? req.url.slice(queryIdx) : '';

    if (pathPart !== '/api' && !pathPart.startsWith('/api/')) {
      const normalized = pathPart.startsWith('/') ? pathPart : `/${pathPart}`;
      req.url = `/api${normalized === '/' ? '' : normalized}${queryPart}`;
    }
  } else {
    req.url = '/api/health';
  }

  const appHandler = getServerlessAppHandler();
  return appHandler(req, res);
}
