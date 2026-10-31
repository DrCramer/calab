# iOS catch-up: independent implementation reviews (2026-10-26)

Both original passes targeted `cf8919c934867f576687a7390a926c7e91ba1a0e` against `e0018e108`. Each CLI result independently reported `claude-opus-5-5` in modelUsage and `is_error=false`. The text below is the reviewers' assessment of that commit, before the corrections listed next. It is not a distribution approval.

## Lead disposition

- Main M1: accepted the reviewer's documentation alternative. Scope is recognized application routes only; public Canvas, RSVP, public Disk and unknown same-origin paths retain the existing native restriction. Added explicit fallback boundary tests and a UI backlog item. No allowlist expansion or page replacement.
- Main M2: React, ReactDOM, React types and TypeScript are excluded from the ordinary tooling update group. Manifest-based review now applies only when those SDK-sensitive names change. Test/lint devDependencies may auto-merge normally. Local shell cases cover mobile React, mobile tooling, desktop-only React, combined names and API failure.
- Configured server origins now canonicalize through URL.origin. Three failing uppercase/default-port regressions pass after the fix; origin lookalikes stay external. Protocol-relative external URLs have a dedicated test.
- Disk anchor href is canonicalized, including copy/native link behavior. Opening still dispatches synchronously.
- Main G1: full JS workspace tests were run. They exposed an unchanged main mail fixture problem, reproduced from base source separately. Draining the silent test server's unread handshake bytes (without responding) lets it observe EOF; no deadline/assertion or mail product code changed. The subsequent full run passed: 6,224 tests, with 18 explicit skips. Remote Linux CI remains a merge/release gate; no push is authorized.
- Main G2: the newer owner instruction in AGENTS.md explicitly disables visual suites and requires one manual screenshot pass. Followed that instruction rather than the review's request to run a disabled suite. Disk usage/purchase suppression and Wiki-to-task phone navigation were manually inspected; added a positive disk-meter assertion to the future visual checkpoint. This is Chromium evidence, not WKWebView.
- Safety H1: editor and Markdown handlers prevent default unconditionally; unsafe schemes cannot fall through to native navigation. The stored absolute URI allowlist is HTTP(S)/mailto; tel/sms/calab were not supported content schemes before this patch.
- Safety H2/H4: PlansDialog uses billingPaymentsAllowed; config.d.ts declares parseReleaseIdentity. Both were missing from the focused review packet, not missing from source.
- Empty explicitly configured release identity remains an error by design; defaults apply only when unset. The env example uses commented valid values. A strict error avoids an accidental release with fallback identity.
- Prebuild with APS disabled can retain an old NSE target in a reused generated tree. Distribution must use a fresh generated tree with final flags/identity; no blanket cleanup of the owner's local artifacts.
- Lockfile was generated with pinned Corepack pnpm 10.17.0, verified live. The review's different-pnpm hypothesis was not confirmed.
- Remaining minor limitations are recorded in docs/09-ui-backlog.md and docs/12-tech-backlog.md. No universal native parity or release acceptance is claimed.

## Original full review

# Ревью `cf8919c9` (база `e0018e10`): iOS catch-up

**Итог:** блокеров в коде нет. Есть **2 major**: одна неполная приёмка и одна регрессия автоматизации Dependabot. Есть **2 обязательных гейта до мержа**, плюс minor и пробелы в тестах. Объём работы описан честно, с одной поправкой формулировки (см. M1).

## Что проверено и в порядке

- **`contentHref`** корректно отсекает:
  - управляющие символы, `\`, учётные данные;
  - `javascript:`/`data:`/`file:`;
  - домены-двойники (`app.test.evil.test`) и регистр.
  - `//evil.test/...` резолвится во внешний `https://evil.test/...`, то есть уходит наружу, а не внутрь.
  - Подделать свой origin нельзя. После `new URL` префикс `https://app.test/` означает host = `app.test` без userinfo.
  - Проверка идёт по trim-строке, а якорь получает сырой `href`. Но любой вариант, который браузер прочтёт как `javascript:`, отсекается раньше: либо по схеме, либо по управляющим символам.
- **Синхронность.** Ни на одном пути (Markdown, клик в редакторе, bubble, тулбар, DiskViewer) между кликом и `openExternal` нет `await`/`import()`.
- **Приоритет PageSource.** Сначала `idOf(нормализованный href)` → `open`, только потом `openOwnLink`. `mailto:` в `handleDeepLink`/`parseMailLink` не попадает.
- **Редактор** (`extensions.ts`):
  - обычный клик при редактировании возвращает `false`, остаётся каретка;
  - клик с модификатором и клик в режиме чтения открывают ссылку один раз;
  - старый плагин `handleClick` удалён, поэтому двойного открытия из своего кода нет;
  - `.wiki-page-link` исключён.
