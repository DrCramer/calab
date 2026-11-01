import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { HandoffError } from '../src/inbox.js';
import { issueTicket } from '../src/ticket.js';
import { ASSIST_TOOL_VERBS, planBoard, planGh, runTool, toolEnv, WAKE_TOOL_VERBS, WRITE_CAPS } from '../src/tools.js';

const REPO = 'itrcz/calab';
const R = ['-R', 'github.com/itrcz/calab'];

describe('planGh: one fixed command per verb on the configured repo', () => {
  it('builds read commands', () => {
    expect(planGh(['pr-view', '12', '--comments'], REPO).args).toEqual(['pr', 'view', '12', ...R, '--comments']);
    expect(planGh(['issue-view', '#3'], REPO).args).toEqual(['issue', 'view', '3', ...R]);
    expect(planGh(['pr-diff', '12'], REPO).args).toEqual(['pr', 'diff', '12', ...R]);
    expect(planGh(['run-view', '987654321', '--log-failed'], REPO).args).toEqual(['run', 'view', '987654321', ...R, '--log-failed']);
    expect(planGh(['pr-list', '--state', 'all', '--limit', '20'], REPO).args).toEqual(['pr', 'list', ...R, '--state', 'all', '--limit', '20']);
    expect(planGh(['pr-view', '1'], REPO).bucket).toBeNull();
  });

  it('refuses other repos, hosts, files, api, web and anything unknown', () => {
    const bad = [
      ['api', 'repos/itrcz/calab/issues'],
      ['pr-view', '12', '-R', 'itrcz/private'],
      ['pr-view', '12', '--repo=itrcz/private'],
      ['pr-view', '12', '--web'],
      ['pr-view', '12; cat ~/.ssh/id_rsa'],
      ['pr-view', '$(cat x)'],
      ['pr-diff', '12', '--patch'],
      ['pr-list', '--limit', '500'],
      ['pr-list', '--search', 'x'],
      ['run-list', '--state', 'open'],
      ['pr-comment', '12', '--body-file', '/Users/mac/.ssh/id_rsa'],
      ['pr-comment', '12', '-F', 'x'],
      ['pr-merge', '12'],
      ['repo', 'view'],
      [],
    ];
    for (const argv of bad) expect(() => planGh(argv, REPO, 'text'), argv.join(' ')).toThrow(HandoffError);
    expect(() => planGh(['pr-view', '1'], 'evil.com/x/y')).toThrow(HandoffError);
  });

  it('comments take the body from stdin only, capped and counted', () => {
    const c = planGh(['issue-comment', '7'], REPO, 'Спасибо, посмотрим');
    expect(c).toEqual({ prog: 'gh', args: ['issue', 'comment', '7', ...R, '--body-file', '-'], stdin: 'Спасибо, посмотрим', bucket: 'comment' });
    expect(() => planGh(['pr-comment', '7'], REPO, '  ')).toThrow(/пустой/);
    expect(() => planGh(['pr-comment', '7'], REPO, 'x'.repeat(3001))).toThrow(/3000/);
  });
});

describe('planBoard', () => {
  it('checks every argument', () => {
    expect(planBoard(['show', '#85']).args).toEqual(['show', '85']);
    expect(planBoard(['label', '85', 'bug', 'Voice', 'Web']).args).toEqual(['label', '85', 'bug', 'Voice', 'Web']);
    expect(planBoard(['priority', '85', 'high'])).toMatchObject({ args: ['priority', '85', 'high'], bucket: 'triage' });
    expect(planBoard(['status', '85', 'waiting', 'for', 'reply']).args).toEqual(['status', '85', 'Waiting for reply']);
    expect(planBoard(['status', '85', 'Закрыто']).args).toEqual(['status', '85', 'Closed']);
    expect(planBoard(['comment', '85'], 'Вопрос @01a0da5f-06e5-7486-984a-d92fbbf5a9bd')).toMatchObject({ args: ['comment', '85', '-'], bucket: 'comment' });
    expect(planBoard(['create', 'Падает звонок'], 'шаги')).toMatchObject({ args: ['create', 'Падает звонок', '-'], stdin: 'шаги', bucket: 'create' });
  });

  it('never moves a task to «В работе»/«Готово», assigns, or takes odd arguments', () => {
    const bad = [
      ['status', '85', 'Готово'],
      ['status', '85', 'done'],
      ['status', '85', 'В работе'],
      ['assign', '85'],
      ['label', '85', 'admin'],
      ['label', '85', 'Voice'],
      ['label', '85', 'bug', 'feature'],
      ['priority', '85', 'none'],
      ['show', '85', 'extra'],
      ['show', '../1'],
      ['comment', '85', 'inline text'],
      ['create', ''],
      ['-c', 'import os'],
    ];
    for (const argv of bad) expect(() => planBoard(argv, 'text'), argv.join(' ')).toThrow(HandoffError);
    const tag = (n: number) => Array.from({ length: n }, (_, i) => `@0000000${String(i)}-0000-0000-0000-000000000000`).join(' ');
    expect(() => planBoard(['comment', '85'], tag(4))).toThrow(/упоминаний/);
  });
});

