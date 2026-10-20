// @vitest-environment jsdom
import { CANVAS_BITS, type CanvasComment } from '@calaba/protocol';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { commentRights } from '../../../../lib/canvas/comments';
import { useCanvasComments } from '../../../../stores/canvasComments';
import { useSession } from '../../../../stores/session';
import { useWorkspaces } from '../../../../stores/workspaces';
import { destroyRigs, rig, type Rig } from '../../engine/testRig';

vi.mock('../../../../platform', () => ({ platform: { kind: 'web', app: { log: () => undefined, attention: () => undefined } } }));

// Pin renders are counted by the name lookup each pin does once per render.
const named = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../../../../stores/workspaces', async (orig) => {
  const mod = await orig<typeof import('../../../../stores/workspaces')>();
  return {
    ...mod,
    memberName: (_ws: string | null, id: string): string => {
      named.calls.push(id);
      return { me: 'Я', alice: 'Alice', bob: 'Bob' }[id] ?? id;
    },
  };
});
const access = vi.hoisted(() => ({ see: new Set<string>(), asked: [] as string[][] }));
vi.mock('../../../../services/canvasComments', async (orig) => {
  const mod = await orig<typeof import('../../../../services/canvasComments')>();
  return {
    ...mod,
    loadComments: vi.fn(() => Promise.resolve()),
    cachedCanvasMentionAccess: () => undefined,
    canvasMentionAccess: (_c: string, ids: readonly string[]) => {
      access.asked.push([...ids]);
      return Promise.resolve(access.see);
    },
  };
});

const { CommentPins } = await import('./CommentPins');
const { CommentsPanel } = await import('./CommentsPanel');
const { CommentInput } = await import('./CommentInput');

const W = 'ws';
const CV = 'cv';

let root: Root | null = null;
let host: HTMLElement | null = null;

const comment = (id: string, more: Partial<CanvasComment> = {}): CanvasComment =>
  ({ id, canvasId: CV, parentId: '', body: `text ${id}`, authorId: 'alice', resolved: false, objectId: '', x: 0, y: 0, mentions: [], ...more }) as CanvasComment;

function mount(el: ReturnType<typeof createElement>): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(el));
  return host;
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
});

