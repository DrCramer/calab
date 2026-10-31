// Records the files the office editors load (ADR-0143) into apps/desktop/src/main/officeAssets.json,
// the precache list main/officeWarm.ts warms. Rerun after a Document Server upgrade:
//   pnpm -F @calaba/desktop exec electron ../../tools/office-assets.cjs https://docs.calab.io
// Each editor's index.html is opened in a frame under a file:// page, as in the app; the versioned
// GETs answered 200 are kept in the order they completed (the order the editor needs them).
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const docs = new URL(process.argv.at(-1)).origin;
const OUT = path.join(__dirname, '../apps/desktop/src/main/officeAssets.json');
const EDITORS = { word: 'documenteditor', cell: 'spreadsheeteditor', slide: 'presentationeditor' };
const VERSIONED = /^\/(\d+\.\d+\.\d+-[0-9a-f]{32})\/(.+)$/;
const NOT_ASSETS = /^(doc|cache|downloadfile|coauthoring|converter|healthcheck)\b/;

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'office-assets-')));
// One editor's window closes before the next opens: that must not end the run.
app.on('window-all-closed', () => undefined);

async function record(version, editor) {
  // Its own session per editor: a window of the same session would get shared files from Blink's memory cache.
  const ses = session.fromPartition(`office-assets-${editor}`);
  const seen = [];
  let last = Date.now();
  let inflight = 0;
  const filter = { urls: [`${docs}/*`] };
  ses.webRequest.onBeforeRequest(filter, (_d, cb) => {
    inflight++;
    cb({});
  });
  ses.webRequest.onErrorOccurred(filter, () => {
    inflight--;
    last = Date.now();
  });
  ses.webRequest.onCompleted(filter, (d) => {
    inflight--;
    last = Date.now();
    const u = new URL(d.url);
    const m = VERSIONED.exec(u.pathname);
    if (d.method === 'GET' && d.statusCode === 200 && m && !NOT_ASSETS.test(m[2])) seen.push(m[2] + u.search);
  });
  const page = path.join(app.getPath('userData'), 'top.html');
  fs.writeFileSync(page, '<!doctype html><iframe id="f"></iframe><script>f.src = location.hash.slice(1)</script>');
  const win = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true } });
  const started = Date.now();
  await win.loadFile(page, { hash: `${docs}/${version}/web-apps/apps/${editor}/main/index.html` });
  await new Promise((resolve) => {
    const t = setInterval(() => {
      if (inflight <= 0 && Date.now() - last > 3000 && Date.now() - started > 5000) clearInterval(t), resolve();
    }, 200);
  });
  win.destroy();
  return [...new Set(seen)];
}

app.whenReady().then(async () => {
  const api = await (await session.defaultSession.fetch(`${docs}/web-apps/apps/api/documents/api.js`)).text();
  const version = /\b(\d+\.\d+\.\d+-[0-9a-f]{32})\b/.exec(api)?.[1];
  if (!version) throw new Error('no Document Server version in api.js');
  const out = { version };
  for (const [kind, editor] of Object.entries(EDITORS)) {
    out[kind] = await record(version, editor);
    console.log(kind, out[kind].length);
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  app.quit();
});
