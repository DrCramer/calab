# Раздел «Телефония» — план реализации

ADR: [0137 Раздел «Телефония»](../adr/0137-telephony-section.md). Пять этапов; **каждый вливается в `main`
сам по себе с зелёным CI** и не оставляет видимого недоделанного UI (до T5 настройки остаются в окне
настроек пространства, до T3 раздела нет). Задачи — в своих worktree от `main` (после слияния предыдущего
этапа), свои порты и БД (`CALABA_VISUAL_MOCK_PORT`, `MOCK_LIVEKIT_ROOM_PREFIX`, `TEST_PG_URL`,
`TEST_REDIS_URL`).

| # | Этап | Слои | Модель | Зависит | Параллельно с |
|---|---|---|---|---|---|
| T1 | Журнал: события звонка, участники, API, событие шлюза, хранение | proto, миграция, сервер | Opus | — | — |
| T2 | Контакты, определитель номера, личный исходящий звонок | proto, миграция, сервер | Opus (+ второе ревью) | T1 | T3 |
| T3 | Раздел «Телефония»: рейл / «Ещё», «Недавние», деталь звонка | клиент | Opus | T1 | T2 |
| T4 | Контакты, «Набор», звонок из раздела, DTMF, имена в звонке | клиент | Opus | T2, T3 | T5 (без одновременных e2e) |
| T5 | Перенос настроек станции в раздел, удаление пункта настроек, телефонные настройки списками | клиент | Sonnet | T3 | T4 (без одновременных e2e) |

Порядок: T1 → (T2 ∥ T3) → (T4 ∥ T5). Одновременно ≤ 2 агента. T4 и T5 не гоняют e2e одновременно
(один тестовый Electron, CLAUDE.md) — кто первым дошёл до визуальной проверки, тот и гоняет, второй ждёт.

## Общее для всех этапов

- Прочитать: CLAUDE.md, ADR-0137 целиком, ADR-0117/0128/0131/0132/0133 (по этапу), docs/04 «Телефония»,
  docs/08 «Телефония» и «Мобильный веб», docs/14, `docs/plans/mobile-polish-2026-10-13.md` (телефонные
  примитивы: `Choice`, `PhoneBack`, `Bar`, `lib/haptics.ts`, `lib/rowSwipe.ts`, `lib/longPress.ts`).
- Проверки перед каждым коммитом — как CI: `make gen` + `git diff --exit-code`; `make lint` в `apps/server`;
  `go test -race` тронутых пакетов + интеграционный своего пакета (`go test -tags integration
  ./internal/app -run 'TestSIP…'`); `pnpm -s typecheck && pnpm -s lint && pnpm -s test`. Полный
  интеграционный набор — один раз перед мержем этапа.
- Коммиты мелкие, по-английски, с чек-листом проверок; minor-замечания ревью — строкой в
  `docs/09-ui-backlog.md` / `docs/12-tech-backlog.md`.
- **Визуальные проверки (этапы с UI — T3, T4, T5) обязательны и входят в «готово»:**
  - новые кадры — шагами `checkpoint(...)` в **существующих** тестах: телефон — `test('m-telephony')` в
    `apps/desktop/e2e-visual/mobile.visual.spec.ts` (iPhone 14, dark; при необходимости — второй шаг-блок в
    том же тесте), десктоп — тесты `telephony-*` в `apps/desktop/e2e-visual/telephony.visual.spec.ts`
    (dark-960). Новых тестов-файлов не заводить;
  - прогон: `pnpm -F @calaba/desktop e2e:visual -g "telephony"` (десктоп) и `pnpm -F @calaba/desktop e2e:visual:mobile -g "m-telephony"` (телефон) —
    `CALABA_VISUAL_WORKERS=1`, `--mute-audio`;
  - **агент открывает каждый PNG телефона (и десктопа) один раз и проверяет**: обрезки и `…` там, где
    должен быть перенос; перекрытия (FAB над строкой, липкая панель над контентом); safe area сверху и снизу;
    цели ≥ 44 px; пустые и загрузочные состояния; контраст в обеих темах; длинные имена и номера; нет
    горизонтальной прокрутки. **Найденное исправляет до отчёта** и перегоняет только изменённые кадры;
    в отчёте — список проверенных кадров и что исправлено. Инварианты `mobile.visual.spec.ts` (нет гориз.
    скролла, всё ≥ 44 px, ничего за экраном, axe) должны проходить на новых экранах;
  - если WebKit для мобильных снимков на машине недоступен — этап **не считается готовым**: агент
    сообщает лиду, а не пропускает проверку.
