#!/usr/bin/env bash
# A hand-testing desktop app from THIS checkout against the mock API (apps/desktop/e2e-support/dev-mock.ts):
# builds the app (out/), starts the dev LiveKit on :7880 if nothing listens there (for calls; stopped
# on exit), signs in as Анна with the fixtures, audio muted. Not /Applications/Calab.app.
#
#   tools/dev-mock.sh            # signed in, on «Команда»
#   tools/dev-mock.sh --voice    # also in the voice room «Переговорка», on «Диск»
#   tools/dev-mock.sh --no-build # reuse the last build
# Options are passed on: --port <mock port, default 39380>, --theme light.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root/apps/desktop"

build=1
args=()
for a in "$@"; do
  if [ "$a" = "--no-build" ]; then build=0; else args+=("$a"); fi
done

[ -d node_modules ] || (cd "$root" && pnpm install --frozen-lockfile)
[ "$build" = 1 ] && pnpm run build:app

lk_pid=""
if ! lsof -iTCP:7880 -sTCP:LISTEN >/dev/null 2>&1; then
  if command -v livekit-server >/dev/null 2>&1; then
    livekit-server --dev >/tmp/calaba-dev-mock-livekit.log 2>&1 &
    lk_pid=$!
  else
    echo "dev-mock: no livekit-server (brew install livekit) — calls will not connect" >&2
  fi
fi
trap '[ -n "$lk_pid" ] && kill "$lk_pid" 2>/dev/null || true' EXIT

npx tsx e2e-support/dev-mock.ts ${args[@]+"${args[@]}"}
