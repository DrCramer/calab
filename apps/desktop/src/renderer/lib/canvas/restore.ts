import * as Y from 'yjs';
import type { CanvasDoc } from './doc';
import { MAX_OBJECTS } from './types';

/** A Y.Map field copied for another document: a Y.Text becomes a new Y.Text with the same formatting, JSON values are copied by value. */
function cloneField(v: unknown): unknown {
  if (v instanceof Y.Text) {
    const t = new Y.Text();
    t.applyDelta(v.toDelta() as never);
    return t;
  }
  return typeof v === 'object' && v !== null ? JSON.parse(JSON.stringify(v)) : v;
}

function cloneObject(src: Y.Map<unknown>): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  for (const [k, v] of src) m.set(k, cloneField(v));
  return m;
}

/** JSON with sorted keys; a Y.Text is its delta, so attribute (bold, list…) changes count as changes. */
function canon(v: unknown): string {
  if (v instanceof Y.Text) return `T${canon(v.toDelta())}`;
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

const sameObject = (a: Y.Map<unknown>, b: Y.Map<unknown>): boolean => canon(Object.fromEntries(a)) === canon(Object.fromEntries(b));

/**
 * «Восстановить» a version (ADR-0114 §3): the live document's objects become the version's, in ONE
 * local transaction — objects the version lacks are deleted, new and changed ones are written (an
 * unchanged object is left alone, so a co-author's concurrent edit of it is not rewritten), `meta`
 * stays. The state is read through a scratch Y.Doc; the live one never applies it as an update (that
 * would merge, not replace). The transaction carries LOCAL_ORIGIN, so my undo can take the restore
 * back and the sync provider sends it like any edit. Returns false (nothing changed) when the state
 * is not a canvas document or holds more objects than the limit.
 */
export function restoreCanvasState(doc: CanvasDoc, state: Uint8Array): boolean {
  const scratch = new Y.Doc();
  try {
    Y.applyUpdate(scratch, state);
    const src = scratch.getMap<Y.Map<unknown>>('objects');
    if (src.size > MAX_OBJECTS) return false;
    doc.checkpoint();
    doc.transact(() => {
      for (const id of [...doc.objects.keys()]) if (!src.has(id)) doc.objects.delete(id);
      for (const [id, obj] of src) {
        if (!(obj instanceof Y.Map)) continue;
        const cur = doc.objects.get(id);
        if (cur && sameObject(cur, obj)) continue;
        doc.objects.set(id, cloneObject(obj));
      }
    });
    doc.checkpoint();
    return true;
  } catch {
    return false;
  } finally {
    scratch.destroy();
  }
}
