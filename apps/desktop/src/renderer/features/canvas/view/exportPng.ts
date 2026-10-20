/**
 * PNG export (ADR-0113 §6): the same drawing code as the live view, painted into an offscreen canvas.
 * No server route. The size is capped (long side ≤ 8192 px and ≤ 40 Mpx in all) so a huge canvas
 * cannot take the renderer's memory: the scale is lowered to fit.
 */
import type { CanvasEngine } from '../engine';

export type ExportArea = 'visible' | 'all';
export const MAX_EXPORT_SIDE = 8192;
export const MAX_EXPORT_PIXELS = 40_000_000;
/** World margin around the content for «all». */
export const EXPORT_PAD = 24;

/** Pixels per world unit: the wanted one, lowered until the image fits the limits. */
export function exportScale(worldW: number, worldH: number, want: number): number {
  const w = Math.max(1, worldW);
  const h = Math.max(1, worldH);
  // The engine rounds each side up to a whole pixel: leave one pixel / 0.1 % of room.
  const bySide = (MAX_EXPORT_SIDE - 1) / Math.max(w, h);
  const byArea = Math.sqrt((MAX_EXPORT_PIXELS * 0.999) / (w * h));
  return Math.max(0.001, Math.min(want, bySide, byArea));
}

export interface ExportOptions {
  area: ExportArea;
  /** Device pixel ratio for «visible» (the image matches what the screen shows); default: window's, at most 2. */
  dpr?: number;
}

function toBlob(c: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      c.toBlob((b) => resolve(b), 'image/png');
    } catch {
      resolve(null);
    }
  });
}

/** Renders the canvas to a PNG; `null` when there is nothing to export or the browser could not encode it. */
export async function exportCanvasPng(engine: CanvasEngine, opts: ExportOptions): Promise<Blob | null> {
  if (!engine.scene.bounds()) return null;
  let target: HTMLCanvasElement | null;
  if (opts.area === 'visible') {
    const rect = engine.visibleWorld();
    const dpr = Math.min(2, opts.dpr ?? (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1));
    const ppu = exportScale(rect.w, rect.h, engine.camera.scale * dpr);
    target = engine.exportToCanvas({ rect, pad: 0, pxPerUnit: ppu });
  } else {
    const b = engine.scene.bounds();
    if (!b) return null;
    const ppu = exportScale(b.w + 2 * EXPORT_PAD, b.h + 2 * EXPORT_PAD, 2);
    target = engine.exportToCanvas({ pxPerUnit: ppu, pad: EXPORT_PAD });
  }
  if (!target) return null;
  return toBlob(target);
}

/** `name.png` safe for any file system (no path separators or control characters). */
export function pngFileName(name: string, fallback: string): string {
  const clean = Array.from(name)
    .map((ch) => (ch.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(ch) ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return `${clean || fallback}.png`;
}

/** Saves a blob the way the rest of the product does: an `<a download>` (desktop: the Downloads folder). */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
