/**
 * Phone navigation (ADR-0073 §1–§2): root tabs with a bottom tab bar and a stack of pushed
 * screens above the tab root. Pure functions; `useUi.phone` holds the state, services/phoneNav.ts
 * keeps it in step with the browser history (Android back, the browser's back, the edge swipe)
 * and with the older per-feature flags (members, search, calendar event, task…).
 */

export type PhoneTab = 'chats' | 'dms' | 'boards' | 'calendar' | 'disk' | 'wiki' | 'canvas' | 'profile';
/** Default order of all sections (rail order without mail, ADR-0095 addendum 2026-10-14). */
export const PHONE_TABS: readonly PhoneTab[] = ['chats', 'dms', 'calendar', 'boards', 'wiki', 'canvas', 'disk', 'profile'];

/** How many tabs sit on the bar itself; the rest live behind «Ещё» (ADR-0095). */
export const PINNED_COUNT = 4;
/** Candidates for the pinned set, in the order they top up a short list. */
export const DEFAULT_PINNED: readonly PhoneTab[] = ['chats', 'dms', 'boards', 'calendar'];

/**
 * Pin toggle (addendum 2026-10-14): only changes the set, never the order. Pinning with the bar
 * full is refused (`full`, the card disables the pin with a hint); unpinning is always possible.
 */
export function togglePin(pinned: readonly PhoneTab[], tab: PhoneTab): { pinned: PhoneTab[]; full?: boolean } {
  if (pinned.includes(tab)) return { pinned: pinned.filter((x) => x !== tab) };
  if (pinned.length >= PINNED_COUNT) return { pinned: [...pinned], full: true };
  return { pinned: [...pinned, tab] };
}

const known = (v: unknown): PhoneTab[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is PhoneTab => PHONE_TABS.includes(x as PhoneTab)))] : []);

/** A stored pinned set is valid when it holds distinct known tabs, at most `PINNED_COUNT` (fewer is fine: the user unpinned). Not an array = default. */
export function normalizePinned(v: unknown): PhoneTab[] {
  return Array.isArray(v) ? known(v).slice(0, PINNED_COUNT) : [...DEFAULT_PINNED];
}

/** Migration from the three-cell bar (prefs v5): a full old list of 3 gets the next default appended. */
export function migratePinned(v: unknown): PhoneTab[] {
  const out = normalizePinned(v);
  if (out.length === PINNED_COUNT - 1) {
    const next = DEFAULT_PINNED.find((x) => !out.includes(x));
    if (next) out.push(next);
  }
  return out.length === 0 ? [...DEFAULT_PINNED] : out;
}

/**
 * The full order of the sections (pinned and not): stored ids first, the missing ones after in the
 * default order. Migration passes the old pinned list as `lead` so the bar keeps its order.
 */
export function normalizeOrder(v: unknown, lead: readonly PhoneTab[] = []): PhoneTab[] {
  const out = [...new Set([...lead, ...known(v)])];
  for (const t of PHONE_TABS) if (!out.includes(t)) out.push(t);
  return out;
}

/** Moves `from` onto the place of `to` (drag and drop of a card row). */
export function moveTab(order: readonly PhoneTab[], from: PhoneTab, to: PhoneTab): PhoneTab[] {
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  if (a < 0 || b < 0 || a === b) return [...order];
  const out = [...order];
  out.splice(a, 1);
  out.splice(b, 0, from);
  return out;
}

/**
 * The tabs shown on the bar for an account: pinned and available, in the `order`, topped up from
 * the available ones in that order (a guest has few sections): at most `PINNED_COUNT`. `more` =
 * something is hidden, so «Ещё» is shown.
 */
export function barTabs(pinned: readonly PhoneTab[], available: readonly PhoneTab[], order: readonly PhoneTab[] = PHONE_TABS): { bar: PhoneTab[]; more: boolean } {
  const ordered = order.filter((t) => available.includes(t));
  const bar = ordered.filter((t) => pinned.includes(t)).slice(0, PINNED_COUNT);
  for (const t of ordered) if (bar.length < PINNED_COUNT && !bar.includes(t)) bar.push(t);
  const sorted = ordered.filter((t) => bar.includes(t));
  return { bar: sorted, more: available.some((t) => !sorted.includes(t)) };
}

