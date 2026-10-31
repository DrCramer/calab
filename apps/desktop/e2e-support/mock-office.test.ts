import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IDS, startMockServer, type MockServer } from './mock-server';

// The office editor in the mock (ADR-0143) serves the server's contract (apps/server/internal/office):
// pnpm -F @calaba/desktop exec vitest run --config e2e-support/vitest.config.ts mock-office

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
  return ((await res.json()) as { tokens: { accessToken: string } }).tokens.accessToken;
}

const api = (token: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`${server.url}${path}`, {
    ...(body !== undefined ? { method: 'POST', body: JSON.stringify(body) } : {}),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });

type Item = { id: string; name: string; parentId?: string };
const WS = `/api/workspaces/${IDS.workspaces.main}`;

describe('office (ADR-0143)', () => {
  it('off by default: capabilities say so, config and create are 404', async () => {
    server.reset('data');
    const anna = await login('owner@calaba.test');
    expect(await (await api(anna, '/api/office/capabilities')).json()).toMatchObject({ enabled: false, formats: [] });
    const item = ((await (await api(anna, `${WS}/disk/items`)).json()) as { items: Item[] }).items.find((i) => i.name === 'Бюджет 2026.xlsx');
    expect((await api(anna, `/api/office/config?item=${item?.id}`)).status).toBe(404);
    expect((await api(anna, `${WS}/office/create`, { extension: 'docx' })).status).toBe(404);
  });

  it('on: the format map, the config of an item, «Создать» with a free name, «Сохранить как», «Сохранить в Диск»', async () => {
    server.reset('data');
    server.setOffice(true);
    const anna = await login('owner@calaba.test');
    const caps = (await (await api(anna, '/api/office/capabilities')).json()) as { enabled: boolean; docsUrl: string; formats: Array<{ extension: string; capability: string; convertTo?: string }> };
    expect(caps.enabled).toBe(true);
    expect(caps.docsUrl).toBe(server.url);
    expect(caps.formats.find((f) => f.extension === 'doc')).toMatchObject({ capability: 'OFFICE_CAPABILITY_CONVERT', convertTo: 'docx' });
    const items = ((await (await api(anna, `${WS}/disk/items`)).json()) as { items: Item[] }).items;
    const sheet = items.find((i) => i.name === 'Бюджет 2026.xlsx');
    const cfg = (await (await api(anna, `/api/office/config?item=${sheet?.id}&lang=ru`)).json()) as { mode: string; configJson: string; format: { extension: string } };
    expect(cfg.mode).toBe('OFFICE_MODE_EDIT');
    expect(cfg.format.extension).toBe('xlsx');
    expect(JSON.parse(cfg.configJson)).toMatchObject({ editorConfig: { region: 'ru-RU', customization: { compactHeader: true, goback: { requestClose: true } } } });

    const a = ((await (await api(anna, `${WS}/office/create`, { extension: 'docx', name: 'Новый документ', lang: 'ru' })).json()) as { item: Item }).item;
    const b = ((await (await api(anna, `${WS}/office/create`, { extension: 'docx', name: 'Новый документ', lang: 'ru' })).json()) as { item: Item }).item;
    expect([a.name, b.name]).toEqual(['Новый документ.docx', 'Новый документ (2).docx']);
    expect((await api(anna, `${WS}/office/create`, { extension: 'doc' })).status).toBe(422);

    const legacy = ((await (await api(anna, `${WS}/office/create`, { extension: 'xlsx', name: 'Старая' })).json()) as { item: Item }).item;
    expect((await api(anna, `/api/disk/items/${legacy.id}/office/convert`, {})).status).toBe(415);
    const att = IDS.files.legacyDoc;
    const conv = ((await (await api(anna, `${WS}/office/convert`, { fileId: att, parentId: '' })).json()) as { item: Item }).item;
    expect(conv.name).toBe('Договор (старый).docx');
    const imp = ((await (await api(anna, `${WS}/disk/import`, { fileId: att, parentId: '' })).json()) as { item: Item }).item;
    expect(imp.name).toBe('Договор (старый).doc');
  });
});
