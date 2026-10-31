// The poller: no LLM. Every few minutes it takes a small snapshot of the repo's GitHub PRs/issues and the
// bug board's tasks, compares it with the baseline (the snapshot taken after the last wake run) and says
// what changed. Changes made by the bot itself (board: the bot account; GitHub: the account `gh` acts as,
// which is also what the wake run and the interactive lead use) and by ignored authors (dependabot) do
// not count. GitHub requests are conditional (ETag → 304 costs nothing against the rate limit).

export interface GhItem {
  kind: 'pr' | 'issue';
  state: string;
  title: string;
  comments: number;
  /** PR head sha (open PRs only). */
  sha?: string;
  author: string;
  /** GitHub `author_association` (OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE…). */
  assoc?: string;
}

export interface BoardItem {
  title: string;
  status: string;
  comments: number;
  createdBy: string;
  roomId: string;
  /** Label names (absent in snapshots taken before the sweep existed). */
  labels?: string[];
  /** TaskPriority: 0 = none … 4 = urgent. */
  priority?: number;
}

export interface Snapshot {
  at: string;
  gh: Record<string, GhItem>;
  board: Record<string, BoardItem>;
}

export interface Change {
  source: 'github' | 'board';
  /** `pr#12`, `issue#3`, `#85` */
  key: string;
  title: string;
  author: string;
  what: string[];
  /** New comments since the baseline (to check who wrote them). */
  newComments: number;
  /** Board: the task's comment room; GitHub: the number. */
  ref: string;
  /**
   * Caused by someone with a stake: the board (workspace members) or a GitHub owner/member/collaborator.
   * Wakes caused only by outsiders have their own, smaller daily cap, so a flood cannot starve the rest.
   */
  trusted: boolean;
}

/** GitHub author associations that count as insiders. */
export const TRUSTED_ASSOC = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export interface Actors {
  /** Item authors whose items never wake the bot (dependabot). */
  ignoreAuthors: ReadonlySet<string>;
  /** The GitHub login `gh` acts as (the owner's account: the bot's and the lead's own GitHub actions). */
  ghSelf: string;
  /** The bot's user id on Calab (its own board actions). */
  botId: string;
}

const isSelfGh = (login: string, a: Actors): boolean => login !== '' && login.toLowerCase() === a.ghSelf.toLowerCase();

/** Pure diff of two snapshots; comment changes still need an author check (see Poller). */
export function diffSnapshots(base: Snapshot, cur: Snapshot, actors: Actors): Change[] {
  const out: Change[] = [];
  for (const [key, it] of Object.entries(cur.gh)) {
    if (actors.ignoreAuthors.has(it.author.toLowerCase())) continue;
    const self = isSelfGh(it.author, actors);
    const was = base.gh[key];
    const c: Change = { source: 'github', key, title: it.title, author: it.author, what: [], newComments: 0, ref: key.replace(/^\D+/, ''), trusted: TRUSTED_ASSOC.has(it.assoc ?? '') };
    if (!was) {
      if (self) continue; // the lead's own PRs/issues
      c.what.push('new');
      if (it.comments > 0) c.newComments = it.comments;
    } else {
      if (!self && was.state !== it.state) c.what.push(`state ${was.state}→${it.state}`);
      if (!self && was.sha && it.sha && was.sha !== it.sha) c.what.push(`new commits (head ${it.sha.slice(0, 7)})`);
      if (it.comments > was.comments) {
        c.newComments = it.comments - was.comments;
        c.what.push(`comments +${String(c.newComments)}`);
      }
    }
    if (c.what.length) out.push(c);
  }
  for (const [key, it] of Object.entries(cur.board)) {
    const was = base.board[key];
    const c: Change = { source: 'board', key, title: it.title, author: it.createdBy, what: [], newComments: 0, ref: it.roomId, trusted: true };
    if (!was) {
      if (it.createdBy === actors.botId) continue;
      c.what.push(`new (${it.status})`);
    } else {
      // Status moves are mostly the bot's own; only a move back to Todo (reopened) is news.
      if (was.status !== it.status && it.status.toLowerCase() === 'todo') c.what.push(`status ${was.status}→${it.status}`);
      if (it.comments > was.comments) {
        c.newComments = it.comments - was.comments;
        c.what.push(`comments +${String(c.newComments)}`);
      }
    }
    if (c.what.length) out.push(c);
  }
  return out;
}

