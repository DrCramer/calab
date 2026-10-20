import { WorkspaceRole } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { gate, roomAllowed } from '../src/gate.js';

const WS = 'ws-1';
const member = (role: WorkspaceRole, user: Partial<{ isBot: boolean; isGuest: boolean }> = {}, workspaceId = WS) => ({
  workspaceId,
  role,
  user: { id: 'u1', isBot: false, isGuest: false, ...user },
});

describe('gate', () => {
  it('lets owner, admin and member in', () => {
    for (const r of [WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.MEMBER]) expect(gate(member(r), WS)).toEqual({ ok: true });
  });
  it('refuses guests by role and by account', () => {
    expect(gate(member(WorkspaceRole.GUEST), WS)).toEqual({ ok: false, reason: 'guest' });
    expect(gate(member(WorkspaceRole.MEMBER, { isGuest: true }), WS)).toEqual({ ok: false, reason: 'guest' });
  });
  it('refuses bots, even with a member role', () => {
    expect(gate(member(WorkspaceRole.MEMBER, { isBot: true }), WS)).toEqual({ ok: false, reason: 'bot' });
  });
  it('refuses non-members and members of another workspace', () => {
    expect(gate(null, WS)).toEqual({ ok: false, reason: 'not-member' });
    expect(gate({ workspaceId: WS, role: WorkspaceRole.MEMBER }, WS)).toEqual({ ok: false, reason: 'not-member' });
    expect(gate(member(WorkspaceRole.UNSPECIFIED), WS)).toEqual({ ok: false, reason: 'not-member' });
    expect(gate(member(WorkspaceRole.OWNER, {}, 'ws-2'), WS)).toEqual({ ok: false, reason: 'other-workspace' });
  });
  it('accepts DMs and rooms of the allowed workspace only', () => {
    expect(roomAllowed('', WS)).toBe(true);
    expect(roomAllowed(WS, WS)).toBe(true);
    expect(roomAllowed('ws-2', WS)).toBe(false);
  });
});
