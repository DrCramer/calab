// The only way a sandboxed run reaches GitHub and the board: the typed tools of the runs' MCP server
// (src/mcp.ts), which map onto the verbs here. The runs have no shell; every call is parsed into one fixed
// shape, run with execFile (no shell) in a clean env, and every write is redacted and counted against a
// per-run cap. What a run may call comes from its ticket.
import { readFileSync } from 'node:fs';
import { parseEnvFile } from './config.js';
import { cleanText, HandoffError, readTicket, reserveWrite } from './inbox.js';
import { redact } from './redact.js';

/** Verbs a ticket may allow (`gh.*` and `board.*`). */
export const GH_READ = ['pr-view', 'pr-diff', 'pr-checks', 'pr-list', 'issue-view', 'issue-list', 'run-list', 'run-view'] as const;
export const GH_WRITE = ['pr-comment', 'issue-comment'] as const;
export const BOARD_READ = ['list', 'show', 'author'] as const;
export const BOARD_WRITE = ['comment', 'create', 'label', 'priority', 'status', 'ask-owner'] as const;

/** The inbox writer and the chat of the run's messages (src/inbox.ts), as ticket verbs of the MCP tools. */
export const HANDOFF_VERBS = ['inbox.add', 'chat.read', 'chat.reply'] as const;

export const WAKE_TOOL_VERBS: readonly string[] = [...GH_READ, ...GH_WRITE]
  .map((v) => `gh.${v}`)
  .concat([...BOARD_READ, ...BOARD_WRITE].map((v) => `board.${v}`))
  .concat(HANDOFF_VERBS);
export const ASSIST_TOOL_VERBS: readonly string[] = ['board.list', 'board.show', 'board.comment', 'board.create', 'board.label', 'inbox.add'];

/** Per-run caps of writes, by bucket. */
export const WRITE_CAPS = { comment: 8, create: 3, triage: 20 } as const;
export type WriteBucket = keyof typeof WRITE_CAPS;

export const LABELS = ['bug', 'feature', 'Boards', 'Mail', 'Calendar', 'Voice', 'Chat', 'Wiki', 'Disk', 'Bots', 'Web', 'Mobile'] as const;
export const PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;
/** Statuses a sandboxed run may set: never «В работе»/«Готово» (the interactive lead's, after a release). */
const STATUS_ALIASES: Record<string, string> = {
  todo: 'Todo',
  'waiting for reply': 'Waiting for reply',
  waiting: 'Waiting for reply',
  ждём: 'Waiting for reply',
  пауза: 'Waiting for reply',
  closed: 'Closed',
  закрыто: 'Closed',
};
export const MAX_COMMENT = 3000;
export const MAX_MENTIONS = 3;

export interface ToolCall {
  /** Which program: the daemon's `gh` or `python3 <bugboard>`. */
  prog: 'gh' | 'board';
  args: string[];
  /** Text for the child's stdin (comment bodies, descriptions); already cleaned, not yet redacted. */
  stdin?: string;
  /** Counted write, or null for a read. */
  bucket: WriteBucket | null;
}

function fail(msg: string): never {
  throw new HandoffError(msg);
}

