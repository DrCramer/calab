import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import {
  CanvasItemKind,
  CanvasItemResponseSchema,
  CanvasItemSchema,
  CanvasPathResponseSchema,
  EmptyCanvasTrashResponseSchema,
  ListCanvasItemsResponseSchema,
  type CanvasItem,
} from '@calaba/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api/client';
import { childKey, trashKey } from '../lib/canvas/tree';
import { setCanvasDocHandle } from '../lib/canvas/docHandle';
import { useCanvas } from '../stores/canvas';
import { useCanvasUi } from '../stores/canvasUi';
import { useToasts } from '../stores/toasts';
import { useUi } from '../stores/ui';
import { canvasApi, createItem, deleteForever, emptyTrash, loadChildren, loadTrash, moveItem, onCanvasItemRemove, onCanvasItemUpsert, openCanvasHit, openCanvasSection, renameItem, restoreItem, restoreVersion, trashItem } from './canvas';

vi.mock('../platform', () => ({ platform: { kind: 'web', app: { log: () => undefined, attention: () => undefined } } }));
const confirm = vi.hoisted(() => vi.fn());
vi.mock('../components/Confirm', () => ({ confirmAction: confirm }));
const showMode = vi.hoisted(() => vi.fn());
vi.mock('../features/shell/sectionNav', () => ({ showMode }));

const W = 'w';
const item = (id: string, parentId = '', extra: Omit<Partial<CanvasItem>, '$typeName' | '$unknown'> = {}): CanvasItem =>
  create(CanvasItemSchema, { id, workspaceId: W, parentId, kind: CanvasItemKind.CANVAS, name: id, ...extra });
const folder = (id: string, parentId = ''): CanvasItem => item(id, parentId, { kind: CanvasItemKind.FOLDER });

function reset(): void {
  useCanvas.setState({ items: {}, lists: {}, load: {} });
  useCanvasUi.setState({ active: false, itemOf: {}, trashOf: {}, expanded: {}, query: '', renaming: null, dialog: null });
  useUi.setState({ activeWorkspaceId: W });
  useToasts.setState({ items: [] });
  setCanvasDocHandle(null);
  confirm.mockReset();
  showMode.mockReset();
}

