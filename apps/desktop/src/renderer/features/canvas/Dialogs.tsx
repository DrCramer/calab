import { timestampDate } from '@bufbuild/protobuf/wkt';
import { CanvasItemKind, CANVAS_BITS, type CanvasVersion } from '@calaba/protocol';
import { ChevronRight, Folder } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button, Modal, Segmented, Spinner, cx } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { fmt } from '../../lib/format';
import { canvasDocHandle } from '../../lib/canvas/docHandle';
import { ancestorsOf, childKey, isInSubtree, mergeById, TOP } from '../../lib/canvas/tree';
import { canvasApi, loadChildren, moveItem, restoreVersion } from '../../services/canvas';
import { toast } from '../../stores/toasts';
import { useCanvas } from '../../stores/canvas';
import { useCanvasUi, type CanvasDialog } from '../../stores/canvasUi';
import { memberName, useWorkspaces } from '../../stores/workspaces';
import { MemberAvatar } from '../boards/menus';
import { entryOf, TreeAccessEditor, useTreeAccess } from '../people/TreeAccess';
import { LinkPanel } from './LinkPanel';

/**
 * The canvas section's dialogs (ADR-0113 §5): «Доступ» (the shared tree access editor and, for a canvas, the
 * public read-only «Ссылка», ADR-0114 wave 5),
 * «История версий» (the list, «Восстановить» into the live document) and «Переместить». One host
 * reads the request from stores/canvasUi; each mounts only while open.
 */
export function CanvasDialogs({ workspaceId }: { workspaceId: string }): ReactNode {
  const dialog = useCanvasUi((s) => s.dialog);
  if (!dialog) return null;
  return <DialogBody dialog={dialog} workspaceId={workspaceId} onClose={closeDialog} />;
}

const closeDialog = (): void => useCanvasUi.getState().openDialog(null);

function DialogBody({ dialog, workspaceId, onClose }: { dialog: CanvasDialog; workspaceId: string; onClose: () => void }): ReactNode {
  switch (dialog.kind) {
    case 'share':
      return <ShareDialog itemId={dialog.itemId} onClose={onClose} />;
    case 'versions':
      return <VersionsDialog key={dialog.itemId} workspaceId={workspaceId} canvasId={dialog.itemId} onClose={onClose} />;
    case 'move':
      return <MoveDialog workspaceId={workspaceId} itemId={dialog.itemId} onClose={onClose} />;
  }
}

// ---------------------------------------------------------------- «Доступ»

const CANVAS_TREE = { VIEW: CANVAS_BITS.VIEW, WRITE: CANVAS_BITS.WRITE };

type ShareTab = 'access' | 'link';

