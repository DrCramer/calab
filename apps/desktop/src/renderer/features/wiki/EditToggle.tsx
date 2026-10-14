import { Check, Pencil } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { Button, IconButton } from '../../components/ui';
import { t } from '../../i18n';
import { haptics } from '../../lib/haptics';
import { nextEditing } from '../../lib/wiki/mode';
import { canWrite } from '../../lib/wiki/tree';
import { useWiki } from '../../stores/wiki';
import { useWikiUi } from '../../stores/wikiUi';

/**
 * The page header's «Редактировать» / «Готово» (owner 14.10): a page opens for reading and this
 * switches the mode (lib/wiki/mode.ts). Hidden without WRITE and in the trash. Desktop: pencil +
 * label; phone: the pencil / check icon alone (a bar icon button).
 */
export function EditToggle({ pageId, phone = false }: { pageId: string; phone?: boolean }): ReactNode {
  const can = useWiki((s) => {
    const p = s.pages[pageId];
    return !!p && !p.trashedAt && canWrite(p.myBits);
  });
  const editing = useWikiUi((s) => s.editing === pageId);
  if (!can) return null;
  const toggle = (): void => {
    if (phone) haptics.tap();
    useWikiUi.getState().setEditing(nextEditing(useWikiUi.getState().editing, { kind: 'toggle', id: pageId, canWrite: true }));
  };
  const label = editing ? t('wiki.editDone') : t('wiki.edit');
  const Icon = editing ? Check : Pencil;
  if (phone) {
    return (
      <IconButton tip={false} bar label={label} onClick={toggle} aria-pressed={editing} data-testid="wiki-edit-toggle">
        <Icon className="size-5" aria-hidden />
      </IconButton>
    );
  }
  return (
    <Button variant={editing ? 'primary' : 'secondary'} size="sm" onClick={toggle} aria-pressed={editing} data-testid="wiki-edit-toggle">
      <Icon className="size-3.5" aria-hidden />
      {label}
    </Button>
  );
}

/**
 * Mode upkeep of the open page: its edit mode ends when the page closes; on the desktop Esc leaves
 * edit mode (unless the key was handled by a menu, the slash list or a dialog).
 */
export function useEditMode(pageId: string, esc: boolean): void {
  useEffect(
    () => () => {
      const ui = useWikiUi.getState();
      ui.setEditing(nextEditing(ui.editing, { kind: 'leave', id: pageId }));
    },
    [pageId],
  );
  useEffect(() => {
    if (!esc) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const ui = useWikiUi.getState();
      if (ui.editing !== pageId || ui.dialog) return;
      if (e.target instanceof Element && e.target.closest('[role="toolbar"],[role="menu"],[role="listbox"],[role="dialog"],input')) return;
      ui.setEditing(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [pageId, esc]);
}
