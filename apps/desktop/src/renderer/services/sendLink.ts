import type { ForwardItem } from '../features/chat/forwardModel';
import { plural, t } from '../i18n';
import { log } from '../lib/log';
import { HOME } from '../stores/dms';
import { useRooms } from '../stores/rooms';
import { toast, useToasts } from '../stores/toasts';
import { useUi } from '../stores/ui';
import { MAX_CONTENT, sendMessage } from './chat';
import { ensureDm } from './dms';

/**
 * «Отправить в чат…» for an own-server link (wiki page, Disk item, canvas): one message per picked
 * chat — the optional comment, then the address (the feed draws the kind's card under it). Through
 * the chat's own send path; the server checks the right to write there, and whoever opens the link
 * is checked against the target's own rights. The one implementation for every kind.
 */
export async function sendLinkToChats(url: string | null, targets: readonly ForwardItem[], comment: string): Promise<void> {
  if (!url || !targets.length) return;
  const note = comment.trim();
  const content = (note ? `${note}\n${url}` : url).slice(0, MAX_CONTENT);
  let last: { ws: string; room: string; name: string } | null = null;
  let sent = 0;
  let failed = 0;
  for (const target of targets) {
    try {
      const roomId = target.kind === 'room' ? target.roomId : await ensureDm(target.userId);
      const ws = useRooms.getState().byId[roomId]?.workspaceId ?? '';
      await sendMessage(ws, roomId, content, [], undefined);
      last = { ws, room: roomId, name: target.name };
      sent++;
    } catch (e) {
      log.warn('link to chat: send', e);
      failed++;
    }
  }
  if (last) {
    const to = last;
    const label = sent > 1 ? plural('wiki.send.sentMany', sent) : t('wiki.send.sent', { name: to.name });
    useToasts.getState().push('success', label, { label: t('wiki.send.open'), run: () => useUi.getState().openRoom(to.ws || HOME, to.room) });
  }
  if (failed) toast.error(t('wiki.send.failed'));
}
