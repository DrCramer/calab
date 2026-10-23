/**
 * Mail sorting rules (CBF-39): which folder an inbox message belongs in. A pure function, so
 * the sync, «apply to existing» and tests share one decision; the matching itself is shared with
 * smart folders (CBF-56, shared/mailMatch.ts).
 */
import type { MailRule } from '../../shared/mail';
import { conditionHit, type MatchSubject } from '../../shared/mailMatch';

export type RuleSubject = Omit<MatchSubject, 'to'>;

/** The folder path of the first rule of `accountId` the message matches, else null. */
export function matchRule(rules: readonly MailRule[], accountId: string, m: RuleSubject): string | null {
  for (const r of rules) {
    if (r.accountId !== accountId) continue;
    if (conditionHit(r, m)) return r.folderPath;
  }
  return null;
}