// ---- sources ----

export interface GhCommenter {
  login: string;
  assoc: string;
}

type FetchLike = (url: string, init: { headers: Record<string, string> }) => Promise<{ status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;

export interface GhCache {
  etags: Record<string, string>;
  bodies: Record<string, unknown>;
}

interface RawIssue {
  number?: number | undefined;
  state?: string | undefined;
  title?: string | undefined;
  comments?: number | undefined;
  user?: { login?: string | undefined } | null | undefined;
  author_association?: string | undefined;
  pull_request?: unknown;
  head?: { sha?: string | undefined } | undefined;
}

/** GitHub PRs and issues of one repo, the 50 most recently updated, with ETags. */
export class GithubSource {
  constructor(
    private readonly o: { repo: string; token: () => Promise<string>; fetch: FetchLike; cache: GhCache; api?: string },
  ) {}

  /** GET with If-None-Match; only the reduced form is cached (and saved in the state file), never bodies. */
  private async get(path: string, reduce: (body: unknown) => RawIssue[]): Promise<RawIssue[]> {
    const url = `${this.o.api ?? 'https://api.github.com'}${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.o.token()}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'calab-claude-bot',
    };
    const etag = this.o.cache.etags[path];
    if (etag && path in this.o.cache.bodies) headers['if-none-match'] = etag;
    const r = await this.o.fetch(url, { headers });
    if (r.status === 304) return this.o.cache.bodies[path] as RawIssue[];
    if (r.status !== 200) throw new Error(`github ${path}: HTTP ${String(r.status)}`);
    const body = reduce(await r.json());
    const tag = r.headers.get('etag');
    if (tag) this.o.cache.etags[path] = tag;
    this.o.cache.bodies[path] = body;
    return body;
  }

  async items(): Promise<Record<string, GhItem>> {
    const list = (b: unknown): RawIssue[] => (Array.isArray(b) ? (b as RawIssue[]) : []);
    const issues = await this.get(`/repos/${this.o.repo}/issues?state=all&sort=updated&direction=desc&per_page=50`, (b) =>
      list(b).map((i) => ({
        number: i.number,
        state: i.state,
        title: (i.title ?? '').slice(0, 200),
        comments: i.comments,
        user: { login: i.user?.login ?? '' },
        author_association: i.author_association ?? '',
        pull_request: i.pull_request ? true : undefined,
      })),
    );
    const pulls = await this.get(`/repos/${this.o.repo}/pulls?state=open&sort=updated&direction=desc&per_page=50`, (b) =>
      list(b).map((p) => ({ number: p.number, head: { sha: p.head?.sha ?? '' } })),
    );
    const sha = new Map(pulls.map((p) => [p.number, p.head?.sha]));
    const out: Record<string, GhItem> = {};
    for (const i of issues) {
      if (typeof i.number !== 'number') continue;
      const kind = i.pull_request ? 'pr' : 'issue';
      const s = sha.get(i.number);
      out[`${kind}#${String(i.number)}`] = {
        kind,
        state: i.state ?? '',
        title: (i.title ?? '').slice(0, 200),
        comments: i.comments ?? 0,
        ...(s ? { sha: s } : {}),
        author: i.user?.login ?? '',
        ...(i.author_association ? { assoc: i.author_association } : {}),
      };
    }
    return out;
  }

  /** Authors (login, association) of the comments on issue/PR `n` updated since `since`. */
  async commentAuthors(n: string, since: string): Promise<GhCommenter[]> {
    const url = `${this.o.api ?? 'https://api.github.com'}/repos/${this.o.repo}/issues/${n}/comments?since=${encodeURIComponent(since)}&per_page=100`;
    const r = await this.o.fetch(url, { headers: { authorization: `Bearer ${await this.o.token()}`, accept: 'application/vnd.github+json', 'user-agent': 'calab-claude-bot' } });
    if (r.status !== 200) throw new Error(`github comments #${n}: HTTP ${String(r.status)}`);
    return ((await r.json()) as { user?: { login?: string } | null; author_association?: string }[]).map((c) => ({ login: c.user?.login ?? '', assoc: c.author_association ?? '' }));
  }
}

