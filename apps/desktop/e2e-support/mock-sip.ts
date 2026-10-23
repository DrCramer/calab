/**
 * Telephony in the mock (ADR-0046, sip.proto): the stored SIP account's rules and the callee
 * number normalisation. The routes, the control methods (MockServer.setSip / placeSipCall /
 * setSipCallStatus) and the SIP_CALL_UPDATE fan-out live in mock-server.ts (`sipRoutes`).
 *
 * Simplifications against the server: no LiveKit (a placed call stays DIALING until a test moves
 * it with setSipCallStatus), no 45 s ring timeout or 2 h cap, the connection test always answers
 * «answered» unless the host is MOCK_SIP_UNREACHABLE_HOST; the hourly limits are not enforced
 * except by MOCK_SIP_RATE_NUMBER.
 */
import { create } from '@bufbuild/protobuf';
import { SipCallStatus, SipSettingsSchema, SipTransport, type SipSettings } from '@calaba/protocol';

/** A number whose POST …/calls answers 429 SIP_RATE_LIMITED (Retry-After 600). */
export const MOCK_SIP_RATE_NUMBER = '+79990000429';
/** A host whose connection test fails like an unreachable provider (ok = false, no SIP answer). */
export const MOCK_SIP_UNREACHABLE_HOST = 'unreachable.example.com';
/** A host LiveKit «refuses» on PUT: 502 SIP_PROVIDER_ERROR, the text kept as last_error. */
export const MOCK_SIP_REFUSED_HOST = 'refused.example.com';

export const defaultSipSettings = (): SipSettings => create(SipSettingsSchema, { transport: SipTransport.UDP, port: 5060, recordingAvailable: true });

/** The server's callee normalisation (sip.proto PlaceSipCallRequest): E.164 or null. */
export function normalizeCallee(input: string): string | null {
  const s = input.trim().replace(/[\s\-.()]/g, '');
  let out: string;
  if (s.startsWith('+')) out = s;
  else if (/^00\d+$/.test(s)) out = `+${s.slice(2)}`;
  else if (/^[78]\d{10}$/.test(s)) out = `+7${s.slice(1)}`;
  else return null;
  return /^\+[1-9]\d{7,14}$/.test(out) ? out : null;
}

/** Allowed prefixes of the account: empty = any number. */
export const numberAllowed = (number: string, prefixes: readonly string[]): boolean => prefixes.length === 0 || prefixes.some((p) => number.startsWith(p));

/** PUT validation (the server's fields); the offending field or null. */
export function sipSettingsError(b: { enabled: boolean; host: string; callerId: string; outboundPrefix: string; allowedPrefixes: readonly string[]; provider: string }): { field: string; message: string } | null {
  if (b.provider.length > 64) return { field: 'provider', message: 'provider: at most 64 characters' };
  if (b.host && (/^sip:/i.test(b.host) || !/^[a-z0-9.-]+(:\d{1,5})?$/i.test(b.host))) return { field: 'host', message: 'host: a public host name without sip:' };
  if (b.enabled && !b.host) return { field: 'host', message: 'host is required' };
  if (b.callerId && !normalizeCallee(b.callerId)) return { field: 'callerId', message: 'callerId: not a phone number' };
  if (b.enabled && !b.callerId) return { field: 'callerId', message: 'callerId is required' };
  if (b.outboundPrefix && !/^\+?\d{0,8}$/.test(b.outboundPrefix)) return { field: 'outboundPrefix', message: 'outboundPrefix: an optional + and up to 8 digits' };
  if (b.allowedPrefixes.length > 50 || b.allowedPrefixes.some((p) => !/^\+\d{1,15}$/.test(p))) return { field: 'allowedPrefixes', message: 'allowedPrefixes: + and 1..15 digits' };
  return null;
}

export const isLiveSipStatus = (s: SipCallStatus): boolean => s === SipCallStatus.DIALING || s === SipCallStatus.RINGING || s === SipCallStatus.ACTIVE;
