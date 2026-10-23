import { SipExtensionKind, WorkspaceRole, type SipExtension, type WorkspaceMember } from '@calaba/protocol';
import { useQuery } from '@tanstack/react-query';
import { Hash, Loader2, PhoneForwarded, Users } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { PickerPopover } from '../../components/picker/Picker';
import type { PickerGroup, PickerItem } from '../../components/picker/pickerModel';
import { Button, cx } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { transferTargets } from '../../lib/sipInbound';
import { extensionsKey } from '../../lib/sipPbx';
import { cancelTransferInbound, transferInbound, type TransferTarget } from '../../services/sipInbound';
import { myUserId } from '../../stores/session';
import { useSipInbound } from '../../stores/sipInbound';
import { useWorkspaces } from '../../stores/workspaces';
import { MemberPickRow } from '../people/MemberPicker';
import { nameOf } from '../people/members';
import { memberItems, type MemberPickItem } from '../people/memberPickItems';

/**
 * Transfer of the answered phone call (ADR-0132, docs/08 «Телефония»): «Перевести» opens the
 * picker — colleagues (people and bots, with their internal number), groups by their number, and
 * «Перевести на номер N» for digits typed in the search; while the target rings, «Переводим: Имя»
 * with «Отменить перевод» (I stay with the caller until they answer). Leaf components: they
 * subscribe to the phone call's own slice only (useShallow over the target ids).
 */

interface GroupItem extends PickerItem {
  kind: 'group';
  extensionId: string;
  name: string;
  number: string;
}

interface DialItem extends PickerItem {
  kind: 'dial';
  number: string;
}

type TransferItem = MemberPickItem | GroupItem | DialItem;

const NO_EXTS: SipExtension[] = [];
const DIGITS = /^\d{2,6}$/;

/** The workspace and the targets of my phone call's transfer ([] = none rings). */
function useTransfer(callId: string): { workspaceId: string; targets: readonly string[] } {
  const workspaceId = useSipInbound((s) => (s.active?.id === callId ? s.active.workspaceId : ''));
  const targets = useSipInbound(useShallow((s) => (s.active?.id === callId ? transferTargets(s.active) : [])));
  return { workspaceId, targets };
}

/** «Борис, Вера» — whom the transfer rings (a string: the row re-renders only when it changes). */
function useTargetNames(workspaceId: string, ids: readonly string[]): string {
  return useWorkspaces((s) => {
    const members = s.byId[workspaceId]?.members;
    return ids.map((id) => (members?.[id] ? nameOf(members[id]) : s.users[id]?.displayName) || t('common.unknownUser')).join(', ');
  });
}

function GroupGlyph({ dial }: { dial?: boolean }): ReactNode {
  const Icon = dial ? Hash : Users;
  return (
    <span className="grid size-6 shrink-0 place-items-center rounded-full bg-[var(--color-fill)]" aria-hidden>
      <Icon className="size-3.5" />
    </span>
  );
}

function TransferRow({ item, active }: { item: TransferItem; active: boolean }): ReactNode {
  if (item.kind === 'member') return <MemberPickRow item={item} active={active} />;
  return (
    <>
      <GroupGlyph dial={item.kind === 'dial'} />
      <span className="min-w-0 flex-1 truncate font-medium">{item.kind === 'dial' ? t('call.sipTransferToNumber', { number: item.number }) : item.name}</span>
      {item.kind === 'group' ? <span className={cx('shrink-0 text-caption tabular-nums', active ? '' : 'text-muted')}>{item.number}</span> : null}
    </>
  );
}

/** Colleagues who may take the call: not guests, not me; their number as the row's note. */
function memberTargets(members: Record<string, WorkspaceMember> | undefined, exts: readonly SipExtension[], me: string): MemberPickItem[] {
  const numberOf = new Map(exts.filter((e) => e.userId).map((e) => [e.userId, e.number]));
  const list = Object.values(members ?? {}).filter((m) => m.user && m.role !== WorkspaceRole.GUEST && m.user.id !== me);
  return memberItems(list, { decorate: (m) => ({ note: numberOf.get(m.user?.id ?? '') ?? '' }) }).map((it) => (it.note ? { ...it, search: [...it.search, it.note] } : it));
}

