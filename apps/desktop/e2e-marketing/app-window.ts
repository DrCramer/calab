import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { NOW, PASSWORD } from '../e2e-visual/harness';

/**
 * The landing's window scenes as real macOS windows: the built app (`out/`, `pnpm build:app`) against the
 * marketing mock, captured by the OS (`screencapture -l <CGWindowID>`), so the frame carries the native
 * title bar — traffic lights, the window's rounded corners — and the real `sidebar` vibrancy (ADR-0075;
 * CALABA_VISUAL_VIBRANCY=1 keeps it in a test run). A page screenshot never includes the window chrome.
 *
 * The window is placed on screen (vibrancy samples what is behind it) and made key (active traffic lights);
 * a window taller than the display extends past its bottom edge (CALABA_VISUAL_TEST lets it grow, see
 * src/main/windows.ts) — WindowServer still renders and captures all of it. macOS only; the capture
 * needs the Screen Recording permission for the terminal running Playwright.
 */
export const APP_WINDOW = process.platform === 'darwin' && process.env['CALABA_LANDING_WEB'] !== '1';

const ROOT = resolve(import.meta.dirname, '..');

export interface AppWindow {
  app: ElectronApplication;
  page: Page;
  close(): Promise<void>;
}

/**
 * The app signed in as the landing's «Анна» (owner@calaba.test), dark, the persisted UI state `ui` (column width,
 * members' panel), as the web boots of landing-v5/v6 do.
 */
export async function launchAppWindow(serverUrl: string, size: { width: number; height: number }, ui?: Record<string, unknown>): Promise<AppWindow> {
  const userData = mkdtempSync(join(tmpdir(), 'calaba-landing-'));
  const app = await electron.launch({
    args: ['.', '--lang=ru', '--mute-audio'],
    cwd: ROOT,
    env: {
      ...process.env,
      CALABA_SERVER_URL: serverUrl,
      CALABA_USER_DATA: userData,
      CALABA_MULTI_INSTANCE: '1',
      CALABA_FAKE_MEDIA: '1',
      CALABA_VISUAL_TEST: '1',
      CALABA_VISUAL_VIBRANCY: '1',
      ELECTRON_RENDERER_URL: '',
      TZ: 'Europe/Moscow',
      LANG: 'ru_RU.UTF-8',
    },
  });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow, screen }, v) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (!w) return;
    w.setContentSize(v.width, v.height);
    const wa = screen.getPrimaryDisplay().workArea;
    w.setPosition(wa.x + Math.max(0, Math.round((wa.width - v.width) / 2)), wa.y);
    // Only Playwright's (CDP) input reaches the page: the real cursor over the window hovers nothing.
    w.setIgnoreMouseEvents(true);
  }, size);
  await page.clock.setFixedTime(NOW);
  await page.evaluate((u) => {
    localStorage.setItem('calaba-prefs', JSON.stringify({ state: { theme: 'dark', onboarded: true, locale: 'ru' }, version: 1 }));
    if (u) localStorage.setItem('calaba-ui', JSON.stringify({ state: u, version: 1 }));
  }, ui ?? null);
  await page.reload();
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(size.width);
  await page.getByLabel('Email').fill('owner@calaba.test');
  await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.locator('aside').first()).toBeVisible({ timeout: 30_000 });
  return {
    app,
    page,
    async close() {
      await app.close().catch(() => undefined);
      rmSync(userData, { recursive: true, force: true });
    },
  };
}

/** The OS capture of the window (no drop shadow: the crops are in window coordinates), 2x on a Retina display. */
export async function captureAppWindow(app: ElectronApplication, path: string): Promise<void> {
  const id = await app.evaluate(({ app: a, BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (!w) return '';
    a.focus({ steal: true });
    w.show();
    w.focus();
    return w.getMediaSourceId();
  });
  const cg = id.split(':')[1];
  if (!cg) throw new Error(`no window id (${id})`);
  // Key-window state (coloured traffic lights, the active vibrancy) settles within a frame or two.
  await new Promise((r) => setTimeout(r, 400));
  execFileSync('screencapture', ['-x', '-o', '-t', 'png', '-l', cg, path]);
}

/** The window's content size (CSS px), kept on screen from the work area's top. */
export async function resizeAppWindow(win: AppWindow, size: { width: number; height: number }): Promise<void> {
  await win.app.evaluate(({ BrowserWindow, screen }, v) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (!w) return;
    w.setContentSize(v.width, v.height);
    const wa = screen.getPrimaryDisplay().workArea;
    w.setPosition(wa.x + Math.max(0, Math.round((wa.width - v.width) / 2)), wa.y);
  }, size);
  await expect.poll(() => win.page.evaluate(() => `${innerWidth}x${innerHeight}`)).toBe(`${size.width}x${size.height}`);
}
