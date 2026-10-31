import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceRole } from '@calaba/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { listRequests } from '../src/inbox.js';
import { handleMessage, MCP_VERBS, mcpToolNames, TOOLS, type ServerOptions } from '../src/mcp.js';
import { issueTicket, takeReplies, WAKE_REQUESTER } from '../src/ticket.js';
import { ASSIST_TOOL_VERBS, WAKE_TOOL_VERBS, WRITE_CAPS } from '../src/tools.js';

const REPO = 'itrcz/calab';
const R = ['-R', 'github.com/itrcz/calab'];
let dir: string;
let envFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-'));
  envFile = join(dir, 'owner.env');
  writeFileSync(envFile, 'SOME_VALUE=supersecretvalue123\n');
});

function ticket(allow: readonly string[], sources: Parameters<typeof issueTicket>[0]['sources'] = []): string {
  return issueTicket({
    inboxDir: dir,
    workspaceId: 'ws-1',
    requester: WAKE_REQUESTER,
    roomId: '-',
    sources,
    ttlMs: 60_000,
    now: 1000,
    tools: { allow: [...allow], ghRepo: REPO, ghBin: '/opt/homebrew/bin/gh', bugboard: '/b/bugboard.py', envFile },
  }).id;
}

function server(ticketId: string) {
  const calls: { bin: string; args: string[]; input?: string | undefined }[] = [];
  const o: ServerOptions = {
    inboxDir: dir,
    ticketId,
    env: { HOME: '/h', PATH: '/bin', GH_TOKEN: 'x' },
    now: () => 2000,
    exec: (bin, args, x) => {
      calls.push({ bin, args, input: x.input });
      return `out of ${args.join(' ')}`;
    },
  };
  let id = 0;
  const rpc = (method: string, params?: unknown) => handleMessage(o, { jsonrpc: '2.0', id: ++id, method, ...(params === undefined ? {} : { params }) }) as Record<string, unknown>;
  const call = (name: string, args: unknown) => (rpc('tools/call', { name, arguments: args }).result ?? {}) as { content: { text: string }[]; isError?: boolean };
  return { rpc, call, calls };
}

const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join('');

