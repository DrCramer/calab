import { SipCallStatus } from '@calaba/protocol';
import { IDS } from '../e2e-support/mock-server';
import { expect, test } from './app';
import { checkpoint, settle } from './harness';

/**
 * «Телефония» (docs/08 «Телефония»): the station's settings in the section (ADR-0137 §5, T5) — the
 * «Настройки» group of the column: «Подключение» (the empty state before anything is connected, the
 * form), «Входящие» over a registration at the provider (ADR-0121: registered / a refused
 * password), «Внутренние номера» (103 unassigned), «Группы» («Поддержка» with a deleted fallback),
 * «Автоответ» (a menu with a recording and keys, key 9 leading to a deleted menu; «Выходные» without
 * one — «Загрузить запись» in its row), «Запись звонков», «Хранение и лимиты», «Рабочие часы»
 * (ADR-0138: two intervals on Monday, a Friday night shift, an overlap refused); the settings
 * window without «Телефония»; the internal number set from a profile (a taken one says whose).
 * Fixture: mock-server seedSipExchange / seedSipSchedule. And the incoming phone call (ADR-0117
 * step 2): the sheet with the caller's number and the menu it came through; a group's fallback off
 * / on (ADR-0124); an exchange from scratch (a new menu with its greeting chosen in the form:
 * refused files at once, the upload right after «Сохранить» — the conversion, a server refusal that
 * keeps the saved menu open). A call taken while in a voice room parks the room (ADR-0133): me and
 * Борис dimmed with a handset. Projects `telephony-dark-960` (all) and `telephony-light-960`
 * (telephony-menu with the schedule, and the incoming call); run with -g:
 *
 *   CALABA_VISUAL_MOCK_PORT=4513 MOCK_LIVEKIT_ROOM_PREFIX=tel_ \
 *     pnpm -F @calaba/desktop e2e:visual -g "telephony-"
 */

type Page = import('@playwright/test').Page;
type Locator = import('@playwright/test').Locator;

const DARK = (theme: string): boolean => theme === 'dark';

type SetPage = 'connection' | 'inbound' | 'schedule' | 'numbers' | 'groups' | 'ivr' | 'recording' | 'policy';

/** «Телефония → Настройки → <page>»: the rail's tile, then the page in the column's settings group. */
async function settingsPage(win: Page, page: SetPage): Promise<Locator> {
  if (!(await win.getByTestId('tel-nav').isVisible())) await win.getByTestId('section-telephony').click();
  await win.getByTestId(`tel-nav-set-${page}`).click();
  const centre = win.getByTestId(`tel-settings-${page}`);
  await expect(centre).toBeVisible();
  return centre;
}

