import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { CanvasItemKind } from '@calaba/protocol';
import { ChevronRight, Ellipsis, Shapes, Share2, Trash2 } from 'lucide-react';
import { memo, Suspense, useCallback, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Bar, BAR_GROUP } from '../../components/Bar';
import { Button, IconButton, Spinner, cx } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { ancestorsOf, canStructure } from '../../lib/canvas/tree';
import { createItem, deleteForever, restoreItem } from '../../services/canvas';
import { useCanvas } from '../../stores/canvas';
import { useCanvasUi } from '../../stores/canvasUi';
import { myUserId, useSession } from '../../stores/session';
import { menuBox } from '../shell/menu';
import { DROP, ItemMenuEntries } from './ItemMenu';
import { CanvasViewLazy } from './lazy';

/**
 * The right side of «Холст» (ADR-0107 §5, docs/08): the header (crumbs · «Поделиться» · «⋯») and
 * the open canvas — `CanvasView` (features/canvas/view, its own
 * lazy chunk: the engine, Yjs and the socket; it draws its own presence and connection notices). Only the open
 * canvas mounts a document. A canvas in
 * the trash shows a restore banner instead of the view.
 */
export function CanvasMain({ workspaceId, canCreate }: { workspaceId: string; canCreate: boolean }): ReactNode {
  const itemId = useCanvasUi((s) => s.itemOf[workspaceId] ?? '');
  // Only canvases open in the centre; a folder id (an old memory) counts as nothing open.
  const canvas = useCanvas((s) => s.items[itemId]?.kind === CanvasItemKind.CANVAS);
  const known = useCanvas((s) => !!s.items[itemId]);
  const openId = canvas ? itemId : '';
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <CanvasBar workspaceId={workspaceId} itemId={openId} />
      <div className="relative min-h-0 flex-1" data-testid="canvas-main">
        {openId ? (
          <OpenCanvas key={openId} workspaceId={workspaceId} itemId={openId} />
        ) : itemId && !known ? (
          <div className="grid h-full place-items-center">
            <Spinner />
          </div>
        ) : (
          <NoCanvas workspaceId={workspaceId} canCreate={canCreate} />
        )}
      </div>
    </div>
  );
}

function NoCanvas({ workspaceId, canCreate }: { workspaceId: string; canCreate: boolean }): ReactNode {
  useLocale();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-body text-muted" data-testid="canvas-empty">
      <Shapes className="size-10" strokeWidth={1.25} aria-hidden />
      <p>{t('canvas.pick')}</p>
      {canCreate ? <Button onClick={() => void createItem(workspaceId, '', CanvasItemKind.CANVAS)}>{t('canvas.newCanvas')}</Button> : null}
    </div>
  );
}

/** The canvas itself, or the restore banner when it is in the trash. */
function OpenCanvas({ workspaceId, itemId }: { workspaceId: string; itemId: string }): ReactNode {
  const trashed = useCanvas((s) => !!s.items[itemId]?.trashedAt);
  const bits = useCanvas((s) => s.items[itemId]?.myBits ?? 0n);
  const name = useCanvas((s) => s.items[itemId]?.name ?? '');
  const onOpenHistory = useCallback(() => useCanvasUi.getState().openDialog({ kind: 'versions', itemId }), [itemId]);
  const onShare = useCallback(() => useCanvasUi.getState().openDialog({ kind: 'share', itemId }), [itemId]);
  if (trashed) return <TrashedBanner itemId={itemId} />;
  return (
    <Suspense
      fallback={
        <div className="grid h-full place-items-center">
          <Spinner />
        </div>
      }
    >
      <CanvasViewLazy canvasId={itemId} workspaceId={workspaceId} bits={bits} name={name} onOpenHistory={onOpenHistory} onShare={onShare} />
    </Suspense>
  );
}

