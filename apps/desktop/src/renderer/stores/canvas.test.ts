import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { CanvasItemKind, CanvasItemSchema, type CanvasItem } from '@calaba/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { childKey, trashKey } from '../lib/canvas/tree';
import { useBoardsUi } from './boardsUi';
import { useCanvas } from './canvas';
import { clampTree, itemOf, leaveCanvas, TREE_DEFAULT, TREE_MAX, TREE_MIN, useCanvasUi } from './canvasUi';
import { useDiskUi } from './diskUi';
import { useWikiUi } from './wikiUi';

const W = 'w';
const item = (id: string, parentId = '', extra: Omit<Partial<CanvasItem>, '$typeName' | '$unknown'> = {}): CanvasItem =>
  create(CanvasItemSchema, { id, workspaceId: W, parentId, kind: CanvasItemKind.CANVAS, name: id, ...extra });

describe('canvas store', () => {
  beforeEach(() => useCanvas.setState({ items: {}, lists: {}, load: {} }));

  it('setList stores the items and the order and marks the list ready', () => {
    useCanvas.getState().setList(childKey(W, ''), [item('a'), item('b')]);
    const s = useCanvas.getState();
    expect(s.lists[childKey(W, '')]).toEqual(['a', 'b']);
    expect(s.load[childKey(W, '')]).toBe('ready');
    expect(Object.keys(s.items)).toEqual(['a', 'b']);
  });

  it('setLoad with the same value is no write (no re-render)', () => {
    useCanvas.getState().setLoad('k', 'loading');
    const before = useCanvas.getState().load;
    useCanvas.getState().setLoad('k', 'loading');
    expect(useCanvas.getState().load).toBe(before);
  });

  it('upsert touches only the lists of its workspace; an unloaded list stays unloaded', () => {
    useCanvas.getState().setList(childKey(W, ''), [item('a')]);
    useCanvas.getState().setList('other/top', [item('z')]);
    const other = useCanvas.getState().lists['other/top'];
    useCanvas.getState().upsert(item('b', '', { position: 1 }));
    expect(useCanvas.getState().lists[childKey(W, '')]).toEqual(['a', 'b']);
    expect(useCanvas.getState().lists['other/top']).toBe(other);
    expect(useCanvas.getState().lists[childKey(W, 'f')]).toBeUndefined();
  });

  it('put stores items without touching any list; an empty put is no write', () => {
    useCanvas.getState().put([item('p')]);
    expect(useCanvas.getState().items['p']).toBeDefined();
    expect(useCanvas.getState().lists).toEqual({});
    const before = useCanvas.getState();
    useCanvas.getState().put([]);
    expect(useCanvas.getState()).toBe(before);
  });

  it('remove, dropWorkspace and forgetLists', () => {
    useCanvas.getState().setList(childKey(W, ''), [item('a'), item('b')]);
    useCanvas.getState().setList(trashKey(W), [item('t', '', { trashedAt: timestampFromMs(1), trashedRoot: true })]);
    useCanvas.getState().remove('a');
    expect(useCanvas.getState().lists[childKey(W, '')]).toEqual(['b']);
    useCanvas.getState().forgetLists(W);
    expect(useCanvas.getState().lists).toEqual({});
    expect(useCanvas.getState().load).toEqual({});
    expect(useCanvas.getState().items['b']).toBeDefined(); // known items stay for the crumbs
    useCanvas.getState().dropWorkspace(W);
    expect(useCanvas.getState().items).toEqual({});
  });
});

describe('canvas UI store', () => {
  beforeEach(() => {
    useCanvasUi.setState({ active: false, itemOf: {}, trashOf: {}, expanded: {}, query: 'x', renaming: null, dialog: null, treeWidth: TREE_DEFAULT });
    useBoardsUi.setState({ active: false });
    useDiskUi.setState({ active: false });
    useWikiUi.setState({ active: false });
  });

  it('the open canvas is remembered per workspace; opening one closes the trash view and a dialog', () => {
    const ui = useCanvasUi.getState();
    ui.openTrash('w1', true);
    ui.openDialog({ kind: 'share', itemId: 'x' });
    ui.openItem('w1', 'a');
    ui.openItem('w2', 'b');
    expect(itemOf(useCanvasUi.getState(), 'w1')).toBe('a');
    expect(itemOf(useCanvasUi.getState(), 'w2')).toBe('b');
    expect(itemOf(useCanvasUi.getState(), 'w3')).toBe('');
    expect(useCanvasUi.getState().dialog).toBeNull();
  });

  it('opening the already open canvas is no write, unless the trash view covers it', () => {
    useCanvasUi.getState().openItem('w1', 'a');
    const before = useCanvasUi.getState().itemOf;
    useCanvasUi.getState().openItem('w1', 'a');
    expect(useCanvasUi.getState().itemOf).toBe(before);
    useCanvasUi.getState().openTrash('w1', true);
    useCanvasUi.getState().openItem('w1', 'a');
    expect(useCanvasUi.getState().itemOf).not.toBe(before);
  });

  it('the trash view toggles per workspace and clears the filter', () => {
    useCanvasUi.getState().openTrash('w1', true);
    expect(useCanvasUi.getState().trashOf).toEqual({ w1: true });
    expect(useCanvasUi.getState().query).toBe('');
    useCanvasUi.getState().openTrash('w1', false);
    expect(useCanvasUi.getState().trashOf).toEqual({});
  });

  it('leaving the section clears the filter and the dialog', () => {
    useCanvasUi.getState().setActive(true);
    useCanvasUi.getState().setQuery('abc');
    useCanvasUi.getState().openDialog({ kind: 'move', itemId: 'x' });
    leaveCanvas();
    expect(useCanvasUi.getState()).toMatchObject({ active: false, query: '', dialog: null });
  });

  it('expanded nodes toggle without a write when nothing changes', () => {
    useCanvasUi.getState().setExpanded('f', true);
    const before = useCanvasUi.getState().expanded;
    useCanvasUi.getState().setExpanded('f', true);
    expect(useCanvasUi.getState().expanded).toBe(before);
    useCanvasUi.getState().setExpanded('f', false);
    expect(useCanvasUi.getState().expanded).toEqual({});
  });

  it('the tree width is clamped to 220–360', () => {
    expect(clampTree(10)).toBe(TREE_MIN);
    expect(clampTree(900)).toBe(TREE_MAX);
    expect(clampTree(Number.NaN)).toBe(TREE_DEFAULT);
    useCanvasUi.getState().setTreeWidth(300.4);
    expect(useCanvasUi.getState().treeWidth).toBe(300);
  });

  it('the boards, the Disk or the Wiki turned on from anywhere leave the canvas', () => {
    for (const turnOn of [() => useBoardsUi.getState().setActive(true), () => useDiskUi.getState().setActive(true), () => useWikiUi.getState().setActive(true)]) {
      useCanvasUi.getState().setActive(true);
      turnOn();
      expect(useCanvasUi.getState().active).toBe(false);
      useBoardsUi.setState({ active: false });
      useDiskUi.setState({ active: false });
      useWikiUi.setState({ active: false });
    }
  });
});
