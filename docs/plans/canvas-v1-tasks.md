# Холст v1 — задачи

ADR: [0107 Холст](../adr/0107-canvas.md). Ветка интеграции — `feat/canvas` (от `main`); задачи — в своих worktree и ветках, лид мержит в `feat/canvas`, затем одним PR в `main`. Образец разбиения — [wiki-v1-tasks.md](wiki-v1-tasks.md).

Объём v1 (решение владельца, 19.10): стикеры и текст, фигуры и коннекторы; дерево с папками и права как у Диска/Вики. Не входит: рисование от руки, картинки, фреймы, публичная ссылка, правка на телефоне (ADR §«Отложено»).

| # | Задача | Зависит | Пути |
|---|--------|---------|------|
| H1 | Контракт и права: `canvas.proto` (§7), биты 41–43, `ComputeTree` с третьим набором (Go `perm/canvas.go`, TS `treeItemPermissions`), векторы в `proto/testdata/permissions.json`, `SearchType.CANVAS`, события `CANVAS_ITEM_*` (105/106), миграция `00103_canvas.sql` (§1), sqlc-запросы (дерево, корзина, обновления/снимок/компакция, версии, журнал), `make gen`, docs/04 | — | `proto/`, `packages/protocol`, `apps/server/internal/{perm,db}` |
| H2 | Сервер: вынос ядра ретранслятора из `internal/wiki/sync.go` в `internal/ysync` (Вики — первый потребитель, поведение не меняется), пакеты `internal/canvas` + `internal/canvasacl` (REST §7, сокет `/sync`, версии, журнал, события с фильтром по получателю, `TrashSweep`, поиск, настройки), интеграционные тесты (матрица прав, два сокета, компакция, лимиты, приватные холсты, `Detached`) + все тесты Вики зелёные | H1 | `apps/server/internal/{ysync,wiki,canvas,canvasacl,app,gateway,search}` |
| H3 | Движок (чистый TS, без раздела): `features/canvas/engine/` — модель Y.Doc (§3), `scene`, пространственный индекс, рендер по требованию с кэшем и отсечением, камера, хит-тест, выделение/перенос/ресайз, привязка и направляющие, коннекторы с маршрутизацией, `Y.UndoManager`, буфер обмена, текст-оверлей `<textarea>`; юнит-тесты геометрии/маршрутов/индекса/камеры/синхронизации (два `Y.Doc`), бенчмарк `tools/perf-canvas.ts` на 2000/5000 объектов | — (локальный Y.Doc, без сервера) | `apps/desktop/src/renderer/features/canvas/engine`, `lib/canvas/` |
| H4 | Клиентская синхронизация: `lib/wikiSync.ts` → общий `lib/ySync.ts` (Вики переезжает, тесты Вики зелёные), `lib/canvasSync.ts` (кадры, awareness ≤ 20/с, реконнект, компакция, `plain_text` в мета), мок-сокет | H1 (кадры), H3 (формат документа) | `apps/desktop/src/renderer/lib/` |
| H5 | Раздел: рейл «Холст» (иконка, `sectionNav`, `stores/canvasUi.ts`), колонка-дерево (копия Диска/Вики), экран холста (шапка `Bar`, панель инструментов, панель свойств, масштаб, курсоры участников), диалоги Доступ (общий `TreeAccess`) / Переместить / История / Корзина, настройки `canvas_trash_days`, экспорт PNG, i18n ×4, мок-сервер, визуальная спека `canvas` (dark-960 + iPhone 14), одно прохождение | H3, H4, контракт H1 | `features/canvas/*`, `features/shell/*`, `stores/canvas*.ts`, `services/canvas.ts`, `i18n/*/canvas.ts`, `e2e-support/mock-canvas.ts` |
| H6 | Телефон: «Холст» в «Ещё», только просмотр (панорама, щипок), спека `m-canvas-*` | H5 | `features/canvas/phone*` |
| H7 | Второе ревью H1+H2 (права, `/sync` — auth/лимиты/DoS, вынос `ysync`, приватные холсты, `Detached`) | H2 | — |
| H8 | Сверка клиента с сервером: два клиента (Playwright chromium ×2) на живом Go-сервере правят один холст — сходимость, права «только просмотр», компакция, версия; `tools/canvas-walk.sh` | H2, H5 | `apps/desktop/e2e-web/canvas.spec.ts`, `tools/` |
| H9 | Перф-проход с цифрами до/после: покой (CPU ≈ 0, нет таймеров), панорамирование/зум 2000 и 5000 объектов, `CALABA_REACT_PROFILING=1` на чужой правке, память; запись в `docs/14-energy.md` | H5 | `docs/14-energy.md`, `tools/` |
| R3 | Docs (01, 05, 08 «Холст», 16, `TESTING.md`), CHANGELOG «Коротко», статусы | всё | `docs/` |

Параллельно стартуют **H1 и H3** (движок не зависит от сервера). H2 — после H1; H4 — после H1 и формата документа из H3; H5 — после H3 и H4.

## Правила для исполнителей
- Перед работой прочитать CLAUDE.md, ADR-0107, docs/02 (медиа-правила не затрагиваются, но `<audio>` не трогать), docs/04, docs/08, docs/14.
- Агенты работают в своих worktree от `feat/canvas`; свои порты и БД (`CALABA_VISUAL_MOCK_PORT`, `TEST_PG_URL`, `TEST_REDIS_URL`).
- Проверки перед коммитом — как CI: `make gen` + `git diff --exit-code`, `make lint` (в `apps/server`), `go test -race` пакета, `pnpm -s typecheck && pnpm -s lint && pnpm -s test`; интеграционный тест только своего пакета, полный набор — один раз перед мержем ветки.
- Minor-замечания ревью — строкой в `docs/09-ui-backlog.md` / `docs/12-tech-backlog.md`.

## Статусы (19.10)

| Задача | Статус |
|---|---|
| ADR-0107, план | написаны |
| H1–H9, R3 | не начаты |
