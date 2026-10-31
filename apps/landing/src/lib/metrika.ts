// Yandex Metrika goals (counter 113761661) and UTM passthrough to app links.
// Goals reach Metrika only when the tag is loaded, i.e. after the visitor opted into `analytics`
// (components/yandex-metrika.tsx): without consent window.ym does not exist and goal() does nothing.
// Nothing is queued before consent. UTM passthrough does not touch a third party and holds no personal
// data, so it works without consent. The Metrika ClientID (`ym_cid`) is added to app links only after
// consent: it comes from the tag itself (getClientID), which loads only then. The app sends it with the
// registration, and the server reports sign-up and payment conversions for it (ADR-0135).
import { APP_URL, CONTACT_FORM_URL, DOWNLOADS } from './site';

export const COUNTER_ID = 113761661;

export type GoalId =
  | 'download_click'
  | 'open_web_app'
  | 'plan_buy_click'
  | 'payment_success'
  | 'contact_click'
  | 'support_chat_open'
  | 'pricing_view'
  | 'docs_open';

export function goal(id: GoalId, params?: Record<string, string>): void {
  const ym = (window as Window & { ym?: (...a: unknown[]) => void }).ym;
  if (typeof ym !== 'function') return;
  if (params) ym(COUNTER_ID, 'reachGoal', id, params);
  else ym(COUNTER_ID, 'reachGoal', id);
}

const UTM_KEY = 'calab_utm';
const UTM_PARAM = /^(utm_[a-z0-9_]+|yclid)$/i;

/** Remember utm_* / yclid of the landing URL for this tab session. */
export function captureUtm(search: string = location.search): void {
  try {
    const found = new URLSearchParams();
    for (const [k, v] of new URLSearchParams(search)) if (UTM_PARAM.test(k) && v) found.set(k, v.slice(0, 200));
    if (found.size) sessionStorage.setItem(UTM_KEY, found.toString());
  } catch { /* Storage blocked: attribution is best effort. */ }
}

let clientId = '';

/** Remember the Metrika ClientID the tag reports (ym getClientID callback; the tag runs only after consent). */
export function rememberClientId(id: unknown): void {
  const v = typeof id === 'string' || typeof id === 'number' ? String(id) : '';
  if (/^\d{1,32}$/.test(v)) clientId = v;
}

/** Forget the ClientID (consent withdrawn). */
export function forgetClientId(): void {
  clientId = '';
}

/**
 * `href` with the stored campaign params and, after analytics consent, the Metrika ClientID (`ym_cid`)
 * added (existing params win). Unchanged when there is nothing to add.
 */
export function withUtm(href: string): string {
  try {
    const stored = sessionStorage.getItem(UTM_KEY);
    if (!stored && !clientId) return href;
    const url = new URL(href);
    for (const [k, v] of new URLSearchParams(stored ?? '')) if (!url.searchParams.has(k)) url.searchParams.set(k, v);
    if (clientId && !url.searchParams.has('ym_cid')) url.searchParams.set('ym_cid', clientId);
    return url.toString();
  } catch {
    return href;
  }
}

export const isApp = (href: string): boolean =>
  href === APP_URL || href.startsWith(`${APP_URL}/`) || href.startsWith(`${APP_URL}?`);

const OS_BY_FILE: [string, string][] = [
  [DOWNLOADS.macArm64, 'mac-arm64'],
  [DOWNLOADS.macX64, 'mac-x64'],
  [DOWNLOADS.win, 'win'],
  [DOWNLOADS.appImage, 'linux-appimage'],
  [DOWNLOADS.deb, 'linux-deb'],
];

/** Which goal (if any) a click on a link counts as. `href` is the attribute value, `currentPath` the page path. */
export function goalForHref(href: string, currentPath = ''): { id: GoalId; params?: Record<string, string> } | null {
  const file = OS_BY_FILE.find(([url]) => href === url);
  if (file) return { id: 'download_click', params: { os: file[1] } };
  if (isApp(href)) {
    const url = new URL(href);
    if (url.pathname === '/plans') return { id: 'plan_buy_click', params: { plan: url.searchParams.get('plan') ?? '' } };
    return { id: 'open_web_app' };
  }
  if (href.startsWith(CONTACT_FORM_URL) || href.toLowerCase() === 'mailto:support@calab.io') return { id: 'contact_click' };
  // Developer docs are same-origin pages; a click inside the docs themselves is navigation, not an opening.
  if (/^\/[a-z]{2}\/docs\//.test(href) && !/^\/[a-z]{2}\/docs\//.test(currentPath)) return { id: 'docs_open' };
  return null;
}
