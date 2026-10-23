import { describe, expect, it } from 'vitest';
import { CanvasDoc } from './doc';
import { duplicate, parse, serialize, toInits } from './clipboard';
import { Scene, type SceneChange } from './scene';
import { pair, ids, makeDoc } from './testing';
import { TextLayouter } from './textLayout';

const sceneOf = (d: CanvasDoc): Scene => new Scene(d, new TextLayouter((t, s) => t.length * s * 0.5));
const three = (d: CanvasDoc): void => {
  d.createMany([0, 1, 2].map((i) => ({ init: { kind: 'sticky' as const, x: i * 200, y: 0 } })));
};

describe('locked in the document', () => {
  it('is stored as true and removed on false; absent means unlocked', () => {
    const d = makeDoc();
    d.create({ kind: 'sticky', x: 0, y: 0 });
    d.patch('o1', { locked: true });
    expect(d.objects.get('o1')?.get('locked')).toBe(true);
    expect(sceneOf(d).get('o1')?.locked).toBe(true);
    d.patch('o1', { locked: false });
    expect(d.objects.get('o1')?.has('locked')).toBe(false);
    expect(sceneOf(d).get('o1')?.locked).toBeUndefined();
  });
  it('applies to connectors too, and a non-boolean is ignored', () => {
    const d = makeDoc();
    d.create({ kind: 'connector', from: { x: 0, y: 0 }, to: { x: 5, y: 5 } });
    d.patch('o1', { locked: true });
    expect(sceneOf(d).get('o1')?.locked).toBe(true);
    d.patch('o1', { locked: 'yes' as never });
    expect(d.objects.get('o1')?.get('locked')).toBe(true);
  });
  it('a lock set by one client reaches the other and survives a concurrent edit of another field', () => {
    const { a, b, net } = pair();
    a.create({ kind: 'sticky', x: 0, y: 0 }, 'k');
    net.pause();
    a.patch('k', { locked: true });
    b.patch('k', { color: 'pink' });
    net.flush();
    for (const d of [a, b]) {
      expect(d.objects.get('k')?.get('locked')).toBe(true);
      expect(d.objects.get('k')?.get('color')).toBe('pink');
    }
  });
});

describe('groups in the scene', () => {
  it('records show `group` only while two or more objects carry the id', () => {
    const d = makeDoc();
    three(d);
    d.patchMany(new Map([['o1', { group: 'g1' }], ['o2', { group: 'g1' }]]));
    const s = sceneOf(d);
    expect(s.get('o1')?.group).toBe('g1');
    expect(s.get('o2')?.group).toBe('g1');
    expect(s.get('o3')?.group).toBeUndefined();
    expect([...s.groupMembers('g1')].sort()).toEqual(['o1', 'o2']);
    expect(s.unitOf('o1').sort()).toEqual(['o1', 'o2']);
    expect(s.unitOf('o3')).toEqual(['o3']);
  });
  it('a group left with one member dissolves by itself (delete), and comes back if the delete is undone', () => {
    const d = makeDoc();
    three(d);
    d.patchMany(new Map([['o1', { group: 'g1' }], ['o2', { group: 'g1' }], ['o3', { group: 'g1' }]]));
    const s = sceneOf(d);
    const changes: SceneChange[] = [];
    s.subscribe((c) => changes.push(c));
    d.checkpoint();
    d.remove(['o3']);
    expect(s.get('o1')?.group).toBe('g1');
    d.checkpoint();
    d.remove(['o2']);
    expect(s.get('o1')?.group).toBeUndefined(); // lone leftover: an ordinary object
    expect(s.unitOf('o1')).toEqual(['o1']);
    expect(changes.at(-1)?.ids.has('o1')).toBe(true); // reported so selection / panel refresh
    d.undo.undo();
    expect(s.get('o1')?.group).toBe('g1');
    expect(s.get('o2')?.group).toBe('g1');
  });
  it('ungrouping every member removes the id; one member leaving the group leaves the rest a group of two or dissolves a pair', () => {
    const d = makeDoc();
    three(d);
    d.patchMany(new Map([['o1', { group: 'g1' }], ['o2', { group: 'g1' }]]));
    const s = sceneOf(d);
    d.patch('o2', { group: null });
    expect(s.get('o1')?.group).toBeUndefined();
    expect(d.objects.get('o2')?.has('group')).toBe(false);
  });
  it('building a scene over a doc with a stray single group id shows no group (a concurrent delete left it)', () => {
    const d = makeDoc();
    three(d);
    d.objects.get('o1')?.set('group', 'zz');
    const s = sceneOf(d);
    expect(s.get('o1')?.group).toBeUndefined();
  });
  it('rejects a bad group id and keeps flat groups (a new id replaces the old one)', () => {
    const d = makeDoc();
    three(d);
    d.patch('o1', { group: 'has space' });
    expect(d.objects.get('o1')?.has('group')).toBe(false);
    d.patchMany(new Map([['o1', { group: 'a' }], ['o2', { group: 'a' }]]));
    d.patchMany(new Map([['o2', { group: 'b' }], ['o3', { group: 'b' }]]));
    const s = sceneOf(d);
    expect(s.get('o1')?.group).toBeUndefined(); // 'a' lost o2, o1 is alone
    expect(s.get('o2')?.group).toBe('b');
    expect(s.get('o3')?.group).toBe('b');
  });
  it('converges: two clients grouping different pairs, and a concurrent delete', () => {
    const { a, b, net } = pair();
    a.createMany([0, 1, 2, 3].map((i) => ({ id: `k${i}`, init: { kind: 'sticky' as const, x: i * 200, y: 0 } })));
    const sa = sceneOf(a);
    const sb = sceneOf(b);
    net.pause();
    a.patchMany(new Map([['k0', { group: 'ga' }], ['k1', { group: 'ga' }]]));
    b.patchMany(new Map([['k2', { group: 'gb' }], ['k3', { group: 'gb' }]]));
    net.flush();
    for (const s of [sa, sb]) {
      expect([...s.groupMembers('ga')].sort()).toEqual(['k0', 'k1']);
      expect([...s.groupMembers('gb')].sort()).toEqual(['k2', 'k3']);
    }
    net.pause();
    a.remove(['k1']);
    b.patch('k0', { x: 5 });
    net.flush();
    for (const s of [sa, sb]) {
      expect(s.get('k0')?.group).toBeUndefined();
      expect(s.get('k0')?.x).toBe(5);
    }
  });
});

