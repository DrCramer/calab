import { useSyncExternalStore } from 'react';

/*
 * Whether the window is on screen (docs/14-energy.md: a hidden window runs no timers). On the
 * desktop `document.hidden` is the truthful one of lib/windowVisibility.ts (shown and not
 * minimized); on the web — the page's own. A clock leaf picks its ticker by this: none while hidden.
 */

const subscribe = (cb: () => void): (() => void) => {
  document.addEventListener('visibilitychange', cb);
  return () => document.removeEventListener('visibilitychange', cb);
};

const visible = (): boolean => !document.hidden;

export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribe, visible, () => true);
}