- **Оплата.** `BuyStorage` и кнопка в футере `UsageDialog` (включая `full`/413) закрыты через `billingPaymentsAllowed()`. `nativeShell` работает fail-closed для старых хостов без поля `platform`.
- **Плагины.** На существующей цели при каждом prebuild переписываются `PRODUCT_BUNDLE_IDENTIFIER`, `MARKETING_VERSION` и `CURRENT_PROJECT_VERSION`. Это закрывает найденный баг с устаревшим bundle ID.
- **Shell в CI.**
  - `gh pr view` выполняется под дефолтным `bash -e`: при ошибке API шаг падает, и автомерж не включается (fail closed).
  - Инъекций нет: `PR` — число, `DEPS` не исполняется.
- **Разрешение React.** В lockfile пиры RN 0.86.3 указывают на `react@19.2.3`, `scheduler@0.27.0`. `metro.config.js` пинит `react`/`react-dom`, включая подпути.

## Major

**M1. Неизвестные пути своего origin по-прежнему открывают новое окно, которое iOS-оболочка блокирует.** Это `services/contentLink.ts:openContentLink`. Регрессии нет, но не выполнен принятый критерий плана: «`window.open` со своим origin не вызывается ни разу» / «prove same-origin links never open a new window».

Сценарий: в вики (чтение), чате или Markdown-превью Диска стоит ссылка на путь своего сервера, которого нет в списке `known` в `openOwnLink`. Примеры:
- `https://<server>/c/<code>` — публичный просмотр Холста; `links.ts` прямо пишет, что это не `/canvas/`;
- `/e/<id>/rsvp?t=…` — `parseEventLink` его не матчит;
- публичная ссылка Диска;
- любой другой путь сервера.

Цепочка: `openOwnLink` → `false` → `platform.app.openExternal(href)`. На web-платформе это новое окно (web.ts:658, по ссылке ревью плана). Дальше `decideNewWindow` → `block` (navigation.ts:91-95). Тап молча ничего не делает.

Тестами это не покрыто: `contentLink.test.ts` проверяет только чужие хосты, а в тестах редактора `openOwnLink` замокан в `true`.

**Исправление** (только веб, без расширения allowlist): если `openOwnLink` вернул `false`, `href` начинается с `${origin}/` и активен `iosNativeShell()`, не вызывать `openExternal`. Вместо этого показать тост «Ссылка открывается в браузере» с действием «Скопировать». Плюс тест: `/c/x` в iOS-оболочке не вызывает `openExternal`. Другой вариант — явно задокументировать ограничение со списком типов ссылок. В любом случае в `shared-web-status.md` «Internal … links route inside the client» заменить на «known in-app routes».

**M2. Триаж Dependabot одновременно слишком широкий и не закрывает пару React.** Это шаг `decide` в `dependabot-auto-merge.yml` и `dependabot.yml`.

- **(a) Правило срабатывает на любую правку файла.** `grep -qx apps/mobile/package.json` реагирует на любое изменение мобильного манифеста. Но в `apps/mobile` есть devDeps, общие с десктопом: `vitest`, `eslint`, `typescript-eslint`, `@eslint/js`, `@types/node`, `globals`.
  - Если стратегия версий — `increase` (дефолт `auto` для приватных пакетов; в диффе её не видно), еженедельная группа `minor-and-patch` перепишет их диапазоны и в мобильном манифесте.
  - Итог: метка `needs-review`, и автомерж всей npm-группы фактически выключен навсегда.
- **(b) Пара React не закрыта.** `react`, `react-dom`, `@types/react`, `typescript` не в ignore.
  - Патч React 19.3.x для десктопа, по-видимому, поднимет и точный пин `react: 19.2.3` в мобильном манифесте.
  - Тогда `check:sdk` красный, группа одновременно красная и `needs-review`. Обновления десктопа стоят, пока человек не разрежет PR.
  - Это ровно сценарий п. 2 из ревью плана.

**Исправление:**
1. Решать по именам, а не по файлу: `needs-review` ставится, только если мобильный манифест изменён **и** `DEPS` пересекается с `{react, react-dom, @types/react, typescript}`.
2. Эти четыре пакета вынести из группы через `exclude-patterns`, чтобы они приходили отдельными PR.
3. Сверить `versioning-strategy` в полном `dependabot.yml`.

