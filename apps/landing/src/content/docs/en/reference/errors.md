---
title: "Error codes"
description: "Error format of the API and the codes a bot can receive."
placeholder: true
---

This page exists only in English — the Russian docs show it with a notice.

## Format

```json
{ "error": { "code": "FORBIDDEN", "reason": "BOT_NOT_ALLOWED" } }
```

## Codes

| HTTP | Code | When |
| --- | --- | --- |
| 401 | `UNAUTHORIZED` | missing or invalid token |
| 403 | `FORBIDDEN` | the role has no right |
| 429 | `RATE_LIMITED` | too many requests |
