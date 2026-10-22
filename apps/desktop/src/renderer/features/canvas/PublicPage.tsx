import type { PublicCanvas } from '@calaba/protocol';
import { Eye, Link2Off, Shapes, Users } from 'lucide-react';
import { Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Spinner } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { ApiError } from '../../lib/api/client';
import { serverClockOffset } from '../../lib/canvas/serverClock';
import { backoffDelay } from '../../lib/gateway/client';
import { useMobile } from '../../lib/mobile';
import { CLOSE_RATE } from '../../lib/ySync';
import { canvasPublic } from '../../services/canvasPublic';
import { useSession } from '../../stores/session';
import { CanvasViewLazy } from './lazy';
import type { CanvasViewDeps } from './view/session';

/** The view's id of the public canvas (its real id is never sent to an anonymous visitor). */
const PUBLIC_ID = 'public';
const noop = (): void => undefined;
const serverUrl = (): string => useSession.getState().serverUrl || window.location.origin;

/**
 * The connection of the anonymous viewer: no token, nobody signed in, the real WebSocket. A socket that fails before
 * it opens (a refused code is a 404 before the upgrade, which a browser's WebSocket cannot read) asks again with HEAD
 * (not a view): a 404 ends the page, anything else leaves the provider's backoff (1 s → 30 s) to retry. Too many
 * viewers — a close 4008 (the link's or this network's sockets: one office behind one address), a 429 on the HEAD —
 * is `onBusy(true)` while the provider retries; the first frame of a socket is `onBusy(false)`.
 */
export function publicDeps(
  code: string,
  onGone: () => void,
  onBusy: (busy: boolean) => void,
  make: (url: string) => WebSocket = (url) => new WebSocket(url),
): CanvasViewDeps {
  return {
    serverUrl,
    getToken: () => Promise.resolve(null),
    createSocket: (url) => {
      const ws = make(url);
      let opened = false;
      ws.addEventListener('open', () => {
        opened = true;
      });
      ws.addEventListener('message', () => onBusy(false), { once: true });
      ws.addEventListener('close', (ev) => {
        if (ev.code === CLOSE_RATE) onBusy(true);
        if (!opened) {
          void canvasPublic.probe(serverUrl(), code).then((s) => {
            if (s === 'gone') onGone();
            else if (s === 'busy') onBusy(true);
          });
        }
      });
      return ws;
    },
    user: () => ({ id: '', name: '' }),
    serverClockOffset: () => serverClockOffset(serverUrl()),
  };
}

/**
 * `/c/{code}` — a canvas seen through its public link, without signing in (ADR-0116 wave 5, docs/08 «Холст:
 * публичная ссылка»): the name and «Только просмотр» above the canvas in view only — no app shell, tools, comments,
 * voting, cursors or avatars (CanvasView `publicCode`), pan and pinch on the phone. The name comes first (it counts
 * a view and proves the link); then the canvas chunk and its receive-only socket. A revoked / expired / private /
 * deleted canvas is one neutral screen; the server closes a live socket within seconds when that happens. Too many
 * viewers from one network (the server's per-address limit; a 429 on the name, a close 4008 of the socket) is a line
 * under the header while the page retries by itself, not that screen. `noindex` + no-referrer like the wiki's public
 * page.
 */
export function CanvasPublicPage({ code }: { code: string }): ReactNode {
  useLocale();
  const phone = useMobile();
  const [meta, setMeta] = useState<PublicCanvas | null>(null);
  const [gone, setGone] = useState(false);
  const [busy, setBusy] = useState(false);
  const toGone = useCallback(() => setGone(true), []);
  const deps = useMemo(() => publicDeps(code, toGone, setBusy), [code, toGone]);

  useEffect(() => {
    const robots = document.createElement('meta');
    robots.name = 'robots';
    robots.content = 'noindex,nofollow';
    const referrer = document.createElement('meta');
    referrer.name = 'referrer';
    referrer.content = 'no-referrer';
    document.head.append(robots, referrer);
    return () => {
      robots.remove();
      referrer.remove();
    };
  }, []);

  useEffect(() => {
    const ctl = new AbortController();
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = (): void => {
      canvasPublic.meta(code, ctl.signal).then(
        (m) => {
          setBusy(false);
          setMeta(m);
          document.title = `${m.name || t('canvas.untitled')} · Calab`;
        },
        (e: unknown) => {
          if (ctl.signal.aborted) return;
          // 404 = revoked / expired / private / deleted. A 429 (too many requests from this network) or a failure
          // says nothing about the link: again, with the sockets' backoff.
          if (e instanceof ApiError && e.status === 404) {
            setGone(true);
            return;
          }
          if (e instanceof ApiError && e.status === 429) setBusy(true);
          retry = setTimeout(load, backoffDelay(attempt++, Math.random()));
        },
      );
    };
    load();
    return () => {
      ctl.abort();
      clearTimeout(retry);
    };
  }, [code]);

  if (gone) return <Gone />;
  return (
    <div className="flex h-full flex-col bg-main text-fg mobile:pt-[var(--safe-top,0px)]" data-testid="canvas-public">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4" data-testid="canvas-public-header">
        <Shapes className="size-4 shrink-0 text-muted" aria-hidden />
        <h1 className="min-w-0 truncate text-body font-semibold" data-testid="canvas-public-title">
          {meta ? meta.name || t('canvas.untitled') : ''}
        </h1>
        <span className="flex-1" />
        <span className="flex shrink-0 items-center gap-1.5 text-caption text-muted" data-testid="canvas-public-readonly">
          <Eye className="size-3.5" aria-hidden />
          {t('canvasShare.public.readOnly')}
        </span>
      </header>
      {busy ? (
        <div role="status" className="flex shrink-0 items-center justify-center gap-2 border-b border-line px-4 py-2 text-caption text-muted" data-testid="canvas-public-busy">
          <Users className="size-3.5 shrink-0" aria-hidden />
          <span>{t('canvasShare.public.busy')}</span>
        </div>
      ) : null}
      <main className="relative min-h-0 flex-1 pb-[var(--safe-bottom,0px)]">
        {meta ? (
          <Suspense fallback={<Loading />}>
            <CanvasViewLazy canvasId={PUBLIC_ID} workspaceId="" bits={0n} name={meta.name} onOpenHistory={noop} onShare={noop} phone={phone} publicCode={code} onFatal={toGone} deps={deps} />
          </Suspense>
        ) : (
          <Loading />
        )}
      </main>
    </div>
  );
}

function Loading(): ReactNode {
  return (
    <div className="grid h-full place-items-center">
      <Spinner />
    </div>
  );
}

function Gone(): ReactNode {
  return (
    <div className="grid h-full place-items-center bg-bg px-6 text-fg" data-testid="canvas-public-gone">
      <div className="flex max-w-[360px] flex-col items-center gap-3 text-center">
        <Link2Off className="size-10 text-muted" strokeWidth={1.25} aria-hidden />
        <h1 className="text-title font-semibold">{t('canvasShare.public.gone')}</h1>
        <p className="text-body text-muted">{t('canvasShare.public.goneText')}</p>
      </div>
    </div>
  );
}
