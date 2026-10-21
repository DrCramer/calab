// @vitest-environment jsdom
import { create } from '@bufbuild/protobuf';
import { PublicCanvasSchema } from '@calaba/protocol';
import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasView } from './view/CanvasView';

type ViewProps = ComponentProps<typeof CanvasView>;
const seen = vi.hoisted(() => ({ props: null as ViewProps | null, mounts: 0 }));
const pub = vi.hoisted(() => ({ meta: vi.fn(), probe: vi.fn() }));
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
const { ApiError } = await import('../../lib/api/client');

const CODE = 'D'.repeat(43);

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
});

let root: Root | null = null;
let host: HTMLElement | null = null;
beforeEach(() => {
  pub.meta.mockReset();
  pub.probe.mockReset();
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

  it('a refused link (404) is one neutral screen, and the canvas never mounts', async () => {
    pub.meta.mockRejectedValue(new ApiError('NOT_FOUND', 'link', 404));
    await mount();
    expect(q('canvas-public-gone')).not.toBeNull();
    expect(seen.mounts).toBe(0);
  });

  it('too many viewers from one network (429) is a line under the header, and the name is asked again', async () => {
    vi.useFakeTimers();
    try {
      pub.meta
        .mockRejectedValueOnce(new ApiError('RATE_LIMITED', 'slow down', 429))
        .mockRejectedValueOnce(new TypeError('network'))
        .mockResolvedValue(create(PublicCanvasSchema, { name: 'Roadmap', readOnly: true }));
      host = document.createElement('div');
      document.body.append(host);
      root = createRoot(host);
      act(() => root?.render(createElement(CanvasPublicPage, { code: CODE })));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(q('canvas-public-busy')?.textContent).toBe('Слишком много зрителей с вашей сети, попробуйте позже');
      expect(q('canvas-public-gone')).toBeNull();
      expect(seen.mounts).toBe(0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000); // the first retry (0.5–1 s): a network failure, again
      });
      expect(pub.meta).toHaveBeenCalledTimes(2);
      expect(q('canvas-public-gone')).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(pub.meta).toHaveBeenCalledTimes(3);
      expect(q('canvas-public-busy')).toBeNull();
      expect(seen.props?.publicCode).toBe(CODE);
    } finally {
      vi.useRealTimers();
    }
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

  const closeWith = (code?: number): Event => Object.assign(new Event('close'), { code });

  it('a socket that fails before it opens asks with HEAD; only a 404 ends the page, a 429 says busy', async () => {
    const onGone = vi.fn();
    const onBusy = vi.fn();
    const d = publicDeps(CODE, onGone, onBusy, make);
    pub.probe.mockResolvedValueOnce('ok').mockResolvedValueOnce('gone').mockResolvedValueOnce('busy');
    d.createSocket('wss://x/1');
    sockets.at(-1)?.dispatchEvent(closeWith());
    await flush();
    expect(pub.probe).toHaveBeenCalledTimes(1);
    expect(onGone).not.toHaveBeenCalled();
    d.createSocket('wss://x/2');
    sockets.at(-1)?.dispatchEvent(closeWith());
    await flush();
    expect(onGone).toHaveBeenCalledTimes(1);
    d.createSocket('wss://x/3');
    sockets.at(-1)?.dispatchEvent(closeWith());
    await flush();
    expect(onBusy).toHaveBeenLastCalledWith(true);
    // A socket that opened and then closed is the provider's (backoff, 4404): no HEAD.
    d.createSocket('wss://x/4');
    sockets.at(-1)?.dispatchEvent(new Event('open'));
    sockets.at(-1)?.dispatchEvent(closeWith(4404));
    await flush();
    expect(pub.probe).toHaveBeenCalledTimes(3);
    expect(onGone).toHaveBeenCalledTimes(1);
  });

  it('a close 4008 (too many viewers of the link or of this network) says busy until a socket gets its first frame', () => {
    const onBusy = vi.fn();
    const d = publicDeps(CODE, vi.fn(), onBusy, make);
    d.createSocket('wss://x/1');
    sockets.at(-1)?.dispatchEvent(new Event('open'));
    sockets.at(-1)?.dispatchEvent(closeWith(4008));
    expect(onBusy).toHaveBeenLastCalledWith(true);
    d.createSocket('wss://x/2');
    sockets.at(-1)?.dispatchEvent(new Event('open'));
    sockets.at(-1)?.dispatchEvent(new Event('message'));
    sockets.at(-1)?.dispatchEvent(new Event('message'));
    expect(onBusy).toHaveBeenLastCalledWith(false);
    expect(onBusy).toHaveBeenCalledTimes(2);
    expect(pub.probe).not.toHaveBeenCalled();
  });
});