beforeEach(() => {
  named.calls = [];
  access.see = new Set();
  access.asked = [];
  useCanvasComments.setState({ byId: {}, threads: {}, replies: {}, loaded: {}, panel: false, active: null, draft: null, focus: null, filterOpen: false });
  useSession.setState({ me: { user: { id: 'me' } } } as never);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  destroyRigs();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('the «Комментарий» tool (engine, ADR-0114 wave 4)', () => {
  it('a click reports the point and the object under it, the document is not touched; ⌥C toggles the tool', () => {
    const r = rig();
    const [note] = r.make({ init: { kind: 'sticky', x: 100, y: 100, w: 200, h: 200 } });
    const clicks: Array<{ objectId: string | null; x: number; y: number }> = [];
    r.engine.onCommentAt((c) => clicks.push({ objectId: c.objectId, x: c.world.x, y: c.world.y }));
    r.key('c', { altKey: true, code: 'KeyC' });
    expect(r.engine.tool).toBe('comment');
    const before = r.engine.scene.size;
    r.click(150, 160);
    r.click(900, 700);
    expect(clicks).toEqual([
      { objectId: note, x: 150, y: 160 },
      { objectId: null, x: 900, y: 700 },
    ]);
    expect(r.engine.scene.size).toBe(before);
    expect(r.engine.selection.size).toBe(0);
    r.key('ç', { altKey: true, code: 'KeyC' });
    expect(r.engine.tool).toBe('select');
  });

  it('a read-only canvas has no comment tool', () => {
    const r = rig({ readOnly: true });
    r.key('c', { altKey: true, code: 'KeyC' });
    expect(r.engine.tool).toBe('select');
  });
});

describe('pins (a DOM layer over the canvas, ADR-0114 wave 4)', () => {
  function pins(r: Rig): HTMLElement {
    const el = mount(createElement(CommentPins, { engine: r.engine, canvasId: CV, workspaceId: W }));
    return el.querySelector<HTMLElement>('[data-testid="canvas-comment-pins"]') as HTMLElement;
  }

  it('follow the camera and their objects by CSS alone; never ask the main canvas for a frame', () => {
    const r = rig();
    const [note] = r.make({ init: { kind: 'sticky', x: 100, y: 100, w: 200, h: 200 } });
    r.raf.flush();
    act(() => useCanvasComments.getState().setCanvas(CV, [comment('a', { objectId: note, x: 10, y: 20 }), comment('b', { x: -50, y: 7 })]));
    const layer = pins(r);
    const els = [...layer.querySelectorAll<HTMLElement>('[data-testid="canvas-comment-pin"]')];
    expect(els.map((e) => [e.style.getPropertyValue('--wx'), e.style.getPropertyValue('--wy')])).toEqual([['110', '120'], ['-50', '7']]);
    const frames = r.engine.stats.frames;
    const scheduled = r.raf.scheduled;
    // Someone else's comment, an edit, a resolve: no frame of the canvas.
    act(() => {
      useCanvasComments.getState().upsert(comment('c', { x: 1, y: 1, authorId: 'bob' }));
      useCanvasComments.getState().upsert(comment('b', { body: 'edited', x: -50, y: 7 }));
    });
    expect(r.raf.scheduled).toBe(scheduled);
    expect(r.engine.stats.frames).toBe(frames);
    expect(layer.querySelectorAll('[data-testid="canvas-comment-pin"]')).toHaveLength(3);
    // The camera: one style write on the layer.
    act(() => r.engine.setCamera({ tx: 30, ty: -40, scale: 2 }));
    expect(layer.style.transform).toBe('translate(30px, -40px)');
    expect(layer.style.getPropertyValue('--s')).toBe('2');
    // The object moves: its pin with it, without a React render.
    named.calls = [];
    act(() => r.engine.doc.patch(note ?? '', { x: 300 }));
    expect(els[0]?.style.getPropertyValue('--wx')).toBe('310');
    expect(named.calls).toEqual([]);
    // The object is deleted: its pin hides.
    act(() => r.engine.doc.remove([note ?? '']));
    expect(els[0]?.hidden).toBe(true);
  });

  it('a comment event re-renders its own pin only; resolved threads leave the canvas', () => {
    const r = rig();
    act(() => useCanvasComments.getState().setCanvas(CV, [comment('a'), comment('b', { authorId: 'bob' })]));
    const layer = pins(r);
    named.calls = [];
    act(() => useCanvasComments.getState().upsert(comment('b', { authorId: 'bob', body: 'changed' })));
    expect(named.calls).toEqual(['bob']);
    act(() => useCanvasComments.getState().upsert(comment('a', { resolved: true })));
    expect([...layer.querySelectorAll<HTMLElement>('[data-testid="canvas-comment-pin"]')].map((e) => e.dataset['commentId'])).toEqual(['b']);
  });
});

describe('the comments panel (rights, ADR-0114 wave 4)', () => {
  const setup = (bits: bigint, ownerId = 'owner'): HTMLElement => {
    const r = rig();
    act(() => {
      const st = useCanvasComments.getState();
      st.setCanvas(CV, [comment('mine', { authorId: 'me' }), comment('theirs', { authorId: 'bob' }), comment('done', { resolved: true })]);
      st.setPanel(true);
    });
    return mount(createElement(CommentsPanel, { canvasId: CV, workspaceId: W, rights: commentRights(bits, ownerId, 'me'), engine: r.engine }));
  };
  const count = (el: HTMLElement, id: string): number => el.querySelectorAll(`[data-testid="${id}"]`).length;

  it('a viewer reads only', () => {
    const el = setup(CANVAS_BITS.VIEW);
    expect(count(el, 'canvas-comment-thread')).toBe(3);
    expect(count(el, 'canvas-comment-resolve')).toBe(0);
    expect(count(el, 'canvas-comment-edit')).toBe(0);
    expect(count(el, 'canvas-comment-delete')).toBe(0);
    act(() => useCanvasComments.getState().setActive('theirs'));
    expect(count(el, 'canvas-comment-input')).toBe(0);
  });

  it('a writer resolves any thread and changes their own; the owner of the canvas changes anyone’s', () => {
    let el = setup(CANVAS_BITS.VIEW | CANVAS_BITS.WRITE);
    expect(count(el, 'canvas-comment-resolve')).toBe(3);
    expect(count(el, 'canvas-comment-edit')).toBe(1);
    act(() => useCanvasComments.getState().setActive('theirs'));
    expect(count(el, 'canvas-comment-input')).toBe(1);
    act(() => root?.unmount());
    el = setup(CANVAS_BITS.VIEW | CANVAS_BITS.WRITE, 'me');
    expect(count(el, 'canvas-comment-edit')).toBe(3);
  });

  it('«Только открытые» hides resolved threads', () => {
    const el = setup(CANVAS_BITS.VIEW);
    act(() => useCanvasComments.getState().setFilterOpen(true));
    expect([...el.querySelectorAll<HTMLElement>('[data-testid="canvas-comment-thread"]')].map((e) => e.dataset['threadId'])).toEqual(['mine', 'theirs']);
  });
});

describe('the @ list of the input (ADR-0114 wave 4)', () => {
  it('offers only members the server says see the canvas, and sends ids', async () => {
    useWorkspaces.setState({
      byId: {
        [W]: {
          members: {
            me: { user: { id: 'me', displayName: 'Я' }, role: 1 },
            alice: { user: { id: 'alice', displayName: 'Alice' }, role: 1 },
            bob: { user: { id: 'bob', displayName: 'Bob' }, role: 1 },
            robo: { user: { id: 'robo', displayName: 'Robo' }, role: 1 },
          },
          roles: [],
        },
      },
      users: { robo: { id: 'robo', isBot: true } },
    } as never);
    access.see = new Set(['alice']);
    const sent: string[] = [];
    const el = mount(
      createElement(CommentInput, {
        canvasId: CV, workspaceId: W, placeholder: 'p', submitLabel: 's',
        onSubmit: (w: string) => {
          sent.push(w);
          return Promise.resolve(true);
        },
      }),
    );
    const field = el.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      field.focus();
      field.dispatchEvent(new FocusEvent('focus'));
      await Promise.resolve();
    });
    // Bots and I are never asked about.
    expect(access.asked.flat().sort()).toEqual(['alice', 'bob']);
    const type = (v: string): void => {
      // React tracks the value through the instance: the prototype's setter makes it see a change.
      Reflect.apply(Reflect.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set ?? (() => undefined), field, [v]);
      field.setSelectionRange(v.length, v.length);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    };
    act(() => type('hi @'));
    const options = [...el.querySelectorAll('[role="option"]')].map((o) => o.textContent);
    expect(options).toHaveLength(1);
    expect(options[0]).toContain('Alice');
    act(() => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(field.value).toBe('hi @Alice ');
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
    });
    expect(sent).toEqual(['hi @alice']);
  });
});
