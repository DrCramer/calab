import { lazy } from 'react';

/**
 * The lazy boundary of the canvas screen (ADR-0114 §4, §5): the engine, Yjs and the sync provider
 * load as their own chunk the first time a canvas opens. Nothing outside the chunk may import
 * features/canvas/engine, lib/canvasSync or lib/ySync at runtime (lib/canvas/docHandle.ts and
 * lib/canvas/restore.ts are the main chunk's only way in, and restore.ts is loaded by the view).
 */
export const CanvasViewLazy = lazy(() => import('./view').then((m) => ({ default: m.CanvasView })));

/** Warm the chunk (the section opened, a tree row hovered) without rendering it. */
export function preloadCanvasView(): void {
  void import('./view');
}
