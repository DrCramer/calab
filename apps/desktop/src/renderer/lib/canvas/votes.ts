/**
 * Voting on a canvas (ADR-0116, wave 3). The document carries `meta.vote = {id, by, startedAt, votesPerPerson,
 * open}` and the top-level `votes: Y.Map<objectId, Y.Map<userId, number>>`. Everyone writes only their own cell
 * `votes[objectId][userId]`, so concurrent votes add up with nothing lost; a new session, a reset and the finish
 * are single transactions of a writer. Both fields are optional: a build without them draws the canvas as before
 * and does not touch them.
 *
 * Reading rules: while a vote is open only my own count is visible; once it is finished every object shows the
 * total and the leader(s) are marked. A vote for an object that no longer exists (or is not a sticky/shape) counts
 * for nothing: it is not in the totals, the leaders or the voter's «used» number.
 *
 * Yjs cannot merge two `votes.set(objectId, new Y.Map())` made at once for the same object — one map wins and the
 * other voter's cell goes with the losing one. Every client therefore remembers what it wrote into its own cells
 * during the open session (`intent`) and writes a cell back when a remote update replaced it.
 */
import * as Y from 'yjs';
import { newId } from './doc';

export const VOTE_DEFAULT = 5;
export const VOTE_MIN = 1;
export const VOTE_MAX = 20;

/** Transaction origin of vote writes: not the canvas UndoManager's, so voting is not undoable. */
export const VOTE_ORIGIN = 'canvas-vote';

export interface VoteSession {
  readonly id: string;
  readonly by: string;
  readonly startedAt: number;
  readonly votesPerPerson: number;
  readonly open: boolean;
}

export type VotePhase = 'none' | 'open' | 'closed';

export interface VoteBadge {
  /** Own votes while the vote is open, the total once it is finished. */
  readonly n: number;
  /** Finished vote: the object has the most votes. */
  readonly leader: boolean;
}

export const clampVotes = (n: number): number => (Number.isFinite(n) ? Math.min(VOTE_MAX, Math.max(VOTE_MIN, Math.round(n))) : VOTE_DEFAULT);

/** `meta.vote` as the doc has it, or null when absent / not well-formed. */
export function parseVoteSession(v: unknown): VoteSession | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id.length === 0 || o.id.length > 64) return null;
  return {
    id: o.id,
    by: typeof o.by === 'string' ? o.by.slice(0, 64) : '',
    startedAt: typeof o.startedAt === 'number' && Number.isFinite(o.startedAt) ? o.startedAt : 0,
    votesPerPerson: clampVotes(typeof o.votesPerPerson === 'number' ? o.votesPerPerson : VOTE_DEFAULT),
    open: o.open === true,
  };
}

const sameSession = (a: VoteSession | null, b: VoteSession | null): boolean =>
  a === b || (!!a && !!b && a.id === b.id && a.open === b.open && a.votesPerPerson === b.votesPerPerson && a.by === b.by && a.startedAt === b.startedAt);

/** One cell: a vote count, bounded so a hostile or broken client cannot swamp the totals. */
const cellValue = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(VOTE_MAX, Math.max(0, Math.floor(v))) : 0);

/** Told which objects' badges may have changed; `null` = everything (a new session, a reset, a finish). */
export type VoteListener = (ids: ReadonlySet<string> | null) => void;

export class VoteBook {
  readonly cells: Y.Map<Y.Map<number>>;
  private readonly meta: Y.Map<unknown>;
  private sess: VoteSession | null;
  /** Totals over all voters, by object id (only entries above 0). */
  private readonly totals = new Map<string, number>();
  /** My own counts as the document has them. */
  private readonly mine = new Map<string, number>();
  /** What I wrote into my cells this session (see the module comment). */
  private readonly intent = new Map<string, number>();
  private leaders = new Set<string>();
  private usedCache: number | null = null;
  private readonly listeners = new Set<VoteListener>();
  private readonly onCells: (events: Y.YEvent<Y.AbstractType<unknown>>[]) => void;
  private readonly onMeta: (e: Y.YMapEvent<unknown>) => void;

