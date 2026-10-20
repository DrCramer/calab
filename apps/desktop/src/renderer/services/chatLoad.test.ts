import { create } from '@bufbuild/protobuf';
import { MessageSchema, type Message } from '@calaba/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// docs/09 #146: the first load of a room must never leave the chat on a spinner forever.

type Page = { messages: Message[]; hasMore: boolean };
const list = vi.fn<(roomId: string, p: { before?: string; after?: string; limit?: number }, signal?: AbortSignal) => Promise<Page>>();
vi.mock('../lib/api/endpoints', () => ({
  api: { messages: { list: (roomId: string, p: { before?: string; after?: string; limit?: number }, signal?: AbortSignal) => list(roomId, p, signal) } },
  uploadFile: vi.fn(),
}));
vi.mock('./gateway', () => ({ sendTyping: () => undefined }));
vi.mock('../stores/toasts', () => ({ toast: { fail: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../platform', () => ({ platform: { kind: 'web', app: { log: () => undefined } } }));

const { openRoom, reloadRoom, retryFailedLoads, resetChatCaches, LOAD_TIMEOUT_MS, STALE_LOAD_MS } = await import('./chat');
const { useMessages } = await import('../stores/messages');
const { useRooms } = await import('../stores/rooms');

const A = 'room-a';
const B = 'room-b';
const msg = (roomId: string, id: string): Message => create(MessageSchema, { id, roomId, authorId: 'u', content: id });
const page = (roomId: string, ...ids: string[]): Page => ({ messages: ids.map((id) => msg(roomId, id)), hasMore: false });
const st = (roomId: string) => useMessages.getState().rooms[roomId];

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A request that never answers (a stalled connection): only its AbortSignal ends it. */
function hang(signal?: AbortSignal): Promise<Page> {
  return new Promise((_res, rej) => signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
}

beforeEach(() => {
  vi.useFakeTimers();
  resetChatCaches();
  useMessages.getState().reset();
  useRooms.setState({ readState: {}, lastMessage: {} });
  list.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('room first load (docs/09 #146)', () => {
  it('a stalled request ends in the error state after the timeout, and opening again retries', async () => {
    list.mockImplementationOnce((_r, _p, signal) => hang(signal));
    const first = openRoom(A);
    expect(st(A)?.loading).toBe(true);
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS + 1);
    await first;
    expect(st(A)?.loading).toBe(false);
    expect(st(A)?.loaded).toBe(false);
    expect(st(A)?.error).toBeTruthy();

    // Before the fix the room stayed in the in-flight set: every later open was a no-op.
    list.mockResolvedValueOnce(page(A, '0002', '0001'));
    await openRoom(A);
    expect(list).toHaveBeenCalledTimes(2);
    expect(st(A)?.loaded).toBe(true);
    expect(st(A)?.items.map((c) => c.key)).toEqual(['0001', '0002']);
  });

  it('opening a room whose load has been pending > STALE_LOAD_MS re-issues the fetch', async () => {
    const stuck = deferred<Page>();
    list.mockReturnValueOnce(stuck.promise);
    void openRoom(A);
    await openRoom(A); // a remount right away: deduped
    expect(list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(STALE_LOAD_MS + 1);
    list.mockResolvedValueOnce(page(A, '0001'));
    await openRoom(A);
    expect(list).toHaveBeenCalledTimes(2);
    expect(st(A)?.loaded).toBe(true);
  });

  it('«Повторить» while the first request still hangs sends a new one; the late first answer is dropped', async () => {
    const late = deferred<Page>();
    list.mockReturnValueOnce(late.promise);
    void openRoom(A);
    list.mockResolvedValueOnce(page(A, '0003', '0002'));
    await reloadRoom(A);
    expect(list).toHaveBeenCalledTimes(2);
    expect(st(A)?.items.map((c) => c.key)).toEqual(['0002', '0003']);
    late.resolve(page(A, '0001'));
    await vi.advanceTimersByTimeAsync(0);
    expect(st(A)?.items.map((c) => c.key)).toEqual(['0002', '0003']);
    expect(st(A)?.loading).toBe(false);
  });

  it('a fast switch A → B → A still ends with A loaded', async () => {
    const a = deferred<Page>();
    list.mockReturnValueOnce(a.promise).mockResolvedValueOnce(page(B, '0010'));
    void openRoom(A);
    await openRoom(B);
    await openRoom(A); // remount of A's chat while its request is in flight
    a.resolve(page(A, '0001'));
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(2);
    expect(st(A)?.loaded).toBe(true);
    expect(st(B)?.loaded).toBe(true);
  });

  it('with unread messages the room still loads its newest page (CBF-31: opens at the latest message)', async () => {
    useRooms.setState({ readState: { [A]: '0001' }, lastMessage: { [A]: '0005' } });
    list.mockResolvedValueOnce({ messages: ['0005', '0004', '0003', '0002', '0001'].map((id) => msg(A, id)), hasMore: true });
    await openRoom(A);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0]?.[1]).not.toHaveProperty('after');
    expect(st(A)?.hasMoreAfter).toBe(false);
    expect(st(A)?.items.at(-1)?.key).toBe('0005');
  });

  it('with unread messages a stalled load ends in the error state', async () => {
    useRooms.setState({ readState: { [A]: '0001' }, lastMessage: { [A]: '0005' } });
    list.mockImplementation((_r, _p, signal) => hang(signal));
    const p = openRoom(A);
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS + 1);
    await p;
    expect(st(A)?.loading).toBe(false);
    expect(st(A)?.error).toBeTruthy();
  });

  it('a reconnect retries rooms whose first load failed, not the loaded ones', async () => {
    list.mockRejectedValueOnce(new Error('offline'));
    await openRoom(A);
    expect(st(A)?.error).toBeTruthy();
    list.mockResolvedValueOnce(page(B, '0010'));
    await openRoom(B);
    list.mockResolvedValueOnce(page(A, '0001'));
    await retryFailedLoads();
    expect(list).toHaveBeenCalledTimes(3);
    expect(list.mock.calls[2]?.[0]).toBe(A);
    expect(st(A)?.loaded).toBe(true);
  });
});
