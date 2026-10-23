import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PINNED,
  MAX_DEPTH,
  PHONE_TABS,
  barTabs,
  migratePinned,
  moveTab,
  normalizeOrder,
  normalizePinned,
  togglePin,
  backStep,
  depthOfState,
  emptyPhoneNav,
  historyPlan,
  historyTarget,
  openChat,
  openSettingsSection,
  popScreen,
  pushOnTab,
  pushScreen,
  removeKind,
  switchTab,
  topScreen,
  visibleRoom,
  type PhoneNav,
} from './phoneNav';

const nav = (over: Partial<PhoneNav> = {}): PhoneNav => ({ ...emptyPhoneNav(), on: true, ...over });
const room = (r: string, ws = 'w1') => ({ kind: 'room' as const, ws, room: r });

describe('phone navigation stack (ADR-0073 §1)', () => {
  it('opens a room from the list over the tab root', () => {
    const n = openChat(nav(), room('a'));
    expect(n.tab).toBe('chats');
    expect(n.stack).toEqual([room('a')]);
    expect(visibleRoom(n)).toBe('a');
  });

  it('a deep link into another tab builds «tab root → screen»', () => {
    const n = openChat(nav({ tab: 'calendar', stack: [{ kind: 'event', key: 'e@1' }] }), { kind: 'dm', room: 'd1' });
    expect(n.tab).toBe('dms');
    expect(n.stack).toEqual([{ kind: 'dm', room: 'd1' }]);
  });

  it('a link in a room pushes the next room; back returns to the first', () => {
    const n = openChat(openChat(nav(), room('a')), room('b'));
    expect(n.stack.map((s) => (s.kind === 'room' ? s.room : s.kind))).toEqual(['a', 'b']);
    expect(visibleRoom(popScreen(n))).toBe('a');
  });

  it('returning to a room already in the stack drops the screens above it', () => {
    const n = openChat(openChat(openChat(nav(), room('a')), room('b')), room('a'));
    expect(n.stack).toEqual([room('a')]);
  });

  it('opening a chat closes the non-chat screens (members, search…)', () => {
    const start = nav({ stack: [room('a'), { kind: 'members', ws: 'w1', room: 'a' }, { kind: 'search' }] });
    expect(openChat(start, room('b')).stack).toEqual([room('a'), room('b')]);
  });

  it('pushes members over the room and pops back to it', () => {
    const n = pushScreen(openChat(nav(), room('a')), { kind: 'members', ws: 'w1', room: 'a' });
    expect(topScreen(n)?.kind).toBe('members');
    expect(visibleRoom(n)).toBeNull();
    expect(topScreen(popScreen(n))).toEqual(room('a'));
  });

  it('pushing the top screen again is a no-op (same object)', () => {
    const n = pushScreen(nav(), { kind: 'search' });
    expect(pushScreen(n, { kind: 'search' })).toBe(n);
  });

  it('caps the depth', () => {
    let n = nav();
    for (let i = 0; i < MAX_DEPTH + 3; i++) n = pushScreen(n, room(`r${i}`));
    expect(n.stack).toHaveLength(MAX_DEPTH);
    expect(visibleRoom(n)).toBe(`r${MAX_DEPTH + 2}`);
  });

  it('removes a kind when its feature flag goes off elsewhere', () => {
    const n = nav({ stack: [room('a'), { kind: 'task', id: 't' }] });
    expect(removeKind(n, 'task').stack).toEqual([room('a')]);
    expect(removeKind(n, 'search')).toBe(n);
  });

  it('a tab switch shows its root; tapping the open tab returns to its root', () => {
    const deep = openChat(nav(), room('a'));
    expect(switchTab(deep, 'boards')).toMatchObject({ tab: 'boards', stack: [] });
    expect(switchTab(deep, 'chats')).toMatchObject({ tab: 'chats', stack: [] });
    const root = nav({ tab: 'boards' });
    expect(switchTab(root, 'boards')).toBe(root);
  });

  it('a board or a task lives on «Доски»; the profile is a tab', () => {
    // From another tab: «tab root → screen» (a board link, a notification).
    const link = pushOnTab(openChat(nav(), room('a')), 'boards', { kind: 'board', ws: 'w' });
    expect(link).toMatchObject({ tab: 'boards', stack: [{ kind: 'board', ws: 'w' }] });
    // On the tab: the task goes over the board, back returns to the board, then the list.
    const task = pushOnTab(link, 'boards', { kind: 'task', id: 't' });
    expect(task.stack.map((x) => x.kind)).toEqual(['board', 'task']);
    expect(popScreen(popScreen(task))).toMatchObject({ tab: 'boards', stack: [] });
    // The profile is a tab of its own (owner, 07.10): settings pushed from it pop back to its root.
    const profile = switchTab(nav({ tab: 'dms' }), 'profile');
    expect(profile).toMatchObject({ tab: 'profile', stack: [] });
    const settings = pushOnTab(profile, 'profile', { kind: 'settings', section: 'voice' });
    expect(popScreen(settings)).toMatchObject({ tab: 'profile', stack: [] });
  });

  it('popping the root does nothing', () => {
    const n = nav();
    expect(popScreen(n)).toBe(n);
  });
});

