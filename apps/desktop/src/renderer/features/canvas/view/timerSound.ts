import { prefs } from '../../../stores/prefs';
import { synth, wav, type Note } from '../../../lib/sounds';

/**
 * The «time is up» cue (ADR-0114): a short three-note chime rendered once into a WAV blob and played through a plain
 * `<audio>` element on the chosen output device — never WebAudio on the output (docs/02, echo rule 1). It follows the
 * app's «Звуки» switch and volume.
 */
const CHIME: readonly Note[] = [
  { f: 880, at: 0, dur: 0.2 },
  { f: 1174.66, at: 0.16, dur: 0.2 },
  { f: 1567.98, at: 0.32, dur: 0.5 },
];

let url: string | null = null;

export function playTimerEnd(): void {
  const p = prefs();
  if (!p.voiceSounds) return;
  url ??= URL.createObjectURL(wav(synth(CHIME)));
  const el = new Audio(url);
  el.volume = Math.max(0, Math.min(1, p.soundVolume));
  const play = (): void => void el.play().catch(() => undefined);
  const sink = p.outputDeviceId;
  if (sink && typeof el.setSinkId === 'function') void el.setSinkId(sink).then(play, play);
  else play();
}
