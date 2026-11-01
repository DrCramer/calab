import { SipActiveStep, SipCallDirection, SipCallOrigin, SipCallStatus, SipCallTargetKind, type SipJournalEntry } from '@calaba/protocol';
import { getLocale, plural, t, type MessageKey } from '../../i18n';
import { dateTimeFormat, fmt } from '../../lib/format';
import { formatPhone, reasonKey } from '../../lib/sip';
import { myUserId } from '../../stores/session';
import { useRooms } from '../../stores/rooms';
import { memberName } from '../../stores/workspaces';
import { formatDuration } from '../shell/voiceFormat';
import { numberOf, type Outcome, type RingAttempt, type Step } from './timeline';

/*
 * «Телефония» texts (ADR-0137 §6–§7): a row's name and outcome line, the day headers, the
 * detail's summary and the steps of «Маршрут». Names are read at call time (members, rooms):
 * a row re-renders when its entry changes; a rename shows on the next one.
 */

/** «Вы» for me, else the member's name. */
export function person(ws: string, userId: string): string {
  if (!userId) return '';
  return userId === myUserId() ? t('tel.you') : memberName(ws, userId);
}

/** A duration for people: «0:31», «4:12», «1:02:15». */
export const dur = (ms: number): string => formatDuration(ms);

/** A short duration for the route: «8 с», «1 мин 15 с». */
export function shortDur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return t('tel.sec', { n: s });
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? t('tel.minSec', { m, s: r }) : t('tel.min', { n: m });
}

/** Who the call is with: the contact (T2), an employee whose phone it is, the number, «Скрытый номер». */
export function partyName(ws: string, e: SipJournalEntry): { name: string; company: string; number: string } {
  const number = numberOf(e);
  const shown = number ? formatPhone(number) : t('tel.hidden');
  if (e.contact && (e.contact.name || e.contact.company)) return { name: e.contact.name || e.contact.company, company: e.contact.name ? e.contact.company : '', number: shown };
  if (e.memberUserId) return { name: memberName(ws, e.memberUserId), company: '', number: shown };
  return { name: shown, company: '', number: number ? shown : '' };
}

/** The outcome line under the name (ADR-0137 §6). */
export function outcomeText(ws: string, o: Outcome, e: SipJournalEntry): string {
  switch (o.kind) {
    case 'answered':
      return [t('tel.o.answered', { name: person(ws, o.by) || '—' }), o.waitMs > 0 ? t('tel.o.wait', { d: dur(o.waitMs) }) : '', o.talkMs > 0 ? dur(o.talkMs) : ''].filter(Boolean).join(' · ');
    case 'missed':
      return [t('tel.o.missed'), o.waitMs > 0 ? t('tel.o.wait', { d: dur(o.waitMs) }) : '', o.via ? `«${o.via}»` : ''].filter(Boolean).join(' · ');
    case 'refused':
      return t('tel.o.refused', { reason: t(reasonKey(SipCallStatus.FAILED, o.reason)) });
    case 'test':
      return t('tel.o.test');
    case 'outbound': {
      if (o.failed) return t('tel.o.outFailed', { reason: t(reasonKey(SipCallStatus.FAILED, o.failed)) });
      const who = person(ws, o.by);
      const room = o.roomId ? (useRooms.getState().byId[o.roomId]?.name ?? '') : '';
      const head = room ? t('tel.o.room', { room }) : e.origin === SipCallOrigin.ROOM ? t('tel.o.roomGone') : t('tel.o.out');
      return [head, who, o.talkMs > 0 ? dur(o.talkMs) : ''].filter(Boolean).join(' · ');
    }
    case 'live':
      return liveText(ws, e, null);
  }
}

/**
 * Where a live call is (the «Сейчас» block): the exchange's step (ADR-0128) when I may read it,
 * else what the call itself says — ringing whom, talking with whom, dialing.
 */
