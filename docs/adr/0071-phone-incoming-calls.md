# ADR-0071. iOS: входящие звонки через общий web call service

Статус: принято для локального опт-ин (2026-10-02). Дополняет ADR-0067/0069/0070.

## Решение

- `CALAB_IOS_INCOMING_CALLS=1` вместе с `CALAB_IOS_PUSH_ENVIRONMENT` включает PushKit/CallKit
  и background modes `audio, voip`. Default build сообщает unsupported. Сервер отдельно требует
  полный APNs config и `PUSH_VOIP_ENABLED=true`; Android, обычный браузер и старый host
  сохраняют прежний путь. Новый SDK, native login, refresh и RTC runtime не добавлены.
- `platform.incomingCalls` использует существующие native-проверенные main-frame/origin/
  WebView/document/sequence границы. Натив хранит только opaque binding/version/expiry/token
  и ограниченные call action references. Auth и media credentials остаются в общем вебе.
- Expo app-delegate subscriber создаёт PushKit receiver до React scene. Каждый требуемый
  VoIP callback сразу вызывает CallKit report, до JS/auth/network; completion вызывается один
  раз. Дубликат использует прежний UUID, stale/malformed/revoked событие отчётно завершается.
  Report tickets не позволяют позднему callback воскресить закрытый звонок. Одновременно
  один звонок, очередь до восьми actions; ring ограничен серверными 45 с, answer/end 10 с.
- Endpoint привязан к текущей web-сессии, установке и отдельному VOIP token. `callsEnabled`
  разрешён только для VOIP; message preferences не подавляют звонки. Доставка и resolve
  заново проверяют DB session, disabled/bot/guest, общий workspace, доступ к DM, DND,
  актуальный Redis RINGING и expiry. Отмена и ответ на другом устройстве закрывают путь.
  В текущей схеме есть только `bot_blocks`; bots не могут звонить. Human-block модели нет,
  новая таблица и мнимая проверка не вводились. Message policy остаётся прежней.
- Push содержит только opaque refs. Общий renderer ждёт существующий auth/gateway READY,
  разрешает reference сервером и использует общий call transition/voice service. Native ring
  подавляет второй web ringtone. Cancel/expiry/logout/session switch отменяют действие;
  поздний успешный accept не подключает RTC и может завершить только собственный CallID
  под прежней актуальной сессией. Logout отзывает native binding перед async web teardown;
  anonymous cold document сначала получает native grant, затем очищает binding.
- CallKit answer выполняется после успешного общего accept. Connected отправляется только
  из существующего voice store; дополнительно ожидается CallKit audio activation, до 15 с.
  Timeout/reset дают bounded end action общему call service. Native AVAudioSession не
  переактивируется, отдельного медиавладельца нет. Reload отзывает document, сохраняет ring,
  но завершает native accepted call; logout дополнительно очищает persisted binding.

## Cold-start и ворота

В установленном Expo 57 `ExpoAppSceneDelegate.scene(_:willConnectTo:options:)` создаёт
React root и единственный Host. Ранняя регистрация subscriber доказана исходниками;
создаст ли iOS scene при cold locked PushKit launch и успеет ли общий web cookie bootstrap
к answer deadline, не доказано. Второй WebView/controller и native auth/media не добавлены.
Если scene отсутствует, очередь безопасно истечёт, но cold answer не состоится. Это отдельный
device spike: отметить scene/Host/READY timestamps без токенов, проверить locked answer.

R05 Swift/WidgetKit и Release скомпилированы без ошибок. Development APS profile и локальная
подпись подтверждены отдельно; R06 Swift/Release скомпилированы в том checkpoint. Реальная доставка, duplicate report,
native frame isolation, CallKit fulfilment/audio activation и двусторонний WKWebView разговор
на блокировке требуют [сценария устройства](../mobile/incoming-calls-testing.md).
Web/server/migration не опубликованы; production authorization отсутствует.

