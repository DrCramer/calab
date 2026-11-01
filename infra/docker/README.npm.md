# Self-hosted Calab behind Nginx Proxy Manager

This compose profile is for a host where Nginx Proxy Manager already owns TCP 80/443.
Calab does not bind those ports. Create the external Docker network configured by
`NPM_NETWORK` (default `evilcorp`) and connect NPM to it.

## Values to configure

Copy `.env.example` to `.env` and set:

- `NPM_NETWORK`: Docker network shared with NPM.
- `NPM_HOST_IP`: host-side gateway address on that bridge; find it with
  `docker network inspect "$NPM_NETWORK"` and verify the address is assigned on the host.
- `NPM_LETSENCRYPT_DIR`: host directory containing NPM's certificate store.
- `TURN_CERT_DIR`: matching certificate directory as mounted inside LiveKit. It must contain
  `fullchain.pem` and `privkey.pem` for `turn.<DOMAIN>`.
- `RTC_INTERFACE`: host NIC LiveKit should use for ICE candidates (for example, `eno1`).
- `DOMAIN=cramerstation.ru`, `APP_HOST=calab.cramerstation.ru`.

Keep the existing secret values in `.env`. Do not copy `.env` into Git.

## NPM Proxy Hosts

| Hostname | Scheme | Forward target | Port | WebSockets |
|---|---|---|---:|---|
| `calab.cramerstation.ru` | http | `calaba-web` | 8080 | on |
| `rtc.cramerstation.ru` | http | host-side gateway (`NPM_HOST_IP`) | 17880 | on |

Enable SSL and Force SSL for both hosts. Use HTTP/2. `Block Common Exploits` can stay on.
The RTC host is a signaling WebSocket endpoint; it is not a media proxy.

The bundled Caddy disables raw access logs and filters request URLs and headers from
proxy error logs, matching upstream. Apply equivalent logging protection in NPM:
identity and calendar-subscription URLs can contain credentials in their paths or queries.

Do not create an ordinary NPM Proxy Host for `turn.cramerstation.ru`. LiveKit TURN is
served directly by the host: DNS for `turn.cramerstation.ru` must point to the public IP,
and the router forwards UDP 443 and TCP 5349 directly to the server. LiveKit terminates
TURN/TLS using NPM's mounted certificate files. Renewing that certificate requires restarting
LiveKit so it reloads the files.

## Public ports

Forward/open these ports to the Calab host:

- TCP 7881: LiveKit ICE/TCP fallback.
- UDP 7882: LiveKit WebRTC media mux.
- UDP 443: LiveKit TURN/UDP.
- TCP 5349: LiveKit TURN/TLS.
- UDP 20000–29999: LiveKit TURN relay range configured in `livekit.yaml.tpl`.
- TCP 80/443 remain owned by NPM; Calab does not publish them.

Do not expose TCP 13000 or 17880, UDP/TCP 15432 or 16379, or database/cache container
ports. The API binds to the NPM bridge gateway for reverse-proxy access; database and
Valkey ports are loopback-only.

## Deploy and inspect

```bash
cd infra/docker
./deploy.sh
docker compose ps
docker compose logs --tail=200
```

`deploy.sh` renders the LiveKit config, then starts the stack. For a web-only rebuild,
build the web client, run `infra/docker/sync.sh` to publish `apps/desktop/dist-web` into
the host's `web/` directory, then restart `caddy`.

Backups are written to `backups/` under the repository deployment directory by default;
set `BACKUP_DIR` to move them outside that tree. PostgreSQL is dumped with `pg_dump` and
the `files_data` named volume is archived separately. NPM TLS certificates are owned and
backed up with the NPM installation.
