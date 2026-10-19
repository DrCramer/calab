import * as Popover from '@radix-ui/react-popover';
import { ArrowLeftRight, ArrowRight, BringToFront, Check, CopyPlus, Minus, SendToBack, Slash, Trash2 } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { IconButton, cx } from '../../../components/ui';
import { t, useLocale } from '../../../i18n';
import type { Arrow, ObjectPatch, RouteKind, ShapeKind } from '../../../lib/canvas/types';
import { resolveColor, resolveSticky, type CanvasEngine, type CanvasPalette } from '../engine';
import { DIVIDER, MENU_BOX, PANEL, keepFocus } from './chrome';
import { placePanel } from './layout';
import {
  ARROW_DEFS, FILL_COLORS, INK_COLORS, ROUTE_DEFS, SHAPE_DEFS, STICKY_COLORS, STROKE_COLORS, STROKE_WIDTHS, TEXT_SIZES, nearestTextSize,
} from './model';
import { createSelectionModel } from './selectionModel';

const ICON = 'size-4';

type ColorKind = 'sticky' | 'ink' | 'fill';

function swatchCss(palette: CanvasPalette, kind: ColorKind, token: string): string | null {
  return kind === 'sticky' ? resolveSticky(palette, token).bg : resolveColor(palette, token);
}

function colorLabel(token: string): string {
  const key = `canvasBoard.color.${token}`;
  const s = t(key as Parameters<typeof t>[0]);
  return s === key ? token : s;
}

function Swatch({ css, none, size = 18 }: { css: string | null; none?: boolean; size?: number }): ReactNode {
  return (
    <span
      aria-hidden
      className="relative grid place-items-center overflow-hidden rounded-full ring-1 ring-inset ring-[var(--color-separator)]"
      style={{ width: size, height: size, background: css ?? 'transparent' }}
    >
      {none || css === null ? <Slash className="size-3 text-muted" strokeWidth={2} /> : null}
    </span>
  );
}

