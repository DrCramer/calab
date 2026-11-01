import { describe, expect, it } from 'vitest';
import { dtmfCode, dtmfPacket, isLineIdentity } from './dtmf';

const LINE = 'sip:01a18685-4c0f-73a0-9cbc-3a2f238dc6b4';

describe('tones to one phone line', () => {
  it('maps keys to RFC 4733 codes', () => {
    expect(['0', '5', '9', '*', '#'].map(dtmfCode)).toEqual([0, 5, 9, 10, 11]);
    expect(dtmfCode('a')).toBe(-1);
    expect(dtmfCode('12')).toBe(-1);
    expect(dtmfCode('')).toBe(-1);
  });

  it('addresses the packet to that line only', () => {
    const p = dtmfPacket('#', LINE);
    expect(p?.destinationIdentities).toEqual([LINE]);
    expect(p?.value.case).toBe('sipDtmf');
    expect(p?.value.case === 'sipDtmf' ? [p.value.value.code, p.value.value.digit] : null).toEqual([11, '#']);
  });

  it('never broadcasts: no packet without a line to send to', () => {
    expect(dtmfPacket('1', '')).toBeNull();
    expect(dtmfPacket('1', 'user:01a18685-4c0f-73a0-9cbc-3a2f238dc6b4')).toBeNull();
    expect(dtmfPacket('1', 'ivr:abc')).toBeNull();
    expect(dtmfPacket('x', LINE)).toBeNull();
    expect(isLineIdentity(LINE)).toBe(true);
    expect(isLineIdentity('sip:')).toBe(false);
  });
});
