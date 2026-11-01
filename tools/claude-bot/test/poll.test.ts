import { describe, expect, it } from 'vitest';
import { diffSnapshots, emptyPollState, GithubSource, Poller, type Actors, type BoardItem, type GhCommenter, type GhItem, type Snapshot } from '../src/poll.js';

const BOT = 'bot-id';
const actors: Actors = { ignoreAuthors: new Set(['dependabot[bot]']), ghSelf: 'itrcz', botId: BOT };

const gh = (o: Partial<GhItem> = {}): GhItem => ({ kind: 'pr', state: 'open', title: 'T', comments: 0, author: 'alice', ...o });
const task = (o: Partial<BoardItem> = {}): BoardItem => ({ title: 'Bug', status: 'Todo', comments: 0, createdBy: 'u-anna', roomId: 'room-85', ...o });
const snap = (g: Record<string, GhItem>, b: Record<string, BoardItem>): Snapshot => ({ at: '2026-10-28T10:00:00.000Z', gh: g, board: b });

describe('diffSnapshots', () => {
  it('reports new items, state changes, new commits, new comments and reopened tasks', () => {
    const base = snap({ 'pr#1': gh({ sha: 'aaa' }), 'issue#2': gh({ kind: 'issue' }) }, { '#85': task({ status: 'В работе' }) });
    const cur = snap(
      { 'pr#1': gh({ sha: 'bbbbbbbbb', comments: 2 }), 'issue#2': gh({ kind: 'issue', state: 'closed' }), 'issue#3': gh({ kind: 'issue', title: 'New' }) },
      { '#85': task({ status: 'Todo', comments: 1 }), '#86': task({ title: 'New task' }) },
    );
    const c = diffSnapshots(base, cur, actors);
    expect(c.map((x) => [x.key, x.what])).toEqual([
      ['pr#1', ['new commits (head bbbbbbb)', 'comments +2']],
      ['issue#2', ['state open→closed']],
      ['issue#3', ['new']],
      ['#85', ['status В работе→Todo', 'comments +1']],
      ['#86', ['new (Todo)']],
    ]);
  });

  it('ignores dependabot, the gh account itself (the bot and the lead), the bot on the board, and status moves away from Todo', () => {
    const base = snap({ 'pr#5': gh({ author: 'itrcz', sha: 'a' }), 'pr#6': gh({ author: 'dependabot[bot]', sha: 'a' }) }, { '#85': task() });
    const cur = snap(
      {
        'pr#5': gh({ author: 'itrcz', sha: 'b', state: 'closed' }),
        'pr#6': gh({ author: 'dependabot[bot]', sha: 'b', comments: 3 }),
        'pr#7': gh({ author: 'dependabot[bot]' }),
        'pr#8': gh({ author: 'ITRCZ' }),
      },
      { '#85': task({ status: 'В работе' }), '#90': task({ createdBy: BOT }) },
    );
    expect(diffSnapshots(base, cur, actors)).toEqual([]);
    expect(diffSnapshots(cur, cur, actors)).toEqual([]);
  });
});

function fakePoller(o: { gh: Record<string, GhItem>[]; board: Record<string, BoardItem>[]; ghAuthors?: GhCommenter[]; boardAuthors?: string[] }) {
  let i = 0;
  let j = 0;
  const calls: string[] = [];
  const p = new Poller(emptyPollState(), {
    ghItems: () => Promise.resolve(o.gh[Math.min(i++, o.gh.length - 1)] ?? {}),
    boardItems: () => Promise.resolve(o.board[Math.min(j++, o.board.length - 1)] ?? {}),
    ghCommentAuthors: (n) => {
      calls.push(`gh ${n}`);
      return Promise.resolve(o.ghAuthors ?? []);
    },
    boardCommentAuthors: (room, count) => {
      calls.push(`board ${room} ${String(count)}`);
      return Promise.resolve(o.boardAuthors ?? []);
    },
    actors: () => actors,
  });
  return { p, calls };
}

const T = (min: number) => new Date(Date.UTC(2026, 9, 28, 10, min));

