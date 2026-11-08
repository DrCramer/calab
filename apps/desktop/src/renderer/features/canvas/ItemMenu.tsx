import * as ContextMenu from '@radix-ui/react-context-menu';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { CanvasItemKind } from '@calaba/protocol';
import { Ellipsis, FilePlus2, FileImage, FolderInput, FolderPlus, History, Link2, Pencil, RotateCcw, Send, Shapes, Smile, Trash2, Users, X } from 'lucide-react';
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { canStructure, canWrite, isFolder } from '../../lib/canvas/tree';
import { createItem, deleteForever, openCanvas, renameItem, restoreItem, setItemEmoji, trashItem } from '../../services/canvas';
import { canvasUrl } from '../../services/links';
import { toast } from '../../stores/toasts';
import { myUserId } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { useCanvas } from '../../stores/canvas';
import { useCanvasUi } from '../../stores/canvasUi';
import { EmojiPicker } from '../chat/EmojiPicker';
import { menuBox, menuItem, menuLabel, menuSeparator } from '../shell/menu';
// Not from './view': that barrel pulls the engine into the main chunk.
import { getCanvasViewHandle } from './view/handle';

/**
 * The item's menu (ADR-0126 §5): ONE list of entries on a right click / long press of a tree row
 * and on the «⋯» of the canvas header. Open, Rename (inline in the row), New canvas / New folder
 * (folders), Move…, Access…, Version history (canvases), To the trash; in the trash — Restore and
 * Delete forever. Entries follow the item's bits: adding needs WRITE, the structure (rename, move,
 * access, trash, restore) `canStructure` (= canvasStructureAllowed). The body mounts only while the
 * menu is open.
 */
interface Parts {
  Item: ComponentType<{ className?: string; onSelect?: (e: Event) => void; children?: ReactNode; 'data-testid'?: string }>;
  Separator: ComponentType<{ className?: string }>;
  Label: ComponentType<{ className?: string; children?: ReactNode }>;
}
export const CTX: Parts = { Item: ContextMenu.Item, Separator: ContextMenu.Separator, Label: ContextMenu.Label };
export const DROP: Parts = { Item: Dropdown.Item, Separator: Dropdown.Separator, Label: Dropdown.Label };

export function ItemMenuEntries({
  itemId,
  parts,
  onRename,
  afterTrash,
  hideOpen = false,
  withExport = false,
}: {
  itemId: string;
  parts: Parts;
  /** Rename in place: a row turns into a field (`useCanvasUi.setRenaming`). */
  onRename: () => void;
  afterTrash?: () => void;
  /** The canvas header's menu: the canvas is open already. */
  hideOpen?: boolean;
  /** The canvas header's menu: «Экспорт PNG» (only while the open canvas' view is mounted). */
  withExport?: boolean;
}): ReactNode {
  const item = useCanvas((s) => s.items[itemId]);
  if (!item) return null;
  const { Item, Separator, Label } = parts;
  const ui = useCanvasUi.getState();
  const trashed = !!item.trashedAt;
  const folder = isFolder(item);
  const write = canWrite(item.myBits);
  const structure = canStructure(item, myUserId());
  const ws = item.workspaceId;
  const link = !folder && !trashed ? canvasUrl(itemId) : null;
  const exportHandle = withExport && !folder && !trashed ? getCanvasViewHandle(itemId) : null;
  const ic = (I: typeof FolderInput): ReactNode => <I className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />;
  const row = (icon: ReactNode, label: string, run: () => void, testId: string, danger = false, extra?: string): ReactNode => (
    <Item className={cx(menuItem, danger && 'text-danger-text', extra)} onSelect={run} data-testid={testId}>
      {icon}
      {label}
    </Item>
  );
  return (
    <>
      {/* The phone's card names its item (the card covers the row): one line, ellipsis. */}
      <Label className={cx(menuLabel, 'hidden truncate mobile:block')} data-testid="canvas-menu-title">
        {item.name || t('canvas.untitled')}
      </Label>
      <Separator className={cx(menuSeparator, 'hidden mobile:block')} />
      {!folder && !hideOpen ? row(ic(Shapes), t('canvas.open'), () => openCanvas(ws, itemId), 'canvas-menu-open') : null}
      {folder && write && !trashed ? row(ic(FilePlus2), t('canvas.newCanvas'), () => void createItem(ws, itemId, CanvasItemKind.CANVAS), 'canvas-menu-new-canvas') : null}
      {folder && write && !trashed ? row(ic(FolderPlus), t('canvas.newFolder'), () => void createItem(ws, itemId, CanvasItemKind.FOLDER), 'canvas-menu-new-folder') : null}
      {structure && !trashed ? row(ic(Pencil), t('canvas.rename'), onRename, 'canvas-menu-rename') : null}
      {/* The picker opens at the tree row / the header title once the menu is gone (a phone has neither: not offered there). */}
      {structure && !trashed
        ? row(ic(Smile), t('canvas.emoji'), () => setTimeout(() => ui.setEmojiFor({ id: itemId, at: hideOpen ? 'header' : 'tree' }), 0), 'canvas-menu-emoji', false, 'mobile:hidden')
        : null}
      {structure && !trashed && item.emoji ? row(ic(X), t('canvas.emojiClear'), () => void setItemEmoji(itemId, ''), 'canvas-menu-emoji-clear') : null}
      {structure && !trashed ? row(ic(FolderInput), t('canvas.move'), () => ui.openDialog({ kind: 'move', itemId }), 'canvas-menu-move') : null}
      {structure && !trashed ? row(ic(Users), t('canvas.access'), () => ui.openDialog({ kind: 'share', itemId }), 'canvas-menu-access') : null}
      {!folder && !trashed ? row(ic(Send), t('canvas.sendToChat'), () => useUi.getState().openDialog({ kind: 'canvas-send', itemId }), 'canvas-menu-send') : null}
      {link ? row(ic(Link2), t('canvas.copyLink'), () => copyLink(link), 'canvas-menu-copy-link') : null}
      {!folder && !trashed ? row(ic(History), t('canvas.versions'), () => ui.openDialog({ kind: 'versions', itemId }), 'canvas-menu-versions') : null}
      {exportHandle ? row(ic(FileImage), t('canvas.exportPng'), () => void exportHandle.exportPng({ area: 'all', name: item.name }), 'canvas-menu-export') : null}
      {exportHandle ? row(ic(FileImage), t('canvas.exportPngVisible'), () => void exportHandle.exportPng({ area: 'visible', name: item.name }), 'canvas-menu-export-visible') : null}
      {structure ? <Separator className={menuSeparator} /> : null}
      {structure && !trashed
        ? row(
            ic(Trash2),
            t('canvas.toTrash'),
            () => {
              void trashItem(itemId).then((ok) => {
                if (ok) afterTrash?.();
              });
            },
            'canvas-menu-trash',
            true,
          )
        : null}
      {structure && trashed ? row(ic(RotateCcw), t('canvas.restore'), () => void restoreItem(itemId), 'canvas-menu-restore') : null}
      {structure && trashed ? row(ic(Trash2), t('canvas.deleteForever'), () => void deleteForever(itemId), 'canvas-menu-delete', true) : null}
    </>
  );
}

