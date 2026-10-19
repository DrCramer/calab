import { timestampDate } from '@bufbuild/protobuf/wkt';
import { WorkspaceRole, type GetBotResponse } from '@calaba/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { UserPlus, X } from 'lucide-react';
import { memo, useMemo, useState, type ReactNode } from 'react';
import type { PickerGroup } from '../../components/picker/pickerModel';
import { confirmAction } from '../../components/Confirm';
import { Button, IconButton, Modal } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { fmt } from '../../lib/format';
import { useBots } from '../../stores/bots';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { memberName, useMemberName, useWorkspaces } from '../../stores/workspaces';
import { MemberAvatar } from '../boards/menus';
import { useBotCard } from './BotProfile';
import { MemberPicker } from './MemberPicker';
import { memberItems, type PeoplePickItem } from './memberPickItems';

/*
 * «Делегировать права» (ADR-0111): who lets the bot act on their behalf in this workspace. The
 * access-dialog layout (rows with avatars, «Пригласить» through the member picker): my own row
 * with «Разрешить» / «Отозвать» — the only consent I can give or take; the members who allowed
 * it; the pending invitations (× for the inviter: cancel; for the invitee: decline). Inviting
 * makes the bot DM each member a suggestion naming me with «Принять» / «Отказаться». The server
 * decides everything (only the member's own request or click records a consent).
 *
 * For the bot's OWNER (at its home workspace) my own row is «Действовать от моего имени»
 * (ADR-0106, CBF-17) instead of a consent: the switch moved here from the bot settings. Allowing
 * asks once more (a leaked token then acts as the owner); the server accepts only the owner.
 */

const queryKey = (ws: string, bot: string): string[] => ['botDelegations', ws, bot];

