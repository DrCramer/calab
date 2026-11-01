import type { SipContact } from '@calaba/protocol';
import { dialKey, digitsOf, isExtensionLike } from '../../../lib/phoneNumber';

/**
 * What the dial pad suggests under the number (ADR-0137 §7): 2–6 digits that are a colleague's
 * internal number — «Анна Петрова · вн. 101» (an internal call, ADR-0034); otherwise a contact
 * whose number is the typed one or starts with it (8… and +7… alike), else a contact whose number
 * contains it; otherwise nothing (the line keeps its height).
 */

export interface ExtensionTarget {
  userId: string;
  name: string;
  number: string;
}

export type DialSuggestion =
  | { kind: 'ext'; userId: string; name: string; number: string }
  | { kind: 'contact'; contactId: string; name: string; company: string; number: string; exact: boolean };

export function suggestDial(typed: string, exts: readonly ExtensionTarget[], contacts: readonly SipContact[]): DialSuggestion | null {
  const raw = typed.trim();
  if (isExtensionLike(raw)) {
    const ext = exts.find((e) => e.number === raw);
    if (ext) return { kind: 'ext', ...ext };
  }
  const key = dialKey(raw);
  if (key.length < 3) return null;
  // A Russian mobile without the trunk prefix (9…, 10 digits) is +7 9… too.
  const keys = key.length === 10 && key.startsWith('9') ? [key, `7${key}`] : [key];
  let best: { rank: number; c: SipContact; number: string } | null = null;
  for (const c of contacts) {
    for (const p of c.phones) {
      const d = digitsOf(p.number);
      const rank = keys.includes(d) ? 3 : keys.some((k) => d.startsWith(k)) ? 2 : keys.some((k) => d.includes(k)) ? 1 : 0;
      if (rank > (best?.rank ?? 0)) best = { rank, c, number: p.number };
      if (rank === 3) break;
    }
    if (best?.rank === 3) break;
  }
  if (!best) return null;
  return { kind: 'contact', contactId: best.c.id, name: best.c.name, company: best.c.company, number: best.number, exact: best.rank === 3 };
}
