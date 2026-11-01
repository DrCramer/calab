# @calaba/landing — calab.io

Marketing landing for **Calab**. Next.js 15 (`output: 'export'`) + Tailwind v4, no server: the build is plain static
files in `out/`. Localized (ADR-0022 §3): `ru` (source), `en`, `es`, `zh-CN`.

## Commands

```sh
pnpm -F @calaba/landing dev        # http://localhost:3000
pnpm -F @calaba/landing build      # → apps/landing/out (index.html, ru/ en/ es/ zh/, 404.html, robots.txt, sitemap.xml, manifest)
pnpm -F @calaba/landing lint
pnpm -F @calaba/landing typecheck
pnpm -F @calaba/landing assets     # regenerate public/screens/<lang>/*.webp and public/og/<lang>.png
```

Preview the export: `npx -y serve apps/landing/out` (or `python3 -m http.server -d apps/landing/out`).

## Localization

- Routes: `/ru/`, `/en/`, `/es/`, `/zh/` and `/<locale>/bots/` (Bot API page, ADR-0031; docs link: ru → `docs/19-bot-api.md`, others → `.en.md`) — pages per locale (`src/app/[locale]/`, `generateStaticParams`,
  `dynamicParams = false`), `<html lang>`, title/description/OG, canonical and `hreflang` (+ `x-default → /en/`) per locale.
- `/` is `out/index.html` from `src/app/index.html/route.ts`: a content-less redirect page (no React runtime). Order:
  the switcher's saved choice (`localStorage['calab.locale']`, only with unexpired storage permission) → `navigator.languages` (first supported: ru/uk/be/kk →
  `ru`, zh* → `zh`, es* → `es`, en* → `en`) → `/en/`. Query and `#hash` are kept, so old `calab.io/#download` links
  (release notes, `/download/` fallback in Caddy) land on `/<locale>/#download`. Without JS: `<noscript>` meta refresh
  to `/en/`. In `next dev` it is served at `/index.html`, not `/`.
- Texts: `src/i18n/<locale>.ts`, typed by `ru.ts` (`Dict`): a missing or extra key fails `typecheck`. `{name}`
  placeholders become links/`<code>` via `rich()` (`src/lib/rich.tsx`) — keep them in every locale. Terms follow
  `docs/i18n-glossary.md` (workspace/espacio/工作区, room/sala/房间, screen share/pantalla compartida/屏幕共享 …);
  «Powered by GPTunneL» and product/tech names are never translated. es/zh are agent translations, native review pending.
- Language switcher: header pill (`locale-switcher.tsx`, native `<details>` + links, works without JS); names in their own
  language (Русский · English · Español · 中文); with JS and permission it saves the choice and keeps the page path.
- `404.html` is shared by all locales (English + links to each language). Caddy redirects unknown locale prefixes
  (`/de/`, `/pt-BR/…`) to `/en/` and `/ru` → `/ru/`.
- Screenshots follow the page: `Screen` (`components/ui.tsx`) loads `public/screens/<lang>/<name>` — the app UI *and*
  its team (names, rooms, chat, meetings, board) in that language, dark theme in both page themes. OpenGraph image per
  locale: `public/og/<lang>.png`. The home page carries schema.org `SoftwareApplication` JSON-LD in its language.
- `public/llms.txt` (summary + links, llmstxt.org format) and `public/llms-full.txt` (full text) are served at the site root as-is; keep their plan table, limits and feature list in sync with `src/i18n/en.ts` and the README, and mark unreleased features as planned.

## Plan prices from the server (ADR-0083)

