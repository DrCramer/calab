import { timestampDate } from '@bufbuild/protobuf/wkt';
import {
  SipExtensionKind,
  SipGroupStrategy,
  SipInboundMode,
  SipPromptStatus,
  SipRegistrationStatus,
  WorkspaceRole,
  type ListSipIvrMenusResponse,
  type SipExtension,
  type SipGroup,
  type SipIvrMenu,
  type SipRegistration,
  type SipRouteTarget,
  type SipSettings,
  type WorkspaceMember,
} from '@calaba/protocol';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Pause, Pencil, Play, Trash2, TriangleAlert, Upload, X } from 'lucide-react';
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { confirmAction } from '../../components/Confirm';
import { Button, Card, IconButton, Input, PasswordInput, Row, Segmented, Select, Spinner, Switch, cx } from '../../components/ui';
import { plural, t } from '../../i18n';
import { describeError } from '../../lib/api/errors';
import { fmt } from '../../lib/format';
import { api } from '../../lib/api/endpoints';
import { formatPhone } from '../../lib/sip';
import {
  PROMPT_ACCEPT,
  cleanNumber,
  extensionsKey as extKey,
  fieldError,
  groupsKey as groupKey,
  menusKey as menuKey,
  numberValid,
  promptFileError,
  targetInit,
  targetValue,
} from '../../lib/sipPbx';
import { reportPlanError } from '../../services/plan';
import { toast } from '../../stores/toasts';
import { useMemberName, useWorkspaces } from '../../stores/workspaces';
import { memberItems } from '../people/memberPickItems';
import { MemberPicker } from '../people/MemberPicker';
import { formatDuration } from '../shell/voiceFormat';
import { clearPromptError, promptError, uploadPrompt, usePromptUpload } from './promptUpload';

/*
 * Workspace settings → «Телефония» → the exchange (ADR-0117 step 1, docs/08 «Телефония»;
 * MANAGE_INTEGRATIONS), one section per tab (TelephonyTab, CBF-77): «Номера» (number · member or
 * bot · description), «Группы» (number, all at once / one by one, members in order, the optional
 * fallback — ADR-0124), «IVR» (voice menus: the recorded prompt — chosen already in the new-menu
 * form, uploaded right after «Сохранить» — what each key 1–9 * 0 # does, «нет нажатия»). Each card
 * is a list; a row opens its inline form. «Входящие» (in «Настройки», shown when the server can
 * take inbound calls): the switch, how calls arrive (to our address with the provider's
 * addresses, or over a registration at the provider — ADR-0121, its state line), where calls go,
 * saved with PUT …/sip/inbound. Rows are memo'd with primitive props; the lists change only by the
 * admin's own saves (react-query), never by a live event.
 */

/** The keys of a menu in phone keypad order. */
export const KEYPAD = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'] as const;

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

/** One tab's part of the exchange: «Номера», «Группы», «IVR» or «Входящие» of «Настройки». */
export type ExchangePart = 'numbers' | 'groups' | 'ivr' | 'inbound';

export function Exchange({ workspaceId, settings, part }: { workspaceId: string; settings: SipSettings; part: ExchangePart }): ReactNode {
  const inboundAvailable = settings.inboundAvailable;
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
  // The server takes no inbound calls yet: said where inbound is set up and where menus are built.
  const off =
    inboundAvailable || (part !== 'inbound' && part !== 'ivr') ? null : (
      <p className="px-1 text-caption text-faint" data-testid="sip-inbound-off">
        {t('pbx.inboundOff')}
      </p>
    );
  return (
    <div className="flex flex-col gap-6" data-testid="sip-exchange">
      {off}
      {part === 'inbound' && inboundAvailable ? (
        <InboundCard
          key={`${settings.inboundEnabled}:${settings.inboundSaved}:${settings.inboundTarget?.id ?? ''}:${settings.inboundAllowedCidrs.join(',')}:${settings.inboundMode}:${regKey(settings)}`}
          workspaceId={workspaceId}
          settings={settings}
          exts={x.exts}
          groups={x.groups}
          menus={x.menus}
        />
      ) : null}
      {part === 'numbers' ? <ExtensionsCard workspaceId={workspaceId} exts={x.exts} /> : null}
      {part === 'groups' ? <GroupsCard workspaceId={workspaceId} exts={x.exts} groups={x.groups} menus={x.menus} /> : null}
      {part === 'ivr' ? <MenusCard workspaceId={workspaceId} exts={x.exts} groups={x.groups} menus={x.menus} /> : null}
    </div>
  );
}

