import * as Dropdown from '../../../components/radix/dropdown-menu';
import type { SipContact, SipContactPhone, SipJournalEntry } from '@calaba/protocol';
import { ArrowDownLeft, ArrowUpRight, Copy, Ellipsis, Pencil, Phone, PhoneMissed, Trash2 } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { PhoneHeader } from '../../../components/PhoneHeader';
import { Button, CloseButton, IconButton, Spinner, cx } from '../../../components/ui';
import { t, useLocale } from '../../../i18n';
import { fmt, useTimeFormat } from '../../../lib/format';
import { useLongPress } from '../../../lib/longPress';
import { formatPhone } from '../../../lib/sip';
import { phoneBack } from '../../../services/phoneNav';
import { useTelContacts } from '../../../stores/telContacts';
import { useTelephonyUi } from '../../../stores/telephonyUi';
import { useUi } from '../../../stores/ui';
import { menuBox, menuItem } from '../../shell/menu';
import { useMayDeleteContact, usePlaceCalls } from '../access';
import { openCallDetail } from '../actions';
import { outcomeText } from '../texts';
import { directionOf, outcomeOf, startOf } from '../timeline';
import { ContactAvatar, confirmDelete } from './ContactsList';
import { callContact, copyContactNumber, editContact, useContact } from './data';
import { contactSubtitle, contactTitle, labelKey } from './model';

/**
 * A contact's card (ADR-0137 §6 desktop — the right panel of «Контакты», §7 phone — a pushed
 * screen): the hero (circle, name, company), the numbers (a tap calls, the phone's long press
 * copies), the note, «Звонки» (the last 10 calls I may see; a tap opens the call's detail).
 * Desktop: «Позвонить» / «Изменить» / «Удалить» under the hero; phone: a sticky bar at the thumb —
 * «Позвонить» full width (several numbers: a card to pick one) and the round «Изменить», «Ещё».
 */

/** Desktop: the right panel (a column from 1200 px, a floating panel below; Esc closes it). */
export function ContactPanel({ ws, floating }: { ws: string; floating: boolean }): ReactNode {
  const id = useTelContacts((s) => s.selected);
  useEffect(() => {
    if (!id) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('[role="menu"],[role="dialog"]')) return;
      useTelContacts.getState().select(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id]);
  if (!id) return null;
  return (
    <aside
      aria-label={t('telc.card')}
      data-testid="telc-card"
      className={
        floating
          ? 'mat-popover anim-in absolute bottom-3 right-3 top-[60px] z-[var(--z-popover)] flex w-[360px] flex-col overflow-hidden rounded-[var(--radius-panel)]'
          : 'mat-sidebar flex w-[360px] shrink-0 flex-col border-l border-line'
      }
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line pl-4 pr-2">
        <h2 className="min-w-0 flex-1 truncate text-headline font-semibold">{t('telc.card')}</h2>
        <CloseButton onClick={() => useTelContacts.getState().select(null)} data-testid="telc-card-close" />
      </div>
      <CardBody key={id} ws={ws} id={id} phone={false} />
    </aside>
  );
}

/** Phone: the pushed screen. */
export function PhoneContactCard({ ws, id }: { ws: string; id: string }): ReactNode {
  useLocale();
  const q = useContact(ws, id);
  const c = q.data?.contact;
  return (
    <section className="mat-content flex min-h-0 flex-1 flex-col" data-testid="telc-card">
      <PhoneHeader title={c ? contactTitle(c) : t('telc.card')} icon={c ? <ContactAvatar c={c} size={32} /> : undefined} />
      <CardBody ws={ws} id={id} phone />
    </section>
  );
}

