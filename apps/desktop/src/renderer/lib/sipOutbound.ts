import { SipCallOrigin, SipCallStatus, type SipCall } from '@calaba/protocol';
import { formatPhone } from './sip';

/**
 * The personal call of this device (ADR-0137 §3), the pure part: which news of SIP_CALL_UPDATE /
 * the POST and DELETE answers / READY moves it, and what the call band says about it. Only a call
 * placed here is followed (another device's call of mine is that device's business).
 */

const LIVE = new Set<SipCallStatus>([SipCallStatus.DIALING, SipCallStatus.RINGING, SipCallStatus.ACTIVE]);
const RANK: Partial<Record<SipCallStatus, number>> = {
  [SipCallStatus.DIALING]: 1,
  [SipCallStatus.RINGING]: 2,
  [SipCallStatus.ACTIVE]: 3,
  [SipCallStatus.ENDED]: 4,
  [SipCallStatus.FAILED]: 4,
};

export const isLivePersonal = (c: SipCall | null | undefined): boolean => !!c && LIVE.has(c.status);

/** Not answered yet: the band says «Набираем…», the ring-back plays. */
export const isDialing = (c: SipCall | null | undefined): boolean => !!c && (c.status === SipCallStatus.DIALING || c.status === SipCallStatus.RINGING);

/**
 * The news `c` for my followed call `cur`: the same call only moves forward (a late DIALING after
 * ACTIVE changes nothing); another call, a room's line or an inbound call is not ours. Same object
 * back when nothing changed.
 */
export function applyOutbound(cur: SipCall | null, c: SipCall): SipCall | null {
  if (!cur || c.id !== cur.id || c.origin !== SipCallOrigin.PERSONAL) return cur;
  const a = RANK[cur.status] ?? 0;
  const b = RANK[c.status] ?? 0;
  if (b < a) return cur;
  if (b === a && c.status === cur.status && c.reason === cur.reason && c.callerName === cur.callerName && c.callerCompany === cur.callerCompany) return cur;
  return c;
}

/** «Анна Петрова (ООО Ромашка)», the company alone, the number, or `hidden` — who a phone call is with. */
export function phonePartyLabel(c: Pick<SipCall, 'callerName' | 'callerCompany' | 'number'>, hidden: string, fallbackName = ''): string {
  const name = c.callerName || fallbackName;
  if (name && c.callerCompany && c.callerCompany !== name) return `${name} (${c.callerCompany})`;
  if (name) return name;
  if (c.callerCompany) return c.callerCompany;
  return c.number ? formatPhone(c.number) : hidden;
}
