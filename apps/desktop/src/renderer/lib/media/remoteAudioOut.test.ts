import { describe, expect, it } from 'vitest';
import { type AudioOutState, RemoteAudioOut } from './remoteAudioOut';

/**
 * A stand-in <audio>: muted / volume like the DOM, `volumechange` fired synchronously on a real
 * change (the DOM queues it; order is the same), `setSinkId` records the device and — like a
 * renderer rebuilt on a sink switch — can drop the element back to «audible» (`resetOnSink`).
 */
class FakeAudio {
  private m = false;
  private v = 1;
  sinkId = '';
  resetOnSink = false;
  pushes = 0;
  private readonly listeners = new Set<() => void>();

  get muted(): boolean {
    return this.m;
  }
  set muted(x: boolean) {
    if (x === this.m) return;
    this.m = x;
    this.fire();
  }
  get volume(): number {
    return this.v;
  }
  set volume(x: number) {
    if (x === this.v) return;
    this.v = x;
    this.pushes++;
    this.fire();
  }
  setSinkId(id: string): Promise<undefined> {
    this.sinkId = id;
    if (this.resetOnSink) {
      // Behind our back, as Room.startAudio() / a rebuilt renderer would.
      this.m = false;
      this.v = 1;
    }
    return Promise.resolve(undefined);
  }
  addEventListener(_t: string, fn: () => void): void {
    this.listeners.add(fn);
  }
  removeEventListener(_t: string, fn: () => void): void {
    this.listeners.delete(fn);
  }
  private fire(): void {
    for (const fn of [...this.listeners]) fn();
  }
  /** An outside write that does fire `volumechange` (LiveKit `el.muted = false`). */
  unmuteFromOutside(): void {
    this.muted = false;
  }
}

function setup(init: Partial<AudioOutState> = {}) {
  const state: AudioOutState = { deafened: false, userVolumes: {}, mutedUsers: {}, deafUsers: {}, streamVolume: {}, outputVolume: 1, ...init };
  const out = new RemoteAudioOut<FakeAudio & HTMLMediaElement>(() => state);
  const el = (): FakeAudio & HTMLMediaElement => new FakeAudio() as FakeAudio & HTMLMediaElement;
  /** An engine without per-element output selection (WebKit with the setting off): no `setSinkId`. */
  const noSinkEl = (): FakeAudio & HTMLMediaElement => Object.defineProperty(el(), 'setSinkId', { value: undefined });
  return { state, out, el, noSinkEl };
}

describe('RemoteAudioOut — deafen holds on every path', () => {
  it('deafen → output device switch → every element still muted', async () => {
    const { state, out, el } = setup();
    const a = el();
    const b = el();
    out.add('TR_a', a, 'u1', false);
    out.add('TR_b', b, 'u2', true);
    state.deafened = true;
    out.applyAll();
    expect([a.muted, b.muted]).toEqual([true, true]);
    // The sink switch resets the elements (charger / dock on macOS): deafen is put back.
    a.resetOnSink = true;
    b.resetOnSink = true;
    await out.setSink('usb-headset');
    expect([a.sinkId, b.sinkId]).toEqual(['usb-headset', 'usb-headset']);
    expect([a.muted, b.muted]).toEqual([true, true]);
  });

  it('deafen → a new participant joins → their element is muted from the start, on our sink', async () => {
    const { state, out, el } = setup({ deafened: true });
    await out.setSink('speakers');
    const c = el();
    out.add('TR_c', c, 'u3', false);
    expect(c.muted).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(c.sinkId).toBe('speakers');
    expect(c.muted).toBe(true);
    state.deafened = false;
    out.applyAll();
    expect(c.muted).toBe(false);
  });

  it('something else unmutes an element while deafened (Room.startAudio) → muted again', () => {
    const { out, el } = setup({ deafened: true });
    const a = el();
    out.add('TR_a', a, 'u1', false);
    a.unmuteFromOutside();
    expect(a.muted).toBe(true);
  });

  it('undeafen restores the per-user volumes and «mute for me»', () => {
    const { state, out, el } = setup({ userVolumes: { u1: 0.5 }, mutedUsers: { u2: true }, outputVolume: 0.8 });
    const a = el();
    const b = el();
    out.add('TR_a', a, 'u1', false);
    out.add('TR_b', b, 'u2', false);
    expect([a.muted, a.volume, b.muted]).toEqual([false, 0.4, true]);
    state.deafened = true;
    out.applyAll();
    expect([a.muted, b.muted]).toEqual([true, true]);
    state.deafened = false;
    out.applyAll();
    expect([a.muted, a.volume, b.muted]).toEqual([false, 0.4, true]);
  });

  it('a sink switch re-pushes the volume to the player even when the attributes already match', async () => {
    const { out, el } = setup({ userVolumes: { u1: 0.5 } });
    const a = el();
    out.add('TR_a', a, 'u1', false);
    const before = a.pushes;
    await out.setSink('');
    expect(a.pushes).toBeGreaterThan(before);
    expect(a.volume).toBe(0.5);
  });

  it('a removed element is no longer touched', async () => {
    const { state, out, el } = setup();
    const a = el();
    out.add('TR_a', a, 'u1', false);
    expect(out.remove('TR_a')).toBe(a);
    state.deafened = true;
    out.applyAll();
    await out.setSink('x');
    expect([a.muted, a.sinkId]).toEqual([false, '']);
    expect(out.size).toBe(0);
  });
});