/** «Сохранено» sits over the form's foot: close it by a DOM click. */
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
  // Nothing connected yet: the administrator still finds the section (ADR-0137 §5) — it is only the
  // settings, open on «Подключение» with its empty state; «Подключить» shows the form.
  mock.seedSipExchange(true);
  mock.setSip(IDS.workspaces.main, null);
  await win.getByTestId('section-telephony').click();
  await expect(win.getByTestId('tel-nav-recents')).toHaveCount(0);
  const empty = win.getByTestId('tel-not-connected');
  await expect(empty).toContainText('Подключите SIP-провайдера');
  await checkpoint(shot, 'telephony-not-connected');
  await empty.getByRole('button', { name: 'Подключить' }).click();
  await expect(win.getByTestId('sip-form')).toBeVisible();

  // The settings window has no «Телефония» any more (ADR-0137 §5).
  await win.getByTestId('titlebar-title').click();
  await win.getByRole('menuitem', { name: 'Настройки', exact: true }).click();
  const dialog = win.getByRole('dialog');
  await expect(dialog.getByRole('tab', { name: 'Тариф' })).toBeVisible();
  await expect(dialog.getByRole('tab', { name: 'Телефония' })).toHaveCount(0);
  await checkpoint(shot, 'settings-no-telephony');
  await win.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  await open();
  mock.seedSipExchange();
  mock.setSipRegistration('registered');
  mock.seedSipSchedule();

  let page = await settingsPage(win, 'numbers');
  await expect(page.getByTestId('sip-ext-row')).toHaveCount(4);
  // ADR-0129: 101 (Борис) is closed to external callers — «без внешних» in its row and the switch on in its form.
  await expect(page.getByTestId('sip-ext-row').filter({ hasText: 'Борис' }).getByTestId('sip-ext-no-external')).toHaveText('без внешних');
  await checkpoint(shot, 'telephony-numbers');
  await page.getByTestId('sip-ext-row').filter({ hasText: 'Борис' }).getByRole('button', { name: 'Изменить' }).click();
  const noExternal = page.getByTestId('sip-ext-no-external-switch');
  await expect(noExternal.getByRole('switch', { name: 'Не принимать внешние звонки по добавочному' })).toHaveAttribute('aria-checked', 'true');
  await checkpoint(shot, 'telephony-number-no-external');
  await page.getByTestId('sip-ext-form').getByRole('button', { name: 'Отмена' }).click();

  // A new number: the member picker without guests and members who have one.
  await page.getByTestId('sip-ext-add').click();
  await page.getByTestId('sip-ext-number').fill('105');
  await page.getByTestId('sip-ext-member').click();
  await expect(win.getByTestId('sip-ext-picker')).toBeVisible();
  await checkpoint(shot, 'telephony-number-picker');
  await win.keyboard.press('Escape');
  await page.getByTestId('sip-ext-number').fill('101');
  await page.getByTestId('sip-ext-description').fill('Касса');
  // A taken number: the server's 409 under the field (Григорий is the one member without a number).
  await page.getByTestId('sip-ext-member').click();
  await win.getByTestId('sip-ext-picker').getByRole('option').first().click();
  await page.getByTestId('sip-ext-save').click();
  await expect(page.getByTestId('sip-ext-error')).toHaveText('Этот номер уже занят');
  await checkpoint(shot, 'telephony-number-form');
  await page.getByRole('button', { name: 'Отмена' }).click();

  // «Группы»: the list; a group's order, strategy, «если никто не ответил» with a deleted target.
  page = await settingsPage(win, 'groups');
  await expect(page.getByTestId('sip-group-row')).toHaveCount(2);
  await checkpoint(shot, 'telephony-groups');
  await page.getByTestId('sip-group-row').filter({ hasText: 'Поддержка' }).getByRole('button', { name: 'Изменить' }).click();
  const group = page.getByTestId('sip-group-form');
  await expect(group.getByTestId('sip-target-missing')).toBeVisible();
  await group.getByTestId('sip-group-add-member').selectOption({ label: '102 · Вера Ким' });
  await group.scrollIntoViewIfNeeded();
  await checkpoint(shot, 'telephony-group-form');
  await group.getByRole('button', { name: 'Отмена' }).click();

  // «Автоответ»: «Выходные» has no recording — «Загрузить запись» right in its row.
  page = await settingsPage(win, 'ivr');
  await expect(page.getByTestId('sip-menu-row')).toHaveCount(2);
  await expect(page.getByTestId('sip-menu-row').filter({ hasText: 'Выходные' }).getByTestId('sip-menu-row-upload')).toHaveText('Загрузить запись');
  await expect(page.getByTestId('sip-menu-row').filter({ hasText: 'Главное меню' }).getByTestId('sip-menu-row-upload')).toHaveCount(0);
  await checkpoint(shot, 'telephony-ivr');

  // «Подключение»: the provider form and the test (the column's dot is green).
  page = await settingsPage(win, 'connection');
  await expect(page.getByTestId('sip-form')).toBeVisible();
  await checkpoint(shot, 'telephony-settings');

  // «Входящие» (ADR-0121) over a registration at the provider — the mode, the state line
  // (registered until …, the masked contact) with the registrar fields open, the working hours in a
  // line under it; then the provider refuses the password: saving re-reads the settings and the
  // line turns into the error.
  page = await settingsPage(win, 'inbound');
  await expect(page.getByTestId('sip-reg-status')).toHaveText('Зарегистрировано до 13:39 · контакт sip:c…@141.105.69.177:5080');
  await expect(page.getByTestId('sip-inbound-mode').getByRole('radio', { name: 'По регистрации' })).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('sip-reg-advanced').click();
  await page.getByTestId('sip-reg-status').scrollIntoViewIfNeeded();
  await checkpoint(shot, 'telephony-inbound-register');
  mock.setSipRegistration('failed');
  await page.getByTestId('sip-inbound-save').click();
  await expect(page.getByTestId('sip-reg-status')).toHaveText('Ошибка регистрации: провайдер не принял логин или пароль');
  await dropToasts(win);
  await page.getByTestId('sip-reg-status').scrollIntoViewIfNeeded();
  await checkpoint(shot, 'telephony-inbound-register-failed');

  // ADR-0131: «Запись звонков» — incoming on (the fixture), outgoing switched on here.
  page = await settingsPage(win, 'recording');
  const rec = page.getByTestId('sip-recording');
  await expect(rec.getByRole('switch', { name: 'Записывать входящие звонки' })).toHaveAttribute('aria-checked', 'true');
  await rec.getByRole('switch', { name: 'Записывать исходящие звонки' }).click();
  await expect(rec.getByRole('switch', { name: 'Записывать исходящие звонки' })).toHaveAttribute('aria-checked', 'true');
  await dropToasts(win);
  await checkpoint(shot, 'telephony-recording');

  // «Хранение и лимиты» (PUT sip/policy): 6 months and a member limit out of range.
  page = await settingsPage(win, 'policy');
  await page.getByRole('radio', { name: '6 месяцев' }).click();
  await page.getByTestId('tset-limit-member').fill('2000');
  await expect(page.getByTestId('tset-policy-save')).toBeDisabled();
  await checkpoint(shot, 'telephony-retention');
  await page.getByTestId('tset-limit-member').fill('20');
  await page.getByTestId('tset-policy-save').click();
  await expect(win.getByTestId('toast')).toContainText('Сохранено');
  await dropToasts(win);

  // The internal number from a profile (owner 27.10): the administrator's pencil, a taken number
  // says whose it is.
  await win.getByTestId('section-chats').click();
  const members = win.getByRole('complementary', { name: 'Участники' });
  if (!(await members.isVisible())) await win.getByRole('button', { name: 'Участники' }).click();
  await members.getByRole('button', { name: /Борис Петров/ }).click();
  const card = win.getByRole('dialog', { name: 'Борис Петров' });
  await expect(card.getByTestId('profile-extension')).toContainText('101');
  await card.getByTestId('profile-extension-edit').click();
  await card.getByTestId('profile-extension-input').fill('102');
  await card.getByTestId('profile-extension-save').click();
  await expect(card.getByTestId('profile-extension-error')).toHaveText('Номер 102 уже у: Вера Ким');
  await checkpoint(shot, 'telephony-profile-extension');
});