/** The saved registration fields (not its live state: the 15 s re-read must not reset the form). */
function regKey(s: SipSettings): string {
  const r = s.registration;
  return r ? `${r.registrar}|${r.domain}|${r.expiresSec}|${r.authUsername}|${r.hasPassword}` : '';
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
            <ExtensionRow key={e.id} workspaceId={workspaceId} id={e.id} number={e.number} userId={e.userId} bot={e.kind === SipExtensionKind.BOT} description={e.description} noExternal={e.externalBlocked} onEdit={setEditing} />
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
  noExternal,
  onEdit,
}: {
  workspaceId: string;
  id: string;
  number: string;
  userId: string;
  bot: boolean;
  description: string;
  noExternal: boolean;
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
        {noExternal ? (
          <span className="shrink-0 rounded-full bg-[var(--color-fill)] px-1.5 text-caption text-muted" data-testid="sip-ext-no-external" title={t('pbx.ext.noExternal')}>
            {t('pbx.ext.rowNoExternal')}
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
  const [noExternal, setNoExternal] = useState(!!ext?.externalBlocked);
  const [picking, setPicking] = useState(false);
  const errs = useFormErrors(workspaceId);
  const id = useId();
  const candidates = useAssignable(workspaceId, exts, ext?.userId ?? '');
  const groups = useMemo(() => [{ id: 'members', label: '', items: memberItems(candidates) }], [candidates]);
  const save = useMutation({
    mutationFn: () =>
      ext
        ? api.sip.updateExtension(workspaceId, ext.id, { number, userId, description: description.trim(), externalBlocked: noExternal })
        : api.sip.createExtension(workspaceId, { number, userId, description: description.trim(), externalBlocked: noExternal }),
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
      {/* ADR-0129: dialing this number from a voice menu is closed to external callers. */}
      <div data-testid="sip-ext-no-external-switch">
        <Switch checked={noExternal} onChange={setNoExternal} label={t('pbx.ext.noExternal')} hint={t('pbx.ext.noExternalHint')} />
      </div>
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

// ---------------------------------------------------------------- inbound calls

/** «Входящие» (ADR-0117 step 2, ADR-0121): answer calls to the Caller ID, how they arrive (to our address or over a registration at the provider), where they go. */
function InboundCard({
  workspaceId,
  settings,
  exts,
  groups,
  menus,
}: {
  workspaceId: string;
  settings: SipSettings;
  exts: SipExtension[];
  groups: SipGroup[];
  menus: SipIvrMenu[];
}): ReactNode {
  const qc = useQueryClient();
  const reg = settings.registration;
  const [on, setOn] = useState(settings.inboundEnabled);
  const [target, setTarget] = useState(targetValue(settings.inboundTarget) || 'hangup');
  const [cidrs, setCidrs] = useState(settings.inboundAllowedCidrs.join(', '));
  const [mode, setMode] = useState<'direct' | 'register'>(settings.inboundMode === SipInboundMode.REGISTER ? 'register' : 'direct');
  const [registrar, setRegistrar] = useState(reg?.registrar ?? '');
  const [domain, setDomain] = useState(reg?.domain ?? '');
  const [expires, setExpires] = useState(reg?.expiresSec ? String(reg.expiresSec) : '600');
  const [authUser, setAuthUser] = useState(reg?.authUsername ?? '');
  const [password, setPassword] = useState('');
  const [advanced, setAdvanced] = useState(Boolean(reg?.registrar || reg?.domain || (reg && reg.expiresSec !== 600)));
  const [own, setOwn] = useState(Boolean(reg?.authUsername || reg?.hasPassword));
  const errs = useFormErrors(workspaceId);
  const cidrId = useId();
  const f = useId();
  const showMode = settings.registrationAvailable || settings.inboundMode === SipInboundMode.REGISTER;
  const register = mode === 'register';
  const save = useMutation({
    mutationFn: () =>
      api.sip.saveInbound(workspaceId, {
        enabled: on,
        target: targetInit(target === 'missing' ? 'hangup' : target),
        allowedCidrs: cidrs
          .split(/[\s,;]+/)
          .map((c) => c.trim())
          .filter(Boolean),
        mode: register ? SipInboundMode.REGISTER : SipInboundMode.DIRECT,
        registration: register
          ? {
              registrar: advanced ? registrar.trim() : '',
              domain: advanced ? domain.trim() : '',
              expiresSec: advanced ? Number(expires) || 0 : 600,
              keepaliveSec: reg?.keepaliveSec ?? 30,
              authUsername: own ? authUser.trim() : '',
              // Unset keeps the stored password; turning «own» off drops a stored one.
              ...(own ? (password ? { password } : {}) : reg?.hasPassword ? { password: '' } : {}),
            }
          : undefined,
      }),
    onSuccess: () => {
      toast.info(t('pbx.saved'));
      void qc.invalidateQueries({ queryKey: ['sip', workspaceId] });
    },
    onError: errs.report,
  });
  const live = settings.inboundEnabled && settings.inboundSaved;
  const field = (id: string): string => `${f}-${id}`;
  return (
    <Card title={t('pbx.in.title')} footer={register ? t('pbx.in.footerRegister') : t('pbx.in.footer')}>
      <div className="px-3 py-1.5" data-testid="sip-inbound">
        <Switch
          checked={on}
          onChange={(v) => {
            setOn(v);
            errs.clear();
          }}
          label={t('pbx.in.enabled', { number: settings.callerId ? formatPhone(settings.callerId) : '—' })}
          hint={settings.enabled ? (live ? t('pbx.in.stateOn') : t('pbx.in.stateOff')) : t('pbx.in.enabledHint')}
          disabled={!settings.enabled && !on}
        />
      </div>
      {showMode ? (
        <Row label={t('pbx.in.mode')} hint={t('pbx.in.modeHint')}>
          <span className="flex min-w-0 flex-col items-end gap-1">
            <Segmented<'direct' | 'register'>
              label={t('pbx.in.mode')}
              value={mode}
              onChange={(v) => {
                setMode(v);
                errs.clear();
              }}
              options={[
                { value: 'direct', label: t('pbx.in.modeDirect') },
                { value: 'register', label: t('pbx.in.modeRegister') },
              ]}
              testId="sip-inbound-mode"
            />
            {register && !settings.registrationAvailable ? <span className="text-caption text-muted">{t('pbx.in.reg.noAgent')}</span> : null}
          </span>
        </Row>
      ) : null}
      {register && settings.inboundMode === SipInboundMode.REGISTER ? (
        <Row label={t('pbx.in.reg.status')}>
          <RegistrationStatus reg={reg} />
        </Row>
      ) : null}
      <Row label={t('pbx.in.target')}>
        <span className="flex min-w-0 flex-col items-end gap-1">
          <TargetSelect
            value={target}
            onChange={(v) => {
              setTarget(v);
              errs.clear('target');
            }}
            exts={exts}
            groups={groups}
            menus={menus}
            label={t('pbx.in.target')}
            testId="sip-inbound-target"
          />
          <MissingNote target={settings.inboundTarget} />
          <ErrLine text={errs.field.target} />
        </span>
      </Row>
      {register ? (
        <>
          <div className="px-3 py-1.5">
            <Switch checked={own} onChange={setOwn} label={t('pbx.in.reg.own')} hint={t('pbx.in.reg.ownHint')} />
          </div>
          {own ? (
            <>
              <Row label={t('pbx.in.reg.authUser')} htmlFor={field('user')}>
                <span className="flex min-w-0 flex-col items-end gap-1">
                  <Input
                    id={field('user')}
                    value={authUser}
                    maxLength={128}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) => {
                      setAuthUser(e.target.value);
                      errs.clear('regAuthUsername');
                    }}
                    data-testid="sip-reg-auth-user"
                  />
                  <ErrLine text={errs.field.regAuthUsername} />
                </span>
              </Row>
              <Row label={t('pbx.in.reg.password')} htmlFor={field('pw')}>
                <span className="flex min-w-0 flex-col items-end gap-1">
                  <PasswordInput
                    id={field('pw')}
                    value={password}
                    maxLength={256}
                    autoComplete="new-password"
                    placeholder={reg?.hasPassword ? t('sip.passwordSaved') : ''}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      errs.clear('regPassword');
                    }}
                    data-testid="sip-reg-password"
                  />
                </span>
              </Row>
            </>
          ) : null}
          <ErrRow text={errs.field.regPassword ?? errs.field.username} />
          <div className="px-3 py-1.5">
            <button
              type="button"
              className="text-caption font-medium text-accent-text hover:underline"
              aria-expanded={advanced}
              onClick={() => setAdvanced((v) => !v)}
              data-testid="sip-reg-advanced"
            >
              {t('pbx.in.reg.advanced')}
            </button>
          </div>
          {advanced ? (
            <>
              <Row label={t('pbx.in.reg.registrar')} hint={t('pbx.in.reg.registrarHint')} htmlFor={field('registrar')}>
                <span className="flex min-w-0 flex-col items-end gap-1">
                  <Input
                    id={field('registrar')}
                    value={registrar}
                    spellCheck={false}
                    placeholder={settings.host || 'sip.example.com'}
                    onChange={(e) => {
                      setRegistrar(e.target.value);
                      errs.clear('registrar');
                    }}
                    data-testid="sip-reg-registrar"
                  />
                  <ErrLine text={errs.field.registrar} />
                </span>
              </Row>
              <Row label={t('pbx.in.reg.domain')} hint={t('pbx.in.reg.domainHint')} htmlFor={field('domain')}>
                <span className="flex min-w-0 flex-col items-end gap-1">
                  <Input
                    id={field('domain')}
                    value={domain}
                    spellCheck={false}
                    placeholder={settings.host || 'sip.example.com'}
                    onChange={(e) => {
                      setDomain(e.target.value);
                      errs.clear('domain');
                    }}
                    data-testid="sip-reg-domain"
                  />
                  <ErrLine text={errs.field.domain} />
                </span>
              </Row>
              <Row label={t('pbx.in.reg.expires')} htmlFor={field('expires')}>
                <span className="flex min-w-0 flex-col items-end gap-1">
                  <Input
                    id={field('expires')}
                    value={expires}
                    inputMode="numeric"
                    className="w-24 tabular-nums"
                    onChange={(e) => {
                      setExpires(e.target.value.replace(/\D/g, '').slice(0, 4));
                      errs.clear('expiresSec');
                    }}
                    data-testid="sip-reg-expires"
                  />
                  <ErrLine text={errs.field.expiresSec ?? errs.field.keepaliveSec} />
                </span>
              </Row>
            </>
          ) : null}
        </>
      ) : null}
      {/* Both modes: over a registration the provider may still call from addresses other than its registrar's. */}
      <Row label={t('pbx.in.cidrs')} hint={t('pbx.in.cidrsHint')} htmlFor={cidrId}>
        <span className="flex min-w-0 flex-col items-end gap-1">
          <Input
            id={cidrId}
            value={cidrs}
            spellCheck={false}
            placeholder="203.0.113.0/24"
            onChange={(e) => {
              setCidrs(e.target.value);
              errs.clear('allowedCidrs');
            }}
            data-testid="sip-inbound-cidrs"
          />
          <ErrLine text={errs.field.allowedCidrs} />
        </span>
      </Row>
      <div className="flex flex-wrap items-center gap-3 px-3 py-2">
        <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending} data-testid="sip-inbound-save">
          {t('pbx.save')}
        </Button>
        <ErrLine text={errs.form} testId="sip-inbound-error" />
      </div>
    </Card>
  );
}

