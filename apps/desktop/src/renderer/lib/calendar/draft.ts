import type { MessageInitShape } from '@bufbuild/protobuf';
import { timestampFromMs, timestampMs } from '@bufbuild/protobuf/wkt';
import { EventRepeat, type CalendarEvent, type CreateCalendarEventRequestSchema, type UpdateCalendarEventRequestSchema } from '@calaba/protocol';
import type { MessageKey } from '../../i18n';
import { atMinutes, dayEnd, dayKey, dayStart, eventDays, eventSpan, minutesOf, STEP_MIN } from './time';

/*
 * The meeting dialog's model (ADR-0038 §7): the form's values, their checks and the requests they
 * make. Times are a local day + minutes after its midnight (the end may pass 24:00 — a meeting
 * over midnight). Pure.
 */

export interface DraftAttendee {
  userId: string;
  email: string;
  required: boolean;
}

export interface EventDraft {
  title: string;
  description: string;
  day: string;
  start: number;
  end: number;
  allDay: boolean;
  roomId: string;
  /**
   * The meeting's own temporary room (ADR-0112): with `roomId` '' the server makes it 1 h before
   * the start; with `roomId` set that room is the one it made. Excludes a chosen room and a repeat.
   */
  tempRoom: boolean;
  attendees: DraftAttendee[];
  repeat: EventRepeat;
  /** `YYYY-MM-DD` (inclusive, the viewer's zone), '' = no end. */
  until: string;
  record: boolean;
}

export const MAX_TITLE = 120;
export const MAX_DESCRIPTION = 4000;
export const MAX_EXTERNALS = 20;
export const MAX_ATTENDEES = 100;

/** The server's address check, roughly (calendar/input.go): something@domain.tld, no spaces or <>. */
export const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

const snapDown = (m: number): number => Math.floor(m / STEP_MIN) * STEP_MIN;

/** A new meeting: the given range (a grid selection, «+ Встреча»), else the next half hour for 30 minutes. */
export function newDraft(init: { start?: number; end?: number; allDay?: boolean; roomId?: string; attendees?: readonly string[] }, now = Date.now()): EventDraft {
  const s = new Date(init.start ?? Math.ceil((now + 60_000) / 1_800_000) * 1_800_000);
  const day = dayKey(s);
  const start = snapDown(minutesOf(s));
  const endMs = init.end ?? s.getTime() + 30 * 60_000;
  const end = Math.max(start + STEP_MIN, snapDown(Math.round((endMs - dayStart(day)) / 60_000)));
  return { title: '', description: '', day, start, end, allDay: init.allDay ?? false, roomId: init.roomId ?? '', tempRoom: false, attendees: (init.attendees ?? []).reduce<DraftAttendee[]>((l, id) => addMember(l, id), []), repeat: EventRepeat.UNSPECIFIED, until: '', record: false };
}

/** The form of an existing occurrence (its own date and times). */
export function draftOf(ev: CalendarEvent): EventDraft {
  const { start, end } = eventSpan(ev);
  const s = new Date(start);
  const day = ev.allDay ? (eventDays(ev)[0] ?? dayKey(s)) : dayKey(s);
  return {
    title: ev.title,
    description: ev.description,
    day,
    start: ev.allDay ? 9 * 60 : minutesOf(s),
    end: ev.allDay ? 10 * 60 : Math.round((end - dayStart(day)) / 60_000),
    allDay: ev.allDay,
    roomId: ev.roomId,
    tempRoom: ev.tempRoom,
    attendees: ev.attendees.filter((a) => a.userId !== ev.organizerId).map((a) => ({ userId: a.userId, email: a.email, required: a.required })),
    repeat: ev.repeat,
    until: ev.repeatUntil ? dayKey(timestampMs(ev.repeatUntil)) : '',
    record: ev.record,
  };
}

/** A copy for «Дублировать»: everything but the answers; a meeting's own room is asked for anew. */
export function copyDraft(ev: CalendarEvent): EventDraft {
  const d = draftOf(ev);
  return { ...d, ...(d.tempRoom ? { roomId: '' } : {}), attendees: d.attendees.map((a) => ({ ...a })) };
}

/** The draft's [start, end) in ms; all-day — the local day (the server rounds to midnight of tz). */
export function draftSpan(d: EventDraft): { start: number; end: number } {
  if (d.allDay) return { start: dayStart(d.day), end: dayEnd(d.day) };
  return { start: atMinutes(d.day, d.start).getTime(), end: atMinutes(d.day, d.end).getTime() };
}

export type DraftField = 'title' | 'end' | 'email' | 'attendees' | 'until' | 'description';
export type DraftErrors = Partial<Record<DraftField, MessageKey>>;

export function validateDraft(d: EventDraft): DraftErrors {
  const e: DraftErrors = {};
  const title = d.title.trim();
  if (!title || Array.from(title).length > MAX_TITLE) e.title = 'cal.err.title';
  if (!d.allDay && d.end <= d.start) e.end = 'cal.err.end';
  if (d.attendees.filter((a) => !a.userId).length > MAX_EXTERNALS) e.attendees = 'cal.err.externals';
  // The organizer takes a place too (calendar/input.go checkAttendees).
  else if (d.attendees.length + 1 > MAX_ATTENDEES) e.attendees = 'cal.err.attendeesMax';
  if (d.repeat !== EventRepeat.UNSPECIFIED && d.until && d.until < d.day) e.until = 'cal.err.end';
  return e;
}