  /** `votable(id)`: the object exists and can take votes (a sticky or a shape). `userId` '' = a reader without an identity: never votes. */
  constructor(
    private readonly ydoc: Y.Doc,
    private readonly userId: string,
    private readonly votable: (id: string) => boolean,
    /** False while the canvas is read-only: the background clean-ups (`purgeOwn`, `repair`) write nothing then. */
    private readonly canWrite: () => boolean = () => true,
  ) {
    this.cells = ydoc.getMap<Y.Map<number>>('votes');
    this.meta = ydoc.getMap<unknown>('meta');
    this.sess = parseVoteSession(this.meta.get('vote'));
    for (const id of this.cells.keys()) this.recompute(id);
    this.leaders = this.computeLeaders();
    this.onMeta = (e) => {
      if (e.keysChanged.has('vote')) this.syncSession();
    };
    this.onCells = (events) => {
      this.syncSession();
      const ids = new Set<string>();
      for (const ev of events) {
        if (ev.target === this.cells) for (const k of (ev as Y.YMapEvent<Y.Map<number>>).keysChanged) ids.add(String(k));
        else {
          const key = ev.path[0];
          if (typeof key === 'string') ids.add(key);
        }
      }
      this.touched(ids);
      this.repair();
    };
    this.meta.observe(this.onMeta);
    this.cells.observeDeep(this.onCells);
  }

  destroy(): void {
    this.meta.unobserve(this.onMeta);
    this.cells.unobserveDeep(this.onCells);
    this.listeners.clear();
  }

