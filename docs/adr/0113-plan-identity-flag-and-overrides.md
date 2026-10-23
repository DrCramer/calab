# ADR-0113: Корпоративный вход как параметр тарифа; параметры Team / Business для пространства (2026-10-20)

**Статус: принято.** Дополняет [ADR-0024](0024-plans-and-limits.md) (тарифы) и §5 [ADR-0054](0054-workspace-identity.md)
(SSO / AD / OAuth-провайдер только в Business). Задача CBF-44.

## Контекст
Владелец, 20.10: OAuth2 не появился у активного тарифа, смена тарифа в админке туда-сюда не помогла; админ
должен задавать параметры тарифов, в том числе Team и Business. Причина: право на SSO, синхронизацию каталога
и OAuth-провайдер вычислялось только как `workspace_plans.plan = 'enterprise'` — в SQL шлюза
(`business_eligible`), в `identitypolicy.SQLLoader.LoadGrant`, в `oauthprovider` (согласие) и `sso`, а grant'ы
`cloud_business` писались с `enabled = plan == "enterprise"`. Индивидуальный тариф (и Team) получить это не
мог никак, а возврат на него после Business снова выключал grant'ы. Параметра в лимитах не было, в форме
админки — тоже. Отдельно форма индивидуального тарифа не содержала `cameras_per_room`, `stickers`, `boards`,
`caldav_disabled`, `musician_disabled`: каждое сохранение записывало 0 / false — снимало эти лимиты.

## Решение
1. **Флаг `corporate_identity`** (`PlanLimits.corporate_identity = 40`, `plans.Limits.CorporateIdentity`):
   SSO, каталог и OAuth-провайдер — одним переключателем. Положительный, в отличие от прочих флагов
   (`*_disabled`): §5 ADR-0054 требует, чтобы ноль ничего не разрешал — клиент, не знающий поля, и старая
   запись индивидуального тарифа без ключа значат «нет». Business — `true`, Free / Team / `CustomBase` — `false`.
2. **Одно правило в двух местах:** `identitypolicy.PlanGrantsIdentity(plan, limits, valid_until)` и
   `business_eligible` в `GetIdentityGateState(s)`: булев ключ `corporate_identity` сохранённых лимитов, если
   он есть, иначе только `enterprise`; истёкший срок — нет. Положительный grant `cloud_business` по-прежнему
   обязателен; правка тарифа (и `SyncBillingIdentity` для биллинга) пишет его по тому же правилу.
3. **Встроенное значение типа тарифа не меняется через env:** `PLAN_*_LIMITS` с другим `corporate_identity`
   — ошибка старта (шлюз читает правило из SQL, не из конфигурации).
4. **Параметры Team / Business для пространства:** `AdminSetPlanRequest.limits` теперь допустим и с TEAM /
   ENTERPRISE (с FREE — 422). Хранится только отличие от значений тарифа (`plans.Overrides` →
   `workspace_plans.limits`, тот же столбец, без миграции); остальное следует `PLAN_*_LIMITS`. Без `limits` —
   значения тарифа, переопределения сбрасываются. Биллинг пишет `limits = NULL` для team / enterprise, так что
   платная смена тарифа переопределений не наследует.
5. **Форма админки** содержит все поля `PlanLimits` (тест на клиенте проверяет каждое поле схемы); для Team /
   Business она редактирует текущий тариф пространства, после переключения на другой — его значения до сохранения.

## Последствия
- Новое поле лимитов теперь должно попасть и в форму (её общий компонент) — иначе сохранение Team / Business
  с переопределениями запишет 0.
- Тарифный экран участника и PlanLock читают `corporate_identity` (`planHasIdentity`).
