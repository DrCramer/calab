import * as Dropdown from '../../components/radix/dropdown-menu';
import { WorkspaceRole } from '@calaba/protocol';
import { Check, ChevronDown, ListFilter, Search, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Button, IconButton, Input, Modal, Segmented, cx } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { haptics } from '../../lib/haptics';
import { menuBox, menuItem, menuLabel } from '../shell/menu';
import { MemberPicker } from '../people/MemberPicker';
import { memberItems } from '../people/memberPickItems';
import { activeChips, useTelephonyUi, type Direction, type JournalFilter, type Period, type Scope } from '../../stores/telephonyUi';
import { memberName, useWorkspaces } from '../../stores/workspaces';
import { useMayReadAll } from './access';

/*
 * The filters of «Недавние» (ADR-0137 §6–§7). Desktop: one bar — «Все | Пропущенные», the
 * direction, whose calls (VIEW_JOURNALS: «Мои / Все звонки / Сотрудник…»), the search pill and the
 * period, each a pill with ▾. Phone: the segments sit under the title (PhoneTelephony), the search
 * pill scrolls with the list and carries a funnel → a centred card with the rest; what is set shows
 * as removable chips under the search.
 */

const DIRECTIONS: Direction[] = ['all', 'in', 'out'];
const PERIODS: Period[] = ['any', 'today', 'yesterday', 'week', 'month'];

const dirLabel = (d: Direction): string => t(d === 'in' ? 'tel.dir.in' : d === 'out' ? 'tel.dir.out' : 'tel.dir.all');
const periodLabel = (p: Period): string => t(`tel.period.${p}`);

/** «Мои» / «Все звонки» / the employee's name. */
function useScopeLabel(ws: string, scope: Scope): string {
  return useWorkspaces(() => (scope === 'mine' ? t('tel.scope.mine') : scope === 'all' ? t('tel.scope.all') : memberName(ws, scope.slice(5))));
}

export const setFilter = (patch: Partial<JournalFilter>): void => useTelephonyUi.getState().setFilter(patch);

/** The desktop bar's controls (inside `<Bar>`: every control 28 px). */
export function DesktopFilters({ ws }: { ws: string }): ReactNode {
  useLocale();
  const segment = useTelephonyUi((s) => s.filter.segment);
  const direction = useTelephonyUi((s) => s.filter.direction);
  const period = useTelephonyUi((s) => s.filter.period);
  const all = useMayReadAll(ws);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 px-3" data-testid="tel-filters">
      <Segmented
        value={segment}
        onChange={(v) => setFilter({ segment: v })}
        label={t('tel.seg.label')}
        options={[
          { value: 'all', label: t('tel.seg.all') },
          { value: 'missed', label: t('tel.seg.missed') },
        ]}
        testId="tel-segment"
      />
      {/* Missed calls are inbound: no direction to choose there. */}
      {segment === 'all' ? <PillMenu label={t('tel.dir.label')} value={direction} options={DIRECTIONS.map((d) => ({ value: d, label: dirLabel(d) }))} onChange={(v) => setFilter({ direction: v })} placeholder={t('tel.dir.label')} neutral="all" testId="tel-dir" /> : null}
      {all ? <ScopeMenu ws={ws} /> : null}
      <SearchField className="ml-auto w-56 min-w-28 shrink" />
      <PillMenu label={t('tel.period.label')} value={period} options={PERIODS.map((p) => ({ value: p, label: periodLabel(p) }))} onChange={(v) => setFilter({ period: v })} placeholder={t('tel.period.label')} neutral="any" testId="tel-period" />
    </div>
  );
}

/**
 * A pill with ▾ and a radio menu. At its neutral value it reads as the filter's name («Период»),
 * set — as the value («7 дней»), tinted.
 */
function PillMenu<T extends string>({ label, value, options, onChange, placeholder, neutral, testId }: { label: string; value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; placeholder: string; neutral: T; testId: string }): ReactNode {
  const set = value !== neutral;
  const current = options.find((o) => o.value === value)?.label ?? '';
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>
        <Button variant="secondary" size="sm" aria-label={`${label}: ${current}`} className={cx('max-w-44 gap-1 pr-2', set && 'text-accent-text')} data-testid={testId}>
          <span className="min-w-0 truncate">{set ? current : placeholder}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted" aria-hidden />
        </Button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className={cx(menuBox, 'w-52')} sideOffset={4} align="start" collisionPadding={16}>
          <Dropdown.Label className={menuLabel}>{label}</Dropdown.Label>
          <Dropdown.RadioGroup value={value} onValueChange={(v) => onChange(v as T)}>
            {options.map((o) => (
              <Dropdown.RadioItem key={o.value} value={o.value} className={menuItem} data-testid={`${testId}-${o.value}`}>
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.value === value ? <Check className="size-4 shrink-0" aria-hidden /> : null}
              </Dropdown.RadioItem>
            ))}
          </Dropdown.RadioGroup>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/** «Мои / Все звонки / Сотрудник…» (VIEW_JOURNALS): «Сотрудник…» opens the member picker at the pill. */
