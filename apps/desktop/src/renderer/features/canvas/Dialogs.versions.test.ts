// @vitest-environment jsdom
import { create } from '@bufbuild/protobuf';
import { CanvasVersionSchema, CanvasVersionsResponseSchema, type CanvasVersion, type CanvasVersionsResponse } from '@calaba/protocol';
import { StrictMode, act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeById } from '../../lib/canvas/tree';

const versions = vi.hoisted(() => vi.fn());
vi.mock('../../platform', () => ({ platform: { kind: 'web', apiBase: '', auth: { accessToken: () => Promise.resolve('t'), forceRefresh: () => Promise.resolve('t') } } }));
vi.mock('../../services/canvas', async (orig) => ({
  ...(await orig<typeof import('../../services/canvas')>()),
  canvasApi: { versions },
}));
vi.mock('../../lib/canvas/docHandle', () => ({ canvasDocHandle: () => null }));

const { VersionsDialog } = await import('./Dialogs');

const version = (id: string): CanvasVersion => create(CanvasVersionSchema, { id, size: 100 });
const page = (ids: string[], nextCursor = ''): CanvasVersionsResponse => create(CanvasVersionsResponseSchema, { versions: ids.map(version), nextCursor });

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

const flush = (): Promise<void> => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const rows = (): number => document.querySelectorAll('[data-testid="canvas-version-row"]').length;

function mount(canvasId: string, strict: boolean): void {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const el = createElement(VersionsDialog, { workspaceId: 'w', canvasId, onClose: () => undefined });
  act(() => root?.render(strict ? createElement(StrictMode, null, el) : el));
}

describe('mergeById', () => {
  it('adds only the ids it does not have; the same array when nothing is new', () => {
    const l = [{ id: 'a' }, { id: 'b' }];
    expect(mergeById(l, [{ id: 'b' }, { id: 'c' }, { id: 'c' }])).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    expect(mergeById(l, [{ id: 'a' }])).toBe(l);
  });
});

describe('«История версий» loading', () => {
  beforeEach(() => {
    versions.mockReset();
  });

  it('StrictMode double mount: each version is listed once', async () => {
    versions.mockImplementation(() => Promise.resolve(page(['v3', 'v2', 'v1'])));
    mount('c', true);
    await flush();
    expect(versions).toHaveBeenCalledTimes(2);
    expect(rows()).toBe(3);
  });

  it('the next page is appended, not duplicated, and the cursor moves on', async () => {
    versions.mockImplementation((_id: string, cursor?: string) => Promise.resolve(cursor ? page(['v2', 'v1']) : page(['v3', 'v2'], 'cur')));
    mount('c', true);
    await flush();
    expect(rows()).toBe(2);
    const more = [...document.querySelectorAll('button')].find((b) => b.textContent && b.className.includes('text-accent-text'));
    expect(more).toBeTruthy();
    act(() => more?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();
    expect(versions).toHaveBeenLastCalledWith('c', 'cur');
    expect(rows()).toBe(3); // v3, v2 + v1 (v2 came again)
    expect([...document.querySelectorAll('button')].some((b) => b.className.includes('text-accent-text'))).toBe(false);
  });

  it('a stale answer after unmount sets nothing', async () => {
    let resolve: (r: CanvasVersionsResponse) => void = () => undefined;
    versions.mockImplementation(() => new Promise<CanvasVersionsResponse>((r) => (resolve = r)));
    mount('c', false);
    act(() => root?.unmount());
    root = null;
    resolve(page(['v1']));
    await flush();
    expect(rows()).toBe(0);
  });
});
