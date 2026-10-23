import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { canvasDocUserKey, sha256 } from './docUser';
import { startTimer } from './timer';
import { VoteBook } from './votes';

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

describe('sha256', () => {
  it('matches WebCrypto across block boundaries', async () => {
    for (const n of [0, 1, 3, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      const msg = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 0xff);
      expect(hex(sha256(msg))).toBe(hex(new Uint8Array(await crypto.subtle.digest('SHA-256', msg))));
    }
    expect(hex(sha256(new TextEncoder().encode('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('canvasDocUserKey', () => {
  const user = '0192a8c4-7f3e-7b21-9c55-3d1e2f4a5b6c';
  const canvas = '0192a8c4-0000-7000-8000-000000000001';

  it('is stable per member and canvas, differs across canvases, empty without an identity', () => {
    const k = canvasDocUserKey(canvas, user);
    expect(k).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(canvasDocUserKey(canvas, user)).toBe(k);
    expect(canvasDocUserKey('0192a8c4-0000-7000-8000-000000000002', user)).not.toBe(k);
    expect(canvasDocUserKey(canvas, '0192a8c4-7f3e-7b21-9c55-3d1e2f4a5b6d')).not.toBe(k);
    expect(canvasDocUserKey(canvas, '')).toBe('');
  });

  // What an anonymous viewer of a public link receives is the whole document: after a vote, a cast and the timer
  // it carries the members' keys, never their ids; the member still sees their own votes.
  it('keeps member ids out of the document a viewer gets, voting still works', () => {
    const doc = new Y.Doc();
    const key = canvasDocUserKey(canvas, user);
    const book = new VoteBook(doc, key, () => true);
    book.start(3);
    expect(book.add('sticky-1', 1)).toBe(true);
    expect(book.add('sticky-1', 1)).toBe(true);
    startTimer(doc.getMap('meta'), 5, key, Date.now());
    expect(book.own('sticky-1')).toBe(2);
    expect(book.left()).toBe(1);

    const viewer = new Y.Doc();
    Y.applyUpdate(viewer, Y.encodeStateAsUpdate(doc));
    const json = JSON.stringify([viewer.getMap('votes').toJSON(), viewer.getMap('meta').toJSON()]);
    expect(json).not.toContain(user);
    expect(json).toContain(key);
    expect(new TextDecoder().decode(Y.encodeStateAsUpdate(doc))).not.toContain(user);

    // The same member on another device writes into the same cell (one budget).
    const again = new VoteBook(viewer, canvasDocUserKey(canvas, user), () => true);
    expect(again.own('sticky-1')).toBe(2);
    expect(again.left()).toBe(1);
  });
});
