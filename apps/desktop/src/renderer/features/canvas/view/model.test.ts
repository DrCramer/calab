import { describe, expect, it } from 'vitest';
import { DEFAULTS, SOFT_PREFIX } from '../../../lib/canvas/types';
import {
  ARROW_DEFS, FILL_COLORS, FILL_PICKER, FONT_PRESETS, INK_COLORS, PEN_COLORS, ROUTE_DEFS, SHAPE_DEFS, SOFT_FILL_COLORS,
  STICKY_COLORS, STROKE_COLORS, STROKE_WIDTHS, TOOL_DEFS,
} from './model';

const unique = (xs: readonly unknown[]): boolean => new Set(xs).size === xs.length;

describe('toolbar tables', () => {
  it('every tool has a hotkey, and a tool and its hotkey are not listed twice (C is the connector and, with Alt, the comment)', () => {
    expect(unique(TOOL_DEFS.map((d) => d.tool))).toBe(true);
    expect(unique(TOOL_DEFS.map((d) => `${d.alt ? 'alt+' : ''}${d.key}`))).toBe(true);
    expect(TOOL_DEFS.every((d) => d.key.length > 0)).toBe(true);
  });

  it('lists the eleven shapes once each, and the three routes and arrows', () => {
    expect(SHAPE_DEFS).toHaveLength(11);
    expect(unique(SHAPE_DEFS.map((d) => d.kind))).toBe(true);
    expect(ROUTE_DEFS.map((d) => d.route)).toEqual(['straight', 'elbow', 'curve']);
    expect(ARROW_DEFS.map((d) => d.arrow)).toEqual(['none', 'end', 'both']);
  });
});

describe('color tables', () => {
  it('the ink comes first in the text and outline rows; the sticky colors are unique', () => {
    expect(INK_COLORS[0]).toBe('text');
    expect(STROKE_COLORS[0]).toBe('stroke');
    expect(PEN_COLORS[0]).toBe('stroke');
    expect(unique(STICKY_COLORS)).toBe(true);
    expect(STICKY_COLORS.length).toBeGreaterThan(0);
  });

  it('the soft row is the soft prefix on every hue, and the fill picker is the plain fills then the soft row', () => {
    expect(SOFT_FILL_COLORS.every((c) => c.startsWith(SOFT_PREFIX))).toBe(true);
    expect(FILL_PICKER).toEqual([...FILL_COLORS, ...SOFT_FILL_COLORS]);
    expect(FILL_COLORS.slice(0, 2)).toEqual(['none', 'white']);
  });
});

describe('size tables', () => {
  it('font presets ascend and fit the text size range', () => {
    expect([...FONT_PRESETS].sort((a, b) => a - b)).toEqual([...FONT_PRESETS]);
    expect(FONT_PRESETS[0]).toBeGreaterThanOrEqual(DEFAULTS.minTextSize);
    expect(FONT_PRESETS[FONT_PRESETS.length - 1]).toBeLessThanOrEqual(DEFAULTS.maxTextSize);
  });

  it('stroke widths ascend from thin to thick', () => {
    expect(STROKE_WIDTHS.map((w) => w.width)).toEqual([1, 2, 4]);
  });
});
