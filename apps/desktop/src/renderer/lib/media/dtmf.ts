import { DataPacket, SipDTMF } from '@livekit/protocol';

/**
 * Tones to one phone line (ADR-0046 addendum «Тональный набор», ADR-0137 §3.7). A key is a
 * `SipDTMF` data packet; livekit/sip v1.14 hands every SipDTMF its room connection receives to
 * the provider as RFC 2833 (`pkg/sip/room.go` OnDataPacket) without looking at the sender. So the
 * packet names its one receiver in `destination_identities` (livekit-server forwards a SipDTMF
 * only there): with two lines in a room — or the IVR worker, which also reads SipDTMF — the keys
 * reach only the line they are pressed for. livekit-client's own `publishDtmf` has no
 * destination, hence this packet. Data, not sound: the echo rules (docs/02) are untouched.
 */

/** RFC 4733 event code of a key: 0-9, «*» = 10, «#» = 11; -1 for anything else. */
export function dtmfCode(key: string): number {
  if (key === '*') return 10;
  if (key === '#') return 11;
  return /^[0-9]$/.test(key) ? Number(key) : -1;
}

/** A phone line's LiveKit identity: `sip:<call id>` (rtc.SIPIdentity). */
export const isLineIdentity = (identity: string): boolean => /^sip:\S{1,64}$/.test(identity);

/** The reliable SipDTMF packet of one key to one line, or null for a bad key or receiver. */
export function dtmfPacket(key: string, identity: string): DataPacket | null {
  const code = dtmfCode(key);
  if (code < 0 || !isLineIdentity(identity)) return null;
  // No `kind` (deprecated): livekit-server takes it from the channel — voice sends on the reliable one.
  return new DataPacket({
    destinationIdentities: [identity],
    value: { case: 'sipDtmf', value: new SipDTMF({ code, digit: key }) },
  });
}
