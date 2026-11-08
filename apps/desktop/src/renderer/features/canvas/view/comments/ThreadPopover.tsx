/**
 * A thread in its own window at its pin (owner 30.10, Miro-style), on the desktop: a pin's click opens it, a click of
 * the «Комментарий» tool opens it on a new thread's field. «Решено», the comments and the reply field; the panel
 * stays the list of all threads. It closes on Esc, a click elsewhere and a pan or zoom (it would float off its pin —
 * following the camera every frame would cost a frame loop while it is open).
 */
import * as Popover from '@radix-ui/react-popover';
import { X } from 'lucide-react';
import { memo, useEffect, useMemo, type ReactNode, type RefObject } from 'react';
import { IconButton, Toggle, cx } from '../../../../components/ui';
import { t, useLocale } from '../../../../i18n';
import { sameCamera } from '../../../../lib/canvas/camera';
import { createThread, resolveThread } from '../../../../services/canvasComments';
import { useCanvasComments } from '../../../../stores/canvasComments';
import { MENU_BOX } from '../chrome';
import { CommentInput } from './CommentInput';
import { ThreadBody, type Ctx } from './CommentsPanel';

/** Closes the popover: the draft is dropped, the pin loses its highlight unless the panel shows the thread. */
function closePopover(focusCanvas: () => void): void {
  const st = useCanvasComments.getState();
  st.setPinOpen(false);
  st.setDraft(null);
  if (!st.panel) st.setActive(null);
  focusCanvas();
}

function ThreadHeader({ id, ctx, onClose }: { id: string; ctx: Ctx; onClose: () => void }): ReactNode {
  const resolved = useCanvasComments((s) => !!s.byId[id]?.resolved);
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line pl-4 pr-2">
      {ctx.rights.write || ctx.rights.moderate ? (
        <label className="flex items-center gap-2">
          <Toggle checked={resolved} onChange={(v) => void resolveThread(id, v)} label={t('canvasComments.resolved')} />
          <span className={cx('text-caption', resolved ? 'text-success' : 'text-muted')}>{t('canvasComments.resolved')}</span>
        </label>
      ) : resolved ? (
        <span className="text-caption text-success">{t('canvasComments.resolved')}</span>
      ) : null}
      <span className="flex-1" />
      <IconButton size="sm" label={t('common.close')} onClick={onClose} data-testid="canvas-comment-popover-close">
        <X className="size-4" aria-hidden />
      </IconButton>
    </div>
  );
}

export const ThreadPopover = memo(function ThreadPopover({
  ctx, layer, focusCanvas,
}: {
  ctx: Ctx;
  /** The pins' layer: the popover is anchored to the pin element in it. */
  layer: RefObject<HTMLDivElement | null>;
  focusCanvas: () => void;
}): ReactNode {
  useLocale();
  const open = useCanvasComments((s) => s.pinOpen);
  const active = useCanvasComments((s) => (s.pinOpen && s.active && s.byId[s.active] ? s.active : null));
  const draft = useCanvasComments((s) => (s.pinOpen && s.draft?.canvasId === ctx.canvasId ? s.draft : null));
  const target = draft ? 'draft' : active;
  const { engine } = ctx;

  useEffect(() => {
    if (!open) return undefined;
    const cam = engine.camera;
    return engine.subscribeView(() => {
      if (!sameCamera(cam, engine.camera)) closePopover(focusCanvas);
    });
  }, [open, engine, focusCanvas]);

  const pinSel = target === 'draft' ? '[data-testid="canvas-comment-draft-pin"]' : `[data-comment-id="${CSS.escape(target ?? '')}"]`;
  // The pin element, read when the popover places itself (pins move without React); its last place if it is gone.
  const anchor = useMemo(() => {
    const last = { rect: new DOMRect() };
    return {
      current: {
        getBoundingClientRect: (): DOMRect => {
          const el = layer.current?.querySelector<HTMLElement>(pinSel);
          if (el && !el.hidden) last.rect = el.getBoundingClientRect();
          return last.rect;
        },
      },
    };
  }, [pinSel, layer]);
  // The object the pin sits on went away (deleted by someone): the window closes rather than float off.
  useEffect(() => {
    if (!target) return undefined;
    return engine.scene.subscribe(() => {
      const el = layer.current?.querySelector<HTMLElement>(pinSel);
      if (!el || el.hidden) closePopover(focusCanvas);
    });
  }, [target, pinSel, layer, engine, focusCanvas]);

  if (!target) return null;
  const close = (): void => closePopover(focusCanvas);
  return (
    <Popover.Root
      open
      onOpenChange={(o) => {
        if (!o) close();
      }}
    >
      <Popover.Anchor virtualRef={anchor} />
      <Popover.Portal>
        <Popover.Content
          key={draft ? `draft:${draft.objectId}:${draft.x}:${draft.y}` : target}
          side="right"
          align="start"
          sideOffset={10}
          collisionPadding={12}
          // Concentric with the composer's pill inside (its 20 px radius + the 8 px padding around it).
          className={cx(MENU_BOX, 'flex max-h-[min(70vh,520px)] w-[340px] flex-col overflow-hidden rounded-[28px] p-0')}
          aria-label={t('canvasComments.title')}
          data-testid="canvas-comment-popover"
          // The field inside takes the focus itself (CommentInput autoFocus).
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            // Another click of the «Комментарий» tool places the next pin: the popover moves there instead of closing.
            if (e.target === engine.canvas && engine.tool === 'comment') e.preventDefault();
          }}
        >
          {draft ? (
            <CommentInput
              canvasId={ctx.canvasId}
              workspaceId={ctx.workspaceId}
              placeholder={t('canvasComments.newPlaceholder')}
              autoFocus
              onEscape={close}
              className="p-2"
              onSubmit={async (wire) => {
                const c = await createThread(ctx.canvasId, wire, draft);
                if (!c) return false;
                const st = useCanvasComments.getState();
                st.setDraft(null);
                st.setActive(c.id);
                return true;
              }}
            />
          ) : active ? (
            <>
              <ThreadHeader id={active} ctx={ctx} onClose={close} />
              <ThreadBody id={active} ctx={ctx} reply autoFocus scroll />
            </>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
});
