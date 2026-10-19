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
  const first = Object.values(p.sticky)[0];
  return first ?? { bg: '#fde68a', fg: '#1f2937' };
}

const STICKY_LIGHT = {
  yellow: { bg: '#fde68a', fg: '#3b2f0b' },
  green: { bg: '#bbf7d0', fg: '#0f3d1f' },
  blue: { bg: '#bfdbfe', fg: '#10294d' },
  pink: { bg: '#fbcfe8', fg: '#4a1030' },
  orange: { bg: '#fed7aa', fg: '#4a2306' },
  purple: { bg: '#ddd6fe', fg: '#2a1a5c' },
  gray: { bg: '#e5e7eb', fg: '#1f2937' },
} as const;

const STICKY_DARK = {
  yellow: { bg: '#a88b1d', fg: '#fff8dc' },
  green: { bg: '#2f7d4a', fg: '#eafff1' },
  blue: { bg: '#3b6fb6', fg: '#eef5ff' },
  pink: { bg: '#a34878', fg: '#fff0f8' },
  orange: { bg: '#b7691f', fg: '#fff3e6' },
  purple: { bg: '#6a56b3', fg: '#f3efff' },
  gray: { bg: '#4b5563', fg: '#f3f4f6' },
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
    colors: {
      red: light ? '#dc2626' : '#f87171',
      orange: light ? '#ea580c' : '#fb923c',
      yellow: light ? '#ca8a04' : '#facc15',
      green: light ? '#16a34a' : '#4ade80',
      blue: light ? '#2563eb' : '#60a5fa',
      purple: light ? '#7c3aed' : '#a78bfa',
      gray: light ? '#6b7280' : '#9ca3af',
      white: '#ffffff',
    },
    sticky: light ? STICKY_LIGHT : STICKY_DARK,
    fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  };
}
