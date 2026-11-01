import { describe, expect, it } from 'vitest';
import { NO_MARKS, addMark, afterFlush, planFlush } from './readMarker';

const A = '019a0000-0000-7000-8000-000000000001';
const B = '019a0000-0000-7000-8000-000000000002';
const C = '019a0000-0000-7000-8000-000000000003';

describe('read markers (ADR-0140)', () => {
  it('moves only forward; seen implies read', () => {
    const p = addMark(addMark(NO_MARKS, B, true), A, true);
    expect(p).toEqual({ read: B, seen: B });
    expect(addMark(p, A, false)).toBe(p); // nothing moved: the same object
    expect(addMark(p, C, false)).toEqual({ read: C, seen: B });
  });

  it('one seen request moves both markers', () => {
    expect(planFlush(NO_MARKS, { read: B, seen: B })).toEqual([{ messageId: B, seen: true }]);
  });

  it('a plain «mark as read» never claims seen', () => {
    expect(planFlush(NO_MARKS, { read: B, seen: '' })).toEqual([{ messageId: B, seen: false }]);
  });

  it('seen part first, then the read-only rest', () => {
    expect(planFlush(NO_MARKS, { read: C, seen: A })).toEqual([
      { messageId: A, seen: true },
      { messageId: C, seen: false },
    ]);
  });

  it('sends nothing already sent', () => {
    expect(planFlush({ read: C, seen: B }, { read: B, seen: B })).toEqual([]);
    // Read already further (marked from the sidebar), now seen: only the seen request.
    expect(planFlush({ read: C, seen: '' }, { read: B, seen: B })).toEqual([{ messageId: B, seen: true }]);
  });

  it('afterFlush keeps the maxima', () => {
    expect(afterFlush({ read: C, seen: '' }, { read: B, seen: B })).toEqual({ read: C, seen: B });
    expect(afterFlush(NO_MARKS, { read: C, seen: A })).toEqual({ read: C, seen: A });
  });
});
