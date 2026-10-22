import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  CallOutcome,
  CallState,
  GatewayFrameSchema,
  GatewayOpcode,
  MessageKind,
  NotificationLevel,
  Plan,
  PlanLimitsSchema,
  RecordingStatus,
  RoomRecordingState,
  RoomType,
  ScreenSharePreset,
  VoiceDisconnectReason,
  VoiceStreamStopReason,
  type DispatchEvent,
  type GatewayFrame,
} from '@calaba/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { GENERAL_MESSAGE_COUNT, IDS, MARKETING_IDS, MOCK_EMAIL_CODE, MOCK_GPTUNNEL_CODE, MOCK_GPTUNNEL_WEB, parseMentions, startMockServer, type MockServer } from './mock-server';

// Smoke test: pnpm -F @calaba/desktop exec vitest run --config e2e-support/vitest.config.ts

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
  expect(res.status).toBe(200);
  const body = (await res.json()) as { tokens: { accessToken: string } };
  return body.tokens.accessToken;
}

/** Opens the gateway and collects frames; `next(pred)` waits for a matching frame. */
function openGateway(): Promise<{ ws: WebSocket; next(pred: (f: GatewayFrame) => boolean): Promise<GatewayFrame>; send(f: Parameters<typeof create<typeof GatewayFrameSchema>>[1]): void }> {
  const ws = new WebSocket(`${server.url.replace('http', 'ws')}/gateway?v=1`);
  const frames: GatewayFrame[] = [];
  const waiters: { pred: (f: GatewayFrame) => boolean; resolve: (f: GatewayFrame) => void }[] = [];
  ws.on('message', (data: Buffer) => {
    const f = fromBinary(GatewayFrameSchema, new Uint8Array(data));
    const w = waiters.findIndex((x) => x.pred(f));
    if (w >= 0) waiters.splice(w, 1)[0]?.resolve(f);
    else frames.push(f);
  });
  const next = (pred: (f: GatewayFrame) => boolean): Promise<GatewayFrame> => {
    const i = frames.findIndex(pred);
    if (i >= 0) return Promise.resolve(frames.splice(i, 1)[0] as GatewayFrame);
    return new Promise((resolve, reject) => {
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error('timeout waiting for frame')), 5000);
    });
  };
  const send = (init: Parameters<typeof create<typeof GatewayFrameSchema>>[1]): void => {
    ws.send(toBinary(GatewayFrameSchema, create(GatewayFrameSchema, init)));
  };
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, next, send }));
    ws.once('error', reject);
  });
}

const dispatchOf = (f: GatewayFrame): DispatchEvent | undefined => (f.payload.case === 'dispatch' ? f.payload.value : undefined);

