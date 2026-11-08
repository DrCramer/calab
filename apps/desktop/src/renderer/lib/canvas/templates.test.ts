import { describe, expect, it } from 'vitest';
import { boundsOf } from './geometry';
import { Scene } from './scene';
import { TEMPLATE_IDS, buildTemplate, type TemplateId, type TemplateKey } from './templates';
import { ids, makeDoc } from './testing';
import { MAX_OBJECTS, isConnector } from './types';

const tr = (key: TemplateKey, p?: Record<string, string | number>): string => (p ? `${key}:${JSON.stringify(p)}` : key);
const COUNTS: Record<TemplateId, { objects: number; connectors: number; stickies: number }> = {
  kanban: { objects: 17, connectors: 0, stickies: 7 },
  retro: { objects: 17, connectors: 0, stickies: 8 },
  swot: { objects: 17, connectors: 0, stickies: 6 },
  mindmap: { objects: 26, connectors: 12, stickies: 1 },
  flow: { objects: 13, connectors: 6, stickies: 0 },
  matrix: { objects: 17, connectors: 2, stickies: 4 },
  roadmap: { objects: 19, connectors: 1, stickies: 0 },
  meeting: { objects: 13, connectors: 0, stickies: 3 },
};
const shapeTexts = (id: TemplateId): string[] => buildTemplate(id, { x: 0, y: 0 }, tr, ids('t')).flatMap((i) => (i.init.kind === 'shape' && i.init.text ? [i.init.text] : []));

