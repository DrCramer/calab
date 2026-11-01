import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useBoardsUi } from './boardsUi';
import { useCanvasUi } from './canvasUi';
import { useDiskUi } from './diskUi';
import { useWikiUi } from './wikiUi';

/**
 * The «Телефония» section's UI state (ADR-0137 §5–§7): whether the section covers the column and
 * the centre (desktop), the open page of its navigation, the journal's filters and the call whose
 * detail is open. The journal's data lives in stores/sipJournal.ts.
 *
 * Exclusive with the other workspace modes like the Canvas: the boards, the Disk, the Wiki or the
 * Canvas turned on anywhere turn it off (below); a room, a day or history travel turn it off in
 * stores/ui.ts (leaveTelephony); the rail goes through features/shell/sectionNav.ts showMode.
 */

/**
 * The pages of the section: «Недавние» now; «Контакты» and «Набор» arrive with T4, the station's
 * settings with T5 (features/telephony/pages.ts lists the ones this build has).
 */
export type TelPage = 'recents' | 'contacts' | 'dial' | 'settings';

/** «Все | Пропущенные» (desktop) / «Недавние | Пропущенные» (phone). */
export type Segment = 'all' | 'missed';
export type Direction = 'all' | 'in' | 'out';
export type Period = 'any' | 'today' | 'yesterday' | 'week' | 'month';
/** Whose calls: mine, the workspace's (VIEW_JOURNALS), or one employee's (`user:<id>`, VIEW_JOURNALS). */
export type Scope = 'mine' | 'all' | `user:${string}`;

export interface JournalFilter {
  segment: Segment;
  direction: Direction;
  scope: Scope;
  period: Period;
  /** Digits of a number (names come with the contacts, T2/T4); trimmed. */
  q: string;
}

export const DEFAULT_FILTER: JournalFilter = { segment: 'all', direction: 'all', scope: 'mine', period: 'any', q: '' };

interface TelephonyUiState {
  active: boolean;
  setActive: (on: boolean) => void;
  page: TelPage;
  setPage: (p: TelPage) => void;
  filter: JournalFilter;
  setFilter: (patch: Partial<JournalFilter>) => void;
  resetFilter: () => void;
  /** The call whose detail is open (desktop: the right panel; the phone pushes a screen). */
  detail: string | null;
  openDetail: (callId: string | null) => void;
}

export const useTelephonyUi = create<TelephonyUiState>()(
  persist(
    (set) => ({
      active: false,
      setActive: (active) => set((s) => (s.active === active ? s : active ? { active } : { active, detail: null })),
      page: 'recents',
      setPage: (page) => set((s) => (s.page === page ? s : { page })),
      filter: DEFAULT_FILTER,
      setFilter: (patch) =>
        set((s) => {
          const next = { ...s.filter, ...patch };
          return (Object.keys(next) as Array<keyof JournalFilter>).every((k) => next[k] === s.filter[k]) ? s : { filter: next };
        }),
      // Back to everything; the scope a manager picked stays (it is not a narrowing «chip»).
      resetFilter: () => set((s) => ({ filter: { ...DEFAULT_FILTER, segment: s.filter.segment, scope: s.filter.scope === 'all' ? 'all' : 'mine' } })),
      detail: null,
      openDetail: (detail) => set((s) => (s.detail === detail ? s : { detail })),
    }),
    {
      name: 'calaba-telephony-ui',
      version: 1,
      // The scope a manager chose («Все звонки») is remembered; the rest starts clean.
      partialize: (s) => ({ scope: s.filter.scope === 'all' ? 'all' : 'mine' }),
      merge: (stored, cur) => {
        const p = (stored ?? {}) as { scope?: unknown };
        return { ...cur, filter: { ...cur.filter, scope: p.scope === 'all' ? 'all' : 'mine' } };
      },
    },
  ),
);

/** The filters a phone shows as chips (the segment and the scope «Мои» are not narrowing chips). */
export function activeChips(f: JournalFilter): Array<'direction' | 'scope' | 'period'> {
  const out: Array<'direction' | 'scope' | 'period'> = [];
  if (f.direction !== 'all') out.push('direction');
  if (f.scope !== 'mine') out.push('scope');
  if (f.period !== 'any') out.push('period');
  return out;
}

/** Leaves the section (a room, a day, a board, the Disk, the Wiki or the Canvas opened from anywhere). */
export function leaveTelephony(): void {
  if (useTelephonyUi.getState().active) useTelephonyUi.getState().setActive(false);
}

// The boards, the Disk, the Wiki or the Canvas turned on from anywhere leave the section.
useBoardsUi.subscribe((s, prev) => {
  if (s.active && !prev.active) leaveTelephony();
});
useDiskUi.subscribe((s, prev) => {
  if (s.active && !prev.active) leaveTelephony();
});
useWikiUi.subscribe((s, prev) => {
  if (s.active && !prev.active) leaveTelephony();
});
useCanvasUi.subscribe((s, prev) => {
  if (s.active && !prev.active) leaveTelephony();
});
