import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { CanvasDoc, LOCAL_ORIGIN, applyTextDiff, clampText, color, endpoint } from './doc';
import { REMOTE, makeDoc, pair } from './testing';
import { MAX_OBJECTS, MAX_TEXT } from './types';

describe('creation', () => {
  it('stores flat fields, a fractional z and Y.Text for text', () => {
    const d = makeDoc();
    const id = d.create({ kind: 'sticky', x: 10, y: 20, text: 'hi', color: 'pink' });
    expect(id).toBe('o1');
    const m = d.objects.get('o1');
    expect(m?.get('kind')).toBe('sticky');
    expect(m?.get('x')).toBe(10);
    expect(m?.get('w')).toBe(160);
    expect(m?.get('color')).toBe('pink');
    expect(m?.get('text')).toBeInstanceOf(Y.Text);
    expect(typeof m?.get('z')).toBe('string');
    expect(d.getText('o1')).toBe('hi');
  });
  it('creates every kind with defaults', () => {
    const d = makeDoc();
    d.createMany([
      { init: { kind: 'text', x: 0, y: 0 } },
      { init: { kind: 'shape', x: 0, y: 0, shape: 'diamond' } },
      { init: { kind: 'connector', from: { id: 'o1', side: 'auto' }, to: { x: 5, y: 5 } } },
    ]);
    expect(d.snapshot('o1')).toMatchObject({ kind: 'text', w: 240, size: 20, color: 'text', text: '' });
    expect(d.snapshot('o2')).toMatchObject({ kind: 'shape', shape: 'diamond', fill: 'none', stroke: 'stroke', strokeWidth: 2 });
    expect(d.snapshot('o3')).toMatchObject({ kind: 'connector', arrow: 'end', route: 'straight', from: { id: 'o1', side: 'auto' }, to: { x: 5, y: 5 } });
  });
  it('stacks new objects on top, in order', () => {
    const d = makeDoc();
    d.createMany([1, 2, 3].map((i) => ({ init: { kind: 'sticky' as const, x: i, y: 0 } })));
    expect(d.orderedIds()).toEqual(['o1', 'o2', 'o3']);
    d.create({ kind: 'sticky', x: 0, y: 0 });
    expect(d.orderedIds().at(-1)).toBe('o4');
  });
  it('sanitizes hostile or sloppy input', () => {
    const d = makeDoc();
    d.create({ kind: 'sticky', x: NaN, y: 1e12, w: -5, h: Infinity, color: '<script>' });
    const s = d.snapshot('o1');
    expect(s?.x).toBe(0);
    expect(s?.y).toBe(1e7);
    expect(s?.w).toBe(24);
    expect(s?.h).toBe(160);
    expect(s?.color).toBe('yellow');
    expect(color('#FFaa00', 'x')).toBe('#FFaa00');
    expect(color('red', 'x')).toBe('red');
    expect(color('url(x)', 'x')).toBe('x');
    expect(endpoint({ id: '', side: 'top' })).toBeNull();
    expect(endpoint({ id: 'a', side: 'weird' })).toEqual({ id: 'a', side: 'auto' });
    expect(endpoint({ x: 1, y: 2, extra: 1 })).toEqual({ x: 1, y: 2 });
  });
});

