import { X } from 'lucide-react';
import { memo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { IconButton, cx } from '../../../components/ui';
import { plural, t, useLocale } from '../../../i18n';
import { PANEL } from './chrome';
import type { PresenceStore } from './presenceStore';

/**
 * What the phone viewer draws over the canvas besides the zoom bar and the connection notices
 * (ADR-0113 §5: view only): the count of the others on the canvas — no avatars, no cursors — and the
 * one-time «editing is not available on the phone» note. Both are leaves with their own subscription.
 */

/** «ещё N на холсте», bottom left. Re-renders only when the number of people changes. */
export const PhoneOthers = memo(function PhoneOthers({ store }: { store: PresenceStore }): ReactNode {
  useLocale();
  const n = useSyncExternalStore(store.subscribe, () => store.getSnapshot().length);
  if (n === 0) return null;
  return (
    <div role="status" data-testid="canvas-others" className={cx(PANEL, 'absolute bottom-3 left-3 z-10 rounded-full px-3 py-2 text-control text-muted')}>
      {plural('canvasPhone.others', n)}
    </div>
  );
});

export const NOTE_KEY = 'calaba-canvas-phone-note';

/** The note is shown on the first canvas this device opens, then never again (a private window shows it each time). */
function takeNote(): boolean {
  try {
    if (localStorage.getItem(NOTE_KEY) === '1') return false;
    localStorage.setItem(NOTE_KEY, '1');
  } catch {
    // Storage is blocked: the note is harmless to show.
  }
  return true;
}

/** A small plate above the zoom bar; «Понятно» (or the cross) closes it. */
export function PhoneNote(): ReactNode {
  useLocale();
  const [open, setOpen] = useState(takeNote);
  if (!open) return null;
  return (
    <div role="note" data-testid="canvas-phone-note" className={cx(PANEL, 'absolute inset-x-3 bottom-[64px] z-10 flex items-start gap-2 px-3 py-2 text-control text-fg')}>
      <p className="min-w-0 flex-1">{t('canvasPhone.note')}</p>
      <IconButton label={t('canvasPhone.dismiss')} tip={false} size="sm" onClick={() => setOpen(false)} data-testid="canvas-phone-note-close">
        <X className="size-4" aria-hidden />
      </IconButton>
    </div>
  );
}
