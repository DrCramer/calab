import { SipExtensionKind, type SipExtension, type SipGroup, type SipIvrMenu, type SipRouteTarget } from '@calaba/protocol';
import { Check, ChevronLeft, ChevronRight, TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Modal, Select, cx } from '../../../components/ui';
import { t } from '../../../i18n';
import { haptics } from '../../../lib/haptics';
import { useWorkspaces } from '../../../stores/workspaces';
import { usePhoneSettings } from './ui';

/*
 * «Куда» of the exchange (ADR-0117): hang up, repeat (a menu's keys), a menu, a person or a bot
 * number, a group. Desktop — a <select> with option groups; phone (ADR-0137 §7) — a row with the
 * chosen target and a chevron that opens a centred card: the simple actions, then «Голосовое меню ›»,
 * «Сотрудник или бот ›», «Группа ›» — the second level lists those (rows 44 px, a check on the
 * chosen one). Values are lib/sipPbx targetValue strings.
 */

export interface TargetOptions {
  exts: SipExtension[];
  groups: SipGroup[];
  menus: SipIvrMenu[];
  allowRepeat?: boolean;
  allowNone?: boolean;
  /** A menu's own id: it is not offered as its own target. */
  selfMenu?: string;
}

type Option = { value: string; label: string };

/** The choices of a target field, grouped as the <select> shows them. */
function useTargetChoices(o: TargetOptions): { simple: Option[]; menus: Option[]; people: Option[]; groups: Option[] } {
  const names = useWorkspaces((s) => s.byId[o.exts[0]?.workspaceId ?? '']?.members);
  const memberName = (uid: string): string => (uid ? names?.[uid]?.nickname || names?.[uid]?.user?.displayName || '' : t('pbx.ext.unassigned'));
  const simple: Option[] = [];
  if (o.allowNone) simple.push({ value: '', label: t('pbx.target.none') });
  simple.push({ value: 'hangup', label: t('pbx.target.hangup') });
  if (o.allowRepeat) simple.push({ value: 'repeat', label: t('pbx.target.repeat') });
  return {
    simple,
    menus: o.menus.filter((m) => m.id !== o.selfMenu).map((m) => ({ value: `menu:${m.id}`, label: m.name })),
    people: o.exts.filter((e) => e.kind !== SipExtensionKind.GROUP).map((e) => ({ value: `extension:${e.id}`, label: `${e.number} · ${memberName(e.userId)}` })),
    groups: o.groups.map((g) => ({ value: `group:${g.id}`, label: `${g.extension?.number ?? ''} · ${g.name}` })),
  };
}

/** The label of a target value («Положить трубку», the menu's name, «101 · Гром»). */
export function useTargetLabel(value: string, o: TargetOptions): string {
  const c = useTargetChoices(o);
  if (value === 'missing') return t('pbx.target.missing');
  return [...c.simple, ...c.menus, ...c.people, ...c.groups].find((x) => x.value === value)?.label ?? t('pbx.target.hangup');
}

/** The desktop <select>. */
export function TargetSelect({ value, onChange, label, testId, className, ...o }: TargetOptions & { value: string; onChange: (v: string) => void; label: string; testId?: string; className?: string }): ReactNode {
  const c = useTargetChoices(o);
  return (
    <Select aria-label={label} title={label} value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId} className={className}>
      {c.simple.map((x) => (
        <option key={x.value || 'none'} value={x.value}>
          {x.label}
        </option>
      ))}
      {value === 'missing' ? <option value="missing">{t('pbx.target.missing')}</option> : null}
      {c.menus.length ? (
        <optgroup label={t('pbx.target.menus')}>
          {c.menus.map((x) => (
            <option key={x.value} value={x.value}>
              {x.label}
            </option>
          ))}
        </optgroup>
      ) : null}
      {c.people.length ? (
        <optgroup label={t('pbx.target.people')}>
          {c.people.map((x) => (
            <option key={x.value} value={x.value}>
              {x.label}
            </option>
          ))}
        </optgroup>
      ) : null}
      {c.groups.length ? (
        <optgroup label={t('pbx.target.groups')}>
          {c.groups.map((x) => (
            <option key={x.value} value={x.value}>
              {x.label}
            </option>
          ))}
        </optgroup>
      ) : null}
    </Select>
  );
}

