import { create } from '@bufbuild/protobuf';
import { CanvasItemKind, CanvasItemSchema, DispatchEventSchema, WorkspaceDeleteSchema, WorkspaceRole, WorkspaceSchema, type CanvasItem, type DispatchEvent } from '@calaba/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});
vi.stubGlobal('document', { hasFocus: () => false, addEventListener: vi.fn(), visibilityState: 'visible' });
vi.stubGlobal('window', globalThis);

vi.mock('./voice', () => ({ voice: { leave: vi.fn(), currentRoomId: null, onMoved: vi.fn(), reconcileSelfState: vi.fn(), stopStream: vi.fn(), checkSeat: vi.fn(), refreshRights: vi.fn() } }));
vi.mock('./chat', () => ({ clearChatRooms: vi.fn(), resyncLoadedRooms: vi.fn(() => Promise.resolve()), resyncPins: vi.fn(() => Promise.resolve()), retryFailedLoads: vi.fn(() => Promise.resolve()) }));
vi.mock('./mentions', () => ({ loadMentions: () => Promise.resolve() }));
vi.mock('./notify', () => ({ onIncomingMessage: vi.fn(), mentionsMe: () => false }));
vi.mock('./profile', () => ({ applyUserSettings: vi.fn() }));
vi.mock('./gateway', () => ({ pruneGatewaySubscriptions: vi.fn() }));
vi.mock('../stores/toasts', () => ({ toast: { info: vi.fn(), error: vi.fn() } }));
vi.mock('../platform', () => ({ platform: { kind: 'web', app: { log: () => undefined }, clearProtectedMedia: vi.fn() } }));

const { applyDispatch } = await import('./dispatch');
const { useCanvas } = await import('../stores/canvas');
const { useCanvasUi } = await import('../stores/canvasUi');
const { useUi } = await import('../stores/ui');
const { useWorkspaces } = await import('../stores/workspaces');
const { childKey } = await import('../lib/canvas/tree');

const WS = 'ws-1';
const ev = (event: DispatchEvent['event']): DispatchEvent => create(DispatchEventSchema, { event });
const item = (id: string, extra: Omit<Partial<CanvasItem>, '$typeName' | '$unknown'> = {}): CanvasItem => create(CanvasItemSchema, { id, workspaceId: WS, kind: CanvasItemKind.CANVAS, name: id, ...extra });

beforeEach(() => {
  useCanvas.setState({ items: {}, lists: {}, load: {} });
  useCanvasUi.setState({ active: false, itemOf: {}, trashOf: {}, expanded: {}, query: '', renaming: null, dialog: null });
  useWorkspaces.getState().reset();
  useUi.setState({ activeWorkspaceId: WS });
});

describe('dispatch CANVAS_ITEM_*', () => {
  it('an upsert of a known item updates it (rights of the recipient included)', () => {
    useCanvas.getState().put([item('c', { name: 'old', myBits: 1n })]);
    applyDispatch(ev({ case: 'canvasItemUpsert', value: { workspaceId: WS, item: item('c', { name: 'new', myBits: 7n }), access: [], accessBefore: [] } as never }));
    expect(useCanvas.getState().items['c']).toMatchObject({ name: 'new', myBits: 7n });
  });

  it('on screen an upsert lands in its loaded list at its position', () => {
    useCanvasUi.setState({ active: true });
    useCanvas.getState().setList(childKey(WS, ''), [item('a')]);
    applyDispatch(ev({ case: 'canvasItemUpsert', value: { workspaceId: WS, item: item('b', { position: 1 }) } as never }));
    expect(useCanvas.getState().lists[childKey(WS, '')]).toEqual(['a', 'b']);
  });

  it('a remove takes the item away and closes it when open', () => {
    useCanvas.getState().setList(childKey(WS, ''), [item('a'), item('b')]);
    useCanvasUi.setState({ active: true, itemOf: { [WS]: 'a' } });
    applyDispatch(ev({ case: 'canvasItemRemove', value: { workspaceId: WS, itemId: 'a', parentId: '' } as never }));
    expect(useCanvas.getState().items['a']).toBeUndefined();
    expect(useCanvasUi.getState().itemOf[WS]).toBe('');
  });

  it('deleting the workspace drops its canvas items', () => {
    useWorkspaces.setState({ order: [WS], byId: { [WS]: { ws: create(WorkspaceSchema, { id: WS }), role: WorkspaceRole.MEMBER } as never } });
    useCanvas.getState().setList(childKey(WS, ''), [item('a')]);
    useCanvas.getState().setList('ws-2/top', [item('z', { workspaceId: 'ws-2' })]);
    applyDispatch(ev({ case: 'workspaceDelete', value: create(WorkspaceDeleteSchema, { workspaceId: WS }) }));
    expect(Object.keys(useCanvas.getState().items)).toEqual(['z']);
  });
});
