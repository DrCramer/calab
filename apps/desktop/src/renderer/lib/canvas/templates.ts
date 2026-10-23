import type { Point, Rect } from './geometry';
import { boundsOf } from './geometry';
import type { ObjectInit } from './types';

/** Built-in starting points for a canvas (ADR-0127): a set of objects inserted at once around a point. */
export const TEMPLATE_IDS = ['kanban', 'retro', 'swot', 'mindmap', 'flow'] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

/** The texts a template writes into its objects: i18n keys, resolved by the caller's `t` (so the code stays language-free). */
export type TemplateKey =
  | 'kanban.todo' | 'kanban.doing' | 'kanban.done' | 'kanban.task'
  | 'retro.good' | 'retro.bad' | 'retro.try' | 'retro.note'
  | 'swot.s' | 'swot.w' | 'swot.o' | 'swot.t'
  | 'mindmap.center' | 'mindmap.branch'
  | 'flow.start' | 'flow.step' | 'flow.decision';

export type TemplateText = (key: TemplateKey, params?: Record<string, string | number>) => string;

export interface TemplateItem {
  id: string;
  init: ObjectInit;
}

const COL_W = 280;
const COL_GAP = 24;
const HEAD_H = 56;
const BODY_H = 440;
const NOTE_W = 232;
const NOTE_H = 132;

/** Column boards (Kanban, retrospective): a header plate and an outlined body per column, stickies on top. */
function columns(
  heads: readonly { key: TemplateKey; fill: string }[],
  note: TemplateKey,
  noteColor: (col: number) => string,
  tr: TemplateText,
  makeId: () => string,
): TemplateItem[] {
  const items: TemplateItem[] = [];
  heads.forEach((h, c) => {
    const x = c * (COL_W + COL_GAP);
    items.push({ id: makeId(), init: { kind: 'shape', shape: 'rect', x, y: HEAD_H + 8, w: COL_W, h: BODY_H, fill: 'none', stroke: 'stroke', strokeWidth: 1 } });
    items.push({ id: makeId(), init: { kind: 'shape', shape: 'rounded', x, y: 0, w: COL_W, h: HEAD_H, fill: h.fill, stroke: h.fill, strokeWidth: 1, text: tr(h.key) } });
  });
  heads.forEach((_, c) => {
    const x = c * (COL_W + COL_GAP) + (COL_W - NOTE_W) / 2;
    for (let n = 0; n < 2; n++) {
      items.push({
        id: makeId(),
        init: { kind: 'sticky', x, y: HEAD_H + 8 + 20 + n * (NOTE_H + 20), w: NOTE_W, h: NOTE_H, color: noteColor(c), text: tr(note, { n: n + 1 }) },
      });
    }
  });
  return items;
}

function swot(tr: TemplateText, makeId: () => string): TemplateItem[] {
  const W = 380;
  const H = 300;
  const GAP = 24;
  const quads: { key: TemplateKey; fill: string }[] = [
    { key: 'swot.s', fill: 'green' }, { key: 'swot.w', fill: 'red' },
    { key: 'swot.o', fill: 'blue' }, { key: 'swot.t', fill: 'orange' },
  ];
  const items: TemplateItem[] = [];
  quads.forEach((q, i) => {
    const x = (i % 2) * (W + GAP);
    const y = Math.floor(i / 2) * (HEAD_H + 8 + H + GAP);
    items.push({ id: makeId(), init: { kind: 'shape', shape: 'rect', x, y: y + HEAD_H + 8, w: W, h: H, fill: 'none', stroke: 'stroke', strokeWidth: 1 } });
    items.push({ id: makeId(), init: { kind: 'shape', shape: 'rounded', x, y, w: W, h: HEAD_H, fill: q.fill, stroke: q.fill, strokeWidth: 1, text: tr(q.key) } });
  });
  return items;
}

