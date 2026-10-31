import { PhoneMissed, PhoneOff, SearchX } from 'lucide-react';
import { forwardRef, memo, useCallback, useEffect, useMemo, type HTMLAttributes, type ReactNode } from 'react';
import { GroupedVirtuoso } from 'react-virtuoso';
import { Bar } from '../../components/Bar';
import { Button, Spinner, cx } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { usePageVisible } from '../../lib/pageVisible';
import { dropJournal, loadJournal, loadMoreJournal, markJournalSeen } from '../../services/sipJournal';
import { groupIds, liveKey, queryDigits, useSipJournal } from '../../stores/sipJournal';
import { useTelephonyUi } from '../../stores/telephonyUi';
import { GROUP_LABEL } from '../shell/ColumnHeader';
import { DesktopFilters } from './RecentsFilters';
import { RecentsRow } from './RecentsRow';
import { dayHeader } from './texts';

/**
 * «Недавние» on the desktop (ADR-0137 §6): the filters bar over the journal list.
 */
export function Recents({ workspaceId }: { workspaceId: string }): ReactNode {
  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label={t('tel.recents')} data-testid="tel-recents">
      <Bar className="pr-3">
        <DesktopFilters ws={workspaceId} />
      </Bar>
      <JournalList ws={workspaceId} phone={false} />
    </section>
  );
}

/** A changed search waits this long before the request (typing a number digit by digit). */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * The journal list (desktop and phone): the first page when it opens and when the filters change,
 * the next ones near the end, «Сейчас» and the day headers sticky (28 px), the loading / empty /
 * error states. While on screen in a visible window it marks the missed calls as seen (the badge).
 * Unmounted — the loaded entries go (no updates for a list nobody sees).
 */
export function JournalList({ ws, phone, header }: { ws: string; phone: boolean; header?: ReactNode }): ReactNode {
  useLocale();
  const filter = useTelephonyUi((s) => s.filter);
  const qKey = filter.q.trim();
  useEffect(() => {
    if (!qKey) {
      loadJournal(ws, useTelephonyUi.getState().filter);
      return;
    }
    const timer = window.setTimeout(() => loadJournal(ws, useTelephonyUi.getState().filter), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [ws, filter.segment, filter.direction, filter.scope, filter.period, qKey]);
  useEffect(() => () => dropJournal(), []);

  // «Недавние» looked at: the missed badge goes (ADR-0137 §1 sip_seen_at), also when a new one comes in meanwhile.
  const missed = useSipJournal((s) => s.missed[ws] ?? 0);
  const visible = usePageVisible();
  useEffect(() => {
    if (missed > 0 && visible) markJournalSeen(ws);
  }, [ws, missed, visible]);

  const status = useSipJournal((s) => s.list?.status ?? 'loading');
  const ids = useSipJournal((s) => s.list?.ids);
  const live = useSipJournal(liveKey);
  const more = useSipJournal((s) => !!s.list?.more);
  const groups = useMemo(() => {
    const set = new Set(live ? live.split(',') : []);
    return groupIds(ids ?? [], set, useSipJournal.getState().entries);
  }, [ids, live]);
  const flat = useMemo(() => groups.flatMap((g) => g.ids), [groups]);
  const counts = useMemo(() => groups.map((g) => g.ids.length), [groups]);
  // GroupedVirtuoso keys by the absolute index (group headers counted): a row keeps its fiber by
  // its call id when a call comes in above it, so memo rows are not re-rendered with another id.
  const keys = useMemo(() => groups.flatMap((g) => [`g:${g.key}`, ...g.ids]), [groups]);
  const endReached = useCallback(() => loadMoreJournal(useTelephonyUi.getState().filter), []);

  const empty = flat.length === 0;
  const body = useMemo(() => (status === 'error' ? <ErrorState ws={ws} /> : status === 'loading' && empty ? <Skeleton phone={phone} /> : empty ? <EmptyState /> : null), [status, empty, phone, ws]);

  // One scroller in every state: the phone's search pill lives in its header, so it must never
  // remount (the field would lose the focus while a search empties the list).
  const hasHeader = !!header;
  const components = useMemo(
    () => ({ Header: hasHeader ? HeaderSlot : undefined, EmptyPlaceholder: BodySlot, Footer: more ? MoreFooter : phone ? PhoneFooter : DesktopFooter, TopItemList: StickyTop }),
    [hasHeader, more, phone],
  );
  const context = useMemo<ListContext>(() => ({ header, body }), [header, body]);
  return (
    <GroupedVirtuoso<unknown, ListContext>
      className="scrollbar-none min-h-0 flex-1"
      data-testid="tel-list"
      context={context}
      groupCounts={body ? EMPTY : counts}
      groupContent={(i) => <GroupHeader group={groups[i]?.key ?? 'now'} phone={phone} />}
      itemContent={(i) => <RecentsRow id={flat[i] ?? ''} ws={ws} phone={phone} />}
      computeItemKey={(i) => keys[i] ?? i}
      endReached={endReached}
      increaseViewportBy={{ top: 200, bottom: 400 }}
      components={components}
    />
  );
}

const EMPTY: number[] = [];

interface ListContext {
  header: ReactNode;
  body: ReactNode;
}

const HeaderSlot = ({ context }: { context?: ListContext }): ReactNode => <>{context?.header}</>;
const BodySlot = ({ context }: { context?: ListContext }): ReactNode => <>{context?.body}</>;

/** The sticky group header sits on the list's surface (an opaque strip, 28 px). */
const StickyTop = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function StickyTop(props, ref) {
  return <div ref={ref} {...props} className={cx(props.className, 'z-[1]')} />;
});

/** Memo: a list change (a call in, a call ending) does not redraw the headers that stay. */
const GroupHeader = memo(function GroupHeader({ group, phone }: { group: 'now' | number; phone: boolean }): ReactNode {
  const text = group === 'now' ? t('tel.now') : dayHeader(group);
  return (
    <div className={cx('flex h-7 items-end bg-[var(--color-bg)] pb-1', phone ? 'px-4' : 'px-4')} data-testid="tel-group">
      <h3 className={cx('min-w-0 truncate', GROUP_LABEL)}>{text}</h3>
    </div>
  );
});

const MoreFooter = (): ReactNode => (
  <div className="grid h-12 place-items-center">
    <Spinner className="size-4" />
  </div>
);
// The phone's FAB «Набор» floats over the list's end: the last row stays above it (56 + 32, ADR-0137 §7).
const PhoneFooter = (): ReactNode => <div className="h-[88px]" />;
const DesktopFooter = (): ReactNode => <div className="h-3" />;

/** Six static rows while the first page loads (no endless shimmer: docs/08). */
function Skeleton({ phone }: { phone: boolean }): ReactNode {
  return (
    <div className="pt-1" role="status" aria-label={t('common.loading')} data-testid="tel-skeleton">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className={cx('flex items-center gap-3', phone ? 'h-16 px-3' : 'mx-2 h-[52px] px-2')} aria-hidden>
          <span className={cx('shrink-0 rounded-full bg-[var(--color-fill)]', phone ? 'size-10' : 'size-8')} />
          <span className="flex min-w-0 flex-1 flex-col gap-2">
            <span className="h-3 rounded-full bg-[var(--color-fill)]" style={{ width: `${[52, 38, 64, 45, 58, 34][i]}%` }} />
            <span className="h-2.5 rounded-full bg-[var(--color-fill)] opacity-70" style={{ width: `${[70, 55, 48, 62, 40, 66][i]}%` }} />
          </span>
          <span className="h-2.5 w-10 shrink-0 rounded-full bg-[var(--color-fill)]" />
        </div>
      ))}
    </div>
  );
}