describe('runTool', () => {
  let dir: string;
  let envFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tools-'));
    envFile = join(dir, 'owner.env');
    writeFileSync(envFile, 'CALAB_BUGS_BOT_TOKEN=supersecretvalue123\nOTHER=plainvalue99\n');
  });
  const ticket = (allow: readonly string[]) =>
    issueTicket({
      inboxDir: dir,
      workspaceId: 'ws',
      requester: { userId: 'mr-claude-wake', name: 'wake' },
      roomId: '-',
      sources: [],
      ttlMs: 60_000,
      now: 1000,
      tools: { allow: [...allow], ghRepo: REPO, ghBin: '/opt/homebrew/bin/gh', bugboard: '/b/bugboard.py', envFile },
    }).id;

  function run(t: string | undefined, group: 'gh' | 'board', argv: string[], text = '') {
    const calls: { bin: string; args: string[]; input?: string | undefined; env: NodeJS.ProcessEnv }[] = [];
    const out = runTool({
      inboxDir: dir,
      ticketId: t,
      group,
      argv,
      readText: () => text,
      now: 2000,
      env: { HOME: '/h', PATH: '/bin', GH_HOST: 'evil.example', GH_TOKEN: 'x', PYTHONPATH: '/tmp', NODE_OPTIONS: '--require x' },
      exec: (bin, args, o) => {
        calls.push({ bin, args, input: o.input, env: o.env });
        return 'ok';
      },
    });
    return { out, calls };
  }

  it('runs only verbs the ticket allows, with a clean env, redacting what it posts', () => {
    const t = ticket(WAKE_TOOL_VERBS);
    const { calls } = run(t, 'gh', ['pr-comment', '5'], 'token supersecretvalue123 and ghp_abcdefghijklmnopqrstuvwxyz0123');
    expect(calls[0]?.bin).toBe('/opt/homebrew/bin/gh');
    expect(calls[0]?.input).toBe('token [скрыто] and [скрыто]');
    expect(calls[0]?.env).toEqual({ HOME: '/h', PATH: '/bin', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' });
    const b = run(t, 'board', ['show', '85']).calls[0];
    expect(b).toMatchObject({ bin: 'python3', args: ['/b/bugboard.py', 'show', '85'] });
    const a = ticket(ASSIST_TOOL_VERBS);
    expect(() => run(a, 'board', ['status', '85', 'Closed'])).toThrow(/в этом запуске/);
    expect(() => run(a, 'gh', ['pr-view', '1'])).toThrow(/ничего/);
    expect(() => run(undefined, 'board', ['list'])).toThrow(HandoffError);
    const noTools = issueTicket({ inboxDir: dir, workspaceId: 'ws', requester: { userId: 'u', name: 'n' }, roomId: '-', sources: [], ttlMs: 60_000, now: 1000 }).id;
    expect(() => run(noTools, 'board', ['list'])).toThrow(HandoffError);
  });

  it('caps writes per run; reads are free', () => {
    const t = ticket(WAKE_TOOL_VERBS);
    for (let i = 0; i < WRITE_CAPS.create; i++) run(t, 'board', ['create', `T${String(i)}`], 'd');
    expect(() => run(t, 'board', ['create', 'one more'], 'd')).toThrow(/лимит/);
    for (let i = 0; i < WRITE_CAPS.comment; i++) run(t, 'board', ['comment', '1'], 'c');
    expect(() => run(t, 'gh', ['issue-comment', '1'], 'c')).toThrow(/лимит/);
    for (let i = 0; i < 30; i++) run(t, 'board', ['list']);
  });
});

describe('env', () => {
  it('keeps only the basics of the env', () => {
    expect(toolEnv({ HOME: '/h', GH_HOST: 'x', HTTPS_PROXY: 'p', PYTHONSTARTUP: 's' })).toEqual({ HOME: '/h', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' });
  });
});
