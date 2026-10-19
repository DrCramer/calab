import { fromJson, type JsonValue } from '@bufbuild/protobuf';
import { timestampMs } from '@bufbuild/protobuf/wkt';
import {
  CANVAS_BITS,
  CanvasActivityKind,
  CanvasActivityPageSchema,
  CanvasItemKind,
  CanvasItemResponseSchema,
  CanvasPathResponseSchema,
  CanvasPermissionsResponseSchema,
  CanvasSettingsSchema,
  CanvasVersionsResponseSchema,
  EmptyCanvasTrashResponseSchema,
  ListCanvasItemsResponseSchema,
  PermissionTargetType,
  SearchResponseSchema,
  SearchType,
} from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { applyList, canStructure, canWrite, childKey, trashKey } from '../lib/canvas/tree';
import { snippetText } from '../lib/search/snippet';

/**
 * The JSON of the Canvas routes as the Go server's protojson writes it (canvas.proto; enums by name,
 * 64-bit integers as strings, timestamps RFC 3339, scalar defaults written out). The files in
 * __fixtures__/canvas are the answers of a live server: `tools/canvas-walk.sh <base> <this dir>` (the REST
 * walk) and `lib/canvasSync.live.test.ts` with CALABA_CANVAS_DUMP (versions, a list after a compaction, the
 * text search — they need a document); `list-page-1.json` is written by hand (a page over the
 * server's 200). The client's schemas and reducers read them as they are, without fallbacks.
 */
const files = import.meta.glob('./__fixtures__/canvas/*.json', { eager: true, import: 'default' });
const read = (name: string): JsonValue => files[`./__fixtures__/canvas/${name}.json`] as JsonValue;
const OWNER = CANVAS_BITS.VIEW | CANVAS_BITS.WRITE | CANVAS_BITS.MANAGE;
const item = (name: string) => {
  const it = fromJson(CanvasItemResponseSchema, read(name)).item;
  if (!it) throw new Error(`fixture ${name}: no item`);
  return it;
};

