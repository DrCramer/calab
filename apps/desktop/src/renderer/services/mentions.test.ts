import { create } from '@bufbuild/protobuf';
import { MessageSchema, TaskNoticeEntrySchema } from '@calaba/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});
vi.stubGlobal('document', { hasFocus: () => true });

const api = vi.hoisted(() => ({ mentions: vi.fn(), taskNotices: vi.fn() }));
vi.mock('../lib/api/endpoints', () => ({ api: { me: api } }));
vi.mock('../stores/toasts', () => ({ toast: { info: vi.fn(), error: vi.fn() } }));
vi.mock('../lib/log', () => ({ log: { warn: () => undefined } }));
vi.mock('../platform', () => ({ platform: { kind: 'web', app: { log: () => undefined } } }));

const { loadMentions } = await import('./mentions');
const { useRooms } = await import('../stores/rooms');
const { useInbox } = await import('../stores/inbox');

const id = (n: number): string => `0190a0b0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const mention = (roomId: string, n: number) => create(MessageSchema, { id: id(n), roomId, authorId: 'other' });
const m = (mid: string) => create(MessageSchema, { id: mid, roomId: 'a' });
const n = (nid: string) => create(TaskNoticeEntrySchema, { id: nid, taskId: 't' });

beforeEach(() => {
  useRooms.getState().reset();
  useInbox.getState().reset();
  api.mentions.mockReset();
  api.taskNotices.mockReset();
  api.taskNotices.mockResolvedValue({ entries: [], hasMore: false });
});

describe('loadMentions (review N7)', () => {
  it('fills the inbox list only: badges come from the read-state counters, never from history', async () => {
    api.mentions.mockResolvedValue({ messages: [mention('open', 5), mention('other', 6)], hasMore: false });
    await loadMentions();
    expect(useInbox.getState().items).toHaveLength(2);
    expect(useRooms.getState().mentions).toEqual({}); // no phantom badge on the open room
  });
});

describe('loadMentions (ADR-0141)', () => {
  it('loads chat mentions and task notices side by side', async () => {
    api.mentions.mockResolvedValue({ messages: [m('04')], hasMore: false });
    api.taskNotices.mockResolvedValue({ entries: [n('05')], hasMore: true });
    await loadMentions();
    const s = useInbox.getState();
    expect(s.loaded).toBe(true);
    expect(s.items.map((x) => x.id)).toEqual(['04']);
    expect(s.notices.map((x) => x.id)).toEqual(['05']);
    expect(s.noticesHasMore).toBe(true);
    // Older: only the list that has more pages on, from its oldest id.
    api.taskNotices.mockResolvedValue({ entries: [n('01')], hasMore: false });
    await loadMentions(true);
    expect(api.mentions).toHaveBeenCalledTimes(1);
    expect(api.taskNotices).toHaveBeenLastCalledWith({ limit: 30, before: '05' });
    expect(useInbox.getState().notices.map((x) => x.id)).toEqual(['05', '01']);
  });

  it('pages task notices by next_before, past a page of tasks hidden now', async () => {
    api.mentions.mockResolvedValue({ messages: [], hasMore: false });
    // The whole first page is of tasks the caller no longer sees: no entries, a cursor.
    api.taskNotices.mockResolvedValue({ entries: [], hasMore: true, nextBefore: '09' });
    await loadMentions();
    expect(useInbox.getState().noticesHasMore).toBe(true);
    api.taskNotices.mockResolvedValue({ entries: [n('07'), n('06')], hasMore: true, nextBefore: '03' });
    await loadMentions(true);
    expect(api.taskNotices).toHaveBeenLastCalledWith({ limit: 30, before: '09' });
    api.taskNotices.mockResolvedValue({ entries: [n('02')], hasMore: false, nextBefore: '' });
    await loadMentions(true);
    expect(api.taskNotices).toHaveBeenLastCalledWith({ limit: 30, before: '03' });
    expect(useInbox.getState().notices.map((x) => x.id)).toEqual(['07', '06', '02']);
    expect(useInbox.getState().noticesHasMore).toBe(false);
  });

  it('one failing list does not empty the other', async () => {
    api.mentions.mockRejectedValue(new Error('down'));
    api.taskNotices.mockResolvedValue({ entries: [n('05')], hasMore: false });
    await loadMentions();
    const s = useInbox.getState();
    expect(s.loaded).toBe(true);
    expect(s.loading).toBe(false);
    expect(s.notices).toHaveLength(1);
  });
});
