// Who may use Mr.Claude: a person who is a full member of the allowed workspace (owner / admin /
// member role), not a guest account and not a bot. Checked on the server's answer for every request.
import { WorkspaceRole } from '@calaba/protocol';

export interface MemberLike {
  workspaceId: string;
  role: WorkspaceRole;
  user?: { id: string; isBot: boolean; isGuest: boolean } | undefined;
}

export type GateResult = { ok: true } | { ok: false; reason: 'not-member' | 'guest' | 'bot' | 'other-workspace' };

const FULL_ROLES = new Set([WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.MEMBER]);

export function gate(member: MemberLike | null | undefined, allowedWorkspaceId: string): GateResult {
  if (!member?.user) return { ok: false, reason: 'not-member' };
  if (member.workspaceId !== allowedWorkspaceId) return { ok: false, reason: 'other-workspace' };
  if (member.user.isBot) return { ok: false, reason: 'bot' };
  if (member.user.isGuest || member.role === WorkspaceRole.GUEST) return { ok: false, reason: 'guest' };
  if (!FULL_ROLES.has(member.role)) return { ok: false, reason: 'not-member' };
  return { ok: true };
}

/**
 * Where a request may come from: a DM, or a room of the allowed workspace (a /check or a mention in a
 * room of another workspace the bot was added to is ignored).
 */
export function roomAllowed(roomWorkspaceId: string, allowedWorkspaceId: string): boolean {
  return roomWorkspaceId === '' || roomWorkspaceId === allowedWorkspaceId;
}
