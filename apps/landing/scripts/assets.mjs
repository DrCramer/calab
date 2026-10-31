// Landing v3 / README images (docs/09 #139) from the raw captures of
// apps/desktop/e2e-marketing/landing.spec.ts in apps/landing/shots/ (git-ignored):
// <scene>-<locale>@2x.png — the web client at 1440×900 CSS px, device scale 2, dark theme, the UI and
// the team in the landing locale (ru, en, es, zh → folder zh-CN). The whole-window scenes (voice, chat-full, kanban-full,
// calendar-week, canvas, phone-call, phone-incoming, wiki-full, disk-full, mail) are OS captures of the macOS app window
// instead (e2e-marketing/app-window.ts): the native title bar with the traffic lights, rounded transparent corners, and its
// bar is 46 px tall (the web's is 38) — crops cut out of them are 8 px lower than in the web captures.
// Output, per locale (folder = the locale's BCP 47 tag, as <html lang>):
// - public/screens/<lang>/<name>@2x.webp — the crop at full resolution, <name>.webp — a 1x
//   Lanczos resample and, for crops wider than 720 px, <name>-720.webp (phones); every file ≤ 300 KB (quality steps down from 88 until it fits).
// - a crop with `focus` also gets <name>-focus@2x.webp / <name>-focus.webp (≤ 720 px wide, the phones' <source>): `focus.own` —
//   a capture of its own, <scene>-focus-<locale>@2x.png, in a window as wide as the panel (so the crop follows the panel's
//   border, not the middle of a message); otherwise the rectangle is cut out of the scene's crop (CSS px of the crop).
// - `--check` verifies, without writing, that every scene of src/lib/screens.ts has its files in every language with the
//   sizes the table says (crop × 2 at @2x, ×1, 720 wide, focus) and that none is over 300 KB; CROPS must equal SCREENS.
// - public/og/<lang>.png — 1200×630 OpenGraph card: the hero window on the brand gradient.
// The README files (README*.md) use public/screens/<lang>/<name>.webp directly.
// Usage: pnpm -F @calaba/landing assets [--only=a,b] [--check]
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'shots');
const out = join(root, 'public/screens');
const og = join(root, 'public/og');
const SCALE = 2;
const LOCALES = { ru: 'ru', en: 'en', es: 'es', zh: 'zh-CN' };
const MAX = 300_000;

