import { timestampDate } from '@bufbuild/protobuf/wkt';
import { RoomType } from '@calaba/protocol';
import { useQuery } from '@tanstack/react-query';
import { Check, CheckCheck } from 'lucide-react';
import { memo, useState, type ReactNode } from 'react';
import * as Popover from '../../components/radix/popover';
import { Spinner } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { fmt } from '../../lib/format';
import { TICKS_NONE, TICKS_SENT, useReadReceipt } from '../../stores/readReceipts';
import { useRooms } from '../../stores/rooms';
import { useMemberName } from '../../stores/workspaces';
import { MemberAvatar } from '../boards/menus';

/**
 * docs/08 «Галочки» (docs/09 #92, ADR-0140): ✓ — the server has the message, ✓✓ — someone else saw
 * it on screen (the DM peer / another member). Nothing before read receipts started. A leaf with a
 * numeric selector: a READ_RECEIPT re-renders only the ticks it flips, not the bubble or the feed.
 * In a chat of several people ✓✓ is a button with «Прочитали»; `spacer` (the bubble's invisible
 * copy of the time that reserves its room) draws the same box without the button.
 */
export const Ticks = memo(function Ticks({ roomId, messageId, workspaceId, spacer = false }: { roomId: string; messageId: string; workspaceId: string; spacer?: boolean }): ReactNode {
  const state = useReadReceipt(roomId, messageId);
  const type = useRooms((s) => s.byId[roomId]?.type);
  // A notes shelf (ADR-0039) has no readers: no ticks at all.
  if (type === RoomType.NOTES || state === TICKS_NONE) return null;
  if (state === TICKS_SENT) return <Check className="size-4" aria-label={t('chat.statusSent')} />;
  if (type === RoomType.DM || spacer) return <CheckCheck className="size-4" aria-label={t('chat.statusRead')} />;
  return <ReadersButton roomId={roomId} messageId={messageId} workspaceId={workspaceId} />;
});

/** ✓✓ of a chat of several people: a tap opens «Прочитали» (the list loads only while open). */
function ReadersButton({ roomId, messageId, workspaceId }: { roomId: string; messageId: string; workspaceId: string }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={t('chat.statusRead')}
          data-inline-target
          data-testid="read-ticks"
          // The bubble's own press (menu, swipe, selection) stays out of it.
          onPointerDown={(e) => e.stopPropagation()}
          className="-m-1 inline-grid place-items-center rounded-[4px] p-1 text-inherit outline-none hover:bg-[var(--color-fill)] focus-visible:ring-2 focus-visible:ring-accent"
        >
          <CheckCheck className="size-4" aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="end"
          sideOffset={6}
          collisionPadding={12}
          className="mat-popover anim-in z-[var(--z-popover)] w-72 rounded-[var(--radius-card)] p-1 text-body text-fg"
          data-testid="read-by-popover"
        >
          {open ? <ReadersList roomId={roomId} messageId={messageId} workspaceId={workspaceId} /> : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * «Прочитали» (ADR-0140): who saw my message and when, oldest first — GET …/readers, the author
 * only (the server answers 403 to anyone else). Shared by the ✓✓ popover and the message menu.
 */
export function ReadersList({ roomId, messageId, workspaceId, title = true }: { roomId: string; messageId: string; workspaceId: string; title?: boolean }): ReactNode {
  const q = useQuery({
    queryKey: ['message-readers', messageId],
    queryFn: ({ signal }) => api.messages.readers(roomId, messageId, signal),
    staleTime: 0,
  });
  const readers = q.data?.readers ?? [];
  return (
    // A group, not a list: inside the message menu only menu roles may be its children.
    <div role="group" aria-label={t('chat.readBy')} className="flex flex-col" data-testid="read-by">
      {title ? <div className="px-2.5 pb-1 pt-1.5 text-caption font-medium text-muted" aria-hidden>{t('chat.readBy')}</div> : null}
      {q.isPending ? (
        <div className="grid h-9 place-items-center">
          <Spinner className="size-4" />
        </div>
      ) : q.isError || !readers.length ? (
        <div className="px-2.5 pb-2 pt-0.5 text-caption text-faint">{q.isError ? t('err.ctx.loadMessage') : t('chat.readByNone')}</div>
      ) : (
        <div className="max-h-64 overflow-y-auto">
          {readers.map((r) => (
            <ReaderRow key={r.userId} workspaceId={workspaceId} userId={r.userId} at={r.readAt ? timestampDate(r.readAt) : null} />
          ))}
        </div>
      )}
    </div>
  );
}

/** «сегодня в 14:05» / «3 окт. 14:05» — short enough to sit beside a name (like Telegram). */
export function readTime(at: Date, now = new Date()): string {
  return at.toDateString() === now.toDateString() ? fmt.stamp(at, now) : `${fmt.dayMonth(at)} ${fmt.time(at)}`;
}

function ReaderRow({ workspaceId, userId, at }: { workspaceId: string; userId: string; at: Date | null }): ReactNode {
  const name = useMemberName(workspaceId || null, userId);
  return (
    <div className="flex h-9 items-center gap-2 rounded-[6px] px-2.5" data-testid="read-by-row">
      <MemberAvatar workspaceId={workspaceId} userId={userId} size={24} />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {at ? <span className="shrink-0 text-caption text-muted tabular-nums">{readTime(at)}</span> : null}
    </div>
  );
}
