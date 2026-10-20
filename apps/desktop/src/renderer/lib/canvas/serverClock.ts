/**
 * `serverNow − localNow` in ms for the canvas timer (ADR-0115): one light request, the server's `Date` (whole seconds;
 * +½ s) against our clock around the round trip; null when the header is missing. `/api/version` is anonymous, so the
 * public link's viewer uses it too.
 */
export async function serverClockOffset(serverUrl: string): Promise<number | null> {
  const t0 = Date.now();
  const res = await fetch(`${serverUrl}/api/version`, { cache: 'no-store' });
  const t1 = Date.now();
  const date = res.headers.get('Date');
  const server = date ? Date.parse(date) : NaN;
  return Number.isFinite(server) ? server + 500 - (t0 + t1) / 2 : null;
}
