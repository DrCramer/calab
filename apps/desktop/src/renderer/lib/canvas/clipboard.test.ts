import { describe, expect, it } from 'vitest';
import { CLIPBOARD_PREFIX, duplicate, parse, serialize, toInits } from './clipboard';
import { Scene } from './scene';
import { ids, makeDoc } from './testing';
import { MAX_TEXT } from './types';

const fixture = () => {
  const d = makeDoc();
  d.createMany([
    { init: { kind: 'sticky', x: 0, y: 0, text: 'one', color: 'pink' } },
    { init: { kind: 'shape', shape: 'diamond', x: 400, y: 0, text: 'two' } },
    { init: { kind: 'connector', from: { id: 'o1', side: 'right' }, to: { id: 'o2', side: 'left' }, route: 'elbow', label: 'go' } },
    { init: { kind: 'sticky', x: 900, y: 0 } },
  ]);
  return { d, s: new Scene(d) };
};

describe('clipboard format', () => {
  it('prefixes the JSON and keeps layer order', () => {
    const { d, s } = fixture();
    const text = serialize(s, d, ['o2', 'o1']) ?? '';
    expect(text.startsWith(CLIPBOARD_PREFIX)).toBe(true);
    const p = parse(text);
    expect(p?.objects.map((o) => o.id)).toEqual(['o1', 'o2']);
    expect(p?.objects[0]).toMatchObject({ kind: 'sticky', text: 'one', color: 'pink' });
  });
  it('returns null for nothing to copy, foreign text or malformed JSON', () => {
    const { d, s } = fixture();
    expect(serialize(s, d, [])).toBeNull();
    expect(parse('hello')).toBeNull();
    expect(parse(`${CLIPBOARD_PREFIX}{oops`)).toBeNull();
    expect(parse(`${CLIPBOARD_PREFIX}{"v":2,"objects":[]}`)).toBeNull();
    expect(parse(`${CLIPBOARD_PREFIX}{"v":1,"objects":[{"id":1}]}`)).toBeNull();
    expect(parse(`${CLIPBOARD_PREFIX}{"v":1,"objects":"x"}`)).toBeNull();
  });
  it('turns a connector into free points when its targets are not copied', () => {
    const { d, s } = fixture();
    const p = parse(serialize(s, d, ['o1', 'o3']) ?? '');
    const conn = p?.objects.find((o) => o.kind === 'connector');
    expect(conn?.from).toEqual({ id: 'o1', side: 'right' });
    expect(conn?.to).toEqual({ x: 400, y: 50 });
  });
});

describe('paste', () => {
  it('creates fresh ids, offsets, and remaps glued connectors', () => {
    const { d, s } = fixture();
    const p = parse(serialize(s, d, ['o1', 'o2', 'o3']) ?? '');
    expect(p).not.toBeNull();
    const inits = toInits(p ?? { v: 1, objects: [] }, 50, 60, ids('n'));
    expect(inits.map((i) => i.id)).toEqual(['n1', 'n2', 'n3']);
    expect(inits[0]?.init).toMatchObject({ kind: 'sticky', x: 50, y: 60, text: 'one' });
    expect(inits[2]?.init).toMatchObject({ kind: 'connector', from: { id: 'n1', side: 'right' }, to: { id: 'n2', side: 'left' }, route: 'elbow', label: 'go' });
  });
  it('shifts free connector ends and drops unknown glue', () => {
    const payload = {
      v: 1,
      objects: [{ id: 'c', kind: 'connector' as const, z: 'a', from: { id: 'gone', side: 'top' }, to: { x: 10, y: 10 } }],
    };
    const [c] = toInits(payload, 5, 5, ids('n'));
    expect(c?.init).toMatchObject({ from: { x: 5, y: 5 }, to: { x: 15, y: 15 } });
  });
  it('sanitizes values from a hostile clipboard', () => {
    const payload = {
      v: 1,
      objects: [
        { id: 'a', kind: 'sticky' as const, z: '', x: 'bad', y: 1e99, w: -1, h: 5, color: 'url(evil)', text: 'z'.repeat(9000) },
        { id: 'b', kind: 'shape' as const, z: '', shape: 'blob', x: 0, y: 0 },
      ],
    };
    const d = makeDoc();
    const out = d.createMany(toInits(payload, 0, 0, ids('n')));
    expect(out).toHaveLength(2);
    const a = d.snapshot('n1');
    expect(a).toMatchObject({ x: 0, y: 1e7, w: 24, color: 'yellow' });
    expect(a?.text).toHaveLength(MAX_TEXT);
    expect(d.snapshot('n2')).toMatchObject({ shape: 'rect' });
  });
  it('round-trips through the document', () => {
    const { d, s } = fixture();
    const text = serialize(s, d, ['o1', 'o2', 'o3']) ?? '';
    const payload = parse(text);
    const created = d.createMany(toInits(payload ?? { v: 1, objects: [] }, 24, 24));
    expect(created).toHaveLength(3);
    expect(d.count).toBe(7);
    const conn = d.snapshot(created[2] ?? '');
    expect(conn?.from).toMatchObject({ id: created[0] });
    expect(conn?.to).toMatchObject({ id: created[1] });
    expect(d.getText(created[0] ?? '')).toBe('one');
  });
});

describe('duplicate', () => {
  it('copies in place with an offset and keeps the copies on top', () => {
    const { d, s } = fixture();
    const copies = duplicate(s, d, ['o1'], 24, 24);
    expect(copies).toHaveLength(1);
    expect(d.snapshot(copies[0] ?? '')).toMatchObject({ x: 24, y: 24, text: 'one' });
    expect(d.orderedIds().at(-1)).toBe(copies[0]);
  });
  it('does nothing for an empty selection', () => {
    const { d, s } = fixture();
    expect(duplicate(s, d, [], 1, 1)).toEqual([]);
  });
});
