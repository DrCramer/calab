# ADR-0143. Правка офисных файлов Диска в ONLYOFFICE Docs

Статус: **принято и реализовано** (задача #98, 28.10.2026): спайк `spike/onlyoffice-98` с пробным
прогоном, сервер `feat/office-server-98` с независимым ревью безопасности (`fix/office-review`),
клиент `feat/office-client-98`, сведены в `feat/office-integration-98`. Выкатка Document Server —
[docs/ops/office-onlyoffice-deploy.md](../ops/office-onlyoffice-deploy.md). Дополняет
[ADR-0094](0094-disk.md) (Диск). Решение о движке — владельца: ONLYOFFICE, потому что правка и
пересчёт идут в браузере пользователя и сервер остаётся лёгким.

## Контекст

Файлы Диска (`ФОТ*.xlsx`, `График отпусков*.xlsx`, шаблоны договоров `*.docx`) сотрудники
регулярно правят, а боты и синк Hostinger читают их по пути и sha256 (openpyxl, python-docx). Сейчас
поправить ячейку можно только скачав файл и загрузив его заново. Нужно (доска #98): «Открыть»
открывает редактор в окне Calab. Сохранение идёт в тот же файл: тот же id, путь и имя, новая
версия в «Истории», новые sha256, размер и `updatedAt`. Нужна совместная правка без «конфликтующих
копий». «Правка» редактирует, остальные открывают файл только на чтение. Файл остаётся обычным
OOXML. Телефону достаточно просмотра.

## Факты из документации ONLYOFFICE (проверено 28.10.2026)

Актуальная версия — **10.0.0** (12.10.2026,
[releases](https://github.com/ONLYOFFICE/DocumentServer/releases)).

**Лицензия и лимиты Community Edition**
- AGPLv3 с дополнительными условиями: указание авторства (раздел «About» или аналог), пометка
  изменённых версий; права на товарные знаки не даются. Оригинальный брендинг и копирайты
  убирать нельзя; white label — только по коммерческой лицензии. Если программу изменили и дают
  ей пользоваться по сети, её исходники должны быть доступны пользователям.
  Источники: [блог 9.4](https://www.onlyoffice.com/blog/2026/05/onlyoffice-docs-9-4),
  [FAQ Community](https://helpcenter.onlyoffice.com/docs/faq/docs-community.aspx).
- **Лимита 20 одновременных подключений больше нет** (с 9.4, 19.05.2026). Проверено по коду:
  коммит [ONLYOFFICE/server@c635713](https://github.com/ONLYOFFICE/server/commit/c635713160f2964fb1f5abddc75b5a7cdc05d73e)
  ставит `connections` и `connectionsView` для open source в `0x7fffffff`. В том же объекте
  лицензии: `customization: false`, `branding: false`, `advancedApi: false`. Лимита на число
  документов не нашли. FAQ называет ограничения Community: «No clustering or enterprise
  scalability» (только один инстанс) и «No mobile web version».
- **Мобильная веб-правка — только в коммерческих редакциях.** Community на телефоне открывает
  документ только для просмотра. Источники:
  [FAQ](https://helpcenter.onlyoffice.com/docs/faq/docs-community.aspx),
  [сравнение редакций](https://www.onlyoffice.com/compare-editions).

**Кастомизация** ([customization](https://api.onlyoffice.com/docs/docs-api/usage-api/config/editor/customization/customization-standard-branding/),
[темы](https://api.onlyoffice.com/docs/docs-api/get-started/how-it-works/customizing-themes/)).
Что работает без лицензии, проверено по коду web-apps
(`apps/spreadsheeteditor/main/app/controller/Main.js`: `canBranding = asc_getCustomization()`,
`canBrandingExt = asc_getCanBranding()`; `LayoutManager`/`FeaturesManager` читают
`customization.layout` и `customization.features` только при `canBrandingExt`):

| Параметр | Community | Что даёт |
|---|---|---|
| `uiTheme`: `default-dark`, `default-light`, `theme-dark`, `theme-light`, `theme-classic-light`, `theme-contrast-dark`, `theme-gray`, `theme-white`, `theme-night`, `theme-system` | да | тёмная или светлая тема по теме приложения |
| Своя тема: JSON `{id: "theme-…", type: light/dark, colors{…}}` в `web-apps/apps/common/main/resources/themes`, затем `uiTheme: "theme-calab-dark"` | да (ограничения редакции в документации нет; проверить прогоном) | цвета Calab: фон, панели, акцент |
| `compactHeader`, `compactToolbar`, `toolbarHideFileName`, `hideRightMenu`, `hideRulers`, `zoom`, `unit`, `wordHeadingsColor` | да | компактная шапка, имя файла только в рамке Calab |
| `autosave`, `forcesave`, `comments`, `help`, `feedback`, `plugins`, `close`, `goback`, `macros`, `review.*`, `mobile.*`, `ai.disabled` | да | убрать «Справку», «Обратную связь», плагины, AI |
| `logo`, `customer` (раздел «О программе») | **нет** (только Developer) | свой логотип |
| `layout` (скрыть вкладки, меню «Файл», панели, строку состояния), `features` (spellcheck mode, `tabStyle`, `tabBackground` без `change`) | **нет** (`canBrandingExt`) | тонкая перекройка интерфейса |
| `loaderLogo`, `loaderName`, `font` | **нет**: Community показывает предупреждение «платная функция» | свой экран загрузки |

**JWT** ([signature](https://api.onlyoffice.com/docs/docs-api/additional-api/signature/),
[в заголовке](https://api.onlyoffice.com/docs/docs-api/additional-api/signature/request/token-in-header/),
[в теле](https://api.onlyoffice.com/docs/docs-api/additional-api/signature/request/token-in-body/),
[Docker env](https://github.com/ONLYOFFICE/Docker-DocumentServer#readme))
- Алгоритм HS256. В Docker `JWT_ENABLED=true` по умолчанию, а `JWT_SECRET` без явного значения —
  случайный, поэтому его обязательно задавать. `JWT_HEADER=Authorization`, `JWT_IN_BODY=false`.
- Конфиг редактора подписан целиком: claims — это сам конфиг, а токен лежит в `config.token`.
- Исходящие запросы Document Server (скачивание `document.url` и вызов `callbackUrl`) несут
  `Authorization: Bearer <jwt>`, где `payload` — тело запроса; при `JWT_IN_BODY` токен идёт полем
  `token` в теле. С 10.0 в токене есть `operation` (`download` / `callback`), и Document Server
  отвергает входящие токены с такими значениями. `/converter`, `/command` и `/docbuilder` больше не
  принимают токен конфига редактора ([CHANGELOG 10.0.0](https://github.com/ONLYOFFICE/DocumentServer/blob/master/CHANGELOG.md)).

**Сохранение** ([callback handler](https://api.onlyoffice.com/docs/docs-api/usage-api/callback-handler/))
- Статусы: 1 — подключился или отключился пользователь; 2 — готов к сохранению, через ≈10 с после
  закрытия последним (`url`, `changesurl`, `history`, `users`, `actions`, `filetype`); 3 — ошибка
  сохранения; 4 — закрыт без изменений; 6 — forcesave, правка продолжается (`forcesavetype`: 0 —
  command service, 1 — кнопка «Сохранить» или Ctrl+S при `customization.forcesave`, 2 — таймер
  сервера, 3 — отправка формы); 7 — ошибка forcesave.
- Ответ `{"error":0}`. Время жизни `url` в документации не указано: файл забираем сразу.

**Ключи и совместная правка** ([document](https://api.onlyoffice.com/docs/docs-api/usage-api/config/document/),
[co-editing](https://api.onlyoffice.com/docs/docs-api/get-started/how-it-works/co-editing/))
- `document.key`: символы `0-9 a-z A-Z - . _ =`, не длиннее 128. Ключ уникален на сервере
  документов, иначе тот отдаст чужой кэш. Известный ключ открывает документ из кэша.
- Все соавторы открывают один ключ. После статуса 2 ключ больше не открывает правку — нужен новый.
  После статуса 6 ключ **не меняют**, иначе совместная правка распадётся.
- Режимы `coEditing`: `fast` (по умолчанию, правки видны сразу) и `strict`. Совместная правка в
  Community доступна.


**Форматы** ([ONLYOFFICE/document-formats](https://github.com/ONLYOFFICE/document-formats),
`onlyoffice-docs-formats.json` — машиночитаемый список, по которому работают коннекторы
ONLYOFFICE; сверено для Docs 10.0 28.10.2026; [fileType в config.document](https://api.onlyoffice.com/docs/docs-api/usage-api/config/document/)):

| Расширение | type | actions в списке ONLYOFFICE |
|---|---|---|
| docx / xlsx / pptx | word / cell / slide | `view`, `edit` (родной формат) |
| odt / ods / odp | word / cell / slide | `view`, `lossy-edit`, `auto-convert` |
| rtf | word | `view`, `lossy-edit`, `auto-convert` |
| txt / csv | word / cell | `view`, `lossy-edit` |
| doc / ppt | word / slide | `view`, `auto-convert` (правки в формате нет) |
| xls | cell | `view`, `lossy-edit`, `auto-convert` |
| pdf | pdf | `view`, `edit`, `fill` |

`lossy-edit` — Document Server сохраняет в тот же формат, но может потерять то, чего формат не
держит; `auto-convert` — открывается через конвертацию в OOXML. Все они доступны в Community
(ограничения редакции по форматам в документации нет).

## Решение

### 1. Схема
```
Calab client ──GET /api/office/capabilities──▶ API (on/off, format map, max size, docs origin)
     │       ──GET /api/office/config?item=|file=──▶ API (signed config: mode, key, file URL, callback URL)
     │  iframe {OFFICE_DOCS_URL}/web-apps/apps/calab/calab-editor.html   (only while open)
     │  postMessage: hello → open{config} → events(ready/state/error) → close
     ▼
Document Server ──GET /api/office/file/{t}──▶ API (our URL token + DS JWT «download»; pinned version)
                ──POST /api/office/callback/{t}─▶ API (DS JWT; status 2/6 → new version of the item)
API ──POST {internal}/converter, /command──▶ Document Server («Сохранить как», drop)
API ──GET {internal}/cache/…──▶ Document Server (saved / converted file; only its origin)
```
- **JS Document Server не исполняется в странице Calab.** Клиент на «Открыть» создаёт `<iframe>`
  на хост-страницу `infra/office/calab-editor.html` на origin Document Server (смонтирована
  read-only в его `web-apps/apps/calab/`). Хост грузит `api.js` только после `open`, на `close`
  вызывает `destroyEditor()`, клиент удаляет iframe. Исключений в `script-src` нет, закрытое окно
  ничего не стоит.
- Протокол postMessage: конфиг — только на origin Document Server, сообщения — только от
  `iframe.contentWindow` с этого origin; хост принимает только от `window.parent`.
- Сервер: пакет `internal/office`, флаг `OFFICE_ENABLED` (по умолчанию выключен). Маршруты
  зарегистрированы всегда (одна таблица маршрутов для ботов и identity), выключено — 404.

### 2. Форматы — одна карта на сервере
`internal/office/formats.go` — единственное место, которое решает, что и как открывается; клиент
получает её из `GET /api/office/capabilities` и своей копии не держит.

| Формат | Capability | Режим | Сохранение |
|---|---|---|---|
| docx, xlsx, pptx | `EDIT` | правка по «Правке» | новая версия того же элемента |
| odt, ods, odp, rtf, csv, txt | `EDIT`, `lossy: true` | правка по «Правке» | новая версия в том же формате; клиент предупреждает о возможных потерях |
| doc, xls, ppt | `CONVERT`, `convert_to` = docx/xlsx/pptx | только просмотр | никогда в том же файле; «Сохранить как docx/xlsx/pptx» → **новый** элемент рядом со своим id |
| pdf | `VIEW` | только просмотр | — |
| остальное | нет в карте | как раньше (415 у config) | — |

- xls в списке ONLYOFFICE — `lossy-edit`, но мы его в месте не пишем: бинарный формат, боты
  читают его ненадёжно, а пересохранение старого файла рискованнее новой копии. pdf редактор умеет
  (`edit`), но в объём задачи не входит.
- Проверка байтов при каждом сохранении и конвертации, по формату: OOXML — zip с
  `[Content_Types].xml` и главной частью (`word/document.xml`, `xl/workbook.xml`,
  `ppt/presentation.xml`, так что docx под именем .xlsx не пройдёт); ODF — zip, запись `mimetype`
  с точным типом формата и `content.xml`; rtf — `{\rtf`; csv/txt — UTF-8 (BOM допустим) без NUL.
  Формат без проверки (doc/xls/ppt/pdf) не пишется никогда. Zip не распаковывается целиком —
  читается только каталог и `mimetype` (≤ 128 байт).
- Тип файла при сохранении определяет **текущее имя элемента**, а не `filetype` callback: если
  элемент переименовали в `.doc` посреди сессии, сохранение отклоняется; `filetype` callback должен
  совпадать с расширением.

### 3. Эндпоинты (итоговый контракт с клиентом)
- `GET /api/office/capabilities` (private, без workspace): `OfficeCapabilitiesResponse{enabled,
  formats[], max_size_bytes, docs_url, theme_dark, theme_light}`. Боты — 403. Клиент спрашивает
  его при каждом READY: флаг, карта форматов, origin Document Server и темы оператора — только
  отсюда; переключателя сборки нет.
- `GET /api/office/config?item={diskItemId}|file={fileId}&theme=dark|light&phone=1&lang=ru`
  (private): `OfficeConfigResponse{docs_url, config_json, mode, key, host_url, format, item_id,
  file_id}` — поля 1–5 из спайка не менялись, 6–8 добавлены. `item` — элемент Диска (сессия,
  правка); `file` — вложение (только просмотр, без callback). Подписанный конфиг несёт всё, что
  нужно виду в оболочке: `customization.compactHeader`, `toolbarHideFileName: false` (имя — в шапке
  редактора), `goback: {requestClose: true}` (не на телефоне), `uiTheme`, `lang` и `region` (формат
  дат и чисел по языку приложения: `ru` → `ru-RU`). Клиент конфиг не правит. Ответы: 404 — нет доступа / выключено;
  415 — формата нет в карте; 413 — больше `OFFICE_MAX_SIZE_MB`; 429 — лимит; 403 — бот или запрос
  от имени через бота.
- `POST /api/disk/items/{id}/office/convert` (без тела) и `POST /api/workspaces/{id}/office/convert`
  `{file_id, parent_id}` (вложение в папку пространства): «Сохранить как». 201 `DiskItemResponse`
  нового элемента; 415 — формат без `convert_to`; 502 — Document Server не сконвертировал или
  результат не прошёл проверку байтов.
- `POST /api/workspaces/{id}/disk/import` `{file_id, parent_id, name}` — «Сохранить в Диск»: копия
  читаемого файла (вложение чата или задачи) новым элементом; общий маршрут Диска (`DISK_WRITE`
  на папке, боты — по правам, как загрузка).
- `POST /api/workspaces/{id}/office/create` `{parent_id, extension, name, lang}` — «Создать» (§15).
  201 `DiskItemResponse`; 422 — расширение не docx/xlsx/pptx или плохое имя; 413 — квота;
  403/404 — нет `DISK_WRITE` на папке; выключено — 404. `scopeWorkspace`, `botDeny`,
  `RestrictedUpload`.
- `GET /api/office/file/{token}`, `POST /api/office/callback/{token}` — запросы Document Server
  (анонимные, токены ниже). Callback всегда 200 `{"error":0|1}`.
- `DiskItem.editor_ids` — кто сейчас правит файл (в листинге, `GET` и каждом `DISK_ITEM_UPSERT`);
  `DISK_ACTIVITY_KIND_EDIT` — запись «Истории» о версии.

### 4. Права
`Mode(item, format, phone)`:
- `DISK_VIEW | DISK_WRITE` («Правка», владелец элемента, `DISK_MANAGE`) и формат `EDIT` → `edit`;
- только `DISK_VIEW`, формат `VIEW`/`CONVERT`, элемент в корзине, пространство без записи
  (приостановлено или ограниченный режим тарифа — `plans.RestrictedUpload`) и телефон → `view`;
- без `DISK_VIEW` → 404, как во всём Диске.

Биты — `perm.ComputeDiskItemIn` по цепочке `diskacl`; резолвер проверяет и identity-политику
запроса (`perm.CheckAccess`): `GET /api/office/config?item=` классифицирован как Диск
(`scopeOffice` → рабочее пространство элемента), `?file=` — как чтение файла (`files.CanRead` под
той же политикой). Вложения — только через `files.CanRead` (комната, доска, Диск, …): токен
редактора не открывает ничего, что человек не может скачать. Гости — по своим переопределениям,
как в Диске. Боты в редактор не ходят (config, capabilities, convert — `botDeny`; от имени через
бота — 403), файлы читают и пишут API Диска.

### 5. Сохранение — версия того же элемента
Callback 2 или 6:
1. Наш URL-токен callback → элемент и **ключ сессии**; ключ тела должен совпасть с ключом токена
   и с текущей сессией элемента в Valkey. Иначе — отказ (`error:1`), ничего не пишется.
2. Права автора (`users[0]`) проверяются заново на текущий момент (`ItemFor` без кэша): нет
   `edit` — отказ. Сохранение без пользователя Calab — отказ.
3. Скачивание: URL только на origin `OFFICE_DOCS_URL` или `OFFICE_DOCS_INTERNAL_URL` (схема, хост
   и порт; без userinfo), запрос идёт на внутренний адрес, редиректы не выполняются, только 200,
   `Content-Type` — файловый (octet-stream, zip, OOXML, ODF, rtf, text/plain, text/csv; html —
   отказ), `Content-Length` и тело ≤ `OFFICE_MAX_SIZE_MB`, затем проверка байтов формата (§2).
4. `DiskStore.SaveVersion`: байты → `files.StoreSystemFile` (sha256, квота, загрузил — автор,
   имя = имя элемента, mime формата) → `disk.SaveVersion` в одной транзакции: блокировка строки
   квоты, затем элемента; **compare-and-swap** `file_id = expect` (`ReplaceDiskItemFile`), прежний
   файл → `disk_file_versions`, обрезка до 50 версий с освобождением квоты, запись «Истории»
   `edit` `{file_id, size, sha256}` до и после, `DISK_ITEM_UPSERT`. Тот же sha256 — версии нет.
   Отказ или «без изменений» удаляет сохранённый файл.
5. `GET /api/disk/items/{id}`, листинг и `GET /api/files/{fileId}` отдают новую версию сразу:
   отложенной конвертации нет, sha256 и размер — из новой строки `files`, `updated_at` элемента
   сдвинут. id, папка и имя прежние — бот по пути находит тот же файл с новым sha256.
6. Статус 6 — сессия продолжается с тем же ключом (`Advance` на новый `file_id`); статус 2 —
   сессия закрывается, следующее открытие получает ключ новой версии.

Прежние версии: скачиваются по `before.file_id` записи «Истории» (`GET /api/files/{id}`, доступ —
через элемент). Восстановление версии — бэклог (docs/12). Чтобы Диск не отставал от открытого
редактора (бот забирает файл раз в час), на Document Server включаем forcesave по таймеру
(`services.CoAuthoring.autoAssembly`, 5 мин); Ctrl+S сохраняет версию сразу.

### 6. Откуда открывается — и выбор для вложений
- **Диск** — «Открыть» и двойной клик по формату из карты; ссылка на файл Диска в чате
  (`DiskLinkChip`) — тот же элемент, тот же редактор.
- **Вложения задач и файлы чата** — `task_attachments.file_id` и `message_attachments.file_id`
  указывают на неизменяемые строки `files` (кэш отдачи `immutable` по id); версий у них нет, а
  одна строка `files` может быть приложена к нескольким сообщениям и задачам. Правка на месте
  означала бы либо переписать байты под тем же id (ломает кэш и sha256 у всех ссылок), либо
  завести версии вложениям во всех слоях. Поэтому выбран безопасный вариант: «Открыть» вложения —
  **редактор в режиме просмотра** (`?file=`, ключ `calab-a-…` на файл, без callback), рядом —
  «Сохранить в Диск» (`POST …/disk/import`: копия новым элементом, дальше обычная правка с
  версиями) и для doc/xls/ppt — «Сохранить как» в выбранную папку Диска
  (`POST /api/workspaces/{id}/office/convert`). Клиент кладёт копию в корень пространства
  вложения и сразу открывает её своей вкладкой. Исходное вложение не меняется никогда.

### 7. Ключ и сессии (Valkey)
`key = "calab-" + hex(HMAC(urlKey, item_id ‖ file_id начала сессии))[:40]` — детерминированный:
двое, открывшие файл одновременно, получают один ключ ещё до записи сессии. Просмотр без правки
(pdf, doc/xls/ppt) — ключ `calab-v-…` на версию, вложение — `calab-a-…` на файл, конвертация —
`calab-c-…` на файл и цель; у них нет сессии и callback.

`office.ValkeySessions` (`redisx`): хэш `office:s:{item}` с TTL `OFFICE_SESSION_TTL` (24 ч),
продлевается каждым открытием и callback; поля `k` (ключ), `f` (файл, на котором стоят правки),
`e:{uid}` (получил конфиг правки: `1`, после `drop` за потерю «Правки» — `0`, «отозван»),
`v:{uid}` (получил конфиг просмотра), `on` (подключённые редакторы по последнему статусу 1:
просмотрщиков Document Server в статусе 1 не сообщает); множество
`office:live`. Все изменения — Lua-скрипты, атомарно на элемент, по compare-and-swap ключа:
- первый открывший создаёт сессию, следующие присоединяются (просмотрщики тоже — один ключ);
- forcesave сдвигает `f`, ключ остаётся; статус 2 или 4 закрывает сессию;
- `f` ≠ текущему файлу элемента (Document Server потерял сессию, или TTL истёк после forcesave) —
  открытие начинает новую сессию на текущем файле. Исключение: `f` — последняя версия элемента
  (текущий файл сохранён forcesave этой же сессии, `Advance` ещё не прошёл) — сессия сдвигается и
  продолжается, иначе открытие в эти миллисекунды отрезало бы её редакторов от сохранений.
- «Редактирует Имя»: `editor_ids` = `on ∩ e:*` (просмотрщики не «редактируют»). Статус 1 с другим
  набором → `disk.Announce` → `DISK_ITEM_UPSERT`; листинг читает сессии одним `DoMulti` на
  страницу и только при `OFFICE_ENABLED`; сбой Valkey оставляет метку пустой, листинг не падает.

### 8. Параллельная запись: политика
- Внутри сессии конфликтов нет: Document Server сливает правки (`fast`), копий не бывает.
- **Загрузка поверх не существует**: Диск никогда не заменяет файл загрузкой — занятое имя
  получает «(2)» (ADR-0094). Бот или API, «перезаливающий» файл, создаёт рядом новый элемент и
  правки в редакторе не теряет. Единственный путь сменить файл элемента — `SaveVersion` с
  compare-and-swap по `file_id` сессии; при расхождении (`ErrConflict`) сохранение отклоняется,
  Document Server оставляет правки у себя и показывает ошибку, следующее открытие стартует с
  текущей версии.
- Поздний статус 2 закрытой сессии или чужой ключ — отказ, поверх новой версии никогда не пишется.
- «Удалить навсегда» файла, который сейчас правят (`editor_ids` не пуст), — 409
  `DISK_FILE_EDITING`. Корзина разрешена: сохранение в элемент в корзине принимается (это тот же
  элемент, восстановление вернёт его с правками). Переименование и перемещение разрешены (id тот
  же); смена расширения на формат без правки останавливает сохранения (§2).
- Удалён навсегда (папка целиком, сборщик корзины) во время сессии — callback получает 404
  элемента: отказ, сессия закрывается, правки остаются только в Document Server (редактор
  предлагает скачать копию).

### 9. Угрозы (для второго ревью)
- **Подделка токена.** Три независимых ключа: конфиг редактора подписан `OFFICE_JWT_SECRET`
  (HS256, `WithValidMethods` — `none`/RS-подмена не проходят); запросы Document Server
  (`file`, `callback`) несут его JWT с `operation` 10.0 (`download` / `callback`, токен одной
  операции не годится для другой); наши URL-токены подписаны ключом, выведенным из `JWT_SECRET`
  API (`HMAC(…, "calab-office-url-v1")`), `aud=office`, `op` в `file|afile|callback`. Утечка
  секрета Document Server не даёт URL-токенов (нельзя прочитать чужой файл без нашего токена),
  утечка URL-токена не даёт права писать (нужен JWT Document Server) и не верифицируется как
  сессионный токен API. Тело callback читается только из подписанных claims.
  Ревью: секрет Document Server общий для обеих сторон, а конфиг (подписан им же) есть в каждом
  браузере — поэтому входящие токены (`file`, `callback`) обязаны иметь `exp` (Document Server
  ставит 5 мин; перехваченный запрос не повторить позже) и не могут иметь форму наших токенов
  (`document`, `editorConfig`, `c`, `outputtype`): конфиг не скачивает файл и не сохраняет. Конфиг
  подписан с `exp` = 12 ч (`ConfigTokenTTL`): хост-страница принимает конфиг от любого родителя,
  и без срока сохранённый конфиг открывал бы сессию после потери доступа, пока жив ключ.
  `OFFICE_JWT_SECRET` ≠ `JWT_SECRET` (проверка конфигурации). Пути `/api/office/file|callback/…`
  в логах запросов — без токена.
- **Повтор ссылки между версиями.** Токен файла закреплён за `file_id` и живёт 5 мин; если элемент
  ушёл на новую версию — 410, старые байты под новой сессией и новые под старой не отдаются.
  Токен callback закреплён за ключом сессии: тело с другим ключом (другого файла или старой
  сессии) — отказ. Сохранение — compare-and-swap по `file_id` сессии.
- **SSRF через URL callback.** URL скачивания принимается только на настроенном origin Document
  Server (точное совпадение схемы и хоста с портом, без userinfo; `docs.x.test.evil.test` и
  `ftp://` не проходят), запрос всегда идёт на `OFFICE_DOCS_INTERNAL_URL`, редиректы не
  выполняются, ответ ограничен по размеру, типу и проверке байтов. Те же правила — у результата
  `/converter`. Других исходящих адресов у пакета нет (`/command`, `/converter` — только
  внутренний origin).
- **Path traversal в именах.** Имя элемента нигде не становится путём: ключ blob —
  `<workspace>/<file id>`, имя файла — только метаданные (`files.SanitizeName`, имя элемента
  уже прошло `cleanName` Диска: без `/`, `\`, управляющих, `.`/`..`). URL Document Server и его
  `filetype` не влияют на имя и место хранения. Тип при сохранении — по текущему имени элемента.
  «Сохранить как» строит имя из имени источника и нового расширения и проходит `cleanName` +
  `freeName` Диска.
- **Понижение прав во время открытой сессии.** (1) При каждом сохранении права автора проверяются
  заново — без «Правки» отказ. (2) При каждом входе соавтора (статус 1 с новым набором) и обходом
  раз в минуту (`RunSweep`) перепроверяются все, кто получил конфиг сессии (`e:`, `v:`) или
  подключён (`on`) — просмотрщики только по меткам, статус 1 их не называет: без `DISK_VIEW` —
  `drop` и метки забываются (после удачного `/command`); с меткой правки без `DISK_WRITE` — `drop`
  и метка становится «отозван»; отозванный снова в `on` (подключился как редактор с сохранённым
  конфигом правки) — `drop` сразу, а законно открытый им просмотр не трогается (`/command`, JWT
  в теле). Окно — до минуты,
  при этом сохранить в это окно уже нельзя (1). Выход из пространства, смена ролей, ACL,
  перемещение в restricted-папку — всё ловится, потому что проверка — по текущей цепочке.
  Известное ограничение: правки, сделанные пониженным пользователем до `drop`, могут попасть в
  версию, которую сохранит другой редактор с правом (Document Server не разделяет правки по
  авторам); окно ограничено минутой.
- **Callback для удалённого файла.** Элемент удалён навсегда → `ErrNotFound` → `error:1`, сессия
  закрывается, сохранённый файл (если успели) удаляется; в другой элемент не пишется никогда
  (элемент — из подписанного токена, а не из тела). Удаление навсегда файла, который правят, —
  409 (§8).
- **Прочее.** Лимиты: `config` 30/мин на пользователя, `convert` 5/мин, запросы Document Server
  (`file`+`callback`) 120/мин на элемент; тело callback ≤ 1 МиБ. Логи — без содержимого (id,
  ключ, статус, размер, sha256). `Cache-Control: no-store` у config и file.

### 10. Развёртывание (k8s, позже; кластер и стенд в этой задаче не трогаем)
- **Один инстанс** `onlyoffice/documentserver:10.0.0` (`Deployment`, `replicas: 1`,
  `strategy: Recreate`: Community не кластеризуется, два пода разделят сессии). Ресурсы для
  заявки до замеров: requests 2 GiB / 1 CPU, limits 4 GiB / 2 CPU; уточнить `run.sh` (docker
  stats в простое и с открытым документом).
- **PVC** на `/var/lib/onlyoffice` (кэш, несохранённые сессии — переживают рестарт) и
  `/var/www/onlyoffice/Data`.
- **JWT**: `JWT_ENABLED=true`, `JWT_SECRET` из Kubernetes Secret — тот же Secret в API как
  `OFFICE_JWT_SECRET`; `JWT_HEADER=Authorization`, `JWT_IN_BODY=true` допустим (API принимает оба).
  `WOPI_ENABLED=false`, `PLUGINS_ENABLED=false`.
- **Сеть.** Браузер → `Ingress` `OFFICE_DOCS_URL` (`docs.<домен>`, TLS) с
  `Content-Security-Policy: frame-ancestors <PUBLIC_APP_URLS> 'self'`. Document Server → API —
  in-cluster `OFFICE_API_URL` (`http://api.<ns>.svc`), поэтому `ALLOW_PRIVATE_IP_ADDRESS=true`
  у Document Server. API → Document Server — `OFFICE_DOCS_INTERNAL_URL` (`http://onlyoffice.<ns>.svc`).
  `NetworkPolicy`: egress Document Server только к API (и DNS); ingress Document Server — от
  ingress-контроллера и от API; маршруты `/api/office/file|callback` снаружи не нужны —
  при желании закрыть их на Ingress API. `ALLOW_PRIVATE_IP_ADDRESS=true` открывает Document Server
  все приватные адреса, поэтому egress-политика обязательна (иначе подписанный запрос `/converter`
  ходит куда угодно в кластере). На публичном Ingress Document Server закрыть сервисы, которые
  нужны только API: `/converter`, `/command`, `/ConvertService.ashx`,
  `/coauthoring/CommandService.ashx`, а также `/example`, `/info`. `OFFICE_JWT_SECRET` — свой
  случайный секрет, не `JWT_SECRET` API (API откажется стартовать).
- Хост-страница `infra/office/calab-editor.html` + `calab-editor.js` и (по желанию) тема
  `infra/office/themes/theme-calab-dark.json` — `ConfigMap`, read-only в `web-apps/apps/calab` и
  `web-apps/apps/common/main/resources/themes`.
- **Конфиг Document Server**: `services.CoAuthoring.autoAssembly` (`enable: true`, `interval: 5m`)
  — версия на Диске не реже раза в 5 минут, пока идёт правка.
- Хостов и секретов в коде нет: `OFFICE_*` в env API (docs/06 «Редактор документов ONLYOFFICE»),
  origin Document Server клиенту отдаёт сервер (`capabilities`, `config`).

### 11. CSP, Electron, скрытое окно
- Веб Calab (Caddy): `frame-src https:` уже разрешает iframe; `script-src` не меняется.
- **Electron** (`main/officeFrame.ts`): guard'ы подфреймов (`windows.ts` `will-frame-navigate` и
  `will-redirect`, `mail/frameGuard.ts`) пускают ровно один origin. Renderer при открытии вида
  вызывает `office.openFrame()` (IPC `office:frame`, только свои страницы) **без адреса**: main сам
  спрашивает `GET /api/office/capabilities` у сервера, с которым залогинен (bearer из main), и
  разрешает origin `docs_url`, если он `https:` (или `http:` на loopback для dev и мока), без
  userinfo; при закрытии вида — `closeFrame()`. Под страницей приложения — только путь хост-страницы,
  ниже — только тот же origin; `blob:`/`data:`, чужие хосты и порты — нет; попапы и главный фрейм
  как раньше. Renderer сверяет свой `docs_url` из конфига с тем, что разрешил main, и при
  расхождении рамку не грузит. Клиентская ветка брала origin из ответа config в renderer — это
  отвергнуто: XSS в renderer мог бы расширить guard на любой https-сайт, а сервер, с которым
  залогинен main, — единственный источник, который renderer не подменит. Поздний ответ на уже
  закрытый вид отбрасывается (счётчик вызовов на окно).
- Скрытое окно (`usePageVisible`): через 5 минут без несохранённых правок редактор снимается
  (iframe, сокет, таймеры); при показе окна вид открывается заново со свежим конфигом. Пока окно
  скрыто — один однократный таймер.
- **Прогрев** (`main/officeWarm.ts`, 29.10.2026): холодное открытие упирается в цепочку requirejs из
  ~200 мелких файлов, а не в большие (на канале 0,35 МБ/с таблица 33 с, документ 27 с; прогрев
  одних тяжёлых файлов дал 25 %). Main скачивает файлы редакторов в HTTP-кэш сессии по умолчанию,
  рамка берёт их оттуда (`fromCache`, проверено на Electron 44): после прогрева 0,6–0,7 с и ни одного
  запроса в сеть. Список — `officeAssets.json` (381 путь трёх редакторов, пишет
  `tools/office-assets.cjs`; перезаписать после обновления Document Server) плюс пути, которые рамка
  реально загрузила (`office-warm.json` в userData, относительно версии). Какие редакторы: открытая
  папка Диска прогревает редакторы своих файлов по `document_type` (IPC `office:warm`, `disk`; папка
  с .xlsx только таблицы, без документов ничего); READY через минуту прогревает редакторы, которые
  человек уже открывал (`ready`). Кто документами не пользуется, ничего не скачивает. Один раз на
  версию `x.y.z-<hash>` из `api.js` и редактор, версия проверяется не чаще раза в 30 минут, 6 запросов
  разом, ничего не исполняется. Цена: 3–5 МБ на редактор один раз на версию.

### 12. Телефон
Community не правит в мобильном вебе: телефон всегда `mode: view`, `type: mobile`.

### 13. Стоимость и лимиты
- Сервер Calab: подпись конфига, отдача файла, приём callback, раз в минуту обход живых сессий
  (одна команда Valkey на сессию). Листинг Диска с включённым редактором — +1 round trip к Valkey
  на страницу.
- Document Server — один под (§10). Клиент — редактор стоит, только пока открыт.
- Лимиты: `OFFICE_MAX_SIZE_MB` (100), ссылка на файл — `OFFICE_FILE_URL_TTL` (5 мин), сессия —
  `OFFICE_SESSION_TTL` (24 ч), версий — 50 на файл, конвертация — 90 с.

### 14. Вид: что совпадает с Calab без коммерческой лицензии
Решение владельца: ONLYOFFICE, логотип остаётся, ощущение — родное (встроенный офис, не модалка).
- **Вид в оболочке, не окно.** Файл показывается в основном слоте (`AppShell` → `OfficeScreen`):
  рейл и заголовок окна на месте, секция, из которой открыли, ждёт под видом. Своей шапки нет: имя,
  состояние сохранения, соавторов и «Открыть расположение файла» (назад, `requestClose`) рисует
  компактная шапка редактора. Для старого формата и вложения над редактором — полоса с «Сохранить
  как .docx» / «Сохранить в Диск»; для `lossy` — строка о возможных потерях.
- **Вкладки.** Открытые файлы — вкладки в общем ряду заголовка с вкладками задач
  (`stores/taskTabs.ts`: `kind: 'task' | 'file'`, `itemId` или `fileId`; ≤ 10, лишняя вытесняет
  самую давнюю; точка — несохранённое, красная — не сохранилось при уходе). Закрытие с
  несохранённым — «Сохранить и закрыть / Не сохранять / Отмена». Двенадцать прежних тестов вкладок
  задач не менялись.
- **Жизненный цикл.** Редактор (iframe) смонтирован только у активной вкладки. Уход из вида — хост
  просит сохранить (`requestSave`), клиент ждёт `state=false` до 8 с и снимает iframe; не
  сохранилось — вид возвращается с предупреждением, правки на месте.
- **Нижний островок остаётся** (в голосовом мессенджере управление звонком не прячем). Ширина —
  `--sidebar-width`, вид оставляет под редактором полосу высотой островка (`--island-height` +
  12 px), как список «Почты»: строка состояния редактора всегда над ним. Клиентская ветка прятала
  островок — отменено.
- **«Редактирует Имя»** из `DiskItem.editor_ids`: в строке списка и подписи плитки Диска, в карточке
  файла (иконка карандаша, `accent`; «и ещё N»).
- Совпадает с Calab: тема по теме приложения и её смена на лету (`changeTheme`, темы оператора из
  `capabilities`); язык и `region`; компактная шапка; без правой панели, «Справки», «Обратной
  связи», плагинов и AI. Тема Calab `theme-calab-dark` — опция оператора (`OFFICE_THEME_DARK`):
  прогон показал, что Community её принимает; по умолчанию остаются `default-dark` /
  `default-light` (их видели на эталонах, светлой темы Calab пока нет — docs/12).
- Не совпадает: логотип ONLYOFFICE и «О программе» (AGPL — остаются), экран загрузки, вкладки и меню
  «Файл» (`layout`), шрифт интерфейса, вид ленты.

### 15. «Создать» в Диске
- В меню «+» Диска (и в шапке Диска на телефоне — тот же `CreateMenu`) после «Папка»: **Документ,
  Таблица, Презентация**, когда редактор включён и правит docx/xlsx/pptx (карта из `capabilities`),
  и только при праве записи в папку (как сам «+»). Контекстного меню на пустом месте у Диска нет.
- Сервер: `office/create.go`. Шаблоны `templates/blank.{docx,xlsx,pptx}` встроены (`embed`), их
  делает `tools/office-fidelity/templates.py` из шаблонов python-docx, openpyxl и python-pptx (их
  сделал Office): docx — A4, поля 2 см; pptx — 16:9 (макеты растянуты), один титульный слайд;
  xlsx — один лист; свойства документа нейтральные, байты воспроизводимы. При создании сервер
  ставит язык текста приложения (`lang`: `ru-RU`, `en-US`, `es-ES`, `zh-CN`) в стили docx и
  во все части pptx и имя листа («Лист1») — так проверка орфографии нового текста совпадает с
  языком пользователя. Файл проходит ту же проверку байтов, что сохранение (§2), затем
  `Store.AddFile` → `files.StoreSystemFile` (sha256, квота) → `disk.AddFile` (`writable`, блокировка
  дерева, `DISK_WRITE` на папке, `freeName` — «Новый документ (2).docx», запись «Истории» `upload`,
  `DISK_ITEM_UPSERT`); при отказе сохранённый файл удаляется. Имя по умолчанию — на языке
  приложения, клиент передаёт своё.
- Клиент: файл добавляется в листинг, выделяется и сразу открывается вкладкой в редакторе.
  Телефон правит только в коммерческой редакции (§12): там файл остаётся в списке с тостом
  «…создан. Править его можно на компьютере».
- Проверено: 12 вариантов (3 формата × 4 языка) читают python-docx, openpyxl и python-pptx,
  проходят `Format.Check`; integration — квота, журнал, « (2)», «Просмотр» на папке, приостановленное
  пространство. Открытие в настоящих Word/PowerPoint и Document Server — при выкатке (docs/12).

### 16. Орфография и формат дат (из прогона)
- Хост-страница шлёт `ready` по `onDocumentReady` (документ показан), а не по `onAppReady`.
- Формат дат и чисел — `editorConfig.region` по языку приложения (прогон: `DD.MM.YYYY` при
  `lang=ru` без региона показывался как `01,07,2026`).
- Проверка орфографии в ONLYOFFICE идёт по языку, записанному в тексте документа (`w:lang`);
  настроить язык проверки конфигом Community не может (`features.spellcheck` — `canBrandingExt`).
  Поэтому: новые файлы «Создать» получают язык приложения (§15); существующие с en-US (так пишет
  python-docx по умолчанию) — язык текста в строке состояния редактора или язык у бота, который
  пишет файл. Переписывать язык чужих документов при открытии не будем: это правка файла без
  действия пользователя и новая версия.

## Что сделано
- Спайк: proto `office.proto`, хост-страница `infra/office/`, `tools/office-fidelity/` (план
  проверки и пробный прогон ниже).
- Сервер (`feat/office-server-98`):
  - миграция `00133`: `disk_file_versions`, `disk_activity.kind = 'edit'`; сирот, квоты,
    использование, удаление навсегда и `files.CanRead` учитывают версии;
  - `disk.SaveVersion` (compare-and-swap, версии, «История», событие), `disk.AddFile`,
    `POST …/disk/import`, `DiskItem.editor_ids`, 409 на удаление правящегося файла;
  - `office`: карта форматов, `DiskStore` (настоящий Диск и `files.CanRead` для вложений),
    `ValkeySessions`, callback с защитой §9, «Сохранить как» через `/converter`, обход прав
    (`/command drop`), лимиты, логи;
  - маршруты: `identityroutes` (`scopeOffice`), `botroutes`, `planinactive`, `_routes.json`.
- Ревью безопасности (`fix/office-review`): перепроверка просмотрщиков и отозванных по меткам
  сессии, срок у входящих токенов Document Server и у конфига (12 ч), отказ токенам формы конфига,
  открытие во время forcesave, `OFFICE_JWT_SECRET ≠ JWT_SECRET`, токены не попадают в логи
  путей; требования к развёртыванию (§10). Остаток — docs/12.
- Интеграция (`feat/office-integration-98`): клиент на настоящем контракте (`capabilities`, config
  `?item=|file=`, оба convert, import), «Создать» (§15), origin для Electron от сервера (§11),
  островок над видом (§14), снятие редактора в скрытом окне, `region`/`goback` в конфиге, темы
  оператора в `capabilities`, мок e2e на том же контракте (`mock-office.test.ts`).
- Тесты: unit (`internal/office`: подписи, режимы, форматы и байты, вложения, боты, повтор
  ссылок, SSRF-варианты, редирект, тип ответа, ключ callback, drop, конвертация, шаблоны и
  «Создать»), integration (Valkey-сессии; `DiskStore` против Postgres; `disk` — версии, квота,
  обрезка, 409, импорт; «Создать»); клиент — `office.test.ts`, `officeFrame.test.ts`, вкладки,
  визуальные `office-*` и `m-office-view`.

## План проверки (нужен Docker и ≥ 8 ГБ свободно; только localhost)
`tools/office-fidelity/run.sh [OUT]`:
1. Поднимает `onlyoffice/documentserver:10.0.0` на `127.0.0.1:18080` с `JWT_ENABLED=true` и
   секретом в `OUT/ds.env` (не в репозитории). Хост-страница монтируется в
   `web-apps/apps/calab`. Снимает `docker stats` в простое.
2. `fixtures.py OUT` (openpyxl, python-docx, python-pptx): `vacations.xlsx` (формулы между
   листами, имена, объединения, форматы дат, ₽ и %, ширины, закрепление, условное форматирование,
   проверка данных, стили), `contract.docx` (заголовки, списки, таблица с повтором шапки и
   объединениями, колонтитулы, поля, альбомная секция), `deck.pptx` (титул, уровни списка, таблица
   с объединённой шапкой, заметки, 16:9), `staff.csv` (UTF-8, `;`, кавычки с `;` и переносом).
3. `bench.mjs`: `/converter` каждого файла в свой формат → `convert-*`; путь «Сохранить как» для
   старых форматов: xlsx → xls → xlsx, docx → doc → docx, pptx → ppt → pptx → `legacy-*`; редактор
   через хост-страницу: время до `ready`, CPU и heap, правка, Ctrl+S → статус 6 → `editor6-*`,
   закрытие → статус 2 → `editor2-*`, базовая линия после закрытия; снимки тем и pptx.
4. `compare.py` по каждой паре (xlsx/docx/pptx/csv; legacy сравнивается с OOXML-оригиналом).
   Критерий: `convert-*` без изменений; `editor*-*` — ровно одна ожидаемая правка; `legacy-*` —
   список потерь старого формата (для подсказки в «Сохранить как»).

`compare.py` проверен на контрольных парах: файл против себя — без изменений; правка ячейки,
абзаца, заголовка слайда, ячейки csv — ровно одно изменение.

## Результаты пробного прогона (28.10.2026)

Стенд: `onlyoffice/documentserver:10.0.0.1` на выделенной машине (4 CPU, 6 ГБ RAM) в Docker,
`JWT_ENABLED=true`. Порты привязаны к 127.0.0.1; доступ шёл через `ssh -L` с RTT ≈ 0,29 с.
Заглушка хранилища и callback — `harness.py` на той же сети Docker. После прогона на машине
ничего не осталось.

**Совместимость.**
- Конвертация `/converter` xlsx, docx и pptx → тот же формат: потерь нет по всем проверкам
  `compare.py`.
- Сохранение из редактора (Ctrl+S → статус 6, закрытие → статус 2):
  - docx и pptx: ровно одна ожидаемая правка. Сохранились стили, нумерованные и маркированные
    списки, таблица с объединением и повтором шапки, колонтитулы (свой у первой страницы), поля,
    альбомная секция; в pptx — макеты, уровни, таблица, диаграмма и заметки.
  - xlsx, сохранилось: формулы (VLOOKUP, INDEX/MATCH между листами, SUM, SUMPRODUCT, COUNTIF,
    TEXT, именованный диапазон), объединения, форматы чисел, ширины колонок, закрепление и
    colorScale. Добавились кэшированные значения формул: `data_only=True` теперь видит
    результаты, раньше было `None`.
  - xlsx, изменилось:
    1. Условное форматирование (cellIs, expression) и проверка данных переписаны в расширение
       `x14` (`extLst`). Excel их видит, **openpyxl — нет**: он их выбрасывает, и бот,
       пересохраняющий файл openpyxl, их сотрёт.
    2. Белый цвет шрифта шапки записан как `indexed="65"` (системный), а не `FFFFFF`.
    3. Имена листов в части формул взяты в кавычки (`'Сотрудники'!A1`) — по смыслу то же самое.
- В редакторе формат даты `DD.MM.YYYY` (как его пишет openpyxl) при `lang=ru` показывается как
  `01,07,2026`. Проверить на настоящем «График отпусков 2026.xlsx»: Excel обычно пишет
  `dd\.mm\.yyyy` или встроенный формат 14.

**Стоимость.**
- Document Server: ≈ 367 МиБ RAM в простое, 370–414 МиБ с открытым документом. CPU в простое
  ≈ 0 %. Образ 3,14 ГБ на диске (0,94 ГБ сжатый).
- Клиент: холодное открытие — ≈ 250 запросов и 11,3–12,6 МБ трафика, из них 4,0–4,5 МБ JS
  (сжатый размер). Время до `onDocumentReady` 11–12 с через туннель с RTT 0,29 с; повторное
  открытие с прогретым кэшем (service worker редактора) — 1,9–2,3 с.
- Открытый документ без действий, 60 с (курсор в документе): CPU страницы 1,3 % (xlsx),
  3,4–4,0 % (docx, pptx); JS heap 39–48 МБ.
- После закрытия: heap 1,6–2,1 МБ (база 0,5), CPU 0,01 %, число фреймов вернулось к 1 (у pptx
  Chromium ещё числит 30 отсоединённых фреймов).

**Сохранение.** Ctrl+S → статус 6 через ≈ 2 с. Закрытие → статус 2 через 6,2–7,1 с, то есть
≈ 10–12 с после последней правки. Всего 80 callback, все с `operation: callback` (10.0).

**Вид.**
- `default-dark` и `default-light` работают; компактная шапка убирает строку заголовка.
- Своя тема `theme-calab-dark` (JSON с цветами токенов Calab) подхватилась без лицензии:
  Document Server сам отдаёт её в `/themes.json`.
- Логотип ONLYOFFICE остаётся.
- Проверка орфографии по умолчанию подчёркивает весь русский текст документа с языком en-US.
- На эталоне владельца редактор встроен в область раздела: рейл и шапка приложения видны.
  Принято так же: вид в оболочке с вкладками (§14), а не окно поверх всего.

## Что остаётся
| Работа | Кто |
|---|---|
| Document Server в кластере: Deployment, PVC, Ingress с frame-ancestors и закрытыми служебными путями, ConfigMap, Secret, NetworkPolicy, autoAssembly — по docs/ops/office-onlyoffice-deploy.md | девопс |
| Electron из `file:` против `frame-ancestors` ingress (может дать пустую рамку) — решить на первой выкатке | девопс + лид |
| Нагрузка: десятки одновременных документов и конвертаций; ресурсы пода по факту | после выкатки |
| Шаблоны «Создать» в настоящих Word/PowerPoint и Document Server; `region` на «График отпусков 2026.xlsx» | после выкатки |
| Светлая тема Calab, восстановление версии, число версий, остальные minor ревью | docs/12 |

## Риски
- **Форматы с потерями** (odt/ods/odp/rtf/csv/txt — `lossy-edit`): сохранение в том же формате
  может потерять то, чего нет в модели ONLYOFFICE; клиент предупреждает (`lossy`), «История» хранит
  прежнюю версию.
- **Совместимость** (прогон выше): для ботов на openpyxl главное — условное форматирование и
  проверки данных уходят в `x14`. x2t конвертирует OOXML во внутренний формат и обратно. Сводные таблицы,
  макросы, внешние ссылки, срезы, спарклайны и редкое условное форматирование могут измениться.
  Пересчёт идёт формулами ONLYOFFICE, а кэшированные значения пишет он же (боты с
  `data_only=True` читают их). Пробный прогон на синтетических файлах потерь, кроме перечисленных,
  не нашёл; настоящие файлы команды («ФОТ», «График отпусков») прогнать `run.sh` до включения.
- **Единственный инстанс** (Community не кластеризуется): падение Document Server — правка
  недоступна, а несохранённые правки живут в его кэше. Нужен PVC и forcesave по таймеру.
- **Лицензия**: AGPL и дополнительные условия, брендинг ONLYOFFICE остаётся. Образ не меняем, своя
  только хост-страница рядом. Если её сочтут модификацией — отдавать её отдельным путём Ingress на
  том же origin.
- **Безопасность**: у Document Server были CVE (в 10.0 исправлены SSRF и перехват сессии в WOPI).
  Держать версию свежей, WOPI выключен, NetworkPolicy. Callback и file проверяют наш токен и JWT
  Document Server, URL скачивания — на origin Document Server.
- **Слабые компьютеры**: редактор — полноценный офис в canvas; он тяжёлый, пока открыт.
  Закрытие освобождает всё (iframe), скрытое окно закрывает редактор.
- **Electron**: без разрешения в guard'ах подфреймов (§11) или при `frame-ancestors` ingress, не
  пускающем страницу из `file:`, в приложении будет пустая рамка — проверить на первой выкатке.
