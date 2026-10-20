import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import type { Room } from '@calaba/protocol';
import { confirmAction } from '../components/Confirm';
import { ApiError } from '../lib/api/client';
import { errorText } from '../lib/api/errors';
import { t } from '../i18n';
import { api } from '../lib/api/endpoints';
import { fmt } from '../lib/format';
import { log } from '../lib/log';
import { mayInviteGuests } from '../lib/permissions';
import { expiresMs } from '../lib/tempRooms';
import { roomInviteLink, roomLinkError } from '../features/people/roomLink';
import { newEvent } from '../features/calendar/actions';
import { useRooms } from '../stores/rooms';
import { myUserId } from '../stores/session';
import { useTempArchive } from '../stores/tempArchive';
import { toast } from '../stores/toasts';
import { rolesOf, useWorkspaces } from '../stores/workspaces';

/**
 * Temporary rooms (ADR-0044) — the actions of the create dialog, the row menu and the island:
 * the room link (the one from creation, else the server's list), extend, delete (= archive), the
 * meeting; «Осталось 10 минут». The «Комната закрыта» toast is services/roomClosed.ts.
 */

/** Links handed out by POST …/rooms/temp, by room: «Скопировать ссылку» needs no request then. */
const created = new Map<string, string>();

export function rememberTempLink(roomId: string, url: string): void {
  if (url) created.set(roomId, url);
}

/** The room's link: the one from creation, else the first usable link the server lists (or a new one). */
export async function tempRoomLink(room: Room): Promise<string> {
  const known = created.get(room.id);
  if (known) return known;
  // Without INVITE_GUESTS only members-only links are listed / created for me (ADR-0043).
  const guests = mayInviteGuests(rolesOf(useWorkspaces.getState().byId[room.workspaceId], myUserId()));
  const url = await roomInviteLink(room.id, !guests);
  created.set(room.id, url);
  return url;
}

export async function copyTempRoomLink(room: Room): Promise<void> {
  try {
    await navigator.clipboard.writeText(await tempRoomLink(room));
    toast.success(t('temp.copied'));
  } catch (e) {
    log.warn('temp room link copy failed', e);
    toast.error(roomLinkError(e));
  }
}

/** PATCH expires_at; the store takes the answer (ROOM_UPDATE follows for everyone). */
export async function extendTempRoom(roomId: string, until: number): Promise<boolean> {
  try {
    const r = await api.rooms.update(roomId, { expiresAt: timestampFromMs(until) });
    if (r.room) useRooms.getState().upsert(r.room);
    toast.success(t('temp.extended', { when: fmt.stamp(new Date(until)) }));
    return true;
  } catch (e) {
    toast.fail(e);
    return false;
  }
}

/** «Удалить комнату»: closes it for everyone, the history stays in the archive (DELETE → 204, ROOM_DELETE). */
export async function deleteTempRoom(room: Room): Promise<void> {
  const ok = await confirmAction(t('temp.deleteTitle', { name: room.name }), t('temp.deleteConfirm'), t('temp.delete'));
  if (!ok) return;
  try {
    await api.rooms.remove(room.id);
  } catch (e) {
    toast.fail(e);
  }
}

/** Archive «Вернуть» (ADR-0044 addendum 14.10): the room is live again for its old lifetime (ROOM_CREATE follows for everyone). */
export async function restoreTempRoom(room: Room): Promise<boolean> {
  try {
    const r = await api.rooms.restoreTemp(room.id);
    if (r.room) useRooms.getState().upsert(r.room);
    useTempArchive.getState().drop(room.id);
    toast.success(t('temp.restored', { name: room.name }));
    return true;
  } catch (e) {
    toast.error(restoreError(e));
    return false;
  }
}

/** The limits of live temporary rooms by their reason, else the server's text. */
function restoreError(e: unknown): string {
  if (e instanceof ApiError && e.is('ERROR_CODE_TEMP_ROOM_LIMIT')) {
    const limit = e.extra.limit ?? 50;
    return e.reason === 'PER_USER' ? t('temp.errLimitUser', { limit }) : t('temp.errLimitWs', { limit });
  }
  return errorText(e);
}

/** Archive «Сделать постоянной»: after a confirmation the room becomes a regular one (history, members and settings stay). */
export async function makeTempRoomPermanent(room: Room): Promise<boolean> {
  const ok = await confirmAction(t('temp.permanentTitle', { name: room.name }), t('temp.permanentConfirm'), t('temp.permanent'), 'primary');
  if (!ok) return false;
  try {
    const r = await api.rooms.makePermanent(room.id);
    if (r.room) useRooms.getState().upsert(r.room);
    useTempArchive.getState().drop(room.id);
    toast.success(t('temp.madePermanent', { name: room.name }));
    return true;
  } catch (e) {
    toast.fail(e);
    return false;
  }
}

/** «Добавить встречу»: the meeting dialog with this room, from the next 5 minutes to the room's end. */
export function addTempRoomMeeting(room: Room): void {
  const step = 5 * 60_000;
  const start = Math.ceil(Date.now() / step) * step;
  const end = expiresMs(room);
  newEvent(room.workspaceId, { start, end: end > start ? end : start + 30 * 60_000, roomId: room.id });
}

/** «Осталось 10 минут», once per room for people in its voice (the island's leaf fires it). */
const warned = new Set<string>();

export function warnTenMinutes(roomId: string, name: string): void {
  if (warned.has(roomId)) return;
  warned.add(roomId);
  toast.info(t('temp.tenMinutes', { name }));
}
