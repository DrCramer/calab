---
title: "Tokens and lifetimes"
description: "Access and refresh tokens, their lifetimes, rotation and revocation."
placeholder: true
---

## Lifetimes

| Token | Lifetime |
| --- | --- |
| code | 1 minute |
| access | 5 minutes |
| refresh | 8 hours, 30 minutes idle |

## Revocation

```bash
curl -X POST https://app.calab.io/oidc/workspaces/acme/revoke -d token=$REFRESH
```
