# Телефон: релиз в стор

Как сегодня собирается и публикуется `apps/mobile` (ADR-0067, ADR-0142). Отдельно от `release.yml`/`images.yml` десктопа/веба (docs/06 «Релиз с 3.0»): ручной процесс, свой runbook. Статус фич и устройство — [shared-web-status.md](shared-web-status.md).

## Идентификаторы

- **iOS**: bundle `dev.calab.mobile`, Apple team `3KGZ3829US`, приложение App Store Connect `6820671861`.
- **Android**: package `dev.calab.mobile`, Play App Signing; upload-ключ хранит мобильный лид вне git (не в этом репозитории; пути и имя файла здесь не называем).

## Env для сборки

`cd apps/mobile`, затем `.env` (копия `.env.example`, не коммитится):

```
EXPO_PUBLIC_CALAB_URL=https://app.calab.io
EXPO_PUBLIC_CALAB_LINK_HOSTS=app.calab.io
CALAB_IOS_BUNDLE_ID=dev.calab.mobile
CALAB_ANDROID_APPLICATION_ID=dev.calab.mobile
CALAB_IOS_PUSH_ENVIRONMENT=production
CALAB_IOS_INCOMING_CALLS=1          # как в сборке 22, не дефолт платформы
CALAB_IOS_NATIVE_CALL_AUDIO=1       # как в сборке 22, не дефолт платформы
CALAB_APP_VERSION=X.Y.Z
CALAB_IOS_BUILD_NUMBER=<растёт на каждую загрузку>
CALAB_ANDROID_VERSION_CODE=<обязательно указать явно — см. ниже>
```

`CALAB_APP_VERSION` — три числа (`parseReleaseIdentity`, `src/config.js`); сверить номер сборки с действующей историей дистрибуции перед загрузкой — повтор отклоняется магазином. `CALAB_ANDROID_VERSION_CODE` по умолчанию берёт `CALAB_IOS_BUILD_NUMBER`, но счётчики сторов независимы (на момент написания следующий Android `versionCode` — `3`, не связан с текущим iOS build number) — указывать явно, не доверять дефолту.

## iOS

```
npx expo prebuild --platform ios --clean
xcodebuild -workspace ios/Calab.xcworkspace -scheme Calab -configuration Release \
  -destination 'generic/platform=iOS' -archivePath <out>/Calab.xcarchive archive \
  -allowProvisioningUpdates DEVELOPMENT_TEAM=3KGZ3829US CODE_SIGN_STYLE=Automatic
xcodebuild -exportArchive -archivePath <out>/Calab.xcarchive -exportPath <out>/export \
  -exportOptionsPlist <out>/ExportOptions.plist
```

`-allowProvisioningUpdates` требует Apple ID, залогиненный в Xcode (Settings → Accounts), или `-authenticationKeyPath/-authenticationKeyID/-authenticationKeyIssuerID` (App Store Connect API key) на CI/headless-машине без интерактивного логина.

`<out>/ExportOptions.plist` не в репозитории — живёт в каталоге сборки рядом с архивом (скопировать шаблон у мобильного лида один раз). Для осмотра перед отправкой `destination` в нём — `export` (`method: app-store-connect`, `signingStyle: automatic`, `uploadSymbols: true`): проверять нужно именно распакованную `.ipa`, а не `.xcarchive` — он может остаться development-подписанным:

```
unzip -o <out>/export/Calab.ipa -d <out>/export/unzipped
codesign -dvv <out>/export/unzipped/Payload/Calab.app                    # Apple Distribution, команда 3KGZ3829US
codesign -d --entitlements - <out>/export/unzipped/Payload/Calab.app     # aps-environment, com.apple.developer.associated-domains
```

`CFBundleVersion` в `Info.plist` должен совпадать с `CALAB_IOS_BUILD_NUMBER`. Проверки прошли — отправить тот же архив: `xcodebuild -exportArchive` повторно с `destination: upload` в `ExportOptions.plist` (повторный экспорт того же `.xcarchive`, не пересборка), либо загрузить уже полученную `.ipa` через Transporter.

Export-compliance (`ios.config.usesNonExemptEncryption: false`, `app.config.ts`) объявлено заранее: приложение использует только HTTPS и WebRTC DTLS-SRTP (стандартное шифрование), поэтому App Store Connect на каждой сборке больше не спрашивает про экспортный контроль.

## Android

```
npx expo prebuild --platform android --clean
read -s -p "Upload keystore password: " CALAB_UPLOAD_STORE_PASSWORD; echo
read -s -p "Upload key password: " CALAB_UPLOAD_KEY_PASSWORD; echo
export CALAB_UPLOAD_STORE_PASSWORD CALAB_UPLOAD_KEY_PASSWORD
cd android && ./gradlew bundleRelease \
  -Pandroid.injected.signing.store.file=<upload-keystore> \
  -Pandroid.injected.signing.store.password="$CALAB_UPLOAD_STORE_PASSWORD" \
  -Pandroid.injected.signing.key.alias=calab-upload \
  -Pandroid.injected.signing.key.password="$CALAB_UPLOAD_KEY_PASSWORD"
keytool -printcert -jarfile app/build/outputs/bundle/release/app-release.aab
```

`versionCode` обязан расти на каждую загрузку — Play отклоняет повтор. Play App Signing переподписывает aab своим ключом для раздачи; `keytool` здесь проверяет upload-подпись самого aab, не итоговый `assetlinks.json`-отпечаток (тот — ключ Play, docs/06 «Universal links / App Links»).

## Магазины

- **TestFlight**: загрузка тем же архивом (`destination: upload` или Transporter выше); раздать группе внутреннего/внешнего тестирования.
- **Play**: канал «Внутреннее тестирование», release notes с тегами `<en-US>`/`<ru-RU>`. Вопрос об экспортном шифровании в Play Console задаётся один раз при создании приложения (не на каждый релиз) — US export-декларация в этом runbook повторно не отвечается.

## Проверка ссылок (ADR-0142)

После публикации `.well-known` (docs/06 «Universal links / App Links») — GET с проверкой тела, не `HEAD`/код ответа: CDN и Google могут ответить `200` с пустым или устаревшим телом.

```
curl -s https://app.calab.io/.well-known/apple-app-site-association | grep -c '3KGZ3829US.dev.calab.mobile'
curl -s https://app.calab.io/.well-known/assetlinks.json | grep -c 'dev.calab.mobile'
curl -s https://app-site-association.cdn-apple.com/a/v1/app.calab.io | grep -c '3KGZ3829US.dev.calab.mobile'
curl -s 'https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://app.calab.io&relation=delegate_permission/common.handle_all_urls' | grep -c 'dev.calab.mobile'
```

Каждая — `1` и более. Без этого ссылка из Telegram/почты откроет браузер, а не приложение.

## Уборка

```
rm -rf ios android   # из apps/mobile; по ~1 ГБ каждый, prebuild --clean создаёт заново
```

## Известные ограничения

На обеих платформах: пространства с обязательным SSO не поддерживаются (нет native callback adapter для внешнего IdP в WebView); экранная трансляция/системный звук и PiP не реализованы.

Только на Android: push ещё нет (FCM не настроен, только APNs для iOS); навигационная политика WebView полагается на JS-ответ (не fail-closed к нативной проверке origin, 250 мс таймаут пропускает загрузку); ссылка, открытая при уже запущенном приложении, перезагружает WebView (нет host-канала ADR-0069, в отличие от iOS — там тёплая ссылка открывается на месте).

Подробности и статус по датам — [shared-web-status.md](shared-web-status.md).
