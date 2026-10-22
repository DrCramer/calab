import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { CanvasDoc } from '../src/renderer/lib/canvas/doc';
import { restoreCanvasState } from '../src/renderer/lib/canvas/restore';
import { decodeFrame, encodeUpdate, FRAME_SNAPSHOT, FRAME_UPDATE, type Frame } from '../src/renderer/lib/wiki/frames';
import { IDS, startMockServer, type MockServer } from './mock-server';

// The Canvas in the mock (ADR-0115): pnpm -F @calaba/desktop exec vitest run --config e2e-support/vitest.config.ts mock-canvas

let server: MockServer;

beforeAll(async () => {
  server = await startMockServer({ scenario: 'data' });
});
afterAll(async () => {
  await server.close();
});

async function login(email: string): Promise<string> {
  const res = await fetch(`${server.url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123', deviceName: 'vitest' }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { tokens: { accessToken: string } }).tokens.accessToken;
}

const api = (token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> =>
  fetch(`${server.url}${path}`, {
    ...(init.method ? { method: init.method } : {}),
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });

type Item = { id: string; name: string; kind: string; parentId?: string; hasChildren?: boolean; restricted?: boolean; position?: number; myBits?: string };
const W = `/api/workspaces/${IDS.workspaces.main}/canvas`;
const list = async (token: string, query = ''): Promise<Item[]> => ((await (await api(token, `${W}/items${query}`)).json()) as { items: Item[] }).items;

/** A sync socket that collects decoded frames. */
function sync(canvasId: string, token: string): Promise<{ ws: WebSocket; next: () => Promise<Frame> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${server.url.replace('http', 'ws')}/api/canvas/items/${canvasId}/sync`);
    const frames: Frame[] = [];
    const waiters: Array<(f: Frame) => void> = [];
    ws.on('message', (data: Buffer) => {
      const f = decodeFrame(new Uint8Array(data));
      if (!f) return;
      const w = waiters.shift();
      if (w) w(f);
      else frames.push(f);
    });
    ws.on('open', () => {
      ws.send(token);
      resolve({ ws, next: () => new Promise((r) => (frames.length ? r(frames.shift() as Frame) : waiters.push(r))) });
    });
    ws.on('error', reject);
  });
}