describe('mock server', () => {
  it('serves REST with protojson and deterministic fixtures', async () => {
    const token = await login();
    const auth = { Authorization: `Bearer ${token}` };

    const me = (await (await fetch(`${server.url}/api/me`, { headers: auth })).json()) as { me: { user: { displayName: string } } };
    expect(me.me.user.displayName).toBe('Анна Смирнова');

    const page = (await (
      await fetch(`${server.url}/api/rooms/${IDS.rooms.general}/messages?limit=100`, { headers: auth })
    ).json()) as { messages: { id: string }[]; hasMore: boolean };
    expect(page.messages).toHaveLength(GENERAL_MESSAGE_COUNT);
    expect(page.hasMore).toBe(false);
    const ids = page.messages.map((m) => m.id);
    expect([...ids].sort().reverse()).toEqual(ids); // newest first

    const thumb = await fetch(`${server.url}/api/files/${IDS.files.image}/thumbnail`, { headers: auth });
    expect(thumb.headers.get('content-type')).toBe('image/png');

    expect((await fetch(`${server.url}/api/me`)).status).toBe(401);
    const bad = await fetch(`${server.url}/api/auth/login`, {
      method: 'POST',
      body: JSON.stringify({ email: 'owner@calaba.test', password: 'nope' }),
    });
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as { code: string }).code).toBe('ERROR_CODE_INVALID_CREDENTIALS');
  });

  it('web login sets the refresh cookie and refreshes from it', async () => {
    const res = await fetch(`${server.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client': 'web' },
      body: JSON.stringify({ email: 'owner@calaba.test', password: 'password123' }),
    });
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^calaba_refresh=[^;]+; Path=\/api\/auth; HttpOnly; SameSite=Strict/);
    expect(((await res.json()) as { tokens: { refreshToken: string } }).tokens.refreshToken).toBe('');
    const refreshed = await fetch(`${server.url}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'X-Client': 'web', Cookie: cookie.split(';')[0] ?? '' },
    });
    expect(refreshed.status).toBe(200);
  });

  it('gateway: HELLO → IDENTIFY → READY with snapshots and unread state; live MESSAGE_CREATE', async () => {
    const token = await login();
    const gw = await openGateway();
    const hello = await gw.next((f) => f.op === GatewayOpcode.HELLO);
    expect(hello.payload.case === 'hello' && hello.payload.value.heartbeatIntervalMs).toBe(41_000);

    gw.send({ op: GatewayOpcode.IDENTIFY, payload: { case: 'identify', value: { token, device: { name: 'vitest', platform: 'test', appVersion: '0' } } } });
    const readyFrame = await gw.next((f) => f.op === GatewayOpcode.DISPATCH);
    expect(readyFrame.seq).toBe(1n);
    const ev = dispatchOf(readyFrame)?.event;
    if (ev?.case !== 'ready') throw new Error(`expected READY, got ${ev?.case}`);
    const ready = ev.value;

    expect(ready.me?.user?.id).toBe(IDS.users.anna);
    expect(ready.me?.settings?.noiseSuppression).toBe(false);
    expect(ready.workspaces.map((w) => w.workspace?.name)).toEqual(['Команда Calab', 'Дизайн']);
    const main = ready.workspaces[0];
    expect(main?.rooms.map((r) => r.name)).toEqual([
      'общий',
      'разработка',
      'очень-длинное-название-комнаты-для-проверки-обрезки',
      'Созвон',
      'Переговорка',
    ]);
    expect(main?.rooms.filter((r) => r.type === RoomType.VOICE)).toHaveLength(2);
    expect(main?.members).toHaveLength(5);
    expect(main?.voiceStates.map((v) => v.userId).sort()).toEqual([IDS.users.boris, IDS.users.vera]);
    expect(main?.permissions[IDS.rooms.general]).toBeGreaterThan(0n);

    // Unread: `общий` and `разработка` have messages after the read marker.
    const general = main?.rooms.find((r) => r.id === IDS.rooms.general);
    const read = new Map(ready.readStates.map((r) => [r.roomId, r.lastReadMessageId]));
    expect(general?.lastMessageId && general.lastMessageId > (read.get(IDS.rooms.general) ?? '')).toBe(true);
    const dev = main?.rooms.find((r) => r.id === IDS.rooms.dev);
    expect(dev?.lastMessageId && dev.lastMessageId > (read.get(IDS.rooms.dev) ?? '')).toBe(true);
    const call = main?.rooms.find((r) => r.id === IDS.rooms.call);
    expect(call?.lastMessageId).toBe(read.get(IDS.rooms.call));
    // Counters as the server sends them in READY read_states.
    const counts = new Map(ready.readStates.map((r) => [r.roomId, r.unreadCount]));
    expect(counts.get(IDS.rooms.general)).toBeGreaterThan(0);
    expect(counts.get(IDS.rooms.dev)).toBeGreaterThan(0);
    expect(counts.get(IDS.rooms.call)).toBe(0);

    // Heartbeat.
    gw.send({ op: GatewayOpcode.HEARTBEAT, payload: { case: 'heartbeat', value: { lastSeq: 1n } } });
    await gw.next((f) => f.op === GatewayOpcode.HEARTBEAT_ACK);

    // Injected mention → MESSAGE_CREATE with seq 2.
    server.injectMessage({ roomId: IDS.rooms.dev, authorId: IDS.users.boris, content: `@${IDS.users.anna} созвон через 5 минут` });
    const created = await gw.next((f) => f.op === GatewayOpcode.DISPATCH);
    expect(created.seq).toBe(2n);
    const ce = dispatchOf(created)?.event;
    expect(ce?.case).toBe('messageCreate');

    // Own message via REST echoes the nonce.
    const res = await fetch(`${server.url}/api/rooms/${IDS.rooms.general}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'привет', nonce: 'n-1' }),
    });
    expect(res.status).toBe(201);
    const echoed = await gw.next((f) => dispatchOf(f)?.event.case === 'messageCreate');
    const m = dispatchOf(echoed)?.event;
    expect(m?.case === 'messageCreate' && m.value.message?.nonce).toBe('n-1');

    gw.ws.close(1000);
  });

  it('read receipts (docs/09 #92): READY peer reads; another member reads → READ_RECEIPT', async () => {
    const token = await login();
    const gw = await openGateway();
    await gw.next((f) => f.op === GatewayOpcode.HELLO);
    gw.send({ op: GatewayOpcode.IDENTIFY, payload: { case: 'identify', value: { token, device: { name: 'vitest', platform: 'test', appVersion: '0' } } } });
    const ev = dispatchOf(await gw.next((f) => f.op === GatewayOpcode.DISPATCH))?.event;
    if (ev?.case !== 'ready') throw new Error(`expected READY, got ${ev?.case}`);
    // The fixture's other members read every room; DMs carry the peer's marker.
    expect(ev.value.peerReads.find((p) => p.roomId === IDS.rooms.general)?.lastReadMessageId).not.toBe('');
    expect(ev.value.peerReads.some((p) => p.roomId === IDS.dms.vera)).toBe(false);
    expect(ev.value.dms.find((d) => d.room?.id === IDS.dms.vera)?.peerReadMessageId).not.toBe('');

    const m = server.injectMessage({ roomId: IDS.dms.vera, authorId: IDS.users.anna, content: 'прочитаешь?' });
    expect(server.markRead(IDS.users.vera, IDS.dms.vera, m.id)).toBe(true);
    const rr = dispatchOf(await gw.next((f) => dispatchOf(f)?.event.case === 'readReceipt'))?.event;
    expect(rr?.case === 'readReceipt' && rr.value).toMatchObject({ roomId: IDS.dms.vera, lastReadMessageId: m.id });
    expect(server.markRead(IDS.users.vera, IDS.dms.vera, m.id)).toBe(false); // did not move
    gw.ws.close(1000);
  });

  it('empty scenario: READY without workspaces', async () => {
    const empty = await startMockServer({ scenario: 'empty' });
    try {
      const res = await fetch(`${empty.url}/api/auth/login`, {
        method: 'POST',
        body: JSON.stringify({ email: 'owner@calaba.test', password: 'password123' }),
      });
      const token = ((await res.json()) as { tokens: { accessToken: string } }).tokens.accessToken;
      const ws = new WebSocket(`${empty.url.replace('http', 'ws')}/gateway?v=1`);
      const ready = await new Promise<DispatchEvent>((resolve, reject) => {
        ws.on('message', (data: Buffer) => {
          const f = fromBinary(GatewayFrameSchema, new Uint8Array(data));
          if (f.op === GatewayOpcode.HELLO) {
            ws.send(toBinary(GatewayFrameSchema, create(GatewayFrameSchema, { op: GatewayOpcode.IDENTIFY, payload: { case: 'identify', value: { token } } })));
          } else if (f.payload.case === 'dispatch') resolve(f.payload.value);
        });
        ws.once('error', reject);
      });
      expect(ready.event.case === 'ready' && ready.event.value.workspaces).toEqual([]);
      ws.close(1000);
    } finally {
      await empty.close();
    }
  });
});

describe('mentions and room notifications (docs/05)', () => {
  it('parses mentions like the server', () => {
    const a = IDS.users.anna;
    expect(parseMentions(`@${a.toUpperCase()} mail@${IDS.users.boris} \`@${IDS.users.vera}\` @here`)).toEqual({ users: [a], everyone: true });
    expect(parseMentions('```\n@everyone\n``` @everyones')).toEqual({ users: [], everyone: false });
  });

  it('lists my mentions newest first, with the before cursor', async () => {
    const auth = { Authorization: `Bearer ${await login()}` };
    const page = (await (await fetch(`${server.url}/api/me/mentions?limit=2`, { headers: auth })).json()) as {
      messages: { id: string; content: string }[];
      hasMore: boolean;
    };
    expect(page.messages).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.messages[0]?.id && page.messages[1]?.id && page.messages[0].id > page.messages[1].id).toBe(true);
    const rest = (await (
      await fetch(`${server.url}/api/me/mentions?before=${page.messages[1]?.id ?? ''}`, { headers: auth })
    ).json()) as { messages: { id: string }[]; hasMore: boolean };
    expect(rest.hasMore).toBe(false);
    expect(rest.messages.every((m) => m.id < (page.messages[1]?.id ?? ''))).toBe(true);
    expect((await fetch(`${server.url}/api/me/mentions?after=x`, { headers: auth })).status).toBe(422);
  });

  it('stores notification settings, echoes ROOM_NOTIFICATION_UPDATE, READY carries them', async () => {
    const token = await login();
    const gw = await openGateway();
    await gw.next((f) => f.op === GatewayOpcode.HELLO);
    gw.send({ op: GatewayOpcode.IDENTIFY, payload: { case: 'identify', value: { token } } });
    const ready = dispatchOf(await gw.next((f) => dispatchOf(f)?.event.case === 'ready'))?.event;
    const stored = ready?.case === 'ready' ? ready.value.notificationSettings : [];
    expect(stored.map((n) => [n.roomId, n.level])).toEqual([[IDS.rooms.longPrivate, NotificationLevel.MENTIONS]]);

    const put = await fetch(`${server.url}/api/rooms/${IDS.rooms.general}/notifications`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'NOTIFICATION_LEVEL_NONE' }),
    });
    expect(put.status).toBe(200);
    const ev = dispatchOf(await gw.next((f) => dispatchOf(f)?.event.case === 'roomNotificationUpdate'))?.event;
    expect(ev?.case === 'roomNotificationUpdate' && ev.value.settings?.level).toBe(NotificationLevel.NONE);
    gw.ws.close(1000);
    server.reset('data');
  });

  it('workspace level (docs/09 item 22): stored, echoed as WORKSPACE_NOTIFICATION_UPDATE, in READY; INHERIT refused', async () => {
    const token = await login();
    const gw = await openGateway();
    await gw.next((f) => f.op === GatewayOpcode.HELLO);
    gw.send({ op: GatewayOpcode.IDENTIFY, payload: { case: 'identify', value: { token } } });
    const ready = dispatchOf(await gw.next((f) => dispatchOf(f)?.event.case === 'ready'))?.event;
    expect(ready?.case === 'ready' && ready.value.workspaceNotificationSettings).toEqual([]);
    const put = (level: string) =>
      fetch(`${server.url}/api/workspaces/${IDS.workspaces.main}/notifications`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ level }),
      });
    expect((await put('NOTIFICATION_LEVEL_INHERIT')).status).toBe(422);
    expect((await put('NOTIFICATION_LEVEL_ALL')).status).toBe(200);
    const ev = dispatchOf(await gw.next((f) => dispatchOf(f)?.event.case === 'workspaceNotificationUpdate'))?.event;
    expect(ev?.case === 'workspaceNotificationUpdate' && ev.value.settings?.level).toBe(NotificationLevel.ALL);
    gw.ws.close(1000);
    const gw2 = await openGateway();
    await gw2.next((f) => f.op === GatewayOpcode.HELLO);
    gw2.send({ op: GatewayOpcode.IDENTIFY, payload: { case: 'identify', value: { token } } });
    const again = dispatchOf(await gw2.next((f) => dispatchOf(f)?.event.case === 'ready'))?.event;
    expect(again?.case === 'ready' && again.value.workspaceNotificationSettings.map((n) => n.level)).toEqual([NotificationLevel.ALL]);
    gw2.ws.close(1000);
    server.reset('data');
  });

  it('ROOM_UPDATE carries voice_started_at when a call starts and ends', async () => {
    const token = await login();
    const gw = await openGateway();
    await gw.next((f) => f.op === GatewayOpcode.HELLO);
    gw.send({ op: GatewayOpcode.IDENTIFY, payload: { case: 'identify', value: { token } } });
    await gw.next((f) => dispatchOf(f)?.event.case === 'ready');
    const roomUpdate = (): Promise<GatewayFrame> => gw.next((f) => dispatchOf(f)?.event.case === 'roomUpdate');
    server.setVoiceState({ userId: IDS.users.grigory, roomId: IDS.rooms.call });
    const started = dispatchOf(await roomUpdate())?.event;
    expect(started?.case === 'roomUpdate' && started.value.room?.voiceStartedAt).toBeTruthy();
    server.setVoiceState({ userId: IDS.users.grigory, roomId: '' });
    const ended = dispatchOf(await roomUpdate())?.event;
    expect(ended?.case === 'roomUpdate' && ended.value.room?.id).toBe(IDS.rooms.call);
    expect(ended?.case === 'roomUpdate' && ended.value.room?.voiceStartedAt).toBeUndefined();
    gw.ws.close(1000);
    server.reset('data');
  });

  it('cameras: /camera/request marks VoiceState.camera (409 over camera_limit), a moderator stops one', async () => {
    const token = await login();
    const post = (path: string): Promise<Response> => fetch(`${server.url}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    const me = IDS.users.anna;
    server.setVoiceState({ userId: me, roomId: IDS.rooms.meeting });
    // 200 {preset, fps} since ADR-0024; the main workspace is Team (no camera cap).
    expect((await post(`/api/rooms/${IDS.rooms.meeting}/camera/request`)).status).toBe(200);
    expect(server.state.voiceStates.get(me)?.camera).toBe(true);
    expect((await post(`/api/rooms/${IDS.rooms.meeting}/camera/stop`)).status).toBe(204);
    expect(server.state.voiceStates.get(me)?.camera).toBe(false);
    // Борис turns his camera on; the owner (MUTE_MEMBERS) turns it off, twice = 404.
    server.setVoiceState({ userId: IDS.users.boris, roomId: IDS.rooms.meeting, muted: true, camera: true });
    expect((await post(`/api/rooms/${IDS.rooms.meeting}/voice/${IDS.users.boris}/stop-camera`)).status).toBe(204);
    expect(server.state.voiceStates.get(IDS.users.boris)?.camera).toBe(false);
    expect((await post(`/api/rooms/${IDS.rooms.meeting}/voice/${IDS.users.boris}/stop-camera`)).status).toBe(404);
    // Over the limit on track_published: camera off + VOICE_CAMERA_STOP{LIMIT_REACHED} to the room.
    const gw = await openGateway();
    await gw.next((f) => f.op === GatewayOpcode.HELLO);
    gw.send({ op: GatewayOpcode.IDENTIFY, payload: { case: 'identify', value: { token } } });
    await gw.next((f) => dispatchOf(f)?.event.case === 'ready');
    server.setVoiceState({ userId: IDS.users.vera, roomId: IDS.rooms.meeting, camera: true });
    server.stopCamera(IDS.users.vera, VoiceStreamStopReason.LIMIT_REACHED);
    const stop = dispatchOf(await gw.next((f) => dispatchOf(f)?.event.case === 'voiceCameraStop'))?.event;
    expect(stop?.case === 'voiceCameraStop' && stop.value.reason).toBe(VoiceStreamStopReason.LIMIT_REACHED);
    expect(server.state.voiceStates.get(IDS.users.vera)?.camera).toBe(false);
    gw.ws.close(1000);
    // camera_limit 0 = cameras off → 409.
    const room = server.state.rooms.get(IDS.rooms.meeting);
    if (room?.media) room.media.cameraLimit = 0;
    expect((await post(`/api/rooms/${IDS.rooms.meeting}/camera/request`)).status).toBe(409);
    server.reset('data');
  });

  it('voice status: a participant or MANAGE_ROOM sets it (≤ 60), ROOM_UPDATE fans out, cleared when the call empties', async () => {
    const put = async (email: string, status: string): Promise<Response> =>
      fetch(`${server.url}/api/rooms/${IDS.rooms.call}/voice-status`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${await login(email)}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
    const token = await login();
    const gw = await openGateway();
    await gw.next((f) => f.op === GatewayOpcode.HELLO);
    gw.send({ op: GatewayOpcode.IDENTIFY, payload: { case: 'identify', value: { token } } });
    await gw.next((f) => dispatchOf(f)?.event.case === 'ready');
    const roomUpdate = (): Promise<GatewayFrame> => gw.next((f) => dispatchOf(f)?.event.case === 'roomUpdate');

    // A member outside the call cannot; inside it can.
    expect((await put('grigory@calaba.test', 'Планёрка')).status).toBe(403);
    server.setVoiceState({ userId: IDS.users.grigory, roomId: IDS.rooms.call });
    await roomUpdate(); // call started
    expect((await put('grigory@calaba.test', 'x'.repeat(61))).status).toBe(422);
    const ok = await put('grigory@calaba.test', '  Планёрка  ');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ room: { voiceStatus: 'Планёрка' } });
    const set = dispatchOf(await roomUpdate())?.event;
    expect(set?.case === 'roomUpdate' && set.value.room?.voiceStatus).toBe('Планёрка');

    server.setVoiceState({ userId: IDS.users.grigory, roomId: '' });
    const ended = dispatchOf(await roomUpdate())?.event;
    expect(ended?.case === 'roomUpdate' && ended.value.room?.voiceStatus).toBe('');
    // MANAGE_ROOM (the owner) may set it without being in the call.
    expect((await put('owner@calaba.test', 'Скоро начнём')).status).toBe(200);
    gw.ws.close(1000);
    server.reset('data');
  });
});

describe('optimistic voice join (docs/05)', () => {
  it('/join answers pending and announces the pending state, the simulated connect clears it; a repeated /join is idempotent', async () => {
    const owner = await login();
    const grigory = await login('grigory@calaba.test');
    const gw = await openGateway();
    await gw.next((f) => f.op === GatewayOpcode.HELLO);
    gw.send({ op: GatewayOpcode.IDENTIFY, payload: { case: 'identify', value: { token: owner } } });
    await gw.next((f) => dispatchOf(f)?.event.case === 'ready');
    const stateOf = (pending: boolean) => (f: GatewayFrame): boolean => {
      const e = dispatchOf(f)?.event;
      return e?.case === 'voiceStateUpdate' && e.value.state?.userId === IDS.users.grigory && e.value.state.roomId === IDS.rooms.call && e.value.state.pending === pending;
    };
    const join = async (): Promise<{ pending?: boolean }> => {
      const r = await fetch(`${server.url}/api/rooms/${IDS.rooms.call}/join`, { method: 'POST', headers: { Authorization: `Bearer ${grigory}` } });
      expect(r.status).toBe(200);
      return (await r.json()) as { pending?: boolean };
    };
    const pendingSeen = gw.next(stateOf(true));
    expect((await join()).pending).toBe(true);
    await pendingSeen;
    await gw.next(stateOf(false)); // «participant_joined»
    expect((await join()).pending ?? false).toBe(false);
    gw.ws.close(1000);
    server.reset('data');
  });
});

describe('one device in voice (docs/05 «Несколько устройств»)', () => {
  it('a /join from a second session sends VOICE_DISCONNECTED{OTHER_DEVICE} for the first one', async () => {
    // Anna has a desktop and a web session in the fixtures.
    const loginAs = async (web: boolean): Promise<{ accessToken: string; sessionId: string }> => {
      const res = await fetch(`${server.url}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(web ? { 'X-Client': 'web' } : {}) },
        body: JSON.stringify({ email: 'anna@calaba.test', password: 'password123', deviceName: 'vitest' }),
      });
      return ((await res.json()) as { tokens: { accessToken: string; sessionId: string } }).tokens;
    };
    const a = await loginAs(false);
    const b = await loginAs(true);
    expect(b.sessionId).not.toBe(a.sessionId);
    const gw = await openGateway();
    await gw.next((f) => f.op === GatewayOpcode.HELLO);
    gw.send({ op: GatewayOpcode.IDENTIFY, payload: { case: 'identify', value: { token: a.accessToken } } });
    await gw.next((f) => dispatchOf(f)?.event.case === 'ready');
    const join = (room: string, token: string): Promise<Response> => fetch(`${server.url}/api/rooms/${room}/join`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    expect((await join(IDS.rooms.call, a.accessToken)).status).toBe(200);
    expect((await join(IDS.rooms.meeting, b.accessToken)).status).toBe(200);
    const ev = dispatchOf(await gw.next((f) => dispatchOf(f)?.event.case === 'voiceDisconnected'))?.event;
    if (ev?.case !== 'voiceDisconnected') throw new Error('expected VOICE_DISCONNECTED');
    expect(ev.value).toMatchObject({ workspaceId: IDS.workspaces.main, roomId: IDS.rooms.call, sessionId: a.sessionId, reason: VoiceDisconnectReason.OTHER_DEVICE });
    expect(server.state.voiceStates.get(IDS.users.anna)?.roomId).toBe(IDS.rooms.meeting);
    gw.ws.close(1000);
    server.reset('data');
  });
});

