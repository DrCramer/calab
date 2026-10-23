import type { MessageInitShape } from '@bufbuild/protobuf';
import { SipRouteKind, type SipRouteTarget, type SipRouteTargetSchema } from '@calaba/protocol';
import { t, type MessageKey } from '../i18n';
import { ApiError } from './api/client';
import { formatPhone } from './sip';

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
  fallbackSec: 'pbx.err.fallbackSec',
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

// ---------------------------------------------------------------- the telephony tabs (CBF-77)

/** The tabs of «Настройки пространства → Телефония», in order. */
export const TELEPHONY_TABS = ['calls', 'numbers', 'groups', 'ivr', 'settings'] as const;
export type TelephonyTabId = (typeof TELEPHONY_TABS)[number];

export const TELEPHONY_TAB_LABEL: Record<TelephonyTabId, MessageKey> = {
  calls: 'pbx.tab.calls',
  numbers: 'pbx.tab.numbers',
  groups: 'pbx.tab.groups',
  ivr: 'pbx.tab.ivr',
  settings: 'pbx.tab.settings',
};

const isTelephonyTab = (v: unknown): v is TelephonyTabId => typeof v === 'string' && (TELEPHONY_TABS as readonly string[]).includes(v);
const TAB_STORE = 'calaba-telephony-tab';

/**
 * The tab the viewer looked at last: a per-viewer convenience in localStorage; storage that
 * throws or holds junk gives `fallback`.
 */
export function rememberedTelephonyTab(fallback: TelephonyTabId): TelephonyTabId {
  try {
    const v = localStorage.getItem(TAB_STORE);
    return isTelephonyTab(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export function rememberTelephonyTab(tab: TelephonyTabId): void {
  try {
    localStorage.setItem(TAB_STORE, tab);
  } catch {
    // private mode / blocked storage: the choice lives until the dialog closes
  }
}

// ---------------------------------------------------------------- react-query keys

export const extensionsKey = (ws: string): readonly unknown[] => ['sipExtensions', ws];
export const groupsKey = (ws: string): readonly unknown[] => ['sipGroups', ws];
export const menusKey = (ws: string): readonly unknown[] => ['sipMenus', ws];
/** «Активные звонки» (ADR-0128); SIP_CALLS_CHANGED invalidates it (services/dispatch). */
export const activeCallsKey = (ws: string): readonly unknown[] => ['sipActiveCalls', ws];
/** The call journal under «Активные звонки»; SIP_CALLS_CHANGED invalidates it too. */
export const journalKey = (ws: string): readonly unknown[] => ['sipJournal', ws];

// ---------------------------------------------------------------- the menu greeting

/** The prompt upload limit (sip.proto CreateSipIvrMenuRequest.prompt_source_file_id). */
export const MAX_PROMPT_UPLOAD = 10 * 1024 * 1024;
export const PROMPT_ACCEPT = 'audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/wave,audio/ogg,audio/opus,.mp3,.wav,.ogg,.oga,.opus';

/** Why a chosen file cannot be a greeting, before any upload (the server checks the content); null = fine. */
export function promptFileError(f: { name: string; type: string; size: number }): MessageKey | null {
  if (!/\.(mp3|wav|ogg|oga|opus)$/i.test(f.name) && !/^audio\/(mpeg|mp3|wav|x-wav|wave|ogg|opus)$/.test(f.type)) return 'pbx.err.promptFormat';
  if (f.size > MAX_PROMPT_UPLOAD) return 'pbx.err.promptTooBig';
  return null;
}

// ---------------------------------------------------------------- active calls

/** A caller's number for the list: E.164 as «+7 916 123-45-67»; a masked one («+7916*****67») in the same groups. */
export function callerNumber(n: string, masked: boolean): string {
  if (masked && /^\+7[\d*]{10}$/.test(n)) return `+7 ${n.slice(2, 5)} ${n.slice(5, 8)}-${n.slice(8, 10)}-${n.slice(10)}`;
  return masked ? n : formatPhone(n);
}

/**
 * Coalesces SIP_CALLS_CHANGED (ADR-0128): a busy exchange sends one per step of every call, and
 * each re-read is a request (the journal: every loaded page). `run(key)` goes at once when the
 * key ran more than `gapMs` ago, otherwise once at the end of the gap — at most one re-read per
 * gap per workspace, the last change never lost. No timer lives between bursts.
 */
export function coalescer(run: (key: string) => void, gapMs: number): (key: string) => void {
  const last = new Map<string, number>();
  const pending = new Set<string>();
  return (key) => {
    if (pending.has(key)) return;
    const wait = (last.get(key) ?? -Infinity) + gapMs - Date.now();
    const go = (): void => {
      pending.delete(key);
      last.set(key, Date.now());
      run(key);
    };
    if (wait <= 0) go();
    else {
      pending.add(key);
      setTimeout(go, wait);
    }
  };
}

