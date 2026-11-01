/**
 * The two read markers of a room the client moves (ADR-0140): `read` — unread counters
 * (any «mark as read»), `seen` — the message was on screen (the feed's bottom, a card's last
 * comment), behind the others' ✓✓ and «Прочитали». Ids are uuidv7: string order = message order.
 * Pure: `services/chat.ts` keeps one `Marks` per room for what is pending and what was sent.
 */
export interface Marks {
  read: string;
  seen: string;
}

export interface ReadRequest {
  messageId: string;
  seen: boolean;
}

export const NO_MARKS: Marks = { read: '', seen: '' };

const maxId = (a: string, b: string): string => (a > b ? a : b);

/** `id` marked read (and seen): markers only move forward; seen implies read. */
export function addMark(p: Marks, id: string, seen: boolean): Marks {
  const read = maxId(p.read, id);
  const s = seen ? maxId(p.seen, id) : p.seen;
  return read === p.read && s === p.seen ? p : { read, seen: s };
}

/**
 * What to send for `pending` after `sent`: nothing when neither marker would move; one request
 * when the seen marker reaches the read one (it moves both); otherwise the seen part first, then
 * the read-only rest.
 */
export function planFlush(sent: Marks, pending: Marks): ReadRequest[] {
  const out: ReadRequest[] = [];
  const seen = pending.seen > sent.seen;
  if (seen) out.push({ messageId: pending.seen, seen: true });
  const readTo = seen ? maxId(sent.read, pending.seen) : sent.read;
  if (pending.read > readTo) out.push({ messageId: pending.read, seen: false });
  return out;
}

/** The markers after the requests of planFlush went out. */
export function afterFlush(sent: Marks, pending: Marks): Marks {
  return { read: maxId(sent.read, maxId(pending.read, pending.seen)), seen: maxId(sent.seen, pending.seen) };
}
