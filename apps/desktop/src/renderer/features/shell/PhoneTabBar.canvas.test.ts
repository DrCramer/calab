// @vitest-environment jsdom
import { WorkspaceRole } from '@calaba/protocol';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PINNED } from '../../lib/phoneNav';
import { usePrefs } from '../../stores/prefs';
import { useSession } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { useWorkspaces } from '../../stores/workspaces';
import { TabBar, tabLabel } from './PhoneTabBar';

vi.mock('../../platform', () => ({ platform: { kind: 'web', app: { log: () => undefined, attention: () => undefined } } }));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  Element.prototype.scrollIntoView = () => undefined;
});

let root: Root;
let host: HTMLElement;
const q = (id: string): HTMLElement | null => document.querySelector(`[data-testid="${id}"]`);

async function render(guest = false): Promise<void> {
  useSession.setState({ me: { user: { id: 'me', displayName: 'Me', isGuest: guest } } } as never);
  useWorkspaces.setState({ order: ['w'], byId: { w: { role: guest ? WorkspaceRole.GUEST : WorkspaceRole.MEMBER } } } as never);
  await act(async () => {
    root.render(createElement(TabBar, { tab: 'chats' }));
  });
}

async function openMore(): Promise<void> {
  await act(async () => {
    const e = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 });
    q('phone-tab-more')?.dispatchEvent(e);
  });
  expect(q('phone-more-card')).not.toBeNull();
}

beforeEach(() => {
  usePrefs.setState({ phonePinnedTabs: [...DEFAULT_PINNED] });
  useUi.getState().setPhone(() => ({ on: true, tab: 'chats', stack: [] }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
});

describe('«Холст» in the phone «Ещё» card (ADR-0095)', () => {
  it('is named «Холст», not pinned by default, and listed in the card with its icon and a pin', async () => {
    expect(tabLabel('canvas')).toBe(tabLabel('canvas'));
    await render();
    expect(q('phone-tab-canvas')).toBeNull();
    await openMore();
    const row = q('more-row-canvas');
    expect(row).not.toBeNull();
    expect(row?.textContent).toMatch(/Холст|Canvas/);
    expect(row?.querySelector('svg')).not.toBeNull();
    expect(q('more-pin-canvas')).not.toBeNull();
  });

  it('a tap on the row opens the section on the phone', async () => {
    await render();
    await openMore();
    await act(async () => q('more-row-canvas')?.click());
    expect(useUi.getState().phone).toMatchObject({ tab: 'canvas', stack: [] });
  });

  it('with four tabs on the bar the pin is refused; moved up in the card it takes a cell of the bar', async () => {
    await render();
    await openMore();
    expect(q('more-pin-canvas')?.hasAttribute('data-disabled')).toBe(true);
    expect(q('more-pin-hint')).not.toBeNull();
    await act(async () => usePrefs.setState({ phonePinnedTabs: ['chats', 'dms', 'boards'], phoneTabOrder: ['chats', 'dms', 'boards', 'canvas', 'calendar', 'wiki', 'disk', 'profile'] }));
    expect(q('phone-tab-canvas')?.getAttribute('aria-current')).toBeNull();
    expect(q('phone-tab-calendar')).toBeNull();
    expect(q('more-pin-canvas')?.getAttribute('aria-checked')).toBe('true');
    await act(async () => q('more-pin-canvas')?.click());
    expect(usePrefs.getState().phonePinnedTabs).toEqual(['chats', 'dms', 'boards']);
  });

  it('a guest has no Canvas, like the other workspace sections', async () => {
    await render(true);
    expect(q('phone-tab-canvas')).toBeNull();
    expect(q('phone-tab-more')).toBeNull();
  });
});
