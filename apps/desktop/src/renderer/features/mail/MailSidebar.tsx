import { Archive, BrushCleaning, ChevronRight, FileText, Folder, FolderPlus, FolderSearch, Inbox, OctagonAlert, PanelLeft, Pencil, Plus, RotateCw, Send, SendHorizontal, Star, Trash2, TriangleAlert, type LucideIcon } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { MailFolderRef, MailFolderRole } from '../../../shared/mail';
import * as ContextMenu from '../../components/radix/context-menu';
import { Button, IconButton, cx } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { boxUnread, refKey, selectBox, syncNow, useMail, type MailBox } from '../../stores/mail';
import { useMailUi } from '../../stores/mailUi';
import { ColumnHeader, ColumnTitle, GROUP_LABEL, GroupChevron, ROW_HOVER, ROW_SELECTED } from '../shell/ColumnHeader';
import { menuBox, menuItem, menuSeparator } from '../shell/menu';
import { emptyTrash } from './actions';
import { deleteFolder, deleteSmartFolder } from './folderActions';
import { canHoldFolders, folderTree, isOwnFolder } from './folderTree';
import { allLabel, folderLabel } from './format';

/**
 * The mailbox sidebar (CBF-56, Apple Mail): «Избранное» with the unified boxes when there are
 * several accounts, then every account as a foldable section with its folder tree (role folders on
 * top, own folders by name, subfolders under their parent), then «Умные папки». Right click: «Новая
 * папка…», «Переименовать…», «Удалить…» (one menu for the whole sidebar, not one per row). Rows are
 * memo'd with primitive props; a counter re-renders its own row only.
 */
