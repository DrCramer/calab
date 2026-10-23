import { create } from 'zustand';
import type { MailAddress, MailDraft } from '../../shared/mail';
import { useBoardsUi } from './boardsUi';
import { openRow, useMail } from './mail';
import { useWebApps } from './webApps';

/**
 * The «Почта» section's shell state (ADR-0088 §8): whether the mail mode covers the column and the
 * centre, the add-account form (with a deep-link prefill, §12) and the composer request. Not
 * persisted: the app starts on the section it left by the other stores (mail is not remembered per
 * workspace, like «Личные»). The mail data itself lives in stores/mail.ts.
 *
 * Exclusive with the other modes: a room / DM / day / board / web app opened from anywhere turns
 * mail off — the boards and web apps through the subscriptions below, rooms and days in stores/ui.ts.
 */

/** What the composer opens with. `seq` makes a repeated request (the same reply twice) a new one. */
export type ComposeRequest =
  | { kind: 'new'; accountId?: string; to?: MailAddress[]; cc?: MailAddress[]; subject?: string; text?: string; seq: number }
  | { kind: 'reply' | 'replyAll' | 'forward'; messageId: string; seq: number }
  | { kind: 'draft'; draft: MailDraft; seq: number };

/** Prefill of the add-account form from `calab://mail/<payload>` (§12). Lives in memory only; never logged. */
export interface AddPrefill {
  email: string;
  password: string;
  seq: number;
}