- Перф (T3, T4): `CALABA_REACT_PROFILING=1` + `tools/perf-call.ts` — событие журнала перерисовывает одну
  строку, открытый раздел без звонков — без таймеров; цифры до/после — в docs/14 «Телефония».

---

## T1 — Журнал на сервере (Opus)

**Статус: сделан** (ветка `feat/telephony-journal-t1`). Отличия от плана — в ADR-0137: срок хранения и
лимиты исходящих — `PUT …/sip/policy` (`retention_months`, `out_per_hour`, `out_per_user_hour`; решения
владельца 27.10), `missed` хранится в строке звонка, события вне машины нумеруются с 1000001.

**Что.** ADR-0137 §1: `origin`, `peer_e164`, `sip_call_events`, `sip_call_parties`, `retention_months`,
`sip_seen_at`; эмиссия событий из машины входящих (`InCall.Seq`, `Effects.Events`, `c.log`), из исходящих
комнатных звонков и из записи; запись событий и участников в той же транзакции, что строка, до сохранения
Valkey; `ParseLegacyRoute`; REST `journal`, `journal/{cid}`, `journal/seen`, `policy`;
`SIP_JOURNAL_ENTRY` и `SIP_MISSED_CHANGED` с фильтром получателей; `WorkspaceSnapshot.sip_missed`;
часовой воркер хранения. UI не трогает; старый `GET …/calls` без изменений.

**Пути.**
- `proto/calaba/v1/sip.proto` (журнал, `SipCallEvent`, `SipCallEventKind`, `SipJournalEntry`, запросы),
  `proto/calaba/v1/gateway.proto` (два события — следующие свободные номера), `proto/calaba/v1/workspace.proto`
  (`sip_missed`); сгенерированное: `apps/server/gen/**`, `packages/protocol/src/gen/**`.
- `apps/server/internal/db/migrations/00029_sip_call_journal.sql` (номер — следующий свободный на момент
  работы), `apps/server/internal/db/queries/sip_journal.sql` (новый) + sqlc-код.
- `apps/server/internal/sip/`: `machine.go`, `transfer.go`, `dial.go` (только `step` → `log`), `inbound.go`
  (`apply`: события/участники в транзакции), `calls.go` (события исходящих), новые `events.go`
  (типы, `log`, legacy-разбор), `journal.go` (REST, видимость, курсор), `retention.go` (воркер).
- `apps/server/internal/recording/phone.go` — вызов `JournalSink` (интерфейс в `recording`, реализация —
  `sip.Service`,
  подключается в `internal/app/app.go`).
- `apps/server/internal/gateway/hub.go` (фильтр `VIEW_JOURNALS` + каналы участников), `internal/app/app.go`
  (маршруты, воркер), `identityroutes.go`, `botroutes.go`, справочник бота (`_routes.json`, события).
- Docs: `docs/04-data-model.md` «Телефония», `docs/05-realtime-protocol.md` (события), `docs/16-permissions-matrix.md`.

**Тесты.**
- Unit `internal/sip/events_test.go` (таблица): меню → кнопка → группа «по очереди» (два `RING`/`RING_END
  no_answer`, `ANSWERED`) → перевод (`TRANSFER`, `TRANSFER_END answered`) → `ENDED`; «все сразу» с
  отклонением; переадресация группы (`FALLBACK`); набор добавочного `not_found`; предупреждение о записи;
  `seq` строго растёт; пустой переход ADR-0124 — ни одного события; `ParseLegacyRoute` на строках из
  существующих тестов.
