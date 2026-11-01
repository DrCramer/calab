import { describe, expect, it } from 'vitest';
import { micGlyph, mySeat, selfMic, selfMicGlyph } from './voiceLogic';

describe('micGlyph', () => {
  it('muted or deafened is a crossed mic whatever the mode', () => {
    expect(micGlyph({ muted: true, deafened: false, ptt: true, talking: true })).toBe('muted');
    expect(micGlyph({ muted: false, deafened: true, ptt: false, talking: false })).toBe('muted');
  });
  it('push-to-talk waiting is the pale state, the key held is live', () => {
    expect(micGlyph({ muted: false, deafened: false, ptt: true, talking: false })).toBe('ptt-idle');
    expect(micGlyph({ muted: false, deafened: false, ptt: true, talking: true })).toBe('live');
  });
  it('voice activation is live', () => {
    expect(micGlyph({ muted: false, deafened: false, ptt: false, talking: false })).toBe('live');
  });
});

describe('selfMic (#96): one view for the panel, my row and the island', () => {
  const local = { inVoice: false, muted: false, deafened: false, serverMuted: false, ptt: false };
  it('in the call on this device: its intent, whatever the server copy says', () => {
    const m = selfMic({ ...local, inVoice: true, muted: true }, { roomId: 'A', muted: false, deafened: false });
    expect(m).toMatchObject({ here: true, elsewhere: false, muted: true });
    expect(selfMicGlyph(m, false)).toBe('muted');
  });
  it('another device of mine in the call: the server copy (the reported case)', () => {
    const m = selfMic(local, { roomId: 'A', muted: true, deafened: false });
    expect(m).toMatchObject({ here: false, elsewhere: true, muted: true });
    expect(selfMicGlyph(m, false)).toBe('muted');
    expect(selfMicGlyph(selfMic(local, { roomId: 'A', muted: false, deafened: false, ptt: true }), true)).toBe('ptt-idle'); // no key here
    expect(selfMic(local, { roomId: 'A', muted: false, deafened: true }).muted).toBe(true); // deafen implies mute
    expect(selfMic(local, { roomId: 'A', muted: false, deafened: false, serverMuted: true })).toMatchObject({ muted: true, serverMuted: true });
  });
  it('nowhere in voice: the pre-join intent', () => {
    expect(selfMic({ ...local, muted: true }, null)).toMatchObject({ here: false, elsewhere: false, muted: true });
  });
  it('PTT: idle until the key is held here', () => {
    const m = selfMic({ ...local, inVoice: true, ptt: true }, null);
    expect(selfMicGlyph(m, false)).toBe('ptt-idle');
    expect(selfMicGlyph(m, true)).toBe('live');
  });
  it('mySeat finds my room in any workspace', () => {
    const v = { roomId: 'R', muted: true, deafened: false };
    expect(mySeat({ a: { voice: {} }, b: { voice: { me: v } } }, 'me')).toBe(v);
    expect(mySeat({ a: { voice: { me: { ...v, roomId: '' } } } }, 'me')).toBeNull();
    expect(mySeat({ b: { voice: { me: v } } }, '')).toBeNull();
  });
});
