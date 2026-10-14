---
title: "Что можно интегрировать"
description: "Боты и API, вход через Calab по OAuth 2, SSO и каталог — обзор возможностей."
placeholder: true
---

Calab открыт для интеграций тремя способами.

## Боты и API

Серверные интеграции с токеном бота — см. [быстрый старт](../bots/quickstart).

## OAuth 2 / OIDC

Вход «через Calab» в ваш сервис — [поток Authorization Code](../oauth/flow).

## SSO и каталог

Вход сотрудников через корпоративный IdP — [подключение OIDC](../sso/oidc).

```http
GET /api/version HTTP/1.1
Host: app.calab.io
```
