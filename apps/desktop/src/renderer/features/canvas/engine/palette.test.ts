import { describe, expect, it } from 'vitest';
import { enCanvasBoard } from '../../../i18n/en/canvasBoard';
import { esCanvasBoard } from '../../../i18n/es/canvasBoard';
import { ruCanvasBoard } from '../../../i18n/ru/canvasBoard';
import { zhCanvasBoard } from '../../../i18n/zh-CN/canvasBoard';
import { FILL_COLORS, INK_COLORS, STICKY_COLORS, STROKE_COLORS } from '../view/model';
import { type CanvasPalette, HUE_IDS, STICKY_IDS, contrastRatio, defaultPalette, readableInk, resolveColor, resolveSticky } from './palette';

// CIEDE2000 on sRGB → Lab (D65): the distance two colors need to look different at a glance.
function lab(hex: string): [number, number, number] {
  const lin = (i: number): number => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [lin(1), lin(3), lin(5)] as [number, number, number];
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const fx = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047);
  const fy = f(0.2126729 * r + 0.7151522 * g + 0.072175 * b);
  const fz = f((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function deltaE00(c1: string, c2: string): number {
  const rad = Math.PI / 180;
  const [L1, a1, b1] = lab(c1);
  const [L2, a2, b2] = lab(c2);
  const Cb = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const ap1 = (1 + G) * a1;
  const ap2 = (1 + G) * a2;
  const Cp1 = Math.hypot(ap1, b1);
  const Cp2 = Math.hypot(ap2, b2);
  const hue = (b: number, a: number): number => (b === 0 && a === 0 ? 0 : ((Math.atan2(b, a) / rad) + 360) % 360);
  const h1 = hue(b1, ap1);
  const h2 = hue(b2, ap2);
  let dh = 0;
  if (Cp1 * Cp2 !== 0) {
    dh = h2 - h1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dL = L2 - L1;
  const dC = Cp2 - Cp1;
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dh * rad) / 2);
  const Lb = (L1 + L2) / 2;
  const Cpb = (Cp1 + Cp2) / 2;
  let hb = h1 + h2;
  if (Cp1 * Cp2 !== 0) {
    if (Math.abs(h1 - h2) > 180) hb += h1 + h2 < 360 ? 360 : -360;
    hb /= 2;
  }
  const T = 1 - 0.17 * Math.cos((hb - 30) * rad) + 0.24 * Math.cos(2 * hb * rad) + 0.32 * Math.cos((3 * hb + 6) * rad) - 0.2 * Math.cos((4 * hb - 63) * rad);
  const Rc = 2 * Math.sqrt(Cpb ** 7 / (Cpb ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2);
  const Sc = 1 + 0.045 * Cpb;
  const Sh = 1 + 0.015 * Cpb * T;
  const Rt = -Math.sin(2 * 30 * Math.exp(-(((hb - 275) / 25) ** 2)) * rad) * Rc;
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
}

function css(p: CanvasPalette, id: string): string {
  const c = resolveColor(p, id);
  if (c === null) throw new Error(`no color for ${id}`);
  return c;
}

const THEMES = ['light', 'dark'] as const;
const LEGACY_STICKY = ['yellow', 'green', 'blue', 'pink', 'orange', 'purple', 'gray'];
const LEGACY_HUES = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'];
const MIN_STICKY_DISTANCE = 7;
const MIN_HUE_DISTANCE = 6;

describe('sticky colors', () => {
  it('offers at least 20 distinct ids and keeps the original seven', () => {
    expect(new Set(STICKY_IDS).size).toBe(STICKY_IDS.length);
    expect(STICKY_IDS.length).toBeGreaterThanOrEqual(20);
    expect(STICKY_COLORS).toEqual([...STICKY_IDS]);
    for (const id of LEGACY_STICKY) expect(STICKY_IDS).toContain(id);
  });

  it.each(THEMES)('has a definition for every id and %s text on it reads at WCAG AA (4.5:1)', (theme) => {
    const p = defaultPalette(theme);
    expect(Object.keys(p.sticky).sort()).toEqual([...STICKY_IDS].sort());
    for (const id of STICKY_IDS) {
      const { bg, fg } = resolveSticky(p, id);
      expect(contrastRatio(fg, bg), `${theme} ${id}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(THEMES)('no two %s notes look alike (CIEDE2000 ≥ 7)', (theme) => {
    const p = defaultPalette(theme);
    for (const [i, a] of STICKY_IDS.entries()) {
      for (const b of STICKY_IDS.slice(i + 1)) {
        expect(deltaE00(resolveSticky(p, a).bg, resolveSticky(p, b).bg), `${theme} ${a} vs ${b}`).toBeGreaterThanOrEqual(MIN_STICKY_DISTANCE);
      }
    }
  });

  it('keeps the original light look of existing documents', () => {
    const p = defaultPalette('light');
    expect(resolveSticky(p, 'yellow')).toEqual({ bg: '#fde68a', fg: '#3b2f0b' });
    expect(resolveSticky(p, 'gray')).toEqual({ bg: '#e5e7eb', fg: '#1f2937' });
    expect(resolveSticky(p, 'purple').bg).toBe('#ddd6fe');
  });

  it('draws an unknown id (from a newer client) neutral, a hex as itself', () => {
    for (const theme of THEMES) {
      const p = defaultPalette(theme);
      expect(resolveSticky(p, 'chartreuse-2030')).toEqual(p.sticky['gray']);
      expect(resolveSticky(p, '#abcdef').bg).toBe('#abcdef');
    }
  });
});

describe('shape / text / connector colors', () => {
  it('lists are consistent: hues shared, 15 swatches each, ids all defined', () => {
    expect(INK_COLORS).toHaveLength(15);
    expect(STROKE_COLORS).toHaveLength(15);
    expect(FILL_COLORS).toHaveLength(15);
    for (const id of LEGACY_HUES) expect(HUE_IDS).toContain(id);
    for (const theme of THEMES) {
      const p = defaultPalette(theme);
      for (const id of [...INK_COLORS, ...STROKE_COLORS, ...FILL_COLORS]) {
        if (id === 'none') expect(resolveColor(p, id)).toBeNull();
        else expect(resolveColor(p, id), `${theme} ${id}`).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it.each(THEMES)('%s hues are distinct and the new ones stand out from the canvas (3:1)', (theme) => {
    const p = defaultPalette(theme);
    const ids = [...HUE_IDS, 'brown'];
    for (const id of ids) {
      if (LEGACY_HUES.includes(id)) continue;
      expect(contrastRatio(css(p, id), p.background), `${theme} ${id}`).toBeGreaterThanOrEqual(3);
    }
    for (const [i, a] of ids.entries()) {
      for (const b of ids.slice(i + 1)) {
        expect(deltaE00(css(p, a), css(p, b)), `${theme} ${a} vs ${b}`).toBeGreaterThanOrEqual(MIN_HUE_DISTANCE);
      }
    }
  });

  it('keeps the original hue values and the neutral fallback for unknown ids', () => {
    const p = defaultPalette('light');
    expect(resolveColor(p, 'red')).toBe('#dc2626');
    expect(resolveColor(p, 'gray')).toBe('#6b7280');
    expect(resolveColor(p, 'no-such-color')).toBe(p.ink);
  });

  it('readableInk keeps a readable ink and swaps an unreadable one', () => {
    expect(readableInk('#ffffff', '#1f2937')).toBe('#1f2937');
    expect(readableInk('#1f2937', '#1f2937')).toBe('#ffffff');
    expect(readableInk('#facc15', '#e5e7eb')).toBe('#111827');
    expect(readableInk('rgba(0,0,0,0.5)', '#1f2937')).toBe('#1f2937');
  });
});

describe('color names for accessibility', () => {
  const dicts = { ru: ruCanvasBoard, en: enCanvasBoard, es: esCanvasBoard, zh: zhCanvasBoard } as Record<string, Record<string, string>>;
  it('every swatch id has a name in every language, and names do not repeat within the sticky list', () => {
    const ids = new Set([...STICKY_IDS, ...INK_COLORS, ...STROKE_COLORS, ...FILL_COLORS]);
    for (const [lang, d] of Object.entries(dicts)) {
      for (const id of ids) expect(d[`canvasBoard.color.${id}`], `${lang} ${id}`).toBeTruthy();
      const names = STICKY_IDS.map((id) => d[`canvasBoard.color.${id}`]);
      expect(new Set(names).size, `${lang} duplicate sticky names`).toBe(names.length);
    }
  });
});