/** The picker over its trigger: who to transfer the call to. */
function TransferPicker({
  callId,
  workspaceId,
  open,
  onOpenChange,
  side,
  align,
  onPending,
  children,
}: {
  onPending?: (pending: boolean) => void;
  callId: string;
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side: 'top' | 'bottom';
  align: 'start' | 'center' | 'end';
  children: ReactNode;
}): ReactNode {
  const [text, setText] = useState('');
  // A closed picker forgets its query (derived during render, no effect round trip).
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) setText('');
  }
  // Closed (the whole call long): no member subscription, no items built.
  const members = useWorkspaces((s) => (open ? s.byId[workspaceId]?.members : undefined));
  const exts = useQuery({ queryKey: extensionsKey(workspaceId), queryFn: () => api.sip.extensions(workspaceId), enabled: open && !!workspaceId, staleTime: 60_000 });
  const list = exts.data?.extensions ?? NO_EXTS;
  const people = useMemo(() => memberTargets(members, list, myUserId()), [members, list]);
  const groups = useMemo(
    (): GroupItem[] =>
      list
        .filter((e) => e.kind === SipExtensionKind.GROUP)
        .map((e) => ({ kind: 'group', id: `g:${e.id}`, extensionId: e.id, name: e.groupName || e.description || e.number, number: e.number, search: [e.groupName, e.description, e.number].filter(Boolean) })),
    [list],
  );
  const q = text.trim();
  const pickerGroups = useMemo((): Array<PickerGroup<TransferItem>> => {
    const dial: DialItem[] = DIGITS.test(q) ? [{ kind: 'dial', id: 'dial', number: q, search: [q] }] : [];
    return [
      { id: 'dial', label: '', items: dial },
      { id: 'groups', label: t('call.sipTransferGroups'), items: groups },
      { id: 'people', label: t('call.sipTransferPeople'), items: people },
    ];
  }, [q, groups, people]);
  const pick = (it: TransferItem): void => {
    const to: TransferTarget = it.kind === 'member' ? { userId: it.userId } : it.kind === 'group' ? { extensionId: it.extensionId } : { number: it.number };
    onOpenChange(false);
    onPending?.(true);
    void transferInbound(callId, to).finally(() => onPending?.(false));
  };
  return (
    <PickerPopover<TransferItem>
      open={open}
      onOpenChange={onOpenChange}
      side={side}
      align={align}
      width={320}
      restoreFocus="keyboard"
      groups={pickerGroups}
      renderItem={(item, active) => <TransferRow item={item} active={active} />}
      onSelect={pick}
      onInput={setText}
      loading={exts.isLoading}
      placeholder={t('call.sipTransferSearch')}
      label={t('call.sipTransferPick')}
      emptyText={t('call.sipTransferNone')}
      testId="sip-transfer-picker"
    >
      {children}
    </PickerPopover>
  );
}

/** «Переводим: Имя» · «Вы на связи, пока не ответят» · «Отменить перевод». */
function TransferStatus({ callId, workspaceId, targets, className }: { callId: string; workspaceId: string; targets: readonly string[]; className?: string }): ReactNode {
  const names = useTargetNames(workspaceId, targets);
  return (
    <div className={cx('flex items-center gap-2 rounded-[var(--radius-row)] bg-hover px-2 py-1.5 text-[12px]', className)} role="status" data-testid="sip-transferring">
      <Loader2 className="size-4 shrink-0 animate-spin text-accent-text" aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium text-fg" title={names}>
          {t('call.sipTransferring', { name: names })}
        </span>
        <span className="truncate text-muted">{t('call.sipTransferHint')}</span>
      </span>
      <button
        type="button"
        className="shrink-0 rounded-[var(--radius-control)] font-medium text-accent-text hover:underline mobile:tap-h"
        onClick={() => void cancelTransferInbound(callId)}
        aria-label={t('call.sipTransferCancel')}
        title={t('call.sipTransferCancel')}
        data-testid="sip-transfer-cancel"
      >
        {t('call.sipTransferCancelShort')}
      </button>
    </div>
  );
}

/** The island's row (desktop and web): «Перевести», or the transfer that rings. */
export function PhoneTransferRow({ callId, className }: { callId: string; className?: string }): ReactNode {
  const { workspaceId, targets } = useTransfer(callId);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  if (!workspaceId) return null;
  if (targets.length > 0) return <TransferStatus callId={callId} workspaceId={workspaceId} targets={targets} className={className} />;
  return (
    <div className={className}>
      <TransferPicker callId={callId} workspaceId={workspaceId} open={open} onOpenChange={setOpen} side="top" align="start" onPending={setBusy}>
        <Button variant="secondary" className="w-full" busy={busy} data-testid="sip-transfer">
          {busy ? null : <PhoneForwarded className="size-4" aria-hidden />}
          {t('call.sipTransfer')}
        </Button>
      </TransferPicker>
    </div>
  );
}

/** The phone strip's 44 px round «Перевести» (in place of the camera: a phone call has none). */
export function PhoneTransferButton({ callId, className }: { callId: string; className: string }): ReactNode {
  const { workspaceId, targets } = useTransfer(callId);
  const [open, setOpen] = useState(false);
  if (!workspaceId) return null;
  return (
    <TransferPicker callId={callId} workspaceId={workspaceId} open={open} onOpenChange={setOpen} side="top" align="end">
      <button type="button" aria-label={t('call.sipTransfer')} disabled={targets.length > 0} className={cx(className, 'disabled:opacity-40')} data-testid="sip-transfer">
        <PhoneForwarded className="size-5" aria-hidden />
      </button>
    </TransferPicker>
  );
}

/** The phone strip's line above the island while a transfer rings. */
export function PhoneTransferStatus({ callId, className }: { callId: string; className?: string }): ReactNode {
  const { workspaceId, targets } = useTransfer(callId);
  if (!workspaceId || targets.length === 0) return null;
  return <TransferStatus callId={callId} workspaceId={workspaceId} targets={targets} className={className} />;
}