function CardBody({ ws, id, phone }: { ws: string; id: string; phone: boolean }): ReactNode {
  useLocale();
  useTimeFormat();
  const q = useContact(ws, id);
  const place = usePlaceCalls(ws);
  const c = q.data?.contact;
  if (!c) {
    return (
      <div className="grid flex-1 place-items-center p-6 text-body text-muted">
        {q.isError ? (
          <div className="flex flex-col items-center gap-3" role="alert">
            <span className="text-danger-text">{t('telc.cardFailed')}</span>
            <Button variant="secondary" size="sm" onClick={() => void q.refetch()}>
              {t('common.retry')}
            </Button>
          </div>
        ) : (
          <Spinner />
        )}
      </div>
    );
  }
  const calls = q.data?.calls ?? [];
  const sub = contactSubtitle(c);
  return (
    <>
      <div className={cx('scrollbar-none min-h-0 flex-1 overflow-y-auto overflow-x-hidden', phone ? 'px-4 pb-6 pt-5' : 'p-4')} tabIndex={0} role="region" aria-label={t('telc.card')} data-testid="telc-card-body">
        <div className="flex flex-col items-center gap-1 text-center">
          <ContactAvatar c={c} size={phone ? 64 : 56} />
          <h3 className={cx('mt-2 line-clamp-2 break-words font-semibold text-fg', phone ? 'text-[20px] leading-6' : 'text-[17px] leading-[22px]')} data-testid="telc-card-name">
            {contactTitle(c)}
          </h3>
          {sub ? <p className={cx('line-clamp-2 break-words text-muted', phone ? 'text-list' : 'text-body')}>{sub}</p> : null}
        </div>
        {phone ? null : <DesktopActions ws={ws} c={c} place={place} />}
        {c.phones.length ? (
          <ul className={cx('overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-card)]', phone ? 'mt-5' : 'mt-4')} aria-label={t('telc.numbers')} data-testid="telc-card-numbers">
            {c.phones.map((p) => (
              <NumberRow key={p.number} ws={ws} c={c} p={p} phone={phone} place={place} />
            ))}
          </ul>
        ) : null}
        {c.note ? (
          <div className={cx('rounded-[var(--radius-card)] bg-[var(--color-card)] px-3 py-2.5', phone ? 'mt-4' : 'mt-3')} data-testid="telc-card-note">
            <h4 className="text-micro text-muted">{t('telc.note')}</h4>
            <p className={cx('selectable mt-0.5 whitespace-pre-wrap break-words text-fg', phone ? 'text-list' : 'text-body')}>{c.note}</p>
          </div>
        ) : null}
        <h4 className={cx('mb-1 mt-5 font-semibold', phone ? 'text-micro uppercase tracking-[0.04em] text-muted' : 'text-caption text-muted')}>{t('telc.calls')}</h4>
        {calls.length ? (
          <ul className="overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-card)]" data-testid="telc-card-calls">
            {calls.map((e) => (
              <CallRow key={e.call?.id ?? ''} ws={ws} e={e} phone={phone} />
            ))}
          </ul>
        ) : (
          <p className="text-caption text-muted">{t('telc.noCalls')}</p>
        )}
      </div>
      {phone ? <PhoneBar ws={ws} c={c} place={place} /> : null}
    </>
  );
}

/** A number: the label, the number; a click / tap calls (PLACE_CALLS) — else copies; a long press copies. */
function NumberRow({ ws, c, p, phone, place }: { ws: string; c: SipContact; p: SipContactPhone; phone: boolean; place: boolean }): ReactNode {
  const press = useLongPress(phone, () => copyContactNumber(p.number));
  const act = (): void => (place ? callContact(ws, c, p.number) : copyContactNumber(p.number));
  return (
    <li className={cx('relative flex items-center gap-2 border-b border-[var(--color-card-line)] last:border-b-0', phone ? 'min-h-[52px] px-3' : 'min-h-11 px-3')} data-testid="telc-number">
      <button type="button" className="absolute inset-0" aria-label={place ? t('tel.callName', { name: formatPhone(p.number) }) : t('tel.copy')} onClick={act} {...press} />
      <span className="pointer-events-none flex min-w-0 flex-1 flex-col py-1.5">
        <span className="text-caption leading-4 text-muted">{t(labelKey(p.label))}</span>
        <span className={cx('truncate tabular-nums', phone ? 'text-[17px] leading-6 text-accent-text' : 'text-body text-fg')}>{formatPhone(p.number)}</span>
      </span>
      {phone ? null : (
        <span className="relative flex shrink-0 items-center gap-0.5">
          {place ? (
            <IconButton size="sm" label={t('tel.callName', { name: formatPhone(p.number) })} onClick={() => callContact(ws, c, p.number)} className="text-ok">
              <Phone className="size-3.5" aria-hidden />
            </IconButton>
          ) : null}
          <IconButton size="sm" label={t('tel.copy')} onClick={() => copyContactNumber(p.number)}>
            <Copy className="size-3.5" aria-hidden />
          </IconButton>
        </span>
      )}
    </li>
  );
}

/** A call with the contact: the direction, when, how it went; a tap opens its detail. */
function CallRow({ ws, e, phone }: { ws: string; e: SipJournalEntry; phone: boolean }): ReactNode {
  const id = e.call?.id ?? '';
  const dir = directionOf(e);
  const Icon = dir === 'missed' ? PhoneMissed : dir === 'in' ? ArrowDownLeft : ArrowUpRight;
  const at = startOf(e);
  const open = (): void => {
    if (!useUi.getState().phone.on) useTelephonyUi.getState().setPage('recents');
    openCallDetail(id);
  };
  return (
    <li className="border-b border-[var(--color-card-line)] last:border-b-0">
      <button type="button" onClick={open} className={cx('flex w-full items-center gap-3 px-3 text-left hover:bg-hover', phone ? 'min-h-[52px]' : 'min-h-11')} data-testid="telc-call">
        <Icon className={cx('size-4 shrink-0', dir === 'missed' ? 'text-danger' : 'text-muted')} aria-label={t(dir === 'missed' ? 'tel.dir.missed' : dir === 'in' ? 'tel.dir.in' : 'tel.dir.out')} />
        <span className="flex min-w-0 flex-1 flex-col py-1.5">
          <span className={cx('truncate', phone ? 'text-list' : 'text-body', dir === 'missed' ? 'text-danger-text' : 'text-fg')}>{at ? fmt.dateTime(new Date(at), 'short') : '—'}</span>
          <span className="truncate text-caption text-muted">{outcomeText(ws, outcomeOf(e), e)}</span>
        </span>
      </button>
    </li>
  );
}

