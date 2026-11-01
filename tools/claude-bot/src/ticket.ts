// Daemon side of the handoff tickets: a ticket is issued for one run (a wake run or a chat answer), names
// who the requests are recorded for and which chat messages the run may answer, and is removed when the
// run ends. Only the daemon writes tickets; the run gets the ticket id in an env var it cannot change.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gate, type MemberLike } from './gate.js';
import { cleanName, ID_RE, SAFE_ID_RE, ticketDir, type Requester, type Ticket, type TicketSource, type TicketTools } from './inbox.js';

/** The requester of a wake run's own requests (no chat author behind them). */
export const WAKE_REQUESTER: Requester = { userId: 'mr-claude-wake', name: 'Mr.Claude (wake)' };

export interface SourceInput {
  ref: string;
  member: MemberLike | null | undefined;
  name: string;
  roomId: string;
  /** The chat context for the run, saved as `<ref>.txt` (already framed as untrusted). */
  context: string;
}

/**
 * Issues a ticket. Every chat source passes the gate again (a full member of the board's workspace);
 * one that does not is dropped, so the run cannot record or reply on its behalf.
 */
export function issueTicket(opts: {
  inboxDir: string;
  workspaceId: string;
  requester: Requester;
  roomId: string;
  sources: SourceInput[];
  ttlMs: number;
  now: number;
  tools?: TicketTools;
}): { id: string; ticket: Ticket } {
  const id = randomBytes(16).toString('hex');
  const dir = ticketDir(opts.inboxDir, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sources: Record<string, TicketSource> = {};
  for (const s of opts.sources) {
    const userId = s.member?.user?.id ?? '';
    if (!gate(s.member, opts.workspaceId).ok || !SAFE_ID_RE.test(userId) || !SAFE_ID_RE.test(s.roomId) || !/^chat-\d{1,3}$/.test(s.ref)) continue;
    sources[s.ref] = { userId, name: cleanName(s.name), roomId: s.roomId };
    writeFileSync(join(dir, `${s.ref}.txt`), s.context, { mode: 0o600 });
  }
  const ticket: Ticket = {
    v: 1,
    requester: { userId: opts.requester.userId, name: cleanName(opts.requester.name) },
    roomId: SAFE_ID_RE.test(opts.roomId) ? opts.roomId : '-',
    sources,
    expiresAt: opts.now + opts.ttlMs,
    ...(opts.tools ? { tools: opts.tools } : {}),
  };
  writeFileSync(join(dir, 'ticket.json'), JSON.stringify(ticket), { mode: 0o600 });
  return { id, ticket };
}

/** Ids of the requests the run recorded. */
export function createdBy(inboxDir: string, id: string): string[] {
  try {
    return readFileSync(join(ticketDir(inboxDir, id), 'created'), 'utf8').split('\n').filter((l) => ID_RE.test(l));
  } catch {
    return [];
  }
}

/** Replies waiting to be posted, oldest first; each is removed as it is taken. */
export function takeReplies(inboxDir: string, id: string): { ref: string; text: string }[] {
  const dir = join(ticketDir(inboxDir, id), 'replies');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: { ref: string; text: string }[] = [];
  for (const n of names.filter((x) => /^chat-\d{1,3}\.\d+-[0-9a-f]{4}\.txt$/.test(x)).sort((a, b) => Number(a.split('.')[1]?.split('-')[0]) - Number(b.split('.')[1]?.split('-')[0]))) {
    const p = join(dir, n);
    try {
      out.push({ ref: n.split('.')[0] ?? '', text: readFileSync(p, 'utf8') });
      unlinkSync(p);
    } catch {
      // taken meanwhile
    }
  }
  return out;
}

export function dropTicket(inboxDir: string, id: string): void {
  rmSync(ticketDir(inboxDir, id), { recursive: true, force: true });
}

/** At start: tickets of runs that died with the previous daemon are void. */
export function dropAllTickets(inboxDir: string): void {
  rmSync(join(inboxDir, '.tickets'), { recursive: true, force: true });
}