describe('limits (ADR-0107 §3)', () => {
  it('refuses to create past 5000 objects', () => {
    const y = new Y.Doc();
    const d = new CanvasDoc(y, { rng: null });
    y.transact(() => {
      for (let i = 0; i < MAX_OBJECTS; i++) {
        const m = new Y.Map<unknown>();
        d.objects.set(`s${i}`, m);
        m.set('kind', 'sticky');
        m.set('z', 'a00');
      }
    });
    expect(d.count).toBe(MAX_OBJECTS);
    expect(d.canCreate).toBe(false);
    expect(d.create({ kind: 'sticky', x: 0, y: 0 })).toBeNull();
    expect(d.count).toBe(MAX_OBJECTS);
  });
  it('batch creation is all-or-nothing', () => {
    const y = new Y.Doc();
    const d = new CanvasDoc(y, { rng: null });
    y.transact(() => {
      for (let i = 0; i < MAX_OBJECTS - 2; i++) d.objects.set(`s${i}`, new Y.Map<unknown>());
    });
    const three = [1, 2, 3].map(() => ({ init: { kind: 'sticky' as const, x: 0, y: 0 } }));
    expect(d.createMany(three)).toEqual([]);
    expect(d.count).toBe(MAX_OBJECTS - 2);
    expect(d.createMany(three.slice(0, 2))).toHaveLength(2);
    expect(d.count).toBe(MAX_OBJECTS);
  });
  it('writes a big batch as several updates that each fit a sync frame, as one undo step', () => {
    const y = new Y.Doc();
    const d = new CanvasDoc(y, { rng: null });
    const sizes: number[] = [];
    y.on('update', (u: Uint8Array) => sizes.push(u.length));
    const items = Array.from({ length: 800 }, (_, i) => ({ init: { kind: 'sticky' as const, x: i, y: 0, text: `pasted note number ${i} with some words` } }));
    const ids = d.createMany(items);
    expect(ids).toHaveLength(800);
    expect(d.count).toBe(800);
    expect(sizes.length).toBeGreaterThan(3); // one transaction would be ≈ 200 KB: above the 64 KiB frame
    expect(Math.max(...sizes)).toBeLessThan(60_000);
    const zs = ids.map((id) => d.snapshot(id)?.z as string);
    expect([...zs].sort()).toEqual(zs); // still bottom → top in order
    d.undo.undo();
    expect(d.count).toBe(0);
  });
  it('clamps text to 5000 characters on creation and on edit', () => {
    const d = makeDoc();
    const id = d.create({ kind: 'sticky', x: 0, y: 0, text: 'x'.repeat(9000) });
    expect(d.getText(id ?? '')).toHaveLength(MAX_TEXT);
    d.setText(id ?? '', 'y'.repeat(7000));
    expect(d.getText(id ?? '')).toHaveLength(MAX_TEXT);
    expect(clampText('a'.repeat(MAX_TEXT - 1) + '😀')).toHaveLength(MAX_TEXT - 1);
  });
  it('clamps a connector label too', () => {
    const d = makeDoc();
    const id = d.create({ kind: 'connector', from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, label: 'l'.repeat(6000) }) ?? '';
    expect(d.getText(id)).toHaveLength(MAX_TEXT);
  });
});

describe('patching', () => {
  it('applies only fields valid for the kind and clamps values', () => {
    const d = makeDoc();
    d.create({ kind: 'sticky', x: 0, y: 0 });
    d.patch('o1', { x: 50, w: 1, size: 99, fill: 'red', color: 'blue', arrow: 'both' });
    expect(d.snapshot('o1')).toMatchObject({ x: 50, w: 24, color: 'blue' });
    expect(d.snapshot('o1')).not.toHaveProperty('size');
    expect(d.snapshot('o1')).not.toHaveProperty('fill');
    expect(d.snapshot('o1')).not.toHaveProperty('arrow');
  });
  it('ignores invalid values and unknown ids', () => {
    const d = makeDoc();
    d.create({ kind: 'shape', x: 0, y: 0 });
    d.patch('o1', { x: NaN, shape: 'blob' as never, strokeWidth: 999 });
    d.patch('nope', { x: 1 });
    expect(d.snapshot('o1')).toMatchObject({ x: 0, shape: 'rect', strokeWidth: 24 });
  });
  it('does not write unchanged values (no empty updates)', () => {
    const d = makeDoc();
    d.create({ kind: 'sticky', x: 0, y: 0 });
    let updates = 0;
    d.ydoc.on('update', () => updates++);
    d.patch('o1', { x: 0, y: 0 });
    d.patch('o1', { from: { x: 1, y: 1 } });
    expect(updates).toBe(0);
    d.patch('o1', { x: 1 });
    expect(updates).toBe(1);
  });
  it('patchMany is one transaction', () => {
    const d = makeDoc();
    d.createMany([{ init: { kind: 'sticky', x: 0, y: 0 } }, { init: { kind: 'sticky', x: 0, y: 0 } }]);
    let updates = 0;
    d.ydoc.on('update', () => updates++);
    d.patchMany(new Map([['o1', { x: 10 }], ['o2', { x: 20 }]]));
    expect(updates).toBe(1);
  });
});

