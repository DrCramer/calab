import type { SearchHit } from '@calaba/protocol';
import { WorkspaceRole } from '@calaba/protocol';
import { create } from 'zustand';
import { MOBILE_QUERY } from '../lib/phone';
import { NO_FILTERS, type PanelFilters } from '../lib/search/query';
import type { SectionName } from '../lib/search/sections';
import { useBoards } from './boards';
import { MY_TASKS, useBoardsUi } from './boardsUi';
import { HOME } from './dms';
import { useUi } from './ui';
import { useWebApps } from './webApps';
import { useWorkspaces } from './workspaces';

/** The loaded list of the panel: the hits of one request and where its cursor stands. */
export interface SearchFeed {
  /** The request (first page's parameters) these hits answer. */
  key: string;
  hits: SearchHit[];
  cursor: string;
  done: boolean;
  total: number;
  timedOut: boolean;
  failed: boolean;
  /** Pages in a row that added no row passing the filters. */
  emptyRun: number;
}

/** What the panel had on screen when it unmounted (a trip to the boards, the calendar…). */
export interface SearchView {
  /** The search (show() count) it belongs to: a newer search never restores it. */
  seq: number;
  feed: SearchFeed | null;
  scrollTop: number;
}

/**
 * «Результаты поиска» (ADR-0062 §4, ADR-0105): the search the right panel shows — query, scope, tab,
 * filters — and the list it had loaded, so leaving the panel's view (boards, calendar, another
 * room) and coming back shows the same results at the same place without a refetch. Reset by a
 * new search (show) and dropped by close. Not persisted. `view` is a snapshot the panel reads once
 * when it mounts; nothing subscribes to it.
 */
interface SearchPanelState {
  open: boolean;
  /** Bumped by every show(): the panel remounts with the new query (its field and filters reset). */
  seq: number;
  q: string;
  /** A workspace id or "all". */
  scope: string;
  tab: SectionName;
  filters: PanelFilters;
  /** The moment the period filter is measured from: set when a period is picked. */
  anchor: number;
  /** The board the search was started on (boards view): the tasks tab's default board filter. */
  homeBoard: string;
  view: SearchView | null;
  show: (q: string, scope: string, tab: SectionName) => void;
  setTab: (tab: SectionName) => void;
  setQuery: (q: string) => void;
  setScope: (scope: string) => void;
  setFilter: <K extends keyof PanelFilters>(k: K, v: PanelFilters[K]) => void;
  resetFilters: () => void;
  saveView: (view: SearchView) => void;
  close: () => void;
}

/**
 * The phone layout (lib/mobile.ts isMobileNow), read without the platform module so the store
 * stays importable anywhere (tests without a window).
 */
function phoneNow(): boolean {
  return import.meta.env.VITE_PLATFORM === 'web' && typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches;
}

/** The workspace whose boards view is on screen (not «Личные», not a guest), else null. */
function boardsWorkspace(): string | null {
  const ws = useUi.getState().activeWorkspaceId;
  if (!ws || ws === HOME) return null;
  if (useWorkspaces.getState().byId[ws]?.role === WorkspaceRole.GUEST) return null;
  return ws;
}

/** The board open in the boards view of `ws` ('' for «Мои задачи» or a board gone). */
function openBoardOf(ws: string): string {
  const id = useBoardsUi.getState().boardOf[ws];
  if (!id || id === MY_TASKS) return '';
  const b = useBoards.getState().boards[id];
  return b && !b.archivedAt ? id : '';
}

/**
 * Task hits open in the boards view (ADR-0105): the tasks tab stands beside it, not beside an
 * unrelated chat. A phone shows the results as their own screen — nothing to switch there.
 */
function enterBoards(): void {
  if (phoneNow() || !boardsWorkspace()) return;
  if (!useBoardsUi.getState().active) useBoardsUi.getState().setActive(true);
}

function filtersFor(tab: SectionName, homeBoard: string): PanelFilters {
  return tab === 'tasks' && homeBoard ? { ...NO_FILTERS, place: homeBoard } : NO_FILTERS;
}

export const useSearchPanel = create<SearchPanelState>()((set, get) => ({
  open: false,
  seq: 0,
  q: '',
  scope: 'all',
  tab: 'messages',
  filters: NO_FILTERS,
  anchor: 0,
  homeBoard: '',
  view: null,
  show: (q, scope, tab) => {
    const bu = useBoardsUi.getState();
    const ws = boardsWorkspace();
    // Started inside the boards view: the tasks of this workspace and board first (widened in the
    // panel's filters).
    const fromBoards = bu.active && !!ws && !phoneNow();
    const homeBoard = fromBoards && ws ? openBoardOf(ws) : '';
    const sc = fromBoards && ws && tab === 'tasks' ? ws : scope;
    // The panel stands beside a chat or the boards: leave the calendar / web app views for it. A
    // phone keeps the old order (its search is a screen of its own above the tab).
    if (bu.active && phoneNow()) bu.setActive(false);
    if (useWebApps.getState().open) useWebApps.getState().setOpen(null);
    const ui = useUi.getState();
    if (ui.calDay) ui.closeCalendar();
    if (ui.membersOverlay) ui.setMembersOverlay(false);
    if (tab === 'tasks') enterBoards();
    set((s) => ({ open: true, seq: s.seq + 1, q: q.trim(), scope: sc, tab, filters: filtersFor(tab, homeBoard), anchor: Date.now(), homeBoard, view: null }));
  },
  setTab: (tab) => {
    if (tab === get().tab) return;
    if (tab === 'tasks') enterBoards();
    // Board / room ids differ between tabs; the rest of the filters stay.
    set((s) => ({ tab, filters: { ...s.filters, place: tab === 'tasks' ? s.homeBoard : '' } }));
  },
  setQuery: (q) => set({ q }),
  setScope: (scope) => set({ scope }),
  setFilter: (k, v) => set((s) => ({ filters: { ...s.filters, [k]: v }, ...(k === 'period' ? { anchor: Date.now() } : {}) })),
  resetFilters: () => set({ filters: NO_FILTERS }),
  saveView: (view) => {
    const s = get();
    if (s.open && view.seq === s.seq) set({ view });
  },
  close: () => set({ open: false, view: null }),
}));
