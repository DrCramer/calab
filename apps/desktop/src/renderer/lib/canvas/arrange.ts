/** Align and distribute (ADR-0114 §Волна 1): pure math over "units" — a free object or a whole group moves as one. */
import { boundsOf, type Rect } from './geometry';
import { aabb, isBox, type ObjectRec } from './types';

export type ArrangeOp = 'left' | 'hcenter' | 'right' | 'top' | 'vmiddle' | 'bottom' | 'hspace' | 'vspace';

export const ALIGN_OPS: readonly ArrangeOp[] = ['left', 'hcenter', 'right', 'top', 'vmiddle', 'bottom'];
export const DISTRIBUTE_OPS: readonly ArrangeOp[] = ['hspace', 'vspace'];

/** Things that move together; `rect` is the circumscribed rect of their boxes (rotated ones by their bounds). */
export interface ArrangeUnit {
  /** All members, connectors included (the ones with free ends are shifted too). */
  ids: readonly string[];
  rect: Rect;
}

/**
 * The units of a selection: every unlocked box alone, a group as one unit while the selection holds all its
 * members. Locked objects — and a group with a locked member — are not units: they do not move.
 * `groupSize(g)` is the member count of a group (the selection must hold that many).
 */
export function arrangeUnits(objs: readonly ObjectRec[], groupSize: (gid: string) => number): ArrangeUnit[] {
  const byGroup = new Map<string, ObjectRec[]>();
  const loose: ObjectRec[] = [];
  for (const o of objs) {
    if (o.group !== undefined) {
      const list = byGroup.get(o.group);
      if (list) list.push(o);
      else byGroup.set(o.group, [o]);
    } else loose.push(o);
  }
  const out: ArrangeUnit[] = [];
  const add = (members: readonly ObjectRec[]): void => {
    if (members.some((m) => m.locked)) return;
    const rect = boundsOf(members.filter(isBox).map(aabb));
    if (rect) out.push({ ids: members.map((m) => m.id), rect });
  };
  for (const o of loose) add([o]);
  for (const [gid, members] of byGroup) {
    if (members.length >= groupSize(gid)) add(members);
    else for (const m of members) add([m]);
  }
  return out;
}

/** Translation per unit (same order) that performs `op`; null when it does not apply (too few units). */
export function arrangeDeltas(units: readonly ArrangeUnit[], op: ArrangeOp): { dx: number; dy: number }[] | null {
  const distribute = op === 'hspace' || op === 'vspace';
  if (units.length < (distribute ? 3 : 2)) return null;
  const all = boundsOf(units.map((u) => u.rect));
  if (!all) return null;
  const per = (f: (r: Rect) => [number, number]): { dx: number; dy: number }[] =>
    units.map((u) => {
      const [dx, dy] = f(u.rect);
      return { dx, dy };
    });
  switch (op) {
    case 'left': return per((r) => [all.x - r.x, 0]);
    case 'right': return per((r) => [all.x + all.w - (r.x + r.w), 0]);
    case 'hcenter': return per((r) => [all.x + all.w / 2 - (r.x + r.w / 2), 0]);
    case 'top': return per((r) => [0, all.y - r.y]);
    case 'bottom': return per((r) => [0, all.y + all.h - (r.y + r.h)]);
    case 'vmiddle': return per((r) => [0, all.y + all.h / 2 - (r.y + r.h / 2)]);
    case 'hspace':
    case 'vspace': {
      const h = op === 'hspace';
      const lo = (r: Rect): number => (h ? r.x : r.y);
      const len = (r: Rect): number => (h ? r.w : r.h);
      // Order by center, then equal gaps between neighbours across the whole span.
      const order = units.map((u, i) => ({ i, c: lo(u.rect) + len(u.rect) / 2 })).sort((a, b) => a.c - b.c || a.i - b.i);
      const gap = (len(all) - units.reduce((n, u) => n + len(u.rect), 0)) / (units.length - 1);
      const out = units.map(() => ({ dx: 0, dy: 0 }));
      let at = lo(all);
      for (const { i } of order) {
        const r = units[i]?.rect;
        const slot = out[i];
        if (!r || !slot) continue;
        if (h) slot.dx = at - lo(r);
        else slot.dy = at - lo(r);
        at += len(r) + gap;
      }
      return out;
    }
  }
}