function ShareDialog({ itemId, onClose }: { itemId: string; onClose: () => void }): ReactNode {
  useLocale();
  const item = useCanvas((s) => s.items[itemId]);
  // A private canvas: restricted itself or below a restricted folder (the server refuses a link then).
  const privateChain = useCanvas((s) => !!s.items[itemId]?.restricted || ancestorsOf(s.items, itemId).some((id) => !!s.items[id]?.restricted));
  const [tab, setTab] = useState<ShareTab>('access');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => canvasApi.permissions(itemId), [itemId]);
  const access = useTreeAccess(load, CANVAS_TREE, (e) => {
    toast.fail(e, t('canvas.err.access'));
    onClose();
  });
  if (!item) return null;
  const isCanvas = item.kind === CanvasItemKind.CANVAS;
  const { drafts, restricted } = access;
  const save = (): void => {
    if (!drafts) return;
    setBusy(true);
    canvasApi
      .setPermissions(itemId, {
        entries: drafts.map((d) => entryOf(d, CANVAS_TREE)),
        restricted,
      })
      .then(
        () => {
          const cur = useCanvas.getState().items[itemId];
          if (cur) useCanvas.getState().upsert({ ...cur, restricted, shared: drafts.length > 0 });
          onClose();
        },
        (e: unknown) => {
          setBusy(false);
          toast.fail(e, t('canvas.err.access'));
        },
      );
  };
  return (
    <Modal
      open
      onClose={onClose}
      medium
      initialFocus="body"
      title={t('canvas.shareTitle', { name: item.name || t('canvas.untitled') })}
      footer={
        tab === 'access' ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button onClick={save} busy={busy} disabled={!drafts} data-testid="canvas-access-save">
              {t('common.save')}
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={onClose}>
            {t('common.close')}
          </Button>
        )
      }
    >
      <div className="flex min-h-[340px] flex-col gap-4" data-testid="canvas-share-dialog">
        {isCanvas ? (
          <Segmented<ShareTab>
            value={tab}
            label={t('canvasShare.tabs')}
            fill
            options={[
              { value: 'access', label: t('canvasShare.tab.access') },
              { value: 'link', label: t('canvasShare.tab.link') },
            ]}
            onChange={setTab}
            testId="canvas-share-tabs"
          />
        ) : null}
        {tab === 'link' && isCanvas ? (
          <LinkPanel itemId={itemId} restricted={privateChain} />
        ) : (
          <TreeAccessEditor
            workspaceId={item.workspaceId}
            ownerId={item.ownerId}
            access={access}
            hint={t('canvas.restrictedHint')}
            hintOwner={t('canvas.restrictedHintOwner')}
            itemName={item.name || t('canvas.untitled')}
            onTakeOver={() => canvasApi.takeOver(itemId).then((r) => r.item && useCanvas.getState().upsert(r.item))}
            inherited={t('canvas.accessInherited')}
            footer={t('canvas.accessFooter')}
            testId="canvas-access"
          />
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- «История версий»

/**
 * «История версий» (ADR-0113 §1, §3): the versions newest first (date, authors) on the left; the
 * picked one on the right (who edited, size) with «Восстановить», which puts the version's objects
 * into the live document as one edit (co-authors see it, my undo takes it back). The restore needs
 * the open canvas (its document handle, lib/canvas/docHandle.ts) and the right to write.
 */
export function VersionsDialog({ workspaceId, canvasId, onClose }: { workspaceId: string; canvasId: string; onClose: () => void }): ReactNode {
  useLocale();
  const name = useCanvas((s) => s.items[canvasId]?.name ?? '');
  const [list, setList] = useState<readonly CanvasVersion[]>([]);
  const [cursor, setCursor] = useState<string | null>('');
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // An answer counts only for the effect run that asked: StrictMode's double mount (and a change
  // of canvas) must not add the first page twice or let a stale page move the cursor.
  const epoch = useRef(0);
  const fetchPage = useCallback(
    (from: string) => {
      const mine = epoch.current;
      canvasApi.versions(canvasId, from || undefined).then(
        (r) => {
          if (epoch.current !== mine) return;
          setList((l) => mergeById(l, r.versions));
          setPicked((p) => p ?? r.versions[0]?.id ?? null);
          setCursor(r.nextCursor || null);
          setLoading(false);
        },
        (e: unknown) => {
          if (epoch.current !== mine) return;
          toast.fail(e, t('canvas.err.versions'));
          setCursor(null);
          setLoading(false);
        },
      );
    },
    [canvasId],
  );
  useEffect(() => {
    const token = epoch;
    fetchPage('');
    return () => {
      token.current++;
    };
  }, [fetchPage]);
  const version = list.find((v) => v.id === picked) ?? null;
  const writable = canvasDocHandle(canvasId)?.writable() ?? false;
  return (
    <Modal
      open
      onClose={onClose}
      wide
      initialFocus="body"
      title={t('canvas.versionsTitle', { name: name || t('canvas.untitled') })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.close')}
          </Button>
          <Button
            disabled={!version || !writable}
            busy={busy}
            onClick={() => {
              if (!version) return;
              setBusy(true);
              void restoreVersion(canvasId, version.id).then((ok) => {
                setBusy(false);
                if (ok) onClose();
              });
            }}
            data-testid="canvas-version-restore"
          >
            {t('canvas.versions.restore')}
          </Button>
        </>
      }
    >
      <div className="flex h-[min(60vh,420px)] gap-3" data-testid="canvas-versions">
        <ol className="scrollbar-thin flex w-56 shrink-0 flex-col gap-0.5 overflow-y-auto rounded-[var(--radius-card)] bg-[var(--color-card)] p-1">
          {list.map((v) => (
            <VersionRow key={v.id} workspaceId={workspaceId} v={v} active={v.id === picked} onPick={setPicked} />
          ))}
          {loading ? (
            <li className="grid h-12 place-items-center">
              <Spinner />
            </li>
          ) : !list.length ? (
            <li className="px-2 py-3 text-caption text-muted">{t('canvas.versions.empty')}</li>
          ) : cursor ? (
            <li>
              <button
                type="button"
                onClick={() => {
                  setLoading(true);
                  fetchPage(cursor);
                }}
                className="h-7 rounded-full px-2.5 text-caption text-accent-text hover:bg-hover"
              >
                {t('boards.hist.more')}
              </button>
            </li>
          ) : null}
        </ol>
        <div className="flex min-w-0 flex-1 flex-col gap-3" data-testid="canvas-version-details">
          {version ? (
            <VersionDetails workspaceId={workspaceId} v={version} writable={writable} />
          ) : (
            <div className="grid flex-1 place-items-center text-caption text-muted">{loading ? null : t('canvas.versions.pick')}</div>
          )}
        </div>
      </div>
    </Modal>
  );
}

const VersionRow = memo(function VersionRow({ workspaceId, v, active, onPick }: { workspaceId: string; v: CanvasVersion; active: boolean; onPick: (id: string) => void }): ReactNode {
  const at = v.createdAt ? timestampDate(v.createdAt) : null;
  return (
    <li>
      <button
        type="button"
        onClick={() => onPick(v.id)}
        aria-pressed={active}
        className={cx('flex w-full flex-col gap-1 rounded-[var(--radius-row)] px-2 py-1.5 text-left', active ? 'bg-active' : 'hover:bg-hover')}
        data-testid="canvas-version-row"
      >
        <span className="text-body">{at ? fmt.dateTime(at, 'short') : '—'}</span>
        <span className="flex items-center -space-x-1">
          {v.authorIds.slice(0, 5).map((id) => (
            <span key={id} className="rounded-full ring-2 ring-[var(--color-card)]">
              <MemberAvatar workspaceId={workspaceId} userId={id} size={18} />
            </span>
          ))}
        </span>
      </button>
    </li>
  );
});

function VersionDetails({ workspaceId, v, writable }: { workspaceId: string; v: CanvasVersion; writable: boolean }): ReactNode {
  const at = v.createdAt ? timestampDate(v.createdAt) : null;
  const names = useWorkspaces(useShallow((s) => v.authorIds.map((id) => (s.byId[workspaceId]?.members[id] ? memberName(workspaceId, id) : ''))));
  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-card)] bg-[var(--color-card)] p-3 text-body">
      <h3 className="text-headline font-semibold">{t('canvas.versions.version', { date: at ? fmt.dateTime(at, 'short') : '—' })}</h3>
      {v.authorIds.length ? (
        <section className="flex flex-col gap-1.5">
          <h4 className="text-caption font-semibold text-muted">{t('canvas.versions.authors')}</h4>
          <ul className="flex flex-col gap-1">
            {v.authorIds.map((id, i) => (
              <li key={id} className="flex items-center gap-2">
                <MemberAvatar workspaceId={workspaceId} userId={id} size={20} />
                <span className="min-w-0 flex-1 truncate">{names[i] || '—'}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <p className="text-caption text-muted">{t('canvas.versions.size', { size: fmt.size(v.size) })}</p>
      <p className="text-caption text-muted">{writable ? t('canvas.versions.hint') : t('canvas.versions.noWrite')}</p>
    </div>
  );
}

// ---------------------------------------------------------------- «Переместить»

/**
 * «Переместить»: walks the folders from the item's parent — crumbs on top, the child folders as
 * rows (a click goes in), «Переместить сюда» puts the item last there. Only folders are offered;
 * the item itself and its subtree are not.
 */
function MoveDialog({ workspaceId, itemId, onClose }: { workspaceId: string; itemId: string; onClose: () => void }): ReactNode {
  useLocale();
  const item = useCanvas((s) => s.items[itemId]);
  const [at, setAt] = useState<string>(item?.parentId ?? TOP);
  const key = childKey(workspaceId, at);
  const rows = useCanvas(useShallow((s) => (s.lists[key] ?? []).filter((id) => s.items[id]?.kind === CanvasItemKind.FOLDER && !isInSubtree(s.items, id, itemId))));
  const loaded = useCanvas((s) => !!s.lists[key]);
  const path = useCanvas(useShallow((s) => (at ? [...ancestorsOf(s.items, at), at] : [])));
  useEffect(() => {
    void loadChildren(workspaceId, at);
  }, [workspaceId, at]);
  if (!item) return null;
  const ok = at !== item.parentId && at !== itemId && !isInSubtree(useCanvas.getState().items, at, itemId);
  return (
    <Modal
      open
      onClose={onClose}
      initialFocus="body"
      title={t('canvas.moveTitle', { name: item.name || t('canvas.untitled') })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={!ok}
            onClick={() => {
              onClose();
              const n = (useCanvas.getState().lists[key] ?? []).filter((x) => x !== itemId).length;
              void moveItem(itemId, at, n);
            }}
            data-testid="canvas-move-here"
          >
            {t('canvas.moveHere')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2" data-testid="canvas-move">
        <nav aria-label={t('canvas.path')} className="flex min-w-0 flex-wrap items-center gap-0.5 text-body">
          <MoveCrumb id={TOP} last={!path.length} onOpen={setAt} />
          {path.map((id, i) => (
            <span key={id} className="flex min-w-0 items-center gap-0.5">
              <ChevronRight className="size-3.5 text-faint" aria-hidden />
              <MoveCrumb id={id} last={i === path.length - 1} onOpen={setAt} />
            </span>
          ))}
        </nav>
        <div tabIndex={-1} className="flex h-60 flex-col overflow-y-auto rounded-[var(--radius-card)] bg-[var(--color-card)] p-1 outline-none">
          {!loaded ? (
            <div className="grid flex-1 place-items-center">
              <Spinner />
            </div>
          ) : rows.length ? (
            rows.map((id) => <MoveRow key={id} id={id} onOpen={setAt} />)
          ) : (
            <p className="grid flex-1 place-items-center text-caption text-muted">{t('canvas.noFolders')}</p>
          )}
        </div>
      </div>
    </Modal>
  );
}

function MoveCrumb({ id, last, onOpen }: { id: string; last: boolean; onOpen: (id: string) => void }): ReactNode {
  const name = useCanvas((s) => (id ? (s.items[id]?.name ?? '') : ''));
  return (
    <button
      type="button"
      onClick={() => onOpen(id)}
      className={cx('h-7 max-w-48 truncate rounded-[var(--radius-control)] px-1.5', last ? 'font-semibold text-fg' : 'text-muted hover:bg-hover hover:text-fg')}
    >
      {id ? name || t('canvas.untitled') : t('canvas.section')}
    </button>
  );
}

function MoveRow({ id, onOpen }: { id: string; onOpen: (id: string) => void }): ReactNode {
  const name = useCanvas((s) => s.items[id]?.name ?? '');
  return (
    <button type="button" onClick={() => onOpen(id)} className="flex h-8 shrink-0 items-center gap-2 rounded-[var(--radius-row)] px-2 text-left text-body hover:bg-hover" data-testid="canvas-move-row">
      <span className="grid size-5 shrink-0 place-items-center" aria-hidden>
        <Folder className="size-4 text-muted" strokeWidth={1.75} />
      </span>
      <span className="min-w-0 flex-1 truncate">{name || t('canvas.untitled')}</span>
      <ChevronRight className="size-3.5 shrink-0 text-faint" aria-hidden />
    </button>
  );
}