function ErrRow({ text }: { text: string | undefined }): ReactNode {
  return text ? (
    <div className="px-3 pb-1.5 text-right">
      <ErrLine text={text} />
    </div>
  ) : null;
}

/** The registration's state line (ADR-0121 §8); re-read with the settings every 15 s while visible. */
function RegistrationStatus({ reg }: { reg: SipRegistration | undefined }): ReactNode {
  const status = reg?.status ?? SipRegistrationStatus.OFF;
  let text: string;
  let tone = 'text-muted';
  switch (status) {
    case SipRegistrationStatus.REGISTERED: {
      const until = reg?.expiresAt ? fmt.time(timestampDate(reg.expiresAt)) : '—';
      text = t('pbx.in.reg.registered', { time: until });
      if (reg?.contactMasked) text += ` · ${t('pbx.in.reg.contact', { contact: reg.contactMasked })}`;
      tone = 'text-ok';
      break;
    }
    case SipRegistrationStatus.REGISTERING:
      text = t('pbx.in.reg.registering');
      break;
    case SipRegistrationStatus.FAILED:
      text = t('pbx.in.reg.failed', { error: reg?.error.startsWith('auth') ? t('pbx.in.reg.failedAuth') : reg?.error || '—' });
      tone = 'text-danger-text';
      break;
    case SipRegistrationStatus.UNAVAILABLE:
      text = t('pbx.in.reg.unavailable');
      tone = 'text-danger-text';
      break;
    default:
      text = t('pbx.in.reg.off');
  }
  return (
    <span className={cx('min-w-0 text-right text-caption [overflow-wrap:anywhere]', tone)} role="status" data-testid="sip-reg-status">
      {text}
    </span>
  );
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
              fallbackSec={g.fallbackEnabled ? g.fallbackSec : 0}
              warn={g.fallbackEnabled && !!g.onFail?.missing}
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
  fallbackSec,
  warn,
  onEdit,
}: {
  id: string;
  name: string;
  number: string;
  roundRobin: boolean;
  members: number;
  /** 0 = no fallback: the group rings until somebody answers (ADR-0124). */
  fallbackSec: number;
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
        {fallbackSec ? ` · ${t('pbx.group.rowFallback', { sec: fallbackSec })}` : ''}
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
  const [memberSec, setMemberSec] = useState(String(group?.memberRingSec || 15));
  const [members, setMembers] = useState<string[]>(() => group?.members.map((m) => m.extensionId) ?? []);
  const [fallback, setFallback] = useState(!!group?.fallbackEnabled);
  const [fallbackSec, setFallbackSec] = useState(String(group?.fallbackSec || 30));
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
    memberRingSec: Number(memberSec) || 0,
    fallbackEnabled: fallback,
    fallbackSec: Number(fallbackSec) || 0,
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
        {roundRobin ? (
          <label className="flex items-center gap-2 text-body">
            <span className="text-muted">{t('pbx.group.memberSec')}</span>
            <Input
              aria-label={t('pbx.group.memberSec')}
              value={memberSec}
              inputMode="numeric"
              className="w-16! tabular-nums"
              onChange={(e) => {
                setMemberSec(e.target.value.replace(/\D/g, '').slice(0, 2));
                errs.clear('memberRingSec');
              }}
            />
            <span className="text-muted">{t('pbx.sec')}</span>
          </label>
        ) : null}
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
          <p className="text-body text-muted">{t(free.length ? 'pbx.group.noMembers' : 'pbx.group.needNumbers')}</p>
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
      {/* ADR-0124: off — the group rings until somebody answers; on — after N s the call goes on. */}
      <div className="flex flex-col gap-2" data-testid="sip-group-fallback">
        <Switch
          checked={fallback}
          onChange={(v) => {
            setFallback(v);
            errs.clear('onFail');
            errs.clear('fallbackSec');
          }}
          label={t('pbx.group.fallback')}
          hint={t(fallback ? 'pbx.group.fallbackOnHint' : 'pbx.group.fallbackOffHint')}
        />
        {fallback ? (
          <div className="flex flex-wrap items-center gap-2 text-body">
            <label className="flex items-center gap-2">
              <span className="text-muted">{t('pbx.group.fallbackAfter')}</span>
              <Input
                aria-label={t('pbx.group.fallback')}
                value={fallbackSec}
                inputMode="numeric"
                className="w-16! tabular-nums"
                data-testid="sip-group-fallback-sec"
                onChange={(e) => {
                  setFallbackSec(e.target.value.replace(/\D/g, '').slice(0, 3));
                  errs.clear('fallbackSec');
                }}
              />
              <span className="text-muted">{t('pbx.sec')}</span>
            </label>
            <span className="text-muted">{t('pbx.group.fallbackTo')}</span>
            <TargetSelect
              value={onFail}
              onChange={(v) => {
                setOnFail(v);
                errs.clear('onFail');
              }}
              exts={exts}
              groups={groups.filter((g) => g.id !== group?.id)}
              menus={menus}
              label={t('pbx.group.onFail')}
              className="w-64 mobile:w-full"
              testId="sip-group-onfail"
            />
            <MissingNote target={onFail === 'missing' ? group?.onFail : undefined} />
          </div>
        ) : null}
        <ErrLine text={errs.field['fallbackSec'] ?? errs.field['onFail']} />
      </div>
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
  const qc = useQueryClient();
  // A new menu stays open after «Сохранить» as its edit form; the greeting chosen in the new
  // form is uploaded right then (it needs the menu's id), its progress shows in that form.
  const created = useCallback(
    (m: SipIvrMenu, file: File | null) => {
      qc.setQueryData<ListSipIvrMenusResponse>(menuKey(workspaceId), (cur) => (cur && !cur.menus.some((x) => x.id === m.id) ? { ...cur, menus: [...cur.menus, m] } : cur));
      setEditing(m.id);
      if (file) void uploadPrompt(workspaceId, m.id, file);
    },
    [qc, workspaceId],
  );
  // «Загрузить запись» of a row without one: the form opens on the menu with the upload (or the refusal).
  const uploadFor = useCallback(
    (id: string, file: File) => {
      setEditing(id);
      void uploadPrompt(workspaceId, id, file);
    },
    [workspaceId],
  );
  // A refusal belongs to the open form: another form (or none) drops it; so does leaving the tab.
  useEffect(() => {
    const s = usePromptUpload.getState();
    if (s.errMenu && s.errMenu !== editing) clearPromptError(s.errMenu);
  }, [editing]);
  useEffect(() => () => clearPromptError(usePromptUpload.getState().errMenu), []);
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
              onUpload={uploadFor}
            />
          ),
        )}
      </ul>
      {editing === 'new' ? (
        <MenuForm workspaceId={workspaceId} exts={exts} groups={groups} menus={menus} onDone={() => setEditing(null)} onCreated={created} />
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
  onUpload,
}: {
  id: string;
  name: string;
  promptMs: number;
  keys: number;
  warn: boolean;
  onEdit: (id: string) => void;
  onUpload: (id: string, file: File) => void;
}): ReactNode {
  return (
    <li className="flex min-h-11 items-center gap-3 px-3 py-2" data-testid="sip-menu-row">
      {/* Phone: the summary goes under the name, the actions stay on the right. */}
      <span className="flex min-w-0 flex-1 items-center gap-x-3 gap-y-0.5 mobile:flex-col mobile:items-start">
        <span className="min-w-0 flex-1 truncate text-body font-medium mobile:w-full" title={name}>
          {name}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-body text-muted mobile:text-caption">
          {promptMs ? t('pbx.menu.promptLen', { time: formatDuration(promptMs) }) : t('pbx.menu.noPrompt')} · {plural('pbx.menu.keys', keys)}
          {warn ? <TriangleAlert className="size-4 shrink-0 text-[var(--color-yellow)]" aria-label={t('pbx.target.missingHint')} /> : null}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-0.5">
        {promptMs ? null : <PromptPicker label={t('pbx.menu.upload')} variant="ghost" onFile={(f) => onUpload(id, f)} testId="sip-menu-row-upload" inputTestId="sip-menu-row-file" />}
        <IconButton size="sm" label={t('pbx.edit')} onClick={() => onEdit(id)}>
          <Pencil className="size-3.5" aria-hidden />
        </IconButton>
      </span>
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

/** The file picker of a greeting: a hidden input behind a button (MP3 / WAV / OGG). */
function PromptPicker({
  label,
  onFile,
  busy = false,
  variant = 'secondary',
  testId,
  inputTestId,
}: {
  label: string;
  onFile: (f: File) => void;
  busy?: boolean;
  variant?: 'secondary' | 'ghost';
  testId: string;
  inputTestId: string;
}): ReactNode {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={PROMPT_ACCEPT}
        className="hidden"
        data-testid={inputTestId}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) onFile(f);
        }}
      />
      <Button variant={variant} size="sm" busy={busy} onClick={() => input.current?.click()} data-testid={testId}>
        {/* The list row's quiet variant: an icon with the word; on a phone the icon alone (the word stays for screen readers). */}
        {variant === 'ghost' ? (
          <>
            <Upload className="size-3.5" aria-hidden />
            <span className="mobile:sr-only">{label}</span>
          </>
        ) : (
          label
        )}
      </Button>
    </>
  );
}

