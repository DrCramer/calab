/**
 * The Calab side of the office editor's host page protocol (ADR-0143, infra/office/calab-editor.js):
 * the editor runs in an iframe on the Document Server's origin; this module hands it the signed
 * configuration when it says hello and turns its events into the frame's status. Nothing here
 * loads the Document Server's JS: closing the dialog removes the iframe and with it everything
 * the editor ran (no idle cost — CLAUDE.md «Производительность»).
 */

import { officeCapability, useOfficeCaps, type OfficeCap } from './caps';

export type OfficeStatus = 'loading' | 'saved' | 'saving' | 'error';

export { convertTarget, officeCapability, type OfficeCap } from './caps';

/** The frame is view-only: the phone always (ADR-0143 §10), a view-only type, or the server's mode. */
export function viewOnly(cap: OfficeCap, serverEdit: boolean, phone: boolean): boolean {
  return phone || cap === 'view' || !serverEdit;
}

/** Why the frame shows an error: the Document Server cannot be reached, the config's token was refused, anything else. */
export type OfficeProblem = 'unreachable' | 'token' | 'other';

export function problemOf(code: string): OfficeProblem {
  if (code === 'api-load' || code === 'api-missing' || code === 'timeout') return 'unreachable';
  // -20: the security token was refused (expired or not formed correctly); the cure is a fresh config.
  if (code === '-20' || code === '-18') return 'token';
  return 'other';
}

export type HostEvent =
  | { name: 'ready' }
  | { name: 'state'; dirty: boolean }
  | { name: 'error'; code: string }
  | { name: 'warning' }
  | { name: 'users'; names: string[] }
  | { name: 'requestClose' }
  | { name: 'closed' };

const SRC = 'calab-office';

/** The frame's state: the status, why it failed, who else is in the file. */
export interface FrameState {
  status: OfficeStatus;
  problem: OfficeProblem | null;
  others: string[];
}

export const FRAME_START: FrameState = { status: 'loading', problem: null, others: [] };

/** One event of the host page applied to the frame's state (pure: the status machine, unit-tested). */
export function frameReducer(prev: FrameState, e: HostEvent | { name: 'reset' }): FrameState {
  if (e.name === 'reset') return FRAME_START;
  if (e.name === 'users') return { ...prev, others: e.names };
  const status = nextStatus(prev.status, e);
  if (status === prev.status && e.name !== 'error') return prev;
  return { ...prev, status, problem: e.name === 'error' && prev.status !== 'error' ? problemOf(e.code) : prev.problem };
}

/** The frame's status after an event of the host page. */
export function nextStatus(prev: OfficeStatus, e: HostEvent): OfficeStatus {
  switch (e.name) {
    case 'ready':
      return prev === 'error' ? prev : 'saved';
    case 'state':
      return prev === 'error' ? prev : e.dirty ? 'saving' : 'saved';
    case 'error':
      return 'error';
    default:
      return prev;
  }
}

/** The origin of an http(s) URL, '' otherwise. */
export function originOf(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : '';
  } catch {
    return '';
  }
}

function parse(data: unknown): HostEvent | 'hello' | null {
  if (!data || typeof data !== 'object') return null;
  const m = data as { source?: unknown; type?: unknown; name?: unknown; data?: unknown };
  if (m.source !== SRC) return null;
  if (m.type === 'hello') return 'hello';
  if (m.type === 'closed') return { name: 'closed' };
  if (m.type !== 'event') return null;
  switch (m.name) {
    case 'ready':
    case 'warning':
    case 'requestClose':
      return { name: m.name };
    case 'state':
      return { name: 'state', dirty: m.data === true };
    case 'users': {
      const names = Array.isArray(m.data) ? m.data.map((u: unknown) => (u && typeof u === 'object' ? (u as { name?: unknown }).name : null)).filter((n): n is string => typeof n === 'string' && n !== '').slice(0, 20) : [];
      return { name: 'users', names };
    }
    case 'error': {
      const code = m.data && typeof m.data === 'object' ? (m.data as { code?: unknown }).code : undefined;
      return { name: 'error', code: typeof code === 'number' || typeof code === 'string' ? String(code) : '' };
    }
    default:
      return null;
  }
}

export interface HostConnection {
  /** Asks the host page to destroy the editor and stops listening (the caller removes the frame). */
  close(): void;
  /** Asks the editor to save now (a forced save, when this editor version has one): the file is being left. */
  save(): void;
  /** The app's theme changed while the editor is open (the host applies it when the editor supports that). */
  setTheme(theme: 'dark' | 'light'): void;
}

/**
 * Listens to the host page in `frame` (messages from its window and the Document Server's origin
 * only) and sends it `configJson` once it says hello (only to that origin); `onHello` learns the
 * Document Server answered.
 */
export function connectHost(win: Window, frame: HTMLIFrameElement, docsOrigin: string, configJson: string, on: (e: HostEvent) => void, onHello?: () => void): HostConnection {
  let sent = false;
  const listener = (e: MessageEvent): void => {
    if (e.source !== frame.contentWindow || e.origin !== docsOrigin) return;
    const m = parse(e.data);
    if (m === null) return;
    if (m === 'hello') {
      if (sent) return;
      sent = true;
      let config: unknown;
      try {
        config = JSON.parse(configJson);
      } catch {
        on({ name: 'error', code: 'config' });
        return;
      }
      frame.contentWindow?.postMessage({ source: SRC, type: 'open', config }, docsOrigin);
      onHello?.();
      return;
    }
    on(m);
  };
  win.addEventListener('message', listener);
  return {
    save() {
      frame.contentWindow?.postMessage({ source: SRC, type: 'save' }, docsOrigin);
    },
    setTheme(theme) {
      const caps = useOfficeCaps.getState();
      frame.contentWindow?.postMessage({ source: SRC, type: 'theme', theme: theme === 'light' ? caps.themeLight || 'default-light' : caps.themeDark || 'default-dark' }, docsOrigin);
    },
    close() {
      win.removeEventListener('message', listener);
      frame.contentWindow?.postMessage({ source: SRC, type: 'close' }, docsOrigin);
    },
  };
}

/** «Открыть» opens the editor for this file: the server's capabilities name its extension (and the editor is on). */
export function officeOpens(name: string): boolean {
  return officeCapability(name) !== null;
}
