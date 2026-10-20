/**
 * The open canvas's live document, as the main chunk may call it (ADR-0114 §3, §5): «Восстановить»
 * a version needs the live Y.Doc, which lives in the lazy chunk (features/canvas/view). The view
 * registers a handle here while it is mounted; nothing in this module imports Yjs or the engine.
 * Same idea as lib/wiki/docHandle.ts.
 */
export interface CanvasDocHandle {
  canvasId: string;
  /**
   * Replaces the live document's objects with a version's Yjs state, as one local transaction (the
   * co-authors see it as an edit, my undo can take it back); false = nothing changed. The view implements it with
   * `restoreCanvasState(canvasDoc, state)` from lib/canvas/restore.ts.
   */
  restore(state: Uint8Array): boolean;
  /** Whether the document may be changed by me (CANVAS_WRITE, not in the trash, synced). */
  writable(): boolean;
}

let current: CanvasDocHandle | null = null;

export function setCanvasDocHandle(h: CanvasDocHandle | null): void {
  current = h;
}

/** The handle of `canvasId` when that canvas's document is mounted. */
export function canvasDocHandle(canvasId: string): CanvasDocHandle | null {
  return current && current.canvasId === canvasId ? current : null;
}