// ---- the poller ----

export interface PollState {
  baseline: Snapshot | null;
  current: Snapshot | null;
  gh: GhCache;
}

export const emptyPollState = (): PollState => ({ baseline: null, current: null, gh: { etags: {}, bodies: {} } });

export interface PollerDeps {
  ghItems: () => Promise<Record<string, GhItem>>;
  boardItems: () => Promise<Record<string, BoardItem>>;
  /** GitHub authors of the comments on item `n` since an ISO time. */
  ghCommentAuthors: (n: string, since: string) => Promise<GhCommenter[]>;
  /** Author ids of the newest `count` messages of a task room. */
  boardCommentAuthors: (roomId: string, count: number) => Promise<string[]>;
  actors: () => Actors;
  log?: (m: string) => void;
}

type Others = 'none' | 'outsider' | 'insider';

export class Poller {
  /** Comment checks already made: `key@count` → who else wrote. */
  private readonly checked = new Map<string, Others>();

  constructor(
    readonly state: PollState,
    private readonly d: PollerDeps,
  ) {}

  /** Fetches both sources; a failing source keeps its previous part (no spurious change). */
  async refresh(now: Date): Promise<Snapshot> {
    const prev = this.state.current;
    let gh = prev?.gh ?? null;
    let board = prev?.board ?? null;
    try {
      gh = await this.d.ghItems();
    } catch (err) {
      this.d.log?.(`github poll failed: ${(err as Error).message}`);
    }
    try {
      board = await this.d.boardItems();
    } catch (err) {
      this.d.log?.(`board poll failed: ${(err as Error).message}`);
    }
    // A source never fetched yet takes the baseline's part, so it cannot look like "all new".
    const snap: Snapshot = { at: now.toISOString(), gh: gh ?? this.state.baseline?.gh ?? {}, board: board ?? this.state.baseline?.board ?? {} };
    this.state.current = snap;
    return snap;
  }

  /** What changed since the baseline. The first poll ever only sets the baseline. */
  async changes(now: Date): Promise<Change[]> {
    const cur = await this.refresh(now);
    const base = this.state.baseline;
    if (!base) {
      this.state.baseline = cur;
      return [];
    }
    const actors = this.d.actors();
    const out: Change[] = [];
    for (const c of diffSnapshots(base, cur, actors)) {
      if (c.newComments > 0) {
        const others = await this.othersCommented(c, base.at, actors);
        if (others === 'none') {
          c.what = c.what.filter((w) => !w.startsWith('comments +'));
          if (c.what.length === 0) continue;
        } else if (others === 'insider') c.trusted = true;
      }
      out.push(c);
    }
    return out;
  }

  private async othersCommented(c: Change, since: string, actors: Actors): Promise<Others> {
    const k = `${c.key}@${String(c.newComments)}@${since}`;
    const hit = this.checked.get(k);
    if (hit !== undefined) return hit;
    let others: Others = 'outsider'; // when the check fails, count it (better a wake than a missed question)
    try {
      if (c.source === 'github') {
        const rest = (await this.d.ghCommentAuthors(c.ref, since)).filter((x) => !isSelfGh(x.login, actors) && !actors.ignoreAuthors.has(x.login.toLowerCase()));
        others = rest.length === 0 ? 'none' : rest.some((x) => TRUSTED_ASSOC.has(x.assoc)) ? 'insider' : 'outsider';
      } else {
        const ids = await this.d.boardCommentAuthors(c.ref, Math.min(c.newComments, 50));
        others = ids.some((id) => id !== actors.botId) ? 'insider' : 'none';
      }
    } catch (err) {
      this.d.log?.(`comment check ${c.key} failed: ${(err as Error).message}`);
    }
    this.checked.set(k, others);
    return others;
  }

  /** After a wake run: the new state is the baseline, so the run's own comments do not wake it again. */
  async rebaseline(now: Date): Promise<void> {
    this.state.baseline = await this.refresh(now);
    this.checked.clear();
  }
}
