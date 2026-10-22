import { expect, test } from './app';
import { checkpoint } from './harness';

/**
 * «Почта» folders (CBF-56, docs/08 «Почтовый клиент»): the mailbox sidebar (two accounts of the mail
 * mock, their folder trees, «Умные папки»), the grouped switcher, the folder dialog (a new folder,
 * a smart folder with conditions), Settings → «Почта» with the stacked folder / rule rows. Needs the
 * renderer built on the in-memory mail mock (ADR-0088 §7), project `mail-dark-960`:
 *
 *   CALABA_VISUAL_MOCK_PORT=4413 MOCK_LIVEKIT_ROOM_PREFIX=mail_ pnpm -F @calaba/desktop e2e:visual:mail
 */

test('mail-folders', async ({ open, win, shot }) => {
  await open();
  await win.getByTestId('section-mail').click();
  const sidebar = win.getByTestId('mail-sidebar');
  await expect(sidebar, 'the mail mock is off: build with CALABA_MAIL_MOCK=1 (pnpm e2e:visual:mail)').toBeVisible({ timeout: 15_000 });
  await expect(win.getByTestId('mail-sync')).toBeVisible({ timeout: 15_000 });
  await expect(sidebar.getByTestId('mail-sidebar-account')).toHaveCount(2);
  await checkpoint(shot, 'mail-sidebar');

  // The switcher: unified boxes, then one submenu per account (no flat list of every folder).
  await win.getByTestId('mail-box-switcher').click();
  await expect(win.getByTestId('mail-box-account')).toHaveCount(2);
  await win.getByTestId('mail-box-account').last().hover();
  await expect(win.getByRole('menu').nth(1)).toBeVisible();
  await checkpoint(shot, 'mail-switcher');
  await win.keyboard.press('Escape');
  await win.keyboard.press('Escape');

  // Right click on an account: «Новая папка…» → the dialog.
  const work = sidebar.getByTestId('mail-sidebar-account').last();
  await work.getByRole('button', { expanded: true }).first().click({ button: 'right' });
  await win.getByTestId('mail-menu-new-folder').click();
  const dialog = win.getByTestId('mail-folder-dialog');
  await expect(dialog).toBeVisible();
  await win.getByTestId('mail-folder-name').fill('Клиенты');
  await checkpoint(shot, 'mail-folder-dialog');
  await win.getByTestId('mail-folder-dialog-submit').click();
  await expect(dialog).toHaveCount(0);
  await expect(work.getByTestId('mail-sidebar-row').filter({ hasText: 'Клиенты' })).toBeVisible();

  // A smart folder: two conditions, «любое условие».
  await sidebar.getByTestId('mail-sidebar-new-smart').click();
  await win.getByTestId('mail-folder-name').fill('Счета и банк');
  const conds = win.getByTestId('mail-smart-conditions').locator('li');
  await conds.first().getByRole('combobox').selectOption('subject');
  await conds.first().getByRole('textbox').fill('счёт');
  await win.getByTestId('mail-smart-add-condition').click();
  await conds.nth(1).getByRole('textbox').fill('bank');
  await win.getByRole('radio', { name: 'Любое условие' }).click();
  await checkpoint(shot, 'mail-smart-dialog');
  await win.getByTestId('mail-folder-dialog-submit').click();
  await expect(win.getByTestId('mail-folder-dialog')).toHaveCount(0);
  await expect(win.getByTestId('mail-box-switcher')).toContainText('Счета и банк');
  await expect(win.getByTestId('mail-row').first()).toBeVisible();
  await checkpoint(shot, 'mail-smart-list');

  // Settings → «Почта»: the folder and rule rows stack (title, controls, hint under them).
  await win.getByRole('button', { name: 'Настройки', exact: true }).click();
  const settings = win.getByRole('dialog');
  await settings.getByRole('tab', { name: 'Почта' }).click();
  const rule = settings.getByTestId('settings-stack-row').filter({ hasText: 'Новое правило сортировки' }).first();
  await rule.scrollIntoViewIfNeeded();
  await expect(rule).toBeVisible();
  await checkpoint(shot, 'mail-settings-rules');
});
