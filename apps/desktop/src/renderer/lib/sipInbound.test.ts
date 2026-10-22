import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { SipCallDirection, SipCallSchema, SipCallStatus, type SipCall } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { NO_INBOUND, applyInbound, inboundOf, isPhoneRoom, phoneCallId, phoneRoomId } from './sipInbound';

const me = 'u-me';
const call = (id: string, status: SipCallStatus, over: MessageInitShape<typeof SipCallSchema> = {}): SipCall =>
  create(SipCallSchema, { id, workspaceId: 'w', number: '+79161234567', direction: SipCallDirection.IN, status, ...over });

describe('inbound calls', () => {
  it('rings while I am in ringing_user_ids, then goes', () => {
    const ring = call('c1', SipCallStatus.RINGING, { ringingUserIds: [me, 'u2'] });
    let s = applyInbound(NO_INBOUND, ring, me);
    expect(s.ringing.map((c) => c.id)).toEqual(['c1']);
    // The round-robin moved on to someone else: the modal closes here.
    s = applyInbound(s, call('c1', SipCallStatus.RINGING, { ringingUserIds: ['u2'] }), me);
    expect(s.ringing).toEqual([]);
    expect(applyInbound(s, call('c1', SipCallStatus.ENDED), me)).toBe(s);
  });

  it('keeps the call I answered and drops it when it ends', () => {
    let s = applyInbound(NO_INBOUND, call('c1', SipCallStatus.RINGING, { ringingUserIds: [me] }), me);
    s = applyInbound(s, call('c1', SipCallStatus.ACTIVE, { answeredBy: me }), me);
    expect(s.ringing).toEqual([]);
    expect(s.active?.id).toBe('c1');
    // A late ring of the same call (the event after the accept answer) changes nothing.
    expect(applyInbound(s, call('c1', SipCallStatus.RINGING, { ringingUserIds: [me] }), me)).toBe(s);
    s = applyInbound(s, call('c1', SipCallStatus.ENDED, { answeredBy: me, reason: 'remote' }), me);
    expect(s.active).toBeNull();
  });

  it('closes the modal when somebody else answers', () => {
    let s = applyInbound(NO_INBOUND, call('c1', SipCallStatus.RINGING, { ringingUserIds: [me, 'u2'] }), me);
    s = applyInbound(s, call('c1', SipCallStatus.ACTIVE, { answeredBy: 'u2' }), me);
    expect(s).toEqual({ ringing: [], active: null });
  });

  it('ignores outbound calls and builds READY state', () => {
    const out = call('c0', SipCallStatus.RINGING, { direction: SipCallDirection.OUT, ringingUserIds: [me] });
    expect(applyInbound(NO_INBOUND, out, me)).toBe(NO_INBOUND);
    const s = inboundOf([out, call('c1', SipCallStatus.RINGING, { ringingUserIds: [me] }), call('c2', SipCallStatus.ACTIVE, { answeredBy: me })], me);
    expect(s.ringing.map((c) => c.id)).toEqual(['c1']);
    expect(s.active?.id).toBe('c2');
  });

  it('names phone rooms', () => {
    expect(phoneRoomId('c1')).toBe('sipin:c1');
    expect(isPhoneRoom('sipin:c1')).toBe(true);
    expect(isPhoneRoom('room-1')).toBe(false);
    expect(phoneCallId('sipin:c1')).toBe('c1');
    expect(phoneCallId('room-1')).toBe('');
  });
});
