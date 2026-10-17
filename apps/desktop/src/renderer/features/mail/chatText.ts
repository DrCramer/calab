import type { MailAttachment, MailMessage } from '../../../shared/mail';
import { t } from '../../i18n';
import { addressFull, mailHeaderTime } from './format';

/**
 * «Отправить в чат…» (owner 14.10): the chat message is the mail's plain text with a short header,
 * plus the mail's real attachments (never the .eml). Pure.
 */

/** The chat's message length limit (server `MaxContent`, = `MAX_CONTENT` in services/chat). */
export const CHAT_LIMIT = 4000;

const BLOCKS = new Set(['p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'table', 'ul', 'ol', 'hr']);

/** Text of an HTML body: scripts/styles dropped, block elements become line breaks. Inert DOM, nothing runs or loads. */
export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,head,template').forEach((n) => n.remove());
  const out: string[] = [];
  const walk = (n: Node): void => {
    if (n.nodeType === 3) {
      out.push((n.textContent ?? '').replace(/\s+/g, ' '));
      return;
    }
    if (n.nodeType !== 1) return;
    const tag = (n as Element).tagName.toLowerCase();
    if (tag === 'br') {
      out.push('\n');
      return;
    }
    const block = BLOCKS.has(tag);
    if (block) out.push('\n');
    n.childNodes.forEach(walk);
    if (block) out.push('\n');
  };
  walk(doc.body);
  return out
    .join('')
    .replace(/[ \t\u00a0]*\n[ \t\u00a0]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Drops the trailing signature block that starts at the last «-- » line. */
export function stripSignature(text: string): string {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i > 0; i--) {
    if (/^--[ \u00a0]?$/.test(lines[i] ?? '')) return lines.slice(0, i).join('\n').trimEnd();
  }
  return text;
}

/** The message body as chat text: text/plain, else the HTML as text, else the snippet; signature trimmed. */
export function bodyText(m: Pick<MailMessage, 'text' | 'html' | 'snippet'>): string {
  const raw = m.text?.trim() ? m.text : m.html ? htmlToText(m.html) : m.snippet;
  return stripSignature(
    raw
      .replace(/\r\n?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );
}

/**
 * «✉️ **Тема**», «От: Имя <addr> · дата», a blank line and the body. Longer than `limit`: cut with
 * «…» and the note «(письмо сокращено)»; the result never exceeds `limit`.
 */
export function chatText(m: Pick<MailMessage, 'subject' | 'from' | 'date' | 'text' | 'html' | 'snippet'>, limit = CHAT_LIMIT): string {
  const head = `✉️ **${m.subject.trim() || t('mbox.noSubject')}**\n${t('mbox.from')}: ${addressFull(m.from)} · ${mailHeaderTime(m.date)}`;
  const text = bodyText(m);
  if (!text) return head.slice(0, limit);
  const full = `${head}\n\n${text}`;
  if (full.length <= limit) return full;
  const note = `\n\n${t('mbox.chat.cut')}`;
  const room = Math.max(0, limit - note.length - 1);
  return `${full.slice(0, room).trimEnd()}…${note}`;
}

/** What fits into one chat message: at most `maxCount` files of at most `maxBytes` each; the rest is skipped. */
export function planAttachments<T extends { size: number }>(list: readonly T[], maxCount: number, maxBytes: number): { take: T[]; skipped: T[] } {
  const take: T[] = [];
  const skipped: T[] = [];
  for (const a of list) (a.size <= maxBytes && take.length < maxCount ? take : skipped).push(a);
  return { take, skipped };
}

/** Attachments worth sending: regular files. Images used as `cid:` furniture of the HTML are not. */
export function chatAttachments(m: Pick<MailMessage, 'attachments' | 'html'>): MailAttachment[] {
  const html = (m.html ?? '').toLowerCase();
  return m.attachments.filter((a) => {
    if (!a.cid) return !a.inline;
    return !a.inline && !html.includes(`cid:${a.cid.toLowerCase()}`);
  });
}
