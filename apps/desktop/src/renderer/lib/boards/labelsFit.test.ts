import { describe, expect, it } from 'vitest';
import { fitLabels } from './labelsFit';

const base = { group: 40, max: 200, gap: 4, rows: 2 };

describe('fitLabels', () => {
  it('shows everything that fits in one row', () => {
    expect(fitLabels({ ...base, widths: [60, 60, 60] })).toBe(3);
  });

  it('shows everything that fits in two rows, without the group', () => {
    // 100 + 4 + 90 = 194 on row 1, the same on row 2.
    expect(fitLabels({ ...base, widths: [100, 90, 100, 90] })).toBe(4);
  });

  it('collapses the rest into the group on the second row, never a third', () => {
    // Row 1: 100 + 90. Row 2: 100 + group 40 = 144 (the 4th label would not fit anyway).
    expect(fitLabels({ ...base, widths: [100, 90, 100, 90, 50] })).toBe(3);
  });

  it('reserves the group width: a label that would fit alone is hidden when the group would not', () => {
    // Row 2 holds 150; a 4th label of 44 still fits (198), but then the group (40) would not.
    expect(fitLabels({ ...base, widths: [100, 90, 150, 44, 60] })).toBe(3);
    expect(fitLabels({ ...base, widths: [100, 90, 150, 44] })).toBe(4);
  });

  it('collapses everything when not even one label leaves room for the group', () => {
    expect(fitLabels({ ...base, widths: [200, 200, 200], rows: 1 })).toBe(0);
  });

  it('clamps a label wider than the row', () => {
    expect(fitLabels({ ...base, widths: [500] })).toBe(1);
    expect(fitLabels({ ...base, widths: [500, 500, 500] })).toBe(1);
  });

  it('honours one row', () => {
    expect(fitLabels({ ...base, rows: 1, widths: [60, 60, 60] })).toBe(3);
    expect(fitLabels({ ...base, rows: 1, widths: [60, 60, 60, 60] })).toBe(2);
  });

  it('keeps room for the trailing control', () => {
    expect(fitLabels({ ...base, tail: 28, widths: [100, 90, 100, 60] })).toBe(4);
    // Row 2: 100 + 70 = 174, + the tail 28 would not fit: the 4th label goes to the group.
    expect(fitLabels({ ...base, tail: 28, widths: [100, 90, 100, 70] })).toBe(3);
  });

  it('is stable: the same widths give the same answer', () => {
    const w = [70, 30, 80, 55, 90, 20, 66];
    expect(fitLabels({ ...base, widths: w })).toBe(fitLabels({ ...base, widths: [...w] }));
  });

  it('handles no labels and an unmeasured row', () => {
    expect(fitLabels({ ...base, widths: [] })).toBe(0);
    expect(fitLabels({ ...base, max: 0, widths: [10, 10] })).toBe(2);
  });
});
