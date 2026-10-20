import { expect, test, type Page } from '@playwright/test';

/**
 * Web address bar for boards (3.8.0): an open board is `/b/<id>`, an open task `/t/<KEY-N>`, the
 * rest `/`; a reload opens the same place; wiki and meeting addresses are never rewritten.
 * Needs an account that may create boards in «E2E web» (CALABA_WEB_LOGIN / CALABA_WEB_PASSWORD,
 * the e2e-app account on app.calab.io). Creates the board «E2E адрес» and deletes it at the end.
 */
const BOARD = 'E2E адрес';
const KEY = 'EADR';

async function signIn(page: Page, path = '/'): Promise<void> {
  await page.goto(path);
  await page.getByLabel('Email').fill(process.env['CALABA_WEB_LOGIN'] ?? '');
  await page.getByLabel('Пароль', { exact: true }).fill(process.env['CALABA_WEB_PASSWORD'] ?? '');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  const skip = page.getByRole('button', { name: 'Пропустить настройку' });
  await expect(skip.or(page.getByRole('navigation', { name: 'Разделы' }))).toBeVisible({ timeout: 20_000 });
  if (await skip.isVisible()) await skip.click();
}

test('address bar: /b/<id>, /t/<KEY-N>, reload keeps it, wiki and meeting links untouched', async ({ page }) => {
  test.skip(!process.env['CALABA_WEB_LOGIN'], 'needs CALABA_WEB_LOGIN / CALABA_WEB_PASSWORD');
  test.setTimeout(150_000);
  await signIn(page);
  await page.getByTestId('titlebar-title').click();
  await page.getByRole('menuitem', { name: /^E2E web\b/ }).first().click();
  await expect(page.getByTestId('titlebar-title')).toContainText('E2E web');
  await page.getByTestId('section-boards').click();
  await expect(page.getByTestId('boards-list')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/');

  // A board of its own (a leftover of a failed run is reused).
  const row = page.getByTestId('board-row').filter({ hasText: BOARD });
  if (!(await row.first().isVisible().catch(() => false))) {
    const empty = page.getByTestId('boards-empty');
    if (await empty.isVisible()) await empty.click();
    else await page.getByRole('button', { name: 'Новая доска' }).first().click();
    await page.getByTestId('create-board-name').fill(BOARD);
    await page.getByTestId('create-board-key').fill(KEY);
    await page.getByTestId('create-board-submit').click();
  }
  await row.first().click();
  await expect(page).toHaveURL(/\/b\/[^/]+$/);
  const boardPath = new URL(page.url()).pathname;

  try {
    // A task: the address follows the panel.
    await page.keyboard.press('c');
    await page.getByTestId('create-task-title').fill('Адресная строка');
    await page.getByTestId('create-task-submit').click();
    const card = page.getByTestId('task-card').filter({ hasText: 'Адресная строка' }).first();
    await card.getByTestId('card-title').click();
    await expect(page.getByTestId('task-panel')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/t/${KEY}-\\d+$`));
    const taskPath = new URL(page.url()).pathname;

    // Reload: the same task opens again, the address stays.
    await page.reload();
    await expect(page.getByTestId('task-panel').getByTestId('task-title')).toHaveValue('Адресная строка', { timeout: 30_000 });
    expect(new URL(page.url()).pathname).toBe(taskPath);

    // Closing the task → the board; another section → `/`.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('task-panel')).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`${boardPath}$`));
    await page.reload();
    await expect(page.getByTestId('kanban')).toBeVisible({ timeout: 30_000 });
    expect(new URL(page.url()).pathname).toBe(boardPath);
    await page.getByTestId('section-chats').click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/');

    // Wiki and meeting addresses are never rewritten (whatever the page shows for unknown ids).
    for (const p of ['/wiki/qa-address-check', '/r/qa-address-check']) {
      await page.goto(p);
      await page.waitForTimeout(4_000);
      expect(new URL(page.url()).pathname, p).toBe(p);
    }
  } finally {
    // Clean up: delete the board for good.
    await page.goto(boardPath);
    await expect(page.getByTestId('kanban')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('board-more').click();
    await page.getByTestId('board-settings').click();
    await page.getByRole('button', { name: 'Архив и удаление' }).or(page.getByRole('tab', { name: 'Архив и удаление' })).first().click();
    await page.getByTestId('board-delete').click();
    await page.getByTestId('board-delete-key').fill(KEY);
    await page.getByTestId('board-delete-confirm').click();
    await expect(page.getByTestId('board-row').filter({ hasText: BOARD })).toHaveCount(0);
  }
});
