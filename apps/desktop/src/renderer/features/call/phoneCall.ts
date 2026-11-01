import { timestampMs } from '@bufbuild/protobuf/wkt';
import type { SipCall } from '@calaba/protocol';
import { t } from '../../i18n';
import { isPersonalRoom, isPhoneRoom, phoneCallId } from '../../lib/sipInbound';
import { phonePartyLabel } from '../../lib/sipOutbound';
import { useSipInbound } from '../../stores/sipInbound';
import { useSipOutbound } from '../../stores/sipOutbound';
import { memberName, useWorkspaces } from '../../stores/workspaces';

/**
 * Who a phone call is with, for the island, the phone's call band and the notification (ADR-0137
 * §2 caller ID): the contact «Анна Петрова (ООО Ромашка)», the employee whose phone it is, the
 * number, «Скрытый номер». A string per subscriber: the band re-renders only when it changes.
 */
export function callPartyLabel(c: SipCall, fallbackName = '', short = false): string {
  const employee = !c.callerName && c.callerUserId ? memberName(c.workspaceId, c.callerUserId) : '';
  // `short` (the phone's band, like the iPhone «Телефон»): the name alone, no «(company)».
  if (short) return phonePartyLabel({ callerName: c.callerName, callerCompany: c.callerName || fallbackName || employee ? '' : c.callerCompany, number: c.number }, t('call.sipUnknown'), fallbackName || employee);
  return phonePartyLabel(c, t('call.sipUnknown'), fallbackName || employee);
}

/** When the phone call of `roomId` was answered (ms; 0 = not yet / not a phone call): the band's timer. */
export function usePhoneAnsweredAt(roomId: string | null | undefined): number {
  const inbound = useSipInbound((s) => (isPhoneRoom(roomId) && !isPersonalRoom(roomId) && s.active?.id === phoneCallId(roomId) && s.active.answeredAt ? timestampMs(s.active.answeredAt) : 0));
  const outbound = useSipOutbound((s) => (isPersonalRoom(roomId) && s.call?.id === phoneCallId(roomId) && s.call.answeredAt ? timestampMs(s.call.answeredAt) : 0));
  return inbound || outbound;
}

/** The label of the phone call whose voice session `roomId` is (inbound or personal); null for any other room. */
export function usePhoneCallLabel(roomId: string | null | undefined, short = false): string | null {
  // Names follow renames of members (the employee case): read through the workspaces store.
  const inbound = useSipInbound((s) => (isPhoneRoom(roomId) && !isPersonalRoom(roomId) && s.active?.id === phoneCallId(roomId) ? s.active : null));
  const outbound = useSipOutbound((s) => (isPersonalRoom(roomId) && s.call?.id === phoneCallId(roomId) ? s.call : null));
  const name = useSipOutbound((s) => s.name);
  return useWorkspaces(() => (inbound ? callPartyLabel(inbound, '', short) : outbound ? callPartyLabel(outbound, name, short) : isPhoneRoom(roomId) ? '' : null));
}