test('telephony-menu', async ({ open, win, mock, shot, theme }) => {
  // An exchange set up from scratch: a group has nobody to add until people get numbers.
  await open();
  mock.seedSipExchange(true);
  let page = await settingsPage(win, 'numbers');
  await expect(page.getByTestId('sip-ext-empty')).toBeVisible();
  page = await settingsPage(win, 'groups');
  await page.getByTestId('sip-group-add').click();
  await expect(page.getByTestId('sip-group-form')).toContainText('сначала дайте сотрудникам или ботам номера');
  await checkpoint(shot, 'telephony-empty');
  await page.getByTestId('sip-group-form').getByRole('button', { name: 'Отмена' }).click();

  // A new menu: the greeting is chosen right in the form — a wrong format and a file over
  // 10 MB are refused at once; a fitting one waits for «Сохранить».
  page = await settingsPage(win, 'ivr');
  await expect(page.getByTestId('sip-menu-empty')).toBeVisible();
  await page.getByTestId('sip-menu-add').click();
  let menu = page.getByTestId('sip-menu-form');
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
  menu = page.getByTestId('sip-menu-form');
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
  await page.getByTestId('sip-menu-add').click();
  menu = page.getByTestId('sip-menu-form');
  await menu.getByTestId('sip-menu-name').fill('Ночной режим');
  await menu.getByTestId('sip-menu-prompt-file').setInputFiles({ name: 'notes.mp3', mimeType: 'text/plain', buffer: Buffer.from('not audio') });
  await menu.getByTestId('sip-menu-save').click();
  menu = page.getByTestId('sip-menu-form');
  await expect(menu.getByTestId('sip-menu-prompt-error')).toHaveText('Нужен свой файл MP3, WAV или OGG до 10 МБ и до 3 минут');
  await expect(menu.getByTestId('sip-menu-upload')).toHaveText('Загрузить запись');
  await expect(menu.getByRole('button', { name: 'Удалить меню' })).toBeVisible();
  await dropToasts(win);
  await menu.scrollIntoViewIfNeeded();
  await checkpoint(shot, 'telephony-prompt-refused');
  await menu.getByRole('button', { name: 'Отмена' }).click();
  const night = page.getByTestId('sip-menu-row').filter({ hasText: 'Ночной режим' });
  await expect(night).toContainText('Нет записи');
  await checkpoint(shot, 'telephony-ivr-no-prompt');
  // The row's «Загрузить запись» opens the form and uploads there.
  await night.getByTestId('sip-menu-row-file').setInputFiles({ name: 'night.ogg', mimeType: 'audio/ogg', buffer: Buffer.alloc(4096, 1) });
  menu = page.getByTestId('sip-menu-form');
  await expect(menu.getByTestId('sip-menu-listen')).toBeVisible();
  await expect(menu.getByTestId('sip-menu-name')).toHaveValue('Ночной режим');
  file = menu.getByTestId('sip-menu-prompt-file');
  await expect(file).toHaveCount(1);
  await menu.getByRole('button', { name: 'Отмена' }).click();
  await dropToasts(win);

  await open();
  mock.seedSipExchange();
  mock.seedSipSchedule();
  page = await settingsPage(win, 'groups');
  await expect(page.getByTestId('sip-group-row').filter({ hasText: 'Отдел продаж' })).toContainText('переадресация через 45 с');

  // ADR-0124: a new group rings until somebody answers (the fallback off); switched on — after
  // N seconds the call goes to another group / a person / a bot / a menu / hangs up.
  await page.getByTestId('sip-group-add').click();
  const group = page.getByTestId('sip-group-form');
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

  page = await settingsPage(win, 'ivr');
  await page.getByTestId('sip-menu-row').filter({ hasText: 'Главное меню' }).getByRole('button', { name: 'Изменить' }).click();
  const form = page.getByTestId('sip-menu-form');
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
  await form.getByRole('button', { name: 'Отмена' }).click();

  // ADR-0138 «Рабочие часы»: the summary, Monday's two intervals, the Friday night shift running
  // into Saturday, the Russian calendar, off hours → «Выходные» after a notice; then Tuesday gets
  // a second interval overlapping its 9:00–18:00 — refused before the save, under the day.
  page = await settingsPage(win, 'schedule');
  await expect(page.getByTestId('tset-schedule-summary')).toContainText('Пн 9:00–13:00, 14:00–18:00; Вт–Чт 9:00–18:00; Пт 9:00–18:00, 22:00–2:00 · РФ календарь → Выходные');
  await expect(page.getByTestId('tset-day-1').getByTestId('tset-interval')).toHaveCount(2);
  await expect(page.getByTestId('tset-day-5').getByTestId('tset-interval-night')).toHaveText('до утра — Сб');
  await expect(page.getByTestId('tset-schedule-notice-listen')).toBeVisible();
  await checkpoint(shot, 'telephony-schedule');
  if (!DARK(theme)) return;
  const tue = page.getByTestId('tset-day-2');
  await tue.getByTestId('tset-interval-add').click();
  await tue.getByTestId('tset-interval-from').nth(1).fill('17:00');
  await tue.getByTestId('tset-interval-to').nth(1).fill('20:00');
  await expect(tue.getByTestId('tset-day-error')).toHaveText('Интервалы пересекаются — с учётом ночных смен');
  await expect(page.getByTestId('tset-schedule-save')).toBeDisabled();
  await tue.scrollIntoViewIfNeeded();
  await checkpoint(shot, 'telephony-schedule-overlap');
  await page.getByTestId('tset-schedule-target').scrollIntoViewIfNeeded();
  await checkpoint(shot, 'telephony-schedule-off-hours');
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

  // ADR-0132: the next call taken — the island's «Перевести» opens the picker (groups by their
  // number, colleagues with theirs, «Перевести на номер N» for digits); a pick rings Борис while I
  // stay on the call — «Переводим: Борис» with «Отменить перевод».
  mock.seedSipExchange();
  mock.ringSipInbound(IDS.users.anna, '+79161234567', 'Отдел продаж');
  await modal.getByRole('button', { name: 'Принять' }).click();
  const panel = win.getByRole('region', { name: 'Голосовое подключение' });
  await expect(panel).toContainText('Звонок · +7 916 123-45-67');
  await expect(panel).toContainText('Голос подключён', { timeout: 30_000 });
  const transfer = panel.getByTestId('sip-transfer');
  await expect(transfer).toBeVisible();
  await settle(win);
  await checkpoint(shot, 'telephony-in-call');
  await transfer.click();
  const picker = win.getByTestId('sip-transfer-picker');
  await expect(picker.getByRole('option', { name: /Отдел продаж/ })).toBeVisible();
  await expect(picker.getByRole('option', { name: /Борис/ })).toBeVisible();
  await checkpoint(shot, 'telephony-transfer-picker');
  await win.keyboard.type('105');
  await expect(picker.getByRole('option', { name: 'Перевести на номер 105' })).toBeVisible();
  await win.keyboard.press('Backspace');
  await win.keyboard.press('Backspace');
  await win.keyboard.press('Backspace');
  await picker.getByRole('option', { name: /Борис/ }).click();
  const ringing = panel.getByTestId('sip-transferring');
  await expect(ringing).toContainText('Переводим: Борис');
  await checkpoint(shot, 'telephony-transferring');
  await ringing.getByRole('button', { name: 'Отменить перевод' }).click();
  await expect(transfer).toBeVisible();
  await panel.getByRole('button', { name: 'Отключиться' }).click();
  await expect(panel).toHaveCount(0);

  // ADR-0133: a call taken while in a voice room parks the room - I stay in «Переговорка» for the
  // others, dimmed with a handset (Борис too, parked by his own call), and the island says «Комната:
  // Переговорка — на паузе» with «Выйти». The hang-up brings the room back without a reconnect.
  const sidebar = win.locator('aside').first();
  await sidebar.getByRole('button', { name: /Переговорка/ }).first().click();
  await win.getByRole('region', { name: 'Переговорка' }).getByRole('button', { name: 'Войти в голос', exact: true }).click();
  await expect(panel).toContainText('Голос подключён', { timeout: 30_000 });
  mock.setVoiceState({ userId: IDS.users.boris, roomId: IDS.rooms.meeting, onPhone: true });
  mock.ringSipInbound(IDS.users.anna, '+79161234567', 'Отдел продаж');
  await modal.getByRole('button', { name: 'Принять' }).click();
  await expect(panel).toContainText('Звонок · +7 916 123-45-67');
  await expect(panel).toContainText('Голос подключён', { timeout: 30_000 });
  const parked = panel.getByTestId('voice-parked');
  await expect(parked).toContainText('Комната: Переговорка — на паузе');
  await expect(sidebar.locator('li[data-on-phone]')).toHaveCount(2);
  await expect(sidebar.locator('li[data-on-phone] [data-voice-icon="on-phone"]')).toHaveCount(2);
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await settle(win);
  await checkpoint(shot, 'telephony-parked-room');
  await panel.getByRole('button', { name: 'Отключиться' }).click();
  await expect(panel).not.toContainText('Звонок ·');
  await expect(panel).toContainText('Голос подключён');
  await expect(parked).toHaveCount(0);
  await expect(sidebar.locator('li[data-on-phone]')).toHaveCount(1); // Борис is still on his call
});

