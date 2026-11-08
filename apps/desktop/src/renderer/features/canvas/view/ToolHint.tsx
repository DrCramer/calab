import * as TooltipP from '@radix-ui/react-tooltip';
import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import * as Y from 'yjs';
import { t } from '../../../i18n';
import { CanvasDoc } from '../../../lib/canvas/doc';
import { Scene } from '../../../lib/canvas/scene';
import type { TemplateText } from '../../../lib/canvas/templates';
import { TextLayouter } from '../../../lib/canvas/textLayout';
import { makeCanvasMeasure, renderSceneTo, type CanvasPalette } from '../engine';
import { hintScene, type HintArtKey, type HintId } from './hints';

/** The board's palette for the hint pictures; changes only with the theme (no per-frame value in a context). */
export const HintPalette = createContext<CanvasPalette | null>(null);

const ART_W = 264;
const ART_H = 132;
const ART_PAD = 28;
const artText = (k: HintArtKey): string => t(`canvasBoard.hint.art.${k}`);
const templateText: TemplateText = (k, p) => t(`canvasBoard.templates.${k}`, p);

/**
 * A tool's hint card, to the right of the toolbar after a longer hover than a plain tooltip: the name and hotkey,
 * a small picture of what the tool makes and two lines on how to use it (Miro-style). It replaces the button's own
 * tooltip (`tip={false}` on it). `suppress` keeps it shut while the tool's own panel is open; a trigger whose menu
 * is open (`aria-expanded`) does not open it either.
 */
export function ToolHint({ id, title, shortcut, suppress, children }: { id: HintId; title: string; shortcut?: string; suppress?: boolean; children: ReactElement }): ReactNode {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <TooltipP.Root
      delayDuration={700}
      open={open && !suppress}
      onOpenChange={(o) => setOpen(o && trigger.current?.getAttribute('aria-expanded') !== 'true')}
    >
      <TooltipP.Trigger asChild ref={trigger}>
        {children}
      </TooltipP.Trigger>
      <TooltipP.Portal>
        <TooltipP.Content
          side="right"
          align="center"
          sideOffset={12}
          collisionPadding={8}
          className="mat-popover anim-in z-[var(--z-tooltip)] flex w-72 flex-col gap-2 rounded-[var(--radius-panel)] p-3"
          data-testid={`canvas-hint-${id}`}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-body font-medium text-fg">{title}</span>
            {shortcut ? <kbd className="rounded-[var(--radius-icon)] bg-hover px-1.5 font-sans text-micro text-muted">{shortcut}</kbd> : null}
          </div>
          <HintArt id={id} />
          <p className="text-caption text-muted">{t(`canvasBoard.hint.${id}`)}</p>
        </TooltipP.Content>
      </TooltipP.Portal>
    </TooltipP.Root>
  );
}

/**
 * The picture: a throwaway document with the tool's scene, painted once by the export path when the card opens
 * (nothing is kept, no timers). It sits on the board's background so it reads as a piece of the canvas.
 */
function HintArt({ id }: { id: HintId }): ReactNode {
  const palette = useContext(HintPalette);
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c || !palette) return;
    const ydoc = new Y.Doc();
    const doc = new CanvasDoc(ydoc);
    doc.createMany(hintScene(id, artText, templateText));
    const scene = new Scene(doc, new TextLayouter(makeCanvasMeasure(() => palette.fontFamily)));
    const b = scene.bounds();
    if (b) {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const ppu = Math.min(ART_W / (b.w + 2 * ART_PAD), ART_H / (b.h + 2 * ART_PAD)) * dpr;
      renderSceneTo(c, scene, palette, b, ppu, ART_PAD);
      c.style.width = `${c.width / dpr}px`;
      c.style.height = `${c.height / dpr}px`;
    }
    scene.destroy();
    doc.undo.destroy();
    ydoc.destroy();
  }, [id, palette]);
  return (
    <div className="grid place-items-center overflow-hidden rounded-[var(--radius-row)]" style={{ height: ART_H, background: palette?.background }} aria-hidden>
      <canvas ref={ref} />
    </div>
  );
}
