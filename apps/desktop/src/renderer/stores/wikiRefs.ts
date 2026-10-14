import { create } from 'zustand';

/**
 * Wiki pages referenced from outside the tree (owner 14.10): a page link in a document, a card in
 * the chat, a deep link. The page itself goes into `useWiki.pages` (one source of titles and icons);
 * this store only says how its lookup went, per id, once per session (services/wiki
 * `resolveWikiPage`). A row reads `state[id]` — a primitive, so a resolve re-renders that row only.
 *
 * - loading: the GET is in flight;
 * - ok: the page was read (if it is no longer in `useWiki`, it was deleted or hidden since);
 * - gone: 404 / 403 — deleted for good or not mine to see (nothing about it is shown);
 * - error: a network / server failure; the next mount tries again.
 */
export type WikiRefState = 'loading' | 'ok' | 'gone' | 'error';

interface WikiRefsState {
  state: Readonly<Record<string, WikiRefState>>;
  set: (id: string, v: WikiRefState) => void;
}

export const useWikiRefs = create<WikiRefsState>()((set) => ({
  state: {},
  set: (id, v) => set((s) => (s.state[id] === v ? s : { state: { ...s.state, [id]: v } })),
}));

/** What a page link shows: the page (in `useWiki`), a placeholder while it loads, or «unavailable». */
export type WikiRefView = 'page' | 'loading' | 'unavailable';

export function refView(known: boolean, st: WikiRefState | undefined): WikiRefView {
  if (known) return 'page';
  return st === undefined || st === 'loading' ? 'loading' : 'unavailable';
}