// ADR-0137 «Телефония» (T3): the section on the rail — the tile with my missed calls, «Недавние»
// (a call ringing now, the day groups, a missed one in red, an outbound one to a company, a long
// name with a long company, a hidden number, an employee's phone), the detail of a call through
// the main menu, a group «по очереди» and a transfer (the floating panel at 960, its rings
// unfolded), a live call moving on through SIP_JOURNAL_ENTRY, the empty journal. The light theme
// takes the detail only.
test('telephony-section', async ({ open, win, mock, shot, theme }) => {
  await open();
  mock.seedSipExchange();
  mock.seedSipJournal();
  const tile = win.getByTestId('section-telephony');
  await expect(tile.getByTestId('section-telephony-count')).toHaveText('2');
  // The frame is about the rail: the room feed behind it settles its scroll on its own time.
  if (DARK(theme)) await checkpoint(shot, 'telephony-rail', { mask: [win.locator('[data-virtuoso-scroller]')] });
  await tile.click();
  const recents = win.getByTestId('tel-recents');
  await expect(recents.getByTestId('tel-group').first()).toHaveText('Сейчас');
  await expect(recents.getByTestId('tel-row').first()).toContainText('+7 916 700-11-22');
  // Looking at «Недавние» clears the badge (journal/seen).
  await expect(tile.getByTestId('section-telephony-count')).toHaveCount(0);
  const missed = recents.getByTestId('tel-row').filter({ hasText: '+7 495 765-43-21' });
  await expect(missed.getByTestId('tel-row-outcome')).toHaveText('Пропущенный · ждал 1:15 · «Отдел продаж»');
  await expect(recents.getByTestId('tel-row').filter({ hasText: 'ООО Лютик' }).getByTestId('tel-row-outcome')).toHaveText('Исходящий · Вы · 2:03');
  if (DARK(theme)) await checkpoint(shot, 'telephony-recents');

  // The detail: menu → key → «Отдел продаж» one by one → Анна answers → transfers to Борис.
  await recents.getByRole('button', { name: 'Звонок: Анна Петрова' }).click();
  const detail = win.getByTestId('tel-detail');
  await expect(detail.getByTestId('tel-detail-name')).toHaveText('Анна Петрова');
  // The recording (ADR-0131): the player card and «Открыть в Диске».
  await expect(detail.getByTestId('tel-recording')).toContainText('6:20');
  if (DARK(theme)) await checkpoint(shot, 'telephony-detail-recording');
  await expect(detail.getByTestId('tel-step')).toHaveCount(13);
  await detail.getByTestId('tel-step-rings').first().click();
  await expect(detail.getByTestId('tel-step-attempts').first()).toContainText('Вера Ким');
  await detail.getByTestId('tel-step').filter({ hasText: 'переводит' }).scrollIntoViewIfNeeded();
  await checkpoint(shot, 'telephony-detail-transfer');
  if (!DARK(theme)) return;
  await win.keyboard.press('Escape');
  await expect(detail).toHaveCount(0);

  // SIP_JOURNAL_ENTRY: the ringing call is answered (still «Сейчас»), then ends — it joins «Сегодня».
  mock.advanceSipJournal(undefined, IDS.users.boris);
  await expect(recents.getByTestId('tel-row').first().getByTestId('tel-row-outcome')).toHaveText('Разговор: Борис Петров');
  mock.advanceSipJournal();
  await expect(recents.getByTestId('tel-group').first()).toHaveText('Сегодня');

  // Nothing yet.
  await open();
  mock.seedSipExchange();
  mock.seedSipJournal({ empty: true });
  await win.getByTestId('section-telephony').click();
  await expect(win.getByTestId('tel-empty')).toContainText('Звонков пока нет');
  await checkpoint(shot, 'telephony-recents-empty');
});

