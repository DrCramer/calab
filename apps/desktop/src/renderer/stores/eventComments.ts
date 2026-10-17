import { create } from 'zustand';
import type { CalendarEventComment } from '@calaba/protocol';

/**
 * Comments on meetings (ADR-0104), per event (series) id: those of the meetings whose card was
 * opened (oldest first), and the latest count every EVENT_COMMENT_* carried. services/eventComments.ts
 * fills it. Components select the id list of one event (useShallow) or one comment by id.
 */
export interface EventThread {
  ids: readonly string[];
  byId: Readonly<Record<string, CalendarEventComment>>;
  /** Older comments exist on the server. */
  hasMore: boolean;
  loading: boolean;
  /** The first page arrived. */
  loaded: boolean;
}

interface EventCommentsState {
  threads: Readonly<Record<string, EventThread>>;
  /** Event id → comment count from the gateway (newer than the event's counts.comments). */
  counts: Readonly<Record<string, number>>;
  reset: () => void;
}

export const EMPTY_THREAD: EventThread = { ids: [], byId: {}, hasMore: false, loading: false, loaded: false };

export const useEventComments = create<EventCommentsState>()((set) => ({
  threads: {},
  counts: {},
  reset: () => set({ threads: {}, counts: {} }),
}));
