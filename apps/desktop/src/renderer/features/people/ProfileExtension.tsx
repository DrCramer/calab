import { WorkspaceRole, type ListSipExtensionsResponse } from '@calaba/protocol';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Pencil, X } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { IconButton, Input, cx } from '../../components/ui';
import { t } from '../../i18n';
import { ApiError } from '../../lib/api/client';
import { describeError } from '../../lib/api/errors';
import { api } from '../../lib/api/endpoints';
import { log } from '../../lib/log';
import { cleanNumber, extensionsKey, groupsKey, menusKey, numberValid } from '../../lib/sipPbx';
import { startCall } from '../../services/call';
import { reportPlanError } from '../../services/plan';
import { myUserId } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { memberName, useWorkspaces } from '../../stores/workspaces';
import { useCanCall } from '../dm/canDm';
import { useMayManageTelephony } from '../telephony/access';

/*
 * «Внутренний номер» in a person's profile and card (ADR-0117, ADR-0137 §5, owner 27.10): while
 * telephony is on everyone sees the number — a tap calls the person inside the app (ADR-0034), «⧉»
 * copies it; the administrator (MANAGE_INTEGRATIONS) sets or changes it right there — the same
 * numbers API as «Телефония → Внутренние номера»: a taken number answers 409 and the line says
 * whose it is. A member sees their own read-only. Guests have no numbers.
 */

/** Whether the row shows for this person (the number, or the administrator may give one). */
export function useExtensionRow(workspaceId: string, userId: string, extension: string): boolean {
  const on = useWorkspaces((s) => !!s.byId[workspaceId]?.ws.sipEnabled);
  const guest = useWorkspaces((s) => s.byId[workspaceId]?.members[userId]?.role === WorkspaceRole.GUEST);
  const manage = useMayManageTelephony(workspaceId);
  return on && !guest && (extension !== '' || manage);
}

function copy(text: string): void {
  void navigator.clipboard.writeText(text).then(
    () => toast.success(t('people.contacts.copied')),
    (e: unknown) => {
      log.warn('copy extension', e);
      toast.error(t('people.contacts.copyFailed'));
    },
  );
}

export function ProfileExtension({ workspaceId, userId, extension }: { workspaceId: string; userId: string; extension: string }): ReactNode {
  const manage = useMayManageTelephony(workspaceId);
  const canCall = useCanCall(userId, workspaceId) && userId !== myUserId();
  const [editing, setEditing] = useState(false);
  if (editing) return <ExtensionEdit workspaceId={workspaceId} userId={userId} extension={extension} onDone={() => setEditing(false)} />;
  return (
    <span className="flex min-w-0 items-center gap-1.5" data-testid="profile-extension">
      {extension ? (
        canCall ? (
          <button
            type="button"
            onClick={() => void startCall(userId)}
            aria-label={t('tset.profile.call', { number: extension })}
            className="min-w-0 text-left text-accent-text tabular-nums hover:underline mobile:min-h-11"
            data-testid="profile-extension-call"
          >
            {extension}
          </button>
        ) : (
          <span className="selectable min-w-0 tabular-nums">{extension}</span>
        )
      ) : (
        <span className="text-muted">{t('tset.profile.none')}</span>
      )}
      {extension ? (
        <IconButton size="sm" label={t('people.contacts.copyWhat', { what: t('people.profile.extension') })} onClick={() => copy(extension)} className="-my-1 size-6">
          <Copy className="size-3.5" aria-hidden />
        </IconButton>
      ) : null}
      {manage ? (
        <IconButton size="sm" label={t(extension ? 'tset.profile.change' : 'tset.profile.assign')} onClick={() => setEditing(true)} className="-my-1 size-6" data-testid="profile-extension-edit">
          <Pencil className="size-3.5" aria-hidden />
        </IconButton>
      ) : null}
    </span>
  );
}

