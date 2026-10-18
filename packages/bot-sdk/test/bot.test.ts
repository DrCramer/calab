import { create } from '@bufbuild/protobuf';
import { DispatchEventSchema } from '@calaba/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError, Bot, ContactField, GatewayFatalError, parseRetryAfter, parseWebhookUpdate, signWebhook, verifyWebhookSignature, type BotOptions, type CommandEvent, type Message, type ReactionEvent } from '../src/index.js';
import { BOT_ID, FakeServer, TEXT_ROOM, TOKEN, VOICE_ROOM, WS_ID, messageEvent, waitFor } from './fake-server.js';

let srv: FakeServer;
let bots: Bot[] = [];

const fast: Partial<BotOptions> = {
  gateway: { backoffBaseMs: 5, backoffMaxMs: 20, invalidSessionMinMs: 5, invalidSessionJitterMs: 0, random: () => 0.5 },
  sleep: () => Promise.resolve(),
};

function newBot(token = TOKEN, extra: Partial<BotOptions> = {}): Bot {
  const b = new Bot(token, { server: srv.url, ...fast, ...extra });
  bots.push(b);
  return b;
}

const messageJson = (id: string, content: string, extra: Record<string, unknown> = {}) => ({
  message: { id, roomId: TEXT_ROOM, authorId: BOT_ID, content, ...extra },
});

beforeEach(async () => {
  srv = new FakeServer();
  await srv.start();
});

afterEach(async () => {
  for (const b of bots) b.stop();
  bots = [];
  await srv.close();
});

describe('gateway', () => {
  it('identifies with the bot token and resolves READY', async () => {
    const bot = newBot();
    const ready = await bot.start();
    expect(ready.sessionId).toBe('sess-1');
    expect(bot.me?.id).toBe(BOT_ID);
    const id = srv.framesOf('identify')[0];
    expect(id?.payload.case === 'identify' && id.payload.value.token).toBe(TOKEN);
    expect(bot.voice.participants(VOICE_ROOM).map((v) => v.userId)).toEqual(['u-alice']);
  });

  it('rejects start() on a refused token (4004), without reconnecting', async () => {
    const bot = newBot(TOKEN.replace(/A{43}$/, 'B'.repeat(43)));
    const err = await bot.start().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayFatalError);
    expect((err as GatewayFatalError).kind).toBe('auth-failed');
    await new Promise((r) => setTimeout(r, 50));
    expect(srv.connections).toBe(1);
  });

  it('reconnects with RESUME and replays missed events once', async () => {
    const bot = newBot();
    const got: string[] = [];
    bot.on('message', (m) => void got.push(m.id));
    await bot.start();
    srv.dispatch(messageEvent({ id: 'm1', authorId: 'u-alice', content: 'one' }));
    await waitFor(() => got.length === 1);
    srv.drop(4000, 'try again');
    srv.dispatch(messageEvent({ id: 'm2', authorId: 'u-alice', content: 'two' }), false); // missed while down
    await waitFor(() => got.length === 2);
    const resume = srv.framesOf('resume')[0];
    expect(resume?.payload.case === 'resume' && resume.payload.value.sessionId).toBe('sess-1');
    expect(resume?.payload.case === 'resume' && resume.payload.value.seq).toBe(2n);
    expect(got).toEqual(['m1', 'm2']);
    expect(srv.connections).toBe(2);
  });

  it('identifies again after INVALID_SESSION', async () => {
    const bot = newBot();
    let readies = 0;
    bot.on('ready', () => { readies++; });
    await bot.start();
    srv.refuseResume = true;
    srv.drop(4000);
    await waitFor(() => readies === 2);
    expect(srv.framesOf('identify')).toHaveLength(2);
  });

  it('stops for good when another process takes the token over', async () => {
    const bot = newBot();
    const errors: Error[] = [];
    bot.on('error', (e) => void errors.push(e));
    await bot.start();
    srv.drop(4000, 'replaced by a new session');
    await waitFor(() => errors.length === 1);
    expect((errors[0] as GatewayFatalError).kind).toBe('replaced');
    await new Promise((r) => setTimeout(r, 50));
    expect(srv.connections).toBe(1);
  });
});

