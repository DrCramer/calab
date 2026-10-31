import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { SipCallSchema, SipCallStatus, type SipCall } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import {
  dialErrorKey,
  endToast,
  formatNumberInput,
  formatPhone,
  maskEdit,
  mayDial,
  extensionAt,
  extensionLabel,
  extensionPlan,
  mayHangUp,
  mayKeypad,
  normalizeNumber,
  normalizePrefix,
  reasonCode,
  reasonKey,
  statusKey,
  withEvent,
  withSnapshot,
  withoutCall,
  withoutRooms,
  type SipCallMap,
} from './sip';

const call = (id: string, status: SipCallStatus, over: MessageInitShape<typeof SipCallSchema> = {}): SipCall =>
  create(SipCallSchema, { id, workspaceId: 'w1', roomId: 'r1', number: '+79161234567', startedBy: 'u1', status, participantIdentity: `sip:${id}`, ...over });

describe('number normaliser', () => {
  it('takes what people paste', () => {
    expect(normalizeNumber('+7 (916) 123-45-67')).toBe('+79161234567');
    expect(normalizeNumber('8 916 123 45 67')).toBe('+79161234567');
    expect(normalizeNumber('79161234567')).toBe('+79161234567');
    expect(normalizeNumber('00 44 20 7946 0958')).toBe('+442079460958');
    expect(normalizeNumber('+1.415.555.0123')).toBe('+14155550123');
    expect(normalizeNumber('\u00a0+7\u00a0916\u00a01234567 ')).toBe('+79161234567');
  });

  it('refuses what is not a number', () => {
    expect(normalizeNumber('')).toBeNull();
    expect(normalizeNumber('9161234567')).toBeNull(); // national without 8 / 7: needs a «+»
    expect(normalizeNumber('+7 916')).toBeNull(); // too short
    expect(normalizeNumber('+0123456789')).toBeNull(); // no country code 0
    expect(normalizeNumber('+7916abc4567')).toBeNull();
    expect(normalizeNumber('+1234567890123456')).toBeNull(); // 16 digits
  });

  it('prefix chips', () => {
    expect(normalizePrefix('+7')).toBe('+7');
    expect(normalizePrefix('7495')).toBe('+7495');
    expect(normalizePrefix(' + 7 ')).toBe('+7');
    expect(normalizePrefix('abc')).toBeNull();
    expect(normalizePrefix('+1234567890123456')).toBeNull();
  });
});

describe('number mask', () => {
  it('groups Russian numbers as typed', () => {
    expect(formatNumberInput('+')).toBe('+');
    expect(formatNumberInput('+7')).toBe('+7');
    expect(formatNumberInput('+79')).toBe('+7 9');
    expect(formatNumberInput('+7916')).toBe('+7 916');
    expect(formatNumberInput('+79161')).toBe('+7 916 1');
    expect(formatNumberInput('+7916123')).toBe('+7 916 123');
    expect(formatNumberInput('+79161234')).toBe('+7 916 123-4');
    expect(formatNumberInput('+79161234567')).toBe('+7 916 123-45-67');
    expect(formatNumberInput('89161234567')).toBe('8 916 123-45-67');
  });

  it('is paste-friendly', () => {
    expect(formatNumberInput('+7 (916) 123-45-67')).toBe('+7 916 123-45-67');
    expect(formatNumberInput('Тел.: +7 916 123 45 67')).toBe('+7 916 123-45-67');
    expect(formatNumberInput('+44 20 7946 0958')).toBe('+442079460958');
    expect(formatNumberInput('abc')).toBe('');
    expect(formatNumberInput('+1234567890123456789')).toBe('+123456789012345'); // 15 digits max
  });

  it('a Backspace over a mask separator deletes the digit before it', () => {
    expect(maskEdit('+7 916 123-4', '+7 916 123-')).toBe('+7 916 123');
    expect(maskEdit('+7 916 1', '+7 916 ')).toBe('+7 916');
    expect(maskEdit('+7 916 123-4', '+7 916 1234')).toBe('+7 916 123'); // the dash itself
    expect(maskEdit('+7 916', '+7 9161')).toBe('+7 916 1');
    expect(maskEdit('', '8 (916) 123-45-67')).toBe('8 916 123-45-67');
  });

  it('shows E.164 for people', () => {
    expect(formatPhone('+79161234567')).toBe('+7 916 123-45-67');
    expect(formatPhone('+442079460958')).toBe('+442079460958');
  });
});

