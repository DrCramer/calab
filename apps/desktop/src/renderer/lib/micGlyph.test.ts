import { describe, expect, it } from 'vitest';
import { micGlyph } from './voiceLogic';

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
