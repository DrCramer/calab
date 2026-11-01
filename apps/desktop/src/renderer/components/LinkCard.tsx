import { memo, type MouseEvent, type ReactNode } from 'react';
import { cx } from './ui';

const BOX =
  'mt-1.5 flex w-full min-w-0 max-w-[400px] items-center gap-2 rounded-[var(--radius-row)] border-l-[3px] border-l-[color:var(--bubble-accent)] bg-[color-mix(in_srgb,var(--bubble-accent)_10%,transparent)] py-1.5 pl-2 pr-2 text-left';

/**
 * The card of an own-server link under a message's text (wiki page, canvas): an accent bar, an
 * icon tile, a title and a muted line, «Открыть». One shell for every kind (owner rule: no parallel
 * copies); the kind's component resolves the target and passes the texts. `unavailable` is the
 * «нет доступа / удалено» state: a muted line with its own icon, nothing about the target.
 */
export const LinkCard = memo(function LinkCard({
  testId,
  state,
  href,
  onOpen,
  icon,
  title,
  sub,
  openLabel,
  unavailableIcon,
  unavailableLabel,
}: {
  testId: string;
  state: 'page' | 'loading' | 'unavailable';
  href: string | undefined;
  onOpen: () => void;
  icon: ReactNode;
  title: string;
  sub: string;
  openLabel: string;
  unavailableIcon: ReactNode;
  unavailableLabel: string;
}): ReactNode {
  if (state === 'unavailable') {
    return (
      <div className={cx(BOX, 'text-[color:var(--bubble-meta)]')} data-testid={testId} data-state="unavailable">
        {unavailableIcon}
        <span className="min-w-0 truncate text-body">{unavailableLabel}</span>
      </div>
    );
  }
  const open = (e: MouseEvent): void => {
    e.preventDefault();
    onOpen();
  };
  return (
    <a href={href} onClick={open} className={cx(BOX, 'group/link hover:bg-[color-mix(in_srgb,var(--bubble-accent)_16%,transparent)]')} data-testid={testId} data-state={state}>
      <span className="grid size-6 shrink-0 place-items-center text-[18px] leading-none text-[color:var(--bubble-accent)]" aria-hidden>
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body font-semibold leading-5 text-fg">{title}</span>
        <span className="truncate text-caption text-[color:var(--bubble-meta)]">{sub}</span>
      </span>
      <span className="shrink-0 rounded-[var(--radius-row)] px-2 py-1 text-caption font-medium text-[color:var(--bubble-accent)] group-hover/link:bg-[color-mix(in_srgb,var(--bubble-accent)_14%,transparent)]">
        {openLabel}
      </span>
    </a>
  );
});
