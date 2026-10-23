import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { CanvasItemKind } from '@calaba/protocol';
import { ArrowLeft, ChevronRight, FilePlus2, Folder, FolderOpen, FolderPlus, Plus, RotateCcw, Search, Shapes, Trash2 } from 'lucide-react';
import { memo, useCallback, useEffect, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { CreateButton } from '../../components/CreateButton';
import { Button, IconButton, Input, Spinner, cx } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { fmt } from '../../lib/format';
import { canStructure, canWrite, childKey, filterItems, TOP, trashKey, type DropZone } from '../../lib/canvas/tree';
import { createItem, deleteForever, emptyTrash, loadChildren, loadTrash, openCanvas, restoreItem, searchItems } from '../../services/canvas';
import { useCanvas } from '../../stores/canvas';
import { useCanvasUi } from '../../stores/canvasUi';
import { myUserId } from '../../stores/session';
import { menuBox, menuItem } from '../shell/menu';
import { ItemContextMenu, RenameField } from './ItemMenu';

/**
 * The tree column of «Холст» (ADR-0126 §5, docs/08): the name filter and «+» (Новый холст / Новая
 * папка) on top, folders and canvases as collapsible nodes (children loaded when a folder opens),
 * «Корзина» at the bottom; the trash replaces the tree in the same column. Rows are `memo` and read
 * their item by id; a folder subscribes to its own children's ids — an event re-renders the rows it
 * touches. Rows are dnd-kit draggables and drop targets (CanvasScreen owns the DndContext): the top
 * and bottom quarters of a folder row (halves of a canvas row) put the item before / after it, the
 * middle of a folder inside it.
 */

/** The row under a dragged item and the zone (a row reads only whether it is the one). */
export const useCanvasDrag = create<{
  overId: string | null;
  zone: DropZone | null;
  set: (overId: string | null, zone: DropZone | null) => void;
}>()((set) => ({
  overId: null,
  zone: null,
  set: (overId, zone) => set((s) => (s.overId === overId && s.zone === zone ? s : { overId, zone })),
}));

const INDENT = 14;
const EMPTY: readonly string[] = [];

export function CanvasTree({ workspaceId, canCreate }: { workspaceId: string; canCreate: boolean }): ReactNode {
  const trash = useCanvasUi((s) => !!s.trashOf[workspaceId]);
  return trash ? <TrashColumn workspaceId={workspaceId} /> : <TreeColumn workspaceId={workspaceId} canCreate={canCreate} />;
}

function TreeColumn({ workspaceId, canCreate }: { workspaceId: string; canCreate: boolean }): ReactNode {
  useLocale();
  const query = useCanvasUi((s) => s.query);
  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-line px-2.5">
        <span className="min-w-0 flex-1">
          <Input
            type="search"
            icon={<Search className="size-3.5" aria-hidden />}
            value={query}
            onChange={(e) => useCanvasUi.getState().setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.stopPropagation();
                useCanvasUi.getState().setQuery('');
              }
            }}
            placeholder={t('canvas.search')}
            aria-label={t('canvas.search')}
            className="h-8 rounded-full"
            data-testid="canvas-search"
          />
        </span>
        {canCreate ? <CreateMenu workspaceId={workspaceId} /> : null}
      </div>
      <nav className="scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto px-1.5 py-1.5" aria-label={t('canvas.tree')} data-testid="canvas-tree">
        {query.trim() ? <SearchResults workspaceId={workspaceId} query={query} /> : <ChildList workspaceId={workspaceId} parentId={TOP} depth={0} />}
      </nav>
      <div className="shrink-0 border-t border-line p-1.5">
        <button
          type="button"
          onClick={() => useCanvasUi.getState().openTrash(workspaceId, true)}
          className="flex h-8 w-full items-center gap-2 rounded-[var(--radius-row)] px-2 text-body text-muted hover:bg-hover hover:text-fg"
          data-testid="canvas-open-trash"
        >
          <Trash2 className="size-4" strokeWidth={1.75} aria-hidden />
          {t('canvas.trash')}
        </button>
      </div>
    </>
  );
}

