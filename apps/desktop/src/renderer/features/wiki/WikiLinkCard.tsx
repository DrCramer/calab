import { FileText, FileX } from 'lucide-react';
import { memo, useEffect, type MouseEvent, type ReactNode } from 'react';
import { cx } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import type { MdNode } from '../../lib/markdown/parse';
import { ancestorsOf } from '../../lib/wiki/tree';
import { ownWikiPageId, wikiPageUrl } from '../../services/links';
import { ensureWikiPage, openWikiLink } from '../../services/wiki';
import { useWiki } from '../../stores/wiki';
import { refView, useWikiRefs } from '../../stores/wikiRefs';

/** The first link of a message to a wiki page of this server (its card goes under the text), or null. */
export function firstWikiPage(nodes: readonly MdNode[]): string | null {
  for (const n of nodes) {
    if (n.t === 'link') {
      const id = ownWikiPageId(n.href);
      if (id) return id;
    } else if (n.t === 'b' || n.t === 'i' || n.t === 's') {
      const inner = firstWikiPage(n.c);
      if (inner) return inner;
    }
  }
  return null;
}

/** The crumbs of a page as one string (a primitive: the card re-renders only when they change). */
function crumbsOf(pages: Parameters<typeof ancestorsOf>[0], id: string, untitled: string): string {
  return ancestorsOf(pages, id)
    .map((a) => pages[a]?.title || untitled)
    .join(' / ');
}

const BOX =
  'mt-1.5 flex w-full min-w-0 max-w-[400px] items-center gap-2 rounded-[var(--radius-row)] border-l-[3px] border-l-[color:var(--bubble-accent)] bg-[color-mix(in_srgb,var(--bubble-accent)_10%,transparent)] py-1.5 pl-2 pr-2 text-left';

/**
 * A wiki page link in a message (owner 14.10): a compact card under the text — icon, title, crumbs,
 * «Открыть». Resolved on this computer by the page GET (lib: services/wiki resolveWikiPage, once
 * per id), so each viewer sees it by their own rights: no access → «Страница недоступна» and no
 * title. A leaf with its own selectors: resolving re-renders this card only, never the feed.
 */
export const WikiLinkCard = memo(function WikiLinkCard({ pageId }: { pageId: string }): ReactNode {
  useLocale();
  const known = useWiki((s) => !!s.pages[pageId]);
  const title = useWiki((s) => s.pages[pageId]?.title ?? '');
  const icon = useWiki((s) => s.pages[pageId]?.icon ?? '');
  const crumbs = useWiki((s) => (s.pages[pageId] ? crumbsOf(s.pages, pageId, t('wiki.untitled')) : ''));
  const st = useWikiRefs((s) => s.state[pageId]);
  useEffect(() => ensureWikiPage(pageId), [pageId]);
  const view = refView(known, st);

  if (view === 'unavailable') {
    return (
      <div className={cx(BOX, 'text-[color:var(--bubble-meta)]')} data-testid="wiki-link-card" data-state="unavailable">
        <FileX className="size-5 shrink-0" strokeWidth={1.75} aria-hidden />
        <span className="min-w-0 truncate text-body">{t('wiki.unavailable')}</span>
      </div>
    );
  }
  const open = (e: MouseEvent): void => {
    e.preventDefault();
    openWikiLink(pageId);
  };
  return (
    <a href={wikiPageUrl(pageId) ?? undefined} onClick={open} className={cx(BOX, 'group/wiki hover:bg-[color-mix(in_srgb,var(--bubble-accent)_16%,transparent)]')} data-testid="wiki-link-card" data-state={view}>
      <span className="grid size-6 shrink-0 place-items-center text-[18px] leading-none text-[color:var(--bubble-accent)]" aria-hidden>
        {icon || <FileText className="size-5" strokeWidth={1.75} />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body font-semibold leading-5 text-fg">{view === 'loading' ? t('wiki.card.label') : title || t('wiki.untitled')}</span>
        <span className="truncate text-caption text-[color:var(--bubble-meta)]">{view === 'loading' ? t('wiki.pageLink.loading') : crumbs || t('wiki.card.label')}</span>
      </span>
      <span className="shrink-0 rounded-[var(--radius-row)] px-2 py-1 text-caption font-medium text-[color:var(--bubble-accent)] group-hover/wiki:bg-[color-mix(in_srgb,var(--bubble-accent)_14%,transparent)]">
        {t('wiki.card.open')}
      </span>
    </a>
  );
});
