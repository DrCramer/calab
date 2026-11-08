import type { Point, Rect } from './geometry';
import { boundsOf } from './geometry';
import { F_BOLD, toggleFlag, toggleList, type Fmt, type ListKind } from './richText';
import { SOFT_PREFIX, type Endpoint, type ObjectInit, type ShapeKind, type Side } from './types';

/**
 * Built-in starting points for a canvas (ADR-0127): a set of objects inserted at once around a point. Each one shows a
 * few of the tool's means — a bold title, a «how to» sticky with a numbered list, locked soft-tone areas the stickies move over,
 * curved and labelled connectors, example content — and stays readable at a glance.
 */
export const TEMPLATE_IDS = ['kanban', 'retro', 'swot', 'mindmap', 'flow', 'matrix', 'roadmap', 'meeting'] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

/** The texts a template writes into its objects: i18n keys, resolved by the caller's `t` (so the code stays language-free). */
export type TemplateKey =
  | 'kanban.title' | 'kanban.howto' | 'kanban.backlog' | 'kanban.doing' | 'kanban.review' | 'kanban.done' | 'kanban.legend'
  | 'kanban.n1' | 'kanban.n2' | 'kanban.n3' | 'kanban.n4' | 'kanban.n5' | 'kanban.n6'
  | 'retro.title' | 'retro.howto' | 'retro.good' | 'retro.bad' | 'retro.try' | 'retro.actions'
  | 'retro.n1' | 'retro.n2' | 'retro.n3' | 'retro.n4' | 'retro.n5' | 'retro.n6' | 'retro.action'
  | 'swot.title' | 'swot.howto' | 'swot.s' | 'swot.w' | 'swot.o' | 'swot.t'
  | 'swot.ns' | 'swot.nw' | 'swot.no' | 'swot.nt' | 'swot.outcome' | 'swot.outcomenote'
  | 'mindmap.howto' | 'mindmap.center' | 'mindmap.b1' | 'mindmap.b2' | 'mindmap.b3' | 'mindmap.b4'
  | 'mindmap.s11' | 'mindmap.s12' | 'mindmap.s21' | 'mindmap.s22' | 'mindmap.s31' | 'mindmap.s32' | 'mindmap.s41' | 'mindmap.s42'
  | 'flow.title' | 'flow.start' | 'flow.receive' | 'flow.check' | 'flow.yes' | 'flow.no' | 'flow.save' | 'flow.ask' | 'flow.end'
  | 'matrix.title' | 'matrix.howto' | 'matrix.value' | 'matrix.effort' | 'matrix.quick' | 'matrix.big' | 'matrix.fill' | 'matrix.skip'
  | 'matrix.n1' | 'matrix.n2' | 'matrix.n3'
  | 'roadmap.title' | 'roadmap.q1' | 'roadmap.q2' | 'roadmap.q3' | 'roadmap.q4' | 'roadmap.lane1' | 'roadmap.lane2' | 'roadmap.lane3'
  | 'roadmap.bar1' | 'roadmap.bar2' | 'roadmap.bar3' | 'roadmap.bar4' | 'roadmap.bar5' | 'roadmap.bar6' | 'roadmap.release'
  | 'meeting.title' | 'meeting.howto' | 'meeting.agenda' | 'meeting.agendatext' | 'meeting.decisions' | 'meeting.decision'
  | 'meeting.tasks' | 'meeting.task' | 'meeting.notes';

export type TemplateText = (key: TemplateKey, params?: Record<string, string | number>) => string;

export interface TemplateItem {
  id: string;
  init: ObjectInit;
}

const TOP = 96; // where the content starts below a title
const HEAD_H = 52;
const NOTE_W = 220;
const NOTE_H = 110;

/** Bold first line (or all of it) and a list over the rest: what the format bar would make. */
function rich(text: string, bold: 'first' | 'all' | null, list: ListKind | null = null): Fmt | undefined {
  const nl = text.indexOf('\n');
  let fmt: Fmt | undefined;
  if (bold) fmt = toggleFlag(fmt, text, 0, bold === 'all' || nl < 0 ? text.length : nl, F_BOLD);
  if (list && nl >= 0) fmt = toggleList(fmt, text, nl + 1, text.length, list);
  return fmt;
}

