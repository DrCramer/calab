---
title: "Webhooks"
description: "How Calab delivers events to your HTTPS endpoint and how to verify the signature."
placeholder: true
---

A webhook is an alternative to the gateway for servers without a persistent connection.

## Signature

```go
mac := hmac.New(sha256.New, secret)
mac.Write(body)
ok := hmac.Equal(mac.Sum(nil), sig)
```

> [!NOTE]
> The board webhook signature is in a header with the `v1=` prefix.

## Routes

<!-- routes:group=bots decision=allow -->
