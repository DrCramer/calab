# Холст v2 — места повышенного риска для независимого ревью

Перечень для независимого ревью ветки `feat/canvas` владельцем (план — `docs/plans/canvas-v2-tasks.md`, решения — ADR-0114, ADR-0115). Каждая волна, меняющая протокол, права или сервер, дописывает сюда свой раздел: **файл:строка → что может пойти не так → чем закрыто → чем проверено**. Строки — на коммит волны; при расхождении искать по имени функции.

## Оглавление по волнам
- [Волна 4 (V3) — комментарии и @упоминания](#волна-4-v3--комментарии-и-упоминания) — права на чтение и запись, фильтр получателей, упоминания, лимиты, каскады, SQL, маршруты.
- [Волна 5а (V4) — публичная ссылка только для чтения](#волна-5а-v4--публичная-ссылка-только-для-чтения-анонимный-сокет) — код, управление, одинаковый 404, анонимный сокет, отзыв, лимиты.
- Волны 1а, 1б, 2, 5б (V1a, V1b, V2, V5) — клиентские, без протокола и прав: риск регрессий, не безопасности. Отступления — в `docs/12-tech-backlog.md` и в «Дополнениях реализации» ADR-0115. Голосование и таймер живут в документе: лимит голосов проверяет клиент (V2 (в)).
- V6 (перф) — без протокольных изменений; цифры — `docs/14-energy.md`, остаток — `docs/12` V6.

## Уже проверено лидом вживую
- **V1a** (вращение, группы, мультивыделение) — глазами. **V2** (таймер, голосование) — глазами. **V3** (инструмент, панель, упоминание, пин) — глазами.
- **V4** — атака анонимным клиентом: любой кадр — 4013, awareness не уходит, документ не меняется; отзыв закрывает живой сокет за ~60 мс кодом 4404; неизвестный, отозванный и истёкший коды — одинаковый 404; ссылка на приватный холст — 409 `CANVAS_RESTRICTED`; `noindex, nofollow` и `no-store`; поля ответа — только name, updatedAt, readOnly; код — 43 символа base64url из 32 байт. Остаток: публичная страница `/c/{code}` поднимает сессионные запросы оболочки веб-клиента (`/api/auth/refresh`, `/api/me` и др.) — для анонима 401, без раскрытия, но лишние — `docs/12` (лид, проверка V4; в R4 не перепроверено).
- **V5** — глазами в эмуляции 375×812: режим «Править», нижняя панель, лист «+». Жесты и клавиатура — только синтетическими событиями; настоящий телефон не проверен.
- **V1b** — глазами не проверено; подход к форматированию — в отчёте сессии и `docs/12` V1b.

## Волна 4 (V3) — комментарии и @упоминания

Код: `apps/server/internal/canvas/comments.go`, `internal/db/migrations/00109_canvas_comments.sql`, `internal/db/queries/canvas_comments.sql`, `internal/gateway/canvas.go`, `internal/gateway/identity.go`, `internal/app/{identityroutes,botroutes,app}.go`, `internal/notifications/notifications.go`; клиент — `apps/desktop/src/renderer/{services/canvasComments.ts,stores/canvasComments.ts,features/canvas/view/comments/*}`. Тесты: `internal/canvas/comments_integration_test.go` (4 теста), `internal/gateway/canvas_test.go` `TestCanvasCommentEventsPerRecipient`, векторы `canvas` в `proto/testdata/notifications.json`, клиент — `features/canvas/view/comments/comments.test.ts`, `services/canvasComments.test.ts`.

### 1. Права на чтение — 404 без `CANVAS_VIEW`, в том числе по id комментария
- `comments.go:209` `listComments`, `:534` `mentionAccess` → `s.pathItem` → `canvas.go:172` `resolve`: нет элемента, не участник, нет `CANVAS_VIEW` — одинаковое `errNoItem` (404). **Атака:** перебор id холстов/комментариев, чтобы узнать о существовании приватного. **Закрыто:** `comments.go:372` `pathComment` сначала читает комментарий, затем `resolve` холста и превращает `errNoItem` в `errNoComment` — ответ не отличается от «нет такого». **Проверить глазами:** что ни одна ветка не отвечает 403 раньше 404 (403 только после `resolve`, т. е. тому, кто холст видит). **Остаток:** scope-резолвер шлюза идентичности (`identityroutes.go` `scopeCanvasComment` → `GetCanvasCommentWorkspace`) для сессии, ограниченной другим пространством, отвечает 403 `IDENTITY_SCOPE_DENIED` на существующий id и 404 на несуществующий — тот же оракул, что у всех scoped-маршрутов (`scopeCanvasItem`, `scopeWikiPage`), не новый. Тест: `TestCanvasCommentsAccess` (гость, посторонний), `TestCanvasCommentsPrivate` (администратор и участник на приватном холсте: GET/PATCH/DELETE/mention-access — 404).
- Приватный холст и «Владелец видит приватное»: права считает `canvasacl` + `perm.ComputeCanvasItemIn` (как у дерева), своих проверок нет. Тест: `TestCanvasCommentsPrivate` (администратор не видит).

### 2. Права на запись
- `comments.go:121` `commentable`: папка → 409, приостановленное пространство → 403 (`writable`), корзина → 409, нет `CANVAS_WRITE` → 403. Порядок важен: 403 «нет WRITE» отдаётся только тому, кто холст видит. Проверяется дважды: до траты лимита и **повторно в транзакции** (`:310`, `:436`, `:506`) — гонка «отобрали доступ между проверкой и записью».
- `comments.go:139` `commentEditable`: чужое правит/удаляет владелец холста или `CANVAS_MANAGE` (`perm.CanvasStructureAllowed`), своё — автор **с** `CANVAS_WRITE`. Исключение — `changeable` (`comments.go` рядом с `commentable`): `errNoWrite` прощается, если `a.structure()` — владелец холста/`MANAGE` без `WRITE` (переопределение «только просмотр» самому себе) может модерировать. **Проверить:** что это исключение не пропускает корзину/приостановку (они возвращаются раньше `errNoWrite` — да, `commentable` проверяет их первыми). `author_id` NULL (аккаунт удалён) — только модератор.
- Резолв ветки (`:457–:473`): только корень (422 для ответа), `CANVAS_WRITE` или модератор. Тест: `TestCanvasCommentsAccess` (зритель 403, ответ 422, писатель решает, владелец открывает снова).
- **Решение для ревью:** удаление корня уносит **чужие ответы** (CASCADE). Автор корня с `CANVAS_WRITE` может так стереть ответы других — сознательно (как ветка в Figma), записано в `docs/12` V3 (а). Если неприемлемо — заглушка вместо удаления.

### 3. Фильтр получателей событий шлюза
- `gateway/canvas.go:80–:88` → `:95` `canvasToViewers`: `CANVAS_COMMENT_UPSERT/DELETE` несут цепочку доступа холста (`Access`), получатель — только участник с `CANVAS_VIEW` по `perm.ComputeCanvasItemIn` (`:21` `canvasBits`: боты и не-участники → 0). Цепочка вырезается: клиентам уходит новый `DispatchEvent` без `Access`. **Пустая цепочка → никому** (fail closed). **Атака:** утечка текста комментария приватного холста через событие пространства. Тест: `TestCanvasCommentEventsPerRecipient` (открытый: члены и админ, не гость и не бот; приватный: автор и приглашённый гость, не админ; цепочка не утекает).
- Потерявший доступ: отдельного «REMOVE для комментариев» нет — его закрывает `CANVAS_ITEM_REMOVE` дерева, клиент на нём забывает комментарии холста и всех холстов под удалённой папкой (`services/canvas.ts` `onCanvasItemRemove`). Новые события такому получателю уже не идут (цепочка после изменения).
- Классификация: `gateway/identity.go:298` — все три события `true` (workspace-scoped, lease-gated). `CANVAS_COMMENT_MENTION` идёт по каналу пользователя; `eventResources` находит `workspace_id` и проверяет аренду пространства сессии — сессия, ограниченная другим пространством, событие не получит. **Без этой строки** событие пользовательского канала было бы неклассифицировано (deny) — проверить, что `knownScopedEvent` его пропускает.
- `hub.go` `routeLocked`: `routeCanvas` вызывается до `default: toAll` — **если убрать case в `routeCanvas`, событие уйдёт всем участникам пространства**. Тест выше это ловит (`routeCanvas` должен вернуть `true`).

### 4. Кого можно упомянуть
- `comments.go:95` `bodyMentions` → `messages.ParseMentions` (не в коде, ≤ 50 разобранных) → > 10 разных → 422. Клиентский список `mentions` сервер **не принимает** — только тело.
- `comments.go:149` `mentionable`: `ListUsersByIDs` (не бот, не отключён) → `GetMemberAccess` (участник пространства, с `OwnerSeesPrivate`) → `ComputeCanvasItemIn(m, chain).Has(CANVAS_VIEW)`. Недоступные молча отбрасываются (как в чате и задачах), текст остаётся. Выполняется **в транзакции** записи. **Атака:** упомянуть того, кто холст не видит, и тем самым отправить ему название/текст. Тест: `TestCanvasCommentMentions` (посторонний, гость без доступа, бот, упоминание в `` `коде` `` — не в `mentions`, уведомления нет), `TestCanvasCommentsPrivate`.
- `mention-access` (`:534`): та же функция, ≤ 200 id за запрос, без отдельного лимита частоты. **Оракул:** участник с `CANVAS_VIEW` узнаёт, кто ещё видит холст. Принято как у задач (ADR-0076 §5), записано в `docs/12` V3 (д).

### 5. Утечка текста в уведомления
- `comments.go:582` `notifyMentions`: после коммита, получатели — только `fresh` из `notifiedAfter` (`:184`: без автора, без тех, кто уже в `notified`, не больше 100). Уровень — `notifications.CanvasMentionNotifies` (`ALL`/`MENTIONS` — да, `NONE` и mute пространства — нет). Текст (≤ 200 символов) — только при `notifications.CanvasMentionText`: **пуст для приватного холста** (`perm.RestrictedIn` по цепочке, `:591`) и для тех, у кого `hide_message_text_in_notifications`. Тест: `TestCanvasCommentMentions` (автор не получает, правка не дублирует, скрытый текст, уровни), `TestCanvasCommentsPrivate` (приватный — без текста), векторы `canvas mention *` (Go `TestVectors`, TS `notifications.test.ts`).
- **Проверить:** название холста (`canvas_name`) уходит и для приватного — получатель холст видит (проверено `mentionable`), название ему и так показано в дереве. Если ревьюер считает иначе — пустить пустое имя для restricted.
- Нет APNs: `push/delivery.go` `eventJob` событие не знает — на телефон с закрытым приложением ничего не уходит (как у задач). Не утечка, но отступление (`docs/12` V3 (в)).
- Клиент (`services/canvasComments.ts` `noticeBody`) показывает только то, что прислал сервер; `@<id>` превращает в имена из своего списка участников.

### 6. Лимиты и DoS
- Тело: `commentBody` (`:82`) 1..2000 символов, без управляющих кроме `\n\t`; БД CHECK `00109:32`. Пин: `pin` (`:104`) — конечные |x|,|y| ≤ 10⁷ (NaN отсекается сравнениями), `object_id` ≤ 64 без управляющих; БД CHECK `00109:28,41`.
- ≤ 500 комментариев на холст: `LockCanvasComments` (advisory xact lock на холст, `canvas_comments.sql:4`) + `CountCanvasComments` в той же транзакции (`:316–:325`) — гонка двух POST не даёт 501-й. **Проверить:** блокировка не берётся вместе с `LockCanvasTree` (порядок блокировок) — в `createComment` её нет.
- Частота: `CommentLimit` 20 сразу, 20/мин на человека (`app.go:473`, `rl:canvas-comment:`), тратится на создание и правку текста, **после** `resolve` (чужой холст не тратит бюджет). Решение/удаление не лимитированы (как у встреч). Тест: `TestCanvasCommentLimits` (429 на третьем при бюджете 2, у другого — свой).
- Листинг: ≤ 100 корней на страницу + **все** их ответы (≤ 500 на холст — ограничено), курсор — id корня (uuidv7 по времени), `ListCanvasReplies` по `parent_id = ANY` с индексом `canvas_comments_parent_idx`.
- Уведомления: ≤ 10 получателей на запись, ≤ 100 за жизнь комментария (`notified`).

### 7. Каскады и миграция
- `00109:26` `canvas_id … ON DELETE CASCADE` — удаление холста навсегда (и очистка корзины, и почасовой sweeper) уносит комментарии; корзина их сохраняет. `:27` `parent_id … CASCADE` — корень уносит ветку. `author_id/resolved_by … SET NULL` с индексами. Тест: `TestCanvasCommentLimits` (CASCADE после `DELETE /api/canvas/items/{id}`).
- `00109:53–:56`: замена CHECK `canvas_activity.kind` — `DROP` + `ADD … NOT VALID` + `VALIDATE` (короткая `ACCESS EXCLUSIVE` на DROP/ADD без скана, скан под `SHARE UPDATE EXCLUSIVE`), `lock_timeout 10s`. Down удаляет записи `comment/resolve` до возврата старого CHECK. **Проверить:** имя автосгенерированного ограничения `canvas_activity_kind_check` (инлайн CHECK в 00107) — на проде то же.
- Журнал (`comments.go` `s.journal(… "comment" / "resolve" …)`): `after` — только `comment_id`/`thread_id`, `item_name` — название холста (как у всех записей журнала; `visibleActivity` прячет записи холстов, которые читатель не видит). Тест: `TestCanvasCommentsAccess` (в `after` нет текста).

### 8. SQL
- Все запросы `canvas_comments.sql` параметризованы sqlc; `CanvasMentionFacts` — `unnest(uuid[])` + `JOIN users` + `LEFT JOIN workspace_notification_settings` по паре (user, workspace). `GetCanvasCommentWorkspace` — для scope-резолвера (без проверки прав — права дальше в обработчике).
- Ответ на ответ: `createComment` (`:326–:339`) берёт родителя, сверяет `CanvasID` с холстом из пути (иначе 404 — нельзя прицепиться к ветке чужого холста), поднимается к корню. БД это не проверяет (FK только на существование) — **проверить**, что иного пути вставки ответа нет.

### 9. Классификация маршрутов
- `botroutes.go:359` (группа `botDeny` «Canvas v1»): пять маршрутов в группе `botDeny` «Canvas v1» (причина обновлена). `TestBotRouteTable`/`TestBotRouteGroups` зелёные — без записи тест падает.
- `identityroutes.go:540–:545`: `…/items/{id}/comments*` — `scopeCanvasItem`, `/api/canvas/comments/{id}` — новый `scopeCanvasComment` (`GetCanvasCommentWorkspace`). Неизвестный id → 404 «resource» (`identityroutes.go` `db.IsNotFound`). `IdentityRouteClass` → `canvas_comment` (тесты scope-матрицы его пропускают — фикстуры для `canvas_item` тоже нет; при желании добавить обе).

### 10. Клиент (не безопасность, но риск регрессий)
- Пины — DOM-слой (`CommentPins.tsx`) с CSS-переменными камеры: основной канвас не перерисовывается на комментарии (тест: `raf.scheduled`/`stats.frames` не растут), чужой комментарий перерисовывает только свой пин. Инструмент `comment` в движке (`engine.ts` `emitCommentAt`, `input.ts` — мышь, касание, ⌥C по `e.code`) документ не трогает (тест).
- Текст комментария рендерится React-текстом (`bodyParts`), без `dangerouslySetInnerHTML` и без Markdown.

## Волна 5а (V4) — публичная ссылка только для чтения (анонимный сокет)

Код: `apps/server/internal/canvas/link.go`, `internal/ysync/{conn,hub,ysync}.go` (режим зрителя), `internal/canvas/{items,share,canvas,convert}.go` (отзыв, маршруты), `internal/db/migrations/00110_canvas_links.sql`, `internal/db/queries/canvas_links.sql`, `internal/app/{app,botroutes,identityroutes}.go`, `infra/docker/caddy/sites.caddy`; клиент — `apps/desktop/src/renderer/{lib/ySync.ts,lib/canvasSync.ts,services/canvasPublic.ts,features/canvas/{PublicPage,LinkPanel}.tsx,features/canvas/view/{CanvasView.tsx,session.ts,StatusBanner.tsx}}`. Тесты: `internal/canvas/link_integration_test.go` (6 тестов: `TestCanvasLinkManage`, `…PublicPage`, `…SocketReceiveOnly`, `…SocketCloses`, `…SocketLimits`, `…SocketLife`), все прежние `internal/canvas`, `internal/wiki` (общий `ysync`), `TestBotRouteTable/Groups`; клиент — `lib/canvasSync.public.test.ts`, `features/canvas/{LinkPanel,PublicPage}.test.ts`, `view/CanvasView.test.ts` «the public link viewer».

### 1. Код — единственный пропуск
- `link.go:53` `newCode`: 32 байта `crypto/rand` → base64url 43 символа (256 бит; как у Вики и Диска). `:62` `validCode` — длина и алфавит **до** запроса в БД; CHECK `00110:22` по тому же регулярному выражению. **Атака:** перебор кодов. **Закрыто:** 2²⁵⁶ + лимиты IP (`app.go:479–:480`). **Проверить:** код нигде не логируется и не попадает в журнал (`createLink` пишет в `after` только `expires_in_days`; тест `TestCanvasLinkManage` ищет код в записях журнала), в ответах — только владельцу/`MANAGE` (`getLink`/`createLink`).
- Ключи Valkey зрителя — по id холста и IP (`link.go:427–:428`), не по коду.

### 2. Кто управляет ссылкой
- `link.go:88` `linkable` → `structure()` (владелец или `CANVAS_MANAGE`), только `kind = canvas`, не корзина, **`perm.RestrictedIn` по всей цепочке** (приватная папка выше тоже) → `409 CANVAS_RESTRICTED`. Без `CANVAS_VIEW` — `404` из `resolve` раньше любых 403/409. `createLink` (`:134`): `writable` (приостановка → 403), `LockCanvasTree` (`:170`) и **повторный `resolve` под замком**, `CheckPublicCapability` (`:179`). **Атака:** гонка «включить ссылку ↔ сделать папку выше приватной». **Закрыто:** PUT permissions с `restricted` теперь тоже берёт `LockCanvasTree` до блокировки строки (`share.go:103`, порядок «дерево → строка», как у `update`), PATCH уже брал; `dropLinks` в той же транзакции. Даже если гонка пройдёт — анонимная проверка (`linkOpen`) смотрит цепочку на каждом запросе. Тест: `TestCanvasLinkManage` (писатель, гость с VIEW — 403; посторонний — 404; админ ок; папка, приватный, под приватной папкой, корзина — 409; приостановка — 403).
- Боты: все три маршрута — в группе `botDeny` «Canvas v1» (`botroutes.go:364,:369,:380`); scope — `scopeCanvasItem` (`identityroutes.go:548–:550`).
- Один живой: частичный уникальный `canvas_links_live_idx` (`00110:31`) + `RevokeCanvasLink` истёкшей перед вставкой (`link.go:194`). Повтор POST при живой — смена срока с тем же кодом (`SetCanvasLinkExpiry`) и `Kick` (`:211`), чтобы живые сокеты пересчитали срок.

### 3. Одинаковый 404 для всех причин
- `link.go:277` `linkOpen` + `:315` `lookup`: неизвестный/не того вида/отозванный/истёкший (`GetCanvasLinkByCode` фильтрует `revoked_at`/`expires_at` по `now()` БД), папка, корзина (сам **и** через цепочку `canvasacl`), приватный по цепочке, приостановка модерацией, приостановка оплатой (`Billing.CheckBillingOpen`, отказ → 404), политика без публичного (отказ `CheckPublicCapability` → 404, **не** `403 SSO_REQUIRED`, как у Вики) — всё `errNoLink`. Ошибки зависимостей — 5xx (не оракул: от кода не зависят). Тест: `TestCanvasLinkPublicPage` сравнивает **тела** 404 побайтно для 9 причин, включая приватное и корзину «в обход API».
- **Остаток:** время ответа: живой код на приватном холсте делает больше запросов, чем неизвестный — различимо, но для этого уже нужен сам код.
- Заголовки (`link.go:330` `anonymous`): `no-store`, `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer` — и на 404. Caddy — `/c/*` в `@sensitive_spa` (`sites.caddy:187`).
- Просмотры: `r.Method == GET` (`:366`) — Go-шаблон `GET` ловит и `HEAD`; клиент перепроверяет `HEAD`-ом, чтобы не накручивать. Без дедупликации (по брифу).

### 4. Анонимный сокет: только приём
- `link.go:386` `publicSync`: Origin (`ysync.OriginAllowed`, тот же `gateway.OriginAllowed`) → лимит подключений IP → `lookup` → **только потом** апгрейд (`ServeViewer`). Отказ — обычный HTTP 404/429/403, сокет не открывается и ничего не держит.
- `ysync/conn.go:132` `ServeViewer`: нет текстового кадра токена; `c.viewer` задан, `write` всегда false (`authorize` `:252` не трогает `write`), лимит чтения — `readLimitRO` (64 КиБ + 16) и не поднимается (`run` поднимает только при `write`). `readLoop` (`:471`): **первый же** кадр любого типа (бинарный, текст) → `4013` до разбора; `onUpdate`/`onSnapshot`/`onAwareness` для зрителя недостижимы. **Атака:** записать в документ, отравить снимок, разослать awareness от имени «никого». **Закрыто** этой веткой. Тест: `TestCanvasLinkSocketReceiveOnly` — `UPDATE`, `SNAPSHOT_POST`, `AWARENESS`, неизвестный тип, текстовый кадр с токеном участника → 4013; `canvas_updates` не меняется, `canvas_snapshots` пуст; новый зритель не видит «evil».
- **Проверить глазами:** что в `conn` нет других путей записи, кроме `readLoop` → `on*` (их нет: `writeLoop` только шлёт).

### 5. Что анониму не доставляется
- `ysync/hub.go:184` `deliverFrame`: `AWARENESS` — никогда зрителю (локально и через Redis: обе дороги идут через `deliverFrame`); `COMPACT_REQUEST` — только при `write` (`:183`, и потолок, и обычный). Тест: зритель читает строго `SNAPSHOT`/`UPDATE` подряд (`replica.apply` падает на любом другом кадре) при чужой awareness и `CompactUpdates: 1`.
- Присутствие: зритель ничего не шлёт → его не видит никто; счётчики зрителей отдельно от людей (`canvas:viewers:*` против `canvas:conns:*`).
- **Остаток — содержимое документа:** Yjs уходит целиком; внутри — непрозрачные `user_id` голосовавших (`votes[obj][userId]`), `meta.vote.by`, `meta.timer.by`. Имён/цветов/аватаров нет (они только в REST участников, анониму недоступном), но «id X голосовал за стикер Y» восстановимо. Сервер Yjs не разбирает и фильтровать не может. Записано в `docs/12` V4 (г). **Решение для ревью:** приемлемо ли; иначе — голоса из документа в серверную сущность (отдельный ADR).
- Комментарии, версии, журнал — только REST с аутентификацией; клиент-зритель не монтирует `CommentsLayer` (тест: ни одного `fetch`).

### 6. Отзыв, срок, корзина, приватность закрывают живые сокеты
- Перепроверка зрителя — `Check` (`link.go:405`) = тот же `lookup` по коду (+ что холст тот же). Будят: `Kick` после `DELETE …/link` (`:249`), смены срока (`:211`), корзины (`items.go:532` `s.kick(ctx, ids)`), `restricted`/переноса/доступа папки (`recheckBelow`); срок — **таймер сокета** на `expires_at` из `Check` (`conn.go:283` `arm`, минимум 1 с: решают часы БД, ранняя проверка перевзводится); и общий тик 30 с. Закрытие — `4404`. Тест: `TestCanvasLinkSocketCloses` (отзыв; срок через 1.5 с без события; корзина; `restricted` холста; `restricted` папки через PUT permissions; перенос в приватную папку; смена срока — сокет жив). Удаление навсегда — после корзины (сокеты уже закрыты), строки уходят CASCADE (тест в `…PublicPage`).
- **Остаток:** приостановка пространства, смена политики идентичности, удаление пространства — без `Kick`, до 30 с (`docs/12` V4 (д)).
- `dropLinks` (`link.go:259`) — **отзыв** ссылок поддерева при `restricted` (`items.go:407`, `share.go:160`), переносе в приватную папку (`items.go:407`) и корзине (`items.go:512`); снятие `restricted` и восстановление их **не** возвращают (тест: `restricted` вкл→выкл — ссылки нет). Записи `link_off` при этом нет (`docs/12` V4 (в)).

### 7. Лимиты и DoS
- Подключения: `rl:canvas-link-ws:` 20 сразу / 10 в минуту на IP (до апгрейда, `429`); имя: `rl:canvas-link:` 60/мин на IP. IPv6 — по `/64` (`ipGroup`, `link.go:343`).
- Сокеты: `ysync/hub.go:322` `claim` по нескольким слотам (≤ 100 на холст, ≤ 10 на IP по всем ссылкам), любой сверх → `4008` и выход из всех слотов; ZADD+ZCARD конвейером, не MULTI — при гонке двух подключений оба могут получить отказ (в сторону закрытия), как и у людей. Тест: `TestCanvasLinkSocketLimits` (на ссылку, на IP через две ссылки, /64, частота, участники не считаются).
- Жизнь ≤ 2 ч (`ViewerMaxLife`, `conn.go:296`) → `4000`; тест `TestCanvasLinkSocketLife`.
- **Остаток:** нет лимита частоты подключений **на ссылку**: распределённые IP могут гонять подключения, каждое читает снимок (≤ 4 МиБ) и обновления из БД — тот же класс, что `GET /api/public/wiki/{code}/state`. Без доверенных прокси все анонимы — один IP-ключ (отказ в сторону закрытия). `docs/12` V4 (е, ж).
- Медленный зритель: очередь 256 → «добор» из БД только недостающего (снимок перечитывается лишь после новой компакции), `WriteTimeout` 10 с закрывает зависшего.

### 8. Общий ретранслятор не сломан
- `Serve` людей разнесён на `accept` + авторизацию + `run` (`conn.go:210`); слот человека — тот же ключ `canvas:conns:<doc>:<user>` / `wiki:conns:…` с `MaxConnsPerUser`. Все тесты `internal/wiki` и `internal/canvas` (синхронизация, потолок V1-фикса, компакция, межэкземплярные, рукопожатие, Origin) — зелёные без изменений. **Проверить:** `claim` теперь при ошибке Valkey делает `release` (раньше нет) — безвредно.

### 9. Клиент
- `lib/ySync.ts` `anonymous`: `send()` возвращается сразу (вторая страховка поверх `readOnly`), `setReadOnly(false)` игнорируется, нет токена в `onopen`, входящая awareness отбрасывается, 4013 — без переподключения. Тест `canvasSync.public.test.ts`: после правок, awareness, `compact`, `COMPACT_REQUEST`, `destroy` — `sent` пуст; в покое 0 таймеров.
- `CanvasView publicCode`: без `CommentsLayer`, `Presence`, `VoteChip`, мини-карты, контекстного меню, `setCanvasDocHandle`; `bits` игнорируются (тест монтирует с `WRITE`, клавиши правки не шлют ничего). Страница `/c/{code}` не отдаёт и не хранит реальный id холста (`canvasId = 'public'`).
