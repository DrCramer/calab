# LiveKit self-hosted config TEMPLATE. See docs/03-network.md.
# Rendered by infra/docker/deploy.sh via envsubst into livekit.gen.yaml (gitignored).
# Only the documented variables in deploy.sh are substituted; do not add other variables.
# API keys/secrets come from env LIVEKIT_KEYS (compose.yml), never from this file.
port: 17880
bind_addresses:
  - "${NPM_HOST_IP}"     # signal HTTP listener reachable from NPM's Docker bridge; media ports stay public
  - "127.0.0.1"          # egress, SIP and IVR connect locally

rtc:
  tcp_port: 7881
  udp_port: 7882          # UDP mux: all media on a single port
  use_external_ip: true
  # Some home routers reject a server's self-ping through its public address.
  skip_external_ip_validation: true
  allow_tcp_fallback: true
  # Use the physical NIC for ICE candidates; do not advertise Docker bridge addresses.
  interfaces:
    includes:
      - ${RTC_INTERFACE}
  # on bad UDP the SDK falls back to TCP / TURN by itself

# Redis (Valkey): the egress service (meeting recording, ADR-0025) is reached only through it;
# also what a 2nd node would need. DB 1 (DB 0 belongs to the API). The password comes from env
# REDIS_PASSWORD (compose.yml), not from this file.
redis:
  address: 127.0.0.1:16379
  db: 1

turn:
  enabled: true
  domain: turn.${DOMAIN}
  tls_port: 5349          # direct TURN/TLS; TCP 443 remains owned by NPM
  cert_file: ${TURN_CERT_DIR}/fullchain.pem
  key_file: ${TURN_CERT_DIR}/privkey.pem
  udp_port: 443           # TURN/UDP on 443 — passes where UDP is allowed only on 443
  # Relay sockets live BELOW the kernel ephemeral range (32768–60999), so the host firewall can
  # filter relayed traffic by source port without touching other processes' UDP (see docs/03,
  # "TURN relay"): no relaying to loopback/private networks, only to the SFU on :7882.
  relay_range_start: 20000
  relay_range_end: 29999

room:
  # Our API calls CreateRoom (idempotent) before issuing every join token. Inbound phone calls
  # (ADR-0117) need auto_create: LiveKit SIP puts the caller into a new room sipin_<workspace>_…
  # of its own (SIPDispatchRuleIndividual, random suffix) that the API cannot create in advance;
  # with auto_create: false the server answers 404 and the caller hears busy. Joining still needs
  # a token, and only the API (or LiveKit SIP, by our dispatch rule) mints them.
  auto_create: true
  empty_timeout: 300
  max_participants: 100

# Active-speaker detection (ActiveSpeakersChanged → the green speaking ring, docs/02 «Индикация
# речи собеседников»). Units per livekit-server pkg/sfu/audio (v1.13): active_level is 0–127 in
# -dBov, 0 = loudest, so a HIGHER value lets QUIETER speech count (default 35 = −35 dBov; our old
# 30 cut off quiet talkers). A participant is active when above active_level in ≥ min_percentile %
# of the packets of one update_interval window (ms); the level is averaged over smooth_intervals
# windows. Senders run RNNoise + a VAD gate + DTX, so silence is real silence and −40 dBov is safe.
# Changing this needs a LiveKit restart (deploy.sh does it when the rendered config changes).
audio:
  active_level: 40        # −40 dBov (default 35)
  min_percentile: 40      # % of the window above active_level (default 40)
  update_interval: 150    # ms between ActiveSpeakersChanged updates (default 400)
  smooth_intervals: 2     # average over 2 windows ≈ 300 ms (default 2)

webhook:
  api_key: ${LIVEKIT_API_KEY}
  urls:
    - http://${NPM_HOST_IP}:13000/api/rtc/webhook

prometheus:
  port: 6789              # loopback and NPM bridge only (bind_addresses); do not expose publicly

logging:
  level: info
  json: true
