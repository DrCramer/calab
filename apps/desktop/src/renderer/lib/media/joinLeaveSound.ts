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

/**
 * Where the server has a person's seat in my room (ADR-0150): `gone` (not in this room), `lost`
 * (kept after a lost connection, VoiceState.connection_lost) or `present`.
 */
export type SeatVerdict = 'gone' | 'lost' | 'present';

/**
 * Others' join/leave cues follow the server's seat, not the bare LiveKit connection (ADR-0150).
 * A person whose last LiveKit connection disappears is not announced until the server rules: the
 * seat is gone → «leave»; kept as lost (or not ruled yet) → nothing now, «leave» once it is
 * removed; back on LiveKit before that → no cue at all, no «join» either. A full reconnect
 * (old connection out, new one in) is silent the same way. Plain bookkeeping, no timers: the
 * caller feeds LiveKit events and the server's voice state changes.
 */
export class SeatCues {
  /** People whose connection went while the server still had their seat. */
  private readonly away = new Set<string>();

  get size(): number {
    return this.away.size;
  }

  /** `who`'s last LiveKit connection went; true = the «leave» cue is due now. */
  disconnected(who: string, seat: SeatVerdict): boolean {
    if (seat === 'gone') {
      this.away.delete(who);
      return true;
    }
    this.away.add(who);
    return false;
  }

  /** A LiveKit connection of `who` appeared; false = no «join» cue (back to a kept seat). */
  connected(who: string, seat: SeatVerdict): boolean {
    if (this.away.delete(who)) return false;
    return seat !== 'lost';
  }

  /** The server's seats changed: the people whose seat is gone for good, «leave» due for each. */
  settle(seatOf: (who: string) => SeatVerdict): string[] {
    const left: string[] = [];
    for (const who of this.away) {
      if (seatOf(who) === 'gone') left.push(who);
    }
    for (const who of left) this.away.delete(who);
    return left;
  }

  clear(): void {
    this.away.clear();
  }
}