// Crops in CSS px of the 1440×900 window. The sizes here are the width/height the pages use
// (src/lib/screens.ts) — change both together (`--check` compares them). `focus` (≤ 720 px wide, for phones) is
// `{ left, top, width, height, own? }`: with `own` the rectangle is cut from a capture of its own in a window as wide as the
// panel (<scene>-focus-<locale>@2x.png), without it from the scene's crop (CSS px of the crop). `from: '<scene>'` cuts the
// crop out of that scene's capture (its overlay included) instead of a capture of its own; without the raw capture it is
// cut out of the scene's committed @2x file, so a tile can be re-cut without a new capture.
export const CROPS = {
  // hero: the whole window in a call — the shared slide on the stage, cameras, the room list
  voice: { left: 0, top: 0, width: 1440, height: 900, focus: { left: 329, top: 39, width: 720, height: 560, own: true } },
  // landing v6 (docs/plans/landing-v6.md §5): one day of a team — the chat, the board, the week, the wiki
  'chat-full': { left: 0, top: 0, width: 1440, height: 900, focus: { left: 329, top: 39, width: 720, height: 560, own: true } },
  'kanban-full': { left: 0, top: 0, width: 1440, height: 900, focus: { left: 329, top: 89, width: 720, height: 560, own: true } },
  'calendar-week': { left: 0, top: 0, width: 1440, height: 900, focus: { left: 329, top: 39, width: 720, height: 560, own: true } },
  canvas: { left: 0, top: 0, width: 1440, height: 900, focus: { left: 333, top: 39, width: 720, height: 560, own: true } },
  'canvas-panel': { left: 333, top: 39, width: 860, height: 538 },
  // landing v6, continued
  // the phones' crop and the catalogue tile keep the call island of the sidebar (a narrow window shows the chat only)
  'phone-call': { left: 0, top: 0, width: 1440, height: 900, focus: { left: 0, top: 346, width: 720, height: 548 } },
  // an incoming call ringing over the chat (hero «Телефония и IVR»); the story's frame is the call sheet with the chat around it
  'phone-incoming': { left: 0, top: 0, width: 1440, height: 900, focus: { left: 360, top: 170, width: 720, height: 560 } },
  'story-incoming': { from: 'phone-incoming', left: 340, top: 230, width: 760, height: 440 },
  // the disk in a 1056×660 window (16:10, the nine tiles fill it; hero «Облачный диск»)
  // hero «Почта»: the whole mail window as is; the phones' crop is the open message (the reading pane)
  'mail-window': { from: 'mail', left: 0, top: 0, width: 1440, height: 758, focus: { left: 713, top: 39, width: 720, height: 560 } },
  'disk-full': { left: 0, top: 0, width: 1056, height: 660, focus: { left: 76, top: 44, width: 720, height: 560 } },
  // settings windows: the pane to the right of the section list (the dialog is 920 px wide; a tile shows ≤ 860)
  'telephony-ivr': { left: 481, top: 131, width: 698, height: 330 },
  'telephony-groups': { left: 481, top: 131, width: 698, height: 330 },
  // the three live calls, as tall as the IVR and groups frames (below the title bar, above the call journal)
  'telephony-call': { left: 481, top: 180, width: 698, height: 330 },
  // the role block (name, colour, mentions), above the permission sections (their rows wrap differently per language)
  roles: { left: 481, top: 131, width: 698, height: 338 },
  'recording-focus': { left: 329, top: 39, width: 860, height: 538 },
  'recording-transcript': { left: 284, top: 108, width: 860, height: 230 },
  aitask: { left: 434, top: 232, width: 576, height: 440 },
  rail: { left: 0, top: 39, width: 72, height: 560 },
  'story-message': { left: 329, top: 131, width: 860, height: 420 },
  'story-task': { left: 329, top: 39, width: 860, height: 860 },
  'story-meeting': { left: 1120, top: 39, width: 320, height: 560 },
  'story-wiki': { left: 527, top: 318, width: 720, height: 520 },
  'phone-canvas': { left: 0, top: 0, width: 390, height: 844 },
  'wiki-full': { left: 0, top: 0, width: 1440, height: 900, focus: { left: 333, top: 89, width: 720, height: 560, own: true } },
  // chat: the room header (with «… печатает») and the room list column, the feed down to the composer: the mockup's end, a reply
  // quote, short lines of four people with reactions, my last one read (the capture's window is 1280×800)
  chat: { left: 0, top: 38, width: 1040, height: 762 },
  // one-to-one call: the DM with «Звонок · 00:00 · Завершить», the island
  call: { left: 0, top: 30, width: 1440, height: 870 },
  // calendar: the day with the planning meeting's card
  calendar: { left: 330, top: 30, width: 1110, height: 870 },
  // «Подобрать время»: busy columns, the green free window, the picked slot
  findtime: { left: 330, top: 30, width: 1110, height: 870 },
  // boards
  kanban: { left: 330, top: 30, width: 1110, height: 600 },
  timeline: { left: 330, top: 30, width: 1110, height: 870, focus: { left: 329, top: 89, width: 720, height: 560, own: true } },
  task: { left: 930, top: 30, width: 510, height: 870 },
  // the guest's waiting card
  guest: { left: 420, top: 220, width: 600, height: 460 },
  // landing v4 (e2e-marketing/landing-v4.spec.ts): SIP dialer popover over the room header and the members
  sipdial: { left: 330, top: 30, width: 1110, height: 300 },
  // the phone line in the room list («В разговоре 02:14») + the members column
  siproom: { left: 0, top: 30, width: 1440, height: 500 },
  // workspace settings → Телефония: the provider card / the connection test and the call journal
  sipsettings: { left: 250, top: 120, width: 940, height: 660 },
  siplog: { left: 250, top: 120, width: 940, height: 660 },
  // the «Продажи» web app open from its rail icon (the tip with its name), the bot's daily summary
  // laid over the bottom right (OVERLAYS below)
  webapps: { left: 0, top: 30, width: 1440, height: 870 },
  // Calab 2.0 (e2e-marketing/landing-v2.spec.ts)
  // the task panel with two named checklists
  checklists: { left: 960, top: 30, width: 480, height: 870 },
  // board settings windows: «Фичи», «Вебхук» (Business)
  boardfeatures: { left: 250, top: 120, width: 940, height: 660 },
  boardhook: { left: 250, top: 120, width: 940, height: 660 },
  // workspace settings → SSO: the connection, the sign-in policy
  sso: { left: 250, top: 120, width: 940, height: 660 },
  ssopolicy: { left: 250, top: 120, width: 940, height: 660 },
  // «Разрешить вход в приложение?» (OAuth consent)
  consent: { left: 440, top: 215, width: 560, height: 480 },
  // built-in «Calab Stikers»: chat and the picker
  stickerchat: { left: 330, top: 30, width: 1110, height: 870 },
  stickerpicker: { left: 330, top: 30, width: 1110, height: 870 },
  // the room list: people in a voice room and «Войти»
  voicelist: { left: 0, top: 30, width: 340, height: 440 },
  // Landing 3.3 (e2e-marketing/landing-v5.spec.ts, landing-mail.spec.ts)
  // the desktop mail client (Electron, its window is 1440×758 CSS px on the capture machine)
  // the message list (the panel left of the reading pane) is the phones' crop
  mail: { left: 0, top: 0, width: 1440, height: 758, focus: { left: 73, top: 39, width: 381, height: 560 } },
  // the board with the opened task on «История»
  taskhistory: { left: 330, top: 30, width: 1110, height: 870 },
  // settings → Уведомления: the task triggers / their end with «Передавать боту»
  notify: { left: 260, top: 130, width: 920, height: 640 },
  notifyrelay: { left: 260, top: 130, width: 920, height: 640 },
  // a video meeting in «Галерея»: the 2 × 2 camera grid only (tiles at 341,214–1189,694 + 12 px)
  gallery: { left: 335, top: 202, width: 860, height: 504 },
  // «Диск» as tiles: folders (one restricted), files with thumbnails, the storage meter (window 1060×600)
  disk: { left: 70, top: 30, width: 990, height: 570 },
  // «Вики»: the page tree with branches open and a page with a cover, a checklist, a table and two carets (window 1060×780)
  wiki: { left: 70, top: 30, width: 990, height: 750 },
  // ⌘K with the unified search sections
  search: { left: 390, top: 115, width: 660, height: 650 },
  // the phone (iPhone 14 viewport, 390×844): rooms, chat, «В голосе», a board
  'phone-rooms': { left: 0, top: 0, width: 390, height: 844 },
  'phone-chat': { left: 0, top: 0, width: 390, height: 844 },
  'phone-voice': { left: 0, top: 0, width: 390, height: 844 },
  'phone-board': { left: 0, top: 0, width: 390, height: 844 },
  // Landing v6 catalogue tiles (≤ 860 px wide, so a 568 px tile shows them at ≥ 0.66): `from` = cut out of another
  // scene's capture (window coordinates), no capture of their own
  // the whole history down to the composer (a shorter cut would end mid-list: rows wrap differently per language)
  'disk-panel': { from: 'disk', left: 70, top: 87, width: 860, height: 513 },
  // the bot's summary card laid over the dashboard (OVERLAYS.webapps) + 24 px
};