- Интеграционный `internal/app/sip_journal_integration_test.go` (+ правки `sip_inbound_…`/`sip_transfer_…`
  не нужны — новые проверки отдельным тестом): полный входящий через фейки LiveKit SIP и воркера →
  события в БД в порядке и с временем; повтор того же перехода не задваивает (`ON CONFLICT`); исходящий
  комнатный: дубли вебхуков дают одно `ANSWERED`; запись → `RECORDING stored`; видимость: участник видит
  только свои (`scope=mine`), `scope=all` без `VIEW_JOURNALS` → 403, гость → 403/404, звонки закрытой
  комнаты не видны; фильтры `missed/in/out/user/q/from/to`, курсор; `SIP_JOURNAL_ENTRY` доходит до
  `VIEW_JOURNALS` и участника и не доходит до остальных; `sip_missed` в READY и после `seen`; хранение
  удаляет старше срока и только в пространстве с заданным сроком.
- `make gen` без дрейфа.

**Визуальные проверки.** Нет (без UI).

**Готово, когда:** всё выше зелёное, старый журнал в настройках работает как раньше (ручная проверка
мок-сервером не нужна — API не менялся), docs обновлены, отчёт ≤ 15 строк.

---

## T2 — Контакты, определитель номера, личный исходящий (Opus, второе независимое ревью)

**Статус: сделан** (ветка `feat/telephony-t2`), ждёт второго ревью. Отличия от плана: текста пуша нет —
SIP-пушей пока нет вовсе (CallKit для SIP — отдельный ADR, ADR-0137 §7), строка в docs/12; `SipCall.origin`
добавлен (клиенту отличить личный звонок); `ApiError.conflict_id/conflict_name` — владелец номера в
`SIP_CONTACT_NUMBER_TAKEN`; токен личного звонка с `canPublishData` (DTMF в T4); импорт — 20 в час на
пространство вместе с предпросмотрами; имя по телефону сотрудника ботам не уходит (ни в событиях, ни в REST).

**Что.** ADR-0137 §2, §3: `sip_contacts`, `sip_contact_phones`, CRUD, импорт/экспорт CSV (`,`/`;`, BOM,
cp1251, предпросмотр), нормализация (+ правило 10 цифр на `9` при `+7`-номере), общие векторы
`proto/testdata/phone_numbers.json` (Go-тест читает их; TS-зеркало — в T4); caller ID: контакт →
`User.phone` сотрудника → номер, поля `SipCall.caller_name/caller_company/contact_id/caller_user_id` в
`SIP_INBOUND_RING`/`SIP_CALL_UPDATE`, текст пуша; имена в `SipJournalEntry` (T1 отдаёт пустые); личный
исходящий: `POST`/`DELETE …/sip/calls[/{cid}]`, комната `sipout_*`, набор после входа звонящего, 15 с на
вход, занятость, `lost`, запись исходящих этой комнаты, события журнала; лимиты — политика пространства
из T1 (`Service.takeOutbound`: `out_per_hour` / `out_per_user_hour`, по умолчанию 120 / 30); контакты —
удаление по `retention_months` (правило — ADR-0137 «Хранение», крючок в `sip/retention.go`).

**Пути.**
- `proto/calaba/v1/sip.proto` (контакты, `PlaceSipPersonalCallRequest/Response`, поля `SipCall`),
  `proto/calaba/v1/common.proto` (`SIP_CONTACT_NUMBER_TAKEN`, `SIP_BUSY` — если нет), `proto/testdata/phone_numbers.json`;
  сгенерированное.
- `apps/server/internal/db/migrations/00030_sip_contacts.sql`, `apps/server/internal/db/queries/sip_contacts.sql`.
- `apps/server/internal/sip/`: новые `contacts.go`, `contacts_csv.go`, `lookup.go`, `outbound.go`;
  правки `inbound.go` (поля caller ID при сборке `SipCall`), `journal.go` (имена), `validate.go`
  (`NormalizeNumber` + правило для контактов отдельной функцией).
- `apps/server/internal/rtc/webhook.go` (+ `SIPHook`: комнаты `sipout_`), `apps/server/internal/push/delivery.go`
  (текст пуша), `apps/server/internal/recording/phone.go` (комната личного исходящего),
  `internal/app/{app.go,identityroutes.go,botroutes.go}`.
- Docs: `docs/01-architecture.md` (поток личного звонка), `docs/04`, `docs/05`, `docs/16`.

