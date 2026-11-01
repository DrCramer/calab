import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { Plan, SipCallDirection, SipCallSchema, SipCallStatus, SipGroupStrategy, SipRouteKind, WorkspacePlanSchema } from '@calaba/protocol';
import { ENTERPRISE_PLAN_LIMITS, RECORDING_RESULT } from '../e2e-support/fixtures';
import { IDS } from '../e2e-support/mock-server';
import type { MockServer } from '../e2e-support/mock-server';
import { NOW } from '../e2e-visual/harness';
import type { Copy } from './copy';
import type { Copy4 } from './copy4';

/**
 * Landing v6: the telephony exchange, the roles and the recording result of the mock, renamed and
 * filled for the page language (set before the client signs in; no app source is touched).
 */
const U = IDS.users;
const W = IDS.workspaces.main;

interface Pbx {
  exts: { id: string; number: string; description: string }[];
  groups: { id: string; name: string; strategy: SipGroupStrategy; fallbackEnabled: boolean; fallbackSec: number; onFail?: { kind: SipRouteKind; id: string; missing?: boolean } }[];
  menus: { id: string; name: string; items: { digit: string; action: { kind: SipRouteKind; id: string; missing?: boolean } }[] }[];
}

/** Telephony of the workspace as an admin left it: the account on, two groups, two menus, numbers, three live calls and a journal. */
export function seedTelephony(mock: MockServer, _c: Copy, c4: Copy4, withCalls = true): void {
  const t = c4.tel;
  const ws = mock.state.workspaces.get(W);
  if (ws) ws.plan = create(WorkspacePlanSchema, { plan: Plan.ENTERPRISE, limits: ENTERPRISE_PLAN_LIMITS, validUntil: timestampFromMs(Date.parse('2026-12-31T23:59:59Z')), expired: false });
  mock.setSip(W, { enabled: true, host: 'sip.zadarma.com', callerId: '+74951230099', allowedPrefixes: ['+7', '+1', '+34', '+44', '+86'], hasPassword: true });
  mock.seedSipExchange();
  mock.setSipRegistration('registered');
  const p = mock.state.sipPbx.get(W) as unknown as Pbx;
  const [sales, support] = p.groups;
  const main = p.menus.find((m) => m.name === 'Главное меню');
  const off = p.menus.find((m) => m.name === 'Выходные');
  if (!sales || !support || !main || !off) throw new Error('no exchange');
  sales.name = t.groups[0];
  sales.strategy = SipGroupStrategy.RING_ALL;
  sales.fallbackEnabled = true;
  sales.fallbackSec = 20;
  sales.onFail = { kind: SipRouteKind.GROUP, id: support.id };
  support.name = t.groups[1];
  support.strategy = SipGroupStrategy.ROUND_ROBIN;
  support.fallbackEnabled = false;
  main.name = t.menus[0];
  off.name = t.menus[1];
  main.items = [
    { digit: '1', action: { kind: SipRouteKind.GROUP, id: sales.id } },
    { digit: '2', action: { kind: SipRouteKind.GROUP, id: support.id } },
    { digit: '0', action: { kind: SipRouteKind.HANGUP, id: '' } },
  ];
  const ext = (n: string, d: string): void => {
    const e = p.exts.find((x) => x.number === n);
    if (e) e.description = d;
  };
  ext('100', t.ext[0]);
  ext('101', t.ext[1]);
  ext('103', t.ext[2]);

  if (!withCalls) return;
  // The live calls (the menu, a ringing group, a talk) and three finished ones for the journal; times follow the page clock.
  const call = (number: string, ago: number, extra: MessageInitShape<typeof SipCallSchema>): void => {
    const id = `00000000-0000-7000-8000-00000000b${String(mock.state.sipCalls.size + 1).padStart(3, '0')}`;
    mock.state.sipCalls.set(
      id,
      create(SipCallSchema, { id, workspaceId: W, number, direction: SipCallDirection.IN, status: SipCallStatus.RINGING, startedAt: timestampFromMs(NOW.getTime() - ago), participantIdentity: `sip_${number}`, ...extra }),
    );
  };
  call(t.calls[0], 8_000, { route: 'menu', via: t.menus[0] });
  call(t.calls[1], 21_000, { route: 'group', via: t.groups[0], ringingUserIds: [U.boris, U.vera] });
  call('+74957001122', 134_000, { status: SipCallStatus.ACTIVE, answeredBy: U.vera, answeredAt: timestampFromMs(NOW.getTime() - 120_000), route: 'ext' });
  const done = (number: string, ago: number, talk: number, by: string): void =>
    call(number, ago, { status: SipCallStatus.ENDED, answeredBy: by, answeredAt: timestampFromMs(NOW.getTime() - ago + 6_000), endedAt: timestampFromMs(NOW.getTime() - ago + talk), route: 'group', via: t.groups[0] });
  done('+74951112233', 52 * 60_000, 3 * 60_000, U.boris);
}

/** Custom roles «Поддержка» (blue) and the second one, held by Вера and Григорий. */
export function seedRoles(mock: MockServer, _c: Copy, c4: Copy4): void {
  const roles = mock.state.roles.get(W) ?? [];
  const design = roles.find((r) => r.id === IDS.roles.design);
  const moderator = roles.find((r) => r.id === IDS.roles.moderator);
  if (design) design.name = c4.role.name;
  if (moderator) moderator.name = c4.role.other;
  mock.setMemberRoles(W, U.vera, [IDS.roles.design]);
  mock.setMemberRoles(W, U.grigory, [IDS.roles.design, IDS.roles.moderator]);
}

/** The recording's summary and transcript in the page language (the mock serves them from RECORDING_RESULT). */
export function seedRecordingText(c4: Copy4): void {
  const r = RECORDING_RESULT as unknown as { summary: string; transcript: { speaker: number; startMs: number; endMs: number; text: string }[] };
  r.summary = c4.rec.summary;
  r.transcript.forEach((seg, i) => {
    seg.text = c4.rec.transcript[i] ?? seg.text;
  });
}
