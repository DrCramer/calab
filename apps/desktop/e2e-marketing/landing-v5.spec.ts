import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { create, toJson } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { SearchResponseSchema, SearchType, TaskNoticeKind, TaskPriority } from '@calaba/protocol';
import { chromium, devices, expect, test, webkit, type Browser, type Page } from '@playwright/test';
import { IDS, startMockServer, type MockServer } from '../e2e-support/mock-server';
import { NOW, PASSWORD, settle } from '../e2e-visual/harness';
import { startPublisher, type Publisher } from '../e2e-visual/publisher';
import { APP_LOCALE, COPY, type Copy, type Short } from './copy';
import { COPY3, type Copy3 } from './copy3';
import { mockupHtml, render } from './art';
import { cameraPhoto, dataUrl, heroStream } from './photos';
import { drawArt, msk, seedBoard, seedMeetings, seedNotes, seedScene } from './seed';

/**
 * Landing 3.3 scenes (docs/10 «Лендинг 3.3»): the task panel with «История», the notification
 * settings (task triggers + «Передавать боту»), the video gallery of a call, ⌘K unified search and
 * the phone (the web client on an iPhone 14 viewport: rooms, chat, «В голосе», a board). The same
 * web build, window and framing as landing.spec.ts (1440×900 CSS px, device scale 2, dark); data of
 * the deployed mock + copy.ts / copy3.ts, set through the mock's control methods (no app source).
 *
 *   pnpm -F @calaba/desktop build:web
 *   cd apps/desktop && CALABA_VISUAL_MOCK_PORT=5224 MOCK_LIVEKIT_ROOM_PREFIX=landing_ \
 *     pnpm exec playwright test --config playwright.marketing.config.ts landing-v5
 *
 * `-g "v5 gallery"` one scene, CALABA_LANDING_LOCALES=ru,en some languages. The gallery needs the dev
 * LiveKit (pnpm infra:dev). Raw captures: apps/landing/shots/<scene>-<locale>@2x.png (git-ignored);
 * `pnpm -F @calaba/landing assets` crops them (scripts/assets.mjs). The mailbox scene is Electron-only:
 * landing-mail.spec.ts.
 */
const OUT = resolve(import.meta.dirname, '../../landing/shots');
const DIST = resolve(import.meta.dirname, '../dist-web');
const SIZE = { width: 1440, height: 900 };
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const U = IDS.users;
const R = IDS.rooms;

const ALL: Short[] = ['ru', 'en', 'es', 'zh'];
const wanted = process.env['CALABA_LANDING_LOCALES']?.split(',').map((s) => s.trim());
const LOCALES = ALL.filter((s) => !wanted || wanted.includes(s));
const lkOpts = (): { livekitUrl?: string; livekitKey?: string; livekitSecret?: string } => ({
  ...(process.env['MOCK_LIVEKIT_URL'] ? { livekitUrl: process.env['MOCK_LIVEKIT_URL'] } : {}),
  ...(process.env['MOCK_LIVEKIT_KEY'] ? { livekitKey: process.env['MOCK_LIVEKIT_KEY'] } : {}),
  ...(process.env['MOCK_LIVEKIT_SECRET'] ? { livekitSecret: process.env['MOCK_LIVEKIT_SECRET'] } : {}),
});
const PREFIX = process.env['MOCK_LIVEKIT_ROOM_PREFIX'] || 'landing_';

/** The title bar's settings button in each language (the app's `settings.title`). */
const SETTINGS: Record<Short, string> = { ru: 'Настройки', en: 'Settings', es: 'Ajustes', zh: '设置' };

