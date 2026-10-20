import { create } from '@bufbuild/protobuf';
import { MessageSchema } from '@calaba/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { opensAwayFromPresent, reactWith, useMessages, type RoomMessages } from './messages';

const msg = (id: string, nonce = '', content = id) => create(MessageSchema, { id, roomId: 'r', authorId: 'u', content, nonce });
const keys = (): string[] => useMessages.getState().rooms['r']?.items.map((c) => c.key) ?? [];

beforeEach(() => {
  useMessages.getState().reset();
  useMessages.getState().prependPage('r', [msg('0002'), msg('0001')], true); // API: newest first
});

describe('opensAwayFromPresent (CBF-31)', () => {
  const win = (hasMoreAfter: boolean, loaded = true): RoomMessages => ({ items: [], hasMoreBefore: true, hasMoreAfter, loading: false, loaded, error: null, base: 0 });

  it('a loaded window left away from the present reloads the present before the feed opens', () => {
    expect(opensAwayFromPresent(win(true), false)).toBe(true);
  });

  it('a window at the present, or a room not loaded yet: the feed opens as is', () => {
    expect(opensAwayFromPresent(win(false), false)).toBe(false);
    expect(opensAwayFromPresent(win(true, false), false)).toBe(false);
    expect(opensAwayFromPresent(undefined, false)).toBe(false);
  });

  it('back from a phone screen pushed over the room: its window is where the reader left it', () => {
    expect(opensAwayFromPresent(win(true), true)).toBe(false);
  });
});

describe('messages store', () => {
  it('pages are stored oldest-first and prepending older pages dedupes', () => {
    expect(keys()).toEqual(['0001', '0002']);
    useMessages.getState().prependPage('r', [msg('0001'), msg('0000')], false);
    expect(keys()).toEqual(['0000', '0001', '0002']);
    expect(useMessages.getState().rooms['r']?.hasMoreBefore).toBe(false);
  });

  it('server echo replaces the optimistic message by nonce (no duplicate)', () => {
    const s = useMessages.getState();
    s.addPending('r', { key: 'local:n1', msg: msg('', 'n1', 'hi'), status: 'pending' });
    expect(keys()).toEqual(['0001', '0002', 'local:n1']);
    s.upsert(msg('0003', 'n1', 'hi')); // POST response or MESSAGE_CREATE, whichever first
    s.upsert(msg('0003', 'n1', 'hi')); // the other one
    expect(keys()).toEqual(['0001', '0002', '0003']);
    expect(useMessages.getState().rooms['r']?.items[2]?.status).toBe('sent');
  });

  it('messages from others land before my still-pending ones', () => {
    const s = useMessages.getState();
    s.addPending('r', { key: 'local:n2', msg: msg('', 'n2'), status: 'pending' });
    s.upsert(msg('0005'));
    expect(keys()).toEqual(['0001', '0002', '0005', 'local:n2']);
  });

  it('out-of-order delivery is sorted by id; edits replace in place; delete removes', () => {
    const s = useMessages.getState();
    s.upsert(msg('0004'));
    s.upsert(msg('0003'));
    expect(keys()).toEqual(['0001', '0002', '0003', '0004']);
    s.upsert(msg('0003', '', 'edited'));
    expect(useMessages.getState().rooms['r']?.items.find((c) => c.key === '0003')?.msg.content).toBe('edited');
    s.remove('r', '0003');
    expect(keys()).toEqual(['0001', '0002', '0004']);
  });

  it('events for rooms that are not loaded are ignored (fetched fresh on open)', () => {
    useMessages.getState().upsert(create(MessageSchema, { id: '9', roomId: 'other' }));
    expect(useMessages.getState().rooms['other']).toBeUndefined();
  });

  it('own messages: the POST response and the gateway echo (either order) leave one sent message', () => {
    const s = useMessages.getState();
    s.addPending('r', { key: 'local:n3', msg: msg('', 'n3'), status: 'pending' });
    s.upsert(msg('0006', 'n3'), { rest: true });
    s.upsert(msg('0006', 'n3'));
    s.upsert(msg('0006', 'n3'), { rest: true }); // late POST response
    const own = useMessages.getState().rooms['r']?.items.filter((c) => c.msg.nonce === 'n3');
    expect(own).toHaveLength(1);
    expect(own?.[0]).toMatchObject({ key: '0006', status: 'sent' });
  });

  it('an older window ignores new messages beyond its end; appendPage grows it', () => {
    const s = useMessages.getState();
    s.setWindow('r', [msg('0001'), msg('0002')], true, true);
    s.upsert(msg('0009'));
    expect(keys()).toEqual(['0001', '0002']);
    s.appendPage('r', [msg('0003'), msg('0009')], false);
    expect(keys()).toEqual(['0001', '0002', '0003', '0009']);
    expect(useMessages.getState().rooms['r']?.hasMoreAfter).toBe(false);
  });

  it('reactions: optimistic toggle + echo count once; events keep my flag', () => {
    const s = useMessages.getState();
    const reactions = () => useMessages.getState().rooms['r']?.items[0]?.msg.reactions ?? [];
    s.applyReaction('r', '0001', '👍', true, true); // optimistic
    s.applyReaction('r', '0001', '👍', true, true); // echo
    s.applyReaction('r', '0001', '👍', true, false); // someone else
    expect(reactions().map((r) => [r.emoji, r.count, r.me])).toEqual([['👍', 2, true]]);
    s.upsert({ ...msg('0001'), reactions: [{ $typeName: 'calaba.v1.Reaction', emoji: '👍', count: 2, me: false }] });
    expect(reactions()[0]?.me).toBe(true);
    s.applyReaction('r', '0001', '👍', false, true);
    s.applyReaction('r', '0001', '👍', false, true);
    expect(reactions().map((r) => [r.emoji, r.count, r.me])).toEqual([['👍', 1, false]]);
  });

  it('reactWith removes the chip at zero', () => {
    const one = reactWith([], '🎉', true, false);
    expect(reactWith(one, '🎉', false, false)).toEqual([]);
  });

  it('pins follow MESSAGE_UPDATE and deletes', () => {
    const s = useMessages.getState();
    s.setPins('r', []);
    const pinned = { ...msg('0002'), pinnedAt: { $typeName: 'google.protobuf.Timestamp' as const, seconds: 10n, nanos: 0 } };
    s.upsert(pinned);
    expect(useMessages.getState().pins['r']?.map((m) => m.id)).toEqual(['0002']);
    s.upsert(msg('0002'));
    expect(useMessages.getState().pins['r']).toEqual([]);
    s.upsert(pinned);
    s.remove('r', '0002');
    expect(useMessages.getState().pins['r']).toEqual([]);
  });
});

