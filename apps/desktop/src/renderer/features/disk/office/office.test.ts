// @vitest-environment node
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import HOST_JS from '../../../../../../../infra/office/calab-editor.js?raw';
import { create } from '@bufbuild/protobuf';
import { OfficeCapability, OfficeFormatSchema } from '@calaba/protocol';
import { officeOpens, FRAME_START, connectHost, convertTarget, frameReducer, nextStatus, officeCapability, originOf, problemOf, viewOnly, type HostEvent } from './bridge';
import { setOfficeCaps, useOfficeCaps } from './caps';

/** The server's map (apps/server/internal/office/formats.go), as GET /api/office/capabilities answers it. */
const f = (extension: string, capability: OfficeCapability, convertTo = '', lossy = false) => create(OfficeFormatSchema, { extension, capability, convertTo, lossy });
const SERVER = {
  enabled: true,
  docsUrl: 'https://docs.calab.test',
  maxSizeBytes: 100n << 20n,
  themeDark: 'theme-calab-dark',
  themeLight: 'default-light',
  formats: [
    f('docx', OfficeCapability.EDIT), f('xlsx', OfficeCapability.EDIT), f('pptx', OfficeCapability.EDIT), f('odt', OfficeCapability.EDIT, '', true),
    f('doc', OfficeCapability.CONVERT, 'docx'), f('xls', OfficeCapability.CONVERT, 'xlsx'), f('ppt', OfficeCapability.CONVERT, 'pptx'), f('pdf', OfficeCapability.VIEW),
  ],
};

/**
 * The office editor's two halves (ADR-0143): the Calab host page that runs on the Document
 * Server's origin (infra/office/calab-editor.js, with a fake DocsAPI) and the client's side of
 * its protocol (bridge.ts). jsdom does not fill MessageEvent.source / origin for postMessage, so
 * messages are dispatched by hand with both set, and the outgoing ones are spied.
 */

const DOCS = 'https://docs.calab.test';
const APP = 'https://app.calab.test';

type Msg = { source: string; type: string; name?: string; data?: unknown; config?: unknown };

function pair() {
  const dom = new JSDOM('<!doctype html><body><iframe></iframe></body>', { runScripts: 'outside-only', url: `${APP}/` });
  const parent = dom.window as unknown as Window & typeof globalThis;
  const frame = parent.document.querySelector('iframe') as HTMLIFrameElement;
  const child = frame.contentWindow as Window & typeof globalThis & { eval: (s: string) => unknown; DocsAPI?: unknown };
  child.document.body.innerHTML = '<div id="calab-office-editor"></div>';
  return { dom, parent, frame, child };
}

/** The host page in its frame, with the parent's inbox spied and a fake DocsAPI on demand. */
function host(withApi: boolean) {
  const { parent, frame, child } = pair();
  const toParent: Msg[] = [];
  vi.spyOn(parent, 'postMessage').mockImplementation((m: unknown) => {
    toParent.push(m as Msg);
  });
  const editors: { id: string; config: Record<string, unknown>; destroyed: boolean }[] = [];
  const api = {
    DocEditor: class {
      rec: { id: string; config: Record<string, unknown>; destroyed: boolean };
      constructor(id: string, config: Record<string, unknown>) {
        this.rec = { id, config, destroyed: false };
        editors.push(this.rec);
      }
      destroyEditor(): void {
        this.rec.destroyed = true;
      }
    },
  };
  if (withApi) child.DocsAPI = api;
  child.eval(HOST_JS);
  const send = (data: unknown, source: unknown = parent): void => {
    child.dispatchEvent(new child.MessageEvent('message', { data, source: source as Window, origin: APP }));
  };
  return { parent, frame, child, toParent, editors, api, send };
}

