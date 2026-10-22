# 03 — Сеть и доступность

Цель: соединение устанавливается из любой сети — корпоративный файрвол, VPN «только 443», симметричный NAT, мобильный хотспот.

## Порты на сервере (один публичный IPv4)

| Порт | Протокол | Кто | Назначение |
|---|---|---|---|
| 443 | TCP | Caddy | HTTPS API, WSS gateway, WSS signal LiveKit, **TURN/TLS** (SNI `turn.*` → layer4, TLS терминирует Caddy) |
| 443 | UDP | LiveKit | **TURN/UDP** (поэтому HTTP/3 в Caddy выключен) |
| 80 | TCP | Caddy | ACME + redirect |
| 7881 | TCP | LiveKit | ICE over TCP (нельзя за прокси/LB — сырой) |
| 7882 | UDP | LiveKit | UDP mux — весь медиа-трафик в одном порту (вместо диапазона 50000–60000) |
| 7880 | TCP | LiveKit | signal — только localhost, за Caddy |
| 20000–29999 | UDP | LiveKit | relay-сокеты TURN (исходящие только на SFU :7882, см. «TURN relay»); снаружи не открыты |
| 5349 | TCP | LiveKit | TURN (TLS снят в Caddy, `external_tls`), за Caddy layer4. LiveKit не умеет привязать TURN к loopback — слушает `*:5349`, снаружи закрыт файрволом (порта нет в accept-списке) |
| 3000 | TCP | API | только 127.0.0.1, за Caddy |
| 5432 / 6379 | TCP | Postgres / Redis | только 127.0.0.1 |
| 5060 | UDP + TCP | LiveKit SIP | **только при `SIP_ENABLED=1`** (ADR-0046): SIP-сигнализация с провайдерами телефонии |
| 10000–10200 | UDP | LiveKit SIP | **только при `SIP_ENABLED=1`**: RTP телефонных звонков (ниже TURN relay 20000–29999 и эфемерных 32768–60999) |

Порядок попыток клиента (libwebrtc + LiveKit SDK, `allow_tcp_fallback: true`):
1. Прямой UDP host/srflx (STUN) → 7882
2. ICE/TCP → 7881
3. TURN/UDP → 443
4. TURN/TLS → 443 (работает почти везде: выглядит как HTTPS)

## Домены и TLS

