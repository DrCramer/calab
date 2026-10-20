/** The app's wiring of the Canvas screen: platform auth, the real WebSocket, the signed-in person. */
import { platform } from '../../../platform';
import { useSession } from '../../../stores/session';
import { memberName, useWorkspaces } from '../../../stores/workspaces';
import type { CanvasViewDeps } from './session';

export function appDeps(workspaceId: string): CanvasViewDeps {
  return {
    serverUrl: () => useSession.getState().serverUrl || window.location.origin,
    getToken: () => platform.auth.accessToken(),
    refreshToken: () => platform.auth.forceRefresh(),
    createSocket: (url) => new WebSocket(url),
    serverClockOffset: async () => {
      // One light request: the server's `Date` (whole seconds; +½ s) against our clock around the round trip.
      const t0 = Date.now();
      const res = await fetch(`${useSession.getState().serverUrl || window.location.origin}/api/version`, { cache: 'no-store' });
      const t1 = Date.now();
      const date = res.headers.get('Date');
      const server = date ? Date.parse(date) : NaN;
      return Number.isFinite(server) ? server + 500 - (t0 + t1) / 2 : null;
    },
    user: () => {
      const id = useSession.getState().me?.user?.id ?? '';
      const known = id && useWorkspaces.getState().byId[workspaceId]?.members[id];
      return { id, name: known ? memberName(workspaceId, id) : (useSession.getState().me?.user?.displayName ?? '') };
    },
  };
}