/**
 * A pushed screen. Chats carry their ids (back from room B shows room A again); the other kinds
 * mirror a flag of their feature store, which is the source of their content.
 */
export type PhoneScreen =
  | { kind: 'room'; ws: string; room: string }
  | { kind: 'dm'; room: string }
  | { kind: 'members'; ws: string; room: string }
  | { kind: 'search' }
  | { kind: 'event'; key: string }
  | { kind: 'findTime' }
  | { kind: 'board'; ws: string }
  | { kind: 'task'; id: string }
  | { kind: 'archived'; room: string }
  /** A folder of «Диск» (ADR-0094 §8) or, with `trash`, its trash; the workspace is the open one. */
  | { kind: 'disk'; folderId: string; trash?: boolean }
  /** A page of «Вики» (ADR-0096 §7), or with `trash` its trash (pageId ''); the workspace is the open one. */
  | { kind: 'wiki'; pageId: string; trash?: boolean }
  /** A folder or a canvas of «Холст» (ADR-0107 §5, view only on the phone); the workspace is the open one. */
  | { kind: 'canvas'; itemId: string }
  /**
   * A settings window (app, workspace, room or board; its source is `useUi.dialog` / `useBoardsUi.settingsFor`)
   * as a screen: `section` null = the list of sections (also the search), else that section.
   * The list → section hop is one more screen, so back returns to the list.
   */
  | { kind: 'settings'; section: string | null };

export type ScreenKind = PhoneScreen['kind'];

export interface PhoneNav {
  /** The phone layout drives navigation (services/phoneNav installed); false on the desktop. */
  on: boolean;
  tab: PhoneTab;
  /** Pushed screens over the tab root, bottom first; empty = the tab root with the tab bar. */
  stack: readonly PhoneScreen[];
}

/** Deeper stacks drop their bottom screen (the history keeps working: it counts levels only). */
export const MAX_DEPTH = 8;

export const emptyPhoneNav = (): PhoneNav => ({ on: false, tab: 'chats', stack: [] });

export const topScreen = (nav: Pick<PhoneNav, 'stack'>): PhoneScreen | undefined => nav.stack.at(-1);

const isChat = (s: PhoneScreen): s is Extract<PhoneScreen, { kind: 'room' | 'dm' }> => s.kind === 'room' || s.kind === 'dm';

/** The room / DM the top screen shows, else null (the root list shows no room as read). */
export function visibleRoom(nav: Pick<PhoneNav, 'stack'>): string | null {
  const top = topScreen(nav);
  return top && (top.kind === 'room' || top.kind === 'dm' || top.kind === 'archived') ? top.room : null;
}

export function sameScreen(a: PhoneScreen, b: PhoneScreen): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'room':
    case 'members':
      return a.room === (b as typeof a).room && a.ws === (b as typeof a).ws;
    case 'dm':
    case 'archived':
      return a.room === (b as typeof a).room;
    case 'event':
      return a.key === (b as typeof a).key;
    case 'board':
      return a.ws === (b as typeof a).ws;
    case 'task':
      return a.id === (b as typeof a).id;
    case 'settings':
      return a.section === (b as typeof a).section;
    case 'disk':
      return a.folderId === (b as typeof a).folderId && !!a.trash === !!(b as typeof a).trash;
    case 'wiki':
      return a.pageId === (b as typeof a).pageId && !!a.trash === !!(b as typeof a).trash;
    case 'canvas':
      return a.itemId === (b as typeof a).itemId;
    case 'search':
    case 'findTime':
      return true;
  }
}

/**
 * Pushes a screen. The same screen already in the stack is returned to instead (its screens
 * above are dropped), so a loop room A → B → A never grows the stack.
 */