export function MailSidebar(): ReactNode {
  useLocale();
  const shown = useMailUi((s) => s.sidebar);
  const accountIds = useMail((s) => s.accountIds);
  if (!shown) return null;
  return (
    <nav className="mat-sidebar mat-sidebar-window relative flex w-[clamp(224px,19vw,260px)] shrink-0 flex-col border-r border-line" aria-label={t('mbox.sidebar')} data-testid="mail-sidebar">
      <ColumnHeader title={<ColumnTitle>{t('mbox.sidebar')}</ColumnTitle>}>
        <IconButton label={t('mbox.sidebar.hide')} onClick={() => useMailUi.getState().toggleSidebar()} data-testid="mail-sidebar-hide">
          <PanelLeft className="size-4" strokeWidth={1.75} />
        </IconButton>
      </ColumnHeader>
      <SidebarMenu>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {accountIds.length > 1 ? <Favorites /> : null}
          {accountIds.map((id) => (
            <AccountSection key={id} accountId={id} />
          ))}
          <SmartSection />
        </div>
      </SidebarMenu>
      <div className="shrink-0 px-2 pb-3 pt-1">
        <Button size="sm" variant="ghost" className="w-full justify-start" onClick={() => useMailUi.getState().openAdd()} data-testid="mail-sidebar-add-account">
          <Plus className="size-3.5" aria-hidden />
          {t('mbox.addAccount')}
        </Button>
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------- groups

function GroupHeader({ id, title, children, warn }: { id: string; title: string; children?: ReactNode; warn?: string }): ReactNode {
  const collapsed = useMailUi((s) => s.collapsed.has(id));
  return (
    <div className="group/cat flex h-9 items-center gap-0.5 pr-0.5 pt-2" data-menu-kind={id.startsWith('acc:') ? 'account' : undefined} data-menu-id={id.startsWith('acc:') ? id.slice(4) : undefined}>
      <button
        type="button"
        onClick={() => useMailUi.getState().toggleCollapsed(id)}
        aria-expanded={!collapsed}
        aria-label={collapsed ? t('shell.categoryExpand', { name: title }) : t('shell.categoryCollapse', { name: title })}
        className={cx('flex h-7 min-w-0 flex-1 items-center gap-1 rounded-[var(--radius-row)] pl-2 text-left transition-colors duration-[var(--motion-fast)] hover:text-fg', GROUP_LABEL)}
        title={title}
      >
        <span className="min-w-0 truncate">{title}</span>
        {warn ? <TriangleAlert className="size-3 shrink-0 text-warn" aria-label={warn} /> : null}
        <GroupChevron collapsed={collapsed} />
      </button>
      {children}
    </div>
  );
}

function Favorites(): ReactNode {
  const collapsed = useMailUi((s) => s.collapsed.has('fav'));
  return (
    <section aria-label={t('mbox.sidebar.favorites')}>
      <GroupHeader id="fav" title={t('mbox.sidebar.favorites')} />
      {collapsed ? null : (
        <div className="flex flex-col gap-px">
          <SideRow scope="all" refStr="inbox" role="inbox" label={t('mbox.allInboxes')} />
          <SideRow scope="all" refStr="starred" role="starred" label={allLabel('starred')} />
        </div>
      )}
    </section>
  );
}

const STATE_KEY = { auth_failed: 'mbox.state.authFailed', offline: 'mbox.state.offline', error: 'mbox.state.error' } as const;

function AccountSection({ accountId }: { accountId: string }): ReactNode {
  const email = useMail((s) => s.accounts[accountId]?.email ?? '');
  const state = useMail((s) => s.accounts[accountId]?.state);
  const folders = useMail(useShallow((s) => s.folders[accountId] ?? []));
  const collapsedSet = useMailUi((s) => s.collapsed);
  const collapsed = collapsedSet.has(`acc:${accountId}`);
  const rows = useMemo(() => (collapsed ? [] : folderTree(folders, collapsedSet)), [folders, collapsedSet, collapsed]);
  const warn = state === 'auth_failed' || state === 'offline' || state === 'error' ? t(STATE_KEY[state]) : undefined;
  return (
    <section aria-label={email} data-testid="mail-sidebar-account">
      <GroupHeader id={`acc:${accountId}`} title={email} {...(warn ? { warn } : {})}>
        <IconButton
          label={t('mbox.folders.newInAccount', { email })}
          size="sm"
          className="opacity-0 group-hover/cat:opacity-100 focus-visible:opacity-100"
          onClick={() => useMailUi.getState().openFolderDialog({ kind: 'create', accountId, parentId: null, smart: false })}
          data-testid="mail-sidebar-new-folder"
        >
          <FolderPlus className="size-3.5" />
        </IconButton>
      </GroupHeader>
      {rows.length ? (
        <div className="flex flex-col gap-px">
          {rows.map(({ folder: f, depth, hasChildren }) => (
            <SideRow
              key={f.id}
              scope={accountId}
              refStr={f.role ? f.role : `id:${f.id}`}
              role={f.role}
              label={folderLabel(f)}
              depth={depth}
              folderId={f.id}
              toggleId={hasChildren ? f.id : null}
              menu={f.role === 'trash' && f.path ? 'trash' : canHoldFolders(f) || isOwnFolder(f) ? 'folder' : null}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function SmartSection(): ReactNode {
  const items = useMail(useShallow((s) => s.settings.smartFolders.map((f) => `${f.id}\n${f.accountId ?? ''}\n${f.name}`)));
  const only = useMail((s) => (s.accountIds.length === 1 ? (s.accountIds[0] ?? null) : null));
  const collapsed = useMailUi((s) => s.collapsed.has('smart'));
  return (
    <section aria-label={t('mbox.smart.group')} data-testid="mail-sidebar-smart">
      <GroupHeader id="smart" title={t('mbox.smart.group')}>
        <IconButton
          label={t('mbox.smart.titleNew')}
          size="sm"
          className="opacity-0 group-hover/cat:opacity-100 focus-visible:opacity-100"
          onClick={() => useMailUi.getState().openFolderDialog({ kind: 'create', accountId: only, parentId: null, smart: true })}
          data-testid="mail-sidebar-new-smart"
        >
          <Plus className="size-3.5" />
        </IconButton>
      </GroupHeader>
      {collapsed || !items.length ? null : (
        <div className="flex flex-col gap-px">
          {items.map((line) => {
            const [id = '', acc = '', name = ''] = line.split('\n');
            return <SideRow key={id} scope={acc || 'all'} refStr={`smart:${id}`} role={null} label={name} smartId={id} menu="smart" />;
          })}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- rows

const ROLE_ICON: Record<MailFolderRole, LucideIcon> = {
  inbox: Inbox,
  starred: Star,
  sent: Send,
  drafts: FileText,
  outbox: SendHorizontal,
  archive: Archive,
  junk: OctagonAlert,
  trash: Trash2,
};

function parseRef(refStr: string): MailFolderRef {
  if (refStr.startsWith('id:')) return { id: refStr.slice(3) };
  if (refStr.startsWith('smart:')) return { smart: refStr.slice(6) };
  return refStr as MailFolderRole;
}

interface SideRowProps {
  scope: string;
  /** The box's folder as `refKey` gives it (role, `id:…`, `smart:…`). */
  refStr: string;
  role: MailFolderRole | null;
  label: string;
  depth?: number;
  folderId?: string;
  smartId?: string;
  /** The folder id whose subtree the chevron folds (null = no subfolders). */
  toggleId?: string | null;
  menu?: 'folder' | 'trash' | 'smart' | null;
}

const SideRow = memo(function SideRow({ scope, refStr, role, label, depth = 0, folderId, smartId, toggleId = null, menu = null }: SideRowProps): ReactNode {
  const box = useMemo<MailBox>(() => ({ scope, folder: parseRef(refStr) }), [scope, refStr]);
  const current = useMail((s) => !s.query && s.box.scope === scope && refKey(s.box.folder) === refStr);
  // Drafts and the outgoing queue count their items; every other folder its unread (as the switcher).
  const count = useMail((s) => {
    if (smartId) return 0;
    const f = folderId ? s.folderById[folderId] : undefined;
    if (f && (role === 'drafts' || role === 'outbox')) return f.total;
    return f ? f.unread : boxUnread(s, box);
  });
  const folded = useMailUi((s) => (toggleId ? s.collapsed.has(toggleId) : false));
  const ref = useRef<HTMLDivElement>(null);
  // The box opened elsewhere (the switcher, a new smart folder): its row comes into view.
  useEffect(() => {
    if (current) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [current]);
  const Icon = smartId ? FolderSearch : role ? ROLE_ICON[role] : Folder;
  return (
    <div
      ref={ref}
      className={cx('group/row relative flex h-8 items-center rounded-[var(--radius-row)] transition-colors duration-[var(--motion-fast)]', current ? ROW_SELECTED : ROW_HOVER)}
      style={{ paddingLeft: 4 + depth * 14 }}
      data-menu-kind={menu ?? undefined}
      data-menu-id={smartId ?? folderId}
    >
      {toggleId ? (
        <button
          type="button"
          className="grid size-5 shrink-0 place-items-center rounded-[4px] text-muted hover:text-fg"
          aria-label={t(folded ? 'mbox.folders.expand' : 'mbox.folders.collapse', { name: label })}
          aria-expanded={!folded}
          onClick={() => useMailUi.getState().toggleCollapsed(toggleId)}
        >
          <ChevronRight className={cx('size-3 transition-transform duration-[var(--motion-fast)]', !folded && 'rotate-90')} strokeWidth={2} aria-hidden />
        </button>
      ) : (
        <span className="size-5 shrink-0" aria-hidden />
      )}
      <button
        type="button"
        className="flex h-full min-w-0 flex-1 items-center gap-2 pr-2 text-left text-body text-fg"
        aria-current={current || undefined}
        onClick={() => selectBox(box)}
        data-testid="mail-sidebar-row"
      >
        <Icon className={cx('size-4 shrink-0', current ? 'text-fg' : 'text-accent-text')} strokeWidth={1.75} aria-hidden />
        <span className="min-w-0 flex-1 truncate" title={label}>{label}</span>
        {count > 0 ? <span className="shrink-0 text-caption tabular-nums text-muted">{count}</span> : null}
      </button>
    </div>
  );
});

// ---------------------------------------------------------------- the context menu

type MenuTarget = { kind: 'account' | 'folder' | 'trash' | 'smart'; id: string } | null;

/** One menu for the sidebar: the row under the pointer says what it is (`data-menu-kind` / `-id`). */
function SidebarMenu({ children }: { children: ReactNode }): ReactNode {
  const [target, setTarget] = useState<MenuTarget>(null);
  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger
        asChild
        onContextMenu={(e) => {
          const el = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-menu-kind]') : null;
          const kind = el?.dataset['menuKind'];
          const id = el?.dataset['menuId'];
          if (!id || (kind !== 'account' && kind !== 'folder' && kind !== 'trash' && kind !== 'smart')) {
            e.preventDefault();
            return;
          }
          setTarget({ kind, id });
        }}
      >
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={cx(menuBox, 'w-max max-w-[320px]')} collisionPadding={16} data-testid="mail-sidebar-menu">
          {target ? <MenuItems target={target} /> : null}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function MenuItems({ target }: { target: NonNullable<MenuTarget> }): ReactNode {
  const ui = useMailUi.getState();
  const folder = useMail((s) => (target.kind === 'folder' || target.kind === 'trash' ? (s.folderById[target.id] ?? null) : null));
  if (target.kind === 'account') {
    return (
      <>
        <ContextMenu.Item className={menuItem} onSelect={() => ui.openFolderDialog({ kind: 'create', accountId: target.id, parentId: null, smart: false })} data-testid="mail-menu-new-folder">
          <FolderPlus className="size-4" aria-hidden />
          {t('mbox.folders.newFolder')}
        </ContextMenu.Item>
        <ContextMenu.Item className={menuItem} onSelect={() => ui.openFolderDialog({ kind: 'create', accountId: target.id, parentId: null, smart: true })}>
          <FolderSearch className="size-4" aria-hidden />
          {t('mbox.smart.titleNew')}
        </ContextMenu.Item>
        <ContextMenu.Separator className={menuSeparator} />
        <ContextMenu.Item className={menuItem} onSelect={() => void syncNow(target.id)}>
          <RotateCw className="size-4" aria-hidden />
          {t('mbox.checkMail')}
        </ContextMenu.Item>
      </>
    );
  }
  if (target.kind === 'smart') {
    return (
      <>
        <ContextMenu.Item className={menuItem} onSelect={() => ui.openFolderDialog({ kind: 'smart', smartId: target.id })} data-testid="mail-menu-edit-smart">
          <Pencil className="size-4" aria-hidden />
          {t('mbox.smart.edit')}
        </ContextMenu.Item>
        <ContextMenu.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => deleteSmartFolder(target.id)} data-testid="mail-menu-delete-smart">
          <Trash2 className="size-4" aria-hidden />
          {t('mbox.smart.delete')}
        </ContextMenu.Item>
      </>
    );
  }
  if (!folder) return null;
  const own = isOwnFolder(folder);
  return (
    <>
      {canHoldFolders(folder) ? (
        <ContextMenu.Item className={menuItem} onSelect={() => ui.openFolderDialog({ kind: 'create', accountId: folder.accountId, parentId: folder.id, smart: false })} data-testid="mail-menu-new-subfolder">
          <FolderPlus className="size-4" aria-hidden />
          {t('mbox.folders.newSub')}
        </ContextMenu.Item>
      ) : null}
      {folder.role === 'trash' ? (
        <ContextMenu.Item className={cx(menuItem, 'text-danger-text')} disabled={folder.total === 0} onSelect={() => void emptyTrash(folder.id, folder.total)} data-testid="mail-box-empty-trash">
          <BrushCleaning className="size-4" aria-hidden />
          {t('mbox.trash.empty')}
        </ContextMenu.Item>
      ) : null}
      {own ? (
        <>
          <ContextMenu.Item className={menuItem} onSelect={() => ui.openFolderDialog({ kind: 'rename', folderId: folder.id })} data-testid="mail-menu-rename-folder">
            <Pencil className="size-4" aria-hidden />
            {t('mbox.folders.rename')}
          </ContextMenu.Item>
          <ContextMenu.Separator className={menuSeparator} />
          <ContextMenu.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => void deleteFolder(folder.id)} data-testid="mail-menu-delete-folder">
            <Trash2 className="size-4" aria-hidden />
            {t('mbox.folders.delete')}
          </ContextMenu.Item>
        </>
      ) : null}
    </>
  );
}