// A second capture laid over a crop as a floating card (CSS px from the crop's right / bottom edge,
// rounded, a hairline border and a soft shadow): webapps = the sales dashboard + the bot's daily summary.
const OVERLAYS = {
  webapps: { from: 'webapps-bot', right: 36, bottom: 36, radius: 16 },
};

/** sharp composite inputs: the card's shadow, the rounded card, its border — at the crop's bottom right. */
async function floating(file, cw, ch, bw, bh, { right, bottom, radius }) {
  const r = radius * SCALE;
  const left = bw - right * SCALE - cw;
  const top = bh - bottom * SCALE - ch;
  const blur = 24 * SCALE;
  const shadow = await sharp(Buffer.from(`<svg width="${cw + blur * 2}" height="${ch + blur * 2}" xmlns="http://www.w3.org/2000/svg"><rect x="${blur}" y="${blur + 8 * SCALE}" width="${cw}" height="${ch}" rx="${r}" fill="#000" fill-opacity=".7"/></svg>`))
    .blur(blur / 2)
    .png()
    .toBuffer();
  const card = await sharp(file)
    .composite([{ input: Buffer.from(`<svg width="${cw}" height="${ch}"><rect width="${cw}" height="${ch}" rx="${r}" ry="${r}"/></svg>`), blend: 'dest-in' }])
    .png()
    .toBuffer();
  const border = Buffer.from(`<svg width="${cw}" height="${ch}" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="${cw - 2}" height="${ch - 2}" rx="${r - 1}" fill="none" stroke="#ffffff" stroke-opacity=".14" stroke-width="2"/></svg>`);
  return [
    { input: shadow, left: left - blur, top: top - blur },
    { input: card, left, top },
    { input: border, left, top },
  ];
}

