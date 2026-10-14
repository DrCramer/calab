---
title: "Gateway"
description: "WebSocket для событий в реальном времени: IDENTIFY, READY, RESUME и коды закрытия."
placeholder: true
---

Gateway — WebSocket `wss://<host>/gateway?v=1`, через который бот получает события.

## Подключение

```js
const ws = new WebSocket('wss://app.calab.io/gateway?v=1');
ws.onopen = () => ws.send(JSON.stringify({ op: 'IDENTIFY', token }));
```

### Коды закрытия

| Код | Значение |
| --- | --- |
| 4001 | Неверный токен |
| 4008 | Слишком много запросов |

## События

<!-- routes:group=system -->

Вернуться к [быстрому старту](quickstart#первый-запрос).
