---
title: Token and permissions
description: The bot token format, how to send, reissue and revoke it; how bot permissions work and what is always closed to bots.
order: 3
---

## The token

A bot token looks like this:

```text
calab_bot_0192a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b_Xq3v9aT2LmN8pR4sW7yZ1bC5dF0gH6jK3nQ9uV2xE8w
└──┬────┘ └───────────────┬──────────────────┘ └────────────────┬────────────────────┘
  prefix           bot id (UUID)                    secret: 43 base64url characters
```

- The `calab_bot_` prefix lets secret scanners (GitHub and others) recognise a leaked token.
- The server stores only a `sha256` hash of the secret, so a token can never be shown again. The bot's profile shows the first 6 characters of the secret (`tokenPrefix`) to tell tokens apart.
- A token doesn't expire on its own: it works until it is reissued or revoked.

### How to send it

| Where | How |
|---|---|
| REST | the `Authorization: Bearer <token>` header |
| Gateway | the `token` field of the `IDENTIFY` (or `RESUME`) frame |

**Never** put the token in a URL, a query string or a webhook body — only in those two places.

```sh
curl -s https://app.example.com/api/me -H "Authorization: Bearer $TOKEN"
```

### Reissue and revoke

In “Workspace settings → Bots”, the bot's owner or a member with `MANAGE_BOTS` in the bot's home workspace can:

- **“Reissue token”** — get a new token; the old one stops working immediately.
- **“Revoke token”** — switch the bot off without a new token, until it is reissued.
- **“Delete bot”** — the bot leaves every workspace and call; its messages stay.

What happens to the old token:

| Channel | Result |
|---|---|
| REST | `401 UNAUTHENTICATED` |
| Gateway | the socket closes with `4010`; don't reconnect |
| Voice | the bot leaves its calls |

> [!NOTE]
> Token checks are cached for at most 30 seconds, but reissuing or revoking drops the cache — the old token stops working at once.

### One token, one process

A token is one gateway “device”. A second process with the same token pushes the first one out: the first socket closes with `4000` and the reason `replaced by a new session`. Run one process per token. To scale processing, use a [webhook](./webhooks) with idempotent handling by `id`, or several bots.

## Permissions

A bot is a workspace member, and its permissions are computed exactly like a person's: workspace roles plus overrides on a room or a board.

- **By default** a bot gets the member role: it sees open rooms, writes in them and joins voice.
- **Need more?** Give the bot a role with the permissions it needs: `MANAGE_MESSAGES` for moderation, `CREATE_TASKS` / `EDIT_TASKS` for boards, `INVITE_MEMBERS` for invites, and so on.
- **Need less?** Deny the permission with a room override.
- **Restricted rooms and boards** are visible to a bot only through an override on the object itself — personal or by role, as for people. Otherwise the answer is `404`.

Every REST chapter lists the permissions its routes need. Without one the server answers `403 FORBIDDEN`, and `message` names the missing permission.

### A bot with admin permissions is an admin

A bot token whose roles grant `MANAGE_*`, `INVITE_*` or `VIEW_JOURNALS` acts as an admin with those permissions. Keep such a token like an admin's password and reissue it at the slightest doubt. The role editor warns when admin permissions go to a role that bots hold. The server logs every administrative bot action — the route, the response status, the bot and its owner.

### A bot in several workspaces

A bot is created in one — **home** — workspace, where it is managed (token, deletion). An admin of another workspace can add the bot: “Workspace settings → Bots → Add a bot from another workspace” by its `username`, or through the `/bots/<username>` link. In each workspace the bot's permissions are its own, by its roles there.

### Blocking by people

A person can “Block bot” — the bot then can't write to them in direct messages: new DMs and messages in an existing DM get `403 BOT_BLOCKED`.

## Always closed to bots

The rule is simple: **if the bot has the permission, it does what a person with that permission does.** Board automations, the board's Git and webhook, board access, web apps, camera backgrounds, GPTunneL, telephony, the call journal, achievements, meeting comments, recordings — all by the bits of the bot's roles; without the bit it is the ordinary `403` naming the missing permission.

Only what a role cannot decide stays closed. These routes answer a bot with `403 FORBIDDEN` and `reason: "BOT_NOT_ALLOWED"` — whatever its roles:

