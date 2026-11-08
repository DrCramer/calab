/**
 * Frames (ADR-0127 addendum 2026-10-30): titled boards behind other objects. The record is a plain box (`FrameRec`);
 * what it holds is computed from geometry (`Scene.frameMembers`), so nothing has to be kept in sync when an object is
 * dragged in or out. Pure helpers shared by the scene (hit tests), the drawing and the tool.
 */
import type { Rect } from './geometry';
import type { FrameRec } from './types';

/** Title text size, world units: the title is part of the board and zooms with it. */
export const FRAME_TITLE_SIZE = 18;
/** Gap between the title's baseline band and the frame's top edge. */
export const FRAME_TITLE_GAP = 6;
/** The band above the frame the title lives in (and is picked by). */
export const FRAME_TITLE_H = Math.ceil(FRAME_TITLE_SIZE * 1.3) + FRAME_TITLE_GAP;
/** Corner radius of the board. */
export const FRAME_RADIUS = 8;

export type FramePreset = '16:9' | 'a4' | '1:1' | 'custom';

/** Sizes the «Фрейм» tool offers; `custom` is drawn by dragging (a click then places the 16:9 one). */
export const FRAME_PRESETS: readonly { id: FramePreset; w: number; h: number }[] = [
  { id: '16:9', w: 960, h: 540 },
  // Portrait, 210 × 297.
  { id: 'a4', w: 620, h: 877 },
  { id: '1:1', w: 720, h: 720 },
  { id: 'custom', w: 960, h: 540 },
];

export function framePresetSize(id: FramePreset): { w: number; h: number } {
  const p = FRAME_PRESETS.find((f) => f.id === id) ?? FRAME_PRESETS[0];
  return { w: p?.w ?? 960, h: p?.h ?? 540 };
}

/** Where the title sits: above the top-left corner, as wide as its text (`textW`, world units) but never wider than the frame. */
export function frameTitleRect(f: Pick<FrameRec, 'x' | 'y' | 'w'>, textW: number): Rect {
  return { x: f.x, y: f.y - FRAME_TITLE_H, w: Math.max(0, Math.min(f.w, textW + 2)), h: FRAME_TITLE_H - FRAME_TITLE_GAP / 2 };
}