/** The column's «+»: «Новый холст» / «Новая папка» at the top level. */
function CreateMenu({ workspaceId }: { workspaceId: string }): ReactNode {
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>
        <CreateButton label={t('canvas.create')} data-testid="canvas-create" />
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className={menuBox} sideOffset={4} align="end" collisionPadding={16} onCloseAutoFocus={(e) => e.preventDefault()} data-testid="canvas-create-menu">
          <Dropdown.Item className={menuItem} onSelect={() => void createItem(workspaceId, TOP, CanvasItemKind.CANVAS)} data-testid="canvas-new-canvas">
            <FilePlus2 className="size-4" strokeWidth={1.75} aria-hidden />
            {t('canvas.newCanvas')}
          </Dropdown.Item>
          <Dropdown.Item className={menuItem} onSelect={() => void createItem(workspaceId, TOP, CanvasItemKind.FOLDER)} data-testid="canvas-new-folder">
            <FolderPlus className="size-4" strokeWidth={1.75} aria-hidden />
            {t('canvas.newFolder')}
          </Dropdown.Item>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/** The children of a folder (or the top level), loaded when first shown. */
const ChildList = memo(function ChildList({ workspaceId, parentId, depth }: { workspaceId: string; parentId: string; depth: number }): ReactNode {
  const key = childKey(workspaceId, parentId);
  const ids = useCanvas(useShallow((s) => s.lists[key] ?? EMPTY));
  const loaded = useCanvas((s) => !!s.lists[key]);
  const failed = useCanvas((s) => s.load[key] === 'error');
  useEffect(() => {
    if (!loaded) void loadChildren(workspaceId, parentId);
  }, [loaded, workspaceId, parentId]);
  if (!loaded) {
    return failed ? null : (
      <div className="flex h-8 items-center" style={{ paddingLeft: 8 + depth * INDENT }}>
        <Spinner className="size-3.5" />
      </div>
    );
  }
  if (!ids.length) {
    return depth === 0 ? (
      <p className="px-2 py-3 text-caption text-muted">{t('canvas.emptyTree')}</p>
    ) : (
      <p className="flex h-7 items-center text-caption text-faint" style={{ paddingLeft: 30 + depth * INDENT }}>
        {t('canvas.emptyFolder')}
      </p>
    );
  }
  return (
    <ul className="flex flex-col">
      {ids.map((id) => (
        <TreeNode key={id} workspaceId={workspaceId} id={id} depth={depth} />
      ))}
    </ul>
  );
});

/** The icon of a row: a folder (open when expanded) or a canvas. */
function ItemIcon({ folder, open }: { folder: boolean; open?: boolean }): ReactNode {
  const I = folder ? (open ? FolderOpen : Folder) : Shapes;
  return <I className="size-4 text-muted" strokeWidth={1.75} aria-hidden />;
}

const TreeNode = memo(function TreeNode({ workspaceId, id, depth }: { workspaceId: string; id: string; depth: number }): ReactNode {
  const name = useCanvas((s) => s.items[id]?.name ?? '');
  const folder = useCanvas((s) => s.items[id]?.kind === CanvasItemKind.FOLDER);
  const hasChildren = useCanvas((s) => !!s.items[id]?.hasChildren || (s.lists[childKey(workspaceId, id)]?.length ?? 0) > 0);
  const writable = useCanvas((s) => canWrite(s.items[id]?.myBits ?? 0n));
  const movable = useCanvas((s) => {
    const i = s.items[id];
    return !!i && canStructure(i, myUserId());
  });
  const expanded = useCanvasUi((s) => !!s.expanded[id]);
  const renaming = useCanvasUi((s) => s.renaming === id);
  const active = useCanvasUi((s) => s.itemOf[workspaceId] === id);
  const zone = useCanvasDrag((s) => (s.overId === id ? s.zone : null));
  const drag = useDraggable({ id, disabled: !movable });
  const drop = useDroppable({ id: `canvas:${id}`, data: { itemId: id, folder } });
  const ref = useCallback(
    (el: HTMLElement | null) => {
      drag.setNodeRef(el);
      drop.setNodeRef(el);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dnd-kit's setters are stable
    [],
  );
  const toggle = (): void => useCanvasUi.getState().setExpanded(id, !expanded);
  const openRow = (): void => (folder ? toggle() : openCanvas(workspaceId, id));
  return (
    <li className="flex flex-col">
      {/* The row is a drag handle and a drop target; a canvas opens (a folder expands) from its name button (no nested controls). A right click / long press opens the item menu. */}
      <ItemContextMenu itemId={id}>
        <div
          ref={ref}
          {...drag.listeners}
          className={cx(
            'group relative flex h-8 items-center gap-1 rounded-[var(--radius-row)] pr-1 text-body',
            active ? 'bg-active text-fg' : 'text-fg hover:bg-hover',
            drag.isDragging && 'opacity-40',
            zone === 'inside' && 'bg-hover ring-2 ring-inset ring-accent',
          )}
          style={{ paddingLeft: 4 + depth * INDENT }}
          data-testid="canvas-node"
          data-kind={folder ? 'folder' : 'canvas'}
          data-active={active || undefined}
        >
          {zone === 'before' || zone === 'after' ? (
            <span className={cx('pointer-events-none absolute right-1 h-0.5 rounded-full bg-accent', zone === 'before' ? '-top-px' : '-bottom-px')} style={{ left: 4 + depth * INDENT }} aria-hidden />
          ) : null}
          <button
            type="button"
            tabIndex={folder && hasChildren ? 0 : -1}
            aria-expanded={folder && hasChildren ? expanded : undefined}
            onClick={toggle}
            onPointerDown={(e) => e.stopPropagation()}
            className={cx('grid size-5 shrink-0 place-items-center rounded-[4px] text-faint hover:bg-active hover:text-fg', !(folder && hasChildren) && 'invisible')}
            aria-label={expanded ? t('canvas.collapse') : t('canvas.expand')}
            data-testid="canvas-node-toggle"
          >
            <ChevronRight className={cx('size-3.5 transition-transform duration-[var(--motion-fast)]', expanded && 'rotate-90')} aria-hidden />
          </button>
          {renaming ? (
            <>
              <span className="grid size-5 shrink-0 place-items-center" aria-hidden>
                <ItemIcon folder={folder} open={expanded} />
              </span>
              <RenameField itemId={id} className="h-6 flex-1" />
            </>
          ) : (
            <button
              type="button"
              onClick={openRow}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight' && folder && !expanded) toggle();
                else if (e.key === 'ArrowLeft' && folder && expanded) toggle();
              }}
              aria-current={active ? 'page' : undefined}
              className="flex h-full min-w-0 flex-1 items-center gap-1 rounded-[var(--radius-row)] text-left outline-none focus-visible:ring-2 focus-visible:ring-accent"
              data-testid="canvas-node-open"
            >
              <span className="grid size-5 shrink-0 place-items-center" aria-hidden>
                <ItemIcon folder={folder} open={expanded} />
              </span>
              <span className={cx('min-w-0 flex-1 truncate', !name && 'text-muted')}>{name || t('canvas.untitled')}</span>
            </button>
          )}
          {folder && writable && !renaming ? (
            <IconButton
              size="sm"
              tip={false}
              label={t('canvas.addInside')}
              className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => void createItem(workspaceId, id, CanvasItemKind.CANVAS)}
              data-testid="canvas-node-add"
            >
              <Plus className="size-3.5" aria-hidden />
            </IconButton>
          ) : null}
        </div>
      </ItemContextMenu>
      {folder && expanded ? <ChildList workspaceId={workspaceId} parentId={id} depth={depth + 1} /> : null}
    </li>
  );
});

