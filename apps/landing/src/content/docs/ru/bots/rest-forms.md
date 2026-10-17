---
title: Формы досок
description: Формы приёма заявок на доске — создание, изменение, предпросмотр и отправка ответов от имени бота.
order: 8
---

Форма доски — анкета, ответы на которую становятся задачами. Бот может управлять формами доски (создавать, менять, удалять, проверять определение на предпросмотре) и отправлять ответы в форму по её коду — например, переносить заявки из внешней системы.

| Действие | Право |
|---|---|
| список, создание, изменение, удаление форм, предпросмотр | `VIEW_BOARD` и `MANAGE_BOARD` |
| открыть и отправить форму | доступ по настройкам формы (для закрытой формы — бот в списке `allowedUserIds`) |

Лимиты форм на доску: Team — 5, Business — 20, собственная установка — по настройке (0 — без ограничений). Выключенная на доске функция «Формы» — `409 FEATURE_DISABLED`.

## Маршруты

<!-- routes:forms -->
| Метод | Путь | Что делает |
|---|---|---|
| `GET` | `/api/boards/{id}/forms` | Формы доски → `{forms}` |
| `POST` | `/api/boards/{id}/forms` | Создать форму `{definition}` → `{form}` |
| `PUT` | `/api/boards/{id}/forms/{fid}` | Заменить определение `{definition, revision}` → `{form}` |
| `DELETE` | `/api/boards/{id}/forms/{fid}` | Удалить форму: ссылка перестаёт работать, задачи остаются |
| `POST` | `/api/boards/{id}/forms/preview` | Проверить несохранённое определение и ответы без создания задачи |
| `GET` | `/api/forms/{code}` | Форма глазами отвечающего → `{title, description, fields, revision}` |
| `POST` | `/api/forms/{code}/submissions` | Отправить ответы → `{receiptId}` |
| `POST` | `/api/forms/{code}/files` | Загрузить файл поля `FILE` (`?field=<id>`, multipart `file`) → `{uploadId, name, size, mime}` |
<!-- /routes -->

Анонимные `GET /api/public/forms/{code}`, `POST /api/public/forms/{code}/files` и `POST /api/public/forms/{code}/submissions` — публичный доступ по ссылке для людей без аккаунта; при обязательном SSO пространства он закрыт. Боты пользуются авторизованными `/api/forms/{code}…`.

## Определение формы

`BoardFormDefinition`:

| Поле | Описание |
|---|---|
| `title`, `description` | Заголовок и описание формы |
| `fields` | Поля: `id` (UUID), `type`, `label`, `hint`, `placeholder`, `required`, `options` |
| `titleFieldId` | Необязательное поле с одним значением — источник названия задачи (не `CHECKBOX` и не `MULTISELECT`) |
| `statusId`, `priority` | Статус и приоритет создаваемых задач |
| `isPrivate`, `allowedUserIds` | Закрытая форма и кто может её отправлять |
| `routes` | Маршруты по ответу: `{fieldId, option, boardId, statusId}` — первое совпавшее правило создаёт задачу на другой доске того же пространства (пустой `statusId` — статус по умолчанию той доски); иначе — доска формы |
| `showMembers` | Анонимные посетители видят поля `PEOPLE` и имена участников (по умолчанию нет) |

Типы полей (с префиксом `BOARD_FORM_FIELD_TYPE_` в JSON): `TEXT`, `PARAGRAPH`, `EMAIL`, `NUMBER`, `DATE`, `SELECT`, `CHECKBOX`, `PHONE`, `URL`, `MULTISELECT`, `FILE`, `PEOPLE`.

Дополнительно у поля:

| Поле | Описание |
|---|---|
| `multiple` | `FILE` и `PEOPLE`: несколько значений (людей — до 10) |
| `maxFiles`, `maxFileMb`, `accept` | `FILE`: до 20 файлов (сумма по всем полям ≤ 20), до 100 МБ каждый, категории `image`, `pdf`, `document`, `video`, `audio`, `archive` (пусто — любые) |
| `roleId` | `PEOPLE`: только участники с этой ролью |
| `target` | Куда ответ попадает в задаче (`BOARD_FORM_FIELD_TARGET_…`): `PRIORITY` (`SELECT`), `DUE_DATE` (`DATE`), `LABELS` (`SELECT`/`MULTISELECT`), `ASSIGNEES`, `APPROVERS`, `WATCHERS` (`PEOPLE`); каждая цель, кроме меток, — у одного поля |
| `optionPriorities`, `optionLabels` | Вариант → приоритет / id метки доски формы |

Настройки маршрутов, `target`, карты вариантов и `roleId` видит только управляющий: `GET /api/forms/{code}` их не отдаёт. Владелец маршрутов — последний, кто сохранил форму: он должен иметь `VIEW_BOARD` и `CREATE_TASKS` на целевых досках (проверяется при сохранении и при отправке).

> [!WARNING]
> Право управлять формой не обходит список доступа закрытой формы: чтобы бот мог её отправлять, явно добавьте id бота в `allowedUserIds`.

