/**
 * docs/09 #118: a modal Radix Dialog locks scroll with react-remove-scroll: it cancels every
 * wheel/touchmove at the document unless the target is inside the Overlay's React subtree or the
 * Content's DOM. Popovers, dropdown menus, selects and context menus are portaled to <body>, so
 * inside a dialog (create task → assignees, task panel pickers, emoji picker) their lists could
 * not scroll.
 *
 * One delegate for all of them: Radix wraps every popper-positioned content in
 * `[data-radix-popper-content-wrapper]`, and custom portals opt in with `data-scroll-shard`. The
 * listener sits on <body> (bubble phase), i.e. below the lock's document listener, and stops the
 * event there: the lock never sees it, the browser still scrolls the list under the pointer.
 * Nothing behind a popover moves: the body is not scrollable and lists use overscroll-contain.
 * The idle tracker listens in the capture phase on window and is unaffected.
 *
 * Wheel inside a dialog's own content (task #1, touchpads): even there the lock judges every
 * wheel event and picks its axis by the larger delta. A precision touchpad (Windows) sends
 * vertical swipes with a little deltaX; whenever |deltaX| > |deltaY| and nothing under the
 * pointer scrolls sideways the event is cancelled, so touchpad scrolling in dialogs stutters
 * or stops while a mouse wheel (pure deltaY) always works. The dialog content is portaled to
 * <body>, which does not scroll, so native scrolling there needs no lock: wheel events inside
 * `[role=dialog]` skip it too. Touch is left to the lock (phones rely on it against the
 * rubber band).
 */
const SHARD = '[data-radix-popper-content-wrapper],[data-scroll-shard]';
const WHEEL_SHARD = `${SHARD},[role="dialog"],[role="alertdialog"]`;

function stopTouchInPopover(e: Event): void {
  const t = e.target;
  if (t instanceof Element && t.closest(SHARD)) e.stopPropagation();
}

function stopWheelInPopover(e: Event): void {
  const t = e.target;
  if (t instanceof Element && t.closest(WHEEL_SHARD)) e.stopPropagation();
}

/** Installs the delegate once per document; returns the uninstall function. */
export function installPopoverScroll(doc: Document = document): () => void {
  const body = doc.body;
  body.addEventListener('wheel', stopWheelInPopover, { passive: true });
  body.addEventListener('touchmove', stopTouchInPopover, { passive: true });
  return () => {
    body.removeEventListener('wheel', stopWheelInPopover);
    body.removeEventListener('touchmove', stopTouchInPopover);
  };
}
