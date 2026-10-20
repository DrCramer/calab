// @vitest-environment jsdom
import { create } from '@bufbuild/protobuf';
import { PublicCanvasSchema } from '@calaba/protocol';
import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasView } from './view/CanvasView';

type ViewProps = ComponentProps<typeof CanvasView>;
const seen = vi.hoisted(() => ({ props: null as ViewProps | null, mounts: 0 }));
const pub = vi.hoisted(() => ({ meta: vi.fn(), alive: vi.fn() }));
vi.mock('../../platform', () => ({ isWeb: true, platform: { kind: 'web', apiBase: '', auth: { accessToken: () => Promise.resolve(null), forceRefresh: () => Promise.resolve(null) } } }));
vi.mock('../../services/canvasPublic', () => ({ canvasPublic: pub }));
// The canvas chunk is the view's own test (CanvasView.test.ts): here only what the page hands it.
vi.mock('./lazy', () => ({
  CanvasViewLazy: (p: ViewProps) => {
    seen.props = p;
    seen.mounts++;
    return null;
  },
}));

const { CanvasPublicPage, publicDeps } = await import('./PublicPage');

const CODE = 'D'.repeat(43);

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
});

let root: Root | null = null;
let host: HTMLElement | null = null;
beforeEach(() => {
  pub.meta.mockReset();
  pub.alive.mockReset();
  seen.props = null;
  seen.mounts = 0;
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

const flush = (): Promise<void> =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
const q = (id: string): HTMLElement | null => document.querySelector(`[data-testid="${id}"]`);

async function mount(): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(CanvasPublicPage, { code: CODE })));
  await flush();
}

describe('/c/{code}', () => {
  it('shows the name, «Только просмотр» and the canvas in the anonymous view-only mode; noindex', async () => {
    pub.meta.mockResolvedValue(create(PublicCanvasSchema, { name: 'Roadmap', readOnly: true }));
    await mount();
    expect(pub.meta).toHaveBeenCalledWith(CODE, expect.any(AbortSignal));
    expect(q('canvas-public-title')?.textContent).toBe('Roadmap');
    expect(q('canvas-public-readonly')).not.toBeNull();
    expect(document.title).toContain('Roadmap');
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex,nofollow');
    expect(document.head.querySelector('meta[name="referrer"]')?.getAttribute('content')).toBe('no-referrer');
    const p = seen.props as ViewProps;
    expect(p.publicCode).toBe(CODE);
    expect(p.bits).toBe(0n);
    expect(p.canvasId).toBe('public');
    expect(p.deps?.user()).toEqual({ id: '', name: '' });
    await expect(p.deps?.getToken()).resolves.toBeNull();
  });

  it('a refused link (404 and the like) is one neutral screen, and the canvas never mounts', async () => {
    pub.meta.mockRejectedValue(new Error('404'));
    await mount();
    expect(q('canvas-public-gone')).not.toBeNull();
    expect(seen.mounts).toBe(0);
  });

  it('the socket closed for good (revoked meanwhile: 4404) ends in the same screen', async () => {
    pub.meta.mockResolvedValue(create(PublicCanvasSchema, { name: 'X', readOnly: true }));
    await mount();
    act(() => seen.props?.onFatal?.(4404));
    expect(q('canvas-public-gone')).not.toBeNull();
  });
});

describe('publicDeps', () => {
  class FakeWs extends EventTarget {
    constructor(readonly url: string) {
      super();
    }
  }
  const sockets: FakeWs[] = [];
  const make = (url: string): WebSocket => {
    const ws = new FakeWs(url);
    sockets.push(ws);
    return ws as unknown as WebSocket;
  };

  it('a socket that fails before it opens asks with HEAD; only a 404 ends the page', async () => {
    const onGone = vi.fn();
    const d = publicDeps(CODE, onGone, make);
    pub.alive.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    d.createSocket('wss://x/1');
    sockets.at(-1)?.dispatchEvent(new Event('close'));
    await flush();
    expect(pub.alive).toHaveBeenCalledTimes(1);
    expect(onGone).not.toHaveBeenCalled();
    d.createSocket('wss://x/2');
    sockets.at(-1)?.dispatchEvent(new Event('close'));
    await flush();
    expect(onGone).toHaveBeenCalledTimes(1);
    // A socket that opened and then closed is the provider's (backoff, 4404): no HEAD.
    d.createSocket('wss://x/3');
    sockets.at(-1)?.dispatchEvent(new Event('open'));
    sockets.at(-1)?.dispatchEvent(new Event('close'));
    await flush();
    expect(pub.alive).toHaveBeenCalledTimes(2);
  });
});
