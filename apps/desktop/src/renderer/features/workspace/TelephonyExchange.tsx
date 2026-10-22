import {
  SipExtensionKind,
  SipGroupStrategy,
  SipPromptStatus,
  WorkspaceRole,
  type SipExtension,
  type SipGroup,
  type SipIvrMenu,
  type SipRouteTarget,
  type WorkspaceMember,
} from '@calaba/protocol';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Pause, Pencil, Play, Trash2, TriangleAlert, X } from 'lucide-react';
import { memo, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { confirmAction } from '../../components/Confirm';
import { Button, Card, IconButton, Input, Segmented, Select, Spinner, cx } from '../../components/ui';
import { plural, t } from '../../i18n';
import { describeError } from '../../lib/api/errors';
import { api, uploadFile, uploadPath } from '../../lib/api/endpoints';
import { log } from '../../lib/log';
import { cleanNumber, fieldError, numberValid, targetInit, targetValue } from '../../lib/sipPbx';
import { reportPlanError } from '../../services/plan';
import { toast } from '../../stores/toasts';
import { useMemberName, useWorkspaces } from '../../stores/workspaces';
import { memberItems } from '../people/memberPickItems';
import { MemberPicker } from '../people/MemberPicker';
import { formatDuration } from '../shell/voiceFormat';

/*
 * Workspace settings → «Телефония» → the exchange (ADR-0117 step 1, docs/08 «Телефония»;
 * MANAGE_INTEGRATIONS): «Внутренние номера» (number · member or bot · description), «Группы»
 * (number, all at once / one by one, members in order, «если никто не ответил»), «Автоответ»
 * (voice menus: the recorded prompt, what each key 1–9 * 0 # does, «нет нажатия»). Each card is
 * a list; a row opens its inline form. Answering calls comes with step 2 (SIP_INBOUND), so the
 * cards are set up ahead of time. Rows are memo'd with primitive props; the lists change only
 * by the admin's own saves (react-query), never by a live event.
 */

/** The prompt upload limit (sip.proto CreateSipIvrMenuRequest.prompt_source_file_id). */
export const MAX_PROMPT_UPLOAD = 10 * 1024 * 1024;
const PROMPT_ACCEPT = 'audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/wave,audio/ogg,audio/opus,.mp3,.wav,.ogg,.oga,.opus';
/** The keys of a menu in phone keypad order. */
export const KEYPAD = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'] as const;

const extKey = (ws: string): readonly unknown[] => ['sipExtensions', ws];
const groupKey = (ws: string): readonly unknown[] => ['sipGroups', ws];
const menuKey = (ws: string): readonly unknown[] => ['sipMenus', ws];

function useExchange(workspaceId: string): {
  exts: SipExtension[] | undefined;
  groups: SipGroup[] | undefined;
  menus: SipIvrMenu[] | undefined;
  failed: boolean;
  retry: () => void;
} {
  const e = useQuery({ queryKey: extKey(workspaceId), queryFn: () => api.sip.extensions(workspaceId) });
  const g = useQuery({ queryKey: groupKey(workspaceId), queryFn: () => api.sip.groups(workspaceId) });
  const m = useQuery({ queryKey: menuKey(workspaceId), queryFn: () => api.sip.menus(workspaceId) });
  return {
    exts: e.data?.extensions,
    groups: g.data?.groups,
    menus: m.data?.menus,
    failed: e.isError || g.isError || m.isError,
    retry: () => {
      void e.refetch();
      void g.refetch();
      void m.refetch();
    },
  };
}

/** After any change: the three lists refer to each other (missing targets, group numbers). */
function useRefresh(workspaceId: string): () => void {
  const qc = useQueryClient();
  return () => {
    for (const k of [extKey(workspaceId), groupKey(workspaceId), menuKey(workspaceId)]) void qc.invalidateQueries({ queryKey: k });
  };
}

/** A failed save: plan → the plan dialog; a field → under it; else one line at the form's foot. */
function useFormErrors(workspaceId: string): {
  field: Record<string, string>;
  form: string | null;
  report: (e: unknown) => void;
  clear: (k?: string) => void;
} {
  const [field, setField] = useState<Record<string, string>>({});
  const [form, setForm] = useState<string | null>(null);
  return {
    field,
    form,
    report: (e) => {
      const f = fieldError(e);
      if (f) {
        setField({ [f.field]: f.text });
        return;
      }
      if (reportPlanError(e, workspaceId)) return;
      setForm(describeError(e).text);
    },
    clear: (k) => {
      if (k === undefined) setField({});
      else if (field[k]) setField(({ [k]: _gone, ...rest }) => rest);
      setForm(null);
    },
  };
}

function ErrLine({ text, testId }: { text: string | null | undefined; testId?: string }): ReactNode {
  return text ? (
    <span className="text-caption text-danger-text" role="alert" data-testid={testId}>
      {text}
    </span>
  ) : null;
}

export function Exchange({ workspaceId, inboundAvailable }: { workspaceId: string; inboundAvailable: boolean }): ReactNode {
  const x = useExchange(workspaceId);
  if (x.failed) {
    return (
      <Card>
        <div className="flex items-center justify-between gap-3 px-3 py-2.5">
          <span className="text-body text-danger-text" role="alert">
            {t('pbx.loadFailed')}
          </span>
          <Button variant="secondary" size="sm" onClick={x.retry}>
            {t('common.retry')}
          </Button>
        </div>
      </Card>
    );
  }
  if (!x.exts || !x.groups || !x.menus) {
    return (
      <div className="grid place-items-center py-6">
        <Spinner />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6" data-testid="sip-exchange">
      {inboundAvailable ? null : (
        <p className="px-1 text-caption text-faint" data-testid="sip-inbound-off">
          {t('pbx.inboundOff')}
        </p>
      )}
      <ExtensionsCard workspaceId={workspaceId} exts={x.exts} />
      <GroupsCard workspaceId={workspaceId} exts={x.exts} groups={x.groups} menus={x.menus} />
      <MenusCard workspaceId={workspaceId} exts={x.exts} groups={x.groups} menus={x.menus} />
    </div>
  );
}

// ---------------------------------------------------------------- numbers

function ExtensionsCard({ workspaceId, exts }: { workspaceId: string; exts: SipExtension[] }): ReactNode {
  const [editing, setEditing] = useState<string | null>(null); // extension id, 'new', or null
  const people = exts.filter((e) => e.kind !== SipExtensionKind.GROUP);
  return (
    <Card title={t('pbx.ext.title')} footer={t('pbx.ext.footer')}>
      {people.length === 0 && editing !== 'new' ? (
        <p className="px-3 py-3 text-body text-muted" data-testid="sip-ext-empty">
          {t('pbx.ext.empty')}
        </p>
      ) : null}
      <ul data-testid="sip-ext-list" className="divide-y divide-[var(--color-card-line)]">
        {people.map((e) =>
          editing === e.id ? (
            <li key={e.id}>
              <ExtensionForm workspaceId={workspaceId} ext={e} exts={exts} onDone={() => setEditing(null)} />
            </li>
          ) : (
            <ExtensionRow key={e.id} workspaceId={workspaceId} id={e.id} number={e.number} userId={e.userId} bot={e.kind === SipExtensionKind.BOT} description={e.description} onEdit={setEditing} />
          ),
        )}
      </ul>
      {editing === 'new' ? (
        <ExtensionForm workspaceId={workspaceId} exts={exts} onDone={() => setEditing(null)} />
      ) : (
        <div className="px-3 py-2">
          <Button variant="secondary" size="sm" onClick={() => setEditing('new')} data-testid="sip-ext-add">
            {t('pbx.ext.add')}
          </Button>
        </div>
      )}
    </Card>
  );
}

function MemberLabel({ workspaceId, userId, bot }: { workspaceId: string; userId: string; bot?: boolean }): ReactNode {
  const name = useMemberName(workspaceId, userId);
  const fileId = useWorkspaces((s) => s.byId[workspaceId]?.members[userId]?.user?.avatarFileId ?? s.users[userId]?.avatarFileId ?? '');
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Avatar userId={userId} name={name} size={20} {...(fileId ? { fileId } : {})} />
      <span className="min-w-0 truncate" title={name}>
        {name}
      </span>
      {bot ? <span className="shrink-0 rounded-full bg-[var(--color-fill)] px-1.5 text-caption text-muted">{t('pbx.bot')}</span> : null}
    </span>
  );
}

const NumberPill = ({ number }: { number: string }): ReactNode => (
  <span className="inline-flex h-6 min-w-12 shrink-0 items-center justify-center rounded-full bg-[var(--color-fill)] px-2 text-body font-semibold tabular-nums">{number}</span>
);

const ExtensionRow = memo(function ExtensionRow({
  workspaceId,
  id,
  number,
  userId,
  bot,
  description,
  onEdit,
}: {
  workspaceId: string;
  id: string;
  number: string;
  userId: string;
  bot: boolean;
  description: string;
  onEdit: (id: string) => void;
}): ReactNode {
  const refresh = useRefresh(workspaceId);
  const remove = useMutation({
    mutationFn: () => api.sip.removeExtension(workspaceId, id),
    onSuccess: refresh,
    onError: (e) => {
      if (!reportPlanError(e, workspaceId)) toast.error(describeError(e).text);
    },
  });
  return (
    <li className="flex min-h-11 items-center gap-3 px-3 py-2" data-testid="sip-ext-row">
      <NumberPill number={number} />
      {/* Phone: the description goes under the name, the actions stay on the right. */}
      <span className="flex min-w-0 flex-1 items-center gap-x-3 gap-y-0.5 text-body mobile:flex-col mobile:items-start">
        <span className="min-w-0 flex-1 mobile:w-full">
          {userId ? <MemberLabel workspaceId={workspaceId} userId={userId} bot={bot} /> : <span className="text-muted">{t('pbx.ext.unassigned')}</span>}
        </span>
        {description ? (
          <span className="min-w-0 max-w-[40%] truncate text-muted mobile:max-w-full mobile:text-caption" title={description}>
            {description}
          </span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-0.5">
        <IconButton size="sm" label={t('pbx.edit')} onClick={() => onEdit(id)}>
          <Pencil className="size-3.5" aria-hidden />
        </IconButton>
        <IconButton
          size="sm"
          danger
          label={t('pbx.ext.delete')}
          disabled={remove.isPending}
          onClick={() =>
            void confirmAction(t('pbx.ext.deleteTitle', { number }), t('pbx.ext.deleteText'), t('pbx.delete')).then((ok) => {
              if (ok) remove.mutate();
            })
          }
        >
          <Trash2 className="size-3.5" aria-hidden />
        </IconButton>
      </span>
    </li>
  );
});

/** Members who may get a number: not guests (bots allowed), without a number of their own. */
function useAssignable(workspaceId: string, exts: SipExtension[], keep: string): WorkspaceMember[] {
  const members = useWorkspaces((s) => s.byId[workspaceId]?.members);
  return useMemo(() => {
    const taken = new Set(exts.map((e) => e.userId).filter((u) => u && u !== keep));
    return Object.values(members ?? {}).filter((m) => m.user && m.role !== WorkspaceRole.GUEST && !taken.has(m.user.id));
  }, [members, exts, keep]);
}

function ExtensionForm({ workspaceId, ext, exts, onDone }: { workspaceId: string; ext?: SipExtension; exts: SipExtension[]; onDone: () => void }): ReactNode {
  const refresh = useRefresh(workspaceId);
  const [number, setNumber] = useState(ext?.number ?? '');
  const [userId, setUserId] = useState(ext?.userId ?? '');
  const [description, setDescription] = useState(ext?.description ?? '');
  const [picking, setPicking] = useState(false);
  const errs = useFormErrors(workspaceId);
  const id = useId();
  const candidates = useAssignable(workspaceId, exts, ext?.userId ?? '');
  const groups = useMemo(() => [{ id: 'members', label: '', items: memberItems(candidates) }], [candidates]);
  const save = useMutation({
    mutationFn: () =>
      ext
        ? api.sip.updateExtension(workspaceId, ext.id, { number, userId, description: description.trim() })
        : api.sip.createExtension(workspaceId, { number, userId, description: description.trim() }),
    onSuccess: () => {
      refresh();
      toast.success(t('pbx.saved'));
      onDone();
    },
    onError: errs.report,
  });
  const ready = numberValid(number) && (!!userId || !!ext);
  return (
    <form
      className="flex flex-col gap-2 px-3 py-3"
      data-testid="sip-ext-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !save.isPending) save.mutate();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onDone();
        }
      }}
    >
      <div className="flex flex-wrap items-start gap-2">
        <span className="flex w-24 flex-col gap-1">
          <label htmlFor={`${id}-n`} className="text-caption text-muted">
            {t('pbx.ext.number')}
          </label>
          <Input
            id={`${id}-n`}
            data-testid="sip-ext-number"
            value={number}
            inputMode="numeric"
            placeholder="101"
            autoFocus
            className="tabular-nums"
            aria-invalid={errs.field['number'] ? true : undefined}
            onChange={(e) => {
              setNumber(cleanNumber(e.target.value));
              errs.clear('number');
            }}
          />
        </span>
        <span className="flex min-w-48 flex-1 flex-col gap-1">
          <span className="text-caption text-muted">{t('pbx.ext.member')}</span>
          <MemberPicker open={picking} onOpenChange={setPicking} restoreFocus="keyboard" groups={groups} onSelect={(it) => {
            if (it.kind !== 'member') return;
            setUserId(it.userId);
            errs.clear('userId');
            setPicking(false);
          }} placeholder={t('picker.searchPeople')} label={t('pbx.ext.pick')} testId="sip-ext-picker">
            <button
              type="button"
              data-testid="sip-ext-member"
              className="flex h-7 min-w-0 items-center gap-2 rounded-[var(--radius-control)] border border-line bg-elev px-2 text-left text-body shadow-[var(--shadow-card)] hover:bg-hover mobile:tap-h mobile:tap-px"
            >
              {userId ? <MemberLabel workspaceId={workspaceId} userId={userId} /> : <span className="text-muted">{t('pbx.ext.pick')}</span>}
            </button>
          </MemberPicker>
        </span>
        <span className="flex min-w-40 flex-1 flex-col gap-1">
          <label htmlFor={`${id}-d`} className="text-caption text-muted">
            {t('pbx.ext.description')}
          </label>
          <Input id={`${id}-d`} data-testid="sip-ext-description" value={description} maxLength={64} placeholder={t('pbx.ext.descriptionPlaceholder')} onChange={(e) => {
            setDescription(e.target.value);
            errs.clear('description');
          }} />
        </span>
      </div>
      <ErrLine text={errs.field['number'] ?? errs.field['userId'] ?? errs.field['description']} testId="sip-ext-error" />
      <div className="flex flex-wrap items-center justify-end gap-2">
        <ErrLine text={errs.form} />
        {ext && ext.userId ? (
          <Button variant="ghost" size="sm" className="mr-auto" onClick={() => setUserId('')}>
            {t('pbx.ext.unassign')}
          </Button>
        ) : null}
        <Button variant="secondary" size="sm" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" size="sm" busy={save.isPending} disabled={!ready} data-testid="sip-ext-save">
          {t('pbx.save')}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- targets

/** «Куда»: hang up, repeat (keys only), a menu, a person / bot number, a group. */
function TargetSelect({
  value,
  onChange,
  exts,
  groups,
  menus,
  allowRepeat = false,
  allowNone = false,
  selfMenu,
  label,
  testId,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  exts: SipExtension[];
  groups: SipGroup[];
  menus: SipIvrMenu[];
  allowRepeat?: boolean;
  allowNone?: boolean;
  selfMenu?: string;
  label: string;
  testId?: string;
  className?: string;
}): ReactNode {
  const names = useWorkspaces((s) => s.byId[exts[0]?.workspaceId ?? '']?.members);
  const people = exts.filter((e) => e.kind !== SipExtensionKind.GROUP);
  const memberName = (uid: string): string => (uid ? names?.[uid]?.nickname || names?.[uid]?.user?.displayName || '' : t('pbx.ext.unassigned'));
  return (
    <Select aria-label={label} title={label} value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId} className={className}>
      {allowNone ? <option value="">{t('pbx.target.none')}</option> : null}
      <option value="hangup">{t('pbx.target.hangup')}</option>
      {allowRepeat ? <option value="repeat">{t('pbx.target.repeat')}</option> : null}
      {value === 'missing' ? <option value="missing">{t('pbx.target.missing')}</option> : null}
      {menus.some((m) => m.id !== selfMenu) ? (
        <optgroup label={t('pbx.target.menus')}>
          {menus
            .filter((m) => m.id !== selfMenu)
            .map((m) => (
              <option key={m.id} value={`menu:${m.id}`}>
                {m.name}
              </option>
            ))}
        </optgroup>
      ) : null}
      {people.length ? (
        <optgroup label={t('pbx.target.people')}>
          {people.map((e) => (
            <option key={e.id} value={`extension:${e.id}`}>
              {`${e.number} · ${memberName(e.userId)}`}
            </option>
          ))}
        </optgroup>
      ) : null}
      {groups.length ? (
        <optgroup label={t('pbx.target.groups')}>
          {groups.map((g) => (
            <option key={g.id} value={`group:${g.id}`}>
              {`${g.extension?.number ?? ''} · ${g.name}`}
            </option>
          ))}
        </optgroup>
      ) : null}
    </Select>
  );
}

function MissingNote({ target }: { target: SipRouteTarget | undefined }): ReactNode {
  return target?.missing ? (
    <span className="flex items-center gap-1 text-caption text-muted" data-testid="sip-target-missing">
      <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
      {t('pbx.target.missingHint')}
    </span>
  ) : null;
}

// ---------------------------------------------------------------- groups

function GroupsCard({ workspaceId, exts, groups, menus }: { workspaceId: string; exts: SipExtension[]; groups: SipGroup[]; menus: SipIvrMenu[] }): ReactNode {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <Card title={t('pbx.group.title')} footer={t('pbx.group.footer')}>
      {groups.length === 0 && editing !== 'new' ? (
        <p className="px-3 py-3 text-body text-muted" data-testid="sip-group-empty">
          {t('pbx.group.empty')}
        </p>
      ) : null}
      <ul className="divide-y divide-[var(--color-card-line)]" data-testid="sip-group-list">
        {groups.map((g) =>
          editing === g.id ? (
            <li key={g.id}>
              <GroupForm workspaceId={workspaceId} group={g} exts={exts} groups={groups} menus={menus} onDone={() => setEditing(null)} />
            </li>
          ) : (
            <GroupRow
              key={g.id}
              id={g.id}
              name={g.name}
              number={g.extension?.number ?? ''}
              roundRobin={g.strategy === SipGroupStrategy.ROUND_ROBIN}
              members={g.members.length}
              warn={!!g.onFail?.missing}
              onEdit={setEditing}
            />
          ),
        )}
      </ul>
      {editing === 'new' ? (
        <GroupForm workspaceId={workspaceId} exts={exts} groups={groups} menus={menus} onDone={() => setEditing(null)} />
      ) : (
        <div className="px-3 py-2">
          <Button variant="secondary" size="sm" onClick={() => setEditing('new')} data-testid="sip-group-add">
            {t('pbx.group.add')}
          </Button>
        </div>
      )}
    </Card>
  );
}

