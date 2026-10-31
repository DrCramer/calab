import { timestampMs } from '@bufbuild/protobuf/wkt';
import { SipCallDirection, SipCallEventKind, SipCallOrigin, type SipCallEvent, type SipJournalEntry, type SipJournalRecording } from '@calaba/protocol';
import { useQuery } from '@tanstack/react-query';
import { Copy, MessageCircle, Pause, Phone, Play, UserRound, UserRoundPlus } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Avatar } from '../../components/Avatar';
import { PhoneHeader } from '../../components/PhoneHeader';
import { Button, CloseButton, IconButton, Spinner, cx } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { fmt, useTimeFormat } from '../../lib/format';
import { formatPhone } from '../../lib/sip';
import { journalEntryKey } from '../../services/sipJournal';
import { useSipJournal } from '../../stores/sipJournal';
import { useTelephonyUi } from '../../stores/telephonyUi';
import { useRooms } from '../../stores/rooms';
import { memberName, useWorkspaces } from '../../stores/workspaces';
import { copyNumber, callBack, internalPeer, openOrAddContact, writeTo } from './actions';
import { usePlaceCalls } from './access';
import { PartyCircle } from './RecentsRow';
import { dur, partyName, person, resultText } from './texts';
import { CallRoute } from './CallRoute';
import { RecordingPlayer, toggleRecording } from './RecordingPlayer';
import { usePlayer } from '../../stores/player';
import { numberOf, startOf } from './timeline';

/*
 * The detail of a call (ADR-0137 §6 desktop — the right panel, §7 phone — a pushed screen): who
 * (the contact / employee / number with «Скопировать»), what can be done (call back an employee,
 * write to them, listen to the recording when I may), the summary and «Маршрут». The row's entry
 * shows at once; the events arrive with GET journal/{cid}, re-read on SIP_JOURNAL_ENTRY of this
 * call while it is open (services/sipJournal).
 */

const NO_EVENTS: readonly SipCallEvent[] = [];

function useDetail(ws: string, callId: string): { entry: SipJournalEntry | undefined; events: readonly SipCallEvent[]; recording: SipJournalRecording | undefined; loading: boolean; failed: boolean; retry: () => void } {
  const listed = useSipJournal((s) => s.entries[callId]);
  const q = useQuery({ queryKey: journalEntryKey(ws, callId), queryFn: ({ signal }) => api.sip.journalEntry(ws, callId, signal) });
  return { entry: q.data?.entry ?? listed, events: q.data?.events ?? NO_EVENTS, recording: q.data?.recording, loading: q.isPending, failed: q.isError, retry: () => void q.refetch() };
}

