import { SipPhoneLabel, type SipContact } from '@calaba/protocol';
import type { MessageKey } from '../../../i18n/types';

/**
 * The phone book's pure parts (ADR-0137 §6–§7): what a contact is called in a row, the sticky
 * letter it goes under (А–Я, then A–Z, then «#»: the server's order is Cyrillic, Latin, the rest),
 * the groups of a loaded list, the number labels.
 */

/** The row's title: the name, else the company (one of them is always set). */
export const contactTitle = (c: Pick<SipContact, 'name' | 'company'>): string => c.name || c.company;

/** The second line: the company under a name (never the title again). */
export const contactSubtitle = (c: Pick<SipContact, 'name' | 'company'>): string => (c.name ? c.company : '');

/** The letter a contact is listed under: А–Я (Ё with Е), A–Z, «#» for the rest. */
export function contactLetter(c: Pick<SipContact, 'name' | 'company'>): string {
  const first = contactTitle(c).trim().charAt(0).toUpperCase();
  if (first === 'Ё') return 'Е';
  if (/[А-Я]/.test(first) || /[A-Z]/.test(first)) return first;
  return '#';
}

export interface LetterGroup {
  letter: string;
  ids: string[];
}

/**
 * The loaded list in letter groups, in the list's order (the server sorts); a letter met again
 * further down (a page boundary, an odd sort of the rest) joins its first group's run only when
 * adjacent — a header never repeats in a row.
 */
export function groupContacts(list: readonly Pick<SipContact, 'id' | 'name' | 'company'>[]): LetterGroup[] {
  const out: LetterGroup[] = [];
  for (const c of list) {
    const letter = contactLetter(c);
    const last = out.at(-1);
    if (last && last.letter === letter) last.ids.push(c.id);
    else out.push({ letter, ids: [c.id] });
  }
  return out;
}

export const PHONE_LABELS: readonly SipPhoneLabel[] = [SipPhoneLabel.MOBILE, SipPhoneLabel.WORK, SipPhoneLabel.HOME, SipPhoneLabel.OTHER];

/** «мобильный» / «рабочий» / «домашний» / «другой». */
export function labelKey(l: SipPhoneLabel): MessageKey {
  switch (l) {
    case SipPhoneLabel.MOBILE:
      return 'telc.label.mobile';
    case SipPhoneLabel.WORK:
      return 'telc.label.work';
    case SipPhoneLabel.HOME:
      return 'telc.label.home';
    default:
      return 'telc.label.other';
  }
}