/** Collects one template's objects in local coordinates. */
class Sheet {
  readonly items: TemplateItem[] = [];
  constructor(
    readonly tr: TemplateText,
    private readonly makeId: () => string,
  ) {}

  add(init: ObjectInit): string {
    const id = this.makeId();
    this.items.push({ id, init });
    return id;
  }

  /** The big bold heading of the board. */
  title(key: TemplateKey, x = 0, y = 0, w = 720): string {
    const text = this.tr(key);
    return this.add({ kind: 'text', x, y, w, size: 36, text, fmt: rich(text, 'all') });
  }

  /** A coloured plate with a label (a column head, a branch). */
  plate(x: number, y: number, w: number, h: number, fill: string, key: TemplateKey, shape: ShapeKind = 'rounded'): string {
    return this.add({ kind: 'shape', shape, x, y, w, h, fill, stroke: fill, strokeWidth: 1, text: this.tr(key) });
  }

  /** An area in the soft tone of `hue`, locked: stickies are dragged over it without moving it. */
  zone(x: number, y: number, w: number, h: number, hue: string): string {
    return this.add({ kind: 'shape', shape: 'rect', x, y, w, h, fill: `${SOFT_PREFIX}${hue}`, stroke: 'none', strokeWidth: 0, locked: true });
  }

  note(x: number, y: number, color: string, key: TemplateKey, w = NOTE_W, h = NOTE_H): string {
    const text = this.tr(key);
    return this.add({ kind: 'sticky', x, y, w, h, color, text, fmt: rich(text, text.includes('\n') ? 'first' : null) });
  }

  /** «How to use»: a grey sticky, the heading bold and the steps numbered. */
  howto(x: number, y: number, key: TemplateKey, w = 300, h = 200): string {
    const text = this.tr(key);
    return this.add({ kind: 'sticky', x, y, w, h, color: 'gray', fontSize: 's', text, fmt: rich(text, 'first', 'number') });
  }

  label(x: number, y: number, key: TemplateKey, w = 200, size = 16): string {
    return this.add({ kind: 'text', x, y, w, size, text: this.tr(key) });
  }

  wire(from: Endpoint, to: Endpoint, o: { route?: 'straight' | 'elbow' | 'curve'; arrow?: 'none' | 'end'; stroke?: string; width?: number; label?: TemplateKey } = {}): string {
    return this.add({
      kind: 'connector', from, to, arrow: o.arrow ?? 'end', route: o.route ?? 'elbow', stroke: o.stroke ?? 'stroke', strokeWidth: o.width ?? 2,
      ...(o.label ? { label: this.tr(o.label) } : {}),
    });
  }
}

const at = (id: string, side: Side): Endpoint => ({ id, side });

/** Column boards: a head plate and a locked body per column, the stickies on top. */
function columns(s: Sheet, heads: readonly { key: TemplateKey; fill: string }[], colW = 260, gap = 20, bodyH = 520): void {
  heads.forEach((h, c) => {
    const x = c * (colW + gap);
    s.zone(x, TOP + HEAD_H + 8, colW, bodyH, h.fill);
    s.plate(x, TOP, colW, HEAD_H, h.fill, h.key);
  });
}
const colNote = (c: number, n: number, colW = 260, gap = 20): Point => ({ x: c * (colW + gap) + (colW - NOTE_W) / 2, y: TOP + HEAD_H + 8 + 20 + n * (NOTE_H + 20) });

function kanban(s: Sheet): void {
  s.title('kanban.title');
  columns(s, [
    { key: 'kanban.backlog', fill: 'gray' }, { key: 'kanban.doing', fill: 'blue' },
    { key: 'kanban.review', fill: 'orange' }, { key: 'kanban.done', fill: 'green' },
  ]);
  // Sticky colour = the kind of work (the legend under the board).
  const notes: [number, number, string, TemplateKey][] = [
    [0, 0, 'yellow', 'kanban.n1'], [0, 1, 'sky', 'kanban.n2'],
    [1, 0, 'yellow', 'kanban.n3'], [1, 1, 'coral', 'kanban.n4'],
    [2, 0, 'yellow', 'kanban.n5'], [3, 0, 'yellow', 'kanban.n6'],
  ];
  for (const [c, n, color, key] of notes) {
    const p = colNote(c, n);
    s.note(p.x, p.y, color, key);
  }
  s.label(0, TOP + HEAD_H + 8 + 520 + 16, 'kanban.legend', 600);
  s.howto(4 * 280 + 20, TOP, 'kanban.howto');
}

