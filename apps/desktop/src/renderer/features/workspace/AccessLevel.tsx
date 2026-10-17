import { Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import type { AccessLevel } from '../../lib/permissions';
import { useOwnerSeesPrivate } from '../people/PrivateAccess';

/*
 * «Кто видит» of a room / board as two levels (addenda 2026-10-14 to ADR-0058 / ADR-0078; owner,
 * 14.10: «публичная — для всех в пространстве, или приватная — видна только автору и тем, кого
 * добавили»): «Для всех в пространстве» · «Только приглашённые / выбранные — не видят даже
 * администраторы и владелец». While «Владелец видит приватное» is on the second label drops the
 * owner (the list then shows the owner as a fixed row). Radio rows with a one-line hint each.
 */

export function AccessLevelPicker({
  value,
  onChange,
  disabled,
  kind,
  workspaceId,
}: {
  value: AccessLevel;
  onChange: (v: AccessLevel) => void;
  disabled: boolean;
  /** A room says «приглашённые», a board «выбранные». */
  kind: 'room' | 'board';
  workspaceId: string;
}): ReactNode {
  const sees = useOwnerSeesPrivate(workspaceId);
  const privateLabel: MessageKey =
    kind === 'room' ? (sees ? 'access.privateRoomOwner' : 'access.privateRoom') : sees ? 'access.privateBoardOwner' : 'access.privateBoard';
  const options: ReadonlyArray<{ v: AccessLevel; label: MessageKey; hint: MessageKey }> = [
    { v: 'all', label: 'access.all', hint: 'access.allHint' },
    { v: 'private', label: privateLabel, hint: 'access.privateHint' },
  ];
  return (
    <div role="radiogroup" aria-label={t('room.accessCard')} className="flex flex-col" data-testid="access-level">
      {options.map((o) => {
        const on = value === o.v;
        return (
          <button
            key={o.v}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => !on && onChange(o.v)}
            data-testid={`access-level-${o.v}`}
            className="flex min-h-11 items-center gap-3 px-3 py-2 text-left enabled:hover:bg-hover disabled:cursor-default"
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex items-center gap-1.5 text-body">
                {t(o.label)}
                {o.v === 'private' ? <Lock className="size-3.5 shrink-0 text-muted" aria-hidden /> : null}
              </span>
              <span className="text-caption text-faint">{t(o.hint)}</span>
            </span>
            <span
              className={cx('grid size-4 shrink-0 place-items-center rounded-full border', on ? 'border-accent bg-accent' : 'border-[var(--color-fill-hover)]')}
              aria-hidden
            >
              {on ? <span className="size-1.5 rounded-full bg-white" /> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
