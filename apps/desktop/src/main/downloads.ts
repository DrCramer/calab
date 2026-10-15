import { execFile } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { app, BrowserWindow, session, shell, type DownloadItem, type Session } from 'electron';
import log from 'electron-log/main';
import { safeFileName, numberedName } from '../shared/fileName';
import { IPC, type DownloadArgs, type DownloadProgress } from '../shared/ipc';
import { currentServerUrl, getAccessToken } from './auth';

/**
 * Attachment downloads (security review 2026-09-26, M2): through Chromium's download manager
 * (session.downloadURL + `will-download`, with progress), and every saved file is marked as
 * downloaded from the Internet — `com.apple.quarantine` on macOS (Gatekeeper checks a
 * downloaded .app / .terminal / .fileloc on open) and the Mark-of-the-Web (`Zone.Identifier`,
 * zone 3) on Windows (SmartScreen / Office protected view). Electron's download manager does
 * not set these itself (verified on macOS: no xattr), so we do it right after completion.
 */

/** A free path in `dir` for a user-supplied name (shared/fileName.ts: `..`, CON, trailing dots…). */
export function uniquePath(dir: string, name: string): string {
  const safe = safeFileName(name);
  let p = join(dir, safe);
  for (let i = 1; existsSync(p); i++) p = join(dir, numberedName(safe, i));
  return p;
}

const run = promisify(execFile);

/** Marks a file as downloaded from `origin` (quarantine / Mark-of-the-Web). Never throws. */
export async function markFromInternet(path: string, origin: string): Promise<void> {
  try {
    if (process.platform === 'darwin') {
      // flags 0x0083 = quarantined + downloaded by a user agent; time in hex seconds.
      const value = `0083;${Math.floor(Date.now() / 1000).toString(16)};Calab;`;
      await run('/usr/bin/xattr', ['-w', 'com.apple.quarantine', value, path], { timeout: 5000 });
    } else if (process.platform === 'win32') {
      writeFileSync(`${path}:Zone.Identifier`, `[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=${origin}\r\n`);
    }
  } catch (e) {
    log.warn('[download] could not mark the file as downloaded from the Internet', e);
  }
}

interface Pending {
  fileId: string;
  name: string;
  resolve: (path: string) => void;
  reject: (e: Error) => void;
}

/** Our downloads by URL; other downloads keep Chromium's default handling (marked on completion). */
const pending = new Map<string, Pending>();
let installedOn: Session | null = null;

function broadcast(p: DownloadProgress): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC.filesProgress, p);
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function onWillDownload(_e: Electron.Event, item: DownloadItem): void {
  const url = item.getURLChain()[0] ?? item.getURL();
  const job = pending.get(url);
  if (!job) {
    // Another download keeps Chromium's handling (a save dialog) — today the PDF viewer's own
    // «Скачать» / «Сохранить» (ADR-0103, a blob: of our page): the saved file is marked all the same.
    item.once('done', (_ev, state) => {
      const path = item.getSavePath();
      if (state === 'completed' && path) void markFromInternet(path, originOf(currentServerUrl()));
    });
    return;
  }
  pending.delete(url);
  const path = uniquePath(app.getPath('downloads'), job.name);
  item.setSavePath(path); // no save dialog
  item.on('updated', (_ev, state) => {
    if (state === 'progressing') broadcast({ fileId: job.fileId, received: item.getReceivedBytes(), total: item.getTotalBytes(), state: 'progressing' });
  });
  item.once('done', (_ev, state) => {
    broadcast({ fileId: job.fileId, received: item.getReceivedBytes(), total: item.getTotalBytes(), state });
    if (state === 'completed') {
      void markFromInternet(path, new URL(url).origin).then(() => {
        shell.showItemInFolder(path);
        job.resolve(path);
      });
    } else {
      log.warn('[download] not completed', state);
      job.reject(new Error(state === 'cancelled' ? 'cancelled' : 'download failed'));
    }
  });
}

/** The `will-download` handler on `ses` (once; also installed lazily by downloadFile). */
export function installDownloadHandler(ses: Session): void {
  if (installedOn === ses) return;
  ses.on('will-download', onWillDownload);
  installedOn = ses;
}

/** Saves an attachment into ~/Downloads (quarantined) and reveals it. Returns the saved path. */
export async function downloadFile(args: DownloadArgs): Promise<string> {
  if (!/^[0-9a-f-]{36}$/i.test(args.fileId)) throw new Error('invalid file id');
  const ses = session.defaultSession;
  installDownloadHandler(ses);
  const token = await getAccessToken();
  // A per-request marker keeps concurrent downloads of the same file apart.
  const url = `${currentServerUrl()}/api/files/${args.fileId}?dl=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return new Promise<string>((resolve, reject) => {
    pending.set(url, { fileId: args.fileId, name: args.name, resolve, reject });
    ses.downloadURL(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    // Never leave a promise hanging if Chromium refuses to start the download.
    setTimeout(() => {
      if (pending.delete(url)) reject(new Error('download did not start'));
    }, 30_000);
  });
}