/** The drag chip under the pointer. */
export function DragChip({ id }: { id: string }): ReactNode {
  const name = useCanvas((s) => s.items[id]?.name ?? '');
  const folder = useCanvas((s) => s.items[id]?.kind === CanvasItemKind.FOLDER);
  return (
    <div className="mat-popover flex h-8 max-w-64 items-center gap-2 rounded-[var(--radius-row)] px-2.5 text-body shadow-[var(--shadow-popover)]">
      <ItemIcon folder={folder} />
      <span className="truncate">{name || t('canvas.untitled')}</span>
    </div>
  );
}

// ---------------------------------------------------------------- search

interface Hit {
  id: string;
  name: string;
  folder: boolean;
}

/** The filter: loaded items whose name matches, then the server's hits (name and text) not shown yet. */
function SearchResults({ workspaceId, query }: { workspaceId: string; query: string }): ReactNode {
  const local = useCanvas(useShallow((s) => filterItems(s.items, workspaceId, query)));
  const [remote, setRemote] = useState<Hit[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const q = query.trim();
  useEffect(() => {
    if (q.length < 2) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      setBusy(true);
      searchItems(workspaceId, q, ctl.signal).then(
        (r) => {
          setRemote(r);
          setFailed(false);
          setBusy(false);
        },
        () => {
          // Not «nothing found»: the server's part is missing, said under the local matches.
          if (!ctl.signal.aborted) setFailed(true);
          setBusy(false);
        },
      );
    }, 250);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [workspaceId, q]);
  const shown = new Set(local);
  const extra = q.length < 2 ? [] : remote.filter((r) => !r.folder && !shown.has(r.id));
  return (
    <div className="flex flex-col" data-testid="canvas-search-results">
      {local.map((id) => (
        <ResultRow key={id} workspaceId={workspaceId} id={id} />
      ))}
      {extra.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={() => openCanvas(workspaceId, r.id)}
          className="flex h-8 items-center gap-2 rounded-[var(--radius-row)] px-2 text-left text-body hover:bg-hover"
          data-testid="canvas-search-hit"
        >
          <span className="grid size-5 shrink-0 place-items-center" aria-hidden>
            <ItemIcon folder={false} />
          </span>
          <span className="min-w-0 flex-1 truncate">{r.name || t('canvas.untitled')}</span>
        </button>
      ))}
      {busy ? (
        <div className="flex h-8 items-center px-2">
          <Spinner className="size-3.5" />
        </div>
      ) : !local.length && !extra.length ? (
        <p className="px-2 py-3 text-caption text-muted">{t(failed ? 'canvas.searchFailed' : 'canvas.searchEmpty')}</p>
      ) : failed && q.length >= 2 ? (
        <p className="px-2 py-3 text-caption text-muted">{t('canvas.searchFailed')}</p>
      ) : null}
    </div>
  );
}