describe('MCP protocol', () => {
  it('initializes, answers ping, ignores notifications, refuses unknown methods and bad JSON-RPC', () => {
    const { rpc } = server(ticket(WAKE_TOOL_VERBS));
    expect(rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code' } }).result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'calab' },
    });
    expect(rpc('ping').result).toEqual({});
    expect(handleMessage({ inboxDir: dir, ticketId: '', env: {}, exec: () => '' }, { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect(rpc('resources/list').error).toMatchObject({ code: -32601 });
    expect(handleMessage({ inboxDir: dir, ticketId: '', env: {}, exec: () => '' }, { id: 1, method: 'ping' })).toMatchObject({ error: { code: -32600 } });
  });

  it('every ticket verb of the wake and the assistant has a tool; names are what argv allows', () => {
    for (const v of [...WAKE_TOOL_VERBS, ...ASSIST_TOOL_VERBS]) expect(MCP_VERBS).toContain(v);
    expect(mcpToolNames(['board.list', 'gh.pr-view'])).toEqual(['mcp__calab__gh_pr_view', 'mcp__calab__board_list']);
  });

  it('lists only the tools the ticket allows, with closed schemas; nothing without a valid ticket', () => {
    const { rpc } = server(ticket(ASSIST_TOOL_VERBS));
    const tools = (rpc('tools/list').result as { tools: { name: string; inputSchema: { additionalProperties: boolean } }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual(['board_list', 'board_show', 'board_comment', 'board_create', 'board_label', 'inbox_add']);
    expect(tools.every((t) => !t.inputSchema.additionalProperties)).toBe(true);
    expect((server('0'.repeat(32)).rpc('tools/list').result as { tools: unknown[] }).tools).toEqual([]);
    expect((server('../../etc').rpc('tools/list').result as { tools: unknown[] }).tools).toEqual([]);
    expect(Object.keys(TOOLS)).toHaveLength(MCP_VERBS.length);
  });
});

describe('MCP tools/call', () => {
  it('runs a valid call as one fixed command on the configured repo', () => {
    const { call, calls } = server(ticket(WAKE_TOOL_VERBS));
    expect(call('gh_pr_view', { number: 253, comments: true }).isError).toBeUndefined();
    expect(call('gh_pr_list', { state: 'open', limit: 3 }).isError).toBeUndefined();
    expect(text(call('board_status', { task: 85, status: 'Waiting for reply' }))).toContain('status 85 Waiting for reply');
    expect(call('board_label', { task: 85, labels: ['bug', 'Voice'] }).isError).toBeUndefined();
    expect(calls.map((c) => [c.bin, ...c.args])).toEqual([
      ['/opt/homebrew/bin/gh', 'pr', 'view', '253', ...R, '--comments'],
      ['/opt/homebrew/bin/gh', 'pr', 'list', ...R, '--state', 'open', '--limit', '3'],
      ['python3', '/b/bugboard.py', 'status', '85', 'Waiting for reply'],
      ['python3', '/b/bugboard.py', 'label', '85', 'bug', 'Voice'],
    ]);
  });

  it('refuses invalid input before anything runs: types, ranges, enums, unknown or missing arguments', () => {
    const { call, calls } = server(ticket(WAKE_TOOL_VERBS));
    const bad: [string, unknown][] = [
      ['gh_pr_view', { number: '12; cat ~/.ssh/id_rsa' }],
      ['gh_pr_view', { number: -1 }],
      ['gh_pr_view', { number: 1.5 }],
      ['gh_pr_view', { number: 12, repo: 'itrcz/private' }],
      ['gh_pr_view', {}],
      ['gh_pr_list', { limit: 500 }],
      ['gh_pr_comment', { number: 1, body: 'x', body_file: '/Users/mac/.ssh/id_rsa' }],
      ['gh_pr_comment', { number: 1, body: 'x'.repeat(3001) }],
      ['board_status', { task: 85, status: 'Готово' }],
      ['board_status', { task: 85, status: 'В работе' }],
      ['board_label', { task: 85, labels: ['admin'] }],
      ['board_label', { task: 85, labels: ['Voice'] }],
      ['board_priority', { task: 85, priority: 'none' }],
      ['board_comment', { task: 85, text: '   ' }],
      ['board_show', 'not an object'],
    ];
    for (const [name, args] of bad) {
      const r = call(name, args);
      expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
    }
    expect(calls).toEqual([]);
  });

  it('refuses a verb the ticket does not allow, and unknown tools', () => {
    const { call, calls } = server(ticket(ASSIST_TOOL_VERBS));
    expect(text(call('board_status', { task: 85, status: 'Closed' }))).toMatch(/no tool board_status in this run/);
    expect(call('gh_pr_view', { number: 1 }).isError).toBe(true);
    expect(call('chat_reply', { ref: 'chat-1', text: 'hi' }).isError).toBe(true);
    expect(call('Bash', { command: 'cat ~/.ssh/id_rsa' }).isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it('keeps the per-run caps across calls', () => {
    const { call } = server(ticket(WAKE_TOOL_VERBS));
    for (let i = 0; i < WRITE_CAPS.comment; i++) expect(call(i % 2 ? 'board_comment' : 'gh_issue_comment', i % 2 ? { task: 1, text: 'c' } : { number: 1, body: 'c' }).isError).toBeUndefined();
    expect(text(call('gh_pr_comment', { number: 1, body: 'one more' }))).toMatch(/лимит/);
    for (let i = 0; i < WRITE_CAPS.create; i++) call('board_create', { title: `T${String(i)}`, description: 'd' });
    expect(call('board_create', { title: 'more', description: 'd' }).isError).toBe(true);
    for (let i = 0; i < 30; i++) expect(call('board_list', {}).isError).toBeUndefined();
  });

  it('redacts what it posts: patterns and the env file values', () => {
    const { call, calls } = server(ticket(WAKE_TOOL_VERBS));
    call('gh_pr_comment', { number: 5, body: 'value supersecretvalue123 and ghp_abcdefghijklmnopqrstuvwxyz0123' });
    expect(calls[0]?.input).toBe('value [скрыто] and [скрыто]');
  });

  it('records requests for the ticket\'s requester; the model cannot name one', () => {
    const member = { workspaceId: 'ws-1', role: WorkspaceRole.MEMBER, user: { id: 'u-anna', isBot: false, isGuest: false } };
    const t = ticket(WAKE_TOOL_VERBS, [{ ref: 'chat-1', member, name: 'Анна', roomId: 'room-1', context: 'chat text' }]);
    const { call } = server(t);
    expect(call('inbox_add', { text: 'x', requester: { userId: 'owner', name: 'Илья' } }).isError).toBe(true);
    expect(call('inbox_add', { text: 'x', userId: 'owner' }).isError).toBe(true);
    expect(call('inbox_add', { text: 'x', from: 'chat-9' }).isError).toBe(true);
    expect(text(call('inbox_add', { kind: 'bug', task: 85, text: 'Падает звонок' }))).toMatch(/^recorded: /);
    expect(text(call('inbox_add', { from: 'chat-1', text: 'Добавить кнопку' }))).toMatch(/^recorded: /);
    const reqs = listRequests(dir).sort((a, b) => a.kind.localeCompare(b.kind));
    expect(reqs.map((r) => [r.requester.userId, r.roomId, r.kind, r.taskKey])).toEqual([
      [WAKE_REQUESTER.userId, '-', 'bug', '#85'],
      ['u-anna', 'room-1', 'request', undefined],
    ]);
  });

  it('reads and answers only the chat messages of this run', () => {
    const member = { workspaceId: 'ws-1', role: WorkspaceRole.MEMBER, user: { id: 'u-anna', isBot: false, isGuest: false } };
    const t = ticket(WAKE_TOOL_VERBS, [{ ref: 'chat-1', member, name: 'Анна', roomId: 'room-1', context: 'chat text' }]);
    const { call } = server(t);
    expect(text(call('chat_read', { ref: 'chat-1' }))).toBe('chat text');
    expect(call('chat_read', { ref: 'chat-2' }).isError).toBe(true);
    expect(call('chat_read', { ref: '../ticket.json' }).isError).toBe(true);
    expect(call('chat_reply', { ref: 'chat-1', text: 'Готово, посмотрю' }).isError).toBeUndefined();
    expect(takeReplies(dir, t)).toEqual([{ ref: 'chat-1', text: 'Готово, посмотрю' }]);
    expect(readFileSync(envFile, 'utf8')).toContain('SOME_VALUE');
  });
});
