/**
 * Whether `url` is this server's task / board link (`/t/<KEY-N>`, `/b/<id>` on the server's or the
 * web client's origin): 'task' / 'board', else null. Pure (tests).
 */
export function ownBoardLink(url: string, serverUrl: string, webOrigin = typeof location !== 'undefined' ? location.origin : ''): 'task' | 'board' | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const origins = [serverUrl, webOrigin].map((s) => {
    try {
      return s ? new URL(s).origin : '';
    } catch {
      return '';
    }
  });
  if (!origins.includes(u.origin)) return null;
  const m = /^\/(t|b)\/[^/]+\/?$/.exec(u.pathname);
  return m ? (m[1] === 't' ? 'task' : 'board') : null;
}