describe('canvas listing', () => {
  beforeEach(reset);
  afterEach(() => vi.restoreAllMocks());

  it('follows next_cursor until the last page', async () => {
    const list = vi
      .spyOn(canvasApi, 'list')
      .mockResolvedValueOnce(create(ListCanvasItemsResponseSchema, { items: [item('a'), item('b')], nextCursor: 'c1' }))
      .mockResolvedValueOnce(create(ListCanvasItemsResponseSchema, { items: [item('c')] }));
    await loadChildren(W, '');
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[0]?.[1]).not.toHaveProperty('cursor');
    expect(list.mock.calls[1]?.[1]).toMatchObject({ cursor: 'c1' });
    expect(useCanvas.getState().lists[childKey(W, '')]).toEqual(['a', 'b', 'c']);
  });

  it('two loads of one list share a request', async () => {
    const list = vi.spyOn(canvasApi, 'list').mockResolvedValue(create(ListCanvasItemsResponseSchema, { items: [item('a')] }));
    await Promise.all([loadChildren(W, ''), loadChildren(W, '')]);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('a folder that answers 404 leaves the tree and its list is marked failed', async () => {
    const { ApiError } = await import('../lib/api/client');
    useCanvas.getState().put([folder('f')]);
    vi.spyOn(canvasApi, 'list').mockRejectedValue(new ApiError('NOT_FOUND', 'gone', 404));
    await loadChildren(W, 'f');
    expect(useCanvas.getState().items['f']).toBeUndefined();
    expect(useCanvas.getState().load[childKey(W, 'f')]).toBe('error');
  });

  it('the trash lists the roots; the section opens on the first canvas (not a folder) when none is remembered', async () => {
    const list = vi.spyOn(canvasApi, 'list').mockImplementation((_ws, p) =>
      Promise.resolve(create(ListCanvasItemsResponseSchema, { items: p.trashed ? [item('old', '', { trashedAt: timestampFromMs(1), trashedRoot: true })] : [folder('f'), item('first'), item('second')] })),
    );
    await loadTrash(W);
    expect(useCanvas.getState().lists[trashKey(W)]).toEqual(['old']);
    expect(list.mock.calls[0]?.[1]).toMatchObject({ trashed: true });
    await openCanvasSection(W);
    expect(useCanvasUi.getState().itemOf[W]).toBe('first');
    await openCanvasSection(W);
    expect(useCanvasUi.getState().itemOf[W]).toBe('first'); // kept
  });
});

describe('canvas gateway events', () => {
  beforeEach(reset);

  it('a hidden section applies nothing to its lists: they are dropped and reload on the next open', () => {
    useCanvas.getState().setList(childKey(W, ''), [item('a')]);
    onCanvasItemUpsert({ workspaceId: W, item: item('b') } as never);
    expect(useCanvas.getState().lists[childKey(W, '')]).toBeUndefined();
    expect(useCanvas.getState().items['b']).toBeUndefined(); // an unknown item is not stored either
    onCanvasItemUpsert({ workspaceId: W, item: item('a', '', { name: 'renamed' }) } as never);
    expect(useCanvas.getState().items['a']?.name).toBe('renamed');
  });

  it('on screen: a rename costs no request, a new / moved / trashed item refetches the touched lists', async () => {
    useCanvasUi.setState({ active: true });
    useCanvas.getState().setList(childKey(W, ''), [item('a'), folder('f')]);
    useCanvas.getState().setList(childKey(W, 'f'), []);
    const list = vi.spyOn(canvasApi, 'list').mockResolvedValue(create(ListCanvasItemsResponseSchema, { items: [] }));
    onCanvasItemUpsert({ workspaceId: W, item: item('a', '', { name: 'renamed', updatedAt: timestampFromMs(5) }) } as never);
    await Promise.resolve();
    expect(list).not.toHaveBeenCalled();
    expect(useCanvas.getState().items['a']?.name).toBe('renamed');
    // a moves into f: both lists (and nothing else loaded) are read once, together
    onCanvasItemUpsert({ workspaceId: W, item: item('a', 'f') } as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(list.mock.calls.map((c) => c[1].parent ?? '').sort()).toEqual(['', 'f']);
    vi.restoreAllMocks();
  });

  it('remove closes an open canvas inside the removed folder and takes the subtree away', () => {
    useCanvasUi.setState({ active: true, itemOf: { [W]: 'c' } });
    useCanvas.getState().setList(childKey(W, ''), [folder('f')]);
    useCanvas.getState().setList(childKey(W, 'f'), [item('c', 'f')]);
    onCanvasItemRemove({ workspaceId: W, itemId: 'f', parentId: '' } as never);
    expect(useCanvasUi.getState().itemOf[W]).toBe('');
    expect(useCanvas.getState().items['c']).toBeUndefined();
    expect(useCanvas.getState().lists[childKey(W, '')]).toEqual([]);
  });
});

describe('canvas actions', () => {
  beforeEach(reset);
  afterEach(() => vi.restoreAllMocks());

  it('a created canvas opens and its row goes into rename; a folder only expands its parent', async () => {
    vi.spyOn(canvasApi, 'create').mockImplementation((_ws, parentId, kind) => Promise.resolve(create(CanvasItemResponseSchema, { item: kind === CanvasItemKind.FOLDER ? folder('nf', parentId) : item('nc', parentId) })));
    await createItem(W, 'p', CanvasItemKind.CANVAS);
    expect(useCanvasUi.getState().itemOf[W]).toBe('nc');
    expect(useCanvasUi.getState().renaming).toBe('nc');
    expect(useCanvasUi.getState().expanded['p']).toBe(true);
    useCanvasUi.setState({ renaming: null });
    await createItem(W, '', CanvasItemKind.FOLDER);
    expect(useCanvasUi.getState().itemOf[W]).toBe('nc');
    expect(useCanvasUi.getState().renaming).toBe('nf');
  });

  it('a refused create is a toast, nothing is stored', async () => {
    vi.spyOn(canvasApi, 'create').mockRejectedValue(new Error('403'));
    await createItem(W, '', CanvasItemKind.CANVAS);
    expect(useCanvas.getState().items).toEqual({});
    expect(useToasts.getState().items.length).toBe(1);
  });

  it('rename is optimistic and comes back on a refusal; the same name sends nothing', async () => {
    useCanvas.getState().put([item('a', '', { name: 'Old' })]);
    const update = vi.spyOn(canvasApi, 'update').mockRejectedValue(new Error('403'));
    await renameItem('a', ' Old ', 'Old');
    expect(update).not.toHaveBeenCalled();
    await renameItem('a', 'New', 'Old');
    expect(update).toHaveBeenCalledWith('a', { name: 'New' });
    expect(useCanvas.getState().items['a']?.name).toBe('Old');
  });

  it('move patches parent and position, expands the target and rolls back on a refusal', async () => {
    useCanvas.getState().setList(childKey(W, ''), [item('a'), folder('f')]);
    const update = vi.spyOn(canvasApi, 'update').mockResolvedValue(create(CanvasItemResponseSchema, { item: item('a', 'f') }));
    await moveItem('a', 'f', 0);
    expect(update).toHaveBeenCalledWith('a', { parentId: 'f', position: 0 });
    expect(useCanvasUi.getState().expanded['f']).toBe(true);
    update.mockRejectedValueOnce(new Error('403'));
    useCanvas.getState().upsert(item('a', ''));
    await moveItem('a', 'f', 0);
    expect(useCanvas.getState().items['a']?.parentId).toBe('');
  });

  it('trash offers «Отменить» that restores', async () => {
    useCanvas.getState().put([item('a')]);
    vi.spyOn(canvasApi, 'trash').mockResolvedValue(create(CanvasItemResponseSchema, { item: item('a', '', { trashedAt: timestampFromMs(1), trashedRoot: true }) }));
    const restore = vi.spyOn(canvasApi, 'restore').mockResolvedValue(create(CanvasItemResponseSchema, { item: item('a') }));
    expect(await trashItem('a')).toBe(true);
    expect(useCanvas.getState().items['a']?.trashedAt).toBeDefined();
    const undo = useToasts.getState().items.at(-1)?.action;
    expect(undo).toBeDefined();
    undo?.run();
    await Promise.resolve();
    expect(restore).toHaveBeenCalledWith('a');
    await restoreItem('a');
    expect(useCanvas.getState().items['a']?.trashedAt).toBeUndefined();
  });

  it('delete forever asks first; confirmed it removes the item and closes it if open', async () => {
    useCanvas.getState().put([item('a')]);
    useCanvasUi.setState({ itemOf: { [W]: 'a' } });
    const remove = vi.spyOn(canvasApi, 'remove').mockResolvedValue(undefined);
    confirm.mockResolvedValueOnce(false);
    await deleteForever('a');
    expect(remove).not.toHaveBeenCalled();
    confirm.mockResolvedValueOnce(true);
    await deleteForever('a');
    expect(remove).toHaveBeenCalledWith('a');
    expect(useCanvas.getState().items['a']).toBeUndefined();
    expect(useCanvasUi.getState().itemOf[W]).toBe('');
  });

  it('empty trash asks first, reports the count and reloads the trash', async () => {
    const empty = vi.spyOn(canvasApi, 'emptyTrash').mockResolvedValue(create(EmptyCanvasTrashResponseSchema, { deleted: 2 }));
    vi.spyOn(canvasApi, 'list').mockResolvedValue(create(ListCanvasItemsResponseSchema, { items: [] }));
    confirm.mockResolvedValueOnce(false);
    await emptyTrash(W);
    expect(empty).not.toHaveBeenCalled();
    confirm.mockResolvedValueOnce(true);
    await emptyTrash(W);
    expect(empty).toHaveBeenCalledWith(W);
    await new Promise((r) => setTimeout(r, 0));
    expect(useCanvas.getState().lists[trashKey(W)]).toEqual([]);
  });
});

describe('restoring a version', () => {
  beforeEach(reset);
  afterEach(() => vi.restoreAllMocks());

  it('needs the open writable canvas; the state goes to the live document', async () => {
    const state = vi.spyOn(canvasApi, 'versionState').mockResolvedValue(Uint8Array.of(1, 2, 3));
    expect(await restoreVersion('c', 'v')).toBe(false); // no handle
    expect(state).not.toHaveBeenCalled();
    const restore = vi.fn(() => true);
    setCanvasDocHandle({ canvasId: 'c', restore, writable: () => false });
    expect(await restoreVersion('c', 'v')).toBe(false); // read-only
    setCanvasDocHandle({ canvasId: 'c', restore, writable: () => true });
    expect(await restoreVersion('other', 'v')).toBe(false); // another canvas is open
    expect(await restoreVersion('c', 'v')).toBe(true);
    expect(restore).toHaveBeenCalledWith(Uint8Array.of(1, 2, 3));
  });

  it('a document that refuses the state is a failure, not a success toast', async () => {
    vi.spyOn(canvasApi, 'versionState').mockResolvedValue(Uint8Array.of(9));
    setCanvasDocHandle({ canvasId: 'c', restore: () => false, writable: () => true });
    expect(await restoreVersion('c', 'v')).toBe(false);
  });
});

describe('opening a search hit', () => {
  beforeEach(reset);
  afterEach(() => vi.restoreAllMocks());

  const answer = (items: CanvasItem[], path: CanvasItem[] = []): void => {
    vi.spyOn(canvasApi, 'get').mockImplementation((id) => {
      const it = items.find((i) => i.id === id);
      return it ? Promise.resolve(create(CanvasItemResponseSchema, { item: it })) : Promise.reject(new ApiError('NOT_FOUND', 'gone', 404));
    });
    vi.spyOn(canvasApi, 'path').mockResolvedValue(create(CanvasPathResponseSchema, { items: path }));
  };

  it('a canvas: the section, the canvas open, the folders above it expanded', async () => {
    answer([item('c', 'f')], [folder('f')]);
    useCanvasUi.setState({ trashOf: { [W]: true } });
    await openCanvasHit(W, { itemId: 'c', folder: false });
    expect(showMode).toHaveBeenCalledWith('canvas');
    expect(useCanvasUi.getState().itemOf[W]).toBe('c');
    expect(useCanvasUi.getState().trashOf[W]).toBeUndefined();
    expect(useCanvasUi.getState().expanded['f']).toBe(true);
  });

  it('a folder: opened and expanded in the tree, the open canvas stays', async () => {
    answer([folder('f', 'g')], [folder('g')]);
    useCanvasUi.setState({ itemOf: { [W]: 'keep' } });
    vi.spyOn(canvasApi, 'list').mockResolvedValue(create(ListCanvasItemsResponseSchema, { items: [] }));
    await openCanvasHit(W, { itemId: 'f', folder: true });
    expect(showMode).toHaveBeenCalledWith('canvas');
    expect(useCanvasUi.getState().itemOf[W]).toBe('keep');
    expect(useCanvasUi.getState().expanded).toMatchObject({ f: true, g: true });
  });

  it('a canvas that is gone or in the trash says so and opens nothing', async () => {
    answer([item('t', '', { trashedAt: timestampFromMs(1) })]);
    await openCanvasHit(W, { itemId: 'nope', folder: false });
    await openCanvasHit(W, { itemId: 't', folder: false });
    expect(showMode).not.toHaveBeenCalled();
    expect(useCanvasUi.getState().itemOf[W]).toBeUndefined();
    expect(useToasts.getState().items).toHaveLength(1); // the same notice is not stacked
  });
});
