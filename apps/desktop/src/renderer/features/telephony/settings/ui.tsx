import { ChevronRight, type LucideIcon } from 'lucide-react';
import { createContext, useContext, type ReactNode } from 'react';
import { Button, cx } from '../../../components/ui';
import { t } from '../../../i18n';

/*
 * The shared layout of the station's settings (ADR-0137 §6–§7): the same forms on the desktop page
 * (a card's inline form, actions in a row at its foot) and on a phone screen (the fields scroll,
 * «Сохранить» sticks to the bottom on the full width — above the keyboard, as the shell ends there
 * while it is up, lib/mobile.ts — and the destructive actions go under the fields). The phone
 * screens provide `PhoneSettings` so the forms read it without a prop through every card.
 */

const PhoneSettingsContext = createContext(false);
export const PhoneSettingsProvider = PhoneSettingsContext.Provider;
/** The settings render as phone screens (features/telephony/settings/PhoneSettings.tsx). */
export const usePhoneSettings = (): boolean => useContext(PhoneSettingsContext);

export function ErrLine({ text, testId }: { text: string | null | undefined; testId?: string }): ReactNode {
  return text ? (
    <span className="text-caption text-danger-text" role="alert" data-testid={testId}>
      {text}
    </span>
  ) : null;
}

/**
 * A settings form. Desktop: the fields, then one row — the form's error, the destructive action on
 * the left, «Отмена», «Сохранить». Phone: the fields scroll, the destructive action under them on the
 * full width, the error and «Сохранить» in the sticky bar (no «Отмена»: «‹» goes back).
 */
export function FormShell({
  testId,
  onSubmit,
  onCancel,
  children,
  className,
  error,
  danger,
  saveLabel,
  saveBusy,
  saveDisabled,
  saveTestId,
  errorTestId,
}: {
  testId: string;
  onSubmit: () => void;
  /** Desktop «Отмена» (and Escape); none = no such button (a page form). */
  onCancel?: () => void;
  children: ReactNode;
  className?: string;
  error?: string | null;
  danger?: ReactNode;
  saveLabel?: string;
  saveBusy?: boolean;
  saveDisabled?: boolean;
  saveTestId?: string;
  errorTestId?: string;
}): ReactNode {
  const phone = usePhoneSettings();
  const save = (
    <Button type="submit" size={phone ? 'md' : 'sm'} busy={saveBusy} disabled={saveDisabled} className={phone ? 'w-full' : undefined} data-testid={saveTestId}>
      {saveLabel ?? t('pbx.save')}
    </Button>
  );
  const submit = (e: { preventDefault: () => void }): void => {
    e.preventDefault();
    if (!saveBusy && !saveDisabled) onSubmit();
  };
  if (phone) {
    return (
      <form className="flex min-h-0 flex-1 flex-col" data-testid={testId} onSubmit={submit}>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-6 pt-4">
          {children}
          {danger ? <div className="mt-2 flex flex-col gap-2 [&>button]:w-full">{danger}</div> : null}
        </div>
        <div className="mat-toolbar flex shrink-0 flex-col gap-1.5 border-t border-line px-4 pb-[calc(8px+var(--safe-bottom))] pt-2" data-testid="tset-sticky">
          <ErrLine text={error} testId={errorTestId} />
          {save}
        </div>
      </form>
    );
  }
  return (
    <form
      className={cx('flex flex-col gap-3', className)}
      data-testid={testId}
      onSubmit={submit}
      onKeyDown={
        onCancel
          ? (e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                onCancel();
              }
            }
          : undefined
      }
    >
      {children}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {error ? (
          <span className="mr-auto min-w-0 text-caption text-danger-text" role="alert" data-testid={errorTestId}>
            {error}
          </span>
        ) : null}
        {danger ? <span className={cx('flex gap-2', !error && 'mr-auto')}>{danger}</span> : null}
        {onCancel ? (
          <Button variant="secondary" size="sm" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        ) : null}
        {save}
      </div>
    </form>
  );
}

/**
 * A row of the phone's drill-down lists (docs/08 «Мобильный веб»: settings rows 52 px, icon 20,
 * label 15, the value 15 `muted`, a chevron). `sub` is a second line (the schedule's summary) —
 * the row grows instead of cutting it.
 */
export function DrillRow({ icon: Icon, label, value, sub, onOpen, testId, lead }: { icon?: LucideIcon; label: string; value?: ReactNode; sub?: string; onOpen: () => void; testId?: string; lead?: ReactNode }): ReactNode {
  return (
    <li className="border-b border-line last:border-b-0">
      <button type="button" onClick={onOpen} className="flex min-h-[52px] w-full min-w-0 items-center gap-3 px-4 py-2 text-left text-list active:bg-[var(--color-fill-hover)]" data-testid={testId}>
        {Icon ? <Icon className="size-5 shrink-0 text-muted" strokeWidth={1.75} aria-hidden /> : null}
        {lead}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="min-w-0 truncate">{label}</span>
          {sub ? <span className="min-w-0 break-words text-body text-muted">{sub}</span> : null}
        </span>
        {value !== undefined && value !== null && value !== '' ? <span className="flex min-w-0 max-w-[45%] shrink-0 items-center gap-1.5 truncate text-muted">{value}</span> : null}
        <ChevronRight className="size-4 shrink-0 text-faint" aria-hidden />
      </button>
    </li>
  );
}

/** The plate of a phone list (the profile's settings list look). */
export function DrillList({ children, testId, title, label }: { children: ReactNode; testId?: string; title?: string; label?: string }): ReactNode {
  return (
    <section className="flex flex-col gap-1">
      {title ? <h2 className="px-1 text-micro font-semibold uppercase tracking-[0.04em] text-muted">{title}</h2> : null}
      <ul className="overflow-hidden rounded-[var(--radius-panel)] bg-[var(--color-fill)]" aria-label={label} data-testid={testId}>
        {children}
      </ul>
    </section>
  );
}

/** A state dot: green — works, red — an error, grey — off. */
export function StateDot({ tone }: { tone: 'ok' | 'error' | 'off' }): ReactNode {
  return <span aria-hidden className={cx('size-2 shrink-0 rounded-full', tone === 'ok' ? 'bg-ok' : tone === 'error' ? 'bg-danger' : 'bg-muted')} />;
}
