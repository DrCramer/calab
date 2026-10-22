#!/usr/bin/env bash
# Deploy the production-like stack on a single host. Run from anywhere:
#   infra/docker/deploy.sh                  # whole stack
#   infra/docker/deploy.sh caddy livekit    # only these services (and their deps)
# Requires infra/docker/.env (see .env.example) and envsubst (gettext-base).
set -euo pipefail

cd "$(dirname "$0")"

if [[ ! -f .env ]]; then
  echo "infra/docker/.env not found — copy .env.example and fill it in" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

: "${DOMAIN:?DOMAIN is not set in .env}"
: "${LIVEKIT_API_KEY:?LIVEKIT_API_KEY is not set in .env}"

# Substitute only these two variables; everything else in the template stays literal.
cfg=livekit/livekit.gen.yaml
before="$(cat "$cfg" 2>/dev/null | sha256sum)"
envsubst '${DOMAIN} ${LIVEKIT_API_KEY}' < livekit/livekit.yaml.tpl > "$cfg"
after="$(sha256sum < "$cfg")"

# Telephony (ADR-0046): the sip service runs only with SIP_ENABLED=1. Its config carries the
# Valkey password, so it is rendered into the environment (SIP_CONFIG_BODY), not into a file.
# Inbound calls (ADR-0117) need SIP_INBOUND=1 too: LiveKit SIP then answers INVITEs (4xx for
# unknown numbers / addresses instead of silence) and the IVR worker runs (profile ivr).
if [[ "${SIP_ENABLED:-0}" == "1" ]]; then
  : "${REDIS_PASSWORD:?REDIS_PASSWORD is not set in .env}"
  SIP_HIDE_INBOUND=true
  if [[ "${SIP_INBOUND:-0}" == "1" ]]; then
    : "${IVR_AGENT_TOKEN:?IVR_AGENT_TOKEN is not set in .env (SIP_INBOUND=1)}"
    SIP_HIDE_INBOUND=false
    export COMPOSE_PROFILES="${COMPOSE_PROFILES:+${COMPOSE_PROFILES},}ivr"
  elif [[ -n "$(docker compose --profile ivr ps -q ivr 2>/dev/null)" ]]; then
    echo "SIP_INBOUND is off -> removing the ivr service"
    docker compose --profile ivr rm -sf ivr
  fi
  export SIP_HIDE_INBOUND
  SIP_CONFIG_BODY="$(envsubst '${REDIS_PASSWORD} ${SIP_HIDE_INBOUND}' < livekit/sip.yaml.tpl)"
  export SIP_CONFIG_BODY
  export COMPOSE_PROFILES="${COMPOSE_PROFILES:+${COMPOSE_PROFILES},}sip"
elif [[ -n "$(docker compose --profile sip ps -q sip 2>/dev/null)" ]]; then
  echo "SIP_ENABLED is off -> removing the sip service"
  docker compose --profile sip rm -sf sip
fi

docker compose up -d --build --remove-orphans "$@"

# The config is a bind mount: compose doesn't notice content changes, so restart
# LiveKit ourselves when the rendered file changed (brief media interruption).
if [[ "$before" != "$after" ]] && [[ -n "$(docker compose ps -q livekit 2>/dev/null)" ]]; then
  echo "livekit config changed -> restarting livekit"
  docker compose restart livekit
fi
