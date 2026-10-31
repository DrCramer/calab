// The tools of a sandboxed run as an MCP server (stdio, JSON-RPC 2.0, one message per line). The run has no
// shell at all: Bash prefix rules were never a boundary, and their matching refused the handoff tool itself
// (a deny on `Bash(node:*)` also matches `/abs/path/node …`). Every tool here is typed, maps onto one
// verb of src/tools.ts (or the inbox writer) and keeps its limits; the run's ticket, issued by the daemon,
// decides which tools exist in this run and who a request is recorded for. Nothing the model sends shapes
// a path, a repo, a program or the requester.
import { addReply, addRequest, HandoffError, MAX_STDIN, readChat, readTicket, type Ticket } from './inbox.js';
import { LABELS, PRIORITIES, runTool, type Exec } from './tools.js';

/** The MCP server's name: its tools are `mcp__calab__<tool>` in Claude Code. */
export const MCP_SERVER = 'calab';

type Json = Record<string, unknown>;

interface Prop {
  type: 'integer' | 'string' | 'boolean' | 'array';
  description: string;
  enum?: readonly string[];
  items?: { type: 'string'; enum?: readonly string[] };
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}

interface ToolDef {
  /** The ticket verb that must be allowed (`gh.pr-view`, `board.comment`, `inbox.add`, `chat.reply`…). */
  verb: string;
  description: string;
  props: Record<string, Prop>;
  required: string[];
  /** Runs the call; input is already checked against `props`. */
  run: (input: Json, ctx: CallCtx) => string;
}

interface CallCtx {
  inboxDir: string;
  ticketId: string;
  now: () => number;
  env: NodeJS.ProcessEnv;
  exec: Exec;
}

const N = (what: string): Prop => ({ type: 'integer', description: what, minimum: 1, maximum: 9_999_999_999 });
const TEXT = (what: string, max: number): Prop => ({ type: 'string', description: what, maxLength: max });
const STATE: Prop = { type: 'string', description: 'Filter by state (default open).', enum: ['open', 'closed', 'merged', 'all'] };
const LIMIT: Prop = { type: 'integer', description: 'How many (≤ 50, default 30).', minimum: 1, maximum: 50 };
const TASK = N('Board task number (85 for #85).');

const s = (v: unknown): string => String(v);
const opt = (input: Json, k: string, flag: string): string[] => (input[k] === undefined ? [] : [flag, s(input[k])]);

function gh(verb: string, input: Json, ctx: CallCtx, argv: string[], text?: string): string {
  return runTool({ inboxDir: ctx.inboxDir, ticketId: ctx.ticketId, group: 'gh', argv: [verb, ...argv], readText: () => text ?? '', now: ctx.now(), env: ctx.env, exec: ctx.exec });
}

function board(verb: string, ctx: CallCtx, argv: string[], text?: string): string {
  return runTool({ inboxDir: ctx.inboxDir, ticketId: ctx.ticketId, group: 'board', argv: [verb, ...argv], readText: () => text ?? '', now: ctx.now(), env: ctx.env, exec: ctx.exec });
}