function ScopeMenu({ ws }: { ws: string }): ReactNode {
  const scope = useTelephonyUi((s) => s.filter.scope);
  const label = useScopeLabel(ws, scope);
  const [picking, setPicking] = useState(false);
  return (
    <span className="relative flex">
      <Dropdown.Root modal={false}>
        <Dropdown.Trigger asChild>
          <Button variant="secondary" size="sm" aria-label={`${t('tel.scope.label')}: ${label}`} className={cx('max-w-48 gap-1 pr-2', scope !== 'mine' && 'text-accent-text')} data-testid="tel-scope">
            <span className="min-w-0 truncate">{label}</span>
            <ChevronDown className="size-3.5 shrink-0 text-muted" aria-hidden />
          </Button>
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content className={cx(menuBox, 'w-52')} sideOffset={4} align="start" collisionPadding={16}>
            <Dropdown.Label className={menuLabel}>{t('tel.scope.label')}</Dropdown.Label>
            <ScopeItems scope={scope} onPick={() => setPicking(true)} />
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
      <EmployeePicker ws={ws} open={picking} onOpenChange={setPicking} />
    </span>
  );
}

function ScopeItems({ scope, onPick }: { scope: Scope; onPick: () => void }): ReactNode {
  const item = (v: 'mine' | 'all', text: string): ReactNode => (
    <Dropdown.Item key={v} className={menuItem} onSelect={() => setFilter({ scope: v })} data-testid={`tel-scope-${v}`}>
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {scope === v ? <Check className="size-4 shrink-0" aria-hidden /> : null}
    </Dropdown.Item>
  );
  return (
    <>
      {item('mine', t('tel.scope.mine'))}
      {item('all', t('tel.scope.all'))}
      <Dropdown.Item className={menuItem} onSelect={onPick} data-testid="tel-scope-user">
        <span className="min-w-0 flex-1 truncate">{t('tel.scope.user')}</span>
        {scope.startsWith('user:') ? <Check className="size-4 shrink-0" aria-hidden /> : null}
      </Dropdown.Item>
    </>
  );
}

/** «Сотрудник…»: the members of the workspace (no guests, no bots). The anchor sits under the scope pill. */
function EmployeePicker({ ws, open, onOpenChange }: { ws: string; open: boolean; onOpenChange: (o: boolean) => void }): ReactNode {
  const members = useWorkspaces((s) => s.byId[ws]?.members);
  const roles = useWorkspaces((s) => s.byId[ws]?.roles);
  const groups = useMemo(() => {
    if (!open || !members) return [];
    const list = Object.values(members).filter((m) => m.role !== WorkspaceRole.GUEST && !m.user?.isBot);
    return [{ id: 'members', label: '', items: memberItems(list, { roles: roles ?? [] }) }];
  }, [open, members, roles]);
  return (
    <MemberPicker
      open={open}
      onOpenChange={onOpenChange}
      groups={groups}
      onSelect={(it) => {
        if (it.kind === 'member') setFilter({ scope: `user:${it.userId}` });
        onOpenChange(false);
      }}
      placeholder={t('picker.searchPeople')}
      label={t('tel.scope.user')}
      testId="tel-scope-picker"
    >
      <span aria-hidden className="pointer-events-none absolute bottom-0 left-0 size-px" />
    </MemberPicker>
  );
}

