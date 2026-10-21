import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { CANVAS_BITS, CanvasItemKind, CanvasItemSchema, type CanvasItem } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { ancestorsOf, applyList, applyRemove, applyUpsert, canManage, canStructure, canView, canWrite, childKey, dropPlan, dropWorkspace, filterItems, isFolder, isInSubtree, trashKey, zoneAt, type CanvasData } from './tree';

const WS = 'w1';
const FOLDER = CanvasItemKind.FOLDER;
const item = (id: string, parentId = '', extra: Omit<Partial<CanvasItem>, '$typeName' | '$unknown'> = {}): CanvasItem =>
  create(CanvasItemSchema, { id, workspaceId: WS, parentId, kind: CanvasItemKind.CANVAS, name: id.toUpperCase(), ...extra });
const folder = (id: string, parentId = '', extra: Omit<Partial<CanvasItem>, '$typeName' | '$unknown'> = {}): CanvasItem => item(id, parentId, { kind: FOLDER, hasChildren: true, ...extra });

/** a/ → (a1, a2/ → (a21)), b, c (a canvas); all lists loaded. */
function tree(): CanvasData {
  let s: CanvasData = { items: {}, lists: {} };
  s = applyList(s, childKey(WS, ''), [folder('a', '', { position: 0 }), item('b', '', { position: 1024 }), item('c', '', { position: 2048 })]);
  s = applyList(s, childKey(WS, 'a'), [item('a1', 'a'), folder('a2', 'a')]);
  s = applyList(s, childKey(WS, 'a2'), [item('a21', 'a2')]);
  return s;
}

describe('canvas tree reducers', () => {
  it('upsert moves an item between loaded lists at its position', () => {
    const s = applyUpsert(tree(), item('a21', '', { position: 512 }));
    expect(s.lists[childKey(WS, 'a2')]).toEqual([]);
    expect(s.lists[childKey(WS, '')]).toEqual(['a', 'a21', 'b', 'c']);
  });

  it('a trashed root leaves its list and goes to the front of a loaded trash; a trashed descendant is in no list', () => {
    let s = applyList(tree(), trashKey(WS), [item('old', '', { trashedAt: timestampFromMs(1), trashedRoot: true })]);
    s = applyUpsert(s, item('a1', 'a', { trashedAt: timestampFromMs(2), trashedRoot: true }));
    expect(s.lists[childKey(WS, 'a')]).toEqual(['a2']);
    expect(s.lists[trashKey(WS)]).toEqual(['a1', 'old']);
    s = applyUpsert(s, item('a21', 'a2', { trashedAt: timestampFromMs(3) }));
    expect(s.lists[childKey(WS, 'a2')]).toEqual([]);
    expect(s.lists[trashKey(WS)]).toEqual(['a1', 'old']);
  });

  it('a new item teaches its parent folder it has children', () => {
    let s = applyList({ items: {}, lists: {} }, childKey(WS, ''), [folder('e', '', { hasChildren: false })]);
    s = applyUpsert(s, item('x', 'e'));
    expect(s.items['e']?.hasChildren).toBe(true);
  });

  it('a list read older than an event does not bring back the old name', () => {
    let s = applyList({ items: {}, lists: {} }, childKey(WS, ''), [item('a')]);
    s = applyUpsert(s, item('a', '', { name: 'Renamed', updatedAt: timestampFromMs(2000) }), true);
    s = applyList(s, childKey(WS, ''), [item('a', '', { name: '', updatedAt: timestampFromMs(1000), myBits: CANVAS_BITS.VIEW })]);
    expect(s.items['a']?.name).toBe('Renamed');
    expect(s.items['a']?.myBits).toBe(CANVAS_BITS.VIEW); // the fetched rights are taken
    s = applyList(s, childKey(WS, ''), [item('a', '', { name: 'Newer', updatedAt: timestampFromMs(3000) })]);
    expect(s.items['a']?.name).toBe('Newer');
  });

  it('an event with my_bits 0 keeps the known bits; a local answer does not', () => {
    let s = applyList({ items: {}, lists: {} }, childKey(WS, ''), [item('a', '', { myBits: CANVAS_BITS.VIEW | CANVAS_BITS.WRITE })]);
    s = applyUpsert(s, item('a', '', { name: 'n' }), true);
    expect(s.items['a']?.myBits).toBe(CANVAS_BITS.VIEW | CANVAS_BITS.WRITE);
    s = applyUpsert(s, item('a', '', { name: 'n' }));
    expect(s.items['a']?.myBits).toBe(0n);
  });

  it('remove takes the loaded subtree and every list entry with it', () => {
    const s = applyRemove(tree(), 'a');
    expect(Object.keys(s.items).sort()).toEqual(['b', 'c']);
    expect(s.lists[childKey(WS, '')]).toEqual(['b', 'c']);
    expect(Object.keys(s.lists)).toEqual([childKey(WS, '')]);
    expect(applyRemove(s, 'zzz')).toBe(s);
  });

  it('a workspace is dropped with its lists only', () => {
    const other = applyList(tree(), 'w2/top', [create(CanvasItemSchema, { id: 'q', workspaceId: 'w2' })]);
    const s = dropWorkspace(other, WS);
    expect(Object.keys(s.items)).toEqual(['q']);
    expect(Object.keys(s.lists)).toEqual(['w2/top']);
  });

  it('ancestors, subtree test and folder kind', () => {
    const s = tree();
    expect(ancestorsOf(s.items, 'a21')).toEqual(['a', 'a2']);
    expect(ancestorsOf(s.items, 'b')).toEqual([]);
    expect(isInSubtree(s.items, 'a21', 'a')).toBe(true);
    expect(isInSubtree(s.items, 'b', 'a')).toBe(false);
    expect(isFolder(s.items['a'])).toBe(true);
    expect(isFolder(s.items['b'])).toBe(false);
    expect(isFolder(undefined)).toBe(false);
  });
});

