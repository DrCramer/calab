import { IDS } from '../e2e-support/mock-server';
import { expect, test } from './app';
import { checkpoint, settle } from './harness';

/**
 * «Настройки пространства → Телефония» (docs/08 «Телефония»), five tabs (CBF-77): «Активные
 * звонки» (ADR-0128: empty, then a call in a menu, one ringing a group, one answered and an
 * outbound one), «Номера» (103 unassigned), «Группы» («Поддержка» with a deleted fallback), «IVR»
 * (a menu with a recording and keys, key 9 leading to a deleted menu; «Выходные» without one —
 * «Загрузить запись» in its row), «Настройки» with «Входящие» over a registration at the provider
 * (ADR-0121: registered / a refused password). Fixture: mock-server seedSipExchange /
 * seedSipActiveCalls. And the incoming phone call (ADR-0117 step 2): the sheet with the caller's
 * number and the menu it came through; a group's fallback off / on (ADR-0124); an exchange from
 * scratch (a new menu with its greeting chosen in the form: refused files at once, the upload
 * right after «Сохранить» — the conversion, a server refusal that keeps the saved menu open).
 * Projects `telephony-dark-960` (all) and `telephony-light-960` (telephony-menu and the incoming
 * call); run with -g:
 *
 *   CALABA_VISUAL_MOCK_PORT=4513 MOCK_LIVEKIT_ROOM_PREFIX=tel_ \
 *     pnpm -F @calaba/desktop e2e:visual -g "telephony-"
 */

type Page = import('@playwright/test').Page;
type Locator = import('@playwright/test').Locator;

const DARK = (theme: string): boolean => theme === 'dark';

async function openTelephony(win: Page): Promise<Locator> {
  await win.getByTestId('titlebar-title').click();
  await win.getByRole('menuitem', { name: 'Настройки', exact: true }).click();
  const dialog = win.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Телефония' }).click();
  await expect(dialog.getByTestId('sip-tabs')).toBeVisible();
  return dialog;
}

/** A tab of the telephony section (desktop: segments). */
async function tab(dialog: Locator, name: string): Promise<void> {
  await dialog.getByTestId('sip-tabs').getByRole('radio', { name, exact: true }).click();
}

/** «Сохранено» sits over the form's foot (outside the modal): close it by a DOM click. */
async function dropToasts(win: Page): Promise<void> {
  await expect(async () => {
    await win.evaluate(() => {
      for (const b of document.querySelectorAll<HTMLButtonElement>('[data-testid="toast"] button[aria-label="Закрыть уведомление"]')) b.click();
    });
    await expect(win.getByTestId('toast')).toHaveCount(0, { timeout: 1000 });
  }).toPass();
}