describe('text', () => {
  it('writes the smallest diff into the Y.Text', () => {
    const y = new Y.Doc();
    const t = y.getText('t');
    t.insert(0, 'hello world');
    const deltas: unknown[] = [];
    t.observe((e) => deltas.push(e.changes.delta));
    applyTextDiff(t, 'hello brave world');
    expect(t.toJSON()).toBe('hello brave world');
    expect(deltas[0]).toEqual([{ retain: 6 }, { insert: 'brave ' }]);
    applyTextDiff(t, 'hello world');
    expect(t.toJSON()).toBe('hello world');
  });
  it('merges concurrent edits from two clients', () => {
    const { a, b, net } = pair();
    const id = a.create({ kind: 'sticky', x: 0, y: 0, text: 'abc def' }) ?? '';
    expect(b.getText(id)).toBe('abc def');
    net.pause();
    a.setText(id, 'X abc def');
    b.setText(id, 'abc def Y');
    net.flush();
    expect(a.getText(id)).toBe(b.getText(id));
    expect(a.getText(id)).toBe('X abc def Y');
  });
  it('keeps surrogate pairs intact in diffs', () => {
    const y = new Y.Doc();
    const t = y.getText('t');
    t.insert(0, 'a😀b');
    applyTextDiff(t, 'a😁b');
    expect(t.toJSON()).toBe('a😁b');
  });
  it('replaces a connector label', () => {
    const d = makeDoc();
    d.create({ kind: 'connector', from: { x: 0, y: 0 }, to: { x: 1, y: 1 } });
    d.setText('o1', 'yes');
    expect(d.getText('o1')).toBe('yes');
  });
});

describe('removal', () => {
  it('detaches connectors from a deleted target and keeps the end where it was', () => {
    const d = makeDoc();
    d.createMany([
      { init: { kind: 'sticky', x: 0, y: 0 } },
      { init: { kind: 'sticky', x: 500, y: 0 } },
      { init: { kind: 'connector', from: { id: 'o1', side: 'auto' }, to: { id: 'o2', side: 'left' } } },
    ]);
    d.remove(['o2'], (c, end) => (c === 'o3' && end === 'to' ? { x: 500, y: 80 } : null));
    expect(d.objects.has('o2')).toBe(false);
    expect(d.snapshot('o3')).toMatchObject({ from: { id: 'o1', side: 'auto' }, to: { x: 500, y: 80 } });
  });
  it('leaves connectors that are deleted along with their targets alone', () => {
    const d = makeDoc();
    d.createMany([
      { init: { kind: 'sticky', x: 0, y: 0 } },
      { init: { kind: 'connector', from: { id: 'o1', side: 'auto' }, to: { x: 1, y: 1 } } },
    ]);
    d.remove(['o1', 'o2']);
    expect(d.count).toBe(0);
  });
});

