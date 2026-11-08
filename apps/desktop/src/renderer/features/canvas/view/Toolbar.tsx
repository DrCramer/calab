import * as Popover from '@radix-ui/react-popover';
import { Check, Eraser, Frame, Highlighter, MessageSquarePlus, MousePointer2, Pencil, Redo2, Type, Undo2 } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ALT, IconButton, MOD, cx } from '../../../components/ui';
import { t, useLocale } from '../../../i18n';
import type { RouteKind, ShapeKind } from '../../../lib/canvas/types';
import { readableInk, resolveColor, resolveSticky, type CanvasEngine, type CanvasPalette, type Tool } from '../engine';
import { ACTIVE_TOOL, DIVIDER, MENU_BOX, MENU_ITEM, PANEL, keepFocus } from './chrome';
import { useEngineValue } from './hooks';
import { RouteIcon } from './RouteIcon';
import { ShapeIcon } from './ShapeIcon';
import { StickerTool } from './StickerTool';
import { TemplatesMenu } from './Templates';
import { TimerButton } from './Timer';
import type { TimerStore } from './timerStore';
import { VoteButton } from './Vote';
import { FRAME_PRESETS, type FramePreset } from '../../../lib/canvas/frames';
import { ERASER_SIZES } from '../../../lib/canvas/ink';
import { PEN_COLORS, ROUTE_DEFS, SHAPE_DEFS, STICKY_COLORS, TOOL_DEFS } from './model';
import { Swatch, colorLabel, inkWidthItems } from './PropsPanel';
import { STICKY_BODY, STICKY_FOLD, StickyIcon } from './StickyIcon';
import { HintPalette, ToolHint } from './ToolHint';

const ICON = 'size-[18px]';

const shapeIcon = (kind: ShapeKind): ReactNode => <ShapeIcon kind={kind} className={ICON} />;

const ROUTE_ICON: Record<RouteKind, ReactNode> = {
  straight: <RouteIcon route="straight" className={ICON} />,
  elbow: <RouteIcon route="elbow" className={ICON} />,
  curve: <RouteIcon route="curve" className={ICON} />,
};

/**
 * Double-click on a tool keeps it after the object is created (Miro-style). The engine always returns to
 * «Выбор» after a creation (it selects the new object first), so «pinned» is: the tool went to select
 * while the selection had changed since the tool was picked — put the tool back. Any other tool change
 * (V, Esc, another tool) releases the pin.
 */
function usePinnedTool(engine: CanvasEngine, pinned: Tool | null, release: () => void): void {
  useEffect(() => {
    if (!pinned) return undefined;
    let prev = engine.getState().tool;
    let touched = false;
    const offSel = engine.subscribeSelection(() => {
      touched = true;
    });
    const off = engine.subscribe(() => {
      const s = engine.getState();
      if (s.tool === prev) return;
      const was = prev;
      prev = s.tool;
      if (s.tool === pinned) {
        touched = false;
        return;
      }
      if (was === pinned && s.tool === 'select' && touched && !s.readOnly) {
        engine.setTool(pinned);
        return;
      }
      release();
    });
    return () => {
      off();
      offSel();
    };
  }, [engine, pinned, release]);
}

/**
 * A tool button. With a `flyout` (the sticky's colors, the shapes, the line kinds) a click both arms the tool and
 * opens its options beside it, as in Miro; the canvas keeps the focus, so a click on it closes the panel and creates.
 * A keyboard click moves the focus into the panel instead. The panel closes once the tool is released.
 * `stay` (the pencil): drawing does not close it — only the tool button again, Esc or another tool.
 */
