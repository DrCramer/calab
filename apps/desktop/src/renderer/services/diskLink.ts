import type { DiskItem } from '@calaba/protocol';
import type { ForwardItem } from '../features/chat/forwardModel';
import { t } from '../i18n';
import { ApiError } from '../lib/api/client';
import { isFolder } from '../lib/disk';
import { useDisk } from '../stores/disk';
import { useDiskRefs } from '../stores/diskRefs';
import { useSession } from '../stores/session';
import { toast } from '../stores/toasts';
import { diskApi, revealDiskItem } from './disk';
import { diskItemUrl } from './links';
import { sendLinkToChats } from './sendLink';

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
        if (isFolder(r.item)) useDiskRefs.getState().setCounts(id, { files: r.item.folderFiles, folders: r.item.folderFolders });
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

/**
 * The item's address in the app (`/disk/<id>`, the one a chat chip / card opens) to the clipboard —
 * a file's card and a folder's menu use it. `okKey`: the toast text.
 */
export function copyDiskItemAddress(id: string, okKey: 'disk.card.linkCopied' | 'disk.folder.linkCopied'): void {
  const url = diskItemUrl(id);
  if (!url) {
    toast.error(t('disk.err.link'));
    return;
  }
  void navigator.clipboard.writeText(url).then(
    () => toast.success(t(okKey)),
    (e: unknown) => toast.fail(e),
  );
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
export function sendDiskItemToChats(itemId: string, targets: readonly ForwardItem[], comment: string): Promise<void> {
  return sendLinkToChats(diskItemUrl(itemId), targets, comment);
}
