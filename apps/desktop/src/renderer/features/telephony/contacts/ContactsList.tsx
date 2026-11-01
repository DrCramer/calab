import * as ContextMenu from '../../../components/radix/context-menu';
import type { SipContact } from '@calaba/protocol';
import { BookUser, Copy, Pencil, Phone, Search, SearchX, Trash2, Upload, UserRoundPlus, X } from 'lucide-react';
import { forwardRef, memo, useEffect, useMemo, useState, type HTMLAttributes, type ReactNode } from 'react';
import { GroupedVirtuoso } from 'react-virtuoso';
import { avatarColor } from '../../../components/Avatar';
import { confirmAction } from '../../../components/Confirm';
import { Button, Input, Spinner, cx } from '../../../components/ui';
import { t, useLocale } from '../../../i18n';
import { workspaceInitials } from '../../../lib/initials';
import { dialKey } from '../../../lib/phoneNumber';
import { useRowSwipe } from '../../../lib/rowSwipe';
import { formatPhone } from '../../../lib/sip';
import { useSwipeOpenMark, useTelContacts } from '../../../stores/telContacts';
import { GROUP_LABEL } from '../../shell/ColumnHeader';
import { menuBox, menuItem } from '../../shell/menu';
import { useMayDeleteContact, useMayManageTelephony, usePlaceCalls } from '../access';
import { callContact, copyContactNumber, deleteContact, editContact, openContact, openDial, useContactList } from './data';
import { contactSubtitle, contactTitle, groupContacts } from './model';

/**
 * «Контакты» (ADR-0137 §6 desktop — rows 44 px with the main number on the right, the card in
 * the right panel; §7 phone — the third segment, rows 56 px, sticky letters 28 px, no letter index
 * on the side): the search, the list by letters (А–Я, A–Z, «#»), the loading / empty / not found /
 * error states. Phone: a tap opens the card, a left swipe «Позвонить» · «Изменить», a long press
 * the menu. Rows are memo by contact; the list reads the book when it opens (no events).
 */

const SEARCH_DEBOUNCE_MS = 300;

