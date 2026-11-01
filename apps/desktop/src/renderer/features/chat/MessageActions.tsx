import type { PermissionBits } from '@calaba/protocol';
import { CornerUpLeft, Ellipsis, GripVertical, SmilePlus } from 'lucide-react';
import { useMemo, type DragEvent, type MouseEvent, type ReactNode } from 'react';
import { Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { MESSAGE_MIME, encodeDragged, setDraggedMessage } from '../../lib/messageDrag';
import { can } from '../../lib/permissions';
import { toggleReaction } from '../../services/chat';
import type { ChatMessage } from '../../stores/messages';
import { useUi } from '../../stores/ui';
import { useChatView } from './chatView';
import { EmojiPicker } from './EmojiPicker';
import { quickReactions } from './hoverIntent';
import { canToggleReaction, reactionLimitReached } from './reactionLimit';

/** Whether the bar has anything to offer (the same rules as the context menu, MessageMenu.tsx). */
export function hasMessageActions(c: ChatMessage): boolean {
  // «Переслать» (ADR-0033) is there for every sent message the reader sees.
  return c.status === 'sent';
}

export const actionBtn =
  'grid size-6 shrink-0 cursor-default place-items-center rounded-[5px] text-muted outline-offset-0 hover:bg-hover hover:text-fg';

/** The hover bar's box (an opaque popover, 28 px). */
export const ACTION_BAR = 'mat-popover anim-in pointer-events-auto flex h-7 shrink-0 select-none items-center gap-0.5 rounded-[var(--radius-card)] px-0.5';

/** «Ещё…»: a synthetic right click on the bubble opens its Radix context menu under the button. */
export function openMenuFrom(e: MouseEvent<HTMLButtonElement>): void {
  const r = e.currentTarget.getBoundingClientRect();
  e.currentTarget.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left, clientY: r.bottom + 4 }));
}

/**
 * Hover action bar of a message (docs/09 #47): quick reactions + picker, reply, «Ещё…» — the
 * last opens the very same context menu as a right click. Opaque popover, 28 px. Reactions and
 * reply follow SEND_MESSAGES, like the menu.
 */
export function MessageActions({
  c,
  roomId,
  perms,
  onPickerOpenChange,
}: {
  c: ChatMessage;
  roomId: string;
  perms: PermissionBits;
  onPickerOpenChange: (open: boolean) => void;
}): ReactNode {
  const m = c.msg;
  const canSend = can(perms, 'SEND_MESSAGES');
  const recent = useChatView((s) => s.recentEmoji);
  const quick = useMemo(() => quickReactions(recent), [recent]);
  // At the per-user limit (docs/09 #27) new emojis are dimmed with a hint; own ones stay removable.
  const limited = reactionLimitReached(m.reactions);
  const limitHint = limited ? t('chat.reactionLimit') : undefined;

  const react = (emoji: string): void => {
    useChatView.getState().pushRecent(emoji);
    void toggleReaction(roomId, m, emoji);
  };
  const more = openMenuFrom;

  // Drag by the grip (docs/05 «Заметки»): onto a notes shelf or a chat row → forwarded there. The
  // bar stays up for the drag (its source must stay mounted for dragend), like with the picker.
  const dragStart = (e: DragEvent<HTMLSpanElement>): void => {
    const d = { roomId, messageId: m.id };
    setDraggedMessage(d);
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData(MESSAGE_MIME, encodeDragged(d));
    if (m.content) e.dataTransfer.setData('text/plain', m.content);
    const ghost = dragGhost(m.content);
    e.dataTransfer.setDragImage(ghost, 14, 14);
    window.setTimeout(() => ghost.remove(), 0);
    onPickerOpenChange(true);
  };
  const dragEnd = (): void => {
    setDraggedMessage(null);
    onPickerOpenChange(false);
  };

  return (
    <div
      role="group"
      aria-label={t('chat.actions')}
      data-testid="message-actions"
      className={ACTION_BAR}
    >
      <Tip label={t('notes.drag')}>
        <span draggable onDragStart={dragStart} onDragEnd={dragEnd} aria-hidden data-testid="message-drag" className={cx(actionBtn, 'cursor-grab active:cursor-grabbing')}>
          <GripVertical className="size-4" />
        </span>
      </Tip>
      {canSend ? (
        <>
          {quick.map((e) => {
            const mine = m.reactions.some((r) => r.emoji === e && r.me);
            const blocked = !canToggleReaction(m.reactions, e);
            const button = (
              <button
                key={e}
                type="button"
                aria-label={t('chat.reactWith', { emoji: e })}
                aria-pressed={mine}
                aria-disabled={blocked || undefined}
                onClick={() => (blocked ? void toggleReaction(roomId, m, e) : react(e))}
                className={cx(
                  actionBtn,
                  'text-headline leading-none',
                  mine && 'bg-[color-mix(in_srgb,var(--color-accent)_22%,transparent)]',
                  blocked && 'opacity-40 hover:bg-transparent',
                )}
              >
                {e}
              </button>
            );
            return blocked && limitHint ? (
              <Tip key={e} label={limitHint}>
                {button}
              </Tip>
            ) : (
              button
            );
          })}
          <EmojiPicker
            onPick={(e) => void toggleReaction(roomId, m, e)}
            label={limitHint ?? t('chat.addReaction')}
            onOpenChange={onPickerOpenChange}
            closeOnPick
            canPick={(e) => canToggleReaction(m.reactions, e)}
            hint={limitHint}
          >
            <button type="button" aria-label={t('chat.addReaction')} className={actionBtn}>
              <SmilePlus className="size-4" aria-hidden />
            </button>
          </EmojiPicker>
          <span className="mx-0.5 h-4 w-px bg-line" aria-hidden />
          <Tip label={t('chat.reply')}>
            <button type="button" aria-label={t('chat.reply')} onClick={() => useUi.getState().setReply(roomId, m.id)} className={actionBtn}>
              <CornerUpLeft className="size-4" aria-hidden />
            </button>
          </Tip>
        </>
      ) : null}
      <Tip label={t('chat.more')}>
        <button type="button" aria-label={t('chat.more')} aria-haspopup="menu" onClick={more} className={actionBtn}>
          <Ellipsis className="size-4" aria-hidden />
        </button>
      </Tip>
    </div>
  );
}

/** The drag image of a message: a small opaque chip with the start of its text (in the DOM for one frame). */
function dragGhost(content: string): HTMLElement {
  const el = document.createElement('div');
  const text = content.replace(/\s+/g, ' ').trim();
  el.textContent = `💬 ${text ? (text.length > 48 ? `${text.slice(0, 48)}…` : text) : t('notes.dragGhost')}`;
  el.className = 'mat-popover rounded-[var(--radius-row)] px-2.5 py-1.5 text-caption text-fg';
  Object.assign(el.style, { position: 'fixed', top: '-1000px', left: '0', maxWidth: '280px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
  document.body.appendChild(el);
  return el;
}