describe('live calls (store reducer)', () => {
  it('snapshot keeps only live calls of that workspace and replaces the old ones', () => {
    const other: SipCallMap = {
      r9: { id: 'x', workspaceId: 'w2', roomId: 'r9', number: '+7', startedBy: 'u', status: SipCallStatus.ACTIVE, reason: '', answeredAt: 0, identity: 'sip:x', extension: '' },
      r1: { id: 'old', workspaceId: 'w1', roomId: 'r1', number: '+7', startedBy: 'u', status: SipCallStatus.ACTIVE, reason: '', answeredAt: 0, identity: 'sip:old', extension: '' },
    };
    const m = withSnapshot(other, 'w1', [call('a', SipCallStatus.RINGING), call('b', SipCallStatus.ENDED, { roomId: 'r2' })]);
    expect(Object.keys(m).sort()).toEqual(['r1', 'r9']);
    expect(m['r1']?.id).toBe('a');
    expect(m['r1']?.identity).toBe('sip:a');
  });

  it('moves a call forward only, keeps answered_at, never back', () => {
    let m: SipCallMap = withEvent({}, call('a', SipCallStatus.DIALING));
    expect(m['r1']?.status).toBe(SipCallStatus.DIALING);
    m = withEvent(m, call('a', SipCallStatus.ACTIVE, { answeredAt: timestampFromMs(1000) }));
    expect(m['r1']).toMatchObject({ status: SipCallStatus.ACTIVE, answeredAt: 1000 });
    const same = withEvent(m, call('a', SipCallStatus.RINGING)); // late RINGING after ACTIVE
    expect(same).toBe(m);
    expect(withEvent(m, call('a', SipCallStatus.ACTIVE, { answeredAt: timestampFromMs(1000) }))).toBe(m); // no change
    m = withEvent(m, call('a', SipCallStatus.ENDED, { reason: 'remote' }));
    expect(m['r1']).toMatchObject({ status: SipCallStatus.ENDED, reason: 'remote' });
    expect(withEvent(m, call('a', SipCallStatus.ACTIVE))).toBe(m); // ACTIVE after ENDED
  });

  it('one line per room: a new live call replaces, a final event of another call is ignored', () => {
    let m = withEvent({}, call('a', SipCallStatus.FAILED, { reason: 'busy' }));
    expect(m).toEqual({}); // a final call we never saw live is not drawn
    m = withEvent({}, call('a', SipCallStatus.ACTIVE));
    expect(withEvent(m, call('b', SipCallStatus.ENDED))).toBe(m);
    m = withEvent(m, call('a', SipCallStatus.ENDED, { reason: 'hangup' }));
    m = withEvent(m, call('b', SipCallStatus.DIALING));
    expect(m['r1']?.id).toBe('b');
    expect(withEvent(m, call('t', SipCallStatus.DIALING, { roomId: '' }))).toBe(m); // a connection test
  });

  it('linger timer and room drops', () => {
    const m = withEvent({}, call('a', SipCallStatus.ENDED, { reason: 'x' }));
    const live = withEvent({}, call('a', SipCallStatus.ACTIVE));
    const ended = withEvent(live, call('a', SipCallStatus.ENDED, { reason: 'remote' }));
    expect(withoutCall(ended, 'r1', 'other')).toBe(ended);
    expect(withoutCall(ended, 'r1', 'a')).toEqual({});
    expect(m).toEqual({});
    expect(withoutRooms(live, (id) => id === 'r2')).toBe(live);
    expect(withoutRooms(live, (_id, c) => c.workspaceId === 'w1')).toEqual({});
  });
});

describe('texts', () => {
  it('status line and reasons', () => {
    expect(statusKey(SipCallStatus.DIALING)).toBe('sip.status.dialing');
    expect(statusKey(SipCallStatus.UNSPECIFIED)).toBe('sip.status.dialing');
    expect(statusKey(SipCallStatus.RINGING)).toBe('sip.status.ringing');
    expect(statusKey(SipCallStatus.ACTIVE)).toBe('sip.status.active');
    expect(statusKey(SipCallStatus.FAILED)).toBe('sip.status.ended');
    expect(reasonKey(SipCallStatus.FAILED, 'no_answer')).toBe('sip.reason.noAnswer');
    expect(reasonKey(SipCallStatus.FAILED, 'error 503')).toBe('sip.reason.error');
    expect(reasonKey(SipCallStatus.ENDED, 'hangup_moderator')).toBe('sip.reason.moderator');
    expect(reasonKey(SipCallStatus.FAILED, 'something new')).toBe('sip.reason.error');
    expect(reasonCode('error 503')).toBe('503');
    expect(reasonCode('busy')).toBe('');
  });

  it('one toast per end: no answer, failed with reason, ended; nothing for my own hang-up', () => {
    expect(endToast({ status: SipCallStatus.FAILED, reason: 'no_answer' }, false)).toEqual({ key: 'sip.toast.noAnswer' });
    expect(endToast({ status: SipCallStatus.FAILED, reason: 'busy' }, false)).toEqual({ key: 'sip.toast.failed', reason: 'sip.reason.busy' });
    expect(endToast({ status: SipCallStatus.ENDED, reason: 'remote' }, false)).toEqual({ key: 'sip.toast.ended' });
    expect(endToast({ status: SipCallStatus.ENDED, reason: 'hangup' }, true)).toBeNull();
    expect(endToast({ status: SipCallStatus.ENDED, reason: 'remote' }, true)).toEqual({ key: 'sip.toast.ended' });
    expect(endToast({ status: SipCallStatus.ACTIVE, reason: '' }, false)).toBeNull();
  });

  it('dial errors → inline texts', () => {
    const e = (code: string, status: number): Error => Object.assign(new Error('x'), { code, status });
    expect(dialErrorKey(e('ERROR_CODE_SIP_CALL_ACTIVE', 409))).toBe('sip.err.active');
    expect(dialErrorKey(e('ERROR_CODE_SIP_DISABLED', 409))).toBe('sip.err.disabled');
    expect(dialErrorKey(e('ERROR_CODE_SIP_NUMBER_NOT_ALLOWED', 422))).toBe('sip.err.notAllowed');
    expect(dialErrorKey(e('ERROR_CODE_SIP_RATE_LIMITED', 429))).toBe('sip.err.rate');
    expect(dialErrorKey(e('ERROR_CODE_SIP_PROVIDER_ERROR', 502))).toBe('sip.err.provider');
    expect(dialErrorKey(e('ERROR_CODE_VALIDATION', 422))).toBe('sip.err.number');
    expect(dialErrorKey(e('ERROR_CODE_CONFLICT', 409))).toBe('sip.err.notInCall');
    expect(dialErrorKey(Object.assign(e('ERROR_CODE_CONFLICT', 409), { extra: { reason: 'PLAN_LIMIT' } }))).toBe('plan.telephonyLocked');
    expect(dialErrorKey(e('ERROR_CODE_INTERNAL', 500))).toBeNull();
    expect(dialErrorKey(new Error('plain'))).toBeNull();
  });
});

