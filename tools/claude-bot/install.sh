#!/bin/sh
# Builds the daemon, copies it to ~/.calab-claude-bot/app and (re)starts the launchd agent.
#   tools/claude-bot/install.sh            install or update
#   tools/claude-bot/install.sh uninstall  stop and remove the agent (keeps logs and the assistant checkout)
set -eu
LABEL=io.calab.claude-bot
HERE=$(cd "$(dirname "$0")" && pwd)
APP="$HOME/.calab-claude-bot/app"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

if [ "${1:-}" = "uninstall" ]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "removed $LABEL"
  exit 0
fi

NODE=${NODE:-$(command -v node)}
ENV_FILE=${CLAUDE_BOT_ENV_FILE:-/Users/mac/Documents/Calaba/.env}
REPO=$(cd "$HERE/../.." && pwd)
ASSIST=${CLAUDE_BOT_ASSIST_REPO:-$HOME/.calab-claude-bot/repo}

(cd "$HERE" && "$NODE" scripts/build.mjs) # needs `pnpm install` at the repo root
mkdir -p "$APP" "$HOME/Library/Logs/calab-claude-bot" "$HOME/Library/LaunchAgents"
cp "$HERE/dist/daemon.mjs" "$HERE/lead-prompt.md" "$HERE/assistant-prompt.md" "$APP/"

# The assistant's read-only-ish checkout: a detached worktree of main (no .env, no owner files).
if [ ! -e "$ASSIST/.git" ]; then
  git -C "$REPO" worktree add --detach "$ASSIST" main
fi

sed -e "s#__HOME__#$HOME#g" -e "s#__NODE__#$NODE#g" -e "s#__ENV_FILE__#$ENV_FILE#g" \
  "$HERE/launchd/$LABEL.plist" > "$PLIST"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null && sleep 2 || true
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "started $LABEL; log: ~/Library/Logs/calab-claude-bot/daemon.log"