/** An address typed into «Пригласить по email»: added, or why not. */
export function addEmail(list: readonly DraftAttendee[], raw: string): { list: DraftAttendee[] } | { error: MessageKey } {
  const email = raw.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { error: 'cal.err.email' };
  if (list.some((a) => !a.userId && a.email === email)) return { error: 'cal.err.emailDup' };
  if (list.filter((a) => !a.userId).length >= MAX_EXTERNALS) return { error: 'cal.err.externals' };
  return { list: [...list, { userId: '', email, required: false }] };
}

/** A member added (picker, drop): required by default; already there → unchanged. */
export function addMember(list: readonly DraftAttendee[], userId: string): DraftAttendee[] {
  if (!userId || list.some((a) => a.userId === userId)) return [...list];
  return [...list, { userId, email: '', required: true }];
}

/**
 * «@all»: every given member added as required, those already listed kept as they are (their
 * required / optional choice too). The caller passes the workspace's members, not guests or bots.
 */
export function addMembers(list: readonly DraftAttendee[], userIds: readonly string[]): DraftAttendee[] {
  const have = new Set(list.map((a) => a.userId).filter(Boolean));
  const out = [...list];
  for (const id of userIds) {
    if (!id || have.has(id)) continue;
    have.add(id);
    out.push({ userId: id, email: '', required: true });
  }
  return out;
}

const untilTs = (d: EventDraft): number | null => (d.repeat !== EventRepeat.UNSPECIFIED && d.until ? dayEnd(d.until) - 1 : null);

type CreateInit = MessageInitShape<typeof CreateCalendarEventRequestSchema>;
type UpdateInit = MessageInitShape<typeof UpdateCalendarEventRequestSchema>;

export function toCreate(d: EventDraft, tz: string): CreateInit {
  const { start, end } = draftSpan(d);
  const until = untilTs(d);
  return {
    title: d.title.trim(),
    description: d.description,
    startsAt: timestampFromMs(start),
    endsAt: timestampFromMs(end),
    allDay: d.allDay,
    tz,
    roomId: d.tempRoom ? '' : d.roomId,
    tempRoom: d.tempRoom,
    record: d.record,
    repeat: d.repeat,
    ...(until !== null ? { repeatUntil: timestampFromMs(until) } : {}),
    attendees: d.attendees.map((a) => ({ userId: a.userId, email: a.email, required: a.required })),
  };
}

/**
 * The changes of an edit, only what differs. `seriesStart` (a series): the occurrence's move is
 * applied to the series' first start (v1 edits every occurrence).
 */
export function toUpdate(d: EventDraft, orig: EventDraft, tz: string, seriesStart?: number): UpdateInit {
  const out: UpdateInit = {};
  if (d.title.trim() !== orig.title) out.title = d.title.trim();
  if (d.description !== orig.description) out.description = d.description;
  if (d.roomId !== orig.roomId) out.roomId = d.roomId;
  if (d.tempRoom !== orig.tempRoom) out.tempRoom = d.tempRoom;
  if (d.record !== orig.record) out.record = d.record;
  if (d.allDay !== orig.allDay) {
    out.allDay = d.allDay;
    out.tz = tz;
  }
  const now = draftSpan(d);
  const was = draftSpan(orig);
  if (now.start !== was.start || now.end !== was.end || d.allDay !== orig.allDay) {
    const base = seriesStart ?? was.start;
    const start = base + (now.start - was.start);
    out.startsAt = timestampFromMs(start);
    out.endsAt = timestampFromMs(start + (now.end - now.start));
  }
  if (d.repeat !== orig.repeat) out.repeat = d.repeat;
  if (d.repeat !== orig.repeat || d.until !== orig.until) {
    const until = untilTs(d);
    if (until !== null) out.repeatUntil = timestampFromMs(until);
    else out.clearRepeatUntil = true;
  }
  const key = (a: DraftAttendee): string => `${a.userId}|${a.email}|${a.required}`;
  if (d.attendees.map(key).join() !== orig.attendees.map(key).join()) {
    out.setAttendees = true;
    out.attendees = d.attendees.map((a) => ({ userId: a.userId, email: a.email, required: a.required }));
  }
  return out;
}

export const draftDirty = (a: EventDraft, b: EventDraft): boolean => JSON.stringify(a) !== JSON.stringify(b);

/** Server field (422 `field`) → the form's field. */
export function fieldOf(serverField: string | undefined): DraftField | null {
  switch (serverField) {
    case 'title':
      return 'title';
    case 'description':
      return 'description';
    case 'startsAt':
    case 'endsAt':
    case 'starts_at':
    case 'ends_at':
      return 'end';
    case 'attendees':
      return 'attendees';
    case 'repeatUntil':
    case 'repeat_until':
      return 'until';
    default:
      return null;
  }
}
