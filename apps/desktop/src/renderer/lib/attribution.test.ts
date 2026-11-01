import { describe, expect, it } from 'vitest';
import { captureAttribution, clearAttribution, storedAttribution } from './attribution';

function memory(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

const DAY = 24 * 3600 * 1000;

describe('attribution', () => {
  it('captures the landing params, strips them and keeps other params', () => {
    const s = memory();
    const clean = captureAttribution(
      'https://app.calab.io/plans?plan=team&utm_source=yandex&utm_medium=cpc&utm_campaign=brand&yclid=991&ym_cid=1710232430899999999#x',
      s,
      1000,
    );
    expect(clean).toBe('https://app.calab.io/plans?plan=team#x');
    expect(storedAttribution(s, 2000)).toEqual({
      utmSource: 'yandex',
      utmMedium: 'cpc',
      utmCampaign: 'brand',
      yclid: '991',
      ymClientId: '1710232430899999999',
    });
  });

  it('returns null without campaign params and stores nothing', () => {
    const s = memory();
    expect(captureAttribution('https://app.calab.io/?invite=abc', s)).toBeNull();
    expect(storedAttribution(s)).toBeUndefined();
  });

  it('drops a non-numeric ClientID and cuts long values', () => {
    const s = memory();
    captureAttribution(`https://app.calab.io/?ym_cid=abc&utm_term=${'x'.repeat(300)}`, s, 0);
    const a = storedAttribution(s, 0);
    expect(a?.ymClientId).toBeUndefined();
    expect(a?.utmTerm).toHaveLength(200);
  });

  it('keeps the first touch until it expires, then takes the new campaign', () => {
    const s = memory();
    captureAttribution('https://app.calab.io/?utm_source=first', s, 0);
    captureAttribution('https://app.calab.io/?utm_source=second', s, 10 * DAY);
    expect(storedAttribution(s, 10 * DAY)?.utmSource).toBe('first');
    expect(storedAttribution(s, 91 * DAY)).toBeUndefined();
    captureAttribution('https://app.calab.io/?utm_source=later', s, 91 * DAY);
    expect(storedAttribution(s, 91 * DAY)?.utmSource).toBe('later');
    clearAttribution(s);
    expect(storedAttribution(s, 91 * DAY)).toBeUndefined();
  });

  it('survives blocked storage', () => {
    expect(captureAttribution('https://app.calab.io/?utm_source=x', null)).toBe('https://app.calab.io/');
    expect(storedAttribution(null)).toBeUndefined();
  });
});
