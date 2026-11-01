#!/usr/bin/env node
// ONLYOFFICE fidelity and cost bench (ADR-0143 «План проверки»). Needs a Document Server with JWT
// and the storage/callback stub harness.py next to it (run.sh starts both locally; a remote trial
// reaches them through ssh -L).
//
//   node tools/office-fidelity/bench.mjs --ds http://localhost:18080 --secret-file OUT/ds.env \
//     --storage http://localhost:18091 --storage-for-ds http://onlyoffice-trial-harness:8000 --out OUT
//
// 1. Conversion round trips: POST {ds}/converter (JWT in body and header) of every fixture into
//    its own format → OUT/convert-<name>; and the legacy path of «Сохранить как» (ADR-0143
//    «Форматы»): xlsx → xls → xlsx, docx → doc → docx, pptx → ppt → pptx → OUT/legacy-<name>
//    (compare.py against the original shows what the legacy format loses).
// 2. The editor through the Calab host page (infra/office/calab-editor.html, mounted into the
//    Document Server's web-apps), framed by a parent page like the Calab client. Per type, in a
//    fresh browser context (cold cache): download size from the Document Server, time to «ready»,
//    page CPU and JS heap over an idle minute; an edit with the keyboard, Ctrl+S → status 6, close
//    (the iframe goes) → status 2 with timings; page CPU / heap / frames after close against the
//    baseline before opening. Saved files: OUT/editor{6,2}-<name>.
// 3. Screenshots: every type × dark / light × compact header on / off (warm cache, also the warm
//    open time). OUT/shot-<type>-<theme>-<compact|full>.png.
// 4. OUT/bench.json.
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const { chromium } = require('@playwright/test');

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const DS = arg('ds', 'http://localhost:18080').replace(/\/$/, '');
const SECRET = arg('secret') ?? /JWT_SECRET=(\S+)/.exec(readFileSync(arg('secret-file', 'ds.env'), 'utf8'))?.[1];
const STORAGE = arg('storage', 'http://localhost:18091').replace(/\/$/, '');
const STORAGE_FOR_DS = arg('storage-for-ds', 'http://host.docker.internal:18091').replace(/\/$/, '');
const OUT = arg('out', '.');
const PORT = Number(arg('port', '18092'));
const IDLE_S = Number(arg('idle', '60'));
const ONLY = arg('only', 'convert,editor,shots').split(',');
const PARENT = `http://localhost:${PORT}`;
if (!SECRET) throw new Error('no JWT secret (--secret or --secret-file with JWT_SECRET=…)');

const sign = (payload) => {
  const b = (x) => Buffer.from(JSON.stringify(x)).toString('base64url');
  const hp = `${b({ alg: 'HS256', typ: 'JWT' })}.${b(payload)}`;
  return `${hp}.${createHmac('sha256', SECRET).update(hp).digest('base64url')}`;
};
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- callbacks (polled from the stub)

async function callbacks() {
  return (await fetch(`${STORAGE}/callbacks`)).json();
}
/** Polls the stub every 250 ms; resolves with the callback and the local time it was seen. */
async function waitCallback(pred, ms, since = 0) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = (await callbacks()).slice(since).find(pred);
    if (hit) return { ...hit, seenAt: Date.now() };
    await sleep(250);
  }
  return { error: 'callback timeout' };
}
async function fetchSaved(cb) {
  if (!cb?.file) return;
  writeFileSync(join(OUT, cb.file), Buffer.from(await (await fetch(`${STORAGE}/saved/${encodeURIComponent(cb.file)}`)).arrayBuffer()));
}

// ---------------------------------------------------------------- the parent page (the «Calab client»)

let pageHtml = '<!doctype html><title>blank</title>';
const parentPage = (configJson) => `<!doctype html><meta charset="utf-8"><title>bench</title>
<style>html,body{margin:0;height:100%;background:#000}iframe{border:0;width:100%;height:100%}</style>
<body><script>
window.__events = [];
const DOCS = ${JSON.stringify(new URL(DS).origin)};
const f = document.createElement('iframe');
f.src = DOCS + '/web-apps/apps/calab/calab-editor.html';
addEventListener('message', (e) => {
  if (e.source !== f.contentWindow || e.origin !== DOCS || !e.data || e.data.source !== 'calab-office') return;
  if (e.data.type === 'hello') f.contentWindow.postMessage({ source: 'calab-office', type: 'open', config: ${configJson} }, DOCS);
  else window.__events.push({ t: Date.now(), type: e.data.type, name: e.data.name, data: e.data.data });
});
window.__close = () => { f.contentWindow && f.contentWindow.postMessage({ source: 'calab-office', type: 'close' }, DOCS); setTimeout(() => f.remove(), 200); };
document.body.appendChild(f);
</script></body>`;
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(pageHtml);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

// ---------------------------------------------------------------- 1. conversion round trip