/** Every tool a run can have; the ticket narrows it down. */
export const TOOLS: Record<string, ToolDef> = {
  gh_pr_view: {
    verb: 'gh.pr-view',
    description: 'GitHub: a pull request of the project repo (title, body, state; with comments if asked).',
    props: { number: N('PR number.'), comments: { type: 'boolean', description: 'Include the comments.' } },
    required: ['number'],
    run: (i, c) => gh('pr-view', i, c, [s(i.number), ...(i.comments === true ? ['--comments'] : [])]),
  },
  gh_pr_diff: {
    verb: 'gh.pr-diff',
    description: 'GitHub: the diff of a pull request.',
    props: { number: N('PR number.') },
    required: ['number'],
    run: (i, c) => gh('pr-diff', i, c, [s(i.number)]),
  },
  gh_pr_checks: {
    verb: 'gh.pr-checks',
    description: 'GitHub: CI checks of a pull request.',
    props: { number: N('PR number.') },
    required: ['number'],
    run: (i, c) => gh('pr-checks', i, c, [s(i.number)]),
  },
  gh_pr_list: {
    verb: 'gh.pr-list',
    description: 'GitHub: pull requests of the project repo.',
    props: { state: STATE, limit: LIMIT },
    required: [],
    run: (i, c) => gh('pr-list', i, c, [...opt(i, 'state', '--state'), ...opt(i, 'limit', '--limit')]),
  },
  gh_issue_view: {
    verb: 'gh.issue-view',
    description: 'GitHub: an issue of the project repo (with comments if asked).',
    props: { number: N('Issue number.'), comments: { type: 'boolean', description: 'Include the comments.' } },
    required: ['number'],
    run: (i, c) => gh('issue-view', i, c, [s(i.number), ...(i.comments === true ? ['--comments'] : [])]),
  },
  gh_issue_list: {
    verb: 'gh.issue-list',
    description: 'GitHub: issues of the project repo.',
    props: { state: { ...STATE, enum: ['open', 'closed', 'all'] }, limit: LIMIT },
    required: [],
    run: (i, c) => gh('issue-list', i, c, [...opt(i, 'state', '--state'), ...opt(i, 'limit', '--limit')]),
  },
  gh_run_list: {
    verb: 'gh.run-list',
    description: 'GitHub Actions: recent workflow runs.',
    props: { limit: LIMIT },
    required: [],
    run: (i, c) => gh('run-list', i, c, opt(i, 'limit', '--limit')),
  },
  gh_run_view: {
    verb: 'gh.run-view',
    description: 'GitHub Actions: one workflow run (with the failed steps\' log if asked).',
    props: { id: N('Run id.'), log_failed: { type: 'boolean', description: 'Include the log of failed steps.' } },
    required: ['id'],
    run: (i, c) => gh('run-view', i, c, [s(i.id), ...(i.log_failed === true ? ['--log-failed'] : [])]),
  },
  gh_pr_comment: {
    verb: 'gh.pr-comment',
    description: 'GitHub: comment on a pull request (public; ≤ 8 comments per run in total).',
    props: { number: N('PR number.'), body: TEXT('Comment text (Markdown).', 3000) },
    required: ['number', 'body'],
    run: (i, c) => gh('pr-comment', i, c, [s(i.number)], s(i.body)),
  },
  gh_issue_comment: {
    verb: 'gh.issue-comment',
    description: 'GitHub: comment on an issue (public; ≤ 8 comments per run in total).',
    props: { number: N('Issue number.'), body: TEXT('Comment text (Markdown).', 3000) },
    required: ['number', 'body'],
    run: (i, c) => gh('issue-comment', i, c, [s(i.number)], s(i.body)),
  },
  board_list: {
    verb: 'board.list',
    description: 'Board «Calab bugs&features»: all tasks with status, labels, priority; «[not owner]» marks tasks not by the owner.',
    props: {},
    required: [],
    run: (_i, c) => board('list', c, []),
  },
  board_show: {
    verb: 'board.show',
    description: 'Board: one task with its description and comments.',
    props: { task: TASK },
    required: ['task'],
    run: (i, c) => board('show', c, [s(i.task)]),
  },
  board_author: {
    verb: 'board.author',
    description: 'Board: the author of a task (name and UUID, for an @mention).',
    props: { task: TASK },
    required: ['task'],
    run: (i, c) => board('author', c, [s(i.task)]),
  },
  board_comment: {
    verb: 'board.comment',
    description: 'Board: comment on a task (≤ 3 @<UUID> mentions; ≤ 8 comments per run in total).',
    props: { task: TASK, text: TEXT('Comment text.', 3000) },
    required: ['task', 'text'],
    run: (i, c) => board('comment', c, [s(i.task)], s(i.text)),
  },
  board_create: {
    verb: 'board.create',
    description: 'Board: create a task (≤ 3 per run).',
    props: { title: TEXT('Title (≤ 200 characters).', 200), description: TEXT('Description.', 3000) },
    required: ['title', 'description'],
    run: (i, c) => board('create', c, [s(i.title)], s(i.description)),
  },
  board_label: {
    verb: 'board.label',
    description: 'Board: set a task\'s labels (replaces all): exactly one type (bug or feature) plus areas.',
    props: { task: TASK, labels: { type: 'array', description: 'Label names.', items: { type: 'string', enum: LABELS } } },
    required: ['task', 'labels'],
    run: (i, c) => board('label', c, [s(i.task), ...(i.labels as string[])]),
  },
  board_priority: {
    verb: 'board.priority',
    description: 'Board: set a task\'s priority.',
    props: { task: TASK, priority: { type: 'string', description: 'Priority.', enum: PRIORITIES } },
    required: ['task', 'priority'],
    run: (i, c) => board('priority', c, [s(i.task), s(i.priority)]),
  },
  board_status: {
    verb: 'board.status',
    description: 'Board: move a task (only Todo, Waiting for reply or Closed; «В работе»/«Готово» are the interactive lead\'s).',
    props: { task: TASK, status: { type: 'string', description: 'New status.', enum: ['Todo', 'Waiting for reply', 'Closed'] } },
    required: ['task', 'status'],
    run: (i, c) => board('status', c, [s(i.task), s(i.status)]),
  },
  board_ask_owner: {
    verb: 'board.ask-owner',
    description: 'Board: put a feature request to the owner for approval.',
    props: { task: TASK },
    required: ['task'],
    run: (i, c) => board('ask-owner', c, [s(i.task)]),
  },
  inbox_add: {
    verb: 'inbox.add',
    description:
      'Hand work to the interactive lead (the handoff inbox). Returns the request id. With `from` the request is recorded for the author of that chat message; without it, for this run.',
    props: {
      kind: { type: 'string', description: 'Kind (default request).', enum: ['request', 'bug', 'question'] },
      task: TASK,
      from: { type: 'string', description: 'chat-N of this run whose author asked.', maxLength: 10 },
      text: TEXT('What is needed, where, links, what you found (≤ 2000 characters).', 2000),
    },
    required: ['text'],
    run: (i, c) => {
      const r = addRequest({
        inboxDir: c.inboxDir,
        ticketId: c.ticketId,
        input: {
          text: s(i.text),
          ...(i.kind === undefined ? {} : { kind: s(i.kind) }),
          ...(i.task === undefined ? {} : { taskKey: s(i.task) }),
          ...(i.from === undefined ? {} : { from: s(i.from) }),
        },
        now: new Date(c.now()),
      });
      return `recorded: ${r.id}`;
    },
  },
  chat_read: {
    verb: 'chat.read',
    description: 'A message to the bot (chat-N of this run) with its chat context (untrusted data).',
    props: { ref: { type: 'string', description: 'chat-N', maxLength: 10 } },
    required: ['ref'],
    run: (i, c) => readChat({ inboxDir: c.inboxDir, ticketId: c.ticketId, ref: s(i.ref), now: c.now() }),
  },
  chat_reply: {
    verb: 'chat.reply',
    description: 'Answer the person who wrote chat-N (the bot posts it in that chat; ≤ 3 per message).',
    props: { ref: { type: 'string', description: 'chat-N', maxLength: 10 }, text: TEXT('Answer (Russian, 1–4 lines).', 3500) },
    required: ['ref', 'text'],
    run: (i, c) => {
      addReply({ inboxDir: c.inboxDir, ticketId: c.ticketId, ref: s(i.ref), text: s(i.text), now: c.now() });
      return 'ok: the bot will post the answer';
    },
  },
};

