import { PublicCanvasSchema, type PublicCanvas } from '@calaba/protocol';
import { call } from '../lib/api/client';

/**
 * The public canvas `/c/{code}` (ADR-0115 wave 5): the anonymous `GET /api/public/canvas/{code}` (the name;
 * a GET counts a view) and the receive-only socket `…/sync` (lib/canvasSync.ts `canvasPublicSyncUrl`, no token).
 * `probe` asks again with HEAD — not a view — after a socket attempt failed before it opened: a refused code is
 * a plain 404 before the upgrade, which a browser's WebSocket cannot read.
 */
const base = (code: string): string => `/api/public/canvas/${encodeURIComponent(code)}`;

/** What a HEAD says about a link: gone (404), busy (429: too many requests from this network) or ok. */
export type LinkProbe = 'ok' | 'gone' | 'busy';

export const canvasPublic = {
  meta: (code: string, signal?: AbortSignal): Promise<PublicCanvas> => call('GET', base(code), PublicCanvasSchema, undefined, signal),
  /** A network failure (or any other answer) says nothing about the link: ok. */
  probe: async (serverUrl: string, code: string): Promise<LinkProbe> => {
    try {
      const res = await fetch(new URL(base(code), serverUrl), { method: 'HEAD', cache: 'no-store', credentials: 'omit' });
      return res.status === 404 ? 'gone' : res.status === 429 ? 'busy' : 'ok';
    } catch {
      return 'ok';
    }
  },
};

/** The code of a `/c/{code}` page in the web build (null elsewhere). */
export const canvasPageCode = (): string | null =>
  import.meta.env.VITE_PLATFORM === 'web' ? (/^\/c\/([A-Za-z0-9_-]{43})\/?$/.exec(location.pathname)?.[1] ?? null) : null;
