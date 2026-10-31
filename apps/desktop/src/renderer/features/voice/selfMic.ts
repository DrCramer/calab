import { mySeat, selfMic, type SeatState, type SelfMic } from '../../lib/voiceLogic';
import { usePrefs } from '../../stores/prefs';
import { useSession } from '../../stores/session';
import { useVoice } from '../../stores/voice';
import { useWorkspaces } from '../../stores/workspaces';

const IN_ROOM = 1;
const MUTED = 2;
const DEAFENED = 4;
const SERVER_MUTED = 8;
const PTT = 16;

/** My seat as one number, so the selector returns a primitive (a voice event of someone else changes nothing). */
function seatBits(s: SeatState | null): number {
  if (!s) return 0;
  return IN_ROOM | (s.muted ? MUTED : 0) | (s.deafened ? DEAFENED : 0) | (s.serverMuted ? SERVER_MUTED : 0) | (s.ptt ? PTT : 0);
}

function seatOf(bits: number): SeatState | null {
  if (!(bits & IN_ROOM)) return null;
  return { roomId: '-', muted: (bits & MUTED) !== 0, deafened: (bits & DEAFENED) !== 0, serverMuted: (bits & SERVER_MUTED) !== 0, ptt: (bits & PTT) !== 0 };
}

/**
 * My mic as every indicator draws it (#96, lib/voiceLogic.selfMic): the self panel, my row in the
 * room list / people card and the island dot read this one view. Primitive subscriptions only, and
 * no PTT key state: a key press redraws only the leaves that subscribe to `pttDown`.
 */
export function useSelfMic(): SelfMic {
  const me = useSession((s) => s.me?.user?.id ?? '');
  const seat = useWorkspaces((s) => seatBits(mySeat(s.byId, me)));
  const inVoice = useVoice((s) => s.roomId !== null);
  const muted = useVoice((s) => s.muted);
  const deafened = useVoice((s) => s.deafened);
  const serverMuted = useVoice((s) => s.serverMuted);
  // A one-to-one call is voice activation only (ADR-0034): no PTT wait there.
  const pttPref = usePrefs((s) => s.micMode === 'ptt');
  const oneToOne = useVoice((s) => s.call);
  return selfMic({ inVoice, muted, deafened, serverMuted, ptt: pttPref && !oneToOne }, seatOf(seat));
}

/** The same view outside React (tests, services): read from the stores now. */
export function selfMicNow(): SelfMic {
  const v = useVoice.getState();
  const seat = mySeat(useWorkspaces.getState().byId, useSession.getState().me?.user?.id ?? '');
  return selfMic({ inVoice: v.roomId !== null, muted: v.muted, deafened: v.deafened, serverMuted: v.serverMuted, ptt: usePrefs.getState().micMode === 'ptt' && !v.call }, seat);
}
