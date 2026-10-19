/** «Who is on the canvas»: a tiny external store fed from awareness, outside React and Zustand. */
import type { PeerState } from '../engine';

export interface PresenceUser {
  key: string;
  name: string;
  color: string;
}

export class PresenceStore {
  private users: readonly PresenceUser[] = [];
  private sig = '';
  private readonly subs = new Set<() => void>();

  /**
   * Replaces the participants. The same person in two windows (same name and color) shows once. Cursor
   * moves arrive here too but change nothing visible, so subscribers are told only when the set differs.
   */
  set(peers: readonly PeerState[]): void {
    const seen = new Map<string, PresenceUser>();
    for (const p of peers) {
      const key = `${p.name}\u0000${p.color}`;
      if (!seen.has(key)) seen.set(key, { key, name: p.name, color: p.color });
    }
    const next = [...seen.values()];
    const sig = next.map((u) => u.key).join('\u0001');
    if (sig === this.sig) return;
    this.sig = sig;
    this.users = next;
    for (const fn of this.subs) fn();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  };

  getSnapshot = (): readonly PresenceUser[] => this.users;
}