export function liveText(ws: string, e: SipJournalEntry, step: { step: SipActiveStep; name: string } | null): string {
  const c = e.call;
  if (!c) return '';
  const ringing = c.ringingUserIds.map((u) => person(ws, u)).join(', ');
  const s = step?.step;
  if (s === SipActiveStep.MENU) return step?.name ? t('pbx.calls.menu', { name: step.name }) : t('pbx.calls.menuAny');
  if (c.status === SipCallStatus.ACTIVE) {
    if (c.direction === SipCallDirection.IN) return t('pbx.calls.connected', { name: person(ws, c.answeredBy) || '—' });
    const room = c.roomId ? (useRooms.getState().byId[c.roomId]?.name ?? '') : '';
    return room ? t('pbx.calls.connectedRoom', { room }) : t('tel.live.talking', { name: person(ws, c.startedBy) || '—' });
  }
  if (c.direction === SipCallDirection.OUT) return t('sip.status.dialing');
  const group = s === SipActiveStep.RINGING ? step?.name : c.via;
  if (ringing) return group ? `${t('pbx.calls.ringGroup', { name: group })} · ${ringing}` : t('pbx.calls.ringing', { names: ringing });
  if (s === SipActiveStep.RINGING) return t('pbx.calls.ringWait');
  return c.via ? t('tel.live.via', { name: c.via }) : t('tel.live.incoming');
}

/** The right edge of a row: «14:32» today, «Вчера», a weekday within the week, «12.10» earlier. */
export function rowTime(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const t0 = today.getTime();
  if (ms >= t0) return fmt.time(d);
  if (ms >= t0 - 86_400_000) return t('chat.yesterday');
  if (ms >= t0 - 6 * 86_400_000) return dateTimeFormat({ weekday: 'short' }).format(d);
  return dateTimeFormat({ day: '2-digit', month: '2-digit', ...(d.getFullYear() === today.getFullYear() ? {} : { year: '2-digit' }) }).format(d);
}

/** A day header: «Сегодня», «Вчера», «пн, 20 окт.» (the year when not this one). */
export function dayHeader(dayMs: number, now = Date.now()): string {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (dayMs >= today.getTime()) return t('chat.today');
  if (dayMs >= today.getTime() - 86_400_000) return t('chat.yesterday');
  const d = new Date(dayMs);
  const s = dateTimeFormat({ weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }) }).format(d);
  return getLocale() === 'ru' ? s.replace(/\.$/, '') : s;
}

/** The detail's «Итог». */
export function resultText(e: SipJournalEntry): string {
  const c = e.call;
  if (!c) return '';
  if (c.status === SipCallStatus.DIALING || c.status === SipCallStatus.RINGING || c.status === SipCallStatus.ACTIVE) return t('tel.r.live');
  if (e.origin === SipCallOrigin.TEST) return t('tel.o.test');
  if (c.answeredAt) return c.direction === SipCallDirection.IN ? t('tel.r.answered') : t('tel.r.talked');
  if (e.missed) return t('tel.r.missed');
  return capital(t(reasonKey(c.status === SipCallStatus.FAILED ? SipCallStatus.FAILED : SipCallStatus.ENDED, c.reason || 'no_answer')));
}

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------------------------------------------------------- «Маршрут»

const RING_OUTCOME: Record<string, MessageKey> = {
  no_answer: 'tel.ring.noAnswer',
  declined: 'tel.ring.declined',
  answered_elsewhere: 'tel.ring.elsewhere',
  fallback: 'tel.ring.fallback',
  caller_left: 'tel.ring.callerLeft',
  cancelled: 'tel.ring.cancelled',
  ended: 'tel.ring.ended',
  busy: 'tel.ring.busy',
  answered: 'tel.ring.answered',
};

/** One person of a folded run: «Анна · 15 с · не ответил(а)». */
export function attemptText(a: RingAttempt): string {
  return [a.durMs !== null ? shortDur(a.durMs) : '', a.outcome ? t(RING_OUTCOME[a.outcome] ?? 'tel.ring.noAnswer') : t('tel.ring.now')].filter(Boolean).join(' · ');
}

/** The target of a step as people read it: «Отдел продаж», «вн. 101», a member's name. */
function targetText(ws: string, kind: SipCallTargetKind, name: string, id: string): string {
  if (kind === SipCallTargetKind.USER) return (id ? memberName(ws, id) : '') || name;
  if (kind === SipCallTargetKind.EXTENSION) return t('tel.ext', { n: name });
  return name;
}

