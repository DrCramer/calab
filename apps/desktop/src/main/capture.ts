import { desktopCapturer, nativeImage, screen, shell, systemPreferences, webContents, type Session, type WebContents } from 'electron';
import log from 'electron-log/main';
import { resolveScreenDisplays } from '../shared/annot';
import { sameThumb, THUMB_DEFAULT, type ThumbRequest, type ThumbSize } from '../shared/captureThumb';
import type { CaptureSelection, CaptureSource, ScreenAccess } from '../shared/ipc';
import { loopbackDevice, systemAudioSupport as systemAudioSupportFor, type SystemAudioSupport } from './systemAudio';

/**
 * Screen capture with our own picker (docs/02-media.md, "Захват").
 *
 * Flow: renderer lists sources (thumbnails) → user picks → renderer calls
 * `selectSource` (armed per webContents) → renderer calls getDisplayMedia() →
 * our display-media handler hands Chromium the armed source.
 */

/** Picked source per webContents, until its getDisplayMedia() — or ARM_TTL_MS (review L3). */
const armed = new Map<number, { sel: CaptureSelection; at: number }>();
const ARM_TTL_MS = 10_000;
/** webContents whose `destroyed` we already listen to (one listener each, not one per pick). */
const tracked = new Set<number>();

export { MAC_SYSTEM_AUDIO_FEATURES } from './systemAudio';

export function macSystemAudioEnabled(): boolean {
  return process.platform === 'darwin' && process.env['CALABA_MAC_SYSTEM_AUDIO'] !== '0';
}

export function systemAudioSupport(): SystemAudioSupport {
  const osVersion = process.platform === 'darwin' || process.platform === 'win32' ? process.getSystemVersion() : '';
  return systemAudioSupportFor(process.platform, osVersion, process.env);
}

/** CALABA_VISUAL_TEST=1: synthetic sources — no real screens in screenshots, no TCC prompt. */
const VISUAL_TEST = process.env['CALABA_VISUAL_TEST'] === '1';
const FAKE_PREFIX = 'fake:';

/**
 * Sources with thumbnails at the size the picker's cards need (docs/09 #17, shared/captureThumb).
 * Screens and windows may differ (one big screen card vs a grid): then they are fetched apart.
 */
export async function listSources(req: ThumbRequest = { screen: THUMB_DEFAULT, window: THUMB_DEFAULT }): Promise<CaptureSource[]> {
  if (VISUAL_TEST) return fakeSources(req);
  const get = (types: Array<'screen' | 'window'>, thumbnailSize: ThumbSize): Promise<Electron.DesktopCapturerSource[]> =>
    desktopCapturer.getSources({ types, thumbnailSize, fetchWindowIcons: types.includes('window') });
  const sources = sameThumb(req.screen, req.window)
    ? await get(['screen', 'window'], req.screen)
    : (await Promise.all([get(['screen'], req.screen), get(['window'], req.window)])).flat();
  const displayOf = screenDisplays(sources);
  return sources.map((s) => {
    // Typed as always present, but null for screens and windows without an icon.
    const ic = s.appIcon as Electron.NativeImage | null;
    return {
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen:') ? 'screen' : 'window',
      thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
      displayId: displayOf.get(s.id) ?? s.display_id,
      appIcon: ic && !ic.isEmpty() ? ic.resize({ width: 32, height: 32 }).toDataURL() : '',
    };
  });
}

let loggedLayout = '';

/**
 * Screen sources → `screen.getAllDisplays()` ids for the annotation overlay (ADR-0028, issue
 * #102): Windows may hand out an empty or foreign `display_id` (shared/annot
 * `resolveScreenDisplays`). A layout whose ids did not all match is logged once.
 */
function screenDisplays(sources: readonly Electron.DesktopCapturerSource[]): Map<string, string> {
  const screens = sources
    .filter((s) => s.id.startsWith('screen:'))
    .map((s) => {
      const size = s.thumbnail.getSize();
      return { id: s.id, displayId: s.display_id, thumbWidth: size.width, thumbHeight: size.height };
    });
  if (screens.length === 0) return new Map();
  const displays = screen.getAllDisplays();
  const resolved = resolveScreenDisplays(screens, displays);
  const raw = screens.map((s) => `${s.id}=${s.displayId || '∅'}→${resolved.get(s.id) || '∅'}`).join(' ');
  if (screens.some((s) => resolved.get(s.id) !== s.displayId) && raw !== loggedLayout) {
    loggedLayout = raw;
    log.info('[annot] screen sources need display mapping', {
      platform: process.platform,
      sources: raw,
      displays: displays.map((d) => `${d.id} ${d.bounds.x},${d.bounds.y} ${d.bounds.width}x${d.bounds.height} @${d.scaleFactor}`).join('; '),
    });
  }
  return resolved;
}

