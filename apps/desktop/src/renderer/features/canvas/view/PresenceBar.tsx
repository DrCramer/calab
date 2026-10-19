import { memo, useSyncExternalStore, type ReactNode } from 'react';
import { t, useLocale } from '../../../i18n';
import { PANEL } from './chrome';
import type { PresenceStore } from './presenceStore';
import { cx } from '../../../components/ui';

const MAX = 4;

/** Who else is on the canvas, top right. Re-renders only when the set of people changes, never for cursor moves. */
export const Presence = memo(function Presence({ store }: { store: PresenceStore }): ReactNode {
  useLocale();
  const users = useSyncExternalStore(store.subscribe, store.getSnapshot);
  if (users.length === 0) return null;
  const shown = users.slice(0, MAX);
  const more = users.length - shown.length;
  const names = users.map((u) => u.name || '?').join(', ');
  return (
    <div
      role="group"
      aria-label={t('canvasBoard.presence.title', { names })}
      title={t('canvasBoard.presence.title', { names })}
      data-testid="canvas-presence"
      className={cx(PANEL, 'absolute right-3 top-3 z-10 flex items-center rounded-full px-1.5 py-1')}
    >
      {shown.map((u, i) => (
        <span
          key={u.key}
          data-testid="canvas-presence-user"
          className={cx('grid size-6 place-items-center rounded-full text-micro font-semibold text-white ring-2 ring-[var(--color-popover)]', i > 0 && '-ml-1.5')}
          style={{ background: u.color }}
        >
          {(Array.from(u.name.trim())[0] ?? '?').toUpperCase()}
        </span>
      ))}
      {more > 0 ? <span className="ml-1 px-1 text-caption text-muted">{t('canvasBoard.presence.more', { n: more })}</span> : null}
    </div>
  );
});