// ADR-0137 «Телефония» (T4) on the desktop: «Контакты» (the list by letters, the card in the
// floating panel at 960, the form, the CSV import preview), «Набор» (the card typed from the
// keyboard with the contact suggestion), the personal call — «Набираем…» in the island, then the
// tone keypad — and an inbound call from a contact (its name, company and number). The light
// theme takes the card, the dial pad and the inbound call.
test('telephony-contacts', async ({ open, win, mock, shot, theme }) => {
  await open();
  mock.seedSipExchange();
  mock.seedSipJournal();
  mock.seedSipContacts();
  await win.getByTestId('section-telephony').click();
  await win.getByTestId('tel-nav-contacts').click();
  const page = win.getByTestId('telc-page');
  await expect(page.getByTestId('telc-letter').first()).toHaveText('А');
  if (DARK(theme)) await checkpoint(shot, 'telephony-contacts');
  await page.getByRole('button', { name: 'Анна Петрова', exact: true }).click();
  const card = win.getByTestId('telc-card');
  await expect(card.getByTestId('telc-number')).toHaveCount(3);
  await expect(card.getByTestId('telc-call').first()).toBeVisible();
  await checkpoint(shot, 'telephony-contact-card');
  if (DARK(theme)) {
    await card.getByTestId('telc-card-edit').click();
    const form = win.getByRole('dialog');
    await expect(form.getByTestId('telc-f-number')).toHaveCount(3);
    await checkpoint(shot, 'telephony-contact-form');
    await form.getByRole('button', { name: 'Отмена' }).click();
    await expect(form).toHaveCount(0);
    await win.keyboard.press('Escape');
    // «…» → «Импорт CSV»: a file → the preview with its skips.
    await page.getByTestId('telc-more').click();
    await win.getByTestId('telc-import-open').click();
    await win.getByTestId('telc-import-file').setInputFiles({
      name: 'contacts.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('Имя;Компания;Телефон;Заметка\nИрина Белова;ООО Лютик;8 916 000-11-22;\nДубль Анны;;+7 916 123-45-67;\n;;+7 916 000-99-88;\nПётр;;доб. 12;\n'),
    });
    await expect(win.getByTestId('telc-import-preview')).toContainText('Будет добавлено: 1');
    await checkpoint(shot, 'telephony-import-preview');
    await win.keyboard.press('Escape');
  }

  // «Набор»: typed from the keyboard; the contact of the number under it.
  await win.getByTestId('tel-nav-dial').click();
  const field = win.getByTestId('tel-dial-field');
  await expect(field).toBeFocused();
  await win.keyboard.type('89161234567');
  await expect(field).toHaveValue('8 916 123-45-67');
  await expect(win.getByTestId('tel-dial-suggestion')).toContainText('Анна Петрова');
  await checkpoint(shot, 'telephony-keypad');
  if (DARK(theme)) {
    // Enter calls: the island says «Набираем…» until the answer, then «Клавиатура» sends tones.
    await win.keyboard.press('Enter');
    const panel = win.getByRole('region', { name: 'Голосовое подключение' });
    await expect(panel).toContainText('Звонок · Анна Петрова (ООО Ромашка)');
    await expect(panel.getByTestId('voice-phase')).toHaveText('Набираем…');
    await checkpoint(shot, 'telephony-calling');
    mock.advanceSipPersonal();
    await expect(panel.getByTestId('voice-phase')).toHaveText('Голос подключён', { timeout: 30_000 });
    await panel.getByTestId('dtmf-open').click();
    const pad = win.getByTestId('dtmf-pad');
    for (const k of '12#') await pad.locator(`[data-key="${k}"]`).click();
    await expect(win.getByTestId('dtmf-typed')).toHaveText('12#');
    await checkpoint(shot, 'telephony-dtmf');
    await win.keyboard.press('Escape');
    await panel.getByRole('button', { name: 'Отключиться' }).click();
    await expect(panel).toHaveCount(0);
  }

  // An inbound call from a contact's number: the name big, the company, the number under them.
  mock.ringSipInbound(IDS.users.anna, '+79161234567', 'Отдел продаж');
  const ring = win.getByTestId('sip-incoming');
  await expect(ring.getByTestId('call-sheet-title')).toHaveText('Анна Петрова');
  await expect(ring).toContainText('ООО Ромашка');
  await expect(ring).toContainText('+7 916 123-45-67');
  await checkpoint(shot, 'telephony-incoming-contact');
});

