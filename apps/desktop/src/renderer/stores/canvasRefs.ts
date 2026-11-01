import { create } from 'zustand';
import type { WikiRefState } from './wikiRefs';

/**
 * Canvases referenced from outside the tree (owner 23.10): a card in the chat, a deep link. The item
 * itself goes into `useCanvas.items` (one source of names); this store only says how its lookup went,
 * per id, once per session (services/canvasLink `resolveCanvasItem`). Same states and the same
 * `refView` as the wiki's: loading · ok · gone (404 / 403 / trashed) · error (retry on the next mount).
 */
interface CanvasRefsState {
  state: Readonly<Record<string, WikiRefState>>;
  set: (id: string, v: WikiRefState) => void;
}

export const useCanvasRefs = create<CanvasRefsState>()((set) => ({
  state: {},
  set: (id, v) => set((s) => (s.state[id] === v ? s : { state: { ...s.state, [id]: v } })),
}));
