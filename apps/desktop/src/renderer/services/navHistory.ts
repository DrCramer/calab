import { RoomType, WorkspaceRole } from '@calaba/protocol';
import { locOf, recordNav, sameLoc, step, type Loc, type NavSnapshot } from '../lib/navHistory';
import { openSection, showMode } from '../features/shell/sectionNav';
import { useBoards } from '../stores/boards';
import { MY_TASKS, useBoardsUi } from '../stores/boardsUi';
import { useCanvasUi } from '../stores/canvasUi';
import { folderOf, useDiskUi } from '../stores/diskUi';
import { HOME } from '../stores/dms';
import { closeThread, openThread, refKey, selectBox, useMail } from '../stores/mail';
import { leaveMail, useMailUi } from '../stores/mailUi';
import { useRooms } from '../stores/rooms';
import { useTaskTabs } from '../stores/taskTabs';
import { useTelephonyUi, type TelPage } from '../stores/telephonyUi';
import { useUi } from '../stores/ui';
import { useWebApps } from '../stores/webApps';
import { useWikiUi } from '../stores/wikiUi';
import { useWorkspaces } from '../stores/workspaces';

/**
 * Records the navigation history (board #113) and replays it (‹ ›, ⌘[ / ⌘], Alt+←/→).
 *
 * The one choke point is a subscription to the section stores, not pushes in every open function:
 * dozens of call sites (the rail, ⌘K, links in messages and comments, notifications, deep links,
 * the boards' / Disk's / wiki's own navigation) all end in these stores, and a single navigation
 * often touches several of them (a room opened from a task turns the boards off, then sets the
 * room). So every change only schedules one microtask; it derives the place on screen
 * (lib/navHistory.ts `locOf`) and, when it is another place, pushes the previous one. Filters,
 * scrolling, typing and selection are not part of a place, so they never make an entry.
 * Exceptions are explicit: {@link replaceNextNav} (J/K to the next task, ↑/↓ in the mail list) and
 * travel itself. Before the first READY (and its restored section) nothing is recorded; the phone
 * layout keeps its own history (ADR-0073) and records nothing here.
 */

let cur: Loc | null = null;
let armed = false;
let scheduled = false;
let replace = false;
let traveling = false;

function snapshot(): NavSnapshot {
  const ui = useUi.getState();
  const ws = ui.activeWorkspaceId;
  const home = ws === HOME;
  const guest = !!ws && !home && useWorkspaces.getState().byId[ws]?.role === WorkspaceRole.GUEST;
  const apps = useWebApps.getState();
  const mailUi = useMailUi.getState();
  // The section is only ever on where mail exists (desktop; features/mail/boot MAIL_ENABLED).
  const mail = mailUi.active ? useMail.getState() : null;
  const disk = useDiskUi.getState();
  const wiki = useWikiUi.getState();
  const canvas = useCanvasUi.getState();
  const tel = useTelephonyUi.getState();
  const bu = useBoardsUi.getState();
  return {
    ws,
    home,
    guest,
    room: ws ? (ui.lastRoom[ws] ?? null) : null,
    fileTab: useTaskTabs.getState().fileActive,
    mail: mail
      ? {
          box: mail.box,
          boxKey: `${mail.box.scope}\n${refKey(mail.box.folder)}`,
          thread: mail.thread?.threadId ?? null,
          message: mail.thread ? mail.openId : null,
          row: mail.thread?.rowKey ?? null,
        }
      : null,
    app: apps.open && ws && apps.byId[apps.open]?.workspaceId === ws ? apps.open : null,
    disk: ws && disk.active ? { folder: folderOf(disk, ws), trash: !!disk.trashOf[ws] } : null,
    wiki: ws && wiki.active ? { page: wiki.pageOf[ws] ?? '' } : null,
    canvas: ws && canvas.active ? { item: canvas.itemOf[ws] ?? '' } : null,
    tel: tel.active ? { page: tel.page, detail: tel.detail } : null,
    boards: ws && bu.active ? { board: bu.boardOf[ws] ?? MY_TASKS, task: bu.taskId, from: bu.searchFrom } : null,
    cal: ui.calDay ? { day: ui.calDay, event: ui.calEvent } : null,
  };
}

/** The place on screen now (desktop). */
export function currentLoc(): Loc | null {
  return locOf(snapshot());
}

function flush(): void {
  scheduled = false;
  const wasReplace = replace;
  const wasTravel = traveling;
  replace = false;
  traveling = false;
  if (useUi.getState().phone.on) return;
  const loc = currentLoc();
  if (!loc || sameLoc(loc, cur)) return;
  if (armed && !wasTravel) {
    const h = useUi.getState().history;
    const next = recordNav(h, cur, loc, wasReplace);
    if (next !== h) useUi.setState({ history: next });
  }
  cur = loc;
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(flush);
}

/** Starts recording (AppShell); returns the uninstall. */
export function installNavHistory(): () => void {
  cur = currentLoc();
  const offs = [useUi, useBoardsUi, useMailUi, useMail, useDiskUi, useWikiUi, useCanvasUi, useTelephonyUi, useWebApps, useTaskTabs].map((s) => (s as { subscribe: (fn: () => void) => () => void }).subscribe(schedule));
  return () => {
    for (const off of offs) off();
    armed = false;
  };
}

