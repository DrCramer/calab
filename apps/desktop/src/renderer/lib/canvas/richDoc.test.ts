import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { duplicate, parse, serialize, toInits } from './clipboard';
import { canvasPlainText } from './plainText';
import { F_BOLD, F_ITALIC, F_STRIKE, toggleFlag, toggleList } from './richText';
import { Scene } from './scene';
import { makeDoc, pair } from './testing';
import { TextLayouter } from './textLayout';

const text = 'hello brave world\nsecond';
const rich = () => {
  let f = toggleFlag(undefined, text, 6, 11, F_BOLD);
  f = toggleFlag(f, text, 12, 17, F_STRIKE);
  f = toggleList(f, text, 18, 24, 'bullet');
  return f;
};
const sceneOf = (d: ReturnType<typeof makeDoc>): Scene => new Scene(d, new TextLayouter((t, s, f = 0) => t.length * s * 0.5 * (f & F_BOLD ? 1.1 : 1)));

describe('formatted text in the document', () => {
  it('create with a formatting stores Y.Text attributes; the scene record carries text and fmt', () => {
    const d = makeDoc();
    d.create({ kind: 'sticky', x: 0, y: 0, text, fmt: rich() });
    const yt = d.objects.get('o1')?.get('text') as Y.Text;
    expect(yt.toDelta()).toEqual([
      { insert: 'hello ' },
      { insert: 'brave', attributes: { bold: true } },
      { insert: ' ' },
      { insert: 'world', attributes: { strike: true } },
      { insert: '\nsecond' },
      { insert: '\n', attributes: { list: 'bullet' } },
    ]);
    const rec = sceneOf(d).get('o1');
    expect(rec).toMatchObject({ kind: 'sticky', text });
    expect(rec && 'fmt' in rec ? rec.fmt?.spans : null).toEqual([{ from: 6, to: 11, f: F_BOLD }, { from: 12, to: 17, f: F_STRIKE }]);
    expect(d.getText('o1')).toBe(text);
  });
  it('plain objects get no fmt and no fontSize: records are the same as before', () => {
    const d = makeDoc();
    d.create({ kind: 'sticky', x: 0, y: 0, text: 'plain' });
    const rec = sceneOf(d).get('o1') as unknown as Record<string, unknown>;
    expect('fmt' in rec).toBe(false);
    expect('fontSize' in rec).toBe(false);
  });
  it('setRich changes only what differs and is one undo step', () => {
    const d = makeDoc();
    d.create({ kind: 'shape', x: 0, y: 0, text: 'abc def' });
    d.checkpoint();
    d.setRich('o1', 'abc def', toggleFlag(undefined, 'abc def', 0, 3, F_BOLD));
    expect(d.getRich('o1').fmt?.spans).toEqual([{ from: 0, to: 3, f: F_BOLD }]);
    d.checkpoint();
    d.setRich('o1', 'abc XYZ def', toggleFlag(toggleFlag(undefined, 'abc XYZ def', 0, 3, F_BOLD), 'abc XYZ def', 4, 7, F_ITALIC));
    expect(d.getRich('o1')).toMatchObject({ text: 'abc XYZ def' });
    expect(d.getRich('o1').fmt?.spans).toEqual([{ from: 0, to: 3, f: F_BOLD }, { from: 4, to: 7, f: F_ITALIC }]);
    d.undo.undo();
    expect(d.getRich('o1').text).toBe('abc def');
    expect(d.getRich('o1').fmt?.spans).toEqual([{ from: 0, to: 3, f: F_BOLD }]);
    d.undo.undo();
    expect(d.getRich('o1').fmt).toBeUndefined();
  });
  it('removing the last formatting leaves a clean Y.Text, a last-line list adds and removes its terminator', () => {
    const d = makeDoc();
    d.create({ kind: 'sticky', x: 0, y: 0, text: 'a\nb' });
    d.setRich('o1', 'a\nb', toggleList(undefined, 'a\nb', 2, 3, 'number'));
    expect((d.objects.get('o1')?.get('text') as Y.Text).toJSON()).toBe('a\nb\n');
    expect(d.getText('o1')).toBe('a\nb');
    d.setRich('o1', 'a\nb', undefined);
    expect((d.objects.get('o1')?.get('text') as Y.Text).toJSON()).toBe('a\nb');
    expect((d.objects.get('o1')?.get('text') as Y.Text).toDelta()).toEqual([{ insert: 'a\nb' }]);
  });
  it('an old client (plain text only) reads the same words', () => {
    const d = makeDoc();
    d.create({ kind: 'sticky', x: 0, y: 0, text, fmt: rich() });
    const plainRead = (d.objects.get('o1')?.get('text') as Y.Text).toJSON();
    expect(plainRead.replace(/\n$/, '')).toBe(text);
  });
  it('two documents with different attributes converge', () => {
    const { a, b, net } = pair();
    a.create({ kind: 'text', x: 0, y: 0, text: 'one two three' }, 'o');
    net.flush();
    net.pause();
    a.setRich('o', 'one two three', toggleFlag(undefined, 'one two three', 0, 3, F_BOLD));
    b.setRich('o', 'one two three', toggleFlag(undefined, 'one two three', 8, 13, F_ITALIC));
    net.flush();
    const ra = a.getRich('o');
    const rb = b.getRich('o');
    expect(ra.text).toBe('one two three');
    expect(ra.fmt?.key).toBe(rb.fmt?.key);
    expect(ra.fmt?.spans).toEqual([{ from: 0, to: 3, f: F_BOLD }, { from: 8, to: 13, f: F_ITALIC }]);
  });
  it('concurrent text edits and a format of another part both survive', () => {
    const { a, b, net } = pair();
    a.create({ kind: 'sticky', x: 0, y: 0, text: 'alpha beta' }, 'o');
    net.flush();
    net.pause();
    a.setRich('o', 'alpha beta', toggleFlag(undefined, 'alpha beta', 0, 5, F_BOLD));
    b.setRich('o', 'alpha beta!', undefined);
    net.flush();
    expect(a.getRich('o').text).toBe('alpha beta!');
    expect(a.getRich('o').fmt?.spans).toEqual([{ from: 0, to: 5, f: F_BOLD }]);
    expect(b.getRich('o').fmt?.key).toBe(a.getRich('o').fmt?.key);
  });
  it('fontSize is stored for stickies and shapes only, M is the absence of the field', () => {
    const d = makeDoc();
    d.createMany([
      { init: { kind: 'sticky', x: 0, y: 0, fontSize: 'xl' } },
      { init: { kind: 'text', x: 0, y: 0, fontSize: 'xl' } },
      { init: { kind: 'shape', x: 0, y: 0, fontSize: 'm' } },
    ]);
    expect(d.objects.get('o1')?.get('fontSize')).toBe('xl');
    expect(d.objects.get('o2')?.has('fontSize')).toBe(false);
    expect(d.objects.get('o3')?.has('fontSize')).toBe(false);
    d.patch('o3', { fontSize: 'l' });
    d.patch('o2', { fontSize: 'l' });
    d.patch('o1', { fontSize: 'm' });
    expect(d.objects.get('o3')?.get('fontSize')).toBe('l');
    expect(d.objects.get('o2')?.has('fontSize')).toBe(false);
    expect(d.objects.get('o1')?.has('fontSize')).toBe(false);
    expect(sceneOf(d).get('o3')).toMatchObject({ fontSize: 'l' });
    d.objects.get('o3')?.set('fontSize', 'huge');
    expect('fontSize' in (sceneOf(d).get('o3') as unknown as Record<string, unknown>)).toBe(false);
  });
  it('fontPx: a preset is only its token, any other px is stored next to the nearest token, a text object keeps `size`', () => {
    const d = makeDoc();
    d.createMany([
      { init: { kind: 'sticky', x: 0, y: 0 } },
      { init: { kind: 'text', x: 0, y: 0 } },
      { init: { kind: 'shape', x: 0, y: 0 } },
    ]);
    d.patch('o1', { fontPx: 30 });
    expect(d.objects.get('o1')?.get('fontSize')).toBe('l');
    expect(d.objects.get('o1')?.get('fontPx')).toBe(30);
    d.patch('o1', { fontPx: 38 });
    expect(d.objects.get('o1')?.get('fontSize')).toBe('xl');
    expect(d.objects.get('o1')?.has('fontPx')).toBe(false);
    d.patch('o1', { fontPx: 19 });
    expect(d.objects.get('o1')?.has('fontSize')).toBe(false);
    expect(d.objects.get('o1')?.get('fontPx')).toBe(19);
    d.patch('o1', { fontPx: 18 });
    expect(d.objects.get('o1')?.has('fontSize')).toBe(false);
    expect(d.objects.get('o1')?.has('fontPx')).toBe(false);
    d.patch('o3', { fontPx: 300 });
    expect(d.objects.get('o3')?.get('fontPx')).toBe(200);
    expect(sceneOf(d).get('o3')).toMatchObject({ fontSize: 'xl', fontPx: 200 });
    d.patch('o2', { fontPx: 44 });
    expect(d.objects.get('o2')?.get('size')).toBe(44);
    expect(d.objects.get('o2')?.has('fontPx')).toBe(false);
    // A plain token write (older code) drops the exact size.
    d.patch('o3', { fontPx: 30 });
    d.patch('o3', { fontSize: 's' });
    expect(d.objects.get('o3')?.has('fontPx')).toBe(false);
  });
  it('fontPx is read only while its token is still the nearest: an older client that changed the token wins', () => {
    const d = makeDoc();
    d.create({ kind: 'sticky', x: 0, y: 0, fontPx: 30 });
    expect(sceneOf(d).get('o1')).toMatchObject({ fontSize: 'l', fontPx: 30 });
    d.objects.get('o1')?.set('fontSize', 'xl'); // what a token-only client writes
    const rec = sceneOf(d).get('o1') as unknown as Record<string, unknown>;
    expect(rec['fontSize']).toBe('xl');
    expect('fontPx' in rec).toBe(false);
    d.objects.get('o1')?.set('fontPx', 'big'); // garbage is ignored
    expect('fontPx' in (sceneOf(d).get('o1') as unknown as Record<string, unknown>)).toBe(false);
  });
  it('fontPx survives copy and paste', () => {
    const d = makeDoc();
    d.create({ kind: 'sticky', x: 0, y: 0, fontPx: 30 });
    const payload = parse(serialize(sceneOf(d), d, ['o1']) ?? '');
    expect(payload?.objects[0]).toMatchObject({ fontSize: 'l', fontPx: 30 });
    const inits = payload ? toInits(payload, 30, 30, () => 'n1') : [];
    expect(inits[0]?.init).toMatchObject({ fontSize: 'l', fontPx: 30 });
  });
});

