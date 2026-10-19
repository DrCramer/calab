import { describe, expect, it } from 'vitest';
import { layoutAllDay, layoutDay } from './layout';

const H = 3_600_000;
const M = 60_000;
const DAY = 0; // the day's midnight (ms): items are relative to it

const item = (key: string, fromMin: number, toMin: number) => ({ key, start: DAY + fromMin * M, end: DAY + toMin * M });
const byKey = (xs: ReturnType<typeof layoutDay>) => Object.fromEntries(xs.map((x) => [x.key, x]));

describe('day grid layout (overlaps)', () => {
  it('a lone meeting takes the full width at its time', () => {
    expect(layoutDay([item('a', 9 * 60, 10 * 60)], DAY, DAY + 24 * H)).toEqual([{ key: 'a', top: 540, height: 60, col: 0, cols: 1 }]);
  });

  it('overlapping meetings share the width side by side', () => {
    const r = byKey(layoutDay([item('a', 540, 600), item('b', 570, 630), item('c', 600, 660)], DAY, DAY + 24 * H));
    // a and b overlap; c starts when a ends — it reuses a's column, the cluster keeps 2 columns.
    expect(r['a']).toMatchObject({ col: 0, cols: 2 });
    expect(r['b']).toMatchObject({ col: 1, cols: 2 });
    expect(r['c']).toMatchObject({ col: 0, cols: 2 });
  });

  it('back-to-back meetings do not overlap', () => {
    const r = byKey(layoutDay([item('a', 540, 600), item('b', 600, 660)], DAY, DAY + 24 * H));
    expect(r['a']).toMatchObject({ col: 0, cols: 1 });
    expect(r['b']).toMatchObject({ col: 0, cols: 1 });
  });

  it('three at once make three columns; a later one starts a new cluster', () => {
    const r = byKey(layoutDay([item('a', 600, 720), item('b', 600, 660), item('c', 630, 690), item('d', 800, 830)], DAY, DAY + 24 * H));
    expect([r['a']?.col, r['b']?.col, r['c']?.col]).toEqual([0, 1, 2]);
    expect(r['a']?.cols).toBe(3);
    expect(r['d']).toMatchObject({ col: 0, cols: 1 });
  });

  it('short meetings are drawn with a minimum height and do not draw over each other', () => {
    const r = byKey(layoutDay([item('a', 600, 605), item('b', 610, 615)], DAY, DAY + 24 * H, 20));
    expect(r['a']?.height).toBe(20);
    expect(r['b']).toMatchObject({ col: 1, cols: 2 });
  });

  it('meetings from yesterday or into tomorrow are clamped to the day', () => {
    const r = byKey(layoutDay([item('a', -120, 60), item('b', 23 * 60, 26 * 60), item('c', 1430, 1440)], DAY, DAY + 24 * H, 20));
    expect(r['a']).toMatchObject({ top: 0, height: 60 });
    expect(r['b']).toMatchObject({ top: 1380, height: 60 });
    // 23:50–24:00 is 10 minutes: drawn 20 minutes tall, so it moves up to stay inside the grid.
    expect(r['c']).toMatchObject({ top: 1420, height: 20 });
  });

  it('the week view lays out every day with the same function (columns are independent)', () => {
    const day2 = DAY + 24 * H;
    const r = byKey(layoutDay([{ key: 'x', start: day2 + 600 * M, end: day2 + 660 * M }], day2, day2 + 24 * H));
    expect(r['x']).toMatchObject({ top: 600, height: 60, col: 0, cols: 1 });
  });
});

describe('week «весь день» band', () => {
  it('a multi-day item is one bar over its days', () => {
    expect(layoutAllDay([{ key: 'a', days: [2, 3, 4] }])).toEqual([{ key: 'a', col: 2, span: 3, lane: 0 }]);
  });

  it('bars sharing a day stack into lanes; a free lane is reused', () => {
    const r = Object.fromEntries(
      layoutAllDay([
        { key: 'short', days: [1] },
        { key: 'long', days: [0, 1, 2] },
        { key: 'late', days: [4, 5] },
        { key: 'mid', days: [2, 3] },
      ]).map((p) => [p.key, p]),
    );
    expect(r['long']).toMatchObject({ col: 0, span: 3, lane: 0 });
    expect(r['short']).toMatchObject({ col: 1, span: 1, lane: 1 });
    // «mid» overlaps «long» on day 2 only; lane 1 is free on days 2–3.
    expect(r['mid']).toMatchObject({ col: 2, span: 2, lane: 1 });
    expect(r['late']).toMatchObject({ col: 4, span: 2, lane: 0 });
  });

  it('items without a day in the week are dropped', () => {
    expect(layoutAllDay([{ key: 'x', days: [] }])).toEqual([]);
  });
});