function retro(s: Sheet): void {
  s.title('retro.title');
  columns(s, [
    { key: 'retro.good', fill: 'green' }, { key: 'retro.bad', fill: 'red' },
    { key: 'retro.try', fill: 'blue' }, { key: 'retro.actions', fill: 'purple' },
  ]);
  const notes: [number, number, string, TemplateKey][] = [
    [0, 0, 'green', 'retro.n1'], [0, 1, 'green', 'retro.n2'],
    [1, 0, 'coral', 'retro.n3'], [1, 1, 'coral', 'retro.n4'],
    [2, 0, 'sky', 'retro.n5'], [2, 1, 'sky', 'retro.n6'],
    [3, 0, 'lavender', 'retro.action'],
  ];
  for (const [c, n, color, key] of notes) {
    const p = colNote(c, n);
    s.note(p.x, p.y, color, key);
  }
  s.howto(4 * 280 + 20, TOP, 'retro.howto', 320, 230);
}

function swot(s: Sheet): void {
  s.title('swot.title');
  const W = 400;
  const H = 260;
  const GAP = 20;
  const quads: { key: TemplateKey; note: TemplateKey; fill: string; sticky: string }[] = [
    { key: 'swot.s', note: 'swot.ns', fill: 'green', sticky: 'green' }, { key: 'swot.w', note: 'swot.nw', fill: 'red', sticky: 'coral' },
    { key: 'swot.o', note: 'swot.no', fill: 'blue', sticky: 'sky' }, { key: 'swot.t', note: 'swot.nt', fill: 'orange', sticky: 'amber' },
  ];
  const rowH = HEAD_H + 8 + H + GAP;
  quads.forEach((q, i) => {
    const x = (i % 2) * (W + GAP);
    const y = TOP + Math.floor(i / 2) * rowH;
    s.zone(x, y + HEAD_H + 8, W, H, q.fill);
    s.plate(x, y, W, HEAD_H, q.fill, q.key);
    s.note(x + 20, y + HEAD_H + 28, q.sticky, q.note);
  });
  const y = TOP + 2 * rowH;
  s.zone(0, y + HEAD_H + 8, 2 * W + GAP, 150, 'purple');
  s.plate(0, y, 2 * W + GAP, HEAD_H, 'purple', 'swot.outcome');
  s.note(20, y + HEAD_H + 28, 'lavender', 'swot.outcomenote', 380, NOTE_H);
  s.howto(2 * W + GAP + 40, TOP, 'swot.howto');
}

function mindmap(s: Sheet): void {
  const topic = s.tr('mindmap.center');
  const center = s.add({ kind: 'shape', shape: 'ellipse', x: 640, y: 300, w: 260, h: 120, fill: 'blue', stroke: 'blue', strokeWidth: 1, fontSize: 'l', text: topic, fmt: rich(topic, 'all') });
  // Two branches on each side, two ideas each; curves in the branch's colour.
  const branches: { key: TemplateKey; subs: [TemplateKey, TemplateKey]; fill: string; right: boolean; y: number }[] = [
    { key: 'mindmap.b1', subs: ['mindmap.s11', 'mindmap.s12'], fill: 'green', right: true, y: 200 },
    { key: 'mindmap.b2', subs: ['mindmap.s21', 'mindmap.s22'], fill: 'orange', right: true, y: 456 },
    { key: 'mindmap.b3', subs: ['mindmap.s31', 'mindmap.s32'], fill: 'purple', right: false, y: 200 },
    { key: 'mindmap.b4', subs: ['mindmap.s41', 'mindmap.s42'], fill: 'pink', right: false, y: 456 },
  ];
  for (const b of branches) {
    const bx = b.right ? 1060 : 280;
    const id = s.plate(bx, b.y, 200, 64, b.fill, b.key);
    s.wire(at(center, b.right ? 'right' : 'left'), at(id, b.right ? 'left' : 'right'), { route: 'curve', arrow: 'none', stroke: b.fill, width: 3 });
    b.subs.forEach((key, i) => {
      const sx = b.right ? 1340 : 20;
      const sub = s.add({ kind: 'shape', shape: 'rounded', x: sx, y: b.y - 40 + i * 92, w: 180, h: 52, fill: 'none', stroke: b.fill, strokeWidth: 2, text: s.tr(key) });
      s.wire(at(id, b.right ? 'right' : 'left'), at(sub, b.right ? 'left' : 'right'), { route: 'curve', arrow: 'none', stroke: b.fill, width: 2 });
    });
  }
  s.howto(620, 620, 'mindmap.howto', 300, 150);
}

