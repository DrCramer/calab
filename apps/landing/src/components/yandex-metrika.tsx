'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { forgetClientId, rememberClientId } from '@/lib/metrika';
import { hasSiteConsent, PREFERENCES_CHANGED } from '@/lib/site-preferences';

// Yandex Metrika (counter 113761661), loaded only after the visitor opts into the `analytics` purpose.
// Webvisor records sessions, so nothing is requested from mc.yandex.ru before consent. The official
// <noscript> pixel (https://mc.yandex.ru/watch/113761661) is deliberately omitted: it fires without
// JavaScript and therefore without consent.
const COUNTER_ID = 113761661;
const TAG_SRC = `https://mc.yandex.ru/metrika/tag.js?id=${COUNTER_ID}`;

type Ym = ((id: number, method: string, ...args: unknown[]) => void) & { a?: unknown[]; l?: number };
type YmWindow = Window & { ym?: Ym; dataLayer?: unknown[] };

let initialised = false;
let reportedPath = '';

// The official snippet, with its dedupe check: a second script tag is never added.
function load() {
  if (initialised) return;
  initialised = true;
  reportedPath = location.pathname;
  const w = window as YmWindow;
  if (!w.ym) {
    const queue: Ym = (...args) => { (queue.a = queue.a ?? []).push(args); };
    queue.l = Date.now();
    w.ym = queue;
  }
  if (!Array.from(document.scripts).some((s) => s.src === TAG_SRC)) {
    const script = document.createElement('script');
    script.async = true;
    script.src = TAG_SRC;
    document.head.appendChild(script);
  }
  w.dataLayer = w.dataLayer ?? [];
  w.ym(COUNTER_ID, 'init', {
    ssr: true, webvisor: true, clickmap: true, ecommerce: 'dataLayer',
    referrer: document.referrer, url: location.href, accurateTrackBounce: true, trackLinks: true,
  });
  // The ClientID goes with links to the app (lib/metrika.ts withUtm) for server-side conversions (ADR-0135).
  w.ym(COUNTER_ID, 'getClientID', rememberClientId);
}

// Best effort: first-party `_ym*` cookies and storage keys set by the tag on this origin. Cookies on
// mc.yandex.ru itself belong to Yandex and are not reachable from here.
function clean() {
  forgetClientId();
  try {
    const parts = location.hostname.split('.');
    const domains = ['', ...parts.slice(0, -1).map((_, i) => `.${parts.slice(i).join('.')}`)];
    for (const pair of document.cookie.split(';')) {
      const name = pair.split('=')[0]?.trim();
      if (!name?.startsWith('_ym')) continue;
      for (const d of domains) document.cookie = `${name}=; Max-Age=0; path=/${d ? `; domain=${d}` : ''}`;
    }
  } catch { /* Cookies unavailable: nothing to delete. */ }
  for (const kind of ['localStorage', 'sessionStorage'] as const) {
    try {
      const storage = window[kind];
      for (const key of Object.keys(storage)) if (key.startsWith('_ym')) storage.removeItem(key);
    } catch { /* Storage blocked. */ }
  }
}

export function YandexMetrika() {
  const pathname = usePathname();

  useEffect(() => {
    const sync = () => {
      if (hasSiteConsent('analytics')) { load(); return; }
      clean();
      // The tag cannot be unloaded: after withdrawal a running counter ends with a reload.
      if (initialised) location.reload();
    };
    sync();
    window.addEventListener(PREFERENCES_CHANGED, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(PREFERENCES_CHANGED, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  // The tag reports the page it was loaded on; later client-side route changes are sent as hits.
  useEffect(() => {
    const w = window as YmWindow;
    if (!initialised || !w.ym || reportedPath === location.pathname || !hasSiteConsent('analytics')) return;
    reportedPath = location.pathname;
    w.ym(COUNTER_ID, 'hit', location.href, { referrer: document.referrer });
  }, [pathname]);

  return null;
}
