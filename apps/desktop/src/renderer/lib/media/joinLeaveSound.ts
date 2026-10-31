import type { RoomMediaSettings } from '@calaba/protocol';

/** RoomMediaSettings.join_leave_sound_max when the server did not send it (older server, DM call). */
export const DEFAULT_JOIN_LEAVE_SOUND_MAX = 10;

/** The room's join/leave cue threshold: N people at most, 0 = never. */
export function joinLeaveSoundMax(media: RoomMediaSettings | undefined): number {
  return media?.joinLeaveSoundMax ?? DEFAULT_JOIN_LEAVE_SOUND_MAX;
}

/**
 * Whether another person's join/leave cue plays. `others` are the user ids of the remote
 * participants right after the event (several devices of one user count once), `who` the user
 * who joined or left, `me` my user id. The size is that of the room with that person: the joiner
 * is already among the participants, the leaver is counted back in. Plays iff 0 < size ≤ max.
 */
export function joinLeaveCue(others: Iterable<string>, who: string, me: string, max: number): boolean {
  if (max <= 0) return false;
  const people = new Set(others);
  people.add(who);
  people.add(me);
  return people.size <= max;
}