describe('moving a participant (ADR-0019)', () => {
  it('app-level move: VOICE_MOVED with a target-room token for the device, VOICE_STATE_UPDATE for all', async () => {
    const res = await fetch(`${server.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'grigory@calaba.test', password: 'password123', deviceName: 'vitest' }),
    });
    const { tokens } = (await res.json()) as { tokens: { accessToken: string; sessionId: string } };
    const gw = await openGateway();
    await gw.next((f) => f.op === GatewayOpcode.HELLO);
    gw.send({ op: GatewayOpcode.IDENTIFY, payload: { case: 'identify', value: { token: tokens.accessToken } } });
    await gw.next((f) => dispatchOf(f)?.event.case === 'ready');

    const joined = await fetch(`${server.url}/api/rooms/${IDS.rooms.call}/join`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.accessToken}` } });
    expect(joined.status).toBe(200);
    const move = (userId: string, from: string, to: string, token: string): Promise<Response> =>
      fetch(`${server.url}/api/rooms/${from}/voice/${userId}/move`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetRoomId: to }),
      });
    // A member without MOVE_MEMBERS cannot move anyone.
    expect((await move(IDS.users.grigory, IDS.rooms.call, IDS.rooms.meeting, tokens.accessToken)).status).toBe(403);
    const owner = await login();
    expect((await move(IDS.users.grigory, IDS.rooms.call, IDS.rooms.meeting, owner)).status).toBe(204);

    const moved = dispatchOf(await gw.next((f) => dispatchOf(f)?.event.case === 'voiceMoved'))?.event;
    if (moved?.case !== 'voiceMoved') throw new Error('expected VOICE_MOVED');
    const identity = `${IDS.users.grigory}:${tokens.sessionId}`;
    expect(moved.value).toMatchObject({
      workspaceId: IDS.workspaces.main,
      fromRoomId: IDS.rooms.call,
      toRoomId: IDS.rooms.meeting,
      byUserId: IDS.users.anna,
      url: 'ws://127.0.0.1:7880',
      sessionId: tokens.sessionId,
      identity,
    });
    // A LiveKit token for the target room with the same identity as /join.
    const claims = JSON.parse(Buffer.from(moved.value.token.split('.')[1] ?? '', 'base64url').toString()) as { sub: string; video: { room: string; roomJoin: boolean } };
    expect(claims.sub).toBe(identity);
    expect(claims.video).toMatchObject({ room: `mock_${IDS.rooms.meeting}`, roomJoin: true });

    const upd = dispatchOf(
      await gw.next((f) => {
        const e = dispatchOf(f)?.event;
        return e?.case === 'voiceStateUpdate' && e.value.state?.userId === IDS.users.grigory && e.value.state.roomId === IDS.rooms.meeting;
      }),
    )?.event;
    expect(upd?.case === 'voiceStateUpdate' && upd.value.state?.muted).toBe(false);
    expect(server.state.voiceStates.get(IDS.users.grigory)?.roomId).toBe(IDS.rooms.meeting);

    // A fixture voice state has no device: the token-less (SFU move) event.
    expect((await move(IDS.users.boris, IDS.rooms.meeting, IDS.rooms.call, owner)).status).toBe(204);
    expect(server.state.voiceStates.get(IDS.users.boris)?.roomId).toBe(IDS.rooms.call);
    gw.ws.close(1000);
    server.reset('data');
  });
});

