/**
 * Internal wiki page addresses (owner 14.10): `https://<app origin>/wiki/<page id>`. The page id is
 * the address; the origin is whatever server the link was made on, so documents and Markdown match
 * on the path alone (origin-agnostic) — a page link survives a domain change or an export to
 * another server. Pure, no DOM: shared by the editor, the chat, the deep-link router and the bot SDK.
 */

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PAGE_HREF_RE = new RegExp(`^(?:https?://[^/\\s?#]+)?/wiki/(${UUID})/?(?:[?#]\\S*)?$`, 'i');

/** The page id of a wiki page address (absolute on any origin, or the bare `/wiki/<id>` path); null otherwise. */
export function wikiPageIdOf(href: string): string | null {
  const m = PAGE_HREF_RE.exec(href.trim());
  return m?.[1]?.toLowerCase() ?? null;
}

/** The address of a page on `origin` ('' → the bare path). */
export function wikiPageHref(origin: string, pageId: string): string {
  return `${origin.replace(/\/+$/, '')}/wiki/${pageId}`;
}