/** The search pill: digits of a number now; names and companies with the contacts (T4). */
export function SearchField({ className, phone = false, trailing }: { className?: string; phone?: boolean; trailing?: ReactNode }): ReactNode {
  const q = useTelephonyUi((s) => s.filter.q);
  return (
    <div className={cx('relative flex min-w-0 items-center', className)}>
      <Input
        type="search"
        inputMode="search"
        value={q}
        onChange={(e) => setFilter({ q: e.target.value })}
        placeholder={phone ? t('tel.search') : t('tel.searchShort')}
        aria-label={t('tel.search')}
        icon={<Search aria-hidden />}
        className={cx(phone && 'bg-hover shadow-none border-transparent', trailing ? 'pr-12' : q ? 'pr-8' : undefined)}
        data-testid="tel-search"
      />
      {q && !trailing ? (
        <button type="button" className="tap-hit absolute right-1 grid size-6 place-items-center rounded-full text-muted hover:text-fg" aria-label={t('tel.searchClear')} onClick={() => setFilter({ q: '' })}>
          <X className="size-3.5" aria-hidden />
        </button>
      ) : null}
      {trailing ? <span className="absolute right-0 flex items-center">{trailing}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------- phone

/** The funnel at the right end of the phone's search pill (at the thumb when the list is scrolled up). */
export function FilterButton({ onOpen }: { onOpen: () => void }): ReactNode {
  const count = useTelephonyUi((s) => activeChips(s.filter).length);
  return (
    <IconButton tip={false} label={count ? t('tel.filtersOn', { n: count }) : t('tel.filters')} onClick={onOpen} className={cx('size-11 rounded-full', count ? 'text-accent-text' : 'text-muted')} data-testid="tel-filter-open">
      <ListFilter className="size-5" aria-hidden />
    </IconButton>
  );
}

/** The centred card of the phone's filters: direction, whose calls, period; «Сбросить» at the bottom. */
export function FilterCard({ ws, open, onClose }: { ws: string; open: boolean; onClose: () => void }): ReactNode {
  const f = useTelephonyUi((s) => s.filter);
  const all = useMayReadAll(ws);
  const [picking, setPicking] = useState(false);
  const userLabel = useScopeLabel(ws, f.scope);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('tel.filters')}
      footer={
        <div className="flex w-full flex-col gap-2">
          <Button onClick={onClose} className="w-full" data-testid="tel-filter-done">
            {t('tel.filters.done')}
          </Button>
          <Button
            variant="secondary"
            className="w-full"
            disabled={activeChips(f).length === 0}
            onClick={() => {
              useTelephonyUi.getState().resetFilter();
              haptics.select();
            }}
            data-testid="tel-filter-reset"
          >
            {t('tel.filters.reset')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4" data-testid="tel-filter-card">
        {f.segment === 'all' ? <Radio label={t('tel.dir.label')} value={f.direction} options={DIRECTIONS.map((d) => ({ value: d, label: dirLabel(d) }))} onChange={(v) => setFilter({ direction: v })} /> : null}
        {all ? (
          <Radio
            label={t('tel.scope.label')}
            value={f.scope.startsWith('user:') ? 'user' : f.scope}
            options={[
              { value: 'mine', label: t('tel.scope.mine') },
              { value: 'all', label: t('tel.scope.all') },
              { value: 'user', label: f.scope.startsWith('user:') ? userLabel : t('tel.scope.user') },
            ]}
            onChange={(v) => (v === 'user' ? setPicking(true) : setFilter({ scope: v }))}
          />
        ) : null}
        <Radio label={t('tel.period.label')} value={f.period} options={PERIODS.map((p) => ({ value: p, label: periodLabel(p) }))} onChange={(v) => setFilter({ period: v })} />
        {all ? (
          <div className="relative">
            <EmployeePicker ws={ws} open={picking} onOpenChange={setPicking} />
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

/** A radio group of the card: rows 44 px, the check on the right (iOS settings). */
function Radio<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void }): ReactNode {
  return (
    <fieldset className="flex flex-col">
      <legend className="pb-1 text-caption font-semibold text-muted">{label}</legend>
      <div role="radiogroup" aria-label={label} className="flex flex-col overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-card)]">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            onClick={() => {
              if (o.value !== value) haptics.select();
              onChange(o.value);
            }}
            className="flex min-h-11 items-center gap-2 border-b border-[var(--color-card-line)] px-3 text-left text-list last:border-b-0"
          >
            <span className="min-w-0 flex-1 truncate">{o.label}</span>
            {o.value === value ? <Check className="size-5 shrink-0 text-accent-text" aria-hidden /> : null}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** The chips of the set filters under the phone's search (each × clears its filter). */
export function FilterChips({ ws }: { ws: string }): ReactNode {
  useLocale();
  const f = useTelephonyUi((s) => s.filter);
  const scopeLabel = useScopeLabel(ws, f.scope);
  const chips = activeChips(f);
  if (!chips.length) return null;
  const chip = (key: string, text: string, clear: Partial<JournalFilter>): ReactNode => (
    <li key={key} className="flex shrink-0">
      <button
        type="button"
        className="flex h-9 max-w-[220px] items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--color-accent)_16%,transparent)] pl-3 pr-2 text-control font-medium text-accent-text tap-hit"
        aria-label={t('tel.chip.remove', { name: text })}
        onClick={() => {
          haptics.select();
          setFilter(clear);
        }}
        data-testid={`tel-chip-${key}`}
      >
        <span className="min-w-0 truncate">{text}</span>
        <X className="size-4 shrink-0" aria-hidden />
      </button>
    </li>
  );
  return (
    <ul className="scrollbar-none flex gap-2 overflow-x-auto px-3 pb-2" aria-label={t('tel.filters')} data-testid="tel-chips">
      {chips.map((c) => (c === 'direction' ? chip(c, dirLabel(f.direction), { direction: 'all' }) : c === 'scope' ? chip(c, scopeLabel, { scope: 'mine' }) : chip(c, periodLabel(f.period), { period: 'any' })))}
    </ul>
  );
}
