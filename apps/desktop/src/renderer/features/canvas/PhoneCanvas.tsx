import { timestampMs } from '@bufbuild/protobuf/wkt';
import { CANVAS_BITS, CanvasItemKind } from '@calaba/protocol';
import { ChevronRight, Folder, Search, Shapes } from 'lucide-react';
import { memo, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { CanvasIdleIcon } from '../../assets/nav/icons';
import { Bar, BAR_GROUP } from '../../components/Bar';
import { CreateSlot, HeaderIcon, PhoneHeader, PhoneSearchButton } from '../../components/PhoneHeader';
import { Button, Input, Spinner, cx } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { childKey, filterItems, TOP } from '../../lib/canvas/tree';
import { fmt } from '../../lib/format';
import { loadChildren, loadItem, openPhoneItem, searchItems } from '../../services/canvas';
import { phoneBack } from '../../services/phoneNav';
import { useCanvas } from '../../stores/canvas';
import { useCanvasUi } from '../../stores/canvasUi';
import { CanvasViewLazy } from './lazy';

/**
 * «Холст» on the phone (ADR-0114 §5, ADR-0095: a section behind «Ещё»; view by default): the tab
 * root lists the top-level folders and canvases (56 px rows, a name filter behind the magnifier), a
 * folder and a canvas are pushed screens (`{kind:'canvas'}`, lib/phoneNav.ts) with the standard header.
 * The canvas screen is the desktop's lazy `CanvasView` in its `phone` mode: pan with one finger, pinch
 * with two, zoom bar. A person with CANVAS_WRITE turns on «Править» in the header (touch editing, ADR-0115 wave 5b).
 * No trash, no creating of canvases, no menus. Data comes from the
 * same stores and services as the desktop section. Only the top screen is mounted, so leaving a
 * canvas closes its sync socket; rows are `memo` and read their item by id; no timers.
 */

/** The «section is on screen» flag the gateway events read (services/canvas.ts onScreen) while any canvas screen is mounted. */
function useCanvasOnScreen(): void {
  useEffect(() => {
    useCanvasUi.getState().setActive(true);
    return () => useCanvasUi.getState().setActive(false);
  }, []);
}

const NONE: readonly string[] = [];
const SCROLL = 'min-h-0 flex-1 overflow-y-auto overscroll-contain';

// ---------------------------------------------------------------- the tab root

export function PhoneCanvas({ workspaceId }: { workspaceId: string }): ReactNode {
  useLocale();
  useCanvasOnScreen();
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    void loadChildren(workspaceId, TOP);
    return () => useCanvasUi.getState().setQuery('');
  }, [workspaceId]);
  const toggleSearch = (): void => {
    if (searching) useCanvasUi.getState().setQuery('');
    setSearching((v) => !v);
  };
  return (
    <section className="mat-content relative flex min-h-0 flex-1 flex-col" aria-label={t('canvas.section')} data-testid="phone-canvas">
      <Bar>
        <HeaderIcon>
          <CanvasIdleIcon className="size-5" />
        </HeaderIcon>
        <h1 className="min-w-0 flex-1 truncate text-headline font-semibold">{t('canvas.section')}</h1>
        {/* Standard order «поиск · +»: the «+» slot stays empty (nothing is created on the phone), the magnifier keeps its x. */}
        <div className={BAR_GROUP}>
          <PhoneSearchButton onClick={toggleSearch} active={searching} label={t('canvas.search')} />
          <CreateSlot />
        </div>
      </Bar>
      {searching ? <SearchField onClose={() => setSearching(false)} /> : null}
      <ItemList workspaceId={workspaceId} parentId={TOP} />
    </section>
  );
}

function SearchField({ onClose }: { onClose: () => void }): ReactNode {
  const query = useCanvasUi((s) => s.query);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="shrink-0 px-4 pb-2">
      <Input
        ref={ref}
        type="search"
        icon={<Search className="size-4" aria-hidden />}
        value={query}
        onChange={(e) => useCanvasUi.getState().setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            useCanvasUi.getState().setQuery('');
            onClose();
          }
        }}
        placeholder={t('canvas.search')}
        aria-label={t('canvas.search')}
        className="rounded-full"
        data-testid="phone-canvas-search-field"
      />
    </div>
  );
}

