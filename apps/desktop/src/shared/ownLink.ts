/**
 * Links to our own host (CBF-63): `https://<server>/t/KEY` and the other in-app routes must open in
 * the app, never in the browser (whose web page then offers «Открыть в Calab» for a moment).
 * Pure: the server origin is passed in (it is configuration, never a constant).
 */

const ID = '[0-9a-fA-F-]{36}';
const CODE = '[A-Za-z0-9_-]{4,64}';
const KEY = '[A-Za-z][A-Za-z0-9]{1,5}-[0-9]{1,7}';

/**
 * In-app routes the renderer's router knows (services/links.ts handleDeepLink): the same paths as
 * the `calab://` forms. `/e/<id>/rsvp`, `/download/`, `/api/…` and anything else are not here.
 */
const ROUTES: readonly RegExp[] = [
  new RegExp(`^/t/${KEY}/?$`),
  new RegExp(`^/b/${ID}/?$`),
  new RegExp(`^/m/${ID}/${ID}/?$`),
  new RegExp(`^/r/${CODE}/?$`),
  new RegExp(`^/join/${CODE}/?$`),
  new RegExp(`^/dm/${ID}/?$`),
  new RegExp(`^/e/${ID}/?$`),
  new RegExp(`^/wiki/${ID}/?$`),
  new RegExp(`^/disk/${ID}/?$`),
];

function ownAppPath(href: string, serverUrl: string): string | null {
  let u: URL;
  let s: URL;
  try {
    u = new URL(href.trim());
    s = new URL(serverUrl.trim());
  } catch {
    return null;
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.protocol !== s.protocol || u.host.toLowerCase() !== s.host.toLowerCase()) return null;
  if (u.username || u.password) return null;
  return ROUTES.some((r) => r.test(u.pathname)) ? u.pathname : null;
}

/** True when `href` is an http(s) link to the server's own origin and a known in-app route. */
export function isOwnAppLink(href: string, serverUrl: string): boolean {
  return ownAppPath(href, serverUrl) !== null;
}

/** `https://<server>/t/KEY?x` → `calab://t/KEY` (the deep-link channel into the renderer); null = not ours. */
export function ownLinkToDeepLink(href: string, serverUrl: string): string | null {
  const p = ownAppPath(href, serverUrl);
  return p ? `calab:/${p}` : null;
}
