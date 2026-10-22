import { IDS } from '../e2e-support/mock-server';
import { expect, test } from './app';
import { checkpoint, settle } from './harness';

/**
 * «Настройки пространства → Телефония» — the exchange (ADR-0117 step 1, docs/08 «Телефония»):
 * «Внутренние номера» (103 unassigned), «Группы» («Поддержка» with a deleted fallback),
 * «Автоответ» (a menu with a recording and keys, key 9 leading to a deleted menu), the inline forms
 * of a number, a group and a menu, «Входящие» over a registration at the provider (ADR-0121:
 * registered / a refused password). Fixture: mock-server seedSipExchange. And the incoming phone
 * call (ADR-0117 step 2): the sheet with the caller's number and the menu it came through; a
 * group's fallback off / on (ADR-0124); an exchange from scratch (empty cards, a new menu that stays
 * open for its greeting: refused files, the conversion). Projects `telephony-dark-960` (all) and
 * `telephony-light-960` (telephony-menu and the incoming call); run with -g:
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
  mock.setSipRegistration('registered');
  const dialog = await openTelephony(win);
  await expect(dialog.getByTestId('sip-ext-row')).toHaveCount(4);
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
  // A taken number: the server's 409 under the field (Григорий is the one member without a number).
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

  // ADR-0121: inbound calls over a registration at the provider — the mode, the state line
  // (registered until …, the masked contact) with the registrar fields open; then the provider
  // refuses the password: saving re-reads the settings and the line turns into the error.
  const inbound = dialog.getByTestId('sip-inbound');
  await expect(dialog.getByTestId('sip-reg-status')).toHaveText('Зарегистрировано до 13:39 · контакт sip:c…@141.105.69.177:5080');
  await expect(dialog.getByTestId('sip-inbound-mode').getByRole('radio', { name: 'По регистрации' })).toHaveAttribute('aria-checked', 'true');
  await dialog.getByTestId('sip-reg-advanced').click();
  await inbound.scrollIntoViewIfNeeded();
  await checkpoint(shot, 'telephony-inbound-register');
  mock.setSipRegistration('failed');
  await dialog.getByTestId('sip-inbound-save').click();
  await expect(dialog.getByTestId('sip-reg-status')).toHaveText('Ошибка регистрации: провайдер не принял логин или пароль');
  await inbound.scrollIntoViewIfNeeded();
  await checkpoint(shot, 'telephony-inbound-register-failed');
});

test('telephony-menu', async ({ open, win, mock, shot }) => {
  // An exchange set up from scratch: empty cards; a group has nobody to add until people get numbers.
  await open();
  mock.seedSipExchange(true);
  let dialog = await openTelephony(win);
  await expect(dialog.getByTestId('sip-ext-empty')).toBeVisible();
  await expect(dialog.getByTestId('sip-menu-empty')).toBeVisible();
  await dialog.getByTestId('sip-group-add').click();
  await expect(dialog.getByTestId('sip-group-form')).toContainText('сначала дайте сотрудникам или ботам номера');
  await dialog.getByTestId('sip-menu-list').scrollIntoViewIfNeeded();
  await checkpoint(shot, 'telephony-empty');
  await dialog.getByTestId('sip-group-form').getByRole('button', { name: 'Отмена' }).click();

  // A new menu stays open after «Сохранить» — the greeting is uploaded right there: a wrong
  // format and a file over 10 MB are refused at once, the server's refusal under the row, the
  // conversion shows «Обрабатываем запись…», then the length and ▶.
  await dialog.getByTestId('sip-menu-add').click();
  let menu = dialog.getByTestId('sip-menu-form');
  await menu.getByTestId('sip-menu-name').fill('Приветствие');
  await menu.getByTestId('sip-menu-save').click();
  menu = dialog.getByTestId('sip-menu-form');
  await expect(menu.getByTestId('sip-menu-upload')).toHaveText('Загрузить запись');
  await expect(menu).toContainText('Пока записи нет, меню не звучит');
  // «Сохранено» sits over the form's foot (outside the modal): close it by a DOM click.
  await win.getByTestId('toast').locator('button[aria-label="Закрыть уведомление"]').evaluate((b) => (b as HTMLButtonElement).click());
  await expect(win.getByTestId('toast')).toHaveCount(0);
  const file = menu.getByTestId('sip-menu-prompt-file');
  const prompt = menu.getByTestId('sip-menu-prompt-error');
  await file.setInputFiles({ name: 'big.wav', mimeType: 'audio/wav', buffer: Buffer.alloc(10 * 1024 * 1024 + 1) });
  await expect(prompt).toHaveText('Файл больше 10 МБ — сожмите или укоротите запись');
  await file.setInputFiles({ name: 'notes.mp3', mimeType: 'text/plain', buffer: Buffer.from('not audio') });
  await expect(prompt).toHaveText('Нужен свой файл MP3, WAV или OGG до 10 МБ и до 3 минут');
  await file.setInputFiles({ name: 'greeting.docx', mimeType: 'application/msword', buffer: Buffer.from('doc') });
  await expect(prompt).toHaveText('Этот файл не подходит — нужен MP3, WAV или OGG');
  await menu.scrollIntoViewIfNeeded();
  await checkpoint(shot, 'telephony-prompt-error');
  const release = mock.holdSipPrompt();
  await file.setInputFiles({ name: 'greeting.mp3', mimeType: 'audio/mpeg', buffer: Buffer.alloc(4096, 1) });
  await expect(menu.getByTestId('sip-menu-prompt')).toContainText('Обрабатываем запись…');
  await expect(prompt).toHaveCount(0);
  await checkpoint(shot, 'telephony-prompt-processing');
  release();
  await expect(menu.getByTestId('sip-menu-listen')).toBeVisible();
  await expect(menu.getByTestId('sip-menu-prompt')).toContainText('0:42');
  await expect(menu.getByTestId('sip-menu-upload')).toHaveText('Заменить');

  await open();
  mock.seedSipExchange();
  dialog = await openTelephony(win);
  await expect(dialog.getByTestId('sip-group-row').filter({ hasText: 'Отдел продаж' })).toContainText('переадресация через 45 с');

  // ADR-0124: a new group rings until somebody answers (the fallback off); switched on — after
  // N seconds the call goes to another group / a person / a bot / a menu / hangs up.
  await dialog.getByTestId('sip-group-add').click();
  const group = dialog.getByTestId('sip-group-form');
  await group.getByTestId('sip-group-name').fill('Бухгалтерия');
  await group.getByTestId('sip-group-number').fill('1003');
  await group.getByTestId('sip-group-add-member').selectOption({ label: '102 · Вера Ким' });
  const fallback = group.getByTestId('sip-group-fallback');
  await expect(fallback).toContainText('пока кто-нибудь не ответит');
  await expect(group.getByTestId('sip-group-onfail')).toHaveCount(0);
  await fallback.scrollIntoViewIfNeeded();
  await checkpoint(shot, 'telephony-group-fallback-off');
  await fallback.getByRole('switch', { name: 'Переадресация, если никто не ответил' }).click();
  await group.getByTestId('sip-group-fallback-sec').fill('20');
  await group.getByTestId('sip-group-onfail').selectOption({ label: '1001 · Отдел продаж' });
  await fallback.scrollIntoViewIfNeeded();
  await checkpoint(shot, 'telephony-group-fallback');
  await group.getByRole('button', { name: 'Отмена' }).click();

  await dialog.getByTestId('sip-menu-row').filter({ hasText: 'Главное меню' }).getByRole('button', { name: 'Изменить' }).click();
  const form = dialog.getByTestId('sip-menu-form');
  await expect(form.getByTestId('sip-menu-listen')).toBeVisible();
  await expect(form.getByTestId('sip-menu-key-9')).toHaveValue('missing');
  await form.getByTestId('sip-menu-keys').scrollIntoViewIfNeeded();
  await checkpoint(shot, 'telephony-menu-form');
});

// ADR-0117 step 2: an inbound call rings me — the number, «Входящий на номер · <группа>», the
// buttons; «Отклонить» closes it.
test('telephony-incoming', async ({ open, win, mock, shot }) => {
  await open();
  mock.ringSipInbound(IDS.users.anna, '+79161234567', 'Отдел продаж');
  const modal = win.getByTestId('sip-incoming');
  await expect(modal).toContainText('+7 916 123-45-67');
  await expect(modal).toContainText('Входящий на номер · Отдел продаж');
  await expect(modal.getByRole('button', { name: 'Принять' })).toBeFocused();
  await settle(win);
  await checkpoint(shot, 'telephony-incoming');
  await modal.getByRole('button', { name: 'Отклонить' }).click();
  await expect(modal).toHaveCount(0);
});