/** «Диск»: the fixture's folders (Проекты, Дизайн, Договоры) and files in each language. */
const DISK: Record<Short, { folders: [string, string, string]; files: [string, string, string, string, string, string] }> = {
  ru: { folders: ['Проекты', 'Дизайн', 'Договоры'], files: ['Обложка релиза.png', 'Мудборд коллекции.jpg', 'Офсайт команды.png', 'Отчёт за квартал.pdf', 'Бюджет 2026.xlsx', 'Демо продукта.mp4'] },
  en: { folders: ['Projects', 'Design', 'Contracts'], files: ['Release cover.png', 'Collection moodboard.jpg', 'Team offsite.png', 'Quarterly report.pdf', 'Budget 2026.xlsx', 'Product demo.mp4'] },
  es: { folders: ['Proyectos', 'Diseño', 'Contratos'], files: ['Portada de la versión.png', 'Moodboard de la colección.jpg', 'Offsite del equipo.png', 'Informe trimestral.pdf', 'Presupuesto 2026.xlsx', 'Demo del producto.mp4'] },
  zh: { folders: ['项目', '设计', '合同'], files: ['版本封面.png', '系列灵感板.jpg', '团队团建.png', '季度报告.pdf', '2026 预算.xlsx', '产品演示.mp4'] },
};

/** Safe-area insets of the phone shots: just enough to clear the landing's rounded device edge (landing 14.10 — no empty notch / home-indicator bands). */
const INSETS = { top: 12, bottom: 8 };

interface Ctx {
  browser: Browser;
  page: Page;
  mock: MockServer;
  c: Copy;
  c3: Copy3;
  short: Short;
  pubs: Publisher[];
  phone: boolean;
}

type Seed = (mock: MockServer, c: Copy, c3: Copy3) => void;

const aside = (page: Page) => page.locator('aside').first();

async function boot(short: Short, seed: Seed | undefined, phone: boolean): Promise<Ctx> {
  expect(existsSync(join(DIST, 'index.html')), 'dist-web is missing: run `pnpm build:web` first').toBe(true);
  const browser = phone
    ? await webkit.launch()
    : await chromium.launch({
        args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--allow-loopback-in-peer-connection', '--disable-features=WebRtcHideLocalIpsWithMdns', '--force-webrtc-ip-handling-policy=default_public_and_private_interfaces'],
      });
  const c = COPY[short];
  const c3 = COPY3[short];
  const mock = await startMockServer({ port: 0, scenario: 'data', staticDir: DIST, ...lkOpts() });
  mock.setClock(NOW.getTime());
  // The art (mockup, avatars) is drawn by Chromium also for the WebKit phone scenes.
  const artBrowser = phone ? await chromium.launch() : browser;
  seedScene(mock, c, await drawArt(artBrowser, c));
  if (phone) await artBrowser.close();
  seed?.(mock, c, c3);
  const context = phone
    ? await browser.newContext({ ...devices['iPhone 14'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'dark', locale: 'ru-RU', timezoneId: 'Europe/Moscow', reducedMotion: 'reduce' })
    : await browser.newContext({ viewport: SIZE, deviceScaleFactor: 2, colorScheme: 'dark', locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
  const page = await context.newPage();
  await page.clock.setFixedTime(NOW);
  const ctx: Ctx = { browser, page, mock, c, c3, short, pubs: [], phone };
  await page.goto(`${mock.url}/?visual-test`);
  await page.evaluate(() => localStorage.setItem('calaba-prefs', JSON.stringify({ state: { theme: 'dark', onboarded: true, locale: 'ru' }, version: 1 })));
  await page.goto(`${mock.url}/?visual-test`);
  if (phone) await insets(page);
  await page.getByLabel('Email').fill('owner@calaba.test');
  await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD);
  const signIn = page.getByRole('button', { name: 'Войти', exact: true });
  if (phone) await signIn.tap();
  else await signIn.click();
  if (phone) await expect(page.getByTestId('mobile-shell')).toBeVisible({ timeout: 30_000 });
  else await expect(aside(page)).toBeVisible({ timeout: 30_000 });
  return ctx;
}

async function insets(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `@media (max-width: 768px) { :root.web:not(.kb-open) { --safe-top: ${INSETS.top}px; --safe-bottom: ${INSETS.bottom}px; } }`,
  });
}

async function shutdown(ctx: Ctx | undefined): Promise<void> {
  if (!ctx) return;
  for (const p of ctx.pubs) await p.stop().catch(() => undefined);
  await ctx.browser.close().catch(() => undefined);
  await ctx.mock.close().catch(() => undefined);
}

async function setLocale(page: Page, short: Short): Promise<void> {
  const l = APP_LOCALE[short];
  await page.evaluate((x) => (window as unknown as { __calabaLocale?: (l: string) => void }).__calabaLocale?.(x), l);
  await expect(page.locator('html')).toHaveAttribute('lang', l);
}