**Тесты.**
- Unit: `contacts_csv_test.go` (заголовки ru/en, `;`, BOM, cp1251, несколько номеров в ячейке, дубль
  внутри файла и с базой, 5001 строка → 422), `lookup_test.go` (порядок источников), нормализация по
  векторам.
- Интеграционные `internal/app/sip_contacts_integration_test.go`: CRUD, `409 SIP_CONTACT_NUMBER_TAKEN`,
  удаление — автор/`MANAGE_INTEGRATIONS`, импорт только `MANAGE_INTEGRATIONS`, бот с правами — да, гость —
  нет; входящий от номера контакта → `SIP_INBOUND_RING` с именем. `internal/app/sip_outbound_integration_test.go`:
  без `PLACE_CALLS` пространства → 403 (с allow в комнате — всё равно 403), бот → 403, тариф → `PLAN_LIMIT`,
  `allowed_prefixes`, лимит → 429; набор только после `participant_joined` звонящего, не вошёл 15 с →
  `FAILED not_connected`; занятость: входящий группы пропускает звонящего, DM-звонок → «занято»; конец
  каждой стороной; запись комнаты `sipout_*`; события `STARTED/DIALING/ANSWERED/ENDED`.
- `make gen` без дрейфа.

**Визуальные проверки.** Нет (UI — в T4).

**Готово, когда:** зелёное + **второе независимое ревью** (платные звонки и лимиты, права на личный
звонок, персональные данные, разбор загружаемого файла) — blocker/major исправлены.

---

## T3 — Раздел «Телефония»: рейл, «Недавние», деталь (Opus)

**Что.** ADR-0137 §5 (видимость без ветки «администратор без подключения» — она в T5), §6 и §7 для
«Недавних» и детали: плитка рейла и раздел в «Ещё» с бейджем пропущенных, `showMode('telephony')`,
колонка навигации (пункты «Недавние»; «Контакты» и «Набор» добавит T4, «Настройки» — T5 — через реестр
страниц `features/telephony/pages.ts`), список с блоком «Сейчас», заголовками дней, фильтрами (десктоп —
`Bar`; телефон — сегменты «Недавние · Пропущенные» + третий сегмент появится в T4, воронка → карточка,
чипы), строки, свайп и долгое нажатие на телефоне, деталь с маршрутом (чистая `timeline.ts`: события →
шаги, сворачивание звонков сотрудникам, смещения), «Позвонить» в строке/детали — **пока только
внутренний звонок/деталь** (внешний звонок включит T4; до T4 на телефоне тап по строке открывает деталь),
`SIP_JOURNAL_ENTRY`/`SIP_MISSED_CHANGED`/`journal/seen`, ⌘K «Телефония».

**Пути.**
- Новые: `apps/desktop/src/renderer/features/telephony/{TelephonySection.tsx,pages.ts,Recents.tsx,
  RecentsRow.tsx,RecentsFilters.tsx,CallDetail.tsx,Timeline.tsx,PhoneTelephony.tsx}`,
  `features/telephony/timeline.ts` (+ `timeline.test.ts`), `lib/telephonyAccess.ts` (+ тест),
  `stores/telephonyUi.ts`, `stores/sipJournal.ts`, `assets/nav/phone_{idle,active}.svg` + `assets/nav/icons.tsx`,
  `i18n/{ru,en,es,zh-CN}/telephony.ts` (+ `index.ts`).
- Правки: `lib/sections.ts`, `features/shell/{SectionRail.tsx,sectionNav.ts,PhoneTabBar.tsx,MobileShell.tsx}`,
  `lib/phoneNav.ts`, `lib/api/endpoints.ts` (журнал), `services/dispatch.ts` (два события),
  `features/shell/quickSwitcherActions.ts`.
- Мок и тесты: `apps/desktop/e2e-support/mock-journal.ts` (+ `.test.ts`, регистрация в `mock-server.ts`),
  `e2e-visual/telephony.visual.spec.ts`, `e2e-visual/mobile.visual.spec.ts`.
- Docs: `docs/08-design.md` «Телефония» (раздел, «Недавние», деталь; телефон).

