import * as Popover from '@radix-ui/react-popover';
import { Pause, Play, RotateCcw, Timer as TimerIcon } from 'lucide-react';
import { memo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Button, IconButton, cx } from '../../../components/ui';
import { t, useLocale } from '../../../i18n';
import { TIMER_MAX_MINUTES, TIMER_MIN_MINUTES, TIMER_PRESETS_MIN, clampMinutes, mmss, type TimerPhase } from '../../../lib/canvas/timer';
import type { CanvasEngine } from '../engine';
import { ACTIVE_TOOL, MENU_BOX, PANEL, keepFocus } from './chrome';
import { useEngineValue } from './hooks';
import type { TimerStore } from './timerStore';

const ICON = 'size-[18px]';

/**
 * The countdown plaque, top center: the time left, and for people who can edit pause / resume / reset. A leaf with its
 * own subscription: it re-renders once a second while the timer runs and the canvas is visible, nothing else does —
 * and within it only the time: the icon and the buttons are memo leaves that change with the phase.
 * When the time is up the plaque is highlighted (a solid accent, no animation).
 */
export const TimerChip = memo(function TimerChip({ store, engine }: { store: TimerStore; engine: CanvasEngine }): ReactNode {
  useLocale();
  const v = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const editable = !useEngineValue(engine, (s) => s.readOnly);
  if (v.phase === 'none') return null;
  const ended = v.phase === 'ended';
  const time = mmss(v.secs);
  return (
    <div
      role="timer"
      aria-label={t('canvasBoard.timer.label', { time })}
      data-testid="canvas-timer"
      data-phase={v.phase}
      className={cx(PANEL, 'flex items-center gap-1.5 rounded-full py-1 pl-3 text-control tabular-nums text-fg', editable ? 'pr-1' : 'pr-3', ended && ACTIVE_TOOL)}
    >
      <ChipIcon ended={ended} />
      <span className="min-w-10 text-title" data-testid="canvas-timer-time">{time}</span>
      {ended ? <span data-testid="canvas-timer-ended">{t('canvasBoard.timer.ended')}</span> : null}
      {editable ? <TimerControls store={store} phase={v.phase} /> : null}
    </div>
  );
});

const ChipIcon = memo(function ChipIcon({ ended }: { ended: boolean }): ReactNode {
  return <TimerIcon className={cx('size-4', ended ? 'text-accent-fg' : 'text-muted')} aria-hidden />;
});

/** Pause / resume / reset: re-rendered when the phase changes, not on every second. */
const TimerControls = memo(function TimerControls({ store, phase }: { store: TimerStore; phase: TimerPhase }): ReactNode {
  useLocale();
  const btn = phase === 'ended' ? 'text-accent-fg! hover:bg-white/20!' : undefined;
  return (
    <>
      {phase === 'running' ? (
        <IconButton label={t('canvasBoard.timer.pause')} size="sm" className={btn} onMouseDown={keepFocus} onClick={() => store.pause()} data-testid="canvas-timer-pause">
          <Pause className="size-4" strokeWidth={1.75} aria-hidden />
        </IconButton>
      ) : null}
      {phase === 'paused' ? (
        <IconButton label={t('canvasBoard.timer.resume')} size="sm" className={btn} onMouseDown={keepFocus} onClick={() => store.resume()} data-testid="canvas-timer-resume">
          <Play className="size-4" strokeWidth={1.75} aria-hidden />
        </IconButton>
      ) : null}
      <IconButton label={t('canvasBoard.timer.reset')} size="sm" className={btn} onMouseDown={keepFocus} onClick={() => store.reset()} data-testid="canvas-timer-reset">
        <RotateCcw className="size-4" strokeWidth={1.75} aria-hidden />
      </IconButton>
    </>
  );
});

/** «Таймер» in the toolbar (writers only): presets of 1 / 3 / 5 / 10 minutes and a custom value of 1–180. */
export const TimerButton = memo(function TimerButton({ store, focusCanvas }: { store: TimerStore; focusCanvas: () => void }): ReactNode {
  useLocale();
  const phase = useSyncExternalStore(store.subscribe, () => store.getSnapshot().phase);
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(15);
  const go = (minutes: number): void => {
    void store.start(minutes);
    setOpen(false);
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <IconButton label={t('canvasBoard.timer.button')} active={phase !== 'none'} onMouseDown={keepFocus} data-testid="canvas-timer-button">
          <TimerIcon className={ICON} strokeWidth={1.75} aria-hidden />
        </IconButton>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="right"
          align="end"
          sideOffset={8}
          collisionPadding={8}
          className={cx(MENU_BOX, 'flex w-72 flex-col gap-3 p-3')}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            focusCanvas();
          }}
          data-testid="canvas-timer-popover"
        >
          <h2 className="text-title text-fg">{t('canvasBoard.timer.title')}</h2>
          <p className="text-caption text-muted">{t('canvasBoard.timer.hint')}</p>
          <div className="grid grid-cols-4 gap-1.5">
            {TIMER_PRESETS_MIN.map((n) => (
              <Button key={n} variant="secondary" onClick={() => go(n)} data-testid={`canvas-timer-preset-${n}`}>
                {t('canvasBoard.timer.preset', { n })}
              </Button>
            ))}
          </div>
          <label className="flex items-center justify-between gap-3 text-body text-fg">
            <span>{t('canvasBoard.timer.custom')}</span>
            <input
              type="number"
              min={TIMER_MIN_MINUTES}
              max={TIMER_MAX_MINUTES}
              step={1}
              value={custom}
              onChange={(e) => setCustom(clampMinutes(e.target.valueAsNumber))}
              className="selectable h-7 w-16 rounded-[var(--radius-control)] border border-line bg-elev px-2 text-center text-body tabular-nums text-fg"
              data-testid="canvas-timer-custom"
            />
          </label>
          <div className="flex justify-end">
            <Button onClick={() => go(custom)} data-testid="canvas-timer-start">
              {t('canvasBoard.timer.start')}
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
});