export function ContactsList({ ws, phone, header }: { ws: string; phone: boolean; header?: ReactNode }): ReactNode {
  useLocale();
  const typed = useTelContacts((s) => s.q.trim());
  const [q, setQ] = useState(typed);
  useEffect(() => {
    const timer = window.setTimeout(() => setQ(typed), typed ? SEARCH_DEBOUNCE_MS : 0);
    return () => window.clearTimeout(timer);
  }, [typed]);
  const list = useContactList(ws, q);
  const groups = useMemo(() => groupContacts(list.contacts), [list.contacts]);
  const byId = useMemo(() => new Map(list.contacts.map((c) => [c.id, c])), [list.contacts]);
  const flat = useMemo(() => groups.flatMap((g) => g.ids), [groups]);
  const counts = useMemo(() => groups.map((g) => g.ids.length), [groups]);
  const keys = useMemo(() => groups.flatMap((g) => [`g:${g.letter}:${g.ids[0] ?? ''}`, ...g.ids]), [groups]);
  const selected = useTelContacts((s) => (phone ? null : s.selected));
  const empty = flat.length === 0;
  const status = list.status;
  const retry = list.retry;
  const body = useMemo(() => (status === 'error' && empty ? <ErrorState retry={retry} /> : status === 'loading' && empty ? <Skeleton phone={phone} /> : empty ? <EmptyState ws={ws} q={q} /> : null), [status, empty, phone, ws, q, retry]);
  const hasHeader = !!header;
  const components = useMemo(() => ({ Header: hasHeader ? HeaderSlot : undefined, EmptyPlaceholder: BodySlot, Footer: list.more ? MoreFooter : phone ? PhoneFooter : DesktopFooter, TopItemList: StickyTop }), [hasHeader, list.more, phone]);
  const context = useMemo<ListContext>(() => ({ header, body }), [header, body]);
  return (
    <GroupedVirtuoso<unknown, ListContext>
      className="scrollbar-none min-h-0 flex-1"
      data-testid="telc-list"
      context={context}
      groupCounts={body ? EMPTY : counts}
      groupContent={(i) => <LetterHeader letter={groups[i]?.letter ?? ''} phone={phone} />}
      itemContent={(i) => {
        const c = byId.get(flat[i] ?? '');
        return c ? <ContactRow c={c} ws={ws} phone={phone} selected={selected === c.id} /> : null;
      }}
      computeItemKey={(i) => keys[i] ?? i}
      endReached={list.loadMore}
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
const StickyTop = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function StickyTop(props, ref) {
  return <div ref={ref} {...props} className={cx(props.className, 'z-[1]')} />;
});
const MoreFooter = (): ReactNode => (
  <div className="grid h-12 place-items-center">
    <Spinner className="size-4" />
  </div>
);
// The phone's FAB «Набор» floats over the list's end: the last row stays above it (56 + 32).
const PhoneFooter = (): ReactNode => <div className="h-[88px]" />;
const DesktopFooter = (): ReactNode => <div className="h-3" />;

const LetterHeader = memo(function LetterHeader({ letter, phone }: { letter: string; phone: boolean }): ReactNode {
  return (
    <div className={cx('flex h-7 items-end bg-[var(--color-bg)] pb-1', phone ? 'px-4' : 'px-4')} data-testid="telc-letter">
      <h3 className={cx('min-w-0 truncate', GROUP_LABEL)}>{letter}</h3>
    </div>
  );
});

/** The search pill of the list (phone: in the list's header, it scrolls away; desktop: the bar). */
export function ContactSearch({ phone, className }: { phone: boolean; className?: string }): ReactNode {
  const q = useTelContacts((s) => s.q);
  return (
    <div className={cx('relative flex min-w-0 items-center', className)}>
      <Input
        type="search"
        inputMode="search"
        value={q}
        onChange={(e) => useTelContacts.getState().setQ(e.target.value)}
        placeholder={t('telc.search')}
        aria-label={t('telc.search')}
        icon={<Search aria-hidden />}
        className={cx(phone && 'border-transparent bg-hover shadow-none', q ? 'pr-8' : undefined)}
        data-testid="telc-search"
      />
      {q ? (
        <button type="button" className="tap-hit absolute right-1 grid size-6 place-items-center rounded-full text-muted hover:text-fg mobile:right-2" aria-label={t('tel.searchClear')} onClick={() => useTelContacts.getState().setQ('')}>
          <X className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

/** A contact's circle: its initials on its own colour. */
export function ContactAvatar({ c, size }: { c: Pick<SipContact, 'id' | 'name' | 'company'>; size: number }): ReactNode {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, background: avatarColor(c.id || contactTitle(c)), fontSize: Math.round(size * 0.36) }}
      aria-hidden
    >
      {workspaceInitials(contactTitle(c))}
    </span>
  );
}

const ContactRow = memo(function ContactRow({ c, ws, phone, selected }: { c: SipContact; ws: string; phone: boolean; selected: boolean }): ReactNode {
  const title = contactTitle(c);
  const sub = contactSubtitle(c);
  const main = c.phones[0]?.number ?? '';
  if (!phone) {
    return (
      <RowMenu c={c} ws={ws}>
        <div className={cx('relative mx-2 flex h-11 items-center gap-3 rounded-[8px] px-2', selected ? 'bg-active' : 'hover:bg-row-hover')} data-testid="telc-row" data-contact={c.id}>
          <button type="button" className="absolute inset-0 rounded-[8px]" aria-label={title} aria-current={selected || undefined} onClick={() => openContact(c.id)} />
          <ContactAvatar c={c} size={32} />
          <span className="pointer-events-none flex min-w-0 flex-1 flex-col justify-center">
            <span className="truncate text-list leading-5 text-fg" data-testid="telc-row-name">
              {title}
            </span>
            {sub ? <span className="truncate text-caption leading-4 text-muted">{sub}</span> : null}
          </span>
          {main ? <span className="pointer-events-none shrink-0 text-caption tabular-nums text-muted">{formatPhone(main)}</span> : null}
        </div>
      </RowMenu>
    );
  }
  return <PhoneContactRow c={c} ws={ws} title={title} sub={sub} />;
});

function PhoneContactRow({ c, ws, title, sub }: { c: SipContact; ws: string; title: string; sub: string }): ReactNode {
  const place = usePlaceCalls(ws);
  const main = c.phones[0]?.number ?? '';
  const call = place && !!main;
  const swipe = useRowSwipe(true, call ? 2 : 1);
  const shifted = swipe.offset !== 0;
  useSwipeOpenMark(shifted);
  return (
    <div className="relative flex" {...swipe.handlers}>
      {shifted ? <SwipeActions c={c} ws={ws} call={call} width={Math.min(-swipe.offset, swipe.width)} close={swipe.close} /> : null}
      <RowMenu c={c} ws={ws}>
        <div
          className={cx('relative flex h-14 min-w-0 flex-1 select-none items-center gap-3 bg-[var(--color-bg)] pl-4 duration-[var(--motion-fast)] active:bg-hover', swipe.dragging ? 'transition-colors' : 'transition-[margin,background-color]')}
          style={shifted ? { marginRight: -swipe.offset } : undefined}
          data-testid="telc-row"
          data-contact={c.id}
        >
          <button
            type="button"
            className="absolute inset-0"
            aria-label={title}
            onClick={() => {
              if (shifted) swipe.close();
              else openContact(c.id);
            }}
            data-testid="telc-row-tap"
          />
          <ContactAvatar c={c} size={40} />
          <span className="pointer-events-none flex h-full min-w-0 flex-1 flex-col justify-center border-b border-line pr-4">
            <span className="truncate text-list font-semibold leading-5 text-fg" data-testid="telc-row-name">
              {title}
            </span>
            {sub ? <span className="truncate text-caption leading-4 text-muted">{sub}</span> : null}
          </span>
        </div>
      </RowMenu>
    </div>
  );
}

/** «Позвонить» (ok) · «Изменить» under a swiped row (88 px each); mounted only while it is open. */
function SwipeActions({ c, ws, call, width, close }: { c: SipContact; ws: string; call: boolean; width: number; close: () => void }): ReactNode {
  const action = 'flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 overflow-hidden px-1 text-center text-micro font-medium';
  return (
    <div className="absolute inset-y-0 right-0 flex overflow-hidden" style={{ width }} data-testid="telc-swipe">
      {call ? (
        <button
          type="button"
          className={cx(action, 'bg-ok-fill text-white')}
          onClick={() => {
            close();
            callContact(ws, c, c.phones[0]?.number ?? '');
          }}
          data-testid="telc-swipe-call"
        >
          <Phone className="size-4 shrink-0" aria-hidden />
          <span className="line-clamp-2">{t('tel.call')}</span>
        </button>
      ) : null}
      <button
        type="button"
        className={cx(action, 'bg-[var(--color-fill-hover)] text-fg')}
        onClick={() => {
          close();
          editContact(c.id);
        }}
        data-testid="telc-swipe-edit"
      >
        <Pencil className="size-4 shrink-0" aria-hidden />
        <span className="line-clamp-2">{t('telc.edit')}</span>
      </button>
    </div>
  );
}

/** Right click on the desktop, a long press on the phone (a centred card, lib/phoneMenus). */
function RowMenu({ c, ws, children }: { c: SipContact; ws: string; children: ReactNode }): ReactNode {
  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={cx(menuBox, 'w-60')} data-testid="telc-row-menu">
          <RowMenuItems c={c} ws={ws} />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function RowMenuItems({ c, ws }: { c: SipContact; ws: string }): ReactNode {
  const place = usePlaceCalls(ws);
  const del = useMayDeleteContact(ws, c.createdBy);
  const main = c.phones[0]?.number ?? '';
  return (
    <>
      {place && main ? (
        <ContextMenu.Item className={menuItem} onSelect={() => callContact(ws, c, main)} data-testid="telc-menu-call">
          <Phone className="size-4" aria-hidden /> {t('tel.call')}
        </ContextMenu.Item>
      ) : null}
      <ContextMenu.Item className={menuItem} onSelect={() => editContact(c.id)} data-testid="telc-menu-edit">
        <Pencil className="size-4" aria-hidden /> {t('telc.edit')}
      </ContextMenu.Item>
      {main ? (
        <ContextMenu.Item className={menuItem} onSelect={() => copyContactNumber(main)} data-testid="telc-menu-copy">
          <Copy className="size-4" aria-hidden /> {t('tel.copy')}
        </ContextMenu.Item>
      ) : null}
      {del ? (
        <ContextMenu.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => void confirmDelete(ws, c)} data-testid="telc-menu-delete">
          <Trash2 className="size-4" aria-hidden /> {t('telc.delete')}
        </ContextMenu.Item>
      ) : null}
    </>
  );
}

/** «Удалить контакт?» — the shared confirmation (a centred card on the phone). */
export async function confirmDelete(ws: string, c: Pick<SipContact, 'id' | 'name' | 'company'>): Promise<boolean> {
  const ok = await confirmAction(t('telc.deleteTitle', { name: contactTitle(c) }), t('telc.deleteBody'), t('telc.delete'));
  return ok ? deleteContact(ws, c.id) : false;
}

/** Six static rows while the first page loads (no shimmer, docs/08). */
function Skeleton({ phone }: { phone: boolean }): ReactNode {
  return (
    <div className="pt-1" role="status" aria-label={t('common.loading')} data-testid="telc-skeleton">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className={cx('flex items-center gap-3', phone ? 'h-14 px-4' : 'mx-2 h-11 px-2')} aria-hidden>
          <span className={cx('shrink-0 rounded-full bg-[var(--color-fill)]', phone ? 'size-10' : 'size-8')} />
          <span className="flex min-w-0 flex-1 flex-col gap-2">
            <span className="h-3 rounded-full bg-[var(--color-fill)]" style={{ width: `${[48, 36, 60, 42, 55, 30][i]}%` }} />
            <span className="h-2.5 rounded-full bg-[var(--color-fill)] opacity-70" style={{ width: `${[34, 50, 28, 44, 38, 52][i]}%` }} />
          </span>
        </div>
      ))}
    </div>
  );
}

