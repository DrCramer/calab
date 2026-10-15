import { RecordingStatus } from '@calaba/protocol';
import type { Page } from '@playwright/test';
import { IDS, type MockServer } from '../e2e-support/mock-server';
import { expect, signIn, test } from './calendarWeb';

/**
 * A tall row in the virtualised feed (owner, 15.10: «I expand a meeting recording, scroll through
 * it and it throws me down, everything flickers»): a meeting card with a long summary scrolled
 * past folded, unfolded, scrolled far away (the row unmounts) and back — the text under the
 * reader never jumps, the card comes back unfolded; unfolding the last row at the bottom keeps
 * its top where it was (no pin to the end of the text). The web build in Chromium on a small and
 * a large window and at phone width; behaviour only, no screenshots.
 *
 *   pnpm -F @calaba/desktop build:web && pnpm -F @calaba/desktop exec playwright test --config playwright.visual.config.ts --project feed-scroll
 */

const SIZES = [
  { width: 960, height: 600 },
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];
/** One wheel notch, px. */
const STEP = 100;
/** How far the text under the reader may drift from the wheel's distance (sub-pixel rounding). */
const DRIFT = 3;

function longSummary(): string {
  const lines: string[] = [];
  for (let s = 1; s <= 8; s++) {
    lines.push(`## Раздел ${s}`);
    for (let i = 1; i <= 8; i++) lines.push(`- Пункт ${s}.${i}: обсудили длинную тему, договорились, что делаем дальше и кто отвечает`);
  }
  return lines.join('\n');
}

/** The meeting card (a 72-line summary) in «общий», then `after` messages under it. */
function seed(mock: MockServer, after: number): string {
  const msg = mock.injectRecordingCard({ roomId: IDS.rooms.general, byUserId: IDS.users.boris, durationSec: 3600, status: RecordingStatus.DONE, result: true });
  const p = msg.system?.payload;
  if (p?.case === 'recording') p.value.summary = longSummary();
  for (let i = 0; i < after; i++) mock.injectMessage({ roomId: IDS.rooms.general, authorId: i % 2 ? IDS.users.vera : IDS.users.boris, content: `Сообщение после записи ${i + 1}` });
  return msg.id;
}

