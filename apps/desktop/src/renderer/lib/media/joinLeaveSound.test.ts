import { create } from '@bufbuild/protobuf';
import { RoomMediaSettingsSchema } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { DEFAULT_JOIN_LEAVE_SOUND_MAX, joinLeaveCue, joinLeaveSoundMax } from './joinLeaveSound';

const users = (n: number) => Array.from({ length: n }, (_, i) => `u${i}`);

describe('joinLeaveSoundMax', () => {
  it('unset (older server, DM call, no media) = 10; 0 stays 0', () => {
    expect(joinLeaveSoundMax(undefined)).toBe(DEFAULT_JOIN_LEAVE_SOUND_MAX);
    expect(joinLeaveSoundMax(create(RoomMediaSettingsSchema, { cameraLimit: 4 }))).toBe(10);
    expect(joinLeaveSoundMax(create(RoomMediaSettingsSchema, { joinLeaveSoundMax: 0 }))).toBe(0);
    expect(joinLeaveSoundMax(create(RoomMediaSettingsSchema, { joinLeaveSoundMax: 25 }))).toBe(25);
  });
});

describe('joinLeaveCue', () => {
  it('a join: the joiner is among the others; plays up to N people with me', () => {
    // me + 9 others (the joiner among them) = 10.
    expect(joinLeaveCue(users(9), 'u8', 'me', 10)).toBe(true);
    expect(joinLeaveCue(users(10), 'u9', 'me', 10)).toBe(false);
  });

  it('a leave: the leaver is counted back in', () => {
    // 8 left + the leaver + me = 10 → plays; one more → silent.
    expect(joinLeaveCue(users(8), 'gone', 'me', 10)).toBe(true);
    expect(joinLeaveCue(users(9), 'gone', 'me', 10)).toBe(false);
  });

  it('counts people, not devices', () => {
    // A second device of someone already here, and my own other device: still 2 people.
    expect(joinLeaveCue(['a', 'a', 'me'], 'a', 'me', 2)).toBe(true);
    expect(joinLeaveCue(['a', 'b'], 'b', 'me', 2)).toBe(false);
  });

  it('0 = never', () => {
    expect(joinLeaveCue([], 'a', 'me', 0)).toBe(false);
    expect(joinLeaveCue(['a'], 'a', 'me', 1)).toBe(false);
    expect(joinLeaveCue(['a'], 'a', 'me', 99)).toBe(true);
  });
});