describe('scene', () => {
  it('a rebuild that does not touch the text keeps the same fmt object', () => {
    const d = makeDoc();
    d.create({ kind: 'sticky', x: 0, y: 0, text, fmt: rich() });
    const s = sceneOf(d);
    const before = s.get('o1');
    d.patch('o1', { x: 40 });
    const after = s.get('o1');
    expect(after).not.toBe(before);
    expect(after && 'fmt' in after ? after.fmt : 1).toBe(before && 'fmt' in before ? before.fmt : 2);
  });
  it('a lock does not look like a repaint for formatted text', () => {
    const d = makeDoc();
    d.create({ kind: 'sticky', x: 0, y: 0, text, fmt: rich() });
    const s = sceneOf(d);
    const seen: boolean[] = [];
    s.subscribe((c) => seen.push(c.dirty.length === 0));
    d.patch('o1', { locked: true });
    expect(seen).toEqual([true]);
  });
  it('a text object grows with formatted wrapping (a list indents its lines)', () => {
    const plain = makeDoc();
    plain.create({ kind: 'text', x: 0, y: 0, w: 108, size: 20, text: 'aaaa bbbb cccc' });
    const bold = makeDoc();
    bold.create({ kind: 'text', x: 0, y: 0, w: 108, size: 20, text: 'aaaa bbbb cccc', fmt: toggleList(undefined, 'aaaa bbbb cccc', 0, 14, 'bullet') });
    const hp = sceneOf(plain).get('o1')?.h ?? 0;
    const hb = sceneOf(bold).get('o1')?.h ?? 0;
    expect(hb).toBeGreaterThan(hp);
  });
  it('a format change alone repaints the object', () => {
    const d = makeDoc();
    d.create({ kind: 'sticky', x: 0, y: 0, text: 'abc' });
    const s = sceneOf(d);
    let dirty = 0;
    s.subscribe((c) => (dirty += c.dirty.length));
    d.setRich('o1', 'abc', toggleFlag(undefined, 'abc', 0, 3, F_ITALIC));
    expect(dirty).toBeGreaterThan(0);
    expect(s.get('o1')).toMatchObject({ fmt: { spans: [{ from: 0, to: 3, f: F_ITALIC }] } });
  });
});

