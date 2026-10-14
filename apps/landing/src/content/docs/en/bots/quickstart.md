---
title: "Quickstart"
description: "Create a bot, get a token and send the first message in five minutes."
placeholder: true
---

A Calab bot is a workspace member with its own token. It posts to rooms, works with boards and the calendar through the same REST API as the app, and receives events over the [gateway](gateway).

> [!NOTE]
> This is a placeholder page of the docs platform (DOC1). The real text comes with DOC2.

## Create a bot

1. Open **Workspace settings → Bots** and click “Create bot”.
2. Copy the token — it is shown once.
3. Give the bot a role with the rights it needs.

> [!TIP]
> Keep the token in the `CALAB_BOT_TOKEN` environment variable, not in code.

| What | Where | Example |
| --- | --- | --- |
| Base URL | your server | `https://app.calab.io` |
| Token | bot settings | `bot_7f3c…` |
| Room ID | room menu → “Copy ID” | `01J9Z…` |

## First request

Check the token by reading the bot profile:

```bash
curl -H "Authorization: Bot $CALAB_BOT_TOKEN" https://app.calab.io/api/bots/me
```

Response:

```json
{ "id": "01J9Z8", "name": "Opsa", "commands": [] }
```

### Send a message

```bash tab="curl"
curl -X POST https://app.calab.io/api/rooms/$ROOM/messages \
  -H "Authorization: Bot $CALAB_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content": "Hello from a bot"}'
```

```ts tab="JavaScript"
import { Client } from '@calaba/bot-sdk';

const bot = new Client({ token: process.env.CALAB_BOT_TOKEN! });
await bot.rooms.send(roomId, { content: 'Hello from a bot' });
```

```python tab="Python"
import os, requests

requests.post(
    f"https://app.calab.io/api/rooms/{room}/messages",
    headers={"Authorization": f"Bot {os.environ['CALAB_BOT_TOKEN']}"},
    json={"content": "Hello from a bot"},
)
```

> [!WARNING]
> A bot sees only the rooms its roles give access to. `403 BOT_NOT_ALLOWED` means the route is for people only.

## How it works

<svg viewBox="0 0 560 120" width="560" height="120" role="img" aria-label="The bot sends a request to the API">
  <defs><marker id="arrow-qs" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>
  <rect x="8" y="30" width="140" height="56" rx="12" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="78" y="63" text-anchor="middle" font-size="14" fill="currentColor">Your bot</text>
  <line x1="150" y1="58" x2="408" y2="58" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrow-qs)"/>
  <text x="279" y="48" text-anchor="middle" font-size="12" fill="currentColor">HTTPS + bot token</text>
  <rect x="412" y="30" width="140" height="56" rx="12" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="482" y="63" text-anchor="middle" font-size="14" fill="currentColor">Calab API</text>
</svg>

<details>
<summary>Why not OAuth?</summary>

A bot token is for server integrations. If your service acts on behalf of a person, use [OAuth 2](../oauth/flow#how-the-flow-works).

</details>

## Message routes

<!-- routes:group=messages decision=allow -->

> [!DANGER]
> Never publish the token: it lets anyone post as the bot in all of its rooms.

## Next steps

- Real-time events — [Gateway](gateway#connecting).
- Task events — [webhooks](webhooks.md).
- Every route — [reference](../reference/routes).
