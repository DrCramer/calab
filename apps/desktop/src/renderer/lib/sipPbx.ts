import type { MessageInitShape } from '@bufbuild/protobuf';
import { SipRouteKind, type SipRouteTarget, type SipRouteTargetSchema } from '@calaba/protocol';
import { t, type MessageKey } from '../i18n';
import { ApiError } from './api/client';

/*
 * The telephony exchange (ADR-0117) on the client: routes as <select> values, number input,
 * the server's 422 / 409 fields → texts. Used by features/workspace/TelephonyExchange.
 */

export type TargetInit = MessageInitShape<typeof SipRouteTargetSchema>;

/** A route as one <select> value: «hangup», «repeat», «menu:<id>», «extension:<id>», «group:<id>»; «» = no action (keys). */
export function targetValue(r: SipRouteTarget | undefined): string {
  if (!r) return '';
  switch (r.kind) {
    case SipRouteKind.REPEAT:
      return 'repeat';
    case SipRouteKind.MENU:
      return r.id ? `menu:${r.id}` : 'missing';
    case SipRouteKind.EXTENSION:
      return r.id ? `extension:${r.id}` : 'missing';
    case SipRouteKind.GROUP:
      return r.id ? `group:${r.id}` : 'missing';
    default:
      return 'hangup';
  }
}

/** The request form of a <select> value; «missing» (a deleted target) is sent as hang up. */
export function targetInit(v: string): TargetInit {
  const [kind, id = ''] = v.split(':');
  switch (kind) {
    case 'repeat':
      return { kind: SipRouteKind.REPEAT };
    case 'menu':
      return { kind: SipRouteKind.MENU, id };
    case 'extension':
      return { kind: SipRouteKind.EXTENSION, id };
    case 'group':
      return { kind: SipRouteKind.GROUP, id };
    default:
      return { kind: SipRouteKind.HANGUP };
  }
}

/** Only digits, at most 6 (sip.proto SipExtension.number). */
export const cleanNumber = (s: string): string => s.replace(/\D/g, '').slice(0, 6);
export const numberValid = (s: string): boolean => /^\d{2,6}$/.test(s);

/** A 422 / 409 of the exchange → { field, text } under that field; null = a form-level error. */
const FIELD_ERR: Record<string, MessageKey> = {
  number: 'pbx.err.number',
  userId: 'pbx.err.member',
  description: 'pbx.err.description',
  name: 'pbx.err.name',
  members: 'pbx.err.members',
  ringSec: 'pbx.err.seconds',
  memberRingSec: 'pbx.err.seconds',
  inputTimeoutSec: 'pbx.err.timeout',
  repeats: 'pbx.err.repeats',
  onFail: 'pbx.err.target',
  onNoInput: 'pbx.err.target',
  items: 'pbx.err.target',
  digit: 'pbx.err.target',
  promptSourceFileId: 'pbx.err.prompt',
  target: 'pbx.err.target',
  allowedCidrs: 'pbx.err.cidrs',
  registrar: 'pbx.err.registrar',
  domain: 'pbx.err.domain',
  expiresSec: 'pbx.err.expires',
  keepaliveSec: 'pbx.err.keepalive',
  regAuthUsername: 'pbx.err.regAuthUsername',
  regPassword: 'pbx.err.regPassword',
  username: 'pbx.err.regUsername',
};

export function fieldError(e: unknown): { field: string; text: string } | null {
  if (!(e instanceof ApiError) || !e.field) return null;
  if (e.code === 'ERROR_CODE_SIP_EXTENSION_TAKEN') return { field: e.field, text: t(e.field === 'userId' ? 'pbx.err.memberHasNumber' : 'pbx.err.numberTaken') };
  if (e.code !== 'ERROR_CODE_VALIDATION') return null;
  const key = FIELD_ERR[e.field];
  return key ? { field: e.field, text: t(key) } : null;
}

