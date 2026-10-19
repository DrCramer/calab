import { BillingState, WorkspaceRole } from '@calaba/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The stores read the storage when they are created: the in-memory one stands in for the page's.
const disk = vi.hoisted(() => {
  const m = new Map<string, string>();
  const ls = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  vi.stubGlobal('localStorage', ls);
  vi.stubGlobal('window', { localStorage: ls });
  return m;
});

const { useBoardsUi } = await import('../../stores/boardsUi');
const { useCanvasUi } = await import('../../stores/canvasUi');
const { useDiskUi } = await import('../../stores/diskUi');
const { useMailUi } = await import('../../stores/mailUi');
const { HOME } = await import('../../stores/dms');
const { useSections } = await import('../../stores/sections');
const { useUi } = await import('../../stores/ui');
const { useWebApps } = await import('../../stores/webApps');
const { useWikiUi } = await import('../../stores/wikiUi');
const { useWorkspaces } = await import('../../stores/workspaces');
const { openSection, openWorkspace, resetRestoreForTests, restoreSectionOnBoot } = await import('./sectionNav');

const settle = (): Promise<void> => Promise.resolve();

const entry = (id: string, role = WorkspaceRole.MEMBER, billing?: BillingState) => ({ ws: { id, name: id.toUpperCase(), billing: billing === undefined ? undefined : { state: billing } }, role }) as never;

const off = (): void => {
  useBoardsUi.setState({ active: false });
  useDiskUi.setState({ active: false });
  useWikiUi.setState({ active: false });
  useCanvasUi.setState({ active: false });
  useMailUi.setState({ active: false });
  useWebApps.setState({ open: null });
};

// The first READY after a page load puts the app back on the section the workspace was left on.
describe('section memory after a reload (ADR-0074 §1)', () => {
  beforeEach(async () => {
    off();
    useWorkspaces.setState({ order: ['a', 'b', 'g', 'p'], byId: { a: entry('a'), b: entry('b'), g: entry('g', WorkspaceRole.GUEST), p: entry('p', WorkspaceRole.MEMBER, BillingState.SUSPENDED) } });
    useUi.setState({ activeWorkspaceId: 'a', calDay: null, calEvent: null, miniCal: false });
    await settle();
    useSections.setState({ of: {}, lastWs: 'a' });
    resetRestoreForTests();
  });

  it('survives the storage round trip and opens the remembered section', async () => {
    openSection('canvas');
    await settle();
    expect((JSON.parse(disk.get('calaba-sections') ?? '{}') as { state: { of: unknown } }).state.of).toEqual({ a: 'canvas' });
    // the page is reloaded: the storage is what is left, every mode flag starts off
    const saved = disk.get('calaba-sections') ?? '';
    off();
    await settle();
    useSections.setState({ of: {}, lastWs: null });
    disk.set('calaba-sections', saved);
    await useSections.persist.rehydrate();
    expect(useSections.getState().of).toEqual({ a: 'canvas' });
    restoreSectionOnBoot();
    expect(useCanvasUi.getState().active).toBe(true);
  });

  it.each([
    ['boards', () => useBoardsUi.getState().active],
    ['disk', () => useDiskUi.getState().active],
    ['wiki', () => useWikiUi.getState().active],
    ['canvas', () => useCanvasUi.getState().active],
    ['calendar', () => useUi.getState().calDay !== null],
  ] as const)('opens on «%s» when the workspace was left on it', (section, on) => {
    useSections.setState({ of: { a: section } });
    restoreSectionOnBoot();
    expect(on()).toBe(true);
  });

  it('stays on the rooms with nothing remembered, and does not write the memory by itself', async () => {
    restoreSectionOnBoot();
    await settle();
    expect(useCanvasUi.getState().active).toBe(false);
    expect(useSections.getState().of).toEqual({});
  });

  it('works once per page: a reconnect READY leaves the user where they are', () => {
    useSections.setState({ of: { a: 'canvas' } });
    restoreSectionOnBoot();
    openSection('chats');
    restoreSectionOnBoot();
    expect(useCanvasUi.getState().active).toBe(false);
  });

  it('a guest, «Личные», a closed-for-billing workspace and a workspace that is gone open the rooms', () => {
    useSections.setState({ of: { g: 'canvas', p: 'wiki', a: 'canvas' } });
    for (const ws of ['g', HOME, 'p', 'gone', null]) {
      off();
      resetRestoreForTests();
      useUi.setState({ activeWorkspaceId: ws });
      restoreSectionOnBoot();
      expect(useCanvasUi.getState().active || useWikiUi.getState().active).toBe(false);
    }
  });

  it('an unknown remembered value is the rooms', () => {
    useSections.setState({ of: { a: 'holodeck' as never } });
    restoreSectionOnBoot();
    expect(useCanvasUi.getState().active || useBoardsUi.getState().active || useWikiUi.getState().active || useDiskUi.getState().active).toBe(false);
    expect(useUi.getState().calDay).toBeNull();
  });

  it('«Почта» or an open web app keeps the screen', () => {
    useSections.setState({ of: { a: 'canvas' } });
    useMailUi.setState({ active: true });
    restoreSectionOnBoot();
    expect(useCanvasUi.getState().active).toBe(false);
    off();
    resetRestoreForTests();
    useWebApps.setState({ open: 'app1' });
    restoreSectionOnBoot();
    expect(useCanvasUi.getState().active).toBe(false);
  });

  it('each workspace has its own memory: the one the app opens on decides', async () => {
    useSections.setState({ of: { a: 'boards', b: 'wiki' } });
    useUi.setState({ activeWorkspaceId: 'b' });
    restoreSectionOnBoot();
    expect(useWikiUi.getState().active).toBe(true);
    expect(useBoardsUi.getState().active).toBe(false);
    await settle();
    // and a later switch still follows the memory
    openWorkspace('a');
    expect(useBoardsUi.getState().active).toBe(true);
  });
});
