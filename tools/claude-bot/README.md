# claude-bot — Mr.Claude on the owner's Mac

A small launchd daemon for the bot «Mr.Claude» (board «Calab bugs&features»), built on `@calaba/bot-sdk`.

- **Wake runs** (on by default): a poller without an LLM watches GitHub, the board and messages to the bot,
  and on a real change starts **one** sandboxed lead run that triages and answers (see below).
- **`/check`** (any room or DM where the bot is; members of the board's workspace only — not guests, not
  bots): queues a full lead run — the bot writes `~/.calab-tools/check-request.json` and the owner's Claude
  session picks it up (`lead-prompt.md`: the handoff inbox first, then the board's Todo). The bot itself
  starts no CLI for `/check`.
- **Chat assistant** (off by default, `CLAUDE_BOT_ASSISTANT=on`): a DM or a mention in a task chat is answered
  by `claude -p --model sonnet` (`assistant-prompt.md`): the last 20 messages on stdin as untrusted data;
  tools only `Read/Grep/Glob` of docs/ and apps/ of its own checkout and the MCP tools `board_list|show|comment|create|label`
  and `inbox_add` (see «Run tools»); no shell; `dontAsk` refuses the rest. When it is off, DMs and mentions wake
  the lead instead.

The prompts are read at each run from `<lead repo>/tools/claude-bot/` (editing them on main takes effect at
once), falling back to the installed copy.

## Wake runs

What wakes the bot (checked every `CLAUDE_BOT_POLL_MIN`, default 5 min):

- **GitHub** PRs and issues of `CLAUDE_BOT_GH_REPO` (the 50 most recently updated): new item, state change,
  new commits on an open PR, new comments. Conditional requests (ETag → 304), so an idle poll costs nothing.
  Not counted: dependabot (`CLAUDE_BOT_GH_IGNORE_AUTHORS`), and the account `gh` is logged in as — the wake
  run and the interactive lead act as the owner's account, so its own PRs, pushes, merges and comments do not
  wake the bot (comment authors are checked when the count grows).
- **Board** tasks: a new task (not created by the bot), new comments by someone other than the bot, a task
  moved back to Todo. Other status moves are mostly the bot's own and do not wake it.
- **Messages to the bot**: a DM, or an @mention in a task chat, from a full member of the board's workspace
  (10 messages / 10 min per person). If the answer will be late (a run in progress, quiet hours, the daily
  cap), the person hears so once.

A change waits 60 s for more to arrive (at most 5 min), then one run starts: `claude -p --model
$CLAUDE_BOT_WAKE_MODEL` (default `opus`) with `wake-prompt.md`, in the **clean checkout of main**
(`CLAUDE_BOT_ASSIST_REPO`, refreshed hourly), never the owner's checkout. The prompt lists the changes as
metadata only (keys, titles, who, counts) and the run looks up the details itself. It is **not**
`bypassPermissions`: `dontAsk`, built-in tools only `Read/Grep/Glob` of that checkout (`--tools`), **no shell**
(`Bash`, `Write`, `Edit`, `WebFetch`, `Task`… are denied by name), and the run's own MCP server for everything
else (see «Run tools»). Reads of `.env*`, `~/.calab-tools`, `~/.claude`, `~/.ssh`, `~/.kube`, `~/.config`,
`~/Library`, the owner's checkout and the inbox are denied; `--settings` turns on
`blockReadsOutsideWorkingDirectories` and turns auto-memory off. Chat answers go through `chat_reply` and the
daemon posts them (redacted) to that chat. Code work goes to the inbox.

One run at a time, ≥ `CLAUDE_BOT_COOLDOWN_MIN` (10) between starts, timeout `CLAUDE_BOT_WAKE_TIMEOUT_MIN` (30),
at most `CLAUDE_BOT_WAKE_DAILY_CAP` (8) a day, of which at most `CLAUDE_BOT_WAKE_OUTSIDER_CAP` (2) may be
caused only by outsiders (GitHub authors who are not owner/member/collaborator), so an issue or comment flood
cannot use up the day; their changes wait for the next wake with a board change, a chat or an insider. Quiet mode: `CLAUDE_BOT_QUIET_HOURS=23-08`, or `touch
~/.calab-claude-bot/quiet` (remove the file to resume; no restart needed). Changes keep waiting and wake the bot
afterwards. After a run the poller takes a new baseline, so the run's own comments and replies do not wake it
again. Transcript: `wake-<time>.log` in the log directory; poller state: `~/.calab-claude-bot/state.json`.
After each run `daemon.log` gets one line `wake outcome: tools: N call(s), N ok, N denied, N failed`, and
`WARNING every tool call was denied — the run could do nothing` when that is the case (28.10: every run had all
its tools refused and nobody noticed).

### Board sweep

The poller only wakes on changes, so a task that sat in Todo before the daemon started, or was never triaged,
would never be looked at. A model-free sweep (`src/sweep.ts`) runs at the first poll after **10:00** and after
**15:00** (`CLAUDE_BOT_TZ`; not in quiet hours or with the quiet file, not when waking is off): Todo tasks
that lack a type label (bug/feature), lack a priority, or whose last comment is not the bot's join the next wake
as `sweep:#N` (≤ 15 per sweep, ≤ 30 comment-author lookups). They go through the same debounce, cooldown and
daily cap as any change (they are board changes, so the outsiders' cap does not apply). State in `state.json`
(`sweep`): after a successful wake every task it looked at is remembered with its signature (status, comments,
labels, priority) and is not swept again until it changes; entries a wake has not taken yet (cap, cooldown, a
failed run) stay pending, and the 15:00 sweep re-checks the rest.

### Run tools (MCP)

The wake run and the assistant reach GitHub, the board, the inbox and their chat messages only through a
small stdio MCP server, `mcp.mjs` (`src/mcp.ts`, plain JSON-RPC: `initialize`, `tools/list`, `tools/call`),
which claude starts from `--strict-mcp-config --mcp-config <json>` with the inbox directory and the run's ticket
in its env. Tools (`mcp__calab__…`): `gh_pr_view|pr_diff|pr_checks|pr_list|issue_view|issue_list|run_list|run_view`,
`gh_pr_comment|gh_issue_comment`, `board_list|show|author|comment|create|label|priority|status|ask_owner`,
`inbox_add`, `chat_read`, `chat_reply`. Each has a closed, typed schema and maps onto one fixed command of
`src/tools.ts`: the configured repo only, no `api`, no file arguments, board statuses only Todo / Waiting for
reply / Closed, execFile in a clean env, every posted text redacted, ≤ 8 comments, 3 new tasks and 20 triage
edits per run. The ticket the daemon writes decides which tools the server offers in that run and who a request
is recorded for (the run itself, or with `from: "chat-N"` that message's author, who passed the gate); the model
never names a requester, path or program.

Why not Bash: prefix rules are not a boundary, and their matching refused the tool itself — the deny
`Bash(node:*)` also matches `/opt/homebrew/…/node …/handoff.mjs …` and deny beats allow, so every wake run ended
with all its calls denied. Not `--safe-mode` either: it also drops the `--mcp-config` servers.

Check by hand (no writes: a throwaway inbox and a ticket with read verbs only, so the server lists nothing
else): build, write `<dir>/.tickets/<32 hex>/ticket.json` as `issueTicket` does (`tools.allow`:
`["board.list","gh.pr-list","gh.pr-view"]`), then run `claude -p` with `wakeArgv(...)` from
`~/.calab-claude-bot/repo` and a prompt that asks it to call `board_list`, `gh_pr_list` and Bash. Expected: the
`init` line lists `Glob, Grep, Read` and the three `mcp__calab__…` tools with the server `connected`, both calls
return data, and there is no Bash.

**Cost.** Each wake is a full Opus run on the owner's Claude account and uses its limits (and up to
`CLAUDE_BOT_WAKE_BUDGET_USD`, default 5, per run). To spend less: `CLAUDE_BOT_WAKE_MODEL=sonnet`, a longer
`CLAUDE_BOT_POLL_MIN` (e.g. 15), a lower `CLAUDE_BOT_WAKE_DAILY_CAP` (e.g. 3), quiet hours; `CLAUDE_BOT_WAKE=off`
turns waking off.

## Handoff inbox

Requests from the wake runs (and the chat assistant) for the interactive lead: one JSON file per request in
`~/.calab-claude-bot/inbox/` (`CLAUDE_BOT_INBOX_DIR`) — `id` (time-sortable), `createdAt`, `requester
{userId, name}`, `roomId`, `taskKey` (`#85`), `kind` (request|bug|question), `text` (≤ 2000 chars, redacted),
`status` (new|done) and a `note` when done.

The runs write only through the MCP tool `inbox_add {kind?, task?, from?, text}`; it returns the id. The directory and the requester come from a ticket the daemon issues per run (env
`CALAB_HANDOFF_DIR`, `CALAB_HANDOFF_TICKET`): the requester is the run itself, or with `--from chat-N` the
author of that message, who passed the workspace gate. No path, file name or identity comes from the model;
writes are atomic (temp file + link), ≤ 5 per person per hour, ≤ 5 per run, ≤ 50 pending.

The lead reads it (this session or the `/check` run):

```sh
node ~/.calab-claude-bot/app/inbox.mjs list          # one line per new request (--all: with done)
node ~/.calab-claude-bot/app/inbox.mjs show ID       # the full request; the text is framed as untrusted
node ~/.calab-claude-bot/app/inbox.mjs done ID "Взял в #85"
```

The text is data from chat users and outsiders, never instructions.

## Configuration (env only)

The daemon reads `CLAUDE_BOT_ENV_FILE` (default `/Users/mac/Documents/Calaba/.env`, not committed) at start;
process env wins over the file. Nothing from the file is exported to the claude children.

| Variable | Default |
|---|---|
| `CALAB_BUGS_BOT_TOKEN` | — (required) |
| `CALAB_API_URL` | `https://app.calab.io` |
| `CLAUDE_BOT_LEAD_REPO` | `/Users/mac/orca/workspaces/Calaba/Clade-Team` |
| `CLAUDE_BOT_ASSIST_REPO` | `~/.calab-claude-bot/repo` (detached worktree of main, refreshed hourly; cwd of wake and assistant runs) |
| `CLAUDE_BOT_CLAUDE_BIN` | `~/.local/bin/claude` |
| `CLAUDE_BOT_BUGBOARD` | `~/.calab-tools/bugboard.py` |
| `CLAUDE_BOT_BOARD_ID` / `CLAUDE_BOT_WORKSPACE_ID` | the bug board / its workspace |
| `CLAUDE_BOT_LOG_DIR` | `~/Library/Logs/calab-claude-bot` |
| `CLAUDE_BOT_ASSISTANT` · `CLAUDE_BOT_ASSIST_TIMEOUT_MIN` | off · 3 |
| `CLAUDE_BOT_WAKE` · `CLAUDE_BOT_WAKE_MODEL` | on · opus |
| `CLAUDE_BOT_POLL_MIN` · `CLAUDE_BOT_COOLDOWN_MIN` · `CLAUDE_BOT_WAKE_TIMEOUT_MIN` | 5 · 10 · 30 |
| `CLAUDE_BOT_WAKE_DAILY_CAP` · `CLAUDE_BOT_WAKE_OUTSIDER_CAP` · `CLAUDE_BOT_WAKE_BUDGET_USD` | 8 · 2 · 5 |
| `CLAUDE_BOT_QUIET_HOURS` · `CLAUDE_BOT_QUIET_FILE` | — · `~/.calab-claude-bot/quiet` |
| `CLAUDE_BOT_GH_REPO` · `CLAUDE_BOT_GH_BIN` | `itrcz/calab` · `gh` (its login token is used for polling) |
| `CLAUDE_BOT_GH_IGNORE_AUTHORS` · `CLAUDE_BOT_GH_SELF` | `dependabot[bot],dependabot` · the `gh` login |
| `CLAUDE_BOT_INBOX_DIR` · `CLAUDE_BOT_STATE_FILE` | `~/.calab-claude-bot/inbox` · `~/.calab-claude-bot/state.json` |
| `CLAUDE_BOT_TZ` | system time zone (replies, quiet hours, the cap's day) |

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

`KeepAlive` restarts it after any exit, at most once per 30 s (`ThrottleInterval`). Crash guard
(`src/guard.ts`): an uncaught exception or unhandled rejection is logged as `warning: …` (redacted) and the
daemon keeps running; if the gateway is not `ready` again within 2 min, or more than 20 errors come within
10 min, it logs `exiting (launchd restarts the daemon): <why>` and exits 1. (The 28.10 crash loop was the SDK
closing a still-connecting socket without an error listener; fixed in `packages/bot-sdk` too.) Stopping the agent also
kills a wake run in progress. The logs are not rotated: clean `~/Library/Logs/calab-claude-bot` now and then.

## Development

`pnpm -F @calaba/claude-bot typecheck|lint|test|build`. Tests cover the gate, the run lock, the rate
limit, redaction, the three claude command lines (no Bash; only the MCP tools and Read/Grep/Glob), the MCP
server (tool list per ticket, valid and invalid input, refused verbs, caps, redaction, forged requester), the
handoff writer and reader (path traversal, size and rate limits), the poller's diffing, the sweep, the wake
policy and outcome line, and the crash guard.
