import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBoardsUi } from './boardsUi';
import { TREE_DEFAULT, TREE_MAX, TREE_MIN, clampTree, itemOf, leaveCanvas, useCanvasUi } from './canvasUi';

// The persisted part lives in localStorage: a memory stand-in, set before the store is read (as stores/prefs.test.ts does).
const { storage } = vi.hoisted(() => {
  const m = new Map<string, string>();
  const storage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', { localStorage: storage });
  return { storage };
});

beforeEach(() => {
  useCanvasUi.setState({
    active: false, itemOf: {}, trashOf: {}, expanded: {}, treeWidth: TREE_DEFAULT, treeCollapsed: false,
    query: '', renaming: null, emojiFor: null, dialog: null,
  });
  useBoardsUi.setState({ active: false });
});

describe('clampTree', () => {
  it('keeps the width in the tree column range, rounds it, and falls back to the default for a non-number', () => {
    expect(clampTree(10)).toBe(TREE_MIN);
    expect(clampTree(10_000)).toBe(TREE_MAX);
    expect(clampTree(300.4)).toBe(300);
    expect(clampTree(Number.NaN)).toBe(TREE_DEFAULT);
  });
});

describe('canvasUi store', () => {
  it('turning the section off clears the filter and the dialog', () => {
    const s = useCanvasUi.getState();
    s.setActive(true);
    s.setQuery('plan');
    s.openDialog({ kind: 'share', itemId: 'c1' });
    s.setActive(false);
    expect(useCanvasUi.getState()).toMatchObject({ active: false, query: '', dialog: null });
  });

  it('opening the item already open changes nothing; another item closes the dialog', () => {
    const s = useCanvasUi.getState();
    s.openItem('w1', 'c1');
    s.openDialog({ kind: 'move', itemId: 'c1' });
    s.openItem('w1', 'c1');
    expect(useCanvasUi.getState().dialog).not.toBeNull();
    s.openItem('w1', 'c2');
    expect(itemOf(useCanvasUi.getState(), 'w1')).toBe('c2');
    expect(useCanvasUi.getState().dialog).toBeNull();
  });

  it('the trash replaces the open item view and clears the filter; closing it removes the flag', () => {
    const s = useCanvasUi.getState();
    s.setQuery('x');
    s.openTrash('w1', true);
    expect(useCanvasUi.getState()).toMatchObject({ query: '', trashOf: { w1: true } });
    s.openTrash('w1', false);
    expect(useCanvasUi.getState().trashOf).toEqual({});
  });

  it('expanding a node is idempotent and collapsing removes it', () => {
    const s = useCanvasUi.getState();
    s.setExpanded('f1', true);
    const once = useCanvasUi.getState().expanded;
    s.setExpanded('f1', true);
    expect(useCanvasUi.getState().expanded).toBe(once);
    s.setExpanded('f1', false);
    expect(useCanvasUi.getState().expanded).toEqual({});
  });

  it('the tree width is clamped on set', () => {
    useCanvasUi.getState().setTreeWidth(9999);
    expect(useCanvasUi.getState().treeWidth).toBe(TREE_MAX);
  });

  it('renaming in the tree puts the filter and the trash away; ending the rename keeps them', () => {
    const s = useCanvasUi.getState();
    s.setQuery('a');
    s.openTrash('w1', true);
    s.setRenaming('c1');
    expect(useCanvasUi.getState()).toMatchObject({ renaming: 'c1', query: '', trashOf: {} });
    s.setQuery('b');
    s.setRenaming(null);
    expect(useCanvasUi.getState()).toMatchObject({ renaming: null, query: 'b' });
  });

  it('the emoji picker at the tree row shows the row; at the header it keeps the filter', () => {
    const s = useCanvasUi.getState();
    s.setQuery('a');
    s.setEmojiFor({ id: 'c1', at: 'header' });
    expect(useCanvasUi.getState()).toMatchObject({ emojiFor: { id: 'c1', at: 'header' }, query: 'a' });
    s.setEmojiFor({ id: 'c1', at: 'tree' });
    expect(useCanvasUi.getState()).toMatchObject({ query: '', trashOf: {} });
  });

  it('opening the boards turns the canvas section off', () => {
    useCanvasUi.getState().setActive(true);
    useBoardsUi.setState({ active: true });
    expect(useCanvasUi.getState().active).toBe(false);
  });

  it('leaveCanvas turns the section off only when it is on', () => {
    leaveCanvas();
    expect(useCanvasUi.getState().active).toBe(false);
    useCanvasUi.getState().setActive(true);
    leaveCanvas();
    expect(useCanvasUi.getState().active).toBe(false);
  });

  it('persisted state is read back defensively: bad ids and values are dropped, the width is clamped', async () => {
    storage.setItem(
      'calaba-canvas-ui',
      JSON.stringify({ version: 1, state: { itemOf: { w1: 'c1', w2: 42 }, expanded: { f1: true, f2: 'yes' }, treeWidth: 5000, treeCollapsed: true } }),
    );
    await useCanvasUi.persist.rehydrate();
    const s = useCanvasUi.getState();
    expect(s.itemOf).toEqual({ w1: 'c1' });
    expect(s.expanded).toEqual({ f1: true });
    expect(s.treeWidth).toBe(TREE_MAX);
    expect(s.treeCollapsed).toBe(true);
  });
});
