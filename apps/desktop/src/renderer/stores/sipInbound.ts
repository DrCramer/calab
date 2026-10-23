import { create } from 'zustand';
import { NO_INBOUND, isPhoneRoom, phoneCallId, type InboundState } from '../lib/sipInbound';

/**
 * Inbound phone calls on this device (ADR-0117 §7): the calls that ring me and the one I took
 * (lib/sipInbound.ts). Written by services/sipInbound.ts only. Components select primitives
 * (`ringing[0]?.id`, `active?.id`, `busy`).
 */
export interface SipInboundStore extends InboundState {
  /** An accept / decline / hang-up is in flight (the modal's buttons wait). */
  busy: boolean;
}

export const useSipInbound = create<SipInboundStore>()(() => ({ ...NO_INBOUND, busy: false }));

/**
 * The caller's number of the inbound call whose voice session `roomId` is (the voice panel's
 * «Звонок · +7 916 …»; '' = hidden number); null for any other room.
 */
export function usePhoneCallNumber(roomId: string | null | undefined): string | null {
  return useSipInbound((s) => (isPhoneRoom(roomId) && s.active?.id === phoneCallId(roomId) ? s.active.number : null));
}