describe('copy, paste and duplicate keep groups under new ids', () => {
  it('serializes the transform fields and pastes the group as a group of its own', () => {
    const d = makeDoc({ makeId: ids('p') });
    d.createMany([
      { init: { kind: 'sticky', x: 0, y: 0, rot: 30, group: 'g1' } },
      { init: { kind: 'shape', x: 300, y: 0, locked: true, group: 'g1' } },
      { init: { kind: 'sticky', x: 600, y: 0 } },
    ]);
    const s = sceneOf(d);
    const text = serialize(s, d, ['p1', 'p2', 'p3']);
    const payload = parse(text ?? '');
    expect(payload?.objects[0]).toMatchObject({ rot: 30, group: 'g1' });
    expect(payload?.objects[1]).toMatchObject({ locked: true, group: 'g1' });
    const n = ids('n');
    const inits = toInits(payload ?? { v: 1, objects: [] }, 10, 10, n);
    const groups = inits.map((i) => i.init.group);
    expect(groups[0]).toBeDefined();
    expect(groups[0]).toBe(groups[1]);
    expect(groups[0]).not.toBe('g1');
    expect(groups[2]).toBeUndefined();
    expect(inits[0]?.init.rot).toBe(30);
    expect(inits[1]?.init.locked).toBe(true);
    // Two pastes of the same text are two groups.
    const again = toInits(payload ?? { v: 1, objects: [] }, 20, 20, n);
    expect(again[0]?.init.group).not.toBe(groups[0]);
  });
  it('a copy of a single member of a group carries no group', () => {
    const d = makeDoc();
    d.createMany([{ init: { kind: 'sticky', x: 0, y: 0, group: 'g1' } }, { init: { kind: 'sticky', x: 300, y: 0, group: 'g1' } }]);
    const s = sceneOf(d);
    const made = duplicate(s, d, ['o1'], 10, 10);
    expect(made).toHaveLength(1);
    expect(d.objects.get(made[0] ?? '')?.has('group')).toBe(false);
  });
  it('duplicating a whole group yields a second group and leaves the first alone', () => {
    const d = makeDoc();
    d.createMany([{ init: { kind: 'sticky', x: 0, y: 0, group: 'g1' } }, { init: { kind: 'sticky', x: 300, y: 0, group: 'g1' } }]);
    const s = sceneOf(d);
    const made = duplicate(s, d, ['o1', 'o2'], 10, 10);
    expect(made).toHaveLength(2);
    const g = d.objects.get(made[0] ?? '')?.get('group');
    expect(typeof g).toBe('string');
    expect(g).not.toBe('g1');
    expect(d.objects.get(made[1] ?? '')?.get('group')).toBe(g);
    expect(s.groupMembers('g1').size).toBe(2);
    expect(s.groupMembers(g as string).size).toBe(2);
  });
});
