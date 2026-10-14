import { PermissionTargetType, WorkspaceRole } from '@calaba/protocol';
import { Plus, UserRoundCheck, X } from 'lucide-react';
import { memo, useMemo, useState, type ReactNode } from 'react';
import { confirmAction } from '../../components/Confirm';
import type { PickerGroup } from '../../components/picker/pickerModel';
import { Button, IconButton, Select, Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { mayTakeOver } from '../../lib/permissions';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { memberName, useMemberName, useWorkspaces } from '../../stores/workspaces';
import { MemberAvatar } from '../boards/menus';
import { RoleMark, roleName } from './MemberBits';
import { MemberPicker } from './MemberPicker';
import { memberItems, type PeoplePickItem, type RolePickItem } from './memberPickItems';

/*
 * Private rooms, boards and tree items (addenda 2026-10-14 to ADR-0058 / ADR-0078 / ADR-0094 /
 * ADR-0096): the pieces every «Только выбранные / приглашённые» editor shares — the fixed rows (the
 * creator; the workspace owner while «Владелец видит приватное» is on: display-only, never an
 * override), «Сделать меня владельцем» for a former member's item, and the chosen list of the
 * create dialogs. Selectors return primitives (CLAUDE.md, re-renders).
 */

/** Workspace.ownerSeesPrivate (a primitive selector). */
export function useOwnerSeesPrivate(workspaceId: string | null | undefined): boolean {
  return useWorkspaces((s) => (workspaceId ? (s.byId[workspaceId]?.ws.ownerSeesPrivate ?? false) : false));
}

/** Workspace.ownerId ('' when unknown). */
export function useWorkspaceOwnerId(workspaceId: string | null | undefined): string {
  return useWorkspaces((s) => (workspaceId ? (s.byId[workspaceId]?.ws.ownerId ?? '') : ''));
}

/**
 * A display-only row of a «who sees» list: the creator, or the workspace owner (badge «Владелец
 * пространства», rights «Полный доступ» in a disabled select, the tooltip says why; no ×).
 */
export const FixedAccessRow = memo(function FixedAccessRow({
  workspaceId,
  userId,
  kind,
  withRights = false,
  className,
}: {
  workspaceId: string;
  userId: string;
  kind: 'creator' | 'wsOwner';
  /** Show the disabled «Полный доступ» select (editors whose rows have a rights select). */
  withRights?: boolean;
  className?: string;
}): ReactNode {
  const name = useMemberName(workspaceId, userId);
  const row = (
    <div className={cx('flex min-h-9 items-center gap-2.5', className)} data-testid={`access-fixed-${kind}`}>
      <MemberAvatar workspaceId={workspaceId} userId={userId} size={24} />
      <span className="min-w-0 flex-1 truncate text-body">{name}</span>
      <span className="shrink-0 text-caption text-muted">{t(kind === 'creator' ? 'access.creator' : 'access.wsOwner')}</span>
      {withRights && kind === 'wsOwner' ? (
        <span className="w-36 shrink-0">
          <Select value="full" disabled aria-label={t('access.fullAccess')} onChange={() => undefined}>
            <option value="full">{t('access.fullAccess')}</option>
          </Select>
        </span>
      ) : null}
    </div>
  );
  return kind === 'wsOwner' ? <Tip label={t('access.wsOwnerTip')}>{row}</Tip> : row;
});

/**
 * The fixed rows of a private object's list: its creator (when known) and, while «Владелец видит
 * приватное» is on, the workspace owner (unless they are the creator). Nothing for a public object.
 */
export function PrivateFixedRows({
  workspaceId,
  creatorId,
  isPrivate,
  withRights = false,
  rowClassName,
}: {
  workspaceId: string;
  creatorId: string;
  isPrivate: boolean;
  withRights?: boolean;
  rowClassName?: string;
}): ReactNode {
  const sees = useOwnerSeesPrivate(workspaceId);
  const ownerId = useWorkspaceOwnerId(workspaceId);
  if (!isPrivate) return null;
  return (
    <>
      {creatorId ? <FixedAccessRow workspaceId={workspaceId} userId={creatorId} kind="creator" {...(rowClassName ? { className: rowClassName } : {})} /> : null}
      {sees && ownerId && ownerId !== creatorId ? (
        <FixedAccessRow workspaceId={workspaceId} userId={ownerId} kind="wsOwner" withRights={withRights} {...(rowClassName ? { className: rowClassName } : {})} />
      ) : null}
    </>
  );
}

/** Whether «Сделать меня владельцем» applies to an item (lib/permissions mayTakeOver over the stores). */
export function useCanTakeOver(workspaceId: string, itemOwnerId: string, isPrivate: boolean): boolean {
  const me = useSession((s) => s.me?.user?.id ?? '');
  return useWorkspaces((s) => {
    const e = s.byId[workspaceId];
    if (!e) return false;
    return mayTakeOver({ isOwner: !!me && e.ws.ownerId === me, seesPrivate: e.ws.ownerSeesPrivate, isPrivate, itemOwnerId, members: e.members });
  });
}

/** «Сделать меня владельцем» with its confirmation; `run` calls the take-over endpoint and stores the answer. */
export function TakeOverButton({
  workspaceId,
  itemOwnerId,
  isPrivate,
  name,
  run,
  testId,
}: {
  workspaceId: string;
  itemOwnerId: string;
  isPrivate: boolean;
  name: string;
  run: () => Promise<unknown>;
  testId: string;
}): ReactNode {
  const can = useCanTakeOver(workspaceId, itemOwnerId, isPrivate);
  const [busy, setBusy] = useState(false);
  if (!can) return null;
  const go = (): void => {
    void confirmAction(t('access.takeOverTitle'), t('access.takeOverText', { name }), t('access.takeOver'), 'primary').then((ok) => {
      if (!ok) return;
      setBusy(true);
      run().then(
        () => {
          setBusy(false);
          toast.success(t('access.takeOverDone'));
        },
        (e: unknown) => {
          setBusy(false);
          toast.fail(e, t('access.takeOver'));
        },
      );
    });
  };
  return (
    <Button variant="secondary" size="sm" busy={busy} onClick={go} className="self-start" data-testid={testId}>
      <UserRoundCheck className="size-3.5" aria-hidden /> {t('access.takeOver')}
    </Button>
  );
}

/** One chosen target of a create dialog's «Только выбранные» list. */
export interface Chosen {
  type: PermissionTargetType;
  id: string;
}

const chosenKey = (c: Chosen): string => `${c.type}:${c.id}`;

/** The create request fields of a chosen list (CreateRoomRequest / CreateBoardRequest member_ids / role_ids). */
export function chosenIds(list: readonly Chosen[]): { memberIds: string[]; roleIds: string[] } {
  return {
    memberIds: list.filter((c) => c.type === PermissionTargetType.USER).map((c) => c.id),
    roleIds: list.filter((c) => c.type === PermissionTargetType.ROLE).map((c) => c.id),
  };
}

/**
 * The chosen list of a create dialog (private room / board): me as the creator (fixed), the
 * workspace owner while the setting is on (fixed), then people and — unless `peopleOnly` — roles
 * (custom ones and «admin»: the server refuses owner / member / guest built-ins), each with ×.
 */
export function ChosenList({
  workspaceId,
  value,
  onChange,
  peopleOnly = false,
  noGuests = false,
  testId,
}: {
  workspaceId: string;
  value: readonly Chosen[];
  onChange: (v: Chosen[]) => void;
  peopleOnly?: boolean;
  noGuests?: boolean;
  testId: string;
}): ReactNode {
  const me = useSession((s) => s.me?.user?.id ?? '');
  const roles = useWorkspaces((s) => s.byId[workspaceId]?.roles);
  const members = useWorkspaces((s) => s.byId[workspaceId]?.members);
  const ownerId = useWorkspaceOwnerId(workspaceId);
  const sees = useOwnerSeesPrivate(workspaceId);
  const [adding, setAdding] = useState(false);
  const groups = useMemo((): Array<PickerGroup<PeoplePickItem>> => {
    const listed = new Set(value.map(chosenKey));
    const rs: RolePickItem[] = peopleOnly
      ? []
      : (roles ?? [])
          .filter((r) => (r.builtin === WorkspaceRole.UNSPECIFIED || r.builtin === WorkspaceRole.ADMIN) && !listed.has(`${PermissionTargetType.ROLE}:${r.id}`))
          .map((r) => ({ kind: 'role', id: `role:${r.id}`, roleId: r.id, role: r.builtin, color: r.color, label: roleName(r), note: '', search: [roleName(r), r.name] }));
    const people = memberItems(Object.values(members ?? {}), {
      ...(roles ? { roles } : {}),
      exclude: new Set([me, ...(sees ? [ownerId] : []), ...value.filter((c) => c.type === PermissionTargetType.USER).map((c) => c.id)]),
      ...(noGuests ? { decorate: (m) => (m.role === WorkspaceRole.GUEST ? { disabled: true, note: t('boards.perm.noGuests') } : undefined) } : {}),
    });
    return [...(peopleOnly ? [] : [{ id: 'roles', label: t('picker.roles'), items: rs }]), { id: 'members', label: t('picker.members'), items: people }];
  }, [me, members, noGuests, ownerId, peopleOnly, roles, sees, value]);
  return (
    <div className="flex flex-col" data-testid={testId}>
      <span className="pb-1 text-caption font-medium text-muted">{t('room.whoSees')}</span>
      {me ? <FixedAccessRow workspaceId={workspaceId} userId={me} kind="creator" /> : null}
      {sees && ownerId && ownerId !== me ? <FixedAccessRow workspaceId={workspaceId} userId={ownerId} kind="wsOwner" /> : null}
      {value.map((c) => (
        <ChosenRow key={chosenKey(c)} workspaceId={workspaceId} chosen={c} onRemove={() => onChange(value.filter((x) => chosenKey(x) !== chosenKey(c)))} />
      ))}
      <div className="pt-1.5">
        <MemberPicker
          open={adding}
          onOpenChange={setAdding}
          groups={groups}
          onSelect={(it) => {
            setAdding(false);
            const c: Chosen = it.kind === 'role' ? { type: PermissionTargetType.ROLE, id: it.roleId } : { type: PermissionTargetType.USER, id: it.userId };
            if (!value.some((x) => chosenKey(x) === chosenKey(c))) onChange([...value, c]);
          }}
          placeholder={t('picker.searchPeople')}
          label={t(peopleOnly ? 'access.addPeople' : 'access.add')}
          testId={`${testId}-picker`}
        >
          <Button variant="secondary" size="sm" data-testid={`${testId}-add`}>
            <Plus className="size-3.5" aria-hidden /> {t(peopleOnly ? 'access.addPeople' : 'access.add')}
          </Button>
        </MemberPicker>
      </div>
    </div>
  );
}

function ChosenRow({ workspaceId, chosen, onRemove }: { workspaceId: string; chosen: Chosen; onRemove: () => void }): ReactNode {
  const role = useWorkspaces((s) => (chosen.type === PermissionTargetType.ROLE ? s.byId[workspaceId]?.roles.find((r) => r.id === chosen.id) : undefined));
  const label = role ? `@${roleName(role)}` : memberName(workspaceId, chosen.id);
  return (
    <div className="flex min-h-9 items-center gap-2.5" data-testid="access-chosen-row">
      {role ? (
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-[var(--color-fill-hover)] text-caption font-semibold text-muted" aria-hidden>
          @
        </span>
      ) : (
        <MemberAvatar workspaceId={workspaceId} userId={chosen.id} size={24} />
      )}
      <span className="min-w-0 flex-1 truncate text-body">{label}</span>
      {role ? <RoleMark role={role.builtin} tone="muted" /> : null}
      <IconButton size="sm" label={t('access.remove', { name: label })} onClick={onRemove}>
        <X className="size-3.5" aria-hidden />
      </IconButton>
    </div>
  );
}
