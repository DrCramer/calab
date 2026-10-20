import { expect, test } from './app';
import { checkpoint } from './harness';

/**
 * «Диск» on the desktop (ADR-0094 §8, docs/08 «Диск»): the root as tiles and as a list, the
 * trash, the «Доступ» dialog of a restricted folder. Fixture (e2e-support mock-server seedDisk):
 * «Команда Calab» — folders «Дизайн», «Договоры» (restricted: Борис — правка, Вера — просмотр),
 * «Проекты»; two pictures, a PDF, a table, a video with a public link, an archive; two items in
 * the trash. Projects `disk-dark-960` (all four) and `disk-light-960` (`disk-share` only);
 * run with -g:
 *
 *   CALABA_VISUAL_MOCK_PORT=4313 MOCK_LIVEKIT_ROOM_PREFIX=disk_ \
 *     pnpm -F @calaba/desktop e2e:visual -g "disk-"
 */

const ONLY_DARK = (theme: string): boolean => theme !== 'dark';

test('disk-tiles', async ({ open, win, shot, theme }) => {
  test.skip(ONLY_DARK(theme), 'dark only');
  await open();
  await win.getByTestId('section-disk').click();
  const tiles = win.getByTestId('disk-tile');
  await expect(tiles).toHaveCount(9);
  await expect(tiles.first()).toContainText('Дизайн');
  await expect(win.getByTestId('disk-meter')).toBeVisible();
  await checkpoint(shot, 'disk-tiles');
});

test('disk-list', async ({ open, win, shot, theme }) => {
  test.skip(ONLY_DARK(theme), 'dark only');
  await open({ prefs: { diskView: 'list' } });
  await win.getByTestId('section-disk').click();
  await expect(win.getByTestId('disk-row')).toHaveCount(9);
  // A selected row (the «⋯» shows on it).
  await win.getByTestId('disk-row').filter({ hasText: 'Отчёт за квартал.pdf' }).click();
  await checkpoint(shot, 'disk-list');
  // CBF-22: type plates in «Проекты / Q4» and the previews (Space = Quick Look, ←/→ among the viewable files).
  await win.getByTestId('disk-row').filter({ hasText: 'Проекты' }).dblclick();
  await win.getByTestId('disk-row').filter({ hasText: 'Q4' }).dblclick();
  await expect(win.getByTestId('disk-row')).toHaveCount(4);
  await checkpoint(shot, 'disk-type-icons');
  await win.getByTestId('disk-row').filter({ hasText: 'План релиза.md' }).click();
  await win.keyboard.press('Space');
  await expect(win.getByTestId('disk-view-markdown')).toBeVisible();
  await checkpoint(shot, 'disk-preview-markdown');
  await win.keyboard.press('ArrowRight');
  await expect(win.getByTestId('disk-viewer')).toHaveAttribute('data-kind', /./);
  await win.keyboard.press('ArrowLeft');
  await expect(win.getByTestId('disk-view-markdown')).toBeVisible();
  await win.keyboard.press('Space');
  await expect(win.getByTestId('disk-viewer')).toHaveCount(0);
  await win.getByTestId('disk-row').filter({ hasText: 'Выгрузка продаж.csv' }).click();
  await expect(win.getByTestId('disk-row').filter({ hasText: 'Выгрузка продаж.csv' })).toHaveAttribute('data-selected', 'true');
  await win.keyboard.press('Space');
  await expect(win.getByTestId('disk-view-csv')).toBeVisible();
  await checkpoint(shot, 'disk-preview-csv');
  await win.keyboard.press('Escape');
  await win.getByTestId('disk-row').filter({ hasText: 'Подкаст' }).click();
  await win.keyboard.press('Space');
  await expect(win.getByTestId('audio-player')).toBeVisible();
  await checkpoint(shot, 'disk-preview-audio');
  await win.getByTestId('disk-crumb').filter({ hasText: 'Диск' }).first().click();
  await expect(win.getByTestId('disk-row')).toHaveCount(9);
  // CBF-21: «Колонки» — the root column, a folder opens the next one, a file adds the card column.
  await win.getByTestId('disk-view').getByRole('radio', { name: 'Колонки' }).click();
  await expect(win.getByTestId('disk-column')).toHaveCount(1);
  await win.getByTestId('disk-col-row').filter({ hasText: 'Проекты' }).click();
  await expect(win.getByTestId('disk-column')).toHaveCount(2);
  await win.keyboard.press('ArrowRight');
  await expect(win.getByTestId('disk-column')).toHaveCount(3);
  await checkpoint(shot, 'disk-columns');
  await win.getByTestId('disk-col-row').filter({ hasText: 'Отчёт за квартал.pdf' }).click();
  await expect(win.getByTestId('disk-col-preview')).toBeVisible();
  await expect(win.getByTestId('disk-column')).toHaveCount(1);
  await checkpoint(shot, 'disk-columns-card');
});

test('disk-trash', async ({ open, win, shot, theme }) => {
  test.skip(ONLY_DARK(theme), 'dark only');
  await open();
  await win.getByTestId('section-disk').click();
  await win.getByTestId('disk-more').click();
  await win.getByTestId('disk-open-trash').click();
  await expect(win.getByTestId('disk-trash-row')).toHaveCount(2);
  await expect(win.getByTestId('disk-empty-trash')).toBeVisible();
  await checkpoint(shot, 'disk-trash');
});

test('disk-share', async ({ open, win, shot }) => {
  await open();
  await win.getByTestId('section-disk').click();
  await win.getByTestId('disk-tile').filter({ hasText: 'Договоры' }).click({ button: 'right' });
  await win.getByTestId('disk-menu-access').click();
  const dialog = win.getByTestId('disk-access');
  await expect(dialog.getByTestId('disk-access-row')).toHaveCount(2);
  await expect(dialog.getByRole('switch', { name: 'Только выбранные' })).toBeChecked();
  await checkpoint(shot, 'disk-share');
  // CBF-20: a file without a viewer opens its card (no download), «Отправить в чат» opens the picker.
  await win.keyboard.press('Escape');
  await win.getByTestId('disk-tile').filter({ hasText: 'Бюджет 2026.xlsx' }).click({ button: 'right' });
  await win.getByTestId('disk-menu-open').click();
  await expect(win.getByTestId('disk-file-card')).toBeVisible();
  await checkpoint(shot, 'disk-file-card');
  await win.getByTestId('disk-card-send').click();
  await expect(win.getByTestId('forward-dialog')).toBeVisible();
  await checkpoint(shot, 'disk-send-to-chat');
});