describe('back and the browser history (ADR-0073 §2)', () => {
  it('back closes a sheet before a screen', () => {
    expect(backStep({ overlay: true, depth: 2 })).toBe('overlay');
    expect(backStep({ overlay: false, depth: 2 })).toBe('screen');
    expect(backStep({ overlay: false, depth: 0 })).toBe('none');
    expect(backStep({ overlay: true, depth: 0 })).toBe('overlay');
  });

  it('needs one entry per screen and one per open layer (a menu and its sub-levels)', () => {
    expect(historyTarget(0, 0)).toBe(0);
    expect(historyTarget(2, 0)).toBe(2);
    expect(historyTarget(0, 1)).toBe(1);
    expect(historyTarget(2, 1)).toBe(3);
    // «+» → «Создать задачу ▸»: two cards, two backs before the screen.
    expect(historyTarget(1, 2)).toBe(3);
    expect(historyTarget(1, -1)).toBe(1);
  });

  it('plans pushes and back jumps', () => {
    expect(historyPlan(2, 0)).toEqual({ push: 2 });
    expect(historyPlan(1, 3)).toEqual({ go: -2 });
    expect(historyPlan(1, 1)).toBeNull();
  });

  it('reads our level from an entry, the base entry included', () => {
    expect(depthOfState({ calabaNav: 3 })).toBe(3);
    expect(depthOfState(null)).toBe(0);
    expect(depthOfState({ other: 1 })).toBe(0);
    expect(depthOfState({ calabaNav: -1 })).toBe(0);
  });
});

describe('settings screens (ADR-0073, owner 07.10)', () => {
  const list = { kind: 'settings' as const, section: null };

  it('a section is pushed over the list: back pops one screen at a time', () => {
    const n = openSettingsSection(nav({ stack: [list] }), 'voice');
    expect(n.stack).toEqual([list, { kind: 'settings', section: 'voice' }]);
    expect(popScreen(n).stack).toEqual([list]);
    expect(historyTarget(n.stack.length, 0)).toBe(2);
  });

  it('the same section again does not grow the stack; another section is its own screen', () => {
    const a = openSettingsSection(nav({ stack: [list] }), 'voice');
    expect(openSettingsSection(a, 'voice')).toBe(a);
    expect(openSettingsSection(a, 'about').stack).toHaveLength(3);
  });

  it('the settings screens go together when the window closes', () => {
    const n = openSettingsSection(nav({ stack: [list] }), 'voice');
    expect(removeKind(n, 'settings').stack).toEqual([]);
  });

  it('a section opened straight from the profile has no list under it', () => {
    const n = pushScreen(nav({ stack: [] }), { kind: 'settings', section: 'general' });
    expect(popScreen(n).stack).toEqual([]);
  });
});

