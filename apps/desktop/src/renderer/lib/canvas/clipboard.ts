import { CanvasDoc, clampText, color, endpoint, isShapeKind, newId, num, type PlainObject } from './doc';
import type { Scene } from './scene';
import { MAX_OBJECTS, type Endpoint, type ObjectInit } from './types';

/** Text-clipboard format: prefix + JSON (ADR-0113 §4). */
export const CLIPBOARD_PREFIX = 'calaba-canvas:';
const VERSION = 1;

export interface ClipboardPayload {
  v: number;
  objects: PlainObject[];
}

/**
 * Serializes objects bottom → top. Connectors whose glued target is not part of the copy keep their end
 * where it is (free point), so a pasted connector never points into the old document's objects.
 */
export function serialize(scene: Scene, doc: CanvasDoc, ids: Iterable<string>): string | null {
  const want = new Set(ids);
  const objects: PlainObject[] = [];
  for (const id of scene.orderedIds()) {
    if (!want.has(id)) continue;
    const plain = doc.snapshot(id);
    if (!plain) continue;
    if (plain.kind === 'connector') {
      for (const end of ['from', 'to'] as const) {
        const e = endpoint(plain[end]);
        if (e && 'id' in e && !want.has(e.id)) plain[end] = scene.pointOf(id, end) ?? { x: 0, y: 0 };
      }
    }
    objects.push(plain);
  }
  if (objects.length === 0) return null;
  const payload: ClipboardPayload = { v: VERSION, objects };
  return CLIPBOARD_PREFIX + JSON.stringify(payload);
}

/** Parses clipboard text; null if it is not ours or is malformed. Does not touch the document. */
export function parse(text: string): ClipboardPayload | null {
  if (!text.startsWith(CLIPBOARD_PREFIX)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(CLIPBOARD_PREFIX.length));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const p = raw as { v?: unknown; objects?: unknown };
  if (p.v !== VERSION || !Array.isArray(p.objects) || p.objects.length === 0 || p.objects.length > MAX_OBJECTS) return null;
  const objects: PlainObject[] = [];
  for (const o of p.objects as unknown[]) {
    if (typeof o !== 'object' || o === null) continue;
    const r = o as Record<string, unknown>;
    if (typeof r.id !== 'string' || (r.kind !== 'sticky' && r.kind !== 'text' && r.kind !== 'shape' && r.kind !== 'connector')) continue;
    objects.push({ ...r, id: r.id, kind: r.kind, z: typeof r.z === 'string' ? r.z : '' });
  }
  return objects.length > 0 ? { v: VERSION, objects } : null;
}

/**
 * Turns clipboard objects into creation inits at `dx, dy` with fresh ids. Connector ends glued to a copied
 * object follow its new id; others become free points.
 */
export function toInits(payload: ClipboardPayload, dx: number, dy: number, makeId: () => string = newId): { id: string; init: ObjectInit }[] {
  const ids = new Map<string, string>();
  for (const o of payload.objects) ids.set(o.id, makeId());
  const shift = (e: Endpoint | null): Endpoint => {
    if (!e) return { x: dx, y: dy };
    if ('id' in e) {
      const nid = ids.get(e.id);
      return nid ? { id: nid, side: e.side } : { x: dx, y: dy };
    }
    return { x: e.x + dx, y: e.y + dy };
  };
  const out: { id: string; init: ObjectInit }[] = [];
  for (const o of payload.objects) {
    const id = ids.get(o.id);
    if (!id) continue;
    const text = typeof o.text === 'string' ? clampText(o.text) : '';
    const x = num(o.x, 0) + dx;
    const y = num(o.y, 0) + dy;
    switch (o.kind) {
      case 'sticky':
        out.push({ id, init: { kind: 'sticky', x, y, w: num(o.w, 160), h: num(o.h, 160), color: color(o.color, 'yellow'), text } });
        break;
      case 'text':
        out.push({ id, init: { kind: 'text', x, y, w: num(o.w, 240), size: num(o.size, 20), color: color(o.color, 'text'), text } });
        break;
      case 'shape':
        out.push({
          id,
          init: {
            kind: 'shape', shape: isShapeKind(o.shape) ? o.shape : 'rect', x, y, w: num(o.w, 160), h: num(o.h, 100),
            fill: color(o.fill, 'none'), stroke: color(o.stroke, 'stroke'), strokeWidth: num(o.strokeWidth, 2, 0, 24), text,
          },
        });
        break;
      case 'connector':
        out.push({
          id,
          init: {
            kind: 'connector', from: shift(endpoint(o.from)), to: shift(endpoint(o.to)),
            arrow: o.arrow === 'none' || o.arrow === 'both' ? o.arrow : 'end', route: o.route === 'elbow' ? 'elbow' : 'straight',
            stroke: color(o.stroke, 'stroke'), strokeWidth: num(o.strokeWidth, 2, 0, 24), label: typeof o.label === 'string' ? clampText(o.label) : '',
          },
        });
        break;
    }
  }
  return out;
}

/** Duplicates objects in the doc at an offset; connectors between duplicated objects stay glued to the copies. */
export function duplicate(scene: Scene, doc: CanvasDoc, ids: Iterable<string>, dx: number, dy: number): string[] {
  const text = serialize(scene, doc, ids);
  const payload = text ? parse(text) : null;
  if (!payload) return [];
  return doc.createMany(toInits(payload, dx, dy));
}
