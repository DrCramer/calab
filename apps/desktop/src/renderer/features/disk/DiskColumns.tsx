import type { DiskItem } from '@calaba/protocol';
import { ChevronRight, SearchX } from 'lucide-react';
import { memo, useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button, Spinner, cx } from '../../components/ui';
import { t } from '../../i18n';
import { canWrite, columnFolders, columnsNav, folderKey, isFolder, visibleIds } from '../../lib/disk';
import { collator, loadListing, openItem } from '../../services/disk';
import { useDisk } from '../../stores/disk';
import { folderOf, useDiskUi } from '../../stores/diskUi';
import { usePrefs } from '../../stores/prefs';
import { FileCardPanel } from './FileCard';
import { RenameField, useItemDnd } from './DiskItems';
import { ItemContextMenu } from './ItemMenu';
import { useQuickLook } from './useQuickLook';
import { ItemBadges, ItemGlyph } from './visuals';

/**
 * The «Колонки» view of the Disk (CBF-21, ADR-0094 «Дополнение CBF-21», docs/08 «Диск»): the open
 * folder's path is the strip of columns — the root, each ancestor, the open folder — 240 px each,
 * the strip scrolls sideways; a selected file adds a preview column with the file card. The path
 * IS the open folder (`diskUi.folderOf`, crumbs and the search stay as they are): selecting a
 * folder opens it, which makes its listing the last column and drops the deeper ones. The search
 * filters the last column only. Re-renders: a column reads its shown ids (useShallow), a row its
 * item and «selected» / «renaming» as primitives; the strip reads the path ids and the selected
 * id, so a click re-renders the strip (a few memo columns) and two rows.
 */

/** Selects an item the way a click does: a folder opens (its listing is the last column), a file in an earlier column closes the deeper ones. */
function selectItem(id: string): void {
  const ui = useDiskUi.getState();
  const it = useDisk.getState().items[id];
  if (!it) return;
  if (isFolder(it)) ui.openFolder(it.workspaceId, it.id);
  else if (it.parentId !== folderOf(ui, it.workspaceId)) ui.openFolder(it.workspaceId, it.parentId);
  useDiskUi.getState().select(id);
}

/** Enter / double click: a folder selects its first row (→), a file opens as in the other views. */
function enterItem(id: string): void {
  const disk = useDisk.getState();
  const it = disk.items[id];
  if (!it || it.trashedAt) return;
  if (!isFolder(it)) {
    openItem(it);
    return;
  }
  selectItem(id);
  const first = visibleIds(disk.lists[folderKey(it.workspaceId, it.id)], disk.items, usePrefs.getState().diskSort, '', collator())[0];
  if (first) useDiskUi.getState().select(first);
}

export function DiskColumns({ workspaceId, folderId }: { workspaceId: string; folderId: string }): ReactNode {
  const pathIds = useDisk(useShallow((s) => columnFolders(folderId, s.paths[folderId])));
  const selected = useDiskUi((s) => s.selected);
  // The preview: the selected file of the last column.
  const previewId = useDisk((s) => {
    const it = selected ? s.items[selected] : undefined;
    return it && !isFolder(it) && !it.trashedAt && it.parentId === folderId ? it.id : null;
  });
  const strip = useRef<HTMLDivElement>(null);
  // Quick Look (CBF-22): Space previews the selected file; ←/→ in the viewer step through the active (last) column.
  const sort = usePrefs((s) => s.diskSort);
  const query = useDiskUi((s) => s.query);
  const shownIds = useDisk(useShallow((s) => visibleIds(s.lists[folderKey(workspaceId, folderId)], s.items, sort, query, collator())));
  const shown = useRef<readonly string[]>(shownIds);
  useEffect(() => {
    shown.current = shownIds;
  }, [shownIds]);
  useQuickLook(shown);
  const wantFocus = useRef<string | null>(null);

  // The newest column comes into view (instant: no animation).
  const count = pathIds.length + (previewId ? 1 : 0);
  useEffect(() => {
    strip.current?.scrollTo({ left: strip.current.scrollWidth, behavior: 'instant' });
  }, [count]);

  // Arrow keys move the cursor; the row it lands on takes the focus.
  useEffect(() => {
    if (!selected || wantFocus.current !== selected) return;
    const el = strip.current?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(selected)}"]`);
    if (el) {
      el.focus({ preventScroll: true });
      wantFocus.current = null;
    }
  }, [selected, pathIds]);

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const ui = useDiskUi.getState();
    if (ui.renaming) return;
    const disk = useDisk.getState();
    const sort = usePrefs.getState().diskSort;
    const folders = columnFolders(folderId, disk.paths[folderId]);
    const cols = folders.map((f, i) => ({ folder: f, ids: visibleIds(disk.lists[folderKey(workspaceId, f)], disk.items, sort, i === folders.length - 1 ? ui.query : '', collator()) }));
    const next = columnsNav(cols, ui.selected, e.key);
    e.preventDefault();
    if (!next) return;
    wantFocus.current = next;
    selectItem(next);
  };

  return (
    <div
      ref={strip}
      tabIndex={0}
      className="flex min-h-0 flex-1 overflow-x-auto outline-none"
      onClick={(e) => {
        e.stopPropagation();
        useDiskUi.getState().select(null);
      }}
      onKeyDown={onKeyDown}
      data-testid="disk-columns"
    >
      {pathIds.map((f, i) => (
        <Column key={f || 'root'} workspaceId={workspaceId} folderId={f} openChild={pathIds[i + 1] ?? ''} last={i === pathIds.length - 1} />
      ))}
      {previewId ? (
        <div className="w-80 shrink-0 overflow-y-auto border-l border-line p-4" onClick={(e) => e.stopPropagation()} data-testid="disk-col-preview">
          <FileCardPanel itemId={previewId} />
        </div>
      ) : null}
    </div>
  );
}