async function shoot(ctx: Ctx, scene: string): Promise<void> {
  await ctx.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await settle(ctx.page);
  mkdirSync(OUT, { recursive: true });
  const path = join(OUT, `${scene}-${ctx.short}@2x.png`);
  await ctx.page.screenshot({ path, animations: 'disabled', caret: 'hide' });
  console.log(scene, ctx.short, `${(statSync(path).size / 1e6).toFixed(1)} MB`);
}

async function speaking(page: Page, ids: string[]): Promise<void> {
  await page.evaluate((list) => (window as unknown as { __calabaSpeaking?: (ids: string[]) => void }).__calabaSpeaking?.(list), ids);
}

async function feedBottom(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await page
      .locator('[data-virtuoso-scroller]')
      .first()
      .evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
      .catch(() => undefined);
    await settle(page);
  }
}

/** Someone in «Переговорка» (the mock's voice state; publishers make the media real where it shows). */
function inRoom(mock: MockServer, k: 'anna' | 'boris' | 'vera' | 'grigory' | 'dina', extra: { camera?: boolean; streaming?: boolean; muted?: boolean } = {}): void {
  mock.setVoiceState({ userId: U[k], roomId: R.meeting, joinedAtMs: NOW.getTime() - 14 * 60_000, ...extra });
}

/** Chromium's fake camera replaced by a camera photo (the page's own camera requests). */
async function fakeCamera(page: Page, frame: Buffer): Promise<void> {
  await page.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const cv = document.createElement('canvas');
    cv.width = 1280;
    cv.height = 720;
    const g = cv.getContext('2d');
    if (!g) return;
    const draw = (): void => g.drawImage(img, 0, 0, cv.width, cv.height);
    draw();
    setInterval(draw, 100);
    const stream = cv.captureStream(10);
    const md = navigator.mediaDevices;
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = async (constraints) => (constraints?.video ? new MediaStream(stream.getVideoTracks().map((t) => t.clone())) : orig(constraints));
  }, dataUrl(frame));
}