// ---------------------------------------------------------------- visual-test sources

type Rgb = [number, number, number];

const BASE_W = 480;
const BASE_H = 270;

/**
 * A synthetic thumbnail at the requested size, as a real capture would be: the 480×270 frame's
 * blocks scaled to `size.width` (16:9).
 */
function fakeThumb(size: ThumbSize, bg: Rgb, frame: Array<[number, number, number, number, Rgb]>): string {
  const k = size.width / BASE_W;
  const s = (v: number): number => Math.round(v * k);
  return fakeImage(size.width, s(BASE_H), bg, frame.map(([x, y, w, h, c]): [number, number, number, number, Rgb] => [s(x), s(y), s(w), s(h), c]));
}

/** Flat-colour "screenshot": background, a title strip and a few blocks (BGRA bitmap → PNG). */
function fakeImage(width: number, height: number, bg: Rgb, blocks: Array<[number, number, number, number, Rgb]>): string {
  const buf = Buffer.alloc(width * height * 4);
  const fill = (x0: number, y0: number, w: number, h: number, [r, g, b]: Rgb): void => {
    for (let y = Math.max(0, y0); y < Math.min(height, y0 + h); y++) {
      for (let x = Math.max(0, x0); x < Math.min(width, x0 + w); x++) {
        const i = (y * width + x) * 4;
        buf[i] = b;
        buf[i + 1] = g;
        buf[i + 2] = r;
        buf[i + 3] = 255;
      }
    }
  };
  fill(0, 0, width, height, bg);
  for (const [x, y, w, h, c] of blocks) fill(x, y, w, h, c);
  return nativeImage.createFromBitmap(buf, { width, height }).toDataURL();
}

function fakeSources(req: ThumbRequest): CaptureSource[] {
  const W = 480;
  const H = 270;
  const bar: Rgb = [58, 58, 62];
  const text: Rgb = [210, 210, 216];
  const icon = (c: Rgb): string => fakeImage(32, 32, c, [[8, 8, 16, 16, [255, 255, 255]]]);
  return [
    {
      id: `${FAKE_PREFIX}screen:1`,
      name: 'Экран 1',
      kind: 'screen',
      displayId: '1',
      thumbnail: fakeThumb(req.screen, [28, 60, 110], [[0, 0, W, 10, bar], [40, 40, 180, 120, [44, 44, 48]], [250, 60, 190, 150, [236, 236, 240]], [0, 250, W, 20, bar]]),
    },
    {
      id: `${FAKE_PREFIX}screen:2`,
      name: 'Экран 2',
      kind: 'screen',
      displayId: '2',
      thumbnail: fakeThumb(req.screen, [40, 90, 60], [[0, 0, W, 10, bar], [60, 50, 360, 170, [30, 30, 32]], [80, 80, 200, 12, text], [80, 110, 260, 12, text]]),
    },
    {
      id: `${FAKE_PREFIX}window:1`,
      name: 'main.go — Visual Studio Code',
      kind: 'window',
      displayId: '',
      appIcon: icon([0, 99, 204]),
      thumbnail: fakeThumb(req.window, [30, 30, 32], [[0, 0, W, 22, bar], [0, 22, 60, H - 22, [37, 37, 40]], [80, 44, 220, 10, [94, 173, 255]], [80, 66, 300, 10, text], [100, 88, 240, 10, text], [100, 110, 180, 10, [95, 212, 122]], [80, 132, 260, 10, text]]),
    },
    {
      id: `${FAKE_PREFIX}window:2`,
      name: 'Calab',
      kind: 'window',
      displayId: '',
      appIcon: icon([31, 122, 52]),
      thumbnail: fakeThumb(req.window, [22, 22, 24], [[0, 0, 36, H, [28, 28, 31]], [36, 0, 110, H, [38, 38, 42]], [160, 30, 200, 36, [42, 42, 45]], [240, 90, 220, 36, [43, 82, 120]], [160, 150, 180, 36, [42, 42, 45]], [146, 236, W - 146, 34, [44, 44, 48]]]),
    },
    {
      id: `${FAKE_PREFIX}window:3`,
      name: 'docs/08-design.md — очень длинное название окна браузера для проверки обрезки',
      kind: 'window',
      displayId: '',
      appIcon: icon([179, 64, 11]),
      thumbnail: fakeThumb(req.window, [250, 250, 252], [[0, 0, W, 30, [226, 226, 231]], [60, 60, 300, 16, [29, 29, 31]], [60, 96, 360, 10, [87, 87, 92]], [60, 116, 340, 10, [87, 87, 92]], [60, 136, 200, 10, [0, 102, 204]]]),
    },
  ];
}