async function convert(name, to, out = `convert-${name}`) {
  const ext = name.split('.').pop();
  const body = { async: false, filetype: ext, outputtype: to ?? ext, key: `bench-${randomBytes(6).toString('hex')}`, title: name, url: `${STORAGE_FOR_DS}/files/${encodeURIComponent(name)}` };
  const tok = sign({ ...body, operation: 'converter' });
  const t0 = Date.now();
  const r = await fetch(`${DS}/converter`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${tok}` }, body: JSON.stringify({ ...body, token: tok }) });
  const text = await r.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return { name, error: `HTTP ${r.status}: ${text.slice(0, 200)}` };
  }
  if (!j.endConvert || !j.fileUrl) return { name, error: j.error ?? j };
  const u = new URL(j.fileUrl);
  const file = join(OUT, out);
  writeFileSync(file, Buffer.from(await (await fetch(`${DS}${u.pathname}${u.search}`)).arrayBuffer()));
  return { name, file, ms: Date.now() - t0 };
}

// ---------------------------------------------------------------- 2. the editor

const DOC_TYPE = { xlsx: 'cell', docx: 'word', pptx: 'slide' };
const editorConfig = (name, theme, compact) => {
  const ext = name.split('.').pop();
  const cfg = {
    type: 'desktop',
    documentType: DOC_TYPE[ext],
    document: { fileType: ext, key: `bench-${randomBytes(8).toString('hex')}`, title: name, url: `${STORAGE_FOR_DS}/files/${encodeURIComponent(name)}`, permissions: { edit: true, download: true, print: true, chat: false } },
    editorConfig: {
      mode: 'edit', lang: 'ru', callbackUrl: `${STORAGE_FOR_DS}/callback/${encodeURIComponent(name)}`,
      user: { id: '00000000-0000-7000-8000-000000000001', name: 'Анна Иванова' },
      customization: { uiTheme: theme, compactHeader: compact, toolbarHideFileName: compact, hideRightMenu: true, autosave: true, forcesave: true, help: false, feedback: false, plugins: false },
    },
  };
  return { ...cfg, token: sign(cfg) };
};

async function metrics(cdp) {
  const m = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
  return { task: m.TaskDuration, heap: m.JSHeapUsedSize, nodes: m.Nodes, frames: m.Frames, docs: m.Documents };
}
const mb = (b) => +(b / 1048576).toFixed(1);

async function open(context, name, theme, compact) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const net = { bytes: 0, requests: 0, js: 0 };
  page.on('requestfinished', async (rq) => {
    if (!rq.url().startsWith(DS)) return;
    try {
      const s = await rq.sizes();
      const r = await rq.response();
      if (r?.fromServiceWorker()) return;
      net.requests++;
      net.bytes += s.responseBodySize + s.responseHeadersSize;
      if (/\.js(\?|$)/.test(rq.url())) net.js += s.responseBodySize;
    } catch {
      // gone
    }
  });
  pageHtml = '<!doctype html><title>blank</title>';
  await page.goto(`${PARENT}/blank`);
  await cdp.send('HeapProfiler.collectGarbage');
  const base = await metrics(cdp);
  pageHtml = parentPage(JSON.stringify(editorConfig(name, theme, compact)));
  const t0 = Date.now();
  await page.goto(`${PARENT}/editor`);
  await page.waitForFunction(() => window.__events.some((e) => e.name === 'ready' || e.name === 'error'), null, { timeout: 180_000 });
  const ready = await page.evaluate(() => window.__events.find((e) => e.name === 'ready' || e.name === 'error'));
  return { page, cdp, net, base, openMs: ready.t - t0, error: ready.name === 'error' ? ready.data : null };
}

async function close(page) {
  await page.evaluate(() => window.__close());
  return Date.now();
}

const EDIT = {
  // C4 (the first vacation start) := 02.07.2026
  xlsx: async (page) => {
    await page.mouse.click(700, 500);
    await page.keyboard.press('Control+Home');
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
    for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowRight');
    await page.keyboard.type('02.07.2026');
    await page.keyboard.press('Enter');
  },
  docx: async (page) => {
    await page.mouse.click(720, 500);
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('End');
    await page.keyboard.type(' (правка из редактора)');
  },
  // the title placeholder of the first slide
  pptx: async (page) => {
    const box = await page.evaluate(() => [innerWidth, innerHeight]);
    await page.mouse.dblclick(box[0] * 0.58, box[1] * 0.45);
    await page.keyboard.press('End');
    await page.keyboard.type(' (правка)');
    await page.keyboard.press('Escape');
  },
};

async function measure(browser, name) {
  const ext = name.split('.').pop();
  // Cold cache, and no service worker: the editor's own SW would serve its scripts unseen.
  const context = await browser.newContext({ locale: 'ru-RU', serviceWorkers: 'block' });
  const before = (await callbacks()).length;
  const o = await open(context, name, 'default-dark', true);
  log(name, 'ready in', o.openMs, 'ms,', o.net.requests, 'requests', mb(o.net.bytes), 'MB');
  await sleep(5000);
  const a = await metrics(o.cdp);
  await sleep(IDLE_S * 1000);
  const b = await metrics(o.cdp);
  const res = {
    name, error: o.error, openMs: o.openMs, coldRequests: o.net.requests, coldMB: mb(o.net.bytes), coldJsMB: mb(o.net.js),
    idle: { seconds: IDLE_S, cpuPercent: +(((b.task - a.task) / IDLE_S) * 100).toFixed(2), heapMB: mb(b.heap), nodes: b.nodes, frames: b.frames },
    base: { heapMB: mb(o.base.heap), nodes: o.base.nodes, frames: o.base.frames },
  };
  if (!o.error) {
    await EDIT[ext](o.page);
    const tEdit = Date.now();
    await sleep(1500);
    await o.page.screenshot({ path: join(OUT, `edited-${ext}.png`) });
    await o.page.keyboard.press('Control+S');
    const tSave = Date.now();
    const c6 = await waitCallback((c) => c.name === name && c.status === 6, 60_000, before);
    await fetchSaved(c6);
    const tClose = await close(o.page);
    const c2 = await waitCallback((c) => c.name === name && (c.status === 2 || c.status === 4), 90_000, before);
    await fetchSaved(c2);
    res.save = {
      forcesave: c6.error ? c6 : { afterCtrlS_s: +((c6.seenAt - tSave) / 1000).toFixed(1), size: c6.size, forcesavetype: c6.forcesavetype, operation: c6.operation },
      final: c2.error ? c2 : { status: c2.status, afterClose_s: +((c2.seenAt - tClose) / 1000).toFixed(1), afterLastEdit_s: +((c2.seenAt - tEdit) / 1000).toFixed(1), size: c2.size },
    };
  } else {
    await close(o.page);
  }
  await sleep(3000);
  await o.cdp.send('HeapProfiler.collectGarbage');
  const c1 = await metrics(o.cdp);
  await sleep(10_000);
  const c2 = await metrics(o.cdp);
  res.afterClose = { heapMB: mb(c2.heap), nodes: c2.nodes, frames: c2.frames, cpuPercent: +(((c2.task - c1.task) / 10) * 100).toFixed(2) };
  await context.close();
  log(JSON.stringify(res));
  return res;
}

async function shots(browser, name) {
  const ext = name.split('.').pop();
  const context = await browser.newContext({ locale: 'ru-RU' });
  const out = [];
  for (const theme of ['default-dark', 'default-light']) {
    for (const compact of [true, false]) {
      const o = await open(context, name, theme, compact);
      await sleep(4000);
      const file = join(OUT, `shot-${ext}-${theme.replace('default-', '')}-${compact ? 'compact' : 'full'}.png`);
      await o.page.screenshot({ path: file });
      out.push({ file, warmOpenMs: o.openMs, warmMB: mb(o.net.bytes), error: o.error });
      await close(o.page);
      await o.page.close();
    }
  }
  await context.close();
  return out;
}

const FILES = ['vacations.xlsx', 'contract.docx', 'deck.pptx'];
const report = { ds: DS, at: new Date().toISOString(), convert: [], editor: [], shots: [] };
const browser = await chromium.launch({ args: ['--enable-precise-memory-info'] });
try {
  if (ONLY.includes('convert')) {
    for (const n of [...FILES, 'staff.csv']) report.convert.push(await convert(n).catch((e) => ({ name: n, error: e.message })));
    // The legacy path: the Document Server writes the legacy file (into OUT, so the storage stub
    // serves it), then «Сохранить как» converts it back to OOXML → OUT/legacy-<name>.
    for (const [n, legacy] of [['vacations.xlsx', 'xls'], ['contract.docx', 'doc'], ['deck.pptx', 'ppt']]) {
      const base = n.replace(/\.[^.]+$/, '');
      const old = await convert(n, legacy, `${base}.${legacy}`).catch((e) => ({ name: n, error: e.message }));
      if (old.error) { report.convert.push(old); continue; }
      report.convert.push(await convert(`${base}.${legacy}`, n.split('.').pop(), `legacy-${n}`).catch((e) => ({ name: `${base}.${legacy}`, error: e.message })));
    }
  }
  log('convert', JSON.stringify(report.convert));
  if (ONLY.includes('editor')) for (const n of FILES) report.editor.push(await measure(browser, n).catch((e) => ({ name: n, error: e.message })));
  if (ONLY.includes('shots')) for (const n of FILES) report.shots.push(...(await shots(browser, n).catch((e) => [{ name: n, error: e.message }])));
} finally {
  await browser.close();
  server.close();
  writeFileSync(join(OUT, 'bench.json'), JSON.stringify(report, null, 1));
}
console.log(JSON.stringify(report, null, 1));
