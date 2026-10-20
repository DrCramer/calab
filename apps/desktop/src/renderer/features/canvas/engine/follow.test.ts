// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AwarenessLayer, followKeyOf, sameView, type PeerState } from './awareness';
import { destroyRigs, rig } from './testRig';

afterEach(() => {
  destroyRigs();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const peer = (over: Partial<PeerState> = {}): PeerState => ({ id: '7', userId: 'u-anna', name: 'Анна', color: '#e11d48', ...over });

describe('view sameness', () => {
  it('ignores sub-pixel and sub-per-mille differences only', () => {
    expect(sameView({ x: 10, y: 10, zoom: 1 }, { x: 10.2, y: 10.2, zoom: 1.0004 })).toBe(true);
    expect(sameView({ x: 10, y: 10, zoom: 1 }, { x: 11, y: 10, zoom: 1 })).toBe(false);
    expect(sameView({ x: 10, y: 10, zoom: 1 }, { x: 10, y: 10, zoom: 1.01 })).toBe(false);
    // zoomed out, half a pixel is a lot of world units
    expect(sameView({ x: 0, y: 0, zoom: 0.1 }, { x: 4, y: 0, zoom: 0.1 })).toBe(true);
    expect(sameView(undefined, undefined)).toBe(true);
    expect(sameView(undefined, { x: 0, y: 0, zoom: 1 })).toBe(false);
  });
});

describe('AwarenessLayer.followTarget', () => {
  it('finds the person by user id, preferring the window that moved last, and a view over none', () => {
    const a = new AwarenessLayer();
    a.setPeers([peer({ id: '1', view: { x: 0, y: 0, zoom: 1 } }), peer({ id: '2', view: { x: 5, y: 5, zoom: 1 } })], 100);
    // window 1 moves later
    a.setPeers([peer({ id: '1', view: { x: 50, y: 0, zoom: 1 } }), peer({ id: '2', view: { x: 5, y: 5, zoom: 1 } })], 200);
    expect(a.followTarget('u-anna')?.id).toBe('1');
    a.setPeers([peer({ id: '1' }), peer({ id: '2', view: { x: 5, y: 5, zoom: 1 } })], 300);
    expect(a.followTarget('u-anna')?.id).toBe('2');
    expect(a.followTarget('nobody')).toBeNull();
    expect(followKeyOf({ id: '9' })).toBe('9');
  });
  it('a view change alone is not a visible change for the cursor layer', () => {
    const a = new AwarenessLayer();
    a.setPeers([peer({ view: { x: 0, y: 0, zoom: 1 } })], 0);
    expect(a.setPeers([peer({ view: { x: 900, y: 0, zoom: 2 } })], 10)).toBe(false);
  });
});

describe('sending our view', () => {
  it('goes out at most 5 times a second and only after the camera changed', () => {
    vi.useFakeTimers();
    const r = rig();
    const sent: { x: number; y: number; zoom: number }[] = [];
    r.engine.onLocalView((v) => sent.push(v));
    r.raf.flush();
    // the camera has not moved since the listener came: the initial view goes out once
    const first = sent.length;
    expect(first).toBeLessThanOrEqual(1);
    sent.length = 0;
    for (let i = 0; i < 30; i++) {
      r.engine.panByScreen(10, 0);
      r.clock.t += 20;
      vi.advanceTimersByTime(20);
    }
    // 600 ms of continuous panning: leading edge + a few trailing ones, never more than 5/s
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent.length).toBeLessThanOrEqual(4);
    r.clock.t += 500;
    vi.advanceTimersByTime(500);
    const settled = sent.length;
    expect(sent[sent.length - 1]).toMatchObject({ zoom: 1 });
    // the center is what we see: 1000×800 viewport, panned 300 px right → world x = 500 − 300
    expect(sent[sent.length - 1]?.x).toBeCloseTo(200, 5);
    expect(sent[sent.length - 1]?.y).toBeCloseTo(400, 5);
    // idle: nothing more, no timers
    r.clock.t += 5000;
    vi.advanceTimersByTime(5000);
    expect(sent.length).toBe(settled);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('sends nothing while the window is hidden, and the current view once when it is shown', () => {
    vi.useFakeTimers();
    const r = rig();
    const sent: unknown[] = [];
    r.engine.onLocalView((v) => sent.push(v));
    r.clock.t += 1000;
    vi.advanceTimersByTime(1000);
    sent.length = 0;
    r.engine.setActive(false);
    r.engine.panByScreen(100, 0);
    r.clock.t += 1000;
    vi.advanceTimersByTime(1000);
    r.engine.panByScreen(100, 0);
    expect(sent).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    r.engine.setActive(true);
    expect(sent).toHaveLength(1);
  });
});

describe('following a person', () => {
  const settle = (r: ReturnType<typeof rig>): void => {
    r.raf.flush();
  };

  it('takes their center and zoom, whatever the sizes of the two windows', () => {
    const r = rig();
    r.engine.setPeers([peer({ view: { x: 400, y: 300, zoom: 2 } })]);
    r.engine.follow('u-anna');
    expect(r.engine.getState()).toMatchObject({ followKey: 'u-anna', followName: 'Анна' });
    settle(r);
    // our 1000×800 viewport centered on (400, 300) at 200 %
    expect(r.engine.camera).toEqual({ scale: 2, tx: 500 - 800, ty: 400 - 600 });
    expect(r.engine.getState().zoomPct).toBe(200);
    // they pan: the camera follows, one setCamera per frame
    r.engine.setPeers([peer({ view: { x: 500, y: 300, zoom: 2 } })]);
    settle(r);
    expect(r.engine.camera.tx).toBe(500 - 1000);
  });

  it('an unchanged view moves nothing and costs no frame', () => {
    const r = rig();
    r.engine.setPeers([peer({ view: { x: 400, y: 300, zoom: 2 } })]);
    r.engine.follow('u-anna');
    settle(r);
    const { frames } = r.engine.stats;
    for (let i = 0; i < 10; i++) {
      r.engine.setPeers([peer({ view: { x: 400 + i * 0.01, y: 300, zoom: 2 } })]);
      settle(r);
    }
    expect(r.engine.stats.frames).toBe(frames);
  });

  it('works in read-only mode', () => {
    const r = rig({ readOnly: true });
    r.engine.setPeers([peer({ view: { x: 0, y: 0, zoom: 1 } })]);
    r.engine.follow('u-anna');
    settle(r);
    expect(r.engine.camera).toEqual({ scale: 1, tx: 500, ty: 400 });
    expect(r.engine.followKey).toBe('u-anna');
  });

  it('our own pan, zoom, fit or zoom buttons end it', () => {
    const own: Record<string, (r: ReturnType<typeof rig>) => void> = {
      wheel: (r) => r.wheel(100, { ctrlKey: true }),
      pan: (r) => r.engine.panByScreen(5, 5),
      zoomAtPoint: (r) => r.engine.zoomAtPoint(1.2, { x: 10, y: 10 }),
      step: (r) => r.engine.zoomStep(1),
      zoomTo: (r) => r.engine.zoomTo(100),
      fit: (r) => r.engine.fitAll(),
      steer: (r) => r.engine.steerPan(3, 3),
    };
    for (const [name, act] of Object.entries(own)) {
      const r = rig();
      r.engine.setPeers([peer({ view: { x: 400, y: 300, zoom: 2 } })]);
      r.engine.follow('u-anna');
      settle(r);
      act(r);
      expect(r.engine.followKey, name).toBeNull();
      expect(r.engine.getState().followName, name).toBe('');
      // and their next move no longer drags us
      settle(r);
      const cam = { ...r.engine.camera };
      r.engine.setPeers([peer({ view: { x: 9000, y: 9000, zoom: 3 } })]);
      settle(r);
      expect(r.engine.camera, name).toEqual(cam);
    }
  });

  it('their cursor, our selection and clicks do not end it', () => {
    const r = rig();
    const [id] = r.make({ init: { kind: 'sticky', x: 100, y: 100 } });
    r.engine.setPeers([peer({ view: { x: 400, y: 300, zoom: 1 } })]);
    r.engine.follow('u-anna');
    settle(r);
    r.engine.setSelection([id ?? '']);
    r.engine.setPeers([peer({ view: { x: 400, y: 300, zoom: 1 }, cursor: { x: 5, y: 5 }, selection: [id ?? ''] })]);
    expect(r.engine.followKey).toBe('u-anna');
  });

  it('ends when the person leaves the canvas, and refuses someone who is not there', () => {
    const r = rig();
    r.engine.follow('u-anna');
    expect(r.engine.followKey).toBeNull();
    r.engine.setPeers([peer({ view: { x: 1, y: 1, zoom: 1 } })]);
    r.engine.follow('u-anna');
    expect(r.engine.followKey).toBe('u-anna');
    r.engine.setPeers([]);
    expect(r.engine.followKey).toBeNull();
    expect(r.engine.getState().followName).toBe('');
  });

  it('follows the other window of the same person when one closes', () => {
    const r = rig();
    r.engine.setPeers([peer({ id: '1', view: { x: 0, y: 0, zoom: 1 } }), peer({ id: '2', view: { x: 100, y: 0, zoom: 1 } })]);
    r.engine.follow('u-anna');
    r.engine.setPeers([peer({ id: '1', view: { x: 0, y: 0, zoom: 1 } })]);
    expect(r.engine.followKey).toBe('u-anna');
  });

  it('a person without a view (an old client) is followed once one arrives', () => {
    const r = rig();
    r.engine.setPeers([peer()]);
    r.engine.follow('u-anna');
    settle(r);
    expect(r.engine.camera).toEqual({ scale: 1, tx: 0, ty: 0 });
    r.engine.setPeers([peer({ view: { x: 0, y: 0, zoom: 1 } })]);
    settle(r);
    expect(r.engine.camera).toEqual({ scale: 1, tx: 500, ty: 400 });
  });

  it('is plain frames: no timers while following in rest, and a hidden window draws nothing', () => {
    vi.useFakeTimers();
    const r = rig();
    r.engine.setPeers([peer({ view: { x: 400, y: 300, zoom: 1 } })]);
    r.engine.follow('u-anna');
    settle(r);
    r.clock.t += 20_000;
    vi.advanceTimersByTime(20_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(r.raf.pending).toBe(0);
    r.engine.setActive(false);
    r.engine.setPeers([peer({ view: { x: 700, y: 300, zoom: 1 } })]);
    expect(r.raf.pending).toBe(0);
    r.engine.setActive(true);
    settle(r);
    expect(r.engine.camera.tx).toBe(500 - 700);
  });
});
