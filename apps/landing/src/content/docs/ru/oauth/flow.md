---
title: "Authorization Code + PKCE"
description: "Пошаговый поток входа через Calab для стороннего сервиса."
placeholder: true
---

## Как устроен поток

<svg viewBox="0 0 560 120" width="560" height="120" role="img" aria-label="Сервис перенаправляет пользователя в Calab">
  <defs><marker id="arrow-oauth" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>
  <rect x="8" y="30" width="140" height="56" rx="12" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="78" y="63" text-anchor="middle" font-size="14" fill="currentColor">Ваш сервис</text>
  <line x1="150" y1="58" x2="408" y2="58" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrow-oauth)"/>
  <text x="279" y="48" text-anchor="middle" font-size="12" fill="currentColor">authorize → code → token</text>
  <rect x="412" y="30" width="140" height="56" rx="12" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="482" y="63" text-anchor="middle" font-size="14" fill="currentColor">Calab</text>
</svg>

### Обмен кода

```bash
curl -X POST https://app.calab.io/oidc/workspaces/acme/token \
  -d grant_type=authorization_code -d code=$CODE -d code_verifier=$VERIFIER
```

> [!TIP]
> Код живёт одну минуту — обменивайте его сразу. Сроки токенов — в разделе [токены](tokens#сроки).

<!-- routes:group=oauth -->