## Обязательные гейты до мержа (это не дефекты кода)

**G1. Полный `pnpm -r test` и удалённый CI не запускались.** Прогнаны только 17 файлов. Это нарушает п. 8 CLAUDE.md. Есть конкретный риск:
- `lib/markdown/Markdown.tsx` раньше грузил `services/links` лениво (комментарий «off the render path»; в `links.ts` — «stays free of the API / platform graph»).
- Теперь он грузит его статически: `contentLink` → `links` → `features/people/roomLink`. Там `api`, `voice`, `Confirm`, `queryClient` и `useSession.subscribe` на верхнем уровне.
- Каждый тест-файл, который рендерит Markdown с частичным моком `platform`, теперь тянет этот граф при импорте.

Кроме того, `check:sdk` и `export:check:ios` теперь стоят в обязательном `ts`. Если `expo export --platform ios` упадёт на Linux, красными станут все PR и main.

**G2. Визуальная проверка по CLAUDE.md.**
- Добавленные проверки `toHaveCount(0)` чисто негативные: они пройдут и при неверной области поиска. Нужен позитивный контроль (например, `disk-meter` виден в той же точке).
- Нужен один прогон `e2e:visual -g "billing-ios-shell"`.
- Окно «Место» на iOS так и не получило чекпоинт (ревью плана, п. 9).

## Minor

По CLAUDE.md minor идут строкой в бэклог, кроме m2: его нужно сначала проверить, он может стать major.

- **m1. Нормализация только с одной стороны.** `contentHref` возвращает канонический `url.href`, а `openOwnLink`/`ownWikiPageId` сравнивают его с сырым `shareOrigin('')`. `HTTP_ORIGIN` проверяет только префикс.
  - На десктопе при `serverUrl` вида `https://Host`, `https://host:443` или `https://host/base` внутренняя ссылка теперь уйдёт в браузер.
  - Раньше срабатывало точное совпадение сырой строки.
  - На вебе и в iOS `location.origin` канонический, там проблемы нет.
  - **Исправление:** один раз канонизировать через `new URL(o).origin`.
- **m2. `preventDefault()` до проверки ссылки.** В `extensions.ts:activate` он вызывается до проверки `contentHref`. Всё, что схема хранит (`isAllowedHref`), но `contentHref` отвергает, в режиме чтения теперь мёртвый клик; раньше это была обычная нативная ссылка.
  - **Проверить:** какие схемы допускают `isAllowedHref`/`isSafeHref`. Если там есть `tel:`/`sms:`/`calab:`, это регрессия: кнопки «Открыть» в тулбаре и bubble тоже пропадут.
  - `#frag` и относительные ссылки без `/` были сломаны и раньше.
- **m3. Сырой `href` в `DiskViewer.tsx:marked`.** Компонент рендерит `href={href}` как есть. В Electron относительная `/t/X` резолвится от origin рендерера, поэтому «Копировать ссылку» и средняя кнопка дадут неверный адрес.
  - **Исправление:** рендерить `contentHref(href)`.
- **m4. Ранний `return` в плагинах.** Если APS выключен или нет bundleId, плагины выходят сразу и не трогают существующую цель.
  - После prebuild без `--clean` из дерева со старыми флагами NSE остаётся со старыми версией и ID. Это провалит валидацию в App Store.
  - **Исправление:** записать `prebuild --clean` в runbook релиза.
- **m5. Lockfile записан, похоже, другой версией pnpm.** Примерно у 40 пакетов удалено поле `libc`, плюс посторонние dedupe: `compressible`→`mime-db 1.54.0`, `fb-watchman`, `@babel/runtime`.
  - `--frozen-lockfile` метаданные не проверяет, поэтому установка проходит.
  - Но следующий `pnpm install` вернёт поля и даст шум в чужих PR. А на glibc-Linux без `libc` ставятся и `-musl`-бинарники.
  - **Исправление:** пересобрать lockfile закреплённой версией `packageManager`.
- **m6. Другие точки входа в покупку места.** Других вызовов `openBuyStorage`/`disk.buy.*` (меню PhoneDisk, тост при 413) в диффе не видно.
  - **Проверить** grep'ом, иначе CTA «Докупить место» останется.