export function BotDelegationDialog({ workspaceId, botUserId, onClose }: { workspaceId: string; botUserId: string; onClose: () => void }): ReactNode {
  const me = useSession((s) => s.me?.user?.id ?? '');
  const botName = useMemberName(workspaceId, botUserId);
  const qc = useQueryClient();
  const state = useQuery({
    queryKey: queryKey(workspaceId, botUserId),
    queryFn: ({ signal }) => api.bots.delegations(workspaceId, botUserId, signal),
    staleTime: 0,
  });
  const [busy, setBusy] = useState(false);
  const run = (p: Promise<GetBotResponse>, done?: string): void => {
    setBusy(true);
    p.then(
      (r) => {
        qc.setQueryData(queryKey(workspaceId, botUserId), r);
        setBusy(false);
        if (done) toast.success(done);
      },
      (e: unknown) => {
        setBusy(false);
        toast.fail(e);
      },
    );
  };
  const card = useBotCard(botUserId);
  const ownerMode = !!card && me !== '' && card.ownerUserId === me && card.workspaceId === workspaceId;
  const setActsAsOwner = async (on: boolean): Promise<void> => {
    if (busy || !card) return;
    if (on && !(await confirmAction(t('bots.actsAsOwnerConfirmTitle', { name: botName }), t('bots.actsAsOwnerWarning'), t('bots.actsAsOwnerConfirm'), 'primary'))) return;
    setBusy(true);
    try {
      const r = await api.bots.update(workspaceId, botUserId, { actsAsOwner: on });
      if (r.bot) useBots.getState().upsert(workspaceId, r.bot);
    } catch (e) {
      toast.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const data = state.data;
  const mine = data?.delegations.find((d) => d.userId === me);
  const others = data?.delegations.filter((d) => d.userId !== me) ?? [];
  const invites = useMemo(() => data?.invites ?? [], [data]);
  const listed = useMemo(() => [me, ...(data?.onBehalfUserIds ?? []), ...invites.map((i) => i.userId)], [me, data, invites]);
  return (
    <Modal
      open
      onClose={onClose}
      title={t('bots.delegate.title', { bot: botName })}
      description={t('bots.delegate.text', { bot: botName })}
      initialFocus="body"
    >
      <div className="flex flex-col gap-4" data-testid="bot-delegation-dialog">
        <section className="flex min-h-10 items-center gap-2.5" data-testid="bot-delegation-me">
          <MemberAvatar workspaceId={workspaceId} userId={me} size={28} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-body">{t('bots.delegate.you')}</span>
            <span className="text-caption text-muted">
              {ownerMode
                ? card.actsAsOwner
                  ? card.actsAsOwnerSince
                    ? t('bots.delegate.allowedSince', { date: fmt.date(timestampDate(card.actsAsOwnerSince)) })
                    : t('bots.actsAsOwnerOn')
                  : t('bots.delegate.notAllowed')
                : mine?.since
                  ? t('bots.delegate.allowedSince', {
                      date: fmt.date(timestampDate(mine.since)),
                    })
                  : t('bots.delegate.notAllowed')}
            </span>
            {ownerMode ? <span className="text-caption text-muted">{t('bots.actsAsOwnerHint')}</span> : null}
          </span>
          {ownerMode ? (
            card.actsAsOwner ? (
              <Button variant="secondary" size="sm" busy={busy} onClick={() => void setActsAsOwner(false)} data-testid="bot-acts-as-owner-off">
                {t('bots.delegate.revoke')}
              </Button>
            ) : (
              <Button size="sm" busy={busy} onClick={() => void setActsAsOwner(true)} data-testid="bot-acts-as-owner-on">
                {t('bots.delegate.allow')}
              </Button>
            )
          ) : mine ? (
            <Button
              variant="secondary"
              size="sm"
              busy={busy}
              onClick={() => run(api.bots.revokeDelegation(workspaceId, botUserId, me), t('bots.delegate.revoked'))}
              data-testid="bot-delegation-revoke"
            >
              {t('bots.delegate.revoke')}
            </Button>
          ) : (
            <Button
              size="sm"
              busy={busy}
              disabled={!data}
              onClick={() => run(api.bots.grantDelegation(workspaceId, botUserId, me), t('bots.delegate.granted'))}
              data-testid="bot-delegation-grant"
            >
              {t('bots.delegate.allow')}
            </Button>
          )}
        </section>

        <section className="flex flex-col">
          <h3 className="pb-1 text-caption font-medium text-muted">{t('bots.delegate.allowedList')}</h3>
          {others.length === 0 ? <p className="py-1 text-caption text-muted">{t('bots.delegate.nobody')}</p> : null}
          {others.map((d) => (
            <PersonRow
              key={d.userId}
              workspaceId={workspaceId}
              userId={d.userId}
              note={
                d.since
                  ? t('bots.delegate.since', {
                      date: fmt.date(timestampDate(d.since)),
                    })
                  : ''
              }
            />
          ))}
        </section>

        <section className="flex flex-col">
          <h3 className="pb-1 text-caption font-medium text-muted">{t('bots.delegate.invitedList')}</h3>
          {invites.length === 0 ? <p className="py-1 text-caption text-muted">{t('bots.delegate.noInvites')}</p> : null}
          {invites.map((inv) => (
            <PersonRow
              key={inv.userId}
              workspaceId={workspaceId}
              userId={inv.userId}
              note={t('bots.delegate.invitedBy', {
                name: memberName(workspaceId, inv.invitedBy),
              })}
              {...(inv.invitedBy === me || inv.userId === me
                ? {
                    removeLabel:
                      inv.userId === me
                        ? t('bots.delegate.decline')
                        : t('bots.delegate.cancelInvite', {
                            name: memberName(workspaceId, inv.userId),
                          }),
                    onRemove: () => run(api.bots.cancelDelegationInvite(workspaceId, botUserId, inv.userId)),
                  }
                : {})}
            />
          ))}
          <div className="pt-1.5">
            <InvitePicker
              workspaceId={workspaceId}
              exclude={listed}
              disabled={!data || busy}
              onPick={(userId) =>
                run(
                  api.bots.inviteDelegation(workspaceId, botUserId, [userId]),
                  t('bots.delegate.inviteSent', {
                    name: memberName(workspaceId, userId),
                  }),
                )
              }
            />
          </div>
        </section>
      </div>
    </Modal>
  );
}

const PersonRow = memo(function PersonRow({
  workspaceId,
  userId,
  note,
  removeLabel,
  onRemove,
}: {
  workspaceId: string;
  userId: string;
  note: string;
  removeLabel?: string;
  onRemove?: () => void;
}): ReactNode {
  const name = useMemberName(workspaceId, userId);
  return (
    <div className="flex min-h-9 items-center gap-2.5" data-testid="bot-delegation-row">
      <MemberAvatar workspaceId={workspaceId} userId={userId} size={24} />
      <span className="min-w-0 flex-1 truncate text-body">{name}</span>
      {note ? <span className="shrink-0 truncate text-caption text-muted">{note}</span> : null}
      {onRemove && removeLabel ? (
        <IconButton size="sm" label={removeLabel} onClick={onRemove}>
          <X className="size-3.5" aria-hidden />
        </IconButton>
      ) : null}
    </div>
  );
});

/** «Пригласить участников»: people with a non-guest role, not bots, not already listed. */
function InvitePicker({
  workspaceId,
  exclude,
  disabled,
  onPick,
}: {
  workspaceId: string;
  exclude: string[];
  disabled: boolean;
  onPick: (userId: string) => void;
}): ReactNode {
  const members = useWorkspaces((s) => s.byId[workspaceId]?.members);
  const roles = useWorkspaces((s) => s.byId[workspaceId]?.roles);
  const [open, setOpen] = useState(false);
  const groups = useMemo((): Array<PickerGroup<PeoplePickItem>> => {
    const list = Object.values(members ?? {}).filter((m) => m.user && !m.user.isBot);
    const items = memberItems(list, {
      ...(roles ? { roles } : {}),
      exclude: new Set(exclude),
      decorate: (m) => (m.role === WorkspaceRole.GUEST ? { disabled: true, note: t('bots.delegate.noGuests') } : undefined),
    });
    return [{ id: 'members', label: t('picker.members'), items }];
  }, [members, roles, exclude]);
  return (
    <MemberPicker
      open={open}
      onOpenChange={setOpen}
      groups={groups}
      onSelect={(it) => {
        setOpen(false);
        if (it.kind === 'member') onPick(it.userId);
      }}
      placeholder={t('picker.searchPeople')}
      label={t('bots.delegate.invite')}
      testId="bot-delegation-picker"
    >
      <Button variant="secondary" size="sm" disabled={disabled} data-testid="bot-delegation-invite">
        <UserPlus className="size-3.5" aria-hidden /> {t('bots.delegate.invite')}
      </Button>
    </MemberPicker>
  );
}