/** Wraps the item's icon at `at`: while «Иконка» is on for it there, the emoji picker opens on it. */
export function ItemEmojiPicker({ id, at, children }: { id: string; at: 'tree' | 'header'; children: ReactNode }): ReactNode {
  const on = useCanvasUi((s) => s.emojiFor?.id === id && s.emojiFor.at === at);
  if (!on) return children;
  return (
    <EmojiPicker
      label={t('canvas.emoji')}
      defaultOpen
      closeOnPick
      onOpenChange={(open) => {
        if (!open) useCanvasUi.getState().setEmojiFor(null);
      }}
      onPick={(e) => void setItemEmoji(id, e)}
    >
      {children}
    </EmojiPicker>
  );
}

/** «Копировать ссылку»: the in-app address `/canvas/<id>` (opens for whoever may view it, as a board's link). */
function copyLink(link: string): void {
  navigator.clipboard.writeText(link).then(
    () => toast.success(t('canvas.linkCopied')),
    (e: unknown) => toast.fail(e),
  );
}

/** The «⋯» of a tree row (shown on hover / focus / while open, as on a board row): the same entries as the right click. */
export function ItemRowMenu({ itemId }: { itemId: string }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <Dropdown.Root modal={false} open={open} onOpenChange={setOpen}>
      <Dropdown.Trigger asChild>
        <button
          type="button"
          aria-label={t('canvas.moreMenu')}
          onPointerDown={(e) => e.stopPropagation()}
          className="grid size-6 shrink-0 place-items-center rounded-[var(--radius-icon)] text-muted opacity-0 hover:bg-active hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
          data-testid="canvas-node-menu"
        >
          <Ellipsis className="size-4" aria-hidden />
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        {open ? (
          <Dropdown.Content className={cx(menuBox, 'min-w-56')} sideOffset={4} align="start" collisionPadding={16} onCloseAutoFocus={(e) => e.preventDefault()} data-testid="canvas-item-menu">
            <ItemMenuEntries itemId={itemId} parts={DROP} onRename={() => useCanvasUi.getState().setRenaming(itemId)} />
          </Dropdown.Content>
        ) : null}
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/** Right click (desktop) / long press (phone: lib/phoneMenus.ts) on a row opens the item menu; «Переименовать» turns the row into a field. */
export function ItemContextMenu({ itemId, children }: { itemId: string; children: ReactNode }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <ContextMenu.Root modal={false} onOpenChange={setOpen}>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        {open ? (
          <ContextMenu.Content className={cx(menuBox, 'min-w-56')} onCloseAutoFocus={(e) => e.preventDefault()} data-testid="canvas-item-menu">
            <ItemMenuEntries itemId={itemId} parts={CTX} onRename={() => useCanvasUi.getState().setRenaming(itemId)} />
          </ContextMenu.Content>
        ) : null}
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** The inline rename field of a row (Enter / blur save, Escape cancels). */
export function RenameField({ itemId, className }: { itemId: string; className?: string }): ReactNode {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const prev = useCanvas((s) => s.items[itemId]?.name ?? '');
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);
  const finish = (save: boolean): void => {
    if (done.current) return;
    done.current = true;
    const v = ref.current?.value ?? '';
    useCanvasUi.getState().setRenaming(null);
    if (save) void renameItem(itemId, v, prev);
  };
  return (
    <input
      ref={ref}
      defaultValue={prev}
      maxLength={200}
      aria-label={t('canvas.rename')}
      placeholder={t('canvas.untitled')}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      }}
      onBlur={() => finish(true)}
      className={cx('min-w-0 rounded-[6px] border border-accent bg-elev px-1.5 text-body text-fg outline-none', className)}
      data-testid="canvas-rename"
    />
  );
}
