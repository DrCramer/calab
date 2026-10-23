import { create } from '@bufbuild/protobuf';
import { CANVAS_BITS, CanvasPermissionEntrySchema, PermissionTargetType } from '@calaba/protocol';
import type { Page } from '@playwright/test';
import { IDS } from '../e2e-support/fixtures';
import { expect, test } from './app';
import { checkpoint } from './harness';

/**
 * «Холст» on the desktop (ADR-0126 §5, docs/08 «Холст»): one test, one `checkpoint` per state —
 * the empty section, the tree + an open canvas (stickies, shapes, connectors, a text), a selected
 * object with its properties panel, «только просмотр», the history dialog, the «Доступ» dialog and
 * the trash. Fixture (e2e-support/mock-server seedCanvas): «Команда Calab» — «Продукт» (→ «Дорожная
 * карта Q1», «Ретро-доска»), «Дизайн» (→ «Схема навигации»), «Планирование спринта», «Черновики»
 * (restricted); in the trash «Старая схема» and the folder «Архив». The read-only canvas is added by
 * the test («Протокол встречи», Борис's, Анна has «Просмотр» only). Projects `canvas-dark-960`
 * (everything) and `canvas-light-960` (the «Доступ» dialog only). The phone's section is H6, not here.
 *
 *   CALABA_VISUAL_WORKERS=1 CALABA_VISUAL_MOCK_PORT=4750 MOCK_LIVEKIT_ROOM_PREFIX=canvas_ \
 *     pnpm -F @calaba/desktop e2e:visual -g "canvas"
 */

/** The first sticky of «Дорожная карта Q1» is at world (0,0); the objects span x 0…600, y −80…340. */
const FIT = { cx: 300, cy: 130, w: 600, h: 420 } as const;

/** The screen point of a world point right after «Показать всё» (scale ≤ 1, padding 48, the box centred). */
async function atWorld(win: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = await win.getByTestId('canvas-surface').boundingBox();
  if (!box) throw new Error('no canvas surface');
  const s = Math.min(1, (box.width - 96) / FIT.w, (box.height - 96) / FIT.h);
  return { x: box.x + box.width / 2 + (x - FIT.cx) * s, y: box.y + box.height / 2 + (y - FIT.cy) * s };
}

/** Fits the content and waits for the camera animation and the first frame. */
async function fitted(win: Page): Promise<void> {
  await expect(win.getByTestId('canvas-surface')).toBeVisible();
  await win.getByTestId('canvas-fit-all').click();
  await win.waitForTimeout(900);
}

async function openRoadmap(win: Page): Promise<void> {
  await win.getByTestId('section-canvas').click();
  await expect(win.getByTestId('canvas-node').first()).toBeVisible();
  const product = win.getByTestId('canvas-node').filter({ hasText: 'Продукт' });
  await product.getByTestId('canvas-node-toggle').click();
  await win.getByTestId('canvas-node').filter({ hasText: 'Дорожная карта Q1' }).getByTestId('canvas-node-open').click();
  await expect(win.getByTestId('canvas-title')).toHaveText('Дорожная карта Q1');
  // The sync socket delivered the seeded document and left «Подключение…» behind.
  await expect(win.getByTestId('canvas-connecting')).toHaveCount(0);
  await fitted(win);
}

test('canvas-screen', async ({ open, win, mock, shot, theme }) => {
  if (theme === 'dark') {
    // 1. An empty section: no canvas open, nothing in the tree.
    await open();
    mock.canvas.items.clear();
    await win.getByTestId('section-canvas').click();
    await expect(win.getByTestId('canvas-empty')).toBeVisible();
    await checkpoint(shot, 'canvas-empty');

    // 2. The tree and an open canvas: stickies, a shape, a text, three connectors.
    await open();
    await openRoadmap(win);
    await expect(win.getByTestId('canvas-node')).toHaveCount(6);
    await expect(win.getByTestId('canvas-toolbar')).toBeVisible();
    await checkpoint(shot, 'canvas-tree');

    // 3. A selected sticky and its properties panel.
    const p = await atWorld(win, 300, 80);
    await win.mouse.click(p.x, p.y);
    await expect(win.getByTestId('canvas-props')).toBeVisible();
    await win.waitForTimeout(300);
    await checkpoint(shot, 'canvas-selected');

    // 4. «Только просмотр»: a canvas of someone else's private folder with «Просмотр» only.
    await open();
    const anna = IDS.users.anna;
    const boris = IDS.users.boris;
    const minutes = mock.canvas.put({ workspaceId: IDS.workspaces.main, name: 'Протокол встречи', ownerId: boris, restricted: true }, (d) => {
      d.create({ kind: 'sticky', x: 0, y: 0, color: 'blue', text: 'Решения' });
      d.create({ kind: 'sticky', x: 220, y: 0, color: 'yellow', text: 'Вопросы' });
      d.create({ kind: 'shape', shape: 'rounded', x: 110, y: 220, text: 'Итог' });
    });
    mock.canvas.perms.set(minutes.id, [create(CanvasPermissionEntrySchema, { targetType: PermissionTargetType.USER, targetId: anna, allow: CANVAS_BITS.VIEW })]);
    await win.getByTestId('section-canvas').click();
    await win.getByTestId('canvas-node').filter({ hasText: 'Протокол встречи' }).getByTestId('canvas-node-open').click();
    await expect(win.getByTestId('canvas-view-only')).toBeVisible();
    await expect(win.getByTestId('canvas-toolbar')).toHaveCount(0);
    await expect(win.getByTestId('canvas-connecting')).toHaveCount(0);
    await win.getByTestId('canvas-fit-all').click();
    await win.waitForTimeout(900);
    await checkpoint(shot, 'canvas-view-only');

    // 5. The history: «Восстановить» is live (the open canvas registered its document).
    await open();
    await openRoadmap(win);
    await win.getByTestId('canvas-more').click();
    await win.getByTestId('canvas-menu-versions').click();
    await expect(win.getByTestId('canvas-version-row')).toHaveCount(2);
    await win.getByTestId('canvas-version-row').first().click();
    await expect(win.getByTestId('canvas-version-restore')).toBeEnabled();
    await checkpoint(shot, 'canvas-versions');
  }

  // 6. «Доступ» (dark and light).
  await open();
  await win.getByTestId('section-canvas').click();
  await win.getByTestId('canvas-node').filter({ hasText: 'Черновики' }).getByTestId('canvas-node-open').click();
  await expect(win.getByTestId('canvas-title')).toHaveText('Черновики');
  await win.getByTestId('canvas-share').click();
  const dialog = win.getByTestId('canvas-share-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('switch', { name: 'Только выбранные' })).toBeChecked();
  await checkpoint(shot, 'canvas-share');

  if (theme === 'dark') {
    // 7. The trash: a canvas and a folder; a trashed canvas shows the restore banner.
    await open();
    await win.getByTestId('section-canvas').click();
    await win.getByTestId('canvas-open-trash').click();
    await expect(win.getByTestId('canvas-trash-row')).toHaveCount(2);
    await win.getByTestId('canvas-trash-row').first().getByRole('button').first().click();
    await expect(win.getByTestId('canvas-trashed')).toBeVisible();
    await checkpoint(shot, 'canvas-trash');
  }
});
