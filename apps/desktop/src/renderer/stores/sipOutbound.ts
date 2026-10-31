import { create } from 'zustand';
import type { SipCall } from '@calaba/protocol';
import { isDialing, isLivePersonal } from '../lib/sipOutbound';
import { isPersonalRoom, phoneCallId } from '../lib/sipInbound';

/**
 * The personal call of this device (ADR-0137 §3): written by services/sipOutbound.ts only.
 * Components select primitives (the call's id, whether it dials, the band's label).
 */
export interface SipOutboundStore {
  /** The call placed here (live, or final for a moment until the service drops it). */
  call: SipCall | null;
  /** Who it is to as the placing screen knew it (a contact / employee name; '' = the number). */
  name: string;
  /** The POST is in flight (the dial pad's button waits; no second call). */
  placing: boolean;
}

export const useSipOutbound = create<SipOutboundStore>()(() => ({ call: null, name: '', placing: false }));

/** My personal call is live (or being placed): the FAB hides, a second call is refused. */
export function usePersonalCallOn(): boolean {
  return useSipOutbound((s) => s.placing || isLivePersonal(s.call));
}

/** The personal call whose voice session `roomId` is dials (not answered yet). */
export function usePersonalDialing(roomId: string | null | undefined): boolean {
  return useSipOutbound((s) => isPersonalRoom(roomId) && s.call?.id === phoneCallId(roomId) && isDialing(s.call));
}

/** The personal call whose voice session `roomId` is was answered (the tone keypad works). */
export function usePersonalActive(roomId: string | null | undefined): boolean {
  return useSipOutbound((s) => isPersonalRoom(roomId) && s.call?.id === phoneCallId(roomId) && isLivePersonal(s.call) && !isDialing(s.call));
}
