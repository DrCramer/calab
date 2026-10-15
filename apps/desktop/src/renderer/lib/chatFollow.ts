/**
 * «The chat follows the voice» (issue #127): when I join or am moved to a voice room, the room's
 * own chat comes up, so a message is not sent to the previously open room by mistake. Pure: the
 * caller (stores/ui.followVoiceChat) reads the view and applies the answer.
 *
 * - Only my own join / move: never on other people's voice events, never for a reload resume
 *   (the persisted view is already where the user left it) or a 1:1 call (its DM is not a room).
 * - Another view covering the room column (boards / an open task, mail, disk, wiki, a web app,
 *   the calendar day, the DM list «Личные») is not taken away: the voice room only becomes the
 *   workspace's remembered room, so leaving that view lands in the voice room's chat.
 * - Phone: a join does not push a chat screen over what the user is doing (ADR-0073); a move
 *   follows only when the source room's chat is the screen on top.
 * - A click on another room afterwards opens that room as usual (nothing is locked).
 */

export type FollowEvent =
  | { kind: 'join'; workspaceId: string; roomId: string; resumed?: boolean; call?: boolean }
  /** VOICE_MOVED handled by this device (a moderator moved me). */
  | { kind: 'moved'; workspaceId: string; fromRoomId: string; toRoomId: string };

export interface FollowView {
  phone: boolean;
  /** The room whose chat is on screen (stores/ui.activeRoomId), or null. */
  shownRoomId: string | null;
  /** The remembered room of the event's workspace (lastRoom[workspaceId]), or null. */
  rememberedRoomId: string | null;
  /** Another view covers the room column (see above). */
  covered: boolean;
}

/** `open`: show the room's chat; `remember`: only make it the workspace's remembered room. */
export type FollowDecision = 'open' | 'remember' | 'none';

export function chatFollow(ev: FollowEvent, view: FollowView): FollowDecision {
  if (!ev.workspaceId) return 'none';
  if (ev.kind === 'join') {
    if (ev.resumed === true || ev.call === true || view.phone) return 'none';
    if (view.covered) return view.rememberedRoomId === ev.roomId ? 'none' : 'remember';
    return view.shownRoomId === ev.roomId ? 'none' : 'open';
  }
  if (ev.fromRoomId === ev.toRoomId) return 'none';
  // Followed only from the room I was moved out of: another chat on screen is the user's choice.
  if (!view.covered && view.shownRoomId === ev.fromRoomId) return 'open';
  if (!view.phone && view.rememberedRoomId === ev.fromRoomId) return 'remember';
  return 'none';
}

/** The room a decision targets. */
export const followTarget = (ev: FollowEvent): string => (ev.kind === 'join' ? ev.roomId : ev.toRoomId);
