/**
 * Warms the office editor's files in the HTTP cache (ADR-0143) so the first open of a document is
 * not a download. The editor is ~12 MB of JS, wasm and CSS behind a requirejs waterfall (app.js asks
 * for its controllers one by one): on a slow or far link the first open takes 10–30 s. Requests made
 * here through the default session land in the same cache entries the editor's frame reads (proven
 * on Electron 44: the frame gets them `fromCache`).
 *
 * - Which editors: only those the person is about to need. Entering a Disk folder warms the editors
 *   of the files in it (`disk`, kinds from the renderer: a folder of .xlsx warms the spreadsheet
 *   editor only); READY warms, after a pause, the editors this person has opened before (`ready`).
 *   Someone who never opens documents downloads nothing.
 * - Once per Document Server version and editor: the version is the `<x.y.z>-<hash>` prefix of every
 *   editor URL, read from the unversioned api.js (at most once per RECHECK_MS).
 * - What: the editor's files from officeAssets.json (recorded by tools/office-assets.cjs) plus the
 *   paths the frame actually loaded here (kept relative to the version, so an upgrade that renames a
 *   few is learned). The time is the waterfall of ~200 small files, not the big ones: warming the 25
 *   heaviest saved 25 %, all of them 98 % (spreadsheet editor on a 0.35 MB/s link: 33 s → 0.6 s).
 * - Cost: network only, PARALLEL requests at a time; nothing is parsed or run.
 */
import { app, session } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { log } from './logging';
import assets from './officeAssets.json';
import { officeOriginOf } from './officeFrame';

const API_JS = '/web-apps/apps/api/documents/api.js';
const VERSION = /\b(\d+\.\d+\.\d+-[0-9a-f]{32})\b/;
const VERSIONED = /^\/(\d+\.\d+\.\d+-[0-9a-f]{32})\/(.+)$/;
/** Paths under the version that are documents or sessions, not the editor's files. */
const NOT_ASSETS = /^(doc|cache|downloadfile|coauthoring|converter|healthcheck)\b/;
const MAX_PATHS = 600;
const PARALLEL = 6;
const RECHECK_MS = 30 * 60_000;
const READY_DELAY_MS = 60_000;

