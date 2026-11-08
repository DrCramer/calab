import { create } from '@bufbuild/protobuf';
import { RoomMediaSettingsSchema } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { DEFAULT_JOIN_LEAVE_SOUND_MAX, SeatCues, joinLeaveCue, joinLeaveSoundMax, type SeatVerdict } from './joinLeaveSound';

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

describe('SeatCues (ADR-0150)', () => {
  it('a plain leave: the seat is already gone, or goes right after the LiveKit event', () => {
    const c = new SeatCues();
    expect(c.disconnected('a', 'gone')).toBe(true);
    expect(c.size).toBe(0);
    expect(c.disconnected('b', 'present')).toBe(false); // VOICE_STATE_UPDATE not here yet
    expect(c.settle(() => 'present')).toEqual([]);
    expect(c.settle(() => 'gone')).toEqual(['b']);
    expect(c.size).toBe(0);
  });

  it('a drop: no leave while the seat is kept, no join when the person is back', () => {
    const c = new SeatCues();
    let seat: SeatVerdict = 'present';
    expect(c.disconnected('a', seat)).toBe(false);
    seat = 'lost';
    expect(c.settle(() => seat)).toEqual([]);
    seat = 'present'; // /join took the seat back before LiveKit connected
    expect(c.settle(() => seat)).toEqual([]);
    expect(c.connected('a', seat)).toBe(false);
    expect(c.size).toBe(0);
    expect(c.connected('a', 'present')).toBe(true); // a later, real join cues again
  });

  it('a drop that never comes back: leave when the grace ends', () => {
    const c = new SeatCues();
    expect(c.disconnected('a', 'lost')).toBe(false);
    expect(c.settle(() => 'lost')).toEqual([]);
    expect(c.settle(() => 'gone')).toEqual(['a']);
    expect(c.settle(() => 'gone')).toEqual([]);
  });

  it('a seat already lost when it connects (I joined during the drop): no join', () => {
    expect(new SeatCues().connected('a', 'lost')).toBe(false);
    expect(new SeatCues().connected('a', 'present')).toBe(true);
  });

  it('clear forgets everyone (I left the room)', () => {
    const c = new SeatCues();
    c.disconnected('a', 'present');
    c.clear();
    expect(c.size).toBe(0);
    expect(c.connected('a', 'present')).toBe(true);
  });
});
