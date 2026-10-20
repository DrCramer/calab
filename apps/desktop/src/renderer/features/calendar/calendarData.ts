import { useEffect, useMemo } from 'react';
import { dayKeys, daySignature, keyEventId, parseSignature, type SigItem } from '../../lib/calendar/events';
import { externalSignature, parseExternalSignature } from '../../lib/calendar/external';
import { chunkOf } from '../../lib/calendar/freebusy';
import { layoutDay, type Placed } from '../../lib/calendar/layout';
import { dayEnd, dayStart, monthOf } from '../../lib/calendar/time';
import { ensureMonth } from '../../services/calendar';
import { busySignature, ensureBusy, ensureExternal, parseBusySignature } from '../../services/freebusy';
import { useCalendar } from '../../stores/calendar';
import { entryKey, selectPeople, useFreeBusy } from '../../stores/freebusy';
import { myUserId } from '../../stores/session';

/*
 * What the day and the week view draw for their days (ADR-0038 §7, ADR-0041 §3, ADR-0045 §3): the
 * meetings in scope, the free / busy time of the watched people, my external calendar's events —
 * per day, laid out. One hook for both views: the day view is the week view with one day.
 */

const NO_PEOPLE: readonly string[] = [];
/** Separates the days inside the primitive signatures. */
const DAY_SEP = '§';

export interface DayData {
  day: string;
  /** Timed items (meetings, busy, external) with their spans — the layout's input. */
  timed: SigItem[];
  /** Keys of the «весь день» row: meetings, then external events, then busy. */
  allDay: string[];
  placed: Placed[];
  /** Anything at all on the day. */
  count: number;
}

/**
 * The days' items. Selectors return primitive signatures: a change re-renders the view only when
 * the set or a time changes, not on an answer / title (the blocks subscribe to those themselves).
 * `days` must be stable (memoised by the caller); it is also the loaded range: the months of its
 * days, the free / busy and external chunks of [first day, last day].
 */
export function useCalendarDays(workspaceId: string, days: readonly string[]): { data: DayData[]; people: readonly string[] } {
  const first = days[0] ?? '';
  const last = days[days.length - 1] ?? first;
  const from = dayStart(first);
  const to = dayEnd(last);

  useEffect(() => {
    ensureMonth(workspaceId, monthOf(first));
    if (monthOf(last) !== monthOf(first)) ensureMonth(workspaceId, monthOf(last));
  }, [workspaceId, first, last]);

  // Scope: without a selection only meetings I organize or attend (owner, 02.10); with one — only
  // the selected people's (owner, 05.10).
  const people = useFreeBusy(selectPeople(workspaceId));
  const peopleSet = useMemo(() => (people.length ? new Set(people) : undefined), [people]);
  const me = myUserId();
  const sig = useCalendar((s) => days.map((d) => daySignature(s.occ, dayKeys(s.occ, workspaceId, d, peopleSet, me))).join(DAY_SEP));

  // Busy time from free / busy: the selected people's (what I cannot see as a meeting), else my
  // external calendar's. A primitive per person: a busy change of someone else re-renders nothing.
  const own = people.length === 0;
  // My external calendar's events: in my own calendar, or when I am one of the selected people.
  const showMine = own || (!!me && people.includes(me));
  const watched = useMemo(() => (!own ? people : me ? [me] : NO_PEOPLE), [own, people, me]);
  useEffect(() => ensureBusy(workspaceId, watched, from, to), [workspaceId, watched, from, to]);
  const fbSig = useFreeBusy((s) => watched.map((u) => `${u}#${busySignature(s.entries[entryKey(workspaceId, u)], from, to)}`).join('¦'));
  // My external calendar's events with their details (ADR-0045 §3) wherever my busy time shows:
  // cards instead of my grey external blocks once the days are loaded.
  const extOn = useFreeBusy((s) => showMine && !!s.caldav?.calendarHref && s.caldav.import);
  const extLoaded = useFreeBusy((s) => s.externalWs === workspaceId && !!s.externalChunks[chunkOf(from)] && !!s.externalChunks[chunkOf(to - 1)]);
  useEffect(() => {
    if (extOn && !extLoaded) ensureExternal(workspaceId, from, to);
  }, [workspaceId, from, to, extOn, extLoaded]);
  const extSig = useFreeBusy((s) => (showMine && s.externalWs === workspaceId ? days.map((d) => externalSignature(s.external[d])).join(DAY_SEP) : ''));
  const extHeld = useFreeBusy((s) => showMine && s.externalWs === workspaceId && days.every((d) => s.external[d] !== undefined));

  const data = useMemo(() => {
    const perDay = sig.split(DAY_SEP).map(parseSignature);
    const perExt = extSig.split(DAY_SEP).map((part) => parseExternalSignature(part).map((e): SigItem => ({ key: e.key, allDay: e.allDay, start: e.start, end: e.end })));
    const busy = busyItems(fbSig, perDay.flat(), own, extHeld ? me : '');
    return days.map((day, i): DayData => {
      const ds = dayStart(day);
      const de = dayEnd(day);
      const items = perDay[i] ?? [];
      const ext = perExt[i] ?? [];
      const b = days.length === 1 ? busy : busy.filter((x) => x.start < de && x.end > ds);
      const timed = [...items.filter((x) => !x.allDay), ...b.filter((x) => !x.allDay), ...ext.filter((x) => !x.allDay)];
      const allDay = [...items.filter((x) => x.allDay), ...ext.filter((x) => x.allDay), ...b.filter((x) => x.allDay)].map((x) => x.key);
      return { day, timed, allDay, placed: layoutDay(timed, ds, de), count: items.length + b.length + ext.length };
    });
  }, [sig, extSig, fbSig, own, extHeld, me, days]);

  return { data, people };
}