describe('Canvas wire format of the server', () => {
  const created = item('create-untitled');
  const WS = created.workspaceId;
  const ME = created.ownerId;

  it('reads the top level: kinds, order, bits, has_children, the written-out defaults', () => {
    const top = fromJson(ListCanvasItemsResponseSchema, read('list-top'));
    expect(top.items.map((i) => i.name)).toEqual(['', 'Продукт']);
    expect(top.items.map((i) => i.kind)).toEqual([CanvasItemKind.CANVAS, CanvasItemKind.FOLDER]);
    expect(top.items.map((i) => i.position)).toEqual([0, 1]);
    expect(top.items.map((i) => i.hasChildren)).toEqual([false, true]);
    expect(top.items.map((i) => i.myBits)).toEqual([OWNER, OWNER]);
    expect(top.items[0]).toMatchObject({ parentId: '', docSize: 0, preview: '', shared: false, restricted: false, trashedRoot: false });
    expect(top.items[0]?.trashedAt).toBeUndefined();
    expect(top.nextCursor).toBe('');
    const raw = (read('list-top') as { items: Array<{ updatedAt: string }> }).items[0]?.updatedAt ?? '';
    // The server writes microseconds ("…49.078963Z"): the client reads them to the millisecond.
    const at = top.items[0]?.updatedAt;
    if (!at) throw new Error('fixture: updated_at');
    expect(Math.abs(timestampMs(at) - Date.parse(raw))).toBeLessThanOrEqual(1);
  });

  it('an untitled canvas comes with an empty name and is not a folder', () => {
    expect(created.name).toBe('');
    expect(created.parentId).toBe('');
    expect(created.kind).toBe(CanvasItemKind.CANVAS);
    expect(created.myBits).toBe(OWNER);
    expect(created.ownerId).toHaveLength(36);
  });

  it('a compacted canvas carries the stored size and the preview of its text, and its share flag', () => {
    const list = fromJson(ListCanvasItemsResponseSchema, read('list-compacted')).items;
    const c = list.find((i) => i.name === 'compaction');
    expect(c?.docSize).toBeGreaterThan(100);
    expect(c?.preview).toBe('Совсем другой текст Позвонить в бухгалтерию');
    expect(list.find((i) => i.name === 'viewonly')?.shared).toBe(true);
    expect(list.find((i) => i.name === 'awareness')).toMatchObject({ docSize: 0, preview: '' });
  });

  it('feeds the store reducers: top-level order, lazily loaded children, trash roots', () => {
    const top = fromJson(ListCanvasItemsResponseSchema, read('list-top')).items;
    const kids = fromJson(ListCanvasItemsResponseSchema, read('list-children')).items;
    const trash = fromJson(ListCanvasItemsResponseSchema, read('list-trash')).items;
    const folder = top.find((i) => i.kind === CanvasItemKind.FOLDER);
    let s = applyList({ items: {}, lists: {} }, childKey(WS, ''), top);
    s = applyList(s, childKey(WS, folder?.id ?? ''), kids);
    s = applyList(s, trashKey(WS), trash);
    expect(s.lists[childKey(WS, '')]).toHaveLength(2);
    expect(s.lists[childKey(WS, folder?.id ?? '')]).toEqual([kids[0]?.id]);
    expect(kids[0]?.parentId).toBe(folder?.id);
    // The trash lists only the roots of a deletion; a folder whose children are all trashed has none left alive.
    expect(trash.map((i) => i.id)).toEqual([folder?.id]);
    expect(s.items[trash[0]?.id ?? '']).toMatchObject({ trashedRoot: true, hasChildren: false });
    expect(s.items[trash[0]?.id ?? '']?.trashedAt).toBeDefined();
  });

  it('paging: the cursor comes back as next_cursor', () => {
    expect(fromJson(ListCanvasItemsResponseSchema, read('list-page-1')).nextCursor).toBe('c-2');
  });

  it('reads the path, a rename, a move and a trash answer', () => {
    expect(fromJson(CanvasPathResponseSchema, read('path')).items.map((i) => i.name)).toEqual(['Продукт', 'Дорожная карта']);
    expect(item('patch-rename').name).toBe('Дорожная карта Q1');
    const moved = item('patch');
    expect([moved.name, moved.position, moved.parentId]).toEqual(['Дорожная карта Q1', 0, '']);
    expect(item('patch-move').parentId).toHaveLength(36);
    const trashed = item('trash');
    expect(trashed.trashedRoot).toBe(true);
    expect(trashed.trashedBy).toBe(ME);
    expect(trashed.trashedAt && timestampMs(trashed.trashedAt)).toBeGreaterThan(0);
    const priv = item('patch-restricted');
    expect([priv.restricted, priv.name]).toEqual([true, 'Secret']);
    expect(item('take-over').ownerId).toBe(ME);
  });

  it("the rights helpers read the server bits: write edits, the structure is the owner's or MANAGE's", () => {
    const own = item('patch');
    expect(canWrite(own.myBits)).toBe(true);
    expect(canStructure(own, ME)).toBe(true); // ME owns it
    expect(canStructure(own, 'someone-else')).toBe(true); // …and holds MANAGE
    // Bob's view of Alice's canvas with a «deny write» override: view only, shared, nothing structural.
    const view = item('get-view-only');
    expect(view.myBits).toBe(CANVAS_BITS.VIEW);
    expect(view.shared).toBe(true);
    expect(view.ownerId).toBe(ME);
    expect(canWrite(view.myBits)).toBe(false);
    expect(canStructure(view, 'someone-else')).toBe(false);
  });

  it('reads the access: allow / deny bits within CANVAS_VIEW | CANVAS_WRITE, the restricted switch', () => {
    const p = fromJson(CanvasPermissionsResponseSchema, read('perms'));
    expect(p.restricted).toBe(false);
    const [user] = p.entries;
    if (!user) throw new Error('fixture');
    expect(p.entries).toHaveLength(1);
    expect(user.targetType).toBe(PermissionTargetType.USER);
    expect(user.targetId).toHaveLength(36);
    expect([user.allow, user.deny]).toEqual([0n, CANVAS_BITS.WRITE]);
  });

  it('reads the versions (newest first, authors, size) and the empty list', () => {
    const vs = fromJson(CanvasVersionsResponseSchema, read('versions')).versions;
    expect(vs).toHaveLength(1);
    expect(vs[0]?.size).toBeGreaterThan(20);
    expect(vs[0]?.authorIds).toHaveLength(1);
    expect(vs[0]?.canvasId).toHaveLength(36);
    expect(vs[0]?.createdAt && timestampMs(vs[0].createdAt)).toBeGreaterThan(0);
    expect(fromJson(CanvasVersionsResponseSchema, read('versions-empty')).versions).toEqual([]);
  });

  it('reads the settings, the emptied trash and the journal (kinds, newest first, before / after)', () => {
    expect(fromJson(CanvasSettingsSchema, read('settings')).trashDays).toBe(7);
    expect(fromJson(EmptyCanvasTrashResponseSchema, read('trash-empty')).deleted).toBe(1);
    const acts = fromJson(CanvasActivityPageSchema, read('activity')).activities;
    expect(acts.map((a) => a.kind)).toEqual([
      CanvasActivityKind.SHARE,
      CanvasActivityKind.SHARE,
      CanvasActivityKind.MOVE,
      CanvasActivityKind.MOVE,
      CanvasActivityKind.RENAME,
      CanvasActivityKind.CREATE,
    ]);
    const rename = acts[4];
    expect([rename?.before, rename?.after]).toEqual([{ name: 'Дорожная карта' }, { name: 'Дорожная карта Q1' }]);
    expect(rename?.itemName).toBe('Дорожная карта Q1');
    expect(acts[5]?.before).toBeUndefined();
    expect(acts[5]?.after).toMatchObject({ kind: 'canvas', name: 'Дорожная карта', parent_name: 'Продукт' });
    expect(acts[0]?.after).toEqual({ entries: [], restricted: false });
    expect(acts[1]?.after).toMatchObject({ entries: [{ target_type: 'user', deny: 4398046511104 }] });
    expect(acts.every((a) => a.actorId === ME && a.itemId.length === 36)).toBe(true);
    const ws = fromJson(CanvasActivityPageSchema, read('activity-workspace')).activities;
    expect(ws.length).toBeGreaterThan(acts.length); // the workspace journal holds every item's entries
    expect(ws.map((a) => a.kind)).toContain(CanvasActivityKind.CREATE);
  });

  it('reads the search section of type canvas: a canvas hit (path, highlighted snippet), a folder hit, a text hit', () => {
    const s = fromJson(SearchResponseSchema, read('search')).sections[0];
    expect(s?.type).toBe(SearchType.CANVAS);
    const hit = s?.items[0];
    expect(hit?.title).toBe('Дорожная карта Q1');
    expect(hit?.ref.case === 'canvas' && [hit.ref.value.folder, hit.ref.value.path, hit.ref.value.itemId.length]).toEqual([false, ['Продукт'], 36]);
    expect(snippetText(hit?.snippet ?? '')).toBe('Дорожная карта');
    const folder = fromJson(SearchResponseSchema, read('search-folder')).sections[0]?.items[0];
    expect(folder?.ref.case === 'canvas' && [folder.ref.value.folder, folder.ref.value.path]).toEqual([true, []]);
    // A hit in the text of an object (plain_text of the snapshot meta): the title is the canvas's name.
    const text = fromJson(SearchResponseSchema, read('search-text')).sections[0]?.items[0];
    expect(text?.title).toBe('compaction');
    expect(snippetText(text?.snippet ?? '')).toBe('Купить молоко\nПозвонить в бухгалтерию');
  });

  it('error bodies are {code, message[, field]}', () => {
    expect(read('not-found')).toMatchObject({ code: 'ERROR_CODE_NOT_FOUND' });
    expect(read('forbidden')).toMatchObject({ code: 'ERROR_CODE_FORBIDDEN' });
  });
});