describe('canvas drag and drop plan', () => {
  it('a folder row has three zones, a canvas row two halves', () => {
    expect(zoneAt(2, 0, 32)).toBe('before');
    expect(zoneAt(16, 0, 32)).toBe('inside');
    expect(zoneAt(30, 0, 32)).toBe('after');
    expect(zoneAt(2, 0, 32, false)).toBe('before');
    expect(zoneAt(16, 0, 32, false)).toBe('after');
    expect(zoneAt(16, 0, 32, false)).not.toBe('inside');
  });

  it('before / after a row reorders among its siblings', () => {
    expect(dropPlan(tree(), 'c', 'b', 'before')).toEqual({ parentId: '', position: 1 });
    expect(dropPlan(tree(), 'a', 'c', 'after')).toEqual({ parentId: '', position: 2 });
    expect(dropPlan(tree(), 'b', 'b', 'before')).toBeNull();
  });

  it('no-op drops are refused: the same place', () => {
    expect(dropPlan(tree(), 'b', 'a', 'after')).toBeNull(); // b already follows a
    expect(dropPlan(tree(), 'b', 'c', 'before')).toBeNull();
  });

  it('inside a folder appends (first when its children are not loaded); never inside a canvas', () => {
    expect(dropPlan(tree(), 'b', 'a', 'inside')).toEqual({ parentId: 'a', position: 2 });
    const unloaded = applyList({ items: {}, lists: {} }, childKey(WS, ''), [folder('f'), item('g')]);
    expect(dropPlan(unloaded, 'g', 'f', 'inside')).toEqual({ parentId: 'f', position: 0 });
    expect(dropPlan(tree(), 'c', 'b', 'inside')).toBeNull();
  });

  it('a folder never moves into itself or its own subtree', () => {
    expect(dropPlan(tree(), 'a', 'a2', 'inside')).toBeNull();
    expect(dropPlan(tree(), 'a', 'a21', 'before')).toBeNull();
    expect(dropPlan(tree(), 'a2', 'a21', 'after')).toBeNull();
  });

  it('a drop beside a row in another folder moves the item there', () => {
    expect(dropPlan(tree(), 'b', 'a1', 'after')).toEqual({ parentId: 'a', position: 1 });
  });
});

describe('canvas filter and rights', () => {
  it('the filter matches live items of the workspace by name, case-insensitively, up to the limit', () => {
    let s = tree();
    s = applyUpsert(s, item('doc1', '', { name: 'Дорожная карта' }));
    s = applyUpsert(s, item('doc2', '', { name: 'карта сайта', trashedAt: timestampFromMs(1), trashedRoot: true }));
    s = applyUpsert(s, create(CanvasItemSchema, { id: 'doc3', workspaceId: 'w2', name: 'карта' }));
    expect(filterItems(s.items, WS, 'КАРТА')).toEqual(['doc1']);
    expect(filterItems(s.items, WS, '  ')).toEqual([]);
    expect(filterItems(s.items, WS, 'a', 2)).toHaveLength(2);
  });

  it('view / write / manage and the structure rule', () => {
    const V = CANVAS_BITS.VIEW;
    const W = CANVAS_BITS.WRITE;
    const M = CANVAS_BITS.MANAGE;
    expect([canView(V), canView(0n)]).toEqual([true, false]);
    expect([canWrite(V | W), canWrite(V), canWrite(M)]).toEqual([true, false, true]);
    expect([canManage(M), canManage(V | W)]).toEqual([true, false]);
    // WRITE alone edits the content; the structure is the owner's or MANAGE's.
    expect(canStructure({ ownerId: 'me', myBits: V | W }, 'me')).toBe(true);
    expect(canStructure({ ownerId: 'other', myBits: V | W }, 'me')).toBe(false);
    expect(canStructure({ ownerId: 'other', myBits: V | M }, 'me')).toBe(true);
    expect(canStructure({ ownerId: '', myBits: V }, '')).toBe(false);
    expect(canStructure({ ownerId: 'me', myBits: 0n }, 'me')).toBe(false);
  });
});