```sh tab="curl"
curl -s -X POST $CALAB/api/boards/$BOARD/forms \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
  "definition": {
    "title": "Заявка в поддержку",
    "fields": [
      {"id": "6f1c2b0e-8a4d-4e3b-9c1a-2d3e4f5a6b7c", "type": "BOARD_FORM_FIELD_TYPE_TEXT", "label": "Тема", "required": true},
      {"id": "7a2d3c1f-9b5e-4f4c-8d2b-3e4f5a6b7c8d", "type": "BOARD_FORM_FIELD_TYPE_EMAIL", "label": "Почта для ответа"},
      {"id": "8b3e4d20-ac6f-4a5d-9e3c-4f5a6b7c8d9e", "type": "BOARD_FORM_FIELD_TYPE_MULTISELECT", "label": "Отдел", "options": ["Дизайн", "Поддержка", "Продажи"]}
    ],
    "titleFieldId": "6f1c2b0e-8a4d-4e3b-9c1a-2d3e4f5a6b7c",
    "priority": "TASK_PRIORITY_MEDIUM"
  }}'
```

```js tab="JavaScript"
import { BoardFormFieldType } from '@calaba/protocol';

const { form } = await bot.forms.create(boardId, {
  definition: {
    title: 'Заявка в поддержку',
    fields: [
      { id: crypto.randomUUID(), type: BoardFormFieldType.TEXT, label: 'Тема', required: true },
    ],
  },
});
```

Ответ — `{form: {id, boardId, url, definition, revision, createdBy, createdAt, updatedAt}}`. `PUT` заменяет `definition` целиком и требует текущий `revision`.

## Отправить ответы

`POST /api/forms/{code}/submissions {revision, nonce, answers: [{fieldId, value}]}` → `{receiptId}` без подробностей о задаче.

- Значения — строки; чекбокс — `"true"` или `"false"`.
- `MULTISELECT` — `{fieldId, values: ["Дизайн", "Поддержка"]}` без `value`; `FILE` — `values` из `uploadId`; `PEOPLE` — `values` из id участников (первый исполнитель — ведущий); остальные типы — только `value`.
- Файл сначала загружается `POST /api/forms/{code}/files?field=<id>` (SDK `bot.forms.upload`); тип определяется по содержимому, HTML/SVG/скрипты не принимаются. Неотправленный за час файл удаляется. После отправки файл — вложение задачи и доступен только тем, кто видит задачу.
- Ответ с `target` заполняет поле задачи (приоритет, срок, метки, исполнители, согласующие, наблюдатели); все ответы всё равно попадают в описание.
- Неизвестные и повторяющиеся варианты отклоняются; порядок выбранных вариантов не влияет на идемпотентность.
- `PHONE` сохраняет форматирование и ведущие нули: 7–15 цифр, до 64 символов, допустимы ведущий `+`, пробелы, скобки, точки и дефисы.
- `URL` — абсолютный HTTP/HTTPS без учётных данных и пробелов; сервер ссылку не открывает.
- Название задачи берётся из ответа на `titleFieldId`: схлопывается в одну строку и обрезается до 200 символов, полное значение остаётся в описании задачи. Поле не задано или без ответа — название формы.

```sh tab="curl"
curl -s -X POST $CALAB/api/forms/$CODE/submissions \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
  "revision": 3,
  "nonce": "3b0f6c1e-2a4d-4b8e-9f10-6a7b8c9d0e1f",
  "answers": [
    {"fieldId": "6f1c2b0e-8a4d-4e3b-9c1a-2d3e4f5a6b7c", "value": "Не приходит письмо"},
    {"fieldId": "8b3e4d20-ac6f-4a5d-9e3c-4f5a6b7c8d9e", "values": ["Поддержка"]}
  ]}'
# → {"receiptId": "0192c9…", "preview": false}
```

```js tab="JavaScript"
const view = await bot.forms.get(code);              // {title, description, fields, revision}
const { receiptId } = await bot.forms.submit(code, {
  revision: view.revision,
  nonce: crypto.randomUUID(),
  answers: [{ fieldId: view.fields[0].id, value: 'Не приходит письмо' }],
});
```

```python tab="Python"
import uuid
view = requests.get(f"{CALAB}/api/forms/{code}", headers=H).json()
r = requests.post(f"{CALAB}/api/forms/{code}/submissions", headers=H, json={
    "revision": view["revision"], "nonce": str(uuid.uuid4()),
    "answers": [{"fieldId": view["fields"][0]["id"], "value": "Не приходит письмо"}],
})
```

> [!TIP]
> При повторе сохраняйте тот же UUID в `nonce`: одинаковые отправки создают одну задачу. Тот же `nonce` с другим содержимым — ошибка `NONCE_CONFLICT`.

## Предпросмотр

`POST /api/boards/{id}/forms/preview {definition, answers}` (SDK `bot.forms.preview`) проверяет несохранённое определение и ответы, не создавая задач, номеров и доставок вебхука. Ответ — `{receiptId: "", preview: true}` или ошибка валидации.

## Ошибки

Все ошибки ниже — `409 CONFLICT` с указанным `reason`; ошибки полей — `422 VALIDATION` с `field`.

| `reason` | Что значит |
|---|---|
| `FORM_CHANGED` | Форма изменилась — перечитайте `revision` |
| `NONCE_CONFLICT` | `nonce` уже использован для другого содержимого |
| `FORM_TARGET_UNAVAILABLE` | Статус, в который форма создаёт задачи, удалён, или владелец маршрутов больше не может создавать задачи на целевой доске |
| `PLAN_LIMIT` | Лимит форм на доску по тарифу |
| `FEATURE_DISABLED` | Функция «Формы» выключена на доске |

Типы запросов и ответов — в `@calaba/protocol`. Общий формат ошибок — в разделе [Ошибки и лимиты](./errors-limits).