async function openRoom(page: Page, mock: MockServer, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await signIn(page, mock);
  if (size.width < 500) await page.getByText('общий').first().click();
  else await page.locator('aside').getByRole('button', { name: /общий/ }).first().click();
  const scroller = page.locator('[data-virtuoso-scroller]').first();
  await expect(scroller).toBeVisible();
  const box = await scroller.boundingBox();
  if (!box) throw new Error('no feed');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

interface Spot {
  top: number;
  max: number;
  /** The row under the feed's centre and its top (px from the viewport top). */
  anchor: string;
  anchorTop: number;
  /** The card's top, null while it is not mounted; its fold button's text. */
  cardTop: number | null;
  button: string | null;
}

const spot = (page: Page, card: string): Promise<Spot> =>
  page.evaluate((card) => {
    const el = document.querySelector<HTMLElement>('[data-virtuoso-scroller]');
    if (!el) throw new Error('no feed');
    const r = el.getBoundingClientRect();
    const row = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest<HTMLElement>('[data-message-id]');
    const c = document.querySelector<HTMLElement>(`[data-message-id="${card}"]`);
    return {
      top: el.scrollTop,
      max: el.scrollHeight - el.clientHeight,
      anchor: row?.dataset['messageId'] ?? '',
      anchorTop: row ? row.getBoundingClientRect().top : 0,
      cardTop: c ? c.getBoundingClientRect().top : null,
      button: c?.querySelector('[data-testid="recording-card-more"]')?.textContent ?? null,
    };
  }, card);

const anchorTop = (page: Page, key: string): Promise<number | null> =>
  page.evaluate((key) => document.querySelector(`[data-message-id="${key}"]`)?.getBoundingClientRect().top ?? null, key);

/**
 * Wheels one notch at a time until `until` holds (at most `max` notches); after each the row that
 * was under the feed's centre must have moved by exactly the notch — a jump fails with where it
 * happened.
 */
async function wheel(page: Page, card: string, dy: number, until: (s: Spot) => boolean, max = 80): Promise<Spot> {
  let s = await spot(page, card);
  for (let i = 0; i < max && !until(s); i++) {
    await page.mouse.wheel(0, dy);
    await page.waitForTimeout(80);
    const moved = s.anchor ? await anchorTop(page, s.anchor) : null;
    const n = await spot(page, card);
    const clamped = (dy > 0 && n.top >= n.max - 1) || (dy < 0 && n.top <= 0);
    if (s.anchor && !clamped) {
      const where = `${dy > 0 ? 'down' : 'up'} #${i}, scrollTop ${Math.round(s.top)} → ${Math.round(n.top)}, card top ${n.cardTop === null ? '-' : Math.round(n.cardTop)}`;
      expect(moved, `the row under the reader unmounted (${where})`).not.toBeNull();
      expect(Math.abs((moved ?? 0) - s.anchorTop + dy), `the text under the reader jumped (${where})`).toBeLessThanOrEqual(DRIFT);
    }
    s = n;
  }
  expect(until(s), 'the scroll did not get there').toBe(true);
  return s;
}

const atBottom = (s: Spot): boolean => s.top >= s.max - 1;

for (const size of SIZES) {
  const name = `${size.width}x${size.height}`;

  test(`feed ${name}: a long meeting summary scrolled past, unfolded, far away and back`, async ({ page, mock }) => {
    const card = seed(mock, 30);
    await openRoom(page, mock, size);
    // Opened at the first unread row: down to the bottom, then up until the card's top is on screen.
    await wheel(page, card, 4 * STEP, atBottom, 30);
    await wheel(page, card, -STEP, (s) => s.cardTop !== null && s.cardTop > 120 && s.cardTop < size.height / 2);
    const more = page.locator(`[data-message-id="${card}"]`).getByTestId('recording-card-more');
    await expect(more).toHaveText('Показать всё');
    const before = await spot(page, card);
    await more.click();
    await expect(more).toHaveText('Свернуть');
    const after = await spot(page, card);
    expect(after.max, 'the card did not unfold').toBeGreaterThan(before.max + 1000);
    expect(Math.abs((after.cardTop ?? 0) - (before.cardTop ?? 0)), 'unfolding moved the card').toBeLessThanOrEqual(1);
    // Down through the summary and on to the bottom: the card unmounts (left behind the overscan).
    await wheel(page, card, STEP, atBottom);
    expect((await spot(page, card)).cardTop).toBeNull();
    // Back up to its top: it comes back unfolded, at the height the feed cached for it.
    const back = await wheel(page, card, -STEP, (s) => s.cardTop !== null && s.cardTop > 0);
    expect(back.button).toBe('Свернуть');
  });

  test(`feed ${name}: unfolding the last row at the bottom keeps its top`, async ({ page, mock }) => {
    const card = seed(mock, 0);
    await openRoom(page, mock, size);
    // The reader scrolls to the very bottom: the bottom pin sticks (lastRowPin.ts).
    await wheel(page, card, 4 * STEP, atBottom, 30);
    // Virtuoso itself scrolls to the bottom on a size increase for 100 ms after its data changes
    // (the room just loaded); a reader's click comes later.
    await page.waitForTimeout(300);
    const before = await spot(page, card);
    expect(before.cardTop).not.toBeNull();
    const more = page.locator(`[data-message-id="${card}"]`).getByTestId('recording-card-more');
    await more.click();
    await expect(more).toHaveText('Свернуть');
    await page.waitForTimeout(200);
    const after = await spot(page, card);
    expect(after.max, 'the card did not unfold').toBeGreaterThan(before.max + 1000);
    expect(Math.abs((after.cardTop ?? 0) - (before.cardTop ?? 0)), 'unfolding threw the reader to the end of the text').toBeLessThanOrEqual(1);
    // Read on down to the end and back up to the card's top without a jump.
    await wheel(page, card, STEP, atBottom);
    await wheel(page, card, -STEP, (s) => s.cardTop !== null && s.cardTop > 0);
  });
}
