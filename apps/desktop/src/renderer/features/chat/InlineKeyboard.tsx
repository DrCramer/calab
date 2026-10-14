import { InlineButtonKind, type InlineButton, type InlineKeyboard } from '@calaba/protocol';
import { Check, Phone } from 'lucide-react';
import { memo, useRef, useState, type ReactNode } from 'react';
import { Button } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { ApiError } from '../../lib/api/client';
import { api } from '../../lib/api/endpoints';
import { sharedThroughButton } from '../../lib/contactRequest';
import { messageById, useMessages } from '../../stores/messages';
import { useSession } from '../../stores/session';
import { useWorkspaces } from '../../stores/workspaces';
import { ContactRequestDialog, type ContactShareResult } from './ContactRequestDialog';

/** Local interaction state: pressing a button never updates the feed or neighbouring rows. */
export const InlineKeyboardView = memo(function InlineKeyboardView({ messageId, roomId, botId, revision, keyboard, canSend }: {
  messageId: string;
  roomId: string;
  /** The message's author (the bot): named in a contact request. */
  botId: string;
  revision: bigint;
  keyboard: InlineKeyboard;
  canSend: boolean;
}): ReactNode {
  useLocale();
  const me = useSession((s) => s.me?.user?.id ?? '');
  const [pending, setPending] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [feedback, setFeedback] = useState<'sent' | 'failed' | 'stale' | 'forbidden' | null>(null);
  const busy = useRef(false);
  // A network timeout may have happened after commit. Retry the same press, not a new effect.
  const nonces = useRef(new Map<string, string>());
  const allowed = canSend && (!keyboard.allowedUserIds.length || keyboard.allowedUserIds.includes(me));

  async function press(buttonId: string): Promise<void> {
    if (busy.current || accepted) return;
    busy.current = true;
    setPending(true);
    setFeedback(null);
    let nonce = nonces.current.get(buttonId);
    if (!nonce) { nonce = crypto.randomUUID(); nonces.current.set(buttonId, nonce); }
    try {
      await api.messages.interact(messageId, { buttonId, keyboardRevision: revision, nonce });
      setAccepted(true);
      setFeedback('sent');
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await refresh();
      }
      setFeedback(error instanceof ApiError && error.status === 409 ? 'stale' : error instanceof ApiError && (error.status === 403 || error.status === 404) ? 'forbidden' : 'failed');
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  async function refresh(): Promise<void> {
    try {
      const fresh = await api.messages.get(roomId, messageId);
      const state = useMessages.getState();
      const current = messageById(state, roomId, messageId);
      // A delayed REST result must not overwrite a newer event or resurrect a deleted row.
      if (current && fresh.keyboardRevision >= current.keyboardRevision) state.upsert(fresh, { rest: true });
    } catch { setFeedback('stale'); }
  }

  return (
    <div className="mt-1 flex min-w-0 flex-col gap-1" data-testid="inline-keyboard" role="group" aria-label={t('chat.inlineActions')}>
      {keyboard.rows.map((row, index) => (
        <div key={index} className="flex min-w-0 flex-wrap gap-1">
          {row.buttons.map((button) => button.kind === InlineButtonKind.REQUEST_CONTACT ? (
            <ContactButton key={button.id} button={button} messageId={messageId} roomId={roomId} botId={botId} allowed={allowed} />
          ) : (
            <Button key={button.id} variant="secondary" className="h-auto min-h-8 min-w-0 flex-1 whitespace-normal break-words px-3 py-1.5 text-center mobile:min-h-11 mobile:py-2 [overflow-wrap:anywhere]"
              disabled={!allowed || pending || button.disabled || accepted || feedback === 'stale' || feedback === 'forbidden'}
              onClick={(event) => { event.stopPropagation(); void press(button.id); }}
              onKeyDown={(event) => event.stopPropagation()}
            >{button.label}</Button>
          ))}
        </div>
      ))}
      {feedback === 'stale' ? <Button variant="ghost" onClick={(event) => { event.stopPropagation(); void refresh(); }}>{t('chat.inlineRefresh')}</Button> : null}
      <span role="status" aria-live="polite" className="text-caption text-muted">
        {pending ? t('chat.inlinePending') : feedback === 'sent' ? t('chat.inlineSent') : feedback === 'failed' ? t('chat.inlineFailed') : feedback === 'stale' ? t('chat.inlineStale') : feedback === 'forbidden' ? t('chat.inlineForbidden') : !allowed ? t('chat.inlineForbidden') : null}
      </span>
    </div>
  );
});

/**
 * «Поделиться контактом» (ADR-0100): a phone icon before the label; a tap opens the confirmation.
 * After a share — «Отправлено» (also from my card in the DM after a reload); independent of the
 * callback buttons of the same keyboard.
 */
const ContactButton = memo(function ContactButton({ button, messageId, roomId, botId, allowed }: {
  button: InlineButton;
  messageId: string;
  roomId: string;
  botId: string;
  allowed: boolean;
}): ReactNode {
  const me = useSession((s) => s.me?.user?.id ?? '');
  const sharedInFeed = useMessages((s) => sharedThroughButton(s.rooms[roomId]?.items ?? [], messageId, button.id, me));
  const botUsername = useWorkspaces((s) => s.users[botId]?.username ?? '');
  const botDisplay = useWorkspaces((s) => s.users[botId]?.displayName ?? '');
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<ContactShareResult | null>(null);
  const sent = sharedInFeed || result === 'sent' || result === 'already';
  const done = (r: ContactShareResult): void => {
    setResult(r);
    setOpen(false);
  };
  return (
    <>
      <Button variant="secondary" className="h-auto min-h-8 min-w-0 flex-1 gap-1.5 whitespace-normal break-words px-3 py-1.5 text-center mobile:min-h-11 mobile:py-2 [overflow-wrap:anywhere]"
        data-testid="contact-button"
        disabled={!allowed || button.disabled || sent || result === 'unavailable'}
        onClick={(event) => { event.stopPropagation(); setOpen(true); }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {sent ? <Check aria-hidden className="size-4 shrink-0" /> : <Phone aria-hidden className="size-4 shrink-0" />}
        {sent ? t('chat.contactSent') : button.label}
      </Button>
      {result === 'unavailable' ? <span role="status" className="sr-only">{t('contact.unavailable')}</span> : null}
      {open ? (
        <ContactRequestDialog open onClose={() => setOpen(false)} onDone={done} messageId={messageId} buttonId={button.id}
          fields={button.fields} reason={button.reason} botName={botUsername ? `@${botUsername}` : botDisplay} />
      ) : null}
    </>
  );
});