const Column = memo(function Column({ workspaceId, folderId, openChild, last }: { workspaceId: string; folderId: string; openChild: string; last: boolean }): ReactNode {
  const key = folderKey(workspaceId, folderId);
  const sort = usePrefs((s) => s.diskSort);
  const query = useDiskUi((s) => (last ? s.query : ''));
  const ids = useDisk(useShallow((s) => visibleIds(s.lists[key], s.items, sort, query, collator())));
  const loaded = useDisk((s) => !!s.lists[key]);
  const failed = useDisk((s) => s.load[key] === 'error');
  // The open folder's listing is loaded by the screen; the ancestors' here.
  useEffect(() => {
    if (!last && !useDisk.getState().lists[key]) void loadListing(workspaceId, folderId, false);
  }, [last, key, workspaceId, folderId]);
  return (
    <div className="flex w-60 shrink-0 flex-col gap-px overflow-y-auto border-r border-line p-1.5" role="list" aria-label={folderId ? undefined : t('disk.section')} data-testid="disk-column">
      {!loaded ? (
        failed ? (
          <div className="flex flex-col items-center gap-2 px-3 py-8 text-center text-body text-muted">
            <p>{t('disk.err.load')}</p>
            <Button variant="secondary" onClick={() => void loadListing(workspaceId, folderId, false)}>
              {t('common.retry')}
            </Button>
          </div>
        ) : (
          <div className="grid place-items-center py-8">
            <Spinner />
          </div>
        )
      ) : ids.length ? (
        ids.map((id) => <ColRow key={id} id={id} open={id === openChild} />)
      ) : (
        <div className="flex flex-col items-center gap-2 px-3 py-8 text-center text-body text-muted">
          {query.trim() ? <SearchX className="size-8" strokeWidth={1.25} aria-hidden /> : null}
          <p>{query.trim() ? t('disk.empty.search') : t('disk.empty.folder')}</p>
        </div>
      )}
    </div>
  );
});

const ColRow = memo(function ColRow({ id, open }: { id: string; open: boolean }): ReactNode {
  const item: DiskItem | undefined = useDisk((s) => s.items[id]);
  const selected = useDiskUi((s) => s.selected === id);
  const renaming = useDiskUi((s) => s.renaming === id);
  const { setRef, listeners, isDragging, over, fileHandlers } = useItemDnd(item, renaming, selected);
  if (!item) return null;
  const folder = isFolder(item);
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      enterItem(id);
    } else if (e.key === 'F2' && canWrite(item.myBits) && !item.trashedAt) useDiskUi.getState().setRenaming(id);
  };
  return (
    <ItemContextMenu id={id}>
      <div
        ref={setRef}
        role="listitem"
        tabIndex={selected ? 0 : -1}
        data-item-id={id}
        data-selected={selected || undefined}
        {...listeners}
        {...fileHandlers}
        onClick={(e) => {
          e.stopPropagation();
          selectItem(id);
        }}
        onDoubleClick={() => enterItem(id)}
        onKeyDown={onKeyDown}
        className={cx(
          'flex h-9 shrink-0 cursor-default items-center gap-2 rounded-[var(--radius-row)] px-2 text-body outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-focus)]',
          selected ? 'bg-active' : open ? 'bg-hover' : 'hover:bg-hover',
          over && 'bg-hover ring-2 ring-inset ring-accent',
          isDragging && 'opacity-40',
        )}
        data-testid="disk-col-row"
        data-kind={folder ? 'folder' : 'file'}
      >
        <ItemGlyph item={item} className="size-5 shrink-0" />
        {renaming ? (
          <RenameField item={item} className="h-6 flex-1" />
        ) : (
          <span className="min-w-0 flex-1 truncate" title={item.name}>
            {item.name}
          </span>
        )}
        <ItemBadges item={item} />
        {folder ? <ChevronRight className="size-3.5 shrink-0 text-faint" aria-hidden /> : null}
      </div>
    </ItemContextMenu>
  );
});
