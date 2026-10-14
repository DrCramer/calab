import * as ContextMenu from '@radix-ui/react-context-menu';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Download, FileText, FolderInput, History, Link2, Pencil, Plus, RotateCcw, Trash2, Users } from 'lucide-react';
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { canStructure, canWrite } from '../../lib/wiki/tree';
import { createPage, deleteForever, exportMarkdown, openWikiPage, renamePage, restorePage, trashPage } from '../../services/wiki';
import { myUserId } from '../../stores/session';
import { useWiki } from '../../stores/wiki';
import { useWikiUi } from '../../stores/wikiUi';
import { menuBox, menuItem, menuLabel, menuSeparator } from '../shell/menu';

/**
 * The page's menu (ADR-0096, owner 14.10): ONE list of entries on a right click / long press of a
 * tree row, on the «⋯» of the page header and on the phone's rows. Open, Rename (inline in the row;
 * from the page header the title field), Add subpage, Move…, Access…, Link…, Version history,
 * Export to Markdown, To the trash; in the trash — Restore and Delete forever. Entries follow the
 * page's bits: rename / subpage need WRITE, the rest of the structure (move, access, link, trash,
 * restore) `canStructure` (= wikiStructureAllowed). The body mounts only while the menu is open.
 */
interface Parts {
  Item: ComponentType<{ className?: string; onSelect?: (e: Event) => void; children?: ReactNode; 'data-testid'?: string }>;
  Separator: ComponentType<{ className?: string }>;
  Label: ComponentType<{ className?: string; children?: ReactNode }>;
}
export const CTX: Parts = { Item: ContextMenu.Item, Separator: ContextMenu.Separator, Label: ContextMenu.Label };
export const DROP: Parts = { Item: Dropdown.Item, Separator: Dropdown.Separator, Label: Dropdown.Label };

/** Focuses the open page's title field (the page header's «Переименовать»: the title is edited in place). */
export function focusTitle(): void {
  const el = document.querySelector<HTMLTextAreaElement>('[data-testid="wiki-title"]');
  el?.focus();
  el?.select();
}

export function PageMenuEntries({
  pageId,
  parts,
  onRename,
  afterTrash,
}: {
  pageId: string;
  parts: Parts;
  /** Rename in place: a row turns into a field (`useWikiUi.setRenaming`), the page header focuses its title. */
  onRename: () => void;
  afterTrash?: () => void;
}): ReactNode {
  const page = useWiki((s) => s.pages[pageId]);
  if (!page) return null;
  const { Item, Separator, Label } = parts;
  const ui = useWikiUi.getState();
  const trashed = !!page.trashedAt;
  const write = canWrite(page.myBits);
  const structure = canStructure(page, myUserId());
  const ws = page.workspaceId;
  const ic = (I: typeof Download): ReactNode => <I className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />;
  const row = (icon: ReactNode, label: string, run: () => void, testId: string, danger = false): ReactNode => (
    <Item className={cx(menuItem, danger && 'text-danger-text')} onSelect={run} data-testid={testId}>
      {icon}
      {label}
    </Item>
  );
  return (
    <>
      {/* The phone's card names its page (the card covers the row): one line, ellipsis. */}
      <Label className={cx(menuLabel, 'hidden truncate mobile:block')} data-testid="wiki-menu-title">
        {page.title || t('wiki.untitled')}
      </Label>
      <Separator className={cx(menuSeparator, 'hidden mobile:block')} />
      {row(ic(FileText), t('wiki.open'), () => openWikiPage(ws, pageId), 'wiki-menu-open')}
      {write && !trashed ? row(ic(Pencil), t('wiki.rename'), onRename, 'wiki-menu-rename') : null}
      {write && !trashed ? row(ic(Plus), t('wiki.addSubpage'), () => void createPage(ws, pageId), 'wiki-menu-add') : null}
      {structure && !trashed ? row(ic(FolderInput), t('wiki.move'), () => ui.openDialog({ kind: 'move', pageId }), 'wiki-menu-move') : null}
      {structure && !trashed ? row(ic(Users), t('wiki.access'), () => ui.openDialog({ kind: 'share', pageId, tab: 'access' }), 'wiki-menu-access') : null}
      {structure && !trashed ? row(ic(Link2), t('wiki.linkMenu'), () => ui.openDialog({ kind: 'share', pageId, tab: 'link' }), 'wiki-menu-link') : null}
      {row(ic(History), t('wiki.versions'), () => ui.openDialog({ kind: 'versions', pageId }), 'wiki-menu-versions')}
      {row(ic(Download), t('wiki.export'), () => exportMarkdown(pageId), 'wiki-menu-export')}
      {structure ? <Separator className={menuSeparator} /> : null}
      {structure && !trashed
        ? row(
            ic(Trash2),
            t('wiki.toTrash'),
            () => {
              void trashPage(pageId).then(() => {
                if (useWiki.getState().pages[pageId]?.trashedAt) afterTrash?.();
              });
            },
            'wiki-menu-trash',
            true,
          )
        : null}
      {structure && trashed ? row(ic(RotateCcw), t('wiki.restore'), () => void restorePage(pageId), 'wiki-menu-restore') : null}
      {structure && trashed ? row(ic(Trash2), t('wiki.deleteForever'), () => void deleteForever(pageId), 'wiki-menu-delete', true) : null}
    </>
  );
}

/**
 * Right click (desktop) / long press (phone: lib/phoneMenus.ts) on a row opens the page menu;
 * «Переименовать» turns the row into a field in place.
 */
export function PageContextMenu({ pageId, children }: { pageId: string; children: ReactNode }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <ContextMenu.Root modal={false} onOpenChange={setOpen}>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        {open ? (
          <ContextMenu.Content className={cx(menuBox, 'min-w-56')} onCloseAutoFocus={(e) => e.preventDefault()} data-testid="wiki-page-menu">
            <PageMenuEntries pageId={pageId} parts={CTX} onRename={() => useWikiUi.getState().setRenaming(pageId)} />
          </ContextMenu.Content>
        ) : null}
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** The inline rename field of a row (Enter / blur save, Escape cancels): same look on the tree and the phone list. */
export function RenameField({ pageId, className }: { pageId: string; className?: string }): ReactNode {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const prev = useWiki((s) => s.pages[pageId]?.title ?? '');
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
    useWikiUi.getState().setRenaming(null);
    if (save) void renamePage(pageId, v, prev);
  };
  return (
    <input
      ref={ref}
      defaultValue={prev}
      maxLength={200}
      aria-label={t('wiki.rename')}
      placeholder={t('wiki.untitled')}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      }}
      onBlur={() => finish(true)}
      className={cx('min-w-0 rounded-[6px] border border-accent bg-elev px-1.5 text-body text-fg outline-none', className)}
      data-testid="wiki-rename"
    />
  );
}
