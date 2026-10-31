import { describe, expect, it } from 'vitest';
import type { WebContents } from 'electron';
import { OFFICE_HOST_PATH, isOfficeFrameNavigation, officeFrameAllowed, officeOriginOf, setOfficeFrame } from './officeFrame';

const DS = 'https://docs.example.org';
const host = `${DS}${OFFICE_HOST_PATH}`;
const top = { origin: DS, parentIsMain: true, parentUrl: '' };
const nested = { origin: DS, parentIsMain: false, parentUrl: host };

describe('officeOriginOf (the announced Document Server)', () => {
  it('accepts https and loopback http, as an exact origin', () => {
    expect(officeOriginOf('https://docs.example.org/web-apps/x?y=1')).toBe(DS);
    expect(officeOriginOf('https://docs.example.org:8443')).toBe('https://docs.example.org:8443');
    expect(officeOriginOf('http://127.0.0.1:18080')).toBe('http://127.0.0.1:18080');
    expect(officeOriginOf('http://localhost:3000/x')).toBe('http://localhost:3000');
  });
  it('rejects everything else', () => {
    for (const u of ['http://docs.example.org', 'ftp://docs.example.org', 'file:///etc/passwd', 'javascript:alert(1)', 'https://u:p@docs.example.org', '', 'docs.example.org', 'about:blank', 42, null, undefined]) {
      expect(officeOriginOf(u), String(u)).toBe('');
    }
  });
});

describe('isOfficeFrameNavigation', () => {
  it('lets the host page through under the app page, by exact path on the exact origin', () => {
    expect(isOfficeFrameNavigation({ ...top, url: host })).toBe(true);
    expect(isOfficeFrameNavigation({ ...top, url: `${host}?v=1#x` })).toBe(true);
  });
  it('lets the editor navigate inside its own origin, under a frame of that origin', () => {
    expect(isOfficeFrameNavigation({ ...nested, url: `${DS}/10.0.0-1/web-apps/apps/documenteditor/main/index.html` })).toBe(true);
  });
  it('denies any other page under the app page, even on the same origin', () => {
    expect(isOfficeFrameNavigation({ ...top, url: `${DS}/` })).toBe(false);
    expect(isOfficeFrameNavigation({ ...top, url: `${DS}/web-apps/apps/api/documents/api.js` })).toBe(false);
  });
  it('denies other origins, schemes, ports and look-alike hosts', () => {
    for (const url of [
      `https://evil.example.org${OFFICE_HOST_PATH}`,
      `https://docs.example.org.evil.org${OFFICE_HOST_PATH}`,
      `http://docs.example.org${OFFICE_HOST_PATH}`,
      `https://docs.example.org:444${OFFICE_HOST_PATH}`,
      `https://u@docs.example.org${OFFICE_HOST_PATH}`,
      'javascript:alert(1)',
      'data:text/html,x',
      `blob:${DS}/id`,
      `file://${OFFICE_HOST_PATH}`,
      'not a url',
    ]) {
      expect(isOfficeFrameNavigation({ ...top, url }), url).toBe(false);
      expect(isOfficeFrameNavigation({ ...nested, url }), url).toBe(false);
    }
  });
  it('denies a frame nested under a foreign parent (a mail body, a web app, another site)', () => {
    expect(isOfficeFrameNavigation({ origin: DS, parentIsMain: false, parentUrl: 'about:srcdoc', url: host })).toBe(false);
    expect(isOfficeFrameNavigation({ origin: DS, parentIsMain: false, parentUrl: 'https://evil.example.org/', url: `${DS}/x` })).toBe(false);
    expect(isOfficeFrameNavigation({ origin: DS, parentIsMain: false, parentUrl: '', url: `${DS}/x` })).toBe(false);
  });
  it('denies everything while no editor is open (no announced origin)', () => {
    expect(isOfficeFrameNavigation({ ...top, origin: '', url: host })).toBe(false);
    expect(isOfficeFrameNavigation({ ...nested, origin: '', url: `${DS}/x` })).toBe(false);
  });
});

describe('setOfficeFrame (the origin comes from the server, ADR-0143 §11)', () => {
  const wc = (id: number): WebContents => ({ id, once: () => undefined }) as unknown as WebContents;
  const frame = { parent: { parent: null, url: 'file:///app/index.html' }, url: '' };
  it('allows the origin of the server-reported URL, and nothing after close', async () => {
    const w = wc(1);
    expect(await setOfficeFrame(w, true, () => Promise.resolve('https://docs.example.org/'))).toBe(DS);
    expect(officeFrameAllowed(w, { url: host, frame })).toBe(true);
    expect(await setOfficeFrame(w, false, () => Promise.reject(new Error('not asked')))).toBe('');
    expect(officeFrameAllowed(w, { url: host, frame })).toBe(false);
  });
  it('allows nothing when the server says off, fails, or reports a URL officeOriginOf rejects', async () => {
    const w = wc(2);
    for (const answer of [() => Promise.resolve(''), () => Promise.reject(new Error('offline')), () => Promise.resolve('http://docs.example.org'), () => Promise.resolve(42)]) {
      expect(await setOfficeFrame(w, true, answer)).toBe('');
      expect(officeFrameAllowed(w, { url: host, frame })).toBe(false);
    }
  });
  it('drops an answer that arrives after a newer close', async () => {
    const w = wc(3);
    let resolve: (v: string) => void = () => undefined;
    const late = setOfficeFrame(w, true, () => new Promise<string>((r) => (resolve = r)));
    await setOfficeFrame(w, false, () => Promise.resolve(''));
    resolve(DS);
    expect(await late).toBe('');
    expect(officeFrameAllowed(w, { url: host, frame })).toBe(false);
  });
});