export function armSelection(wc: WebContents, sel: CaptureSelection): void {
  const id = wc.id;
  armed.set(id, { sel, at: Date.now() });
  if (!tracked.has(id)) {
    tracked.add(id);
    wc.once('destroyed', () => {
      armed.delete(id);
      tracked.delete(id);
    });
  }
}

export function installDisplayMediaHandler(ses: Session): void {
  ses.setDisplayMediaRequestHandler(
    (request, callback) => {
      const wc = request.frame ? webContents.fromFrame(request.frame) : undefined;
      const entry = wc ? armed.get(wc.id) : undefined;
      if (wc) armed.delete(wc.id);
      // getDisplayMedia() without a fresh pick from our picker: deny. A pick that was never
      // used (the renderer failed before capturing) expires instead of arming a later call.
      if (!wc || !entry || Date.now() - entry.at > ARM_TTL_MS) {
        callback({});
        return;
      }
      const sel = entry.sel;
      if (VISUAL_TEST && sel.sourceId.startsWith(FAKE_PREFIX)) {
        // Synthetic source: capture our own page (deterministic, no screen-recording permission).
        callback(request.frame ? { video: request.frame } : {});
        return;
      }
      void desktopCapturer
        .getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          const source = sources.find((s) => s.id === sel.sourceId);
          if (!source) {
            callback({});
            return;
          }
          const wantAudio = sel.audio && request.audioRequested && systemAudioSupport() !== 'unsupported';
          // Plain 'loopback' (docs/02-media.md rule 4, main/systemAudio.ts): with the renderer's
          // `restrictOwnAudio` Chromium opens `loopbackWithoutChrome` — our own playback (other
          // participants' voices) is excluded and stays audible locally (macOS 14.2+, Windows 11;
          // not Windows 10 — 'experimental'). 'loopbackWithMute' would mute all local playback
          // and ignore `restrictOwnAudio`.
          callback(wantAudio ? { video: source, audio: loopbackDevice(process.platform) } : { video: source });
        })
        .catch(() => callback({}));
    },
    { useSystemPicker: false },
  );
}

const SCREEN_PRIVACY_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

/** One small screen grab: true when it returns real pixels (the process can capture now). */
async function probeCapture(): Promise<boolean> {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 8, height: 8 } });
    return sources.some((s) => !s.thumbnail.isEmpty());
  } catch (err) {
    log.warn('[capture] screen probe failed', err);
    return false;
  }
}

/**
 * Screen Recording state for the onboarding step (docs/09 P0 #3). macOS only; elsewhere capture
 * needs no OS grant. Probes only when the OS says «granted» — a probe without the grant would
 * show the system prompt, which only `requestScreenAccess` may do.
 */
export async function screenAccess(): Promise<ScreenAccess> {
  if (VISUAL_TEST) return { status: 'denied', canCapture: false };
  if (process.platform !== 'darwin') return { status: 'n/a', canCapture: true };
  const status = systemPreferences.getMediaAccessStatus('screen');
  return { status, canCapture: status === 'granted' ? await probeCapture() : false };
}

/**
 * «Запросить доступ и открыть настройки»: macOS lists an app under Privacy → Screen Recording only
 * after its first capture attempt, so opening the pane alone shows a list without Calab. Attempt a
 * capture first (registers the app in TCC; macOS may show its own prompt), then open the pane.
 */
export async function requestScreenAccess(): Promise<ScreenAccess> {
  if (VISUAL_TEST || process.platform !== 'darwin') return screenAccess();
  if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
    await probeCapture();
    await shell.openExternal(SCREEN_PRIVACY_URL).catch((err: unknown) => log.warn('[capture] open privacy pane failed', err));
  }
  return screenAccess();
}
