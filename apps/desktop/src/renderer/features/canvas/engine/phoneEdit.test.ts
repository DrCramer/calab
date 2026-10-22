// @vitest-environment jsdom
import * as Y from 'yjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CanvasEngine, type EngineOptions } from './engine';
import { defaultPalette } from './palette';
import { fakeCtx, manualRaf } from './testing';

/** The phone's edit mode in the engine (ADR-0116 wave 5b): touch pointers on an editable canvas with `touch: true`. */
interface Rig {
  engine: CanvasEngine;
  canvas: HTMLCanvasElement;
  host: HTMLElement;
  raf: ReturnType<typeof manualRaf>;
  clock: { t: number };
  /** The recording 2D context the canvas draws on. */
  fake: ReturnType<typeof fakeCtx>;
  down(id: number, x: number, y: number): void;
  move(id: number, x: number, y: number): void;
  up(id: number, x: number, y: number): void;
  tap(x: number, y: number): void;
  /** One finger: down, a few moves, up. */
  drag(from: [number, number], to: [number, number]): void;
  /** The next pointerdown starts a new touch sequence (primary), as after a lost pointerup. */
  forget(): void;
  cam(): CanvasEngine['camera'];
  make(...inits: Parameters<CanvasEngine['doc']['createMany']>[0]): string[];
}

const rigs: Rig[] = [];
const sticky = (x: number, y: number, w = 160, h = 160, extra: object = {}) => ({ init: { kind: 'sticky' as const, x, y, w, h, ...extra } });

function rig(opts: Partial<EngineOptions> = {}): Rig {
  const fake = fakeCtx();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fake.ctx as never);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const canvas = document.createElement('canvas');
  host.appendChild(canvas);
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 800, right: 400, bottom: 800, x: 0, y: 0, toJSON: () => ({}) });
  const raf = manualRaf();
  const clock = { t: 10_000 };
  const engine = new CanvasEngine({
    canvas, doc: new Y.Doc(), palette: defaultPalette('light'), raf: raf.raf, cancelRaf: raf.cancel, now: () => clock.t,
    measure: (t, s) => t.length * s * 0.5, gridSize: 0, reducedMotion: true, touch: true, ...opts,
  });
  const down = new Set<number>();
  const ptr = (type: string, id: number, x: number, y: number): void => {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(e, 'pointerId', { value: id });
    Object.defineProperty(e, 'pointerType', { value: 'touch' });
    if (type === 'pointerdown') {
      Object.defineProperty(e, 'isPrimary', { value: down.size === 0 });
      down.add(id);
    }
    if (type === 'pointerup' || type === 'pointercancel') down.delete(id);
    canvas.dispatchEvent(e);
  };
  const r: Rig = {
    engine, canvas, host, raf, clock, fake,
    down: (id, x, y) => ptr('pointerdown', id, x, y),
    move: (id, x, y) => ptr('pointermove', id, x, y),
    up: (id, x, y) => ptr('pointerup', id, x, y),
    tap(x, y) {
      this.down(1, x, y);
      this.up(1, x, y);
    },
    drag(from, to) {
      this.down(1, from[0], from[1]);
      this.move(1, (from[0] + to[0]) / 2, (from[1] + to[1]) / 2);
      this.move(1, to[0], to[1]);
      this.up(1, to[0], to[1]);
    },
    cam: () => {
      raf.flush();
      return engine.camera;
    },
    make: (...inits) => engine.doc.createMany(inits),
    forget: () => down.clear(),
  };
  rigs.push(r);
  return r;
}

