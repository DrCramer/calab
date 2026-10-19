// Configuration: process env first, then the owner's env file (read once at start, never copied into
// process.env, so child processes do not inherit the bot token). Every secret-looking value of the file
// is kept in memory only for redaction of what the bot posts.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface Config {
  apiUrl: string;
  token: string;
  /** The lead's checkout (main): cwd of /check runs. */
  leadRepo: string;
  /** A separate checkout of main for the Sonnet assistant (no .env, nothing else of the owner's). */
  assistRepo: string;
  /** The directory of the env file (the owner's main checkout): denied to the assistant. */
  ownerDir: string;
  claudeBin: string;
  bugboard: string;
  boardId: string;
  /** Only members of this workspace may use the bot; '' = the workspace of the board. */
  workspaceId: string;
  logDir: string;
  /** Where the editable prompts live: the lead checkout first, then the installed copy. */
  promptDirs: string[];
  cooldownMs: number;
  leadTimeoutMs: number;
  assistTimeoutMs: number;
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
  const minutes = (k: string, d: number): number => {
    const n = Number(get(k, String(d)));
    return (Number.isFinite(n) && n >= 0 ? n : d) * 60_000;
  };
  return {
    apiUrl: get('CALAB_API_URL', 'https://app.calab.io').replace(/\/+$/, ''),
    token,
    leadRepo,
    assistRepo: get('CLAUDE_BOT_ASSIST_REPO', join(home, '.calab-claude-bot', 'repo')),
    ownerDir: dirname(envFile),
    claudeBin: get('CLAUDE_BOT_CLAUDE_BIN', join(home, '.local', 'bin', 'claude')),
    bugboard: get('CLAUDE_BOT_BUGBOARD', join(home, '.calab-tools', 'bugboard.py')),
    boardId: get('CLAUDE_BOT_BOARD_ID', DEFAULT_BOARD),
    workspaceId: get('CLAUDE_BOT_WORKSPACE_ID'),
    logDir: get('CLAUDE_BOT_LOG_DIR', join(home, 'Library', 'Logs', 'calab-claude-bot')),
    promptDirs: [join(leadRepo, 'tools', 'claude-bot'), ...(installDir ? [installDir] : [])],
    cooldownMs: minutes('CLAUDE_BOT_COOLDOWN_MIN', 10),
    leadTimeoutMs: minutes('CLAUDE_BOT_LEAD_TIMEOUT_MIN', 240),
    assistTimeoutMs: minutes('CLAUDE_BOT_ASSIST_TIMEOUT_MIN', 3),
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
    if (k === 'CALAB_BUGS_BOT_TOKEN' || k.startsWith('CLAUDE_BOT_') || /BOT_TOKEN/.test(k)) continue;
    out[k] = v;
  }
  return out;
}
