import { EventRepeat } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { addEmail, addMember, addMembers, draftDirty, fieldOf, newDraft, toCreate, toUpdate, validateDraft, type EventDraft } from './draft';
import { atMinutes } from './time';

/** The meeting dialog's model (ADR-0038 §7, docs/20 C.1): checks, the requests it makes. Local times. */
const base = (): EventDraft => ({ ...newDraft({ start: atMinutes('2026-01-15', 15 * 60).getTime(), end: atMinutes('2026-01-15', 16 * 60).getTime() }), title: 'Планёрка' });

describe('meeting dialog model', () => {
  it('a grid range becomes the draft’s day and minutes', () => {
    const d = base();
    expect([d.day, d.start, d.end]).toEqual(['2026-01-15', 900, 960]);
  });

  it('checks the title, the end after the start, 20 external addresses at most', () => {
    expect(validateDraft({ ...base(), title: '  ' })).toEqual({ title: 'cal.err.title' });
    expect(validateDraft({ ...base(), end: 900 })).toEqual({ end: 'cal.err.end' });
    // All day: the times do not matter.
    expect(validateDraft({ ...base(), end: 900, allDay: true })).toEqual({});
    const many = Array.from({ length: 21 }, (_, i) => ({ userId: '', email: `x${i}@example.com`, required: false }));
    expect(validateDraft({ ...base(), attendees: many })).toEqual({ attendees: 'cal.err.externals' });
  });

  it('external addresses: checked, lower-cased, no duplicates, optional by default', () => {
    expect(addEmail([], 'не адрес')).toEqual({ error: 'cal.err.email' });
    const r = addEmail([], ' Ext@Example.com ');
    expect(r).toEqual({ list: [{ userId: '', email: 'ext@example.com', required: false }] });
    if (!('list' in r)) throw new Error('no list');
    expect(addEmail(r.list, 'ext@example.com')).toEqual({ error: 'cal.err.emailDup' });
    expect(addMember(r.list, 'u1')).toEqual([...r.list, { userId: 'u1', email: '', required: true }]);
    expect(addMember(addMember([], 'u1'), 'u1')).toHaveLength(1);
  });

  it('@all adds every member once, keeps the listed ones as they are; 100 with the organizer at most', () => {
    const list = [{ userId: 'u1', email: '', required: false }, { userId: '', email: 'x@example.com', required: false }];
    expect(addMembers(list, ['u1', 'u2', 'u2', '', 'u3'])).toEqual([...list, { userId: 'u2', email: '', required: true }, { userId: 'u3', email: '', required: true }]);
    const ids = Array.from({ length: 100 }, (_, i) => `u${i}`);
    expect(validateDraft({ ...base(), attendees: addMembers([], ids.slice(0, 99)) })).toEqual({});
    expect(validateDraft({ ...base(), attendees: addMembers([], ids) })).toEqual({ attendees: 'cal.err.attendeesMax' });
  });

  it('create: times as instants, the viewer’s zone, attendees as typed', () => {
    const d = { ...base(), roomId: 'r1', record: true, attendees: [{ userId: 'u1', email: '', required: true }], repeat: EventRepeat.WEEKLY, until: '2026-02-15' };
    const req = toCreate(d, 'Europe/Moscow');
    expect(req.startsAt).toEqual(expect.objectContaining({ seconds: BigInt(atMinutes('2026-01-15', 900).getTime() / 1000) }));
    expect(req).toMatchObject({ title: 'Планёрка', tz: 'Europe/Moscow', roomId: 'r1', record: true, repeat: EventRepeat.WEEKLY, attendees: [{ userId: 'u1', email: '', required: true }] });
    expect(req.repeatUntil).toBeDefined();
  });

  it('edit: only what changed; a series moves by the occurrence’s shift', () => {
    const orig = base();
    expect(toUpdate(orig, orig, 'Europe/Moscow')).toEqual({});
    expect(draftDirty(orig, { ...orig })).toBe(false);
    const moved = { ...orig, start: 960, end: 1020, title: 'Планёрка 2' };
    const seriesStart = atMinutes('2026-01-12', 900).getTime();
    const up = toUpdate(moved, orig, 'Europe/Moscow', seriesStart);
    expect(up.title).toBe('Планёрка 2');
    expect(Number(up.startsAt?.seconds) * 1000).toBe(seriesStart + 3_600_000);
    expect(Number(up.endsAt?.seconds) * 1000).toBe(seriesStart + 2 * 3_600_000);
    expect(up.setAttendees).toBeUndefined();
    // Repeat cleared → its end cleared.
    const series = { ...orig, repeat: EventRepeat.DAILY, until: '2026-01-20' };
    expect(toUpdate({ ...series, repeat: EventRepeat.UNSPECIFIED, until: '' }, series, 'UTC')).toMatchObject({ repeat: EventRepeat.UNSPECIFIED, clearRepeatUntil: true });
  });

  it('maps the server’s 422 fields to the form', () => {
    expect(fieldOf('title')).toBe('title');
    expect(fieldOf('endsAt')).toBe('end');
    expect(fieldOf('attendees')).toBe('attendees');
    expect(fieldOf('roomId')).toBeNull();
  });
});