| Area | What exactly | Why |
|---|---|---|
| Account | sessions, password, email and its verification, push devices, choosing a username | a bot has no password, email or sessions — only its token |
| Identity | SSO and the directory, OAuth clients, the OAuth provider (`/oidc/…`), OAuth grants, reauthentication | a person's login and the workspace's login policy |
| Billing | balance, payments, payment methods, auto top-up, plans; superadmin | money is the workspace owner's decision |
| Workspace ownership | creating, deleting, discovering and joining; taking over a room, board, file or page | a bot owns no workspace and does not join by itself — people add it |
| Accounts without consent | looking an account up by address, adding an account directly | invite links and email invites are open |
| Bot management | creating, adding and deleting bots, tokens, avatars, “on behalf of the owner”, the journal of contacts shared with bots, bot blocks | a bot does not manage bots or their oversight — no self-escalation |
| A person's decision | the approval vote (only [on behalf of the owner](#on-behalf-of-the-owner)), pressing buttons, sharing a contact, answering an invitation (RSVP) | the intent of a particular person |
| Personal | notes, status, notification and chat-list settings, birthdays, “today”, CalDAV and external calendars | a person's private data and settings |
| Voice and guests | one-to-one calls, room guest links, waiting for admission | a bot does not ring people or hand out anonymous entry to calls |
| Helpers | link previews, the HEIC converter | client helpers, not the API: a token must not become a free proxy |

The exact route list is in [Bot routes](../reference/routes).

## On behalf of the owner

The bot's owner can let the bot act **on their behalf**: Workspace settings → Bots (or the bot's profile) → “Act on my behalf”. Only the bot's owner turns it on and off — admins with `MANAGE_BOTS` only see the line “Acts on behalf of its owner”.

A request on behalf of the owner is an ordinary REST request with the bot token and the header `Calab-On-Behalf: owner`:

```sh
# The owner's vote in a task approval — a bot never votes for itself
curl -s -X POST https://app.example.com/api/tasks/$TASK/approval \
  -H "Authorization: Bearer $TOKEN" \
  -H "Calab-On-Behalf: owner" \
  -H "Content-Type: application/json" \
  -d '{"decision":"TASK_APPROVAL_DECISION_APPROVE"}'
```

- Such a request runs **with the owner's permissions** and is stored as the owner's action: the message author, the vote, the task journal entry are the owner, marked with `viaBotId` (the app shows “Name (via bot X)”).
- Everything open to bots is available, **plus** the vote in task approvals. Closed even on behalf of the owner: the owner's account (profile, password, email, sessions), bot management (this switch included), billing, workspace deletion, superadmin, voice and calls, recording, and the administration opened to bots in 3.9 (automations, the board's Git, webhook and access, integrations, backgrounds, achievements, meeting comments, recordings) — a bot does that only as itself.
- The bot must be a member of the workspace and the owner an active member there. Workspaces with enforced SSO refuse on-behalf requests.
- The gateway and the webhook do not change: the bot receives events with its own permissions.
- On-behalf requests count against the bot's limits.
- If anyone but the owner (a `MANAGE_BOTS` admin) reissues the token, the switch turns off.
- Without the header the bot acts as itself. With the header but without permission the request is refused, never silently downgraded:

| Answer | `reason` | Why |
|---|---|---|
| `400` | `ON_BEHALF_INVALID` | the header value is not `owner` |
| `401` | — | the token was revoked or reissued |
| `403` | `ON_BEHALF_DISABLED` | the owner has not turned on “Act on my behalf” |
| `403` | `ON_BEHALF_OWNER_INACTIVE` | the owner's account is disabled, or the owner is no longer a member of the bot's home workspace |
| `403` | `ON_BEHALF_OWNER_NOT_MEMBER` | the owner is not a member of this workspace (left, removed, banned) |
| `403` | `ON_BEHALF_IDENTITY_POLICY` | the workspace requires the person's own sign-in (SSO) |
| `403` | `ON_BEHALF_ROUTE` | the route is closed on behalf of the owner too |

> [!WARNING]
> The token of such a bot acts as its owner. Keep it like a password; if it may have leaked, reissue the token or turn the switch off — it takes effect at once.

In the SDK: `bot.asOwner()` — the same bot with the header on every call (`await bot.asOwner().tasks.vote(taskId, 'approve')`), or `{ onBehalfOfOwner: true }` on a single `bot.rest.request`.

## Good practice

- Keep the token in a secret store (Vault, CI environment variables), not in code.
- Give the bot the least it needs: a dedicated role for the job beats an admin role.
- Use a separate bot for admin jobs, so a token with broad permissions lives in fewer processes.
- Keep the webhook secret apart from the token and verify the signature of every delivery — see [Webhooks](./webhooks).