describe('Poller', () => {
  it('the first poll only sets the baseline', async () => {
    const { p } = fakePoller({ gh: [{ 'issue#1': gh({ kind: 'issue' }) }], board: [{ '#1': task() }] });
    expect(await p.changes(T(0))).toEqual([]);
    expect(await p.changes(T(5))).toEqual([]);
  });

  it('does not wake on the bot\'s own comments: checked by author, and absorbed by the baseline after a run', async () => {
    const { p, calls } = fakePoller({
      gh: [{ 'pr#1': gh() }, { 'pr#1': gh({ comments: 1 }) }],
      board: [{ '#85': task() }, { '#85': task({ comments: 2 }) }],
      ghAuthors: [{ login: 'itrcz', assoc: 'OWNER' }],
      boardAuthors: [BOT, BOT],
    });
    await p.changes(T(0));
    expect(await p.changes(T(5))).toEqual([]);
    expect(calls).toEqual(['gh 1', 'board room-85 2']);
    // a cached check is not repeated on the next poll
    expect(await p.changes(T(10))).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it('wakes on someone else\'s comment, and the run\'s own changes become the new baseline', async () => {
    const { p } = fakePoller({
      gh: [{}, {}, {}],
      board: [{ '#85': task() }, { '#85': task({ comments: 1 }) }, { '#85': task({ comments: 3, status: 'В работе' }) }],
      boardAuthors: ['u-anna'],
    });
    await p.changes(T(0));
    expect((await p.changes(T(5))).map((c) => c.what)).toEqual([['comments +1']]);
    // the wake run answers and moves the task; afterwards nothing is pending
    await p.rebaseline(T(10));
    expect(await p.changes(T(15))).toEqual([]);
  });

  it('marks outsiders\' GitHub activity untrusted, insiders\' and the board\'s trusted', async () => {
    const { p } = fakePoller({
      gh: [{ 'issue#1': gh({ kind: 'issue' }), 'issue#2': gh({ kind: 'issue' }) }, { 'issue#1': gh({ kind: 'issue', comments: 1 }), 'issue#2': gh({ kind: 'issue', comments: 1 }), 'issue#3': gh({ kind: 'issue', author: 'mallory', assoc: 'NONE' }), 'pr#4': gh({ author: 'anna', assoc: 'COLLABORATOR' }) }],
      board: [{}, { '#9': task() }],
      ghAuthors: [{ login: 'mallory', assoc: 'NONE' }],
    });
    await p.changes(T(0));
    const c = await p.changes(T(5));
    expect(c.map((x) => [x.key, x.trusted])).toEqual([
      ['issue#1', false],
      ['issue#2', false],
      ['issue#3', false],
      ['pr#4', true],
      ['#9', true],
    ]);
  });

  it('a failing source keeps its previous part instead of looking all new', async () => {
    let fail = false;
    const p = new Poller(emptyPollState(), {
      ghItems: () => (fail ? Promise.reject(new Error('503')) : Promise.resolve({ 'pr#1': gh() })),
      boardItems: () => Promise.resolve({}),
      ghCommentAuthors: () => Promise.resolve([]),
      boardCommentAuthors: () => Promise.resolve([]),
      actors: () => actors,
    });
    await p.changes(T(0));
    fail = true;
    expect(await p.changes(T(5))).toEqual([]);
  });
});

describe('GithubSource', () => {
  const issues = [
    { number: 12, state: 'open', title: 'Fix login', comments: 1, user: { login: 'alice' }, pull_request: {}, body: 'long body that is not kept' },
    { number: 3, state: 'open', title: 'Crash', comments: 0, user: { login: 'bob' } },
  ];
  const pulls = [{ number: 12, head: { sha: 'abc123' } }];

  it('sends If-None-Match, reuses the reduced cache on 304 and never stores bodies', async () => {
    const seen: { url: string; inm: string | undefined; auth: string | undefined }[] = [];
    let notModified = false;
    const src = new GithubSource({
      repo: 'o/r',
      token: () => Promise.resolve('TOKEN'),
      cache: emptyPollState().gh,
      fetch: (url, init) => {
        seen.push({ url, inm: init.headers['if-none-match'], auth: init.headers.authorization });
        const body = url.includes('/pulls') ? pulls : issues;
        return Promise.resolve({
          status: notModified ? 304 : 200,
          headers: { get: (n: string) => (n === 'etag' ? `"e-${url.includes('/pulls') ? 'p' : 'i'}"` : null) },
          json: () => Promise.resolve(body),
        });
      },
    });
    const first = await src.items();
    expect(first).toEqual({
      'pr#12': { kind: 'pr', state: 'open', title: 'Fix login', comments: 1, sha: 'abc123', author: 'alice' },
      'issue#3': { kind: 'issue', state: 'open', title: 'Crash', comments: 0, author: 'bob' },
    });
    notModified = true;
    expect(await src.items()).toEqual(first);
    expect(seen.map((s) => s.inm)).toEqual([undefined, undefined, '"e-i"', '"e-p"']);
    expect(seen.every((s) => s.auth === 'Bearer TOKEN')).toBe(true);
    expect(JSON.stringify((src as unknown as { o: { cache: unknown } }).o.cache)).not.toContain('long body');
  });
});
