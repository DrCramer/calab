/** Where the floating properties panel sits relative to the selection (screen space). Pure. */
import type { Camera } from '../../../lib/canvas/camera';
import type { Point, Rect } from '../../../lib/canvas/geometry';

export interface PanelPlacement {
  x: number;
  y: number;
  /** False when the selection is entirely outside the viewport (the panel hides). */
  visible: boolean;
}

/** Distances (px) from each viewport edge the panel must stay clear of: the screen's own floating chrome. */
export interface Insets {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const PANEL_GAP = 12;
export const PANEL_MARGIN = 8;
/** Radius (px) the rotation handle occupies around its center, hit area included. */
export const KNOB_RADIUS = 8;
export const NO_INSETS: Insets = { left: 0, top: 0, right: 0, bottom: 0 };

/**
 * The part of the viewport free of the screen's floating panels: `chrome` (left toolbar, top presence bar,
 * bottom undo/zoom bars) plus a margin. Never empty — a window too small to leave room keeps a 1px strip.
 */
export function safeArea(viewport: { w: number; h: number }, chrome: Insets = NO_INSETS): Rect {
  const l = Math.min(chrome.left + PANEL_MARGIN, viewport.w - 1);
  const t = Math.min(chrome.top + PANEL_MARGIN, viewport.h - 1);
  const r = Math.max(viewport.w - chrome.right - PANEL_MARGIN, l + 1);
  const b = Math.max(viewport.h - chrome.bottom - PANEL_MARGIN, t + 1);
  return { x: l, y: t, w: r - l, h: b - t };
}

/**
 * The panel centers over the visible part of the selection, goes above it, flips below when there is no
 * room above, and when neither fits (a selection taller than the window) sits inside its visible part. It
 * is always clamped into the safe area, so it never covers the toolbar or the zoom/undo bars. `bounds` is
 * in world units; `size` is the panel's own size in px; `chrome` is how far the floating panels reach in.
 * `knob` (world units) is the selection's rotation handle: the panel clears it like part of the selection —
 * above the handle, or below the object when there is no room above — instead of lying over it.
 */
export function placePanel(
  bounds: Rect,
  cam: Camera,
  viewport: { w: number; h: number },
  size: { w: number; h: number },
  chrome: Insets = NO_INSETS,
  knob?: Point | null,
): PanelPlacement {
  let sx = cam.tx + bounds.x * cam.scale;
  let sy = cam.ty + bounds.y * cam.scale;
  let sw = bounds.w * cam.scale;
  let sh = bounds.h * cam.scale;
  if (knob) {
    // The handle's disc joins the selection's screen box.
    const kx = cam.tx + knob.x * cam.scale;
    const ky = cam.ty + knob.y * cam.scale;
    const x0 = Math.min(sx, kx - KNOB_RADIUS);
    const y0 = Math.min(sy, ky - KNOB_RADIUS);
    sw = Math.max(sx + sw, kx + KNOB_RADIUS) - x0;
    sh = Math.max(sy + sh, ky + KNOB_RADIUS) - y0;
    sx = x0;
    sy = y0;
  }
  const visible = sx < viewport.w && sy < viewport.h && sx + sw > 0 && sy + sh > 0;
  const safe = safeArea(viewport, chrome);
  const sRight = safe.x + safe.w;
  const sBottom = safe.y + safe.h;

  // Horizontal: center on the part of the selection inside the safe area (the whole selection when it fits).
  const vl = Math.max(sx, safe.x);
  const vr = Math.min(sx + sw, sRight);
  const center = vl < vr ? (vl + vr) / 2 : sx + sw / 2;
  const x = Math.max(safe.x, Math.min(center - size.w / 2, sRight - size.w));

  // Vertical: above, else below, else inside the visible top of the selection.
  let y = sy - size.h - PANEL_GAP;
  if (y < safe.y) {
    y = sy + sh + PANEL_GAP;
    if (y + size.h > sBottom) y = Math.max(sy, safe.y) + PANEL_GAP;
  }
  y = Math.max(safe.y, Math.min(y, sBottom - size.h));
  return { x: Math.round(x), y: Math.round(y), visible };
}
