import { afterEach, describe, expect, it, vi } from 'vitest';

const handled = vi.hoisted(() => [] as string[]);
vi.mock('../stores/session', () => ({ useSession: { getState: () => ({ status: 'anon', settings: null }) } }));
vi.mock('../stores/ui', () => ({ useUi: { getState: () => ({ openDialog: () => undefined }) } }));
vi.mock('../features/people/roomLink', () => ({ openRoomLink: (c: string) => handled.push(`room:${c}`) }));

const { alwaysOpenInApp, continueInBrowser, landingFor, setAlwaysOpenInApp, showLinkLanding, skipsLanding, useLinkLanding } = await import('./linkLanding');

describe('link landing (docs/09 #53)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useLinkLanding.setState({ link: null });
    handled.length = 0;
  });

  it('recognises web /join and /r links only', () => {
    expect(landingFor('https://app.calab.io/join/calaba-team-2026')).toEqual({ kind: 'join', code: 'calaba-team-2026', url: 'https://app.calab.io/join/calaba-team-2026' });
    expect(landingFor('https://app.calab.io/r/call-guest-link')).toMatchObject({ kind: 'r', code: 'call-guest-link' });
    expect(landingFor('calaba-team-2026')).toBeNull(); // a bare code is not a link
    expect(landingFor('https://app.calab.io/rooms/x')).toBeNull();
  });

  it('continue in the browser hands the link to the app flow and clears the card', () => {
    const replaceState = vi.fn();
    vi.stubGlobal('history', { replaceState });
    expect(showLinkLanding('https://app.calab.io/r/call-guest-link')).toBe(true);
    expect(useLinkLanding.getState().link?.code).toBe('call-guest-link');
    continueInBrowser();
    expect(useLinkLanding.getState().link).toBeNull();
    expect(replaceState).toHaveBeenCalledWith(null, '', '/');
    expect(handled).toEqual(['room:call-guest-link']);
  });

  it('«always open in the app» persists and survives blocked storage', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    });
    expect(alwaysOpenInApp()).toBe(false);
    setAlwaysOpenInApp(true);
    expect(alwaysOpenInApp()).toBe(true);
    setAlwaysOpenInApp(false);
    expect(alwaysOpenInApp()).toBe(false);

    const boom = (): never => {
      throw new Error('SecurityError');
    };
    vi.stubGlobal('localStorage', { getItem: boom, setItem: boom, removeItem: boom });
    expect(alwaysOpenInApp()).toBe(false);
    expect(() => setAlwaysOpenInApp(true)).not.toThrow();
  });
});

describe('task links on the web landing (CBF-40)', () => {
  it('recognises /t/<KEY-N> as a task card with the key upper-cased', () => {
    expect(landingFor('https://app.calab.io/t/inv-820')).toEqual({ kind: 't', code: 'INV-820', url: 'https://app.calab.io/t/inv-820' });
    expect(landingFor('https://app.calab.io/t/INV-812/')).toMatchObject({ kind: 't', code: 'INV-812' });
    expect(landingFor('https://app.calab.io/t/INV-812/x')).toBeNull();
    expect(landingFor('https://app.calab.io/b/0190aaaa-0000-4000-8000-000000000000')).toBeNull();
  });

  it('is skipped for a signed-in web visitor only, and only for tasks', () => {
    const task = landingFor('https://app.calab.io/t/INV-820');
    const join = landingFor('https://app.calab.io/join/calaba-team-2026');
    expect(task && skipsLanding(task, true)).toBe(true);
    expect(task && skipsLanding(task, false)).toBe(false);
    expect(join && skipsLanding(join, true)).toBe(false);
  });
});
