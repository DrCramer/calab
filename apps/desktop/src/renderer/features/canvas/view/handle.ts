/**
 * What the section's chrome (the header's «⋯» menu) can ask of the open canvas without owning the engine.
 * `CanvasView` registers a handle per canvas id while it is mounted; the same handle is also given to a
 * `ref` on `CanvasView`.
 */
import type { ExportArea } from './exportPng';

export interface CanvasViewHandle {
  /**
   * Renders the canvas to a PNG and saves it (`<a download>`). `area`: the visible part or all content
   * (default `all`); `name`: the canvas' name for the file. Toasts «nothing to export» / failure itself.
   * Resolves to whether a file was saved.
   */
  exportPng(opts?: { area?: ExportArea; name?: string }): Promise<boolean>;
  /** Fits everything into the view. */
  fitAll(): void;
}

const handles = new Map<string, CanvasViewHandle>();

export function registerCanvasViewHandle(canvasId: string, h: CanvasViewHandle): () => void {
  handles.set(canvasId, h);
  return () => {
    if (handles.get(canvasId) === h) handles.delete(canvasId);
  };
}

/** The handle of the canvas that is on screen right now, or null. */
export function getCanvasViewHandle(canvasId: string): CanvasViewHandle | null {
  return handles.get(canvasId) ?? null;
}
