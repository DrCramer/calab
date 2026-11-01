import { platform } from '../platform';
import { openOwnLink, shareOrigin } from './links';

/** Content links are untrusted. Resolve relative authorities/routes against this server, never a base tag. */
export function contentHref(raw: string): string | null {
  const href = raw.trim();
  if (!href) return null;
  for (const c of href) {
    if (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || c === '\\') return null;
  }
  const origin = shareOrigin('');
  try {
    const url = href.startsWith('/') && origin ? new URL(href, `${origin}/`) : new URL(href);
    if (!['https:', 'http:', 'mailto:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

/** Synchronous gesture routing. True means handed off, not that the platform confirmed opening. */
export function openContentLink(raw: string, pages?: { idOf: (href: string) => string | null; open: (id: string) => void } | null): boolean {
  const href = contentHref(raw);
  if (!href) return false;
  const page = pages?.idOf(href);
  if (page) { pages?.open(page); return true; }
  // mailto goes to the OS, never the desktop-only Mail deep-link handler.
  if (!href.startsWith('mailto:') && openOwnLink(href)) return true;
  void platform.app.openExternal(href);
  return true;
}
