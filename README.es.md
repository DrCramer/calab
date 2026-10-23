<p align="center"><a href="README.md">English</a> · <a href="README.ru.md">Русский</a> · <b>Español</b> · <a href="README.zh-CN.md">简体中文</a></p>

<p align="center">
  <img src="apps/desktop/build/icons/web/icon-192.png" width="96" alt="Calab">
</p>

<h1 align="center">Calab</h1>

<p align="center">
  Todo el equipo en una ventana: salas de voz, chat, reuniones y tareas en tu propio servidor.<br>
  <sub>Mensajería de equipo autoalojada con la voz primero. macOS · Windows · Linux · web.</sub>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: BUSL-1.1" src="https://img.shields.io/badge/license-BUSL--1.1-blue"></a>
  <a href="https://github.com/itrcz/calab/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/itrcz/calab/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Electron" src="https://img.shields.io/badge/desktop-Electron-47848F">
  <img alt="Go" src="https://img.shields.io/badge/server-Go-00ADD8">
  <img alt="LiveKit" src="https://img.shields.io/badge/media-LiveKit-ff6b35">
  <a href="https://calab.io/es/"><img alt="calab.io" src="https://img.shields.io/badge/site-calab.io-0A84FF"></a>
</p>

<p align="center">
  <img src="apps/landing/public/screens/es/voice.webp" width="880" alt="Calab durante una reunión de planificación: una diapositiva compartida, las cámaras de los participantes y las salas del espacio">
</p>

---

## Qué es

Calab es una mensajería para equipos donde lo primero es la **voz**. Entras en una sala y oyes a tus compañeros al momento; al lado tienes un chat como Telegram, un calendario con reuniones y tableros de tareas al estilo de Linear. Todo funciona en tu propio servidor: un `docker compose`, con PostgreSQL y LiveKit dentro, sin servicios externos ni suscripciones.

Está pensado para equipos de hasta 20–30 personas en voz a la vez y hasta 3 pantallas compartidas por sala. El cliente es ligero: 0,05 % de CPU sin llamada y ≈ 7 % en voz en un MacBook Air M4.

## Funciones

### Funciones de un vistazo