const GroupRow = memo(function GroupRow({
  id,
  name,
  number,
  roundRobin,
  members,
  warn,
  onEdit,
}: {
  id: string;
  name: string;
  number: string;
  roundRobin: boolean;
  members: number;
  warn: boolean;
  onEdit: (id: string) => void;
}): ReactNode {
  return (
    <li className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2" data-testid="sip-group-row">
      <NumberPill number={number} />
      <span className="min-w-24 flex-1 truncate text-body font-medium" title={name}>
        {name}
      </span>
      <span className="shrink-0 text-body text-muted">
        {t(roundRobin ? 'pbx.group.roundRobin' : 'pbx.group.ringAll')} · {plural('pbx.group.members', members)}
      </span>
      {warn ? <TriangleAlert className="size-4 shrink-0 text-[var(--color-yellow)]" aria-label={t('pbx.target.missingHint')} /> : null}
      <IconButton size="sm" label={t('pbx.edit')} onClick={() => onEdit(id)}>
        <Pencil className="size-3.5" aria-hidden />
      </IconButton>
    </li>
  );
});

function GroupForm({
  workspaceId,
  group,
  exts,
  groups,
  menus,
  onDone,
}: {
  workspaceId: string;
  group?: SipGroup;
  exts: SipExtension[];
  groups: SipGroup[];
  menus: SipIvrMenu[];
  onDone: () => void;
}): ReactNode {
  const refresh = useRefresh(workspaceId);
  const errs = useFormErrors(workspaceId);
  const id = useId();
  const [name, setName] = useState(group?.name ?? '');
  const [number, setNumber] = useState(group?.extension?.number ?? '');
  const [roundRobin, setRoundRobin] = useState(group?.strategy === SipGroupStrategy.ROUND_ROBIN);
  const [ringSec, setRingSec] = useState(String(group?.ringSec || 30));
  const [memberSec, setMemberSec] = useState(String(group?.memberRingSec || 15));
  const [members, setMembers] = useState<string[]>(() => group?.members.map((m) => m.extensionId) ?? []);
  const [onFail, setOnFail] = useState(targetValue(group?.onFail));
  const byId = useMemo(() => new Map(exts.map((e) => [e.id, e])), [exts]);
  const free = exts.filter((e) => e.kind !== SipExtensionKind.GROUP && !members.includes(e.id));
  const move = (i: number, d: -1 | 1): void =>
    setMembers((cur) => {
      const next = [...cur];
      const j = i + d;
      if (j < 0 || j >= next.length) return cur;
      [next[i], next[j]] = [next[j] as string, next[i] as string];
      return next;
    });
  const body = {
    name: name.trim(),
    number,
    strategy: roundRobin ? SipGroupStrategy.ROUND_ROBIN : SipGroupStrategy.RING_ALL,
    ringSec: Number(ringSec) || 0,
    memberRingSec: Number(memberSec) || 0,
    onFail: targetInit(onFail),
    members: { extensionIds: members },
  };
  const save = useMutation({
    mutationFn: () => (group ? api.sip.updateGroup(workspaceId, group.id, body) : api.sip.createGroup(workspaceId, body)),
    onSuccess: () => {
      refresh();
      toast.success(t('pbx.saved'));
      onDone();
    },
    onError: errs.report,
  });
  const remove = useMutation({
    mutationFn: () => api.sip.removeGroup(workspaceId, group?.id ?? ''),
    onSuccess: () => {
      refresh();
      onDone();
    },
    onError: errs.report,
  });
  const ready = !!name.trim() && numberValid(number);
  const sec = roundRobin ? memberSec : ringSec;
  return (
    <form
      className="flex flex-col gap-3 px-3 py-3"
      data-testid="sip-group-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !save.isPending) save.mutate();
      }}
    >
      <div className="flex flex-wrap items-start gap-2">
        <span className="flex min-w-40 flex-1 flex-col gap-1">
          <label htmlFor={`${id}-name`} className="text-caption text-muted">
            {t('pbx.group.name')}
          </label>
          <Input id={`${id}-name`} data-testid="sip-group-name" value={name} maxLength={64} autoFocus placeholder={t('pbx.group.namePlaceholder')} onChange={(e) => {
            setName(e.target.value);
            errs.clear('name');
          }} />
          <ErrLine text={errs.field['name']} />
        </span>
        <span className="flex w-24 flex-col gap-1">
          <label htmlFor={`${id}-n`} className="text-caption text-muted">
            {t('pbx.ext.number')}
          </label>
          <Input id={`${id}-n`} data-testid="sip-group-number" value={number} inputMode="numeric" placeholder="1001" className="tabular-nums" onChange={(e) => {
            setNumber(cleanNumber(e.target.value));
            errs.clear('number');
          }} />
        </span>
      </div>
      <ErrLine text={errs.field['number']} />
      <div className="flex flex-wrap items-center gap-3">
        <Segmented<'all' | 'rr'>
          label={t('pbx.group.strategy')}
          value={roundRobin ? 'rr' : 'all'}
          onChange={(v) => setRoundRobin(v === 'rr')}
          options={[
            { value: 'all', label: t('pbx.group.ringAll') },
            { value: 'rr', label: t('pbx.group.roundRobin') },
          ]}
          testId="sip-group-strategy"
        />
        <label className="flex items-center gap-2 text-body">
          <span className="text-muted">{t(roundRobin ? 'pbx.group.memberSec' : 'pbx.group.ringSec')}</span>
          <Input
            aria-label={t(roundRobin ? 'pbx.group.memberSec' : 'pbx.group.ringSec')}
            value={sec}
            inputMode="numeric"
            className="w-16! tabular-nums"
            onChange={(e) => (roundRobin ? setMemberSec : setRingSec)(e.target.value.replace(/\D/g, '').slice(0, 2))}
          />
          <span className="text-muted">{t('pbx.sec')}</span>
        </label>
      </div>
      <p className="text-caption text-faint">{t(roundRobin ? 'pbx.group.roundRobinHint' : 'pbx.group.ringAllHint')}</p>
      <ErrLine text={errs.field['ringSec'] ?? errs.field['memberRingSec']} />
      <div className="flex flex-col gap-1">
        <span className="text-caption text-muted">{t('pbx.group.order')}</span>
        {members.length ? (
          <ol className="flex flex-col rounded-[var(--radius-card)] border border-line" data-testid="sip-group-members">
            {members.map((m, i) => {
              const e = byId.get(m);
              return (
                <li key={m} className="flex min-h-9 items-center gap-2 border-b border-line px-2 py-1 last:border-b-0">
                  <span className="w-5 shrink-0 text-right text-caption tabular-nums text-faint">{i + 1}</span>
                  <NumberPill number={e?.number ?? '—'} />
                  <span className="min-w-0 flex-1 text-body">
                    {e?.userId ? <MemberLabel workspaceId={workspaceId} userId={e.userId} bot={e.kind === SipExtensionKind.BOT} /> : <span className="text-muted">{t('pbx.ext.unassigned')}</span>}
                  </span>
                  <IconButton size="sm" label={t('pbx.up')} disabled={i === 0} onClick={() => move(i, -1)}>
                    <ArrowUp className="size-3.5" aria-hidden />
                  </IconButton>
                  <IconButton size="sm" label={t('pbx.down')} disabled={i === members.length - 1} onClick={() => move(i, 1)}>
                    <ArrowDown className="size-3.5" aria-hidden />
                  </IconButton>
                  <IconButton size="sm" label={t('pbx.group.removeMember')} onClick={() => setMembers((cur) => cur.filter((x) => x !== m))}>
                    <X className="size-3.5" aria-hidden />
                  </IconButton>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="text-body text-muted">{t('pbx.group.noMembers')}</p>
        )}
        {free.length && members.length < 20 ? (
          <Select
            aria-label={t('pbx.group.addMember')}
            value=""
            className="w-64 mobile:w-full"
            data-testid="sip-group-add-member"
            onChange={(e) => {
              const v = e.target.value;
              if (v) setMembers((cur) => [...cur, v]);
              errs.clear('members');
            }}
          >
            <option value="">{t('pbx.group.addMember')}</option>
            {free.map((e) => (
              <ExtOption key={e.id} workspaceId={workspaceId} ext={e} />
            ))}
          </Select>
        ) : null}
        <ErrLine text={errs.field['members']} />
      </div>
      <label className="flex flex-wrap items-center gap-2 text-body">
        <span className="text-muted">{t('pbx.group.onFail')}</span>
        <TargetSelect value={onFail} onChange={setOnFail} exts={exts} groups={groups.filter((g) => g.id !== group?.id)} menus={menus} label={t('pbx.group.onFail')} className="w-64 mobile:w-full" testId="sip-group-onfail" />
        <MissingNote target={onFail === 'missing' ? group?.onFail : undefined} />
      </label>
      <ErrLine text={errs.field['onFail']} />
      <div className="flex flex-wrap items-center justify-end gap-2">
        <ErrLine text={errs.form} />
        {group ? (
          <Button
            variant="destructive"
            size="sm"
            className="mr-auto"
            busy={remove.isPending}
            onClick={() =>
              void confirmAction(t('pbx.group.deleteTitle', { name: group.name }), t('pbx.group.deleteText'), t('pbx.delete')).then((ok) => {
                if (ok) remove.mutate();
              })
            }
          >
            {t('pbx.group.delete')}
          </Button>
        ) : null}
        <Button variant="secondary" size="sm" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" size="sm" busy={save.isPending} disabled={!ready} data-testid="sip-group-save">
          {t('pbx.save')}
        </Button>
      </div>
    </form>
  );
}

function ExtOption({ workspaceId, ext }: { workspaceId: string; ext: SipExtension }): ReactNode {
  const name = useMemberName(workspaceId, ext.userId);
  return <option value={ext.id}>{`${ext.number} · ${ext.userId ? name : t('pbx.ext.unassigned')}`}</option>;
}

// ---------------------------------------------------------------- voice menus

function MenusCard({ workspaceId, exts, groups, menus }: { workspaceId: string; exts: SipExtension[]; groups: SipGroup[]; menus: SipIvrMenu[] }): ReactNode {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <Card title={t('pbx.menu.title')} footer={t('pbx.menu.footer')}>
      {menus.length === 0 && editing !== 'new' ? (
        <p className="px-3 py-3 text-body text-muted" data-testid="sip-menu-empty">
          {t('pbx.menu.empty')}
        </p>
      ) : null}
      <ul className="divide-y divide-[var(--color-card-line)]" data-testid="sip-menu-list">
        {menus.map((m) =>
          editing === m.id ? (
            <li key={m.id}>
              <MenuForm workspaceId={workspaceId} menu={m} exts={exts} groups={groups} menus={menus} onDone={() => setEditing(null)} />
            </li>
          ) : (
            <MenuRow
              key={m.id}
              id={m.id}
              name={m.name}
              promptMs={m.promptStatus === SipPromptStatus.READY ? m.promptDurationMs : 0}
              keys={m.items.length}
              warn={m.items.some((it) => it.action?.missing) || !!m.onNoInput?.missing}
              onEdit={setEditing}
            />
          ),
        )}
      </ul>
      {editing === 'new' ? (
        <MenuForm workspaceId={workspaceId} exts={exts} groups={groups} menus={menus} onDone={() => setEditing(null)} />
      ) : (
        <div className="px-3 py-2">
          <Button variant="secondary" size="sm" onClick={() => setEditing('new')} data-testid="sip-menu-add">
            {t('pbx.menu.add')}
          </Button>
        </div>
      )}
    </Card>
  );
}

const MenuRow = memo(function MenuRow({
  id,
  name,
  promptMs,
  keys,
  warn,
  onEdit,
}: {
  id: string;
  name: string;
  promptMs: number;
  keys: number;
  warn: boolean;
  onEdit: (id: string) => void;
}): ReactNode {
  return (
    <li className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2" data-testid="sip-menu-row">
      <span className="min-w-24 flex-1 truncate text-body font-medium" title={name}>
        {name}
      </span>
      <span className={cx('shrink-0 text-body', promptMs ? 'text-muted' : 'text-muted')}>
        {promptMs ? t('pbx.menu.promptLen', { time: formatDuration(promptMs) }) : t('pbx.menu.noPrompt')} · {plural('pbx.menu.keys', keys)}
      </span>
      {warn ? <TriangleAlert className="size-4 shrink-0 text-[var(--color-yellow)]" aria-label={t('pbx.target.missingHint')} /> : null}
      <IconButton size="sm" label={t('pbx.edit')} onClick={() => onEdit(id)}>
        <Pencil className="size-3.5" aria-hidden />
      </IconButton>
    </li>
  );
});

/** Listen to the prompt: a plain <audio> element, never WebAudio (docs/02). */
function PromptPlayer({ fileId }: { fileId: string }): ReactNode {
  const [playing, setPlaying] = useState(false);
  const el = useRef<HTMLAudioElement | null>(null);
  useEffect(
    () => () => {
      el.current?.pause();
      el.current = null;
    },
    [fileId],
  );
  const toggle = async (): Promise<void> => {
    if (playing) {
      el.current?.pause();
      setPlaying(false);
      return;
    }
    const { platform } = await import('../../platform');
    // A fresh element each time: it starts from the beginning (the file is cached by the browser).
    const a = new Audio(await platform.mediaUrl(`/api/files/${fileId}`));
    a.addEventListener('ended', () => setPlaying(false));
    el.current?.pause();
    el.current = a;
    setPlaying(true);
    await a.play().catch(() => setPlaying(false));
  };
  return (
    <IconButton label={t(playing ? 'pbx.menu.stop' : 'pbx.menu.listen')} onClick={() => void toggle()} data-testid="sip-menu-listen">
      {playing ? <Pause className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />}
    </IconButton>
  );
}

function PromptRow({ workspaceId, menu }: { workspaceId: string; menu: SipIvrMenu }): ReactNode {
  const refresh = useRefresh(workspaceId);
  const input = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const ready = menu.promptStatus === SipPromptStatus.READY && !!menu.promptFileId;
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const meta = await uploadFile(uploadPath(workspaceId, ''), file, file.name, () => undefined).promise;
      return api.sip.updateMenu(workspaceId, menu.id, { promptSourceFileId: meta.id });
    },
    onMutate: () => setErr(null),
    onSuccess: () => {
      refresh();
      toast.success(t('pbx.menu.promptSaved'));
    },
    onError: (e) => {
      log.warn('sip prompt upload', e);
      const f = fieldError(e);
      if (f) setErr(f.text);
      else if (!reportPlanError(e, workspaceId)) setErr(describeError(e).text);
    },
  });
  const clear = useMutation({
    mutationFn: () => api.sip.updateMenu(workspaceId, menu.id, { promptSourceFileId: '' }),
    onSuccess: refresh,
    onError: (e) => setErr(describeError(e).text),
  });
  return (
    <div className="flex flex-col gap-1">
      <span className="text-caption text-muted">{t('pbx.menu.prompt')}</span>
      <div className="flex flex-wrap items-center gap-2" data-testid="sip-menu-prompt">
        {ready ? <PromptPlayer fileId={menu.promptFileId} /> : null}
        <span className={cx('text-body', ready ? 'tabular-nums' : 'text-muted')}>
          {upload.isPending ? t('pbx.menu.processing') : ready ? formatDuration(menu.promptDurationMs) : t('pbx.menu.noPrompt')}
        </span>
        <input
          ref={input}
          type="file"
          accept={PROMPT_ACCEPT}
          className="hidden"
          data-testid="sip-menu-prompt-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            if (f.size > MAX_PROMPT_UPLOAD) {
              setErr(t('pbx.err.prompt'));
              return;
            }
            upload.mutate(f);
          }}
        />
        <Button variant="secondary" size="sm" busy={upload.isPending} onClick={() => input.current?.click()} data-testid="sip-menu-upload">
          {t(ready ? 'pbx.menu.replace' : 'pbx.menu.upload')}
        </Button>
        {ready ? (
          <Button variant="ghost" size="sm" busy={clear.isPending} onClick={() => clear.mutate()}>
            {t('pbx.menu.removePrompt')}
          </Button>
        ) : null}
      </div>
      <span className="text-caption text-faint">{t('pbx.menu.promptHint')}</span>
      <ErrLine text={err} testId="sip-menu-prompt-error" />
    </div>
  );
}

