import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { VOTE_DEFAULT, VOTE_MAX, VoteBook, clampVotes, parseVoteSession, type VoteBook as Book } from './votes';

const ALL = new Set(['a', 'b', 'c']);
const book = (userId: string, doc = new Y.Doc(), exists: Set<string> = ALL): Book => new VoteBook(doc, userId, (id) => exists.has(id));

/** Two replicas of one document, joined by a manual relay (nothing travels until `sync`). */
function pair(userA = 'ann', userB = 'bob', exists = ALL): { a: Book; b: Book; da: Y.Doc; db: Y.Doc; sync: () => void } {
  const da = new Y.Doc();
  const db = new Y.Doc();
  const sync = (): void => {
    for (let i = 0; i < 3; i++) {
      Y.applyUpdate(db, Y.encodeStateAsUpdate(da, Y.encodeStateVector(db)));
      Y.applyUpdate(da, Y.encodeStateAsUpdate(db, Y.encodeStateVector(da)));
    }
  };
  return { a: book(userA, da, exists), b: book(userB, db, exists), da, db, sync };
}

describe('session document field', () => {
  it('reads meta.vote and clamps the limits; garbage is no session', () => {
    expect(parseVoteSession({ id: 'v1', by: 'u', startedAt: 5, votesPerPerson: 3, open: true })).toEqual({ id: 'v1', by: 'u', startedAt: 5, votesPerPerson: 3, open: true });
    expect(parseVoteSession({ id: 'v1', votesPerPerson: 99, open: true })?.votesPerPerson).toBe(VOTE_MAX);
    expect(parseVoteSession({ id: 'v1', votesPerPerson: 0 })?.votesPerPerson).toBe(1);
    expect(parseVoteSession({ id: 'v1', votesPerPerson: 'x' })?.votesPerPerson).toBe(VOTE_DEFAULT);
    expect(parseVoteSession({ id: 'v1' })?.open).toBe(false);
    for (const bad of [null, 5, 'x', {}, { id: '' }, { id: 7 }]) expect(parseVoteSession(bad)).toBeNull();
    expect(clampVotes(NaN)).toBe(VOTE_DEFAULT);
  });

  it('a document without voting reads as none and badges nothing', () => {
    const b = book('ann');
    expect(b.phase).toBe('none');
    expect(b.active).toBe(false);
    expect(b.badge('a')).toBeNull();
    expect(b.left()).toBe(0);
    expect(b.add('a', 1)).toBe(false);
  });
});

describe('a person’s votes', () => {
  it('are limited per person; taking one back frees it; a cell never goes below 0', () => {
    const b = book('ann');
    b.start(3);
    expect(b.left()).toBe(3);
    expect(b.add('a', 1)).toBe(true);
    expect(b.add('a', 1)).toBe(true);
    expect(b.add('b', 1)).toBe(true);
    expect(b.left()).toBe(0);
    expect(b.add('c', 1)).toBe(false);
    expect(b.add('a', 1)).toBe(false);
    expect(b.own('a')).toBe(2);
    expect(b.add('a', -1)).toBe(true);
    expect(b.left()).toBe(1);
    expect(b.add('c', -1)).toBe(false);
    expect(b.add('a', -1)).toBe(true);
    expect(b.add('a', -1)).toBe(false);
    expect(b.own('a')).toBe(0);
    // an emptied cell is gone from the document
    expect(b.cells.get('a')?.has('ann')).toBe(false);
  });

  it('only stickies and shapes take votes, and only while the vote is open', () => {
    const b = book('ann', new Y.Doc(), new Set(['a']));
    expect(b.add('a', 1)).toBe(false); // no session yet
    b.start(5);
    expect(b.add('gone', 1)).toBe(false);
    expect(b.add('a', 1)).toBe(true);
    b.finish();
    expect(b.add('a', 1)).toBe(false);
    expect(b.add('a', -1)).toBe(false);
  });

  it('a reader without an identity never votes', () => {
    const d = new Y.Doc();
    book('ann', d).start(5);
    const r = new VoteBook(d, '', () => true);
    expect(r.add('a', 1)).toBe(false);
  });

  it('votes for deleted objects are ignored: not in the used count, the totals shown, or the leaders', () => {
    const exists = new Set(['a', 'b']);
    const b = book('ann', new Y.Doc(), exists);
    b.start(3);
    b.add('a', 1);
    b.add('a', 1);
    b.add('b', 1);
    expect(b.left()).toBe(0);
    exists.delete('a');
    b.invalidate();
    expect(b.left()).toBe(2);
    b.finish();
    expect([...b.leaderIds()]).toEqual(['b']);
  });
});