describe('room links and people (ADR-0016)', () => {
  it('previews a link publicly, signs a guest in (web cookie) and lets an admin promote them', async () => {
    const preview = await fetch(`${server.url}/api/room-invites/call-guest-link`);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ roomName: 'Созвон', workspaceName: 'Команда Calab', allowGuests: true });

    const join = await fetch(`${server.url}/api/room-invites/call-guest-link/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client': 'web' },
      body: JSON.stringify({ nickname: 'Гость Ира', deviceName: 'vitest (web)' }),
    });
    expect(join.status).toBe(201);
    expect(join.headers.get('set-cookie')).toContain('calaba_refresh=');
    const body = (await join.json()) as { roomId: string; workspaceId: string; me: { user: { id: string; isGuest: boolean } } };
    expect(body.roomId).toBe(IDS.rooms.call);
    expect(body.me.user.isGuest).toBe(true);

    const token = await login();
    const promote = await fetch(`${server.url}/api/workspaces/${IDS.workspaces.main}/members/${body.me.user.id}/promote`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(promote.status).toBe(200);
    expect(await promote.json()).toMatchObject({ member: { role: 'WORKSPACE_ROLE_MEMBER' } });
  });

  it('sets nicknames within the workspace rules', async () => {
    const token = await login('vera@calaba.test');
    const own = await fetch(`${server.url}/api/workspaces/${IDS.workspaces.main}/members/${IDS.users.vera}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: 'Верочка' }),
    });
    expect(own.status).toBe(200);
    const other = await fetch(`${server.url}/api/workspaces/${IDS.workspaces.main}/members/${IDS.users.boris}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: 'Боря' }),
    });
    expect(other.status).toBe(403);
    server.reset('data');
  });
});

describe('member profile (docs/09 #20)', () => {
  it('private notes: the author only, empty text deletes, 404 for unknown users', async () => {
    const anna = await login();
    const boris = await login('boris@calaba.test');
    const url = `${server.url}/api/users/${IDS.users.vera}/note`;
    const req = (token: string, method: string, body?: unknown): Promise<Response> =>
      fetch(url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    expect(await (await req(anna, 'GET')).json()).toMatchObject({ note: { subjectId: IDS.users.vera } });
    const put = await req(anna, 'PUT', { text: '  дизайн-ревью по четвергам ' });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ note: { text: 'дизайн-ревью по четвергам' } });
    expect(((await (await req(boris, 'GET')).json()) as { note: { text?: string } }).note.text ?? '').toBe('');
    expect((await req(anna, 'PUT', { text: 'я'.repeat(1001) })).status).toBe(422);
    expect(((await (await req(anna, 'PUT', { text: ' ' })).json()) as { note: { text?: string } }).note.text ?? '').toBe('');
    expect((await req(anna, 'DELETE')).status).toBe(204);
    const unknown = await fetch(`${server.url}/api/users/nobody/note`, { headers: { Authorization: `Bearer ${anna}` } });
    expect(unknown.status).toBe(404);
    server.reset('data');
  });

  it('members carry member since: registration and joining the workspace', async () => {
    const anna = await login();
    const res = await fetch(`${server.url}/api/workspaces/${IDS.workspaces.main}/members`, { headers: { Authorization: `Bearer ${anna}` } });
    const body = (await res.json()) as { members: { user: { id: string; createdAt?: string }; joinedAt?: string }[] };
    const vera = body.members.find((m) => m.user.id === IDS.users.vera);
    expect(vera?.user.createdAt).toBeTruthy();
    expect(vera?.joinedAt).toBeTruthy();
  });
});

describe('password and email change (user.proto)', () => {
  it('needs the current password; a wrong one is 403 INVALID_CREDENTIALS, not 401', async () => {
    const token = await login('boris@calaba.test');
    const patch = (path: string, body: object): Promise<Response> =>
      fetch(`${server.url}${path}`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const wrong = await patch('/api/me/password', { currentPassword: 'nope', newPassword: 'newpassword1' });
    expect(wrong.status).toBe(403);
    expect(((await wrong.json()) as { code: string }).code).toBe('ERROR_CODE_INVALID_CREDENTIALS');
    expect((await patch('/api/me/password', { currentPassword: 'password123', newPassword: 'short' })).status).toBe(422);
    expect((await patch('/api/me/password', { currentPassword: 'password123', newPassword: 'newpassword1' })).status).toBe(204);
    // The session that changed the password stays.
    expect((await fetch(`${server.url}/api/me`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);

    expect((await patch('/api/me/email', { newEmail: 'owner@calaba.test', currentPassword: 'newpassword1' })).status).toBe(409);
    expect((await patch('/api/me/email', { newEmail: 'not-an-email', currentPassword: 'newpassword1' })).status).toBe(422);
    const ok = await patch('/api/me/email', { newEmail: 'Boris.New@calaba.test', currentPassword: 'newpassword1' });
    expect(ok.status).toBe(200);
    // ADR-0023: the new address waits for its code; login stays on the old one.
    expect(((await ok.json()) as { me: { email: string; pendingEmail: string } }).me).toMatchObject({
      email: 'boris@calaba.test',
      pendingEmail: 'boris.new@calaba.test',
    });
    server.reset('data');
  });
});

describe('link previews (docs/09 #51)', () => {
  it('embeds-hidden: the author or MANAGE_MESSAGES toggles it; not an edit', async () => {
    const msg = server.state.messages.get(IDS.rooms.general)?.find((m) => m.content.includes('https://calaba.test/docs/08-design'));
    expect(msg?.authorId).toBe(IDS.users.vera);
    const put = async (email: string, hidden: boolean): Promise<Response> =>
      fetch(`${server.url}/api/messages/${msg?.id ?? ''}/embeds-hidden`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${await login(email)}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden }),
      });
    expect((await put('dina@calaba.test', true)).status).toBe(403); // a guest: no MANAGE_MESSAGES here
    const own = await put('vera@calaba.test', true);
    expect(own.status).toBe(200);
    const body = (await own.json()) as { message: { embedsHidden: boolean; editedAt?: string } };
    expect(body.message.embedsHidden).toBe(true);
    expect(body.message.editedAt).toBeUndefined();
    expect((await put('owner@calaba.test', false)).status).toBe(200);
    expect(msg?.embedsHidden).toBe(false);
    server.reset('data');
  });
});

describe('marketing scenario (README / landing screenshots)', () => {
  it('READY has the marketing rooms; «общий» has 5–7 messages and a calab.io preview', async () => {
    const mk = await startMockServer({ scenario: 'marketing' });
    try {
      const res = await fetch(`${mk.url}/api/auth/login`, {
        method: 'POST',
        body: JSON.stringify({ email: 'owner@calaba.test', password: 'password123' }),
      });
      const token = ((await res.json()) as { tokens: { accessToken: string } }).tokens.accessToken;
      const ws = new WebSocket(`${mk.url.replace('http', 'ws')}/gateway?v=1`);
      const ready = await new Promise<DispatchEvent>((resolve, reject) => {
        ws.on('message', (data: Buffer) => {
          const f = fromBinary(GatewayFrameSchema, new Uint8Array(data));
          if (f.op === GatewayOpcode.HELLO) {
            ws.send(toBinary(GatewayFrameSchema, create(GatewayFrameSchema, { op: GatewayOpcode.IDENTIFY, payload: { case: 'identify', value: { token } } })));
          } else if (f.payload.case === 'dispatch') resolve(f.payload.value);
        });
        ws.once('error', reject);
      });
      ws.close(1000);
      if (ready.event.case !== 'ready') throw new Error('expected READY');
      const [main, ...rest] = ready.event.value.workspaces;
      expect(rest).toHaveLength(0);
      expect(main?.workspace?.name).toBe('Команда Calab');
      expect(main?.rooms.map((r) => r.name)).toEqual(['общий', 'дизайн', 'бэкенд', 'релизы', 'Стендап', 'Переговорка']);
      expect(main?.voiceStates.map((v) => v.userId).sort()).toEqual([IDS.users.boris, IDS.users.vera]);

      const page = (await (
        await fetch(`${mk.url}/api/rooms/${MARKETING_IDS.rooms.general}/messages?limit=100`, { headers: { Authorization: `Bearer ${token}` } })
      ).json()) as { messages: { content: string }[] };
      expect(page.messages.length).toBeGreaterThanOrEqual(5);
      expect(page.messages.length).toBeLessThanOrEqual(7);
      expect(page.messages.some((m) => m.content.includes(`@${IDS.users.anna}`))).toBe(true);

      const preview = await fetch(`${mk.url}/api/unfurl?url=${encodeURIComponent('https://calab.io')}`, { headers: { Authorization: `Bearer ${token}` } });
      expect(((await preview.json()) as { siteName: string }).siteName).toBe('Calab');
      const file = await fetch(`${mk.url}/api/files/${MARKETING_IDS.files.screenshot}/thumbnail`, { headers: { Authorization: `Bearer ${token}` } });
      expect(file.headers.get('content-type')).toBe('image/jpeg');
    } finally {
      await mk.close();
    }
  });
});

describe('direct messages (ADR-0020)', () => {
  async function identify(email: string): Promise<{ gw: Awaited<ReturnType<typeof openGateway>>; token: string; ready: Extract<DispatchEvent['event'], { case: 'ready' }>['value'] }> {
    const token = await login(email);
    const gw = await openGateway();
    await gw.next((f) => f.op === GatewayOpcode.HELLO);
    gw.send({ op: GatewayOpcode.IDENTIFY, payload: { case: 'identify', value: { token } } });
    const ev = dispatchOf(await gw.next((f) => f.op === GatewayOpcode.DISPATCH))?.event;
    if (ev?.case !== 'ready') throw new Error('expected READY');
    return { gw, token, ready: ev.value };
  }
  const call = async (token: string, method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${server.url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it('READY and GET /api/dms list the DMs (newest first) with read state; candidates skip guests and me', async () => {
    server.reset('data');
    const { gw, token, ready } = await identify('owner@calaba.test');
    expect(ready.dms.map((d) => d.peer?.displayName)).toEqual(['Борис Петров', 'Вера Ким', 'Григорий Олегович Длинноимённый-Константинопольский']);
    const boris = ready.dms[0];
    expect(boris?.room?.type).toBe(RoomType.DM);
    expect(boris?.room?.workspaceId).toBe('');
    expect(boris?.readState?.unreadCount).toBe(2);
    expect(boris?.readState?.mentionCount).toBe(2);
    // The list preview comes with the summary (no history request per DM).
    expect(boris?.lastMessage?.content).toBe('Закрепил, чтобы не потерялся 🙏');
    expect(boris?.lastMessage?.authorId).toBe(IDS.users.boris);
    expect(boris?.lastMessage?.id).toBe(boris?.room?.lastMessageId);
    expect(ready.readStates.some((r) => r.roomId === IDS.dms.boris)).toBe(true);
    const list = (await (await call(token, 'GET', '/api/dms')).json()) as { dms: { room: { id: string } }[] };
    expect(list.dms.map((d) => d.room.id)).toEqual([IDS.dms.boris, IDS.dms.vera, IDS.dms.grigory]);
    const cands = (await (await call(token, 'GET', '/api/dms/candidates')).json()) as { users: { id: string }[] };
    expect(cands.users.map((u) => u.id).sort()).toEqual([IDS.users.boris, IDS.users.vera, IDS.users.grigory].sort());
    const vera = (await (await call(token, 'GET', `/api/dms/candidates?q=${encodeURIComponent('вер')}`)).json()) as { users: { id: string }[] };
    expect(vera.users.map((u) => u.id)).toEqual([IDS.users.vera]);
    gw.ws.close(1000);
  });

  it('POST /api/dms: 422 self, 403 guest, 200 existing, 201 new + DM_CREATE to both; messages go to the participants only', async () => {
    server.reset('data');
    const anna = await login('owner@calaba.test');
    expect((await call(anna, 'POST', '/api/dms', { userId: IDS.users.anna })).status).toBe(422);
    expect((await call(anna, 'POST', '/api/dms', { userId: IDS.users.dina })).status).toBe(403);
    expect((await call(anna, 'POST', '/api/dms', { userId: IDS.users.boris })).status).toBe(200);

    const boris = await identify('boris@calaba.test');
    const vera = await identify('vera@calaba.test');
    const created = await call(boris.token, 'POST', '/api/dms', { userId: IDS.users.vera });
    expect(created.status).toBe(201);
    const dmId = ((await created.json()) as { dm: { room: { id: string } } }).dm.room.id;
    for (const [c, peer] of [
      [boris, IDS.users.vera],
      [vera, IDS.users.boris],
    ] as const) {
      const ev = dispatchOf(await c.gw.next((f) => dispatchOf(f)?.event.case === 'dmCreate'))?.event;
      expect(ev?.case === 'dmCreate' && ev.value.dm?.peer?.id).toBe(peer);
    }
    expect((await call(vera.token, 'POST', `/api/rooms/${dmId}/messages`, { content: 'привет', nonce: 'n1' })).status).toBe(201);
    const msg = dispatchOf(await boris.gw.next((f) => dispatchOf(f)?.event.case === 'messageCreate'))?.event;
    expect(msg?.case === 'messageCreate' && msg.value.workspaceId).toBe('');
    // A third person sees nothing; both participants may pin.
    expect((await call(anna, 'GET', `/api/rooms/${dmId}/messages`)).status).toBe(404);
    const id = msg?.case === 'messageCreate' ? (msg.value.message?.id ?? '') : '';
    expect((await call(boris.token, 'PUT', `/api/messages/${id}/pin`)).status).toBe(204);
    boris.gw.ws.close(1000);
    vera.gw.ws.close(1000);
  });
});

describe('room order (docs/09 P1 #19)', () => {
  const put = (token: string, body: unknown): Promise<Response> =>
    fetch(`${server.url}/api/workspaces/${IDS.workspaces.main}/rooms/order`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('applies one batch (rooms + categories) for admins; all or nothing; 403 for members', async () => {
    const anna = await login();
    const grigory = await login('grigory@calaba.test');
    expect((await put(grigory, { rooms: [{ roomId: IDS.rooms.dev, position: 0 }] })).status).toBe(403);

    // A room of another workspace: 422, and the valid item before it is not applied.
    const bad = await put(anna, {
      rooms: [
        { roomId: IDS.rooms.dev, position: 0 },
        { roomId: IDS.rooms.designMockups, position: 1 },
      ],
    });
    expect(bad.status).toBe(422);

    const ok = await put(anna, {
      rooms: [{ roomId: IDS.rooms.dev, position: 1, categoryId: '' }],
      categories: [
        { categoryId: IDS.categories.voice, position: 0 },
        { categoryId: IDS.categories.dev, position: 1 },
      ],
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { rooms: { id: string; categoryId?: string; position?: number }[]; categories: { id: string }[] };
    expect(body.rooms).toMatchObject([{ id: IDS.rooms.dev, position: 1 }]);
    expect(body.rooms[0]?.categoryId ?? '').toBe('');
    expect(body.categories).toHaveLength(2);

    // Restore the fixture for the other tests.
    const back = await put(anna, {
      rooms: [{ roomId: IDS.rooms.dev, position: 1, categoryId: IDS.categories.dev }],
      categories: [
        { categoryId: IDS.categories.dev, position: 0 },
        { categoryId: IDS.categories.voice, position: 1 },
      ],
    });
    expect(back.status).toBe(200);
  });
});

describe('plans and the superadmin API (ADR-0024)', () => {
  const api = (token: string, path: string, init: { method?: string; body?: string } = {}): Promise<Response> =>
    fetch(`${server.url}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });

  it('READY: plan per workspace, planContact, me.isSuperadmin', async () => {
    const token = await login();
    const gw = await openGateway();
    await gw.next((f) => f.op === GatewayOpcode.HELLO);
    gw.send({ op: GatewayOpcode.IDENTIFY, payload: { case: 'identify', value: { token } } });
    const ready = dispatchOf(await gw.next((f) => dispatchOf(f)?.event.case === 'ready'))?.event;
    gw.ws.close(1000);
    if (ready?.case !== 'ready') throw new Error('no READY');
    expect(ready.value.me?.isSuperadmin).toBe(true);
    expect(ready.value.planContact).toBe('mailto:support@calab.io');
    const plans: Record<string, string> = {};
    for (const w of ready.value.workspaces) plans[w.workspace?.slug ?? ''] = Plan[w.workspace?.plan?.plan ?? Plan.UNSPECIFIED];
    expect(plans).toEqual({ calaba: 'TEAM', design: 'FREE' });
  });

  it('search / get / log for the superadmin; 404 for anyone else', async () => {
    const anna = await login();
    const boris = await login('boris@calaba.test');
    expect((await api(boris, '/api/admin/workspaces')).status).toBe(404);
    const all = (await (await api(anna, '/api/admin/workspaces')).json()) as { workspaces: { workspace: { slug: string }; ownerEmail: string; usage: { members: number } }[] };
    expect(all.workspaces.map((w) => w.workspace.slug)).toEqual(['community', 'design', 'calaba']);
    expect(all.workspaces[2]?.usage.members).toBe(4); // guests do not count
    const byEmail = (await (await api(anna, '/api/admin/workspaces?q=VERA@')).json()) as { workspaces: { workspace: { slug: string } }[] };
    expect(byEmail.workspaces.map((w) => w.workspace.slug)).toEqual(['design']);
    const one = await api(anna, `/api/admin/workspaces/${IDS.workspaces.community}`);
    expect(((await one.json()) as { workspace: { planNote: string } }).workspace.planNote).toMatch(/Пилот/);
    const log = (await (await api(anna, `/api/admin/workspaces/${IDS.workspaces.main}/plan/log`)).json()) as { entries: { plan: string }[] };
    expect(log.entries.map((e) => e.plan)).toEqual(['PLAN_TEAM']);
  });

  it('PUT plan: 422 on limits without CUSTOM; CUSTOM stored, logged and sent as WORKSPACE_UPDATE', async () => {
    const anna = await login();
    const path = `/api/admin/workspaces/${IDS.workspaces.design}/plan`;
    expect((await api(anna, path, { method: 'PUT', body: JSON.stringify({ plan: 'PLAN_TEAM', limits: { roomMembers: 3 }, note: '' }) })).status).toBe(422);
    expect((await api(anna, path, { method: 'PUT', body: JSON.stringify({ plan: 'PLAN_ENTERPRISE', limits: { roomMembers: 3 }, note: '' }) })).status).toBe(422);
    const gw = await openGateway();
    await gw.next((f) => f.op === GatewayOpcode.HELLO);
    gw.send({ op: GatewayOpcode.IDENTIFY, payload: { case: 'identify', value: { token: anna } } });
    await gw.next((f) => dispatchOf(f)?.event.case === 'ready');
    const res = await api(anna, path, { method: 'PUT', body: JSON.stringify({ plan: 'PLAN_CUSTOM', limits: { roomMembers: 8, storageMb: '2048' }, note: 'тест' }) });
    expect(res.status).toBe(200);
    const upd = dispatchOf(await gw.next((f) => dispatchOf(f)?.event.case === 'workspaceUpdate'))?.event;
    gw.ws.close(1000);
    expect(upd?.case === 'workspaceUpdate' && upd.value.workspace?.plan?.limits?.roomMembers).toBe(8);
    const log = (await (await api(anna, `${path}/log`)).json()) as { entries: { plan: string; note: string }[] };
    expect(log.entries[0]).toMatchObject({ plan: 'PLAN_CUSTOM', note: 'тест' });
    server.reset('data');
  });

  it('suspension (docs/09 #32): reason required, writes 403, calls end, resume', async () => {
    const anna = await login();
    const path = `/api/admin/workspaces/${IDS.workspaces.main}/suspension`;
    expect((await api(anna, path, { method: 'PUT', body: JSON.stringify({ suspended: true }) })).status).toBe(422);
    server.setVoiceState({ userId: IDS.users.boris, roomId: IDS.rooms.meeting });
    const res = await api(anna, path, { method: 'PUT', body: JSON.stringify({ suspended: true, reason: 'неоплата' }) });
    const aw = ((await res.json()) as { workspace: { workspace: { suspension?: { reason: string } }; suspendedByEmail: string } }).workspace;
    expect(aw.workspace.suspension?.reason).toBe('неоплата');
    expect(aw.suspendedByEmail).toBe('owner@calaba.test');
    expect(server.state.voiceStates.get(IDS.users.boris)?.roomId ?? '').toBe('');
    const send = await api(anna, `/api/rooms/${IDS.rooms.general}/messages`, { method: 'POST', body: JSON.stringify({ content: 'x' }) });
    expect(send.status).toBe(403);
    expect(await send.json()).toMatchObject({ code: 'ERROR_CODE_WORKSPACE_SUSPENDED' });
    expect((await api(anna, `/api/rooms/${IDS.rooms.meeting}/join`, { method: 'POST' })).status).toBe(403);
    await api(anna, path, { method: 'PUT', body: JSON.stringify({ suspended: false }) });
    expect(server.state.workspaces.get(IDS.workspaces.main)?.suspension).toBeUndefined();
    server.reset('data');
  });

  it('bans (docs/09 #32): ban removes the member, listed, unban; the owner cannot be banned', async () => {
    const anna = await login();
    const base = `/api/workspaces/${IDS.workspaces.main}/bans`;
    const vera = await login('vera@calaba.test');
    expect((await api(vera, base)).status).toBe(403);
    expect((await api(anna, base, { method: 'POST', body: JSON.stringify({ userId: IDS.users.anna }) })).status).toBe(403);
    const r = await api(anna, base, { method: 'POST', body: JSON.stringify({ userId: IDS.users.vera, reason: 'спам' }) });
    expect(r.status).toBe(201);
    expect(server.state.members.some((m) => m.workspaceId === IDS.workspaces.main && m.userId === IDS.users.vera)).toBe(false);
    const list = (await (await api(anna, base)).json()) as { bans: { user: { id: string }; reason: string }[] };
    expect(list.bans.map((b) => [b.user.id, b.reason])).toEqual([[IDS.users.vera, 'спам']]);
    expect((await api(anna, `${base}/${IDS.users.vera}`, { method: 'DELETE' })).status).toBe(204);
    expect((await api(anna, `${base}/${IDS.users.vera}`, { method: 'DELETE' })).status).toBe(404);
    server.reset('data');
  });

  it('limits: 409 ROOM_FULL PLAN_LIMIT with used / limit; stream and camera capped; 413 quota with reason', async () => {
    const anna = await login();
    const ws = server.state.workspaces.get(IDS.workspaces.main);
    if (!ws?.plan?.limits) throw new Error('no plan');
    ws.plan.limits = create(PlanLimitsSchema, { roomMembers: 1, streamMaxPreset: ScreenSharePreset.H720, streamMaxFps: 10, cameraMaxPreset: ScreenSharePreset.H720, cameraMaxFps: 15, storageMb: 1n });
    server.setVoiceState({ userId: IDS.users.boris, roomId: IDS.rooms.meeting });
    const full = await api(anna, `/api/rooms/${IDS.rooms.meeting}/join`, { method: 'POST' });
    expect(full.status).toBe(409);
    const body = (await full.json()) as { used?: string };
    expect(body).toMatchObject({ code: 'ERROR_CODE_ROOM_FULL', reason: 'PLAN_LIMIT', limit: '1' });
    expect(Number(body.used)).toBeGreaterThanOrEqual(1);
    server.setVoiceState({ userId: IDS.users.boris, roomId: '' });
    server.setVoiceState({ userId: IDS.users.anna, roomId: IDS.rooms.meeting });
    const stream = await api(anna, `/api/rooms/${IDS.rooms.meeting}/stream/request`, { method: 'POST', body: JSON.stringify({ preset: 'SCREEN_SHARE_PRESET_H1080' }) });
    expect(await stream.json()).toEqual({ preset: 'SCREEN_SHARE_PRESET_H720', fps: 10 });
    const cam = await api(anna, `/api/rooms/${IDS.rooms.meeting}/camera/request`, { method: 'POST', body: JSON.stringify({ preset: 'SCREEN_SHARE_PRESET_H1080' }) });
    expect(await cam.json()).toEqual({ preset: 'SCREEN_SHARE_PRESET_H720', fps: 15 });
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(1024)], { type: 'application/octet-stream' }), 'a.bin');
    const up = await fetch(`${server.url}/api/workspaces/${IDS.workspaces.main}/files`, { method: 'POST', headers: { Authorization: `Bearer ${anna}` }, body: form });
    expect(up.status).toBe(413);
    expect(await up.json()).toMatchObject({ code: 'ERROR_CODE_FILE_QUOTA_EXCEEDED', reason: 'PLAN_LIMIT', limit: String(1024 * 1024) });
    server.reset('data');
  });
});