Источники: [Apple PushKit](https://developer.apple.com/documentation/pushkit/responding-to-voip-notifications-from-pushkit),
[Expo subscribers](https://docs.expo.dev/modules/appdelegate-subscribers/),
[Expo scene lifecycle](https://github.com/expo/fyi/blob/main/ios-scene-lifecycle.md).
Deployment contract: [передача push оператору](../mobile/push-deployment.md).

## R07 checkpoint

Native compile в R06 — историческая проверка той версии. После main merge R07
physical-iOS arm64 Release скомпилирована и подписана локально, signature и APS
`development` проверены без input drift. Новая сборка не установлена на телефон;
реальные PushKit/CallKit/locked answer/audio по-прежнему UNVERIFIED.
Registry следует local-account scope общего identity слоя; deployment contract —
[push-deployment](../mobile/push-deployment.md).

## Android (2026-10-29)

DEV-5031, v1 без ConnectionService. Одно FCM-устройство несёт и сообщения, и звонки:
отдельного VoIP-токена у Android нет, а уникальность `(provider, environment, app_id, token)`
не позволяет завести второй endpoint на тот же токен.

- **Сервер.** `calls_enabled` разрешён для VoIP (только звонки, как раньше) и для FCM (вместе
  с `notifications_enabled` или без); APNs alert по-прежнему не звонит. `deviceEnabled`
  отправляет звонок на FCM-endpoint с `calls_enabled`. Политика send/resolve та же: свежая
  сессия, DND, доступ к DM, актуальный RINGING, срок ring. Настройки сообщений звонки не
  подавляют. Комментарий в `push.proto` («только VoIP») устарел — поправить вместе со
  следующей правкой proto (`make gen`).
- **Веб.** Для `provider: 'fcm'` регистрирует FCM с `callsEnabled: true`,
  `notificationsEnabled = mentions || all`, и держит endpoint ради звонков, даже если
  уведомления о сообщениях выключены. Capability `incomingCalls` на Android не объявлена:
  нет native ring/CallKit-аналога, состояние звонка ведёт общий call service.
- **Телефон.** Call push — data high priority (TTL = остаток ring ≤ 45 с) → heads-up
  уведомление в канале «Звонки» с рингтоном (insistent) и кнопками «Отклонить»/«Ответить»,
  `timeoutAfter` = срок ring; один звонок за раз. В foreground не показывается: звонит
  общий веб. Любое касание сохраняет opaque tap с `action: 'answer' | 'decline'`
  (аддитивное поле `HostPushTap`) и открывает приложение. Веб разрешает его через
  `push-resolve`, получает `call` и отдаёт общему call service: `answer` → обычный accept,
  `decline` → decline. Простое касание открывает личку, и веб звонит сам. Возврат приложения в
  foreground и сообщение о пропущенном звонке гасят нативный звонок.
- **Отмена ring.** Когда звонок уходит из RINGING (принят на другом устройстве, отклонён,
  отменён звонящим, пропущен), сервер шлёт best-effort FCM data `kind=call-cancel` с opaque
  `binding`/`eventId` того ring. Получают только FCM-endpoints вызываемого с `calls_enabled`,
  до которых этот ring дошёл на текущей версии endpoint, и только пока ring не истёк
  (`ListPushRingCancels`). Отправка отвязана от публикации события, ≤ 3 с. Без call, room и
  имени. Телефон снимает только уведомление с тегом этого `eventId`, полномочий у сообщения
  нет. APNs/VoIP его не несут (CallKit — свой путь). Потерянная отмена — звонок гаснет по
  сроку ring (≤ 45 с).
- **v2 (не сделано).** ConnectionService/self-managed telecom, full-screen intent поверх
  блокировки (`USE_FULL_SCREEN_INTENT` и декларация Play), ответ без разблокировки. Сейчас
  ответ требует разблокировки и загрузки веба.

Ворота: `TestPushIncomingCallOverFCMEndpoint` (регистрация FCM с calls, ring при выключенных
сообщениях, resolve, `call-cancel` только вызываемому и только до истечения ring), unit-тест
APNs (отмена туда не уходит), unit-тесты веба. Доставка, отмена и ответ на устройстве
**не проверены**.
