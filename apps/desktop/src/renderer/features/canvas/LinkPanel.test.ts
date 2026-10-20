// @vitest-environment jsdom
import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { CanvasLinkResponseSchema, CanvasLinkSchema, type CanvasLinkResponse } from '@calaba/protocol';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ link: vi.fn(), createLink: vi.fn(), deleteLink: vi.fn() }));
vi.mock('../../platform', () => ({ platform: { kind: 'web', apiBase: '', auth: { accessToken: () => Promise.resolve('t'), forceRefresh: () => Promise.resolve('t') } } }));
vi.mock('../../services/canvas', async (orig) => ({ ...(await orig<typeof import('../../services/canvas')>()), canvasApi: api }));

const { LinkPanel } = await import('./LinkPanel');

const CODE = 'C'.repeat(43);
const URL_ = `https://app.test/c/${CODE}`;
const live = (over: { expiresAtMs?: number; views?: bigint } = {}): CanvasLinkResponse =>
  create(CanvasLinkResponseSchema, {
    link: create(CanvasLinkSchema, { code: CODE, canvasId: 'c1', views: over.views ?? 3n, ...(over.expiresAtMs ? { expiresAt: timestampFromMs(over.expiresAtMs) } : {}) }),
    url: URL_,
  });
const none = (): CanvasLinkResponse => create(CanvasLinkResponseSchema, {});

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let host: HTMLElement | null = null;
const writeText = vi.fn(() => Promise.resolve());
beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  writeText.mockClear();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
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
const toggle = (): HTMLElement => document.querySelector('[data-testid="canvas-link"] [role="switch"]') as HTMLElement;

async function mount(restricted = false): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(LinkPanel, { itemId: 'c1', restricted })));
  await flush();
}

describe('«Ссылка» of a canvas', () => {
  it('turns the link on with the chosen term, shows and copies the address, then revokes it', async () => {
    api.link.mockResolvedValue(none());
    api.createLink.mockResolvedValue(live({ views: 0n }));
    api.deleteLink.mockResolvedValue(undefined);
    await mount();
    expect(api.link).toHaveBeenCalledWith('c1');
    expect(q('canvas-link-url')).toBeNull();
    const select = q('canvas-link-expiry') as HTMLSelectElement;
    act(() => {
      select.value = '7';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(api.createLink).not.toHaveBeenCalled(); // off: the term waits for the switch
    act(() => toggle().click());
    await flush();
    expect(api.createLink).toHaveBeenCalledWith('c1', 7);
    expect((q('canvas-link-url') as HTMLInputElement).value).toBe(URL_);
    act(() => (q('canvas-link-copy') as HTMLButtonElement).click());
    await flush();
    expect(writeText).toHaveBeenCalledWith(URL_);
    act(() => toggle().click());
    await flush();
    expect(api.deleteLink).toHaveBeenCalledWith('c1');
    expect(q('canvas-link-url')).toBeNull();
  });

  it('a live link shows its term and views; a new term keeps it live (the same code)', async () => {
    api.link.mockResolvedValue(live({ expiresAtMs: Date.now() + 6 * 86_400_000, views: 12n }));
    api.createLink.mockResolvedValue(live({ expiresAtMs: Date.now() + 30 * 86_400_000, views: 12n }));
    await mount();
    expect((q('canvas-link-expiry') as HTMLSelectElement).value).toBe('7');
    expect(q('canvas-link-meta')?.textContent).toContain('12');
    const select = q('canvas-link-expiry') as HTMLSelectElement;
    act(() => {
      select.value = '30';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(api.createLink).toHaveBeenCalledWith('c1', 30);
    expect(api.deleteLink).not.toHaveBeenCalled();
  });

  it('a private canvas cannot get a link: the switch is off and disabled, with the reason', async () => {
    api.link.mockResolvedValue(none());
    await mount(true);
    expect(q('canvas-link-private')).not.toBeNull();
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect((toggle() as HTMLButtonElement).disabled).toBe(true);
    act(() => toggle().click());
    await flush();
    expect(api.createLink).not.toHaveBeenCalled();
  });
});
