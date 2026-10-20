import { create } from 'zustand';
import { handleDeepLink, parseBoardLink, parseInviteCode, parseRoomInviteCode } from './links';

/**
 * Web link page (docs/09 #53): `https://<server>/join/<code>` and `/r/<code>` first show a card —
 * «Открыть в Calab» / «Продолжить в браузере» / «Скачать приложение» — instead of jumping straight
 * into the web flow. `/t/<KEY-N>` (a task link copied by hand and sent through a messenger, CBF-40)
 * gets the same card, but only for a visitor without a web session (see `skipsLanding`). Web only: the desktop app handles `calab://` and pasted https links directly.
 */
export interface LinkLanding {
  kind: 'join' | 'r' | 't';
  code: string;
  /** The link as the app flow takes it (`handleDeepLink`). */
  url: string;
}

interface LinkLandingState {
  link: LinkLanding | null;
}

export const useLinkLanding = create<LinkLandingState>()(() => ({ link: null }));

export function landingFor(url: string): LinkLanding | null {
  const room = parseRoomInviteCode(url);
  if (room) return { kind: 'r', code: room, url };
  const board = /\/t\/[^/]+\/?(?:[?#].*)?$/.test(url) ? parseBoardLink(url) : null;
  if (board?.kind === 'task') return { kind: 't', code: board.id, url };
  // Bare codes are not links: the landing is for /join/<code> URLs only.
  const code = /\/join\//.test(url) ? parseInviteCode(url) : null;
  return code ? { kind: 'join', code, url } : null;
}

/**
 * A task link opens the card straight away for someone already signed in on the web (the card is
 * for links coming from outside: messengers, mail). Join / room links always show it (docs/09 #53).
 */
export function skipsLanding(link: LinkLanding, signedIn: boolean): boolean {
  return link.kind === 't' && signedIn;
}

/** Shows the card for a web link; false = not a link (the caller handles it as before). */
export function showLinkLanding(url: string): boolean {
  const link = landingFor(url);
  if (!link) return false;
  useLinkLanding.setState({ link });
  return true;
}

/** «Продолжить в браузере»: the regular web flow (login / guest screen / join dialog). */
export function continueInBrowser(): void {
  const link = useLinkLanding.getState().link;
  if (!link) return;
  useLinkLanding.setState({ link: null });
  // The address bar keeps /join/<code> while the card is shown (a reload shows it again).
  try {
    history.replaceState(null, '', '/');
  } catch {
    // not fatal
  }
  handleDeepLink(link.url);
}

/** «Всегда открывать в приложении» — a per-browser convenience, so localStorage. */
const ALWAYS_APP_KEY = 'calab-open-links-in-app';

export function alwaysOpenInApp(): boolean {
  try {
    return localStorage.getItem(ALWAYS_APP_KEY) === '1';
  } catch {
    return false;
  }
}

export function setAlwaysOpenInApp(on: boolean): void {
  try {
    if (on) localStorage.setItem(ALWAYS_APP_KEY, '1');
    else localStorage.removeItem(ALWAYS_APP_KEY);
  } catch {
    // storage blocked: the option just does not stick
  }
}
