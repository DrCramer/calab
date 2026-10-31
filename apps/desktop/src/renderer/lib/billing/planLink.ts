import { WorkspaceRole } from '@calaba/protocol';
import type { PlanLink } from './plans';

/**
 * The plans deep link of the landing's «Купить» buttons: `https://<server>/plans?plan=team|business`
 * (web client) and `calab://plans?plan=…` (desktop). Pure parsing and the routing decision; the
 * opening itself is services/plansLink.ts. An unknown `plan` still opens the dialog, unmarked.
 */

const SCHEME = 'calaba?';

/** null = not a plans link; `plan: null` = a plans link without a (known) plan. */
export function parsePlansLink(input: string): { plan: PlanLink | null } | null {
  const s = input.trim();
  const m = new RegExp(`^${SCHEME}://plans/?(\\?[^#]*)?(?:#.*)?$`).exec(s) ?? /^https?:\/\/[^/\s]+\/plans\/?(\?[^#]*)?(?:#.*)?$/.exec(s);
  if (!m) return null;
  const v = new URLSearchParams(m[1] ?? '').get('plan')?.trim().toLowerCase();
  return { plan: v === 'team' || v === 'business' ? v : null };
}

export type PlansRoute = { kind: 'open'; workspaceId: string } | { kind: 'create' };

/**
 * Where a plans link goes once the session is ready: the dialog of the active workspace (else the
 * workspace the person owns, else the first); no workspace at all — the creation flow first, the
 * plans dialog follows it (offerPlansAfterCreate).
 */
export function routePlansLink(workspaces: ReadonlyArray<{ id: string; role: WorkspaceRole }>, activeId: string | null): PlansRoute {
  const real = workspaces.filter((w) => w.role !== WorkspaceRole.GUEST);
  const pick = real.find((w) => w.id === activeId) ?? real.find((w) => w.role === WorkspaceRole.OWNER) ?? real[0];
  return pick ? { kind: 'open', workspaceId: pick.id } : { kind: 'create' };
}

let afterCreate: PlanLink | null | undefined;

/** The create-workspace flow was started by a plans link: its plans dialog gets the link's plan. */
export function holdPlanAfterCreate(plan: PlanLink | null): void {
  afterCreate = plan;
}

/** undefined = no link waits for the creation; null = a link without a plan. */
export function takePlanAfterCreate(): PlanLink | null | undefined {
  const p = afterCreate;
  afterCreate = undefined;
  return p;
}
