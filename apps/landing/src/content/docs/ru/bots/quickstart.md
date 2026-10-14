---
title: "Быстрый старт"
description: "Создайте бота, получите токен и отправьте первое сообщение за пять минут."
placeholder: true
---

Бот в Calab — участник пространства со своим токеном. Он пишет в комнаты, работает с досками и календарём через тот же REST API, что и приложение, и получает события через [gateway](gateway).

> [!NOTE]
> Это временная страница платформы документации (DOC1). Настоящий текст появится в задаче DOC2.

## Создайте бота

1. Откройте **Настройки пространства → Боты** и нажмите «Создать бота».
2. Скопируйте токен — он показывается один раз.
3. Выдайте боту роль с нужными правами.

> [!TIP]
> Храните токен в переменной окружения `CALAB_BOT_TOKEN`, а не в коде.

| Что | Где взять | Пример |
| --- | --- | --- |
| Базовый URL | адрес вашего сервера | `https://app.calab.io` |
| Токен | настройки бота | `bot_7f3c…` |
| ID комнаты | меню комнаты → «Копировать ID» | `01J9Z…` |

## Первый запрос

Проверьте токен запросом профиля бота:

```bash
curl -H "Authorization: Bot $CALAB_BOT_TOKEN" https://app.calab.io/api/bots/me
```

Ответ:

```json
{ "id": "01J9Z8", "name": "Опса", "commands": [] }
```

### Отправьте сообщение

```bash tab="curl"
curl -X POST https://app.calab.io/api/rooms/$ROOM/messages \
  -H "Authorization: Bot $CALAB_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content": "Привет из бота"}'
```

```ts tab="JavaScript"
import { Client } from '@calaba/bot-sdk';

const bot = new Client({ token: process.env.CALAB_BOT_TOKEN! });
await bot.rooms.send(roomId, { content: 'Привет из бота' });
```

```python tab="Python"
import os, requests

requests.post(
    f"https://app.calab.io/api/rooms/{room}/messages",
    headers={"Authorization": f"Bot {os.environ['CALAB_BOT_TOKEN']}"},
    json={"content": "Привет из бота"},
)
```

> [!WARNING]
> Бот видит только комнаты, к которым у его ролей есть доступ. Ответ `403 BOT_NOT_ALLOWED` значит, что маршрут только для людей.

## Как это устроено

<svg viewBox="0 0 560 120" width="560" height="120" role="img" aria-label="Бот отправляет запрос в API">
  <defs><marker id="arrow-qs" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>
  <rect x="8" y="30" width="140" height="56" rx="12" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="78" y="63" text-anchor="middle" font-size="14" fill="currentColor">Ваш бот</text>
  <line x1="150" y1="58" x2="408" y2="58" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrow-qs)"/>
  <text x="279" y="48" text-anchor="middle" font-size="12" fill="currentColor">HTTPS + Bot-токен</text>
  <rect x="412" y="30" width="140" height="56" rx="12" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="482" y="63" text-anchor="middle" font-size="14" fill="currentColor">Calab API</text>
</svg>

<details>
<summary>Почему не OAuth?</summary>

Токен бота — для серверных интеграций. Если сервису нужно действовать от имени человека, используйте [OAuth 2](../oauth/flow#как-устроен-поток).

</details>

## Маршруты сообщений

<!-- routes:group=messages decision=allow -->

> [!DANGER]
> Не публикуйте токен: с ним можно писать от имени бота во всех его комнатах.

## Что дальше

- События в реальном времени — [Gateway](gateway#подключение).
- Сообщения о задачах — [вебхуки](webhooks.md).
- Полный список маршрутов — [справочник](../reference/routes).
