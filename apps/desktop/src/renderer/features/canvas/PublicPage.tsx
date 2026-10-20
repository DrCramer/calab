import type { PublicCanvas } from '@calaba/protocol';
import { Eye, Link2Off, Shapes } from 'lucide-react';
import { Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Spinner } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { serverClockOffset } from '../../lib/canvas/serverClock';
import { useMobile } from '../../lib/mobile';
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
 * (not a view): a 404 ends the page, anything else leaves the provider's backoff (1 s → 30 s) to retry.
 */
export function publicDeps(code: string, onGone: () => void, make: (url: string) => WebSocket = (url) => new WebSocket(url)): CanvasViewDeps {
  return {
    serverUrl,
    getToken: () => Promise.resolve(null),
    createSocket: (url) => {
      const ws = make(url);
      let opened = false;
      ws.addEventListener('open', () => {
        opened = true;
      });
      ws.addEventListener('close', () => {
        if (!opened) void canvasPublic.alive(serverUrl(), code).then((ok) => ok || onGone());
      });
      return ws;
    },
    user: () => ({ id: '', name: '' }),
    serverClockOffset: () => serverClockOffset(serverUrl()),
  };
}

/**
 * `/c/{code}` — a canvas seen through its public link, without signing in (ADR-0115 wave 5, docs/08 «Холст:
 * публичная ссылка»): the name and «Только просмотр» above the canvas in view only — no app shell, tools, comments,
 * voting, cursors or avatars (CanvasView `publicCode`), pan and pinch on the phone. The name comes first (it counts
 * a view and proves the link); then the canvas chunk and its receive-only socket. A revoked / expired / private /
 * deleted canvas is one neutral screen; the server closes a live socket within seconds when that happens.
 * `noindex` + no-referrer like the wiki's public page.
 */
export function CanvasPublicPage({ code }: { code: string }): ReactNode {
  useLocale();
  const phone = useMobile();
  const [meta, setMeta] = useState<PublicCanvas | null>(null);
  const [gone, setGone] = useState(false);
  const toGone = useCallback(() => setGone(true), []);
  const deps = useMemo(() => publicDeps(code, toGone), [code, toGone]);

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
    canvasPublic.meta(code, ctl.signal).then(
      (m) => {
        setMeta(m);
        document.title = `${m.name || t('canvas.untitled')} · Calab`;
      },
      () => {
        // 404 = revoked / expired / private / deleted; anything else (429, network) reads the same to a visitor.
        if (!ctl.signal.aborted) setGone(true);
      },
    );
    return () => ctl.abort();
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