/** «Запись» of the menu form — the layout both forms share (a saved menu and a new one). */
function PromptLine({
  player,
  status,
  tabular = false,
  actions,
  silent,
  err,
}: {
  player?: ReactNode;
  status: string;
  tabular?: boolean;
  actions: ReactNode;
  /** No greeting (and none on its way): the menu is silent — say so. */
  silent: boolean;
  err: string | null;
}): ReactNode {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-caption text-muted">{t('pbx.menu.prompt')}</span>
      <div className="flex flex-wrap items-center gap-2" data-testid="sip-menu-prompt">
        {player}
        <span className={cx('min-w-0 max-w-full truncate text-body', tabular ? 'tabular-nums' : 'text-muted')} title={status}>
          {status}
        </span>
        {actions}
      </div>
      <span className="text-caption text-faint">{t('pbx.menu.promptHint')}</span>
      {silent ? <span className="text-caption text-muted">{t('pbx.menu.noPromptHint')}</span> : null}
      <ErrLine text={err} testId="sip-menu-prompt-error" />
    </div>
  );
}

/** A saved menu's greeting: listen, upload / replace (promptUpload.ts — progress, conversion), remove. */
function PromptRow({ workspaceId, menu }: { workspaceId: string; menu: SipIvrMenu }): ReactNode {
  const refresh = useRefresh(workspaceId);
  const busy = usePromptUpload((s) => s.menuId === menu.id);
  const pct = usePromptUpload((s) => (s.menuId === menu.id ? s.pct : null));
  const err = usePromptUpload((s) => (s.errMenu === menu.id ? s.err : ''));
  const ready = menu.promptStatus === SipPromptStatus.READY && !!menu.promptFileId;
  const clear = useMutation({
    mutationFn: () => api.sip.updateMenu(workspaceId, menu.id, { promptSourceFileId: '' }),
    onMutate: () => clearPromptError(menu.id),
    onSuccess: refresh,
    onError: (e) => promptError(menu.id, describeError(e).text),
  });
  return (
    <PromptLine
      player={ready ? <PromptPlayer fileId={menu.promptFileId} /> : null}
      status={busy ? (pct !== null ? t('pbx.menu.uploading', { pct }) : t('pbx.menu.processing')) : ready ? formatDuration(menu.promptDurationMs) : t('pbx.menu.noPrompt')}
      tabular={ready && !busy}
      silent={!ready && !busy}
      err={err || null}
      actions={
        <>
          <PromptPicker
            label={t(ready ? 'pbx.menu.replace' : 'pbx.menu.upload')}
            busy={busy}
            onFile={(f) => void uploadPrompt(workspaceId, menu.id, f)}
            testId="sip-menu-upload"
            inputTestId="sip-menu-prompt-file"
          />
          {ready ? (
            <Button variant="ghost" size="sm" busy={clear.isPending} onClick={() => clear.mutate()}>
              {t('pbx.menu.removePrompt')}
            </Button>
          ) : null}
        </>
      }
    />
  );
}