/**
 * The administrator's inline edit: digits (2–6), ✓ saves, × or Escape cancels; empty — the person
 * has no number (the number stays in the station, unassigned). Saved, the member's
 * WORKSPACE_MEMBER_UPDATE brings the new number back here.
 */
function ExtensionEdit({ workspaceId, userId, extension, onDone }: { workspaceId: string; userId: string; extension: string; onDone: () => void }): ReactNode {
  const qc = useQueryClient();
  const id = useId();
  const [value, setValue] = useState(extension);
  const [err, setErr] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      const list = await freshNumbers(workspaceId, qc);
      const mine = list.extensions.find((e) => e.userId === userId);
      if (!value) return mine ? api.sip.updateExtension(workspaceId, mine.id, { userId: '' }) : null;
      if (mine) return api.sip.updateExtension(workspaceId, mine.id, { number: value });
      return api.sip.createExtension(workspaceId, { number: value, userId });
    },
    onSuccess: () => {
      for (const k of [extensionsKey(workspaceId), groupsKey(workspaceId), menusKey(workspaceId)]) void qc.invalidateQueries({ queryKey: k });
      toast.success(t('pbx.saved'));
      onDone();
    },
    onError: async (e) => {
      if (e instanceof ApiError && e.code === 'ERROR_CODE_SIP_EXTENSION_TAKEN' && e.field === 'number') {
        setErr(await takenBy(workspaceId, value, qc));
        return;
      }
      if (e instanceof ApiError && e.code === 'ERROR_CODE_VALIDATION' && e.field === 'number') {
        setErr(t('pbx.err.number'));
        return;
      }
      if (!reportPlanError(e, workspaceId)) setErr(describeError(e).text);
    },
  });
  const ok = value === '' || numberValid(value);
  return (
    <span className="flex min-w-0 flex-col gap-1" data-testid="profile-extension-form">
      <form
        className="flex min-w-0 items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok && !save.isPending) save.mutate();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onDone();
          }
        }}
      >
        <Input
          id={id}
          aria-label={t('people.profile.extension')}
          value={value}
          inputMode="numeric"
          placeholder={t('tset.profile.placeholder')}
          aria-invalid={err ? true : undefined}
          className={cx('w-24! tabular-nums')}
          onChange={(e) => {
            setValue(cleanNumber(e.target.value));
            setErr(null);
          }}
          data-testid="profile-extension-input"
        />
        <IconButton type="submit" size="sm" label={t('pbx.save')} disabled={!ok || save.isPending} className="mobile:size-11" data-testid="profile-extension-save">
          <Check className="size-4" aria-hidden />
        </IconButton>
        <IconButton size="sm" label={t('common.cancel')} onClick={onDone} className="mobile:size-11">
          <X className="size-4" aria-hidden />
        </IconButton>
      </form>
      {err ? (
        <span className="text-caption text-danger-text" role="alert" data-testid="profile-extension-error">
          {err}
        </span>
      ) : null}
    </span>
  );
}

/** The numbers as the server has them now (the cache may be from another admin's minute ago). */
async function freshNumbers(workspaceId: string, qc: ReturnType<typeof useQueryClient>): Promise<ListSipExtensionsResponse> {
  const list = await api.sip.extensions(workspaceId);
  qc.setQueryData(extensionsKey(workspaceId), list);
  return list;
}

/** «Номер 101 уже у Бориса Петрова» — the holder from the numbers list (a person, a bot, a group, or nobody). */
async function takenBy(workspaceId: string, number: string, qc: ReturnType<typeof useQueryClient>): Promise<string> {
  try {
    const list = await freshNumbers(workspaceId, qc);
    const e = list.extensions.find((x) => x.number === number);
    const who = !e ? '' : e.groupName ? t('tset.profile.group', { name: e.groupName }) : e.userId ? memberName(workspaceId, e.userId) : t('pbx.ext.unassigned');
    return who ? t('tset.profile.taken', { number, who }) : t('pbx.err.numberTaken');
  } catch {
    return t('pbx.err.numberTaken');
  }
}