describe('pinned tabs (ADR-0095 + addendum 2026-10-14)', () => {
  const four = ['chats', 'dms', 'boards', 'calendar'] as const;
  it('default is four pinned: chats, dms, boards, calendar', () => {
    expect(DEFAULT_PINNED).toEqual(four);
  });
  it('pinning never reorders and appends to the set', () => {
    expect(togglePin(['chats', 'dms'], 'disk')).toEqual({ pinned: ['chats', 'dms', 'disk'] });
  });
  it('pinning a fifth is refused (the card disables the pin), the set is untouched', () => {
    expect(togglePin(four, 'disk')).toEqual({ pinned: [...four], full: true });
  });
  it('unpinning removes just that tab, any time', () => {
    expect(togglePin(four, 'dms')).toEqual({ pinned: ['chats', 'boards', 'calendar'] });
    expect(togglePin(['chats'], 'chats')).toEqual({ pinned: [] });
  });
  it('normalizes a stored value without topping it up', () => {
    expect(normalizePinned(undefined)).toEqual([...four]);
    expect(normalizePinned(['chats', 'chats', 'x', 'disk'])).toEqual(['chats', 'disk']);
    expect(normalizePinned(['chats', 'dms', 'boards'])).toEqual(['chats', 'dms', 'boards']);
    expect(normalizePinned(['disk', 'wiki', 'calendar', 'dms', 'chats'])).toEqual(['disk', 'wiki', 'calendar', 'dms']);
  });
  it('migration from three cells appends the next available default', () => {
    expect(migratePinned(['chats', 'dms', 'boards'])).toEqual(['chats', 'dms', 'boards', 'calendar']);
    expect(migratePinned(['disk', 'chats', 'dms'])).toEqual(['disk', 'chats', 'dms', 'boards']);
    expect(migratePinned(['chats', 'calendar', 'boards'])).toEqual(['chats', 'calendar', 'boards', 'dms']);
    expect(migratePinned(undefined)).toEqual([...four]);
    expect(migratePinned([])).toEqual([...four]);
    expect(migratePinned(four)).toEqual([...four]);
  });
  it('order: stored first, missing appended in the default sequence; the lead keeps the old bar order', () => {
    expect(normalizeOrder(undefined)).toEqual([...PHONE_TABS]);
    expect(normalizeOrder(['profile', 'x', 'chats', 'chats'])).toEqual(['profile', 'chats', 'dms', 'calendar', 'boards', 'wiki', 'canvas', 'disk']);
    expect(normalizeOrder(undefined, ['disk', 'chats', 'dms', 'boards'])).toEqual(['disk', 'chats', 'dms', 'boards', 'calendar', 'wiki', 'canvas', 'profile']);
  });
  it('default order follows the rail: chats, dms, calendar, boards, wiki, canvas, disk, profile', () => {
    expect(PHONE_TABS).toEqual(['chats', 'dms', 'calendar', 'boards', 'wiki', 'canvas', 'disk', 'profile']);
  });
  it('moveTab puts the dragged row on the place of the target, both ways', () => {
    const o = ['chats', 'dms', 'calendar', 'boards', 'wiki', 'canvas', 'disk', 'profile'] as const;
    expect(moveTab(o, 'disk', 'dms')).toEqual(['chats', 'disk', 'dms', 'calendar', 'boards', 'wiki', 'canvas', 'profile']);
    expect(moveTab(o, 'chats', 'boards')).toEqual(['dms', 'calendar', 'boards', 'chats', 'wiki', 'canvas', 'disk', 'profile']);
    expect(moveTab(o, 'dms', 'dms')).toEqual([...o]);
    expect(moveTab(o, 'dms', 'nope' as never)).toEqual([...o]);
  });
  it('the bar is the pinned tabs in the order; dragging a row moves the tab, pins stay', () => {
    const all = [...PHONE_TABS];
    expect(barTabs(four, all)).toEqual({ bar: ['chats', 'dms', 'calendar', 'boards'], more: true });
    const order = moveTab(all, 'boards', 'chats');
    expect(barTabs(four, all, order)).toEqual({ bar: ['boards', 'chats', 'dms', 'calendar'], more: true });
    // moving an unpinned row does not move any pinned tab
    expect(barTabs(four, all, moveTab(all, 'disk', 'chats')).bar).toEqual(['chats', 'dms', 'calendar', 'boards']);
  });
  it('a guest gets what is available, topped up in order; «Ещё» only if something is hidden', () => {
    expect(barTabs(four, ['chats', 'profile'])).toEqual({ bar: ['chats', 'profile'], more: false });
    expect(barTabs(['calendar', 'disk', 'profile'], ['chats', 'profile', 'disk'])).toEqual({ bar: ['chats', 'disk', 'profile'], more: false });
  });
  it('fewer pinned than four is topped up from the available in order', () => {
    expect(barTabs(['disk'], [...PHONE_TABS]).bar).toEqual(['chats', 'dms', 'calendar', 'disk']);
  });
});