describe('templates', () => {
  it('there are eight', () => {
    expect([...TEMPLATE_IDS]).toEqual(['kanban', 'retro', 'swot', 'mindmap', 'flow', 'matrix', 'roadmap', 'meeting']);
  });
  it.each(TEMPLATE_IDS)('%s: the expected objects, connectors glued to existing shapes, localized texts', (id) => {
    const items = buildTemplate(id, { x: 0, y: 0 }, tr, ids('t'));
    const want = COUNTS[id];
    expect(items).toHaveLength(want.objects);
    expect(items.filter((i) => i.init.kind === 'connector')).toHaveLength(want.connectors);
    expect(items.filter((i) => i.init.kind === 'sticky')).toHaveLength(want.stickies);
    const known = new Set(items.map((i) => i.id));
    expect(known.size).toBe(items.length);
    for (const i of items) {
      if (i.init.kind !== 'connector') continue;
      // A glued end refers to an object of the template; free ends are the matrix axes and the roadmap's release line.
      for (const e of [i.init.from, i.init.to]) if ('id' in e) expect(known.has(e.id)).toBe(true);
    }
    // Every visible text comes through `tr` (a key, not a hard-coded phrase).
    const texts = items.flatMap((i) => (i.init.kind !== 'connector' && i.init.kind !== 'image' && i.init.kind !== 'ink' && i.init.kind !== 'frame' && i.init.text ? [i.init.text] : []));
    expect(texts.length).toBeGreaterThan(0);
    for (const x of texts) expect(x).toMatch(new RegExp(`^${id}\\.[a-z0-9]+$`));
    // The areas under the stickies are locked soft-tone shapes; nothing else is locked.
    for (const i of items) if (i.init.locked) expect(i.init.kind === 'shape' && i.init.fill?.startsWith('soft:') && !i.init.text).toBe(true);
  });
  it('the column boards have their four heads; SWOT is 2×2 with conclusions below', () => {
    expect(shapeTexts('kanban')).toEqual(['kanban.backlog', 'kanban.doing', 'kanban.review', 'kanban.done']);
    expect(shapeTexts('retro')).toEqual(['retro.good', 'retro.bad', 'retro.try', 'retro.actions']);
    const swot = buildTemplate('swot', { x: 0, y: 0 }, tr, ids('t')).flatMap((i) => (i.init.kind === 'shape' && i.init.text && i.init.text !== 'swot.outcome' ? [i.init] : []));
    expect(new Set(swot.map((s) => s.x)).size).toBe(2);
    expect(new Set(swot.map((s) => s.y)).size).toBe(2);
  });
  it('the flow chart branches yes / no and loops back; the mind map wires its center to four branches of two ideas', () => {
    const flow = buildTemplate('flow', { x: 0, y: 0 }, tr, ids('t'));
    const arrows = flow.flatMap((i) => (i.init.kind === 'connector' ? [i.init] : []));
    expect(arrows.every((a) => a.arrow === 'end')).toBe(true);
    expect(arrows.flatMap((a) => (a.label ? [a.label] : []))).toEqual(['flow.yes', 'flow.no']);
    const map = buildTemplate('mindmap', { x: 0, y: 0 }, tr, ids('t'));
    const centerId = map[0]?.id;
    const wires = map.flatMap((i) => (i.init.kind === 'connector' ? [i.init] : []));
    expect(wires.filter((w) => 'id' in w.from && w.from.id === centerId)).toHaveLength(4);
    expect(wires.every((w) => w.route === 'curve')).toBe(true);
  });
  it('the matrix axes move with the template (free connector ends)', () => {
    const a = buildTemplate('matrix', { x: 0, y: 0 }, tr, ids('a')).flatMap((i) => (i.init.kind === 'connector' ? [i.init] : []));
    const b = buildTemplate('matrix', { x: 500, y: 300 }, tr, ids('b')).flatMap((i) => (i.init.kind === 'connector' ? [i.init] : []));
    expect(a).toHaveLength(2);
    a.forEach((w, n) => {
      const v = b[n];
      if (!v || 'id' in w.from || 'id' in v.from) throw new Error('free ends expected');
      expect(v.from.x - w.from.x).toBeCloseTo(500);
      expect(v.from.y - w.from.y).toBeCloseTo(300);
    });
  });
  it.each(TEMPLATE_IDS)('%s is centered on the requested point', (id) => {
    const items = buildTemplate(id, { x: 1000, y: -400 }, tr, ids('t'));
    const b = boundsOf(items.flatMap((i) => (i.init.kind === 'connector' ? [] : [{ x: i.init.x, y: i.init.y, w: i.init.w ?? 160, h: ('h' in i.init ? i.init.h : undefined) ?? 100 }])));
    expect(b ? b.x + b.w / 2 : 0).toBeCloseTo(1000);
    expect(b ? b.y + b.h / 2 : 0).toBeCloseTo(-400);
  });
  it.each(TEMPLATE_IDS)('%s: one createMany is one undo step; the scene routes its connectors', (id) => {
    const d = makeDoc();
    d.create({ kind: 'sticky', x: 5000, y: 5000 });
    d.checkpoint();
    const before = d.count;
    const made = d.createMany(buildTemplate(id, { x: 0, y: 0 }, tr, ids('n')));
    expect(made).toHaveLength(COUNTS[id].objects);
    expect(d.count).toBe(before + COUNTS[id].objects);
    const s = new Scene(d);
    for (const mid of made) {
      const o = s.get(mid);
      expect(o).toBeDefined();
      if (o && isConnector(o)) expect(o.points.length).toBeGreaterThanOrEqual(4);
    }
    d.undo.undo();
    expect(d.count).toBe(before);
    d.undo.redo();
    expect(d.count).toBe(before + COUNTS[id].objects);
  });
  it('does not fit when the 5000-object limit would be crossed: nothing is inserted', () => {
    const d = makeDoc();
    d.createMany(Array.from({ length: MAX_OBJECTS - 3 }, (_, i) => ({ init: { kind: 'sticky' as const, x: i, y: 0 } })));
    expect(d.createMany(buildTemplate('kanban', { x: 0, y: 0 }, tr, ids('n')))).toEqual([]);
    expect(d.count).toBe(MAX_OBJECTS - 3);
    expect(d.createMany(buildTemplate('flow', { x: 0, y: 0 }, tr, ids('f')))).toEqual([]);
    expect(d.createMany(buildTemplate('swot', { x: 0, y: 0 }, tr, ids('s')))).toEqual([]);
  });
});
