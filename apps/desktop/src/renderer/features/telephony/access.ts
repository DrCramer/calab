import { WorkspaceRole } from '@calaba/protocol';
import { can, workspacePerms } from '../../lib/permissions';
import { planHas } from '../../lib/plan';
import { telephonyVisible } from '../../lib/telephonyAccess';
import { myUserId, useSession } from '../../stores/session';
import { rolesOf, useWorkspaces, type WorkspaceEntry } from '../../stores/workspaces';

/**
 * The «Телефония» gates as primitives (CLAUDE.md «Ререндеры»): the rail tile, the phone's «Ещё»
 * and the section read one boolean each, re-rendered only when it flips.
 */

const NONE = { visible: false, viewJournals: false, placeCalls: false, manage: false };

function rights(e: WorkspaceEntry | undefined, me: string): { visible: boolean; viewJournals: boolean; placeCalls: boolean; manage: boolean } {
  // Cheap until telephony is connected or on the plan: no permission math for the workspaces without it.
  if (!e) return NONE;
  const plan = planHas(e.ws.plan, 'telephony');
  if (!e.ws.sipEnabled && !plan) return NONE;
  const bits = workspacePerms(rolesOf(e, me));
  const r = { placeCalls: can(bits, 'PLACE_CALLS'), viewJournals: can(bits, 'VIEW_JOURNALS'), manage: can(bits, 'MANAGE_INTEGRATIONS') };
  const visible = telephonyVisible({
    guest: e.role === WorkspaceRole.GUEST,
    sipEnabled: e.ws.sipEnabled,
    placeCalls: r.placeCalls,
    extension: e.members[me]?.extension ?? '',
    viewJournals: r.viewJournals,
    manageIntegrations: r.manage,
    planTelephony: plan,
  });
  return { visible, ...r };
}

/** The section is shown for `ws` (ADR-0137 §5). */
export function useTelephonyVisible(ws: string | null | undefined): boolean {
  const me = useSession((s) => s.me?.user?.id ?? '');
  return useWorkspaces((s) => (ws ? rights(s.byId[ws], me).visible : false));
}

/** «Все звонки» / «Сотрудник…» (VIEW_JOURNALS). */
export function useMayReadAll(ws: string): boolean {
  const me = useSession((s) => s.me?.user?.id ?? '');
  return useWorkspaces((s) => rights(s.byId[ws], me).viewJournals);
}

/** The live calls' steps of everyone (ADR-0128): MANAGE_INTEGRATIONS. */
export function useMayManageTelephony(ws: string): boolean {
  const me = useSession((s) => s.me?.user?.id ?? '');
  return useWorkspaces((s) => rights(s.byId[ws], me).manage);
}

/** Telephony is connected (Workspace.sip_enabled): the journal and calling make sense; else the administrator sets it up. */
export function useTelephonyConnected(ws: string): boolean {
  return useWorkspaces((s) => !!s.byId[ws]?.ws.sipEnabled);
}

/** «Позвонить» over the trunk (ADR-0137 §3): PLACE_CALLS of the workspace (the server checks the rest). */
export function usePlaceCalls(ws: string): boolean {
  const me = useSession((s) => s.me?.user?.id ?? '');
  return useWorkspaces((s) => rights(s.byId[ws], me).placeCalls);
}

export function placeCallsNow(ws: string): boolean {
  return rights(useWorkspaces.getState().byId[ws], myUserId()).placeCalls;
}

/** Somebody else (a person) has an internal number: the dial pad can call them (ADR-0137 §3.8). */
export function useHasExtensions(ws: string): boolean {
  const me = useSession((s) => s.me?.user?.id ?? '');
  return useWorkspaces((s) => Object.values(s.byId[ws]?.members ?? {}).some((m) => !!m.extension && m.user?.id !== me && !m.user?.isBot));
}

/** May I delete this contact: its author or MANAGE_INTEGRATIONS (the server checks). */
export function useMayDeleteContact(ws: string, createdBy: string): boolean {
  const me = useSession((s) => s.me?.user?.id ?? '');
  const manage = useWorkspaces((s) => rights(s.byId[ws], me).manage);
  return manage || (!!createdBy && createdBy === me);
}

/** Outside React (⌘K, the phone's tab list). */
export function telephonyVisibleNow(ws: string | null | undefined): boolean {
  return ws ? rights(useWorkspaces.getState().byId[ws], myUserId()).visible : false;
}
