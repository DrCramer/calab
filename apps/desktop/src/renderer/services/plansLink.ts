import { holdPlanAfterCreate, routePlansLink } from '../lib/billing/planLink';
import type { PlanLink } from '../lib/billing/plans';
import { usePrefs } from '../stores/prefs';
import { useSession } from '../stores/session';
import { useUi } from '../stores/ui';
import { useWorkspaces } from '../stores/workspaces';

/*
 * `/plans?plan=team|business` (the landing's «Купить»): after READY the plans dialog of the current
 * workspace with that plan marked; before it (signed out, still loading) the link waits in memory —
 * the web address keeps `/plans` until then, so a reload still finds it. Same shape as the other
 * links (services/canvasLink.ts); the dialog itself decides what a member without billing rights sees.
 */

let pending: { plan: PlanLink | null } | null = null;
let unwatch: (() => void) | null = null;

export function openPlansLink(plan: PlanLink | null): void {
  pending = { plan };
  if (useSession.getState().ready) {
    takePending();
    return;
  }
  unwatch ??= useSession.subscribe((s) => {
    if (!s.ready || !pending) return;
    unwatch?.();
    unwatch = null;
    takePending();
  });
}

function takePending(): void {
  const p = pending;
  pending = null;
  if (!p) return;
  // Web: the address bar had /plans?…; the app does not route by URL (a reload would reopen the dialog).
  if (import.meta.env.VITE_PLATFORM === 'web' && typeof location !== 'undefined' && location.pathname.startsWith('/plans')) {
    try {
      history.replaceState(null, '', '/');
    } catch {
      // not fatal
    }
  }
  const ui = useUi.getState();
  const list = Object.values(useWorkspaces.getState().byId).map((e) => ({ id: e.ws.id, role: e.role }));
  const route = routePlansLink(list, ui.activeWorkspaceId);
  if (route.kind === 'open') {
    if (ui.activeWorkspaceId !== route.workspaceId) ui.setWorkspace(route.workspaceId);
    ui.openDialog({ kind: 'billing-plans', workspaceId: route.workspaceId, ...(p.plan ? { plan: p.plan } : {}) });
    return;
  }
  // No workspace yet: the creation flow first (the first-run onboarding has its own step for it).
  holdPlanAfterCreate(p.plan);
  if (usePrefs.getState().onboarded) ui.openDialog({ kind: 'create-workspace' });
}
