/** Static tables of the Canvas screen: tools, hotkeys, swatches (ADR-0114 §5). No React. */
import type { Arrow, RouteKind, ShapeKind } from '../../../lib/canvas/types';
import { HUE_IDS, INK_EXTRA_IDS, STICKY_IDS, type Tool } from '../engine';

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
  { tool: 'comment', key: '⌥C', label: 'canvasBoard.tool.comment' },
];

export const SHAPE_DEFS: readonly { kind: ShapeKind; label: `canvasBoard.shape.${ShapeKind}` }[] = [
  { kind: 'rect', label: 'canvasBoard.shape.rect' },
  { kind: 'rounded', label: 'canvasBoard.shape.rounded' },
  { kind: 'ellipse', label: 'canvasBoard.shape.ellipse' },
  { kind: 'diamond', label: 'canvasBoard.shape.diamond' },
  { kind: 'triangle', label: 'canvasBoard.shape.triangle' },
  { kind: 'star', label: 'canvasBoard.shape.star' },
  { kind: 'hexagon', label: 'canvasBoard.shape.hexagon' },
  { kind: 'parallelogram', label: 'canvasBoard.shape.parallelogram' },
  { kind: 'arrow', label: 'canvasBoard.shape.arrow' },
  { kind: 'bubble', label: 'canvasBoard.shape.bubble' },
  { kind: 'cylinder', label: 'canvasBoard.shape.cylinder' },
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
export const STICKY_COLORS: readonly string[] = STICKY_IDS;
/** Text / outline colors: the ink first, then the hues (no 'white': it would vanish on a light canvas). */
export const INK_COLORS: readonly string[] = ['text', ...HUE_IDS, ...INK_EXTRA_IDS];
export const STROKE_COLORS: readonly string[] = ['stroke', ...HUE_IDS, ...INK_EXTRA_IDS];
export const FILL_COLORS: readonly string[] = ['none', 'white', ...HUE_IDS];

/** Text sizes (px) offered by the size field's list; any whole number in `DEFAULTS.minTextSize`..`maxTextSize` can be typed. */
export const FONT_PRESETS: readonly number[] = [12, 14, 18, 24, 36, 48, 64, 96];

export const STROKE_WIDTHS: readonly { width: number; label: `canvasBoard.width.${'thin' | 'medium' | 'thick'}` }[] = [
  { width: 1, label: 'canvasBoard.width.thin' },
  { width: 2, label: 'canvasBoard.width.medium' },
  { width: 4, label: 'canvasBoard.width.thick' },
];
