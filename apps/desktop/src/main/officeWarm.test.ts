import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', once: vi.fn() }, session: {} }));
vi.mock('./logging', () => ({ log: { info: vi.fn(), warn: vi.fn() } }));

const { assetPath, createWarmer, kindOfPath, mergeInTurn, parseState, usedKinds, versionOf, warmList } = await import('./officeWarm');
const assets = (await import('./officeAssets.json')).default;

const DOCS = 'https://docs.example.test';
const V = '10.0.0-ce0e996f340571b62de360f416560cfc';
const API = `/* … */ var ver = '/${V}/'; /* … */`;
const CELL = 'web-apps/apps/spreadsheeteditor/main/app.js';
const WORD = 'web-apps/apps/documenteditor/main/app.js';

function deps(opts: { state?: string; api?: string; failing?: (url: string) => boolean } = {}) {
  const fetched: string[] = [];
  let written = '';
  let clock = 0;
  const d = {
    fetch: vi.fn((url: string) => {
      fetched.push(url);
      if (url.endsWith('/api.js')) return Promise.resolve(new Response(opts.api ?? API));
      if (opts.failing?.(url)) return Promise.reject(new Error('offline'));
      return Promise.resolve(new Response('x'.repeat(10)));
    }),
    read: () => Promise.resolve(opts.state ?? ''),
    write: (s: string) => {
      written = s;
      return Promise.resolve();
    },
    now: () => clock,
    delay: vi.fn(() => Promise.resolve()),
  };
  const files = () => fetched.filter((u) => !u.endsWith('/api.js'));
  return { d, fetched, files, written: () => written, tick: (ms: number) => (clock += ms) };
}

const docsUrl = () => Promise.resolve(DOCS);
const state = (s: object) => JSON.stringify({ origin: DOCS, warmed: {}, paths: [], ...s });

