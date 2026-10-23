import { ScreenSharePreset } from '@calaba/protocol';
import { Track } from 'livekit-client';
import { describe, expect, it, vi } from 'vitest';
import { cameraPublishOptions } from './camera';

vi.mock('../../platform', () => ({ platform: {} }));
import { H264_DETAIL_BITRATE_FACTOR, ownAudioExcluded, screenBitrate, screenPublishOptions } from './screenShare';

/** docs/09 #68: Chromium reports whether our own playback is excluded from the loopback track. */
describe('ownAudioExcluded', () => {
  it('true for loopbackWithoutChrome / restrictOwnAudio honoured, false for a plain or muted loopback', () => {
    expect(ownAudioExcluded({ deviceId: 'loopbackWithoutChrome', restrictOwnAudio: true })).toBe(true);
    expect(ownAudioExcluded({ deviceId: 'loopback', restrictOwnAudio: false })).toBe(false);
    expect(ownAudioExcluded({ deviceId: 'loopbackWithMute' })).toBe(false);
  });
});

/** The `publishTrack` arguments per codec (ADR-0032): what LiveKit gets for the stream and the camera. */
describe('screen share publish options', () => {
  it('H.264: plain simulcast (no scalabilityMode), +40 % on both layers for «detail»', () => {
    const o = screenPublishOptions('h264', ScreenSharePreset.H1080, 'detail', 15);
    expect(o.source).toBe(Track.Source.ScreenShare);
    expect(o.videoCodec).toBe('h264');
    expect(o.backupCodec).toBe(false);
    expect(o.simulcast).toBe(true);
    expect(o.scalabilityMode).toBeUndefined();
    expect(o.screenShareEncoding).toEqual({ maxBitrate: 2_800_000, maxFramerate: 15 });
    expect(o.screenShareSimulcastLayers?.map((l) => [l.width, l.height, l.encoding.maxBitrate, l.encoding.maxFramerate])).toEqual([[640, 360, 350_000, 15]]);
    expect(o.degradationPreference).toBe('maintain-resolution');
  });

  it('H.264 «motion»: the preset’s own caps', () => {
    const o = screenPublishOptions('h264', ScreenSharePreset.H720, 'motion', 15);
    expect(o.screenShareEncoding?.maxBitrate).toBe(1_000_000);
    expect(o.screenShareSimulcastLayers?.[0]?.encoding.maxBitrate).toBe(250_000);
    expect(o.degradationPreference).toBe('balanced');
  });

  it('AV1: SVC simulcast (L1T3 per rid), caps unchanged', () => {
    const o = screenPublishOptions('av1', ScreenSharePreset.H1080, 'detail', 15);
    expect(o.videoCodec).toBe('av1');
    expect(o.scalabilityMode).toBe('L1T3');
    expect(o.screenShareEncoding?.maxBitrate).toBe(2_000_000);
  });

  it('publishes high frame-rate presets above the former 4 Mbps ceiling', () => {
    const av1 = screenPublishOptions('av1', ScreenSharePreset.H1080_60, 'motion', 60);
    const h264 = screenPublishOptions('h264', ScreenSharePreset.H1440_60, 'detail', 60);
    expect(av1.screenShareEncoding).toEqual({ maxBitrate: 10_000_000, maxFramerate: 60 });
    expect(h264.screenShareEncoding).toEqual({ maxBitrate: 22_400_000, maxFramerate: 60 });
  });

  it('+40 % only for H.264 «detail»', () => {
    expect(H264_DETAIL_BITRATE_FACTOR).toBe(1.4);
    expect(screenBitrate(400_000, 'h264', 'detail')).toBe(560_000);
    expect(screenBitrate(400_000, 'av1', 'detail')).toBe(400_000);
    expect(screenBitrate(400_000, 'vp9', 'detail')).toBe(400_000);
  });
});

describe('camera publish options', () => {
  it('H.264: plain simulcast q/h/f', () => {
    const o = cameraPublishOptions(undefined, 'h264');
    expect(o.videoCodec).toBe('h264');
    expect(o.scalabilityMode).toBeUndefined();
    expect(o.simulcast).toBe(true);
    expect(o.videoSimulcastLayers).toHaveLength(2);
  });

  it('with the background: two layers, the low and the top one (docs/02 «Камера: фон»)', () => {
    const three = cameraPublishOptions(undefined, 'h264');
    const two = cameraPublishOptions(undefined, 'h264', null, true);
    expect(two.videoSimulcastLayers).toHaveLength(1);
    expect(two.videoSimulcastLayers?.[0]).toEqual(three.videoSimulcastLayers?.[0]);
    expect(two.videoEncoding).toEqual(three.videoEncoding);
  });

  it('VP9 / AV1: L1T3 per rid', () => {
    expect(cameraPublishOptions(undefined, 'vp9').scalabilityMode).toBe('L1T3');
    expect(cameraPublishOptions(undefined, 'av1').scalabilityMode).toBe('L1T3');
  });
});