function mindmap(tr: TemplateText, makeId: () => string): TemplateItem[] {
  const cw = 240;
  const ch = 120;
  const bw = 200;
  const bh = 80;
  const gap = 120;
  const center: TemplateItem = { id: makeId(), init: { kind: 'shape', shape: 'ellipse', x: bw + gap, y: bh + gap, w: cw, h: ch, fill: 'blue', stroke: 'blue', strokeWidth: 1, text: tr('mindmap.center') } };
  // Branches: top, right, bottom, left of the center, each wired side to opposite side.
  const spots: { x: number; y: number; from: 'top' | 'right' | 'bottom' | 'left'; to: 'top' | 'right' | 'bottom' | 'left'; fill: string }[] = [
    { x: bw + gap + (cw - bw) / 2, y: 0, from: 'top', to: 'bottom', fill: 'green' },
    { x: bw + gap + cw + gap, y: bh + gap + (ch - bh) / 2, from: 'right', to: 'left', fill: 'orange' },
    { x: bw + gap + (cw - bw) / 2, y: bh + gap + ch + gap, from: 'bottom', to: 'top', fill: 'purple' },
    { x: 0, y: bh + gap + (ch - bh) / 2, from: 'left', to: 'right', fill: 'pink' },
  ];
  const items: TemplateItem[] = [center];
  spots.forEach((s, i) => {
    const id = makeId();
    items.push({ id, init: { kind: 'shape', shape: 'rounded', x: s.x, y: s.y, w: bw, h: bh, fill: s.fill, stroke: s.fill, strokeWidth: 1, text: tr('mindmap.branch', { n: i + 1 }) } });
    items.push({
      id: makeId(),
      init: { kind: 'connector', from: { id: center.id, side: s.from }, to: { id, side: s.to }, arrow: 'none', route: 'straight', stroke: 'stroke', strokeWidth: 2 },
    });
  });
  return items;
}

function flow(tr: TemplateText, makeId: () => string): TemplateItem[] {
  const w = 200;
  const gap = 120;
  const a = { id: makeId(), init: { kind: 'shape', shape: 'ellipse', x: 0, y: 10, w, h: 90, fill: 'green', stroke: 'green', strokeWidth: 1, text: tr('flow.start') } } as const;
  const b = { id: makeId(), init: { kind: 'shape', shape: 'rounded', x: w + gap, y: 10, w, h: 90, fill: 'blue', stroke: 'blue', strokeWidth: 1, text: tr('flow.step') } } as const;
  const c = { id: makeId(), init: { kind: 'shape', shape: 'diamond', x: 2 * (w + gap), y: 0, w, h: 110, fill: 'orange', stroke: 'orange', strokeWidth: 1, text: tr('flow.decision') } } as const;
  const wire = (from: string, to: string): TemplateItem => ({
    id: makeId(),
    init: { kind: 'connector', from: { id: from, side: 'right' }, to: { id: to, side: 'left' }, arrow: 'end', route: 'elbow', stroke: 'stroke', strokeWidth: 2 },
  });
  return [a, b, c, wire(a.id, b.id), wire(b.id, c.id)];
}

/** Objects of a template in local coordinates (origin at its top-left), ids made by `makeId`. */
function layout(id: TemplateId, tr: TemplateText, makeId: () => string): TemplateItem[] {
  switch (id) {
    case 'kanban':
      return columns(
        [{ key: 'kanban.todo', fill: 'gray' }, { key: 'kanban.doing', fill: 'blue' }, { key: 'kanban.done', fill: 'green' }],
        'kanban.task', () => 'yellow', tr, makeId,
      );
    case 'retro':
      return columns(
        [{ key: 'retro.good', fill: 'green' }, { key: 'retro.bad', fill: 'red' }, { key: 'retro.try', fill: 'blue' }],
        'retro.note', (c) => (['green', 'coral', 'sky'] as const)[c] ?? 'yellow', tr, makeId,
      );
    case 'swot':
      return swot(tr, makeId);
    case 'mindmap':
      return mindmap(tr, makeId);
    case 'flow':
      return flow(tr, makeId);
  }
}

const boxOf = (init: ObjectInit): Rect | null => {
  if (init.kind === 'connector') return null;
  return { x: init.x, y: init.y, w: init.w ?? 160, h: init.kind === 'sticky' || init.kind === 'shape' ? (init.h ?? 100) : 100 };
};

/**
 * The objects of template `id` centered on `center` (connectors glued to their shapes by id). The texts come from
 * `tr`; `makeId` supplies the ids the connectors refer to. One list = one `createMany` = one undo step.
 */
export function buildTemplate(id: TemplateId, center: Point, tr: TemplateText, makeId: () => string): TemplateItem[] {
  const local = layout(id, tr, makeId);
  const b = boundsOf(local.flatMap((i) => boxOf(i.init) ?? []));
  const dx = center.x - (b ? b.x + b.w / 2 : 0);
  const dy = center.y - (b ? b.y + b.h / 2 : 0);
  return local.map(({ id: oid, init }) => (init.kind === 'connector' ? { id: oid, init } : { id: oid, init: { ...init, x: init.x + dx, y: init.y + dy } }));
}
