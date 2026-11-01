import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { NotificationLevel, RoomNotificationSettingsSchema, WorkspaceNotificationSettingsSchema } from '@calaba/protocol';
import { api } from '../lib/api/endpoints';
import { log } from '../lib/log';
import { useInbox } from '../stores/inbox';
import { useRooms, workspaceNotify } from '../stores/rooms';
import { toast } from '../stores/toasts';
import { t } from '../i18n';

const PAGE = 30;

/**
 * Mentions inbox history (ADR-0141): GET /api/me/mentions and GET /api/me/task-notices, side by
 * side. Without `older` it fetches the newest page of each (merged with what is known, so live
 * items and history never duplicate); `older` pages on whichever list has more.
 */
export async function loadMentions(older = false): Promise<void> {
  const inbox = useInbox.getState();
  if (inbox.loading) return;
  const before = older ? inbox.items.at(-1)?.id : undefined;
  const noticesBefore = older ? inbox.noticesCursor : undefined;
  const mentions = !older || (inbox.hasMore && !!before);
  const notices = !older || (inbox.noticesHasMore && !!noticesBefore);
  if (!mentions && !notices) return;
  inbox.setLoading(true);
  const [m, n] = await Promise.allSettled([
    mentions ? api.me.mentions({ limit: PAGE, ...(before ? { before } : {}) }) : null,
    notices ? api.me.taskNotices({ limit: PAGE, ...(noticesBefore ? { before: noticesBefore } : {}) }) : null,
  ]);
  const s = useInbox.getState();
  // The notices first: addPage marks the inbox loaded, and a first page sets both «has more».
  if (n.status === 'fulfilled' && n.value) s.addNotices(n.value.entries, n.value.hasMore, older, n.value.nextBefore);
  else if (n.status === 'rejected') log.warn('load task notices failed', n.reason);
  // The list only: badges come from the server-counted read states (READY mention_count), not
  // from this history — seeding them from it badged the open room (review N7).
  if (m.status === 'fulfilled' && m.value) s.addPage(m.value.messages, m.value.hasMore, older);
  else if (m.status === 'rejected') log.warn('load mentions failed', m.reason);
  if (!useInbox.getState().loaded) useInbox.getState().addPage([], false, false);
  useInbox.getState().setLoading(false);
}

/**
 * Room notification settings (docs/05, «Уведомления»): optimistic, rolled back when the server
 * refuses. `mutedUntil` null = not muted; level INHERIT without a mute = the default.
 */
export async function setRoomNotifications(roomId: string, level: NotificationLevel, mutedUntil: number | null): Promise<void> {
  const rooms = useRooms.getState();
  const prev = rooms.notify[roomId];
  const next = create(RoomNotificationSettingsSchema, {
    roomId,
    level,
    ...(mutedUntil ? { mutedUntil: timestampFromMs(mutedUntil) } : {}),
  });
  rooms.setNotify(next);
  try {
    const res = await api.rooms.setNotifications(roomId, {
      level,
      ...(mutedUntil ? { mutedUntil: timestampFromMs(mutedUntil) } : {}),
    });
    if (res.settings) useRooms.getState().setNotify(res.settings);
  } catch (e) {
    log.warn('room notifications failed', e);
    useRooms.getState().setNotify(prev ?? create(RoomNotificationSettingsSchema, { roomId, level: NotificationLevel.INHERIT }));
    toast.error(t('chat.notifyFailed'));
  }
}

/**
 * Workspace notification settings (docs/09 item 22): the level of its rooms left at «Как в
 * пространстве», and a mute of the whole workspace. Optimistic like the room ones; level
 * MENTIONS without a mute = the default.
 */
export async function setWorkspaceNotifications(workspaceId: string, level: NotificationLevel, mutedUntil: number | null): Promise<void> {
  const rooms = useRooms.getState();
  const prev = rooms.wsNotify[workspaceId];
  const muted = mutedUntil ? { mutedUntil: timestampFromMs(mutedUntil) } : {};
  rooms.setWsNotify(create(WorkspaceNotificationSettingsSchema, { workspaceId, level, ...muted, taskLevel: prev?.taskLevel ?? NotificationLevel.UNSPECIFIED }));
  try {
    const res = await api.workspaces.setNotifications(workspaceId, { level, ...muted });
    if (res.settings) useRooms.getState().setWsNotify(res.settings);
  } catch (e) {
    log.warn('workspace notifications failed', e);
    useRooms.getState().setWsNotify(prev ?? create(WorkspaceNotificationSettingsSchema, { workspaceId, level: NotificationLevel.MENTIONS }));
    toast.error(t('chat.notifyFailed'));
  }
}

/**
 * The workspace's «Задачи» notifications (ADR-0042 §4): ALL | MENTIONS (assigned to me, @me) |
 * NONE. Sent with the current level and mute (the PUT replaces the whole setting). Optimistic.
 */
export async function setWorkspaceTaskLevel(workspaceId: string, taskLevel: NotificationLevel): Promise<void> {
  const rooms = useRooms.getState();
  const prev = rooms.wsNotify[workspaceId];
  const n = workspaceNotify(prev);
  const muted = n.mutedUntil ? { mutedUntil: timestampFromMs(n.mutedUntil) } : {};
  rooms.setWsNotify(create(WorkspaceNotificationSettingsSchema, { workspaceId, level: n.level, ...muted, taskLevel }));
  try {
    const res = await api.workspaces.setNotifications(workspaceId, { level: n.level, ...muted, taskLevel });
    if (res.settings) useRooms.getState().setWsNotify(res.settings);
  } catch (e) {
    log.warn('workspace task notifications failed', e);
    useRooms.getState().setWsNotify(prev ?? create(WorkspaceNotificationSettingsSchema, { workspaceId, level: NotificationLevel.MENTIONS }));
    toast.error(t('chat.notifyFailed'));
  }
}
