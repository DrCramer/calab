# Матрица прав: действие → бит → где проверяется

Правило одно (docs/04, ADR-0026): `computePermissions` (TS) = `perm.ComputeOrdered` / `perm.ComputeBoard` (Go), общие векторы `proto/testdata/permissions.json`. «ws» — права пространства (OR ролей, без переопределений), «room» — в комнате (с переопределениями ролей и пользователя), «board» — на доске. Сервер проверяет всё; клиент только скрывает UI (`lib/permissions`, `features/people/members.ts`) и пересчитывает его из стора на каждое событие (`READY`, `WORKSPACE_MEMBER_UPDATE`, `ROLE_*`, `ROOM_PERMISSIONS_UPDATE`, `ROOM_UPDATE`, `BOARD_UPDATE`) — без реконнекта.

**Роли v2 (ADR-0048).** Семь битов уровня пространства вынесены из `MANAGE_WORKSPACE`: `CREATE_BOARDS`, `MANAGE_MEMBERS`, `MANAGE_BOTS`, `MANAGE_INTEGRATIONS`, `VIEW_JOURNALS`, `MANAGE_EVENTS`, `MANAGE_RECORDINGS`. `MANAGE_WORKSPACE` их не подразумевает (миграция 00052 выдала их ролям, у которых он был), `ADMINISTRATOR` включает. Переопределения комнат и досок их не дают и не снимают; гостям не действуют.

**Приватные комнаты и доски (ADR-0078 и ADR-0058, дополнения 2026-10-14; раньше — «закрытые», ADR-0029 → ADR-0048).** Два вида: «для всех» и «только приглашённые/выбранные» (`is_private`, `restricted` — синоним). В приватной `ADMINISTRATOR` и владелец пространства не дают обхода, а `VIEW_ROOM` / `VIEW_BOARD` берутся **только** из переопределения на объекте (роль или лично; во временной комнате — только лично) или у создателя (`created_by`); биты пространства (`MANAGE_*`, `VIEW_JOURNALS`, `MANAGE_RECORDINGS` …) открывают объект не больше, чем обычному участнику (`RoomAccess.NoBypass` / `BoardAccess.NoBypass`). Каждая строка ниже для админа и владельца без переопределения — 404 (не 403: существование не раскрываем) — в списках, поиске, упоминаниях, уведомлениях, календаре, задачах, журналах, экспорте, записях, файлах и голосе. **«Владелец видит приватное»** (`Workspace.owner_sees_private`, по умолчанию выкл.; `PATCH /api/workspaces/{id}` — только владелец, `403 OWNER_ONLY` даже админу; запись `workspace_audit`): пока включено, владелец пространства (только он) — все биты на приватных комнатах, досках, папках Диска и страницах Вики. Гость на приватной доске — никогда. Тесты: `internal/app/permissions_matrix_integration_test.go`, `restricted_integration_test.go`, `rolesv2_integration_test.go` (таблица действие × кто), `internal/db` `TestRolesV2Migration`; unit — `lib/permissions.test.ts`, `features/people/members.test.ts`, `stores/workspaces.test.ts`.

## Пространство

| Действие | Бит | Сервер | Клиент |
|---|---|---|---|
| Настройки (название, иконка, тема, медиа по умолчанию, политика гостей) | `MANAGE_WORKSPACE` ws; тариф `audio_tier_max_kbps` (медиа) | `workspaces.update` (`requireManage`), `plans.Check` | `mayManageWorkspace` |
| Фоны камеры пространства (ADR-0035): добавить / переименовать / удалить | `MANAGE_WORKSPACE` ws; исходный файл — своя загрузка в это пространство (не стикер); боты — так же (ADR-0109) | `workspaces.createBackground`, `updateBackground`, `deleteBackground` | `BackgroundsTab` (`mayManageWorkspace`) |
| Список фонов пространства, картинка фона | участник пространства (и гость); боты — так же (ADR-0109) | `workspaces.listBackgrounds`, `files.CanRead` (`IsWorkspaceBackground`) | «Фоны пространства» в `BackgroundPicker` |
| Роли: создать / править / порядок / удалить | `MANAGE_ROLES` ws, только ниже своей старшей; `MANAGE_ROLES` / `MANAGE_WORKSPACE` выдаёт/снимает только админ; `ADMINISTRATOR` — никогда | `roles.go` (`above`, `checkGrant`) | `canCreateRole`, `canEditRole`, `editableBits` |
| Стикерпаки: создать / править / загрузить / удалить (ADR-0030) | `MANAGE_STICKERS` ws | `stickers.manager` | вкладка «Стикеры» (`can(ws,'MANAGE_STICKERS')`) |
| Саундборд пространства (ADR-0036): добавить / изменить / удалить | `MANAGE_STICKERS` ws («Стикеры и звуки»); исходный файл — своя загрузка в это пространство; бот — так же, но внешние адреса добавляет только в свою встречу (ADR-0051) | `sounds.manager` | вкладка «Звуки» |
| Список звуков, клип звука | участник пространства (и гость), бот | `sounds.list`, `files.CanRead` (`IsWorkspaceSound`) | поповер «Звуки» |
| Проиграть звук в комнату | подключён к звонку этой комнаты; 1 / 2 с на пользователя, 5 / 10 с на комнату | `sounds.play` | кнопка «Звуки» в островке |
| Установить пак, отправить стикер | не гость пространства пака; в комнате — `SEND_MESSAGES` room, в DM — оба не гости | `stickers.install`, `messages.sticker` | `packUsable` |
| Удалить workspace | владелец | `workspaces.delete` | вкладка «Опасная зона» |
| Личная квота пользователя (ADR-0039) | суперадмин (`SUPERADMIN_EMAILS`), остальным — 404 | `plans.Admin.setStorageQuota` | — |

## Участники

