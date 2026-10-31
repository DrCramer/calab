import { CanvasItemKind, type CanvasItem, WorkspaceRole } from '@calaba/protocol';
import type { ForwardItem } from '../features/chat/forwardModel';
import { showMode } from '../features/shell/sectionNav';
import { t } from '../i18n';
import { ApiError } from '../lib/api/client';
import { useCanvas } from '../stores/canvas';
import { useCanvasRefs } from '../stores/canvasRefs';
import { HOME } from '../stores/dms';
import { useSession } from '../stores/session';
import { toast } from '../stores/toasts';
import { useUi } from '../stores/ui';
import { useWorkspaces } from '../stores/workspaces';
import { canvasApi, openCanvas } from './canvas';
import { canvasUrl } from './links';
import { sendLinkToChats } from './sendLink';

/*
 * Canvases outside the Canvas section (owner 23.10): the chat card, the deep link `/canvas/<item id>`
 * and «Отправить в чат». Access is the server's: the GET answers 404 / 403 without view rights.
 */

const resolving = new Map<string, Promise<CanvasItem | null>>();

/**
 * Reads a canvas by id (once per session per id unless it failed): null = gone, in the trash, a
 * folder or not mine to see. The item lands in `useCanvas.items` (`put`: no list is touched), so a
 * card shows the same name as the tree.
 */
export function resolveCanvasItem(id: string): Promise<CanvasItem | null> {
  const st = useCanvasRefs.getState().state[id];
  if (st === 'gone') return Promise.resolve(null);
  const known = useCanvas.getState().items[id];
  if (known && st === 'ok') return Promise.resolve(known);
  const running = resolving.get(id);
  if (running) return running;
  useCanvasRefs.getState().set(id, 'loading');
  const p = canvasApi
    .get(id)
    .then(
      (r) => {
        if (!r.item || r.item.trashedAt || r.item.kind !== CanvasItemKind.CANVAS) {
          useCanvasRefs.getState().set(id, 'gone');
          return null;
        }
        useCanvas.getState().put([r.item]);
        useCanvasRefs.getState().set(id, 'ok');
        return r.item;
      },
      (e: unknown) => {
        const gone = e instanceof ApiError && (e.status === 404 || e.status === 403);
        useCanvasRefs.getState().set(id, gone ? 'gone' : 'error');
        return null;
      },
    )
    .finally(() => resolving.delete(id));
  resolving.set(id, p);
  return p;
}

/** Resolves a referenced canvas unless it is already known (a mount of a card). */
export function ensureCanvasItem(id: string): void {
  if (id) void resolveCanvasItem(id);
}

let pendingLink: string | null = null;
let unwatch: (() => void) | null = null;

/**
 * Opens a canvas link (a card, a pasted link, a deep link): the Canvas section of its workspace on
 * the board (on the phone: the board screen over the «Холст» tab). Before the first READY the link
 * waits (the workspaces are not known yet).
 */
export function openCanvasLink(id: string): void {
  // Web: the address bar had /canvas/<id>; the app does not route by URL (a reload would come back here).
  if (import.meta.env.VITE_PLATFORM === 'web' && typeof location !== 'undefined' && location.pathname.startsWith('/canvas/')) {
    try {
      history.replaceState(null, '', '/');
    } catch {
      // not fatal
    }
  }
  if (useSession.getState().ready) {
    void goToCanvas(id);
    return;
  }
  pendingLink = id;
  unwatch ??= useSession.subscribe((s) => {
    if (!s.ready || !pendingLink) return;
    const next = pendingLink;
    pendingLink = null;
    unwatch?.();
    unwatch = null;
    void goToCanvas(next);
  });
}

async function goToCanvas(id: string): Promise<void> {
  const item = await resolveCanvasItem(id);
  const ws = item?.workspaceId ?? '';
  if (!item || !ws || ws === HOME || useWorkspaces.getState().byId[ws]?.role === WorkspaceRole.GUEST) {
    toast.info(t('canvas.err.gone'));
    return;
  }
  const ui = useUi.getState();
  if (ui.activeWorkspaceId !== ws) ui.setWorkspace(ws);
  if (!ui.phone.on) showMode('canvas');
  openCanvas(ws, id);
}

/**
 * «Отправить в чат…»: one message per picked chat — the optional comment, then the canvas' address
 * (the feed draws its card). Whoever opens the link needs view rights on the canvas anyway.
 */
export function sendCanvasToChats(itemId: string, targets: readonly ForwardItem[], comment: string): Promise<void> {
  return sendLinkToChats(canvasUrl(itemId), targets, comment);
}
