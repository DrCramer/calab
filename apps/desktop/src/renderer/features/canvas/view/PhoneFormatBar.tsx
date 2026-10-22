import { Bold, Check, Italic, List, ListOrdered, Strikethrough } from 'lucide-react';
import { memo, useSyncExternalStore, type ReactNode } from 'react';
import { cx } from '../../../components/ui';
import { t, useLocale } from '../../../i18n';
import { F_BOLD, F_ITALIC, F_STRIKE } from '../../../lib/canvas/richText';
import type { CanvasEngine } from '../engine';
import { DIVIDER, PANEL } from './chrome';
import { FontSizeField } from './FontSizeField';
import { PhoneBtn } from './PhoneEditBar';

const ICON = 'size-[22px]';

/**
 * The format bar of the phone's edit mode (ADR-0116 wave 5b): bold, italic, strike-through, the two lists, the text size and
 * «Готово», in one row of 44 px targets pinned to the bottom of the work area — which the keyboard has shortened, so the bar
 * sits right above it (`kbd` is what is left to add when the keyboard covers more than the shortened area). The row
 * scrolls sideways when the buttons do not fit; «Готово» stays put at its end. A leaf with its own subscription to the
 * editor: nothing renders while no text is open.
 */
export const PhoneFormatBar = memo(function PhoneFormatBar({ engine }: { engine: CanvasEngine }): ReactNode {
  useLocale();
  const ed = engine.editor;
  const st = useSyncExternalStore(ed.subscribe, ed.getSnapshot);
  if (!st.open) return null;
  const flag = (label: string, key: string, on: boolean, bit: number, icon: ReactNode): ReactNode => (
    <PhoneBtn label={label} active={on} onClick={() => ed.toggleFlag(bit)} testId={`canvas-format-${key}`}>
      {icon}
    </PhoneBtn>
  );
  return (
    <div
      role="toolbar"
      aria-label={t('canvasBoard.format.bar')}
      data-testid="canvas-format-bar"
      className={cx(PANEL, 'absolute inset-x-0 z-10 flex items-center rounded-none border-x-0 border-b-0 px-1')}
      style={{ bottom: st.kbd }}
    >
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        {st.rich ? (
          <>
            {flag(t('canvasBoard.format.bold'), 'bold', st.bold, F_BOLD, <Bold className={ICON} strokeWidth={1.75} aria-hidden />)}
            {flag(t('canvasBoard.format.italic'), 'italic', st.italic, F_ITALIC, <Italic className={ICON} strokeWidth={1.75} aria-hidden />)}
            {flag(t('canvasBoard.format.strike'), 'strike', st.strike, F_STRIKE, <Strikethrough className={ICON} strokeWidth={1.75} aria-hidden />)}
            <div className={DIVIDER} aria-hidden />
            <PhoneBtn label={t('canvasBoard.format.bullet')} active={st.list === 'bullet'} onClick={() => ed.toggleList('bullet')} testId="canvas-format-bullet">
              <List className={ICON} strokeWidth={1.75} aria-hidden />
            </PhoneBtn>
            <PhoneBtn label={t('canvasBoard.format.number')} active={st.list === 'number'} onClick={() => ed.toggleList('number')} testId="canvas-format-number">
              <ListOrdered className={ICON} strokeWidth={1.75} aria-hidden />
            </PhoneBtn>
          </>
        ) : null}
        {st.rich && st.size !== null ? (
          <>
            <div className={DIVIDER} aria-hidden />
            <FontSizeField
              touch
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
      <div className={DIVIDER} aria-hidden />
      <PhoneBtn label={t('canvasPhone.textDone')} onClick={() => ed.commit()} testId="canvas-format-done">
        <Check className={ICON} strokeWidth={2} aria-hidden />
      </PhoneBtn>
    </div>
  );
});