/** No contacts yet («Добавить контакт», «Импорт CSV» for MANAGE_INTEGRATIONS), or nothing found. */
function EmptyState({ ws, q }: { ws: string; q: string }): ReactNode {
  const manage = useMayManageTelephony(ws);
  const digits = dialKey(q);
  if (q) {
    return (
      <div className="flex flex-col items-center gap-2 px-6 pb-8 pt-16 text-center" data-testid="telc-empty">
        <span className="grid size-14 place-items-center rounded-full bg-[var(--color-fill)] text-muted" aria-hidden>
          <SearchX className="size-7" strokeWidth={1.5} />
        </span>
        <p className="mt-1 text-headline font-semibold text-fg">{t('tel.emptySearch', { q })}</p>
        {digits.length >= 3 && /^[\d\s()+\-.]+$/.test(q) ? (
          <Button variant="secondary" className="mt-2" onClick={() => openDial(q)} data-testid="telc-empty-dial">
            <Phone className="size-3.5" aria-hidden /> {t('telc.dialNumber', { number: q })}
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-2 px-6 pb-8 pt-16 text-center" data-testid="telc-empty">
      <span className="grid size-14 place-items-center rounded-full bg-[var(--color-fill)] text-muted" aria-hidden>
        <BookUser className="size-7" strokeWidth={1.5} />
      </span>
      <p className="mt-1 text-headline font-semibold text-fg">{t('telc.empty')}</p>
      <p className="max-w-xs text-body text-muted">{manage ? t('telc.emptyHintImport') : t('telc.emptyHint')}</p>
      <div className="mt-2 flex flex-wrap justify-center gap-2">
        <Button onClick={() => editContact('')} data-testid="telc-empty-add">
          <UserRoundPlus className="size-3.5" aria-hidden /> {t('telc.add')}
        </Button>
        {manage ? (
          <Button variant="secondary" onClick={() => useTelContacts.getState().setImport(true)} data-testid="telc-empty-import">
            <Upload className="size-3.5" aria-hidden /> {t('telc.import')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ErrorState({ retry }: { retry: () => void }): ReactNode {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3" role="alert" data-testid="telc-error">
      <span className="text-body text-danger-text">{t('telc.loadFailed')}</span>
      <Button variant="secondary" size="sm" onClick={retry}>
        {t('common.retry')}
      </Button>
    </div>
  );
}
