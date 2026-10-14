---
title: "Gateway"
description: "The WebSocket for real-time events: IDENTIFY, READY, RESUME and close codes."
placeholder: true
---

The gateway is a WebSocket at `wss://<host>/gateway?v=1` that delivers events to the bot.

## Connecting

```js
const ws = new WebSocket('wss://app.calab.io/gateway?v=1');
ws.onopen = () => ws.send(JSON.stringify({ op: 'IDENTIFY', token }));
```

### Close codes

| Code | Meaning |
| --- | --- |
| 4001 | Invalid token |
| 4008 | Rate limited |

## Events

<!-- routes:group=system -->

Back to the [quickstart](quickstart#first-request).