/** The Document Server's documentType of an editor (OfficeFormat.document_type). */
export type OfficeKind = 'word' | 'cell' | 'slide';
export const OFFICE_KINDS: readonly OfficeKind[] = ['word', 'cell', 'slide'];
const KIND_OF: readonly [OfficeKind, RegExp][] = [
  ['word', /^(web-apps\/apps\/documenteditor|sdkjs\/word)\//],
  ['cell', /^(web-apps\/apps\/spreadsheeteditor|sdkjs\/cell)\//],
  ['slide', /^(web-apps\/apps\/presentationeditor|sdkjs\/slide)\//],
];

/** The editor a path belongs to, null for the files they share. */
export function kindOfPath(p: string): OfficeKind | null {
  return KIND_OF.find(([, re]) => re.test(p))?.[0] ?? null;
}

/** Lists merged in turn, each path once: each editor's first files come first (its waterfall needs them first). */
export function mergeInTurn(lists: readonly (readonly string[])[]): string[] {
  const out = new Set<string>();
  for (let i = 0; i < Math.max(0, ...lists.map((l) => l.length)); i++) for (const l of lists) if (i < l.length) out.add(l[i] as string);
  return [...out];
}

export interface WarmState {
  origin: string;
  /** Per editor, the version last warmed completely enough. */
  warmed: Partial<Record<OfficeKind, string>>;
  /** Paths the editor loaded, relative to the version root. */
  paths: string[];
}

const empty = (): WarmState => ({ origin: '', warmed: {}, paths: [] });

/** The Document Server version named in api.js, '' when it names none. */
export function versionOf(apiJs: string): string {
  return VERSION.exec(apiJs)?.[1] ?? '';
}

/** A request of the editor → its path relative to the version, or null when it is not an editor file of `origin`. */
export function assetPath(url: string, origin: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.origin !== origin) return null;
  const m = VERSIONED.exec(u.pathname);
  if (!m?.[2] || NOT_ASSETS.test(m[2])) return null;
  return m[2] + u.search;
}

/** The URLs to warm for these editors: their recorded files, then what was learned for them or shared, each once. */
export function warmList(origin: string, version: string, kinds: readonly OfficeKind[], learned: readonly string[]): string[] {
  const own = learned.filter((p) => {
    const k = kindOfPath(p);
    return k === null || kinds.includes(k);
  });
  return [...new Set([...mergeInTurn(kinds.map((k) => assets[k])), ...own])].map((p) => `${origin}/${version}/${p}`);
}

/** The editors this person has opened here (their files were learned). */
export function usedKinds(learned: readonly string[]): OfficeKind[] {
  return OFFICE_KINDS.filter((k) => learned.some((p) => kindOfPath(p) === k));
}

/** The state file's content, or an empty state for anything unexpected. */
export function parseState(raw: string): WarmState {
  try {
    const v = JSON.parse(raw) as { origin?: unknown; warmed?: unknown; paths?: unknown };
    if (typeof v.origin !== 'string' || !Array.isArray(v.paths)) return empty();
    const warmed: WarmState['warmed'] = {};
    if (v.warmed && typeof v.warmed === 'object')
      for (const k of OFFICE_KINDS) {
        const w = (v.warmed as Record<string, unknown>)[k];
        if (typeof w === 'string') warmed[k] = w;
      }
    return { origin: v.origin, warmed, paths: v.paths.filter((p): p is string => typeof p === 'string').slice(0, MAX_PATHS) };
  } catch {
    return empty();
  }
}

export interface WarmDeps {
  fetch(url: string, init: { signal: AbortSignal }): Promise<Response>;
  read(): Promise<string>;
  write(s: string): Promise<void>;
  now(): number;
  /** Resolves after `ms`, or early when `signal` aborts. */
  delay(ms: number, signal: AbortSignal): Promise<void>;
}

export type WarmReason = 'disk' | 'ready';

/** The warmer over its I/O (tests give fakes; `officeWarmer()` the real ones). */
export function createWarmer(deps: WarmDeps) {
  let state: WarmState | null = null;
  let running: Promise<void> | null = null;
  let known: { origin: string; version: string; at: number } | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const stop = new AbortController();
  /** Entering the Disk while a READY run waits: it goes now. */
  let hurry = new AbortController();

  const load = async (): Promise<WarmState> => (state ??= parseState(await deps.read().catch(() => '')));
  const save = (): void => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (state) void deps.write(JSON.stringify(state)).catch(() => undefined);
    }, 5_000);
  };

  /** The Document Server origin and its version, asked again after RECHECK_MS. */
  async function current(docsUrl: () => Promise<unknown>): Promise<{ origin: string; version: string } | null> {
    if (known && deps.now() - known.at < RECHECK_MS) return known.version ? known : null;
    const origin = officeOriginOf(await docsUrl().catch(() => ''));
    if (!origin) return null;
    const res = await deps.fetch(origin + API_JS, { signal: AbortSignal.any([stop.signal, AbortSignal.timeout(10_000)]) });
    const text = await res.text();
    known = { origin, version: res.ok ? versionOf(text) : '', at: deps.now() };
    return known.version ? known : null;
  }

  async function run(reason: WarmReason, asked: readonly OfficeKind[], docsUrl: () => Promise<unknown>): Promise<void> {
    let kinds = asked;
    if (reason === 'ready') {
      kinds = usedKinds((await load()).paths);
      if (kinds.length === 0) return; // never opened the editor here: nothing is downloaded for it
      hurry = new AbortController();
      await deps.delay(READY_DELAY_MS, AbortSignal.any([stop.signal, hurry.signal]));
    }
    if (kinds.length === 0 || stop.signal.aborted) return;
    const at = await current(docsUrl);
    if (!at) return;
    const { origin, version } = at;
    const s = await load();
    const mine = s.origin === origin;
    const todo = kinds.filter((k) => !mine || s.warmed[k] !== version);
    if (todo.length === 0) return;
    const urls = warmList(origin, version, todo, mine ? s.paths : []);
    const started = deps.now();
    let next = 0;
    let ok = 0;
    let bytes = 0;
    const worker = async (): Promise<void> => {
      while (next < urls.length && !stop.signal.aborted) {
        const url = urls[next++];
        if (url === undefined) return;
        try {
          const r = await deps.fetch(url, { signal: stop.signal });
          // The whole body: an abandoned HTTP/2 stream keeps its window (apiProtocol.ts) and is not cached.
          bytes += (await r.arrayBuffer()).byteLength;
          if (r.ok) ok++;
        } catch {
          // offline or quitting: the next trigger tries again
        }
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    log.info('[office] warmed the editor', { version, kinds: todo, files: `${ok}/${urls.length}`, bytes, ms: deps.now() - started, reason });
    if (ok * 2 < urls.length) return;
    const now: WarmState = state?.origin === origin ? state : { origin, warmed: {}, paths: [] };
    for (const k of todo) now.warmed[k] = version;
    state = now;
    save();
  }

  return {
    /** IPC `office:warm`: runs one after another (each skips what is warm already); the Disk cuts READY's pause short. */
    warm(reason: WarmReason, kinds: readonly OfficeKind[], docsUrl: () => Promise<unknown>): Promise<void> {
      if (reason === 'disk') hurry.abort();
      const next: Promise<void> = (running ?? Promise.resolve())
        .then(() => run(reason, kinds, docsUrl))
        .catch((e: unknown) => {
          log.warn('[office] warming failed', e);
        })
        .finally(() => {
          if (running === next) running = null;
        });
      running = next;
      return next;
    },
    /** A request the editor's frame completed: remembered when it is one of its files. */
    learn(url: string, origin: string): void {
      const p = assetPath(url, origin);
      if (p === null || !state) return;
      if (state.origin !== origin) state = { origin, warmed: {}, paths: [] };
      if (state.paths.includes(p) || state.paths.length >= MAX_PATHS) return;
      state.paths.push(p);
      save();
    },
    /** The editor opened: load the state so its requests can be learned. */
    async prepare(): Promise<void> {
      await load();
    },
    stop(): void {
      stop.abort();
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null;
      if (state) void deps.write(JSON.stringify(state)).catch(() => undefined);
    },
  };
}

type Warmer = ReturnType<typeof createWarmer>;
let warmer: Warmer | null = null;
const learning = new Set<string>();

function officeWarmer(): Warmer {
  if (warmer) return warmer;
  const file = path.join(app.getPath('userData'), 'office-warm.json');
  const w = createWarmer({
    fetch: (url, init) => session.defaultSession.fetch(url, init),
    read: () => fs.readFile(file, 'utf8'),
    write: (s) => fs.writeFile(file, s),
    now: () => Date.now(),
    delay: (ms, signal) =>
      new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        const done = (): void => {
          clearTimeout(t);
          resolve();
        };
        signal.addEventListener('abort', done, { once: true });
      }),
  });
  app.once('before-quit', () => w.stop());
  warmer = w;
  return w;
}

/** IPC `office:warm`. */
export function warmOffice(reason: WarmReason, kinds: readonly OfficeKind[], docsUrl: () => Promise<unknown>): Promise<void> {
  return officeWarmer().warm(reason, kinds, docsUrl);
}

/**
 * The editor's frame was allowed for `origin`: its completed requests are learned from now on (one
 * listener on the default session, no other code uses onCompleted there).
 */
export function learnOfficeFrom(origin: string): void {
  if (!origin || learning.has(origin)) return;
  learning.add(origin);
  const w = officeWarmer();
  void w.prepare();
  const origins = [...learning];
  session.defaultSession.webRequest.onCompleted({ urls: origins.map((o) => `${o}/*`) }, (d) => {
    if (d.method !== 'GET' || d.statusCode !== 200) return;
    for (const o of origins) w.learn(d.url, o);
  });
}
