import * as Popover from '@radix-ui/react-popover';
import { Vote } from 'lucide-react';
import { memo, useState, type ReactNode } from 'react';
import { Button, IconButton, cx } from '../../../components/ui';
import { t, useLocale } from '../../../i18n';
import { VOTE_DEFAULT, VOTE_MAX, VOTE_MIN, clampVotes } from '../../../lib/canvas/votes';
import type { CanvasEngine } from '../engine';
import { MENU_BOX, PANEL, keepFocus } from './chrome';
import { useEngineValue } from './hooks';

const ICON = 'size-[18px]';

/**
 * «Голосование» in the toolbar (writers only: the toolbar is theirs): one button, a small popover that starts a
 * vote (votes per person), finishes it and clears the results. The button reads «on» while a vote exists.
 */
export const VoteButton = memo(function VoteButton({ engine, focusCanvas }: { engine: CanvasEngine; focusCanvas: () => void }): ReactNode {
  useLocale();
  const phase = useEngineValue(engine, (s) => s.votePhase);
  const per = useEngineValue(engine, (s) => s.votesPer);
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(VOTE_DEFAULT);
  const act = (fn: () => unknown): void => {
    fn();
    setOpen(false);
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <IconButton label={t('canvasBoard.vote.button')} active={phase !== 'none'} onMouseDown={keepFocus} data-testid="canvas-vote-button">
          <Vote className={ICON} strokeWidth={1.75} aria-hidden />
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
          data-testid="canvas-vote-popover"
        >
          <h2 className="text-title text-fg">{t('canvasBoard.vote.title')}</h2>
          <p className="text-caption text-muted">
            {phase === 'none' ? t('canvasBoard.vote.hintNone') : phase === 'open' ? t('canvasBoard.vote.hintOpen') : t('canvasBoard.vote.hintClosed')}
          </p>
          {phase !== 'open' ? (
            <label className="flex items-center justify-between gap-3 text-body text-fg">
              <span>{t('canvasBoard.vote.perPerson')}</span>
              <input
                type="number"
                min={VOTE_MIN}
                max={VOTE_MAX}
                step={1}
                value={count}
                onChange={(e) => setCount(clampVotes(e.target.valueAsNumber))}
                className="selectable h-7 w-16 rounded-[var(--radius-control)] border border-line bg-elev px-2 text-center text-body tabular-nums text-fg"
                data-testid="canvas-vote-count"
              />
            </label>
          ) : (
            <p className="text-body tabular-nums text-fg">{t('canvasBoard.vote.perPerson')}: {per}</p>
          )}
          <div className="flex items-center justify-end gap-2">
            {phase !== 'none' ? (
              <Button variant="ghost" onClick={() => act(() => engine.resetVote())} data-testid="canvas-vote-reset">
                {t('canvasBoard.vote.reset')}
              </Button>
            ) : null}
            {phase === 'open' ? (
              <Button onClick={() => act(() => engine.finishVote())} data-testid="canvas-vote-finish">
                {t('canvasBoard.vote.finish')}
              </Button>
            ) : (
              <Button onClick={() => act(() => engine.startVote(count))} data-testid="canvas-vote-start">
                {phase === 'none' ? t('canvasBoard.vote.start') : t('canvasBoard.vote.startNew')}
              </Button>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
});

/** «Осталось N из M» for those who vote, «Идёт голосование» for the others; nothing once it is over. A leaf of the top-center column. */
export const VoteChip = memo(function VoteChip({ engine }: { engine: CanvasEngine }): ReactNode {
  useLocale();
  const phase = useEngineValue(engine, (s) => s.votePhase);
  const can = useEngineValue(engine, (s) => s.canVote);
  const left = useEngineValue(engine, (s) => s.votesLeft);
  const per = useEngineValue(engine, (s) => s.votesPer);
  if (phase !== 'open') return null;
  return (
    <div role="status" className={cx(PANEL, 'flex items-center gap-2 rounded-full px-3 py-1.5 text-control tabular-nums text-fg')} data-testid="canvas-vote-chip">
      <Vote className="size-4 text-muted" aria-hidden />
      <span>{can ? t('canvasBoard.vote.left', { left, per }) : t('canvasBoard.vote.watching')}</span>
    </div>
  );
});
