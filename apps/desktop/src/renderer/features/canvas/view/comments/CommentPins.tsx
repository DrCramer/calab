/**
 * The comment pins of a canvas (ADR-0127 wave 4): a DOM layer over the canvas, never the canvas itself — a
 * comment written by someone else re-renders its own pin, not the canvas nor the React tree above.
 *
 * Positions follow the camera without React: the layer's transform and its `--s` (scale) are set from the
 * engine's view callback, each pin holds its world point in `--wx` / `--wy`; a pin on an object is moved
 * when the scene reports that object changed (`placePin`). In idle nothing runs (no frame, no timer).
 */
import { Check, MessageCircle, MessageCirclePlus } from 'lucide-react';
import { timestampMs } from '@bufbuild/protobuf/wkt';
import { memo, useCallback, useLayoutEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Tip, cx } from '../../../../components/ui';
import { t } from '../../../../i18n';
import { pinWorld } from '../../../../lib/canvas/comments';
import { fmt } from '../../../../lib/format';
import { useCanvasComments, type CommentDraft } from '../../../../stores/canvasComments';
import { memberName } from '../../../../stores/workspaces';
import { MemberAvatar } from '../../../boards/menus';
import { previewText } from '../../../chat/mentionText';
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

/** Comments the hover card shows: the first one and the latest ones; the rest is a line pointing to the panel. */
const CARD_LATEST = 4;

/** One comment of the hover card; the author line only where the author changes. */
function CardRow({ id, workspaceId, head }: { id: string; workspaceId: string; head: boolean }): ReactNode {
  const c = useCanvasComments((s) => s.byId[id]);
  if (!c) return null;
  const ms = c.createdAt ? timestampMs(c.createdAt) : 0;
  return (
    <span className={cx('flex items-start gap-2', head && 'pt-1')}>
      <span className="w-6 shrink-0">{head ? <MemberAvatar workspaceId={workspaceId} userId={c.authorId} size={24} /> : null}</span>
      <span className="flex min-w-0 flex-col gap-0.5">
        {head ? (
          <span className="flex items-baseline gap-2">
            <span className="truncate font-semibold text-fg">{memberName(workspaceId, c.authorId)}</span>
            {ms ? <span className="shrink-0 text-faint">{fmt.relative(new Date(ms))}</span> : null}
          </span>
        ) : null}
        <span className="line-clamp-3 break-words text-fg">{previewText(workspaceId, c.body)}</span>
      </span>
    </span>
  );
}

/**
 * The hover card of a pin (Miro-style): the thread as a short dialogue — who wrote what and when. Mounted only while
 * shown; a long thread shows its first comment and the latest ones.
 */
function PinCard({ id, workspaceId }: { id: string; workspaceId: string }): ReactNode {
  const ids = useCanvasComments(useShallow((s) => [id, ...(s.replies[id] ?? EMPTY)]));
  const authors = useCanvasComments(useShallow((s) => ids.map((k) => s.byId[k]?.authorId ?? '')));
  const skipped = Math.max(0, ids.length - 1 - CARD_LATEST);
  const shown = skipped > 0 ? [0, ...ids.slice(-CARD_LATEST).map((_, i) => ids.length - CARD_LATEST + i)] : ids.map((_, i) => i);
  return (
    <span className="flex max-w-64 flex-col gap-1.5 py-1" data-testid="canvas-comment-pin-card">
      {shown.map((i, n) => {
        const prev = n > 0 ? shown[n - 1] : undefined;
        // After the gap the author is named again.
        const head = prev === undefined || prev !== i - 1 || authors[prev] !== authors[i];
        return (
          <span key={ids[i]} className="contents">
            {n === 1 && skipped > 0 ? <span className="pl-8 text-faint">{t('canvasComments.cardMore', { n: skipped })}</span> : null}
            <CardRow id={ids[i] ?? ''} workspaceId={workspaceId} head={head} />
          </span>
        );
      })}
    </span>
  );
}