**Тесты.** Unit: `timeline.test.ts` (входящий с меню, кнопкой, «по очереди» с тремя сотрудниками, перевод,
пропущенный, исходящий, старый звонок без времени), `telephonyAccess.test.ts` (все ветки видимости),
`sections`/`sectionNav` тесты на новый раздел, мок-сервер; перф-проверка (выше).

**Визуальные проверки (обязательные кадры).**
- iPhone 14 (`m-telephony`): `m-tel-recents` (смешанный список: «Сейчас», пропущенный, исходящий, длинное
  имя + длинная компания, номер без контакта, «Скрытый номер»), `m-tel-recents-loading`, `m-tel-recents-empty`,
  `m-tel-missed`, `m-tel-missed-empty`, `m-tel-filter-card`, `m-tel-filter-chips`, `m-tel-row-swipe`,
  `m-tel-row-menu` (долгое нажатие), `m-tel-detail-transfer` (меню → кнопка → «по очереди» 3 сотрудника →
  перевод → конец; маршрут раскрыт), `m-tel-detail-missed`, `m-tel-detail-outbound`, `m-tel-detail-legacy`
  (без времени), `m-tel-more` (строка «Телефония» в «Ещё» с бейджем), `m-tel-pinned` (вкладка в панели).
- Десктоп dark-960: `telephony-recents`, `telephony-recents-empty`, `telephony-detail-transfer`
  (плавающая панель на 960), `telephony-rail` (плитка с бейджем); светлая тема — `telephony-detail-transfer`.

**Готово, когда:** проверки и все кадры выше просмотрены и исправлены, раздел виден/скрыт по правилу,
окно настроек не тронуто, перф-цифры в docs/14.

---

## T4 — Контакты, «Набор», звонок из раздела (Opus)

**Статус: сделан** (ветка `feat/telephony-t4`). Отличия от плана: DTMF — только в личном исходящем (токен принятого входящего без `canPublishData`, строка в docs/12); FAB скрыт, пока строка открыта свайпом; без `PLACE_CALLS` пояснение стоит в строке подсказки (вместо отдельной карточки — экран SE помещается); свайп строки «Недавних» — «Контакт» · «Копировать».

**Что.** ADR-0137 §6–§7: третий сегмент «Контакты» и пункт колонки, список с буквами, свайп/долгое
нажатие, карточка, правка (экран на телефоне, `Modal` на десктопе), ошибки дубля, импорт CSV с
предпросмотром и экспорт (`MANAGE_INTEGRATIONS`); «Набор» (десктоп — карточка в центре с вводом с
клавиатуры; телефон — FAB и экран клавиатуры: `inputmode=none`, вставка, «0» → «+», подсказки контакт /
внутренний номер, размеры клавиш по `dvh`); личный звонок `services/sipOutbound.ts` по образцу
`services/sipInbound.ts` (пауза комнаты ADR-0133, гудок `call-outgoing`, ошибки `SIP_BUSY`,
`SIP_NUMBER_NOT_ALLOWED`, 429, `PLAN_LIMIT`); тап по строке «Недавних» на телефоне — звонок; клавиатура DTMF
в островке и полосе звонка (`publishDtmf`; без поддержки — скрыта); имена контакта в модалке входящего,
островке, полосе, пуше на клиенте; `lib/phoneNumber.ts` по общим векторам.

**Пути.**
- Новые: `features/telephony/contacts/**`, `features/telephony/keypad/**`, `services/sipOutbound.ts`
  (+ тест), `lib/phoneNumber.ts` (+ тест на `proto/testdata/phone_numbers.json`), `features/call/DtmfKeypad.tsx`,
  `apps/desktop/e2e-support/mock-contacts.ts` (+ тест).
- Правки: `features/telephony/{pages.ts,PhoneTelephony.tsx,RecentsRow.tsx,CallDetail.tsx}` (звонок,
  контакт), `features/call/{CallLayer.tsx,CallBits.tsx}`, `features/shell/MobileVoiceStrip.tsx` (кнопка
  клавиатуры), `lib/sipInbound.ts`, `services/voice.ts` (только если нужен `publishDtmf`-обёртка),
  `lib/api/endpoints.ts`, `lib/api/errors.ts`, `i18n/*/telephony.ts`, `e2e-support/mock-server.ts`,
  `e2e-visual/{telephony.visual.spec.ts,mobile.visual.spec.ts}`.