/** `85`, `#85`, `CBF-85` → `85`. */
export function num(raw: string | undefined, what = 'номер'): string {
  const m = /^(?:#|CBF-)?([1-9]\d{0,9})$/i.exec(raw ?? '');
  if (!m?.[1]) return fail(`${what}: число`);
  return m[1];
}

function noMore(rest: readonly string[]): void {
  if (rest.length) fail(`лишние аргументы: ${rest.join(' ').slice(0, 40)}`);
}

function needText(text: string | undefined, max: number): string {
  const t = (text ?? '').trim();
  if (!t) fail('пустой текст (на stdin)');
  if (t.length > max) fail(`текст длиннее ${String(max)} символов — сократите`);
  if ((t.match(/@[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? []).length > MAX_MENTIONS) {
    fail(`не больше ${String(MAX_MENTIONS)} упоминаний в комментарии`);
  }
  return t;
}

/**
 * `gh <verb> [N] [flags]` → a fixed gh command on `repo` (always `-R github.com/<repo>`), never `api`,
 * `--body-file <path>`, `--repo`, `--web` or anything else.
 */
export function planGh(argv: readonly string[], repo: string, text?: string): ToolCall {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) fail('repo');
  const R = ['-R', `github.com/${repo}`];
  const [verb, ...rest] = argv;
  const flag = (allowed: readonly string[]): string[] => {
    for (const f of rest.slice(1)) if (!allowed.includes(f)) fail(`флаг ${f.slice(0, 20)} не разрешён (можно: ${allowed.join(' ') || 'нет'})`);
    return rest.slice(1);
  };
  const limitArgs = (r: readonly string[], withState = true): string[] => {
    // [--state open|closed|merged|all] [--limit N≤50]
    const out: string[] = [];
    for (let i = 0; i < r.length; i += 2) {
      const k = r[i];
      const v = r[i + 1] ?? '';
      if (withState && k === '--state' && ['open', 'closed', 'merged', 'all'].includes(v)) out.push(k, v);
      else if (k === '--limit' && /^[1-9]\d?$/.test(v) && Number(v) <= 50) out.push(k, v);
      else fail(`флаг ${(k ?? '').slice(0, 20)} не разрешён (можно ${withState ? '--state, ' : ''}--limit ≤ 50)`);
    }
    return out;
  };
  switch (verb) {
    case 'pr-view':
      return { prog: 'gh', args: ['pr', 'view', num(rest[0]), ...R, ...flag(['--comments'])], bucket: null };
    case 'issue-view':
      return { prog: 'gh', args: ['issue', 'view', num(rest[0]), ...R, ...flag(['--comments'])], bucket: null };
    case 'pr-diff':
      return { prog: 'gh', args: ['pr', 'diff', num(rest[0]), ...R, ...flag([])], bucket: null };
    case 'pr-checks':
      return { prog: 'gh', args: ['pr', 'checks', num(rest[0]), ...R, ...flag([])], bucket: null };
    case 'run-view':
      return { prog: 'gh', args: ['run', 'view', num(rest[0]), ...R, ...flag(['--log-failed'])], bucket: null };
    case 'pr-list':
      return { prog: 'gh', args: ['pr', 'list', ...R, ...limitArgs(rest)], bucket: null };
    case 'issue-list':
      return { prog: 'gh', args: ['issue', 'list', ...R, ...limitArgs(rest)], bucket: null };
    case 'run-list':
      return { prog: 'gh', args: ['run', 'list', ...R, ...limitArgs(rest, false)], bucket: null };
    case 'pr-comment':
    case 'issue-comment': {
      const n = num(rest[0]);
      noMore(rest.slice(1));
      return { prog: 'gh', args: [verb === 'pr-comment' ? 'pr' : 'issue', 'comment', n, ...R, '--body-file', '-'], stdin: needText(text, MAX_COMMENT), bucket: 'comment' };
    }
    default:
      return fail(`gh: ${[...GH_READ, ...GH_WRITE].join('|')}`);
  }
}

/** `board <verb> …` → `python3 <bugboard> <verb> …` with every argument checked. */
export function planBoard(argv: readonly string[], text?: string): ToolCall {
  const [verb, ...rest] = argv;
  switch (verb) {
    case 'list':
      noMore(rest);
      return { prog: 'board', args: ['list'], bucket: null };
    case 'show':
    case 'author':
      noMore(rest.slice(1));
      return { prog: 'board', args: [verb, num(rest[0], 'задача')], bucket: null };
    case 'comment':
      noMore(rest.slice(1));
      return { prog: 'board', args: ['comment', num(rest[0], 'задача'), '-'], stdin: needText(text, MAX_COMMENT), bucket: 'comment' };
    case 'create': {
      // create "title" — the description on stdin
      const title = (rest[0] ?? '').replace(/\s+/g, ' ').trim();
      noMore(rest.slice(1));
      if (!title || title.length > 200) fail('create "заголовок" (≤ 200 символов), описание — на stdin');
      return { prog: 'board', args: ['create', title, '-'], stdin: needText(text, MAX_COMMENT), bucket: 'create' };
    }
    case 'label': {
      const names = rest.slice(1);
      if (names.length === 0 || names.length > 6 || !names.every((x) => (LABELS as readonly string[]).includes(x))) fail(`label N ${LABELS.join('|')}`);
      if (names.filter((x) => x === 'bug' || x === 'feature').length !== 1) fail('label N: ровно один тип — bug или feature');
      return { prog: 'board', args: ['label', num(rest[0], 'задача'), ...names], bucket: 'triage' };
    }
    case 'priority': {
      const p = rest[1] ?? '';
      noMore(rest.slice(2));
      if (!(PRIORITIES as readonly string[]).includes(p)) fail(`priority N ${PRIORITIES.join('|')}`);
      return { prog: 'board', args: ['priority', num(rest[0], 'задача'), p], bucket: 'triage' };
    }
    case 'status': {
      const s = STATUS_ALIASES[rest.slice(1).join(' ').trim().toLowerCase()];
      if (!s) fail('status N Todo|"Waiting for reply"|Closed (В работе и Готово ставит только лид)');
      return { prog: 'board', args: ['status', num(rest[0], 'задача'), s], bucket: 'triage' };
    }
    case 'ask-owner':
      noMore(rest.slice(1));
      return { prog: 'board', args: ['ask-owner', num(rest[0], 'задача')], bucket: 'triage' };
    default:
      return fail(`board: ${[...BOARD_READ, ...BOARD_WRITE].join('|')}`);
  }
}

/** A clean env for gh/python children: no inherited GH_*, PYTHON*, NODE_* or proxies the model could set. */
export function toolEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of ['HOME', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'USER']) if (env[k] !== undefined) out[k] = env[k];
  out.GH_PROMPT_DISABLED = '1';
  out.GH_NO_UPDATE_NOTIFIER = '1';
  out.NO_COLOR = '1';
  return out;
}

