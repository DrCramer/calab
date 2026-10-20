/**
 * Comments on the open canvas (ADR-0114 wave 4): reads the threads once the view is open, turns a click of
 * the «Комментарий» tool into a new thread's pin, centres the camera on a thread a notification asked for
 * (once the document arrived: the first «fit all» of the view would undo it), and draws the pins and the
 * panel. Mounted inside the view's chrome; the canvas itself never re-renders for a comment.
 */
import { MessageSquare } from 'lucide-react';
import { memo, useEffect, useMemo, type ReactNode } from 'react';
import { IconButton, cx } from '../../../../components/ui';
import { plural, t, useLocale } from '../../../../i18n';
import { commentRights, pinAt, pinWorld } from '../../../../lib/canvas/comments';
import { loadComments } from '../../../../services/canvasComments';
import { useCanvas } from '../../../../stores/canvas';
import { openThreads, useCanvasComments } from '../../../../stores/canvasComments';
import { myUserId } from '../../../../stores/session';
import { toast } from '../../../../stores/toasts';
import type { CanvasEngine } from '../../engine';
import type { CanvasSync } from '../../../../lib/canvasSync';
import { CommentPins } from './CommentPins';
import { CommentsPanel } from './CommentsPanel';

export interface CommentsLayerProps {
  engine: CanvasEngine;
  sync: Pick<CanvasSync, 'getStatus' | 'subscribe'>;
  canvasId: string;
  workspaceId: string;
  /** `my_bits` of the canvas. */
  bits: bigint;
  phone?: boolean;
}

export const CommentsLayer = memo(function CommentsLayer({ engine, sync, canvasId, workspaceId, bits, phone = false }: CommentsLayerProps): ReactNode {
  const ownerId = useCanvas((s) => s.items[canvasId]?.ownerId ?? '');
  const me = myUserId();
  const rights = useMemo(() => commentRights(bits, ownerId, me), [bits, ownerId, me]);

  useEffect(() => {
    void loadComments(canvasId);
    return () => {
      const st = useCanvasComments.getState();
      if (st.draft?.canvasId === canvasId) st.setDraft(null);
    };
  }, [canvasId]);

  // A click of the «Комментарий» tool: the pin goes there, the panel opens on the new thread's input.
  useEffect(
    () =>
      engine.onCommentAt((c) => {
        if (!rights.write) return;
        const st = useCanvasComments.getState();
        st.setDraft({ canvasId, ...pinAt(c.world, c.objectId ? engine.scene.get(c.objectId) : undefined) });
        st.setActive(null);
        st.setPanel(true);
      }),
    [engine, canvasId, rights.write],
  );

  // A thread asked for from outside (a notification): centred once both the comments and the document are here.
  const focus = useCanvasComments((s) => (s.focus?.canvasId === canvasId ? s.focus.threadId : ''));
  const loaded = useCanvasComments((s) => !!s.loaded[canvasId]);
  useEffect(() => {
    if (!focus || !loaded) return undefined;
    let done = false;
    const go = (): void => {
      const st = sync.getStatus();
      if (done || (st !== 'synced' && st !== 'readonly')) return;
      done = true;
      off();
      const cs = useCanvasComments.getState();
      cs.setFocus(null);
      const c = cs.byId[focus];
      if (!c) {
        toast.info(t('canvasComments.gone'));
        return;
      }
      cs.setActive(focus);
      cs.setPanel(true);
      // After the view's own first «fit all», which runs on the same status change.
      queueMicrotask(() => {
        const p = pinWorld(c, (o) => engine.scene.get(o));
        if (p) engine.centerOn(p);
      });
    };
    const off = sync.subscribe(go);
    go();
    return () => {
      done = true;
      off();
    };
  }, [focus, loaded, sync, engine]);

  return (
    <>
      <CommentPins engine={engine} canvasId={canvasId} workspaceId={workspaceId} />
      <CommentsPanel canvasId={canvasId} workspaceId={workspaceId} rights={rights} engine={engine} phone={phone} />
    </>
  );
});

/** The panel's button with the count of open threads (in the zoom bar). */
export const CommentsToggle = memo(function CommentsToggle({ canvasId, focusCanvas }: { canvasId: string; focusCanvas?: () => void }): ReactNode {
  useLocale();
  const open = useCanvasComments((s) => s.panel);
  const count = useCanvasComments((s) => openThreads(s, canvasId));
  const label = count > 0 ? plural('canvasComments.toggleCount', count) : t('canvasComments.toggle');
  return (
    <span className="relative">
      <IconButton
        label={label}
        active={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          useCanvasComments.getState().setPanel(!open);
          focusCanvas?.();
        }}
        data-testid="canvas-comments-toggle"
      >
        <MessageSquare className="size-[18px]" strokeWidth={1.75} aria-hidden />
      </IconButton>
      {count > 0 ? (
        <span
          aria-hidden
          data-testid="canvas-comments-count"
          className={cx('pointer-events-none absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-accent-strong px-1 text-[10px] font-semibold leading-none text-accent-fg')}
        >
          {count > 99 ? '99+' : count}
        </span>
      ) : null}
    </span>
  );
});