Нужны **три DNS-имени** на один IP, все с валидными сертификатами (Let's Encrypt через Caddy):
- `<domain>` (само имя, без префикса) — API, gateway, файлы, веб-клиент
- `rtc.<domain>` — LiveKit signal
- `turn.<domain>` — TURN/TLS. Отдельное имя обязательно: по нему Caddy layer4 отличает TURN от HTTPS.

TLS для TURN терминирует Caddy (layer4-маршрут `tls` → `proxy 127.0.0.1:5349`), LiveKit работает с `turn.external_tls: true`, `tls_port: 5349` и без собственных сертификатов (ADR-0010). Сайт `turn.<domain>` в Caddyfile (`respond 404`) нужен только чтобы Caddy выпускал и продлевал его сертификат.

### Несколько доменов

- `DOMAIN` — основной, `DOMAIN_ALT` — запасной алиас (опционально), `DOMAIN_LEGACY` — временный третий набор имён на время переезда (опционально). Для каждого непустого — те же три имени `<домен>`/`rtc.<домен>`/`turn.<домен>`, свои сертификаты; Caddy обслуживает все наборы одинаково (`infra/docker/caddy/entrypoint.sh` собирает списки хостов, Caddyfile использует `{$APP_HOSTS}`/`{$RTC_HOSTS}`/`{$TURN_HOSTS}`, layer4 матчит SNI любого `turn.*` из списка).
- **Ограничение:** LiveKit анонсирует клиентам TURN только по основному домену (`turn.domain: turn.${DOMAIN}` — одно значение). Клиент, пришедший через `rtc.<DOMAIN_ALT>`, всё равно получит `turns:turn.<DOMAIN>:443`. Запасной домен — алиас для `app`/`rtc`; `turn.<DOMAIN_ALT>` работает (сертификат, SNI-маршрут), но клиентам не раздаётся. Если основной домен заблокируют — поменять местами `DOMAIN` и `DOMAIN_ALT` и передеплоить (LiveKit перезапустится с новым `turn.domain`). TURN/UDP раздаётся по IP (`turn:141.105.69.177:443?transport=udp`) и от домена не зависит.
- `PUBLIC_APP_URL` — основной (`https://${DOMAIN}`), `PUBLIC_APP_URL_ALT` — `https://${DOMAIN_ALT}` (пусто, если алиаса нет).

Стенд: `DOMAIN=colaba.gptunnel.ai`, `DOMAIN_ALT=colaba.gptunnel.ru`, DNS — Cloudflare, A-записи `colaba`, `rtc.colaba`, `turn.colaba` → 141.105.69.177 в обеих зонах, **строго DNS-only (proxied=false)**: прокси Cloudflare не пропускает WebRTC/TURN (UDP, TCP 7881, сырой TLS на 443 к `turn.*`) и режет WebSocket-сессии по таймауту. Имена `*.141-105-69-177.sslip.io` (первые пробы) сняты 2026-09-25 и не обслуживаются.

## Caddy: SNI-роутинг на 443

Своя сборка Caddy (`infra/docker/caddy/Dockerfile`: `xcaddy` + `mholt/caddy-l4`, версия запинена), конфиг — `infra/docker/caddy/Caddyfile`. layer4 подключён как `listener_wrapper` HTTP-сервера `:443` (стоит до `tls`, поэтому видит сырой ClientHello):

```
:443 (TCP)
  SNI turn.<domain>   → layer4: tls (терминация в Caddy) → proxy 127.0.0.1:5349 (LiveKit TURN, external_tls)
  иначе               → обычный HTTPS-сервер Caddy (h1, h2; h3 выключен):
       <domain>       → /api/*, /gateway, /healthz, /readyz → reverse_proxy 127.0.0.1:3000 (API); остальное — веб-статика
       rtc.<domain>   → reverse_proxy 127.0.0.1:7880 (LiveKit signal)
       turn.<domain>  → respond 404 (только ради сертификата)
```

Альтернатива — nginx `stream { ssl_preread }`; функционально то же.

## Файрвол на тестовом стенде (141.105.69.177)

Фактически: `iptables` (бэкенд nf_tables), цепочка INPUT с финальным `DROP all` («всё, что не разрешено — drop»). Правила сохранены в `/etc/iptables/rules.v4`, при загрузке их восстанавливает `iptables-restore.service` (свой unit, не `netfilter-persistent`; сервис `nftables` выключен). Для Calaba правила **только добавляем** (никогда не `flush`, не трогаем существующие правила GPU-сервисов). Уже добавлены и сохранены (2026-09-25) перед финальным DROP:

```
-A INPUT -p tcp --dport 80   -j ACCEPT
-A INPUT -p tcp --dport 443  -j ACCEPT
-A INPUT -p tcp --dport 7881 -j ACCEPT
-A INPUT -p udp --dport 443  -j ACCEPT
-A INPUT -p udp --dport 7882 -j ACCEPT
```

- Проверка: `iptables -L INPUT -n -v --line-numbers` — наши ACCEPT стоят выше `DROP all`. Правило для lo (`ACCEPT all -- lo`) уже есть, поэтому 7880/5349/6789/3000 на loopback работают, а снаружи (5349, 6789) — дропаются.
- Добавлять точечно (`iptables -I INPUT <n> …` перед DROP) и сохранять `iptables-save > /etc/iptables/rules.v4` (предварительно сделать `.bak`). Не делать `iptables -F`, не перезапускать Docker.
- Проверять доступность портов снаружи — с машины **без** VPN/TUN-прокси: TUN-режим VPN (например, на маке разработчика) сам принимает любой TCP connect, и `nc -zv` «успешен» даже для закрытого порта.
- Caddy, LiveKit и API — в host network → трафик идёт через цепочку INPUT, правила обязательны. API слушает только 127.0.0.1 и ходит в Postgres/Redis через 127.0.0.1 (их порты опубликованы Docker'ом на loopback), поэтому отдельное правило для `docker0` не нужно.
- Цепочку forward управляет Docker — её не трогаем.
- Существующие `ffmpeg` слушают UDP 9001/9002/54241/33621 — не пересекается.

### TURN relay: только к нашему SFU

Встроенный TURN LiveKit нужен только чтобы довезти медиа клиента до нашего же SFU (`141.105.69.177:7882/udp`). Гости получают TURN-креды по дизайну (ADR-0016), поэтому relay не должен уметь ходить куда-то ещё.

- Проверено 2026-09-26 (pion-клиент с кредами из JoinResponse): LiveKit сам отказывает (`CreatePermission 403`) для `127.0.0.1`, `10/8`, `192.168/16`, `169.254/16`, но **пропускал** relay на собственный публичный IP сервера на любой порт (пакет дошёл до тестового слушателя на `141.105.69.177:45998` — путь к сервисам соседа на этом хосте), в CGNAT `100.64/10` и в интернет (открытый UDP-relay с нашего IP).
- Решение: relay-сокеты LiveKit — в диапазоне `20000–29999` (`turn.relay_range_start/end`), **ниже** эфемерного диапазона ядра (`32768–60999`), чтобы фильтр по исходному порту не задел чужие процессы. В `OUTPUT`:
  ```
  -A OUTPUT -p udp --sport 20000:29999 -m addrtype ! --dst-type LOCAL -j DROP   # никуда, кроме адресов хоста
  -A OUTPUT -p udp --sport 20000:29999 ! --dport 7882 -j DROP                   # и там — только на SFU
  ```
  (в `/etc/iptables/rules.v4`, комментарий `calaba-turn-relay`). После: пакет на `141.105.69.177:45998` не доходит, `100.64.0.1`/`1.1.1.1` дропаются (счётчики правил), relay-check TLS и UDP — PASS, медиа идёт.
- Проверка: `iptables -L OUTPUT -n -v | grep calaba-turn` — счётчики растут только при попытках злоупотребления, не при обычных звонках.

### SIP (телефония, ADR-0046) — только при `SIP_ENABLED=1`

Контейнер `livekit/sip` в host network: сигнализация `5060` UDP+TCP, медиа `10000–10200/udp`. Звонки только исходящие, но провайдер шлёт в диалог запросы (BYE, re-INVITE) и RTP с других адресов/портов, так что conntrack «established» не хватает — порты открываются явно. Незнакомые INVITE сервис молча отбрасывает (`hide_inbound_port`). Перед DROP:

```
-A INPUT -p udp --dport 5060 -m comment --comment calaba-sip -j ACCEPT
-A INPUT -p tcp --dport 5060 -m comment --comment calaba-sip -j ACCEPT
-A INPUT -p udp --dport 10000:10200 -m comment --comment calaba-sip-rtp -j ACCEPT
```

- Пересечений нет: чужая GPU-задача — 8000–8400, 9100, 9400; её `ffmpeg` — UDP 9001/9002/33621/54241; TURN relay — 20000–29999; эфемерные — 32768–60999. Перед включением стенд-агент проверяет `ss -lunp | grep -E ':(5060|100[0-9]{2}|10[12][0-9]{2})\b'` и `ss -ltnp | grep :5060` — пусто.
- Выключить телефонию: `SIP_ENABLED=0` + `deploy.sh` (контейнер удаляется) и убрать три правила (`iptables -D …`), сохранить `rules.v4`.
- Провайдер, у которого белый список IP, — дать ему публичный IP хоста; `use_external_ip` узнаёт его через STUN.
- Входящие (ADR-0117, `SIP_INBOUND=1`): `hide_inbound_port: false` — на каждый INVITE ответ (4xx для чужих адресов и номеров); принимается только номер пространства от адресов его провайдера (`allowed_addresses` входящего транка: A/AAAA хоста на момент сохранения + `SIP_INBOUND_ALLOWED_ADDRESSES` + адреса из настроек, диапазоны не шире /16). Новых портов нет: воркер `calab-ivr` ходит к LiveKit по loopback, к API — исходящим WebSocket.

### IPv6

Глобального IPv6 на хосте нет, но на случай его появления `ip6tables` INPUT — политика DROP с теми же разрешениями (lo, established, ICMPv6, DHCPv6 от fe80::/10, tcp 22/80/443/7881, udp 443/7882): `/etc/iptables/rules.v6`, восстанавливается `ip6tables-restore.service` (свой unit, рядом с `iptables-restore.service`).

## MTU и VPN

- libwebrtc держит RTP ≤ ~1200 байт — запас под VPN/TURN-обёртки. SFU не перепаковывает.
- Типичная проблема на туннелях — фрагментация DTLS-handshake. Симптом: ICE connected, а медиа нет. Лечится переходом на TCP/TURN-TLS (SDK делает сам), в диагностике показываем «соединение через relay».
- Кернел на сервере: поднять `net.core.rmem_max/wmem_max` до 4–8 MB (в compose через `sysctls` нельзя для host-net → ставим на хосте). На стенде уже 16 MB.

## Ограничения из-за цензуры (РФ)

- TSPU режет TLS к диапазонам Cloudflare/Hetzner/DO/OVH после ~16 KB → там не хостимся. Текущий IP не из этих диапазонов.
- ECH/ESNI дропаются — не включаем.
- Мобильные «белые списки» в отдельных регионах — обойти невозможно, честно показываем статус.
- TURN/TLS терминирует Caddy (`external_tls`), поэтому TLS-фингерпринт TURN совпадает с HTTPS-сайтами того же сервера — отдельно от веба его по TLS не отличить.

## Диагностика в клиенте

- Кнопка «Проверить соединение»: STUN-тест, TCP 7881, TURN allocate; показывает, какой путь используется (`candidate-pair` из getStats: host/srflx/relay + protocol).
- Индикатор качества (RTT/loss) рядом с комнатой.

## Kubernetes (позже)

- LiveKit: официальный Helm-чарт, `hostNetwork: true`, один pod на ноду, Redis обязателен; TURN-passthrough через Traefik `IngressRouteTCP HostSNI(turn.*)` или ingress-nginx ssl-passthrough.
- Всё остальное — обычные Deployment + Ingress + cert-manager; Postgres — CloudNativePG.
- Не подходит: private/serverless кластеры (лишний NAT ломает WebRTC).
