import * as Y from 'yjs';
import { isValidKey } from './fracIndex';

/** Plain text of a canvas, as the server stores it for search: ≤ 100k characters (the server clips at 256 KiB). */
export const MAX_PLAIN_TEXT = 100_000;

/**
 * The texts of all objects (sticky/text/shape `text`, connector `label`), one per line, bottom → top
 * (z, then id) so the same document always yields the same string. Reads the Y.Doc directly: it never
 * creates the `objects` type and builds no CanvasDoc (no UndoManager) for a snapshot meta.
 */
export function canvasPlainText(doc: Y.Doc): string {
  if (!doc.share.has('objects')) return '';
  const rows: [string, string, string][] = [];
  for (const [id, m] of doc.getMap<Y.Map<unknown>>('objects')) {
    if (!(m instanceof Y.Map)) continue;
    const t = m.get('text');
    const text = t instanceof Y.Text ? t.toJSON() : typeof m.get('label') === 'string' ? (m.get('label') as string) : '';
    const trimmed = text.trim();
    if (!trimmed) continue;
    const z = m.get('z');
    rows.push([isValidKey(z) ? z : '', id, trimmed]);
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  let out = '';
  for (const r of rows) {
    out += out ? `\n${r[2]}` : r[2];
    if (out.length >= MAX_PLAIN_TEXT) return out.slice(0, MAX_PLAIN_TEXT);
  }
  return out;
}
