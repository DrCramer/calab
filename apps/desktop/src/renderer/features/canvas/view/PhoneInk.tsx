import { Check, Eraser, Highlighter, Pencil } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '../../../components/ui';
import { t, useLocale } from '../../../i18n';
import { ERASER_SIZES } from '../../../lib/canvas/ink';
import { readableInk, resolveColor, type CanvasEngine, type CanvasPalette } from '../engine';
import { keepFocus } from './chrome';
import { useEngineValue } from './hooks';
import { PEN_COLORS } from './model';
import { Swatch, colorLabel, inkWidthItems } from './PropsPanel';

/**
 * The phone's pencil sheet (ADR-0127, ink): pen / marker / eraser, then the colors and widths (or the eraser sizes).
 * Two short rows of 44 px targets so it stays low; the bar closes it on the first touch of the canvas, the tool stays armed.
 */
const SHEET = 'mat-popover pointer-events-auto flex flex-col gap-1 rounded-t-[var(--radius-card)] border-x-0 border-b-0 p-2';
const OPT = 'grid h-11 min-w-0 flex-1 place-items-center rounded-[var(--radius-control)] text-fg active:bg-active';

const KINDS = [
  { id: 'pen', Icon: Pencil, label: 'canvasBoard.ink.pen' },
  { id: 'marker', Icon: Highlighter, label: 'canvasBoard.ink.marker' },
  { id: 'eraser', Icon: Eraser, label: 'canvasBoard.tool.eraser' },
] as const;

const ERASER_LABELS = ['canvasBoard.ink.eraserS', 'canvasBoard.ink.eraserM', 'canvasBoard.ink.eraserL'] as const;

function Opt({ label, selected, onPick, testId, children }: { label: string; selected: boolean; onPick: () => void; testId: string; children: ReactNode }): ReactNode {
  return (
    <button type="button" aria-label={label} title={label} aria-pressed={selected} onMouseDown={keepFocus} onClick={onPick} data-testid={testId} className={cx(OPT, selected && 'bg-active')}>
      {children}
    </button>
  );
}

export function PhoneInkSheet({ engine, palette }: { engine: CanvasEngine; palette: CanvasPalette }): ReactNode {
  useLocale();
  const tool = useEngineValue(engine, (s) => s.tool);
  const marker = useEngineValue(engine, (s) => s.inkMarker);
  const color = useEngineValue(engine, (s) => s.inkColor);
  const width = useEngineValue(engine, (s) => s.inkWidth);
  const eraser = useEngineValue(engine, (s) => s.eraserPx);
  const kind = tool === 'eraser' ? 'eraser' : marker ? 'marker' : 'pen';
  return (
    <div role="group" aria-label={t('canvasBoard.tool.pen')} className={SHEET} data-testid="canvas-phone-ink">
      <div role="group" aria-label={t('canvasBoard.ink.kind')} className="flex gap-1">
        {KINDS.map(({ id, Icon, label }) => (
          <Opt
            key={id}
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
          >
            <Icon className="size-[22px]" strokeWidth={1.75} aria-hidden />
          </Opt>
        ))}
      </div>
      {kind === 'eraser' ? (
        <div role="group" aria-label={t('canvasBoard.ink.eraserSize')} className="flex gap-1">
          {ERASER_SIZES.map((px, i) => (
            <Opt key={px} label={t(ERASER_LABELS[i] ?? 'canvasBoard.ink.eraserM')} selected={px === eraser} onPick={() => engine.setEraserPx(px)} testId={`canvas-eraser-size-${px}`}>
              <span aria-hidden className="rounded-full border-[1.5px] border-current" style={{ width: Math.min(28, px * 1.1 + 4), height: Math.min(28, px * 1.1 + 4) }} />
            </Opt>
          ))}
        </div>
      ) : (
        <>
          <div role="group" aria-label={t('canvasBoard.props.color')} className="flex">
            {PEN_COLORS.map((tok) => {
              const css = resolveColor(palette, tok);
              return (
                <button
                  key={tok}
                  type="button"
                  aria-label={colorLabel(tok)}
                  title={colorLabel(tok)}
                  aria-pressed={tok === color}
                  onMouseDown={keepFocus}
                  onClick={() => engine.setInk({ color: tok })}
                  data-testid={`canvas-ink-color-${tok}`}
                  className="relative grid h-11 min-w-0 flex-1 place-items-center active:bg-active"
                >
                  <Swatch css={css} size={22} />
                  {tok === color && css ? <Check className="absolute size-3.5" style={{ color: readableInk(css, '#ffffff') }} strokeWidth={3} aria-hidden /> : null}
                </button>
              );
            })}
          </div>
          <div role="group" aria-label={t('canvasBoard.props.strokeWidth')} className="flex gap-1">
            {inkWidthItems(marker).map((it) => (
              <Opt key={it.id} label={it.label} selected={it.id === width} onPick={() => engine.setInk({ width: it.id })} testId={`canvas-ink-width-${it.id}`}>
                {it.node}
              </Opt>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