- **m7. `parseReleaseIdentity` читает сырой `process.env`.** Остальные флаги идут через `env()`, где пустая строка означает «не задано».
  - Поэтому `CALAB_IOS_BUILD_NUMBER=` валит конфиг, а `CALAB_EAS_PROJECT_ID=` — нет.
- **Мелочи:**
  - порядок импортов: новый импорт стоит первой строкой в `extensions.ts` и `Dialogs.tsx`;
  - однострочный стиль `contentLink.ts` и тестов не похож на окружающий код;
  - doc-комментарий `BuyStorage` не упоминает iOS;
  - английские разделы в русских `docs/11` и `shared-web-status.md`;
  - в `ios-catchup` все чекбоксы остались `[ ]`;
  - фраза в docs/11 про «0.x RN minor» устарела: RN теперь в ignore.

## Пробелы в тестах (браузерная фикстура ≠ WKWebView)

- **`openOwnLink` замокан везде** (в тестах редактора — всегда `true`). Нет теста, что настоящие `parseBoardLink`/`parseCanvasLink`/`parseDiskLink`/`parseWikiLink` принимают нормализованный `href`. Хватит одного теста с реальным `links.ts`.
- **PageSource на тулбаре не покрыт.** Тест тулбара рендерит его без `pages`. Нет проверки, что ссылка на вики-страницу в режиме чтения или в тулбаре идёт в `pages.open`.
- **Нет тестов на:**
  - открытие внешней ссылки из тулбара, bubble и режима чтения;
  - `mailto:` в редакторе;
  - исключение `.wiki-page-link`;
  - неизвестный путь своего origin (M1).
- **Реальный указатель не проверен.** `.click()` в jsdom не порождает mousedown/mouseup. Путь ProseMirror `handleClick` (и Link `openOnClick`, если он включён в `wikiStarterKit`) не проверен, двойное открытие на реальном указателе тесты не исключают.

## Вердикт: готовность кода

**Блокеров нет. В main пока не готово.** Нужно:
1. Закрыть M1 (код или явное ограничение в документации плюс тест).
2. Закрыть M2 (сузить триаж).
3. Пройти G1: полный `pnpm -r test` и зелёный CI, включая новые шаги `ts`.
4. Пройти G2: один визуальный прогон.

После этого — готово к мержу.

## Вердикт: готовность iOS-релиза

**Не готов.**
- **Веб-часть.** Изменения Диска и ссылок после мержа и обычного веб-деплоя дойдут до установленных бинарей без новой сборки. Однажды проверить в build 20, что мост `CalabHostActivity` есть: на нём держится скрытие оплаты.
- **Натив.** Сейчас есть только неподписанные тестовые сборки 0.1.0/21 с тестовым префиксом. Для релиза нужно:
  1. зелёный CI;
  2. `prebuild --clean` с боевым bundle ID и build number выше живой истории App Store Connect;
  3. решение по флагам APS/calls/nativeAudio;
  4. подпись: NSE без communication grant;
  5. приёмка в Simulator с WKWebView: свои, внешние и `mailto:` ссылки, share sheet, скачивания, разрешения;
  6. проверки на устройстве: заблокированный экран и фоновое аудио, холодный ответ через PushKit/CallKit, push.
- **Остаются задокументированными ограничениями:** входящие SIP без APNs, push по событиям, SSO, трансляция экрана и PiP.

## Original independent safety review

# Независимое ревью (второй проход): `cf8919c9` против `e0018e10`

Проверял только то, что входит в объём ревью: обработку URL в content-ссылках, guard'ы Dependabot/CI и валидацию идентичности мобильной сборки. Нативный allowlist, auth, API/proto, физическое устройство и WKWebView не оценивал.

## Итог

**Введённых blocker: 0. Введённых major: 0.** Ниже minor-замечания, пункты для проверки (код вне диффа) и известные ограничения.

---

## 1. `apps/desktop/src/renderer/services/contentLink.ts`

### Что проверено и держится

- **Управляющие символы и `\` отсекаются до парсера** (`contentLink.ts:8-10`). Парсер URL молча выкидывает `\t\n\r` и превращает `\` в `/` для special-схем, поэтому `https://app.te\nst/...` и `https://app.test\@evil.test` не могут подменить хост. Оба случая покрыты тестом.
- **Allowlist схем** (`:14`): `javascript:`, `data:`, `file:`, `blob:`, `calab://` дают `null`. Креды в URL отклоняются.
- **Сравнение по каноничному `url.href`**:
  - `https://APP.TEST/...` и `:443` нормализуются;
  - `app.test.evil.test`, `app.test.` (точка в конце) и punycode-омографы не совпадают с префиксом `${origin}/` и уходят во внешний браузер, а не в in-app роутер.
