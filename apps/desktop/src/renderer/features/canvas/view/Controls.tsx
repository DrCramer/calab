import * as Popover from '@radix-ui/react-popover';
import { CircleHelp, Focus, Map as MapIcon, Maximize, Minus, Plus } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { ALT, IconButton, MOD, Tip, cx } from '../../../components/ui';
import { t, useLocale } from '../../../i18n';
import type { CanvasEngine } from '../engine';
import { DIVIDER, MENU_BOX, PANEL, keepFocus } from './chrome';
import { useEngineValue } from './hooks';
import { useMinimapPref } from './MiniMap';
import { minimapPref } from './minimapDraw';

const ICON = 'size-[18px]';

/** The zoom percentage: its own leaf so only it re-renders while zooming. */
const ZoomPct = memo(function ZoomPct({ engine, focusCanvas }: { engine: CanvasEngine; focusCanvas: () => void }): ReactNode {
  useLocale();
  const pct = useEngineValue(engine, (s) => s.zoomPct);
  return (
    <Tip label={t('canvasBoard.zoom.reset')} shortcut="0">
      <button
        type="button"
        onMouseDown={keepFocus}
        onClick={() => {
          engine.zoomTo(100);
          focusCanvas();
        }}
        aria-label={t('canvasBoard.zoom.reset')}
        data-testid="canvas-zoom-pct"
        className="h-8 min-w-12 rounded-[var(--radius-icon)] px-1.5 text-center text-control tabular-nums text-muted hover:bg-hover hover:text-fg"
      >
        {t('canvasBoard.zoom.value', { pct })}
      </button>
    </Tip>
  );
});

const HELP_ROWS = [
  'canvasBoard.help.tools',
  'canvasBoard.tool.pinHint',
  'canvasBoard.help.pan',
  'canvasBoard.help.zoom',
  'canvasBoard.help.fit',
  'canvasBoard.help.select',
  'canvasBoard.help.edit',
  'canvasBoard.help.move',
  'canvasBoard.help.copy',
  'canvasBoard.help.layers',
  'canvasBoard.help.rotate',
  'canvasBoard.help.group',
  'canvasBoard.help.lock',
  'canvasBoard.help.format',
  'canvasBoard.help.undo',
  'canvasBoard.help.comment',
] as const;

function Help({ focusCanvas, canWrite, open, onOpenChange }: { focusCanvas: () => void; canWrite: boolean; open: boolean; onOpenChange: (o: boolean) => void }): ReactNode {
  useLocale();
  // A view-only person has no tools or edits to learn about: the navigation lines only.
  const rows = canWrite ? HELP_ROWS : HELP_ROWS.filter((r) => r === 'canvasBoard.help.pan' || r === 'canvasBoard.help.zoom' || r === 'canvasBoard.help.fit');
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <IconButton label={t('canvasBoard.help.open')} shortcut="?" onMouseDown={keepFocus} data-testid="canvas-help">
          <CircleHelp className={ICON} strokeWidth={1.75} aria-hidden />
        </IconButton>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="end"
          sideOffset={8}
          className={cx(MENU_BOX, 'w-80 p-3')}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            focusCanvas();
          }}
          data-testid="canvas-help-panel"
        >
          <h2 className="mb-2 text-body font-semibold text-fg">{t('canvasBoard.help.title')}</h2>
          <ul className="flex flex-col gap-1.5 text-caption text-muted">
            {rows.map((k) => (
              <li key={k}>{t(k, { mod: MOD, alt: ALT })}</li>
            ))}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The mini-map switch: its own leaf, remembered per person (`localStorage`). */
function MiniMapToggle({ focusCanvas }: { focusCanvas: () => void }): ReactNode {
  useLocale();
  const on = useMinimapPref();
  return (
    <IconButton
      label={t('canvasBoard.minimap.toggle')}
      active={on}
      className={cx(on && 'bg-active text-fg')}
      onMouseDown={keepFocus}
      onClick={() => {
        minimapPref.set(!on);
        focusCanvas();
      }}
      data-testid="canvas-minimap-toggle"
    >
      <MapIcon className={ICON} strokeWidth={1.75} aria-hidden />
    </IconButton>
  );
}

/** Zoom, fit and the shortcut help: bottom right. `phone` (view only, no keyboard): zoom and «вписать всё» only. */
export const ZoomBar = memo(function ZoomBar({
  engine, focusCanvas, canWrite, helpOpen, onHelpOpenChange, phone = false, top = false, comments,
}: {
  engine: CanvasEngine;
  focusCanvas: () => void;
  canWrite: boolean;
  helpOpen: boolean;
  onHelpOpenChange: (o: boolean) => void;
  phone?: boolean;
  /** The phone's edit mode: the bar hangs from the top, the bottom belongs to the tool bar. */
  top?: boolean;
  /** The comments panel's button (ADR-0116 wave 4). */
  comments?: ReactNode;
}): ReactNode {
  useLocale();
  const step = (dir: 1 | -1) => (): void => {
    engine.zoomStep(dir);
    focusCanvas();
  };
  return (
    <div role="group" aria-label={t('canvasBoard.zoom.group')} className={cx(PANEL, 'absolute right-3 z-10 flex items-center gap-0.5', top ? 'top-3' : 'bottom-3')} data-testid="canvas-zoom">
      <IconButton label={t('canvasBoard.zoom.out')} shortcut="−" onMouseDown={keepFocus} onClick={step(-1)} data-testid="canvas-zoom-out">
        <Minus className={ICON} strokeWidth={1.75} aria-hidden />
      </IconButton>
      <ZoomPct engine={engine} focusCanvas={focusCanvas} />
      <IconButton label={t('canvasBoard.zoom.in')} shortcut="+" onMouseDown={keepFocus} onClick={step(1)} data-testid="canvas-zoom-in">
        <Plus className={ICON} strokeWidth={1.75} aria-hidden />
      </IconButton>
      <div className={DIVIDER} aria-hidden />
      <IconButton label={t('canvasBoard.zoom.fitAll')} shortcut="⇧1" onMouseDown={keepFocus} onClick={() => { engine.fitAll(); focusCanvas(); }} data-testid="canvas-fit-all">
        <Maximize className={ICON} strokeWidth={1.75} aria-hidden />
      </IconButton>
      {comments ? (
        <>
          <div className={DIVIDER} aria-hidden />
          {comments}
        </>
      ) : null}
      {phone ? null : (
        <>
          <IconButton label={t('canvasBoard.zoom.fitSelection')} shortcut="⇧2" onMouseDown={keepFocus} onClick={() => { engine.fitSelection(); focusCanvas(); }} data-testid="canvas-fit-selection">
            <Focus className={ICON} strokeWidth={1.75} aria-hidden />
          </IconButton>
          <MiniMapToggle focusCanvas={focusCanvas} />
          <div className={DIVIDER} aria-hidden />
          <Help focusCanvas={focusCanvas} canWrite={canWrite} open={helpOpen} onOpenChange={onHelpOpenChange} />
        </>
      )}
    </div>
  );
});
