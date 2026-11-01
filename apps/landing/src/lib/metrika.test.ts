import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureUtm, forgetClientId, goal, goalForHref, rememberClientId, withUtm } from './metrika';
import { APP_URL, CONTACT_FORM_URL, DOWNLOADS } from './site';

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
}

beforeEach(() => {
  vi.stubGlobal('window', {});
  vi.stubGlobal('sessionStorage', memoryStorage());
});
afterEach(() => vi.unstubAllGlobals());

describe('goal', () => {
  it('is a no-op without ym', () => {
    expect(() => { goal('pricing_view'); }).not.toThrow();
  });
  it('calls reachGoal with params', () => {
    const ym = vi.fn();
    vi.stubGlobal('window', { ym });
    goal('download_click', { os: 'win' });
    expect(ym).toHaveBeenCalledWith(113761661, 'reachGoal', 'download_click', { os: 'win' });
  });
});

describe('utm', () => {
  it('captures utm/yclid only and appends to app links', () => {
    captureUtm('?utm_source=ya&yclid=1&foo=2');
    expect(withUtm(`${APP_URL}/plans?plan=team`)).toBe(`${APP_URL}/plans?plan=team&utm_source=ya&yclid=1`);
  });
  it('leaves links alone with nothing stored', () => {
    expect(withUtm(APP_URL)).toBe(APP_URL);
  });
  it('adds the Metrika ClientID only once the tag reported a valid one', () => {
    rememberClientId('abc');
    expect(withUtm(APP_URL)).toBe(APP_URL);
    rememberClientId(1710232430899999999n.toString());
    captureUtm('?utm_source=ya');
    expect(withUtm(`${APP_URL}/`)).toBe(`${APP_URL}/?utm_source=ya&ym_cid=1710232430899999999`);
    expect(withUtm(`${APP_URL}/?ym_cid=1`)).toBe(`${APP_URL}/?ym_cid=1&utm_source=ya`);
    forgetClientId();
    expect(withUtm(`${APP_URL}/`)).toBe(`${APP_URL}/?utm_source=ya`);
  });
});

describe('goalForHref', () => {
  it('maps links to goals', () => {
    expect(goalForHref(DOWNLOADS.win)).toEqual({ id: 'download_click', params: { os: 'win' } });
    expect(goalForHref(APP_URL)).toEqual({ id: 'open_web_app' });
    expect(goalForHref(`${APP_URL}/plans?plan=business`)).toEqual({ id: 'plan_buy_click', params: { plan: 'business' } });
    expect(goalForHref(CONTACT_FORM_URL)?.id).toBe('contact_click');
    expect(goalForHref('mailto:support@calab.io')?.id).toBe('contact_click');
    expect(goalForHref('/ru/docs/bots/', '/ru/developers/')?.id).toBe('docs_open');
    expect(goalForHref('#download')).toBeNull();
  });
});
