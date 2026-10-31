import * as Dropdown from '../../components/radix/dropdown-menu';
import { Bookmark, Ellipsis, Pencil, Trash2 } from 'lucide-react';
import { memo, useEffect, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { confirmAction, promptAction } from '../../components/Confirm';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { loadSavedSearches, openSavedSearch, removeSavedSearch, updateSavedSearch } from '../../services/taskSearch';
import { MY_TASKS, useBoardsUi } from '../../stores/boardsUi';
import { useTaskSearch } from '../../stores/taskSearch';
import { ROW_HOVER } from '../shell/ColumnHeader';
import { menuBox, menuItem } from '../shell/menu';

/**
 * Saved task searches in the boards column, right under «Мои задачи» (ADR-0139): one row each,
 * a click opens the results page with its conditions; «…» renames / deletes. Nothing is shown
 * while there are none.
 */
export function SavedSearchRows({ workspaceId }: { workspaceId: string }): ReactNode {
  useEffect(() => loadSavedSearches(workspaceId), [workspaceId]);
  const ids = useTaskSearch(useShallow((s) => (s.saved[workspaceId] ?? NONE).map((x) => x.id)));
  if (!ids.length) return null;
  return (
    <div className="flex flex-col gap-px pt-px" data-testid="saved-searches">
      {ids.map((id) => (
        <SavedRow key={id} id={id} workspaceId={workspaceId} />
      ))}
    </div>
  );
}

const NONE: never[] = [];

const SavedRow = memo(function SavedRow({ id, workspaceId }: { id: string; workspaceId: string }): ReactNode {
  const name = useTaskSearch((s) => s.saved[workspaceId]?.find((x) => x.id === id)?.name ?? '');
  const chosen = useTaskSearch((s) => s.activeSaved[workspaceId] === id);
  const onMine = useBoardsUi((s) => s.boardOf[workspaceId] === MY_TASKS);
  const active = chosen && onMine;
  const open = (): void => {
    const s = useTaskSearch.getState().saved[workspaceId]?.find((x) => x.id === id);
    if (s) openSavedSearch(workspaceId, s);
  };
  const rename = async (): Promise<void> => {
    const v = await promptAction(t('ts.rename'), '', t('ts.rename'), { label: t('ts.saveName'), placeholder: name, maxLength: 60 }, 'primary');
    if (v) void updateSavedSearch(workspaceId, id, { name: v });
  };
  const remove = async (): Promise<void> => {
    if (await confirmAction(t('ts.deleteConfirm', { name }), t('ts.deleteText'), t('ts.delete'))) void removeSavedSearch(workspaceId, id);
  };
  return (
    <div className={cx('group/saved flex h-9 items-center rounded-[var(--radius-card)] pr-1 mobile:h-14', active ? 'bg-active' : ROW_HOVER)} data-testid="saved-search">
      <button
        type="button"
        onClick={open}
        aria-current={active ? 'page' : undefined}
        className={cx('flex h-full min-w-0 flex-1 items-center gap-2 px-2 text-left text-list mobile:gap-3 mobile:px-3', active ? 'font-medium text-fg' : 'text-muted hover:text-fg')}
      >
        <span className="grid shrink-0 place-items-center mobile:size-10 mobile:rounded-full mobile:bg-[var(--color-fill)]">
          <Bookmark className="size-[18px] shrink-0 mobile:size-5" aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate">{name}</span>
      </button>
      <Dropdown.Root modal={false}>
        <Dropdown.Trigger asChild>
          <button
            type="button"
            aria-label={t('ts.savedTitle')}
            className="grid size-6 shrink-0 place-items-center rounded-[var(--radius-icon)] text-muted opacity-0 hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover/saved:opacity-100 data-[state=open]:opacity-100 mobile:size-11 mobile:opacity-100"
            data-testid="saved-search-menu"
          >
            <Ellipsis className="size-4" aria-hidden />
          </button>
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content className={cx(menuBox, 'min-w-48')} sideOffset={4} align="start" collisionPadding={16}>
            <Dropdown.Item className={menuItem} onSelect={() => void rename()}>
              <Pencil className="size-4" aria-hidden /> {t('ts.rename')}
            </Dropdown.Item>
            <Dropdown.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => void remove()}>
              <Trash2 className="size-4" aria-hidden /> {t('ts.delete')}
            </Dropdown.Item>
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
    </div>
  );
});