/** A step's two lines: the step (500) and its detail (muted), both may wrap. */
export function stepText(ws: string, s: Step, entry: SipJournalEntry): { title: string; detail: string } {
  const e = s.ev;
  const who = e.userId ? memberName(ws, e.userId) : '';
  const target = targetText(ws, e.targetKind, e.targetName, e.targetId);
  switch (s.kind) {
    case 'started': {
      if (entry.call?.direction === SipCallDirection.IN) return { title: e.digits ? t('tel.st.startedIn', { number: formatPhone(e.digits) }) : t('tel.st.incoming'), detail: e.reason === 'register' ? t('tel.st.viaRegister') : '' };
      if (entry.origin === SipCallOrigin.TEST) return { title: t('tel.o.test'), detail: who };
      const room = e.targetKind === SipCallTargetKind.ROOM ? e.targetName : '';
      return { title: who ? t('tel.st.calls', { name: who }) : t('tel.st.outgoing'), detail: room ? t('tel.st.fromRoom', { room }) : '' };
    }
    case 'menu':
      return { title: e.targetName ? t('tel.st.menu', { name: e.targetName }) : t('pbx.calls.menuAny'), detail: Number(e.digits) > 1 ? t('tel.st.menuAgain', { n: Number(e.digits) }) : '' };
    case 'key':
      return { title: t('tel.st.key', { key: e.digits }), detail: e.reason === 'invalid' ? t('tel.st.keyInvalid') : '' };
    case 'dialed':
      return { title: t('tel.st.dialed', { n: e.digits }), detail: e.reason === 'not_found' ? t('tel.st.notFound') : '' };
    case 'noInput':
      return { title: t('tel.st.noInput'), detail: '' };
    case 'notice':
      return { title: t('tel.st.notice'), detail: '' };
    case 'group':
      return { title: t('tel.st.group', { name: e.targetName || '—' }), detail: e.reason === 'round_robin' ? t('tel.st.roundRobin') : t('tel.st.ringAll') };
    case 'rings': {
      const r = s.rings;
      if (!r) return { title: '', detail: '' };
      const first = r.attempts[0];
      if (r.mode === 'one' && first) return { title: t('tel.st.ringOne', { name: memberName(ws, first.userId) }), detail: attemptText(first) };
      const names = [...new Set(r.attempts.map((a) => a.userId))];
      const answered = r.answeredBy ? t('tel.st.answeredAfter', { name: memberName(ws, r.answeredBy), d: r.answeredAfterMs !== null ? shortDur(r.answeredAfterMs) : '' }).replace(/\s+$/, '') : t('tel.st.nobody');
      if (r.mode === 'all') return { title: t('tel.st.ringAllNames', { names: names.map((u) => memberName(ws, u)).join(', ') }), detail: answered };
      return { title: plural('tel.st.rangN', names.length), detail: answered };
    }
    case 'fallback':
      return { title: t('tel.st.fallback', { target: target || '—' }), detail: e.reason === 'timeout' ? t('tel.st.fbTimeout') : e.reason === 'nobody' ? t('tel.st.fbNobody') : e.reason === 'declined' ? t('tel.st.fbDeclined') : '' };
    case 'answered':
      return { title: e.userId ? t('tel.st.answered', { name: who }) : t('tel.st.calleeAnswered'), detail: '' };
    case 'transfer': {
      const to = e.peerUserId ? memberName(ws, e.peerUserId) : target;
      return { title: t('tel.st.transfer', { name: who || '—', to: to || '—' }), detail: '' };
    }
    case 'transferEnd':
      if (e.reason === 'answered') return { title: t('tel.st.transferTaken', { name: who || '—' }), detail: '' };
      return { title: t('tel.st.transferFailed'), detail: t(RING_OUTCOME[e.reason] ?? (e.reason === 'not_connected' ? 'tel.st.notConnected' : 'tel.ring.cancelled')) };
    case 'dialing':
      return { title: t('tel.st.dialing'), detail: '' };
    case 'providerRinging':
      return { title: t('tel.st.providerRinging'), detail: '' };
    case 'recording':
      return { title: e.reason === 'stored' ? t('tel.st.recStored') : e.reason.startsWith('failed') ? t('tel.st.recFailed') : t('tel.st.recStarted'), detail: '' };
    case 'ended': {
      const reason = e.reason ? t(reasonKey(isFailure(entry) ? SipCallStatus.FAILED : SipCallStatus.ENDED, e.reason)) : '';
      return { title: who ? t('tel.st.hungUp', { name: who }) : t('tel.st.ended'), detail: who ? '' : reason };
    }
  }
}

const isFailure = (e: SipJournalEntry): boolean => e.call?.status === SipCallStatus.FAILED;
