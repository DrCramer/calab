import { boundsOf } from '../../../lib/canvas/geometry';
import { aabb, isBox, type BoxRec, type ObjectRec } from '../../../lib/canvas/types';
import type { SelFrame } from './overlay';

/**
 * The frame the selection wears: one box → its own (rotated) frame; several → their circumscribed rect, turned
 * never. Handles are offered only where the operation is defined: nothing on a selection with a locked object;
 * resize for one box, or for several that are all unrotated and ungrouped (a group has no resize: its members'
 * frames would shear); rotation for all. Null when no box is selected (a connector alone has its end handles).
 */
export function selectionFrame(recs: readonly ObjectRec[]): SelFrame | null {
  const boxes: BoxRec[] = recs.filter(isBox);
  const first = boxes[0];
  if (!first) return null;
  const locked = recs.some((r) => r.locked);
  if (boxes.length === 1) {
    return { rect: { x: first.x, y: first.y, w: first.w, h: first.h }, rot: first.rot ?? 0, resize: !locked, rotate: !locked, widthOnly: first.kind === 'text' };
  }
  const rect = boundsOf(boxes.map(aabb));
  if (!rect) return null;
  return { rect, rot: 0, resize: !locked && boxes.every((b) => !b.rot && !b.group), rotate: !locked };
}
