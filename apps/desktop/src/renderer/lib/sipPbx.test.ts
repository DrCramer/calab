import { create } from '@bufbuild/protobuf';
import { SipRouteKind, SipRouteTargetSchema } from '@calaba/protocol';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../platform', () => ({ platform: { kind: 'web', apiBase: '', apiFetch: vi.fn() } }));

const { ApiError } = await import('./api/client');
const { MAX_PROMPT_UPLOAD, callerNumber, cleanNumber, fieldError, numberValid, promptFileError, rememberTelephonyTab, rememberedTelephonyTab, targetInit, targetValue } =
  await import('./sipPbx');

describe('exchange routes as select values (ADR-0117)', () => {
  it('round-trips every kind', () => {
    for (const v of ['hangup', 'repeat', 'menu:m1', 'extension:e1', 'group:g1']) {
      expect(targetValue(create(SipRouteTargetSchema, targetInit(v)))).toBe(v);
    }
  });
  it('a deleted target is «missing» and is sent as hang up', () => {
    expect(targetValue(create(SipRouteTargetSchema, { kind: SipRouteKind.GROUP, missing: true }))).toBe('missing');
    expect(targetInit('missing')).toEqual({ kind: SipRouteKind.HANGUP });
    expect(targetInit('')).toEqual({ kind: SipRouteKind.HANGUP });
  });
  it('no route and UNSPECIFIED read as no action / hang up', () => {
    expect(targetValue(undefined)).toBe('');
    expect(targetValue(create(SipRouteTargetSchema, {}))).toBe('hangup');
  });
});

describe('numbers', () => {
  it('keeps only digits, at most 6', () => {
    expect(cleanNumber(' 10-1a ')).toBe('101');
    expect(cleanNumber('12345678')).toBe('123456');
  });
  it('2 to 6 digits, a leading zero allowed', () => {
    expect(numberValid('1')).toBe(false);
    expect(numberValid('01')).toBe(true);
    expect(numberValid('123456')).toBe(true);
    expect(numberValid('1234567')).toBe(false);
  });
});

describe('server errors under their fields', () => {
  it('maps SIP_EXTENSION_TAKEN by field', () => {
    expect(fieldError(new ApiError('ERROR_CODE_SIP_EXTENSION_TAKEN', 'taken', 409, 'number'))?.field).toBe('number');
    const user = fieldError(new ApiError('ERROR_CODE_SIP_EXTENSION_TAKEN', 'taken', 409, 'userId'));
    expect(user?.field).toBe('userId');
    expect(user?.text).not.toBe(fieldError(new ApiError('ERROR_CODE_SIP_EXTENSION_TAKEN', 'taken', 409, 'number'))?.text);
  });
  it('maps known validation fields, leaves the rest to the form', () => {
    expect(fieldError(new ApiError('ERROR_CODE_VALIDATION', 'bad', 422, 'promptSourceFileId'))?.field).toBe('promptSourceFileId');
    expect(fieldError(new ApiError('ERROR_CODE_VALIDATION', 'bad', 422, 'nope'))).toBeNull();
    expect(fieldError(new ApiError('ERROR_CODE_CONFLICT', 'limit', 409))).toBeNull();
    expect(fieldError(new Error('x'))).toBeNull();
  });
});

describe('the telephony tabs (CBF-77)', () => {
  it('remembers the tab, ignores junk and a throwing storage', () => {
    const m = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) });
    expect(rememberedTelephonyTab('settings')).toBe('settings');
    rememberTelephonyTab('ivr');
    expect(rememberedTelephonyTab('calls')).toBe('ivr');
    m.set('calaba-telephony-tab', 'nope');
    expect(rememberedTelephonyTab('calls')).toBe('calls');
    const blocked = (): never => {
      throw new Error('blocked');
    };
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked });
    expect(rememberedTelephonyTab('numbers')).toBe('numbers');
    expect(() => rememberTelephonyTab('groups')).not.toThrow();
    vi.unstubAllGlobals();
  });
});

describe('the greeting file and the caller number', () => {
  it('checks the format and the size before an upload', () => {
    expect(promptFileError({ name: 'greeting.mp3', type: 'audio/mpeg', size: 4096 })).toBeNull();
    expect(promptFileError({ name: 'hello', type: 'audio/ogg', size: 1 })).toBeNull();
    expect(promptFileError({ name: 'a.docx', type: 'application/msword', size: 1 })).toBe('pbx.err.promptFormat');
    expect(promptFileError({ name: 'big.wav', type: 'audio/wav', size: MAX_PROMPT_UPLOAD + 1 })).toBe('pbx.err.promptTooBig');
  });
  it('formats full and masked numbers', () => {
    expect(callerNumber('+79161234567', false)).toBe('+7 916 123-45-67');
    expect(callerNumber('+7916*****67', true)).toBe('+7 916 ***-**-67');
    expect(callerNumber('+1202*****47', true)).toBe('+1202*****47');
  });
});