  subscribe(fn: VoteListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(ids: ReadonlySet<string> | null): void {
    if (ids !== null && ids.size === 0) return;
    for (const fn of this.listeners) fn(ids);
  }

  // ── reading ────────────────────────────────────────────────────────────────

  get session(): VoteSession | null {
    return this.sess;
  }

  get phase(): VotePhase {
    return this.sess === null ? 'none' : this.sess.open ? 'open' : 'closed';
  }

  /** Whether anything is stored for voting: the badge pass can skip itself otherwise. */
  get active(): boolean {
    return this.sess !== null;
  }

  /** My votes on an object. */
  own(id: string): number {
    return this.mine.get(id) ?? 0;
  }

  /** Everybody's votes on an object. */
  total(id: string): number {
    return this.totals.get(id) ?? 0;
  }

  /** My votes spent on objects that still take them. */
  used(): number {
    if (this.usedCache === null) {
      let n = 0;
      for (const [id, c] of this.mine) if (this.votable(id)) n += c;
      this.usedCache = n;
    }
    return this.usedCache;
  }

  /** Votes I may still give in the open session; 0 otherwise. */
  left(): number {
    return this.sess?.open ? Math.max(0, this.sess.votesPerPerson - this.used()) : 0;
  }

  /** What to draw on an object right now (see the module comment), null for nothing. */
  badge(id: string): VoteBadge | null {
    const s = this.sess;
    if (!s) return null;
    if (s.open) {
      const n = this.mine.get(id) ?? 0;
      return n > 0 ? { n, leader: false } : null;
    }
    const n = this.totals.get(id) ?? 0;
    return n > 0 ? { n, leader: this.leaders.has(id) } : null;
  }

  /** Objects with the most votes of a finished vote (ties: all of them). */
  leaderIds(): ReadonlySet<string> {
    return this.sess && !this.sess.open ? this.leaders : new Set();
  }

  // ── writing ────────────────────────────────────────────────────────────────

  /** A new session: every vote is cleared and the counting starts, in one transaction. */
  start(votesPerPerson: number): VoteSession {
    const sess: VoteSession = { id: newId(), by: this.userId, startedAt: Date.now(), votesPerPerson: clampVotes(votesPerPerson), open: true };
    this.ydoc.transact(() => {
      for (const k of [...this.cells.keys()]) this.cells.delete(k);
      this.meta.set('vote', sess);
    }, VOTE_ORIGIN);
    return sess;
  }

  /** Closes an open session: the totals become visible to everyone. */
  finish(): boolean {
    const s = this.sess;
    if (!s?.open) return false;
    this.ydoc.transact(() => this.meta.set('vote', { ...s, open: false }), VOTE_ORIGIN);
    return true;
  }

  /** Throws the session and all votes away. */
  reset(): boolean {
    if (!this.sess && this.cells.size === 0) return false;
    this.ydoc.transact(() => {
      for (const k of [...this.cells.keys()]) this.cells.delete(k);
      this.meta.delete('vote');
    }, VOTE_ORIGIN);
    return true;
  }

  /**
   * +1 / −1 of my own vote on an object (my cell only). Refused: no open session, an object that takes no votes,
   * +1 without votes left, −1 without a vote of mine there.
   */
  add(id: string, delta: 1 | -1): boolean {
    const s = this.sess;
    if (!s?.open || !this.userId || !this.votable(id)) return false;
    const cur = this.own(id);
    if (delta > 0 ? this.left() <= 0 || cur >= VOTE_MAX : cur <= 0) return false;
    const next = cur + delta;
    this.intent.set(id, next);
    this.write(id, next);
    return true;
  }

  private write(id: string, n: number): void {
    this.ydoc.transact(() => {
      let cell = this.cells.get(id);
      if (!cell) {
        if (n <= 0) return;
        this.cells.set(id, new Y.Map<number>());
        cell = this.cells.get(id);
      }
      if (!cell) return;
      if (n <= 0) cell.delete(this.userId);
      else cell.set(this.userId, n);
    }, VOTE_ORIGIN);
  }

  // ── keeping the derived numbers ────────────────────────────────────────────

  /** Objects were added, removed or changed their kind: the leaders and my «used» may differ. */
  invalidate(): void {
    this.usedCache = null;
    if (!this.sess) return;
    this.touched(new Set());
  }

  private syncSession(): void {
    const next = parseVoteSession(this.meta.get('vote'));
    const prev = this.sess;
    if (sameSession(prev, next)) return;
    this.sess = next;
    // Whatever I still had in the document from a session that is gone belongs to it, not to the new one.
    if (prev && next?.id !== prev.id) this.purgeOwn();
    if (!next?.open) this.intent.clear();
    this.usedCache = null;
    this.leaders = this.computeLeaders();
    this.emit(null);
  }

  /** Removes my cells from the objects I voted on in the session that just ended (a vote that raced with its restart). */
  private purgeOwn(): void {
    const ids = [...this.intent.keys()].filter((id) => this.cells.get(id)?.has(this.userId));
    this.intent.clear();
    if (ids.length === 0 || !this.userId || !this.canWrite()) return;
    this.ydoc.transact(() => {
      for (const id of ids) this.cells.get(id)?.delete(this.userId);
    }, VOTE_ORIGIN);
  }

  private recompute(id: string): void {
    const cell = this.cells.get(id);
    let total = 0;
    let mine = 0;
    if (cell) {
      cell.forEach((v, user) => {
        const n = cellValue(v);
        total += n;
        if (user === this.userId) mine = n;
      });
    }
    if (total > 0) this.totals.set(id, total);
    else this.totals.delete(id);
    if (mine > 0) this.mine.set(id, mine);
    else this.mine.delete(id);
  }

  private computeLeaders(): Set<string> {
    let best = 0;
    for (const [id, n] of this.totals) if (n > best && this.votable(id)) best = n;
    const out = new Set<string>();
    if (best > 0) for (const [id, n] of this.totals) if (n === best && this.votable(id)) out.add(id);
    return out;
  }

  /** Cells of `ids` changed: refresh their numbers and tell who must repaint (the leaders that moved too). */
  private touched(ids: Set<string>): void {
    for (const id of ids) this.recompute(id);
    this.usedCache = null;
    const before = this.leaders;
    this.leaders = this.computeLeaders();
    for (const id of before) if (!this.leaders.has(id)) ids.add(id);
    for (const id of this.leaders) if (!before.has(id)) ids.add(id);
    this.emit(ids);
  }

  /** Puts my cells back when a remote update replaced the map they lived in. */
  private repair(): void {
    if (!this.sess?.open || !this.userId || this.intent.size === 0 || !this.canWrite()) return;
    for (const [id, n] of this.intent) {
      if (this.own(id) !== n) this.write(id, n);
    }
  }
}
