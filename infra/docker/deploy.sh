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
# Inbound calls (ADR-0117/0121) need no switch of their own: a workspace admin turns them on. The
# IVR worker runs when IVR_AGENT_TOKEN is set (profile ivr), the registration agent when
# SIPREG_AGENT_TOKEN is set (profile sipreg; open 5080 udp+tcp first, docs/03 «SIP»).
if [[ "${SIP_ENABLED:-0}" == "1" ]]; then
  : "${REDIS_PASSWORD:?REDIS_PASSWORD is not set in .env}"
  if [[ -n "${IVR_AGENT_TOKEN:-}" ]]; then
    export COMPOSE_PROFILES="${COMPOSE_PROFILES:+${COMPOSE_PROFILES},}ivr"
  elif [[ -n "$(docker compose --profile ivr ps -q ivr 2>/dev/null)" ]]; then
    echo "IVR_AGENT_TOKEN is empty -> removing the ivr service"
    docker compose --profile ivr rm -sf ivr
  fi
  if [[ -n "${SIPREG_AGENT_TOKEN:-}" ]]; then
    export COMPOSE_PROFILES="${COMPOSE_PROFILES:+${COMPOSE_PROFILES},}sipreg"
  elif [[ -n "$(docker compose --profile sipreg ps -q sipreg 2>/dev/null)" ]]; then
    echo "SIPREG_AGENT_TOKEN is empty -> removing the sipreg service"
    docker compose --profile sipreg rm -sf sipreg
  fi
  SIP_CONFIG_BODY="$(envsubst '${REDIS_PASSWORD}' < livekit/sip.yaml.tpl)"
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