/**
 * The first READY has put the app where it was left (sectionNav.restoreSectionOnBoot): that is the
 * starting place, not a navigation. From here every change of place is recorded.
 */
export function armNavHistory(): void {
  if (armed) return;
  cur = currentLoc();
  armed = true;
}

/** The next change of place replaces the current entry instead of pushing (J/K, ↑/↓ through a list). */
export function replaceNextNav(): void {
  replace = true;
  schedule();
}

/** An entry is still reachable: its workspace, room, board, app or file tab still exists for me. */
export function reachable(l: Loc): boolean {
  if (l.kind === 'mail') return l.box.scope === 'all' || !!useMail.getState().accounts[l.box.scope];
  if (l.kind === 'file') return useTaskTabs.getState().tabs.some((x) => x.id === l.tab) && !!useWorkspaces.getState().byId[l.ws];
  const rooms = useRooms.getState().byId;
  if (l.kind === 'room' && l.ws === HOME) return !l.room || rooms[l.room]?.type === RoomType.DM || rooms[l.room]?.type === RoomType.NOTES;
  const w = useWorkspaces.getState().byId[l.ws];
  if (!w) return false;
  switch (l.kind) {
    case 'room':
      return l.room ? rooms[l.room]?.workspaceId === l.ws : true;
    case 'app':
      return useWebApps.getState().byId[l.app]?.workspaceId === l.ws;
    case 'board':
    case 'task':
      if (w.role === WorkspaceRole.GUEST) return false;
      return l.board === MY_TASKS || useBoards.getState().boards[l.board]?.workspaceId === l.ws;
    case 'cal':
      return true;
    default:
      return w.role !== WorkspaceRole.GUEST;
  }
}

/** Puts a workspace on screen without a section of its own (the place's opener picks it). */
function enterWorkspace(ws: string): void {
  const ui = useUi.getState();
  if (ui.activeWorkspaceId !== ws) ui.setWorkspace(ws);
  if (useWebApps.getState().open) useWebApps.getState().setOpen(null);
}

/** Opens a recorded place through the sections' own open functions (their remembered view state stays). */
function openLoc(l: Loc): void {
  const tabs = useTaskTabs.getState();
  if (l.kind === 'file') {
    const ui = useUi.getState();
    if (ui.activeWorkspaceId !== l.ws) ui.setWorkspace(l.ws);
    tabs.showFile(l.tab);
    return;
  }
  tabs.leaveFile();
  if (l.kind === 'mail') {
    openSection('mail');
    selectBox(l.box);
    if (l.thread && l.message) {
      useMail.setState({ selected: l.row });
      void openThread(l.thread, l.message, l.row);
    } else if (useMail.getState().thread) closeThread();
    return;
  }
  leaveMail();
  const ui = useUi.getState();
  switch (l.kind) {
    case 'room':
      if (l.room) ui.openRoom(l.ws, l.room);
      else {
        enterWorkspace(l.ws);
        showMode('voice');
      }
      return;
    case 'app':
      enterWorkspace(l.ws);
      useWebApps.getState().setOpen(l.app);
      return;
    case 'cal':
      enterWorkspace(l.ws);
      ui.openCalendarDay(l.day, l.event);
      ui.toggleMiniCal(true);
      return;
    case 'board':
    case 'task': {
      enterWorkspace(l.ws);
      showMode('boards');
      // The views load what they show on mount (BoardsView: the board's tasks; TaskView: the task).
      const bu = useBoardsUi.getState();
      bu.openBoard(l.ws, l.board);
      bu.openTask(l.kind === 'task' ? l.task : null, l.kind === 'task' ? l.from : undefined);
      return;
    }
    case 'disk':
      enterWorkspace(l.ws);
      showMode('disk');
      if (l.trash) useDiskUi.getState().openTrash(l.ws, true);
      else useDiskUi.getState().openFolder(l.ws, l.folder);
      return;
    case 'wiki':
      enterWorkspace(l.ws);
      showMode('wiki');
      if (l.page) useWikiUi.getState().openPage(l.ws, l.page);
      return;
    case 'canvas':
      enterWorkspace(l.ws);
      showMode('canvas');
      if (l.item) useCanvasUi.getState().openItem(l.ws, l.item);
      return;
    case 'tel':
      enterWorkspace(l.ws);
      showMode('telephony');
      useTelephonyUi.getState().setPage(l.page as TelPage);
      useTelephonyUi.getState().openDetail(l.detail);
      return;
  }
}

function travel(dir: -1 | 1): void {
  const ui = useUi.getState();
  if (ui.phone.on) return;
  // A pending change of place is recorded first (a click and ⌘[ in the same tick).
  if (scheduled) flush();
  const r = step(ui.history, cur ?? currentLoc(), dir, reachable);
  if (!r) return;
  useUi.setState({ history: r.history });
  traveling = true;
  openLoc(r.to);
  schedule();
}

export const goBack = (): void => travel(-1);
export const goForward = (): void => travel(1);
