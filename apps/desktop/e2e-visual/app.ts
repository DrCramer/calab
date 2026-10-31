import { test as base, expect, type Page } from '@playwright/test';
import type { MockServer } from '../e2e-support/mock-server';
import { MOCK_PORT, launch, login, type Env, type Shot, type Theme, type Viewport } from './harness';

/**
 * Per-screen visual tests (screens.spec.ts): one Electron app per worker and configuration
 * (theme × width = a Playwright project), and every test starts from a clean, seeded state:
 *
 *   test('main-chat', async ({ open, win, mock, shot }) => { await open(); … });
 *
 * `open(seed)` resets the mock API (fixtures rebuilt, gateway sessions dropped), wipes the
 * renderer's storage, writes the seeded prefs, reloads and signs in (or out). No test depends
 * on another, so `-g "<screen>"` runs one screen alone and workers run screens in parallel.
 */

export interface Seed {
  /** Signed in (default) or on the login screen. */
  auth?: 'in' | 'out';
  /** false → the first-run onboarding (default true). */
  onboarded?: boolean;
  scenario?: 'data' | 'empty';
  /** Extra prefs (stores/prefs.ts) merged into the seed. */
  prefs?: Record<string, unknown>;
  /** Persisted UI state (stores/ui.ts), e.g. { activeWorkspaceId: '@me' } to start in «Личные». */
  ui?: Record<string, unknown>;
  /** The office editor on in the mock (ADR-0143; off by default, the capabilities are read at READY). */
  office?: boolean;
}

interface WorkerFx {
  theme: Theme;
  /** Window content size (not Playwright's `viewport`: the Electron window is sized by the harness). */
  size: Viewport;
  env: Env;
}

/** The per-project options (playwright.visual.config.ts). */
export interface VisualOptions {
  theme: Theme;
  size: Viewport;
}

interface TestFx {
  /** The app window (Electron page). */
  win: Page;
  mock: MockServer;
  shot: Shot;
  open: (seed?: Seed) => Promise<void>;
}

export const test = base.extend<TestFx, WorkerFx>({
  theme: ['dark', { scope: 'worker', option: true }],
  size: [{ width: 1440, height: 800 }, { scope: 'worker', option: true }],
  env: [
    async ({ theme, size }, use, info) => {
      // Parallel workers share one dev LiveKit: each gets its own mock port and room names.
      // parallelIndex is 0…workers-1 and stable across worker restarts; MOCK_PORT itself stays
      // free for focus.spec (it launches its own app).
      const prefix = process.env['MOCK_LIVEKIT_ROOM_PREFIX'] || 'mock_';
      process.env['MOCK_LIVEKIT_ROOM_PREFIX'] = `${prefix}w${info.parallelIndex}_`;
      const env = await launch({ theme, viewport: size, onboarded: true, port: MOCK_PORT + 1 + info.parallelIndex });
      await login(env.page);
      await expect(env.page.locator('aside').first()).toBeVisible({ timeout: 30_000 });
      await use(env);
      await env.close();
    },
    { scope: 'worker', timeout: 120_000 },
  ],
  win: async ({ env }, use) => {
    await use(env.page);
  },
  mock: async ({ env }, use) => {
    await use(env.mock);
  },
  shot: async ({ env, theme, size }, use) => {
    await use({ page: env.page, theme, viewport: size });
  },
  open: async ({ env, theme }, use, info) => {
    await use((seed) => reset(env, theme, seed ?? {}));
    // Electron pages are not covered by Playwright's `screenshot` option.
    if (info.status !== info.expectedStatus) {
      await info.attach('failure', { body: await env.page.screenshot().catch(() => Buffer.alloc(0)), contentType: 'image/png' });
    }
  },
});

export { expect };

async function reset(env: Env, theme: Theme, seed: Seed): Promise<void> {
  const { page, mock } = env;
  if (seed.auth === 'out') {
    // Visual-test hook (app/App.tsx): sign out without relaunching.
    await page.evaluate(() => (window as unknown as { __calabaLogout?: () => Promise<void> }).__calabaLogout?.()).catch(() => undefined);
  }
  mock.reset(seed.scenario ?? 'data');
  if (seed.office) mock.setOffice(true);
  // Storage wiped and seeded in one step right before the reload: nothing of the previous test
  // (remembered rooms, stage layouts, chat views, camera checks…) survives.
  await page.evaluate(
    ({ theme, onboarded, prefs, ui }) => {
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem('calaba-prefs', JSON.stringify({ state: { theme, onboarded, locale: 'ru', ...prefs }, version: 1 }));
      if (ui) localStorage.setItem('calaba-ui', JSON.stringify({ state: ui, version: 1 }));
    },
    { theme, onboarded: seed.onboarded ?? true, prefs: seed.prefs ?? {}, ui: seed.ui ?? null },
  );
  await page.reload();
  const signIn = page.getByRole('button', { name: 'Войти', exact: true });
  const ready = page.locator('aside').first().or(page.locator('[data-testid^="onboarding-"]')).or(page.getByRole('button', { name: 'Создать пространство' }));
  await expect(signIn.or(ready).first()).toBeVisible({ timeout: 30_000 });
  if (seed.auth === 'out') {
    await expect(signIn).toBeVisible();
    return;
  }
  if (await signIn.isVisible()) await login(page);
  await expect(ready.first()).toBeVisible({ timeout: 30_000 });
}
