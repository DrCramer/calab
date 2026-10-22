# LiveKit SIP config TEMPLATE (telephony, ADR-0046). See docs/03-network.md «SIP» and
# docs/06-deployment.md «Телефония».
# Rendered by infra/docker/deploy.sh only when SIP_ENABLED=1, via envsubst, into the env var
# SIP_CONFIG_BODY of the sip service (never written to disk: it carries the Valkey password).
# Only the Valkey password (REDIS_PASSWORD) and SIP_HIDE_INBOUND (deploy.sh: false with
# SIP_INBOUND=1, else true) are substituted; add no other variables. Key/secret: from env
# LIVEKIT_API_KEY / LIVEKIT_API_SECRET (compose.yml).
#
# The service talks to livekit-server over Valkey (psrpc, the same DB 1 as LiveKit and egress)
# and joins rooms over the loopback websocket as the phone line's participant.
ws_url: ws://127.0.0.1:7880

redis:
  address: 127.0.0.1:6379
  db: 1
  password: "${REDIS_PASSWORD}"

# SIP signalling to and from the providers: 5060 UDP and TCP on all interfaces (public).
sip_port: 5060
# RTP media: 201 ports, BELOW the TURN relay range (20000–29999, livekit.yaml.tpl) and the
# kernel ephemeral range (32768–60999), clear of the neighbour's 8000–8400 / 9100 / 9400.
# A call holds one port; a closed call's port drains up to 10 min before reuse, so ~200 calls
# per 10 min fit — far above the per-workspace limit (20 per hour).
rtp_port: 10000-10200
# Announce the host's public IP (found via STUN) in SDP / Contact, like LiveKit's rtc section.
use_external_ip: true
# Without inbound calls (SIP_INBOUND unset): unauthenticated INVITEs (scanners, spam) are
# dropped silently. With them (ADR-0117) every INVITE gets an answer; only a workspace's inbound
# trunk (its number from the provider's allowed addresses) leads anywhere.
hide_inbound_port: ${SIP_HIDE_INBOUND}

logging:
  level: info
  json: true