/** Nothing (yet), nothing missed, nothing found by the search. */
function EmptyState(): ReactNode {
  const segment = useTelephonyUi((s) => s.filter.segment);
  const q = useTelephonyUi((s) => s.filter.q.trim());
  const narrowed = useTelephonyUi((s) => s.filter.direction !== 'all' || s.filter.period !== 'any' || s.filter.scope.startsWith('user:'));
  const Icon = q ? SearchX : segment === 'missed' ? PhoneMissed : PhoneOff;
  const title = q ? t('tel.emptySearch', { q }) : segment === 'missed' ? t('tel.emptyMissed') : narrowed ? t('tel.emptyFiltered') : t('tel.empty');
  const hint = q ? (queryDigits(q) ? t('tel.emptySearchHint') : t('tel.emptySearchNames')) : segment === 'missed' ? t('tel.emptyMissedHint') : narrowed ? '' : t('tel.emptyHint');
  return (
    <div className="flex flex-col items-center gap-2 px-6 pb-8 pt-16 text-center" data-testid="tel-empty">
      <span className="grid size-14 place-items-center rounded-full bg-[var(--color-fill)] text-muted" aria-hidden>
        <Icon className="size-7" strokeWidth={1.5} />
      </span>
      <p className="mt-1 text-headline font-semibold text-fg">{title}</p>
      {hint ? <p className="max-w-xs text-body text-muted">{hint}</p> : null}
      {narrowed && !q ? (
        <Button variant="secondary" className="mt-2" onClick={() => useTelephonyUi.getState().resetFilter()} data-testid="tel-empty-reset">
          {t('tel.filters.reset')}
        </Button>
      ) : null}
    </div>
  );
}

function ErrorState({ ws }: { ws: string }): ReactNode {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3" role="alert" data-testid="tel-error">
      <span className="text-body text-danger-text">{t('tel.loadFailed')}</span>
      <Button variant="secondary" size="sm" onClick={() => loadJournal(ws, useTelephonyUi.getState().filter, true)}>
        {t('common.retry')}
      </Button>
    </div>
  );
}
