import { useEffect, type RefObject } from 'react';
import { quickLook } from '../../services/disk';
import { useDisk } from '../../stores/disk';
import { useDiskUi } from '../../stores/diskUi';
import { useUi } from '../../stores/ui';

/** Keys that keep Space for themselves: fields, buttons, menus, sliders, switches. */
const OWN_SPACE = 'input, textarea, select, button, a, [contenteditable="true"], [role="menu"], [role="menuitem"], [role="slider"], [role="switch"], [role="dialog"]';

/**
 * Quick Look (CBF-22): Space previews the selected file of the mounted Disk view — a picture, a
 * video, a PDF, audio, text — or opens its card; ←/→ then step inside the viewer. Works with the
 * selection (`diskUi.selected`), wherever the focus is on the screen, so every view of the Disk
 * (tiles, list, columns) shares it. `shown`: the view's visible ids in order.
 */
export function useQuickLook(shown: RefObject<readonly string[]>, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== ' ' || e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if (useUi.getState().dialog || useDiskUi.getState().dialog || useDiskUi.getState().renaming) return;
      if (e.target instanceof Element && e.target.closest(OWN_SPACE)) return;
      const id = useDiskUi.getState().selected;
      const item = id ? useDisk.getState().items[id] : undefined;
      if (!item) return;
      e.preventDefault();
      quickLook(item, shown.current);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shown, enabled]);
}