function flow(s: Sheet): void {
  s.title('flow.title');
  const y = TOP + 40;
  const start = s.plate(0, y, 160, 80, 'green', 'flow.start', 'ellipse');
  const receive = s.plate(240, y, 200, 80, 'blue', 'flow.receive');
  const check = s.plate(520, y - 15, 200, 110, 'orange', 'flow.check', 'diamond');
  const save = s.plate(800, y - 5, 180, 90, 'teal', 'flow.save', 'cylinder');
  const end = s.plate(1060, y, 160, 80, 'green', 'flow.end', 'ellipse');
  const ask = s.plate(520, y + 200, 200, 80, 'pink', 'flow.ask');
  s.wire(at(start, 'right'), at(receive, 'left'));
  s.wire(at(receive, 'right'), at(check, 'left'));
  s.wire(at(check, 'right'), at(save, 'left'), { label: 'flow.yes' });
  s.wire(at(save, 'right'), at(end, 'left'));
  s.wire(at(check, 'bottom'), at(ask, 'top'), { label: 'flow.no' });
  // The loop back: a missing detail sends the request round again.
  s.wire(at(ask, 'left'), at(receive, 'bottom'));
}

function matrix(s: Sheet): void {
  s.title('matrix.title');
  const gx = 80;
  const gy = TOP + 40;
  const W = 360;
  const H = 260;
  const quads: { key: TemplateKey; fill: string; x: number; y: number }[] = [
    { key: 'matrix.quick', fill: 'green', x: gx, y: gy }, { key: 'matrix.big', fill: 'blue', x: gx + W, y: gy },
    { key: 'matrix.fill', fill: 'gray', x: gx, y: gy + H }, { key: 'matrix.skip', fill: 'red', x: gx + W, y: gy + H },
  ];
  for (const q of quads) {
    s.zone(q.x, q.y, W, H, q.fill);
    s.add({ kind: 'shape', shape: 'rounded', x: q.x + 12, y: q.y + 12, w: 200, h: 40, fill: q.fill, stroke: q.fill, strokeWidth: 1, fontSize: 's', text: s.tr(q.key) });
  }
  // The axes: value grows upwards, effort to the right.
  s.wire({ x: gx - 24, y: gy + 2 * H }, { x: gx - 24, y: gy - 16 }, { route: 'straight', width: 2 });
  s.wire({ x: gx, y: gy + 2 * H + 24 }, { x: gx + 2 * W + 16, y: gy + 2 * H + 24 }, { route: 'straight', width: 2 });
  s.label(gx - 60, gy - 52, 'matrix.value', 160);
  s.label(gx + 2 * W - 140, gy + 2 * H + 36, 'matrix.effort', 160);
  s.note(gx + 60, gy + 80, 'yellow', 'matrix.n1', 200, 90);
  s.note(gx + W + 100, gy + 120, 'yellow', 'matrix.n2', 200, 90);
  s.note(gx + 80, gy + H + 100, 'yellow', 'matrix.n3', 200, 90);
  s.howto(gx + 2 * W + 60, gy, 'matrix.howto');
}