describe('RemoteAudioOut — engines without setSinkId', () => {
  it('setSink resolves (devicechange, default and chosen id), the output stays the OS one, deafen is re-asserted', async () => {
    const { state, out, noSinkEl } = setup({ userVolumes: { u1: 0.5 } });
    const a = noSinkEl();
    out.add('TR_a', a, 'u1', false);
    const before = a.pushes;
    await expect(out.setSink('')).resolves.toBeUndefined();
    expect(a.pushes).toBeGreaterThan(before);
    expect(a.volume).toBe(0.5);
    state.deafened = true;
    await expect(out.setSink('usb-headset')).resolves.toBeUndefined();
    expect(a.sinkId).toBe('');
    expect(a.muted).toBe(true);
  });

  it('a new element on a remembered sink: no rejection, muted from the start while deafened', async () => {
    const { out, noSinkEl } = setup({ deafened: true });
    await out.setSink('speakers');
    const c = noSinkEl();
    out.add('TR_c', c, 'u3', false);
    await Promise.resolve();
    await Promise.resolve();
    expect(c.muted).toBe(true);
    expect(c.sinkId).toBe('');
  });

  it('mixed with a supporting element: that one still switches, both keep deafen', async () => {
    const { state, out, el, noSinkEl } = setup();
    const a = el();
    const b = noSinkEl();
    out.add('TR_a', a, 'u1', false);
    out.add('TR_b', b, 'u2', false);
    state.deafened = true;
    a.resetOnSink = true;
    await out.setSink('usb-headset');
    expect([a.sinkId, b.sinkId]).toEqual(['usb-headset', '']);
    expect([a.muted, b.muted]).toEqual([true, true]);
  });
});

describe('replayPaused (audio paused by an interruption / the background)', () => {
  /** An element with play(): `outcome` decides what the next play() does. */
  const playable = (paused: boolean, outcome: 'ok' | 'blocked' | 'fail' = 'ok') => {
    const a = new FakeAudio() as FakeAudio & HTMLMediaElement & { plays: number };
    let isPaused = paused;
    a.plays = 0;
    Object.defineProperty(a, 'paused', { get: () => isPaused });
    Object.defineProperty(a, 'play', {
      value: () => {
        a.plays++;
        if (outcome === 'ok') {
          isPaused = false;
          return Promise.resolve();
        }
        return Promise.reject(Object.assign(new Error('nope'), { name: outcome === 'blocked' ? 'NotAllowedError' : 'AbortError' }));
      },
    });
    return a;
  };

  it('plays only the paused elements, once each, and counts what happened', async () => {
    const state: AudioOutState = { deafened: false, userVolumes: {}, mutedUsers: {}, streamVolume: {} };
    const out = new RemoteAudioOut<FakeAudio & HTMLMediaElement & { plays: number }>(() => state);
    const playing = playable(false);
    const paused = playable(true);
    const blocked = playable(true, 'blocked');
    const broken = playable(true, 'fail');
    out.add('a', playing, 'u1', false);
    out.add('b', paused, 'u2', false);
    out.add('c', blocked, 'u3', false);
    out.add('d', broken, 'u4', false);
    expect(await out.replayPaused()).toEqual({ resumed: 1, blocked: 1, failed: 1 });
    expect([playing.plays, paused.plays, blocked.plays, broken.plays]).toEqual([0, 1, 1, 1]);
    // The next pass touches only what is still paused (no loop of its own).
    expect(await out.replayPaused()).toEqual({ resumed: 0, blocked: 1, failed: 1 });
    expect(paused.plays).toBe(1);
  });

  it('keeps deafen: a replayed element stays muted', async () => {
    const out = new RemoteAudioOut<FakeAudio & HTMLMediaElement & { plays: number }>(() => ({ deafened: true, userVolumes: {}, mutedUsers: {}, streamVolume: {} }));
    const el = playable(true);
    out.add('a', el, 'u1', false);
    await out.replayPaused();
    expect(el.plays).toBe(1);
    expect(el.muted).toBe(true);
  });

  it('elements without play() (unit fakes, old engines) are skipped', async () => {
    const out = new RemoteAudioOut<FakeAudio & HTMLMediaElement>(() => ({ deafened: false, userVolumes: {}, mutedUsers: {}, streamVolume: {} }));
    out.add('a', new FakeAudio() as FakeAudio & HTMLMediaElement, 'u1', false);
    expect(await out.replayPaused()).toEqual({ resumed: 0, blocked: 0, failed: 0 });
  });
});

