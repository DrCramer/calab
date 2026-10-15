import { ContactField } from '@calaba/protocol';
import { CheckCircle2, CircleAlert } from 'lucide-react';
import { memo, useState, type ReactNode } from 'react';
import { Button, Modal } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { ApiError } from '../../lib/api/client';
import { api } from '../../lib/api/endpoints';
import { contactPreview, type ContactPreviewRow } from '../../lib/contactRequest';
import { useMessages } from '../../stores/messages';
import { useSession } from '../../stores/session';

export type ContactShareResult = 'sent' | 'already' | 'unavailable';

/**
 * «Поделиться контактом» (ADR-0100 §2): what the bot will get from my profile — each requested
 * field with its value and whether it is verified, «не указан» for an empty one (not sent) — and
 * the bot's reason. Nothing leaves until «Поделиться»; the server composes the contact itself.
 * A Modal: a centred card on the phone, a dialog on the desktop.
 */
export const ContactRequestDialog = memo(function ContactRequestDialog({ open, onClose, onDone, messageId, buttonId, fields, reason, botName }: {
  open: boolean;
  onClose: () => void;
  onDone: (result: ContactShareResult) => void;
  messageId: string;
  buttonId: string;
  fields: readonly ContactField[];
  reason: string;
  botName: string;
}): ReactNode {
  useLocale();
  const phone = useSession((s) => s.me?.user?.phone ?? '');
  const email = useSession((s) => s.me?.email ?? '');
  const emailVerified = useSession((s) => !!s.me?.emailVerified);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const rows = contactPreview(fields, { phone, email, emailVerified });
  const empty = rows.every((r) => !r.value);

  async function share(): Promise<void> {
    if (busy || empty) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.messages.shareContact(messageId, buttonId);
      if (r.message) useMessages.getState().upsert(r.message, { rest: true });
      onDone('sent');
    } catch (e) {
      const why = e instanceof ApiError ? (e.extra.reason ?? '') : '';
      if (why === 'CONTACT_ALREADY_SHARED') onDone('already');
      else if (e instanceof ApiError && (e.status === 403 || e.status === 404 || why === 'BUTTON_UNAVAILABLE')) onDone('unavailable');
      else setError(why === 'CONTACT_SHARE_LIMIT' ? t('contact.limit') : why === 'CONTACT_EMPTY' ? t('contact.nothing') : t('contact.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('contact.title')}
      closeButton={false}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} autoFocus>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={() => void share()} disabled={busy || empty} data-testid="contact-share">{t('contact.share')}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" data-testid="contact-request">
        <p className="text-muted">{t('contact.botWillGet', { bot: botName })}</p>
        <ul className="flex flex-col gap-2">
          {rows.map((r) => <PreviewRow key={r.field} row={r} />)}
        </ul>
        {reason ? <p className="whitespace-pre-line break-words text-muted [overflow-wrap:anywhere]">{t('contact.reason', { reason })}</p> : null}
        {empty ? <p className="text-caption text-muted">{t('contact.nothing')}</p> : rows.some((r) => !r.value) ? <p className="text-caption text-muted">{t('contact.notSentHint')}</p> : null}
        {error ? <p role="alert" className="text-caption text-danger-text">{error}</p> : null}
      </div>
    </Modal>
  );
});

function PreviewRow({ row }: { row: ContactPreviewRow }): ReactNode {
  const phone = row.field === ContactField.PHONE;
  const status = !row.value
    ? t(phone ? 'contact.phoneMissing' : 'contact.emailMissing')
    : row.verified
      ? t(phone ? 'contact.phoneVerified' : 'contact.emailVerified')
      : t(phone ? 'contact.phoneUnverified' : 'contact.emailUnverified');
  return (
    <li className="flex min-w-0 items-start gap-2 rounded-[var(--radius-control)] bg-[var(--color-fill)] px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-caption text-muted">{t(phone ? 'contact.fieldPhone' : 'contact.fieldEmail')}</div>
        <div className={row.value ? 'break-words [overflow-wrap:anywhere]' : 'text-muted'}>{row.value || status}</div>
      </div>
      {row.value ? (
        <span className="flex shrink-0 items-center gap-1 pt-0.5 text-caption text-muted">
          {row.verified
            ? <CheckCircle2 aria-hidden className="size-3.5 text-ok" />
            : <CircleAlert aria-hidden className="size-3.5" />}
          {status}
        </span>
      ) : null}
    </li>
  );
}
