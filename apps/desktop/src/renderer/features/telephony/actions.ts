import type { SipJournalEntry } from '@calaba/protocol';
import { t } from '../../i18n';
import { haptics } from '../../lib/haptics';
import { pushOnTab } from '../../lib/phoneNav';
import { formatPhone } from '../../lib/sip';
import { copyText } from '../../services/boards';
import { startCall } from '../../services/call';
import { startDm } from '../../services/dms';
import { useTelephonyUi } from '../../stores/telephonyUi';
import { useUi } from '../../stores/ui';
import { placePersonalCall } from '../../services/sipOutbound';
import { placeCallsNow } from './access';
import { editContact, openContact } from './contacts/data';
import { canCallNow } from '../dm/canDm';
import { numberOf } from './timeline';

/*
 * What a row and the detail do (ADR-0137 §6–§7). «Позвонить» is the internal call (ADR-0034) to the
 * employee whose phone the number is, else a personal call over the trunk to the number
 * (services/sipOutbound.ts, PLACE_CALLS); a hidden number, or no right, cannot be called back.
 */

/** The employee I can call back instead of the number ('' = none). */
export function internalPeer(e: SipJournalEntry | undefined, ws: string): string {
  const u = e?.memberUserId ?? '';
  return u && canCallNow(u, ws) ? u : '';
}

/** The call can be called back: an employee, or a number with PLACE_CALLS. */
export function canCallBack(e: SipJournalEntry | undefined, ws: string): boolean {
  if (!e) return false;
  return !!internalPeer(e, ws) || (!!numberOf(e) && placeCallsNow(ws));
}

export function callBack(e: SipJournalEntry, ws: string): boolean {
  const peer = internalPeer(e, ws);
  if (peer) {
    haptics.impact();
    void startCall(peer);
    return true;
  }
  const number = numberOf(e);
  if (!number || !placeCallsNow(ws)) return false;
  const c = e.contact;
  void placePersonalCall({ workspaceId: ws, number, ...(c?.id ? { contactId: c.id, name: c.name || c.company } : {}) });
  return true;
}

/** «Контакт»: the contact of the number, or «Добавить в контакты» with the number filled in. */
export function openOrAddContact(e: SipJournalEntry): void {
  const id = e.contact?.id ?? '';
  if (id) openContact(id);
  else {
    const n = numberOf(e);
    if (n) editContact('', { number: formatPhone(n) });
  }
}

/** The detail of a call: the right panel on the desktop, a pushed screen on the phone. */
export function openCallDetail(callId: string): void {
  const ui = useUi.getState();
  if (ui.phone.on) ui.setPhone((n) => pushOnTab(n, 'telephony', { kind: 'telCall', callId }));
  else useTelephonyUi.getState().openDetail(callId);
}

export function copyNumber(e: SipJournalEntry): void {
  const n = numberOf(e);
  if (n) copyText(formatPhone(n), t('tel.copied'));
}

/** «Написать» the employee whose phone it is. */
export function writeTo(e: SipJournalEntry): void {
  if (e.memberUserId) void startDm(e.memberUserId);
}
