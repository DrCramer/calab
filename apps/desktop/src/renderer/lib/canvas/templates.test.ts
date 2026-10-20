import { describe, expect, it } from 'vitest';
import { boundsOf } from './geometry';
import { Scene } from './scene';
import { TEMPLATE_IDS, buildTemplate, type TemplateId, type TemplateKey } from './templates';
import { ids, makeDoc } from './testing';
import { MAX_OBJECTS, isConnector } from './types';

const tr = (key: TemplateKey, p?: Record<string, string | number>): string => (p ? `${key}:${JSON.stringify(p)}` : key);
const COUNTS: Record<TemplateId, { objects: number; connectors: number; stickies: number }> = {
  kanban: { objects: 12, connectors: 0, stickies: 6 },
  retro: { objects: 12, connectors: 0, stickies: 6 },
  swot: { objects: 8, connectors: 0, stickies: 0 },
  mindmap: { objects: 9, connectors: 4, stickies: 0 },
  flow: { objects: 5, connectors: 2, stickies: 0 },
};

describe('templates', () => {
  it('there are five', () => {
    expect([...TEMPLATE_IDS]).toEqual(['kanban', 'retro', 'swot', 'mindmap', 'flow']);
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
      expect('id' in i.init.from && known.has(i.init.from.id)).toBe(true);
      expect('id' in i.init.to && known.has(i.init.to.id)).toBe(true);
    }
    // Every visible text comes through `tr` (a key, not a hard-coded phrase).
    const texts = items.flatMap((i) => (i.init.kind !== 'connector' && i.init.text ? [i.init.text] : []));
    expect(texts.length).toBeGreaterThan(0);
    for (const x of texts) expect(x).toMatch(/^(kanban|retro|swot|mindmap|flow)\.[a-z]+(:\{.*\})?$/);
  });
  it('the headers of the column boards are the three wanted titles; SWOT is 2×2', () => {
    const texts = (id: TemplateId): string[] => buildTemplate(id, { x: 0, y: 0 }, tr, ids('t')).flatMap((i) => (i.init.kind === 'shape' && i.init.text ? [i.init.text] : []));
    expect(texts('kanban')).toEqual(['kanban.todo', 'kanban.doing', 'kanban.done']);
    expect(texts('retro')).toEqual(['retro.good', 'retro.bad', 'retro.try']);
    const swot = buildTemplate('swot', { x: 0, y: 0 }, tr, ids('t')).flatMap((i) => (i.init.kind === 'shape' && i.init.text ? [i.init] : []));
    expect(new Set(swot.map((s) => s.x)).size).toBe(2);
    expect(new Set(swot.map((s) => s.y)).size).toBe(2);
  });
  it('the flow chart has three steps and arrows between them; the mind map wires its center to four branches', () => {
    const flow = buildTemplate('flow', { x: 0, y: 0 }, tr, ids('t'));
    const arrows = flow.flatMap((i) => (i.init.kind === 'connector' ? [i.init] : []));
    expect(arrows.map((a) => a.arrow)).toEqual(['end', 'end']);
    const map = buildTemplate('mindmap', { x: 0, y: 0 }, tr, ids('t'));
    const centerId = map[0]?.id;
    const wires = map.flatMap((i) => (i.init.kind === 'connector' ? [i.init] : []));
    expect(wires.every((w) => 'id' in w.from && w.from.id === centerId)).toBe(true);
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
