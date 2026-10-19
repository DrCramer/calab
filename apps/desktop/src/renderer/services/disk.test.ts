import { create } from '@bufbuild/protobuf';
import { DiskItemKind, DiskItemSchema, DiskItemUpsertSchema, ListDiskItemsResponseSchema } from '@calaba/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { folderKey } from '../lib/disk';
import { useDisk } from '../stores/disk';
import { useDiskUi } from '../stores/diskUi';
import { usePrefs } from '../stores/prefs';
import { useUi } from '../stores/ui';
import { diskApi, loadListing, onDiskItemUpsert } from './disk';

vi.mock('../platform', () => ({ platform: { kind: 'web' } }));

const item = (id: string) => create(DiskItemSchema, { id, workspaceId: 'w1', kind: DiskItemKind.FILE, name: id });

describe('disk listing paging', () => {
  afterEach(() => vi.restoreAllMocks());

  it('follows next_cursor until the last page', async () => {
    const list = vi
      .spyOn(diskApi, 'list')
      .mockResolvedValueOnce(create(ListDiskItemsResponseSchema, { items: [item('a'), item('b')], nextCursor: 'c1' }))
      .mockResolvedValueOnce(create(ListDiskItemsResponseSchema, { items: [item('c')] }));
    await loadListing('w1', '', false);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[0]?.[1]).not.toHaveProperty('cursor');
    expect(list.mock.calls[1]?.[1]).toMatchObject({ cursor: 'c1' });
    expect(useDisk.getState().lists[folderKey('w1', '')]).toEqual(['a', 'b', 'c']);
  });
});

describe('columns view refresh (CBF-21)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('an upsert reloads the open folder and the shown ancestor it touched, not the other ancestors', async () => {
    const folder = (id: string, parentId: string) => create(DiskItemSchema, { id, workspaceId: 'w1', kind: DiskItemKind.FOLDER, name: id, parentId });
    usePrefs.setState({ diskView: 'columns' });
    useUi.setState({ activeWorkspaceId: 'w1' });
    useDiskUi.setState({ active: true, folderOf: { w1: 'c' } });
    useDisk.setState({ paths: { c: [folder('a', ''), folder('b', 'a'), folder('c', 'b')] } });
    const list = vi.spyOn(diskApi, 'list').mockResolvedValue(create(ListDiskItemsResponseSchema, { items: [] }));
    onDiskItemUpsert(create(DiskItemUpsertSchema, { workspaceId: 'w1', item: item('x') }));
    onDiskItemUpsert(create(DiskItemUpsertSchema, { workspaceId: 'w1', item: create(DiskItemSchema, { id: 'y', workspaceId: 'w1', name: 'y', parentId: 'b' }) }));
    await Promise.resolve();
    const parents = list.mock.calls.map((c) => (c[1] as { parent?: string }).parent).sort();
    // Open folder «c», the root (x's parent) and «b» (y's parent); «a» is untouched.
    expect(parents).toEqual(['', 'b', 'c']);
  });
});