- **Синхронность**: между жестом и `window.open` нет `await` и `import()`, так что popup-blocker WebKit не сработает (по коду).
- **`mailto:`** идёт мимо `openOwnLink` (`:26`). Это избыточно, потому что префикс origin всё равно не совпал бы, но безвредно. До `parseMailLink` такая ссылка не доходит.

### Minor, введено

**M1. Protocol-relative `//host/path` проходит как «root-relative»** (`:13`).
- `'//evil.test/x'.startsWith('/')` даёт `true`, затем `new URL('//evil.test/x', 'https://app.test/')` даёт `https://evil.test/x`, и ссылка уходит в `openExternal`.
- Эскалации нет: абсолютный `https://evil.test` и так разрешён.
- Но комментарий «resolve root-relative routes against this server» неверен для этого случая, и теста на него нет.
- Предложение: `href.startsWith('/') && !href.startsWith('//')` и кейс в тесте.

**M2. `openContentLink` возвращает `true`, даже когда платформа ничего не сделала** (`:27-28`).
- Web `openExternal` открывает только `mailto:` с `@` до `?` (`web.ts`, регэксп `^mailto:[^\s/]+@`). Значит `mailto:?subject=x` пройдёт `contentHref`, но молча ничего не откроет.
- То же в iOS-оболочке для own-origin неизвестного пути: `window.open`, затем `decideNewWindow`, затем `isAppUrl`, итог `'block'`.
- Это no-op без утечки, но вызывающий код не узнает о сбое.

**M3. Возможная потеря in-app маршрута при ненормализованном `serverUrl`.**
- `href` теперь каноничный, а `origin` из `shareOrigin` нет: он только `trim` + срез `/` (`links.ts`, `HTTP_ORIGIN` проверяет только префикс).
- Если в настройках `https://App.Test` или `https://app.test:443`, своя ссылка не совпадёт с префиксом и уйдёт во внешний браузер.
- Это функциональная деградация, не безопасность. Лечится нормализацией `origin` через `new URL(origin).origin` в `contentHref`.

### Проверить (код вне диффа, не могу подтвердить)

**H1. Что делают вызывающие компоненты при `false`.**
- Если `preventDefault()` вызывается только при `true`, то отклонённые `javascript:`, `data:` и `file:` проваливаются в нативную навигацию `<a>`.
- В iOS-оболочке их режет `decideNavigation`, в Electron, вероятно, `will-navigate` в main. Но на web это зависит от React/браузера.
- И наоборот: если `preventDefault()` безусловный, ломаются якоря `#heading`, `?q` и относительные `x/y` в вики (они дают `null`).

**H2. `/plans` в пользовательском контенте теперь канонизируется и идёт в `handleDeepLink`, затем в `openPlansLink`.**
- Нужно убедиться, что `openPlansLink` уважает `iosNativeShell()` (anti-steering, App Store 3.1.1).
- Роутинг предсуществующий, но относительная ссылка `/plans` в контенте теперь гарантированно попадает в него.

**H3. Legacy `calab://t/...` и `calab://wiki/...` в старом контенте теперь блокируются.**
- Раньше они, возможно, открывались через `handleDeepLink`.
- Для `calab://mail/...` блокировка правильная. Для остальных это возможная регрессия старых сообщений; по docs/09 #53 их быть не должно.

---

## 2. Dependabot / CI

### `dependabot-auto-merge.yml`

**Fail-closed подтверждён.**
- Дефолтный shell Actions: `bash -eo pipefail`.
- `changed_files=$(gh pr view …)` при ошибке `gh` роняет шаг через errexit, потому что статус присваивания равен статусу подстановки.
- Итог: ни auto-merge, ни метки. PR остаётся висеть, но не мержится.

**Права и инъекции.**
- Права есть: `pull-requests: write` на job.
- `$PR` числовой, пути файлов не исполняются.

**Nit.** `grep -qx 'apps/mobile/package.json'` трактует `.` как регэксп. Это даёт только over-match, то есть безопасно. Лучше `grep -qxF`.

**Гипотетически.**
- `gh pr view --json files` отдаёт не больше 100 файлов (GraphQL). Для этого монорепо маловероятно.
- Если мобильная React-пара вынесена в pnpm catalog (`pnpm-workspace.yaml`), bump поменяет не `apps/mobile/package.json`, и guard промолчит. Страховка в этом случае — `check:sdk` в CI.

