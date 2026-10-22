import { Bold, Italic, List, ListOrdered, Strikethrough } from 'lucide-react';
import { memo, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { IconButton, MOD, cx } from '../../../components/ui';
import { t, useLocale } from '../../../i18n';
import { F_BOLD, F_ITALIC, F_STRIKE } from '../../../lib/canvas/richText';
import type { CanvasEngine } from '../engine';
import { FontSizeField } from './FontSizeField';
import { DIVIDER, PANEL, keepFocus } from './chrome';

const ICON = 'size-4';
/** Gap between the bar and the text box, and the least distance from the work area's edge. */
const GAP = 8;

/**
 * The format bar over the text being edited (ADR-0116): bold, italic, strike-through, bullet / numbered list and
 * the text size. It is a leaf with its own subscription to the editor, mounted for the whole session but
 * rendering nothing while no text is open; its buttons never take the focus (`keepFocus`), so the textarea
 * keeps its selection and does not commit (the size field does, and says so with `data-keeps-editing`).
 */
export const TextFormatBar = memo(function TextFormatBar({ engine }: { engine: CanvasEngine }): ReactNode {
  useLocale();
  const ed = engine.editor;
  const st = useSyncExternalStore(ed.subscribe, ed.getSnapshot);
  const el = useRef<HTMLDivElement>(null);

  // Above the text box (below it when there is no room), kept inside the work area.
  useLayoutEffect(() => {
    const node = el.current;
    if (!node || !st.open) return;
    const host = node.offsetParent;
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    const maxX = Math.max(GAP, (host?.clientWidth ?? 0) - w - GAP);
    node.style.left = `${Math.min(Math.max(GAP, st.x), maxX)}px`;
    const above = st.y - h - GAP;
    node.style.top = `${above >= GAP ? above : st.y + st.h + GAP}px`;
  });

  if (!st.open || !st.rich) return null;
  const flag = (label: string, key: string, shortcut: string, on: boolean, bit: number, icon: ReactNode): ReactNode => (
    <IconButton
      label={label}
      shortcut={shortcut}
      size="sm"
      active={on}
      className={cx(on && 'bg-active text-fg')}
      onMouseDown={keepFocus}
      onClick={() => ed.toggleFlag(bit)}
      data-testid={`canvas-format-${key}`}
    >
      {icon}
    </IconButton>
  );
  return (
    <div
      ref={el}
      role="toolbar"
      aria-label={t('canvasBoard.format.bar')}
      data-testid="canvas-format-bar"
      // The size field is the one control that takes the focus (to type in); the editor knows it as part of editing.
      onMouseDown={(e) => {
        if (!(e.target instanceof HTMLInputElement)) keepFocus(e);
      }}
      className={cx(PANEL, 'absolute z-10 flex w-max items-center gap-0.5')}
      style={{ left: st.x, top: st.y }}
    >
      {flag(t('canvasBoard.format.bold'), 'bold', `${MOD}B`, st.bold, F_BOLD, <Bold className={ICON} strokeWidth={1.75} aria-hidden />)}
      {flag(t('canvasBoard.format.italic'), 'italic', `${MOD}I`, st.italic, F_ITALIC, <Italic className={ICON} strokeWidth={1.75} aria-hidden />)}
      {flag(t('canvasBoard.format.strike'), 'strike', `⇧${MOD}X`, st.strike, F_STRIKE, <Strikethrough className={ICON} strokeWidth={1.75} aria-hidden />)}
      <div className={DIVIDER} aria-hidden />
      <IconButton
        label={t('canvasBoard.format.bullet')}
        size="sm"
        active={st.list === 'bullet'}
        className={cx(st.list === 'bullet' && 'bg-active text-fg')}
        onMouseDown={keepFocus}
        onClick={() => ed.toggleList('bullet')}
        data-testid="canvas-format-bullet"
      >
        <List className={ICON} strokeWidth={1.75} aria-hidden />
      </IconButton>
      <IconButton
        label={t('canvasBoard.format.number')}
        size="sm"
        active={st.list === 'number'}
        className={cx(st.list === 'number' && 'bg-active text-fg')}
        onMouseDown={keepFocus}
        onClick={() => ed.toggleList('number')}
        data-testid="canvas-format-number"
      >
        <ListOrdered className={ICON} strokeWidth={1.75} aria-hidden />
      </IconButton>
      {st.size !== null ? (
        <>
          <div className={DIVIDER} aria-hidden />
          <FontSizeField
            keepsEditing
            value={st.size}
            onCommit={(px) => engine.setEditFontSize(px)}
            release={() => ed.refocus()}
            leave={(to) => {
              if (!ed.keepsEditing(to)) ed.commit();
            }}
            testId="canvas-format-size"
          />
        </>
      ) : null}
    </div>
  );
});
