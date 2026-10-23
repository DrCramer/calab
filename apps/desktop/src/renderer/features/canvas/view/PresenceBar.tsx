import { memo, useSyncExternalStore, type ReactNode } from 'react';
import { t, useLocale } from '../../../i18n';
import { PANEL } from './chrome';
import type { PresenceStore } from './presenceStore';
import { Tip, cx } from '../../../components/ui';
import type { CanvasEngine } from '../engine';
import { useEngineValue } from './hooks';

const MAX = 4;

/**
 * Who else is on the canvas, top right. A click on an avatar follows that person (the camera takes their center
 * and zoom, until our own pan or zoom); another click stops. Re-renders only when the set of people or the
 * followed person changes, never for cursor moves.
 */
export const Presence = memo(function Presence({ store, engine }: { store: PresenceStore; engine: CanvasEngine }): ReactNode {
  useLocale();
  const users = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const following = useEngineValue(engine, (s) => s.followKey);
  if (users.length === 0) return null;
  const shown = users.slice(0, MAX);
  const more = users.length - shown.length;
  const names = users.map((u) => u.name || '?').join(', ');
  return (
    <div
      role="group"
      aria-label={t('canvasBoard.presence.title', { names })}
      data-testid="canvas-presence"
      className={cx(PANEL, 'absolute right-3 top-3 z-10 flex items-center rounded-full px-1.5 py-1')}
    >
      {shown.map((u, i) => {
        const on = following === u.followKey;
        const label = t(on ? 'canvasBoard.presence.unfollow' : 'canvasBoard.presence.follow', { name: u.name || '?' });
        return (
          <Tip key={u.key} label={label} side="bottom">
            <button
              type="button"
              aria-label={label}
              aria-pressed={on}
              // The canvas keeps its keyboard focus (Delete, arrows) when an avatar is pressed.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => engine.follow(on ? null : u.followKey)}
              data-testid="canvas-presence-user"
              data-following={on ? '' : undefined}
              className={cx(
                'grid size-6 place-items-center rounded-full text-micro font-semibold text-white ring-2',
                on ? 'ring-accent' : 'ring-[var(--color-popover)]',
                i > 0 && '-ml-1.5',
              )}
              style={{ background: u.color }}
            >
              {(Array.from(u.name.trim())[0] ?? '?').toUpperCase()}
            </button>
          </Tip>
        );
      })}
      {more > 0 ? <span className="ml-1 px-1 text-caption text-muted">{t('canvasBoard.presence.more', { n: more })}</span> : null}
    </div>
  );
});
