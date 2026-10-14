---
title: "Каталог LDAPS"
description: "Синхронизация пользователей и групп из Active Directory по LDAPS."
placeholder: true
---

Эта страница есть только по-русски — английская версия покажет её с плашкой.

## Синхронизация

Каталог читается раз в 5 минут; если он недоступен дольше часа, доступ закрывается.

```bash
ldapsearch -H ldaps://dc.example.com -b "dc=example,dc=com" "(objectClass=user)"
```