// ---------------------------------------------------------------- busy items (free / busy)

const BUSY = 'busy~';
export const isBusyKey = (key: string): boolean => key.startsWith(BUSY);

/**
 * Busy blocks of a range: `ownOnly` — my external calendar's; else the watched people's busy time
 * that is not a meeting shown on the grid. The same interval of several people is one block (an
 * external one only with the same shared title and attendees, ADR-0045 §4). `extOf`: whose
 * external intervals are drawn as event cards instead (me, once my days' events are loaded).
 */
export function busyItems(fbSig: string, shown: readonly SigItem[], ownOnly: boolean, extOf: string): SigItem[] {
  if (!fbSig) return [];
  const visible = new Set(shown.map((i) => keyEventId(i.key)));
  const groups = new Map<string, { start: number; end: number; kind: string; allDay: boolean; users: string[]; title: string; attendees: string }>();
  for (const part of fbSig.split('¦')) {
    const at = part.indexOf('#');
    const user = part.slice(0, at);
    for (const b of parseBusySignature(part.slice(at + 1))) {
      if (ownOnly ? b.kind !== 'external' : b.eventId && visible.has(b.eventId)) continue;
      if (b.kind === 'external' && user === extOf) continue;
      const title = b.kind === 'external' ? encodeURIComponent(b.title).replace(/~/g, '%7E') : '';
      const attendees = b.kind === 'external' ? b.attendees.join(',') : '';
      const g = `${b.start}~${b.end}~${b.kind}~${b.allDay ? 1 : 0}~${title}~${attendees}`;
      const cur = groups.get(g);
      if (cur) cur.users.push(user);
      else groups.set(g, { start: b.start, end: b.end, kind: b.kind, allDay: b.allDay, users: [user], title, attendees });
    }
  }
  return [...groups.values()].map((g) => ({ key: `${BUSY}${g.start}~${g.end}~${g.kind}~${g.users.join(',')}~${g.title}~${g.attendees}`, allDay: g.allDay, start: g.start, end: g.end }));
}

export function parseBusyKey(key: string): { start: number; end: number; external: boolean; users: string[]; title: string; attendees: string[] } {
  const [, s, e, kind, users = '', title = '', attendees = ''] = key.split('~');
  let text: string;
  try {
    text = decodeURIComponent(title);
  } catch {
    text = '';
  }
  return { start: Number(s), end: Number(e), external: kind === 'external', users: users.split(',').filter(Boolean), title: text, attendees: attendees.split(',').filter(Boolean) };
}
