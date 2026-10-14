import { ContactField, MessageKind, type ContactSharedCard, type Message, type User } from '@calaba/protocol';
import { t } from '../i18n';

/**
 * Contact requests of bots (ADR-0100): a «Поделиться контактом» button in a bot's DM. The client
 * only shows what the bot will get and confirms; the server composes the contact from the profile.
 */

/** The contact share card of a system message, if it is one. */
export function contactSharedCardOf(m: Pick<Message, 'kind' | 'system'>): ContactSharedCard | null {
  if (m.kind !== MessageKind.SYSTEM) return null;
  const p = m.system?.payload;
  return p?.case === 'contactShared' ? p.value : null;
}

/** One line of the confirmation card: what the bot will get for a requested field. */
export interface ContactPreviewRow {
  field: ContactField;
  /** The value from my profile; '' = not set (nothing is sent for it). */
  value: string;
  verified: boolean;
}

/** The requested fields in the order PHONE, EMAIL with my profile's values (no duplicates). */
export function contactPreview(fields: readonly ContactField[], me: Pick<User, 'phone' | 'email' | 'emailVerified'> | undefined): ContactPreviewRow[] {
  const rows: ContactPreviewRow[] = [];
  // Phone verification does not exist yet (ADR-0100 §5): always «не подтверждён».
  if (fields.includes(ContactField.PHONE)) rows.push({ field: ContactField.PHONE, value: me?.phone ?? '', verified: false });
  if (fields.includes(ContactField.EMAIL)) rows.push({ field: ContactField.EMAIL, value: me?.email ?? '', verified: !!me?.email && me.emailVerified });
  return rows;
}

/** «телефон, почта»: the names of the shared fields, lower case. */
export function contactFieldList(fields: readonly ContactField[]): string {
  return fields
    .map((f) => (f === ContactField.PHONE ? t('contact.fieldPhoneLower') : f === ContactField.EMAIL ? t('contact.fieldEmailLower') : ''))
    .filter(Boolean)
    .join(', ');
}

/** The service line of a share: «Вы поделились контактом с @bot: телефон, почта». */
export function contactSharedText(card: ContactSharedCard, mine: boolean, authorName: string, botName: string): string {
  const params = { name: authorName, bot: botName, fields: contactFieldList(card.fields) };
  return mine ? t('contact.sharedMine', params) : t('contact.sharedOther', params);
}

/**
 * Whether I already shared through this button: a card of mine for it among the loaded messages
 * after the bot's message (the card always follows it). Scans back from the newest row.
 */
export function sharedThroughButton(items: readonly { msg: Message }[], messageId: string, buttonId: string, me: string): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const m = items[i]?.msg;
    if (!m) continue;
    if (m.id && m.id <= messageId) return false;
    const card = contactSharedCardOf(m);
    if (card && m.authorId === me && card.messageId === messageId && card.buttonId === buttonId) return true;
  }
  return false;
}