describe('who sees what', () => {
  it('while open only my own votes show; once finished everybody’s totals show and the leaders are marked', () => {
    const { a, b, sync } = pair();
    a.start(5);
    sync();
    a.add('a', 1);
    a.add('a', 1);
    b.add('a', 1);
    for (let i = 0; i < 4; i++) b.add('b', 1);
    sync();
    expect(a.badge('a')).toEqual({ n: 2, leader: false });
    expect(a.badge('b')).toBeNull(); // Bob's votes are hidden from Ann
    expect(b.badge('a')).toEqual({ n: 1, leader: false });
    expect(b.badge('b')).toEqual({ n: 4, leader: false });
    a.finish();
    sync();
    for (const x of [a, b]) {
      expect(x.phase).toBe('closed');
      expect(x.badge('a')).toEqual({ n: 3, leader: false });
      expect(x.badge('b')).toEqual({ n: 4, leader: true });
      expect(x.badge('c')).toBeNull();
    }
    // a tie marks both
    const t = pair();
    t.a.start(5);
    t.sync();
    t.a.add('a', 1);
    t.b.add('b', 1);
    t.sync();
    t.a.finish();
    t.sync();
    expect([...t.b.leaderIds()].sort()).toEqual(['a', 'b']);
  });

  it('a viewer’s own count is empty, and the finished totals reach them', () => {
    const { a, sync, db } = pair();
    a.start(2);
    a.add('a', 1);
    sync();
    const viewer = new VoteBook(db, 'viewer', () => true);
    expect(viewer.badge('a')).toBeNull();
    a.finish();
    sync();
    expect(viewer.badge('a')).toEqual({ n: 1, leader: true });
  });
});

describe('sessions', () => {
  it('a new session clears every vote in one transaction; reset removes the session too', () => {
    const d = new Y.Doc();
    const b = book('ann', d);
    b.start(5);
    b.add('a', 1);
    b.add('b', 1);
    b.finish();
    let updates = 0;
    d.on('update', () => updates++);
    const s2 = b.start(2);
    expect(updates).toBe(1);
    expect(b.cells.size).toBe(0);
    expect(b.phase).toBe('open');
    expect(b.session).toEqual(s2);
    expect(b.left()).toBe(2);
    expect(b.badge('a')).toBeNull();
    b.add('a', 1);
    updates = 0;
    expect(b.reset()).toBe(true);
    expect(updates).toBe(1);
    expect(b.phase).toBe('none');
    expect(b.cells.size).toBe(0);
    expect(b.reset()).toBe(false);
  });

  it('the other client sees the new session, the cleared votes and the finish', () => {
    const { a, b, sync } = pair();
    a.start(4);
    sync();
    b.add('c', 1);
    sync();
    expect(a.total('c')).toBe(1);
    a.start(3);
    sync();
    expect(b.phase).toBe('open');
    expect(b.session?.votesPerPerson).toBe(3);
    expect(b.total('c')).toBe(0);
    expect(b.left()).toBe(3);
    a.reset();
    sync();
    expect(b.phase).toBe('none');
  });

  it('notifies which objects to repaint: the touched ones and the leaders that moved; everything for a session change', () => {
    const b = book('ann');
    const seen: (string[] | null)[] = [];
    b.subscribe((ids) => seen.push(ids ? [...ids].sort() : null));
    b.start(5);
    expect(seen.at(-1)).toBeNull();
    seen.length = 0;
    b.add('a', 1);
    expect(seen.at(-1)).toContain('a');
    expect(seen.at(-1)).not.toContain('b');
    b.finish();
    expect(seen.at(-1)).toBeNull();
  });
});

describe('concurrent voting', () => {
  it('two people voting at once on one object add up, with nothing lost (own cells only)', () => {
    const { a, b, da, db, sync } = pair();
    a.start(5);
    sync();
    // offline-style: both vote before any update travels, including the very first vote on the object
    a.add('a', 1);
    a.add('a', 1);
    b.add('a', 1);
    b.add('b', 1);
    sync();
    for (const x of [a, b]) {
      expect(x.total('a')).toBe(3);
      expect(x.total('b')).toBe(1);
    }
    expect(a.own('a')).toBe(2);
    expect(b.own('a')).toBe(1);
    expect(a.cells.get('a')?.get('ann')).toBe(2);
    expect(Y.encodeStateAsUpdate(da).length).toBeGreaterThan(0);
    expect(JSON.stringify(da.getMap('votes').toJSON())).toBe(JSON.stringify(db.getMap('votes').toJSON()));
  });

  it('three people, interleaved, converge to the same totals', () => {
    const d1 = new Y.Doc();
    const d2 = new Y.Doc();
    const d3 = new Y.Doc();
    const books = [book('u1', d1), book('u2', d2), book('u3', d3)];
    const docs = [d1, d2, d3];
    books[0]?.start(5);
    const sync = (): void => {
      for (let r = 0; r < 3; r++) {
        for (const x of docs) for (const y of docs) if (x !== y) Y.applyUpdate(y, Y.encodeStateAsUpdate(x, Y.encodeStateVector(y)));
      }
    };
    sync();
    books.forEach((bk) => {
      bk.add('c', 1);
      bk.add('c', 1);
    });
    sync();
    for (const bk of books) expect(bk.total('c')).toBe(6);
    books[0]?.finish();
    sync();
    for (const bk of books) expect(bk.badge('c')).toEqual({ n: 6, leader: true });
  });

  it('does not bring my votes back after somebody reset or restarted while I was offline', () => {
    const { a, b, sync } = pair();
    a.start(5);
    sync();
    b.add('a', 1);
    a.start(5); // Ann restarts: Bob's un-synced vote belongs to the old session
    sync();
    expect(b.session?.id).toBe(a.session?.id);
    expect(b.total('a')).toBe(0);
    expect(a.total('a')).toBe(0);
    a.reset();
    sync();
    expect(b.total('a')).toBe(0);
    expect(b.phase).toBe('none');
  });
});
