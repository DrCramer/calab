/** Static tables of the Canvas screen: tools, hotkeys, swatches (ADR-0126 §5). No React. */
import { SOFT_PREFIX, type Arrow, type RouteKind, type ShapeKind } from '../../../lib/canvas/types';
import { HUE_IDS, INK_EXTRA_IDS, STICKY_IDS, type Tool } from '../engine';

export interface ToolDef {
  tool: Tool;
  /** The engine's hotkey (engine/input.ts), shown in the tooltip. */
  key: string;
  /** The hotkey needs Alt/⌥, rendered with the platform label. */
  alt?: boolean;
  label: `canvasBoard.tool.${Tool}`;
}

export const TOOL_DEFS: readonly ToolDef[] = [
  { tool: 'select', key: 'V', label: 'canvasBoard.tool.select' },
  { tool: 'sticky', key: 'S', label: 'canvasBoard.tool.sticky' },
  { tool: 'text', key: 'T', label: 'canvasBoard.tool.text' },
  { tool: 'shape', key: 'R', label: 'canvasBoard.tool.shape' },
  { tool: 'connector', key: 'C', label: 'canvasBoard.tool.connector' },
  { tool: 'frame', key: 'F', label: 'canvasBoard.tool.frame' },
  { tool: 'pen', key: 'P', label: 'canvasBoard.tool.pen' },
  { tool: 'eraser', key: 'E', label: 'canvasBoard.tool.eraser' },
  { tool: 'comment', key: 'C', alt: true, label: 'canvasBoard.tool.comment' },
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
  { route: 'curve', label: 'canvasBoard.route.curve' },
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
/** The hues' soft tones (`soft:<hue>`, stored as `fill` + `soft`): calm columns and areas under stickies. */
export const SOFT_FILL_COLORS: readonly string[] = HUE_IDS.map((h) => `${SOFT_PREFIX}${h}`);
/** The fill picker: the plain fills, then the soft row. */
export const FILL_PICKER: readonly string[] = [...FILL_COLORS, ...SOFT_FILL_COLORS];
/** A frame's board: none, white or a hue, each drawn as its soft tone (so the frame stays a background). */
export const FRAME_FILLS: readonly string[] = FILL_COLORS;

/** Text sizes (px) offered by the size field's list; any whole number in `DEFAULTS.minTextSize`..`maxTextSize` can be typed. */
export const FONT_PRESETS: readonly number[] = [12, 14, 18, 24, 36, 48, 64, 96];

/** The pen tool's colors: the ink and a few clear hues (the full list is in the properties of a drawn line). */
export const PEN_COLORS: readonly string[] = ['stroke', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'];

export const STROKE_WIDTHS: readonly { width: number; label: `canvasBoard.width.${'thin' | 'medium' | 'thick'}` }[] = [
  { width: 1, label: 'canvasBoard.width.thin' },
  { width: 2, label: 'canvasBoard.width.medium' },
  { width: 4, label: 'canvasBoard.width.thick' },
];