- Docs: `docs/08` «Телефония» (контакты, набор, звонок), `docs/02` — строка про DTMF (публикация данных,
  не звук; правила эха не меняются), `TESTING.md` (сценарий ≤ 15 строк: контакт → входящий с именем →
  перезвон из «Недавних» → DTMF).

**Тесты.** Unit: `phoneNumber.test.ts` (векторы), `sipOutbound.test.ts` (переходы: набор → ответ →
конец; отказ сервера; пауза и возврат комнаты; звонок во время звонка запрещён), разбор вставки номера,
подсказки набора; мок-сервер.

**Визуальные проверки (обязательные кадры).**
- iPhone 14: `m-tel-contacts` (буквы, кириллица и латиница, длинная компания, контакт без имени),
  `m-tel-contacts-empty` (с «Импорт CSV»), `m-tel-contacts-loading`, `m-tel-contact-swipe`,
  `m-tel-contact-card` (3 номера, заметка, звонки), `m-tel-contact-number-choice`, `m-tel-contact-edit`,
  `m-tel-contact-edit-keyboard` (поле в фокусе, «Сохранить» над клавиатурой), `m-tel-contact-dup-error`,
  `m-tel-import-preview`, `m-tel-keypad-empty`, `m-tel-keypad-typed` (с подсказкой контакта),
  `m-tel-keypad-extension` (подсказка «вн. 101»), `m-tel-keypad-plus`, `m-tel-fab` (FAB над списком,
  последняя строка не закрыта), `m-tel-calling` (набор), `m-tel-in-call-dtmf`, `m-call-incoming-contact`
  (полноэкранный входящий с именем и компанией), `m-tel-no-place-calls` (набор без права).
  Дополнительно **iPhone SE**: `m-tel-keypad-typed` — клавиатура помещается без прокрутки.
- Десктоп dark-960: `telephony-contacts`, `telephony-contact-card`, `telephony-contact-form`,
  `telephony-import-preview`, `telephony-keypad`, `telephony-calling` (островок «Набираем…»),
  `telephony-dtmf`, `telephony-incoming-contact`; светлая тема — `telephony-incoming-contact` и
  `telephony-keypad`.

**Готово, когда:** проверки, кадры просмотрены и исправлены, перф-проверка (открытый «Набор» и «Контакты»
без таймеров), docs и `TESTING.md` обновлены.

---

## T5 — Настройки станции в разделе, пункт в настройках удалён (Sonnet)

**Статус: сделан** (ветка `feat/telephony-t5`). Расширено владельцем 27.10: страница «Рабочие часы»
(ADR-0138, `PUT …/sip/schedule`) и внутренний номер в профиле (звонок по тапу, правка у
`MANAGE_INTEGRATIONS`, 409 — чей номер). Отличия от плана: файлы — `features/telephony/settings/**`
(страницы `pages.ts`, телефон `PhoneSettings.tsx`, цели `Targets.tsx`); новые строки — в
`i18n/*/telephonySettings.ts` (не в `sip.ts`/`pbx.ts`, чтобы не конфликтовать с T4); строки «Телефония →
открыть раздел» в поиске окна настроек нет — пункт убран целиком, нарушение тарифа ведёт в раздел.

**Что.** ADR-0137 §5 «Перенос настроек»: существующие карточки (`SettingsForm`, `TestCard`, `Exchange`
по частям, `RecordingCard`, `ActiveCalls` → блок «Сейчас» уже в T3) переезжают в
`features/telephony/settings/**` (`git mv` + разбиение на страницы; **формы, проверки и API не
меняются**); группа «Настройки» в колонке и ⚙ на телефоне; новая страница «Хранение журнала»
(`PUT …/sip/policy`: срок хранения 1/3/6 мес., 1/2/3 года и лимиты исходящих); видимость раздела для `MANAGE_INTEGRATIONS` без подключения (пустое состояние
«Подключите SIP-провайдера») и после понижения тарифа (`PlanLock`); пункт `telephony` удалён из
`WorkspaceSettings.tsx`, поиск по настройкам и старые deep-link ведут в раздел, «Тариф» ссылается на
раздел. Телефон: список-вглубь (строки 52 px со значениями), экраны форм с липким «Сохранить» внизу,
группы — режим «Изменить порядок» с ручками (dnd-kit `TouchSensor`, как «Ещё») вместо ↑↓, автоответ —
сетка 3×4 плиток с карточкой выбора действия.

