/**
 * Mail sorting rules (CBF-39): which folder an inbox message belongs in. A pure function, so
 * the sync, «apply to existing» and tests share one decision.
 */
import type { MailRule } from '../../shared/mail';

export interface RuleSubject {
  fromName: string;
  fromAddress: string;
  subject: string;
}

/** The folder path of the first rule of `accountId` the message matches, else null. */
export function matchRule(rules: readonly MailRule[], accountId: string, m: RuleSubject): string | null {
  const from = `${m.fromName}\n${m.fromAddress}`.toLowerCase();
  const subject = m.subject.toLowerCase();
  for (const r of rules) {
    if (r.accountId !== accountId) continue;
    const needle = r.contains.trim().toLowerCase();
    if (!needle) continue;
    if ((r.field === 'from' ? from : subject).includes(needle)) return r.folderPath;
  }
  return null;
}
