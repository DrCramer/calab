import { RoomType, WorkspaceRole } from '@calaba/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBoards } from '../stores/boards';
import { useBoardsUi } from '../stores/boardsUi';
import { useCanvasUi } from '../stores/canvasUi';
import { useDiskUi } from '../stores/diskUi';
import { useMailUi } from '../stores/mailUi';
import { useRooms } from '../stores/rooms';
import { useTelephonyUi } from '../stores/telephonyUi';
import { canGoBack, canGoForward, useUi } from '../stores/ui';
import { useWebApps } from '../stores/webApps';
import { useWikiUi } from '../stores/wikiUi';
import { useWorkspaces } from '../stores/workspaces';
import { emptyHistory } from '../lib/navHistory';
import { armNavHistory, currentLoc, goBack, goForward, installNavHistory, replaceNextNav } from './navHistory';

/** A change of place is recorded once per synchronous batch (a microtask). */
const settle = (): Promise<void> => Promise.resolve();

const entry = (id: string) => ({ ws: { id, name: id }, role: WorkspaceRole.MEMBER }) as never;
const room = (id: string, workspaceId: string) => ({ id, workspaceId, type: RoomType.TEXT }) as never;

describe('navigation history recorder (board #113)', () => {
  let off: () => void = () => undefined;
  beforeEach(async () => {
    useBoardsUi.setState({ active: false, taskId: null, searchFrom: '', boardOf: {} });
    useDiskUi.setState({ active: false, folderOf: {}, trashOf: {} });
    useWikiUi.setState({ active: false });
    useCanvasUi.setState({ active: false });
    useTelephonyUi.setState({ active: false });
    useMailUi.setState({ active: false });
    useWebApps.setState({ open: null });
    useWorkspaces.setState({ order: ['a'], byId: { a: entry('a') } });
    useRooms.setState({ byId: { r1: room('r1', 'a'), r2: room('r2', 'a') } });
    useBoards.setState({ boards: { b1: { id: 'b1', workspaceId: 'a' } as never } });
    useUi.setState({ activeWorkspaceId: 'a', calDay: null, calEvent: null, lastRoom: { a: 'r1' }, history: emptyHistory() });
    await settle();
    off = installNavHistory();
    armNavHistory();
  });
  afterEach(() => off());

  it('task → a room from its comments → back to the task → forward to the room', async () => {
    useBoardsUi.getState().openBoard('a', 'b1');
    useBoardsUi.getState().openTask('t1');
    await settle();
    expect(currentLoc()).toMatchObject({ kind: 'task', task: 't1' });
    useUi.getState().openRoom('a', 'r2');
    await settle();
    expect(useBoardsUi.getState().active).toBe(false);
    expect(canGoBack(useUi.getState())).toBe(true);
    expect(canGoForward(useUi.getState())).toBe(false);

    goBack();
    await settle();
    expect(useBoardsUi.getState().active).toBe(true);
    expect(useBoardsUi.getState().taskId).toBe('t1');
    expect(canGoForward(useUi.getState())).toBe(true);

    goForward();
    await settle();
    expect(currentLoc()).toEqual({ kind: 'room', ws: 'a', room: 'r2' });
    expect(useBoardsUi.getState().active).toBe(false);
  });

  it('one entry per navigation touching several stores; J/K replaces; filters make none', async () => {
    useBoardsUi.getState().openBoard('a', 'b1');
    await settle();
    expect(useUi.getState().history.back).toHaveLength(1);
    useBoardsUi.getState().openTask('t1');
    await settle();
    replaceNextNav();
    useBoardsUi.getState().openTask('t2');
    await settle();
    useBoardsUi.getState().setFilterOpen(true);
    useBoardsUi.getState().setPrefs('b1', { kind: 'list' });
    await settle();
    // room r1, the board — t1 was replaced by t2, the filter changed nothing.
    expect(useUi.getState().history.back.map((l) => l.kind)).toEqual(['room', 'board']);
    goBack();
    await settle();
    expect(currentLoc()).toEqual({ kind: 'board', ws: 'a', board: 'b1' });
  });

  it('skips places that are gone (a deleted room)', async () => {
    useUi.getState().openRoom('a', 'r2');
    await settle();
    useDiskUi.getState().setActive(true);
    await settle();
    useRooms.setState({ byId: { r1: room('r1', 'a') } });
    goBack();
    await settle();
    expect(currentLoc()).toEqual({ kind: 'room', ws: 'a', room: 'r1' });
    expect(useDiskUi.getState().active).toBe(false);
  });
});
