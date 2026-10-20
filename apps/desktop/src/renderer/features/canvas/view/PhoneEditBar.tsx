import { MousePointer2, Plus, Redo2, Spline, StickyNote, Type, Undo2, Vote, Timer as TimerIcon, type LucideIcon } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cx } from '../../../components/ui';
import { t, useLocale } from '../../../i18n';
import { TEMPLATE_IDS, type TemplateId } from '../../../lib/canvas/templates';
import { TIMER_PRESETS_MIN } from '../../../lib/canvas/timer';
import { VOTE_DEFAULT } from '../../../lib/canvas/votes';
import type { CanvasEngine, Tool } from '../engine';
import { ACTIVE_TOOL, PANEL, keepFocus } from './chrome';
import { useEngineValue } from './hooks';
import { PhoneMenu } from './PhoneMenu';
import { ShapeIcon } from './ShapeIcon';
import { SHAPE_DEFS } from './model';
import { TEMPLATE_ICON, useInsertTemplate } from './Templates';
import type { TimerStore } from './timerStore';

/**
 * The phone's edit mode, bottom dock (ADR-0114 wave 5b): the tool bar — select, sticky, text, shape, connector, «+», undo,
 * redo — with a sheet above it (shapes grid, templates / vote / timer, later the properties sheet). Every target is
 * 44×44 px, the bar clears the home indicator itself (`--safe-bottom`), nothing animates and nothing runs at rest: the
 * buttons are leaves that read one engine primitive each. Hidden while a text is edited (the format bar takes its place).
 */

const ICON = 'size-[22px]';
const BTN = 'grid size-11 shrink-0 place-items-center rounded-[var(--radius-control)] text-fg outline-none active:bg-active disabled:opacity-40 disabled:active:bg-transparent';
/** The sheets above the bar: popover material, square at the bottom, scroll inside when the content is taller than the screen allows. */
export const SHEET = 'mat-popover pointer-events-auto max-h-[min(55vh,420px)] overflow-y-auto overscroll-contain rounded-t-[var(--radius-card)] border-x-0 border-b-0';

type SheetKind = 'shapes' | 'plus';

export function PhoneBtn({
  label, active, disabled, onClick, testId, children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  testId?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active === undefined ? undefined : active}
      disabled={disabled}
      onMouseDown={keepFocus}
      onClick={onClick}
      className={cx(BTN, active && ACTIVE_TOOL)}
      data-testid={testId}
    >
      {children}
    </button>
  );
}

const HistoryBtn = memo(function HistoryBtn({ engine, redo }: { engine: CanvasEngine; redo?: boolean }): ReactNode {
  useLocale();
  const can = useEngineValue(engine, (s) => (redo ? s.canRedo : s.canUndo));
  const Icon = redo ? Redo2 : Undo2;
  return (
    <PhoneBtn label={t(redo ? 'canvasBoard.redo' : 'canvasBoard.undo')} disabled={!can} onClick={() => (redo ? engine.redo() : engine.undo())} testId={redo ? 'canvas-redo' : 'canvas-undo'}>
      <Icon className={ICON} strokeWidth={1.75} aria-hidden />
    </PhoneBtn>
  );
});

const TOOLS: readonly { tool: Tool; Icon: LucideIcon | null }[] = [
  { tool: 'select', Icon: MousePointer2 },
  { tool: 'sticky', Icon: StickyNote },
  { tool: 'text', Icon: Type },
  { tool: 'shape', Icon: null },
  { tool: 'connector', Icon: Spline },
];

/** What the armed tool does on a touch screen, once above the bar (the tool bar alone does not say «tap the canvas»). */
function ArmedHint({ tool }: { tool: Tool }): ReactNode {
  if (tool === 'select') return null;
  return (
    <div role="status" className={cx(PANEL, 'pointer-events-none mx-auto mb-2 rounded-full px-3 py-1.5 text-control text-fg')} data-testid="canvas-phone-armed">
      {t(`canvasPhone.armed.${tool}`)}
    </div>
  );
}

/** Px of the view the zoom bar and the count of others cover from the top: a selection is kept below them. */
const TOP_INSET = 64;