afterEach(() => {
  for (const r of rigs.splice(0)) r.engine.destroy();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('revealSelection: the selected object stays out from under the sheet', () => {
  it('moves the camera up just enough for an object under the bottom inset, zoom unchanged', () => {
    const r = rig();
    const [id] = r.make(sticky(100, 620));
    r.engine.setSelection([id as string]);
    // The object spans y 620..780 of an 800 px view; a 200 px sheet leaves 592 (8 px margin).
    expect(r.engine.revealSelection({ top: 64, bottom: 200 })).toBe(true);
    const c = r.cam();
    expect(c.scale).toBe(1);
    expect(c.tx).toBe(0);
    expect(c.ty).toBeCloseTo(-188, 5);
    // Already in place: nothing more to do.
    expect(r.engine.revealSelection({ top: 64, bottom: 200 })).toBe(false);
  });

  it('moves it down from under the top bars, aligns a taller-than-free object to the top, and ignores an empty selection', () => {
    const r = rig();
    const [a, b] = r.make(sticky(100, 10, 160, 100), sticky(100, 100, 160, 900));
    expect(r.engine.revealSelection({ top: 64, bottom: 200 })).toBe(false);
    r.engine.setSelection([a as string]);
    expect(r.engine.revealSelection({ top: 64, bottom: 200 })).toBe(true);
    expect(r.cam().ty).toBeCloseTo(62, 5);
    r.engine.setCamera({ tx: 0, ty: 0, scale: 1 });
    r.engine.setSelection([b as string]);
    expect(r.engine.revealSelection({ top: 64, bottom: 200 })).toBe(true);
    expect(r.cam().ty).toBeCloseTo(72 - 100, 5);
  });

  it('does nothing during a gesture', () => {
    const r = rig();
    const [id] = r.make(sticky(100, 620));
    r.engine.setSelection([id as string]);
    r.down(1, 150, 700);
    expect(r.engine.revealSelection({ top: 64, bottom: 200 })).toBe(false);
    r.up(1, 150, 700);
  });
});

const obj = (r: Rig, id: string) => r.engine.scene.get(id) as { x: number; y: number; w: number; h: number; rot?: number };

describe('touch gestures on an editable canvas', () => {
  it('a tap selects an object (a tap on empty canvas clears it); nothing moves', () => {
    const r = rig();
    const [a] = r.make(sticky(100, 100));
    r.engine.setSelection([]);
    r.tap(180, 180);
    expect([...r.engine.selection]).toEqual([a]);
    expect(obj(r, a as string)).toMatchObject({ x: 100, y: 100 });
    r.tap(350, 700);
    expect(r.engine.selection.size).toBe(0);
  });

  it('dragging the selected object moves it; dragging an unselected one pans the view instead', () => {
    const r = rig();
    const [a, b] = r.make(sticky(100, 100), sticky(100, 400));
    r.tap(180, 180);
    r.drag([180, 180], [230, 250]);
    expect(obj(r, a as string)).toMatchObject({ x: 150, y: 170 });
    expect(r.cam()).toMatchObject({ tx: 0, ty: 0 });
    // b is not selected: the same drag pans, b stays and the selection is untouched
    r.drag([180, 480], [230, 540]);
    expect(obj(r, b as string)).toMatchObject({ x: 100, y: 400 });
    expect([...r.engine.selection]).toEqual([a]);
    expect(r.cam()).toMatchObject({ tx: 50, ty: 60 });
  });

  it('a lost release keeps the finished move: the next touch does not take it back', () => {
    const r = rig();
    const [a] = r.make(sticky(100, 100), sticky(100, 400));
    r.engine.doc.checkpoint();
    r.tap(180, 180);
    r.down(1, 180, 180);
    r.move(1, 205, 215);
    r.move(1, 230, 250);
    r.forget(); // the pointerup never came (a system gesture took the finger)
    r.tap(300, 700);
    expect(obj(r, a as string)).toMatchObject({ x: 150, y: 170 });
    expect(r.engine.doc.snapshot(a as string)).toMatchObject({ x: 150, y: 170 });
    expect(r.engine.doc.live.size).toBe(0);
    r.engine.undo();
    expect(obj(r, a as string)).toMatchObject({ x: 100, y: 100 });
    expect(r.engine.doc.count).toBe(2);
  });

  it('dragging empty canvas pans, and a finger that wanders a few px still taps', () => {
    const r = rig();
    const [a] = r.make(sticky(100, 100));
    r.drag([300, 600], [250, 640]);
    expect(r.cam()).toMatchObject({ tx: -50, ty: 40 });
    r.engine.setCamera({ tx: 0, ty: 0, scale: 1 });
    r.down(1, 180, 180);
    r.move(1, 184, 183);
    r.up(1, 184, 183);
    expect([...r.engine.selection]).toEqual([a]);
    expect(r.cam()).toMatchObject({ tx: 0, ty: 0 });
    // and a selected object tapped with the same wobble does not move
    r.down(1, 180, 180);
    r.move(1, 185, 184);
    r.up(1, 185, 184);
    expect(obj(r, a as string)).toMatchObject({ x: 100, y: 100 });
  });

  it('two fingers always pan and zoom: they never move the selected object under them, and cancel a started move', () => {
    const r = rig();
    const [a] = r.make(sticky(100, 100));
    r.tap(180, 180);
    r.down(1, 150, 150);
    r.move(1, 160, 160);
    expect(obj(r, a as string).x).toBeGreaterThan(100);
    r.down(2, 250, 250);
    // the move the first finger had begun is undone, the pair pinches
    expect(obj(r, a as string)).toMatchObject({ x: 100, y: 100 });
    r.move(1, 100, 100);
    r.move(2, 300, 300);
    r.up(2, 300, 300);
    r.up(1, 100, 100);
    expect(obj(r, a as string)).toMatchObject({ x: 100, y: 100 });
    expect(r.cam().scale).toBeGreaterThan(1);
    // fingers landing together on the selected object do not move it either
    r.engine.setCamera({ tx: 0, ty: 0, scale: 1 });
    r.engine.setSelection([a as string]);
    r.down(1, 150, 150);
    r.down(2, 200, 200);
    r.move(1, 130, 130);
    r.move(2, 220, 220);
    r.up(2, 220, 220);
    r.up(1, 130, 130);
    expect(obj(r, a as string)).toMatchObject({ x: 100, y: 100 });
  });

  it('«Выбрать несколько»: taps add and remove; a drag on an unselected object still pans', () => {
    const r = rig();
    const [a, b] = r.make(sticky(100, 100), sticky(100, 400));
    r.engine.setMultiSelect(true);
    expect(r.engine.getState().multiSelect).toBe(true);
    r.tap(180, 180);
    r.tap(180, 480);
    expect(new Set(r.engine.selection)).toEqual(new Set([a, b]));
    r.tap(180, 180);
    expect([...r.engine.selection]).toEqual([b]);
    r.drag([180, 180], [200, 260]);
    expect(obj(r, a as string)).toMatchObject({ x: 100, y: 100 });
    expect(r.cam()).toMatchObject({ ty: 80 });
    // tapping empty canvas still clears
    r.tap(380, 790);
    expect(r.engine.selection.size).toBe(0);
    r.engine.setMultiSelect(false);
    expect(r.engine.getState().multiSelect).toBe(false);
  });

  it('the tool places an object with a tap, a text opens its editor at once, a drag with the tool armed pans', () => {
    const r = rig();
    r.engine.setTool('sticky');
    r.drag([300, 600], [250, 640]);
    expect(r.engine.scene.size).toBe(0);
    expect(r.cam()).toMatchObject({ tx: -50, ty: 40 });
    r.engine.setCamera({ tx: 0, ty: 0, scale: 1 });
    r.tap(200, 300);
    expect(r.engine.scene.size).toBe(1);
    expect(r.engine.tool).toBe('select');
    expect(r.engine.selection.size).toBe(1);
    r.engine.editor.commit();
    r.engine.setTool('text');
    r.tap(100, 500);
    expect(r.engine.scene.size).toBe(2);
    expect(r.engine.editor.isOpen).toBe(true);
    r.engine.editor.cancel();
    r.engine.setShapeKind('hexagon');
    r.engine.setTool('shape');
    r.tap(200, 700);
    const kinds = [...r.engine.scene.query({ x: -9999, y: -9999, w: 20000, h: 20000 })].map((o) => (o.kind === 'shape' ? o.shape : o.kind));
    expect(kinds).toContain('hexagon');
  });

  it('a connector is dragged from object to object, and a finger 14 px off the edge still glues (the mouse would not)', () => {
    const r = rig();
    const [a, b] = r.make(sticky(100, 100), sticky(100, 400));
    r.engine.setTool('connector');
    // 14 px under b's bottom edge (560)
    r.drag([180, 180], [180, 574]);
    const conn = r.engine.getSelected()[0];
    expect(conn?.kind).toBe('connector');
    if (conn?.kind !== 'connector') return;
    expect(conn.from).toMatchObject({ id: a });
    expect(conn.to).toMatchObject({ id: b });
    // the same release 40 px away is free
    r.engine.setTool('connector');
    r.drag([180, 180], [180, 600]);
    const free = r.engine.getSelected()[0];
    expect(free?.kind === 'connector' && 'x' in free.to).toBe(true);
  });

  it('the resize and rotate handles are hit from a 44 px zone', () => {
    const r = rig();
    const [a] = r.make(sticky(100, 100));
    r.engine.setSelection([a as string]);
    // the bottom-right corner (260, 260): a touch 18 px outside it still resizes
    r.down(1, 276, 270);
    r.move(1, 300, 290);
    r.move(1, 336, 310);
    r.up(1, 336, 310);
    expect(obj(r, a as string).w).toBeGreaterThan(200);
    expect(obj(r, a as string).x).toBe(100);
    // the rotation handle hangs 40 px above the top edge (y 100 → 60): 15 px beside it still grabs it
    const before = obj(r, a as string);
    const cx = before.x + before.w / 2;
    r.down(1, cx + 15, 62);
    r.move(1, cx + 60, 100);
    r.move(1, cx + 120, 150);
    r.up(1, cx + 120, 150);
    expect(obj(r, a as string).rot ?? 0).not.toBe(0);
  });

  it('a second tap on the same object edits its text; a slow second tap does not', () => {
    vi.useFakeTimers();
    try {
      const r = rig();
      const [a] = r.make(sticky(100, 100));
      r.tap(180, 180);
      vi.advanceTimersByTime(200);
      r.tap(180, 180);
      expect(r.engine.editor.isOpen).toBe(true);
      expect([...r.engine.selection]).toEqual([a]);
      r.engine.editor.cancel();
      vi.advanceTimersByTime(1000);
      r.tap(180, 180);
      expect(r.engine.editor.isOpen).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a press that stays on empty canvas opens the menu once; moving, lifting early or a second finger do not', () => {
    vi.useFakeTimers();
    try {
      const r = rig();
      const [a] = r.make(sticky(100, 100));
      r.engine.setSelection([a as string]);
      const seen: Array<[number, number]> = [];
      r.engine.onLongPress((s) => seen.push([s.x, s.y]));
      r.down(1, 300, 600);
      vi.advanceTimersByTime(499);
      expect(seen).toEqual([]);
      vi.advanceTimersByTime(2);
      expect(seen).toEqual([[300, 600]]);
      r.move(1, 330, 640);
      r.up(1, 330, 640);
      // a long press is not also a tap: the selection survives
      expect(r.engine.selection.size).toBe(1);
      expect(r.cam()).toMatchObject({ tx: 0, ty: 0 });
      // moving cancels
      r.down(1, 300, 600);
      vi.advanceTimersByTime(300);
      r.move(1, 330, 640);
      vi.advanceTimersByTime(600);
      r.up(1, 330, 640);
      // lifting early cancels
      r.down(1, 300, 600);
      vi.advanceTimersByTime(300);
      r.up(1, 300, 600);
      vi.advanceTimersByTime(600);
      // a second finger cancels
      r.down(1, 300, 600);
      vi.advanceTimersByTime(300);
      r.down(2, 200, 600);
      vi.advanceTimersByTime(600);
      r.up(2, 200, 600);
      r.up(1, 300, 600);
      // on an object there is no menu
      r.down(1, 180, 180);
      vi.advanceTimersByTime(900);
      r.up(1, 180, 180);
      expect(seen).toHaveLength(1);
      // and nothing is left armed at rest
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps no frame or timer at rest after any of it', () => {
    vi.useFakeTimers();
    try {
      const r = rig();
      r.make(sticky(100, 100));
      r.tap(180, 180);
      r.drag([180, 180], [230, 250]);
      r.drag([300, 600], [250, 640]);
      r.raf.flush();
      // (the awareness throttle of the selection change may be pending; it does not rearm itself)
      vi.advanceTimersByTime(1000);
      expect(vi.getTimerCount()).toBe(0);
      expect(r.raf.pending).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

/** A stand-in for `window.visualViewport`: the part of the screen the keyboard leaves. */
class FakeViewport extends EventTarget {
  height = 800;
  offsetTop = 0;
  width = 400;
  count = 0;
  override addEventListener(type: string, cb: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions): void {
    this.count++;
    super.addEventListener(type, cb, opts);
  }
  override removeEventListener(type: string, cb: EventListenerOrEventListenerObject | null, opts?: boolean | EventListenerOptions): void {
    this.count--;
    super.removeEventListener(type, cb, opts);
  }
  resizeTo(height: number): void {
    this.height = height;
    this.dispatchEvent(new Event('resize'));
  }
}

describe('a text edit and the on-screen keyboard (visualViewport)', () => {
  const rect = (top: number, bottom: number): DOMRect => ({ top, bottom, left: 0, right: 400, width: 400, height: bottom - top, x: 0, y: top, toJSON: () => ({}) });
  let vv: FakeViewport;

  const setup = (opts: Partial<EngineOptions> = {}): Rig => {
    vv = new FakeViewport();
    Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
    // jsdom lays nothing out: the textarea's box is the one the editor positioned, the host is the whole 400×800 stage.
    vi.spyOn(HTMLTextAreaElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLTextAreaElement) {
      const top = parseFloat(this.style.top) || 0;
      return rect(top, top + (parseFloat(this.style.height) || 0));
    });
    const r = rig(opts);
    r.host.getBoundingClientRect = () => rect(0, 800);
    return r;
  };

  afterEach(() => {
    Reflect.deleteProperty(window, 'visualViewport');
  });

  /** Where the textarea is now (its box follows the camera). */
  const box = (r: Rig): { top: number; bottom: number } => {
    r.cam();
    r.engine.editor.reposition();
    const b = (r.engine.editor.element as HTMLTextAreaElement).getBoundingClientRect();
    return { top: b.top, bottom: b.bottom };
  };

  it('moves the view up so the text clears the keyboard and the format bar, and puts it back when the edit ends', () => {
    const r = setup();
    const [a] = r.make(sticky(100, 620));
    r.engine.setSelection([a as string]);
    r.engine.startTextEdit(a);
    // No keyboard yet, but the format bar (56 px) and a 12 px gap still reserve the bottom: the text ends at 732.
    expect(box(r).bottom).toBeCloseTo(732, 3);
    const first = r.cam().ty;
    expect(first).toBeLessThan(0);
    // The keyboard comes up: 450 px stay visible, the text goes above 450 − 56 − 12 = 382.
    vv.resizeTo(450);
    expect(box(r).bottom).toBeCloseTo(382, 3);
    expect(r.cam().scale).toBe(1);
    expect(r.cam().tx).toBe(0);
    expect(r.engine.editor.getSnapshot().kbd).toBe(350);
    // Idempotent: the same viewport again moves nothing.
    const moved = r.cam().ty;
    vv.resizeTo(450);
    expect(r.cam().ty).toBe(moved);
    r.engine.editor.commit();
    expect(r.cam()).toMatchObject({ tx: 0, ty: 0, scale: 1 });
    expect(r.engine.editor.getSnapshot().kbd).toBe(0);
  });

  it('does not move an object that is already clear, and never pushes the start of a tall one off the top', () => {
    const r = setup();
    const [a, b] = r.make(sticky(100, 100), sticky(100, 300, 160, 500));
    r.engine.startTextEdit(a);
    vv.resizeTo(450);
    expect(r.cam().ty).toBe(0);
    r.engine.editor.commit();
    r.engine.startTextEdit(b);
    vv.resizeTo(450);
    // 500 px tall in a free area of 382 − 64: its start lines up under the bars, the end stays hidden
    expect(box(r).top).toBeCloseTo(64, 3);
    r.engine.editor.commit();
    expect(r.cam().ty).toBe(0);
  });

  it('leaves a view the person moved meanwhile where it is', () => {
    const r = setup();
    const [a] = r.make(sticky(100, 620));
    r.engine.startTextEdit(a);
    vv.resizeTo(450);
    r.engine.setCamera({ tx: 30, ty: -100, scale: 1 });
    r.engine.editor.commit();
    expect(r.cam()).toMatchObject({ tx: 30, ty: -100 });
  });

  it('follows the viewport only while a text is open: no listener at rest, none left after, none off the phone', () => {
    const r = setup();
    const [a] = r.make(sticky(100, 100));
    expect(vv.count).toBe(0);
    r.engine.startTextEdit(a);
    expect(vv.count).toBe(2);
    r.engine.editor.commit();
    expect(vv.count).toBe(0);
    r.engine.startTextEdit(a);
    r.engine.editor.cancel();
    expect(vv.count).toBe(0);
    const d = setup({ touch: false });
    const [b] = d.make(sticky(100, 620));
    d.engine.startTextEdit(b);
    expect(vv.count).toBe(0);
    vv.resizeTo(450);
    expect(d.cam().ty).toBe(0);
  });

  it('leaving the edit mode (read-only) with a text open ends the edit and gives the view back', () => {
    const r = setup();
    const [a] = r.make(sticky(100, 620));
    r.engine.startTextEdit(a);
    vv.resizeTo(450);
    r.engine.setReadOnly(true);
    expect(r.engine.editor.isOpen).toBe(false);
    expect(r.cam().ty).toBe(0);
    expect(vv.count).toBe(0);
  });

  it('growing text that reaches the keyboard moves the view on typing', () => {
    const r = setup();
    const [a] = r.make({ init: { kind: 'text' as const, x: 100, y: 300, w: 200, text: 'one' } });
    r.engine.startTextEdit(a);
    vv.resizeTo(450);
    const ta = r.engine.editor.element as HTMLTextAreaElement;
    const before = r.cam().ty;
    // the textarea grows by a few lines (jsdom has no layout: make it so) and the user types
    Object.defineProperty(ta, 'scrollHeight', { value: 260, configurable: true });
    ta.value = 'one\ntwo\nthree\nfour';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    expect(r.cam().ty).toBeLessThan(before);
  });
});

describe('what the selection looks like under a finger (recorded draw calls)', () => {
  const handles = (r: Rig): Array<[number, number, number, number]> => {
    r.fake.clear();
    r.engine.setSelection([...r.engine.scene.query({ x: -999, y: -999, w: 3000, h: 3000 })].map((o) => o.id));
    r.raf.flush();
    return r.fake.calls.filter((c) => c.name === 'rect').map((c) => c.args as [number, number, number, number]);
  };

  it('the phone draws its eight resize handles 14 px (the desktop 8 px) and hangs the rotation handle 40 px out', () => {
    const touch = rig();
    touch.make(sticky(100, 100));
    const big = handles(touch).filter((a) => a[2] === 14 && a[3] === 14);
    expect(big).toHaveLength(8);
    // centered on the frame's corners/sides: the top-left one at (100, 100)
    expect(big.some((a) => a[0] === 93 && a[1] === 93)).toBe(true);
    const arcs = touch.fake.calls.filter((c) => c.name === 'arc').map((c) => c.args as number[]);
    // the rotation knob: 40 px above the top edge, x at the middle
    expect(arcs.some((a) => a[0] === 180 && a[1] === 60 && a[2] === 8)).toBe(true);

    const mouse = rig({ touch: false });
    mouse.make(sticky(100, 100));
    const small = handles(mouse).filter((a) => a[2] === 8 && a[3] === 8);
    expect(small).toHaveLength(8);
    expect(mouse.fake.calls.filter((c) => c.name === 'arc').some((a) => (a.args as number[])[1] === 74)).toBe(true);
  });

  it('draws nothing while idle: a frame is requested by a change, not by time', () => {
    const r = rig();
    r.make(sticky(100, 100));
    r.raf.flush();
    expect(r.raf.pending).toBe(0);
    r.tap(180, 180);
    r.raf.flush();
    expect(r.raf.pending).toBe(0);
  });
});
