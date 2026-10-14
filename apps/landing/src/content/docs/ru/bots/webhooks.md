---
title: "Вебхуки"
description: "Как Calab доставляет события на ваш HTTPS-адрес и как проверить подпись."
placeholder: true
---

Вебхук — альтернатива gateway для серверов без постоянного соединения.

## Подпись

```go
mac := hmac.New(sha256.New, secret)
mac.Write(body)
ok := hmac.Equal(mac.Sum(nil), sig)
```

> [!NOTE]
> Подпись вебхука доски — в заголовке с префиксом `v1=`.

## Маршруты

<!-- routes:group=bots decision=allow -->
