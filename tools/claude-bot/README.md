# claude-bot — Mr.Claude on the owner's Mac

A small launchd daemon for the bot «Mr.Claude» (board «Calab bugs&features»), built on `@calaba/bot-sdk`.

- **`/check`** (any room or DM where the bot is; members of the board's workspace only — not guests, not
  bots): answers «Принял — смотрю доску, отпишусь в задачах.» and starts **one** headless lead run
  `claude -p <lead-prompt.md> --model opus --permission-mode bypassPermissions` in the lead checkout. When the
  run ends, its final summary (trimmed, secrets redacted) is posted back to the same room. One run at a time
  («Уже работаю с HH:MM…»), ≥ 10 min between run starts. Full transcript: `lead-<time>.log`.
- **Chat**: a DM to the bot, or a message in a task chat that @mentions it, is answered by
  `claude -p --model sonnet` as a sandboxed assistant (`assistant-prompt.md`): the last 20 messages go on
  stdin as untrusted data; tools are only `Read/Grep/Glob` (docs/ and apps/ of its own checkout) and
  `bugboard.py list|show|comment|create`; `dontAsk` refuses the rest, `.env*`, `~/.calab-tools`, `~/.claude`,
  `~/.ssh`, `~/Library` and the owner's checkout are denied; no settings, MCP, skills or CLAUDE.md are
  loaded (`--safe-mode`, `--setting-sources=`, `--strict-mcp-config`). 10 messages / 10 min per user, one
  answer at a time per chat (a message arriving meanwhile is answered next with fresh context), answers
  ≤ 4000 characters.

Both prompts are read at each run from `<lead repo>/tools/claude-bot/` (so editing them on main takes effect
at once), falling back to the installed copy.

## Configuration (env only)

The daemon reads `CLAUDE_BOT_ENV_FILE` (default `/Users/mac/Documents/Calaba/.env`, not committed) at start;
process env wins over the file. Nothing from the file is exported to the claude children.

| Variable | Default |
|---|---|
| `CALAB_BUGS_BOT_TOKEN` | — (required) |
| `CALAB_API_URL` | `https://app.calab.io` |
| `CLAUDE_BOT_LEAD_REPO` | `/Users/mac/orca/workspaces/Calaba/Clade-Team` |
| `CLAUDE_BOT_ASSIST_REPO` | `~/.calab-claude-bot/repo` (detached worktree of main, refreshed hourly) |
| `CLAUDE_BOT_CLAUDE_BIN` | `~/.local/bin/claude` |
| `CLAUDE_BOT_BUGBOARD` | `~/.calab-tools/bugboard.py` |
| `CLAUDE_BOT_BOARD_ID` / `CLAUDE_BOT_WORKSPACE_ID` | the bug board / its workspace |
| `CLAUDE_BOT_LOG_DIR` | `~/Library/Logs/calab-claude-bot` |
| `CLAUDE_BOT_COOLDOWN_MIN` · `CLAUDE_BOT_LEAD_TIMEOUT_MIN` · `CLAUDE_BOT_ASSIST_TIMEOUT_MIN` | 10 · 240 · 3 |
| `CLAUDE_BOT_TZ` | system time zone (HH:MM in replies) |

## Install, update, stop

```sh
pnpm install                         # at the repo root, once
tools/claude-bot/install.sh          # build → ~/.calab-claude-bot/app, plist → ~/Library/LaunchAgents, start
tools/claude-bot/install.sh uninstall
```

By hand (label `io.calab.claude-bot`):

```sh
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/io.calab.claude-bot.plist   # start (and at login)
launchctl bootout gui/$UID/io.calab.claude-bot                                   # stop
launchctl kickstart -k gui/$UID/io.calab.claude-bot                              # restart
launchctl print gui/$UID/io.calab.claude-bot | head -20                          # state
tail -f ~/Library/Logs/calab-claude-bot/daemon.log
```

`KeepAlive` restarts it after any exit, at most once per 30 s (`ThrottleInterval`). Stopping the agent also
kills a lead run in progress. The logs are not rotated: clean `~/Library/Logs/calab-claude-bot` now and then.

## Development

`pnpm -F @calaba/claude-bot typecheck|lint|test|build`. Tests cover the gate, the run lock, the rate
limit, redaction and both claude command lines (allowed and denied tools).
