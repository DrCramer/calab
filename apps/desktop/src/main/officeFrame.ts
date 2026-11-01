/**
 * The office editor's frame (ADR-0143): the renderer shows ONLYOFFICE Docs in an `<iframe>` of our
 * host page on the Document Server's origin. The navigation guards (windows.ts, mail/frameGuard.ts)
 * cancel every foreign sub-frame, so exactly this is let through, and nothing else:
 * - the origin is the one the server this app is logged in to reports (GET /api/office/capabilities
 *   `docs_url`, fetched by main when the renderer opens the editor: IPC `office:frame`, own pages
 *   only), never a URL the renderer hands over; kept per window while the editor is open and
 *   dropped on close;
 *   `https:` (or `http:` to loopback for dev / the mock), an exact origin, never a wildcard;
 * - a frame whose parent is the app page: only the host page, by exact path;
 * - a frame whose parent is a frame of that same origin (the editor itself, its nested frames): the
 *   same origin only.
 * Popups, `window.open` and top-level navigation stay as they are (windows.ts): links go to the
 * system browser, nothing opens inside the app. No Node in the frame (sandboxed renderer).
 */
import type { WebContents } from 'electron';

/** Where the host page lives on the Document Server (infra/office/calab-editor.html is mounted here). */
export const OFFICE_HOST_PATH = '/web-apps/apps/calab/calab-editor.html';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The allowed origin for a Document Server URL from the config, '' when it must not be framed. */
export function officeOriginOf(url: unknown): string {
  if (typeof url !== 'string' || url.length > 2048) return '';
  try {
    const u = new URL(url);
    if (u.username || u.password) return '';
    if (u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname))) return u.origin;
  } catch {
    // not a URL
  }
  return '';
}

export interface OfficeNav {
  /** The announced origin of the Document Server ('' when no editor is open). */
  origin: string;
  /** The URL the frame navigates to. */
  url: string;
  /** The navigating frame's parent is the app page itself. */
  parentIsMain: boolean;
  /** The navigating frame's parent URL (when it is not the app page). */
  parentUrl: string;
}

/** true = this is the editor's own frame navigation and the guards let it through. */
export function isOfficeFrameNavigation(n: OfficeNav): boolean {
  if (!n.origin) return false;
  let target: URL;
  try {
    target = new URL(n.url);
  } catch {
    return false;
  }
  // blob:/data: URLs can carry the origin too: only plain http(s) pages.
  if ((target.protocol !== 'https:' && target.protocol !== 'http:') || target.origin !== n.origin || target.username || target.password) return false;
  if (n.parentIsMain) return target.pathname === OFFICE_HOST_PATH;
  try {
    return new URL(n.parentUrl).origin === n.origin;
  } catch {
    return false;
  }
}

const origins = new Map<number, string>();
/** Per window: the newest open / close call; an older call's answer arriving later is dropped. */
const seqs = new Map<number, number>();

/**
 * IPC `office:frame`: the editor opened (open) or closed in this window. On open, `docsUrl` asks
 * the server for its Document Server URL; the origin is allowed only if it is one officeOriginOf
 * accepts, and returned to the renderer ('' = nothing is allowed: the editor is off, or the server
 * is unreachable).
 */
export async function setOfficeFrame(wc: WebContents, open: boolean, docsUrl: () => Promise<unknown>): Promise<string> {
  const id = wc.id;
  const seq = (seqs.get(id) ?? 0) + 1;
  if (!seqs.has(id)) wc.once('destroyed', () => (origins.delete(id), seqs.delete(id)));
  seqs.set(id, seq);
  origins.delete(id);
  if (!open) return '';
  const origin = officeOriginOf(await docsUrl().catch(() => ''));
  if (seqs.get(id) !== seq || !origin) return '';
  origins.set(id, origin);
  return origin;
}

interface FrameLike {
  parent: FrameLike | null;
  url: string;
}

/** The guards' question for a navigating sub-frame of `wc`. */
export function officeFrameAllowed(wc: WebContents, e: { url: string; frame?: FrameLike | null }): boolean {
  const origin = origins.get(wc.id) ?? '';
  if (!origin) return false;
  try {
    const parent = e.frame?.parent ?? null;
    if (!parent) return false;
    const parentIsMain = parent.parent === null;
    return isOfficeFrameNavigation({ origin, url: e.url, parentIsMain, parentUrl: parentIsMain ? '' : parent.url });
  } catch {
    return false;
  }
}