/** A scene's crop of its raw capture as a PNG buffer, with its floating overlay card (OVERLAYS) laid over. */
async function sceneCrop(name, crop, short) {
  const base = sharp(join(src, `${name}-${short}@2x.png`)).extract(scaled(crop));
  const layer = OVERLAYS[name];
  if (!layer) return base.png().toBuffer();
  const card = join(src, `${layer.from}-${short}@2x.png`);
  if (!existsSync(card)) throw new Error(`missing ${card}: run the landing captures first`);
  const { width: cw = 0, height: ch = 0 } = await sharp(card).metadata();
  const { width: bw, height: bh } = scaled(crop);
  // Flattened first: sharp composites after a resize, and the 1x copies are resized.
  return sharp(await base.png().toBuffer()).composite(await floating(card, cw, ch, bw, bh, layer)).png().toBuffer();
}

// `--only=sipdial,siproom` regenerates just those images (raw captures of the other scenes are not needed,
// the existing files stay untouched; the OpenGraph cards are redrawn only when `voice` is in the list).
// A scene whose raw capture is missing is skipped (its committed files stay), unless `--strict`.
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',');
const strict = process.argv.includes('--strict');

const scaled = (c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Math.round(v * SCALE)]));

async function webp(pipeline, file) {
  for (let q = 88; q >= 40; q -= 6) {
    const buf = await pipeline.clone().webp({ quality: q, effort: 6, smartSubsample: true }).toBuffer();
    if (buf.length <= MAX || q <= 46) {
      await sharp(buf).toFile(file);
      return buf.length;
    }
  }
  return 0;
}

/** `name: { width, height, focus?: { width, height } }` of src/lib/screens.ts, read as text (no TS toolchain here). */
async function readScreens() {
  const text = await readFile(join(root, 'src/lib/screens.ts'), 'utf8');
  const table = {};
  const re = /^\s*'?([\w-]+)'?:\s*\{\s*width:\s*(\d+),\s*height:\s*(\d+)(?:,\s*focus:\s*\{\s*width:\s*(\d+),\s*height:\s*(\d+)\s*\})?\s*\},/gm;
  for (const m of text.matchAll(re)) table[m[1]] = { width: +m[2], height: +m[3], ...(m[4] ? { focus: { width: +m[4], height: +m[5] } } : {}) };
  return table;
}

/** The files of a scene and the pixel sizes each one must have (docs/plans/landing-v6.md §5, rule 6). */
function expected(name, { width, height, focus }) {
  const files = [
    [`${name}@2x.webp`, width * SCALE, height * SCALE],
    [`${name}.webp`, width, height],
  ];
  if (width > 720) files.push([`${name}-720.webp`, 720, Math.round((height * 720) / width)]);
  if (focus) files.push([`${name}-focus@2x.webp`, focus.width * SCALE, focus.height * SCALE], [`${name}-focus.webp`, focus.width, focus.height]);
  return files;
}

async function check() {
  const screens = await readScreens();
  const problems = [];
  const names = Object.keys(CROPS);
  for (const n of names) if (!screens[n]) problems.push(`CROPS.${n} has no entry in src/lib/screens.ts`);
  for (const n of Object.keys(screens)) if (!CROPS[n]) problems.push(`screens.ts ${n} has no CROPS entry`);
  for (const n of names) {
    const s = screens[n];
    const c = CROPS[n];
    if (!s) continue;
    if (c.width !== s.width || c.height !== s.height) problems.push(`${n}: CROPS ${c.width}×${c.height} ≠ screens.ts ${s.width}×${s.height}`);
    if ((c.focus?.width ?? 0) !== (s.focus?.width ?? 0) || (c.focus?.height ?? 0) !== (s.focus?.height ?? 0)) problems.push(`${n}: CROPS focus ≠ screens.ts focus`);
    if (c.focus && c.focus.width > 720) problems.push(`${n}: focus is wider than 720 px`);
  }
  let count = 0;
  for (const lang of Object.values(LOCALES)) {
    for (const [n, s] of Object.entries(screens)) {
      for (const [file, w, h] of expected(n, s)) {
        const path = join(out, lang, file);
        if (!existsSync(path)) {
          problems.push(`${lang}/${file}: missing`);
          continue;
        }
        count++;
        const size = (await stat(path)).size;
        if (size > MAX) problems.push(`${lang}/${file}: ${(size / 1000).toFixed(0)} KB > 300 KB`);
        const m = await sharp(path).metadata();
        if (m.width !== w || m.height !== h) problems.push(`${lang}/${file}: ${m.width}×${m.height}, expected ${w}×${h}`);
      }
    }
  }
  if (problems.length) {
    console.error(`${problems.length} problem(s):\n${problems.join('\n')}`);
    process.exit(1);
  }
  console.log(`assets --check: ${names.length} scenes × ${Object.keys(LOCALES).length} languages, ${count} files OK`);
}

if (process.argv.includes('--check')) {
  await check();
  process.exit(0);
}