describe('permission gate', () => {
  const ok = { sipEnabled: true, placeCalls: true, connect: true, guest: false, inCall: true, liveCall: false };
  it('«Позвонить на номер» needs every condition', () => {
    expect(mayDial(ok)).toBe(true);
    expect(mayDial({ ...ok, sipEnabled: false })).toBe(false);
    expect(mayDial({ ...ok, placeCalls: false })).toBe(false);
    expect(mayDial({ ...ok, connect: false })).toBe(false);
    expect(mayDial({ ...ok, guest: true })).toBe(false);
    expect(mayDial({ ...ok, inCall: false })).toBe(false);
    expect(mayDial({ ...ok, liveCall: true })).toBe(false);
  });

  it('«Завершить»: the caller or MUTE_MEMBERS, a live line only', () => {
    expect(mayHangUp({ me: 'u1', startedBy: 'u1', muteMembers: false, live: true })).toBe(true);
    expect(mayHangUp({ me: 'u2', startedBy: 'u1', muteMembers: false, live: true })).toBe(false);
    expect(mayHangUp({ me: 'u2', startedBy: 'u1', muteMembers: true, live: true })).toBe(true);
    expect(mayHangUp({ me: 'u1', startedBy: 'u1', muteMembers: true, live: false })).toBe(false);
    expect(mayHangUp({ me: '', startedBy: '', muteMembers: false, live: true })).toBe(false);
  });

  it('keypad: the caller or MUTE_MEMBERS, answered line, me in the room’s call', () => {
    const base = { me: 'u1', startedBy: 'u1', muteMembers: false, active: true, inCall: true };
    expect(mayKeypad(base)).toBe(true);
    expect(mayKeypad({ ...base, me: 'u2' })).toBe(false); // a listener in the room
    expect(mayKeypad({ ...base, me: 'u2', muteMembers: true })).toBe(true);
    expect(mayKeypad({ ...base, active: false })).toBe(false); // still ringing
    expect(mayKeypad({ ...base, inCall: false })).toBe(false); // not in this room's call
    expect(mayKeypad({ ...base, me: '', startedBy: '' })).toBe(false);
  });
});

describe('extension', () => {
  it('the dial field keeps the number masked and the extension as typed', () => {
    expect(maskEdit('+7 495 123-45-67', '+7 495 123-45-67,')).toBe('+7 495 123-45-67,');
    expect(maskEdit('+7 495 123-45-67,', '+7 495 123-45-67,101')).toBe('+7 495 123-45-67,101');
    expect(maskEdit('+7 495 123-45-67', '+7 495 123-45-67 д')).toBe('+7 495 123-45-67 д');
    expect(maskEdit('+7 495 123-45-67 до', '+7 495 123-45-67 доб. 101')).toBe('+7 495 123-45-67 доб. 101');
    expect(maskEdit('', '+74951234567;101')).toBe('+7 495 123-45-67;101');
    expect(maskEdit('', 'Тел.: +7 916 123 45 67')).toBe('+7 916 123-45-67'); // a pasted prefix still goes
    expect(extensionAt('Тел.: 8 916')).toBe(-1);
    expect(extensionAt('8 916 x1')).toBe(6);
  });

  it('plans the tones: the marker’s pause, gaps between keys, «,» = 2 s more', () => {
    expect(extensionPlan('101')).toEqual([
      { key: '1', waitMs: 2000 },
      { key: '0', waitMs: 400 },
      { key: '1', waitMs: 400 },
    ]);
    expect(extensionPlan(',1,,2#')).toEqual([
      { key: '1', waitMs: 4000 },
      { key: '2', waitMs: 4000 },
      { key: '#', waitMs: 400 },
    ]);
    expect(extensionPlan('')).toEqual([]);
    expect(extensionLabel(',1,2#')).toBe('12#');
  });
});
