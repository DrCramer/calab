import { CANVAS_BITS } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { bodyParts, commentRights, mayChange, mentionCount, pinAt, pinWorld } from './comments';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('canvas comments, the pure part (ADR-0116 wave 4)', () => {
  it('a pin follows its object; on the field it is the point itself; a gone object hides it', () => {
    const objects: Record<string, { x: number; y: number }> = { o: { x: 100, y: 50 } };
    expect(pinWorld({ objectId: 'o', x: 5, y: -3 }, (id) => objects[id])).toEqual({ x: 105, y: 47 });
    expect(pinWorld({ objectId: '', x: 5, y: -3 }, () => undefined)).toEqual({ x: 5, y: -3 });
    expect(pinWorld({ objectId: 'gone', x: 5, y: -3 }, (id) => objects[id])).toBeNull();
    expect(pinAt({ x: 120, y: 60 }, { id: 'o', x: 100, y: 50 })).toEqual({ objectId: 'o', x: 20, y: 10 });
    expect(pinAt({ x: 120, y: 60 }, undefined)).toEqual({ objectId: '', x: 120, y: 60 });
  });

  it('rights: VIEW reads, WRITE writes, the owner and MANAGE moderate', () => {
    const view = CANVAS_BITS.VIEW;
    const write = view | CANVAS_BITS.WRITE;
    expect(commentRights(view, B, A)).toEqual({ write: false, moderate: false });
    expect(commentRights(write, B, A)).toEqual({ write: true, moderate: false });
    expect(commentRights(view, A, A)).toEqual({ write: false, moderate: true });
    expect(commentRights(write | CANVAS_BITS.MANAGE, B, A)).toEqual({ write: true, moderate: true });
    expect(commentRights(0n, A, A).moderate).toBe(false);
    // The author edits their own with WRITE only; a moderator anyone's.
    expect(mayChange({ authorId: A }, { write: true, moderate: false }, A)).toBe(true);
    expect(mayChange({ authorId: A }, { write: false, moderate: false }, A)).toBe(false);
    expect(mayChange({ authorId: B }, { write: true, moderate: false }, A)).toBe(false);
    expect(mayChange({ authorId: B }, { write: false, moderate: true }, A)).toBe(true);
    expect(mayChange({ authorId: '' }, { write: true, moderate: false }, '')).toBe(false);
  });

  it('the body shows mentions as names, unknown ids stay text', () => {
    const names: Record<string, string> = { [A]: 'Анна' };
    expect(bodyParts(`hi @${A}, and @${B}!`, (id) => names[id])).toEqual([
      { kind: 'text', text: 'hi ' },
      { kind: 'mention', id: A, name: 'Анна' },
      { kind: 'text', text: `, and @${B}!` },
    ]);
    expect(mentionCount(`@${A} @${A.toUpperCase()} @${B} mail@x`)).toBe(2);
  });
});