describe('layer order', () => {
  const three = (): CanvasDoc => {
    const d = makeDoc();
    d.createMany([1, 2, 3].map(() => ({ init: { kind: 'sticky' as const, x: 0, y: 0 } })));
    return d;
  };
  it('bringToFront keeps relative order', () => {
    const d = three();
    d.bringToFront(['o1', 'o2']);
    expect(d.orderedIds()).toEqual(['o3', 'o1', 'o2']);
  });
  it('sendToBack keeps relative order', () => {
    const d = three();
    d.sendToBack(['o2', 'o3']);
    expect(d.orderedIds()).toEqual(['o2', 'o3', 'o1']);
  });
  it('no-ops when already there', () => {
    const d = three();
    let updates = 0;
    d.ydoc.on('update', () => updates++);
    d.bringToFront(['o3']);
    d.sendToBack(['o1']);
    expect(updates).toBe(0);
  });
  it('step moves one layer past the neighbour', () => {
    const d = three();
    d.step(['o1'], 1);
    expect(d.orderedIds()).toEqual(['o2', 'o1', 'o3']);
    d.step(['o1'], 1);
    expect(d.orderedIds()).toEqual(['o2', 'o3', 'o1']);
    d.step(['o1'], 1);
    expect(d.orderedIds()).toEqual(['o2', 'o3', 'o1']);
    d.step(['o1'], -1);
    expect(d.orderedIds()).toEqual(['o2', 'o1', 'o3']);
  });
  it('step moves a multi-selection together', () => {
    const d = makeDoc();
    d.createMany([1, 2, 3, 4].map(() => ({ init: { kind: 'sticky' as const, x: 0, y: 0 } })));
    d.step(['o1', 'o2'], 1);
    expect(d.orderedIds()).toEqual(['o3', 'o1', 'o2', 'o4']);
    d.step(['o2', 'o1'], -1);
    expect(d.orderedIds()).toEqual(['o1', 'o2', 'o3', 'o4']);
  });
  it('reordering two objects does not conflict with a concurrent insert', () => {
    const { a, b, net } = pair();
    a.createMany([1, 2].map(() => ({ init: { kind: 'sticky' as const, x: 0, y: 0 } })));
    net.pause();
    a.bringToFront(['a1']);
    b.create({ kind: 'sticky', x: 5, y: 5 });
    net.flush();
    expect(a.orderedIds()).toEqual(b.orderedIds());
    expect(a.orderedIds()).toHaveLength(3);
    expect(a.orderedIds().indexOf('a1')).toBeGreaterThan(a.orderedIds().indexOf('a2'));
  });
});

describe('schema', () => {
  it('writes meta.schema = 1 once, outside the undo stack', () => {
    const d = makeDoc();
    expect(d.schema).toBe(0);
    expect(d.ensureSchema()).toBe(true);
    expect(d.schema).toBe(1);
    expect(d.undo.undoStack).toHaveLength(0);
  });
  it('a newer schema is read-only and is not overwritten', () => {
    const d = makeDoc();
    d.meta.set('schema', 2);
    expect(d.isFuture).toBe(true);
    expect(d.ensureSchema()).toBe(false);
    expect(d.schema).toBe(2);
  });
});

describe('undo (own edits only)', () => {
  it('undoes my edit and keeps a collaborator\'s', () => {
    const { a, b } = pair();
    const mine = a.create({ kind: 'sticky', x: 0, y: 0 }) ?? '';
    const theirs = b.create({ kind: 'sticky', x: 100, y: 100 }) ?? '';
    expect(a.count).toBe(2);
    a.undo.undo();
    expect(a.objects.has(mine)).toBe(false);
    expect(a.objects.has(theirs)).toBe(true);
    expect(b.objects.has(theirs)).toBe(true);
    expect(b.objects.has(mine)).toBe(false);
    a.undo.redo();
    expect(a.objects.has(mine)).toBe(true);
  });
  it('does not track remote or init updates', () => {
    const a = makeDoc();
    a.ensureSchema();
    const other = new Y.Doc();
    const od = new CanvasDoc(other, { rng: null, makeId: () => 'r1' });
    od.create({ kind: 'sticky', x: 0, y: 0 });
    Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(other), REMOTE);
    expect(a.count).toBe(1);
    expect(a.undo.undoStack).toHaveLength(0);
    a.undo.undo();
    expect(a.count).toBe(1);
  });
  it('one gesture is one undo step even with pauses', () => {
    const d = makeDoc();
    d.create({ kind: 'sticky', x: 0, y: 0 });
    d.undo.stopCapturing();
    d.beginGesture();
    d.patch('o1', { x: 10 });
    d.patch('o1', { x: 20 });
    d.patch('o1', { x: 30 });
    d.endGesture();
    expect(d.snapshot('o1')?.x).toBe(30);
    d.undo.undo();
    expect(d.snapshot('o1')?.x).toBe(0);
    expect(d.objects.has('o1')).toBe(true);
  });
  it('nested gestures only close at the outermost end', () => {
    const d = makeDoc();
    d.create({ kind: 'sticky', x: 0, y: 0 });
    d.beginGesture();
    d.beginGesture();
    d.endGesture();
    expect(d.undo.captureTimeout).toBeGreaterThan(1e6);
    d.endGesture();
    expect(d.undo.captureTimeout).toBe(500);
  });
  it('undoing a delete restores the object', () => {
    const d = makeDoc();
    d.create({ kind: 'sticky', x: 7, y: 8, text: 'keep' });
    d.undo.stopCapturing();
    d.remove(['o1']);
    expect(d.count).toBe(0);
    d.undo.undo();
    expect(d.snapshot('o1')).toMatchObject({ x: 7, y: 8, text: 'keep' });
  });
  it('uses the LOCAL origin', () => {
    const d = makeDoc();
    const origins: unknown[] = [];
    d.ydoc.on('afterTransaction', (t: Y.Transaction) => origins.push(t.origin));
    d.create({ kind: 'sticky', x: 0, y: 0 });
    expect(origins).toContain(LOCAL_ORIGIN);
  });
});