function TrashedBanner({ itemId }: { itemId: string }): ReactNode {
  useLocale();
  const structure = useCanvas((s) => {
    const i = s.items[itemId];
    return !!i && canStructure(i, myUserId());
  });
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-body text-muted" role="status" data-testid="canvas-trashed">
      <Trash2 className="size-10" strokeWidth={1.25} aria-hidden />
      <p className="text-fg">{t('canvas.inTrash')}</p>
      <p className="max-w-sm">{t('canvas.inTrashText')}</p>
      {structure ? (
        <span className="flex gap-2">
          <Button onClick={() => void restoreItem(itemId)} data-testid="canvas-banner-restore">
            {t('canvas.restore')}
          </Button>
          <Button variant="secondary" onClick={() => void deleteForever(itemId)}>
            {t('canvas.deleteForever')}
          </Button>
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- header

function CanvasBar({ workspaceId, itemId }: { workspaceId: string; itemId: string }): ReactNode {
  useLocale();
  const structure = useCanvas((s) => {
    const i = s.items[itemId];
    return !!i && canStructure(i, myUserId());
  });
  const trashed = useCanvas((s) => !!s.items[itemId]?.trashedAt);
  // The global «Нет соединения» pill floats over the middle of this bar: keep the crumbs left of it.
  const reconnecting = useSession((s) => s.ready && s.reconnectBanner);
  return (
    <Bar plain className="gap-2 pl-3 pr-3" data-testid="canvas-bar">
      {itemId ? <Crumbs workspaceId={workspaceId} itemId={itemId} clear={reconnecting} /> : <h1 className="px-1.5 text-headline font-semibold">{t('canvas.section')}</h1>}
      <span className="flex-1" />
      {itemId ? (
        <span className={BAR_GROUP}>
          {structure && !trashed ? (
            <Button variant="secondary" size="sm" onClick={() => useCanvasUi.getState().openDialog({ kind: 'share', itemId })} data-testid="canvas-share">
              <Share2 className="size-3.5" aria-hidden />
              {t('canvas.share')}
            </Button>
          ) : null}
          <MoreMenu itemId={itemId} />
        </span>
      ) : null}
    </Bar>
  );
}

const Crumbs = memo(function Crumbs({ workspaceId, itemId, clear }: { workspaceId: string; itemId: string; clear: boolean }): ReactNode {
  const path = useCanvas(useShallow((s) => ancestorsOf(s.items, itemId)));
  const shown: Array<string | null> = path.length > 3 ? [path[0] ?? null, null, ...path.slice(-2)] : path;
  return (
    <nav aria-label={t('canvas.path')} className={cx('flex min-w-0 items-center gap-0.5', clear && 'max-w-[calc(50%-150px)]')} data-testid="canvas-crumbs">
      {shown.map((id, i) => (
        <span key={id ?? `gap${i}`} className="flex min-w-0 items-center gap-0.5">
          {id === null ? <span className="px-1 text-muted">…</span> : <CrumbButton workspaceId={workspaceId} id={id} />}
          <ChevronRight className="size-3.5 shrink-0 text-faint" aria-hidden />
        </span>
      ))}
      <CrumbTitle id={itemId} />
    </nav>
  );
});

/** A folder crumb: it shows that folder open in the tree (the centre keeps the canvas). */
function CrumbButton({ workspaceId, id }: { workspaceId: string; id: string }): ReactNode {
  const name = useCanvas((s) => s.items[id]?.name ?? '');
  return (
    <button
      type="button"
      onClick={() => {
        const ui = useCanvasUi.getState();
        ui.openTrash(workspaceId, false);
        ui.setExpanded(id, true);
      }}
      className="flex h-8 min-w-0 max-w-48 items-center gap-1 truncate rounded-[var(--radius-bar)] px-1.5 text-body text-muted hover:bg-hover hover:text-fg"
      data-testid="canvas-crumb"
    >
      <span className="truncate">{name || t('canvas.untitled')}</span>
    </button>
  );
}

function CrumbTitle({ id }: { id: string }): ReactNode {
  const name = useCanvas((s) => s.items[id]?.name ?? '');
  return (
    <h1 className="flex min-w-0 items-center gap-1.5 truncate px-1.5 text-body font-semibold" aria-current="page" data-testid="canvas-title">
      <span className="truncate">{name || t('canvas.untitled')}</span>
    </h1>
  );
}

/** The header's «⋯»: the same menu as the tree rows' (ItemMenu.tsx); the canvas is open already, so no «Открыть». */
function MoreMenu({ itemId }: { itemId: string }): ReactNode {
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>
        <IconButton label={t('canvas.moreMenu')} data-testid="canvas-more">
          <Ellipsis className="size-4" aria-hidden />
        </IconButton>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className={cx(menuBox, 'min-w-56')} sideOffset={4} align="end" collisionPadding={16} onCloseAutoFocus={(e) => e.preventDefault()} data-testid="canvas-more-menu">
          <ItemMenuEntries itemId={itemId} parts={DROP} hideOpen onRename={() => useCanvasUi.getState().setRenaming(itemId)} />
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
