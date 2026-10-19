/** Where the floating properties panel sits relative to the selection (screen space). Pure. */
import type { Camera } from '../../../lib/canvas/camera';
import type { Rect } from '../../../lib/canvas/geometry';

export interface PanelPlacement {
  x: number;
  y: number;
  /** False when the selection is entirely outside the viewport (the panel hides). */
  visible: boolean;
}

export const PANEL_GAP = 12;
export const PANEL_MARGIN = 8;

/**
 * The panel centers above the selection, flips below when there is no room above, and stays inside the
 * viewport. `bounds` is in world units; `size` is the panel's own size in px.
 */
export function placePanel(bounds: Rect, cam: Camera, viewport: { w: number; h: number }, size: { w: number; h: number }): PanelPlacement {
  const sx = cam.tx + bounds.x * cam.scale;
  const sy = cam.ty + bounds.y * cam.scale;
  const sw = bounds.w * cam.scale;
  const sh = bounds.h * cam.scale;
  const visible = sx < viewport.w && sy < viewport.h && sx + sw > 0 && sy + sh > 0;
  let x = sx + sw / 2 - size.w / 2;
  x = Math.max(PANEL_MARGIN, Math.min(x, viewport.w - size.w - PANEL_MARGIN));
  let y = sy - size.h - PANEL_GAP;
  if (y < PANEL_MARGIN) y = sy + sh + PANEL_GAP;
  y = Math.max(PANEL_MARGIN, Math.min(y, viewport.h - size.h - PANEL_MARGIN));
  return { x: Math.round(x), y: Math.round(y), visible };
}