Team/Business prices, the «≈ per 30 days» line, the ₽/$ switch and the paid buttons come from `GET {APP_URL}/api/billing/public/offers`
(`lib/offers.ts` parse/pick/format, `lib/offers-store.ts` one lazy fetch after hydration, `components/plan-prices.tsx` leaves).
The page is prerendered with a build-time snapshot (`SNAPSHOT`, equal to the dictionaries' prices; paid buttons = the intake form), so
first paint is final and nothing shifts; the answer only swaps text. Mode: `both` → ₽ for `ru`, $ otherwise, an explicit switch
click wins and is kept in the `calab_market` cookie (only with the «preferences» permission); `ru_only` → ₽, `global_only` → $, `contact` → $ and
«On request» to the server's contact link. Open sales → «Set up in the app». Cross-origin: the server sends CORS for this one GET to
`PUBLIC_LANDING_URLS` (compose: `https://$LANDING_HOST`), the landing CSP `connect-src` allows the app origin (`APP_ORIGIN` in Caddy
entrypoint). Unreachable/invalid answer → the snapshot stays. `pnpm test:offers` checks the mode → market/currency rules.
Payment return pages `/onpay/success/` and `/onpay/fail/` (Tochka merchant URLs): static, noindex, language picked in the browser, no query echo.

## «Add mail to Calab» link (ADR-0088 §12)

`/<locale>/#mail=<base64url(email[:password])>` shows `components/mail-link-card.tsx` (parse: `lib/mail-link.ts`, `pnpm test:mail-link`): the address, a `calab://mail/<payload>` button, a download fallback; phones get a hint instead. Only the fragment is read (`?mail=` is ignored); the password is never decoded, stored or sent; closing the card removes the fragment.

## Public agreements and browser preferences

RU uses Gromtekh / RUB 6 and 18 per employee/day; other locales are priced in USD $0.10 and $0.30.
`content/legal.json` is the RU edition; `content/legal-global.json` is the English Global edition.
Six documents × four locale paths; canonical legal URLs use RU or EN respectively. ES/ZH
keep localized navigation and explicitly identify English legal text. The previous monthly
edition is kept in `content/legal-archive/` and is not imported into pages.

The corner panel uses `lib/site-preferences.ts`; consent is optional-off by default, versioned
and expires after 180 days. It controls real language persistence in both the switcher and
the root redirect. Analytics (Yandex Metrika, `components/yandex-metrika.tsx`, loaded only after the visitor opts in) is active; marketing is prepared but inactive. Before enabling
a provider: disclose recipients/purposes/lifetimes, bump the consent version, update parser
and root-router validation together, and gate loading plus withdrawal through the purpose
check. Never add a tracker via an unconditional script. Active now: preferences and analytics. The landing CSP (`infra/docker/caddy/sites.caddy`) allows `mc.yandex.ru/.com` + `yastatic.net` for it.
Run `pnpm -F @calaba/landing test:preferences` for consent and root-router regression checks.
Metrika goals (`lib/metrika.ts`, delegated clicks in `components/goal-tracking.tsx`; `goal()` is a no-op without consent, nothing is queued): `download_click` {os}, `open_web_app`, `plan_buy_click` {plan}, `payment_success` (OnPay success page), `contact_click`, `support_chat_open` (first click into the chat widget), `pricing_view` (one IntersectionObserver), `docs_open`. Ids must match the JS-event goals in Metrika exactly.
UTM passthrough: `utm_*`/`yclid` of the landing URL are kept in sessionStorage and appended to `APP_URL` links at click time so the app can attribute signups; no personal data and no third party, so it works without consent.
Server-side conversions (ADR-0135): after consent the tag's ClientID (`ym(…, 'getClientID')`) is appended to `APP_URL` links as `ym_cid` (never without consent; forgotten on withdrawal). The web client keeps `utm_*`/`yclid`/`ym_cid` of the first open and sends them with the registration; the server reports the goals `signup` and `purchase` (amount, currency, plan, payment id) over the Measurement Protocol. The desktop app opened from an installer gets no landing params, so desktop sign-ups are not attributed.
No analytics SDK, third-party CMP or payment functionality is enabled by these pages.

## Where it is served

`https://calab.io` — Caddy `file_server` from `/srv/landing` (see `docs/10-branding.md`, `LANDING_HOST`); the old
`https://calab.ru` redirects there (301, same path — `LANDING_HOST_ALIASES`).
Copy the contents of `out/` there. `trailingSlash: true`, so every page `/x/` is exported as `x/index.html`.
Links: «Открыть в браузере» → `https://app.calab.io`, downloads → direct links to the stable names
`https://releases.calab.io/latest/<file>` (`DOWNLOADS` in `src/lib/site.ts`; the main button picks the visitor's OS
in the browser, the version comes from `latest/VERSION`, never versioned file names), licence and support → the public CALAB intake form (`CONTACT_FORM_URL`), source → `https://github.com/itrcz/calab` (`REPO_URL` in `src/lib/site.ts`; LICENSE/SECURITY/TRADEMARKS links point to `blob/main/…`).

## Design

Follows `docs/08-design.md`: system font stack, one accent (`#0A84FF`/`#007AFF`, white-on-accent fills use
`#0071e3`), 4 px grid, solid materials only (no `backdrop-filter`, the sticky header too), light/dark
via `prefers-color-scheme` only, motion only under `prefers-reduced-motion: no-preference`, no infinite animations.
Tokens live in `src/app/globals.css`. Landing 3.3 (docs/10 «Лендинг 3.3»): the home page is hero → «Что есть в Calab» (`feature-catalog.tsx`,
`i18n/catalog.ts`: every big feature as a screenshot + 1–2 sentences, two columns, one on phones) → «Уведомления»
(`notifications.tsx`) → «Скоро: iPhone и Android» (`mobile-soon.tsx`) → scenarios → access → pricing → download → FAQ;
the detailed sections stay on `/<locale>/features/` (now with «Почта» and «Поиск»). Landing v3 (docs/09 #139): hero with the whole app window, then sections in
the order voice/video → sound quality → phone calls (SIP) → chat → calendar → boards → notes → guests → web apps → bots → self-hosted →
performance (measured numbers only, docs/14-energy.md / docs/18) → pricing (Free · Team · Business · Enterprise = your own server) → download → FAQ.
Landing v4 added the SIP, sound, web-apps and performance blocks and the four-plan table; plan limits live in `src/i18n/*.ts`
(`pricing.table.cells`), keep them equal to the server's plans (ADR-0024) and to the `README*.md` tables.
Screenshots sit in a solid dark `.shot-frame` (the app is dark in every shot). All components are server components
except `download-primary.tsx` (OS detection + `latest/VERSION`), the language switcher and the cookie preferences controls; the FAQ uses native
`<details>`, so the page works without JS (the Next runtime chunk still ships, ~100 kB).

Performance: the hero shot is preloaded with its `srcset` and `fetchpriority=high` (phone 720 w ≈ 30 KB, 1x ≈ 80 KB,
2x ≈ 170 KB); every other shot is lazy with `sizes`, so phones fetch the `-720` files. Lighthouse on the built page
(served compressed, as Caddy does): mobile 99 / 100 / 100 / 100 (perf / a11y / best practices / SEO), desktop 100.

## Updating screenshots

Every scene is captured per language with that language's team (docs/09 #139).

1. Captures — `apps/desktop/e2e-marketing/landing.spec.ts`: the production web build (`dist-web`) served by the mock
   API, Chromium at 1440×900 CSS px, device scale 2, dark. Data per language: `e2e-marketing/copy.ts`; people are real
   photos (avatars and camera frames, `e2e-marketing/photos/`, the person→photo table in `photos.ts`); stickers are
   the built-in Calab ones (`apps/server/internal/builtinstickers`); the shared slide and the chat mockup are drawn by
   Chromium (`art.ts`);
   the scene data is set on the mock before sign-in (`seed.ts`). Dev LiveKit running (`pnpm infra:dev`) for the voice
   and call scenes; one Playwright run at a time:
   ```sh
   pnpm -F @calaba/desktop build:web
   cd apps/desktop
   CALABA_VISUAL_MOCK_PORT=5224 MOCK_LIVEKIT_ROOM_PREFIX=landing_ pnpm exec playwright test --config playwright.marketing.config.ts landing
   ```
   `CALABA_LANDING_LOCALES=ru,en` narrows the languages, `-g "landing kanban"` one scene. Raw PNGs land in
   `apps/landing/shots/<scene>-<locale>@2x.png` (git-ignored). Scenes: `voice` (hero: stream + cameras), `chat`,
   `call`, `calendar`, `findtime`, `kanban`, `timeline`, `task`, `notes`, `guest`.
   Landing 3.3 scenes are in `e2e-marketing/landing-v5.spec.ts` (`taskhistory`, `notify`, `notifyrelay`, `gallery`,
   `search`, and the phone: `phone-rooms`, `phone-chat`, `phone-voice`, `phone-board` — WebKit at 390×844, scale 2; data in
   `copy3.ts`) and `e2e-marketing/landing-mail.spec.ts` (`mail`: the built Electron app, `pnpm build:app`, with the renderer's
   mail mock bundled by esbuild over `mail-fixtures.ts` answering `mail:request` in main — no IMAP server, no app source).
   Landing v4 scenes (`sipdial`, `siproom`, `sipsettings`, `siplog`, `webapps`) are in `e2e-marketing/landing-v4.spec.ts`
   (`... playwright test --config playwright.marketing.config.ts landing-v4`): the mock's SIP account and calls
   (`setSip`, `placeSipCall`), the rail apps via `mock.dispatch(workspaceAppUpsert)` and a local dashboard page as the "site".
2. `pnpm -F @calaba/landing assets` — `scripts/assets.mjs` crops (CSS px at the top of the script, equal to
   `src/lib/screens.ts`), writes `public/screens/<lang>/<name>@2x.webp`, `<name>.webp` (1x) and `<name>-720.webp`
   (phones), each ≤ 300 KB, and `public/og/<lang>.png` (1200×630). `node scripts/assets.mjs --only=sipdial,webapps` regenerates
   just those images (no other raw captures needed; OpenGraph is redrawn only when `voice` is listed). The READMEs (`README*.md`) use the same files.
3. Landing v6 (docs/plans/landing-v6.md §5): `e2e-marketing/landing-v6.spec.ts` (data `copy4.ts`, shared seeds `v6-kit.ts`,
   `v6-canvas.ts`, `v6-seeds.ts`) — one day of the «Нордлайт» team: a request in the chat → the task APP-7 → the review
   → the wiki page → the retro canvas → a phone call, plus the telephony, role, recording and AI windows.
   ```sh
   livekit-server --dev            # the call scenes (voice, canvas, phone-call) need the dev LiveKit
   cd apps/desktop && CALABA_VISUAL_WORKERS=1 MOCK_LIVEKIT_ROOM_PREFIX=landing_ \
     pnpm exec playwright test --config playwright.marketing.config.ts landing-v6
   ```
   `CALABA_LANDING_LOCALES=ru,en` narrows the languages, `CALABA_V6_SCENES=chat-full,chat-full-focus` the captures (a
   scene with a phone crop has a second capture, `<scene>-focus`, taken in a window as wide as the panel so the crop follows
   the panel's border, never the middle of a message), `CALABA_V6_TIMEOUT` the per-test limit in ms.
   Scenes (name — crop in CSS px, see `CROPS` in `scripts/assets.mjs`): `voice`, `chat-full`, `kanban-full`, `calendar-week`,
   `canvas`, `phone-call`, `wiki-full`, `timeline`, `mail` — 1440×900 (`timeline` 1110×870, `mail` 1440×758) with a phone
   `focus` (720×560, `mail` 381×560); catalogue tiles ≤ 860 wide: `chat-focus`, `wiki-focus`, `canvas-panel`,
   `phone-call-panel`, `recording-focus` (860×538), `recording-transcript`, `story-*`; windows: `telephony-ivr`,
   `telephony-groups`, `telephony-call`, `roles` (the settings pane), `temp-room`, `aitask`; `rail`, `phone-canvas`.
   The chat scenes show the pinned request, a reply with a quote, a voice note, a sticker and the APP-7 card; the telephony
   frames run on the mock's exchange renamed in `v6-seeds.ts`; the retro canvas's vote is finished and its 04:32 timer paused
   (a running one counts from the server clock, which the frozen page clock cannot follow).
4. `pnpm -F @calaba/landing assets` — `scripts/assets.mjs` crops (CSS px at the top of the script, equal to
   `src/lib/screens.ts`), writes `public/screens/<lang>/<name>@2x.webp`, `<name>.webp` (1x), `<name>-720.webp`
   (phones, scenes wider than 720) and, for a crop with `focus`, `<name>-focus@2x.webp` / `<name>-focus.webp`, each ≤ 300 KB,
   and `public/og/<lang>.png` (1200×630). `focus.own` means the rectangle is cut from the `<scene>-focus-<locale>@2x.png`
   capture, otherwise from the scene's own crop (a scene without a raw capture keeps its committed files and only gets its
   focus from the committed @2x). `--only=sipdial,webapps` regenerates just those, `--lang=ru` one language,
   `--strict` fails on a missing capture. A crop with `from: '<scene>'` (the catalogue tiles `voice-panel`, `kanban-panel`,
   `timeline-panel`, `taskhistory-panel`, `findtime-panel`, `disk-panel`, `mail-panel`, `notifyrelay-panel`, `webapps-panel`,
   `bot-card`, `phone-call-panel`) is cut out of that scene's capture — or, without one, out of its committed @2x file — so a tile
   can be re-cut without a new capture; every crop ends at a panel's edge in all four languages. The READMEs (`README*.md`) use the same files.
5. `node scripts/assets.mjs --check` (no captures needed) — every scene of `src/lib/screens.ts` has its files in all four
   languages with the sizes the table says, none over 300 KB, `CROPS` equals `SCREENS`.
6. Rebuild and commit `public/screens` and `public/og`.

## TODO

- Telegram channel in the footer when there is one (contact now: the CALAB intake form).
- FAQ hardware estimate («ориентировочно 4 vCPU и 8 ГБ» for up to 30 users) comes from the compose memory limits,
  not a load test — refine after the load test.
