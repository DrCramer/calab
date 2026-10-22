/**
 * The comment pins of a canvas (ADR-0116 wave 4): a DOM layer over the canvas, never the canvas itself — a
 * comment written by someone else re-renders its own pin, not the canvas nor the React tree above.
 *
 * Positions follow the camera without React: the layer's transform and its `--s` (scale) are set from the
 * engine's view callback, each pin holds its world point in `--wx` / `--wy`; a pin on an object is moved
 * when the scene reports that object changed (`placePin`). In idle nothing runs (no frame, no timer).
 */
import { MessageCircle } from 'lucide-react';
import { memo, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { cx } from '../../../../components/ui';
import { t } from '../../../../i18n';
import { pinWorld } from '../../../../lib/canvas/comments';
import { useCanvasComments, type CommentDraft } from '../../../../stores/canvasComments';
import { memberName } from '../../../../stores/workspaces';
import type { CanvasEngine } from '../../engine';

const EMPTY: readonly string[] = [];

/** Puts a pin element at its world point (from its data-*), hidden when its object is gone. */
export function placePin(el: HTMLElement, engine: Pick<CanvasEngine, 'scene'>): void {
  const objectId = el.dataset['objectId'] ?? '';
  const p = pinWorld({ objectId, x: Number(el.dataset['ox'] ?? 0), y: Number(el.dataset['oy'] ?? 0) }, (id) => engine.scene.get(id));
  el.hidden = !p;
  if (!p) return;
  el.style.setProperty('--wx', String(p.x));
  el.style.setProperty('--wy', String(p.y));
}

/** The camera as the layer's CSS: one style write per camera change, whatever the number of pins. */
export function applyCamera(el: HTMLElement, cam: { tx: number; ty: number; scale: number }): void {
  el.style.transform = `translate(${cam.tx}px, ${cam.ty}px)`;
  el.style.setProperty('--s', String(cam.scale));
}

const PIN_STYLE: CSSProperties = {
  // The world point × scale, in layer pixels; the pin's tip on the point.
  transform: 'translate(calc(var(--wx) * var(--s) * 1px), calc(var(--wy) * var(--s) * 1px)) translate(-4px, -100%)',
};

const Pin = memo(function Pin({ id, workspaceId, engine }: { id: string; workspaceId: string; engine: CanvasEngine }): ReactNode {
  const c = useCanvasComments((s) => s.byId[id]);
  const replies = useCanvasComments((s) => s.replies[id]?.length ?? 0);
  const active = useCanvasComments((s) => s.active === id);
  const el = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (el.current) placePin(el.current, engine);
  }, [engine, c?.objectId, c?.x, c?.y]);
  if (!c) return null;
  const author = memberName(workspaceId, c.authorId);
  return (
    <button
      ref={el}
      type="button"
      data-testid="canvas-comment-pin"
      data-comment-id={id}
      data-object-id={c.objectId || undefined}
      data-ox={c.x}
      data-oy={c.y}
      aria-label={t('canvasComments.pinLabel', { name: author })}
      aria-pressed={active}
      title={author}
      style={PIN_STYLE}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => {
        const st = useCanvasComments.getState();
        st.setActive(id);
        st.setPanel(true);
      }}
      className={cx(
        'pointer-events-auto absolute left-0 top-0 flex h-7 min-w-7 items-center gap-0.5 rounded-full rounded-bl-none border px-1.5 text-caption font-medium shadow-sm',
        active ? 'border-accent bg-accent-strong text-accent-fg' : c.resolved ? 'border-line bg-main text-muted' : 'border-line bg-main text-fg',
      )}
    >
      <MessageCircle className="size-3.5 shrink-0" strokeWidth={2} aria-hidden />
      {replies > 0 ? <span>{replies + 1}</span> : null}
    </button>
  );
});

function DraftPin({ draft, engine }: { draft: CommentDraft; engine: CanvasEngine }): ReactNode {
  const el = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (el.current) placePin(el.current, engine);
  }, [engine, draft]);
  return (
    <div
      ref={el}
      aria-hidden
      data-testid="canvas-comment-draft-pin"
      data-object-id={draft.objectId || undefined}
      data-ox={draft.x}
      data-oy={draft.y}
      style={PIN_STYLE}
      className="absolute left-0 top-0 grid size-7 place-items-center rounded-full rounded-bl-none border border-accent bg-accent-strong text-accent-fg shadow-sm"
    >
      <MessageCircle className="size-3.5" strokeWidth={2} aria-hidden />
    </div>
  );
}

/** Pins of the open threads (a resolved one only while it is the active thread) and the draft's. */
export const CommentPins = memo(function CommentPins({ engine, canvasId, workspaceId }: { engine: CanvasEngine; canvasId: string; workspaceId: string }): ReactNode {
  const ids = useCanvasComments(useShallow((s) => (s.threads[canvasId] ?? EMPTY).filter((id) => !s.byId[id]?.resolved || s.active === id)));
  const draft = useCanvasComments((s) => (s.draft?.canvasId === canvasId ? s.draft : null));
  const layer = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = layer.current;
    if (!el) return undefined;
    const apply = (): void => applyCamera(el, engine.camera);
    apply();
    const offView = engine.subscribeView(apply);
    // An object that moved, resized or went away takes its pins along; nothing else is touched.
    const offScene = engine.scene.subscribe((ch) => {
      for (const pin of el.querySelectorAll<HTMLElement>('[data-object-id]')) {
        if (ch.ids.has(pin.dataset['objectId'] ?? '')) placePin(pin, engine);
      }
    });
    return () => {
      offView();
      offScene();
    };
  }, [engine]);
  return (
    <div ref={layer} className="pointer-events-none absolute left-0 top-0 z-[5] size-0 overflow-visible" data-testid="canvas-comment-pins">
      {ids.map((id) => (
        <Pin key={id} id={id} workspaceId={workspaceId} engine={engine} />
      ))}
      {draft ? <DraftPin draft={draft} engine={engine} /> : null}
    </div>
  );
});