let total = 0;
const kb = (n) => (n / 1000).toFixed(0);
// `--lang=ru,en` limits the languages (development)
const onlyLang = process.argv.find((a) => a.startsWith('--lang='))?.slice(7).split(',');
for (const [short, lang] of Object.entries(LOCALES)) {
  if (onlyLang && !onlyLang.includes(short)) continue;
  const dir = join(out, lang);
  await mkdir(dir, { recursive: true });
  for (const [name, crop] of Object.entries(CROPS)) {
    if (only && !only.includes(name)) continue;
    const committed = join(dir, `${name}@2x.webp`);
    // The scene itself: the raw capture, cropped (a `from` crop: cut out of that scene's crop, overlay included). Without
    // the raw one the committed @2x file stands in as the source of the focus only — and of a `from` crop, its scene's @2x.
    let base;
    const parent = crop.from ? CROPS[crop.from] : undefined;
    const inner = parent && scaled({ left: crop.left - parent.left, top: crop.top - parent.top, width: crop.width, height: crop.height });
    const raw = join(src, `${crop.from ?? name}-${short}@2x.png`);
    let fresh = existsSync(raw);
    if (fresh) {
      base = sharp(await sceneCrop(crop.from ?? name, parent ?? crop, short));
      if (inner) base = sharp(await base.extract(inner).png().toBuffer());
    } else if (inner && existsSync(join(dir, `${crop.from}@2x.webp`))) {
      base = sharp(await sharp(join(dir, `${crop.from}@2x.webp`)).extract(inner).png().toBuffer());
      fresh = true;
    } else if (existsSync(committed)) base = sharp(committed);
    else if (strict) throw new Error(`missing ${raw}: run the landing captures first`);
    else continue;
    const parts = [];
    if (fresh) {
      const big = await webp(base.clone(), join(dir, `${name}@2x.webp`));
      const small = await webp(base.clone().resize({ width: crop.width, kernel: 'lanczos3' }), join(dir, `${name}.webp`));
      // Phones: a 720 px wide file (the 1x one would be 2× too large for a 390 pt screen at 2x).
      const phone = crop.width > 720 ? await webp(base.clone().resize({ width: 720, kernel: 'lanczos3' }), join(dir, `${name}-720.webp`)) : 0;
      total += big + small + phone;
      parts.push(`@2x ${kb(big)} KB, 1x ${kb(small)} KB${phone ? `, 720 ${kb(phone)} KB` : ''}`);
    }
    const f = crop.focus;
    if (f) {
      const own = join(src, `${name}-focus-${short}@2x.png`);
      let fbase;
      if (f.own) {
        if (!existsSync(own)) {
          if (strict) throw new Error(`missing ${own}: run the landing captures first`);
          console.log(`${lang}/${name}: focus capture missing, skipped`);
          continue;
        }
        fbase = sharp(own).extract(scaled(f));
      } else fbase = base.clone().extract(scaled(f));
      const fb = await webp(fbase.clone(), join(dir, `${name}-focus@2x.webp`));
      const fs1 = await webp(fbase.clone().resize({ width: f.width, kernel: 'lanczos3' }), join(dir, `${name}-focus.webp`));
      total += fb + fs1;
      parts.push(`focus @2x ${kb(fb)} KB, 1x ${kb(fs1)} KB`);
    }
    console.log(`${lang}/${name}: ${parts.join('; ')}`);
  }

  if ((only && !only.includes('voice')) || !existsSync(join(src, `voice-${short}@2x.png`))) continue;
  // OpenGraph: the hero window (top part) on a dark brand gradient, 1200×630.
  await mkdir(og, { recursive: true });
  const shot = await sharp(join(src, `voice-${short}@2x.png`))
    .resize({ width: 1080, kernel: 'lanczos3' })
    .extract({ left: 0, top: 0, width: 1080, height: 560 })
    .composite([{ input: Buffer.from('<svg width="1080" height="560"><rect width="1080" height="560" rx="18" ry="18"/></svg>'), blend: 'dest-in' }])
    .png()
    .toBuffer();
  const bg = Buffer.from(
    `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg"><defs><radialGradient id="g" cx="50%" cy="0%" r="90%"><stop offset="0" stop-color="#1f4fa0"/><stop offset="1" stop-color="#0e0e10"/></radialGradient></defs><rect width="1200" height="630" fill="url(#g)"/></svg>`,
  );
  await sharp(bg)
    .composite([{ input: shot, left: 60, top: 70 }])
    .png({ compressionLevel: 9, palette: true, quality: 90 })
    .toFile(join(og, `${lang}.png`));
}
console.log(`total ${(total / 1e6).toFixed(1)} MB`);