const ResultRow = memo(function ResultRow({ workspaceId, id }: { workspaceId: string; id: string }): ReactNode {
  const name = useCanvas((s) => s.items[id]?.name ?? '');
  const folder = useCanvas((s) => s.items[id]?.kind === CanvasItemKind.FOLDER);
  const active = useCanvasUi((s) => s.itemOf[workspaceId] === id);
  return (
    <button
      type="button"
      onClick={() => {
        if (folder) {
          // A folder hit: leave the filter and show the folder open in the tree.
          useCanvasUi.getState().setQuery('');
          useCanvasUi.getState().setExpanded(id, true);
        } else openCanvas(workspaceId, id);
      }}
      className={cx('flex h-8 items-center gap-2 rounded-[var(--radius-row)] px-2 text-left text-body', active ? 'bg-active' : 'hover:bg-hover')}
      data-testid="canvas-search-row"
    >
      <span className="grid size-5 shrink-0 place-items-center" aria-hidden>
        <ItemIcon folder={folder} />
      </span>
      <span className="min-w-0 flex-1 truncate">{name || t('canvas.untitled')}</span>
    </button>
  );
});

// ---------------------------------------------------------------- trash

function TrashColumn({ workspaceId }: { workspaceId: string }): ReactNode {
  useLocale();
  const key = trashKey(workspaceId);
  const ids = useCanvas(useShallow((s) => s.lists[key] ?? EMPTY));
  const loaded = useCanvas((s) => !!s.lists[key]);
  useEffect(() => {
    void loadTrash(workspaceId);
  }, [workspaceId]);
  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-2">
        <IconButton label={t('canvas.backToCanvas')} onClick={() => useCanvasUi.getState().openTrash(workspaceId, false)} data-testid="canvas-trash-back">
          <ArrowLeft className="size-4" aria-hidden />
        </IconButton>
        <h2 className="min-w-0 flex-1 truncate text-headline font-semibold">{t('canvas.trash')}</h2>
        {ids.length ? (
          <Button variant="secondary" size="sm" onClick={() => void emptyTrash(workspaceId)} data-testid="canvas-empty-trash">
            {t('canvas.emptyTrashShort')}
          </Button>
        ) : null}
      </div>
      <div className="scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto p-1.5" data-testid="canvas-trash">
        {!loaded ? (
          <div className="grid h-12 place-items-center">
            <Spinner />
          </div>
        ) : ids.length ? (
          ids.map((id) => <TrashRow key={id} workspaceId={workspaceId} id={id} />)
        ) : (
          <p className="px-2 py-3 text-caption text-muted">{t('canvas.trashEmpty')}</p>
        )}
      </div>
    </>
  );
}