/** «Позвонить» one number, or a menu of them (the phone shows it as a centred card). */
function CallButton({ ws, c, phone }: { ws: string; c: SipContact; phone: boolean }): ReactNode {
  const cls = phone ? 'flex h-[52px] w-full items-center justify-center gap-2 rounded-full bg-ok-fill text-list font-semibold text-white' : '';
  const label = (
    <>
      <Phone className={phone ? 'size-5' : 'size-3.5'} aria-hidden />
      {t('tel.call')}
    </>
  );
  if (c.phones.length <= 1) {
    const n = c.phones[0]?.number ?? '';
    return phone ? (
      <button type="button" className={cls} onClick={() => callContact(ws, c, n)} data-testid="telc-card-call">
        {label}
      </button>
    ) : (
      <Button onClick={() => callContact(ws, c, n)} data-testid="telc-card-call">
        {label}
      </Button>
    );
  }
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>
        {phone ? (
          <button type="button" className={cls} data-testid="telc-card-call">
            {label}
          </button>
        ) : (
          <Button data-testid="telc-card-call">{label}</Button>
        )}
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className={cx(menuBox, 'w-64')} side={phone ? 'top' : 'bottom'} align="center" sideOffset={6} collisionPadding={16} data-testid="telc-number-choice">
          <Dropdown.Label className="px-2 pb-1 pt-1.5 text-caption text-muted">{t('telc.whichNumber')}</Dropdown.Label>
          {c.phones.map((p) => (
            <Dropdown.Item key={p.number} className={cx(menuItem, 'justify-between gap-3')} onSelect={() => callContact(ws, c, p.number)}>
              <span className="tabular-nums">{formatPhone(p.number)}</span>
              <span className="text-caption text-muted">{t(labelKey(p.label))}</span>
            </Dropdown.Item>
          ))}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

function DesktopActions({ ws, c, place }: { ws: string; c: SipContact; place: boolean }): ReactNode {
  const del = useMayDeleteContact(ws, c.createdBy);
  return (
    <div className="mt-4 flex flex-wrap items-center justify-center gap-2" data-testid="telc-card-actions">
      {place && c.phones.length ? <CallButton ws={ws} c={c} phone={false} /> : null}
      <Button variant="secondary" onClick={() => editContact(c.id)} data-testid="telc-card-edit">
        <Pencil className="size-3.5" aria-hidden /> {t('telc.edit')}
      </Button>
      {del ? (
        <IconButton label={t('telc.deleteContact')} onClick={() => void confirmDelete(ws, c)} className="text-danger-text" data-testid="telc-card-delete">
          <Trash2 className="size-4" aria-hidden />
        </IconButton>
      ) : null}
    </div>
  );
}

/** The phone's sticky bar (ADR-0137 §7): «Позвонить» at the thumb, «Изменить» and «Ещё» round under it. */
function PhoneBar({ ws, c, place }: { ws: string; c: SipContact; place: boolean }): ReactNode {
  const del = useMayDeleteContact(ws, c.createdBy);
  const main = c.phones[0]?.number ?? '';
  const round = 'grid size-11 place-items-center rounded-full bg-hover text-fg';
  const item = 'flex w-[84px] flex-col items-center gap-1 text-micro text-muted';
  return (
    <div className="mat-toolbar flex shrink-0 flex-col gap-2 border-t border-line px-4 pb-[calc(var(--safe-bottom,0px)+12px)] pt-3" data-testid="telc-card-bar">
      {place && main ? <CallButton ws={ws} c={c} phone /> : null}
      <div className="flex items-start justify-center gap-4">
        <button type="button" className={item} onClick={() => editContact(c.id)} data-testid="telc-card-edit">
          <span className={round}>
            <Pencil className="size-5" aria-hidden />
          </span>
          <span className="max-w-full truncate">{t('telc.edit')}</span>
        </button>
        {main || del ? (
          <Dropdown.Root modal={false}>
            <Dropdown.Trigger asChild>
              <button type="button" className={item} data-testid="telc-card-more">
                <span className={round}>
                  <Ellipsis className="size-5" aria-hidden />
                </span>
                <span className="max-w-full truncate">{t('shell.more')}</span>
              </button>
            </Dropdown.Trigger>
            <Dropdown.Portal>
              <Dropdown.Content className={cx(menuBox, 'w-60')} side="top" align="center" sideOffset={6} collisionPadding={16}>
                {main ? (
                  <Dropdown.Item className={menuItem} onSelect={() => copyContactNumber(main)}>
                    <Copy className="size-4" aria-hidden /> {t('tel.copy')}
                  </Dropdown.Item>
                ) : null}
                {del ? (
                  <Dropdown.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => void confirmDelete(ws, c).then((ok) => ok && phoneBack())}>
                    <Trash2 className="size-4" aria-hidden /> {t('telc.delete')}
                  </Dropdown.Item>
                ) : null}
              </Dropdown.Content>
            </Dropdown.Portal>
          </Dropdown.Root>
        ) : null}
      </div>
    </div>
  );
}