describe('disk screens (ADR-0094 §8)', () => {
  it('folders stack over the Disk tab; the same folder is returned to, the trash is its own screen', () => {
    let n = pushOnTab(nav({ tab: 'chats' }), 'disk', { kind: 'disk', folderId: 'a' });
    expect(n.tab).toBe('disk');
    n = pushScreen(n, { kind: 'disk', folderId: 'b' });
    n = pushScreen(n, { kind: 'disk', folderId: '', trash: true });
    expect(n.stack).toHaveLength(3);
    n = pushScreen(n, { kind: 'disk', folderId: 'a' });
    expect(n.stack).toEqual([{ kind: 'disk', folderId: 'a' }]);
  });
});

describe('wiki screens (ADR-0096 §7)', () => {
  it('pages stack over the Wiki tab; the same page is returned to, the trash is its own screen', () => {
    let n = pushOnTab(nav({ tab: 'chats' }), 'wiki', { kind: 'wiki', pageId: 'a' });
    expect(n.tab).toBe('wiki');
    n = pushScreen(n, { kind: 'wiki', pageId: 'b' });
    n = pushScreen(n, { kind: 'wiki', pageId: '', trash: true });
    expect(n.stack).toHaveLength(3);
    n = pushScreen(n, { kind: 'wiki', pageId: 'a' });
    expect(n.stack).toEqual([{ kind: 'wiki', pageId: 'a' }]);
  });
  it('the Wiki tab is behind «Ещё» by default and can be pinned', () => {
    expect(PHONE_TABS).toContain('wiki');
    expect(barTabs(DEFAULT_PINNED, PHONE_TABS).bar).not.toContain('wiki');
    expect(togglePin(['chats', 'dms', 'boards'], 'wiki')).toEqual({ pinned: ['chats', 'dms', 'boards', 'wiki'] });
  });
});

describe('canvas screens (ADR-0126 §5, view only on the phone)', () => {
  it('folders and canvases stack over the Canvas tab; the same item is returned to', () => {
    let n = pushOnTab(nav({ tab: 'chats' }), 'canvas', { kind: 'canvas', itemId: 'f1' });
    expect(n.tab).toBe('canvas');
    n = pushScreen(n, { kind: 'canvas', itemId: 'c1' });
    expect(n.stack).toHaveLength(2);
    n = pushScreen(n, { kind: 'canvas', itemId: 'f1' });
    expect(n.stack).toEqual([{ kind: 'canvas', itemId: 'f1' }]);
    n = pushOnTab(n, 'canvas', { kind: 'canvas', itemId: 'c2' });
    expect(n.stack).toHaveLength(2);
  });
  it('the Canvas tab is behind «Ещё» by default and can be pinned', () => {
    expect(PHONE_TABS).toContain('canvas');
    expect(barTabs(DEFAULT_PINNED, PHONE_TABS)).toMatchObject({ more: true });
    expect(barTabs(DEFAULT_PINNED, PHONE_TABS).bar).not.toContain('canvas');
    expect(togglePin(['chats', 'dms', 'boards'], 'canvas')).toEqual({ pinned: ['chats', 'dms', 'boards', 'canvas'] });
    expect(togglePin([...DEFAULT_PINNED], 'canvas')).toMatchObject({ full: true });
  });
});