function roadmap(s: Sheet): void {
  s.title('roadmap.title');
  const QW = 260;
  const left = 200;
  const quarters: TemplateKey[] = ['roadmap.q1', 'roadmap.q2', 'roadmap.q3', 'roadmap.q4'];
  quarters.forEach((key, i) => s.plate(left + i * QW, TOP, QW - 10, 44, 'gray', key));
  const lanes: { key: TemplateKey; fill: string; bars: [TemplateKey, number, number][] }[] = [
    { key: 'roadmap.lane1', fill: 'blue', bars: [['roadmap.bar1', 10, 380], ['roadmap.bar2', 2 * QW + 10, 420]] },
    { key: 'roadmap.lane2', fill: 'purple', bars: [['roadmap.bar3', 10, 240], ['roadmap.bar4', QW + 10, 2 * QW - 20]] },
    { key: 'roadmap.lane3', fill: 'teal', bars: [['roadmap.bar5', QW / 2 + 10, 400], ['roadmap.bar6', 2.5 * QW + 10, 360]] },
  ];
  lanes.forEach((l, i) => {
    const y = TOP + 60 + i * 120;
    s.zone(left, y, 4 * QW - 10, 100, l.fill);
    s.plate(0, y, 180, 100, l.fill, l.key);
    for (const [key, x, w] of l.bars) s.plate(left + x, y + 22, w, 56, l.fill, key);
  });
  // The release: a line across the lanes and its milestone.
  const rx = left + 2 * QW - 5;
  const bottom = TOP + 60 + 3 * 120;
  s.wire({ x: rx, y: TOP + 50 }, { x: rx, y: bottom + 10 }, { route: 'straight', arrow: 'none', stroke: 'red', width: 2 });
  s.plate(rx - 80, bottom + 10, 160, 80, 'red', 'roadmap.release', 'diamond');
}

function meeting(s: Sheet): void {
  s.title('meeting.title', 0, 0, 900);
  s.zone(0, TOP + HEAD_H + 8, 380, 412, 'blue');
  s.plate(0, TOP, 380, HEAD_H, 'blue', 'meeting.agenda');
  const agenda = s.tr('meeting.agendatext');
  s.add({ kind: 'text', x: 20, y: TOP + HEAD_H + 28, w: 340, size: 18, text: agenda, fmt: toggleList(undefined, agenda, 0, agenda.length, 'number') });
  s.zone(400, TOP + HEAD_H + 8, 380, 170, 'green');
  s.plate(400, TOP, 380, HEAD_H, 'green', 'meeting.decisions');
  s.note(420, TOP + HEAD_H + 28, 'mint', 'meeting.decision', 300, NOTE_H);
  const ty = TOP + HEAD_H + 8 + 170 + 12;
  s.zone(400, ty + HEAD_H + 8, 380, 170, 'orange');
  s.plate(400, ty, 380, HEAD_H, 'orange', 'meeting.tasks');
  s.note(420, ty + HEAD_H + 28, 'amber', 'meeting.task', 300, NOTE_H);
  s.zone(800, TOP + HEAD_H + 8, 300, 412, 'purple');
  s.plate(800, TOP, 300, HEAD_H, 'purple', 'meeting.notes');
  s.howto(1140, TOP, 'meeting.howto', 320, 220);
}

/** Objects of a template in local coordinates (origin near its top-left), ids made by `makeId`. */
function layout(id: TemplateId, tr: TemplateText, makeId: () => string): TemplateItem[] {
  const s = new Sheet(tr, makeId);
  const build: Record<TemplateId, (s: Sheet) => void> = { kanban, retro, swot, mindmap, flow, matrix, roadmap, meeting };
  build[id](s);
  return s.items;
}

const boxOf = (init: ObjectInit): Rect | null => {
  if (init.kind === 'connector') return null;
  return { x: init.x, y: init.y, w: init.w ?? 160, h: init.kind === 'sticky' || init.kind === 'shape' ? (init.h ?? 100) : 100 };
};

/**
 * The objects of template `id` centered on `center` (connectors glued to their shapes by id; free connector ends
 * move with the rest). The texts come from `tr`; `makeId` supplies the ids the connectors refer to. One list = one
 * `createMany` = one undo step.
 */
export function buildTemplate(id: TemplateId, center: Point, tr: TemplateText, makeId: () => string): TemplateItem[] {
  const local = layout(id, tr, makeId);
  const b = boundsOf(local.flatMap((i) => boxOf(i.init) ?? []));
  const dx = center.x - (b ? b.x + b.w / 2 : 0);
  const dy = center.y - (b ? b.y + b.h / 2 : 0);
  const move = (e: Endpoint): Endpoint => ('id' in e ? e : { x: e.x + dx, y: e.y + dy });
  return local.map(({ id: oid, init }) =>
    init.kind === 'connector' ? { id: oid, init: { ...init, from: move(init.from), to: move(init.to) } } : { id: oid, init: { ...init, x: init.x + dx, y: init.y + dy } },
  );
}