/** A new menu's greeting: chosen now (same checks as an upload), uploaded right after «Сохранить». */
function DraftPromptRow({ file, onFile }: { file: File | null; onFile: (f: File | null) => void }): ReactNode {
  const [err, setErr] = useState<string | null>(null);
  return (
    <PromptLine
      status={file ? t('pbx.menu.promptChosen', { name: file.name }) : t('pbx.menu.noPrompt')}
      silent={!file}
      err={err}
      actions={
        <>
          <PromptPicker
            label={t(file ? 'pbx.menu.replace' : 'pbx.menu.promptPick')}
            onFile={(f) => {
              const bad = promptFileError(f);
              setErr(bad ? t(bad) : null);
              if (!bad) onFile(f);
            }}
            testId="sip-menu-upload"
            inputTestId="sip-menu-prompt-file"
          />
          {file ? (
            <Button variant="ghost" size="sm" onClick={() => onFile(null)} data-testid="sip-menu-prompt-clear">
              {t('pbx.menu.promptClear')}
            </Button>
          ) : null}
        </>
      }
    />
  );
}

function MenuForm({
  workspaceId,
  menu,
  exts,
  groups,
  menus,
  onDone,
  onCreated,
}: {
  workspaceId: string;
  menu?: SipIvrMenu;
  exts: SipExtension[];
  groups: SipGroup[];
  menus: SipIvrMenu[];
  onDone: () => void;
  /** A new menu was saved: the form reopens on it and the chosen greeting (if any) uploads. */
  onCreated?: (m: SipIvrMenu, file: File | null) => void;
}): ReactNode {
  const refresh = useRefresh(workspaceId);
  const errs = useFormErrors(workspaceId);
  const id = useId();
  const [name, setName] = useState(menu?.name ?? '');
  const [draft, setDraft] = useState<File | null>(null);
  const [timeout, setTimeoutSec] = useState(String(menu?.inputTimeoutSec || 5));
  const [repeats, setRepeats] = useState(String(menu?.repeats || 3));
  const [noInput, setNoInput] = useState(targetValue(menu?.onNoInput));
  const [dial, setDial] = useState(!!menu?.dialExtensions);
  const [keys, setKeys] = useState<Record<string, string>>(() => Object.fromEntries((menu?.items ?? []).map((it) => [it.digit, targetValue(it.action)])));
  const missing = useMemo(() => new Map((menu?.items ?? []).map((it) => [it.digit, it.action])), [menu]);
  const body = {
    name: name.trim(),
    inputTimeoutSec: Number(timeout) || 0,
    repeats: Number(repeats) || 0,
    onNoInput: targetInit(noInput),
    dialExtensions: dial,
    items: {
      items: KEYPAD.filter((d) => keys[d]).map((d) => ({ digit: d, action: targetInit(keys[d] as string) })),
    },
  };
  const save = useMutation({
    mutationFn: () => (menu ? api.sip.updateMenu(workspaceId, menu.id, body) : api.sip.createMenu(workspaceId, body)),
    onSuccess: (r) => {
      refresh();
      toast.success(t('pbx.saved'));
      if (!menu && r.menu && onCreated) onCreated(r.menu, draft);
      else onDone();
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
      {menu ? <PromptRow workspaceId={workspaceId} menu={menu} /> : <DraftPromptRow file={draft} onFile={setDraft} />}
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
      {/* ADR-0129: the caller may dial an internal number (a person, a bot, a group) too. */}
      <div data-testid="sip-menu-dial">
        <Switch checked={dial} onChange={setDial} label={t('pbx.menu.dial')} hint={t('pbx.menu.dialHint')} />
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