describe('canvas (ADR-0115)', () => {
  it('the top level, lazy children, the restricted canvas only for the listed, the trash', async () => {
    const anna = await login('owner@calaba.test');
    const top = await list(anna);
    expect(top.map((p) => p.name)).toEqual(['Продукт', 'Дизайн', 'Планирование спринта', 'Черновики']);
    expect(top[0]?.hasChildren).toBe(true);
    expect(top[2]?.kind).toBe('CANVAS_ITEM_KIND_CANVAS');
    expect((await list(anna, `?parent=${top[0]?.id}`)).map((p) => p.name)).toEqual(['Дорожная карта Q1', 'Ретро-доска']);
    const grigory = await login('grigory@calaba.test');
    expect((await list(grigory)).some((p) => p.name === 'Черновики')).toBe(false);
    expect((await list(anna, '?trashed=1')).map((p) => p.name)).toEqual(['Старая схема', 'Архив']);
  });

  it('create needs a kind, only a folder is a parent; move with position, trash, restore', async () => {
    const anna = await login('owner@calaba.test');
    const top = await list(anna);
    const post = (body: unknown) => api(anna, `${W}/items`, { method: 'POST', body });
    expect((await post({ name: 'x' })).status).toBe(422);
    const made = ((await (await post({ kind: 'CANVAS_ITEM_KIND_CANVAS', name: 'Новый' })).json()) as { item: Item }).item;
    expect((await post({ kind: 'CANVAS_ITEM_KIND_CANVAS', parentId: made.id, name: 'внутри' })).status).toBe(409);
    expect((await api(anna, `${W}/items?parent=${made.id}`)).status).toBe(409);
    const moved = ((await (await api(anna, `/api/canvas/items/${made.id}`, { method: 'PATCH', body: { parentId: top[1]?.id, position: 0 } })).json()) as { item: Item }).item;
    expect(moved.parentId).toBe(top[1]?.id);
    expect((await list(anna, `?parent=${top[1]?.id}`))[0]?.name).toBe('Новый');
    expect((await api(anna, `/api/canvas/items/${top[1]?.id}`, { method: 'PATCH', body: { parentId: made.id } })).status).toBe(409);
    expect((await api(anna, `/api/canvas/items/${made.id}/trash`, { method: 'POST' })).status).toBe(200);
    expect((await api(anna, `/api/canvas/items/${made.id}/restore`, { method: 'POST' })).status).toBe(200);
  });

  it('answers as the live server does (H8 walk): a folder into its own subtree 409, a live item is not deletable 409, a hit has its path and a marked snippet', async () => {
    const anna = await login('owner@calaba.test');
    const post = (body: unknown) => api(anna, `${W}/items`, { method: 'POST', body });
    const outer = ((await (await post({ kind: 'CANVAS_ITEM_KIND_FOLDER', name: 'Внешняя' })).json()) as { item: Item }).item;
    const inner = ((await (await post({ kind: 'CANVAS_ITEM_KIND_FOLDER', parentId: outer.id, name: 'Внутренняя' })).json()) as { item: Item }).item;
    expect((await api(anna, `/api/canvas/items/${outer.id}`, { method: 'PATCH', body: { parentId: inner.id } })).status).toBe(409);
    expect((await api(anna, `/api/canvas/items/${outer.id}`, { method: 'DELETE' })).status).toBe(409);
    await api(anna, `/api/canvas/items/${outer.id}/trash`, { method: 'POST' });
    expect((await api(anna, `/api/canvas/items/${outer.id}`, { method: 'DELETE' })).status).toBe(204);
    const res = await api(anna, `/api/search?type=canvas&scope=${IDS.workspaces.main}&q=${encodeURIComponent('карта')}`);
    const hit = ((await res.json()) as { sections: Array<{ items: Array<{ snippet: string; canvas?: { path?: string[] } }> }> }).sections[0]?.items[0];
    expect(hit?.canvas?.path).toEqual(['Продукт']);
    expect(hit?.snippet).toContain('\u0002карта\u0003');
  });

  it('search finds a canvas by its name or text and not a folder', async () => {
    const anna = await login('owner@calaba.test');
    const res = await api(anna, `/api/search?type=canvas&scope=${IDS.workspaces.main}&q=${encodeURIComponent('эха')}`);
    const body = (await res.json()) as { sections: Array<{ items: Array<{ title: string; ref: { canvas?: { itemId: string; folder?: boolean } } }> }> };
    expect(body.sections[0]?.items.map((i) => i.title)).toEqual(['Дорожная карта Q1']);
  });

  it('the sync socket: snapshot with the seeded objects, updates echoed with a seq to every socket', async () => {
    const anna = await login('owner@calaba.test');
    const boris = await login('boris@calaba.test');
    const road = (await list(anna, `?parent=${(await list(anna))[0]?.id}`))[0] as Item;
    const a = await sync(road.id, anna);
    const b = await sync(road.id, boris);
    const snap = await a.next();
    await b.next();
    expect(snap.type).toBe(FRAME_SNAPSHOT);
    const doc = new Y.Doc();
    if (snap.type === FRAME_SNAPSHOT) Y.applyUpdate(doc, snap.state);
    expect(doc.getMap('objects').size).toBe(8);
    let update: Uint8Array | null = null;
    doc.on('update', (u: Uint8Array) => (update = u));
    new CanvasDoc(doc).create({ kind: 'sticky', x: 5, y: 5, text: 'новый' });
    a.ws.send(encodeUpdate(update as unknown as Uint8Array));
    const [ea, eb] = await Promise.all([a.next(), b.next()]);
    expect(ea.type).toBe(FRAME_UPDATE);
    expect(eb.type === FRAME_UPDATE && eb.seq).toBe(1);
    a.ws.close();
    b.ws.close();
  });

  it('a canvas I cannot see closes the socket with 4003, a folder with 4404', async () => {
    const anna = await login('owner@calaba.test');
    const grigory = await login('grigory@calaba.test');
    const top = await list(anna);
    const drafts = top.find((p) => p.name === 'Черновики') as Item;
    const s = await sync(drafts.id, grigory);
    expect(await new Promise<number>((r) => s.ws.on('close', (c) => r(c)))).toBe(4003);
    const f = await sync((top[0] as Item).id, anna);
    expect(await new Promise<number>((r) => f.ws.on('close', (c) => r(c)))).toBe(4404);
  });

  it('versions list; a version state restores into a live document as one transaction', async () => {
    const anna = await login('owner@calaba.test');
    const road = (await list(anna, `?parent=${(await list(anna))[0]?.id}`))[0] as Item;
    const vs = ((await (await api(anna, `/api/canvas/items/${road.id}/versions`)).json()) as { versions: Array<{ id: string }> }).versions;
    expect(vs.length).toBe(2);
    const res = await api(anna, `/api/canvas/items/${road.id}/versions/${vs[1]?.id}`);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    const live = new CanvasDoc(new Y.Doc());
    live.create({ kind: 'sticky', x: 1, y: 1, text: 'live' });
    let txs = 0;
    live.ydoc.on('afterTransaction', () => txs++);
    expect(restoreCanvasState(live, new Uint8Array(await res.arrayBuffer()))).toBe(true);
    expect(txs).toBe(1);
    expect(live.count).toBe(1);
    expect([...live.objects.values()].map((m) => (m.get('text') as Y.Text).toJSON())).toEqual(['Голос без эха']);
  });
});
