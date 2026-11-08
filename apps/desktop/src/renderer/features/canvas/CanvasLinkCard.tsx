import { timestampMs } from '@bufbuild/protobuf/wkt';
import { Shapes } from 'lucide-react';
import { memo, useEffect, type ReactNode } from 'react';
import { LinkCard } from '../../components/LinkCard';
import { t, useLocale } from '../../i18n';
import { fmt } from '../../lib/format';
import type { MdNode } from '../../lib/markdown/parse';
import { ensureCanvasItem, openCanvasLink } from '../../services/canvasLink';
import { canvasUrl, ownCanvasId } from '../../services/links';
import { useCanvas } from '../../stores/canvas';
import { useCanvasRefs } from '../../stores/canvasRefs';
import { refView } from '../../stores/wikiRefs';

/** The first link of a message to a canvas of this server (its card goes under the text), or null. */
export function firstCanvas(nodes: readonly MdNode[]): string | null {
  for (const n of nodes) {
    if (n.t === 'link') {
      const id = ownCanvasId(n.href);
      if (id) return id;
    } else if (n.t === 'b' || n.t === 'i' || n.t === 's') {
      const inner = firstCanvas(n.c);
      if (inner) return inner;
    }
  }
  return null;
}

/**
 * A canvas link in a message (owner 23.10): the same card as a wiki page's — a `Shapes` tile, the
 * name, «Холст · изменён …», «Открыть». Resolved on this computer by the item GET (once per id), so
 * each viewer sees it by their own rights: no access → «Холст недоступен», no name. A leaf with its
 * own selectors: resolving re-renders this card only, never the feed.
 */
export const CanvasLinkCard = memo(function CanvasLinkCard({ itemId }: { itemId: string }): ReactNode {
  useLocale();
  const known = useCanvas((s) => !!s.items[itemId]);
  const name = useCanvas((s) => s.items[itemId]?.name ?? '');
  const updated = useCanvas((s) => {
    const at = s.items[itemId]?.updatedAt;
    return at ? timestampMs(at) : 0;
  });
  const emoji = useCanvas((s) => s.items[itemId]?.emoji ?? '');
  const st = useCanvasRefs((s) => s.state[itemId]);
  useEffect(() => ensureCanvasItem(itemId), [itemId]);
  const view = refView(known, st);
  const label = t('canvas.card.label');
  return (
    <LinkCard
      testId="canvas-link-card"
      state={view}
      href={canvasUrl(itemId) ?? undefined}
      onOpen={() => openCanvasLink(itemId)}
      icon={emoji ? <span className="text-[20px] leading-none">{emoji}</span> : <Shapes className="size-5" strokeWidth={1.75} />}
      title={view === 'loading' ? label : name || t('canvas.untitled')}
      sub={view === 'loading' ? t('wiki.pageLink.loading') : updated ? `${label} · ${t('canvasPhone.updated', { when: fmt.dayMonth(new Date(updated)) })}` : label}
      openLabel={t('wiki.card.open')}
      unavailableIcon={<Shapes className="size-5 shrink-0" strokeWidth={1.75} aria-hidden />}
      unavailableLabel={t('canvas.card.unavailable')}
    />
  );
});
