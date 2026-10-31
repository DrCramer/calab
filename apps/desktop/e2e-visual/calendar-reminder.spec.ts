import { IDS } from '../e2e-support/mock-server';
import { expect, planerka, signIn, test } from './calendarWeb';

/**
 * Reminders (docs/20 C.7): EVENT_REMINDER → a system notification «Через 15 минут: Планёрка ·
 * Переговорка» (the Notification constructor is stubbed — no real OS notification) and the same
 * in-app toast with «Перейти в комнату», which opens the room and joins its voice.
 */
test('EVENT_REMINDER → notification + toast; «Перейти в комнату» asks, then joins the room', async ({ page, mock }) => {
  const id = planerka(mock);
  await page.addInitScript(() => {
    const w = window as unknown as { __notes: Array<{ title: string; body: string }>; Notification: unknown };
    w.__notes = [];
    class FakeNotification {
      static permission = 'granted';
      static requestPermission = (): Promise<string> => Promise.resolve('granted');
      onclick: (() => void) | null = null;
      constructor(title: string, opts: { body?: string } = {}) {
        w.__notes.push({ title, body: opts.body ?? '' });
      }
      close(): void {}
    }
    w.Notification = FakeNotification;
  });
  await signIn(page, mock);
  await expect(page.getByRole('heading', { name: 'общий' })).toBeVisible();

  mock.emitReminder(id, IDS.users.anna, 15);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __notes: unknown[] }).__notes)).toEqual([
    { title: 'Через 15 минут: Планёрка · Переговорка', body: 'Перейти в комнату' },
  ]);
  const toast = page.getByText('Через 15 минут: Планёрка · Переговорка').first();
  await expect(toast).toBeVisible();
  const join = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/api/rooms/${IDS.rooms.meeting}/join`));
  await page.getByRole('button', { name: 'Перейти в комнату' }).click();
  // A click asks first (owner, 29.10): no join until «Войти в комнату» in the dialog.
  await expect(page.getByTestId('join-confirm')).toContainText('Планёрка');
  await page.getByTestId('join-confirm-go').click();
  await expect(page.getByRole('heading', { name: 'Переговорка' }).first()).toBeVisible();
  await join;
});
