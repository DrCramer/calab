import { describe, expect, it } from 'vitest';
import { chatFollow, followTarget, type FollowView } from './chatFollow';

const view = (over: Partial<FollowView> = {}): FollowView => ({ phone: false, shownRoomId: 'chat', rememberedRoomId: 'chat', covered: false, ...over });
const join = { kind: 'join', workspaceId: 'ws', roomId: 'A' } as const;
const moved = { kind: 'moved', workspaceId: 'ws', fromRoomId: 'A', toRoomId: 'B' } as const;

describe('chatFollow (issue #127)', () => {
  it('my join opens the room chat unless it is already on screen', () => {
    expect(chatFollow(join, view())).toBe('open');
    expect(chatFollow(join, view({ shownRoomId: null }))).toBe('open');
    expect(chatFollow(join, view({ shownRoomId: 'A' }))).toBe('none');
    expect(followTarget(join)).toBe('A');
  });

  it('a reload resume, a 1:1 call, a join without a workspace and a phone do not switch', () => {
    expect(chatFollow({ ...join, resumed: true }, view())).toBe('none');
    expect(chatFollow({ ...join, call: true }, view())).toBe('none');
    expect(chatFollow({ ...join, workspaceId: '' }, view())).toBe('none');
    expect(chatFollow(join, view({ phone: true }))).toBe('none');
  });

  it('an open task / mail / DM is not taken away: the room is only remembered', () => {
    expect(chatFollow(join, view({ covered: true }))).toBe('remember');
    expect(chatFollow(join, view({ covered: true, rememberedRoomId: 'A' }))).toBe('none');
  });

  it('a move follows only from the room I was moved out of', () => {
    expect(chatFollow(moved, view({ shownRoomId: 'A', rememberedRoomId: 'A' }))).toBe('open');
    expect(followTarget(moved)).toBe('B');
    // Another chat on screen: the user's choice stays.
    expect(chatFollow(moved, view())).toBe('none');
    // Covered, the source remembered: leaving the view lands in the target.
    expect(chatFollow(moved, view({ covered: true, shownRoomId: 'A', rememberedRoomId: 'A' }))).toBe('remember');
    // Phone: only the screen on top follows.
    expect(chatFollow(moved, view({ phone: true, shownRoomId: 'A', rememberedRoomId: 'A' }))).toBe('open');
    expect(chatFollow(moved, view({ phone: true, shownRoomId: null, rememberedRoomId: 'A' }))).toBe('none');
    expect(chatFollow({ ...moved, toRoomId: 'A' }, view({ shownRoomId: 'A' }))).toBe('none');
  });
});
