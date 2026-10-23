import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import type { AppSettings } from '../shared/ipc';
import { DEFAULT_UPDATE_CHANNEL, parseUpdateChannel } from '../shared/updateFeed';

/**
 * Device-level app settings (userData/settings.json). Configuration comes from
 * env / build-time env only — no hosts are hard-coded (CLAUDE.md):
 * CALABA_SERVER_URL at runtime, MAIN_VITE_DEFAULT_SERVER_URL at build time.
 */
function defaultServerUrl(): string {
  const url = process.env['CALABA_SERVER_URL'] ?? import.meta.env.MAIN_VITE_DEFAULT_SERVER_URL ?? '';
  return normalizeServerUrl(url);
}

export function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

const DEFAULTS = (): AppSettings => ({
  serverUrl: defaultServerUrl(),
  updateUrl: process.env['CALABA_UPDATE_URL'] ?? import.meta.env.MAIN_VITE_UPDATE_FEED ?? '',
  autostart: true,
  autoUpdate: true,
  autoCheckUpdates: true,
  // Installs from before 3.1.3 have no key: they get GitHub too (owner 12.10).
  updateChannel: DEFAULT_UPDATE_CHANNEL,
  closeToTray: true,
  trayHintShown: true,
});

let cache: AppSettings | null = null;

function file(): string {
  return join(app.getPath('userData'), 'settings.json');
}

export function getSettings(): AppSettings {
  if (cache) return cache;
  const settingsFile = file();
  const firstRun = !existsSync(settingsFile);
  let stored: Partial<AppSettings> = {};
  try {
    stored = JSON.parse(readFileSync(settingsFile, 'utf8')) as Partial<AppSettings>;
  } catch {
    // first run or corrupt file → defaults
  }
  cache = { ...DEFAULTS(), ...stored };
  // Retired setting (ADR-0075: vibrancy is always on): drop it from old files.
  delete (cache as unknown as Record<string, unknown>)['windowTranslucency'];
  // A hand-edited / unknown value → the default (never a URL: the sources are pinned at build time).
  cache.updateChannel = parseUpdateChannel(cache.updateChannel);
  // Explicit env wins over a stored value (tests, staging builds).
  if (process.env['CALABA_SERVER_URL']) cache.serverUrl = defaultServerUrl();
  if (firstRun) {
    persist(cache);
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: cache.autostart });
  }
  return cache;
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const next: AppSettings = { ...getSettings(), ...patch };
  next.serverUrl = normalizeServerUrl(next.serverUrl);
  cache = next;
  persist(next);
  if (patch.autostart !== undefined && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: next.autostart });
  }
  return next;
}

function persist(settings: AppSettings): void {
  const f = file();
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(`${f}.tmp`, JSON.stringify(settings, null, 2));
  renameSync(`${f}.tmp`, f);
}
