/**
 * Colors the engine paints with. The engine never reads CSS: the UI (H5) resolves docs/08 tokens for the
 * current theme into this shape and hands it over (`setPalette`). Objects store token *names* ('yellow',
 * 'stroke', …), so one document looks right in light and dark.
 */
export interface CanvasPalette {
  background: string;
  /** Dot-grid color. */
  grid: string;
  /** Selection outline, handles' outline, marquee. */
  accent: string;
  accentFill: string;
  handleFill: string;
  /** Alignment guides. */
  guide: string;
  /** Default ink (text, connectors, shape outlines) for the 'text' / 'stroke' tokens. */
  ink: string;
  /** Plate drawn instead of glyphs at tiny zoom, and behind connector labels. */
  plaque: string;
  labelBg: string;
  /** Named colors for fills/strokes/text ('red', 'blue', …). 'none' is transparent, 'text'/'stroke' fall back to `ink`. */
  colors: Readonly<Record<string, string>>;
  /** Sticky note colors: background + ink. */
  sticky: Readonly<Record<string, { bg: string; fg: string }>>;
  fontFamily: string;
}

const HEX = /^#[0-9a-fA-F]{3,8}$/;

/** Token (or #hex) → CSS color; null for 'none'. */
export function resolveColor(p: CanvasPalette, token: string): string | null {
  if (token === 'none') return null;
  if (HEX.test(token)) return token;
  if (token === 'text' || token === 'stroke') return p.colors[token] ?? p.ink;
  return p.colors[token] ?? p.ink;
}

export function resolveSticky(p: CanvasPalette, token: string): { bg: string; fg: string } {
  const s = p.sticky[token];
  if (s) return s;
  if (HEX.test(token)) return { bg: token, fg: p.ink };
  // An id from a newer client: neutral, never the default yellow (which would pass for a real choice).
  return p.sticky['gray'] ?? { bg: '#e5e7eb', fg: '#1f2937' };
}

type Sticky = { bg: string; fg: string };

/**
 * Sticky-note color ids in picker order (5 per row). The first seven are the original ids and keep their
 * original light values; the dark table only nudges yellow/orange a little darker so every pair clears
 * WCAG AA (palette.test.ts checks every id in both themes, and that no two look alike).
 */
export const STICKY_IDS = [
  'yellow', 'amber', 'orange', 'coral', 'red',
  'crimson', 'pink', 'magenta', 'violet', 'purple',
  'lavender', 'indigo', 'cobalt', 'blue', 'sky',
  'cyan', 'teal', 'mint', 'green', 'emerald',
  'lime', 'brown', 'gray', 'slate', 'black',
] as const;

/** Shape/text/connector hues (picker order); 'text'/'stroke' (the ink) lead the ink lists, 'none'/'white' the fill list. */
export const HUE_IDS = [
  'red', 'orange', 'yellow', 'lime', 'green', 'teal', 'cyan', 'blue', 'indigo', 'purple', 'magenta', 'pink', 'gray',
] as const;
/** Ink-only extra: a dark earthy brown that reads on both backgrounds. */
export const INK_EXTRA_IDS = ['brown'] as const;

function luminance(hex: string): number | null {
  if (!HEX.test(hex) || (hex.length !== 4 && hex.length !== 7)) return null;
  const h = hex.length === 4 ? hex.slice(1).replace(/./g, '$&$&') : hex.slice(1);
  const lin = (i: number): number => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
}