describe('resync after a fresh IDENTIFY (mergeLatest)', () => {
  it('adds missed messages, applies edits and deletions in the covered range, keeps older ones', () => {
    const s = useMessages.getState();
    s.prependPage('r', [msg('0000')], true); // window: 0000 0001 0002
    // Server now: 0001 edited, 0002 deleted, 0003 + 0004 new. Newest page covers 0001..0004.
    s.resyncLatest('r', [msg('0004'), msg('0003'), msg('0001', '', 'edited')], true);
    expect(keys()).toEqual(['0000', '0001', '0003', '0004']);
    expect(useMessages.getState().rooms['r']?.items[1]?.msg.content).toBe('edited');
    expect(useMessages.getState().rooms['r']?.hasMoreBefore).toBe(true);
  });

  it('a gap larger than the page replaces the window (no hole)', () => {
    useMessages.getState().resyncLatest('r', [msg('0100'), msg('0099')], true);
    expect(keys()).toEqual(['0099', '0100']);
    expect(useMessages.getState().rooms['r']?.hasMoreBefore).toBe(true);
  });

  it('keeps pending messages at the end and leaves unloaded / old-history windows alone', () => {
    const s = useMessages.getState();
    s.addPending('r', { key: 'local:n1', msg: msg('', 'n1', 'hi'), status: 'pending' });
    s.resyncLatest('r', [msg('0003'), msg('0002')], false);
    expect(keys()).toEqual(['0001', '0002', '0003', 'local:n1']);
    s.resyncLatest('other', [msg('0005')], false);
    expect(useMessages.getState().rooms['other']).toBeUndefined();
    s.setWindow('r', [msg('0001')], true, true); // browsing old history
    s.resyncLatest('r', [msg('0009')], false);
    expect(keys()).toEqual(['0001', 'local:n1']);
  });
});
