/**
 * Canvas comments, the pure part (ADR-0127 wave 4): where a pin is, who may do what (the server decides;
 * this only hides what it would refuse), the text with mentions as names. No React, no stores.
 */
import { CANVAS_BITS, type CanvasComment } from '@calaba/protocol';
import type { Point } from './geometry';
import type { ObjectRec } from './types';

/** The world point of a thread's pin: on its object (offset from the object's corner) or on the field. Null: the object is gone. */
export function pinWorld(c: Pick<CanvasComment, 'objectId' | 'x' | 'y'>, objectOf: (id: string) => Pick<ObjectRec, 'x' | 'y'> | undefined): Point | null {
  if (!c.objectId) return { x: c.x, y: c.y };
  const o = objectOf(c.objectId);
  return o ? { x: o.x + c.x, y: o.y + c.y } : null;
}

/** The pin of a click of the «Комментарий» tool: the offset from the object's corner, or the point on the field. */
export function pinAt(world: Point, object: Pick<ObjectRec, 'id' | 'x' | 'y'> | undefined): { objectId: string; x: number; y: number } {
  return object ? { objectId: object.id, x: world.x - object.x, y: world.y - object.y } : { objectId: '', x: world.x, y: world.y };
}

export interface CommentRights {
  /** CANVAS_WRITE: write, reply, resolve. */
  write: boolean;
  /** The owner of the canvas or CANVAS_MANAGE: edit and delete anyone's. */
  moderate: boolean;
}

/** What the caller may do with the comments of a canvas, from its `my_bits` and owner. */
export function commentRights(bits: bigint, ownerId: string, me: string): CommentRights {
  const view = (bits & CANVAS_BITS.VIEW) !== 0n;
  return {
    write: (bits & CANVAS_BITS.WRITE) !== 0n,
    moderate: view && ((bits & CANVAS_BITS.MANAGE) !== 0n || (!!me && ownerId === me)),
  };
}

/** Edit / delete one comment: the author with CANVAS_WRITE, or a moderator. */
export function mayChange(c: Pick<CanvasComment, 'authorId'>, r: CommentRights, me: string): boolean {
  return r.moderate || (r.write && !!me && c.authorId === me);
}

export type BodyPart = { kind: 'text'; text: string } | { kind: 'mention'; id: string; name: string };

const MENTION = /@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![A-Za-z0-9_])/gi;

/** The body split into text and mentions (`@<id>` → the member's name; an unknown id stays text). */
export function bodyParts(body: string, nameOf: (id: string) => string | undefined): BodyPart[] {
  const out: BodyPart[] = [];
  let last = 0;
  for (const m of body.matchAll(MENTION)) {
    const id = (m[1] ?? '').toLowerCase();
    const name = nameOf(id);
    const at = m.index;
    if (!name) continue;
    if (at > last) out.push({ kind: 'text', text: body.slice(last, at) });
    out.push({ kind: 'mention', id, name });
    last = at + m[0].length;
  }
  if (last < body.length) out.push({ kind: 'text', text: body.slice(last) });
  return out;
}

/** Distinct `@<id>` in a wire text (the server's count for its limit of 10, roughly: code spans included). */
export function mentionCount(wire: string): number {
  return new Set([...wire.matchAll(MENTION)].map((m) => (m[1] ?? '').toLowerCase())).size;
}
