import { Frame, Pencil, X } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { IconButton, cx } from '../../../components/ui';
import { t, useLocale } from '../../../i18n';
import { rectsIntersect } from '../../../lib/canvas/geometry';
import type { Scene } from '../../../lib/canvas/scene';
import { renderSceneTo, type CanvasEngine, type CanvasPalette } from '../engine';
import { PANEL, keepFocus } from './chrome';
import { FrameTitleField } from './FrameTitleField';

const ICON = 'size-[18px]';
/** The preview box, CSS px: a frame is fitted into it with its proportions. */
export const PREVIEW_W = 72;
export const PREVIEW_H = 48;
/** A preview repaints at most this often while what it shows keeps changing (a drag inside the frame). */
const PREVIEW_MS = 250;

/** Whether the frames panel is open: for the session only, shared by the toggle and the panel. */
export const framesPanel = (() => {
  let open = false;
  const listeners = new Set<() => void>();
  return {
    get: (): boolean => open,
    set: (on: boolean): void => {
      if (open === on) return;
      open = on;
      for (const fn of [...listeners]) fn();
    },
    subscribe: (fn: () => void): (() => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
})();

const useFramesPanel = (): boolean => useSyncExternalStore(framesPanel.subscribe, framesPanel.get);

export interface FrameItem {
  readonly id: string;
  readonly title: string;
}

/**
 * The frames of a scene as the panel lists them (bottom → top, the order they were made in), as a snapshot that changes
 * only when a frame comes, goes, moves in the order or is renamed — never for a move or an edit of what is on it.
 */
export function framesList(scene: Pick<Scene, 'frames' | 'subscribe'>): { subscribe: (cb: () => void) => () => void; getSnapshot: () => readonly FrameItem[] } {
  let key = '';
  let items: readonly FrameItem[] = [];
  const read = (): readonly FrameItem[] => {
    const frames = scene.frames();
    const next = frames.map((f) => `${f.id}\u0000${f.title}`).join('\u0001');
    if (next !== key) {
      key = next;
      items = frames.map((f) => ({ id: f.id, title: f.title }));
    }
    return items;
  };
  return {
    subscribe: (cb) => scene.subscribe(() => {
      const before = items;
      if (read() !== before) cb();
    }),
    getSnapshot: read,
  };
}

/** The panel's switch in the zoom bar. */
export const FramesToggle = memo(function FramesToggle({ focusCanvas }: { focusCanvas: () => void }): ReactNode {
  useLocale();
  const on = useFramesPanel();
  return (
    <IconButton
      label={t('canvasBoard.frames.title')}
      active={on}
      className={cx(on && 'bg-active text-fg')}
      onMouseDown={keepFocus}
      onClick={() => {
        framesPanel.set(!on);
        focusCanvas();
      }}
      data-testid="canvas-frames-toggle"
    >
      <Frame className={ICON} strokeWidth={1.75} aria-hidden />
    </IconButton>
  );
});

/**
 * The frames panel (ADR-0127 addendum 2026-10-30): the board's frames with a small picture each; a click brings the frame
 * into view, «Переименовать» (or a double click on the name) renames it in place. Closed it renders nothing and holds no
 * subscription; open, the list follows the scene by a snapshot and each picture repaints itself, throttled, only when
 * something on its frame changed and the window is visible.
 */
export const FramesPanel = memo(function FramesPanel({ engine, palette, editable, focusCanvas }: { engine: CanvasEngine; palette: CanvasPalette; editable: boolean; focusCanvas: () => void }): ReactNode {
  const open = useFramesPanel();
  return open ? <FramesPanelBody engine={engine} palette={palette} editable={editable} focusCanvas={focusCanvas} /> : null;
});

function FramesPanelBody({ engine, palette, editable, focusCanvas }: { engine: CanvasEngine; palette: CanvasPalette; editable: boolean; focusCanvas: () => void }): ReactNode {
  useLocale();
  const store = useMemo(() => framesList(engine.scene), [engine]);
  const items = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [renaming, setRenaming] = useState<string | null>(null);
  const close = (): void => {
    framesPanel.set(false);
    // The panel unmounts with the focused element: the canvas hotkeys keep working.
    focusCanvas();
  };
  return (
    <aside
      aria-label={t('canvasBoard.frames.title')}
      data-testid="canvas-frames-panel"
      className={cx(PANEL, 'absolute bottom-16 left-[4.25rem] top-14 z-20 flex w-[260px] flex-col p-0')}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && renaming === null) close();
      }}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line pl-3 pr-1.5">
        <h2 className="flex-1 truncate text-body font-semibold text-fg">{t('canvasBoard.frames.title')}</h2>
        <IconButton size="sm" label={t('common.close')} onClick={close} data-testid="canvas-frames-close">
          <X className="size-4" aria-hidden />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {items.length === 0 ? (
          <p className="px-2 py-6 text-center text-caption text-muted" data-testid="canvas-frames-empty">{t('canvasBoard.frames.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {items.map((f) => (
              <FrameRow
                key={f.id}
                engine={engine}
                palette={palette}
                id={f.id}
                title={f.title}
                editable={editable}
                renaming={renaming === f.id}
                onRename={setRenaming}
                focusCanvas={focusCanvas}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

const FrameRow = memo(function FrameRow({
  engine, palette, id, title, editable, renaming, onRename, focusCanvas,
}: {
  engine: CanvasEngine;
  palette: CanvasPalette;
  id: string;
  title: string;
  editable: boolean;
  renaming: boolean;
  onRename: (id: string | null) => void;
  focusCanvas: () => void;
}): ReactNode {
  const name = title || t('canvasBoard.frames.untitled');
  return (
    <li className="group flex items-center gap-1 rounded-[var(--radius-row)] pr-1 hover:bg-hover" data-testid={`canvas-frame-row-${id}`}>
      {renaming ? (
        <div className="flex min-w-0 flex-1 items-center gap-2 p-1">
          <FramePreview engine={engine} palette={palette} id={id} />
          <FrameTitleField
            value={title}
            label={t('canvasBoard.frames.rename')}
            placeholder={t('canvasBoard.frames.untitled')}
            autoFocus
            onCommit={(next) => engine.renameFrame(id, next)}
            onDone={() => onRename(null)}
            className="h-7 flex-1"
            testId="canvas-frame-rename"
          />
        </div>
      ) : (
        <>
          <button
            type="button"
            className="flex min-w-0 flex-1 cursor-default items-center gap-2 rounded-[var(--radius-row)] p-1 text-left"
            aria-label={t('canvasBoard.frames.show', { name })}
            onClick={() => {
              engine.zoomToFrame(id);
              focusCanvas();
            }}
            onDoubleClick={() => {
              if (editable) onRename(id);
            }}
            data-testid={`canvas-frame-open-${id}`}
          >
            <FramePreview engine={engine} palette={palette} id={id} />
            <span className={cx('min-w-0 flex-1 truncate text-body', title ? 'text-fg' : 'text-muted')}>{name}</span>
          </button>
          {editable ? (
            <IconButton
              size="sm"
              label={t('canvasBoard.frames.rename')}
              className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
              onClick={() => onRename(id)}
              data-testid={`canvas-frame-rename-${id}`}
            >
              <Pencil className="size-3.5" strokeWidth={1.75} aria-hidden />
            </IconButton>
          ) : null}
        </>
      )}
    </li>
  );
});

/** The frame's picture: the board's own renderer over the frame's rect, painted on mount and after changes on it. */
function FramePreview({ engine, palette, id }: { engine: CanvasEngine; palette: CanvasPalette; id: string }): ReactNode {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** A change came while the window was hidden: paint once it is shown again. */
    let stale = false;
    const draw = (): void => {
      timer = null;
      const f = engine.scene.get(id);
      if (!f || f.kind !== 'frame') return;
      if (!engine.isActive) {
        stale = true;
        return;
      }
      stale = false;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const ppu = Math.min(PREVIEW_W / f.w, PREVIEW_H / f.h) * dpr;
      renderSceneTo(cv, engine.scene, palette, { x: f.x, y: f.y, w: f.w, h: f.h }, ppu, 0);
      cv.style.width = `${cv.width / dpr}px`;
      cv.style.height = `${cv.height / dpr}px`;
    };
    const schedule = (): void => {
      if (timer === null) timer = setTimeout(draw, PREVIEW_MS);
    };
    draw();
    const offScene = engine.scene.subscribe((c) => {
      const f = engine.scene.get(id);
      if (!f) return;
      if (c.full || c.ids.has(id) || c.dirty.some((r) => rectsIntersect(r, f))) schedule();
    });
    const offView = engine.subscribeView(() => {
      if (stale && engine.isActive) schedule();
    });
    return () => {
      if (timer !== null) clearTimeout(timer);
      offScene();
      offView();
    };
  }, [engine, palette, id]);
  return (
    <span className="grid shrink-0 place-items-center overflow-hidden rounded-[var(--radius-icon)] bg-[var(--color-bg)] ring-1 ring-inset ring-[var(--color-separator)]" style={{ width: PREVIEW_W, height: PREVIEW_H }} aria-hidden>
      <canvas ref={ref} />
    </span>
  );
}
