/**
 * A hand-testing instance of the desktop app against the mock API (tools/dev-mock.sh): the built
 * renderer (out/), the deterministic fixtures, signed in as Анна (owner@calaba.test), onboarding
 * done. A normal window you can click through (unlike the visual harness, the mouse works and the
 * clock runs). Audio muted, fake camera / mic. `--voice`: joins «Переговорка» (needs the dev LiveKit
 * on :7880) and opens the Disk, so the folded island shows the call. Close the window to stop.
 *
 *   npx tsx e2e-support/dev-mock.ts [--voice] [--port 39380] [--theme dark|light]
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from '@playwright/test';
import { startMockServer } from './mock-server';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const port = Number(arg('port') ?? process.env['CALABA_DEV_MOCK_PORT'] ?? 39380);
const theme = arg('theme') === 'light' ? 'light' : 'dark';
const voice = argv.includes('--voice');

const mock = await startMockServer({ port, scenario: 'data' });
const userData = mkdtempSync(join(tmpdir(), 'calaba-dev-mock-'));
const app = await electron.launch({
  args: ['.', '--lang=ru', '--mute-audio'],
  cwd: join(import.meta.dirname, '..'),
  env: {
    ...process.env,
    CALABA_SERVER_URL: mock.url,
    CALABA_USER_DATA: userData,
    CALABA_MULTI_INSTANCE: '1',
    CALABA_FAKE_MEDIA: '1',
    ELECTRON_RENDERER_URL: '',
  },
});
const cleanup = async (): Promise<void> => {
  await mock.close().catch(() => undefined);
  rmSync(userData, { recursive: true, force: true });
};
app.on('close', () => void cleanup().then(() => process.exit(0)));
process.on('SIGINT', () => void app.close().catch(() => process.exit(0)));

const page = await app.firstWindow();
await page.evaluate((th) => {
  localStorage.setItem('calaba-prefs', JSON.stringify({ state: { theme: th, onboarded: true, locale: 'ru' }, version: 1 }));
}, theme);
await page.reload();
await page.getByLabel('Email').fill('owner@calaba.test');
await page.getByLabel('Пароль', { exact: true }).fill('password123');
await page.getByRole('button', { name: 'Войти', exact: true }).click();
await page.locator('aside').first().waitFor({ timeout: 30_000 });
if (voice) {
  await page.getByTestId('section-chats').click();
  await page.locator('aside').getByRole('button', { name: /Переговорка/ }).first().click();
  await page.getByRole('region', { name: 'Переговорка' }).getByRole('button', { name: 'Войти в голос', exact: true }).click();
  await page.getByRole('button', { name: /^Качество связи/ }).waitFor({ timeout: 30_000 });
  await page.getByTestId('section-disk').click();
}
console.log(`dev-mock: signed in as Анна (owner@calaba.test / password123), mock API ${mock.url}${voice ? ', in «Переговорка»' : ''}. Close the window to stop.`);
