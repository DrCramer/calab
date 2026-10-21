import * as ContextMenu from '@radix-ui/react-context-menu';
import type { ReactNode } from 'react';
import { MOD, cx } from '../../../components/ui';
import { t, useLocale } from '../../../i18n';
import type { CanvasEngine } from '../engine';
import { MENU_BOX, MENU_ITEM } from './chrome';

export type MenuMode = 'object' | 'empty';

const KBD = 'ml-auto pl-6 text-caption text-faint group-data-[highlighted]:text-accent-fg';
const ITEM = cx(MENU_ITEM, 'group');
const SEP = 'my-1 h-px bg-line';

function Item({ label, kbd, onSelect, disabled, danger, testId }: { label: string; kbd?: string; onSelect: () => void; disabled?: boolean; danger?: boolean; testId: string }): ReactNode {
  return (
    <ContextMenu.Item className={cx(ITEM, danger && 'text-danger-text')} disabled={disabled} onSelect={onSelect} data-testid={testId}>
      {label}
      {kbd ? <span className={KBD}>{kbd}</span> : null}
    </ContextMenu.Item>
  );
}

/**
 * The right-click menu. Rendered only while open (Radix mounts the content then), so it reads the
 * engine's current state at that moment instead of subscribing.
 */
export function CanvasMenu({
  engine, mode, canWrite, focusCanvas, onOpenHistory, onShare,
}: {
  engine: CanvasEngine;
  mode: MenuMode;
  canWrite: boolean;
  focusCanvas: () => void;
  onOpenHistory: () => void;
  onShare: () => void;
}): ReactNode {
  useLocale();
  const s = engine.getState();
  const editable = canWrite && !s.readOnly;
  const hasSel = s.selectionCount > 0;
  const textual = hasSel && s.selectedId !== null;
  const selected = engine.getSelected();
  const allLocked = selected.length > 0 && selected.every((o) => o.locked);
  const grouped = selected.some((o) => o.group !== undefined);
  return (
    <ContextMenu.Portal>
      <ContextMenu.Content className={MENU_BOX} onCloseAutoFocus={(e) => { e.preventDefault(); focusCanvas(); }} data-testid="canvas-menu">
        {mode === 'object' && hasSel ? (
          <>
            {editable && textual && !allLocked ? <Item label={t('canvasBoard.menu.edit')} kbd="Enter" onSelect={() => { engine.startTextEdit(); }} testId="canvas-menu-edit" /> : null}
            <Item label={t('canvasBoard.menu.copy')} kbd={`${MOD}C`} onSelect={() => void engine.copy()} testId="canvas-menu-copy" />
            {editable ? (
              <>
                {allLocked ? null : <Item label={t('canvasBoard.menu.cut')} kbd={`${MOD}X`} onSelect={() => void engine.cut()} testId="canvas-menu-cut" />}
                <Item label={t('canvasBoard.menu.paste')} kbd={`${MOD}V`} onSelect={() => void engine.paste()} testId="canvas-menu-paste" />
                <Item label={t('canvasBoard.menu.duplicate')} kbd={`${MOD}D`} onSelect={() => { engine.duplicateSelection(); }} testId="canvas-menu-duplicate" />
                <ContextMenu.Separator className={SEP} />
                {s.selectionCount > 1 && !grouped ? <Item label={t('canvasBoard.menu.group')} kbd={`${MOD}G`} onSelect={() => { engine.groupSelection(); }} testId="canvas-menu-group" /> : null}
                {grouped ? <Item label={t('canvasBoard.menu.ungroup')} kbd={`⇧${MOD}G`} onSelect={() => engine.ungroupSelection()} testId="canvas-menu-ungroup" /> : null}
                <Item label={t(allLocked ? 'canvasBoard.menu.unlock' : 'canvasBoard.menu.lock')} kbd={`⇧${MOD}L`} onSelect={() => engine.toggleLock()} testId="canvas-menu-lock" />
                <ContextMenu.Separator className={SEP} />
                <Item label={t('canvasBoard.menu.front')} kbd={`⇧${MOD}]`} onSelect={() => engine.reorder(1, true)} testId="canvas-menu-front" />
                <Item label={t('canvasBoard.menu.back')} kbd={`⇧${MOD}[`} onSelect={() => engine.reorder(-1, true)} testId="canvas-menu-back" />
                {allLocked ? null : (
                  <>
                    <ContextMenu.Separator className={SEP} />
                    <Item label={t('canvasBoard.menu.delete')} kbd="Del" danger onSelect={() => engine.deleteSelection()} testId="canvas-menu-delete" />
                  </>
                )}
              </>
            ) : null}
          </>
        ) : (
          <>
            {editable ? <Item label={t('canvasBoard.menu.paste')} kbd={`${MOD}V`} onSelect={() => void engine.paste()} testId="canvas-menu-paste" /> : null}
            <Item label={t('canvasBoard.menu.selectAll')} kbd={`${MOD}A`} onSelect={() => engine.selectAll()} testId="canvas-menu-select-all" />
            <Item label={t('canvasBoard.zoom.fitAll')} kbd="⇧1" onSelect={() => engine.fitAll()} testId="canvas-menu-fit" />
            <ContextMenu.Separator className={SEP} />
            <Item label={t('canvasBoard.menu.history')} onSelect={onOpenHistory} testId="canvas-menu-history" />
            <Item label={t('canvasBoard.menu.share')} onSelect={onShare} testId="canvas-menu-share" />
          </>
        )}
      </ContextMenu.Content>
    </ContextMenu.Portal>
  );
}
