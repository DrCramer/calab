import type { DiskItem } from '@calaba/protocol';
import type { ForwardItem } from '../features/chat/forwardModel';
import { plural, t } from '../i18n';
import { ApiError } from '../lib/api/client';
import { log } from '../lib/log';
import { useDisk } from '../stores/disk';
import { useDiskRefs } from '../stores/diskRefs';
import { HOME } from '../stores/dms';
import { useRooms } from '../stores/rooms';
import { useSession } from '../stores/session';
import { toast, useToasts } from '../stores/toasts';
import { useUi } from '../stores/ui';
import { MAX_CONTENT, sendMessage } from './chat';
import { diskApi, revealDiskItem } from './disk';
import { ensureDm } from './dms';
import { diskItemUrl } from './links';

/*
 * Disk items outside the Disk (CBF-20): the chat chip and the deep link `/disk/<item id>`, and
 * «Отправить в чат». Access is the server's: the GET answers 404 without DISK_VIEW.
 */

const resolving = new Map<string, Promise<DiskItem | null>>();

/**
 * Reads an item by id (once per session per id unless it failed): null = gone, in the trash or
 * not mine to see. The item lands in `useDisk.items`, so a chip shows the same name / size as the Disk.
 */
export function resolveDiskItem(id: string): Promise<DiskItem | null> {
  const st = useDiskRefs.getState().state[id];
  if (st === 'gone') return Promise.resolve(null);
  const known = useDisk.getState().items[id];
  if (known && st === 'ok') return Promise.resolve(known);
  const running = resolving.get(id);
  if (running) return running;
  useDiskRefs.getState().set(id, 'loading');
  const p = diskApi
    .get(id)
    .then(
      (r) => {
        if (!r.item || r.item.trashedAt) {
          useDiskRefs.getState().set(id, 'gone');
          return null;
        }
        useDisk.getState().upsert(r.item);
        useDiskRefs.getState().set(id, 'ok');
        return r.item;
      },
      (e: unknown) => {
        const gone = e instanceof ApiError && (e.status === 404 || e.status === 403);
        useDiskRefs.getState().set(id, gone ? 'gone' : 'error');
        return null;
      },
    )
    .finally(() => resolving.delete(id));
  resolving.set(id, p);
  return p;
}

/** Resolves a referenced item unless it is already known (a mount of a chip). */
export function ensureDiskItem(id: string): void {
  if (id) void resolveDiskItem(id);
}

let pendingLink: string | null = null;
let unwatch: (() => void) | null = null;

/**
 * Opens a Disk link (a chip, a pasted link, a deep link): the Disk at the file's folder, the file
 * selected, its card on top. Before the first READY the link waits (the workspaces are not known yet).
 */
export function openDiskLink(id: string): void {
  // Web: the address bar had /disk/<id>; the app does not route by URL (a reload would come back here).
  if (import.meta.env.VITE_PLATFORM === 'web' && typeof location !== 'undefined' && location.pathname.startsWith('/disk/')) {
    try {
      history.replaceState(null, '', '/');
    } catch {
      // not fatal
    }
  }
  if (useSession.getState().ready) {
    void goToItem(id);
    return;
  }
  pendingLink = id;
  unwatch ??= useSession.subscribe((s) => {
    if (!s.ready || !pendingLink) return;
    const next = pendingLink;
    pendingLink = null;
    unwatch?.();
    unwatch = null;
    void goToItem(next);
  });
}

async function goToItem(id: string): Promise<void> {
  const item = await resolveDiskItem(id);
  if (!item) {
    toast.info(t('disk.err.gone'));
    return;
  }
  revealDiskItem(item, true);
}

/**
 * «Отправить в чат…»: one message per picked chat — the optional comment, then the item's address
 * (the feed draws its chip). Through the chat's own send path; the server checks the rights to
 * write there, and whoever opens the link needs DISK_VIEW anyway.
 */
export async function sendDiskItemToChats(itemId: string, targets: readonly ForwardItem[], comment: string): Promise<void> {
  const url = diskItemUrl(itemId);
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
      log.warn('disk to chat: send', e);
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