/** The children of a folder (or the top level): loading, failed, empty, rows — or the filter's hits while a query is typed. */
function ItemList({ workspaceId, parentId }: { workspaceId: string; parentId: string }): ReactNode {
  useLocale();
  const key = childKey(workspaceId, parentId);
  const query = useCanvasUi((s) => s.query);
  const ids = useCanvas(useShallow((s) => s.lists[key] ?? NONE));
  const loaded = useCanvas((s) => !!s.lists[key]);
  const failed = useCanvas((s) => s.load[key] === 'error');
  const open = useCallback((id: string) => openPhoneItem(id), []);
  if (query.trim()) return <SearchResults workspaceId={workspaceId} query={query} onOpen={open} />;
  if (!loaded) {
    return (
      <div className={cx(SCROLL, 'grid place-items-center')}>
        {failed ? (
          <div className="flex flex-col items-center gap-3 px-6 text-center text-body text-muted">
            <p>{t('canvasPhone.loadFailed')}</p>
            <Button variant="secondary" onClick={() => void loadChildren(workspaceId, parentId)}>
              {t('common.retry')}
            </Button>
          </div>
        ) : (
          <Spinner />
        )}
      </div>
    );
  }
  if (!ids.length) {
    return (
      <div className={cx(SCROLL, 'grid place-items-center')} data-testid="phone-canvas-empty">
        <div className="flex flex-col items-center gap-3 px-6 text-center text-body text-muted">
          <Shapes className="size-10" strokeWidth={1.25} aria-hidden />
          <p className="font-medium text-fg">{t(parentId ? 'canvas.emptyFolder' : 'canvas.emptyTree')}</p>
        </div>
      </div>
    );
  }
  return (
    <div className={SCROLL} data-testid="phone-canvas-area">
      <div role="list" aria-label={t('canvas.tree')} className="pb-6">
        {ids.map((id) => (
          <ItemRow key={id} id={id} onOpen={open} />
        ))}
      </div>
    </div>
  );
}

/** A row: folder or canvas icon · name · «изменён …» · «›» for a folder — 56 px, one target. */
const ItemRow = memo(function ItemRow({ id, onOpen }: { id: string; onOpen: (id: string) => void }): ReactNode {
  const name = useCanvas((s) => s.items[id]?.name ?? '');
  const folder = useCanvas((s) => s.items[id]?.kind === CanvasItemKind.FOLDER);
  const updated = useCanvas((s) => {
    const at = s.items[id]?.updatedAt;
    return at ? timestampMs(at) : 0;
  });
  const known = useCanvas((s) => !!s.items[id]);
  if (!known) return null;
  return (
    <div role="listitem" className="flex h-14 items-center pl-4 pr-3" data-testid="phone-canvas-row" data-kind={folder ? 'folder' : 'canvas'}>
      <button type="button" onClick={() => onOpen(id)} className="tap-hit flex h-14 min-w-0 flex-1 items-center gap-3 text-left">
        <KindIcon folder={folder} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-list leading-5 text-fg">{name || t('canvas.untitled')}</span>
          {!folder && updated ? <span className="truncate text-caption leading-4 text-muted">{t('canvasPhone.updated', { when: fmt.relative(new Date(updated)) })}</span> : null}
        </span>
        {folder ? <ChevronRight className="size-4 shrink-0 text-faint" aria-hidden /> : null}
      </button>
    </div>
  );
});

function KindIcon({ folder }: { folder: boolean }): ReactNode {
  const Icon = folder ? Folder : Shapes;
  return (
    <span className="grid size-10 shrink-0 place-items-center rounded-[8px] bg-[var(--color-fill)] text-muted" aria-hidden>
      <Icon className="size-5" strokeWidth={1.75} />
    </span>
  );
}