| Área | En una línea |
|---|---|
| Voz y vídeo | Salas de voz con sonido limpio y push-to-talk, compartir pantalla, cámara, galería de la reunión, grabación con transcripción, soundboard, anotaciones sobre la pantalla compartida, modo músico |
| Llamadas telefónicas (SIP) | Marca un número fijo o móvil desde una sala de voz con tu propio proveedor SIP |
| Salas temporales e invitados | Una sala por una hora o un día con enlace para invitados; sin registro, y el invitado se elimina tras 48 horas sin actividad |
| Chat | Respuestas, reacciones, stickers, mensajes de voz, reenvío, archivos con vista previa, fijados, confirmaciones de lectura, menciones |
| Mensajes directos y notas | Chats y llamadas uno a uno con archivo; hasta 20 estantes de notas privadas |
| Calendario | Reuniones con invitaciones por correo (`.ics`), búsqueda de hora para varias personas, sincronización CalDAV |
| Tableros de tareas | Kanban, lista y línea de tiempo; tarea a pantalla completa, aprobaciones, listas de control, hitos, automatizaciones, formularios de entrada, webhooks de tablero, historial completo |
| Correo | Cliente de correo IMAP/SMTP integrado en la aplicación de escritorio |
| Wiki | Páginas del equipo con edición conjunta en tiempo real, enlaces entre páginas, versiones y páginas públicas |
| Disco | Carpetas y archivos del espacio con acceso por carpeta, enlaces públicos, papelera e indicador de espacio |
| Búsqueda | `⌘K` encuentra mensajes, tareas, comentarios, eventos, archivos, notas y transcripciones |
| Notificaciones | Niveles por sala y disparadores de tareas por evento; los avisos de tareas se pueden reenviar a tu propio bot (p. ej. a Telegram) |
| Bots y API de integración | Bots con token, SDK de TypeScript, gateway WebSocket, webhooks firmados, voz, botones; [documentación para desarrolladores](https://calab.io/en/docs/) |
| Identidad y roles | SSO OIDC, sincronización del directorio LDAP/AD, «Iniciar sesión con Calab» (OAuth 2); roles por función, salas y tableros privados |
| Miembros | Perfiles con `@alias`, logros y cumpleaños; los antiguos miembros se conservan en el historial |
| Pagos y planes | Free, Team, Business y Enterprise en tu propio servidor, gratis para uso no comercial |
| Teléfono | La versión web funciona hoy en el navegador del móvil; las apps para iPhone y Android están en camino |
| Apps web en la barra | Fija Grafana, el CRM o cualquier sitio junto a Calab; la llamada sigue |
| Servidor propio | Un solo `docker compose`, con PostgreSQL y LiveKit, certificados y copias de seguridad automáticos |

### 🎙 Voz y vídeo

<img src="apps/landing/public/screens/es/call.webp" width="880" alt="Una llamada uno a uno en mensajes directos">

- **Salas de voz**: un clic para entrar; quién habla se ve en la lista de salas; estado de la sala, temporizador y límite de participantes.
- **Sonido limpio**: cancelación de eco AEC3 y supresión de ruido RNNoise (sin servicios externos), Opus con DTX; activación por voz o **pulsar para hablar** con cualquier tecla, también en segundo plano.
- **Modo músico**: interruptor personal que desactiva la cancelación de eco, la supresión de ruido y la ganancia automática y pasa Opus a un perfil musical (128 kbps mono / 192 kbps estéreo, FEC, sin DTX): toca un instrumento o canta en directo sin que el procesado se coma el sonido. Requiere auriculares; los demás ven un icono de guitarra junto a tu nombre. Plan Team y superiores.
- **Pantalla compartida** en AV1 o H.264 por hardware con simulcast: cada espectador recibe la calidad que permite su conexión; los espectadores señalan y dibujan encima.
- **Cámara** con fondo desenfocado o una imagen (fondos integrados y del espacio).
- **Llamadas uno a uno** en mensajes directos, con tono de llamada, cámara y pantalla compartida.
- **Grabaciones de reuniones**: graba el servidor y transcribe GPTunneL; al chat de la sala llega una tarjeta con el resumen, el audio y la transcripción completa.
- **Botonera de sonidos**, moderación (silenciar desde el servidor, desconectar, mover arrastrando), estados.
- **Llamadas telefónicas (SIP)** — conecta tu propio proveedor SIP y marca un número fijo o móvil desde una sala de voz; el interlocutor entra como participante y todos ven «Marcando → Llamando → En la llamada». Ajustes del proveedor, registro de llamadas y el permiso «Hacer llamadas», que por defecto no tiene nadie. Plan Business y Enterprise ([ADR-0046](docs/adr/0046-sip-telephony.md)).
- **Salas temporales** — una sala por una hora o un día con enlace de invitado listo y, si quieres, una reunión en el calendario: un sustituto de Zoom que desaparece solo ([ADR-0044](docs/adr/0044-temp-rooms.md)).
- **Galería de videorreunión** — todos en mosaicos iguales por páginas (hasta 25 en pantalla grande), con interruptor Galería | Orador; los que hablan tienen prioridad.

### 💬 Chat

<img src="apps/landing/public/screens/es/chat.webp" width="880" alt="La sala «general»: una maqueta con reacciones, una respuesta y un sticker">

- Burbujas como en Telegram: respuestas, **reacciones**, reenvío a varios chats, stickers, mensajes de voz, archivos con vista previa, mensajes fijados, marcas de lectura.
- **Menciones**, notificaciones por sala, búsqueda en el espacio con morfología, cambio rápido con `⌘K`.
- **Mensajes directos** con archivo; la versión web se adapta al móvil y se instala en la pantalla de inicio.
- **Búsqueda** — `⌘K` encuentra mensajes, tareas y sus comentarios, eventos del calendario, archivos, notas y transcripciones de reuniones, por inicio de palabra y con tolerancia a erratas.
- **Notificaciones** — niveles por sala; en las tareas cada tipo de evento se desactiva por separado, y tus avisos de tareas se pueden reenviar a un bot que elijas (por ejemplo, a Telegram).

### 📅 Calendario y reuniones

<table>
  <tr>
    <td width="50%"><img src="apps/landing/public/screens/es/calendar.webp" alt="La vista del día con la tarjeta de una reunión"></td>
    <td width="50%"><img src="apps/landing/public/screens/es/findtime.webp" alt="«Buscar hora» para cuatro personas"></td>
  </tr>
</table>

- Un día con reuniones en paralelo, la tarjeta de la reunión con asistentes y respuestas, la sala con el botón «Ir», repeticiones y recordatorios.
- **Invitaciones por correo** con `invite.ics`: la reunión llega al calendario de Apple, Google, Outlook o Yandex; los asistentes externos responden por enlace y entran como invitados.
- **Buscar hora**: columnas de ocupación de tus compañeros, huecos libres comunes y las franjas más cercanas dentro del horario laboral de todos.
- **CalDAV**: conecta Yandex, iCloud, Fastmail o Nextcloud; tu ocupación cuenta y las reuniones de Calab aparecen allí solas.

### ✅ Tableros de tareas

<img src="apps/landing/public/screens/es/kanban.webp" width="880" alt="El tablero «Producto» en kanban">

<table>
  <tr>
    <td width="68%"><img src="apps/landing/public/screens/es/timeline.webp" alt="El cronograma del tablero"></td>
    <td width="32%"><img src="apps/landing/public/screens/es/task.webp" alt="El panel de la tarea con comentarios"></td>
  </tr>
</table>

- **Kanban, lista y cronograma** (Gantt con hitos y la línea de «hoy»), al estilo de Linear y con sus atajos de teclado.
- Estados, prioridades, etiquetas, hitos y fechas límite; varios responsables con uno principal, subtareas y relaciones.
- Comentarios como en el chat (reacciones, stickers, mensajes de voz) junto al historial de cambios.
- Filtros, vistas guardadas, acciones en bloque; **una tarea desde cualquier mensaje**; el enlace a una tarea se despliega como tarjeta en el chat.

- **Aprobaciones** — asigna aprobadores y cuántas aprobaciones hacen falta (todas o N de M); una tarea no avanza en el tablero hasta que se aprueba ([ADR-0049](docs/adr/0049-task-approvals.md)).
- **Tarea a pantalla completa** en escritorio, como en Linear: `Esc` vuelve al tablero, `↑`/`↓` pasan a las tareas vecinas.
- **Listas de control** dentro de las tareas (Team y superior): progreso en la tarjeta y convertir un punto en subtarea.
- **Hitos** dentro de una tarea grande con fechas y progreso; en la línea de tiempo aparecen como rombos ([ADR-0063](docs/adr/0063-task-milestones.md)).
- **Automatizaciones** — reglas «Cuando → Si → Entonces» por tablero: cambiar estado, asignar, escribir en una sala y más (Team y superior, [ADR-0060](docs/adr/0060-board-automations.md)).
- **Formularios de entrada** — enlace público o formulario privado que crea tareas, con campos, estado y prioridad por defecto (Team 5 por tablero, Business 20, [ADR-0064](docs/adr/0064-board-forms.md)).
- **Webhooks de tablero** — eventos firmados para tus sistemas (Business); cada tablero activa y desactiva sus funciones por separado.
- **Historial** — pestañas «Comentarios» e «Historial»: quién cambió qué y cuándo, con valores antes y después; las ediciones repetidas se fusionan. Observadores, acceso a su tarjeta en tableros cerrados, recordatorios a los aprobadores.

### ✉️ Correo

Un cliente de correo en la aplicación de escritorio: conecta Gmail, Yandex, Mail.ru o iCloud (hace falta una contraseña de aplicación), lee y envía correo sin salir de Calab. Un mensaje se puede reenviar a un chat como texto con sus adjuntos. El correo funciona en local: las contraseñas quedan en el llavero del sistema y el servidor no interviene; no hay correo en la versión web ni en el móvil ([ADR-0088](docs/adr/0088-mail-client.md)).

### 📚 Wiki

<img src="apps/landing/public/screens/es/wiki.webp" width="880" alt="Wiki del equipo">

Páginas y subpáginas como en Notion: editor con tablas, listas de tareas, código e imágenes, edición conjunta en tiempo real con cursores, historial de versiones con restauración, acceso por página y enlaces públicos de solo lectura. Las páginas se enlazan entre sí (`[[`) y el enlace a una página en el chat se despliega en una tarjeta; un solo menú para la fila del árbol y para «⋯» de la página: renombrar, subpágina, mover, acceso, enlace, versiones, exportar, papelera.

### 🗂️ Disco

<img src="apps/landing/public/screens/es/disk.webp" width="880" alt="Disco del equipo">

Carpetas y archivos del espacio: subida arrastrando, mosaico o lista, acceso por carpeta (las privadas no las ven ni los administradores), enlaces públicos, papelera con limpieza automática e indicador de espacio claro. El indicador muestra qué ocupa el espacio: chats, tableros, wiki y el resto.

### 📝 Notas

Hasta 20 estantes privados con tus nombres y emoji, como «Mensajes guardados» de Telegram, pero varios. Arrastra mensajes y archivos a un estante, reenvíalos, fíjalos y búscalos.

### 🚪 Invitados y aprobación

<img src="apps/landing/public/screens/es/guest.webp" width="360" alt="Un invitado esperando la aprobación del organizador">

Un enlace de invitado lleva directo a una sala, sin registro. Con la aprobación activada (por sala o por enlace), el invitado espera en esta pantalla hasta que el organizador pulsa «Dejar entrar». Los invitados que no entran en 48 horas se eliminan solos y aparecen agrupados aparte en la lista de miembros. Quienes se fueron quedan en el historial como miembros «antiguos»: sus mensajes y tareas se conservan, y los administradores los ven en una pestaña aparte.

### 🎂 Personas

- **Perfiles** con correo y teléfono (copiar con un toque), un `@alias` único para las menciones, estado y cumpleaños.
- **Cumpleaños** — tarjeta festiva en el chat y aviso en el panel de miembros; **logros** que se otorgan «por algo», con tarjeta en el chat y una fila en el perfil ([ADR-0061](docs/adr/0061-achievements.md)).

### 🧩 Aplicaciones web

Un administrador fija accesos a sitios (Grafana, la wiki, el CRM) bajo el icono del espacio en la barra izquierda. Un clic abre el sitio a pantalla completa dentro de Calab y la llamada continúa; los inicios de sesión se guardan por separado para cada aplicación, y la cámara y el micrófono solo con tu permiso ([ADR-0050](docs/adr/0050-workspace-apps.md)).

### 📱 Teléfono

La versión web se adapta al móvil y se instala en la pantalla de inicio: lista de salas como en Telegram, gestos (responder, marcar como leído), pestañas fijadas más «Más», quién está en una sala de voz de un vistazo. Las apps para iPhone y Android (llamadas en la pantalla bloqueada, push) llegan pronto ([ADR-0067](docs/adr/0067-phone-shared-web-host.md)).

### 🤖 Bots y SDK

Un bot es un miembro con token: la misma API REST y el mismo gateway que la aplicación, permisos por roles. Lee y escribe en el chat, responde a `/comandos`, habla en las salas de voz (LiveKit, Node / Python / Go) y trabaja con los tableros según sus permisos; los eventos llegan por WebSocket o por un webhook firmado con HMAC. Bot API v2 añade el calendario (reuniones, libre/ocupado, búsqueda de hora), perfiles de miembros, invitaciones, insignias, admisión de invitados y grabación de reuniones, además de botones bajo los mensajes ([ADR-0051](docs/adr/0051-bot-api-v2.md)).

```ts
import { Bot } from '@calaba/bot-sdk';

const bot = new Bot(process.env.BOT_TOKEN, { server: 'https://app.calab.io' });
bot.on('message', (m) => bot.reply(m, m.content));
await bot.start();
```

SDK: [`packages/bot-sdk`](packages/bot-sdk); ejemplos: [`examples/bots`](examples/bots) (echo, eco de voz, TTS, Python); documentación: [docs/19-bot-api.en.md](docs/19-bot-api.en.md) (en inglés) · [ruso](docs/19-bot-api.md).

Los bots también trabajan con Disco y Wiki (carpetas, archivos, páginas) y con los webhooks de tablero. Documentación para desarrolladores — bots como API de integración, OAuth 2 / OIDC, SSO: **[calab.io/en/docs/](https://calab.io/en/docs/)**.

### 🔒 Servidor propio y seguridad

- **Funciona en cualquier red**: UDP → ICE/TCP → TURN/UDP 443 → TURN/TLS 443 automáticamente; una sola IP pública; probado detrás de VPN.
- Medios con DTLS-SRTP; API por HTTPS/WSS, HSTS, CSP estricta, cookies `HttpOnly/SameSite=Strict` en la web, argon2id, rotación de tokens de actualización con detección de reutilización, límites de frecuencia. Aún no hay cifrado de extremo a extremo: los medios pasan por tu propio servidor de medios.
- Todos los permisos (salas, tableros, calendario) los comprueba el servidor; el permiso de LiveKit los replica.
- **Roles por función** — permisos separados para tableros, miembros, bots, integraciones, registros, eventos y grabaciones; salas y tableros privados y cerrados que ni los administradores ven ([ADR-0048](docs/adr/0048-roles-v2.md)).
- **Docker Compose** con contenedores endurecidos, certificados de Let’s Encrypt automáticos, copias de seguridad diarias con restauración verificada, métricas de Prometheus; PostgreSQL 17 o 18.

## Próximamente

Planificado, aún no disponible:

- **Asistente de voz con IA** — un asistente de voz con IA en las salas (en pruebas).
- **IVR** — menú de voz y números internos para las llamadas telefónicas (SIP).
- **Solicitudes de contacto para integraciones** — próximamente; aún no disponible.

## Inicio rápido

### Tu propio servidor

Necesitas un host Linux con IP pública, Docker + Compose y un dominio con registros A para `app`, `rtc`, `turn` (y `@` para la web).

```bash
git clone https://github.com/itrcz/calab.git && cd calab
cp infra/docker/.env.example infra/docker/.env   # DOMAIN y secretos: mira los comentarios
infra/docker/deploy.sh                            # Caddy, LiveKit, API, Postgres, Valkey
```

Puertos: `80/443` TCP, `443/UDP`, `7881/TCP`, `7882/UDP`. El primer usuario registrado es el propietario del servidor; los demás entran por invitación. Guía completa, copias de seguridad y endurecimiento: [docs/06-deployment.md](docs/06-deployment.md) (en ruso).

### La aplicación

Las versiones para macOS, Windows y Linux están en [calab.io](https://calab.io/es/#download) y en tu servidor en `https://app.<dominio>/download/`; la versión web, en `https://app.<dominio>`. Novedades de cada versión: [CHANGELOG.md](CHANGELOG.md) (en ruso; el mismo texto va a [GitHub Releases](https://github.com/itrcz/calab/releases)).

### Desarrollo

```bash
corepack enable && pnpm install && make gen       # protobuf → Go + TS
pnpm infra:dev                                    # Postgres, Valkey, LiveKit --dev
cd apps/server && go run ./cmd/server serve       # API en :3000
pnpm -F @calaba/desktop dev                       # Electron
```

Comprobaciones: `make test` (Go + TS), `make test-integration`, pruebas visuales por pantalla (`pnpm -F @calaba/desktop e2e:visual -g "<pantalla>"`). Arquitectura (en ruso): [visión general](docs/01-architecture.md) · [medios](docs/02-media.md) · [red](docs/03-network.md) · [modelo de datos y permisos](docs/04-data-model.md) · [protocolo en tiempo real](docs/05-realtime-protocol.md) · [sistema de diseño](docs/08-design.md) · [ADR](docs/adr/).

## Planes

| | Free | Team | Business | Enterprise |
|---|---|---|---|---|
| Sala de voz | hasta 5 personas | hasta 15 personas | hasta 50 personas | sin límite |
| Miembros del espacio | hasta 50 | hasta 100 | hasta 500 | sin límite |
| Calidad de audio | hasta «Normal» | cualquiera, hasta «Excelente» | cualquiera | cualquiera |
| Pantalla compartida y cámara | hasta 720p / 15 fps | sin límites de calidad | sin límites de calidad | sin límites de calidad |
| Pantallas compartidas a la vez | 1 | 2 | 5 | sin límite |
| Cámaras a la vez | 3 | 10 | 25 | sin límite |
| Archivos | 5 GB por espacio | 300 GB por espacio | 1 TB por espacio | sin límite |
| Bots | 1 | 5 | 20 | sin límite |
| Paquetes de stickers | 1 | sin límite | sin límite | sin límite |
| Tableros de tareas | 3 | 30 | 50 | sin límite |
| Calendario | ✓ | ✓ | ✓ | ✓ |
| CalDAV | — | ✓ | ✓ | ✓ |
| Telefonía (SIP) | — | — | ✓ | ✓ |
| On-prem (servidor propio) | — | — | — | ✓ |
| Soporte | — | soporte | prioritario | ✓ |
| Precio | gratis | a consultar (**support@calab.io**) | a consultar (**support@calab.io**) | gratis para uso no comercial (BSL 1.1, «Powered by GPTunneL»); licencia comercial a consultar |

Free, Team y Business son planes en la nube de un espacio ([ADR-0024](docs/adr/0024-plans-and-limits.md)); Enterprise es Calab en tu propio servidor (on-prem), sin límites. Detalles: [calab.io/es/#pricing](https://calab.io/es/#pricing) y [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md).

**Pagos.** El espacio tiene un saldo del que se cobra por puesto y día; pago con tarjeta o SBP (Rusia). Los planes de pago se activan espacio por espacio; los roles tienen permisos de facturación separados «ver / recargar / gestionar», y con el plan inactivo el espacio sigue siendo legible ([ADR-0080](docs/adr/0080-seat-billing.md)).

## Licencia

**Business Source License 1.1**: [LICENSE](LICENSE).

- El uso no comercial (personal, ONG, educación, evaluación de hasta 30 días) es **gratuito**, con «Powered by GPTunneL» en la interfaz y conservando el [NOTICE](NOTICE).
- El uso comercial requiere una licencia de GPTunneL: [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md), **support@calab.io**.
- Cada versión pasa a Apache-2.0 cuatro años después de su publicación.

Los nombres y logotipos de Calab y GPTunneL son marcas registradas, consulta [TRADEMARKS.md](TRADEMARKS.md).

## Contribuir y seguridad

Se aceptan pull requests con CLA: [CONTRIBUTING.md](CONTRIBUTING.md). Informa de vulnerabilidades en privado a **support@calab.io**, consulta [SECURITY.md](SECURITY.md).

<p align="center"><sub>© 2026 GPTunneL · Powered by <a href="https://gptunnel.ai">GPTunneL</a></sub></p>