export const PhoneEditBar = memo(function PhoneEditBar({
  engine, timer, focusCanvas, children,
}: {
  engine: CanvasEngine;
  timer: TimerStore;
  focusCanvas: () => void;
  /** The properties sheet (when something is selected): above the tool bar, below the open sheet. */
  children?: ReactNode;
}): ReactNode {
  useLocale();
  const tool = useEngineValue(engine, (s) => s.tool);
  const shapeKind = useEngineValue(engine, (s) => s.shapeKind);
  const editing = useEngineValue(engine, (s) => s.editing);
  const selected = useEngineValue(engine, (s) => s.selectionCount);
  const [sheet, setSheet] = useState<SheetKind | null>(null);
  const close = useCallback(() => setSheet(null), []);
  const dock = useRef<HTMLDivElement>(null);
  /** A primitive that changes when the selection does (another object, a different count). */
  const selKey = useEngineValue(engine, (s) => (s.selectedId !== null ? s.selectedId : s.selectionCount > 0 ? `#${s.selectionCount}` : ''));

  // The selected object must not hide under the sheet and the bar: when the selection changes, and whenever the dock
  // changes size (a sheet opens, a grid unfolds), the camera moves just enough. Not during a gesture, never at rest.
  useLayoutEffect(() => {
    const node = dock.current;
    if (!node || selKey === '') return undefined;
    const reveal = (): void => void engine.revealSelection({ top: TOP_INSET, bottom: node.offsetHeight });
    reveal();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(reveal);
    ro.observe(node);
    return () => ro.disconnect();
  }, [engine, selKey, editing]);

  // Selecting something (or starting to type) puts any open sheet away: the properties are what matters then.
  useEffect(() => {
    if (selected > 0 || editing) setSheet(null);
  }, [selected, editing]);

  if (editing) return null;
  const openTemplates = (): void => setSheet('plus');
  const pick = (next: Tool): void => {
    setSheet(null);
    engine.setTool(next);
  };
  return (
    <>
    <PhoneMenu engine={engine} onTemplates={openTemplates} />
    <div ref={dock} className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col" data-testid="canvas-phone-dock">
      <ArmedHint tool={tool} />
      {sheet === 'shapes' ? <ShapesSheet engine={engine} shapeKind={shapeKind} onDone={close} /> : null}
      {sheet === 'plus' ? <PlusSheet engine={engine} timer={timer} focusCanvas={focusCanvas} onDone={close} /> : null}
      {sheet === null ? children : null}
      <div
        role="toolbar"
        aria-label={t('canvasPhone.tools')}
        data-testid="canvas-phone-toolbar"
        className="mat-popover pointer-events-auto flex items-center justify-between rounded-none border-x-0 border-b-0 px-1 pt-1 pb-[max(4px,var(--safe-bottom,0px))]"
      >
        {TOOLS.map(({ tool: id, Icon }) => (
          <PhoneBtn
            key={id}
            label={t(`canvasBoard.tool.${id}`)}
            active={tool === id}
            onClick={() => {
              if (id === 'shape') {
                // The shape button arms the tool and offers the shapes; a second tap puts the sheet away.
                engine.setTool('shape');
                setSheet(sheet === 'shapes' ? null : 'shapes');
              } else pick(id);
            }}
            testId={`canvas-tool-${id}`}
          >
            {Icon ? <Icon className={ICON} strokeWidth={1.75} aria-hidden /> : <ShapeIcon kind={shapeKind} className={ICON} />}
          </PhoneBtn>
        ))}
        <PhoneBtn label={t('canvasPhone.plus')} active={sheet === 'plus'} onClick={() => setSheet(sheet === 'plus' ? null : 'plus')} testId="canvas-phone-plus">
          <Plus className={ICON} strokeWidth={1.75} aria-hidden />
        </PhoneBtn>
        <HistoryBtn engine={engine} />
        <HistoryBtn engine={engine} redo />
      </div>
    </div>
    </>
  );
});

