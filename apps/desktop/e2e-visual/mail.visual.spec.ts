import { expect, test } from './app';
import { checkpoint, joinVoice } from './harness';

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

  // #231 «Прочитать все»: the header button over «Все входящие» (unread mail), the folder context
  // menu, then the counters and the unread dots are gone.
  const markAll = win.getByTestId('mail-mark-all-read');
  await expect(markAll).toBeVisible();
  await expect(win.locator('[data-testid="mail-row"][data-unread]').first()).toBeVisible();
  await checkpoint(shot, 'mail-mark-all-header');
  await sidebar.getByTestId('mail-sidebar-account').first().getByTestId('mail-sidebar-row').first().click({ button: 'right' });
  await expect(win.getByTestId('mail-menu-mark-all-read')).toBeVisible();
  await checkpoint(shot, 'mail-mark-all-menu');
  await win.keyboard.press('Escape');
  await markAll.click();
  const confirm = win.getByRole('alertdialog');
  if (await confirm.isVisible().catch(() => false)) {
    await checkpoint(shot, 'mail-mark-all-confirm');
    await confirm.getByRole('button').last().click();
  }
  await expect(markAll).toHaveCount(0);
  await expect(win.locator('[data-testid="mail-row"][data-unread]')).toHaveCount(0);
  await checkpoint(shot, 'mail-mark-all-after');

  // #94: search by an address / name, Outlook-like: To / Cc count, ё = е, every folder of the account
  // is searched and each row says which one it lives in.
  await win.getByTestId('mail-search').fill('d.volkov@');
  const hits = win.getByTestId('mail-row');
  await expect(win.getByTestId('mail-row-folder').first()).toBeVisible();
  expect(await hits.count()).toBeGreaterThan(1);
  await checkpoint(shot, 'mail-search-address');
  await win.getByTestId('mail-search').fill('Волков');
  await expect(hits.first()).toBeVisible();
  await win.getByTestId('mail-search').fill('');

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
  // The toast stays clear of the list and the sidebar (anchored to the reading pane), then goes away.
  await expect(win.getByRole('region', { name: 'Уведомления' })).toContainText('Папка «Клиенты» создана');
  await checkpoint(shot, 'mail-toast');
  // Close every toast (the «mark all read» one may still be there): they lie over the dialog's buttons.
  const closeToast = win.getByRole('button', { name: 'Закрыть уведомление' });
  for (let i = 0; i < 5 && (await closeToast.first().isVisible().catch(() => false)); i++) await closeToast.first().click().catch(() => undefined); // they may go on their own

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
  await win.keyboard.press('Escape');

  // ADR-0146: in a call the island is folded into my avatar on the rail (with the call mark);
  // the mail columns reserve nothing for it — no fade, no spacer, the lists run to the bottom.
  await joinVoice(win);
  await win.getByTestId('section-mail').click();
  await expect(win.getByTestId('mail-sidebar')).toBeVisible();
  await expect(win.getByTestId('mail-island-spacer')).toHaveCSS('height', '0px');
  await expect(win.getByTestId('island-call-mark')).toBeVisible();
  await checkpoint(shot, 'mail-voice');
  // Hover: the full island over the mailbox sidebar.
  await win.getByTestId('island-avatar').hover();
  await expect(win.getByTestId('bottom-island')).toContainText('Голос подключён');
  await checkpoint(shot, 'mail-voice-open', { keepPointer: true });
  await win.mouse.move(600, 300);
  await expect(win.getByTestId('bottom-island')).toBeHidden();

  // Sidebar hidden: the list runs to the window's bottom, still no spacer.
  await win.getByTestId('mail-sidebar-hide').click();
  await expect(win.getByTestId('mail-sidebar')).toHaveCount(0);
  await expect(win.getByTestId('mail-island-spacer')).toHaveCSS('height', '0px');
  await win.getByTestId('mail-list').evaluate((el) => {
    const scroller = el.matches('[data-virtuoso-scroller]') ? el : (el.querySelector('[data-virtuoso-scroller]') ?? el);
    scroller.scrollTop = scroller.scrollHeight;
  });
  await checkpoint(shot, 'mail-voice-list');
  await win.getByTestId('mail-sidebar-show').click();
});