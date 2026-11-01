import { platform } from '../platform';

/**
 * The click handler of a system notification (ADR-0141): the window comes to the front first —
 * restored when minimized, shown when the close button hid it (the app lives in the tray) — then
 * `open` leads to the source. In the page `window.focus()` alone does neither in Electron. `show`
 * is injectable for tests.
 */
export function toSource(open: () => void, show: () => void = () => platform.app.showWindow()): () => void {
  return () => {
    show();
    open();
  };
}