/** A target field: the <select> on the desktop, a row opening the card on a phone. */
export function TargetField(props: TargetOptions & { value: string; onChange: (v: string) => void; label: string; testId?: string; className?: string }): ReactNode {
  const phone = usePhoneSettings();
  const [open, setOpen] = useState(false);
  const current = useTargetLabel(props.value, props);
  if (!phone) return <TargetSelect {...props} />;
  return (
    <>
      <button
        type="button"
        aria-label={`${props.label}: ${current}`}
        onClick={() => setOpen(true)}
        className={cx('flex min-h-11 w-full min-w-0 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-fill)] px-3 text-left text-list active:bg-[var(--color-fill-hover)]', props.value === 'missing' && 'text-danger-text')}
        data-testid={props.testId}
        data-value={props.value}
        data-row-field
      >
        <span className="min-w-0 flex-1 truncate">{current}</span>
        <ChevronRight className="size-4 shrink-0 text-faint" aria-hidden />
      </button>
      <TargetCard {...props} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

type Level = 'top' | 'menus' | 'people' | 'groups';

/** The phone's centred card: the simple actions and the kinds, the second level — that kind's list. */
export function TargetCard({ open, onClose, value, onChange, label, ...o }: TargetOptions & { open: boolean; onClose: () => void; value: string; onChange: (v: string) => void; label: string }): ReactNode {
  const c = useTargetChoices(o);
  const [level, setLevel] = useState<Level>('top');
  const close = (): void => {
    setLevel('top');
    onClose();
  };
  const pick = (v: string): void => {
    if (v !== value) haptics.select();
    onChange(v);
    close();
  };
  const kinds: Array<{ level: Exclude<Level, 'top'>; label: string; items: Option[] }> = [
    { level: 'menus', label: t('pbx.target.menus'), items: c.menus },
    { level: 'people', label: t('pbx.target.people'), items: c.people },
    { level: 'groups', label: t('pbx.target.groups'), items: c.groups },
  ];
  const sub = kinds.find((k) => k.level === level);
  const kindOf = (v: string): Level => (v.startsWith('menu:') ? 'menus' : v.startsWith('extension:') ? 'people' : v.startsWith('group:') ? 'groups' : 'top');
  return (
    <Modal open={open} onClose={close} title={sub ? sub.label : label}>
      <div className="flex flex-col" data-testid="tset-target-card">
        {sub ? (
          <>
            <button type="button" onClick={() => setLevel('top')} className="-mt-1 mb-1 flex min-h-11 items-center gap-1 self-start text-list text-accent-text" data-testid="tset-target-back">
              <ChevronLeft className="size-5" aria-hidden />
              {label}
            </button>
            <OptionList options={sub.items} value={value} onPick={pick} />
          </>
        ) : (
          <>
            <OptionList options={value === 'missing' ? [...c.simple, { value: 'missing', label: t('pbx.target.missing') }] : c.simple} value={value} onPick={pick} />
            <ul className="mt-3 overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-card)]">
              {kinds
                .filter((k) => k.items.length > 0)
                .map((k) => {
                  const chosen = kindOf(value) === k.level ? k.items.find((x) => x.value === value)?.label : undefined;
                  return (
                    <li key={k.level} className="border-b border-[var(--color-card-line)] last:border-b-0">
                      <button type="button" onClick={() => setLevel(k.level)} className="flex min-h-11 w-full min-w-0 items-center gap-2 px-3 text-left text-list active:bg-[var(--color-fill-hover)]" data-testid={`tset-target-${k.level}`}>
                        <span className="min-w-0 flex-1 truncate">{k.label}</span>
                        {chosen ? <span className="min-w-0 max-w-[50%] truncate text-muted">{chosen}</span> : null}
                        <ChevronRight className="size-4 shrink-0 text-faint" aria-hidden />
                      </button>
                    </li>
                  );
                })}
            </ul>
          </>
        )}
      </div>
    </Modal>
  );
}

function OptionList({ options, value, onPick }: { options: Option[]; value: string; onPick: (v: string) => void }): ReactNode {
  return (
    <div role="radiogroup" className="flex flex-col overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-card)]">
      {options.map((x) => (
        <button
          key={x.value || 'none'}
          type="button"
          role="radio"
          aria-checked={x.value === value}
          onClick={() => onPick(x.value)}
          className="flex min-h-11 w-full min-w-0 items-center gap-2 border-b border-[var(--color-card-line)] px-3 text-left text-list last:border-b-0 active:bg-[var(--color-fill-hover)]"
        >
          <span className={cx('min-w-0 flex-1 break-words', x.value === 'missing' && 'text-danger-text')}>{x.label}</span>
          {x.value === value ? <Check className="size-4 shrink-0 text-accent-text" aria-hidden /> : null}
        </button>
      ))}
    </div>
  );
}

export function MissingNote({ target }: { target: SipRouteTarget | undefined }): ReactNode {
  return target?.missing ? (
    <span className="flex items-center gap-1 text-caption text-muted" data-testid="sip-target-missing">
      <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
      {t('pbx.target.missingHint')}
    </span>
  ) : null;
}