/** The filter: loaded items whose name matches, then the server's hits (names and text) not shown yet. */
function SearchResults({ workspaceId, query, onOpen }: { workspaceId: string; query: string; onOpen: (id: string) => void }): ReactNode {
  const local = useCanvas(useShallow((s) => filterItems(s.items, workspaceId, query)));
  const [remote, setRemote] = useState<Array<{ id: string; name: string; folder: boolean }>>([]);
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
  const extra = q.length < 2 ? [] : remote.filter((r) => !shown.has(r.id));
  return (
    <div className={cx(SCROLL, 'pb-6')} role="list" aria-label={t('canvas.search')} data-testid="phone-canvas-search-results">
      {local.map((id) => (
        <ItemRow key={id} id={id} onOpen={onOpen} />
      ))}
      {extra.map((r) => (
        <div key={r.id} role="listitem" className="flex h-14 items-center pl-4 pr-3" data-testid="phone-canvas-hit">
          <button type="button" onClick={() => onOpen(r.id)} className="tap-hit flex h-14 min-w-0 flex-1 items-center gap-3 text-left">
            <KindIcon folder={r.folder} />
            <span className="min-w-0 flex-1 truncate text-list leading-5 text-fg">{r.name || t('canvas.untitled')}</span>
          </button>
        </div>
      ))}
      {busy ? (
        <div className="grid h-12 place-items-center">
          <Spinner className="size-4" />
        </div>
      ) : !local.length && !extra.length ? (
        <p className="px-4 py-6 text-center text-body text-muted">{t(failed ? 'canvas.searchFailed' : 'canvas.searchEmpty')}</p>
      ) : failed && q.length >= 2 ? (
        <p className="px-4 py-6 text-center text-body text-muted">{t('canvas.searchFailed')}</p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- a pushed screen: folder or canvas

/**
 * A folder (its children) or a canvas (the viewer). An item unknown yet is fetched once; one that is
 * gone or hidden from me, trashed, or removed while open closes the screen (or says so, on a deep link).
 */
export function PhoneCanvasScreen({ workspaceId, itemId }: { workspaceId: string; itemId: string }): ReactNode {
  useLocale();
  useCanvasOnScreen();
  const known = useCanvas((s) => !!s.items[itemId]);
  const folder = useCanvas((s) => s.items[itemId]?.kind === CanvasItemKind.FOLDER);
  const trashed = useCanvas((s) => !!s.items[itemId]?.trashedAt);
  const [tried, setTried] = useState(false);
  const seen = useRef(false);
  useEffect(() => {
    if (useCanvas.getState().items[itemId]) return undefined;
    let live = true;
    void loadItem(workspaceId, itemId).finally(() => live && setTried(true));
    return () => {
      live = false;
    };
  }, [workspaceId, itemId]);
  useEffect(() => {
    if (known) seen.current = true;
    else if (seen.current) phoneBack();
  }, [known]);
  useEffect(() => {
    if (trashed) phoneBack();
  }, [trashed]);
  if (!known) {
    return (
      <section className="mat-content relative flex min-h-0 flex-1 flex-col" aria-label={t('canvas.section')} data-testid="phone-canvas-screen">
        <PhoneHeader title={t('canvas.section')} icon={<HeaderIcon><CanvasIdleIcon className="size-5" /></HeaderIcon>} />
        {tried ? (
          <div className="grid min-h-0 flex-1 place-items-center px-6 text-center text-body text-muted" role="status" data-testid="phone-canvas-gone">
            <p>{t('canvasBoard.status.gone')}</p>
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 place-items-center">
            <Spinner />
          </div>
        )}
      </section>
    );
  }
  // `key`: the edit mode lives in the screen's state, so another canvas always opens in view mode.
  return folder ? <FolderScreen workspaceId={workspaceId} itemId={itemId} /> : <CanvasScreenView key={itemId} workspaceId={workspaceId} itemId={itemId} />;
}

function ItemTitle({ itemId }: { itemId: string }): ReactNode {
  const name = useCanvas((s) => s.items[itemId]?.name ?? '');
  return <>{name || t('canvas.untitled')}</>;
}

function FolderScreen({ workspaceId, itemId }: { workspaceId: string; itemId: string }): ReactNode {
  useEffect(() => {
    void loadChildren(workspaceId, itemId);
  }, [workspaceId, itemId]);
  return (
    <section className="mat-content relative flex min-h-0 flex-1 flex-col" aria-label={t('canvas.folder')} data-testid="phone-canvas-folder">
      <PhoneHeader title={<ItemTitle itemId={itemId} />} icon={<HeaderIcon icon={Folder} />} />
      <ItemList workspaceId={workspaceId} parentId={itemId} />
    </section>
  );
}

const noop = (): void => undefined;

/**
 * The canvas: the header (name, «изменён …», «Править» for a person with CANVAS_WRITE) and the lazy viewer filling the
 * rest. The viewer opens in view mode; «Править» turns on touch editing (ADR-0115 wave 5b) until «Готово» or until the
 * screen closes — the flag is the screen's state, not stored anywhere.
 */
function CanvasScreenView({ workspaceId, itemId }: { workspaceId: string; itemId: string }): ReactNode {
  const bits = useCanvas((s) => s.items[itemId]?.myBits ?? 0n);
  const canWrite = (bits & CANVAS_BITS.WRITE) !== 0n;
  const [editing, setEditing] = useState(false);
  const on = editing && canWrite;
  const name = useCanvas((s) => s.items[itemId]?.name ?? '');
  const updated = useCanvas((s) => {
    const at = s.items[itemId]?.updatedAt;
    return at ? timestampMs(at) : 0;
  });
  return (
    <section className="mat-content relative flex min-h-0 flex-1 flex-col" aria-label={t('canvas.section')} data-testid="phone-canvas-screen">
      <PhoneHeader
        title={<ItemTitle itemId={itemId} />}
        icon={<HeaderIcon icon={Shapes} />}
        {...(updated ? { subtitle: t('canvasPhone.updated', { when: fmt.relative(new Date(updated)) }) } : {})}
      >
        {canWrite ? (
          <Button variant={on ? 'primary' : 'secondary'} size="sm" aria-pressed={on} aria-label={t('canvasPhone.editMode')} onClick={() => setEditing((v) => !v)} data-testid="phone-canvas-edit">
            {t(on ? 'canvasPhone.done' : 'canvasPhone.edit')}
          </Button>
        ) : null}
      </PhoneHeader>
      {/* The bottom inset stays free of the canvas so the zoom bar clears the home indicator; in edit mode the tool bar owns it (it clears the indicator itself). */}
      <div className={cx('relative min-h-0 flex-1', !on && 'pb-[var(--safe-bottom,0px)]')} data-testid="phone-canvas-stage">
        <Suspense
          fallback={
            <div className="grid h-full place-items-center">
              <Spinner />
            </div>
          }
        >
          <CanvasViewLazy canvasId={itemId} workspaceId={workspaceId} bits={bits} name={name} phone phoneEdit={on} onOpenHistory={noop} onShare={noop} onFatal={() => void loadItem(workspaceId, itemId)} />
        </Suspense>
      </div>
    </section>
  );
}
