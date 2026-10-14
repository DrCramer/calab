import type { ContactSharedCard } from '@calaba/protocol';
import { Phone } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { contactSharedText } from '../../lib/contactRequest';
import { useSession } from '../../stores/session';
import { useMemberName, useWorkspaces } from '../../stores/workspaces';

/**
 * «Вы поделились контактом с @bot: телефон, почта» (ADR-0100 §4): a centred service line in the
 * DM with the bot, like RoomIconLine — the person's receipt. Field names only, never the values.
 */
export const ContactSharedLine = memo(function ContactSharedLine({ card, authorId, workspaceId }: { card: ContactSharedCard; authorId: string; workspaceId: string }): ReactNode {
  const me = useSession((s) => s.me?.user?.id ?? '');
  const name = useMemberName(workspaceId || null, authorId);
  const username = useWorkspaces((s) => s.users[card.botUserId]?.username ?? '');
  const display = useWorkspaces((s) => s.users[card.botUserId]?.displayName ?? '');
  const text = contactSharedText(card, authorId === me, name, username ? `@${username}` : display);
  return (
    <div className="flex justify-center py-1" data-testid="contact-shared-line">
      <div className="flex min-w-0 max-w-full items-center gap-2 rounded-full bg-[var(--color-fill)] px-3 py-1 text-caption text-muted">
        <Phone aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{text}</span>
      </div>
    </div>
  );
});