describe('host page (infra/office/calab-editor.js)', () => {
  it('says hello and loads nothing before «open»', () => {
    const h = host(false);
    expect(h.toParent).toEqual([{ source: 'calab-office', type: 'hello' }]);
    expect(h.child.document.querySelectorAll('script').length).toBe(0);
  });

  it('loads api.js only on «open», then creates the editor with the signed config', () => {
    const h = host(false);
    const config = { document: { key: 'calab-k' }, token: 't' };
    h.send({ source: 'calab-office', type: 'open', config });
    const s = h.child.document.querySelector('script');
    expect(s?.getAttribute('src')).toBe('/web-apps/apps/api/documents/api.js');
    expect(h.editors).toHaveLength(0);
    h.child.DocsAPI = h.api;
    s?.dispatchEvent(new h.child.Event('load'));
    expect(h.editors).toHaveLength(1);
    expect(h.editors[0]?.id).toBe('calab-office-editor');
    expect(h.editors[0]?.config['token']).toBe('t');
    expect((h.editors[0]?.config['document'] as { key: string }).key).toBe('calab-k');
  });

  it('relays the editor events and destroys the editor on «close»', () => {
    const h = host(true);
    h.send({ source: 'calab-office', type: 'open', config: {} });
    const ev = h.editors[0]?.config['events'] as Record<string, (e?: unknown) => void>;
    ev['onDocumentReady']?.();
    ev['onDocumentStateChange']?.({ data: true });
    ev['onDocumentStateChange']?.({ data: false });
    ev['onError']?.({ data: { errorCode: -4, errorDescription: 'download failed' } });
    expect(h.toParent.slice(1).map((m) => [m.name, m.data])).toEqual([
      ['ready', null],
      ['state', true],
      ['state', false],
      ['error', { code: -4, text: 'download failed' }],
    ]);
    h.send({ source: 'calab-office', type: 'close' });
    expect(h.editors[0]?.destroyed).toBe(true);
    expect(h.toParent.at(-1)?.type).toBe('closed');
  });

  it('ignores messages from anyone but its parent, and a second «open»', () => {
    const h = host(true);
    h.send({ source: 'calab-office', type: 'open', config: {} }, h.child);
    expect(h.editors).toHaveLength(0);
    h.send({ type: 'open', config: {} });
    expect(h.editors).toHaveLength(0);
    h.send({ source: 'calab-office', type: 'open', config: {} });
    h.send({ source: 'calab-office', type: 'open', config: {} });
    expect(h.editors).toHaveLength(1);
  });

  it('reports a missing api', () => {
    const h = host(false);
    h.send({ source: 'calab-office', type: 'open', config: {} });
    h.child.document.querySelector('script')?.dispatchEvent(new h.child.Event('error'));
    expect(h.toParent.at(-1)).toMatchObject({ type: 'event', name: 'error', data: { code: 'api-load' } });
  });
});

describe('bridge (client side)', () => {
  function client() {
    const { parent, frame, child } = pair();
    const toHost: [unknown, string][] = [];
    vi.spyOn(child, 'postMessage').mockImplementation((m: unknown, o?: unknown) => {
      toHost.push([m, String(o)]);
    });
    const events: HostEvent[] = [];
    let hellos = 0;
    const conn = connectHost(parent, frame, DOCS, JSON.stringify({ document: { key: 'k' }, token: 'signed' }), (e) => events.push(e), () => hellos++);
    const fromHost = (data: unknown, origin = DOCS, source: unknown = child): void => {
      parent.dispatchEvent(new parent.MessageEvent('message', { data, origin, source: source as Window }));
    };
    return { parent, child, toHost, events, conn, fromHost, hellos: () => hellos };
  }

  it('sends the config once, only to the Document Server origin, on hello', () => {
    const c = client();
    expect(c.toHost).toHaveLength(0);
    c.fromHost({ source: 'calab-office', type: 'hello' });
    c.fromHost({ source: 'calab-office', type: 'hello' });
    expect(c.toHost).toEqual([[{ source: 'calab-office', type: 'open', config: { document: { key: 'k' }, token: 'signed' } }, DOCS]]);
    expect(c.hellos()).toBe(1);
  });

  it('drops messages of another origin or another window', () => {
    const c = client();
    c.fromHost({ source: 'calab-office', type: 'hello' }, 'https://evil.test');
    c.fromHost({ source: 'calab-office', type: 'hello' }, DOCS, c.parent);
    c.fromHost({ source: 'calab-office', type: 'event', name: 'error', data: { code: 1 } }, 'https://evil.test');
    expect(c.toHost).toHaveLength(0);
    expect(c.events).toHaveLength(0);
    expect(c.hellos()).toBe(0);
  });

  it('maps the host events and stops listening on close', () => {
    const c = client();
    c.fromHost({ source: 'calab-office', type: 'event', name: 'ready', data: null });
    c.fromHost({ source: 'calab-office', type: 'event', name: 'state', data: true });
    c.fromHost({ source: 'calab-office', type: 'event', name: 'error', data: { code: -4 } });
    c.fromHost({ source: 'calab-office', type: 'event', name: 'nonsense' });
    expect(c.events).toEqual([{ name: 'ready' }, { name: 'state', dirty: true }, { name: 'error', code: '-4' }]);
    c.conn.close();
    expect(c.toHost.at(-1)).toEqual([{ source: 'calab-office', type: 'close' }, DOCS]);
    c.fromHost({ source: 'calab-office', type: 'event', name: 'ready' });
    expect(c.events).toHaveLength(3);
  });

  it('frame status', () => {
    expect(nextStatus('loading', { name: 'ready' })).toBe('saved');
    expect(nextStatus('saved', { name: 'state', dirty: true })).toBe('saving');
    expect(nextStatus('saving', { name: 'state', dirty: false })).toBe('saved');
    expect(nextStatus('saving', { name: 'error', code: '' })).toBe('error');
    expect(nextStatus('error', { name: 'state', dirty: false })).toBe('error');
    expect(nextStatus('saved', { name: 'warning' })).toBe('saved');
  });

  it('files and origins', () => {
    setOfficeCaps(SERVER);
    expect(officeOpens('График отпусков 2026.XLSX')).toBe(true);
    expect(officeOpens('Договор.docx')).toBe(true);
    expect(officeOpens('Презентация.PPTX')).toBe(true);
    expect(officeOpens('old.xls')).toBe(true);
    expect(officeOpens('xlsx')).toBe(false);
    expect(officeOpens('notes.rar')).toBe(false);
    expect(originOf('https://docs.calab.test/x?y')).toBe(DOCS);
    expect(originOf('javascript:alert(1)')).toBe('');
  });
});

