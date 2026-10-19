/** Static tables of the Canvas screen: tools, hotkeys, swatches (ADR-0107 §5). No React. */
import type { Arrow, RouteKind, ShapeKind } from '../../../lib/canvas/types';
import type { Tool } from '../engine';

export interface ToolDef {
  tool: Tool;
  /** The engine's hotkey (engine/input.ts), shown in the tooltip. */
  key: string;
  label: `canvasBoard.tool.${Tool}`;
}

export const TOOL_DEFS: readonly ToolDef[] = [
  { tool: 'select', key: 'V', label: 'canvasBoard.tool.select' },
  { tool: 'sticky', key: 'S', label: 'canvasBoard.tool.sticky' },
  { tool: 'text', key: 'T', label: 'canvasBoard.tool.text' },
  { tool: 'shape', key: 'R', label: 'canvasBoard.tool.shape' },
  { tool: 'connector', key: 'C', label: 'canvasBoard.tool.connector' },
];

export const SHAPE_DEFS: readonly { kind: ShapeKind; label: `canvasBoard.shape.${ShapeKind}` }[] = [
  { kind: 'rect', label: 'canvasBoard.shape.rect' },
  { kind: 'rounded', label: 'canvasBoard.shape.rounded' },
  { kind: 'ellipse', label: 'canvasBoard.shape.ellipse' },
  { kind: 'diamond', label: 'canvasBoard.shape.diamond' },
  { kind: 'triangle', label: 'canvasBoard.shape.triangle' },
];

export const ROUTE_DEFS: readonly { route: RouteKind; label: `canvasBoard.route.${RouteKind}` }[] = [
  { route: 'straight', label: 'canvasBoard.route.straight' },
  { route: 'elbow', label: 'canvasBoard.route.elbow' },
];

export const ARROW_DEFS: readonly { arrow: Arrow; label: `canvasBoard.arrow.${Arrow}` }[] = [
  { arrow: 'none', label: 'canvasBoard.arrow.none' },
  { arrow: 'end', label: 'canvasBoard.arrow.end' },
  { arrow: 'both', label: 'canvasBoard.arrow.both' },
];

/** Palette token names (engine/palette.ts); the stored value is the token, the theme decides the look. */
export const STICKY_COLORS: readonly string[] = ['yellow', 'green', 'blue', 'pink', 'orange', 'purple', 'gray'];
export const INK_COLORS: readonly string[] = ['text', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'];
export const STROKE_COLORS: readonly string[] = ['stroke', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'];
export const FILL_COLORS: readonly string[] = ['none', 'white', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'];

export const TEXT_SIZES: readonly { size: number; label: `canvasBoard.size.${'s' | 'm' | 'l' | 'xl'}`; glyph: string }[] = [
  { size: 14, label: 'canvasBoard.size.s', glyph: 'S' },
  { size: 20, label: 'canvasBoard.size.m', glyph: 'M' },
  { size: 32, label: 'canvasBoard.size.l', glyph: 'L' },
  { size: 48, label: 'canvasBoard.size.xl', glyph: 'XL' },
];

export const STROKE_WIDTHS: readonly { width: number; label: `canvasBoard.width.${'thin' | 'medium' | 'thick'}` }[] = [
  { width: 1, label: 'canvasBoard.width.thin' },
  { width: 2, label: 'canvasBoard.width.medium' },
  { width: 4, label: 'canvasBoard.width.thick' },
];

/** The text size button that covers `size` (the nearest preset). */
export function nearestTextSize(size: number): number {
  let best = TEXT_SIZES[0]?.size ?? 20;
  for (const s of TEXT_SIZES) if (Math.abs(s.size - size) < Math.abs(best - size)) best = s.size;
  return best;
}