describe('plain text for search', () => {
  it('has no attributes and no list terminator', () => {
    const d = makeDoc();
    d.create({ kind: 'sticky', x: 0, y: 0, text, fmt: rich() });
    d.create({ kind: 'shape', x: 0, y: 0, text: 'plain' });
    expect(canvasPlainText(d.ydoc)).toBe(`${text}\nplain`);
  });
});

describe('clipboard keeps formatting inside the canvas', () => {
  it('copy → paste carries text, attributes, lists and font size', () => {
    const d = makeDoc();
    d.create({ kind: 'sticky', x: 0, y: 0, text, fmt: rich(), fontSize: 'l' });
    const s = sceneOf(d);
    const payload = parse(serialize(s, d, ['o1']) ?? '');
    expect(payload?.objects[0]).toMatchObject({ text, fontSize: 'l' });
    expect(Array.isArray(payload?.objects[0]?.rich)).toBe(true);
    const inits = payload ? toInits(payload, 30, 30, () => 'n1') : [];
    const init = inits[0]?.init;
    expect(init).toMatchObject({ kind: 'sticky', text, fontSize: 'l' });
    expect(init && 'fmt' in init ? init.fmt?.key : '').toBe(rich()?.key);
  });
  it('duplicate keeps the formatting; a plain object has no rich field and a bad rich field falls back to its text', () => {
    const d = makeDoc();
    d.create({ kind: 'sticky', x: 0, y: 0, text, fmt: rich() });
    d.create({ kind: 'sticky', x: 300, y: 0, text: 'plain' });
    const s = sceneOf(d);
    const [copy] = duplicate(s, d, ['o1'], 20, 20);
    expect(copy && d.getRich(copy).fmt?.key).toBe(rich()?.key);
    const p = parse(serialize(s, d, ['o2']) ?? '');
    expect(p?.objects[0] && 'rich' in p.objects[0]).toBe(false);
    const bad = parse(`calaba-canvas:${JSON.stringify({ v: 1, objects: [{ id: 'x', kind: 'sticky', x: 0, y: 0, text: 'fallback', rich: [{ insert: 5 }, 'junk', null] }] })}`);
    const init = bad ? toInits(bad, 0, 0, () => 'z')[0]?.init : undefined;
    expect(init).toMatchObject({ text: 'fallback' });
    expect(init && 'fmt' in init ? init.fmt : undefined).toBeUndefined();
  });
});
