import { FileText, FileX } from 'lucide-react';
import { memo, useEffect, type ReactNode } from 'react';
import { LinkCard } from '../../components/LinkCard';
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
  return (
    <LinkCard
      testId="wiki-link-card"
      state={view}
      href={wikiPageUrl(pageId) ?? undefined}
      onOpen={() => openWikiLink(pageId)}
      icon={icon || <FileText className="size-5" strokeWidth={1.75} />}
      title={view === 'loading' ? t('wiki.card.label') : title || t('wiki.untitled')}
      sub={view === 'loading' ? t('wiki.pageLink.loading') : crumbs || t('wiki.card.label')}
      openLabel={t('wiki.card.open')}
      unavailableIcon={<FileX className="size-5 shrink-0" strokeWidth={1.75} aria-hidden />}
      unavailableLabel={t('wiki.unavailable')}
    />
  );
});