**Пути.**
- Перенос: `features/workspace/{TelephonyTab.tsx,TelephonyExchange.tsx,TelephonyCalls.tsx,TelephonyRecording.tsx,promptUpload.ts}`
  → `features/telephony/settings/**`; правки `features/workspace/WorkspaceSettings.tsx`,
  `features/workspace/PlanTab.tsx` (ссылка), `components/settingsSearch.ts` (переход), места вызова
  `openWorkspaceSettings({tab: 'telephony'})`, `features/telephony/{pages.ts,TelephonySection.tsx,
  PhoneTelephony.tsx}` (группа «Настройки», ⚙), `lib/telephonyAccess.ts` (ветки администратора),
  `i18n/*/{sip.ts,pbx.ts}` (существующие ключи; новые — там же, не в `telephony.ts`, чтобы не
  конфликтовать с T4).
- Тесты: `e2e-visual/telephony.visual.spec.ts` и `test('m-telephony')` в `mobile.visual.spec.ts` —
  **существующие шаги переводятся на новую навигацию** (из окна настроек в раздел), имена кадров
  `telephony-*`/`m-telephony-*` сохраняются там, где экран тот же; `e2e-support/mock-sip.ts`,
  `mock-pbx.ts` — без изменения API.
- Docs: `docs/08` «Телефония» (настройки в разделе; таблица журнала и вкладки настроек удалены из текста),
  `docs/09-ui-backlog.md` — закрыть строки, которые снимает перенос.

**Тесты.** Unit: `telephonyAccess.test.ts` (ветки администратора, тариф), `settingsSearch.test.ts`
(переход), существующие тесты `lib/sipPbx.test.ts`, `lib/sip.test.ts` — зелёные без правок логики.

**Визуальные проверки (обязательные кадры).**
- iPhone 14: `m-tel-settings` (список со значениями), `m-tel-not-connected` (администратор, пусто),
  `m-tel-plan-lock`, `m-tel-settings-connection` (форма + проверка, ошибка поля), `m-tel-settings-inbound`
  (регистрация: успех и ошибка), `m-telephony` / `m-tel-numbers` (список), `m-telephony-number-no-external`
  (форма номера), `m-telephony-group` (форма группы), `m-tel-group-reorder` (режим перетаскивания),
  `m-telephony-ivr` (список меню), `m-telephony-menu` (сетка клавиш), `m-tel-ivr-key-picker` (карточка
  выбора действия, второй уровень), `m-telephony-prompt`, `m-telephony-menu-notice`, `m-tel-recording`,
  `m-tel-retention`, `m-tel-save-keyboard` (липкое «Сохранить» над клавиатурой).
- Десктоп dark-960: существующие `telephony-numbers`, `telephony-groups`, `telephony-group-form`,
  `telephony-ivr`, `telephony-menu-form`, `telephony-settings`, `telephony-inbound-register`,
  `telephony-recording` — уже в разделе; новые `telephony-not-connected`, `telephony-retention`,
  `settings-no-telephony` (окно настроек без пункта); светлая тема — `telephony-settings`.

**Готово, когда:** проверки, все кадры просмотрены и исправлены, в окне настроек нет телефонии ни в
каком виде, администратор без подключения находит раздел, docs обновлены.

---

## После T5

- Релизный агент: CHANGELOG «Коротко» (раздел «Телефония», контакты, звонок из раздела, подробный журнал),
  `docs/13-usage.md` — как обычно. Старый `GET …/calls` — удалить через два релиза (строка в docs/12).
- Текст о персональных данных (номера третьих лиц в журнале и книге: политика/оферта, подсказка в
  разделе) — отдельный этап (владелец 27.10), черновик на согласование владельцу. Срок хранения и
  лимиты решены и сделаны в T1.
