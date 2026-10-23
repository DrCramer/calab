// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePrefs } from '../../../stores/prefs';
import { playTimerEnd } from './timerSound';

const played: { src: string; volume: number }[] = [];

class FakeAudio {
  volume = 1;
  constructor(public src: string) {}
  play(): Promise<void> {
    played.push({ src: this.src, volume: this.volume });
    return Promise.resolve();
  }
}

afterEach(() => {
  played.length = 0;
  vi.unstubAllGlobals();
  usePrefs.getState().setPrefs({ voiceSounds: true, soundVolume: 0.5 });
});

describe('the timer cue', () => {
  it('plays through an <audio> element at the app’s sound volume, and the WAV is rendered once', () => {
    vi.stubGlobal('Audio', FakeAudio);
    const make = vi.fn(() => 'blob:timer');
    URL.createObjectURL = make;
    usePrefs.getState().setPrefs({ voiceSounds: true, soundVolume: 0.3 });
    playTimerEnd();
    playTimerEnd();
    expect(played).toEqual([
      { src: 'blob:timer', volume: 0.3 },
      { src: 'blob:timer', volume: 0.3 },
    ]);
    expect(make.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('stays silent when the app’s sounds are off', () => {
    vi.stubGlobal('Audio', FakeAudio);
    usePrefs.getState().setPrefs({ voiceSounds: false });
    playTimerEnd();
    expect(played).toEqual([]);
  });
});
