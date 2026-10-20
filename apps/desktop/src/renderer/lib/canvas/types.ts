import type { Rect } from './geometry';

/** Document schema this build reads and writes (ADR-0113 §3). Newer docs open read-only. */
export const SCHEMA_VERSION = 1;
export const MAX_OBJECTS = 5000;
export const MAX_TEXT = 5000;
export const MAX_COORD = 1e7;
export const MAX_SIZE = 1e5;

export type ObjectKind = 'sticky' | 'text' | 'shape' | 'connector';
export type ShapeKind = 'rect' | 'ellipse' | 'diamond' | 'triangle' | 'rounded';
export const SHAPE_KINDS: readonly ShapeKind[] = ['rect', 'ellipse', 'diamond', 'triangle', 'rounded'];
export type Side = 'auto' | 'top' | 'right' | 'bottom' | 'left';
export type Arrow = 'none' | 'end' | 'both';
export type RouteKind = 'straight' | 'elbow';

/** Connector end: glued to a side of an object, or free in the world. */
export type Endpoint = { id: string; side: Side } | { x: number; y: number };

export const isBound = (e: Endpoint): e is { id: string; side: Side } => 'id' in e;

/** Colors are palette token names (or a #hex literal); the palette decides how they look per theme. */
export interface BaseRec {
  readonly id: string;
  readonly z: string;
  /** Bounds in world units (connectors: bounds of the routed path). */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface StickyRec extends BaseRec {
  readonly kind: 'sticky';
  readonly color: string;
  readonly text: string;
}

export interface TextRec extends BaseRec {
  readonly kind: 'text';
  readonly size: number;
  readonly color: string;
  readonly text: string;
}

export interface ShapeRec extends BaseRec {
  readonly kind: 'shape';
  readonly shape: ShapeKind;
  readonly fill: string;
  readonly stroke: string;
  readonly strokeWidth: number;
  readonly text: string;
}

export interface ConnectorRec extends BaseRec {
  readonly kind: 'connector';
  readonly from: Endpoint;
  readonly to: Endpoint;
  readonly arrow: Arrow;
  readonly route: RouteKind;
  readonly stroke: string;
  readonly strokeWidth: number;
  readonly label: string;
  /** Routed path, flat [x0, y0, x1, y1, …]. */
  readonly points: readonly number[];
}

export type ObjectRec = StickyRec | TextRec | ShapeRec | ConnectorRec;
export type BoxRec = StickyRec | TextRec | ShapeRec;

export const isConnector = (o: ObjectRec): o is ConnectorRec => o.kind === 'connector';
export const isBox = (o: ObjectRec): o is BoxRec => o.kind !== 'connector';

export const recBounds = (o: BaseRec): Rect => ({ x: o.x, y: o.y, w: o.w, h: o.h });

/** Defaults and limits shared by the model and the tools. */
export const DEFAULTS = {
  stickySize: 160,
  shapeW: 160,
  shapeH: 100,
  textW: 240,
  textSize: 20,
  minBox: 24,
  minTextW: 40,
  minTextSize: 8,
  maxTextSize: 200,
  strokeWidth: 2,
  stickyColor: 'yellow',
  textColor: 'text',
  shapeFill: 'none',
  shapeStroke: 'stroke',
  connectorStroke: 'stroke',
} as const;

/** Fields a creation call may set (kind-specific; unknown ones are ignored). */
export type ObjectInit =
  | { kind: 'sticky'; x: number; y: number; w?: number; h?: number; color?: string; text?: string }
  | { kind: 'text'; x: number; y: number; w?: number; size?: number; color?: string; text?: string }
  | { kind: 'shape'; shape?: ShapeKind; x: number; y: number; w?: number; h?: number; fill?: string; stroke?: string; strokeWidth?: number; text?: string }
  | { kind: 'connector'; from: Endpoint; to: Endpoint; arrow?: Arrow; route?: RouteKind; stroke?: string; strokeWidth?: number; label?: string };

/** Patch of plain (non-text) fields; applied only to the keys valid for the object's kind. */
export interface ObjectPatch {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  color?: string;
  size?: number;
  shape?: ShapeKind;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  from?: Endpoint;
  to?: Endpoint;
  arrow?: Arrow;
  route?: RouteKind;
  label?: string;
}
