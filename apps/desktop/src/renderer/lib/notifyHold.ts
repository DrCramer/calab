/**
 * Keeps a system notification reachable until it is clicked or closed. A `Notification` nobody
 * references is garbage-collected, and with it its `onclick`: on Windows the toast then only
 * activates the window (no navigation, or the app stays on whatever was open before). Returns the
 * notification for chaining. Pure bookkeeping over the object's own events (tests).
 */
const held = new Set<object>();

interface Releasable {
  addEventListener(type: 'click' | 'close' | 'error', fn: () => void): void;
}

export function holdNotification<T extends Releasable>(n: T): T {
  held.add(n);
  const release = (): void => void held.delete(n);
  n.addEventListener('click', release);
  n.addEventListener('close', release);
  n.addEventListener('error', release);
  return n;
}

/** Notifications currently kept alive (tests). */
export function heldNotificationCount(): number {
  return held.size;
}
