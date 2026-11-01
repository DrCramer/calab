import type { SipCallEvent, SipJournalEntry } from '@calaba/protocol';
import { ChevronRight, CornerDownRight } from 'lucide-react';
import { memo, useMemo, useState, type ReactNode } from 'react';
import { cx } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { dateTimeFormat } from '../../lib/format';
import { formatDuration } from '../shell/voiceFormat';
import { memberName } from '../../stores/workspaces';
import { attemptText, stepText } from './texts';
import { buildTimeline, startOf, type Step } from './timeline';

/**
 * «Маршрут» of a call (ADR-0137 §6–§7): a vertical rail — the offset from the start on the left
 * (`+0:12`; a tap switches the whole column to the clock time and back), a dot on a 1 px line, the
 * step and its detail, both wrapping (never cut, never scrolled sideways). Rings to employees are
 * one step that unfolds into who was rung, how long and how it ended; a transfer's steps are
 * indented under it. A call from before the journal has its steps without times and a note.
 */
export const CallRoute = memo(function CallRoute({ ws, entry, events, phone }: { ws: string; entry: SipJournalEntry; events: readonly SipCallEvent[]; phone: boolean }): ReactNode {
  useLocale();
  const start = startOf(entry) || null;
  const steps = useMemo(() => buildTimeline(events, start), [events, start]);
  const [clock, setClock] = useState(false);
  const timed = steps.some((s) => s.offsetMs !== null);
  if (!steps.length) return null;
  return (
    <div data-testid="tel-route">
      <ol className="flex flex-col" aria-label={t('tel.route')}>
        {steps.map((s, i) => (
          <StepRow key={s.key} ws={ws} entry={entry} step={s} first={i === 0} last={i === steps.length - 1} phone={phone} timed={timed} clock={clock} onClock={() => setClock((c) => !c)} />
        ))}
      </ol>
      {!entry.hasEvents ? <p className={cx('pt-2 text-muted', phone ? 'text-caption' : 'text-caption')} data-testid="tel-route-legacy">{t('tel.route.legacy')}</p> : null}
    </div>
  );
});

const clockTime = (ms: number): string => dateTimeFormat({ hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(ms));

function StepRow({ ws, entry, step, first, last, phone, timed, clock, onClock }: { ws: string; entry: SipJournalEntry; step: Step; first: boolean; last: boolean; phone: boolean; timed: boolean; clock: boolean; onClock: () => void }): ReactNode {
  const [open, setOpen] = useState(false);
  const { title, detail } = stepText(ws, step, entry);
  const rings = step.rings && step.rings.mode !== 'one' ? step.rings : null;
  const offset = step.offsetMs !== null ? `+${formatDuration(step.offsetMs)}` : '';
  const abs = step.at !== null ? clockTime(step.at) : '';
  const detailEl = detail ? <span className={cx('block break-words text-caption text-muted', phone ? 'leading-[18px]' : 'leading-4')}>{detail}</span> : null;
  const titleEl = (
    <span className={cx('flex items-start gap-1 font-medium', phone ? 'text-list leading-5' : 'text-body leading-[18px]', step.danger ? 'text-danger-text' : 'text-fg')}>
      <span className="min-w-0 break-words">{title}</span>
      {rings ? <ChevronRight className={cx('mt-0.5 size-4 shrink-0 text-muted transition-transform duration-[var(--motion-fast)]', open && 'rotate-90')} aria-hidden /> : null}
    </span>
  );
  return (
    <li className={cx('grid', !timed ? 'grid-cols-[16px_minmax(0,1fr)]' : phone ? 'grid-cols-[52px_16px_minmax(0,1fr)]' : 'grid-cols-[48px_16px_minmax(0,1fr)]')} data-testid="tel-step" data-kind={step.kind}>
      {/* The offset column; a tap toggles offsets ↔ clock times for the whole column. */}
      {timed ? (
        <button
          type="button"
          onClick={onClock}
          title={abs || undefined}
          aria-label={`${clock ? abs : offset}, ${clock ? t('tel.route.showOffset') : t('tel.route.showClock')}`}
          className={cx('flex items-start justify-end self-start pr-2 tabular-nums text-muted', phone ? 'min-h-11 pt-3 text-caption' : 'pt-[7px] text-micro')}
          data-inline-target={phone ? undefined : ''}
        >
          {clock ? abs : offset}
        </button>
      ) : null}
      {/* The rail: a 1 px line through the dots (from the first dot to the last). */}
      <span className="relative flex justify-center" aria-hidden>
        <span className={cx('absolute left-1/2 w-px -translate-x-1/2 bg-[var(--color-line)]', first ? (phone ? 'top-[19px]' : 'top-[11px]') : 'top-0', last ? (phone ? 'h-[19px]' : 'h-[11px]') : 'bottom-0')} style={first && last ? { display: 'none' } : undefined} />
        <span className={cx('relative size-2 rounded-full', phone ? 'mt-[15px]' : 'mt-[7px]', step.danger ? 'bg-danger' : step.kind === 'answered' || (step.kind === 'transferEnd' && step.ev.reason === 'answered') ? 'bg-ok' : 'bg-[var(--color-label-tertiary)]')} />
      </span>
      <div className={cx('min-w-0', step.nested && 'pl-3', phone ? 'min-h-11 py-2.5' : 'py-1')}>
        <div className="flex min-w-0 gap-1">
          {step.nested ? <CornerDownRight className={cx('shrink-0 text-muted', phone ? 'mt-0.5 size-4' : 'mt-px size-3.5')} aria-hidden /> : null}
          <div className="min-w-0 flex-1">
            {rings ? (
              // The whole step (title and detail) unfolds the people rung; on the phone a 44 px target.
              <button type="button" className={cx('block w-full text-left', phone && '-mt-2.5 min-h-11 pt-2.5')} aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="tel-step-rings">
                {titleEl}
                {detailEl}
              </button>
            ) : (
              <>
                {titleEl}
                {detailEl}
              </>
            )}
            {rings && open ? (
              <ul className="mt-1.5 flex flex-col gap-1" data-testid="tel-step-attempts">
                {rings.attempts.map((a, i) => (
                  <li key={`${a.userId}-${i}`} className={cx('flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-caption', phone && 'min-h-6')}>
                    <span className={cx('font-medium', a.outcome === 'answered' ? 'text-[var(--color-green-text)]' : 'text-fg')}>{memberName(ws, a.userId)}</span>
                    <span className="text-muted">{attemptText(a)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      </div>
    </li>
  );
}
