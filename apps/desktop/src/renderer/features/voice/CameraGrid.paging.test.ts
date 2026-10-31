// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePrefs } from '../../stores/prefs';
import { useSession } from '../../stores/session';
import { setVoice, useVoice } from '../../stores/voice';
import { useWorkspaces } from '../../stores/workspaces';

vi.mock('../../platform', () => ({ isWeb: false, platform: { kind: 'desktop', apiBase: '', apiFetch: vi.fn(), app: { log: () => undefined, attention: () => undefined } } }));
// The engine's paging and camera API as the grid uses it (no LiveKit): the page lives in the store.
vi.mock('../../services/voice', async () => {
  const { setVoice: set, useVoice: store } = await import('../../stores/voice');
  return {
    voice: {
      primaryCamera: () => null,
      cameraTrack: () => null,
      showCamera: () => () => undefined,
      focusTile: () => undefined,
      setStage: () => undefined,
      showVideo: () => undefined,
      setGalleryPage: (page: number) => {
        if (store.getState().galleryPage !== page) set({ galleryPage: Math.max(0, page) });
      },
    },
  };
});
vi.mock('../people/MemberContextMenu', () => ({ MemberContextMenu: ({ children }: { children: unknown }) => children }));
vi.mock('./JustJoinedDot', () => ({ JustJoinedDot: () => null }));

import { CameraGrid } from './CameraTiles';

const WS = 'w';
const BOX = { top: 0, height: 600 } as never;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    constructor(private readonly cb: () => void) {}
    observe(): void {
      this.cb();
    }
    unobserve(): void {}
    disconnect(): void {}
  };
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as never;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 960 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 540 });
});

let root: Root;
let host: HTMLElement;
const q = (id: string): HTMLElement | null => document.querySelector(`[data-testid="${id}"]`);
const tiles = (): number => document.querySelectorAll('[data-testid="video-tile"]').length;

/** `n` people in the room, everyone but me with a camera. */
function room(n: number): void {
  const voice: Record<string, unknown> = {};
  const cameras = [];
  for (let i = 0; i < n; i++) {
    const userId = i === 0 ? 'me' : `u${i}`;
    voice[userId] = { userId, roomId: 'r', joinedAt: { seconds: BigInt(i) } };
    if (i > 0) cameras.push({ userId, trackSid: `TR_${i}`, identity: userId });
  }
  useWorkspaces.setState({ byId: { [WS]: { voice, members: {} } } } as never);
  setVoice({ cameras });
}

function render(): void {
  act(() => {
    root.render(createElement(CameraGrid, { box: BOX, wsId: WS }));
  });
}

const click = (id: string): void =>
  act(() => {
    q(id)?.click();
  });

beforeEach(() => {
  // 1024×768 (jsdom) → 9 tiles a page.
  useSession.setState({ me: { user: { id: 'me', displayName: 'Me' } } } as never);
  usePrefs.setState({ callView: 'gallery', hideSelf: false, hideNoVideo: false, hiddenVideo: {}, saveTraffic: false });
  setVoice({ roomId: 'r', galleryPage: 0, focusedTile: null, cameras: [], camera: 'off', speaking: {} });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
});

describe('gallery paging with many cameras (owner: «след. экран» crashed the UI)', () => {
  it('flips through every page and back without a render error', () => {
    room(20);
    render();
    expect(q('video-page')?.textContent).toMatch(/1.*3/);
    expect(tiles()).toBe(9);
    click('video-page-next');
    expect(useVoice.getState().galleryPage).toBe(1);
    expect(q('video-page')?.textContent).toMatch(/2.*3/);
    expect(tiles()).toBe(9);
    click('video-page-next');
    expect(q('video-page')?.textContent).toMatch(/3.*3/);
    expect(tiles()).toBe(2);
    expect(q('video-page-next')).toBeNull();
    click('video-page-prev');
    click('video-page-prev');
    expect(useVoice.getState().galleryPage).toBe(0);
    expect(tiles()).toBe(9);
  });

  it('←/→ flip pages and stop at the ends', () => {
    room(12);
    render();
    const key = (k: string): void =>
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: k, cancelable: true }));
      });
    key('ArrowRight');
    expect(useVoice.getState().galleryPage).toBe(1);
    key('ArrowRight');
    expect(useVoice.getState().galleryPage).toBe(1);
    expect(tiles()).toBe(3);
    key('ArrowLeft');
    expect(useVoice.getState().galleryPage).toBe(0);
  });

  it('clamps the page when cameras leave while on the last page', () => {
    room(20);
    render();
    click('video-page-next');
    click('video-page-next');
    act(() => room(12));
    expect(useVoice.getState().galleryPage).toBe(1);
    expect(tiles()).toBe(3);
    act(() => room(5));
    expect(useVoice.getState().galleryPage).toBe(0);
    expect(tiles()).toBe(5);
    expect(q('video-page')).toBeNull();
  });

  it('a page past the end (store ahead of the layout) is clamped, not rendered empty', () => {
    room(20);
    act(() => setVoice({ galleryPage: 7 }));
    render();
    expect(useVoice.getState().galleryPage).toBe(2);
    expect(tiles()).toBe(2);
  });
});