| Действие | Бит | Сервер | Клиент |
|---|---|---|---|
| Исключить / забанить / разбанить / список банов / встроенная роль | `MANAGE_MEMBERS` ws (ADR-0048; не гость) + иерархия: не владельца, админа — только владелец, цель ниже моей старшей роли | `requireMembers`, `workspaces.outranks`, шлюз `WORKSPACE_BAN_*` — держателям `MANAGE_MEMBERS` | `canRemoveMember` |
| Гость → участник | `MANAGE_MEMBERS` ws | `promote` | `memberActions.promote` |
| Список бывших участников `GET …/former-members` (ADR-0097) | `MANAGE_MEMBERS` ws (не гость); бот — так же | `workspaces.listFormerMembers` | вкладка «Бывшие» |
| Профили по id `GET …/users?ids=` (ADR-0097) | участник (и бот); только те, кто есть или был в пространстве, чужие id молча пропускаются; гость — только видимых ему участников, бывших — нет; ≤ 100 id | `workspaces.listUsers` | резолв неизвестных авторов |
| Назначить / снять роль | `MANAGE_MEMBERS` **или** `MANAGE_ROLES` ws (не гость); только роли ниже своей старшей и с битами, что есть у меня; `admin` — только владелец; не открывать закрытую комнату/доску, которую не вижу (`403 OWNER_ONLY`) | `setMemberRoles`, `restrictedGuard` | `canAssignRole`, `roleToggles` |
| Бейджи (docs/09 #82): библиотека — создать / переименовать / сменить картинку / удалить | `MANAGE_MEMBERS` ws (ADR-0048); бот — так же, картинка — его загрузка (ADR-0051) | `workspaces.createBadge`, `updateBadge`, `deleteBadge` | `BadgesTab` |
| Бейдж участника: назначить / снять | `MANAGE_NICKNAMES` ws + иерархия `workspaces.outranks` (себе — можно); цель — не бот; бот — так же (ADR-0051) | `workspaces.setMemberBadge` | `canSetMemberBadge` |
| Профиль участника `GET …/members/{userId}` (ADR-0051) | участник (и бот); гость — только видимых ему (ADR-0016), иначе 404; открытые задачи — только с досок, которые видит вызывающий (закрытая без переопределения — нет); скрытый день рождения не отдаётся | `workspaces.getMember`, `boards.OpenTasksOf` | — |
| Список бейджей, картинка бейджа | участник пространства (и гость) | `workspaces.listBadges`, `files.CanRead` (`IsWorkspaceBadge`) | — |
| Каталог ачивок пространства (ADR-0061, поправка 1): добавить / изменить / архив / удалить | `MANAGE_WORKSPACE` ws (не гость); ≤ 100 (409 `ACHIEVEMENT_LIMIT`); картинка — своя загрузка в это пространство; удалить — только без вручений (409 `ACHIEVEMENT_IN_USE`); чужое пространство — 404; боты — так же (ADR-0109) | `achievements.create`, `update`, `remove` | настройки → «Библиотека» → «Ачивки» |
| Вручить / отозвать ачивку (ADR-0061) | `MANAGE_MEMBERS` ws (не гость); получатель — участник, не гость, не бот, не я (422 `SELF_GRANT`); ачивка не в архиве; боты — так же (ADR-0109) | `achievements.grant`, `revoke` | — |
| Ачивки участника, каталог и картинки ачивок | участник (и бот); гость — ачивки только видимых ему участников (как профиль), иначе 404; каталог и картинки пространства — любой его участник (и гость) | `achievements.list`, `catalog`, `files.CanRead` (`IsWorkspaceAchievement`) | — |
| Ник другого | `MANAGE_NICKNAMES` ws (иерархии нет, docs/12) | `updateMember` | `canRenameMember` |
| День рождения другого (docs/09 #77), таблица с датами | `MANAGE_NICKNAMES` ws + иерархия; цель — не бот и не гость; бот-токен — 403 | `workspaces.setMemberBirthday`, `listMemberBirthdays` | `canEditMemberBirthday` |

## Приглашения

| Действие | Бит | Сервер | Клиент |
|---|---|---|---|
| Инвайты и email-инвайты в пространство (ADR-0043) | `INVITE_MEMBERS` ws, подтверждённый не-гостевой аккаунт (при `EMAIL_VERIFICATION=optional` — любой не-гостевой, ADR-0065; находят и добавляют по почте — только подтверждённых); тариф `members`; бот — так же (ADR-0051: письмо «от имени бота X»), кроме поиска аккаунта по почте и прямого добавления (`lookup`, `POST …/members` — 403) | `requireInvite`, `inviter` | `mayInviteMembers`, `useMembersCap` |
| Пригласить админом по email | владелец | `createEmailInvite` | `EmailInvite` (owner) |
| Ссылка-приглашение в комнату (гости): создать / список / отозвать | `INVITE_GUESTS` room (не гость); не-админ — не шире своих | `guests.linkAccess` | `mayInviteGuestsIn`, `roomMenuGroups` |
| Ссылка комнаты «только для участников» | `INVITE_MEMBERS` или `INVITE_GUESTS` room; вход — только участник, иначе 403 `INVITE_MEMBERS_ONLY` | `guests.linkAccess`, `guests.grant` | `mayInviteToRoom`, `InviteToRoomDialog` |
| Подтверждение входа гостей: настройка комнаты / ссылки (ADR-0040) | комната — `MANAGE_ROOM` room; ссылка — `INVITE_GUESTS` room | `rooms.update`, `guests.update` | `RoomLinkTab` |
| Пустить / отклонить гостя, имя и бейдж при допуске (ADR-0040) | `INVITE_GUESTS` room (не гость) или автор ссылки (не гость); бот — по `INVITE_GUESTS` (ADR-0051); комната, которую не видно (закрытая), — 404. Не `MANAGE_MEMBERS`: решение по комнате (ADR-0043) | `guests.loadDecider`, `decider.may`, шлюз `RoomAdmission*` | — |

## Комнаты

| Действие | Бит | Сервер | Клиент |
|---|---|---|---|
| Создать комнату / категорию, порядок (drag) | `MANAGE_ROOM` ws; комнату, которую не видишь, передать нельзя (`422`) | `rooms.create`, `categories`, `rooms.order` | `mayArrangeRooms` |
| Переименовать, настройки, удалить комнату | `MANAGE_ROOM` room | `rooms.manage` | `can(room,'MANAGE_ROOM')` |
| Сделать комнату приватной / для всех (`is_private`, `restricted` — синоним; ADR-0078 доп.) | `MANAGE_ROOM` room (создатель временной — тоже); включивший и создатель получают личное allow своих битов комнаты (с `VIEW_ROOM`); `PUT /permissions` сохраняет собственное переопределение вызывающего; при создании `member_ids` / `role_ids` — приглашённые | `rooms.create`, `rooms.update` | `RoomSettings` «Доступ», диалог создания |
| «Сделать меня владельцем» приватной комнаты / доски / папки / страницы (`POST /api/{rooms,boards,disk/items,wiki/pages}/{id}/take-over`) | владелец пространства при `owner_sees_private`; владелец объекта уже не участник (иначе 409), не владелец или настройка выкл. — `403 OWNER_ONLY`; запись `workspace_audit` | `rooms`, `boards`, `disk`, `wiki` take-over | «Доступ» объекта |
| «Владелец видит приватное» и журнал доступа (`GET /api/workspaces/{id}/audit`) | переключает только владелец; журнал — владелец или `VIEW_JOURNALS` ws | `workspaces.update`, `workspaces.audit` | Настройки → Основное |
| Переопределения комнаты | `MANAGE_ROOM` room; не-админ (в закрытой — любой, кроме владельца) — только свои биты; биты пространства и досок — 422 | `rooms.validateOverrides` | вкладка «Права» |
| Временная комната: создать (ADR-0044) | `CREATE_TEMP_ROOMS` ws (не гость); `guests=true` — ещё `INVITE_GUESTS` ws; лимиты 20 / 5 | `rooms.createTemp` | — |
| Временная комната: переименовать, продлить, доступ, права, ссылки, удалить (в архив) | `MANAGE_ROOM` room **или** создатель (не гость); `make_permanent` — только `MANAGE_ROOM` | `rooms.MayManage`, `guests.linkAccess`, `rooms.tempPatch` | `mayManageRoom` |
| Архив временных комнат: список / история | список — `MANAGE_ROOM` ws + `VIEW_ROOM`; история — `VIEW_ROOM`; прочее — 410 `ROOM_ARCHIVED` | `rooms.listArchived`, `rooms.ReadAccess` | — |
| Читать, писать, реакции | `VIEW_ROOM`, `SEND_MESSAGES` room | `messages` | Composer, MessageActions |
| Вложения | `ATTACH_FILES` room | `messages.create`, `files` | `canAttach` |
| @everyone / @here | `MENTION_EVERYONE` room | `saveMentions` | Composer |
| Переслать сообщение / карточку записи (ADR-0033) | `VIEW_ROOM` в источнике (закрытая — можно), `SEND_MESSAGES` в цели (+ `ATTACH_FILES`); копия даёт читателям цели файлы и транскрипт | `messages.forward`, `files.CanRead`, `recording.visibleRecording` | MessageMenu, ForwardDialog |
| «Заметки» (ADR-0039) | владелец полки; чужая — 404; боты и гости — 403; личная квота (`413 PERSONAL_QUOTA`) | `notes.*`, `perm.Resolver` (`Notes`), `files.uploadDM` | `NotesSection`, ForwardDialog |
| Звонок DM (ADR-0034): позвонить / принять / отклонить / отменить / завершить | участник DM, не гость; собеседник — человек с общим пространством; бот-токен — 403; `409 BUSY` / `IN_CALL` | `calls.start` (`mayCall`), `calls.action` | `useCanDm` |

## Голос

| Действие | Бит | Сервер | Клиент |
|---|---|---|---|
| Войти в голос | `VIEW_ROOM` + `CONNECT` room; сверх `user_limit` — только владелец пространства (07.10) | `rtc.join` | `joinOutcome` |
| Голос звонка DM (`POST /api/rooms/{dm}/join`) | участник ACTIVE-звонка этой DM, иначе `409 CALL_NOT_ACTIVE`; grant фиксированный | `rtc.joinDM`, `dmParticipantJoined` | — |
| Микрофон | `SPEAK` room, не замьючен модератором | grant `microphone` | `canSpeak` |
| Экран / камера | `STREAM` / `VIDEO` room (+ слот, лимит камер) | `/stream/request`, `/camera/request`, grant | `voiceCaps` |
| Аннотации на стриме | `SPEAK` (клиент; data-канал, docs/12) | — | `annot.canAnnotate` |
| Статус звонка | в звонке + `CONNECT`, или `MANAGE_ROOM` room | `setVoiceStatus` | `useStatusLine` |

## Модерация

| Действие | Бит | Сервер | Клиент |
|---|---|---|---|
| Закрепить, удалить чужое, скрыть превью | `MANAGE_MESSAGES` room (DM — закреп обоим) | `canPin`, `messages.delete` | `mayPin`, MessageMenu |
| Отключить из голоса, стоп стрима / камеры | `MUTE_MEMBERS` room + иерархия голоса | `rtc.moderate` (`outranks`) | `memberActions` (`mayModerateVoice`) |
| Серверный мьют / снятие | `MUTE_MEMBERS` room и ws + иерархия | `workspaceMute` | `memberActions.serverMute` |
| Переместить (меню, drag) | `MOVE_MEMBERS` в обеих комнатах + иерархия перемещения; цели — `VIEW_ROOM` + `CONNECT` | `rtc.moveMember` (`mayMove`) | `memberActions.moveTargets` |

## Календарь

| Действие | Бит | Сервер | Клиент |
|---|---|---|---|
| Видеть встречу (ADR-0038) | не гость; организатор, участник встречи или `VIEW_ROOM` в её комнате (закрытая — по переопределению); бот — свои (организатор) и встречи видимых комнат, адреса внешних — только если может править (ADR-0051) | `calendar.viewer.sees`, `viewer.emails` | — |
| Создать встречу | не гость; комната — голосовая, видимая; внешние адреса — подтверждённая почта (кроме `EMAIL_VERIFICATION=optional`, ADR-0065); бот — организатор, **не участник** (себя в списке — 422), письма «от имени бота X» без гостевых ссылок (ADR-0051) | `calendar.create`, `checkRoom`, `checkAttendees`, `linkBits` | — |
| Изменить / отменить чужую встречу (и вхождение), видеть адреса её участников | организатор; иначе `MANAGE_ROOM` room встречи **или** `MANAGE_EVENTS` ws (ADR-0048) — при встрече без комнаты или в видимой комнате; бот — так же (ADR-0051) | `calendar.viewer.canEdit`, шлюз `calendar.go` (адреса) | `event.can_edit` |
| Свободно/занято, подбор времени (ADR-0041) | не гость; о ком спрашивают — участники того же пространства (не боты); бот — только «занято», без названий и участников внешних событий (ADR-0051) | `calendar.busyViewer`, `calendar.people`, `collectBusy(details)` | — |
| Внешний календарь CalDAV (ADR-0041) | свой аккаунт; не гость, не бот | `caldav.person` | — |
| Удалить своё внешнее событие из CalDAV (ADR-0045, поправка 1) | только владелец аккаунта: строка ищется среди своих по uid, началу и href внутри выбранного календаря (иначе 404); не гость, не бот (403); 30 в минуту; пароль аккаунта не покидает сервер | `caldav.deleteExternal`, `caldav.paidPerson` | — |
| Ответить на встречу | участник встречи; внешний — подписанной ссылкой | `calendar.rsvp`, `calendar.publicAnswer` | — |
| Гостевая ссылка встречи для внешнего | от имени организатора, если у него `INVITE_GUESTS` room | `calendar.linkBits` | `event.guest_links` |

## Доски

| Действие | Бит | Сервер | Клиент |
|---|---|---|---|
| Видеть доску, задачи, ленту; комментировать, подписаться, вложение (ADR-0042) | `VIEW_BOARD` board (приватная — только по переопределению; закрытая — тоже, и админам); гость — никогда (404, список — 403). **По карточкам** (ADR-0059, ADR-0076): без `VIEW_BOARD`, но исполнитель / согласующий / наблюдатель живой задачи (человек, не гость; закрытая доска — тоже) — доска с `task_scoped`, `permissions = 0`, только свои карточки; на карточке `perm.TaskBits`: исполнитель — `VIEW_BOARD \| CREATE_TASKS`, согласующий и наблюдатель — `VIEW_BOARD` (таблица `proto/testdata/task_bits.json`); обычный подписчик доступа не получает; чужие задачи — 404; задачи, виды (правка), журнал, настройки, доступ — 403 | `boards.board`, `taskOf`, `perm.Resolver.Board` (`TaskScoped`), комната задачи — `perm.TaskRoom(TaskBits)`; списки — `VisibleBoards` | `computeMemberBoardPermissions`, `taskPermissions` |
| Создать доску | `CREATE_BOARDS` ws (ADR-0048) + тариф `boards` (Free 3), ≤ 50; создатель получает все биты доски лично | `boards.createBoard`, `plans.Check(KindBoards)` | — |
| Сделать доску приватной / для всех (`is_private`, `restricted` — синоним; ADR-0058 доп.) | `MANAGE_BOARD` board; включивший получает личное `allow VIEW_BOARD \| MANAGE_BOARD`; при создании `member_ids` / `role_ids` → `allow VIEW_BOARD \| CREATE_TASKS` | `boards.createBoard`, `boards.updateBoard` | `BoardSettings` «Доступ», диалог создания |
| Создать задачу; править свои и назначенные на себя | `CREATE_TASKS` board | `boards.createTask`, `canEdit` | — |
| Назначить исполнителя / согласующего / наблюдателя (ADR-0042 §1, ADR-0049 §1, ADR-0059, ADR-0076) | право править задачу; цель — участник пространства, не гость: видящий доску или любой человек (и на закрытой доске) — увидит её по карточке; бот — только с `VIEW_BOARD`, согласующим — никогда; иначе 422 `the user does not see this board`. @упоминание редактором задачи (описание, комментарий) делает упомянутых людей наблюдателями; упоминание без права правки только подписывает видящих задачу. Снять наблюдателя — редактор или он сам | `boards.mayInvite` (`assigneesIn`, `approversIn`, `addWatcher`), `mentionWatchers`, `removeWatcher` | `WatcherMenu`, `watcherControls` |
| Править / двигать / архивировать любые задачи; модерация комментариев | `EDIT_TASKS` board (в комнате задачи → `MANAGE_MESSAGES`) | `boards.requireEdit`, `setArchived`, `messages.delete` | — |
| Статусы, лейблы, вехи, настройки, общие виды, порядок, архив доски | `MANAGE_BOARD` board; создать лейбл — ещё и `CREATE_TASKS` | `boards.manageBoard` | — |
| Доступ к доске (переопределения) | `MANAGE_BOARD` board; только биты доски; не-админ (на закрытой — любой, кроме владельца) — только свои биты; боты — так же (ADR-0109) | `boards.validateOverrides` | — |
| Перенести задачу на другую доску · удалить доску навсегда (`?purge=1`, бот — 403) | `MANAGE_BOARD` на обеих · `MANAGE_BOARD` | `boards.moveBoard`, `deleteBoard` | — |
| «Создать задачу из сообщения» | `CREATE_TASKS` board + `VIEW_ROOM` в комнате сообщения (иначе 404) | `boards.quoteMessage` | — |
| Правила автоматизации (ADR-0060): список | `VIEW_BOARD` board (по карточкам — 403, не видно — 404); бот — так же | `boards.listRules` | — |
| Правила: создать / изменить / удалить / порядок / проверить на задаче · журнал срабатываний | `MANAGE_BOARD` board; тариф `automations_disabled` (Free) — создание `409 PLAN_LIMIT`; боты — так же (ADR-0109); `notify_room` — только текстовая комната пространства, где автор правила может писать (`VIEW_ROOM` + `SEND_MESSAGES`, иначе 422) | `boards.createRule`, `updateRule`, `deleteRule`, `testRule`, `listRuns` (`ruleAccess`) | — |
| Вехи внутри задачи (ADR-0063): создать / переименовать / дата / порядок / отметить / удалить | как поля задачи: `EDIT_TASKS`, или `CREATE_TASKS` на своей / назначенной (исполнитель по карточке — да, согласующий — нет); видеть — `TaskBits ≠ 0`; фича `MILESTONES` выкл. — запись `409 FEATURE_DISABLED` (удаление можно); бот — так же | `boards.msWrite` → `requireEdit` | — |
| Привязать подзадачу к вехе родителя (ADR-0063) | право правки подзадачи (`requireEdit`); веха — только родителя (`422`) | `boards.updateTask` → `subtaskMilestone` | — |
| Действия правила при срабатывании | от имени доски: права пользователя не проверяются (правило создал `MANAGE_BOARD`), инварианты — да: approval gate, фичи доски, тариф чек-листов, лимиты, `mayInvite` для исполнителей / согласующих; уведомления — только тем, кто видит задачу (`sees`) | `boards.runRules` → `actx` | — |
| Git-вебхук доски: настроить / посмотреть / удалить (ADR-0060 §4) | `MANAGE_BOARD` board + `MANAGE_INTEGRATIONS` ws; тариф как у правил; боты — так же (ADR-0109); секрет — только в ответе `PUT` | `boards.repoBoard` | — |
| Приём Git-событий `POST /api/git/boards/{id}/{provider}` | без сессии; подпись провайдера секретом доски (иначе 401), ≤ 1 МБ, 60/мин на доску, повтор доставки — 204 без эффекта; связи и правила — только задачам этой доски (ключ доски) | `boards.repoInbound`, `vcs.Verify` | — |

## Поиск

| Действие | Бит | Сервер | Клиент |
|---|---|---|---|
| Единый поиск `GET /api/search` (ADR-0062), раздел за разделом | `messages` — `VIEW_ROOM` room (`rooms.VisibleBits`; закрытая без переопределения — нет), DM — только участник и после его «Удалить чат» (`scope=all`); `task_comments` и `tasks` — `boards.VisibleBoards` (`VIEW_BOARD` или доступ по карточке ADR-0059 = `TaskBits ≠ 0`; закрытая доска — нет); `events` — только видимые с деталями по правилам календаря (организатор, участник, `VIEW_ROOM` комнаты события); чужое «занято» (ADR-0041/0045) не находится ни по названию, ни по описанию; `files` — вложения живых сообщений из тех же комнат/DM/задач/своих заметок; `notes` — только свои полки, при `scope=all` или явно; `transcripts` — правило карточки записи (`recording.VisibleSQL`: своя комната или живая пересланная копия), только готовый результат; `wiki` — `WIKI_VIEW` на странице (`perm.ComputeWikiPageIn` по цепочке, `wikiacl`), живые; `disk` — `DISK_VIEW` на элементе (`perm.ComputeDiskItemIn`, `diskacl`): чужая приватная папка и всё в ней — нет, и владельцу пространства без «Владелец видит приватное»; в корзине — нет; `path` хита называет только видимые предки. Гость — что выдано ему лично. Гость — его комнаты, без досок и календаря. Бот — по битам своих ролей (`botAllow`), без `notes`. Не участник пространства — 404 | `search.buildScope` + разделы `search/sections.go`; общий разбор `searchq` | ⌘K, панель «Результаты поиска» (клиент только показывает выдачу сервера) |

## Записи

| Действие | Бит | Сервер | Клиент |
|---|---|---|---|
| `allow_recording` комнаты (согласие на запись) | `MANAGE_ROOM` room + `MANAGE_RECORDINGS` ws (ADR-0048) | `rooms.update` | `RecordingCard` |
| Запись встречи | не гость, `VIEW_ROOM` + `CONNECT`, `allow_recording`; бот — ещё `MANAGE_RECORDINGS` ws (ADR-0051) | `recording.participant` | `roomMenuGroups` (`record`) |
| Саммари, аудио, транскрипт записи (docs/09 #47) | `VIEW_ROOM` room (закрытая — только допущенные) | `files.CanRead`, `recording.transcript` | — |
| Удалить запись встречи (docs/09 #50) | запустивший, владелец, `MANAGE_MESSAGES` room или `MANAGE_RECORDINGS` ws (ADR-0048) — всегда при `VIEW_ROOM` (закрытая без переопределения — 404) | `recording.remove` | `mayDeleteRecording` |

## Оплата (ADR-0087)

Биты `BILLING_VIEW` / `BILLING_TOPUP` / `BILLING_MANAGE` — уровень пространства, вне `ADMINISTRATOR`; владелец — все три всегда; MANAGE ⊃ TOPUP ⊃ VIEW; гости и боты — никогда. Выдаёт / снимает / назначает / удаляет роль с ними — только владелец (`internal/workspaces/roles.go`). Отказ — `403 BILLING_PERMISSION_REQUIRED`.

| Действие | Бит | Сервер | Клиент |
|---|---|---|---|
| Статус оплаты (`GET …/billing` без сумм), шильдик с тарифом | участник | `billinghttp.get` | `PlanBadge`, `MemberBillingStub` |
| Сводка, история, платежи, чеки, заявки на возврат, плательщик, карты, автопополнение — смотреть; «долг» на шильдике и полоса долга | `BILLING_VIEW` | `holderOf(perm.BillingView)` | `BillingCabinet` (только чтение) |
| Пополнить через страницу оплаты, статус checkout; «Оплатить» на полосе долга и пейволле; маршруты оплаты при приостановке | `BILLING_TOPUP` | `holderOf(perm.BillingTopup)`, `identitypolicy.State.BillingPayer` | `BalanceCard`, `TopupDialog` (без карты в один клик и «сохранить»), `BillingPaywall` |
| Квота, подключить / сменить / остановить / возобновить тариф, self-serve старт, рынок до первой оплаты, оплата в один клик, сохранить карту, автопополнение, удалить карту, изменить плательщика, заявка на возврат; письма о долге / приостановке / автопополнении | `BILLING_MANAGE` | `holderOf(perm.BillingManage)`, `inbox.ManagersCopied` | `PlansDialog`, `PlanSwitch`, `AutoTopupCard`, `PayerCard`, `HistoryCard` |
| Поставить / снять биты на роли, назначить / снять / удалить такую роль | владелец | `checkGrant`, `setMemberRoles`, `deleteRole` | группа «Биллинг» в карточке роли (`billingEditableBits`) |

В оболочке iOS (`platform/nativeShell`) клиент не показывает ни одного действия с деньгами, что бы ни было в битах (ADR-0087 §10).

## Диск (ADR-0094)

Биты `DISK_VIEW` (35) / `DISK_WRITE` (36) / `DISK_MANAGE` (37) — уровень пространства, вне `ALL_PERMISSIONS`; у `member` по умолчанию VIEW + WRITE, `ADMINISTRATOR` даёт все три; гостям роли их не дают (только личный allow на элементе); боты — как участники, по своим ролям, все маршруты диска им открыты (дополнение 2026-10-14). Права на элемент — `perm.ComputeDiskItem` по цепочке предков (`internal/diskacl`), нет `DISK_VIEW` — 404.

**Приватная папка («Только выбранные», дополнение ADR-0094 §2 от 2026-10-14).** Restricted-элемент и его поддерево видят только владелец элемента и те, кого впустило переопределение (роль или лично); `ADMINISTRATOR`, `DISK_MANAGE`, владелец пространства и боты с такими ролями — 404 везде: список, путь, файл, события, корзина, журнал диска (записи и названия таких папок скрыты, после удаления навсегда — `disk_activity.private`). Их «Очистить корзину» такие элементы пропускает, автоудаление по сроку — нет; «Место» считает байты. Публичная ссылка работает, но `DISK_MANAGE` её не снимает. Впущенный держатель `DISK_MANAGE` там — обычный участник: «Правка» — видит и пишет, меняет только своё, «Доступ» не открывает; «Просмотр» — только видит. Удаление, корзина или перенос чужой папки не уносят невидимую действующему приватную подпапку: она отцепляется в корень с доступом и историей. Тесты: `internal/disk/private_integration_test.go`, векторы `disk:` в `proto/testdata/permissions.json`.

| Действие | Бит | Сервер | Клиент |
|---|---|---|---|
| Раздел «Диск», список, скачивание, история папки | `DISK_VIEW` на элемент | `internal/disk`, `files.CanRead` | `DiskScreen`, `PhoneDisk` |
| Создать папку, загрузить в папку | `DISK_WRITE` на папку | `internal/disk` (`UploadWith`) | `DiskBar`, `Dialogs` |
| Переименовать, переместить, в корзину, доступ, ссылка | владелец элемента или `DISK_MANAGE` | `internal/disk` | `ItemMenu` по `DiskItem.my_bits` |
| Срок корзины, очистка всей корзины, чужие ссылки, журнал диска | `DISK_MANAGE` | `internal/disk` | `DiskSettings` |
| «Докупить место» (кнопки пока неактивны) | `BILLING_VIEW` | — | `PlanTab` |

## Вики (ADR-0096)

Биты `WIKI_VIEW` (38) / `WIKI_WRITE` (39) / `WIKI_MANAGE` (40) — как у диска: уровень пространства, вне `ALL_PERMISSIONS`, у `member` по умолчанию VIEW + WRITE, `ADMINISTRATOR` даёт все три, гостям — только личный allow на странице; боты — как участники, включая `/sync` бот-токеном (дополнение 2026-10-14). Права на страницу — `perm.ComputeWikiPage` (общий `perm.ComputeTree` с диском), нет `WIKI_VIEW` — 404. Сервер и клиент — задачи W2/W4 (`docs/plans/wiki-v1-tasks.md`), столбцы заполняются вместе с ними.

**Приватная страница (дополнение ADR-0096 §2 от 2026-10-14)** — как приватная папка диска: `ADMINISTRATOR`, `WIKI_MANAGE` и владелец пространства без переопределения получают 404 на неё и подстраницы (дерево, путь, поиск, версии, `/sync`, события, корзина, журнал вики, после удаления — `wiki_activity.private`); впущенный держатель `WIKI_MANAGE` там — обычный участник («Правка» — содержимое и свои страницы, без структуры чужих); невидимая приватная подстраница при удалении/переносе предка отцепляется на верхний уровень. Тесты: `internal/wiki/private_integration_test.go`, векторы `wiki:`.

| Действие | Бит | Сервер | Клиент |
|---|---|---|---|
| Раздел «Вики», дерево, чтение страницы, история версий | `WIKI_VIEW` на страницу | `internal/wiki` (W2) | (W4) |
| Править содержимое (`/sync` с приёмом правок), создать подстраницу | `WIKI_WRITE` на страницу (на верхнем уровне — в пространстве) | `internal/wiki` (W2) | (W4) |
| Переименовать, иконка, обложка, перенести, в корзину, доступ, ссылка | владелец страницы или `WIKI_MANAGE` (`perm.WikiStructureAllowed`) | `internal/wiki` (W2) | по `WikiPage.my_bits` (W4) |
| Срок корзины, очистка всей корзины, чужие ссылки, журнал вики | `WIKI_MANAGE` | `internal/wiki` (W2) | (W4) |

## Холст (ADR-0113)

Биты `CANVAS_VIEW` (41) / `CANVAS_WRITE` (42) / `CANVAS_MANAGE` (43) — как у вики: уровень пространства, вне `ALL_PERMISSIONS`, у `member` по умолчанию VIEW + WRITE (миграция 00107), `ADMINISTRATOR` даёт все три, гостям — только личный allow на элементе; боты — как участники. Права на элемент — `perm.ComputeCanvasItem` (общий `perm.ComputeTree`), нет `CANVAS_VIEW` — 404. Приватный холст или папка (`restricted`) — как приватная страница вики: администраторы, `CANVAS_MANAGE` и владелец пространства без переопределения (и без «Владелец видит приватное») его не видят; `perm.Detached` отцепляет невидимую приватную подпапку при удалении/переносе предка. «Только просмотр» — отсутствие `CANVAS_WRITE`: сокет `/sync` не принимает UPDATE. Публичной ссылки в v1 нет. Боты в v1 — только люди: группа `botDeny` «Холст v1» в `internal/app/botroutes.go` (ADR-0109), SDK для холста нет, сокет `/sync` отклоняет токены ботов кодом 4003; когда ботам дадут холст, группа станет `botAllow` по битам `CANVAS_*`. Тесты: векторы `canvas:` в `proto/testdata/permissions.json` (Go `internal/perm`, TS `permissions.test.ts`).

| Действие | Бит | Сервер | Клиент |
|---|---|---|---|
| Раздел «Холст», дерево, открыть холст, история версий | `CANVAS_VIEW` на элемент | `internal/canvas` | `features/canvas` |
| Править содержимое (`/sync` с приёмом правок), создать папку или холст | `CANVAS_WRITE` на элемент (на верхнем уровне — в пространстве) | `internal/canvas` | `features/canvas` (без `WRITE` — «Только просмотр») |
| Переименовать, перенести, в корзину, доступ | владелец элемента или `CANVAS_MANAGE` (`perm.CanvasStructureAllowed`); перенос — ещё `CANVAS_WRITE` в целевой папке | `internal/canvas` | по `CanvasItem.my_bits` (`canvasStructureAllowed`) |
| Срок корзины, очистка всей корзины, журнал холста | `CANVAS_MANAGE` | `internal/canvas` | `features/canvas` (настройки, корзина) |
| События `CANVAS_ITEM_UPSERT` / `REMOVE`, поиск `canvas` | `CANVAS_VIEW` на элемент (цепочка доступа, `perm.ComputeCanvasItemIn`) | `gateway` / `search` | `features/canvas` (по событиям дерева) |
| Комментарии холста: читать (`GET …/comments`, события `CANVAS_COMMENT_*`) | `CANVAS_VIEW` на холст (нет — 404, и по id комментария) | `internal/canvas` (`comments.go`), `gateway` (цепочка холста) | `features/canvas/view/comments` |
| Комментарии холста: написать, ответить, решить / открыть | `CANVAS_WRITE` на холст; не в корзине, пространство не приостановлено | `internal/canvas` | по `my_bits` (`commentRights`) |
| Комментарии холста: править и удалять своё / чужое | своё — автор с `CANVAS_WRITE`; чужое — владелец холста или `CANVAS_MANAGE` | `internal/canvas` (`commentEditable`) | `mayChange` |
| @упоминание в комментарии холста | упомянуть можно участника, у которого есть `CANVAS_VIEW` на холст (не бота); остальные отбрасываются | `internal/canvas` (`mentionable`), `notifications.CanvasMentionNotifies` | `CommentInput` (`mention-access`) |
| Телефон: просмотр холста (пан, щипок) | `CANVAS_VIEW` на элемент; правки на телефоне нет ни у кого (v1, ADR-0113 §5) | `internal/canvas` (сокет как на десктопе) | `features/canvas/PhoneCanvas` (клиент — `readOnly`) |

## Телефония

| Действие | Бит | Сервер | Клиент |
|---|---|---|---|
| Позвонить на номер из комнаты (ADR-0046) | `PLACE_CALLS` + `VIEW_ROOM` + `CONNECT` room (по умолчанию ни у кого), не гость, в звонке этой комнаты, `Workspace.sip_enabled`; боты — так же | `sip.place` | — |
| Положить телефонную линию | звонивший или `MUTE_MEMBERS` room (не гость) | `sip.hangup` | — |
| Настройки SIP, проверка подключения | `MANAGE_INTEGRATIONS` ws (ADR-0048; не гость); боты — так же (ADR-0109) | `sip.manage` | — |

## Интеграции и боты

| Действие | Бит | Сервер | Клиент |
|---|---|---|---|
| GPTunneL: подключить / отключить | `MANAGE_INTEGRATIONS` ws (ADR-0048; не гость); смотреть — любой не гость; боты — так же (ADR-0109) | `recording.pairIntegration`, `unpairIntegration` | — |
| Создать бота, список ботов (ADR-0031) | `MANAGE_BOTS` ws (ADR-0048; не гость), подтверждённый email (кроме `EMAIL_VERIFICATION=optional`, ADR-0065); тариф `bots`; шлюз `BOT_*` — держателям `MANAGE_BOTS` и владельцу бота | `bots.create`, `bots.list` (`manager`) | — |
| Перевыпустить / отозвать токен, удалить бота, аватар бота | в «домашнем» пространстве: владелец бота или `MANAGE_BOTS` ws (бот не участник — 404, чужое пространство — 403); бот-токен — 403 | `bots.homeBot`, `bots.remove`, `bots.setAvatar` | `BotsTab`, `BotAvatarControls` |
| Добавить / убрать бота в другом пространстве | `MANAGE_BOTS` ws этого пространства | `bots.add`, `bots.remove` | — |
| «Действовать от моего имени» `PATCH …/bots/{botId} {actsAsOwner}` (ADR-0106) | только владелец бота (`owner_user_id`), в домашнем пространстве; `MANAGE_BOTS` — 403 `ON_BEHALF_OWNER_ONLY`; бот-токен (и «от имени») — 403 | `bots.update` | `BotDelegationDialog` (владелец — строка «Вы», CBF-17; прочие видят строку-статус `BotActsAsOwnerNote`) |
| Согласие «бот от моего имени» `PUT`/`DELETE …/bots/{botId}/delegations/{userId}` (ADR-0111) | только сам участник (`userId` = свой, иначе 403 `ON_BEHALF_SELF_ONLY` — и админу, и владельцу бота); дать — роль не `guest` (`ON_BEHALF_NOT_ELIGIBLE`), не `enforced` SSO; бот и «от имени» — 403 | `bots.grant`, `delegation.Check` | «Делегировать права» в меню бота |
| Предложить согласие `POST …/delegation-invites`, отменить `DELETE …/delegation-invites/{userId}` (ADR-0111) | участник с ролью не `guest`; цели — люди с ролью не `guest`; отменяет приглашающий, отказывается приглашённый; «Принять» в DM бота засчитывается только кликом самого приглашённого | `bots.inviteDelegation`, `messages.delegationClick` | диалог «Делегировать права» |
| Запрос бота «от имени участника» (`Calab-On-Behalf: <user id>`, ADR-0111) | как «от имени владельца», но вместо `acts_as_owner` — действующее согласие участника в **каждом** пространстве запроса (`ON_BEHALF_NO_CONSENT`); только внутри пространства: DM, профиль, агрегаты, глобальные операции — `ON_BEHALF_ROUTE`; закрыто и управление доступом (настройки пространства, участники/роли/баны/приглашения, переопределения прав — `app.memberClosed`); права — **участника** | `auth.delegateMember`, `checkOnBehalfWorkspace`, `lockDelegation` | `viaBotId`: «Имя (через бота X)» |
| Запрос бота «от имени владельца» (`Calab-On-Behalf: owner`, ADR-0106) | бот с `acts_as_owner` и действующим токеном (иначе 403 `ON_BEHALF_DISABLED` / 401); владелец — живой человек (`ON_BEHALF_OWNER_INACTIVE`); на каждое пространство запроса: бот — участник (иначе 404), владелец — участник без бана и приостановки каталогом (`ON_BEHALF_OWNER_NOT_MEMBER`), не `enforced` SSO и каталог актуален (`ON_BEHALF_IDENTITY_POLICY`); права — **владельца** (`computePermissions` без изменений); маршруты — `botAllow` + голос в согласовании, кроме аккаунта, `/api/bots/me*`, почтового хостинга, голоса/звонков/записи (`ON_BEHALF_ROUTE`); gateway — права бота; лимиты — бота | `auth.onBehalf`, `checkOnBehalfWorkspace`, `lockDelegation`, `app.onBehalfRoutes` | `viaBotId`: «Имя (через бота X)» |
| Бот: любое действие | те же биты, что у человека (роли + переопределения; встроенная роль `member`; закрытые объекты — только по переопределению) + маршрут `allow` в `internal/app/botroutes.go`, иначе `403 BOT_NOT_ALLOWED`; управление ботами — только люди, какой бы бит ни был у бота. Административные действия бота — строка журнала `bot action` с владельцем бота (`botAudited`, ADR-0051) | `botGate` (`auth.NoBots`) + обработчик | предупреждение в карточке роли (`warnBotsAdmin`) |
| Бот: писать в DM | общее пространство и не заблокирован (`403 BOT_BLOCKED`) | `dms.create`, `messages.create` | — |
| Поделиться контактом с ботом (ADR-0100) | кнопка `REQUEST_CONTACT` — только в DM бота с человеком (иначе отправка/правка сообщения — `400 BOT_CONTACT_REQUEST_DM_ONLY`); подтверждает только человек — второй участник этого DM (`VIEW_ROOM` + `SEND_MESSAGES`, как у нажатия кнопки; бот доступен и не заблокирован; бот-токен — 403, чужой — 404); ≤ 1 отдачи на кнопку (`409 CONTACT_ALREADY_SHARED`), ≤ 10 в час (`429 CONTACT_SHARE_LIMIT`); значения — из профиля на сервере, только запрошенные и непустые (пусто — `422 CONTACT_EMPTY`); событие — только этому боту | `messages.shareContact` (`callbackAccess`, `contactButton`, `composeContact`) | `InlineKeyboard` → `ContactRequestDialog` |
| Команды бота в комнате (подсказки) | `VIEW_ROOM` room у запрашивающего и у бота | `bots.roomCommands`, `messages.resolveCommand` | — |

## Журналы

| Действие | Бит | Сервер | Клиент |
|---|---|---|---|
| Журнал звонков (телефония) | `VIEW_JOURNALS` ws (ADR-0048; не гость); звонки комнат, которых не видно (закрытые), пропускаются; боты — так же (ADR-0109) | `sip.journal` | — |
| Журнал отданных ботам контактов (ADR-0100) `GET /api/workspaces/{id}/bot-contact-shares` | `VIEW_JOURNALS` ws пространства бота (не гость); кто, какому боту, какие поля, когда — без значений; бот-токен — 403 | `messages.listContactShares` | — |
| Журнал доски и CSV-экспорт | `MANAGE_BOARD` или `EDIT_TASKS` board, или `VIEW_JOURNALS` ws — на доске, которую видно (закрытая без переопределения — 404) | `boards.boardActivity` | — |

Иерархия голоса (`rtc.outranks`) — по встроенной роли: владельца не трогает никто, админа — только владелец, участников и гостей — любой с битом; себя — можно. Исключение — перемещение (`rtc.mayMove`, docs/09 п. 54): админ/владелец перемещает и админов, и владельца. Иерархия пространства (`workspaces.outranks`) — по старшей роли (ADR-0026).

## LiveKit grant

`rtc.Grant`: `canSubscribe` = `VIEW_ROOM & CONNECT`; источники — `microphone` при `SPEAK` (и без серверного мьюта), `screen_share(+audio)` при `STREAM` и выданном слоте, `camera` при `VIDEO` и выданной камере; `roomAdmin` клиенту не выдаётся. Токен `/join` и токен перемещения (`VOICE_MOVED`) считаются из прав в целевой комнате. Изменение прав во время звонка (`rtc.SyncPublisher`): `ROOM_PERMISSIONS_UPDATE` — устройства этой комнаты, `WORKSPACE_MEMBER_UPDATE` — устройства участника, `ROLE_UPDATE` / `ROLE_DELETE` — все устройства пространства; `UpdateParticipant` с новым grant, без `VIEW_ROOM | CONNECT` — `RemoveParticipant`. Исключение / бан / приостановка — отключение. Закрытие комнаты — тот же путь (`ROOM_UPDATE` + `ROOM_PERMISSIONS_UPDATE`).

## Видимость живьём

Gateway (`hub.routeLocked`) пересчитывает `VIEW_ROOM` получателя на тех же событиях: доступ появился → `ROOM_CREATE`, для голосовой комнаты с идущим звонком за ним — начало звонка и `VOICE_STATE_UPDATE` участников (`dispatchGained`); пропал → `ROOM_DELETE` (клиент убирает комнату и её голосовые состояния, выходит из звонка в ней). Доски — так же: `BOARD_UPDATE` несёт `restricted` и переопределения, шлюз пересчитывает `VIEW_BOARD` каждому получателю и шлёт `BOARD_CREATE` / `BOARD_DELETE` тем, у кого доступ появился / пропал (`gateway/boards.go`). Доски по карточкам (ADR-0059): шлюз держит приглашённых (исполнители ∪ согласующие живых задач) и счётчик карточек на доску; события задачи и сообщения её комнаты идут зрителям доски и её приглашённым (`taskBits`); `TASK_UPDATE` для приглашённого — переход: позвали → `BOARD_CREATE` (`task_scoped`, без битов, переопределений и `open_tasks`) при первой карточке, затем `TASK_CREATE`; сняли / архив → `TASK_DELETE` (`purged = false`), с последней карточкой — `BOARD_DELETE`; доску закрыли (`restricted`), участник стал гостем — `BOARD_DELETE`; переход «полный доступ ↔ по карточкам» — `BOARD_DELETE` + `BOARD_CREATE`.