async function frames(page: Page, n: number): Promise<void> {
  await expect
    .poll(() => page.locator('video').evaluateAll((vs) => vs.filter((v) => (v as HTMLVideoElement).readyState >= 2 && (v as HTMLVideoElement).videoWidth > 0).length), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(n);
  await settle(page);
}

// ---------------------------------------------------------------- seeds

/** The landing board (seed.ts) without the fixture's board categories (their names are Russian). */
function board(mock: MockServer, c: Copy): void {
  seedBoard(mock, c);
  mock.boards.categories.clear();
}

/** The opened task's history (ADR-0091): two days of changes by the team, an automation, an approval. */
function seedHistory(mock: MockServer, c: Copy, c3: Copy3): void {
  board(mock, c);
  const b = mock.boards as unknown as {
    tasks: Map<string, { task: { id: string; boardId: string; title: string; description: string; statusId: string } }>;
    boards: Map<string, { board: { statuses: { id: string }[]; labels: { id: string; name: string; color: number }[] } }>;
    host: { tick: () => unknown; fanout: unknown };
    journal(t: unknown, actor: string, kind: string, before: object, after: object): { ruleId: string };
  };
  const open = [...b.tasks.values()].find((t) => t.task.title === c.board.tasks[c.board.open.index]?.title);
  if (!open) throw new Error('no opened task');
  const bd = b.boards.get(open.task.boardId)?.board;
  const st = (i: number): string => bd?.statuses[i]?.id ?? '';
  const label = (name: string): { id: string; name: string; color: number } => {
    const l = bd?.labels.find((x) => x.name === name);
    return { id: l?.id ?? '', name, color: l?.color ?? 0 };
  };
  const bug = label(c.board.labels.bug);
  const feature = label(c.board.labels.feature);
  const host = b.host;
  const clock = host.tick;
  const quiet = host.fanout;
  host.fanout = () => undefined;
  const log = (iso: string, actor: string, kind: string, before: object, after: object): { ruleId: string } => {
    host.tick = () => timestampFromMs(Date.parse(iso));
    return b.journal(open, actor, kind, before, after);
  };
  const msg = (n: number): string => `00000000-0000-7000-8000-0000000e${String(n).padStart(4, '0')}`;
  try {
    // 14 January.
    log('2026-01-14T09:10:00Z', U[c3.history.comment[0]], 'comment', {}, { message_id: msg(1), text: c3.history.comment[1], attachments: [] });
    log('2026-01-14T10:05:00Z', U.boris, 'labels', { label_ids: [bug.id, feature.id], labels: [bug, feature] }, { label_ids: [bug.id], labels: [bug] });
    log('2026-01-14T10:40:00Z', U.anna, 'watchers', { user_ids: [] }, { user_ids: [U.vera, U.grigory] });
    const rule = log('2026-01-14T15:00:00Z', '', 'status', { status_id: st(1) }, { status_id: st(2) });
    rule.ruleId = '00000000-0000-7000-8000-0000000a0001';
    // 15 January (today on the clock).
    log('2026-01-15T06:30:00Z', U.anna, 'dates', { start_on: '2026-01-12', due_on: '2026-01-20' }, { start_on: '2026-01-12', due_on: '2026-01-16' });
    log('2026-01-15T07:00:00Z', U.anna, 'priority', { priority: TaskPriority.HIGH }, { priority: TaskPriority.URGENT });
    log('2026-01-15T07:45:00Z', U.anna, 'assignees', { assignees: [{ user_id: U.boris, is_lead: true, note: '' }] }, { assignees: [{ user_id: U.boris, is_lead: true, note: '' }, { user_id: U.anna, is_lead: false, note: '' }] });
    log('2026-01-15T08:10:00Z', U.grigory, 'approval', { user_id: U.grigory, state: 'pending', comment: '' }, { user_id: U.grigory, state: 'approved', comment: c3.history.approval });
    log('2026-01-15T09:40:00Z', U.anna, 'description', { length: c3.history.oldDescription.length, text: c3.history.oldDescription }, { length: open.task.description.length, text: open.task.description });
  } finally {
    host.tick = clock;
    host.fanout = quiet;
  }
}

/** Two bots of the workspace: one relays my task notices (ADR-0090), a few triggers switched off (ADR-0089). */
function seedNotify(mock: MockServer, _c: Copy, c3: Copy3): void {
  mock.seedBots();
  const name = (id: string, n: string): void => {
    const u = mock.state.users.get(id);
    if (u) u.user.displayName = n;
  };
  name(IDS.bots.weather, c3.bots.relay);
  name(IDS.bots.deploy, c3.bots.other);
  mock.setBotAvatar(IDS.bots.weather, { bg: [42, 171, 238], fg: [255, 255, 255] });
  mock.setBotAvatar(IDS.bots.deploy, { bg: [52, 199, 89], fg: [255, 255, 255] });
  const me = mock.state.users.get(U.anna) as unknown as { settings: { taskNotifyBots: string[]; taskNotifyOff: number[] } } | undefined;
  if (me) {
    me.settings.taskNotifyBots = [IDS.bots.weather];
    me.settings.taskNotifyOff = [TaskNoticeKind.EDITED, TaskNoticeKind.ATTACHMENT, TaskNoticeKind.ARCHIVED];
  }
}

// ---------------------------------------------------------------- scenes

interface Scene {
  seed?: Seed;
  phone?: boolean;
  run(ctx: Ctx): Promise<void>;
}

/** Boards mode on «Продукт» (desktop). */
async function openBoards(ctx: Ctx): Promise<void> {
  await aside(ctx.page).getByRole('button', { name: new RegExp(ctx.c.rooms.general) }).first().click();
  await setLocale(ctx.page, ctx.short);
  await ctx.page.getByTestId('section-boards').click();
  await expect(ctx.page.getByTestId('kanban')).toBeVisible();
  await expect(ctx.page.getByTestId('task-card').first()).toBeVisible();
}

/** The phone in the page's language from a fresh render (list previews and memoized rows keep the old one). */
async function relocale(ctx: Ctx): Promise<void> {
  await setLocale(ctx.page, ctx.short);
  await ctx.page.reload();
  await insets(ctx.page);
  await expect(ctx.page.getByTestId('mobile-shell')).toBeVisible({ timeout: 30_000 });
  await expect(ctx.page.locator('html')).toHaveAttribute('lang', APP_LOCALE[ctx.short]);
}

/** «Команда» → a room of the list on the phone. */
async function phoneRoom(page: Page, name: string): Promise<void> {
  await page.getByTestId('phone-room-list').getByRole('button', { name: new RegExp(`^${name}`) }).first().tap();
  await expect(page.getByTestId('phone-tabbar')).toHaveCount(0);
  await expect(page.getByTestId('composer')).toBeVisible();
}

const scenes: Record<string, Scene> = {
  // The board with the opened task on «История» (ADR-0091): the timeline of changes under the properties.
  taskhistory: {
    seed: seedHistory,
    async run(ctx) {
      const { page, c } = ctx;
      await openBoards(ctx);
      const title = c.board.tasks[c.board.open.index]?.title ?? '';
      await page.getByTestId('task-card').filter({ hasText: title }).getByTestId('card-title').click();
      const panel = page.getByTestId('task-panel');
      const section = panel.getByTestId('task-activity');
      await expect(section).toBeVisible();
      await section.getByRole('radio').nth(1).click();
      await expect(section).toHaveAttribute('data-tab', 'history');
      await expect(section.getByTestId('history-row').first()).toBeVisible();
      await setLocale(page, ctx.short);
      await page.waitForTimeout(400);
      await section.evaluate((el) => el.scrollIntoView({ block: 'start' }));
      await shoot(ctx, 'taskhistory');
    },
  },

  // Settings → Уведомления → «Задачи»: the triggers and «Передавать боту».
  notify: {
    seed: seedNotify,
    async run(ctx) {
      const { page } = ctx;
      // The trigger rows are memoized: the dialog opens after the language switch (the app's «settings.title»).
      await setLocale(page, ctx.short);
      await page.getByRole('button', { name: SETTINGS[ctx.short], exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await dialog.getByRole('tab').nth(4).click();
      await expect(dialog.getByTestId('task-notify-me')).toBeVisible();
      await expect(dialog.getByTestId('task-notify-relay')).toBeVisible();
      await page.waitForTimeout(300);
      // The «Задачи» card at the top of the pane (desktop notifications and the sounds stay above / below).
      await dialog.getByTestId('task-notify-me').evaluate((el) => (el.closest('section') ?? el.parentElement ?? el).scrollIntoView({ block: 'start' }));
      await page.waitForTimeout(200);
      await shoot(ctx, 'notify');
      // The relay group at the bottom of the same card.
      await dialog.getByTestId('task-notify-relay').evaluate((el) => el.scrollIntoView({ block: 'end' }));
      await page.waitForTimeout(200);
      await shoot(ctx, 'notifyrelay');
    },
  },

  // A video meeting in «Галерея» (ADR-0066), the grid only (landing 14.10): my camera, Борис and Григорий on camera, Вера as an avatar tile — a clean 2 × 2.
  gallery: {
    seed: (mock) => {
      inRoom(mock, 'vera', { muted: true });
    },
    async run(ctx) {
      const { page, mock, c } = ctx;
      await aside(page).getByRole('button', { name: new RegExp(c.rooms.general) }).first().click();
      await fakeCamera(page, cameraPhoto('anna'));
      await aside(page).getByRole('button', { name: new RegExp(c.rooms.meeting) }).first().click();
      await aside(page).getByRole('button', { name: `Войти в голос «${c.rooms.meeting}»` }).click();
      await expect(page.getByText('Голос подключён')).toBeVisible({ timeout: 30_000 });
      await page.keyboard.press(`${MOD}+Shift+m`);
      await page.evaluate(() => (window as unknown as { __calabaJoinedAt?: (ms: number) => void }).__calabaJoinedAt?.(Date.now() - 14 * 60_000));
      await page.getByTestId('camera-button').click();
      await expect(page.getByTestId('camera-preview-enable')).toBeEnabled({ timeout: 15_000 });
      await page.getByTestId('camera-preview-enable').click();
      await expect(page.getByTestId('camera-button')).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
      for (const k of ['boris', 'grigory'] as const) {
        ctx.pubs.push(await startPublisher({ userId: U[k], name: c.people[k].name, roomId: R.meeting, source: 'camera', image: cameraPhoto(k) }));
        inRoom(mock, k, { camera: true, muted: k === 'grigory' });
      }
      const grid = page.getByTestId('video-grid');
      if (!(await grid.isVisible().catch(() => false))) {
        const expand = page.getByTestId('camera-pip').getByRole('button', { name: 'Развернуть видео' });
        await expect(expand.or(grid).first()).toBeVisible({ timeout: 30_000 });
        if (await expand.count()) await expand.first().click();
      }
      await expect(grid).toBeVisible();
      await expect(grid).toHaveAttribute('data-view', 'gallery');
      await expect(page.getByTestId('video-tile')).toHaveCount(4, { timeout: 30_000 });
      await frames(page, 3);
      await expect(page.getByRole('button', { name: /^Качество связи: Хорошее/ })).toBeVisible({ timeout: 15_000 });
      await speaking(page, [U.boris]);
      await setLocale(page, ctx.short);
      await page.waitForTimeout(1500);
      // The tiles' box (CSS px): CROPS.gallery in apps/landing/scripts/assets.mjs is this plus a margin.
      const box = await page.getByTestId('video-tile').evaluateAll((els) => {
        const rs = els.map((e) => e.getBoundingClientRect());
        return [Math.min(...rs.map((r) => r.left)), Math.min(...rs.map((r) => r.top)), Math.max(...rs.map((r) => r.right)), Math.max(...rs.map((r) => r.bottom))].map(Math.round);
      });
      console.log('gallery tiles', box.join(','));
      await shoot(ctx, 'gallery');
    },
  },

  // ⌘K: one query over messages, tasks, meetings, files, notes and meeting transcripts (ADR-0062).
  search: {
    seed: (mock, c) => {
      board(mock, c);
      seedNotes(mock, c);
    },
    async run(ctx) {
      const { page, mock, c, c3 } = ctx;
      const planning = seedMeetings(mock, c);
      const tasks = [...(mock.boards as unknown as { tasks: Map<string, { task: { id: string; boardId: string; key: string; title: string; description: string } }> }).tasks.values()];
      const task = (i: number) => tasks.find((t) => t.task.title === c.board.tasks[i]?.title)?.task;
      const shelf = [...mock.state.rooms.values()].find((r) => r.name === c.notes.shelves[0]?.[0]);
      const hits = {
        messages: c3.search.messages.map(([k, s], i) => ({ snippet: s, workspaceId: IDS.workspaces.main, at: timestampFromMs(msk(i ? '11:20' : '12:05')), authorId: U[k], ref: { case: 'message' as const, value: { messageId: `00000000-0000-7000-8000-0000000c000${i + 1}`, roomId: i ? R.dev : R.general } } })),
        tasks: [4, 3, 8].map((i) => {
          const t = task(i);
          return { snippet: '', title: t?.title ?? '', workspaceId: IDS.workspaces.main, at: timestampFromMs(msk('10:00')), authorId: U.anna, ref: { case: 'task' as const, value: { taskId: t?.id ?? '', boardId: t?.boardId ?? '', key: t?.key ?? '', statusType: 2 } } };
        }),
        comments: (() => {
          const t = task(c.board.open.index);
          return [{ snippet: c3.search.comment, workspaceId: IDS.workspaces.main, at: timestampFromMs(msk('09:31')), authorId: U.boris, ref: { case: 'taskComment' as const, value: { messageId: '00000000-0000-7000-8000-0000000c0011', roomId: R.general, taskId: t?.id ?? '', taskKey: t?.key ?? '', taskTitle: t?.title ?? '' } } }];
        })(),
        events: [{ snippet: '', title: c.calendar.release, workspaceId: IDS.workspaces.main, at: timestampFromMs(msk('16:00')), authorId: U.anna, ref: { case: 'event' as const, value: { eventId: planning, occurrenceStart: timestampFromMs(msk('16:00')), occurrenceEnd: timestampFromMs(msk('17:00')), roomId: R.meeting, recurring: false } } }],
        files: [{ snippet: '', title: c3.search.file, workspaceId: IDS.workspaces.main, at: timestampFromMs(msk('10:42')), authorId: U.vera, ref: { case: 'file' as const, value: { fileId: '00000000-0000-7000-8000-0000000c0021', messageId: '00000000-0000-7000-8000-0000000c0022', roomId: R.general, mime: 'application/pdf', size: 482_113n } } }],
        notes: [{ snippet: c3.search.note, workspaceId: '', at: timestampFromMs(msk('12:48')), authorId: U.anna, ref: { case: 'note' as const, value: { messageId: '00000000-0000-7000-8000-0000000c0031', roomId: shelf?.id ?? '' } } }],
        transcripts: [{ snippet: c3.search.transcript, workspaceId: IDS.workspaces.main, at: timestampFromMs(msk('10:00', '2026-01-14')), authorId: '', ref: { case: 'transcript' as const, value: { recordingId: '00000000-0000-7000-8000-0000000c0041', roomId: R.meeting, offsetMs: 754_000n, messageId: '' } } }],
      };
      const body = toJson(
        SearchResponseSchema,
        create(SearchResponseSchema, {
          sections: [
            { type: SearchType.MESSAGES, items: hits.messages, totalEstimate: 14 },
            { type: SearchType.TASKS, items: hits.tasks, totalEstimate: 6 },
            { type: SearchType.TASK_COMMENTS, items: hits.comments, totalEstimate: 3 },
            { type: SearchType.EVENTS, items: hits.events, totalEstimate: 2 },
            { type: SearchType.FILES, items: hits.files, totalEstimate: 2 },
            { type: SearchType.NOTES, items: hits.notes, totalEstimate: 1 },
            { type: SearchType.TRANSCRIPTS, items: hits.transcripts, totalEstimate: 4 },
          ],
        }),
      );
      await page.route('**/api/search?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }));
      await aside(page).getByRole('button', { name: new RegExp(c.rooms.general) }).first().click();
      await setLocale(page, ctx.short);
      await page.keyboard.press(`${MOD}+k`);
      const qs = page.getByTestId('quick-switcher');
      await expect(qs).toBeVisible();
      await page.keyboard.type(c3.search.q);
      await expect(qs.getByTestId('search-hit').first()).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(600);
      await shoot(ctx, 'search');
    },
  },

  // «Диск» (ADR-0094) as tiles: the team's folders (one restricted — the lock), files with real
  // thumbnails, a video with a public link, the storage meter. The mock's Disk fixture, renamed to
  // the page language, its pictures replaced by real ones.
  disk: {
    async run(ctx) {
      const { page, mock, c, short } = ctx;
      const names = DISK[short];
      const team = readFileSync(resolve(import.meta.dirname, '../../landing/public/editorial/team-conversation.webp'));
      const pics: Record<string, { bytes: Buffer; mime: string; w: number; h: number }> = {
        cover: { bytes: await render(ctx.browser, mockupHtml(c), 1600, 900), mime: 'image/png', w: 1600, h: 900 },
        board: { bytes: heroStream(), mime: 'image/jpeg', w: 1280, h: 720 },
        team: { bytes: await render(ctx.browser, `<img src="data:image/webp;base64,${team.toString('base64')}" style="display:block;width:1200px;height:800px;object-fit:cover">`, 1200, 800), mime: 'image/png', w: 1200, h: 800 },
      };
      // Fixture name → [the page language's name, the picture that replaces the file's bytes].
      const map: Record<string, [string, string?]> = {
        Проекты: [names.folders[0]],
        Дизайн: [names.folders[1]],
        Договоры: [names.folders[2]],
        'Обложка релиза.png': [names.files[0], 'cover'],
        'Офис.png': [names.files[1], 'board'],
        'Исходники.zip': [names.files[2], 'team'],
        'Отчёт за квартал.pdf': [names.files[3]],
        'Бюджет 2026.xlsx': [names.files[4]],
        'Демо продукта.mp4': [names.files[5]],
      };
      for (const it of mock.disk.items.values()) {
        const m = map[it.name];
        if (!m) continue;
        it.name = m[0];
        if (!it.file) continue;
        it.file.name = m[0];
        const pic = m[1] ? pics[m[1]] : undefined;
        const rec = mock.state.files.get(it.file.id);
        if (!pic || !rec) continue;
        it.file.mime = pic.mime;
        if (m[1] === 'team') it.file.size = 5_412_000n;
        it.file.thumbnailUrl = `/api/files/${it.file.id}/thumbnail`;
        it.file.width = pic.w;
        it.file.height = pic.h;
        rec.meta = it.file;
        rec.bytes = pic.bytes;
        rec.thumbnail = { bytes: pic.bytes, mime: pic.mime };
      }
      await setLocale(page, short);
      // A smaller window: two full rows of tiles above the storage meter, no empty floor.
      await page.setViewportSize({ width: 1060, height: 600 });
      await page.getByTestId('section-disk').click();
      const tiles = page.getByTestId('disk-tile');
      await expect(tiles).toHaveCount(9, { timeout: 15_000 });
      await expect(page.getByTestId('disk-meter')).toBeVisible();
      await expect.poll(() => page.locator('[data-testid="disk-tile"] img').evaluateAll((l) => l.filter((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0).length), { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
      await page.mouse.move(0, 599);
      await page.waitForTimeout(600);
      await shoot(ctx, 'disk');
    },
  },

  // ---- the phone (iPhone 14, the web client)

  // «Команда»: rooms like a messenger — the last message and who is in voice.
  'phone-rooms': {
    phone: true,
    seed: (mock) => {
      inRoom(mock, 'boris');
      inRoom(mock, 'vera', { muted: true });
      inRoom(mock, 'grigory', { muted: true });
    },
    async run(ctx) {
      const { page } = ctx;
      await relocale(ctx);
      await expect(page.getByTestId('phone-room-list').getByTestId('phone-room-row').first()).toBeVisible();
      await page.waitForTimeout(400);
      await shoot(ctx, 'phone-rooms');
    },
  },

  // «общий» on the phone: the morning thread.
  'phone-chat': {
    phone: true,
    async run(ctx) {
      const { page, c } = ctx;
      await relocale(ctx);
      await phoneRoom(page, c.rooms.general);
      await page.waitForTimeout(800);
      await feedBottom(page);
      await shoot(ctx, 'phone-chat');
    },
  },

  // The voice room's header stack → «В голосе»: who is there and «Присоединиться».
  'phone-voice': {
    phone: true,
    seed: (mock) => {
      inRoom(mock, 'boris');
      inRoom(mock, 'vera', { muted: true });
      inRoom(mock, 'grigory', { muted: true });
    },
    async run(ctx) {
      const { page, c } = ctx;
      await relocale(ctx);
      await phoneRoom(page, c.rooms.meeting);
      await page.getByTestId('room-voice-people').tap();
      const card = page.getByTestId('voice-people-card');
      await expect(card.getByTestId('voice-people-row')).toHaveCount(3);
      await page.waitForTimeout(500);
      await shoot(ctx, 'phone-voice');
    },
  },

  // «Доски» → «Продукт» as columns.
  'phone-board': {
    phone: true,
    seed: (mock, c) => board(mock, c),
    async run(ctx) {
      const { page, c } = ctx;
      await relocale(ctx);
      await page.getByTestId('phone-tab-boards').tap();
      const nav = page.getByTestId('phone-boards');
      await nav.getByTestId('board-row').filter({ hasText: c.board.name }).getByRole('button').first().tap();
      await page.getByTestId('board-more').tap();
      await page.getByTestId('view-kanban').tap();
      const kanban = page.getByTestId('kanban');
      await expect(kanban.getByTestId('kanban-column').first()).toBeVisible();
      await kanban.evaluate((el) => {
        const cols = el.querySelectorAll('[data-testid="kanban-column"]');
        (cols[2] as HTMLElement | undefined)?.scrollIntoView({ inline: 'start', block: 'nearest' });
      });
      await page.waitForTimeout(600);
      await shoot(ctx, 'phone-board');
    },
  },
};

for (const [name, scene] of Object.entries(scenes)) {
  for (const short of LOCALES) {
    test(`landing v5 ${name} ${short}`, async () => {
      test.setTimeout(240_000);
      process.env['MOCK_LIVEKIT_ROOM_PREFIX'] = `${PREFIX}v5_${name}_${short}_${Date.now().toString(36)}_`;
      let ctx: Ctx | undefined;
      try {
        ctx = await boot(short, scene.seed, scene.phone ?? false);
        await scene.run(ctx);
      } finally {
        await shutdown(ctx);
      }
    });
  }
}
