---
title: "Токены и сроки"
description: "Access и refresh-токены, их сроки, ротация и отзыв."
placeholder: true
---

## Сроки

| Токен | Срок |
| --- | --- |
| code | 1 минута |
| access | 5 минут |
| refresh | 8 часов, 30 минут простоя |

## Отзыв

```bash
curl -X POST https://app.calab.io/oidc/workspaces/acme/revoke -d token=$REFRESH
```
