import type { RoomInvite, UpdateRoomInviteRequest } from '@calaba/protocol';

/**
 * Editing an active room link (ADR-0107): the draft of the row editor in RoomLinkTab and the
 * PATCH it makes — only what changed; the expiry counts from now, so it is sent only when a new
 * one is chosen ('keep' leaves it as it is). Pure, unit-tested.
 */
export interface LinkDraft {
  /** Seconds from now (0 = never), or 'keep' the current end. */
  expires: number | 'keep';
  maxUses: number;
  speak: boolean;
  messages: boolean;
  files: boolean;
  stream: boolean;
}

export type LinkEdit = Partial<Pick<UpdateRoomInviteRequest, 'expiresInSeconds' | 'maxUses' | 'allowSpeak' | 'allowMessages' | 'allowFiles' | 'allowStream'>>;

export function linkDraftOf(i: RoomInvite): LinkDraft {
  return { expires: 'keep', maxUses: i.maxUses, speak: i.allowSpeak, messages: i.allowMessages, files: i.allowFiles, stream: i.allowStream };
}

/** The PATCH body for a draft, or null when nothing changed. Speak and stream exist in voice rooms only. */
export function linkEditInit(i: RoomInvite, d: LinkDraft, voice: boolean): LinkEdit | null {
  const out: LinkEdit = {};
  if (d.expires !== 'keep') out.expiresInSeconds = d.expires;
  if (d.maxUses !== i.maxUses) out.maxUses = d.maxUses;
  if (voice && d.speak !== i.allowSpeak) out.allowSpeak = d.speak;
  if (d.messages !== i.allowMessages) out.allowMessages = d.messages;
  if (d.files !== i.allowFiles) out.allowFiles = d.files;
  if (voice && d.stream !== i.allowStream) out.allowStream = d.stream;
  return Object.keys(out).length > 0 ? out : null;
}

/** Use limits the link may get: unlimited or above the uses so far (the server's rule), plus its current one. */
export function maxUsesOptions(i: Pick<RoomInvite, 'maxUses' | 'uses'>, choices: readonly number[]): number[] {
  const set = new Set(choices.filter((n) => n === 0 || n > i.uses));
  set.add(i.maxUses);
  return [...set].sort((a, b) => (a === 0 ? -1 : b === 0 ? 1 : a - b));
}