const TrashRow = memo(function TrashRow({ workspaceId, id }: { workspaceId: string; id: string }): ReactNode {
  const name = useCanvas((s) => s.items[id]?.name ?? '');
  const folder = useCanvas((s) => s.items[id]?.kind === CanvasItemKind.FOLDER);
  const trashedMs = useCanvas((s) => {
    const at = s.items[id]?.trashedAt;
    return at ? timestampDate(at).getTime() : 0;
  });
  const mine = useCanvas((s) => {
    const i = s.items[id];
    return !!i && canStructure(i, myUserId());
  });
  const exists = useCanvas((s) => !!s.items[id]);
  const active = useCanvasUi((s) => s.itemOf[workspaceId] === id);
  if (!exists) return null;
  return (
    <ItemContextMenu itemId={id}>
      <div className={cx('group flex h-11 items-center gap-1 rounded-[var(--radius-row)] pr-1', active ? 'bg-active' : 'hover:bg-hover')} data-testid="canvas-trash-row">
        <button
          type="button"
          onClick={() => {
            // A trashed canvas opens in the centre (its restore banner); a folder has nothing to show.
            if (!folder) useCanvasUi.getState().openItem(workspaceId, id);
          }}
          aria-current={active ? 'page' : undefined}
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-row)] pl-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <span className="grid size-5 shrink-0 place-items-center" aria-hidden>
            <ItemIcon folder={folder} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-body">{name || t('canvas.untitled')}</span>
            {trashedMs ? <span className="truncate text-caption text-muted">{t('canvas.trashedAt', { date: fmt.listTime(new Date(trashedMs)) })}</span> : null}
          </span>
        </button>
        {mine ? (
          <span className="flex shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
            <IconButton size="sm" label={t('canvas.restore')} onClick={() => void restoreItem(id)} data-testid="canvas-trash-restore">
              <RotateCcw className="size-3.5" aria-hidden />
            </IconButton>
            <IconButton size="sm" danger label={t('canvas.deleteForever')} onClick={() => void deleteForever(id)} data-testid="canvas-trash-delete">
              <Trash2 className="size-3.5" aria-hidden />
            </IconButton>
          </span>
        ) : null}
      </div>
    </ItemContextMenu>
  );
});