/** WCAG contrast ratio of two #hex colors; null when either is not a plain hex. */
export function contrastRatio(a: string, b: string): number | null {
  const x = luminance(a);
  const y = luminance(b);
  if (x === null || y === null) return null;
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Text color for a label on `fill`: the ink when it reads (AA), else white or near-black, whichever reads better. */
export function readableInk(fill: string, ink: string): string {
  const c = contrastRatio(ink, fill);
  if (c === null || c >= 4.5) return ink;
  return (contrastRatio('#ffffff', fill) ?? 0) >= (contrastRatio('#111827', fill) ?? 0) ? '#ffffff' : '#111827';
}

const STICKY_LIGHT: Readonly<Record<(typeof STICKY_IDS)[number], Sticky>> = {
  yellow: { bg: '#fde68a', fg: '#3b2f0b' },
  amber: { bg: '#fbbf24', fg: '#3b2506' },
  orange: { bg: '#fed7aa', fg: '#4a2306' },
  coral: { bg: '#fb7185', fg: '#3f0a14' },
  red: { bg: '#dc2626', fg: '#ffffff' },
  crimson: { bg: '#be123c', fg: '#ffffff' },
  pink: { bg: '#fbcfe8', fg: '#4a1030' },
  magenta: { bg: '#a21caf', fg: '#ffffff' },
  violet: { bg: '#7e22ce', fg: '#ffffff' },
  purple: { bg: '#ddd6fe', fg: '#2a1a5c' },
  lavender: { bg: '#a78bfa', fg: '#1e1147' },
  indigo: { bg: '#4338ca', fg: '#ffffff' },
  cobalt: { bg: '#2563eb', fg: '#ffffff' },
  blue: { bg: '#bfdbfe', fg: '#10294d' },
  sky: { bg: '#38bdf8', fg: '#082f49' },
  cyan: { bg: '#a5f3fc', fg: '#083344' },
  teal: { bg: '#0f766e', fg: '#ffffff' },
  mint: { bg: '#6ee7b7', fg: '#063d27' },
  green: { bg: '#bbf7d0', fg: '#0f3d1f' },
  emerald: { bg: '#15803d', fg: '#ffffff' },
  lime: { bg: '#bef264', fg: '#243304' },
  brown: { bg: '#92400e', fg: '#ffffff' },
  gray: { bg: '#e5e7eb', fg: '#1f2937' },
  slate: { bg: '#475569', fg: '#ffffff' },
  black: { bg: '#1f2937', fg: '#ffffff' },
};

const STICKY_DARK: Readonly<Record<(typeof STICKY_IDS)[number], Sticky>> = {
  yellow: { bg: '#876c0c', fg: '#fffbe8' },
  amber: { bg: '#92600a', fg: '#fff4d6' },
  orange: { bg: '#a95a14', fg: '#fff7ee' },
  coral: { bg: '#b94a55', fg: '#fff0f1' },
  red: { bg: '#a52a2a', fg: '#fff0f0' },
  crimson: { bg: '#9f1d46', fg: '#fff0f4' },
  pink: { bg: '#a34878', fg: '#fff0f8' },
  magenta: { bg: '#86217f', fg: '#fdf0fc' },
  violet: { bg: '#6a2ca0', fg: '#f8f1ff' },
  purple: { bg: '#6a56b3', fg: '#f3efff' },
  lavender: { bg: '#9059c9', fg: '#ffffff' },
  indigo: { bg: '#4b45b8', fg: '#f2f1ff' },
  cobalt: { bg: '#1d4fa8', fg: '#eef5ff' },
  blue: { bg: '#3b6fb6', fg: '#eef5ff' },
  sky: { bg: '#2b7a9e', fg: '#effaff' },
  cyan: { bg: '#16798a', fg: '#f2fdff' },
  teal: { bg: '#0f6b62', fg: '#e8fffb' },
  mint: { bg: '#1f8070', fg: '#f2fff9' },
  green: { bg: '#2f7d4a', fg: '#eafff1' },
  emerald: { bg: '#1f5a30', fg: '#eafff1' },
  lime: { bg: '#5f7d12', fg: '#fafff0' },
  brown: { bg: '#7a4220', fg: '#fff1e6' },
  gray: { bg: '#5c6370', fg: '#ffffff' },
  slate: { bg: '#2b3a4f', fg: '#f1f5f9' },
  black: { bg: '#111827', fg: '#f9fafb' },
};

const COLORS_LIGHT = {
  red: '#dc2626', orange: '#ea580c', yellow: '#ca8a04', lime: '#5f9a0a', green: '#16a34a', teal: '#0d9488', cyan: '#0891b2',
  blue: '#2563eb', indigo: '#4f46e5', purple: '#7c3aed', magenta: '#c026d3', pink: '#db2777', brown: '#92400e', gray: '#6b7280', white: '#ffffff',
} as const;

const COLORS_DARK = {
  red: '#f87171', orange: '#fb923c', yellow: '#facc15', lime: '#a3e635', green: '#4ade80', teal: '#2dd4bf', cyan: '#22d3ee',
  blue: '#60a5fa', indigo: '#818cf8', purple: '#a78bfa', magenta: '#e879f9', pink: '#f472b6', brown: '#c08457', gray: '#9ca3af', white: '#ffffff',
} as const;

/** Reasonable stand-in palette (tests, benchmark, previews); the product passes token-derived colors. */
export function defaultPalette(theme: 'light' | 'dark' = 'light'): CanvasPalette {
  const light = theme === 'light';
  return {
    background: light ? '#f7f7f8' : '#17181b',
    grid: light ? '#d4d4d8' : '#2e3036',
    accent: '#4f7cff',
    accentFill: 'rgba(79,124,255,0.12)',
    handleFill: light ? '#ffffff' : '#17181b',
    guide: '#ff4d8d',
    ink: light ? '#1f2937' : '#e5e7eb',
    plaque: light ? 'rgba(31,41,55,0.28)' : 'rgba(229,231,235,0.32)',
    labelBg: light ? '#f7f7f8' : '#17181b',
    colors: light ? COLORS_LIGHT : COLORS_DARK,
    sticky: light ? STICKY_LIGHT : STICKY_DARK,
    fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  };
}