export const MAX_OUTPUT = 300_000;

export type Exec = (bin: string, args: string[], opts: { input?: string; env: NodeJS.ProcessEnv }) => string;

/**
 * Runs one `gh …`/`board …` call of a run: the ticket must allow the verb, the arguments become a fixed
 * command (planGh/planBoard), a write takes a slot of its per-run cap and its text is redacted with the
 * patterns and the env file's values. `readText` is called only for writes.
 */
export function runTool(opts: {
  inboxDir: string;
  ticketId: string | undefined;
  group: 'gh' | 'board';
  argv: readonly string[];
  readText: () => string;
  now: number;
  env: NodeJS.ProcessEnv;
  exec: Exec;
}): string {
  const ticket = readTicket(opts.inboxDir, opts.ticketId ?? '', opts.now);
  const tools = ticket.tools;
  const verb = `${opts.group}.${opts.argv[0] ?? ''}`;
  if (!tools?.allow.includes(verb)) {
    const mine = (tools?.allow ?? []).filter((v) => v.startsWith(`${opts.group}.`)).map((v) => v.slice(opts.group.length + 1));
    return fail(`${opts.group}: в этом запуске можно ${mine.join('|') || 'ничего'}`);
  }
  const writesText = opts.group === 'gh' ? (GH_WRITE as readonly string[]) : ['comment', 'create'];
  const text = writesText.includes(opts.argv[0] ?? '') ? cleanText(opts.readText()) : undefined;
  const call = opts.group === 'gh' ? planGh(opts.argv, tools.ghRepo, text) : planBoard(opts.argv, text);
  if (call.bucket) reserveWrite(opts.inboxDir, opts.ticketId ?? '', call.bucket, WRITE_CAPS[call.bucket]);
  let secrets: string[] = [];
  try {
    secrets = [...parseEnvFile(readFileSync(tools.envFile, 'utf8')).values()].filter((v) => v.length >= 8);
  } catch {
    // no env file: the patterns still apply
  }
  const input = call.stdin === undefined ? undefined : redact(call.stdin, secrets);
  const bin = call.prog === 'gh' ? tools.ghBin : 'python3';
  const args = call.prog === 'gh' ? call.args : [tools.bugboard, ...call.args];
  const out = opts.exec(bin, args, { ...(input === undefined ? {} : { input }), env: toolEnv(opts.env) });
  return out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}\n… (обрезано)\n` : out;
}
