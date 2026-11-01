/**
 * Links to our own server (CBF-63): `https://<server>/t/KEY` and the other in-app routes must open in
 * the app, never in the browser (whose web page then offers «Открыть в Calab» for a moment). The one
 * classification every click path uses — message text, link cards, the mail view, notifications
 * (via the openExternal IPC), window.open and middle clicks (main's window-open handler).
 *
 * «Ours» is a set of origins, never a constant (CLAUDE.md, configuration only):
 * - the server the app talks to — the live session's and the configured one (they differ after a
 *   restored pre-2.0 session: session on app.calab.ru, settings on app.calab.io);
 * - the app origins of the same deployment (env `CALABA_APP_ORIGINS` / `MAIN_VITE_APP_ORIGINS`,
 *   web `VITE_APP_ORIGINS`; docs/06 «Домены»: app.calab.io, the eternal alias app.calab.ru, …) —
 *   but only when one of the servers above is in that list: a self-hosted server never treats the
 *   cloud's links as its own.
 * Only the path of such a link is used (the app routes it against its own server); the link's
 * origin is never loaded. Pure: the origins are passed in.
 */

const ID = '[0-9a-fA-F-]{36}';
const CODE = '[A-Za-z0-9_-]{4,64}';
/** The server's task-key rule (apps/server/internal/boards/model.go taskKeyRE). */
const KEY = '[A-Za-z][A-Za-z0-9]{1,5}-[0-9]{1,9}';

/**
 * In-app routes the renderer's router knows (services/links.ts handleDeepLink): the same paths as
 * the `calab://` forms. `/` is the app itself. Everything else on our host — `/e/<id>/rsvp`,
 * `/download/`, `/c/<code>` (public canvas), `/api/…` — is a web-only page: the browser.
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
  new RegExp(`^/canvas/${ID}/?$`),
  new RegExp(`^/disk/${ID}/?$`),
  /^\/plans\/?$/,
];

/** The canonical origin of an http(s) URL without userinfo; null otherwise. */
function originOf(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** A space / comma separated origin list from env (junk entries dropped). */
export function parseOriginList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[\s,]+/)
    .map(originOf)
    .filter((o): o is string => !!o);
}

/**
 * Our origins: every server's origin, plus the deployment's app origins when one of the servers is
 * among them. Empty / invalid servers are skipped.
 */
export function ownOrigins(servers: readonly string[], appOrigins: readonly string[]): string[] {
  const out = new Set<string>();
  for (const s of servers) {
    const o = originOf(s);
    if (o) out.add(o);
  }
  const group = appOrigins.map(originOf).filter((o): o is string => !!o);
  if (group.some((o) => out.has(o))) for (const o of group) out.add(o);
  return [...out];
}

/**
 * What a click on `href` does:
 * - `app` — an in-app route of our server: `deepLink` (`calab://…`) goes to the renderer's router;
 * - `own-page` — our host, but a web-only page (downloads, public pages, the API): the browser;
 * - `external` — any other http(s) host: the browser;
 * - `invalid` — anything else (other schemes, userinfo, control characters): nothing opens.
 */
export type LinkClass =
  | { kind: 'app'; path: string; deepLink: string }
  | { kind: 'own-page'; url: string }
  | { kind: 'external'; url: string }
  | { kind: 'invalid' };

export function classifyLink(href: string, origins: readonly string[]): LinkClass {
  const raw = href.trim();
  // eslint-disable-next-line no-control-regex -- a control character or a backslash is never a link we route
  if (!raw || raw.length > 2048 || /[\u0000-\u001f\u007f\\]/.test(raw)) return { kind: 'invalid' };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { kind: 'invalid' };
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return { kind: 'invalid' };
  const own = origins.some((o) => originOf(o) === u.origin);
  if (!own) return { kind: 'external', url: u.href };
  const path = u.pathname;
  if (path === '/') return { kind: 'app', path, deepLink: 'calab://' };
  if (!ROUTES.some((r) => r.test(path))) return { kind: 'own-page', url: u.href };
  return { kind: 'app', path, deepLink: `calab:/${path}${path.startsWith('/plans') ? planQuery(u) : ''}` };
}

/** True when `href` is an http(s) link to one of our origins and a known in-app route. */
export function isOwnAppLink(href: string, origins: readonly string[]): boolean {
  return classifyLink(href, origins).kind === 'app';
}

/** The `?plan=` of a plans link survives the hop into `calab://plans`; any other query is dropped. */
function planQuery(u: URL): string {
  const v = u.searchParams.get('plan');
  return v && /^[A-Za-z]{1,16}$/.test(v) ? `?plan=${v}` : '';
}