function ShapesSheet({ engine, shapeKind, onDone }: { engine: CanvasEngine; shapeKind: string; onDone: () => void }): ReactNode {
  return (
    <div role="group" aria-label={t('canvasPhone.shapes')} className={cx(SHEET, 'grid grid-cols-6 gap-1 p-2')} data-testid="canvas-phone-shapes">
      {SHAPE_DEFS.map((d) => (
        <PhoneBtn
          key={d.kind}
          label={t(d.label)}
          active={d.kind === shapeKind}
          onClick={() => {
            engine.setShapeKind(d.kind);
            engine.setTool('shape');
            onDone();
          }}
          testId={`canvas-shape-${d.kind}`}
        >
          <ShapeIcon kind={d.kind} className={ICON} />
        </PhoneBtn>
      ))}
    </div>
  );
}

const ROW = 'flex min-h-12 w-full items-center gap-3 rounded-[var(--radius-control)] px-3 text-left outline-none active:bg-active';
const CHIP = 'h-11 min-w-11 rounded-[var(--radius-control)] bg-[var(--color-fill)] px-3 text-body text-fg outline-none active:bg-active disabled:opacity-40';

/** «+»: the templates (inserted at the center of the view), then the vote and the countdown with their quick actions. */
function PlusSheet({ engine, timer, focusCanvas, onDone }: { engine: CanvasEngine; timer: TimerStore; focusCanvas: () => void; onDone: () => void }): ReactNode {
  const insert = useInsertTemplate(engine, focusCanvas);
  const phase = useEngineValue(engine, (s) => s.votePhase);
  const act = (fn: () => unknown) => (): void => {
    fn();
    onDone();
  };
  return (
    <div className={cx(SHEET, 'flex flex-col gap-1 p-2')} role="group" aria-label={t('canvasPhone.plus')} data-testid="canvas-phone-plus-sheet">
      <h2 className="px-3 pt-1 text-caption text-muted">{t('canvasBoard.templates.title')}</h2>
      {TEMPLATE_IDS.map((id: TemplateId) => {
        const Icon = TEMPLATE_ICON[id];
        return (
          <button key={id} type="button" className={ROW} onMouseDown={keepFocus} onClick={act(() => insert(id))} data-testid={`canvas-template-${id}`}>
            <Icon className="size-5 shrink-0 text-muted" strokeWidth={1.75} aria-hidden />
            <span className="flex min-w-0 flex-col">
              <span className="text-body text-fg">{t(`canvasBoard.templates.name.${id}`)}</span>
              <span className="truncate text-caption text-muted">{t(`canvasBoard.templates.desc.${id}`)}</span>
            </span>
          </button>
        );
      })}
      <h2 className="flex items-center gap-2 px-3 pt-2 text-caption text-muted">
        <Vote className="size-4" aria-hidden />
        {t('canvasBoard.vote.title')}
      </h2>
      <div className="flex flex-wrap gap-2 px-3 pb-1">
        {phase !== 'open' ? (
          <button type="button" className={CHIP} onClick={act(() => engine.startVote(VOTE_DEFAULT))} data-testid="canvas-vote-start">
            {phase === 'none' ? t('canvasBoard.vote.start') : t('canvasBoard.vote.startNew')}
          </button>
        ) : (
          <button type="button" className={CHIP} onClick={act(() => engine.finishVote())} data-testid="canvas-vote-finish">
            {t('canvasBoard.vote.finish')}
          </button>
        )}
        {phase !== 'none' ? (
          <button type="button" className={CHIP} onClick={act(() => engine.resetVote())} data-testid="canvas-vote-reset">
            {t('canvasBoard.vote.reset')}
          </button>
        ) : null}
      </div>
      <h2 className="flex items-center gap-2 px-3 pt-2 text-caption text-muted">
        <TimerIcon className="size-4" aria-hidden />
        {t('canvasBoard.timer.title')}
      </h2>
      <div className="flex flex-wrap gap-2 px-3 pb-1">
        {TIMER_PRESETS_MIN.map((n) => (
          <button key={n} type="button" className={CHIP} onClick={act(() => void timer.start(n))} data-testid={`canvas-timer-preset-${n}`}>
            {t('canvasBoard.timer.preset', { n })}
          </button>
        ))}
      </div>
    </div>
  );
}
