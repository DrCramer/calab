// Configuration: process env first, then the owner's env file (read once at start, never copied into
// process.env, so child processes do not inherit the bot token). Every secret-looking value of the file
// is kept in memory only for redaction of what the bot posts.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface Config {
  apiUrl: string;
  token: string;
  /** The lead's checkout (main): where the editable prompts are read from. */
  leadRepo: string;
  /** A separate, clean checkout of main: cwd of the sandboxed runs (wake and assistant; no .env, nothing of the owner's). */
  assistRepo: string;
  /** The directory of the env file (the owner's main checkout): denied to the sandboxed runs. */
  ownerDir: string;
  /** The env file itself (its values are redacted from everything the runs post). */
  envFile: string;
  claudeBin: string;
  bugboard: string;
  boardId: string;
  /** Only members of this workspace may use the bot; '' = the workspace of the board. */
  workspaceId: string;
  logDir: string;
  /** Where the editable prompts live: the lead checkout first, then the installed copy. */
  promptDirs: string[];
  /** Request file for /check: the owner's Claude session picks it up (the bot starts no CLI). */
  checkRequest: string;
  assistTimeoutMs: number;
  /** The Sonnet chat assistant (off by default: DMs and mentions wake the lead instead). */
  assistant: boolean;
  /** Handoff inbox (one JSON file per request) and the poller's state file. */
  inboxDir: string;
  stateFile: string;
  /** Wake runs: the poller wakes the lead on changes (README «Wake runs»). */
  wake: {
    enabled: boolean;
    model: string;
    pollMs: number;
    debounceMs: number;
    cooldownMs: number;
    timeoutMs: number;
    dailyCap: number;
    /** Wakes a day caused only by outsiders' GitHub activity (a flood cannot use up the daily cap). */
    outsiderCap: number;
    /** `23-08` = no wakes from 23:00 to 08:00; '' = none. */
    quietHours: string;
    /** While this file exists, no wakes (a switch without a restart). */
    quietFile: string;
    maxBudgetUsd: number;
  };
  ghRepo: string;
  ghBin: string;
  /** GitHub logins whose PRs/issues never wake the bot. */
  ghIgnoreAuthors: string[];
  /** The login `gh` acts as ('' = ask GitHub at start). */
  ghSelf: string;
  timeZone: string | undefined;
  /** Values from the env file that must never be posted (redaction). */
  secrets: string[];
}

/** Parses a dotenv file: KEY=value, optional quotes, # comments. */
export function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m?.[1]) continue;
    let v = (m[2] ?? '').trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out.set(m[1], v);
  }
  return out;
}

const DEFAULT_BOARD = '01a15335-e861-7e04-9005-65f09159164f';

export function loadConfig(env: NodeJS.ProcessEnv = process.env, installDir = ''): Config {
  const home = env.HOME ?? homedir();
  const envFile = env.CLAUDE_BOT_ENV_FILE ?? '/Users/mac/Documents/Calaba/.env';
  let file = new Map<string, string>();
  try {
    file = parseEnvFile(readFileSync(envFile, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read env file ${envFile}: ${(err as Error).message}`, { cause: err });
  }
  const get = (k: string, d = ''): string => env[k] ?? file.get(k) ?? d;
  const token = get('CALAB_BUGS_BOT_TOKEN');
  if (!token) throw new Error(`CALAB_BUGS_BOT_TOKEN is not set (env or ${envFile})`);
  const leadRepo = get('CLAUDE_BOT_LEAD_REPO', '/Users/mac/orca/workspaces/Calaba/Clade-Team');
  const num = (k: string, d: number): number => {
    const n = Number(get(k, String(d)));
    return Number.isFinite(n) && n >= 0 ? n : d;
  };
  const minutes = (k: string, d: number): number => num(k, d) * 60_000;
  const on = (k: string, d: boolean): boolean => {
    const v = get(k, d ? 'on' : 'off').toLowerCase();
    return v === 'on' || v === '1' || v === 'true' || v === 'yes';
  };
  const botHome = join(home, '.calab-claude-bot');
  return {
    apiUrl: get('CALAB_API_URL', 'https://app.calab.io').replace(/\/+$/, ''),
    token,
    leadRepo,
    assistRepo: get('CLAUDE_BOT_ASSIST_REPO', join(home, '.calab-claude-bot', 'repo')),
    ownerDir: dirname(envFile),
    envFile,
    claudeBin: get('CLAUDE_BOT_CLAUDE_BIN', join(home, '.local', 'bin', 'claude')),
    bugboard: get('CLAUDE_BOT_BUGBOARD', join(home, '.calab-tools', 'bugboard.py')),
    boardId: get('CLAUDE_BOT_BOARD_ID', DEFAULT_BOARD),
    workspaceId: get('CLAUDE_BOT_WORKSPACE_ID'),
    logDir: get('CLAUDE_BOT_LOG_DIR', join(home, 'Library', 'Logs', 'calab-claude-bot')),
    promptDirs: [join(leadRepo, 'tools', 'claude-bot'), ...(installDir ? [installDir] : [])],
    checkRequest: get('CLAUDE_BOT_CHECK_REQUEST', join(home, '.calab-tools', 'check-request.json')),
    assistTimeoutMs: minutes('CLAUDE_BOT_ASSIST_TIMEOUT_MIN', 3),
    assistant: on('CLAUDE_BOT_ASSISTANT', false),
    inboxDir: get('CLAUDE_BOT_INBOX_DIR', join(botHome, 'inbox')),
    stateFile: get('CLAUDE_BOT_STATE_FILE', join(botHome, 'state.json')),
    wake: {
      enabled: on('CLAUDE_BOT_WAKE', true),
      model: get('CLAUDE_BOT_WAKE_MODEL', 'opus'),
      pollMs: Math.max(60_000, minutes('CLAUDE_BOT_POLL_MIN', 5)),
      debounceMs: 60_000,
      cooldownMs: minutes('CLAUDE_BOT_COOLDOWN_MIN', 10),
      timeoutMs: minutes('CLAUDE_BOT_WAKE_TIMEOUT_MIN', 30),
      dailyCap: num('CLAUDE_BOT_WAKE_DAILY_CAP', 8),
      outsiderCap: num('CLAUDE_BOT_WAKE_OUTSIDER_CAP', 2),
      quietHours: get('CLAUDE_BOT_QUIET_HOURS'),
      quietFile: get('CLAUDE_BOT_QUIET_FILE', join(botHome, 'quiet')),
      maxBudgetUsd: num('CLAUDE_BOT_WAKE_BUDGET_USD', 5),
    },
    ghRepo: get('CLAUDE_BOT_GH_REPO', 'itrcz/calab'),
    ghBin: get('CLAUDE_BOT_GH_BIN', 'gh'),
    ghIgnoreAuthors: get('CLAUDE_BOT_GH_IGNORE_AUTHORS', 'dependabot[bot],dependabot')
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean),
    ghSelf: get('CLAUDE_BOT_GH_SELF'),
    timeZone: get('CLAUDE_BOT_TZ') || undefined,
    secrets: [...new Set([token, ...file.values()].filter((v) => v.length >= 8))],
  };
}

/**
 * The environment of a claude child: the daemon's own (launchd's PATH/HOME), without anything the bot
 * reads from the env file, so neither the lead nor the assistant can print the bot token from `env`.
 */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (k === 'CALAB_BUGS_BOT_TOKEN' || k.startsWith('CLAUDE_BOT_') || k.startsWith('CALAB_HANDOFF_') || /BOT_TOKEN/.test(k)) continue;
    out[k] = v;
  }
  return out;
}