describe('officeWarm', () => {
  it('reads the version from api.js', () => {
    expect(versionOf(API)).toBe(V);
    expect(versionOf('no version here')).toBe('');
  });

  it('learns only the editor files of the origin, relative to the version', () => {
    expect(assetPath(`${DOCS}/${V}/sdkjs/cell/sdk-all.js`, DOCS)).toBe('sdkjs/cell/sdk-all.js');
    expect(assetPath(`${DOCS}/${V}/web-apps/apps/x/main/locale/ru.json?_dc=1`, DOCS)).toBe('web-apps/apps/x/main/locale/ru.json?_dc=1');
    expect(assetPath(`${DOCS}/${V}/doc/key/c/`, DOCS)).toBeNull();
    expect(assetPath(`${DOCS}/cache/files/data/k/Editor.bin`, DOCS)).toBeNull();
    expect(assetPath(`https://evil.test/${V}/sdkjs/cell/sdk-all.js`, DOCS)).toBeNull();
    expect(assetPath('not a url', DOCS)).toBeNull();
  });

  it('tells the editor of a path; shared files belong to none', () => {
    expect(kindOfPath('sdkjs/cell/sdk-all.js')).toBe('cell');
    expect(kindOfPath(WORD)).toBe('word');
    expect(kindOfPath('web-apps/apps/presentationeditor/main/code.js')).toBe('slide');
    expect(kindOfPath('sdkjs/common/AllFonts.js')).toBeNull();
    expect(usedKinds(['sdkjs/common/AllFonts.js', CELL])).toEqual(['cell']);
  });

  it('merges lists in turn, each path once', () => {
    expect(mergeInTurn([['a', 'b', 'c'], ['x', 'b']])).toEqual(['a', 'x', 'b', 'c']);
    expect(mergeInTurn([])).toEqual([]);
  });

  it("warms an editor's recorded files plus what was learned for it or shared", () => {
    const urls = warmList(DOCS, V, ['cell'], [WORD, 'shared.js', 'web-apps/apps/spreadsheeteditor/main/extra.js']);
    expect(urls.every((u) => u.startsWith(`${DOCS}/${V}/`))).toBe(true);
    expect(urls).toContain(`${DOCS}/${V}/${assets.cell[0]}`);
    expect(urls).toContain(`${DOCS}/${V}/shared.js`);
    expect(urls).toContain(`${DOCS}/${V}/web-apps/apps/spreadsheeteditor/main/extra.js`);
    expect(urls).not.toContain(`${DOCS}/${V}/${WORD}`);
    expect(urls.some((u) => /documenteditor|sdkjs\/word\//.test(u))).toBe(false);
  });

  it('drops a broken state file, keeps the known editors', () => {
    expect(parseState('{')).toEqual({ origin: '', warmed: {}, paths: [] });
    expect(parseState(JSON.stringify({ origin: DOCS, warmed: { cell: V, pdf: V }, paths: ['a', 1] }))).toEqual({ origin: DOCS, warmed: { cell: V }, paths: ['a'] });
  });

  it('a folder of spreadsheets warms the spreadsheet editor only, once per version', async () => {
    const t = deps();
    const w = createWarmer(t.d);
    await w.warm('disk', ['cell'], docsUrl);
    expect(t.files()).toHaveLength(new Set(assets.cell).size);
    expect(t.files().some((u) => /documenteditor|presentationeditor/.test(u))).toBe(false);
    await w.warm('disk', ['cell'], docsUrl);
    expect(t.files()).toHaveLength(new Set(assets.cell).size);
    w.stop();
    expect(parseState(t.written()).warmed).toEqual({ cell: V });
  });

  it('a folder of documents next warms the document editor, not the spreadsheet one again', async () => {
    const t = deps({ state: state({ warmed: { cell: V } }) });
    const w = createWarmer(t.d);
    await w.warm('disk', ['cell', 'word'], docsUrl);
    expect(t.files().some((u) => u.includes('documenteditor'))).toBe(true);
    expect(t.files().some((u) => u.includes('spreadsheeteditor'))).toBe(false);
  });

  it('a folder without documents warms nothing', async () => {
    const t = deps();
    await createWarmer(t.d).warm('disk', [], docsUrl);
    expect(t.fetched).toHaveLength(0);
  });

  it('rewarms after a Document Server upgrade, with what it learned', async () => {
    const t = deps({ state: state({ warmed: { cell: '9.0.0-' + 'a'.repeat(32) }, paths: ['sdkjs/cell/learned.js'] }) });
    await createWarmer(t.d).warm('disk', ['cell'], docsUrl);
    expect(t.fetched).toContain(`${DOCS}/${V}/sdkjs/cell/learned.js`);
  });

  it('at READY warms, after a pause, only the editors opened before', async () => {
    const never = deps();
    await createWarmer(never.d).warm('ready', [], docsUrl);
    expect(never.fetched).toHaveLength(0);

    const used = deps({ state: state({ paths: [CELL] }) });
    await createWarmer(used.d).warm('ready', [], docsUrl);
    expect(used.d.delay).toHaveBeenCalledOnce();
    expect(used.files().some((u) => u.includes('spreadsheeteditor'))).toBe(true);
    expect(used.files().some((u) => /documenteditor|presentationeditor/.test(u))).toBe(false);
  });

  it('asks api.js for the version at most once per 30 minutes', async () => {
    const t = deps({ api: 'nothing' });
    const w = createWarmer(t.d);
    await w.warm('disk', ['cell'], docsUrl);
    await w.warm('disk', ['word'], docsUrl);
    expect(t.fetched).toHaveLength(1);
    t.tick(31 * 60_000);
    await w.warm('disk', ['cell'], docsUrl);
    expect(t.fetched).toHaveLength(2);
  });

  it('does not mark an editor warmed when most files failed', async () => {
    const t = deps({ failing: (u) => !u.endsWith('require.js') });
    const w = createWarmer(t.d);
    await w.warm('disk', ['cell'], docsUrl);
    w.stop();
    expect(t.written() === '' ? {} : parseState(t.written()).warmed).toEqual({});
  });

  it('nothing happens with the editor off', async () => {
    const t = deps();
    await createWarmer(t.d).warm('disk', ['cell'], () => Promise.resolve(''));
    expect(t.fetched).toHaveLength(0);
  });

  it('remembers what the frame loaded, once', async () => {
    const t = deps();
    const w = createWarmer(t.d);
    await w.prepare();
    w.learn(`${DOCS}/${V}/a.js`, DOCS);
    w.learn(`${DOCS}/${V}/a.js`, DOCS);
    w.learn(`${DOCS}/${V}/doc/k/c/`, DOCS);
    w.stop();
    expect(parseState(t.written())).toMatchObject({ origin: DOCS, paths: ['a.js'] });
  });
});
