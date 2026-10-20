import * as Dropdown from '../../components/radix/dropdown-menu';
import { Check, Pencil, Tag } from 'lucide-react';
import { memo, useState, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { Button, Tip, cx } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { useBadgeList } from '../../stores/workspaces';
import { BadgeImage } from '../people/MemberBadge';
import { menuBox, menuItem, menuLabel } from '../shell/menu';
import { decide } from './services/admissions';
import { useKnock } from './stores/admissions';

/** Guest names on admission: 1..40 (ADR-0040 §6). */
export const NAME_MAX = 40;

/**
 * One waiting guest in «Ожидают подтверждения» (ADR-0040 §5): avatar and name (click → inline
 * field, Enter saves, Esc cancels — the name the guest gets on admission), a badge from the
 * workspace library (the same «Нет» + library as the member badge in the profile), «Пустить» /
 * «Отклонить». Memoised with primitive props; reads its knock by room + user id, so another knock
 * does not re-render it. The choices stay local until «Пустить» sends them with the decision.
 */
export const AdmissionRow = memo(function AdmissionRow({ workspaceId, roomId, userId }: { workspaceId: string; roomId: string; userId: string }): ReactNode {
  useLocale();
  const a = useKnock(roomId, userId);
  const original = a?.user?.displayName ?? '';
  const [name, setName] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [badgeId, setBadgeId] = useState('');
  if (!a) return null;
  const shown = name ?? original;

  const save = (): void => {
    const v = (draft ?? '').trim();
    if (v) setName(v === original ? null : Array.from(v).slice(0, NAME_MAX).join(''));
    setDraft(null);
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-[var(--radius-row)] px-2 py-1.5" data-testid="admission-row" data-user-id={userId}>
      <div className="flex min-w-0 items-center gap-2">
        <Avatar userId={userId} name={shown} fileId={a.user?.avatarFileId || undefined} size={24} />
        {draft !== null ? (
          <input
            autoFocus
            aria-label={t('adm.nameLabel')}
            title={t('adm.nameHint')}
            value={draft}
            maxLength={NAME_MAX}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                save();
              } else if (e.key === 'Escape') {
                // The field only: Esc must not also close a floating members panel.
                e.preventDefault();
                e.stopPropagation();
                setDraft(null);
              }
            }}
            onBlur={save}
            className="selectable h-6 min-w-0 flex-1 rounded-[var(--radius-control)] border border-line bg-elev px-2 text-body text-fg mobile:h-8"
          />
        ) : (
          <button
            type="button"
            aria-label={t('adm.rename', { name: shown })}
            title={t('adm.nameLabel')}
            onClick={() => setDraft(shown)}
            className="group/name flex h-6 min-w-0 flex-1 items-center gap-1 rounded-[var(--radius-control)] px-1 text-left hover:bg-hover"
          >
            <span className="truncate text-body font-medium">{shown}</span>
            <Pencil className="size-3 shrink-0 text-muted opacity-0 group-hover/name:opacity-100 group-focus-visible/name:opacity-100" aria-hidden />
          </button>
        )}
        <BadgePick workspaceId={workspaceId} value={badgeId} onChange={setBadgeId} />
      </div>
      <div className="flex gap-1.5 pl-8">
        <Button
          size="sm"
          className="flex-1"
          aria-label={t('adm.admitName', { name: shown })}
          onClick={() => void decide(roomId, userId, { admit: true, ...(name !== null ? { displayName: name } : {}), ...(badgeId ? { badgeId } : {}) })}
        >
          {t('adm.admit')}
        </Button>
        <Button size="sm" variant="secondary" className="flex-1" aria-label={t('adm.declineName', { name: shown })} onClick={() => void decide(roomId, userId, { admit: false })}>
          {t('adm.decline')}
        </Button>
      </div>
    </div>
  );
});

/** The badge for the guest: an icon button (the chosen badge, else a tag) → «Нет» + the library. Nothing without badges. */
function BadgePick({ workspaceId, value, onChange }: { workspaceId: string; value: string; onChange: (id: string) => void }): ReactNode {
  const badges = useBadgeList(workspaceId);
  if (badges.length === 0) return null;
  const chosen = badges.find((b) => b.id === value);
  const label = t('adm.badgeOf', { badge: chosen?.name ?? t('badges.none') });
  return (
    <Dropdown.Root modal={false}>
      <Tip label={label}>
        <Dropdown.Trigger asChild>
          <button
            type="button"
            aria-label={label}
            data-testid="admission-badge"
            className={cx(
              'grid size-6 shrink-0 place-items-center rounded-[var(--radius-control)] text-muted transition-colors duration-[var(--motion-fast)] hover:bg-hover hover:text-fg data-[state=open]:bg-active',
            )}
          >
            {chosen ? <BadgeImage fileId={chosen.fileId} name={chosen.name} /> : <Tag className="size-3.5" strokeWidth={1.75} aria-hidden />}
          </button>
        </Dropdown.Trigger>
      </Tip>
      <Dropdown.Portal>
        <Dropdown.Content className={cx(menuBox, 'min-w-44')} side="bottom" align="end" sideOffset={4} collisionPadding={16}>
          <Dropdown.Label className={menuLabel}>{t('badges.member')}</Dropdown.Label>
          <Dropdown.RadioGroup value={value} onValueChange={onChange}>
            <Dropdown.RadioItem value="" className={cx(menuItem, 'relative pl-7')}>
              <Dropdown.ItemIndicator className="absolute left-2">
                <Check className="size-3.5" aria-hidden />
              </Dropdown.ItemIndicator>
              {t('badges.none')}
            </Dropdown.RadioItem>
            {badges.map((b) => (
              <Dropdown.RadioItem key={b.id} value={b.id} className={cx(menuItem, 'relative pl-7')}>
                <Dropdown.ItemIndicator className="absolute left-2">
                  <Check className="size-3.5" aria-hidden />
                </Dropdown.ItemIndicator>
                <BadgeImage fileId={b.fileId} name={b.name} />
                <span className="truncate">{b.name}</span>
              </Dropdown.RadioItem>
            ))}
          </Dropdown.RadioGroup>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