test('telephony-exchange', async ({ open, win, mock, shot, theme }) => {
  test.skip(!DARK(theme), 'dark only');
  await open();
  mock.seedSipExchange();
  mock.setSipRegistration('registered');
  const dialog = await openTelephony(win);

  // «Активные звонки»: nothing yet; then four calls arrive (SIP_CALLS_CHANGED re-reads the list).
  await tab(dialog, 'Активные звонки');
  await expect(dialog.getByTestId('sip-calls-empty')).toHaveText('Сейчас звонков нет');
  await checkpoint(shot, 'telephony-calls-empty');
  mock.seedSipActiveCalls();
  const rows = dialog.getByTestId('sip-call-row');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText('+7 916 123-45-67');
  await expect(rows.nth(0).getByTestId('sip-call-step')).toHaveText('Голосовое меню «Главное меню»');
  await expect(rows.nth(1).getByTestId('sip-call-step')).toHaveText('Звонит группе «Отдел продаж» · Борис Петров, Вера Ким');
  await expect(rows.nth(2).getByTestId('sip-call-step')).toHaveText('Разговор: Вера Ким');
  await expect(rows.nth(3).getByTestId('sip-call-step')).toHaveText('Разговор в комнате «Созвон»');
  // The timers and the journal's times follow the clock.
  await expect(dialog.getByTestId('sip-journal-row')).toHaveCount(4);
  await checkpoint(shot, 'telephony-calls', { mask: [dialog.getByTestId('sip-call-timer'), dialog.getByTestId('sip-journal-row').locator('td:first-child')] });

  await tab(dialog, 'Номера');
  await expect(dialog.getByTestId('sip-ext-row')).toHaveCount(4);
  // ADR-0129: 101 (Борис) is closed to external callers — «без внешних» in its row and the switch on in its form.
  await expect(dialog.getByTestId('sip-ext-row').filter({ hasText: 'Борис' }).getByTestId('sip-ext-no-external')).toHaveText('без внешних');
  await checkpoint(shot, 'telephony-numbers');
  await dialog.getByTestId('sip-ext-row').filter({ hasText: 'Борис' }).getByRole('button', { name: 'Изменить' }).click();
  const noExternal = dialog.getByTestId('sip-ext-no-external-switch');
  await expect(noExternal.getByRole('switch', { name: 'Не принимать внешние звонки по добавочному' })).toHaveAttribute('aria-checked', 'true');
  await checkpoint(shot, 'telephony-number-no-external');
  await dialog.getByTestId('sip-ext-form').getByRole('button', { name: 'Отмена' }).click();

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

  // «Группы»: the list; a group's order, strategy, «если никто не ответил» with a deleted target.
  await tab(dialog, 'Группы');
  await expect(dialog.getByTestId('sip-group-row')).toHaveCount(2);
  await checkpoint(shot, 'telephony-groups');
  await dialog.getByTestId('sip-group-row').filter({ hasText: 'Поддержка' }).getByRole('button', { name: 'Изменить' }).click();
  const group = dialog.getByTestId('sip-group-form');
  await expect(group.getByTestId('sip-target-missing')).toBeVisible();
  await group.getByTestId('sip-group-add-member').selectOption({ label: '102 · Вера Ким' });
  await group.scrollIntoViewIfNeeded();
  await checkpoint(shot, 'telephony-group-form');
  await group.getByRole('button', { name: 'Отмена' }).click();

  // «IVR»: «Выходные» has no recording — «Загрузить запись» right in its row.
  await tab(dialog, 'IVR');
  await expect(dialog.getByTestId('sip-menu-row')).toHaveCount(2);
  await expect(dialog.getByTestId('sip-menu-row').filter({ hasText: 'Выходные' }).getByTestId('sip-menu-row-upload')).toHaveText('Загрузить запись');
  await expect(dialog.getByTestId('sip-menu-row').filter({ hasText: 'Главное меню' }).getByTestId('sip-menu-row-upload')).toHaveCount(0);
  await checkpoint(shot, 'telephony-ivr');

  // «Настройки»: the provider, the test, «Входящие» (ADR-0121) over a registration at the
  // provider — the mode, the state line (registered until …, the masked contact) with the
  // registrar fields open; then the provider refuses the password: saving re-reads the settings
  // and the line turns into the error.
  await tab(dialog, 'Настройки');
  await expect(dialog.getByTestId('sip-form')).toBeVisible();
  await checkpoint(shot, 'telephony-settings');
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
  // ADR-0131: «Запись звонков» — incoming on (the fixture), outgoing switched on here.
  const rec = dialog.getByTestId('sip-recording');
  await expect(rec.getByRole('switch', { name: 'Записывать входящие звонки' })).toHaveAttribute('aria-checked', 'true');
  await rec.getByRole('switch', { name: 'Записывать исходящие звонки' }).click();
  await expect(rec.getByRole('switch', { name: 'Записывать исходящие звонки' })).toHaveAttribute('aria-checked', 'true');
  await dropToasts(win);
  await rec.scrollIntoViewIfNeeded();
  await checkpoint(shot, 'telephony-recording');
});

