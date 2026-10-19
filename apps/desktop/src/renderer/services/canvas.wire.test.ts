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

/**
 * The JSON of the Canvas routes as the Go server's protojson writes it (canvas.proto; enums by name,
 * 64-bit integers as strings, defaults omitted, timestamps RFC 3339). The files in
 * __fixtures__/canvas are written by hand after the contract — until the walk against the live
 * server (task H8) replaces them with captured answers, the client's schemas and reducers must read
 * them as they are, without fallbacks.
 */
const files = import.meta.glob('./__fixtures__/canvas/*.json', { eager: true, import: 'default' });
const read = (name: string): JsonValue => files[`./__fixtures__/canvas/${name}.json`] as JsonValue;
const OWNER = CANVAS_BITS.VIEW | CANVAS_BITS.WRITE | CANVAS_BITS.MANAGE;
const WS = '0190a0b0-0000-7000-8000-000000000001';
const ME = '0190a0b0-0000-7000-8000-0000000000a1';

describe('Canvas wire format of the server', () => {
  it('reads the top level: kinds, order, bits, has_children, sizes, the preview', () => {
    const top = fromJson(ListCanvasItemsResponseSchema, read('list-top'));
    expect(top.items.map((i) => i.name)).toEqual(['Продукт', 'Дорожная карта', '']);
    expect(top.items.map((i) => i.kind)).toEqual([CanvasItemKind.FOLDER, CanvasItemKind.CANVAS, CanvasItemKind.CANVAS]);
    expect(top.items[0]?.hasChildren).toBe(true);
    expect(top.items[0]?.myBits).toBe(OWNER);
    expect(top.items[1]?.myBits).toBe(CANVAS_BITS.VIEW | CANVAS_BITS.WRITE);
    expect(top.items[1]?.docSize).toBe(2048);
    expect(top.items[1]?.preview).toContain('Холст');
    expect(top.items[1]?.shared).toBe(true);
    expect(top.items[1]?.updatedAt && timestampMs(top.items[1].updatedAt)).toBe(Date.parse('2026-10-19T10:30:00Z'));
    expect(top.nextCursor).toBe('');
  });

  it('an untitled canvas comes with an empty name and is not a folder', () => {
    const made = fromJson(CanvasItemResponseSchema, read('create-untitled')).item;
    expect(made?.name).toBe('');
    expect(made?.parentId).toBe('');
    expect(made?.kind).toBe(CanvasItemKind.CANVAS);
    expect(made?.myBits).toBe(OWNER);
  });

  it('feeds the store reducers: top-level order, lazily loaded children, trash roots', () => {
    const top = fromJson(ListCanvasItemsResponseSchema, read('list-top')).items;
    const kids = fromJson(ListCanvasItemsResponseSchema, read('list-children')).items;
    const trash = fromJson(ListCanvasItemsResponseSchema, read('list-trash')).items;
    let s = applyList({ items: {}, lists: {} }, childKey(WS, ''), top);
    s = applyList(s, childKey(WS, top[0]?.id ?? ''), kids);
    s = applyList(s, trashKey(WS), trash);
    expect(s.lists[childKey(WS, '')]).toHaveLength(3);
    expect(s.lists[childKey(WS, top[0]?.id ?? '')]).toEqual([kids[0]?.id]);
    expect(s.items[trash[0]?.id ?? '']).toMatchObject({ trashedRoot: true, hasChildren: true });
    expect(s.items[trash[0]?.id ?? '']?.trashedAt).toBeDefined();
  });

  it('paging: the cursor comes back as next_cursor', () => {
    expect(fromJson(ListCanvasItemsResponseSchema, read('list-page-1')).nextCursor).toBe('c-2');
  });

  it('reads the path, a rename + move and a trash answer', () => {
    expect(fromJson(CanvasPathResponseSchema, read('path')).items.map((i) => i.name)).toEqual(['Продукт', 'Дорожная карта']);
    const patched = fromJson(CanvasItemResponseSchema, read('patch')).item;
    expect([patched?.name, patched?.position]).toEqual(['Дорожная карта Q1', 0]);
    expect(patched?.parentId).toHaveLength(36);
    const trashed = fromJson(CanvasItemResponseSchema, read('trash')).item;
    expect(trashed?.trashedRoot).toBe(true);
    expect(trashed?.trashedBy).toBe(ME);
  });

  it("the rights helpers read the server bits: write edits, the structure is the owner's or MANAGE's", () => {
    const [folder, canvas] = fromJson(ListCanvasItemsResponseSchema, read('list-top')).items;
    if (!folder || !canvas) throw new Error('fixture');
    expect(canWrite(canvas.myBits)).toBe(true);
    expect(canStructure(canvas, ME)).toBe(true); // ME owns it
    expect(canStructure(canvas, 'someone-else')).toBe(false); // VIEW|WRITE without MANAGE
    expect(canStructure(folder, 'someone-else')).toBe(true); // MANAGE
  });

  it('reads the access: allow / deny bits within CANVAS_VIEW | CANVAS_WRITE, the restricted switch', () => {
    const p = fromJson(CanvasPermissionsResponseSchema, read('perms'));
    expect(p.restricted).toBe(true);
    const [user, role] = p.entries;
    if (!user || !role) throw new Error('fixture');
    expect(user.targetType).toBe(PermissionTargetType.USER);
    expect(user.allow).toBe(CANVAS_BITS.VIEW | CANVAS_BITS.WRITE);
    expect(role.targetType).toBe(PermissionTargetType.ROLE);
    expect([role.allow, role.deny]).toEqual([CANVAS_BITS.VIEW, CANVAS_BITS.WRITE]);
  });

  it('reads the versions (newest first, authors, size) and the empty list', () => {
    const vs = fromJson(CanvasVersionsResponseSchema, read('versions')).versions;
    expect(vs.map((v) => v.size)).toEqual([1234, 900]);
    expect(vs[0]?.authorIds).toHaveLength(2);
    expect(vs[0]?.canvasId).toHaveLength(36);
    expect(fromJson(CanvasVersionsResponseSchema, read('versions-empty')).versions).toEqual([]);
  });

  it('reads the settings, the emptied trash and the journal kinds', () => {
    expect(fromJson(CanvasSettingsSchema, read('settings')).trashDays).toBe(7);
    expect(fromJson(EmptyCanvasTrashResponseSchema, read('trash-empty')).deleted).toBe(2);
    expect(fromJson(CanvasActivityPageSchema, read('activity')).activities.map((a) => a.kind)).toEqual([CanvasActivityKind.CREATE, CanvasActivityKind.VERSION]);
  });

  it('reads the search section of type canvas: a canvas hit and a folder hit', () => {
    const s = fromJson(SearchResponseSchema, read('search')).sections[0];
    expect(s?.type).toBe(SearchType.CANVAS);
    const [hit, folder] = s?.items ?? [];
    expect(hit?.ref.case === 'canvas' && [hit.ref.value.folder, hit.ref.value.path]).toEqual([false, ['Продукт']]);
    expect(folder?.ref.case === 'canvas' && folder.ref.value.folder).toBe(true);
  });

  it('error bodies are {code, message}', () => {
    expect(read('not-found')).toMatchObject({ code: 'ERROR_CODE_NOT_FOUND' });
  });
});