// ADR-0046 addendum «Тональный набор»: a voice room's phone line. «Позвонить на номер» keeps
// «доб. 101» after the masked number; the line rings without «Клавиатура», answers with «доб. 101»
// in the room's list and «Клавиатура» left of «Завершить» — the shared tone pad beside the row,
// «Тоновый набор: <number> доб. 101» on top, the keys pressed. Dark: all; light: the keypad.
test('telephony-room-call', async ({ open, win, mock, shot, theme }) => {
  await open();
  mock.seedSipExchange();
  const sidebar = win.locator('aside').first();
  await sidebar.getByRole('button', { name: /Переговорка/ }).first().click();
  await win.getByRole('region', { name: 'Переговорка' }).getByRole('button', { name: 'Войти в голос', exact: true }).click();
  const panel = win.getByRole('region', { name: 'Голосовое подключение' });
  await expect(panel).toContainText('Голос подключён', { timeout: 30_000 });

  await win.getByTestId('sip-dial').click();
  const field = win.getByTestId('sip-number');
  await expect(field).toBeFocused();
  await win.keyboard.type('+74951234567 доб. 101');
  await expect(field).toHaveValue('+7 495 123-45-67 доб. 101');
  if (DARK(theme)) await checkpoint(shot, 'telephony-room-dial-ext');
  await win.keyboard.press('Enter');
  const row = sidebar.getByTestId('sip-call-row');
  await expect(row).toHaveAttribute('data-status', 'dialing');
  await expect(row.getByTestId('sip-call-ext')).toHaveText('· доб. 101');
  await expect(panel.getByTestId('sip-keypad')).toHaveCount(0); // not while it rings

  mock.setSipCallStatus(mock.liveSipCallOf(IDS.rooms.meeting), SipCallStatus.ACTIVE);
  await expect(row).toHaveAttribute('data-status', 'active');
  await expect(row).toHaveAttribute('aria-label', 'Телефон +7 495 123-45-67 доб. 101');
  const keys = panel.getByTestId('sip-keypad');
  await expect(keys).toHaveText('Клавиатура');
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  // At 600 px the island covers the list's foot: the row to the top of the list.
  await row.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await settle(win);
  if (DARK(theme)) await checkpoint(shot, 'telephony-room-call-row', { mask: [row.getByTestId('sip-status')] });

  await keys.click();
  const sheet = win.getByTestId('sip-keypad-popover');
  await expect(sheet.getByTestId('dtmf-for')).toHaveText('Тоновый набор: +7 495 123-45-67 доб. 101');
  for (const k of '2#') await sheet.locator(`[data-key="${k}"]`).click();
  await expect(sheet.getByTestId('dtmf-typed')).toHaveText('2#');
  await checkpoint(shot, 'telephony-room-keypad');
  await win.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await panel.getByRole('button', { name: 'Отключиться' }).click();
});