test('telephony-menu', async ({ open, win, mock, shot }) => {
  // An exchange set up from scratch: a group has nobody to add until people get numbers.
  await open();
  mock.seedSipExchange(true);
  let dialog = await openTelephony(win);
  await tab(dialog, 'Номера');
  await expect(dialog.getByTestId('sip-ext-empty')).toBeVisible();
  await tab(dialog, 'Группы');
  await dialog.getByTestId('sip-group-add').click();
  await expect(dialog.getByTestId('sip-group-form')).toContainText('сначала дайте сотрудникам или ботам номера');
  await checkpoint(shot, 'telephony-empty');
  await dialog.getByTestId('sip-group-form').getByRole('button', { name: 'Отмена' }).click();

  // A new menu: the greeting is chosen right in the form — a wrong format and a file over
  // 10 MB are refused at once; a fitting one waits for «Сохранить».
  await tab(dialog, 'IVR');
  await expect(dialog.getByTestId('sip-menu-empty')).toBeVisible();
  await dialog.getByTestId('sip-menu-add').click();
  let menu = dialog.getByTestId('sip-menu-form');
  await menu.getByTestId('sip-menu-name').fill('Приветствие');
  await expect(menu.getByTestId('sip-menu-upload')).toHaveText('Выбрать файл');
  await expect(menu).toContainText('Пока записи нет, меню не звучит');
  let file = menu.getByTestId('sip-menu-prompt-file');
  const prompt = menu.getByTestId('sip-menu-prompt-error');
  await file.setInputFiles({ name: 'big.wav', mimeType: 'audio/wav', buffer: Buffer.alloc(10 * 1024 * 1024 + 1) });
  await expect(prompt).toHaveText('Файл больше 10 МБ — сожмите или укоротите запись');
  await file.setInputFiles({ name: 'greeting.docx', mimeType: 'application/msword', buffer: Buffer.from('doc') });
  await expect(prompt).toHaveText('Этот файл не подходит — нужен MP3, WAV или OGG');
  await menu.scrollIntoViewIfNeeded();
  await checkpoint(shot, 'telephony-prompt-error');
  await file.setInputFiles({ name: 'greeting.mp3', mimeType: 'audio/mpeg', buffer: Buffer.alloc(4096, 1) });
  await expect(menu.getByTestId('sip-menu-prompt')).toContainText('greeting.mp3 — загрузится после «Сохранить»');
  await expect(prompt).toHaveCount(0);
  await expect(menu.getByTestId('sip-menu-upload')).toHaveText('Заменить');
  await menu.scrollIntoViewIfNeeded();
  await checkpoint(shot, 'telephony-menu-new-file');

  // «Сохранить»: the menu is created, the form stays open on it and the file uploads — the
  // conversion shows «Обрабатываем запись…», then the length and ▶.
  const release = mock.holdSipPrompt();
  await menu.getByTestId('sip-menu-save').click();
  menu = dialog.getByTestId('sip-menu-form');
  await expect(menu.getByTestId('sip-menu-prompt')).toContainText('Обрабатываем запись…');
  await dropToasts(win);
  await checkpoint(shot, 'telephony-prompt-processing');
  release();
  await expect(menu.getByTestId('sip-menu-listen')).toBeVisible();
  await expect(menu.getByTestId('sip-menu-prompt')).toContainText('0:42');
  await expect(menu.getByTestId('sip-menu-upload')).toHaveText('Заменить');
  await menu.getByRole('button', { name: 'Отмена' }).click();

  // The server refuses the file after the menu is saved: the menu stays, its form stays open
  // with the refusal and the picker; closed — its row offers «Загрузить запись».
  await dialog.getByTestId('sip-menu-add').click();
  menu = dialog.getByTestId('sip-menu-form');
  await menu.getByTestId('sip-menu-name').fill('Ночной режим');
  await menu.getByTestId('sip-menu-prompt-file').setInputFiles({ name: 'notes.mp3', mimeType: 'text/plain', buffer: Buffer.from('not audio') });
  await menu.getByTestId('sip-menu-save').click();
  menu = dialog.getByTestId('sip-menu-form');
  await expect(menu.getByTestId('sip-menu-prompt-error')).toHaveText('Нужен свой файл MP3, WAV или OGG до 10 МБ и до 3 минут');
  await expect(menu.getByTestId('sip-menu-upload')).toHaveText('Загрузить запись');
  await expect(menu.getByRole('button', { name: 'Удалить меню' })).toBeVisible();
  await dropToasts(win);
  await menu.scrollIntoViewIfNeeded();
  await checkpoint(shot, 'telephony-prompt-refused');
  await menu.getByRole('button', { name: 'Отмена' }).click();
  const night = dialog.getByTestId('sip-menu-row').filter({ hasText: 'Ночной режим' });
  await expect(night).toContainText('Нет записи');
  await checkpoint(shot, 'telephony-ivr-no-prompt');
  // The row's «Загрузить запись» opens the form and uploads there.
  await night.getByTestId('sip-menu-row-file').setInputFiles({ name: 'night.ogg', mimeType: 'audio/ogg', buffer: Buffer.alloc(4096, 1) });
  menu = dialog.getByTestId('sip-menu-form');
  await expect(menu.getByTestId('sip-menu-listen')).toBeVisible();
  await expect(menu.getByTestId('sip-menu-name')).toHaveValue('Ночной режим');
  file = menu.getByTestId('sip-menu-prompt-file');
  await expect(file).toHaveCount(1);
  await menu.getByRole('button', { name: 'Отмена' }).click();
  await dropToasts(win);

  await open();
  mock.seedSipExchange();
  dialog = await openTelephony(win);
  await tab(dialog, 'Группы');
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

  await tab(dialog, 'IVR');
  await dialog.getByTestId('sip-menu-row').filter({ hasText: 'Главное меню' }).getByRole('button', { name: 'Изменить' }).click();
  const form = dialog.getByTestId('sip-menu-form');
  await expect(form.getByTestId('sip-menu-listen')).toBeVisible();
  await expect(form.getByTestId('sip-menu-key-9')).toHaveValue('missing');
  await form.getByTestId('sip-menu-keys').scrollIntoViewIfNeeded();
  await checkpoint(shot, 'telephony-menu-form');
  // ADR-0129: «Разрешить набор добавочного номера» on for the main menu.
  const dial = form.getByTestId('sip-menu-dial');
  await expect(dial.getByRole('switch', { name: 'Разрешить набор добавочного номера' })).toHaveAttribute('aria-checked', 'true');
  await dial.scrollIntoViewIfNeeded();
  await checkpoint(shot, 'telephony-menu-dial');
  // ADR-0131: the recording notice of the main menu — ▶, its length, «Заменить» / «Удалить».
  const notice = form.getByTestId('sip-menu-notice');
  await expect(form.getByTestId('sip-menu-notice-listen')).toBeVisible();
  await expect(notice).toContainText('0:06');
  await notice.scrollIntoViewIfNeeded();
  await checkpoint(shot, 'telephony-menu-notice');
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
