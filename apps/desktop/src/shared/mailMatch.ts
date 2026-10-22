/**
 * Message matching shared by the sorting rules (CBF-39) and smart folders (CBF-56): one pure
 * decision for the engine (sync, SQL function), the renderer (live rows) and the mock. Node-free.
 */
import type { MailCondition, MailSmartFolder } from './mail';

export interface MatchSubject {
  fromName: string;
  fromAddress: string;
  subject: string;
  /** To and Cc as text (names and addresses); absent = unknown (a list row has no recipients). */
  to?: string;
}

/** Does one condition hold? An empty needle never matches; `to` with unknown recipients does not. */
export function conditionHit(c: Pick<MailCondition, 'field' | 'contains'>, m: MatchSubject): boolean {
  const needle = c.contains.trim().toLowerCase();
  if (!needle) return false;
  if (c.field === 'from') return `${m.fromName}\n${m.fromAddress}`.toLowerCase().includes(needle);
  if (c.field === 'subject') return m.subject.toLowerCase().includes(needle);
  return m.to !== undefined && m.to.toLowerCase().includes(needle);
}

/** A smart folder's test: every condition (`all`) or at least one (`any`); no usable condition → false. */
export function matchSmart(f: Pick<MailSmartFolder, 'match' | 'conditions'>, m: MatchSubject): boolean {
  const conds = f.conditions.filter((c) => c.contains.trim());
  if (!conds.length) return false;
  return f.match === 'all' ? conds.every((c) => conditionHit(c, m)) : conds.some((c) => conditionHit(c, m));
}