const Pin = memo(function Pin({ id, workspaceId, engine, onPick }: { id: string; workspaceId: string; engine: CanvasEngine; onPick: (id: string) => void }): ReactNode {
  const c = useCanvasComments((s) => s.byId[id]);
  const replies = useCanvasComments((s) => s.replies[id]?.length ?? 0);
  const active = useCanvasComments((s) => s.active === id);
  const el = useRef<HTMLButtonElement | null>(null);
  // A callback ref as well: the hover card's lazy tooltip remounts the button on first hover, and the new node needs
  // its world point too.
  const attach = useCallback(
    (node: HTMLButtonElement | null) => {
      el.current = node;
      if (node) placePin(node, engine);
    },
    [engine],
  );
  useLayoutEffect(() => {
    if (el.current) placePin(el.current, engine);
  }, [engine, c?.objectId, c?.x, c?.y]);
  if (!c) return null;
  const author = memberName(workspaceId, c.authorId);
  return (
    <Tip label={<PinCard id={id} workspaceId={workspaceId} />} side="right">
      <button
        ref={attach}
        type="button"
        data-testid="canvas-comment-pin"
        data-comment-id={id}
        data-object-id={c.objectId || undefined}
        data-ox={c.x}
        data-oy={c.y}
        // The visible count is part of the name (a screen reader hears what is shown).
        aria-label={c.resolved ? `${t('canvasComments.pinLabel', { name: author })} · ${t('canvasComments.resolved')}` : `${replies + 1} · ${t('canvasComments.pinLabel', { name: author })}`}
        aria-pressed={active}
        style={PIN_STYLE}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => onPick(id)}
        className={cx(
          'pointer-events-auto absolute left-0 top-0 flex h-7 min-w-7 items-center gap-0.5 rounded-full rounded-bl-none border px-1.5 text-caption font-medium shadow-sm',
          // The thread open in the panel: filled, with a halo and above the other pins — the one pin that is «here».
          active
            ? 'z-[1] border-accent bg-accent-strong text-accent-fg shadow-[0_0_0_4px_color-mix(in_srgb,var(--color-accent)_35%,transparent)]'
            : 'border-line bg-main text-fg',
        )}
      >
        {/* A resolved thread stays where it was, as a tick; an open one always shows its count, «1» included. */}
        {c.resolved ? (
          <Check className="size-4 shrink-0" strokeWidth={2.25} aria-hidden data-testid="canvas-comment-pin-resolved" />
        ) : (
          <>
            <MessageCircle className="size-3.5 shrink-0" strokeWidth={2} aria-hidden />
            <span>{replies + 1}</span>
          </>
        )}
      </button>
    </Tip>
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
      // A new thread not yet sent: dashed and unfilled, so it never reads as the selected thread.
      className="absolute left-0 top-0 grid size-7 place-items-center rounded-full rounded-bl-none border border-dashed border-accent bg-main text-accent-text shadow-sm"
    >
      <MessageCirclePlus className="size-3.5" strokeWidth={2} aria-hidden />
    </div>
  );
}

/** Pins of the threads (resolved ones as ticks; with «Только открытые» only the open ones and the active one) and the draft's. */
export const CommentPins = memo(function CommentPins({
  engine, canvasId, workspaceId, onPick, layer,
}: {
  engine: CanvasEngine;
  canvasId: string;
  workspaceId: string;
  /** A pin clicked: its thread opens (a popover at the pin on the desktop, the panel on the phone). Stable. */
  onPick: (id: string) => void;
  /** The layer element, for the popover's anchor. */
  layer: RefObject<HTMLDivElement | null>;
}): ReactNode {
  const ids = useCanvasComments(useShallow((s) => (s.threads[canvasId] ?? EMPTY).filter((id) => !s.filterOpen || !s.byId[id]?.resolved || s.active === id)));
  const draft = useCanvasComments((s) => (s.draft?.canvasId === canvasId ? s.draft : null));
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
  }, [engine, layer]);
  return (
    <div ref={layer} className="pointer-events-none absolute left-0 top-0 z-[5] size-0 overflow-visible" data-testid="canvas-comment-pins">
      {ids.map((id) => (
        <Pin key={id} id={id} workspaceId={workspaceId} engine={engine} onPick={onPick} />
      ))}
      {draft ? <DraftPin draft={draft} engine={engine} /> : null}
    </div>
  );
});