describe('convergence of two Y.Docs', () => {
  it('concurrent edits to different fields of one object both survive', () => {
    const { a, b, net } = pair();
    const id = a.create({ kind: 'sticky', x: 0, y: 0 }) ?? '';
    net.pause();
    a.patch(id, { x: 100 });
    b.patch(id, { color: 'blue' });
    net.flush();
    for (const d of [a, b]) expect(d.snapshot(id)).toMatchObject({ x: 100, color: 'blue' });
  });
  it('concurrent edits to the same field resolve the same way everywhere', () => {
    const { a, b, net } = pair();
    const id = a.create({ kind: 'sticky', x: 0, y: 0 }) ?? '';
    net.pause();
    a.patch(id, { x: 100 });
    b.patch(id, { x: 200 });
    net.flush();
    expect(a.snapshot(id)?.x).toBe(b.snapshot(id)?.x);
  });
  it('concurrent creations all land, with the same order on both sides', () => {
    const { a, b, net } = pair();
    net.pause();
    for (let i = 0; i < 20; i++) {
      a.create({ kind: 'sticky', x: i, y: 0 });
      b.create({ kind: 'shape', x: i, y: 1 });
    }
    net.flush();
    expect(a.count).toBe(40);
    expect(b.count).toBe(40);
    expect(a.orderedIds()).toEqual(b.orderedIds());
  });
  it('delete vs edit: the object is gone for both', () => {
    const { a, b, net } = pair();
    const id = a.create({ kind: 'sticky', x: 0, y: 0, text: 'x' }) ?? '';
    net.pause();
    a.remove([id]);
    b.setText(id, 'xy');
    b.patch(id, { x: 5 });
    net.flush();
    expect(a.objects.has(id)).toBe(false);
    expect(b.objects.has(id)).toBe(false);
  });
  it('two clients undoing independently never touch each other', () => {
    const { a, b } = pair();
    const x = a.create({ kind: 'sticky', x: 0, y: 0 }) ?? '';
    a.undo.stopCapturing();
    const y = b.create({ kind: 'sticky', x: 1, y: 1 }) ?? '';
    b.undo.stopCapturing();
    b.patch(x, { x: 99 });
    a.undo.undo(); // a's creation of x goes away
    expect(a.objects.has(x)).toBe(false);
    expect(b.objects.has(x)).toBe(false);
    expect(b.objects.has(y)).toBe(true);
    b.undo.undo(); // b's patch is already moot; its creation of y is undone next
    b.undo.undo();
    expect(a.objects.has(y)).toBe(false);
    expect(a.count).toBe(0);
  });
  it('encoded state round-trips into a fresh doc', () => {
    const { a } = pair();
    a.create({ kind: 'sticky', x: 3, y: 4, text: 'persist' });
    a.ensureSchema();
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, Y.encodeStateAsUpdate(a.ydoc));
    const d = new CanvasDoc(fresh);
    expect(d.snapshot('a1')).toMatchObject({ x: 3, y: 4, text: 'persist' });
    expect(d.schema).toBe(1);
  });
});
