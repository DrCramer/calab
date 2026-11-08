import * as Popover from '@radix-ui/react-popover';
import { CornerDownLeft, Type } from 'lucide-react';
import { memo, useEffect, useState, type ReactNode } from 'react';
import { cx } from '../../../components/ui';
import { t, useLocale } from '../../../i18n';
import { sameCamera } from '../../../lib/canvas/camera';
import type { Point } from '../../../lib/canvas/geometry';
import type { ShapeKind } from '../../../lib/canvas/types';
import type { CanvasEngine, QuickChoice } from '../engine';
import { MENU_BOX } from './chrome';
import { ShapeIcon } from './ShapeIcon';
import { StickyIcon } from './StickyIcon';

const ICON = 'size-[22px]';
const FIRST: readonly ShapeKind[] = ['rect', 'rounded', 'ellipse', 'diamond', 'parallelogram', 'triangle'];
const MORE: readonly ShapeKind[] = ['star', 'hexagon', 'arrow', 'bubble', 'cylinder'];

/** The wide sticky: StickyIcon's outline stretched (fold bottom right). */
function WideStickyIcon(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" className={ICON} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17 18H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5Z" />
      <path d="M16 18v-3a2 2 0 0 1 2-2h4" />
    </svg>
  );
}

/**
 * Where a «continue» line was released on empty canvas (Miro-style): what to put at its end. The field makes the
 * source's copy (Enter; typed text goes into it), the grid a text, a sticky or a shape. Closing it any other way
 * (Esc, a click elsewhere, a pan or zoom that would leave it floating) drops the line and makes nothing.
 */
export const QuickDropMenu = memo(function QuickDropMenu({ engine, focusCanvas }: { engine: CanvasEngine; focusCanvas: () => void }): ReactNode {
  useLocale();
  const [at, setAt] = useState<Point | null>(null);
  const [more, setMore] = useState(false);
  const [text, setText] = useState('');

  useEffect(
    () =>
      engine.onQuickDrop((d) => {
        setAt(d ? d.screen : null);
        setMore(false);
        setText('');
      }),
    [engine],
  );
  useEffect(() => {
    if (!at) return undefined;
    const cam = engine.camera;
    return engine.subscribeView(() => {
      if (!sameCamera(cam, engine.camera)) engine.quickDismiss();
    });
  }, [at, engine]);

  if (!at) return null;
  const place = (c: QuickChoice): void => engine.quickPlace(c, text);
  const cell = 'grid size-10 cursor-default place-items-center rounded-[var(--radius-icon)] text-fg hover:bg-hover focus-visible:bg-hover';
  const shapes = (kinds: readonly ShapeKind[]): ReactNode =>
    kinds.map((k) => (
      <button key={k} type="button" className={cell} aria-label={t(`canvasBoard.shape.${k}`)} title={t(`canvasBoard.shape.${k}`)} onClick={() => place({ kind: 'shape', shape: k })} data-testid={`canvas-drop-shape-${k}`}>
        <ShapeIcon kind={k} className={ICON} />
      </button>
    ));

  return (
    <Popover.Root
      open
      onOpenChange={(o) => {
        if (!o) engine.quickDismiss();
      }}
    >
      <Popover.Anchor asChild>
        <div className="pointer-events-none absolute size-0" style={{ left: at.x, top: at.y }} aria-hidden />
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          side="right"
          align="center"
          sideOffset={10}
          collisionPadding={8}
          className={cx(MENU_BOX, 'flex w-auto min-w-0 flex-col gap-2 p-3')}
          aria-label={t('canvasBoard.quick.label')}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            focusCanvas();
          }}
          data-testid="canvas-drop-menu"
        >
          <label className="flex h-10 items-center gap-2 rounded-[var(--radius-control)] border border-line px-2.5 focus-within:border-accent">
            <input
              // The menu exists to be answered: typing goes here at once.
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                e.preventDefault();
                place({ kind: 'same' });
              }}
              placeholder={t('canvasBoard.quick.same')}
              aria-label={t('canvasBoard.quick.same')}
              className="selectable w-40 min-w-0 flex-1 bg-transparent text-body text-fg outline-none placeholder:text-faint"
              data-testid="canvas-drop-same"
            />
            <CornerDownLeft className="size-4 shrink-0 text-faint" strokeWidth={1.75} aria-hidden />
          </label>
          <div className="grid grid-cols-3 justify-items-center gap-1">
            <button type="button" className={cell} aria-label={t('canvasBoard.tool.text')} title={t('canvasBoard.tool.text')} onClick={() => place({ kind: 'text' })} data-testid="canvas-drop-text">
              <Type className={ICON} strokeWidth={1.75} aria-hidden />
            </button>
            <button type="button" className={cell} aria-label={t('canvasBoard.tool.sticky')} title={t('canvasBoard.tool.sticky')} onClick={() => place({ kind: 'sticky' })} data-testid="canvas-drop-sticky">
              <StickyIcon className={ICON} strokeWidth={1.75} aria-hidden />
            </button>
            <button type="button" className={cell} aria-label={t('canvasBoard.quick.wide')} title={t('canvasBoard.quick.wide')} onClick={() => place({ kind: 'sticky', wide: true })} data-testid="canvas-drop-sticky-wide">
              <WideStickyIcon />
            </button>
            {shapes(FIRST)}
            {more ? shapes(MORE) : null}
          </div>
          <div className="-mx-3 h-px bg-line" aria-hidden />
          <button type="button" className="h-8 rounded-[var(--radius-icon)] text-body text-muted hover:bg-hover hover:text-fg" onClick={() => setMore((v) => !v)} aria-expanded={more} data-testid="canvas-drop-more">
            {t(more ? 'canvasBoard.quick.less' : 'canvasBoard.quick.more')}
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
});
