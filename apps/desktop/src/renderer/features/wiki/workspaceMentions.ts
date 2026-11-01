import { filterCandidates, type MentionCandidate } from '../../lib/mentions';
import { memberName, useWorkspaces } from '../../stores/workspaces';
import type { MentionSource } from './editor/types';

/**
 * The members of a workspace for the rich editor's `@` (wiki pages, task descriptions), read at
 * call time (no subscription: typing `@` is rare). `me` is left out of the candidates.
 */
export function workspaceMentions(workspaceId: string, me: string): MentionSource {
  return {
    search: (q) => {
      const members = useWorkspaces.getState().byId[workspaceId]?.members ?? {};
      const list: MentionCandidate[] = [];
      for (const m of Object.values(members)) {
        const u = m.user;
        if (!u || u.id === me) continue;
        const name = m.nickname || u.displayName;
        list.push({
          id: u.id,
          name,
          alt: m.nickname && m.nickname !== u.displayName ? [u.displayName] : [],
          ...(u.username ? { nick: u.username } : {}),
        });
      }
      return filterCandidates(q, list);
    },
    label: (id) => (useWorkspaces.getState().byId[workspaceId]?.members[id] ? memberName(workspaceId, id) : undefined),
  };
}
