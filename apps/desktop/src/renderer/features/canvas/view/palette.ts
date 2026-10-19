/**
 * The engine never reads CSS: this resolves the app's tokens (docs/08) for the current theme into its
 * `CanvasPalette`. Surface, ink and accent follow the tokens; the named colors (sticky notes, shape
 * colors) are the engine's per-theme tables, which keep the stored token names readable in both themes.
 */
import { avatarColor } from '../../../components/Avatar';
import { defaultPalette, type CanvasPalette } from '../engine';

export type CanvasTheme = 'light' | 'dark';

export function currentTheme(root: HTMLElement = document.documentElement): CanvasTheme {
  return root.dataset['theme'] === 'light' ? 'light' : 'dark';
}

function token(style: CSSStyleDeclaration, name: string): string | null {
  const v = style.getPropertyValue(name).trim();
  return v ? v : null;
}

/** The palette for `theme`, reading the tokens from `root` (falls back to the engine's stand-ins in tests). */
export function readCanvasPalette(theme: CanvasTheme, root: HTMLElement = document.documentElement): CanvasPalette {
  const base = defaultPalette(theme);
  if (typeof getComputedStyle === 'undefined') return base;
  const st = getComputedStyle(root);
  const bg = token(st, '--color-bg') ?? base.background;
  const font = token(st, '--font-sans');
  return {
    ...base,
    background: bg,
    handleFill: bg,
    labelBg: bg,
    ink: token(st, '--color-label') ?? base.ink,
    accent: token(st, '--color-accent') ?? base.accent,
    ...(font ? { fontFamily: font } : {}),
  };
}

const AVATAR_VAR = /var\((--avatar-\d+)\)/;
const FALLBACK = '#0063cc';

/** The cursor color of a user: their avatar identity color, resolved to a literal (awareness carries literals). */
export function cursorColor(userId: string, root: HTMLElement = document.documentElement): string {
  const m = AVATAR_VAR.exec(avatarColor(userId));
  if (!m || typeof getComputedStyle === 'undefined') return FALLBACK;
  const v = getComputedStyle(root).getPropertyValue(m[1] ?? '').trim();
  return /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : FALLBACK;
}
