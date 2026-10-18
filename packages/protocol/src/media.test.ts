import { describe, expect, it } from 'vitest';
import { ScreenSharePreset } from './gen/calaba/v1/media_pb.js';
import { AUDIO_TIERS_KBPS, SCREEN_SHARE_PRESETS, audioCaptureConstraints, audioTierKbps, clampStreamPreset, micCaptureConstraints } from './media.js';

describe('clampStreamPreset', () => {
  it('keeps presets at or below the max', () => {
    expect(clampStreamPreset(ScreenSharePreset.H720, ScreenSharePreset.H1080)).toBe(ScreenSharePreset.H720);
    expect(clampStreamPreset(ScreenSharePreset.ORIGINAL, ScreenSharePreset.H720)).toBe(ScreenSharePreset.H720);
    expect(clampStreamPreset(ScreenSharePreset.UNSPECIFIED, ScreenSharePreset.ORIGINAL)).toBe(ScreenSharePreset.H1080);
    expect(clampStreamPreset(ScreenSharePreset.H1080_30, ScreenSharePreset.ORIGINAL)).toBe(ScreenSharePreset.ORIGINAL);
    expect(clampStreamPreset(ScreenSharePreset.H2160_60, ScreenSharePreset.H2160_30)).toBe(ScreenSharePreset.H2160_30);
  });
  it('has a config for every concrete preset', () => {
    expect(Object.keys(SCREEN_SHARE_PRESETS)).toHaveLength(12);
    expect(SCREEN_SHARE_PRESETS[ScreenSharePreset.H1080_60]).toMatchObject({ width: 1920, height: 1080, fps: 60, maxBitrate: 10_000_000 });
    expect(SCREEN_SHARE_PRESETS[ScreenSharePreset.H2160_60].maxBitrate).toBe(30_000_000);
    expect(ScreenSharePreset.ECONOMY).toBe(1);
    expect(ScreenSharePreset.H720).toBe(2);
    expect(ScreenSharePreset.H1080).toBe(3);
    expect(ScreenSharePreset.ORIGINAL).toBe(4);
  });
});

describe('audioTierKbps', () => {
  it('keeps a tier, maps legacy 24 / 48 to the nearest one (a tie goes up)', () => {
    for (const t of AUDIO_TIERS_KBPS) expect(audioTierKbps(t)).toBe(t);
    expect(audioTierKbps(24)).toBe(32);
    expect(audioTierKbps(48)).toBe(64);
    expect(audioTierKbps(12)).toBe(16);
    expect(audioTierKbps(510)).toBe(64);
  });

  it('falls back to the default for nothing / nonsense', () => {
    expect(audioTierKbps(0)).toBe(32);
    expect(audioTierKbps(Number.NaN)).toBe(32);
  });
});

describe('micCaptureConstraints (ADR-0052)', () => {
  it('keeps the speech path unchanged when musician mode is off', () => {
    expect(micCaptureConstraints({ rnnoise: false, musician: false })).toEqual(audioCaptureConstraints(false));
    expect(micCaptureConstraints({ rnnoise: true, musician: false })).toEqual({ echoCancellation: true, noiseSuppression: false, autoGainControl: true, channelCount: 1 });
  });
  it('turns every speech stage off in musician mode, whatever RNNoise says', () => {
    for (const rnnoise of [false, true]) {
      expect(micCaptureConstraints({ rnnoise, musician: true })).toEqual({
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        voiceIsolation: false,
        channelCount: { ideal: 2 },
        sampleRate: { ideal: 48000 },
      });
    }
  });
});