describe('email (ADR-0023)', () => {
  const call = (token: string | null, method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${server.url}${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const codeOf = async (r: Response): Promise<string> => ((await r.json()) as { code: string }).code;

  it('sign-up is unverified: 403 EMAIL_NOT_VERIFIED until the code; resend 429 + Retry-After; attempts', async () => {
    const reg = await call(null, 'POST', '/api/auth/register', { email: 'new@calaba.test', password: 'password123', displayName: 'Новый', locale: 'ru-RU' });
    expect(reg.status).toBe(201);
    const body = (await reg.json()) as { tokens: { accessToken: string }; me: { emailVerified?: boolean; locale: string } };
    expect(body.me.emailVerified ?? false).toBe(false);
    expect(body.me.locale).toBe('ru');
    const token = body.tokens.accessToken;
    const ws = await call(token, 'POST', '/api/workspaces', { name: 'X', slug: 'x-ws' });
    expect(ws.status).toBe(403);
    expect(await codeOf(ws)).toBe('ERROR_CODE_EMAIL_NOT_VERIFIED');

    const resend = await call(token, 'POST', '/api/auth/verify/send');
    expect(resend.status).toBe(429);
    expect(Number(resend.headers.get('retry-after'))).toBeGreaterThan(50);

    const wrong = await call(token, 'POST', '/api/auth/verify', { code: '000000' });
    expect(wrong.status).toBe(422);
    expect(((await wrong.json()) as { message: string }).message).toBe('wrong code, 4 attempt(s) left');
    const ok = await call(token, 'POST', '/api/auth/verify', { code: MOCK_EMAIL_CODE });
    expect(((await ok.json()) as { me: { emailVerified: boolean } }).me.emailVerified).toBe(true);
    expect((await call(token, 'POST', '/api/workspaces', { name: 'X', slug: 'x-ws' })).status).toBe(201);
    expect((await call(token, 'POST', '/api/auth/verify/send')).status).toBe(409);
    server.reset('data');
  });

  it('five wrong codes use the code up (CODE_EXPIRED)', async () => {
    server.setEmailState(IDS.users.grigory, { verified: false });
    const token = await login('grigory@calaba.test');
    for (let i = 0; i < 4; i++) expect(await codeOf(await call(token, 'POST', '/api/auth/verify', { code: '000000' }))).toBe('ERROR_CODE_CODE_INVALID');
    expect(await codeOf(await call(token, 'POST', '/api/auth/verify', { code: '000000' }))).toBe('ERROR_CODE_CODE_EXPIRED');
    expect(await codeOf(await call(token, 'POST', '/api/auth/verify', { code: MOCK_EMAIL_CODE }))).toBe('ERROR_CODE_CODE_EXPIRED');
    server.reset('data');
  });

  it('password reset: forgot answers the same bar the similar hint; reset revokes sessions; the new password signs in', async () => {
    const old = await login('vera@calaba.test');
    const forgot = async (email: string): Promise<unknown> => {
      const r = await call(null, 'POST', '/api/auth/password/forgot', { email });
      expect(r.status).toBe(200);
      return r.json();
    };
    expect(await forgot('nobody@calaba.test')).toEqual({ similarAccount: false });
    expect(await forgot('vera@calaba.ru')).toEqual({ similarAccount: true });
    expect(await forgot('vera@calaba.test')).toEqual({ similarAccount: false });
    expect(await codeOf(await call(null, 'POST', '/api/auth/password/reset', { email: 'vera@calaba.test', code: '999999', password: 'brandnew123' }))).toBe(
      'ERROR_CODE_CODE_INVALID',
    );
    expect((await call(null, 'POST', '/api/auth/password/reset', { email: 'vera@calaba.test', code: MOCK_EMAIL_CODE, password: 'brandnew123' })).status).toBe(204);
    expect((await call(old, 'GET', '/api/me')).status).toBe(401);
    const res = await call(null, 'POST', '/api/auth/login', { email: 'vera@calaba.test', password: 'brandnew123' });
    expect(res.status).toBe(200);
    server.reset('data');
  });

  it('invite by email: lookup, add, invitation with a public preview, sign-up with the emailed code joins once confirmed (docs/09 #36)', async () => {
    const anna = await login();
    const ws = IDS.workspaces.main;
    const found = (await (await call(anna, 'POST', `/api/workspaces/${ws}/invites/lookup`, { email: 'Vera@calaba.test' })).json()) as {
      user?: { id: string };
      member: boolean;
    };
    expect(found).toMatchObject({ user: { id: IDS.users.vera }, member: true });
    expect(await (await call(anna, 'POST', `/api/workspaces/${ws}/invites/lookup`, { email: 'x@example.com' })).json()).toEqual({ member: false });
    expect((await call(await login('vera@calaba.test'), 'POST', `/api/workspaces/${ws}/invites/lookup`, { email: 'x@example.com' })).status).toBe(403);

    const created = await call(anna, 'POST', `/api/workspaces/${ws}/invites/email`, { email: 'x@example.com' });
    expect(created.status).toBe(201);
    const again = await call(anna, 'POST', `/api/workspaces/${ws}/invites/email`, { email: 'x@example.com' });
    expect(again.status).toBe(429);
    expect(Number(again.headers.get('retry-after'))).toBeGreaterThan(3600);
    const list = (await (await call(anna, 'GET', `/api/workspaces/${ws}/invites/email`)).json()) as { invites: { id: string; email: string }[] };
    expect(list.invites.map((i) => i.email)).toEqual(['x@example.com']);

    const code = [...server.state.emailInvites.values()][0]?.code ?? '';
    const preview = (await (await call(null, 'GET', `/api/invites/${code}`)).json()) as { email: string; memberCount: number; workspace: { name: string } };
    expect(preview).toMatchObject({ email: 'x@example.com', memberCount: 4, workspace: { name: 'Команда Calab' } });
    const other = await call(null, 'POST', '/api/auth/register', { email: 'y@example.com', password: 'password123', displayName: 'Y', inviteCode: code });
    expect(await codeOf(other)).toBe('ERROR_CODE_INVITE_EMAIL_MISMATCH');
    // ADR-0027: the emailed code signs up; confirming the address joins (docs/09 #36).
    const reg = await call(null, 'POST', '/api/auth/register', { email: 'x@example.com', password: 'password123', displayName: 'X', inviteCode: code });
    const body = (await reg.json()) as { tokens: { accessToken: string }; me: { emailVerified: boolean; user: { id: string } } };
    const me = body.me;
    expect(me.emailVerified).toBe(false);
    expect(server.state.members.some((m) => m.workspaceId === ws && m.userId === me.user.id)).toBe(false);
    const x = body.tokens.accessToken;
    expect(await codeOf(await call(x, 'POST', `/api/invites/${code}/join`))).toBe('ERROR_CODE_EMAIL_NOT_VERIFIED');
    const verified = (await (await call(x, 'POST', '/api/auth/verify', { code: MOCK_EMAIL_CODE })).json()) as { joinedWorkspaceIds: string[] };
    expect(verified.joinedWorkspaceIds).toEqual([ws]);
    expect(server.state.members.some((m) => m.workspaceId === ws && m.userId === me.user.id)).toBe(true);
    // The link again: the preview still shows, joining answers with the membership; others get 403.
    expect((await call(null, 'GET', `/api/invites/${code}`)).status).toBe(200);
    expect((await call(x, 'POST', `/api/invites/${code}/join`)).status).toBe(200);
    const zReg = await call(null, 'POST', '/api/auth/register', { email: 'z@example.com', password: 'password123', displayName: 'Z' });
    const z = ((await zReg.json()) as { tokens: { accessToken: string } }).tokens.accessToken;
    expect(await codeOf(await call(z, 'POST', `/api/invites/${code}/join`))).toBe('ERROR_CODE_INVITE_EMAIL_MISMATCH');
    expect(((await (await call(anna, 'GET', `/api/workspaces/${ws}/invites/email`)).json()) as { invites: unknown[] }).invites).toEqual([]);

    // A verified non-member found by lookup is added at once.
    const add = await call(anna, 'POST', `/api/workspaces/${IDS.workspaces.main}/members`, { userId: me.user.id });
    expect(add.status).toBe(409);
    server.reset('data');
  });

  it('reactions: at most 3 different emojis per user per message (docs/09 #27)', async () => {
    const auth = { Authorization: `Bearer ${await login()}` };
    const page = (await (await fetch(`${server.url}/api/rooms/${IDS.rooms.general}/messages?limit=1`, { headers: auth })).json()) as {
      messages: { id: string }[];
    };
    const mid = page.messages[0]?.id ?? '';
    const put = (e: string, method = 'PUT'): Promise<Response> =>
      fetch(`${server.url}/api/messages/${mid}/reactions/${encodeURIComponent(e)}`, { method, headers: auth });
    // Start from none of anna's own reactions on the message.
    for (const e of ['🧪', '🧫', '🧬', '🔬']) await put(e, 'DELETE');
    for (const e of ['🧪', '🧫', '🧬']) expect((await put(e)).status).toBe(204);
    expect((await put('🧪')).status).toBe(204); // repeat: idempotent
    const over = await put('🔬');
    expect(over.status).toBe(409);
    expect(await over.json()).toMatchObject({ code: 'ERROR_CODE_CONFLICT', reason: 'REACTION_LIMIT', limit: '3' });
    expect((await put('🧫', 'DELETE')).status).toBe(204);
    expect((await put('🔬')).status).toBe(204);
    server.reset('data');
  });
});

describe('meeting recording (ADR-0025)', () => {
  it('pairs GPTunneL, records a room, posts a card that moves on to DONE', async () => {
    server.reset('data');
    const owner = { Authorization: `Bearer ${await login()}`, 'Content-Type': 'application/json' };
    const member = { Authorization: `Bearer ${await login('vera@calaba.test')}`, 'Content-Type': 'application/json' };
    const guest = { Authorization: `Bearer ${await login('dina@calaba.test')}` };
    const ws = `${server.url}/api/workspaces/${IDS.workspaces.main}/integrations/gptunnel`;
    const room = `${server.url}/api/rooms/${IDS.rooms.meeting}`;
    const code = async (r: Response): Promise<string> => ((await r.json()) as { code: string }).code;

    expect((await fetch(ws, { headers: guest })).status).toBe(403);
    expect(((await (await fetch(ws, { headers: member })).json()) as { integration: { paired: boolean } }).integration.paired).toBe(false);
    // Not paired: start is 409 NOT_PAIRED.
    const notPaired = await fetch(`${room}/recording/start`, { method: 'POST', headers: member });
    expect([notPaired.status, await code(notPaired)]).toEqual([409, 'ERROR_CODE_NOT_PAIRED']);
    // Pairing: members may not; wrong / rate-limited / unavailable codes; the mock's code pairs.
    expect((await fetch(ws, { method: 'POST', headers: member, body: JSON.stringify({ code: MOCK_GPTUNNEL_CODE }) })).status).toBe(403);
    const pair = (c: string): Promise<Response> => fetch(ws, { method: 'POST', headers: owner, body: JSON.stringify({ code: c }) });
    const wrong = await pair('WXYZ-1234');
    expect([wrong.status, await code(wrong)]).toEqual([422, 'ERROR_CODE_CODE_INVALID']);
    expect((await pair('ABC')).status).toBe(422);
    expect((await pair('rate-rate')).status).toBe(429);
    expect((await pair('DOWN DOWN')).status).toBe(503);
    const ok = (await (await pair('abcd efgh')).json()) as { integration: { paired: boolean; deviceName: string; webUrl: string } };
    expect(ok.integration).toMatchObject({ paired: true, deviceName: 'Calab · Команда Calab', webUrl: MOCK_GPTUNNEL_WEB });

    // A member starts: ROOM_RECORDING ACTIVE to the workspace; guests cannot.
    const gw = await openGateway();
    await gw.next((f) => f.op === GatewayOpcode.HELLO);
    gw.send({ op: GatewayOpcode.IDENTIFY, payload: { case: 'identify', value: { token: owner.Authorization.slice(7), device: { name: 'vitest', platform: 'test', appVersion: '0' } } } });
    await gw.next((f) => dispatchOf(f)?.event.case === 'ready');
    expect((await fetch(`${room}/recording/start`, { method: 'POST', headers: guest })).status).toBe(403);
    expect((await fetch(`${room}/recording/start`, { method: 'POST', headers: member })).status).toBe(200);
    const active = dispatchOf(await gw.next((f) => dispatchOf(f)?.event.case === 'roomRecording'))?.event;
    expect(active?.case === 'roomRecording' && active.value.state).toBe(RoomRecordingState.ACTIVE);
    const again = await fetch(`${room}/recording/start`, { method: 'POST', headers: owner });
    expect([again.status, await code(again)]).toEqual([409, 'ERROR_CODE_ALREADY_RECORDING']);
    expect(server.state.recordings.has(IDS.rooms.meeting)).toBe(true);

    // Anyone (not a guest) stops: STOPPED {user, by}, then the card UPLOADING → PROCESSING → DONE.
    expect((await fetch(`${room}/recording/stop`, { method: 'POST', headers: owner })).status).toBe(200);
    const stopped = dispatchOf(await gw.next((f) => dispatchOf(f)?.event.case === 'roomRecording'))?.event;
    expect(stopped?.case === 'roomRecording' && [stopped.value.state, stopped.value.stopReason, stopped.value.stoppedBy]).toEqual([
      RoomRecordingState.STOPPED,
      'user',
      IDS.users.anna,
    ]);
    const card = (e: DispatchEvent['event']): RecordingStatus | undefined =>
      (e.case === 'messageCreate' || e.case === 'messageUpdate') && e.value.message?.system?.payload.case === 'recording'
        ? e.value.message.system.payload.value.status
        : undefined;
    const created = dispatchOf(await gw.next((f) => dispatchOf(f)?.event.case === 'messageCreate'))?.event;
    expect(created?.case === 'messageCreate' && [created.value.message?.kind, created.value.message?.authorId]).toEqual([MessageKind.SYSTEM, IDS.users.vera]);
    expect(created && card(created)).toBe(RecordingStatus.UPLOADING);
    const seen: (RecordingStatus | undefined)[] = [];
    for (let i = 0; i < 2; i++) {
      const upd = dispatchOf(await gw.next((f) => dispatchOf(f)?.event.case === 'messageUpdate'))?.event;
      if (upd) seen.push(card(upd));
    }
    expect(seen).toEqual([RecordingStatus.PROCESSING, RecordingStatus.DONE]);
    expect((await fetch(`${room}/recording/stop`, { method: 'POST', headers: owner })).status).toBe(404);

    // allowRecording: MANAGE_WORKSPACE; off → start is 403.
    expect((await fetch(room, { method: 'PATCH', headers: owner, body: JSON.stringify({ allowRecording: false }) })).status).toBe(200);
    expect((await fetch(`${room}/recording/start`, { method: 'POST', headers: member })).status).toBe(403);
    expect((await fetch(ws, { method: 'DELETE', headers: owner })).status).toBe(204);
    gw.ws.close();
    server.reset('data');
  });
});

describe('one-to-one calls (ADR-0034)', () => {
  type Gw = Awaited<ReturnType<typeof openGateway>>;
  const api = async (token: string, path: string): Promise<Response> =>
    fetch(`${server.url}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
  async function identify(email: string): Promise<{ gw: Gw; token: string; ready: Extract<DispatchEvent['event'], { case: 'ready' }>['value'] }> {
    const token = await login(email);
    const gw = await openGateway();
    await gw.next((f) => f.op === GatewayOpcode.HELLO);
    gw.send({ op: GatewayOpcode.IDENTIFY, payload: { case: 'identify', value: { token } } });
    const ev = dispatchOf(await gw.next((f) => f.op === GatewayOpcode.DISPATCH))?.event;
    if (ev?.case !== 'ready') throw new Error('expected READY');
    return { gw, token, ready: ev.value };
  }
  const event = async (gw: Gw, pred: (e: DispatchEvent['event']) => boolean): Promise<DispatchEvent['event']> => {
    const f = await gw.next((x) => {
      const e = dispatchOf(x)?.event;
      return e !== undefined && pred(e);
    });
    return dispatchOf(f)?.event ?? { case: undefined };
  };

  it('ring → accept → join → hangup: events, presence on_call, the DM session, the log card', async () => {
    server.reset('data');
    const anna = await identify('owner@calaba.test');
    // No call: the DM cannot be joined.
    const noCall = await api(anna.token, `/api/rooms/${IDS.dms.boris}/join`);
    expect(noCall.status).toBe(409);
    expect(((await noCall.json()) as { code: string }).code).toBe('ERROR_CODE_CALL_NOT_ACTIVE');
    // Boris calls Anna (the helper the client's tests use): CALL_RING with the caller.
    const call = server.ringCall(IDS.users.boris, IDS.users.anna);
    const ring = await event(anna.gw, (e) => e.case === 'callRing');
    expect(ring.case === 'callRing' && ring.value.caller?.id).toBe(IDS.users.boris);
    expect(ring.case === 'callRing' && ring.value.call?.state).toBe(CallState.RINGING);
    anna.gw.ws.close(1000);
    const a2 = await identify('owner@calaba.test');
    expect(a2.ready.call?.id).toBe(call.id); // READY.call after a reconnect

    expect((await api(a2.token, `/api/calls/${call.id}/cancel`)).status).toBe(403); // the callee cannot cancel
    const acc = await api(a2.token, `/api/calls/${call.id}/accept`);
    expect(acc.status).toBe(200);
    expect(((await acc.json()) as { call: { state: string } }).call.state).toBe('CALL_STATE_ACTIVE');
    expect((await api(a2.token, `/api/calls/${call.id}/accept`)).status).toBe(409);
    const pres = await event(a2.gw, (e) => e.case === 'presenceUpdate' && e.value.presence?.userId === IDS.users.anna);
    expect(pres.case === 'presenceUpdate' && pres.value.presence?.onCall).toBe(true);

    const join = await api(a2.token, `/api/rooms/${IDS.dms.boris}/join`);
    expect(join.status).toBe(200);
    expect(((await join.json()) as { canVideo: boolean }).canVideo).toBe(true);
    const vs = await event(a2.gw, (e) => e.case === 'voiceStateUpdate' && e.value.state?.roomId === IDS.dms.boris);
    expect(vs.case === 'voiceStateUpdate' && vs.value.state?.workspaceId).toBe('');

    expect((await api(a2.token, `/api/calls/${call.id}/hangup`)).status).toBe(200);
    await event(a2.gw, (e) => e.case === 'callState' && e.value.call?.state === CallState.ENDED);
    const card = await event(a2.gw, (e) => e.case === 'messageCreate' && e.value.message?.roomId === IDS.dms.boris);
    expect(card.case === 'messageCreate' && card.value.message?.kind).toBe(MessageKind.SYSTEM);
    expect(card.case === 'messageCreate' && card.value.message?.system?.payload.case).toBe('call');
    expect(server.state.voiceStates.get(IDS.users.anna)).toBeUndefined();
    a2.gw.ws.close(1000);
  });

  it('BUSY / IN_CALL; decline and cancel by the right side only; cards in the DM log', async () => {
    server.reset('data');
    const anna = await login('owner@calaba.test');
    const vera = await login('vera@calaba.test');
    const call = server.ringCall(IDS.users.boris, IDS.users.anna);
    const busy = await api(vera, `/api/dms/${IDS.dms.vera}/call`);
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { code: string }).code).toBe('ERROR_CODE_BUSY');
    expect(() => server.ringCall(IDS.users.boris, IDS.users.vera)).toThrow(); // IN_CALL
    expect((await api(anna, `/api/calls/${call.id}/decline`)).status).toBe(200);
    const out = await api(anna, `/api/dms/${IDS.dms.vera}/call`);
    expect(out.status).toBe(201);
    const id = ((await out.json()) as { call: { id: string } }).call.id;
    expect((await api(vera, `/api/calls/${id}/cancel`)).status).toBe(403);
    expect((await api(anna, `/api/calls/${id}/cancel`)).status).toBe(200);
    const cards = (server.state.messages.get(IDS.dms.vera) ?? []).flatMap((m) => (m.system?.payload.case === 'call' ? [m.system.payload.value.outcome] : []));
    expect(cards).toEqual([CallOutcome.BUSY, CallOutcome.CANCELLED]);
  });
});
