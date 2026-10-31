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
 * original ids (their values were refreshed 23.10, see below); every pair clears
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

// Clean, bright sticky notes after FigJam (owner, 23.10): light-theme pastels with dark ink; the dark theme
// keeps the same hues slightly dimmed (pastels stay pastel with dark ink, the saturated ones go deeper with light ink).
const STICKY_LIGHT: Readonly<Record<(typeof STICKY_IDS)[number], Sticky>> = {
  yellow: { bg: '#ffe866', fg: '#3b2f0b' },
  amber: { bg: '#ffbf3d', fg: '#3b2506' },
  orange: { bg: '#ffc58a', fg: '#4a2306' },
  coral: { bg: '#ff8a80', fg: '#3f0a14' },
  red: { bg: '#dc2626', fg: '#ffffff' },
  crimson: { bg: '#be123c', fg: '#ffffff' },
  pink: { bg: '#ffc2e2', fg: '#4a1030' },
  magenta: { bg: '#a21caf', fg: '#ffffff' },
  violet: { bg: '#7c3aed', fg: '#ffffff' },
  purple: { bg: '#d9ccff', fg: '#2a1a5c' },
  lavender: { bg: '#a78bfa', fg: '#1e1147' },
  indigo: { bg: '#4338ca', fg: '#ffffff' },
  cobalt: { bg: '#2563eb', fg: '#ffffff' },
  blue: { bg: '#aed4ff', fg: '#10294d' },
  sky: { bg: '#4cc2ff', fg: '#082f49' },
  cyan: { bg: '#9ef0ff', fg: '#083344' },
  teal: { bg: '#0f766e', fg: '#ffffff' },
  mint: { bg: '#5fe3b0', fg: '#063d27' },
  green: { bg: '#c1f2cf', fg: '#0f3d1f' },
  emerald: { bg: '#15803d', fg: '#ffffff' },
  lime: { bg: '#c8f560', fg: '#243304' },
  brown: { bg: '#92400e', fg: '#ffffff' },
  gray: { bg: '#e6e8ec', fg: '#1f2937' },
  slate: { bg: '#475569', fg: '#ffffff' },
  black: { bg: '#1e1e1e', fg: '#ffffff' },
};

const STICKY_DARK: Readonly<Record<(typeof STICKY_IDS)[number], Sticky>> = {
  yellow: { bg: '#e6cf55', fg: '#2b2405' },
  amber: { bg: '#e0a52b', fg: '#2e1c03' },
  orange: { bg: '#e8a97c', fg: '#3a1b05' },
  coral: { bg: '#e6736b', fg: '#3a0a10' },
  red: { bg: '#b8322b', fg: '#fff0f0' },
  crimson: { bg: '#a8244f', fg: '#fff0f4' },
  pink: { bg: '#e0a3c6', fg: '#3a0f27' },
  magenta: { bg: '#9a2aa8', fg: '#fdf0fc' },
  violet: { bg: '#8247d9', fg: '#f8f1ff' },
  purple: { bg: '#b8a9e8', fg: '#231550' },
  lavender: { bg: '#9c85e6', fg: '#190e3b' },
  indigo: { bg: '#4b45b8', fg: '#f2f1ff' },
  cobalt: { bg: '#2b5fc4', fg: '#eef5ff' },
  blue: { bg: '#8fb8e8', fg: '#0e2342' },
  sky: { bg: '#55b4e0', fg: '#052a40' },
  cyan: { bg: '#6cc9d6', fg: '#06303b' },
  teal: { bg: '#0f7066', fg: '#e8fffb' },
  mint: { bg: '#55c9a0', fg: '#052f20' },
  green: { bg: '#8fd1a3', fg: '#0c2e18' },
  emerald: { bg: '#217a3c', fg: '#eafff1' },
  lime: { bg: '#a8cf4e', fg: '#1f2b04' },
  brown: { bg: '#7a4220', fg: '#fff1e6' },
  gray: { bg: '#9aa1ad', fg: '#1a1f28' },
  slate: { bg: '#2b3a4f', fg: '#f1f5f9' },
  black: { bg: '#111827', fg: '#f9fafb' },
};

const COLORS_LIGHT = {
  red: '#e5352b', orange: '#f57c00', yellow: '#f2b800', lime: '#5f9f0c', green: '#1fa457', teal: '#0d9e90', cyan: '#0891b2',
  blue: '#2f6df6', indigo: '#5b5bf0', purple: '#8b4df0', magenta: '#cf35d6', pink: '#ec3f8f', brown: '#9a5524', gray: '#6b7280', white: '#ffffff',
} as const;

const COLORS_DARK = {
  red: '#ff6b61', orange: '#ff9d3d', yellow: '#ffd633', lime: '#b6e34a', green: '#4fd88a', teal: '#2fd1bd', cyan: '#3ccbf0',
  blue: '#5b9bff', indigo: '#8c8cff', purple: '#b184ff', magenta: '#ea6df0', pink: '#ff6fae', brown: '#c08457', gray: '#9ca3af', white: '#ffffff',
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