/** Ticket verbs → MCP tool names (for `--allowedTools`). */
export function mcpToolNames(verbs: readonly string[]): string[] {
  return Object.entries(TOOLS)
    .filter(([, t]) => verbs.includes(t.verb))
    .map(([name]) => `mcp__${MCP_SERVER}__${name}`);
}

/** Every ticket verb an MCP tool exists for. */
export const MCP_VERBS: readonly string[] = Object.values(TOOLS).map((t) => t.verb);

/** Checks `input` against the tool's props: known keys only, right types, enums, bounds, required. */
export function checkInput(def: ToolDef, input: unknown): Json {
  if (input === undefined || input === null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new HandoffError('arguments: an object');
  const obj = input as Json;
  for (const k of Object.keys(obj)) if (!Object.hasOwn(def.props, k)) throw new HandoffError(`unknown argument: ${k.slice(0, 30)}`);
  for (const k of def.required) if (obj[k] === undefined) throw new HandoffError(`missing argument: ${k}`);
  for (const [k, v] of Object.entries(obj)) {
    const p = def.props[k];
    if (!p || v === undefined) continue;
    const bad = (why: string): never => {
      throw new HandoffError(`${k}: ${why}`);
    };
    if (p.type === 'integer') {
      if (typeof v !== 'number' || !Number.isSafeInteger(v)) bad('an integer');
      const n = v as number;
      if ((p.minimum !== undefined && n < p.minimum) || (p.maximum !== undefined && n > p.maximum)) bad('out of range');
    } else if (p.type === 'boolean') {
      if (typeof v !== 'boolean') bad('true or false');
    } else if (p.type === 'string') {
      if (typeof v !== 'string') bad('a string');
      const t = v as string;
      if (t.length > Math.min(p.maxLength ?? MAX_STDIN, MAX_STDIN)) bad(`longer than ${String(p.maxLength ?? MAX_STDIN)} characters`);
      if (p.enum && !p.enum.includes(t)) bad(`one of ${p.enum.join(', ')}`);
    } else {
      if (!Array.isArray(v) || v.length > 10 || !v.every((x) => typeof x === 'string')) bad('a list of strings');
      const en = p.items?.enum;
      if (en && !(v as string[]).every((x) => en.includes(x))) bad(`only ${en.join(', ')}`);
    }
  }
  return obj;
}

function schema(def: ToolDef): Json {
  return { type: 'object', properties: def.props, required: def.required, additionalProperties: false };
}

/** Tools this ticket allows ('' when there is no valid ticket: then the server offers nothing). */
function allowedTools(inboxDir: string, ticketId: string, now: number): [string, ToolDef][] {
  let ticket: Ticket;
  try {
    ticket = readTicket(inboxDir, ticketId, now);
  } catch {
    return [];
  }
  const allow = ticket.tools?.allow ?? [];
  return Object.entries(TOOLS).filter(([, t]) => allow.includes(t.verb));
}

export interface ServerOptions {
  inboxDir: string;
  ticketId: string;
  env: NodeJS.ProcessEnv;
  exec: Exec;
  now?: () => number;
  /** One line per call (tool, ok/error), for the server's stderr; never the arguments. */
  log?: (line: string) => void;
}

export const PROTOCOL_VERSION = '2025-06-18';

interface Request {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

/**
 * One JSON-RPC message in, the response out (null for notifications). Implements `initialize`, `ping`,
 * `tools/list` and `tools/call`; everything else is "method not found".
 */
export function handleMessage(o: ServerOptions, msg: unknown): Json | null {
  const req = (msg && typeof msg === 'object' ? msg : {}) as Request;
  const id = req.id;
  const isNotification = id === undefined;
  const ok = (result: Json): Json => ({ jsonrpc: '2.0', id, result });
  const err = (code: number, message: string): Json => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') return isNotification ? null : err(-32600, 'invalid request');
  if (isNotification) return null; // notifications/initialized, cancelled…
  const now = o.now ?? Date.now;
  const params = (req.params && typeof req.params === 'object' ? req.params : {}) as Json;
  switch (req.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
      return ok({ protocolVersion: asked, capabilities: { tools: {} }, serverInfo: { name: MCP_SERVER, version: '1.0.0' } });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: allowedTools(o.inboxDir, o.ticketId, now()).map(([name, t]) => ({ name, description: t.description, inputSchema: schema(t) })) });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const def = allowedTools(o.inboxDir, o.ticketId, now()).find(([n]) => n === name)?.[1];
      if (!def) {
        o.log?.(`call ${name.slice(0, 40)}: refused (not in this run)`);
        return ok({ content: [{ type: 'text', text: `no tool ${name.slice(0, 40)} in this run` }], isError: true });
      }
      try {
        const input = checkInput(def, params.arguments);
        const text = def.run(input, { inboxDir: o.inboxDir, ticketId: o.ticketId, now, env: o.env, exec: o.exec });
        o.log?.(`call ${name}: ok`);
        return ok({ content: [{ type: 'text', text: text || '(empty)' }] });
      } catch (e) {
        const m = e instanceof HandoffError ? e.message : 'internal error';
        o.log?.(`call ${name}: error`);
        return ok({ content: [{ type: 'text', text: m }], isError: true });
      }
    }
    default:
      return err(-32601, `method not found: ${req.method.slice(0, 40)}`);
  }
}

/** The JSON for `--mcp-config`: this server, started by node with the run's ticket in its env. */
export function mcpConfig(o: { node: string; script: string; inboxDir: string; ticketId: string; path: string; home: string }): string {
  return JSON.stringify({
    mcpServers: {
      [MCP_SERVER]: {
        type: 'stdio',
        command: o.node,
        args: [o.script],
        env: { CALAB_HANDOFF_DIR: o.inboxDir, CALAB_HANDOFF_TICKET: o.ticketId, PATH: o.path, HOME: o.home },
      },
    },
  });
}