/** A color button that opens a grid of palette swatches. `value` undefined = the selection differs. */
function SwatchMenu({
  label, kind, tokens, value, palette, onPick, focusCanvas, testId,
}: {
  label: string;
  kind: ColorKind;
  tokens: readonly string[];
  value: string | undefined;
  palette: CanvasPalette;
  onPick: (token: string) => void;
  focusCanvas: () => void;
  testId: string;
}): ReactNode {
  const current = value === undefined ? null : swatchCss(palette, kind, value);
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <IconButton label={label} size="sm" onMouseDown={keepFocus} data-testid={testId}>
          <Swatch css={current} none={value === 'none'} size={20} />
        </IconButton>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="center"
          sideOffset={8}
          className={cx(MENU_BOX, 'min-w-0 p-2')}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            focusCanvas();
          }}
          aria-label={label}
        >
          <div className="grid grid-cols-5 gap-1.5" role="group">
            {tokens.map((tok) => (
              <Popover.Close asChild key={tok}>
                <button
                  type="button"
                  aria-label={colorLabel(tok)}
                  aria-pressed={tok === value}
                  data-testid={`${testId}-${tok}`}
                  onClick={() => onPick(tok)}
                  className="grid size-7 place-items-center rounded-full hover:bg-hover"
                >
                  <span className="relative grid place-items-center">
                    <Swatch css={swatchCss(palette, kind, tok)} none={tok === 'none'} size={20} />
                    {tok === value ? <Check className="absolute size-3 text-fg mix-blend-difference" strokeWidth={3} aria-hidden /> : null}
                  </span>
                </button>
              </Popover.Close>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Seg<T extends string | number>({
  label, items, value, onPick, testId,
}: {
  label: string;
  items: readonly { id: T; label: string; node: ReactNode }[];
  value: T | undefined;
  onPick: (v: T) => void;
  testId: string;
}): ReactNode {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-0.5">
      {items.map((it) => (
        <IconButton
          key={String(it.id)}
          label={it.label}
          size="sm"
          active={it.id === value}
          className={cx(it.id === value && 'bg-active text-fg')}
          onMouseDown={keepFocus}
          onClick={() => onPick(it.id)}
          data-testid={`${testId}-${String(it.id)}`}
        >
          {it.node}
        </IconButton>
      ))}
    </div>
  );
}

const arrowNode: Record<Arrow, ReactNode> = {
  none: <Minus className={ICON} strokeWidth={1.75} aria-hidden />,
  end: <ArrowRight className={ICON} strokeWidth={1.75} aria-hidden />,
  both: <ArrowLeftRight className={ICON} strokeWidth={1.75} aria-hidden />,
};

function routeNode(route: RouteKind): ReactNode {
  return route === 'straight' ? (
    <svg viewBox="0 0 16 16" className={ICON} fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden><path d="M2 13 14 3" /></svg>
  ) : (
    <svg viewBox="0 0 16 16" className={ICON} fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden><path d="M2 13h6V3h6" /></svg>
  );
}

function shapeNode(kind: ShapeKind): ReactNode {
  const p: Record<ShapeKind, ReactNode> = {
    rect: <rect x="2.5" y="3.5" width="11" height="9" />,
    rounded: <rect x="2.5" y="3.5" width="11" height="9" rx="3" />,
    ellipse: <ellipse cx="8" cy="8" rx="5.5" ry="4.5" />,
    diamond: <path d="M8 2.5 13.5 8 8 13.5 2.5 8Z" />,
    triangle: <path d="M8 3 13.5 13h-11Z" />,
  };
  return <svg viewBox="0 0 16 16" className={ICON} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden>{p[kind]}</svg>;
}

function widthNode(w: number): ReactNode {
  return <svg viewBox="0 0 16 16" className={ICON} aria-hidden><rect x="2" y={8 - w / 2} width="12" height={w} rx={w / 2} fill="currentColor" /></svg>;
}

/**
 * The floating properties panel (ADR-0107 §5). It appears above the selected object and follows it by
 * writing `transform` directly from the engine's view events — React renders it only when the selection's
 * displayed values change (selectionModel), never per frame of a drag or pan. Hidden during gestures and
 * text editing.
 */
export const PropsPanel = memo(function PropsPanel({
  engine, palette, focusCanvas,
}: {
  engine: CanvasEngine;
  palette: CanvasPalette;
  focusCanvas: () => void;
}): ReactNode {
  useLocale();
  const store = useMemo(() => createSelectionModel(engine), [engine]);
  const m = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const el = useRef<HTMLDivElement>(null);
  const size = useRef({ w: 0, h: 0 });
  const shown = useRef<boolean | null>(null);

  const place = useCallback((): void => {
    const node = el.current;
    if (!node) return;
    const s = engine.getState();
    let visible = false;
    if (s.selectionCount > 0 && !s.editing && !s.readOnly && engine.activeGesture === null) {
      const b = engine.scene.bounds(engine.selection);
      if (b) {
        const p = placePanel(b, engine.camera, engine.viewport, size.current);
        visible = p.visible;
        if (visible) node.style.transform = `translate(${p.x}px, ${p.y}px)`;
      }
    }
    if (shown.current !== visible) {
      shown.current = visible;
      node.style.visibility = visible ? 'visible' : 'hidden';
    }
  }, [engine]);

  // Measure after the contents change, then position; keep following through the engine's own events.
  useLayoutEffect(() => {
    const node = el.current;
    if (node) size.current = { w: node.offsetWidth, h: node.offsetHeight };
    place();
  }, [m, place]);
  useEffect(() => {
    const offView = engine.subscribeView(place);
    const offSel = engine.subscribeSelection(place);
    const offState = engine.subscribe(place);
    return () => {
      offView();
      offSel();
      offState();
    };
  }, [engine, place]);

  if (!m) return null;
  const patch = (p: ObjectPatch): void => {
    engine.updateSelected(p);
  };
  const run = (fn: () => void) => (): void => {
    fn();
    focusCanvas();
  };

  return (
    <div
      ref={el}
      role="toolbar"
      aria-label={t('canvasBoard.props.label')}
      data-testid="canvas-props"
      className={cx(PANEL, 'absolute left-0 top-0 z-10 flex w-max items-center gap-1')}
      style={{ visibility: 'hidden' }}
    >
      {m.hasSticky ? (
        <SwatchMenu label={t('canvasBoard.props.color')} kind="sticky" tokens={STICKY_COLORS} value={m.stickyColor} palette={palette} onPick={(c) => patch({ color: c })} focusCanvas={focusCanvas} testId="canvas-prop-sticky-color" />
      ) : null}
      {m.hasText ? (
        <>
          <SwatchMenu label={t('canvasBoard.props.color')} kind="ink" tokens={INK_COLORS} value={m.textColor} palette={palette} onPick={(c) => patch({ color: c })} focusCanvas={focusCanvas} testId="canvas-prop-text-color" />
          <Seg
            label={t('canvasBoard.props.textSize')}
            testId="canvas-prop-size"
            value={m.textSize === undefined ? undefined : nearestTextSize(m.textSize)}
            items={TEXT_SIZES.map((s) => ({ id: s.size, label: t(s.label), node: <span className="text-caption font-semibold">{s.glyph}</span> }))}
            onPick={(size) => patch({ size })}
          />
        </>
      ) : null}
      {m.hasShape ? (
        <>
          <Seg
            label={t('canvasBoard.props.shape')}
            testId="canvas-prop-shape"
            value={m.shape}
            items={SHAPE_DEFS.map((d) => ({ id: d.kind, label: t(d.label), node: shapeNode(d.kind) }))}
            onPick={(shape) => patch({ shape })}
          />
          <SwatchMenu label={t('canvasBoard.props.fill')} kind="fill" tokens={FILL_COLORS} value={m.fill} palette={palette} onPick={(c) => patch({ fill: c })} focusCanvas={focusCanvas} testId="canvas-prop-fill" />
        </>
      ) : null}
      {m.hasShape || m.hasConnector ? (
        <>
          <SwatchMenu label={t('canvasBoard.props.stroke')} kind="ink" tokens={STROKE_COLORS} value={m.stroke} palette={palette} onPick={(c) => patch({ stroke: c })} focusCanvas={focusCanvas} testId="canvas-prop-stroke" />
          <Seg
            label={t('canvasBoard.props.strokeWidth')}
            testId="canvas-prop-width"
            value={m.strokeWidth}
            items={STROKE_WIDTHS.map((w) => ({ id: w.width, label: t(w.label), node: widthNode(w.width) }))}
            onPick={(strokeWidth) => patch({ strokeWidth })}
          />
        </>
      ) : null}
      {m.hasConnector ? (
        <>
          <Seg
            label={t('canvasBoard.props.route')}
            testId="canvas-prop-route"
            value={m.route}
            items={ROUTE_DEFS.map((d) => ({ id: d.route, label: t(d.label), node: routeNode(d.route) }))}
            onPick={(route) => patch({ route })}
          />
          <Seg
            label={t('canvasBoard.props.arrow')}
            testId="canvas-prop-arrow"
            value={m.arrow}
            items={ARROW_DEFS.map((d) => ({ id: d.arrow, label: t(d.label), node: arrowNode[d.arrow] }))}
            onPick={(arrow) => patch({ arrow })}
          />
        </>
      ) : null}
      <div className={DIVIDER} aria-hidden />
      <IconButton label={t('canvasBoard.props.front')} shortcut="⇧⌘]" size="sm" onMouseDown={keepFocus} onClick={run(() => engine.reorder(1, true))} data-testid="canvas-prop-front">
        <BringToFront className={ICON} strokeWidth={1.75} aria-hidden />
      </IconButton>
      <IconButton label={t('canvasBoard.props.back')} shortcut="⇧⌘[" size="sm" onMouseDown={keepFocus} onClick={run(() => engine.reorder(-1, true))} data-testid="canvas-prop-back">
        <SendToBack className={ICON} strokeWidth={1.75} aria-hidden />
      </IconButton>
      <IconButton label={t('canvasBoard.props.duplicate')} shortcut="⌘D" size="sm" onMouseDown={keepFocus} onClick={run(() => engine.duplicateSelection())} data-testid="canvas-prop-duplicate">
        <CopyPlus className={ICON} strokeWidth={1.75} aria-hidden />
      </IconButton>
      <IconButton label={t('canvasBoard.props.delete')} shortcut="Del" size="sm" danger onMouseDown={keepFocus} onClick={run(() => engine.deleteSelection())} data-testid="canvas-prop-delete">
        <Trash2 className={ICON} strokeWidth={1.75} aria-hidden />
      </IconButton>
    </div>
  );
});

