import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { CanvasDoc } from './doc';
import { restoreCanvasState } from './restore';

const live = (): CanvasDoc => {
  const d = new CanvasDoc(new Y.Doc(), { rng: () => 0.5 });
  d.ensureSchema();
  return d;
};
const stateOf = (build: (d: CanvasDoc) => void): Uint8Array => {
  const d = live();
  build(d);
  return Y.encodeStateAsUpdate(d.ydoc);
};
const texts = (d: CanvasDoc): string[] => d.orderedIds().map((id) => d.getText(id));

describe('restoreCanvasState', () => {
  it('replaces the objects with the version in ONE local transaction (one undo step takes it back)', () => {
    const version = stateOf((d) => {
      d.create({ kind: 'sticky', x: 0, y: 0, text: 'old A' });
      d.create({ kind: 'text', x: 0, y: 50, text: 'old B' });
    });
    const d = live();
    d.create({ kind: 'sticky', x: 5, y: 5, text: 'now' });
    d.checkpoint();
    let tx = 0;
    d.ydoc.on('afterTransaction', () => tx++);
    expect(restoreCanvasState(d, version)).toBe(true);
    expect(tx).toBe(1);
    expect(texts(d).sort()).toEqual(['old A', 'old B']);
    expect(d.meta.get('schema')).toBe(1);
    d.undo.undo();
    expect(texts(d)).toEqual(['now']);
  });

  it('keeps an unchanged object untouched, so a concurrent edit of it survives; writes the changed one', () => {
    const base = live();
    const same = base.create({ kind: 'sticky', x: 0, y: 0, text: 'same' }) as string;
    const changed = base.create({ kind: 'sticky', x: 0, y: 200, text: 'before' }) as string;
    const version = Y.encodeStateAsUpdate(base.ydoc);
    base.setText(changed, 'after');
    base.patch(same, { x: 7 });
    // The live x differs from the version → the object is written back; the changed text goes back too.
    expect(restoreCanvasState(base, version)).toBe(true);
    expect(base.getText(changed)).toBe('before');
    expect(base.snapshot(same)).toMatchObject({ x: 0 });
    // A second restore of the same state changes nothing (no transaction content, objects equal).
    const before = Y.encodeStateVector(base.ydoc);
    expect(restoreCanvasState(base, version)).toBe(true);
    expect(Y.encodeStateVector(base.ydoc)).toEqual(before);
  });

  it('copies Y.Text fields as text, not as shared types of the scratch doc', () => {
    const version = stateOf((d) => void d.create({ kind: 'shape', x: 0, y: 0, text: 'shape text' }));
    const d = live();
    expect(restoreCanvasState(d, version)).toBe(true);
    const id = d.orderedIds()[0] as string;
    d.setText(id, 'edited later');
    expect(d.getText(id)).toBe('edited later');
  });

  it('refuses garbage and leaves the document alone', () => {
    const d = live();
    d.create({ kind: 'sticky', x: 0, y: 0, text: 'keep' });
    expect(restoreCanvasState(d, Uint8Array.of(1, 2, 3, 4, 5))).toBe(false);
    expect(texts(d)).toEqual(['keep']);
  });

  describe('rich text', () => {
    const deltaOf = (d: CanvasDoc, id: string): unknown => (d.objects.get(id)?.get('text') as Y.Text).toDelta();
    const richDelta = [
      { insert: 'brave ', attributes: { bold: true } },
      { insert: 'new', attributes: { italic: true, strike: true } },
      { insert: ' world' },
      { insert: '\n', attributes: { list: 'bullet' } },
      { insert: 'second item' },
      { insert: '\n', attributes: { list: 'bullet' } },
    ];
    const withRich = (): { version: Uint8Array; d: CanvasDoc; id: string } => {
      const d = live();
      const id = d.create({ kind: 'sticky', x: 0, y: 0, text: '' }) as string;
      (d.objects.get(id)?.get('text') as Y.Text).applyDelta(richDelta);
      return { version: Y.encodeStateAsUpdate(d.ydoc), d, id };
    };

    it('brings back bold, italic, strike and lists with the exact delta (no extra empty line)', () => {
      const { version, d, id } = withRich();
      const want = deltaOf(d, id);
      d.setText(id, 'plain rewrite');
      expect(restoreCanvasState(d, version)).toBe(true);
      expect(deltaOf(d, id)).toEqual(want);
      expect(deltaOf(d, id)).toEqual(richDelta);
    });

    it('rolls back a style-only change made after the version', () => {
      const { version, d, id } = withRich();
      const yt = d.objects.get(id)?.get('text') as Y.Text;
      yt.format(0, 5, { bold: null });
      yt.format(0, 5, { italic: true });
      expect(deltaOf(d, id)).not.toEqual(richDelta);
      expect(restoreCanvasState(d, version)).toBe(true);
      expect(deltaOf(d, id)).toEqual(richDelta);
    });

    it('restoring unchanged rich text writes nothing', () => {
      const { version, d } = withRich();
      const before = Y.encodeStateAsUpdate(d.ydoc);
      let updates = 0;
      d.ydoc.on('update', () => updates++);
      expect(restoreCanvasState(d, version)).toBe(true);
      expect(updates).toBe(0);
      expect(Y.encodeStateAsUpdate(d.ydoc)).toEqual(before);
    });
  });
});
