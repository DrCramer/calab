import { expect, test } from './app';
import { checkpoint } from './harness';

/**
 * «Настройки пространства → Телефония» — the exchange (ADR-0117 step 1, docs/08 «Телефония»):
 * «Внутренние номера» (104 unassigned), «Группы» («Поддержка» with a deleted fallback),
 * «Автоответ» (a menu with a recording and keys, key 9 leading to a deleted menu), the inline forms
 * of a number, a group and a menu. Fixture: mock-server seedSipExchange. Projects
 * `telephony-dark-960` (all) and `telephony-light-960` (the menu form only); run with -g:
 *
 *   CALABA_VISUAL_MOCK_PORT=4513 MOCK_LIVEKIT_ROOM_PREFIX=tel_ \
 *     pnpm -F @calaba/desktop e2e:visual -g "telephony-"
 */

const DARK = (theme: string): boolean => theme === 'dark';

async function openTelephony(win: import('@playwright/test').Page): Promise<import('@playwright/test').Locator> {
  await win.getByTestId('titlebar-title').click();
  await win.getByRole('menuitem', { name: 'Настройки', exact: true }).click();
  const dialog = win.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Телефония' }).click();
  await expect(dialog.getByTestId('sip-exchange')).toBeVisible();
  return dialog;
}

test('telephony-exchange', async ({ open, win, mock, shot, theme }) => {
  test.skip(!DARK(theme), 'dark only');
  await open();
  mock.seedSipExchange();
  const dialog = await openTelephony(win);
  await expect(dialog.getByTestId('sip-ext-row')).toHaveCount(5);
  await expect(dialog.getByTestId('sip-group-row')).toHaveCount(2);
  await expect(dialog.getByTestId('sip-menu-row')).toHaveCount(2);
  await dialog.getByTestId('sip-ext-list').scrollIntoViewIfNeeded();
  await checkpoint(shot, 'telephony-numbers');
  await dialog.getByTestId('sip-menu-list').scrollIntoViewIfNeeded();
  await checkpoint(shot, 'telephony-groups-menus');

  // A new number: the member picker without guests and members who have one.
  await dialog.getByTestId('sip-ext-add').click();
  await dialog.getByTestId('sip-ext-number').fill('105');
  await dialog.getByTestId('sip-ext-member').click();
  await expect(win.getByTestId('sip-ext-picker')).toBeVisible();
  await checkpoint(shot, 'telephony-number-picker');
  await win.keyboard.press('Escape');
  await dialog.getByTestId('sip-ext-number').fill('101');
  await dialog.getByTestId('sip-ext-description').fill('Касса');
  // A taken number: the server's 409 under the field (the picker is closed, the member unset → pick one).
  await dialog.getByTestId('sip-ext-member').click();
  await win.getByTestId('sip-ext-picker').getByRole('option').first().click();
  await dialog.getByTestId('sip-ext-save').click();
  await expect(dialog.getByTestId('sip-ext-error')).toHaveText('Этот номер уже занят');
  await checkpoint(shot, 'telephony-number-form');
  await dialog.getByRole('button', { name: 'Отмена' }).click();

  // A group: order, strategy, «если никто не ответил» with a deleted target.
  await dialog.getByTestId('sip-group-row').filter({ hasText: 'Поддержка' }).getByRole('button', { name: 'Изменить' }).click();
  const group = dialog.getByTestId('sip-group-form');
  await expect(group.getByTestId('sip-target-missing')).toBeVisible();
  await group.getByTestId('sip-group-add-member').selectOption({ label: '102 · Вера Ким' });
  await group.scrollIntoViewIfNeeded();
  await checkpoint(shot, 'telephony-group-form');
  await group.getByRole('button', { name: 'Отмена' }).click();
});

test('telephony-menu', async ({ open, win, mock, shot }) => {
  await open();
  mock.seedSipExchange();
  const dialog = await openTelephony(win);
  await dialog.getByTestId('sip-menu-row').filter({ hasText: 'Главное меню' }).getByRole('button', { name: 'Изменить' }).click();
  const form = dialog.getByTestId('sip-menu-form');
  await expect(form.getByTestId('sip-menu-listen')).toBeVisible();
  await expect(form.getByTestId('sip-menu-key-9')).toHaveValue('missing');
  await form.getByTestId('sip-menu-keys').scrollIntoViewIfNeeded();
  await checkpoint(shot, 'telephony-menu-form');
});
