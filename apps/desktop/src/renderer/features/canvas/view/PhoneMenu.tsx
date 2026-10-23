import { ClipboardPaste, LayoutTemplate, Type } from 'lucide-react';
import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { cx } from '../../../components/ui';
import { t, useLocale } from '../../../i18n';
import type { Point } from '../../../lib/canvas/geometry';
import type { CanvasEngine } from '../engine';
import { PANEL, keepFocus } from './chrome';

/**
 * The long-press menu of the phone's edit mode (ADR-0127 wave 5b): a press that stays put on empty canvas opens
 * «Вставить · Текст · Шаблон…» at the finger (the touch screen's right click). A leaf with its own subscription to the
 * engine's press event; closed, it renders nothing and holds nothing. A tap anywhere else (a backdrop) closes it.
 */

const MENU_W = 196;
const ROW = 'flex h-11 w-full items-center gap-3 rounded-[var(--radius-control)] px-3 text-left text-body text-fg active:bg-active';

interface Open {
  s: Point;
  w: Point;
}

export const PhoneMenu = memo(function PhoneMenu({ engine, onTemplates }: { engine: CanvasEngine; onTemplates: () => void }): ReactNode {
  useLocale();
  const [open, setOpen] = useState<Open | null>(null);
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => engine.onLongPress((s, w) => setOpen({ s, w })), [engine]);
  // Selecting, starting a text or a tool change puts the menu away too.
  useEffect(() => {
    if (!open) return undefined;
    return engine.subscribe(() => setOpen(null));
  }, [engine, open]);
  if (!open) return null;
  const view = engine.viewport;
  const left = Math.max(8, Math.min(open.s.x - MENU_W / 2, view.w - MENU_W - 8));
  const h = 3 * 44 + 8;
  // Above the finger when there is room (the finger covers what is below it), else below.
  const top = open.s.y - h - 16 >= 8 ? open.s.y - h - 16 : Math.min(open.s.y + 24, view.h - h - 8);
  const done = (fn: () => unknown) => (): void => {
    setOpen(null);
    fn();
  };
  return (
    <>
      <button type="button" aria-label={t('canvasPhone.menuClose')} tabIndex={-1} className="absolute inset-0 z-[9] cursor-default bg-transparent" onClick={() => setOpen(null)} data-testid="canvas-phone-menu-backdrop" />
      <div
        ref={el}
        role="menu"
        aria-label={t('canvasPhone.menu')}
        data-testid="canvas-phone-menu"
        className={cx(PANEL, 'absolute z-10 flex flex-col')}
        style={{ left, top, width: MENU_W }}
      >
        <button type="button" role="menuitem" className={ROW} onMouseDown={keepFocus} onClick={done(() => void engine.paste())} data-testid="canvas-phone-menu-paste">
          <ClipboardPaste className="size-5 shrink-0 text-muted" strokeWidth={1.75} aria-hidden />
          {t('canvasPhone.menu.paste')}
        </button>
        <button type="button" role="menuitem" className={ROW} onMouseDown={keepFocus} onClick={done(() => engine.createTextAt(open.w))} data-testid="canvas-phone-menu-text">
          <Type className="size-5 shrink-0 text-muted" strokeWidth={1.75} aria-hidden />
          {t('canvasPhone.menu.text')}
        </button>
        <button type="button" role="menuitem" className={ROW} onMouseDown={keepFocus} onClick={done(onTemplates)} data-testid="canvas-phone-menu-templates">
          <LayoutTemplate className="size-5 shrink-0 text-muted" strokeWidth={1.75} aria-hidden />
          {t('canvasPhone.menu.templates')}
        </button>
      </div>
    </>
  );
});