describe('rebind (the OS switched the output: headphones in or out, #255)', () => {
  /** An element with a stream: counts srcObject writes and play() calls. */
  const bound = (stream: object | null, outcome: 'ok' | 'blocked' = 'ok') => {
    const a = new FakeAudio() as FakeAudio & HTMLMediaElement & { writes: (object | null)[]; plays: number };
    let src = stream;
    a.writes = [];
    a.plays = 0;
    Object.defineProperty(a, 'srcObject', {
      get: () => src,
      set: (v: object | null) => {
        a.writes.push(v);
        src = v;
      },
    });
    Object.defineProperty(a, 'play', {
      value: () => {
        a.plays++;
        return outcome === 'ok' ? Promise.resolve() : Promise.reject(Object.assign(new Error('nope'), { name: 'NotAllowedError' }));
      },
    });
    return a;
  };

  it('re-assigns every element its own stream on the chosen sink and plays it again', async () => {
    const state: AudioOutState = { deafened: false, userVolumes: {}, mutedUsers: {}, streamVolume: {} };
    const out = new RemoteAudioOut<ReturnType<typeof bound>>(() => state);
    const s1 = {};
    const s2 = {};
    const a = bound(s1);
    const b = bound(s2, 'blocked');
    const none = bound(null);
    out.add('a', a, 'u1', false);
    out.add('b', b, 'u2', false);
    out.add('c', none, 'u3', false);
    await out.setSink('headphones');
    expect(await out.rebind()).toEqual({ rebound: 2, blocked: 1 });
    expect(a.writes).toEqual([null, s1]);
    expect(b.writes).toEqual([null, s2]);
    expect(a.srcObject).toBe(s1);
    expect([a.plays, b.plays, none.plays]).toEqual([1, 1, 0]);
    expect(a.sinkId).toBe('headphones');
  });

  it('keeps deafen across the re-bind', async () => {
    const out = new RemoteAudioOut<ReturnType<typeof bound>>(() => ({ deafened: true, userVolumes: {}, mutedUsers: {}, streamVolume: {} }));
    const a = bound({});
    a.resetOnSink = true;
    out.add('a', a, 'u1', false);
    await out.rebind();
    expect(a.muted).toBe(true);
  });
});

describe('sink ops are serialised per element (a re-bind cannot race a switch)', () => {
  it('a slow setSinkId in flight: the next switch and the re-bind wait; the newest id lands last', async () => {
    const out = new RemoteAudioOut<FakeAudio & HTMLMediaElement>(() => ({ deafened: false, userVolumes: {}, mutedUsers: {}, streamVolume: {} }));
    const a = new FakeAudio() as FakeAudio & HTMLMediaElement;
    const calls: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const pending: (() => void)[] = [];
    Object.defineProperty(a, 'srcObject', { value: {}, writable: true });
    Object.defineProperty(a, 'setSinkId', {
      value: (id: string) => {
        calls.push(id);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<void>((resolve) =>
          pending.push(() => {
            inFlight--;
            a.sinkId = id;
            resolve();
          }),
        );
      },
    });
    out.add('a', a, 'u1', false);
    const first = out.setSink('air');
    const rebind = out.rebind();
    const second = out.setSink('default');
    // Drain one call at a time, as a slow audio service would.
    for (let i = 0; i < 10 && (pending.length > 0 || calls.length < 3); i++) {
      await Promise.resolve();
      pending.shift()?.();
      await new Promise((r) => setTimeout(r, 0));
    }
    await Promise.all([first, rebind, second]);
    expect(maxInFlight).toBe(1);
    // The queued ops read the current choice when they run: the older 'air' is never applied.
    expect(calls).toEqual(['default', 'default', 'default']);
    expect(a.sinkId).toBe('default');
  });
});
