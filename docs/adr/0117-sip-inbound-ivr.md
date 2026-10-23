# ADR-0117: Телефонная станция — входящие на SIP-номер, внутренние номера, группы и IVR (2026-10-22)

**Статус: предложено** (ждёт ответов владельца на вопросы в конце; принимается без кода — реализация
отдельной задачей после решения). Продолжает [ADR-0046](0046-sip-telephony.md) (телефония SIP: исходящие,
транк провайдера, `sip_calls`, `PLACE_CALLS`), опирается на [ADR-0034](0034-calls.md) (звонок один на один:
сигналинг `CALL_RING`/`CALL_STATE`, `user_call`, модалки), [ADR-0048](0048-roles-v2.md) (`MANAGE_INTEGRATIONS`,
`VIEW_JOURNALS`), [ADR-0036](0036-soundboard.md) (перекодирование аудио в Ogg/Opus через ffmpeg контейнера api),
[ADR-0013](0013-livekit-minimal-client.md) (в API нет pion / `livekit/protocol`), [ADR-0019](0019-move-without-sfu.md)
(в LiveKit OSS нет `MoveParticipant`), [ADR-0109](0109-bot-rights-like-people.md) (боты — по тем же битам).
Задача CBF-65 (#65).

## Контекст

Слова владельца: «SIP-номер принимает входящие. Варианты ответа: внутренний номер (ext) или автоответ (IVR):
загрузить mp3/wav/ogg, проигрывать и ждать нажатия кнопки; на кнопку назначается действие: переключить на
другой автоответ, на сотрудника, на бота, в группу, повторить, положить трубку. Боты тоже могут иметь
внутренний номер и принимать переключённые входящие. Внутренние номера назначаются сотрудникам через меню SIP
владельцем/админом; у номера есть описание (например „Бухгалтерия“) — только справочно. Группы: у группы свой
номер (1001) и участники (101, 102, 103); звонок в группу — звонят все сразу или по очереди (round-robin) с
выбором порядка; группа — цель маршрута (в том числе из IVR)». ADR-0046 обещал это как «1.4+».

### Что есть сегодня (проверено по коду, 22.10)

- **Только исходящие.** `internal/sip` (~1,5 тыс. строк): один аккаунт провайдера на пространство
  (`sip_accounts`, пароль в sealbox `calaba/sip-password/v1`), `SIPOutboundTrunk` в LiveKit (`trunk_id`),
  `POST /api/rooms/{id}/calls` → `CreateSIPParticipant` в LiveKit-комнату голосовой комнаты, линия —
  участник `sip:<call id>` с атрибутом `sip.callStatus`; статусы из ответа `CreateSIPParticipant` и вебхуков
  (`rtc.SIPHook`: `SIPParticipant`, `PersonLeft`, `SIPRoomFinished`); журнал `sip_calls` с
  `direction in|out`, где `in` зарезервирован и **ни разу не пишется**; метёлка потерянных звонков раз в 30 с.
  Лимиты: 20 звонков/ч, гудки 45 с, разговор ≤ 2 ч, 1 живой звонок на комнату. Телефония — только Business и
  on-prem (`telephony_disabled`).
- **Входящие закрыты на уровне инфраструктуры**: `infra/docker/livekit/sip.yaml.tpl` — `hide_inbound_port:
  true` («неаутентифицированные INVITE молча отбрасываются»); inbound-транков, dispatch-правил, DTMF, IVR,
  внутренних номеров и групп в коде нет (`grep -i "inbound|dispatch|dtmf|extension"` по `internal/sip` — пусто).
  `rtc.SIP` умеет только `Create/Update/DeleteSIPOutboundTrunk` и `CreateSIPParticipant`. Файрвол стенда уже
  открыт на 5060 udp/tcp и 10000–10200/udp (201 RTP-порт — общий потолок одновременных линий, docs/03).
- **Права**: настройки SIP и проверка — `MANAGE_INTEGRATIONS` (ADR-0048; боты — так же, ADR-0109), журнал —
  `VIEW_JOURNALS`, звонить — `PLACE_CALLS` (бит 24). Enum `Permission` заполнен до бита 31; биты ≥ 32 требуют
  схемы `PermissionBit` из ADR-0048 «Следующие биты» (не реализована) либо констант вне enum (как биллинг/диск).
- **Звонок один на один (ADR-0034)** — готовый образец «позвонить человеку»: LiveKit-комната вне пространства
  (`dm:<room id>`), состояние в Redis (`call:<id>`, `user_call:<uid>` — занятость, `call:ringing` — таймауты),
  события `CALL_RING` всем устройствам вызываемого + `CALL_STATE`, таймаут 45 с, `lost` через 30 с без
  устройства, пуш на `CALL_RING` (`internal/push/delivery.go`, `callKind`), модалки входящего/исходящего,
  `voice.join(..., {call: true})`. Боты звонить и принимать не могут (403).
- **Аудио на сервере**: ffmpeg/ffprobe 8.0 (статические) уже в образе api (`apps/server/Dockerfile`,
  `FFMPEG_PATH`, один слот); `files/sound.go` перекодирует загрузку MP3/Ogg/WAV (≤ 2 МБ) в Ogg/Opus 48 кГц
  моно −16 LUFS, обрезая до 5 с; формат определяется по содержимому (`AudioFormat`), демуксер принудительный.
  Звуки саундборда **не** попадают в LiveKit-комнату: `SOUND_PLAY` идёт по gateway, каждый клиент играет файл
  сам через `<audio>`. Значит, механизма «проиграть файл телефонному абоненту» в системе нет — его надо
  строить.
- **Голос ботов**: бот входит в голос как человек (`POST /api/rooms/{id}/join`, `VIEW_ROOM + CONNECT`) и
  работает с LiveKit напрямую (`@livekit/rtc-node`, примеры `examples/bots/voice-echo`, `tts`).
- **LiveKit** (`livekit/sip:v1.14.0`, `livekit-server v1.13.7`; `livekit/protocol v1.52.1` в тестах):
  `CreateSIPInboundTrunk` (`numbers`, `allowed_addresses`, `allowed_numbers`, `auth_*`, `ringing_timeout`,
  `max_call_duration`), `CreateSIPDispatchRule` (`SIPDispatchRuleIndividual {room_prefix}` — своя комната на
  каждый звонок, `trunk_ids`, `metadata`/`attributes` наследуются участником, `room_config`), DTMF абонента
  приходит в комнату как data-пакет `SipDTMF {code, digit}`, `TransferSIPParticipant` — SIP REFER на внешний
  URI. Атрибуты входящей линии (`sip.phoneNumber`, `sip.trunkPhoneNumber`, `sip.callID`, `sip.ruleID`) — по
  документации LiveKit, в коде репозитория не проверялись (см. «Проверить в реализации»). Регистрации
  (REGISTER) у провайдера LiveKit SIP не делает: входящие возможны только от провайдера, который шлёт INVITE
  на наш публичный адрес (IP-транк / «SIP URI»).

## Решение

### 1. Границы версии (v1 станции)

Делаем: входящие на единственный номер пространства (`sip_accounts.caller_id`); точка входа — внутренний номер
человека/бота **или** голосовое меню; меню с загруженным аудио и действиями на кнопки `0–9 * #`; внутренние
номера людей и ботов с описанием; группы со своим номером, участниками, порядком и стратегией «все сразу» /
«по очереди»; таймауты, занято, нет ответа, нет участников; журнал; пуш и модалка входящего на клиенте.

Не делаем (см. §9): несколько номеров, набор внутреннего номера с телефона, перевод во время разговора, музыка
ожидания, расписание (рабочие часы), очередь с позицией, голосовая почта/запись входящих, исходящий Caller ID
на сотрудника, перевод на внешний номер (`TransferSIPParticipant`).

### 2. Архитектура: кто играет аудио и слушает кнопки

Проигрывать файл телефонному абоненту может только участник LiveKit-комнаты с аудиотреком. Варианты:
1. **Медиа в процессе API** — отклонено: ADR-0013 держит API без pion/`livekit/protocol` (−12,7 МБ RSS,
   бюджет 50 МБ, docs/01); API в проде живёт в k8s, а LiveKit/SIP — на стенде: RTP через интернет из k8s
   добавил бы задержку и NAT-проблемы; API должен оставаться stateless и лёгким.
2. **LiveKit Agents (Python, agent dispatch в dispatch-правиле)** — отклонено: второй рантайм и фреймворк ради
   проигрывания файла и чтения DTMF; логика маршрутов всё равно нужна в API (права, пространства, журнал).
3. **Встроенный `pin`-промпт LiveKit SIP** — не настраивается (только «введите PIN»), не подходит.
4. **Принято: маленький Go-воркер `calab-ivr`** (`apps/server/cmd/ivr`, тот же Go-модуль, но пакеты pion /
   `livekit/server-sdk-go/v2` импортирует только этот бинарник — API-бинарник не растёт), отдельный образ,
   compose-сервис `ivr` в профиле `sip` рядом с `livekit/sip` на стенде (`network_mode: host`, LiveKit по
   `ws://127.0.0.1:7880`). Воркер — «руки», API — «голова»:
   - воркер держит **исходящее** WebSocket-соединение к API (`GET /internal/ivr-agent` с токеном
     `IVR_AGENT_TOKEN` из env обоих; входящих портов у воркера нет); при нескольких репликах API команды
     публикуются через Redis-канал `ivr:cmd` (тот же fan-out, что у gateway), доставляет их реплика,
     держащая соединение; одна реплика воркера (`replicas: 1`), горизонтальное масштабирование — не в v1;
   - команды API → воркер: `join {call_id, room, token}`, `play {call_id, file_id, loop}`
     (`file_id` — готовый Ogg/Opus, §6; `loop` — для гудка), `stop`, `leave`. Встроенный гудок (ringback,
     Ogg/Opus в бинарнике воркера) — `play {builtin: "ringback", loop: true}`;
   - события воркер → API: `joined`, `played` (файл доиграл), `dtmf {digit}` (из `SipDTMF`), `left`, `error`.
     Файл воркер получает `GET /internal/ivr-agent/files/{id}` тем же токеном и кэширует на диске по id
     (контент неизменяем: новая загрузка = новый id; LRU 200 МБ);
   - в API воркер скрыт за интерфейсом `rtc.IVRAgent` (мок в тестах, как `rtc.SIP`); нет соединения с
     воркером — входящий получает «занято» (DeleteRoom), `last_error` «IVR-воркер недоступен».
   Воркер публикует трек из Ogg/Opus напрямую (pion `oggreader`, без перекодирования и cgo); в G.711 для
   телефона перекодирует `livekit/sip`. DTMF берётся только из data-пакетов `SipDTMF` (RFC 2833 / INFO
   разбирает `livekit/sip`), in-band тонов не распознаём.

Состояние звонка (шаг маршрута, попытки, кто звонит, дедлайны) — в Redis `sipin:<call id>` с TTL 3 ч и
индексом дедлайнов `sipin:due` (как `call:ringing` в ADR-0034): любая реплика API продолжает сценарий по
событию воркера или тику; общий тик 5 с.

### 3. Модель данных (миграция — следующая свободная; вышла `00109_sip_pbx.sql`)

- `sip_accounts` +: `inbound_enabled bool`, `inbound_trunk_id text` (`SIPInboundTrunk`), `inbound_rule_id text`
  (`SIPDispatchRule`), `inbound_target_kind text CHECK (extension|menu)`, `inbound_target_id uuid` (точка входа;
  `ON DELETE SET NULL` через триггеры/приложение — см. правило «маршрут никогда не блокирует удаление»),
  `inbound_allowed_cidrs text[]` (адреса провайдера сверх резолва `host`; пусто = только резолв).
- `sip_extensions (id uuid PK, workspace_id FK CASCADE, number text, kind text CHECK (user|group),
  user_id uuid? → users, group_id uuid? → sip_groups, description text ≤ 64, created_at, created_by)` —
  **одно пространство номеров** для людей, ботов и групп: `UNIQUE (workspace_id, number)`,
  `UNIQUE (workspace_id, user_id) WHERE user_id IS NOT NULL`, ровно одно из `user_id`/`group_id` (CHECK).
  `number` — 2–6 цифр, любые (владелец: 101, 1001), ведущий ноль допустим; других символов нет. Человек — участник пространства не гость (гостям номер не выдаётся; при
  понижении до гостя / выходе из пространства строка удаляется: FK на `workspace_members (workspace_id,
  user_id) ON DELETE CASCADE`). Бот — такой же `user_id` (бот = пользователь, ADR-0031).
- `sip_groups (id uuid PK, workspace_id FK CASCADE, name text 1..64, strategy text CHECK (ring_all|round_robin),
  ring_sec int (30; 10..60 — «все сразу»), member_ring_sec int (15; 5..60 — на участника «по очереди»),
  next_position int (указатель round-robin, растёт после каждого звонка), on_fail_kind text CHECK
  (hangup|menu|extension), on_fail_id uuid?, created_at, updated_at)`; номер группы — строка `sip_extensions`
  с `kind = group` (создаётся вместе с группой, удаляется с ней).
- `sip_group_members (group_id FK CASCADE, extension_id FK sip_extensions CASCADE, position int, PK (group_id,
  extension_id))` — только `kind = user` (CHECK через триггер или проверка в API). ≤ 20 участников.
- `sip_ivr_menus (id uuid PK, workspace_id FK CASCADE, name text 1..64, prompt_file_id uuid? → files SET NULL,
  prompt_status text CHECK (none|ready|failed), prompt_duration_ms int, prompt_error text, input_timeout_sec int
  (5; 3..15), repeats int (3; 1..5), on_no_input_kind text CHECK (hangup|menu|extension|group), on_no_input_id
  uuid?, created_at, updated_at, updated_by)`. ≤ 20 меню на пространство.
- `sip_ivr_items (menu_id FK CASCADE, digit char(1) CHECK (0-9*#), action_kind text CHECK
  (menu|extension|group|repeat|hangup), action_id uuid?, PK (menu_id, digit))`. «На сотрудника» и «на бота» —
  одно действие `extension` (цель — внутренний номер человека или бота); «в группу» — `group` (можно и
  `extension` группы — одно и то же, API нормализует к `group`).
- `sip_calls` +: `lk_room text` (имя LiveKit-комнаты входящего; у исходящих пусто), `answered_by uuid? →
  users SET NULL`, `route text ≤ 500` (путь для журнала: `menu:<id>/2 → group:<id> → ext:<id>`), `ringing_user_ids
  uuid[]` (кому сейчас звонит — для `SIP_CALL_UPDATE` и RESUME). `direction = in`, `room_id NULL`,
  `number` = номер звонящего (E.164 или как прислал провайдер, если не нормализуется), `started_by NULL`.
  Частичный уникальный индекс «один живой звонок на комнату» входящих не касается (`room_id NULL`).
- **Правило целостности**: все ссылки маршрутов (`inbound_target_id`, `on_fail_id`, `on_no_input_id`,
  `action_id`) — `ON DELETE SET NULL` (FK по виду цели: отдельные nullable-колонки `*_menu_id`/`*_extension_id`/
  `*_group_id` с CHECK «одна заполнена», чтобы FK были настоящими). Удаление участника, группы или меню
  **никогда не блокируется** маршрутом: пустая цель на звонке ведёт себя как `hangup` (меню) / `on_fail`
  (группа), в UI — предупреждение «Назначение удалено» у пункта.
- `WorkspaceMember.extension` (string, пусто = нет) — в снапшоте и `WORKSPACE_MEMBER_UPDATE` при выдаче/снятии;
  гостям поле не отдаётся (как `badge`). Колонки в `workspace_members` нет — join на `sip_extensions`.

### 4. Поток входящего вызова

1. **INVITE провайдера** → `livekit/sip` (в `sip.yaml.tpl` `hide_inbound_port: false`, когда на стенде включены
   входящие; чужие INVITE теперь получают SIP-отказ, а не тишину) → `SIPInboundTrunk` пространства
   (`numbers = [caller_id]`, `allowed_addresses` = A/AAAA `host` на момент сохранения ∪ `inbound_allowed_cidrs`,
   `max_call_duration = 2 h`, `krisp_enabled = false`) → `SIPDispatchRuleIndividual {room_prefix =
   "sipin_<workspace id>_"}` (`trunk_ids` = только этот транк, `metadata` = id пространства,
   `room_config.empty_timeout = 30 s`, `max_participants = 4`). LiveKit отвечает 200 OK — для провайдера
   звонок принят с этого момента (тарификация у абонента идёт, пока играет меню и гудки).
2. **Вебхук `participant_joined`** линии в комнате `sipin_*` → `rtc.webhook` по префиксу (не `voice.ParseRoomName`)
   → новый хук `SIPHook.InboundJoined(wid, room, participant)`. API: тариф (`telephony_disabled` →
   `DeleteRoom`), `inbound_enabled`, лимиты (60 входящих/ч на пространство — `rl:sip-in:`; ≤ 5 одновременных
   входящих на пространство; воркер подключён), строка `sip_calls` (`in`, `ringing`... см. статусы ниже),
   состояние `sipin:<id>`, затем **точка входа** (`inbound_target`).
3. **Шаги маршрута** (`step(target)`), счётчик переходов ≤ 10 на звонок (меню → меню → … без выхода =
   `hangup`, причина `loop`):
   - **Меню**: воркер `join` + `play(prompt)`. Кнопка во время проигрывания **прерывает** его (barge-in) и
     обрабатывается сразу. После `played` — ждём `input_timeout_sec`. Нет нажатия → попытка +1, снова `play`;
     попыток > `repeats` → `on_no_input` (по умолчанию `hangup`). Кнопка без пункта — как нет нажатия (попытка
     +1, повтор). `repeat` — повтор без счёта попыток, но в счёт переходов. `prompt_status != ready` → меню
     ведёт себя как `on_no_input` сразу (в UI такое меню помечено, включить входящие на него нельзя).
   - **Внутренний номер (человек или бот)**: цель — участник пространства не гость, не забанен, с номером.
     **Занят** = есть `user_call:<uid>` (DM-звонок, ADR-0034) или он уже отвечает/звонит в другом входящем
     (`sipin:user:<uid>`); занятость учитывает только это — человек в голосовой комнате пространства **не
     занят** (как в ADR-0034 §4: звонит, принимая — выходит из комнаты). Воркер `play(ringback, loop)`;
     событие `SIP_INBOUND_RING {call, via}` в `user:<uid>` всем устройствам (+ пуш, как `CALL_RING`); боту —
     то же событие в gateway/webhook. Таймаут `ring_sec` (30 с для прямого номера) → `on_fail` точки входа /
     меню. «Отклонить» на любом устройстве = нет ответа сразу. **Принял** → `POST /api/sip/inbound/{cid}/accept`
     → `{call, url, token}` (токен в комнату `sipin_*`: микрофон + подписка, без камеры/экрана в v1), API:
     `answered_by`, `answered_at`, статус `active`, `SIP_CALL_UPDATE` остальным звонившим устройствам (прячут
     модалку), воркер `stop` + `leave`. Клиент — `voice.join(url, token, {call: true})`, UI как у звонка
     ADR-0034 (шапка «Звонок · +7 916 … · 00:42», «Завершить»).
   - **Группа**: участники группы с проверками выше; занятые пропускаются. `ring_all` — всем доступным сразу
     на `ring_sec`, первый принявший получает звонок, остальным `SIP_CALL_UPDATE` (`answered_by` ≠ я → закрыть
     модалку). `round_robin` — по `position` начиная с `next_position`, каждому `member_ring_sec`, «не в сети»
     (нет presence-сессии) пропускаются (пуш за 15 с не поможет), один полный круг; `next_position` сдвигается
     на следующего после того, кто **принял** (или на одного, если никто). Нет доступных участников (пусто, все
     заняты, при round-robin все офлайн) → сразу `on_fail` группы (по умолчанию `hangup`). Для `ring_all`
     офлайн-участники звонят (пуш на телефон).
   - **Бот как цель**: тот же `SIP_INBOUND_RING` (gateway и webhook бота), `POST …/accept` через `botAllow` →
     токен; бот входит в комнату через `@livekit/rtc-node` и дальше сам (TTS/STT — его дело). Не ответил за
     `ring_sec` → `on_fail`. Боты в группах разрешены (владелец: боты принимают переключённые входящие), UI
     предупреждает, что неотвечающий бот тратит время участников очереди.
   - **Положить трубку**: воркер `leave`, `DeleteRoom` (BYE абоненту), статус `ended`, причина по месту
     (`hangup_menu`, `no_input`, `no_answer`, `no_members`, `loop`, `busy_limit`, `agent_unavailable`).
4. **Разговор**: абонент ↔ ответивший в комнате `sipin_*`. Абонент положил трубку → `participant_left` линии →
   `ended/remote`, `SIP_CALL_UPDATE` ответившему (клиент выходит). Ответивший → `DELETE /api/sip/inbound/{cid}`
   → `DeleteRoom`, `ended/hangup`. Ответивший пропал (нет устройства 30 с, вебхук `participant_left` без
   возврата) → `ended/lost`. 2 ч — `max_call_duration` транка + метёлка (как у исходящих). `room_finished` →
   финализация строки, если ещё живая. Вебхуки комнат `sipin_*` не трогают `voice`-состояния пространства.
5. **Статусы** `SipCall` для входящих: `ringing` (с момента входа линии до ответа: меню и гудки — всё
   «звонит» для журнала; `ringing_user_ids` говорит, кому именно) → `active` → `ended`; `ringing → ended`
   без ответа (`reason` выше), `failed` — только системные отказы (`agent_unavailable`, `plan`, `disabled`).
6. **Отключение**: `PUT …/sip` с `inbound_enabled = false` или `enabled = false` → удалить dispatch-правило и
   inbound-транк в LiveKit, живые входящие положить (`disabled`). Понижение тарифа — как у исходящих: ничего не
   удаляется, новые входящие отбиваются (`DeleteRoom`, `failed/plan`), настройки видны.

### 5. Права

- **Настраивать всё** (входящие, точка входа, внутренние номера, группы, меню, загрузка аудио) —
  `MANAGE_INTEGRATIONS` пространства, не гость (там уже живут настройки SIP; «владелец/админ» владельца =
  встроенные роли, которые бит включают). Боты — так же (ADR-0109). Нового бита **нет**: enum заполнен, схема
  `PermissionBit ≥ 32` — отдельная работа, а разделять «настройки провайдера» и «маршруты» владелец не
  просил. Если попросит — бит `MANAGE_TELEPHONY` по схеме ADR-0048 «Следующие биты» новым ADR.
- **Видеть внутренние номера** — все участники не гости (`WorkspaceMember.extension` в снапшоте; список
  `GET …/sip/extensions` — не гость). Меню, группы и их состав — только `MANAGE_INTEGRATIONS`.
- **Принимать входящие** — никакого бита: звонок получает тот, кому админ выдал номер / кого поставил в
  группу или меню. Гость — никогда (номера не получит). `accept`/`decline`/`hangup` — только тот, кому звонит
  / кто ответил (боты — `botAllow`); положить чужой входящий — `MANAGE_INTEGRATIONS`.
- **Журнал** — `VIEW_JOURNALS` (как сейчас); входящие — строки с пустой комнатой и `direction = in`,
  `answered_by`, `route`. Номер звонящего виден ответившему, звонившим и в журнале; гостям события входящих не
  доставляются (их нет среди целей).
- Все проверки на сервере; LiveKit-токен `accept` — только мик + подписка в конкретной `sipin_*`-комнате.

### 6. Аудио меню: загрузка, хранение, доступ

- Загрузка — обычный `POST /api/workspaces/{id}/files` вызывающим (как источник саундборда), затем
  `PUT /api/workspaces/{id}/sip/ivr/{menuId} {prompt_source_file_id}`. Сервер: файл пространства, загружен
  вызывающим, по содержимому MP3 / Ogg (Vorbis или Opus) / WAV (`files.AudioFormat`, принудительный
  демуксер), **≤ 10 МБ**, длительность после перекодирования **≤ 3 мин** (иначе `422 promptSourceFileId`);
  перекодирование ffmpeg контейнера api в том же слоте, что саундборд (`soundTimeout` поднять до 60 с для 3-мин
  файлов): Ogg/Opus 48 кГц моно 32 кбит/с (для телефона хватает; ≈ 700 КБ на 3 мин), громкость −16 LUFS
  (иначе тихие записи неслышны в трубке). Результат — новый системный файл (`files`, в квоте пространства),
  источник удаляется; `prompt_duration_ms` сохраняется; `ErrNoFFmpeg` → `503` «сервер без ffmpeg».
- Доступ к файлу: `GET /api/files/{id}` — `MANAGE_INTEGRATIONS` (прослушать в настройках через `<audio>`),
  воркер — `GET /internal/ivr-agent/files/{id}` по своему токену. Другим участникам файл не отдаётся
  (`FileRooms`-подобная проверка: файл-подсказка принадлежит меню пространства). Файл держится вне чистки
  сирот ссылкой `sip_ivr_menus.prompt_file_id` (добавить в `ListOrphanFiles`-исключения); при замене/удалении
  меню старый файл удаляется, квота освобождается.
- **Шифрование**: нет. Подсказка — публичный контент (его слышит любой позвонивший), sealbox не нужен;
  хранение — как у всех файлов (ADR-0011: диск / S3, наружу не доступно). Кэш воркера — локальный диск
  контейнера (tmpfs/volume), чистится LRU, при рестарте забирается заново.
- Встроенные аудио (гудок ringback; при желании владельца — стандартные фразы «Все операторы заняты») — в
  бинарнике воркера, Ogg/Opus, как `assets/sounds` клиента.

### 7. Клиент (кратко; детали — в docs/08 «Телефония» при реализации)

- Настройки пространства → «Телефония» получает карточки: **«Входящие»** (переключатель, точка входа — выбор
  «Внутренний номер …» / «Меню …», адреса провайдера, состояние «Правило сохранено» / `last_error`);
  **«Внутренние номера»** (таблица номер · участник/бот · описание; добавить — `MemberPicker` без гостей,
  номер, описание; у группы номер показан в её строке); **«Группы»** (имя, номер, стратегия, порядок участников
  drag&drop, таймауты, «если никто не ответил»); **«Голосовые меню»** (имя, загрузка аудио с индикатором
  перекодирования и кнопкой прослушать, длительность, сетка кнопок `1–9 0 * #` с действием каждой, «нет
  ввода»: таймаут/повторы/действие). Предупреждения на пустых целях.
- Профиль/карточка участника: «вн. 101 · Бухгалтерия» под именем (не гостям).
- Входящий — модалка ADR-0034 с номером абонента крупно, строкой «Входящий на SIP-номер · через „Отдел продаж“»
  (`via`), «Принять»/«Отклонить», рингтон `call-incoming`, пуш при скрытом окне; принятый — UI звонка. Все
  устройства звонят, принятие на одном закрывает остальные (`SIP_CALL_UPDATE`). RESUME — `READY.sip_calls`
  содержит входящие, где я в `ringing_user_ids` или `answered_by`.
- Мобильный веб — те же модалки (фоновая вкладка не звонит — ограничение веба, пуш остаётся).
- Новые экраны — визуальная спека и один прогон `e2e:visual -g "telephony"` по правилу CLAUDE.md.

### 8. Инфраструктура и эксплуатация

- `sip.yaml.tpl`: `hide_inbound_port: false` под переменной `SIP_INBOUND=1` (без неё — как сейчас); при
  включении стенд-агент проверяет логи `sip` на шум сканеров (теперь отвечаем 4xx, не молчим) — защита:
  `allowed_addresses` транков и отсутствие транка для неизвестного номера.
- Новый контейнер `ivr` (профиль `sip`, `IVR_AGENT_TOKEN`, `API_URL`, `LIVEKIT_URL=ws://127.0.0.1:7880`,
  ключ/секрет LiveKit как у `sip`), лимиты ресурсов как у `sip`. API: `IVR_AGENT_TOKEN` (пусто = входящие
  недоступны, `PUT` с `inbound_enabled` → `409 SIP_DISABLED` «IVR-воркер не настроен»).
- Ёмкость: 201 RTP-порт на стенде на все линии (входящие + исходящие); лимит ≤ 5 одновременных входящих на
  пространство; воркер — один аудиотрек на звонок, ~1–2 % CPU на звонок.
- `docs/06` — раздел «Телефония» дополнить шагами включения входящих; `docs/03` — замечание про `hide_inbound_port`.

### 9. Не делаем в этой версии (и как модель к этому готова)

- Несколько номеров / маршрут по номеру — `sip_accounts` один; позже `sip_numbers (number, target)` с `numbers`
  dispatch-правила, точка входа переедет туда.
- Набор внутреннего номера с телефона («наберите номер сотрудника») — `sip_extensions.number` уже есть,
  нужен шаг меню «ввод номера» (`action_kind = dial_extension`) и сбор нескольких цифр.
- Перевод во время разговора (ответивший переводит на коллегу) — повторный `step(extension)` в той же
  комнате; на внешний номер — `TransferSIPParticipant`.
- Музыка/объявления ожидания (сейчас — стандартный гудок), расписание (рабочие часы → другое меню), очередь с
  позицией, голосовая почта, запись входящих (egress в `sipin_*`), Caller ID на сотрудника, SMS.

## Последствия

- Протокол, миграция и новые маршруты — ниже; `rtc.SIP` растёт на `Create/Update/DeleteSIPInboundTrunk`,
  `Create/DeleteSIPDispatchRule`; `rtc.SIPHook` — на хуки комнат `sipin_*`; `rtc.webhook` различает три вида
  комнат (пространство, `dm:`, `sipin_`).
- Новый деплой-юнит `calab-ivr` (образ, compose-профиль, env, `images.yml`), новая зависимость модуля
  (`livekit/server-sdk-go/v2` + pion) только в `cmd/ivr`; CI — `go vet`/lint на весь модуль, интеграционные
  тесты API с моком `rtc.IVRAgent`, тест воркера против настоящего LiveKit (`compose.dev`) — проигрывание
  Ogg и приём `SipDTMF` (`-tags integration`).
- Тарификация абонента начинается с 200 OK LiveKit (на меню), а не с ответа сотрудника — особенность LiveKit
  SIP, объяснить в документации владельцу.
- Второе независимое ревью обязательно: открываем входящий SIP на публичном порту (`allowed_addresses`, шум
  сканеров, DNS rebinding провайдера — backlog docs/12 от 30.09 (а) становится актуальнее: пересчитывать
  `allowed_addresses` при каждом сохранении и раз в сутки), токены воркера, `accept` без проверки цели.
- Минорные хвосты — строкой в docs/12 (сервер) / docs/09 (UI), не задачами.

## Что меняется в протоколе (`proto/calaba/v1`, без кода)

- `sip.proto`:
  - `SipSettings` +: `inbound_enabled`, `inbound_target (SipRouteTarget)`, `inbound_allowed_cidrs`, `inbound_saved`
    (транк и правило в LiveKit); `PutSipSettingsRequest` — те же поля; `enabled = false` сбрасывает входящие.
  - `SipRouteTarget {SipRouteKind kind (HANGUP|REPEAT|MENU|EXTENSION|GROUP); string id}` — единый тип цели
    (точка входа, пункт меню, «нет ввода», «никто не ответил»); `REPEAT` допустим только в пунктах меню.
  - `SipExtension {id, workspace_id, number, kind (USER|GROUP), user_id, group_id, description, created_at}`;
    `SipGroup {id, name, extension (SipExtension), strategy (RING_ALL|ROUND_ROBIN), ring_sec, member_ring_sec,
    on_fail (SipRouteTarget), members: repeated SipGroupMember {extension_id, position}, updated_at}`;
    `SipIvrMenu {id, name, prompt_file_id, prompt_status (NONE|READY|FAILED), prompt_duration_ms, prompt_error,
    input_timeout_sec, repeats, on_no_input (SipRouteTarget), items: repeated SipIvrItem {digit, action
    (SipRouteTarget), target_missing bool}, updated_at, updated_by}`; списки `ListSipExtensionsResponse` и т. д.
  - `SipCall` +: `answered_by`, `route`, `ringing_user_ids`, `via` (имя меню/группы для модалки — вычисляемое);
    комментарии к `SIP_CALL_DIRECTION_IN` снять «never produced».
  - REST (все под `/api/workspaces/{id}/sip/…`, `MANAGE_INTEGRATIONS`, не гость; боты — так же):
    `GET|POST extensions`, `PATCH|DELETE extensions/{eid}`; `GET|POST groups`, `PATCH|DELETE groups/{gid}`
    (`PATCH` принимает весь состав с порядком); `GET|POST ivr`, `PATCH|DELETE ivr/{mid}` (`PATCH` с
    `prompt_source_file_id` запускает перекодирование синхронно, до 60 с, ответ — меню с `prompt_status`).
    `GET …/sip/extensions` — любой не гость. Входящие: `POST /api/sip/inbound/{cid}/accept` →
    `{call, url, token}`, `POST …/decline`, `DELETE /api/sip/inbound/{cid}`. Ошибки: `409 SIP_EXTENSION_TAKEN`
    (новый код `common.proto`, следующий свободный — 70 на 22.10), `422 VALIDATION` с `field`
    (`number`, `description`, `digit`, `promptSourceFileId`, `ringSec` …), `409 CONFLICT` (accept не моего /
    уже отвеченного звонка; лимиты меню/групп/номеров), `409 SIP_DISABLED` (воркер не настроен), `PLAN_LIMIT`.
- `gateway.proto`: `SipInboundRing sip_inbound_ring = 102` (следующий свободный номер `DispatchEvent` на
  22.10) `{SipCall call; string via}` — устройствам цели (`user:<id>`), ботам — gateway и webhook;
  `SIP_CALL_UPDATE` для входящих — в `user:<id>` всем из `ringing_user_ids` ∪ `answered_by` (не в `ws:`);
  `WorkspaceSnapshot.sip_calls` включает входящие, где получатель звонит или ответил. `WorkspaceMember.extension`
  (`workspace.proto`), `WORKSPACE_MEMBER_UPDATE` при изменении.
- Внутренний контракт воркера (`/internal/ivr-agent`, не proto-контракт клиента) — отдельный `ivr.proto` в
  том же пакете для JSON-кадров команд/событий, чтобы Go-воркер и API делили типы; в `packages/protocol` не
  экспортируется.
- Пуш: `internal/push/delivery.go` — `SIP_INBOUND_RING` как `callKind` (заголовок «Входящий звонок · +7 916 …»).

## Проверить в реализации

1. `livekit/sip:v1.14.0`: имена атрибутов входящей линии (`sip.phoneNumber`, `sip.trunkPhoneNumber`, `sip.ruleID`),
   что `SipDTMF` действительно публикуется data-пакетом в комнату (и с каким `kind`), что `room_config`
   dispatch-правила применяется в OSS (поле помечено Cloud-only у `room_preset`, у `room_config` — нет), и что
   `SIPDispatchRuleIndividual` без `pin` отвечает 200 сразу (момент начала тарификации).
2. Identity входящей линии в OSS — `sip_<номер>` по умолчанию; `rtc.webhook` должен ловить входящие по имени
   комнаты, а не по префиксу `sip:` (у исходящих identity наш).
3. `allowed_addresses` принимает IP/CIDR, не имена — резолв `host` при сохранении; провайдер с меняющимися
   адресами (пул) требует CIDR от админа (`inbound_allowed_cidrs`).
4. Публикация Ogg/Opus pion-треком: размер страницы/ptime 20 мс, чтобы `livekit/sip` ровно перекодировал в
   G.711; barge-in — `stop` должен обрывать трек без щелчка (замьютить, затем unpublish).
5. Один слот ffmpeg: 3-минутный файл — ~1–2 с перекодирования, но слот общий с HEIC и саундбордом;
   `soundTimeout` 20 с → 60 с только для подсказок.
6. Нагрузка Redis-тика 5 с на дедлайны при нулевом количестве входящих — должна быть одной командой `ZRANGEBYSCORE`
   (бюджет CPU без звонков).

## Открытые вопросы владельцу

1. **Провайдер и способ входящих.** LiveKit SIP не регистрируется (REGISTER) у провайдера — входящие возможны
   только если провайдер шлёт INVITE на наш IP (IP-транк / «переадресация на SIP URI»; у Zadarma, Mango,
   Телфин такое есть). (а) В v1 — только такие провайдеры, в UI так и написать; (б) добавить SIP-регистратор
   (Kamailio/OpenSIPS перед `livekit/sip`) — отдельный ADR и ещё один контейнер. Рекомендую (а). Какой у вас
   провайдер и номер для проверки?
2. **Кто настраивает маршруты.** (а) `MANAGE_INTEGRATIONS` — как настройки SIP сегодня (владелец и админы по
   умолчанию); (б) отдельное право «Телефония: маршруты» — требует схемы битов ≥ 32 (ADR-0048), дороже.
   Рекомендую (а).
3. **Видимость внутренних номеров.** (а) всем участникам в профиле/списке («вн. 101 · Бухгалтерия»);
   (б) только в настройках телефонии. Рекомендую (а) — иначе сотрудники не знают своих номеров.
4. **Round-robin и офлайн.** (а) пропускать тех, кто не в сети (рекомендую: 15 с на участника, пуш не успеет);
   (б) звонить всем по очереди в любом случае. «Все сразу» — звонить и офлайн с пушем на телефон?
5. **Аудио меню.** Лимиты ≤ 10 МБ и ≤ 3 мин достаточно? Нормализовать громкость до −16 LUFS, как у звуков
   саундборда (рекомендую), или оставлять как загрузили?
6. **Нажатие во время проигрывания** прерывает подсказку (рекомендую) или принимается только после неё?
7. **Что слышит абонент, пока звонит сотруднику**: стандартный гудок (v1) — или сразу нужна загрузка музыки
   ожидания (ещё один файл на пространство, + неделя)?
8. **Направление «на бота»**: бот должен принять звонок через Bot API сам (как человек «Принять»), иначе через
   таймаут — «никто не ответил». Устраивает, или бот должен считаться ответившим автоматически?
9. **Номер звонящего** показывать сотруднику в модалке и писать в журнал (рекомендую да) — ограничений по
   персональным данным нет?
10. **Набор внутреннего номера с телефона** («наберите добавочный») — в v1 или следом? Рекомендую следом:
    модель готова, но это ещё одна неделя (сбор цифр, таймауты между цифрами).
11. **Новый контейнер на стенде** (`calab-ivr` рядом с `livekit/sip`, профиль `sip`) и глобальный переключатель
    `SIP_INBOUND=1`, открывающий ответы на входящие INVITE для всего стенда, — согласны?

## Реализация, шаг 1 (22.10, CBF-65)

Данные, API и настройки без звука и воркера; значения по умолчанию — из задачи CBF-65 (ответы 1–11 выше
до слова владельца). Отличия от текста выше, принятые при реализации:
- `sip_extensions.user_id` — `ON DELETE SET NULL (user_id)` по составному FK на `workspace_members`
  (а не CASCADE): участник ушёл / стал гостем (триггер) — номер остаётся «не назначен», маршруты к нему
  целы. Все ссылки маршрутов — `SET NULL` только своей колонки; составные FK держат всё внутри пространства.
- `WorkspaceMember.extension` — из колонки `workspace_members.sip_extension`, которую ведут ручки номеров
  в той же транзакции (а не join: член пространства читается `SELECT *` в десятках запросов).
- `prompt_status` — только `NONE | READY`: перекодирование синхронное, неудача — `422`, ничего не
  сохраняется; `prompt_error` не нужен. Источник подсказки остаётся сиротой (чистка через 24 ч), как у
  саундборда; старая подсказка удаляется сразу. Битрейт 32 кбит/с, `-application voip`.
- Маршрутизация — чистая функция `sip.Route` (+ `NextPosition`, `Press`) и `Service.RouteInbound` за
  `SIP_INBOUND`; точка входа (`sip_accounts.inbound_*`), транки/правила LiveKit, `SipCall`-поля входящих,
  события и воркер — шаг 2. По задаче нажатие во время подсказки (barge-in) в v1 не прерывает её.

## Реализация, шаг 2 (22.10, CBF-65)

Входящие, воркер, звонок на клиент — за `SIP_INBOUND` (по умолчанию выключен) и `IVR_AGENT_TOKEN`. **Дополнено ADR-0121 (22.10):** флаг `SIP_INBOUND` снят по решению владельца — входящие работают в пространствах, где админ их включил, на сервере с `IVR_AGENT_TOKEN`; LiveKit SIP всегда `hide_inbound_port: true`. Отличия
и уточнения к тексту выше:
- Настройки входящих — отдельный `PUT /api/workspaces/{id}/sip/inbound {enabled, target, allowed_cidrs}`
  (а не поля `PUT …/sip`: тот заменяет объект целиком, старый клиент выключал бы входящие). Точка входа —
  меню, номер **или группа**. Сохранение пересоздаёт транк и правило (удалить → создать); `PUT …/sip`
  переносит их на новый Caller ID / хост, `enabled = false` удаляет. Диапазоны адресов — публичные, не шире
  /16 (IPv6 /32). В `numbers` транка — Caller ID с «+» и без (**допущение**: формат номера в INVITE зависит
  от провайдера, `livekit/sip` v1.14 сравнивает как прислано — не проверено на живом провайдере).
- Кадры воркера — Go-типы `internal/ivrwire` (JSON), не `ivr.proto`: контракт внутренний Go↔Go, клиенту не
  нужен. Путь — `/api/internal/ivr-agent` (Caddy и ingress пропускают только `/api/*`). Ответ на любой
  неверный токен — 404.
- Комната: префикс правила `sipin_<ws>`, LiveKit сам добавляет `_<номер>_<случайное>`
  (`sip.EvaluateDispatchRule`, `livekit/protocol` v1.52.1). Линия — `sip_<номер>`, воркер — `ivr:<call>`,
  ответивший — `sipin-answer:<user>` (одна identity на человека: переподключение вытесняет старое).
  Атрибуты линии `sip.phoneNumber` (звонящий), `sip.trunkPhoneNumber`, `sip.callID`, `sip.ruleID` — по
  коду `livekit/protocol` v1.52.1; `livekit/sip` v1.14 собран на более старом коммите — те же имена
  (**допущение**). `SipDTMF` приходит data-пакетом: проверено по `server-sdk-go` v2.19.0 (`engine.go`).
  `room_config` и плоская форма `CreateSIPDispatchRule` проверены unit-тестом против типов протокола; что
  OSS-сервер применяет `room_config` и когда LiveKit шлёт 200 OK — не проверено (нужен провайдер).
- Машина состояний — чистая (`sip/machine.go`), состояние `sipin:<id>` в Valkey, переход — под замком
  звонка; дедлайн меню — от длительности подсказки (+3 с), даже если «played» воркера потерялся. Нажатие во
  время подсказки **не** прерывает её (ответ 6 по умолчанию). Ответивший без соединения 30 с — `lost`.
  Клиент получает в `accept` готовый `JoinVoiceResponse` (только микрофон) и голос идёт обычным
  `voice.join` с комнатой `sipin:<call id>` (её токен — `POST …/inbound/{cid}/join`).
- Не сделано (docs/12): пуш на телефон для `SIP_INBOUND_RING`, занятость входящим для DM-звонков, образ в
  `images.yml`, сверка `hello` воркера, ежесуточный пересчёт адресов. Реальный звонок не проверен — нет
  провайдера; проверены unit-тесты машины и воркера и интеграционный тест потока API с фейками LiveKit SIP
  и воркера.