/** Desktop: the right panel — a column from 1200 px, a floating panel over the list below (Esc closes it). */
export function CallDetailPanel({ ws, floating }: { ws: string; floating: boolean }): ReactNode {
  const callId = useTelephonyUi((s) => s.detail);
  useEffect(() => {
    if (!callId) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('[role="menu"],[role="dialog"]')) return;
      useTelephonyUi.getState().openDetail(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [callId]);
  if (!callId) return null;
  return (
    <aside
      aria-label={t('tel.detail')}
      data-testid="tel-detail"
      className={
        floating
          ? 'mat-popover anim-in absolute bottom-3 right-3 top-[60px] z-[var(--z-popover)] flex w-[360px] flex-col overflow-hidden rounded-[var(--radius-panel)]'
          : 'mat-sidebar flex w-[360px] shrink-0 flex-col border-l border-line'
      }
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line pl-4 pr-2">
        <h2 className="min-w-0 flex-1 truncate text-headline font-semibold">{t('tel.detail')}</h2>
        <CloseButton onClick={() => useTelephonyUi.getState().openDetail(null)} data-testid="tel-detail-close" />
      </div>
      <DetailBody key={callId} ws={ws} callId={callId} phone={false} />
    </aside>
  );
}

/** Phone: the pushed screen («‹» back), the actions in a sticky bar at the thumb. */
export function PhoneCallDetail({ ws, callId }: { ws: string; callId: string }): ReactNode {
  useLocale();
  const listed = useSipJournal((s) => s.entries[callId]);
  const q = useQuery({ queryKey: journalEntryKey(ws, callId), queryFn: ({ signal }) => api.sip.journalEntry(ws, callId, signal) });
  const entry = q.data?.entry ?? listed;
  const party = useWorkspaces(useShallow(() => (entry ? partyName(ws, entry) : { name: '', company: '', number: '' })));
  return (
    <section className="mat-content flex min-h-0 flex-1 flex-col" data-testid="tel-detail">
      <PhoneHeader title={party.name || t('tel.detail')} icon={entry ? <PartyCircle e={entry} ws={ws} name={party.name} size={32} ring="var(--color-toolbar)" badge={false} /> : undefined} />
      <DetailBody ws={ws} callId={callId} phone />
    </section>
  );
}

function DetailBody({ ws, callId, phone }: { ws: string; callId: string; phone: boolean }): ReactNode {
  useLocale();
  useTimeFormat();
  const d = useDetail(ws, callId);
  const place = usePlaceCalls(ws);
  const e = d.entry;
  const party = useWorkspaces(useShallow(() => (e ? partyName(ws, e) : { name: '', company: '', number: '' })));
  if (!e) {
    return (
      <div className="grid flex-1 place-items-center p-6 text-body text-muted">
        {d.failed ? (
          <div className="flex flex-col items-center gap-3" role="alert">
            <span className="text-danger-text">{t('tel.detailFailed')}</span>
            <Button variant="secondary" size="sm" onClick={d.retry}>
              {t('common.retry')}
            </Button>
          </div>
        ) : (
          <Spinner />
        )}
      </div>
    );
  }
  const peer = internalPeer(e, ws);
  const number = numberOf(e);
  const callable = !!peer || (place && !!number);
  return (
    <>
      <div className={cx('scrollbar-none min-h-0 flex-1 overflow-y-auto overflow-x-hidden', phone ? 'px-4 pb-6 pt-5' : 'px-4 pb-4 pt-4')} tabIndex={0} role="region" aria-label={t('tel.detail')} data-testid="tel-detail-body">
        {/* The hero: the party, big; a long name wraps onto two lines instead of being cut. */}
        <div className="flex flex-col items-center gap-1 text-center">
          <PartyCircle e={e} ws={ws} name={party.name} size={phone ? 64 : 56} ring="var(--color-bg)" />
          <h3 className={cx('mt-2 line-clamp-2 break-words font-semibold', phone ? 'text-[20px] leading-6' : 'text-[17px] leading-[22px]', e.missed ? 'text-danger-text' : 'text-fg')} data-testid="tel-detail-name">
            {party.name}
          </h3>
          {party.company ? <p className={cx('line-clamp-2 break-words text-muted', phone ? 'text-list' : 'text-body')}>{party.company}</p> : null}
          {number && party.name !== party.number ? (
            <p className={cx('flex items-center gap-1 tabular-nums text-muted', phone ? 'text-list' : 'text-body')}>
              <span className="selectable">{party.number}</span>
              {phone ? null : (
                <IconButton size="sm" label={t('tel.copy')} onClick={() => copyNumber(e)} data-testid="tel-detail-copy">
                  <Copy className="size-3.5" aria-hidden />
                </IconButton>
              )}
            </p>
          ) : number && !phone ? (
            <IconButton size="sm" label={t('tel.copy')} onClick={() => copyNumber(e)} data-testid="tel-detail-copy">
              <Copy className="size-3.5" aria-hidden />
            </IconButton>
          ) : null}
        </div>
        {/* Desktop: the actions under the hero (the phone has them in the sticky bar). */}
        {!phone && (callable || number || e.memberUserId) ? (
          <div className="mt-4 flex flex-wrap justify-center gap-2" data-testid="tel-detail-actions">
            {callable ? (
              <Button onClick={() => callBack(e, ws)} data-testid="tel-detail-call">
                <Phone className="size-3.5" aria-hidden /> {t('tel.call')}
              </Button>
            ) : null}
            {number ? (
              <Button variant="secondary" onClick={() => openOrAddContact(e)} data-testid="tel-detail-contact">
                {e.contact?.id ? <UserRound className="size-3.5" aria-hidden /> : <UserRoundPlus className="size-3.5" aria-hidden />} {e.contact?.id ? t('telc.contactShort') : t('telc.addContactShort')}
              </Button>
            ) : null}
            {e.memberUserId ? (
              <Button variant="secondary" onClick={() => writeTo(e)}>
                <MessageCircle className="size-3.5" aria-hidden /> {t('tel.write')}
              </Button>
            ) : null}
          </div>
        ) : null}
        {d.recording ? <RecordingPlayer ws={ws} callId={callId} rec={d.recording} subtitle={party.name} phone={phone} /> : null}
        <Summary ws={ws} e={e} events={d.events} phone={phone} />
        <h4 className={cx('mb-1 mt-5 font-semibold', phone ? 'text-micro uppercase tracking-[0.04em] text-muted' : 'text-caption text-muted')}>{t('tel.route')}</h4>
        {d.loading && !d.events.length ? (
          <div className="flex justify-center py-4">
            <Spinner className="size-4" />
          </div>
        ) : d.failed ? (
          <div className="flex items-center justify-between gap-3 py-2" role="alert">
            <span className="text-caption text-danger-text">{t('tel.detailFailed')}</span>
            <Button variant="secondary" size="sm" onClick={d.retry}>
              {t('common.retry')}
            </Button>
          </div>
        ) : d.events.length ? (
          <CallRoute ws={ws} entry={e} events={d.events} phone={phone} />
        ) : (
          <p className="text-caption text-muted">{t('tel.route.none')}</p>
        )}
      </div>
      {phone ? <PhoneActions ws={ws} e={e} recording={d.recording} subtitle={party.name} /> : null}
    </>
  );
}

/** The summary: a grouped list of label · value rows (2 columns on the desktop, 44 px rows on the phone). */
function Summary({ ws, e, events, phone }: { ws: string; e: SipJournalEntry; events: readonly SipCallEvent[]; phone: boolean }): ReactNode {
  const c = e.call;
  const room = useRooms((s) => (c?.roomId && e.origin === SipCallOrigin.ROOM ? (s.byId[c.roomId]?.name ?? '') : ''));
  const answeredBy = c?.answeredBy ?? '';
  const answeredName = useWorkspaces(() => (answeredBy ? person(ws, answeredBy) : ''));
  const placedName = useWorkspaces(() => (c?.startedBy && c.direction === SipCallDirection.OUT ? person(ws, c.startedBy) : ''));
  if (!c) return null;
  const inbound = c.direction === SipCallDirection.IN;
  const start = startOf(e);
  const trunk = inbound ? (events.find((x) => x.kind === SipCallEventKind.STARTED)?.digits ?? '') : '';
  const ended = c.endedAt ? timestampMs(c.endedAt) : 0;
  const rows: Array<{ k: string; label: string; value: ReactNode }> = [
    { k: 'dir', label: t('tel.s.direction'), value: inbound ? t('tel.s.in') : room ? t('tel.s.outRoom', { room }) : t('tel.s.out') },
    { k: 'when', label: t('tel.s.when'), value: start ? fmt.dateTime(new Date(start), 'short') : '—' },
    ...(inbound ? [{ k: 'wait', label: t('tel.s.wait'), value: e.waitMs > 0 ? dur(e.waitMs) : '—' }] : []),
    { k: 'talk', label: t('tel.s.talk'), value: e.talkMs > 0 ? dur(e.talkMs) : ended || !c.answeredAt ? '—' : t('tel.r.live') },
    { k: 'result', label: t('tel.s.result'), value: <span className={e.missed ? 'text-danger-text' : undefined}>{resultText(e)}</span> },
    ...(answeredBy && inbound
      ? [
          {
            k: 'by',
            label: t('tel.s.answeredBy'),
            value: (
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <Avatar userId={answeredBy} name={memberName(ws, answeredBy)} size={phone ? 24 : 18} />
                <span className="min-w-0 truncate">{answeredName}</span>
              </span>
            ),
          },
        ]
      : []),
    ...(placedName ? [{ k: 'placed', label: t('tel.s.placedBy'), value: placedName }] : []),
    ...(trunk ? [{ k: 'trunk', label: t('tel.s.trunk'), value: <span className="tabular-nums">{formatPhone(trunk)}</span> }] : []),
  ];
  if (phone) {
    return (
      <dl className="mt-5 overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-card)]" data-testid="tel-summary">
        {rows.map((r) => (
          <div key={r.k} className="flex min-h-11 items-center gap-3 border-b border-[var(--color-card-line)] px-3 py-2 last:border-b-0">
            <dt className="shrink-0 text-list text-muted">{r.label}</dt>
            <dd className="flex min-w-0 flex-1 justify-end text-right text-list text-fg">{r.value}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2.5 rounded-[var(--radius-card)] bg-[var(--color-card)] p-3" data-testid="tel-summary">
      {rows.map((r) => (
        <div key={r.k} className="flex min-w-0 flex-col">
          <dt className="text-micro text-muted">{r.label}</dt>
          <dd className="min-w-0 truncate text-body text-fg">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The phone's sticky action bar (ADR-0137 §7): «Позвонить» full width at the thumb, the round actions under it. */
function PhoneActions({ ws, e, recording, subtitle }: { ws: string; e: SipJournalEntry; recording: SipJournalRecording | undefined; subtitle: string }): ReactNode {
  const peer = internalPeer(e, ws);
  const number = numberOf(e) !== '';
  const place = usePlaceCalls(ws);
  const callable = !!peer || (place && number);
  if (!callable && !number && !recording && !e.memberUserId) return null;
  const round = 'grid size-11 place-items-center rounded-full bg-hover text-fg';
  return (
    <div className="mat-toolbar flex shrink-0 flex-col gap-2 border-t border-line px-4 pb-[calc(var(--safe-bottom,0px)+12px)] pt-3" data-testid="tel-detail-bar">
      {callable ? (
        <button type="button" onClick={() => callBack(e, ws)} className="flex h-[52px] w-full items-center justify-center gap-2 rounded-full bg-ok-fill text-list font-semibold text-white" data-testid="tel-detail-call">
          <Phone className="size-5" aria-hidden />
          {t('tel.call')}
        </button>
      ) : null}
      <div className="flex items-start justify-center gap-4">
        {number ? (
          <RoundAction label={t('telc.contactShort')} name={e.contact?.id ? t('telc.openContact') : t('telc.addContact')} onClick={() => openOrAddContact(e)} testId="tel-detail-contact" cls={round}>
            {e.contact?.id ? <UserRound className="size-5" aria-hidden /> : <UserRoundPlus className="size-5" aria-hidden />}
          </RoundAction>
        ) : null}
        {number ? (
          <RoundAction label={t('tel.copyShort')} name={t('tel.copy')} onClick={() => copyNumber(e)} testId="tel-detail-copy" cls={round}>
            <Copy className="size-5" aria-hidden />
          </RoundAction>
        ) : null}
        {recording ? <RecordingButton callId={e.call?.id ?? ''} rec={recording} subtitle={subtitle} round={round} /> : null}
        {e.memberUserId ? (
          <RoundAction label={t('tel.write')} name={t('tel.write')} onClick={() => writeTo(e)} testId="tel-detail-write" cls={round}>
            <MessageCircle className="size-5" aria-hidden />
          </RoundAction>
        ) : null}
      </div>
    </div>
  );
}

function RoundAction({ label, name, onClick, testId, cls, children }: { label: string; name: string; onClick: () => void; testId: string; cls: string; children: ReactNode }): ReactNode {
  return (
    <button type="button" onClick={onClick} title={name} className="flex w-[84px] flex-col items-center gap-1 text-micro text-muted" data-testid={testId}>
      <span className={cls}>{children}</span>
      <span className="max-w-full truncate">{label}</span>
    </button>
  );
}

/** «Запись ▶» of the phone's bar: the same track as the player card (one <audio> app-wide, docs/02). */
function RecordingButton({ callId, rec, subtitle, round }: { callId: string; rec: SipJournalRecording; subtitle: string; round: string }): ReactNode {
  const playing = usePlayer((s) => s.track?.messageId === `sip-call:${callId}` && s.playing);
  return (
    <button type="button" onClick={() => toggleRecording(callId, rec, subtitle)} aria-label={`${t('tel.recording')}: ${playing ? t('tel.recording.pause') : t('tel.recording.play')}`} className="flex w-[84px] flex-col items-center gap-1 text-micro text-muted" data-testid="tel-detail-recording">
      <span className={round}>{playing ? <Pause className="size-5 fill-current" aria-hidden /> : <Play className="ml-0.5 size-5 fill-current" aria-hidden />}</span>
      <span className="max-w-full truncate">{t('tel.recording')}</span>
    </button>
  );
}