describe('capabilities and rules of the frame', () => {
  it("the server's map: edit, convert on «Сохранить как», view", () => {
    setOfficeCaps(SERVER);
    expect(officeCapability('a.docx')).toBe('edit');
    expect(officeCapability('a.XLSX')).toBe('edit');
    expect(officeCapability('a.pptx')).toBe('edit');
    expect(officeCapability('a.doc')).toBe('convert');
    expect(officeCapability('a.ppt')).toBe('convert');
    expect(officeCapability('a.odt')).toBe('edit');
    expect(officeCapability('a.pdf')).toBe('view');
    expect(officeCapability('a.rar')).toBeNull();
    expect(officeCapability('docx')).toBeNull();
    expect(convertTarget('a.doc')).toBe('docx');
    expect(convertTarget('a.xls')).toBe('xlsx');
    expect(convertTarget('a.ppt')).toBe('pptx');
    expect(convertTarget('a.docx')).toBe('');
  });

  it('phone view only, whatever the server says; a view type or a view mode views', () => {
    expect(viewOnly('edit', true, false)).toBe(false);
    expect(viewOnly('edit', true, true)).toBe(true);
    expect(viewOnly('edit', false, false)).toBe(true);
    expect(viewOnly('view', true, false)).toBe(true);
    expect(viewOnly('convert', true, false)).toBe(false);
    expect(viewOnly('convert', true, true)).toBe(true);
  });

  it('status machine: loading → saved ⇄ saving, a sticky error with its cause, reset by a retry, co-editors', () => {
    let s = FRAME_START;
    s = frameReducer(s, { name: 'ready' });
    expect(s.status).toBe('saved');
    s = frameReducer(s, { name: 'state', dirty: true });
    expect(s.status).toBe('saving');
    s = frameReducer(s, { name: 'users', names: ['Анна'] });
    expect(s.others).toEqual(['Анна']);
    expect(s.status).toBe('saving');
    s = frameReducer(s, { name: 'state', dirty: false });
    expect(s.status).toBe('saved');
    s = frameReducer(s, { name: 'error', code: '-20' });
    expect(s).toMatchObject({ status: 'error', problem: 'token' });
    expect(frameReducer(s, { name: 'error', code: 'api-load' }).problem).toBe('token');
    expect(frameReducer(s, { name: 'state', dirty: false }).status).toBe('error');
    expect(frameReducer(s, { name: 'reset' })).toEqual(FRAME_START);
    expect(frameReducer(FRAME_START, { name: 'error', code: 'timeout' }).problem).toBe('unreachable');
    expect(problemOf('api-missing')).toBe('unreachable');
    expect(problemOf('-4')).toBe('other');
  });

  it('the bridge relays the co-editors and the theme', () => {
    const { parent, frame, child } = pair();
    const out: unknown[] = [];
    vi.spyOn(child, 'postMessage').mockImplementation((m: unknown) => {
      out.push(m);
    });
    const events: HostEvent[] = [];
    const conn = connectHost(parent, frame, DOCS, '{}', (e) => events.push(e));
    parent.dispatchEvent(new parent.MessageEvent('message', { data: { source: 'calab-office', type: 'event', name: 'users', data: [{ id: 1, name: 'Анна' }, { name: 5 }, null] }, origin: DOCS, source: child as unknown as Window }));
    expect(events).toEqual([{ name: 'users', names: ['Анна'] }]);
    // The operator's themes (OFFICE_THEME_*), as the capabilities report them.
    setOfficeCaps(SERVER);
    conn.setTheme('light');
    expect(out.at(-1)).toEqual({ source: 'calab-office', type: 'theme', theme: 'default-light' });
    conn.setTheme('dark');
    expect(out.at(-1)).toEqual({ source: 'calab-office', type: 'theme', theme: 'theme-calab-dark' });
  });
});

describe('entry-point visibility', () => {
  it("«Открыть» is the editor only while the server's editor is on and names the extension", () => {
    setOfficeCaps({ ...SERVER, enabled: false });
    expect(useOfficeCaps.getState().enabled).toBe(false);
    expect(officeOpens('a.xlsx')).toBe(false);
    setOfficeCaps(SERVER);
    expect(officeOpens('a.xlsx')).toBe(true);
    expect(officeOpens('a.pptx')).toBe(true);
    expect(officeOpens('a.doc')).toBe(true);
    expect(officeOpens('a.pdf')).toBe(true);
    expect(officeOpens('a.txt')).toBe(false);
    setOfficeCaps({ ...SERVER, enabled: false });
    expect(officeOpens('a.xlsx')).toBe(false);
  });
});