function MenuForm({
  workspaceId,
  menu,
  exts,
  groups,
  menus,
  onDone,
}: {
  workspaceId: string;
  menu?: SipIvrMenu;
  exts: SipExtension[];
  groups: SipGroup[];
  menus: SipIvrMenu[];
  onDone: () => void;
}): ReactNode {
  const refresh = useRefresh(workspaceId);
  const errs = useFormErrors(workspaceId);
  const id = useId();
  const [name, setName] = useState(menu?.name ?? '');
  const [timeout, setTimeoutSec] = useState(String(menu?.inputTimeoutSec || 5));
  const [repeats, setRepeats] = useState(String(menu?.repeats || 3));
  const [noInput, setNoInput] = useState(targetValue(menu?.onNoInput));
  const [keys, setKeys] = useState<Record<string, string>>(() => Object.fromEntries((menu?.items ?? []).map((it) => [it.digit, targetValue(it.action)])));
  const missing = useMemo(() => new Map((menu?.items ?? []).map((it) => [it.digit, it.action])), [menu]);
  const body = {
    name: name.trim(),
    inputTimeoutSec: Number(timeout) || 0,
    repeats: Number(repeats) || 0,
    onNoInput: targetInit(noInput),
    items: {
      items: KEYPAD.filter((d) => keys[d]).map((d) => ({ digit: d, action: targetInit(keys[d] as string) })),
    },
  };
  const save = useMutation({
    mutationFn: () => (menu ? api.sip.updateMenu(workspaceId, menu.id, body) : api.sip.createMenu(workspaceId, body)),
    onSuccess: () => {
      refresh();
      toast.success(t('pbx.saved'));
      onDone();
    },
    onError: errs.report,
  });
  const remove = useMutation({
    mutationFn: () => api.sip.removeMenu(workspaceId, menu?.id ?? ''),
    onSuccess: () => {
      refresh();
      onDone();
    },
    onError: errs.report,
  });
  const ready = !!name.trim();
  return (
    <form
      className="flex flex-col gap-3 px-3 py-3"
      data-testid="sip-menu-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !save.isPending) save.mutate();
      }}
    >
      <span className="flex flex-col gap-1">
        <label htmlFor={`${id}-name`} className="text-caption text-muted">
          {t('pbx.menu.name')}
        </label>
        <Input id={`${id}-name`} data-testid="sip-menu-name" value={name} maxLength={64} autoFocus placeholder={t('pbx.menu.namePlaceholder')} className="max-w-80" onChange={(e) => {
          setName(e.target.value);
          errs.clear('name');
        }} />
        <ErrLine text={errs.field['name']} />
      </span>
      {menu ? <PromptRow workspaceId={workspaceId} menu={menu} /> : <p className="text-caption text-faint">{t('pbx.menu.promptAfterSave')}</p>}
      <div className="flex flex-col gap-1">
        <span className="text-caption text-muted">{t('pbx.menu.keysTitle')}</span>
        <div className="grid grid-cols-3 gap-2 mobile:grid-cols-1" data-testid="sip-menu-keys">
          {KEYPAD.map((d) => (
            <div key={d} className="flex min-w-0 items-center gap-2">
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[var(--color-fill)] text-body font-semibold" aria-hidden>
                {d}
              </span>
              <TargetSelect
                value={keys[d] ?? ''}
                onChange={(v) => {
                  setKeys((cur) => ({ ...cur, [d]: v }));
                  errs.clear('items');
                }}
                exts={exts}
                groups={groups}
                menus={menus}
                {...(menu ? { selfMenu: menu.id } : {})}
                allowRepeat
                allowNone
                label={t('pbx.menu.key', { key: d })}
                className={cx('min-w-0 flex-1', keys[d] === 'missing' && missing.get(d)?.missing && 'border-[var(--color-yellow)]')}
                testId={`sip-menu-key-${d}`}
              />
            </div>
          ))}
        </div>
        <ErrLine text={errs.field['items'] ?? errs.field['digit']} />
        {Object.values(keys).includes('missing') ? <MissingNote target={{ missing: true } as SipRouteTarget} /> : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-2 text-body">
          <span className="text-muted">{t('pbx.menu.timeout')}</span>
          <Input value={timeout} inputMode="numeric" className="w-16! tabular-nums" aria-label={t('pbx.menu.timeout')} onChange={(e) => setTimeoutSec(e.target.value.replace(/\D/g, '').slice(0, 2))} />
          <span className="text-muted">{t('pbx.sec')}</span>
        </label>
        <label className="flex items-center gap-2 text-body">
          <span className="text-muted">{t('pbx.menu.repeats')}</span>
          <Input value={repeats} inputMode="numeric" className="w-14! tabular-nums" aria-label={t('pbx.menu.repeats')} onChange={(e) => setRepeats(e.target.value.replace(/\D/g, '').slice(0, 1))} />
        </label>
      </div>
      <ErrLine text={errs.field['inputTimeoutSec'] ?? errs.field['repeats']} />
      <label className="flex flex-wrap items-center gap-2 text-body">
        <span className="text-muted">{t('pbx.menu.noInput')}</span>
        <TargetSelect value={noInput} onChange={setNoInput} exts={exts} groups={groups} menus={menus} {...(menu ? { selfMenu: menu.id } : {})} label={t('pbx.menu.noInput')} className="w-64 mobile:w-full" testId="sip-menu-noinput" />
        <MissingNote target={noInput === 'missing' ? menu?.onNoInput : undefined} />
      </label>
      <ErrLine text={errs.field['onNoInput']} />
      <div className="flex flex-wrap items-center justify-end gap-2">
        <ErrLine text={errs.form} />
        {menu ? (
          <Button
            variant="destructive"
            size="sm"
            className="mr-auto"
            busy={remove.isPending}
            onClick={() =>
              void confirmAction(t('pbx.menu.deleteTitle', { name: menu.name }), t('pbx.menu.deleteText'), t('pbx.delete')).then((ok) => {
                if (ok) remove.mutate();
              })
            }
          >
            {t('pbx.menu.delete')}
          </Button>
        ) : null}
        <Button variant="secondary" size="sm" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" size="sm" busy={save.isPending} disabled={!ready} data-testid="sip-menu-save">
          {t('pbx.save')}
        </Button>
      </div>
    </form>
  );
}