function ToolButton({
  tool, icon, active, pinned, onPick, onPin, focusCanvas, flyout, flyoutLabel, flyoutTestId, stay,
}: {
  /** The eraser has no button of its own: it lives in the pencil's panel. */
  tool: Exclude<Tool, 'eraser'>;
  icon: ReactNode;
  active: boolean;
  pinned: boolean;
  onPick: (t: Tool) => void;
  onPin: (t: Tool) => void;
  focusCanvas: () => void;
  flyout?: ReactNode;
  flyoutLabel?: string;
  flyoutTestId?: string;
  stay?: boolean;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const byKeyboard = useRef(false);
  // The tool was released (created, Esc, another tool): the panel goes with it — adjusted during render, not in an effect.
  if (open && !active) setOpen(false);
  const def = TOOL_DEFS.find((d) => d.tool === tool);
  if (!def) return null;
  const label = pinned ? `${t(def.label)} — ${t('canvasBoard.tool.pinned')}` : t(def.label);
  const shortcut = def.alt ? `${ALT}${def.key}` : def.key;
  const button = (
    <IconButton
      label={label}
      tip={false}
      active={active}
      className={cx(active && ACTIVE_TOOL)}
      onMouseDown={keepFocus}
      onClick={(e) => {
        onPick(tool);
        focusCanvas();
        if (!flyout) return;
        byKeyboard.current = e.detail === 0;
        // A panel that stays is put away by its own button.
        setOpen(!(stay && open));
      }}
      onDoubleClick={() => onPin(tool)}
      aria-haspopup={flyout ? 'dialog' : undefined}
      aria-expanded={flyout ? open : undefined}
      data-testid={`canvas-tool-${tool}`}
      data-pinned={pinned || undefined}
    >
      {icon}
    </IconButton>
  );
  return (
    <div className="relative">
      {flyout ? (
        <Popover.Root open={open} onOpenChange={setOpen}>
          <ToolHint id={tool} title={label} shortcut={shortcut} suppress={open}>
            <Popover.Anchor asChild>{button}</Popover.Anchor>
          </ToolHint>
          <Popover.Portal>
            <Popover.Content
              side="right"
              align="start"
              sideOffset={8}
              collisionPadding={8}
              className={cx(MENU_BOX, 'w-auto min-w-0 p-2')}
              aria-label={flyoutLabel}
              onOpenAutoFocus={(e) => {
                if (!byKeyboard.current) e.preventDefault();
              }}
              onCloseAutoFocus={(e) => {
                e.preventDefault();
                focusCanvas();
              }}
              onInteractOutside={(e) => {
                if (stay) e.preventDefault();
              }}
              data-testid={flyoutTestId}
            >
              {flyout}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      ) : (
        <ToolHint id={tool} title={label} shortcut={shortcut}>
          {button}
        </ToolHint>
      )}
      {pinned ? <span aria-hidden className="pointer-events-none absolute right-1 top-1 size-1.5 rounded-full bg-accent-fg" /> : null}
    </div>
  );
}

/** One option of a tool's flyout: picking it closes the panel (`keep`: leaves it open, several choices to make) and leaves the tool armed. */
function FlyoutOption({ label, selected, onPick, testId, className, keep, children }: { label: string; selected: boolean; onPick: () => void; testId: string; className?: string; keep?: boolean; children: ReactNode }): ReactNode {
  const button = (
    <button
      type="button"
      aria-label={label}
      aria-pressed={selected}
      onMouseDown={keepFocus}
      onClick={onPick}
      data-testid={testId}
      className={cx('cursor-default rounded-[var(--radius-icon)] text-fg hover:bg-hover', selected && 'bg-active', className)}
    >
      {children}
    </button>
  );
  return keep ? button : <Popover.Close asChild>{button}</Popover.Close>;
}

const ERASER_LABELS = ['canvasBoard.ink.eraserS', 'canvasBoard.ink.eraserM', 'canvasBoard.ink.eraserL'] as const;

const INK_KINDS = [
  { id: 'pen', Icon: Pencil, label: 'canvasBoard.ink.pen' },
  { id: 'marker', Icon: Highlighter, label: 'canvasBoard.ink.marker' },
  { id: 'eraser', Icon: Eraser, label: 'canvasBoard.tool.eraser' },
] as const;

/**
 * The pencil's panel: pen, marker or eraser, then (not for the eraser) the color and one of three widths. It stays open
 * while choosing; a click on the canvas closes it and draws.
 */
function InkPanel({ engine, palette }: { engine: CanvasEngine; palette: CanvasPalette }): ReactNode {
  const tool = useEngineValue(engine, (s) => s.tool);
  const marker = useEngineValue(engine, (s) => s.inkMarker);
  const color = useEngineValue(engine, (s) => s.inkColor);
  const width = useEngineValue(engine, (s) => s.inkWidth);
  const eraser = useEngineValue(engine, (s) => s.eraserPx);
  const kind = tool === 'eraser' ? 'eraser' : marker ? 'marker' : 'pen';
  return (
    <div className="flex w-[13.5rem] flex-col gap-2" data-testid="canvas-ink-panel">
      <div role="group" aria-label={t('canvasBoard.ink.kind')} className="grid grid-cols-3 gap-1">
        {INK_KINDS.map(({ id, Icon, label }) => (
          <FlyoutOption
            key={id}
            keep
            label={t(label)}
            selected={kind === id}
            onPick={() => {
              if (id === 'eraser') engine.setTool('eraser');
              else {
                engine.setInk({ marker: id === 'marker' });
                engine.setTool('pen');
              }
            }}
            testId={`canvas-ink-${id}`}
            className="flex flex-col items-center gap-0.5 px-1 py-1.5 text-caption"
          >
            <Icon className={ICON} strokeWidth={1.75} aria-hidden />
            {t(label)}
          </FlyoutOption>
        ))}
      </div>
      {kind === 'eraser' ? (
        <div role="group" aria-label={t('canvasBoard.ink.eraserSize')} className="grid grid-cols-3 gap-1">
          {ERASER_SIZES.map((px, i) => (
            <FlyoutOption key={px} keep label={t(ERASER_LABELS[i] ?? 'canvasBoard.ink.eraserM')} selected={px === eraser} onPick={() => engine.setEraserPx(px)} testId={`canvas-eraser-size-${px}`} className="grid h-9 place-items-center">
              <span aria-hidden className="rounded-full border-[1.5px] border-current" style={{ width: Math.min(28, px * 1.1 + 4), height: Math.min(28, px * 1.1 + 4) }} />
            </FlyoutOption>
          ))}
        </div>
      ) : (
        <>
          <div role="group" aria-label={t('canvasBoard.props.color')} className="grid grid-cols-8 gap-0.5">
            {PEN_COLORS.map((tok) => {
              const css = resolveColor(palette, tok);
              return (
                <FlyoutOption key={tok} keep label={colorLabel(tok)} selected={tok === color} onPick={() => engine.setInk({ color: tok })} testId={`canvas-ink-color-${tok}`} className="relative grid size-6 place-items-center">
                  <Swatch css={css} size={18} />
                  {tok === color && css ? <Check className="absolute size-3" style={{ color: readableInk(css, '#ffffff') }} strokeWidth={3} aria-hidden /> : null}
                </FlyoutOption>
              );
            })}
          </div>
          <div role="group" aria-label={t('canvasBoard.props.strokeWidth')} className="grid grid-cols-3 gap-1">
            {inkWidthItems(marker).map((it) => (
              <FlyoutOption key={it.id} keep label={it.label} selected={it.id === width} onPick={() => engine.setInk({ width: it.id })} testId={`canvas-ink-width-${it.id}`} className="grid h-7 place-items-center">
                {it.node}
              </FlyoutOption>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const FRAME_LABELS: Record<FramePreset, 'canvasBoard.frame.wide' | 'canvasBoard.frame.a4' | 'canvasBoard.frame.square' | 'canvasBoard.frame.custom'> = {
  '16:9': 'canvasBoard.frame.wide',
  a4: 'canvasBoard.frame.a4',
  '1:1': 'canvasBoard.frame.square',
  custom: 'canvasBoard.frame.custom',
};

/** The frame tool's sizes: each a little outline in its proportions; «свой» is a dashed one (drag it out on the canvas). */
function FrameSizes({ engine }: { engine: CanvasEngine }): ReactNode {
  const value = useEngineValue(engine, (s) => s.frameSize);
  return (
    <div className="flex w-52 flex-col gap-0.5" data-testid="canvas-frame-sizes">
      {FRAME_PRESETS.map((p) => {
        const k = 16 / Math.max(p.w, p.h);
        return (
          <FlyoutOption key={p.id} label={t(FRAME_LABELS[p.id])} selected={value === p.id} onPick={() => engine.setFrameSize(p.id)} testId={`canvas-frame-size-${p.id}`} className={cx(MENU_ITEM, 'w-full')}>
            <span aria-hidden className="grid size-[18px] place-items-center">
              <span className={cx('rounded-[2px] border-[1.5px] border-current', p.id === 'custom' && 'border-dashed')} style={p.id === 'custom' ? { width: 16, height: 12 } : { width: p.w * k, height: p.h * k }} />
            </span>
            {t(FRAME_LABELS[p.id])}
          </FlyoutOption>
        );
      })}
    </div>
  );
}

/** A sticky note in one color: the swatch of the sticky tool's flyout (a note, not a dot — what will land on the canvas). */
function StickySwatch({ bg }: { bg: string }): ReactNode {
  return (
    <svg viewBox="0 0 24 24" className="size-7" aria-hidden>
      {/* The sticky tool's outline (StickyIcon), so the fold sits bottom right in both places. */}
      <path d={STICKY_BODY} fill={bg} stroke="rgba(128,128,128,0.4)" strokeWidth={0.75} strokeLinejoin="round" />
      <path d={`${STICKY_FOLD}Z`} fill="rgba(0,0,0,0.2)" />
    </svg>
  );
}

/** The sticky tool's colors: a grid of notes, the hovered color's name under it. */
function StickyColors({ palette, value, onPick }: { palette: CanvasPalette; value: string; onPick: (c: string) => void }): ReactNode {
  const [hot, setHot] = useState(value);
  return (
    <div data-testid="canvas-sticky-colors">
      <div className="grid grid-cols-5 gap-1">
        {STICKY_COLORS.map((tok) => {
          const bg = resolveSticky(palette, tok).bg;
          return (
            <FlyoutOption key={tok} label={colorLabel(tok)} selected={tok === value} onPick={() => onPick(tok)} testId={`canvas-sticky-color-${tok}`} className="relative grid size-10 place-items-center">
              <span className="contents" onMouseEnter={() => setHot(tok)}>
                <StickySwatch bg={bg} />
                {tok === value ? <Check className="absolute size-3.5" style={{ color: readableInk(bg, '#ffffff') }} strokeWidth={3} aria-hidden /> : null}
              </span>
            </FlyoutOption>
          );
        })}
      </div>
      <div className="mt-1.5 truncate px-1 text-caption text-muted" aria-hidden>{colorLabel(hot)}</div>
    </div>
  );
}

export const Toolbar = memo(function Toolbar({ engine, timer, palette, focusCanvas, workspaceId }: { engine: CanvasEngine; timer: TimerStore; palette: CanvasPalette; focusCanvas: () => void; workspaceId: string }): ReactNode {
  useLocale();
  const tool = useEngineValue(engine, (s) => s.tool);
  const shapeKind = useEngineValue(engine, (s) => s.shapeKind);
  const stickyColor = useEngineValue(engine, (s) => s.stickyColor);
  const inkMarker = useEngineValue(engine, (s) => s.inkMarker);
  const inkColor = useEngineValue(engine, (s) => s.inkColor);
  // The pencil button arms the last of pen / eraser used (P and E pick them directly).
  const [lastInk, setLastInk] = useState<'pen' | 'eraser'>('pen');
  if ((tool === 'pen' || tool === 'eraser') && tool !== lastInk) setLastInk(tool);
  const [pinned, setPinned] = useState<Tool | null>(null);
  const [route, setRoute] = useState<RouteKind>(engine.connectorRoute);
  const release = useCallback(() => setPinned(null), []);
  usePinnedTool(engine, pinned, release);

  const pick = (next: Tool): void => {
    setPinned(null);
    engine.setTool(next);
  };
  const pin = (next: Tool): void => {
    engine.setTool(next);
    if (next !== 'select') setPinned(next);
  };
  const common = { onPick: pick, onPin: pin, focusCanvas };

  return (
    <div
      // A group, not role=toolbar: every button is in the Tab order, there is no arrow-key roving.
      role="group"
      aria-label={t('canvasBoard.toolbar')}
      data-testid="canvas-toolbar"
      className={cx(PANEL, 'absolute left-3 top-1/2 z-10 flex -translate-y-1/2 flex-col gap-0.5')}
    >
      <HintPalette.Provider value={palette}>
      <ToolButton {...common} tool="select" icon={<MousePointer2 className={ICON} strokeWidth={1.75} aria-hidden />} active={tool === 'select'} pinned={false} />
      <ToolButton
        {...common}
        tool="sticky"
        // The armed color shows on the tool itself.
        icon={<StickyIcon className={ICON} strokeWidth={1.75} fill={resolveSticky(palette, stickyColor).bg} aria-hidden />}
        active={tool === 'sticky'}
        pinned={pinned === 'sticky'}
        flyoutLabel={t('canvasBoard.props.color')}
        flyoutTestId="canvas-sticky-menu"
        flyout={<StickyColors palette={palette} value={stickyColor} onPick={(c) => engine.setStickyColor(c)} />}
      />
      <ToolButton {...common} tool="text" icon={<Type className={ICON} strokeWidth={1.75} aria-hidden />} active={tool === 'text'} pinned={pinned === 'text'} />
      <ToolButton
        {...common}
        tool="shape"
        icon={shapeIcon(shapeKind)}
        active={tool === 'shape'}
        pinned={pinned === 'shape'}
        flyoutLabel={t('canvasBoard.props.shape')}
        flyoutTestId="canvas-shape-menu"
        flyout={
          <div className="flex w-52 flex-col gap-0.5">
            {SHAPE_DEFS.map((d) => (
              <FlyoutOption key={d.kind} label={t(d.label)} selected={shapeKind === d.kind} onPick={() => engine.setShapeKind(d.kind)} testId={`canvas-shape-${d.kind}`} className={cx(MENU_ITEM, 'w-full')}>
                {shapeIcon(d.kind)}
                {t(d.label)}
              </FlyoutOption>
            ))}
          </div>
        }
      />
      <ToolButton
        {...common}
        tool="connector"
        icon={ROUTE_ICON[route]}
        active={tool === 'connector'}
        pinned={pinned === 'connector'}
        flyoutLabel={t('canvasBoard.props.route')}
        flyoutTestId="canvas-route-menu"
        flyout={
          <div className="flex flex-col gap-0.5">
            {ROUTE_DEFS.map((d) => (
              <FlyoutOption
                key={d.route}
                label={t(d.label)}
                selected={route === d.route}
                onPick={() => {
                  setRoute(d.route);
                  engine.setConnectorRoute(d.route);
                }}
                testId={`canvas-route-${d.route}`}
                className={cx(MENU_ITEM, 'w-full')}
              >
                {ROUTE_ICON[d.route]}
                {t(d.label)}
              </FlyoutOption>
            ))}
          </div>
        }
      />
      <ToolButton
        {...common}
        tool="frame"
        icon={<Frame className={ICON} strokeWidth={1.75} aria-hidden />}
        active={tool === 'frame'}
        pinned={pinned === 'frame'}
        flyoutLabel={t('canvasBoard.frame.size')}
        flyoutTestId="canvas-frame-menu"
        flyout={<FrameSizes engine={engine} />}
      />
      <ToolButton
        {...common}
        tool="pen"
        onPick={() => pick(lastInk)}
        onPin={() => pick(lastInk)}
        icon={
          tool === 'eraser' ? <Eraser className={ICON} strokeWidth={1.75} aria-hidden /> : (
            <span className="relative grid place-items-center">
              {inkMarker ? <Highlighter className={ICON} strokeWidth={1.75} aria-hidden /> : <Pencil className={ICON} strokeWidth={1.75} aria-hidden />}
              {/* The armed color, as on the sticky tool. */}
              <span aria-hidden className="absolute -bottom-0.5 -right-0.5 size-[7px] rounded-full ring-1 ring-[var(--color-separator)]" style={{ background: resolveColor(palette, inkColor) ?? palette.ink }} />
            </span>
          )
        }
        active={tool === 'pen' || tool === 'eraser'}
        pinned={false}
        flyoutLabel={t('canvasBoard.tool.pen')}
        flyoutTestId="canvas-ink-menu"
        stay
        flyout={<InkPanel engine={engine} palette={palette} />}
      />
      <ToolButton {...common} tool="comment" icon={<MessageSquarePlus className={ICON} strokeWidth={1.75} aria-hidden />} active={tool === 'comment'} pinned={false} />
      <StickerTool engine={engine} workspaceId={workspaceId} focusCanvas={focusCanvas} />
      <div className="mx-1 my-0.5 h-px bg-line" aria-hidden />
      <TemplatesMenu engine={engine} focusCanvas={focusCanvas} />
      <VoteButton engine={engine} focusCanvas={focusCanvas} />
      <TimerButton store={timer} focusCanvas={focusCanvas} />
      </HintPalette.Provider>
    </div>
  );
});

/** Undo / redo, bottom left. Re-renders only when their availability flips. */
export const HistoryBar = memo(function HistoryBar({ engine, focusCanvas }: { engine: CanvasEngine; focusCanvas: () => void }): ReactNode {
  useLocale();
  const canUndo = useEngineValue(engine, (s) => s.canUndo);
  const canRedo = useEngineValue(engine, (s) => s.canRedo);
  return (
    <div className={cx(PANEL, 'absolute bottom-3 left-3 z-10 flex items-center gap-0.5')} data-testid="canvas-history">
      <IconButton label={t('canvasBoard.undo')} shortcut={`${MOD}Z`} disabled={!canUndo} onMouseDown={keepFocus} onClick={() => { engine.undo(); focusCanvas(); }} data-testid="canvas-undo">
        <Undo2 className={ICON} strokeWidth={1.75} aria-hidden />
      </IconButton>
      <div className={DIVIDER} aria-hidden />
      <IconButton label={t('canvasBoard.redo')} shortcut={`⇧${MOD}Z`} disabled={!canRedo} onMouseDown={keepFocus} onClick={() => { engine.redo(); focusCanvas(); }} data-testid="canvas-redo">
        <Redo2 className={ICON} strokeWidth={1.75} aria-hidden />
      </IconButton>
    </div>
  );
});