export function pushScreen(nav: PhoneNav, s: PhoneScreen): PhoneNav {
  const at = nav.stack.findIndex((x) => sameScreen(x, s));
  if (at >= 0) return at === nav.stack.length - 1 ? nav : { ...nav, stack: nav.stack.slice(0, at + 1) };
  return { ...nav, stack: [...nav.stack, s].slice(-MAX_DEPTH) };
}

/** A settings section picked on the list: pushed over the list (a screen of its own). */
export function openSettingsSection(nav: PhoneNav, section: string): PhoneNav {
  return pushScreen(nav, { kind: 'settings', section });
}

export function popScreen(nav: PhoneNav, n = 1): PhoneNav {
  if (n <= 0 || nav.stack.length === 0) return nav;
  return { ...nav, stack: nav.stack.slice(0, Math.max(0, nav.stack.length - n)) };
}

/** Drops every screen of a kind (its feature flag went off elsewhere). */
export function removeKind(nav: PhoneNav, kind: ScreenKind): PhoneNav {
  return nav.stack.some((s) => s.kind === kind) ? { ...nav, stack: nav.stack.filter((s) => s.kind !== kind) } : nav;
}

export const hasKind = (nav: Pick<PhoneNav, 'stack'>, kind: ScreenKind): boolean => nav.stack.some((s) => s.kind === kind);

/** A tab: its root, nothing pushed. Tapping the open tab also returns to its root. */
export function switchTab(nav: PhoneNav, tab: PhoneTab): PhoneNav {
  return nav.tab === tab && nav.stack.length === 0 ? nav : { ...nav, tab, stack: [] };
}

/** The tab a chat lives under: DMs and notes in «Личные», rooms in «Команда». */
export const tabOfChat = (s: Extract<PhoneScreen, { kind: 'room' | 'dm' }>): PhoneTab => (s.kind === 'dm' ? 'dms' : 'chats');

/**
 * Opening a room or a DM from anywhere (the list, a link, a notification, ⌘K, search). Another
 * tab: «tab root → chat» (a deep link). The same tab: the screens that are not chats (members,
 * search, an event…) close — opening a room leaves them in their stores too — and the chat is
 * pushed over the chats below it, so back returns to the room the link was tapped in.
 */
export function openChat(nav: PhoneNav, s: Extract<PhoneScreen, { kind: 'room' | 'dm' }>): PhoneNav {
  const tab = tabOfChat(s);
  if (nav.tab !== tab) return { ...nav, tab, stack: [s] };
  const chats = nav.stack.filter(isChat);
  return pushScreen({ ...nav, stack: chats }, s);
}

/** A screen of a tab: pushed when that tab is open, else «tab root → screen». */
export function pushOnTab(nav: PhoneNav, tab: PhoneTab, s: PhoneScreen): PhoneNav {
  return nav.tab === tab ? pushScreen(nav, s) : { ...nav, tab, stack: [s] };
}

/** What one «back» does: close the open sheet / menu first, else drop the top screen. */
export type BackStep = 'overlay' | 'screen' | 'none';

export function backStep(o: { overlay: boolean; depth: number }): BackStep {
  if (o.overlay) return 'overlay';
  return o.depth > 0 ? 'screen' : 'none';
}

/**
 * The browser history entries the app needs above its base entry: one per pushed screen, plus one
 * per open layer — a dialog, a menu card and each of its sub-levels (owner 07.10: «back» walks a
 * sub-menu back one level), so «back» closes the top one first, even on a tab root.
 */
export const historyTarget = (depth: number, layers: number): number => depth + Math.max(0, layers);

/** How to bring the history from `current` levels to `target`: push entries, or go back. */
export type HistoryPlan = { push: number } | { go: number } | null;

export function historyPlan(target: number, current: number): HistoryPlan {
  if (target > current) return { push: target - current };
  if (target < current) return { go: target - current };
  return null;
}

/** Our level stored in a history entry's state (absent = the base entry). */
export function depthOfState(state: unknown): number {
  const d = (state as { calabaNav?: unknown } | null)?.calabaNav;
  return typeof d === 'number' && Number.isInteger(d) && d >= 0 ? d : 0;
}
