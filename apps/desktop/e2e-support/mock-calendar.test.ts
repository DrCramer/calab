import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { AttendeeStatus, EventRepeat, GatewayFrameSchema, GatewayOpcode, type Ready } from '@calaba/protocol';
import { IDS, startMockServer, type MockServer } from './mock-server';

// Calendar in the mock (ADR-0038): pnpm -F @calaba/desktop exec vitest run --config e2e-support/vitest.config.ts

let server: MockServer;

beforeAll(async () => {
  server = await startMockServer({ scenario: 'data' });
});
afterAll(async () => {
  await server.close();
});

async function login(email = 'owner@calaba.test'): Promise<string> {
  const res = await fetch(`${server.url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123', deviceName: 'vitest' }),
  });
  return ((await res.json()) as { tokens: { accessToken: string } }).tokens.accessToken;
}

const api = (token: string, path: string, init: { method?: string; body?: string } = {}): Promise<Response> =>
  fetch(`${server.url}${path}`, { ...init, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });

interface Ev {
  id: string;
  title: string;
  myStatus?: string;
  canEdit?: boolean;
  occurrenceAt?: string;
  attendees: { userId?: string; email?: string; status?: string }[];
  counts?: { accepted?: number; pending?: number; maybe?: number };
}

const HOUR = 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();

describe('calendar (ADR-0038)', () => {
  it('creates, lists, answers, edits and cancels meetings', async () => {
    server.reset();
    const anna = await login();
    const vera = await login('vera@calaba.test');
    const ws = IDS.workspaces.main;
    const start = Date.UTC(2030, 0, 7, 10);
    const created = await api(anna, `/api/workspaces/${ws}/events`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Планёрка', startsAt: iso(start), endsAt: iso(start + HOUR), roomId: IDS.rooms.meeting, tz: 'UTC',
        repeat: 'EVENT_REPEAT_WEEKLY', attendees: [{ userId: IDS.users.vera, required: true }, { email: 'Partner@Outside.org' }] }),
    });
    expect(created.status).toBe(201);
    const ev = ((await created.json()) as { event: Ev }).event;
    expect(ev.myStatus).toBe('ATTENDEE_STATUS_ACCEPTED');
    expect(ev.attendees.map((a) => a.email ?? a.userId)).toContain('partner@outside.org');

    // Validation and a text room.
    const bad = await api(anna, `/api/workspaces/${ws}/events`, { method: 'POST', body: JSON.stringify({ title: 'x', startsAt: iso(start), endsAt: iso(start), tz: 'UTC' }) });
    expect(bad.status).toBe(422);
    const text = await api(anna, `/api/workspaces/${ws}/events`, {
      method: 'POST', body: JSON.stringify({ title: 'x', startsAt: iso(start), endsAt: iso(start + HOUR), roomId: IDS.rooms.general }),
    });
    expect(text.status).toBe(422);

    const list = (await (await api(vera, `/api/workspaces/${ws}/events?from=${iso(start - HOUR)}&to=${iso(start + 15 * 24 * HOUR)}`)).json()) as { events: Ev[] };
    expect(list.events.map((e) => Date.parse(e.occurrenceAt ?? ""))).toEqual([start, start + 7 * 24 * HOUR, start + 14 * 24 * HOUR]);
    expect(list.events[0]?.myStatus).toBe('ATTENDEE_STATUS_PENDING');
    expect(list.events[0]?.canEdit ?? false).toBe(false);

    const answered = await api(vera, `/api/events/${ev.id}/rsvp`, { method: 'PUT', body: JSON.stringify({ status: 'ATTENDEE_STATUS_MAYBE' }) });
    expect(((await answered.json()) as { event: Ev }).event.myStatus).toBe('ATTENDEE_STATUS_MAYBE');
    expect((await api(vera, `/api/events/${ev.id}`, { method: 'PATCH', body: JSON.stringify({ title: 'y' }) })).status).toBe(403);
    const patched = await api(anna, `/api/events/${ev.id}`, { method: 'PATCH', body: JSON.stringify({ title: 'Планёрка 2' }) });
    expect(((await patched.json()) as { event: Ev }).event.title).toBe('Планёрка 2');

    // One occurrence cancelled, then the whole series.
    expect((await api(anna, `/api/events/${ev.id}?occurrence=${iso(start + 7 * 24 * HOUR)}`, { method: 'DELETE' })).status).toBe(204);
    const after = (await (await api(vera, `/api/workspaces/${ws}/events?from=${iso(start - HOUR)}&to=${iso(start + 15 * 24 * HOUR)}`)).json()) as { events: Ev[] };
    expect(after.events).toHaveLength(2);
    expect((await api(anna, `/api/events/${ev.id}`, { method: 'DELETE' })).status).toBe(204);
    const gone = (await (await api(vera, `/api/workspaces/${ws}/events?from=${iso(start - HOUR)}&to=${iso(start + 15 * 24 * HOUR)}`)).json()) as { events?: Ev[] };
    expect(gone.events ?? []).toHaveLength(0);
  });

  it('helpers: addEvent, rsvp, today, the answer link and reminder settings', async () => {
    server.reset();
    const now = Date.UTC(2030, 0, 7, 9, 50);
    server.setClock(now);
    const vera = await login('vera@calaba.test');
    const ev = server.addEvent({
      workspaceId: IDS.workspaces.main, title: 'Ретро', startMs: now + 10 * 60_000, endMs: now + HOUR, roomId: IDS.rooms.meeting,
      repeat: EventRepeat.UNSPECIFIED, attendees: [{ userId: IDS.users.vera }, { email: 'guest@outside.org', status: AttendeeStatus.ACCEPTED }],
    });
    const rsvp = server.rsvp(ev.id, IDS.users.vera, AttendeeStatus.DECLINED);
    expect(rsvp.attendees.find((a) => a.userId === IDS.users.vera)?.status).toBe(AttendeeStatus.DECLINED);
    expect(() => server.rsvp(ev.id, IDS.users.boris, AttendeeStatus.ACCEPTED)).toThrow();
    server.emitReminder(ev.id, IDS.users.vera, 15);
    server.setEventActive(ev.id, true);

    const anna = await login();
    const today = (await (await api(anna, '/api/me/events/today')).json()) as { count?: number; events: Ev[] };
    expect(today.count).toBe(1);
    const veraToday = (await (await api(vera, '/api/me/events/today')).json()) as { count?: number };
    expect(veraToday.count ?? 0).toBe(0); // declined

    const tok = server.eventRsvpToken(ev.id, 'guest@outside.org', AttendeeStatus.MAYBE);
    const pv = (await (await api('', `/api/event-rsvp?t=${encodeURIComponent(tok)}`)).json()) as { title: string; status: string };
    expect(pv).toMatchObject({ title: 'Ретро', status: 'ATTENDEE_STATUS_MAYBE' });
    expect((await api('', '/api/event-rsvp', { method: 'POST', body: JSON.stringify({ token: tok }) })).status).toBe(200);
    expect((await api('', '/api/event-rsvp', { method: 'POST', body: JSON.stringify({ token: 'junk' }) })).status).toBe(404);
    const card = (await (await api(anna, `/api/events/${ev.id}`)).json()) as { event: Ev };
    expect(card.event.attendees.find((a) => a.email === 'guest@outside.org')?.status).toBe('ATTENDEE_STATUS_MAYBE');
    // Vera (not the organizer, no MANAGE_ROOM) sees the address masked.
    const vcard = (await (await api(vera, `/api/events/${ev.id}`)).json()) as { event: Ev };
    expect(vcard.event.attendees.some((a) => a.email === 'guest@outside.org')).toBe(true); // an attendee: in full

    const me = await api(vera, '/api/me', { method: 'PATCH', body: JSON.stringify({ eventReminders: { minutes: [5, 60], dnd: false } }) });
    const settings = ((await me.json()) as { me: { settings: { eventReminders: number[]; eventRemindersDnd?: boolean } } }).me.settings;
    expect(settings.eventReminders).toEqual([60, 5]);
    expect(settings.eventRemindersDnd ?? false).toBe(false);
    expect((await api(vera, '/api/me', { method: 'PATCH', body: JSON.stringify({ eventReminders: { minutes: [7] } }) })).status).toBe(422);
    server.setClock(null);
  });

  it('deep links: the view token page and a guest of the room (ADR-0038 «Диплинки для приглашённых»)', async () => {
    server.reset();
    const now = Date.UTC(2030, 0, 7, 9, 50);
    server.setClock(now);
    const start = now + 10 * 60_000;
    const ev = server.addEvent({
      workspaceId: IDS.workspaces.main, title: 'Демо', description: '**Повестка**', startMs: start, endMs: start + HOUR, roomId: IDS.rooms.meeting,
      repeat: EventRepeat.UNSPECIFIED, attendees: [{ userId: IDS.users.vera }, { email: 'partner@outside.org' }],
    });
    const guestUrl = server.eventGuestLink(ev.id, 'partner@outside.org');
    expect(server.eventGuestLink(ev.id, 'partner@outside.org')).toBe(guestUrl);

    // The view token: the page with answer tokens and the guest window; it cannot answer itself.
    const view = server.eventViewToken(ev.id, 'partner@outside.org');
    const pg = (await (await api('', `/api/event-rsvp?t=${encodeURIComponent(view)}`)).json()) as Record<string, string | undefined>;
    expect(pg).toMatchObject({ title: 'Демо', description: '**Повестка**', myStatus: 'ATTENDEE_STATUS_PENDING', guestUrl, email: 'partner@outside.org' });
    expect(pg.status ?? 'ATTENDEE_STATUS_UNSPECIFIED').toBe('ATTENDEE_STATUS_UNSPECIFIED');
    expect(pg.roomName).toBeTruthy();
    expect(pg.organizerEmail).toBe('owner@calaba.test');
    expect(Date.parse(pg.guestFrom ?? '')).toBe(start - 15 * 60_000);
    expect(Date.parse(pg.guestUntil ?? '')).toBe(start + 2 * HOUR);
    expect((await api('', '/api/event-rsvp', { method: 'POST', body: JSON.stringify({ token: view }) })).status).toBe(400);
    const ans = await api('', '/api/event-rsvp', { method: 'POST', body: JSON.stringify({ token: pg.acceptToken }) });
    expect(((await ans.json()) as { myStatus: string }).myStatus).toBe('ATTENDEE_STATUS_ACCEPTED');

    // The partner joins with the guest link: the active meeting without attendees; the calendar stays closed.
    const code = guestUrl.split('/r/')[1] ?? '';
    const joined = await api('', `/api/room-invites/${code}/join`, { method: 'POST', body: JSON.stringify({ nickname: 'Partner' }) });
    const guest = ((await joined.json()) as { tokens: { accessToken: string } }).tokens.accessToken;
    const card = await api(guest, `/api/events/${ev.id}`);
    expect(card.status).toBe(200);
    const e = ((await card.json()) as { event: Ev & { description?: string } }).event;
    expect(e.attendees).toHaveLength(0);
    expect(e.description).toBe('**Повестка**');
    expect(e.counts?.accepted).toBe(2);
    expect((await api(guest, `/api/workspaces/${IDS.workspaces.main}/events?from=${iso(start)}&to=${iso(start + HOUR)}`)).status).toBe(403);
    expect((await api(guest, `/api/events/${ev.id}/rsvp`, { method: 'PUT', body: JSON.stringify({ status: 'ATTENDEE_STATUS_MAYBE' }) })).status).toBe(403);
    // READY of the guest carries it too.
    const ready = await readyOf(guest);
    const snap = ready.workspaces.find((w) => w.workspace?.id === IDS.workspaces.main);
    expect(snap?.activeEvents.map((x) => [x.id, x.attendees.length])).toEqual([[ev.id, 0]]);
    // Outside the window: 404.
    server.setClock(start + 2 * HOUR);
    expect((await api(guest, `/api/events/${ev.id}`)).status).toBe(404);
    server.setClock(null);
  });
});

async function readyOf(token: string): Promise<Ready> {
  const ws = new WebSocket(`${server.url.replace('http', 'ws')}/gateway?v=1`);
  try {
    return await new Promise<Ready>((resolve, reject) => {
      setTimeout(() => reject(new Error('no READY')), 5000);
      ws.on('open', () => ws.send(toBinary(GatewayFrameSchema, create(GatewayFrameSchema, { op: GatewayOpcode.IDENTIFY, payload: { case: 'identify', value: { token } } }))));
      ws.on('message', (data: Buffer) => {
        const f = fromBinary(GatewayFrameSchema, new Uint8Array(data));
        if (f.payload.case === 'dispatch' && f.payload.value.event.case === 'ready') resolve(f.payload.value.event.value);
      });
      ws.once('error', reject);
    });
  } finally {
    ws.close();
  }
}

describe('meeting comments (ADR-0104)', () => {
  it('whoever sees the meeting comments; the author edits; the author or the organizer deletes', async () => {
    server.reset();
    const anna = await login();
    const vera = await login('vera@calaba.test');
    const boris = await login('boris@calaba.test');
    const start = Date.UTC(2030, 0, 7, 10);
    const res = await api(anna, `/api/workspaces/${IDS.workspaces.main}/events`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Ретро', startsAt: iso(start), endsAt: iso(start + HOUR), tz: 'UTC', attendees: [{ userId: IDS.users.vera, required: true }] }),
    });
    const id = ((await res.json()) as { event: Ev }).event.id;
    const base = `/api/events/${id}/comments`;
    const post = (token: string, body: string): Promise<Response> => api(token, base, { method: 'POST', body: JSON.stringify({ body }) });
    const mine = (await (await post(vera, '  Повестка  ')).json()) as { comment: { id: string; body: string } };
    expect(mine.comment.body).toBe('Повестка');
    expect((await post(boris, 'я тут')).status).toBe(404); // not invited, no room
    expect((await post(vera, '   ')).status).toBe(422);
    await post(anna, 'Ок');
    const list = (await (await api(vera, `${base}?limit=1`)).json()) as { comments: { body: string }[]; hasMore?: boolean };
    expect([list.comments.map((c) => c.body), list.hasMore]).toEqual([['Ок'], true]);
    expect((await api(anna, `${base}/${mine.comment.id}`, { method: 'PATCH', body: JSON.stringify({ body: 'чужое' }) })).status).toBe(403);
    expect((await api(vera, `${base}/${mine.comment.id}`, { method: 'PATCH', body: JSON.stringify({ body: 'Повестка v2' }) })).status).toBe(200);
    expect((await api(anna, `${base}/${mine.comment.id}`, { method: 'DELETE' })).status).toBe(204);
  });
});
