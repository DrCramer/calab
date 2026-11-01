/*
 * Joining a voice room from a notification (a meeting reminder: the system notification or the toast)
 * is asked first (owner, 29.10): a click on «Через час у вас встреча» must not put the user into a
 * room by surprise. Pure: what the confirmation says about the user's current voice seat.
 */

export type JoinPlan =
  /** Already in that room: nothing to join, only show it. */
  | 'here'
  /** No voice seat: a plain confirmation. */
  | 'free'
  /** In another voice room: leaving it is part of the choice (the join switches the room). */
  | 'switch'
  /** In a one-to-one call (ADR-0034): the join ends it. */
  | 'call';

export function joinPlan(seat: { roomId: string | null; call: boolean }, targetRoomId: string): JoinPlan {
  if (seat.roomId === targetRoomId) return 'here';
  if (!seat.roomId) return 'free';
  return seat.call ? 'call' : 'switch';
}

/** Up to `max` names, then the count of the rest. */
export function peopleSummary(names: readonly string[], max = 3): { shown: string[]; more: number } {
  const clean = names.filter((n) => n !== '');
  return { shown: clean.slice(0, max), more: Math.max(0, clean.length - max) };
}
