import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { ChevronDown, MousePointer2, Redo2, Spline, StickyNote, Type, Undo2, Waypoints } from 'lucide-react';
import { memo, useCallback, useEffect, useState, type ReactNode } from 'react';
import { IconButton, Tip, cx } from '../../../components/ui';
import { t, useLocale } from '../../../i18n';
import type { RouteKind, ShapeKind } from '../../../lib/canvas/types';
import type { CanvasEngine, Tool } from '../engine';
import { ACTIVE_TOOL, DIVIDER, MENU_BOX, MENU_ITEM, PANEL, keepFocus } from './chrome';
import { useEngineValue } from './hooks';
import { ShapeIcon } from './ShapeIcon';
import { TemplatesMenu } from './Templates';
import { ROUTE_DEFS, SHAPE_DEFS, TOOL_DEFS } from './model';

const ICON = 'size-[18px]';

const shapeIcon = (kind: ShapeKind): ReactNode => <ShapeIcon kind={kind} className={ICON} />;

const ROUTE_ICON: Record<RouteKind, ReactNode> = {
  straight: <Spline className={ICON} strokeWidth={1.75} aria-hidden />,
  elbow: <Waypoints className={ICON} strokeWidth={1.75} aria-hidden />,
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

function ToolButton({
  tool, icon, active, pinned, onPick, onPin, focusCanvas, menu,
}: {
  tool: Tool;
  icon: ReactNode;
  active: boolean;
  pinned: boolean;
  onPick: (t: Tool) => void;
  onPin: (t: Tool) => void;
  focusCanvas: () => void;
  menu?: ReactNode;
}): ReactNode {
  const def = TOOL_DEFS.find((d) => d.tool === tool);
  if (!def) return null;
  const label = pinned ? `${t(def.label)} — ${t('canvasBoard.tool.pinned')}` : t(def.label);
  return (
    <div className="relative">
      <IconButton
        label={label}
        shortcut={def.key}
        active={active}
        className={cx(active && ACTIVE_TOOL)}
        onMouseDown={keepFocus}
        onClick={() => {
          onPick(tool);
          focusCanvas();
        }}
        onDoubleClick={() => onPin(tool)}
        data-testid={`canvas-tool-${tool}`}
        data-pinned={pinned || undefined}
      >
        {icon}
      </IconButton>
      {pinned ? <span aria-hidden className="pointer-events-none absolute right-1 top-1 size-1.5 rounded-full bg-accent-fg" /> : null}
      {menu}
    </div>
  );
}

function FlyoutTrigger({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <Dropdown.Root modal={false}>
      <Tip label={label} side="right">
        <Dropdown.Trigger asChild>
          <button
            type="button"
            aria-label={label}
            onMouseDown={keepFocus}
            className="absolute -right-0.5 -bottom-0.5 grid size-3.5 place-items-center rounded-full text-muted hover:text-fg"
          >
            <ChevronDown className="size-3" strokeWidth={2} aria-hidden />
          </button>
        </Dropdown.Trigger>
      </Tip>
      {children}
    </Dropdown.Root>
  );
}

export const Toolbar = memo(function Toolbar({ engine, focusCanvas }: { engine: CanvasEngine; focusCanvas: () => void }): ReactNode {
  useLocale();
  const tool = useEngineValue(engine, (s) => s.tool);
  const shapeKind = useEngineValue(engine, (s) => s.shapeKind);
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
  const refocus = (e: Event): void => {
    e.preventDefault();
    focusCanvas();
  };

  return (
    <div
      role="toolbar"
      aria-orientation="vertical"
      aria-label={t('canvasBoard.toolbar')}
      data-testid="canvas-toolbar"
      className={cx(PANEL, 'absolute left-3 top-1/2 z-10 flex -translate-y-1/2 flex-col gap-0.5')}
    >
      <ToolButton {...common} tool="select" icon={<MousePointer2 className={ICON} strokeWidth={1.75} aria-hidden />} active={tool === 'select'} pinned={false} />
      <ToolButton {...common} tool="sticky" icon={<StickyNote className={ICON} strokeWidth={1.75} aria-hidden />} active={tool === 'sticky'} pinned={pinned === 'sticky'} />
      <ToolButton {...common} tool="text" icon={<Type className={ICON} strokeWidth={1.75} aria-hidden />} active={tool === 'text'} pinned={pinned === 'text'} />
      <ToolButton
        {...common}
        tool="shape"
        icon={shapeIcon(shapeKind)}
        active={tool === 'shape'}
        pinned={pinned === 'shape'}
        menu={
          <FlyoutTrigger label={t('canvasBoard.tool.more')}>
            <Dropdown.Portal>
              <Dropdown.Content
                side="right"
                align="start"
                sideOffset={8}
                className={cx(MENU_BOX, 'grid w-auto min-w-0 grid-cols-4 gap-0.5')}
                onCloseAutoFocus={refocus}
                data-testid="canvas-shape-menu"
              >
                {SHAPE_DEFS.map((d) => (
                  <Dropdown.Item
                    key={d.kind}
                    aria-label={t(d.label)}
                    title={t(d.label)}
                    data-testid={`canvas-shape-${d.kind}`}
                    className={cx(
                      'grid size-9 cursor-default place-items-center rounded-[6px] text-fg outline-none data-[highlighted]:bg-accent-strong data-[highlighted]:text-accent-fg',
                      shapeKind === d.kind && 'bg-active',
                    )}
                    onSelect={() => {
                      engine.setShapeKind(d.kind);
                      pick('shape');
                    }}
                  >
                    {shapeIcon(d.kind)}
                  </Dropdown.Item>
                ))}
              </Dropdown.Content>
            </Dropdown.Portal>
          </FlyoutTrigger>
        }
      />
      <ToolButton
        {...common}
        tool="connector"
        icon={ROUTE_ICON[route]}
        active={tool === 'connector'}
        pinned={pinned === 'connector'}
        menu={
          <FlyoutTrigger label={t('canvasBoard.tool.more')}>
            <Dropdown.Portal>
              <Dropdown.Content side="right" align="start" sideOffset={8} className={MENU_BOX} onCloseAutoFocus={refocus} data-testid="canvas-route-menu">
                {ROUTE_DEFS.map((d) => (
                  <Dropdown.Item
                    key={d.route}
                    className={cx(MENU_ITEM, route === d.route && 'font-medium')}
                    onSelect={() => {
                      setRoute(d.route);
                      engine.setConnectorRoute(d.route);
                      pick('connector');
                    }}
                  >
                    {ROUTE_ICON[d.route]}
                    {t(d.label)}
                  </Dropdown.Item>
                ))}
              </Dropdown.Content>
            </Dropdown.Portal>
          </FlyoutTrigger>
        }
      />
      <div className="mx-1 my-0.5 h-px bg-line" aria-hidden />
      <TemplatesMenu engine={engine} focusCanvas={focusCanvas} />
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
      <IconButton label={t('canvasBoard.undo')} shortcut="⌘Z" disabled={!canUndo} onMouseDown={keepFocus} onClick={() => { engine.undo(); focusCanvas(); }} data-testid="canvas-undo">
        <Undo2 className={ICON} strokeWidth={1.75} aria-hidden />
      </IconButton>
      <div className={DIVIDER} aria-hidden />
      <IconButton label={t('canvasBoard.redo')} shortcut="⇧⌘Z" disabled={!canRedo} onMouseDown={keepFocus} onClick={() => { engine.redo(); focusCanvas(); }} data-testid="canvas-redo">
        <Redo2 className={ICON} strokeWidth={1.75} aria-hidden />
      </IconButton>
    </div>
  );
});