interface MailUiState {
  active: boolean;
  setActive: (on: boolean) => void;
  /** The add-account card is shown in the centre (also the empty state without accounts). */
  adding: boolean;
  prefill: AddPrefill | null;
  openAdd: (prefill?: { email: string; password: string }) => void;
  closeAdd: () => void;
  compose: ComposeRequest | null;
  /**
   * The list's multi-selection (Apple Mail: ⌘-click, ⇧-click, ⌘A), row keys; empty or ≥ 2 — one
   * selected row is `useMail.selected`. Replaced on change; rows read `picked.has(key)` (a boolean),
   * so a toggle re-renders the toggled rows only.
   */
  picked: ReadonlySet<string>;
  /** «Отправить в чат…»: the message whose chat picker is open. */
  toChat: string | null;
  openToChat: (messageId: string | null) => void;
  openCompose: (req: DistributiveOmit<ComposeRequest, 'seq'>) => void;
  closeCompose: () => void;
  /** The mailbox sidebar is shown (CBF-56, Apple Mail; remembered on this computer). */
  sidebar: boolean;
  toggleSidebar: () => void;
  /** Folded account sections and folders (ids), remembered on this computer. */
  collapsed: ReadonlySet<string>;
  toggleCollapsed: (id: string) => void;
  folderDialog: FolderDialogReq | null;
  openFolderDialog: (req: FolderDialogReq | null) => void;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * The folder dialog (CBF-56): a new folder in an account (under `parentId`; `smart` starts it as a
 * smart folder), renaming an own folder, or editing a smart folder.
 */
export type FolderDialogReq =
  | { kind: 'create'; accountId: string | null; parentId: string | null; smart: boolean }
  | { kind: 'rename'; folderId: string }
  | { kind: 'smart'; smartId: string };

const SIDEBAR_KEY = 'calab.mail.sidebar';
const COLLAPSED_KEY = 'calab.mail.collapsed';

/** Per-viewer conveniences (CBF-56): the sidebar shown, the folded accounts / folders. Storage may be unavailable. */
function readPref<T>(key: string, fallback: T): T {
  try {
    if (typeof window === 'undefined') return fallback;
    const v = window.localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

function readCollapsed(): ReadonlySet<string> {
  const v = readPref<unknown>(COLLAPSED_KEY, []);
  return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
}

function writePref(key: string, v: unknown): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // private mode / blocked storage: the preference lives for this session only
  }
}

let seq = 0;

export const useMailUi = create<MailUiState>()((set) => ({
  active: false,
  setActive: (active) => set((s) => (s.active === active ? s : { active })),
  adding: false,
  prefill: null,
  openAdd: (prefill) => set({ adding: true, prefill: prefill ? { ...prefill, seq: ++seq } : null }),
  closeAdd: () => set({ adding: false, prefill: null }),
  compose: null,
  picked: new Set<string>(),
  toChat: null,
  openToChat: (toChat) => set({ toChat }),
  openCompose: (req) => set({ compose: { ...req, seq: ++seq } }),
  closeCompose: () => set({ compose: null }),
  sidebar: readPref<unknown>(SIDEBAR_KEY, true) !== false,
  toggleSidebar: () =>
    set((s) => {
      writePref(SIDEBAR_KEY, !s.sidebar);
      return { sidebar: !s.sidebar };
    }),
  collapsed: readCollapsed(),
  toggleCollapsed: (id) =>
    set((s) => {
      const next = new Set(s.collapsed);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writePref(COLLAPSED_KEY, [...next].slice(-500));
      return { collapsed: next };
    }),
  folderDialog: null,
  openFolderDialog: (folderDialog) => set({ folderDialog }),
}));

const NONE: ReadonlySet<string> = new Set<string>();

export function clearPicked(): void {
  if (useMailUi.getState().picked.size) useMailUi.setState({ picked: NONE });
}

/** Applies a new multi-selection: ≥ 2 rows stay picked; one left opens as the single selection. */
function setPicked(next: Set<string>, focus: string | null): void {
  if (next.size <= 1) {
    clearPicked();
    const only = next.values().next().value;
    if (only !== undefined && useMail.getState().selected !== only) openRow(only);
    return;
  }
  useMailUi.setState({ picked: next });
  // The highlighted single row (`selected`) is always one of the picked ones.
  const sel = useMail.getState().selected;
  if (!sel || !next.has(sel)) useMail.setState({ selected: focus && next.has(focus) ? focus : (next.values().next().value ?? null) });
}

/** ⌘-click: adds / removes one row (the row open before joins the selection). */
export function togglePick(key: string): void {
  const s = useMail.getState();
  const next = new Set(useMailUi.getState().picked);
  if (!next.size && s.selected && s.selected !== key) next.add(s.selected);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  setPicked(next, next.has(key) ? key : null);
}

/** ⇧-click: the rows from the open one (the anchor) to this one. */
export function pickRange(key: string): void {
  const s = useMail.getState();
  const anchor = s.selected ?? key;
  const a = s.order.indexOf(anchor);
  const b = s.order.indexOf(key);
  if (a < 0 || b < 0) {
    openRow(key);
    return;
  }
  setPicked(new Set(s.order.slice(Math.min(a, b), Math.max(a, b) + 1)), anchor);
}

/** ⌘A: every loaded row; a second ⌘A changes nothing. */
export function pickAll(): void {
  const s = useMail.getState();
  const cur = useMailUi.getState().picked;
  if (s.order.length < 2 || (cur.size === s.order.length && s.order.every((k) => cur.has(k)))) return;
  setPicked(new Set(s.order), s.selected);
}

/** The rows an action applies to: the multi-selection, else the selected row (keys of loaded rows). */
export function actionKeys(): string[] {
  const s = useMail.getState();
  const picked = useMailUi.getState().picked;
  if (picked.size > 1) return [...picked].filter((k) => !!s.rows[k]);
  return s.selected && s.rows[s.selected] ? [s.selected] : [];
}

// The selection follows the list: another box / search / filter clears it, removed rows leave it.
useMail.subscribe((s, p) => {
  const picked = useMailUi.getState().picked;
  if (!picked.size) return;
  if (s.box !== p.box || s.query !== p.query || s.unreadOnly !== p.unreadOnly || s.flaggedOnly !== p.flaggedOnly) {
    clearPicked();
    return;
  }
  if (s.order !== p.order) {
    const live = new Set(s.order);
    const kept = [...picked].filter((k) => live.has(k));
    if (kept.length !== picked.size) {
      if (kept.length >= 2) useMailUi.setState({ picked: new Set(kept) });
      else clearPicked();
    }
  }
});

/** Turns the mail mode off (a room, a day, a workspace opened from anywhere). */
export function leaveMail(): void {
  if (useMailUi.getState().active) useMailUi.getState().setActive(false);
}

useBoardsUi.subscribe((s, prev) => {
  if (s.active && !prev.active) leaveMail();
});
useWebApps.subscribe((s, prev) => {
  if (s.open && s.open !== prev.open) leaveMail();
});