describe('events', () => {
  it('routes messages, commands and reactions; skips its own', async () => {
    const bot = newBot();
    const msgs: Message[] = [];
    const cmds: CommandEvent[] = [];
    const reactions: ReactionEvent[] = [];
    bot.on('message', (m) => void msgs.push(m));
    bot.on('command', (c) => void cmds.push(c));
    bot.on('reaction', (r) => void reactions.push(r));
    await bot.start();
    srv.dispatch(messageEvent({ id: 'own', authorId: BOT_ID, content: 'mine' }));
    srv.dispatch(messageEvent({ id: 'c1', authorId: 'u-alice', content: '/echo hi there', command: { botUserId: BOT_ID, name: 'echo', args: 'hi there' } }));
    srv.dispatch(messageEvent({ id: 'm1', authorId: 'u-alice', content: 'hello' }));
    srv.dispatch({ event: { case: 'messageReactionAdd', value: { workspaceId: WS_ID, roomId: TEXT_ROOM, messageId: 'm1', userId: 'u-alice', emoji: '👍' } } });
    srv.dispatch({ event: { case: 'messageReactionRemove', value: { workspaceId: WS_ID, roomId: TEXT_ROOM, messageId: 'm1', userId: BOT_ID, emoji: '👍' } } });
    await waitFor(() => reactions.length === 1 && msgs.length === 1 && cmds.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(msgs.map((m) => m.id)).toEqual(['m1']);
    expect(cmds[0]).toMatchObject({ name: 'echo', args: 'hi there', workspaceId: WS_ID });
    expect(cmds[0]?.message.id).toBe('c1');
    expect(reactions).toEqual([{ type: 'add', workspaceId: WS_ID, roomId: TEXT_ROOM, messageId: 'm1', userId: 'u-alice', emoji: '👍' }]);
  });

  it('reports a throwing listener as an error event', async () => {
    const bot = newBot();
    const errors: Error[] = [];
    bot.on('error', (e) => void errors.push(e));
    bot.on('message', () => Promise.reject(new Error('boom')));
    await bot.start();
    srv.dispatch(messageEvent({ id: 'm1', authorId: 'u-alice', content: 'x' }));
    await waitFor(() => errors.length === 1);
    expect(errors[0]?.message).toBe('boom');
  });
});

describe('rest', () => {
  it('sends text and replies with protojson bodies and the bearer token', async () => {
    srv.route(`POST /api/rooms/${TEXT_ROOM}/messages`, (r) => ({ status: 201, json: messageJson('new', (r.json as { content: string }).content) }));
    const bot = newBot();
    const m = await bot.send(TEXT_ROOM, 'hi');
    expect(m.id).toBe('new');
    await bot.reply({ id: 'orig', roomId: TEXT_ROOM } as Message, 'pong');
    const [a, b] = srv.requests;
    expect(a?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(a?.json).toMatchObject({ content: 'hi' });
    expect((a?.json as { nonce: string }).nonce).toMatch(/^[0-9a-f-]{36}$/);
    expect(b?.json).toMatchObject({ content: 'pong', replyToId: 'orig' });
  });

  it('acts on behalf of the owner per call or through asOwner() (ADR-0106)', async () => {
    srv.route(`POST /api/rooms/${TEXT_ROOM}/messages`, (r) => ({ status: 201, json: messageJson('new', (r.json as { content: string }).content) }));
    srv.route('POST /api/tasks/t1/approval', () => ({ json: { task: { id: 't1' } } }));
    srv.route('GET /api/me', () => ({ json: {} }));
    const bot = newBot();
    await bot.send(TEXT_ROOM, 'as myself');
    const owner = bot.asOwner();
    expect(owner.asOwner()).toBe(owner);
    await owner.send(TEXT_ROOM, 'as the owner');
    expect((await owner.tasks.vote('t1', 'approve')).id).toBe('t1');
    await bot.rest.request('GET', '/api/me', { onBehalfOfOwner: true });
    const [self, mine, vote, raw] = srv.requests;
    expect(self?.headers['calab-on-behalf']).toBeUndefined();
    expect(mine?.headers['calab-on-behalf']).toBe('owner');
    expect(mine?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(vote?.headers['calab-on-behalf']).toBe('owner');
    expect(vote?.json).toMatchObject({ decision: 'TASK_APPROVAL_DECISION_APPROVE' });
    expect(raw?.headers['calab-on-behalf']).toBe('owner');
    expect(() => owner.start()).toThrow(/REST only/);
  });

  it('forwards a message into another room (ADR-0033)', async () => {
    srv.route(`POST /api/rooms/${TEXT_ROOM}/messages/m-1/forward`, { status: 201, json: { message: { id: 'copy', roomId: 'r-2', forward: { authorId: 'u-1', messageId: 'm-1' } } } });
    const bot = newBot();
    const m = await bot.forward(TEXT_ROOM, 'm-1', 'r-2');
    expect(m.id).toBe('copy');
    expect(m.forward?.messageId).toBe('m-1');
    expect(srv.requests[0]?.json).toMatchObject({ toRoomId: 'r-2' });
  });

  it('reads a reply target and the full transcript of its recording card', async () => {
    srv.route(`GET /api/rooms/${TEXT_ROOM}/messages/m-rec`, {
      status: 200,
      json: { id: 'm-rec', roomId: TEXT_ROOM, kind: 'MESSAGE_KIND_SYSTEM', system: { recording: { recordingId: 'rec-1', hasTranscript: true } } },
    });
    srv.route(`GET /api/rooms/${TEXT_ROOM}/recordings/rec-1/transcript`, {
      status: 200,
      json: { recordingId: 'rec-1', language: 'ru', segments: [{ speaker: 0, startMs: 480, endMs: 6900, text: 'Первая реплика.' }] },
    });
    const bot = newBot();
    const card = await bot.message(TEXT_ROOM, 'm-rec');
    const p = card.system?.payload;
    const rid = p?.case === 'recording' ? p.value.recordingId : '';
    expect(rid).toBe('rec-1');
    const tr = await bot.transcript(TEXT_ROOM, rid);
    expect(tr.segments[0]?.text).toBe('Первая реплика.');
    expect(tr.segments[0]?.startMs).toBe(480);
    await expect(bot.message(TEXT_ROOM, 'gone')).rejects.toMatchObject({ status: 404 });
  });

  it('retries 429 after Retry-After with the same nonce', async () => {
    let calls = 0;
    const waits: number[] = [];
    srv.route(`POST /api/rooms/${TEXT_ROOM}/messages`, () =>
      ++calls === 1
        ? { status: 429, headers: { 'Retry-After': '2' }, json: { code: 'ERROR_CODE_RATE_LIMITED', message: 'too many requests' } }
        : { status: 201, json: messageJson('m', 'x') },
    );
    const bot = newBot(TOKEN, { sleep: (ms) => { waits.push(ms); return Promise.resolve(); } });
    await bot.send(TEXT_ROOM, { text: 'x', nonce: 'n-1' });
    expect(calls).toBe(2);
    expect(waits).toEqual([2000]);
    expect(srv.requests.map((r) => (r.json as { nonce: string }).nonce)).toEqual(['n-1', 'n-1']);
  });

  it('throws ApiError with code and reason', async () => {
    srv.route('POST /api/dms', { status: 403, json: { code: 'ERROR_CODE_BOT_BLOCKED', message: 'this person blocked the bot' } });
    srv.route('GET /api/workspaces', { status: 403, json: { code: 'ERROR_CODE_FORBIDDEN', message: 'not available for bots', reason: 'BOT_NOT_ALLOWED' } });
    srv.route(`POST /api/rooms/${TEXT_ROOM}/messages`, { status: 429, headers: { 'Retry-After': '1' }, json: { code: 'ERROR_CODE_RATE_LIMITED', message: 'x' } });
    const bot = newBot(TOKEN, { maxRetries: 0 });
    const e1 = (await bot.dm('u-alice').catch((e: unknown) => e)) as ApiError;
    expect(e1).toBeInstanceOf(ApiError);
    expect([e1.status, e1.code]).toEqual([403, 'BOT_BLOCKED']);
    const e2 = (await bot.workspaces().catch((e: unknown) => e)) as ApiError;
    expect([e2.code, e2.reason]).toEqual(['FORBIDDEN', 'BOT_NOT_ALLOWED']);
    const e3 = (await bot.send(TEXT_ROOM, 'x').catch((e: unknown) => e)) as ApiError;
    expect([e3.status, e3.retryAfterMs]).toEqual([429, 1000]);
  });

  it('uploads files to the room workspace, then attaches them', async () => {
    srv.route(`GET /api/rooms/${TEXT_ROOM}`, { json: { room: { id: TEXT_ROOM, workspaceId: WS_ID, type: 'ROOM_TYPE_TEXT' } } });
    srv.route(`POST /api/workspaces/${WS_ID}/files`, { status: 201, json: { file: { id: 'f-1', name: 'a.txt' } } });
    srv.route(`POST /api/rooms/${TEXT_ROOM}/messages`, { status: 201, json: messageJson('m', '') });
    const bot = newBot();
    await bot.send(TEXT_ROOM, { text: 'see', files: [{ name: 'a.txt', data: new TextEncoder().encode('hello') }, 'f-0'] });
    const up = srv.requests.find((r) => r.path.endsWith('/files'));
    const file = up?.form?.get('file');
    expect(file).toBeInstanceOf(File);
    expect(await (file as File).text()).toBe('hello');
    expect(srv.requests.at(-1)?.json).toMatchObject({ content: 'see', attachmentIds: ['f-1', 'f-0'] });
  });

  it('registers commands, joins and leaves voice, sets the webhook', async () => {
    srv.route('PUT /api/bots/me/commands', (r) => ({ json: r.json }));
    srv.route(`POST /api/rooms/${VOICE_ROOM}/join`, { json: { url: 'wss://lk.example', token: 'lk-jwt', identity: `${BOT_ID}:t`, canSpeak: true } });
    srv.route(`POST /api/rooms/${VOICE_ROOM}/voice/leave`, { status: 204 });
    srv.route('PUT /api/bots/me/webhook', (r) => ({ json: { webhook: { url: (r.json as { url: string }).url, enabled: true } } }));
    const bot = newBot();
    const cmds = await bot.commands([{ name: 'echo', description: 'Repeat the text' }, { name: 'ping' }]);
    expect(cmds.map((c) => c.name)).toEqual(['echo', 'ping']);
    expect(srv.requests[0]?.json).toEqual({ commands: [{ name: 'echo', description: 'Repeat the text' }, { name: 'ping' }] });
    const j = await bot.voice.join(VOICE_ROOM);
    expect([j.url, j.token, j.canSpeak]).toEqual(['wss://lk.example', 'lk-jwt', true]);
    await bot.voice.leave(VOICE_ROOM);
    const wh = await bot.webhook.set('https://bot.example/hook', 's'.repeat(32));
    expect(wh.enabled).toBe(true);
    expect(srv.requests.at(-1)?.json).toEqual({ url: 'https://bot.example/hook', secret: 's'.repeat(32) });
  });

  it('uploads stickers as emoji + file pairs', async () => {
    srv.route(`POST /api/workspaces/${WS_ID}/sticker-packs`, { status: 201, json: { pack: { id: 'p-1', name: 'Cats', shortName: 'cats' } } });
    srv.route('POST /api/sticker-packs/p-1/stickers', { status: 201, json: { pack: { id: 'p-1' }, added: [{ id: 's-1', emoji: '😺' }, { id: 's-2', emoji: '😿' }] } });
    const bot = newBot();
    const pack = await bot.stickers.createPack(WS_ID, { name: 'Cats', shortName: 'cats' });
    expect(pack.id).toBe('p-1');
    const res = await bot.stickers.addStickers('p-1', [
      { emoji: '😺', data: new Uint8Array([1]) },
      { emoji: '😿', data: new Uint8Array([2]) },
    ]);
    expect(res.added.map((s) => s.id)).toEqual(['s-1', 's-2']);
    const form = srv.requests.at(-1)?.form;
    expect(form?.getAll('emoji')).toEqual(['😺', '😿']);
    expect(form?.getAll('file')).toHaveLength(2);
    expect([...(form?.keys() ?? [])]).toEqual(['emoji', 'file', 'emoji', 'file']);
  });

  it('parses Retry-After in seconds and as a date', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe('webhook', () => {
  const secret = 'x'.repeat(24);
  const body = JSON.stringify({
    id: 'd-1',
    botUserId: BOT_ID,
    createdAt: '2026-09-27T10:00:00Z',
    event: { messageCreate: { workspaceId: WS_ID, message: { id: 'c1', roomId: TEXT_ROOM, authorId: 'u-alice', content: '/ping', command: { botUserId: BOT_ID, name: 'ping', args: '' } } } },
  });

  it('verifies the signature, dispatches the event once per delivery id', () => {
    const bot = newBot(TOKEN, { webhookSecret: secret });
    const cmds: CommandEvent[] = [];
    bot.on('command', (c) => void cmds.push(c));
    const sig = signWebhook(secret, body);
    expect(verifyWebhookSignature(secret, body, sig)).toBe(true);
    expect(verifyWebhookSignature(secret, body + ' ', sig)).toBe(false);
    expect(bot.handleWebhook(body, { 'X-Calab-Signature': 'sha256=00' })).toBe(false);
    expect(bot.handleWebhook(body, new Headers({ 'X-Calab-Signature': sig, 'X-Calab-Delivery': 'd-1' }))).toBe(true);
    expect(bot.handleWebhook(body, { 'x-calab-signature': sig })).toBe(true); // a retry of the same delivery
    expect(cmds.map((c) => c.name)).toEqual(['ping']);
  });
});

describe('extended API (ADR-0051)', () => {
  it('calendar: list / create / update / delete / freebusy / suggest', async () => {
    const ev = { event: { id: 'e1', workspaceId: WS_ID, title: 'Sync', organizerId: BOT_ID } };
    srv.route(`GET /api/workspaces/${WS_ID}/events`, { json: { events: [ev.event] } });
    srv.route(`POST /api/workspaces/${WS_ID}/events`, { status: 201, json: ev });
    srv.route('GET /api/events/e1', { json: ev });
    srv.route('PATCH /api/events/e1', { json: { event: { ...ev.event, title: 'Moved' } } });
    srv.route('DELETE /api/events/e1', { status: 204 });
    srv.route(`GET /api/workspaces/${WS_ID}/freebusy`, { json: { users: [{ userId: 'u-1', timezone: 'UTC', busy: [] }] } });
    srv.route(`POST /api/workspaces/${WS_ID}/freebusy/suggest`, { json: { slots: [{ startsAt: '2026-10-01T10:00:00Z', endsAt: '2026-10-01T10:30:00Z' }] } });
    const bot = newBot();
    const from = new Date('2026-10-01T00:00:00Z');
    const to = new Date('2026-10-02T00:00:00Z');
    expect((await bot.calendar.list(WS_ID, from, to)).map((e) => e.id)).toEqual(['e1']);
    expect(srv.requests.at(-1)?.query.get('from')).toBe(from.toISOString());
    const created = await bot.calendar.create(WS_ID, { title: 'Sync', attendees: [{ userId: 'u-1', required: true }] });
    expect(created.organizerId).toBe(BOT_ID);
    expect(srv.requests.at(-1)?.json).toEqual({ title: 'Sync', attendees: [{ userId: 'u-1', required: true }] });
    expect((await bot.calendar.get('e1')).title).toBe('Sync');
    expect((await bot.calendar.update('e1', { title: 'Moved' })).title).toBe('Moved');
    await bot.calendar.delete('e1', from);
    expect(srv.requests.at(-1)?.query.get('occurrence')).toBe(from.toISOString());
    const fb = await bot.calendar.freebusy(WS_ID, ['u-1', 'u-2'], from, to);
    expect(fb[0]?.userId).toBe('u-1');
    expect(srv.requests.at(-1)?.query.get('users')).toBe('u-1,u-2');
    const slots = await bot.calendar.suggest(WS_ID, { users: ['u-1'], durationMin: 30 });
    expect(slots).toHaveLength(1);
    expect(srv.requests.at(-1)?.json).toEqual({ users: ['u-1'], durationMin: 30 });
  });

  it('members: the list stays callable; get and setNickname', async () => {
    srv.route(`GET /api/rooms/${TEXT_ROOM}`, { json: { room: { id: TEXT_ROOM, workspaceId: WS_ID } } });
    srv.route(`GET /api/workspaces/${WS_ID}/members`, { json: { members: [{ user: { id: 'u-1' } }] } });
    srv.route(`GET /api/workspaces/${WS_ID}/members/u-1`, { json: { member: { user: { id: 'u-1' } }, openTasks: [{ id: 't-1' }] } });
    srv.route(`PATCH /api/workspaces/${WS_ID}/members/u-1`, { json: { member: { user: { id: 'u-1' }, nickname: 'Bob' } } });
    const bot = newBot();
    expect((await bot.members(TEXT_ROOM)).map((m) => m.user?.id)).toEqual(['u-1']);
    const p = await bot.members.get(WS_ID, 'u-1');
    expect(p.openTasks.map((t) => t.id)).toEqual(['t-1']);
    expect((await bot.members.setNickname(WS_ID, 'u-1', 'Bob')).nickname).toBe('Bob');
    expect(srv.requests.at(-1)?.json).toEqual({ nickname: 'Bob' });
  });

  it('invites, badges and recording', async () => {
    srv.route(`POST /api/workspaces/${WS_ID}/invites`, { status: 201, json: { invite: { id: 'i-1', code: 'abc' } } });
    srv.route(`GET /api/workspaces/${WS_ID}/invites`, { json: { invites: [{ id: 'i-1' }] } });
    srv.route(`DELETE /api/workspaces/${WS_ID}/invites/i-1`, { status: 204 });
    srv.route(`POST /api/workspaces/${WS_ID}/invites/email`, { status: 201, json: { invite: { id: 'ei-1', email: 'x@outside.org' } } });
    srv.route(`GET /api/workspaces/${WS_ID}/invites/email`, { json: { invites: [] } });
    srv.route(`DELETE /api/workspaces/${WS_ID}/invites/email/ei-1`, { status: 204 });
    srv.route(`POST /api/workspaces/${WS_ID}/files`, { status: 201, json: { file: { id: 'f-1' } } });
    srv.route(`POST /api/workspaces/${WS_ID}/badges`, { status: 201, json: { badge: { id: 'b-1', name: 'Partner', fileId: 'f-1' } } });
    srv.route(`PATCH /api/workspaces/${WS_ID}/badges/b-1`, { json: { badge: { id: 'b-1', name: 'Partner+' } } });
    srv.route(`PUT /api/workspaces/${WS_ID}/members/u-1/badge`, { json: { member: { user: { id: 'u-1' }, badgeId: 'b-1' } } });
    srv.route(`DELETE /api/workspaces/${WS_ID}/badges/b-1`, { status: 204 });
    srv.route(`POST /api/rooms/${VOICE_ROOM}/recording/start`, { json: { recording: { recordingId: 'r-1', byUserId: BOT_ID } } });
    srv.route(`POST /api/rooms/${VOICE_ROOM}/recording/stop`, { json: { recording: { recordingId: 'r-1' } } });
    const bot = newBot();
    expect((await bot.invites.create(WS_ID, { maxUses: 1 })).code).toBe('abc');
    expect(srv.requests.at(-1)?.json).toEqual({ maxUses: 1 });
    expect(await bot.invites.list(WS_ID)).toHaveLength(1);
    await bot.invites.delete(WS_ID, 'i-1');
    expect((await bot.invites.email(WS_ID, 'x@outside.org')).id).toBe('ei-1');
    expect(await bot.invites.listEmail(WS_ID)).toEqual([]);
    await bot.invites.deleteEmail(WS_ID, 'ei-1');
    const badge = await bot.badges.create(WS_ID, 'Partner', { name: 'p.png', data: new Uint8Array([1, 2, 3]), type: 'image/png' });
    expect(badge.fileId).toBe('f-1');
    expect(srv.requests.at(-1)?.json).toEqual({ name: 'Partner', fileId: 'f-1' });
    expect((await bot.badges.update(WS_ID, 'b-1', { name: 'Partner+' })).name).toBe('Partner+');
    expect((await bot.badges.set(WS_ID, 'u-1', 'b-1')).badgeId).toBe('b-1');
    await bot.badges.delete(WS_ID, 'b-1');
    expect((await bot.recording.start(VOICE_ROOM)).byUserId).toBe(BOT_ID);
    expect((await bot.recording.stop(VOICE_ROOM)).recordingId).toBe('r-1');
    expect(srv.requests.map((r) => `${r.method} ${r.path}`)).toContain(`DELETE /api/workspaces/${WS_ID}/badges/b-1`);
  });
});

describe('inline callbacks', () => {
  it('sends and replaces or removes keyboards without erasing omitted text', async () => {
    const keyboard = { rows: [{ buttons: [{ id: 'approve', label: 'Approve', data: 'draft:1' }] }], allowedUserIds: ['actor'] };
    srv.route(`POST /api/rooms/${TEXT_ROOM}/messages`, { json: messageJson('m', 'draft', { inlineKeyboard: keyboard, keyboardRevision: '1' }) });
    srv.route('PATCH /api/messages/m', { json: messageJson('m', 'draft') });
    const bot = newBot();
    const m = await bot.send(TEXT_ROOM, { text: 'draft', inlineKeyboard: keyboard });
    expect(m.inlineKeyboard?.rows[0]?.buttons[0]?.id).toBe('approve');
    expect(srv.requests.at(-1)?.json).toMatchObject({ inlineKeyboard: keyboard });
    await bot.edit('m', { inlineKeyboard: { rows: [] } });
    expect(srv.requests.at(-1)?.json).toEqual({ inlineKeyboard: {}, preserveContent: true });
    await bot.edit('m', '');
    expect(srv.requests.at(-1)?.json).toEqual({});
  });

  it('exposes the same typed callback through gateway and signed webhook', async () => {
    const secret = 'callback-secret-for-testing';
    const bot = newBot(TOKEN, { webhookSecret: secret });
    const got: string[] = [];
    bot.on('callback', (c) => { got.push(`${c.id}:${c.userId}:${c.data}:${c.keyboardRevision}`); });
    await bot.start();
    const callback = { id: 'interaction-1', botUserId: BOT_ID, userId: 'actor', roomId: TEXT_ROOM, messageId: 'm', buttonId: 'approve', data: 'draft:1', keyboardRevision: 1n };
    srv.dispatch(create(DispatchEventSchema, { event: { case: 'botCallback', value: callback } }));
    await waitFor(() => got.length === 1);
    const body = JSON.stringify({ id: 'delivery-1', botUserId: BOT_ID, event: { botCallback: { ...callback, keyboardRevision: '1' } } });
    expect(bot.handleWebhook(body, { 'X-Calab-Signature': signWebhook(secret, body) })).toBe(true);
    expect(bot.handleWebhook(body, { 'X-Calab-Signature': signWebhook(secret, body) })).toBe(true);
    // Cross-transport durable effect dedup belongs to the bot, not the SDK's bounded delivery cache.
    expect(got).toEqual(['interaction-1:actor:draft:1:1', 'interaction-1:actor:draft:1:1']);
  });
});

describe('contact requests (ADR-0100)', () => {
  it('sends requestContact buttons through the buttons shorthand', async () => {
    srv.route(`POST /api/rooms/${TEXT_ROOM}/messages`, { json: messageJson('m', 'contact') });
    srv.route('PATCH /api/messages/m', { json: messageJson('m', 'contact') });
    const bot = newBot();
    await bot.send(TEXT_ROOM, {
      text: 'Leave your contact',
      buttons: [[{ kind: 'requestContact', text: 'Share contact', fields: ['phone', 'email'], reason: 'To call you back' }, { id: 'later', text: 'Later', data: 'x' }]],
    });
    expect(srv.requests.at(-1)?.json).toMatchObject({
      inlineKeyboard: {
        rows: [{ buttons: [
          { id: 'contact', label: 'Share contact', kind: 'INLINE_BUTTON_KIND_REQUEST_CONTACT', fields: ['CONTACT_FIELD_PHONE', 'CONTACT_FIELD_EMAIL'], reason: 'To call you back' },
          { id: 'later', label: 'Later', data: 'x' },
        ] }],
      },
    });
    const sent = srv.requests.at(-1)?.json as { inlineKeyboard: { rows: { buttons: Record<string, unknown>[] }[] } };
    expect(sent.inlineKeyboard.rows[0]?.buttons[1]?.kind).toBeUndefined();
    await bot.edit('m', { buttons: [] });
    expect(srv.requests.at(-1)?.json).toEqual({ inlineKeyboard: {}, preserveContent: true });
  });

  it('emits contactShared from the gateway and a signed webhook', async () => {
    const secret = 'contact-secret-for-testing';
    const bot = newBot(TOKEN, { webhookSecret: secret });
    const got: string[] = [];
    bot.on('contactShared', (c) => { got.push(`${c.id}:${c.userId}:${c.phone}:${c.phoneVerified}:${c.email}:${c.emailVerified}:${c.fields.join(',')}`); });
    await bot.start();
    const contact = { id: 'share-1', botUserId: BOT_ID, userId: 'person', displayName: 'Olga', phone: '+79990001122', email: 'olga@example.test', emailVerified: true, roomId: TEXT_ROOM, messageId: 'm', buttonId: 'contact', fields: [ContactField.PHONE, ContactField.EMAIL] };
    srv.dispatch(create(DispatchEventSchema, { event: { case: 'contactShared', value: contact } }));
    await waitFor(() => got.length === 1);
    // Another bot's contact is never emitted.
    srv.dispatch(create(DispatchEventSchema, { event: { case: 'contactShared', value: { ...contact, id: 'share-x', botUserId: 'other-bot' } } }));
    const body = JSON.stringify({ id: 'share-1', botUserId: BOT_ID, event: { contactShared: { ...contact, fields: ['CONTACT_FIELD_PHONE', 'CONTACT_FIELD_EMAIL'] } } });
    expect(bot.handleWebhook(body, { 'X-Calab-Signature': signWebhook(secret, body) })).toBe(true);
    await waitFor(() => got.length === 2);
    expect(parseWebhookUpdate(body).event?.event.case).toBe('contactShared');
    expect(got).toEqual(['share-1:person:+79990001122:false:olga@example.test:true:1,2', 'share-1:person:+79990001122:false:olga@example.test:true:1,2']);
  });
});