### `dependabot.yml`

**Известное ограничение, minor.**
- `ignore` без `update-types` для `expo`, `expo-*`, `@expo/*`, `react-native`, `react-native-webview`.
- По документации GitHub `ignore` действует и на security-PR. Значит CVE в `react-native-webview`, ключевой границе безопасности оболочки, не породит PR.
- Алерты в Security tab при этом остаются. Нужен ручной мониторинг; это строка в `docs/12-tech-backlog.md`.

**Минимальный пробел.** Транзитивные `@react-native/*`, `metro*` и `babel-preset-expo` не в `ignore`. Lockfile-only bump обойдёт guard по `package.json`, и останется только CI-сеть.

### `ci.yml`

**Проверить.**
- `check:sdk` и `export:check:ios` — определения скриптов в диффе не видны.
- Если это `expo install --check`, он может ходить в сеть (api.expo.dev). Это риск флака обязательного `ts` на main. Смягчение: `EXPO_OFFLINE=1` / `EXPO_NO_TELEMETRY=1`, если совместимо.

**Ограничение покрытия.** `export:check:ios` собирает только JS-бандл, нативный ABI он не проверяет. Комментарий «dependency bots must not drift the phone runtime» верен только для JS-уровня.

---

## 3. `parseReleaseIdentity` (`apps/mobile/src/config.js`, `app.config.ts`)

### Fail-closed: регрессий нет

- Раньше было захардкожено `0.1.0`, `buildNumber` не задавался (Expo по умолчанию `1`).
- Регэкспы корректны: ведущие нули отклоняются, якоря `^…$` в JS без флага `m` не пропускают `\n` в конце. Поэтому проверки `trim() !== x` избыточны, это nit.

### Minor, введено

**M4. Пустая строка обрабатывается не так, как остальные env-переменные.**
- Читается сырой `process.env.CALAB_APP_VERSION`. Значение `''` (например, `CALAB_APP_VERSION=` в `.env` или незаданный `vars.X` в Actions) не включает default-параметр и роняет конфиг.
- Остальные переменные в этом же файле идут через `env()`, где `''` превращается в `undefined`.
- Это fail-closed, но неконсистентно. Если в `.env.example` эта строка пустая, падает каждая локальная сборка.

### Проверить

**H4. `config.d.ts` в показанном диффе не обновлён.**
- `app.config.ts` импортирует `parseReleaseIdentity` из `./src/config`.
- Если `.d.ts` не объявляет функцию и `app.config.ts` входит в tsconfig, `pnpm -r typecheck` красный.
- Вероятно, правка есть в коммите вне показанного фрагмента. Подтвердить.

### Известные ограничения

- Защиты «store-сборка без env использует дефолты» нет: комментарий описывает намерение, а не проверку.
  - Последствие ловит App Store Connect: отказ по дублю или понижению версии, то есть fail-closed, но с потерей времени сборки.
  - Если в `eas.json` стоит `appVersionSource: remote`, EAS перекроет эти значения.
- Потолок build number 9999 — политическое решение. Apple допускает больше; ограничение помешает, если брать `run_number`.
- Android `versionCode` не задаётся. Это вне объёма (iOS).

---

## 4. Предсуществующее (не введено этим коммитом)

- `shareOrigin` принимает `serverUrl` с путём (`^https?://[^/\s]+` проверяет только префикс).
- `parseWikiLink` для любого https-URL не проверяет origin; защищает только префикс в `openOwnLink`.
- Own-origin неизвестные пути в iOS-оболочке блокируются в `decideNewWindow` (ограничение задокументировано в `navigation.ts`).

---

## Вердикт

- **Blocker: 0. Major: 0.**
- **Minor, введено: 4** (M1–M4).
- **Пунктов «проверить»: 4** (H1–H4). Ключевые из них: H1 (поведение вызывающих при `false`) и H4 (`config.d.ts`). H4 может сделать CI красным, но это не уязвимость.

**Держать локально до реальной iOS-приёмки безопасно.** Новый код ужесточает обработку ссылок по сравнению с вероятным прежним поведением, а guard'ы Dependabot работают fail-closed. Перед мержем в main стоит закрыть H1 и H4. M1–M4 — строками в бэклог (`docs/09-ui-backlog.md` / `docs/12-tech-backlog.md`).

Доказательств поведения в WKWebView и на устройстве нет: фикстура политики работает на Chromium, `window.open` с `noopener` в react-native-webview на iOS не подтверждён.
