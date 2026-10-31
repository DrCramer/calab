/**
 * Mic AudioWorklet: optional RNNoise denoise + per-20 ms level/VAD reports.
 *
 * Runs on the *capture* side only, after Chromium's AEC3 (getUserMedia with
 * echoCancellation). Nothing here ever touches remote playback
 * (docs/02-media.md, echo rules 1 and 3).
 *
 * - denoise=true: 1 input, 1 output; output is the denoised mono signal
 *   (≈20 ms RNNoise delay + 448 samples / 9.3 ms of frame→quantum buffering, lib/media/frameFifo.ts).
 * - denoise=false: analysis only (0 outputs) — reports RMS, vad = -1.
 *
 * RNNoise runs on demand (lib/media/denoiseSleep.ts): the main thread sends a `DenoiseControl`
 * whenever the mic goes on / off air; while asleep the output is silence (the published track is
 * disabled then anyway) and reports come every 100 ms with the raw level.
 */
import '@rnnoise-dist/polyfills.js';
import createRNNWasmModuleSync, { type RnnoiseWasmModule } from '@rnnoise-dist/generated/rnnoise-sync.js';
import type { MicReport } from '../micReport';
import { DENOISE_SLEEP, DenoiseScheduler, rmsDb, type DenoiseControl } from '../denoiseSleep';
import { FrameFifo } from '../frameFifo';

const FRAME = 480; // RNNoise frame: 10 ms @ 48 kHz
const PCM_SCALE = 32768; // RNNoise expects int16-range floats
const FRAMES_PER_REPORT = 2; // 2 × 10 ms = one 20 ms VAD frame
const PRE_ROLL = DENOISE_SLEEP.preRollFrames;


interface ProcessorOptions {
  denoise: boolean;
}

class MicProcessor extends AudioWorkletProcessor {
  private readonly denoise: boolean;
  private mod: RnnoiseWasmModule | null = null;
  private state = 0;
  private buf = 0;
  private alive = true;

  private readonly frame = new Float32Array(FRAME);
  private framePos = 0;

  /** Denoised frames → render quanta (primed once, no underruns: lib/media/frameFifo.ts). */
  private readonly fifo = new FrameFifo(FRAME);

  private framesInReport = 0;
  private sumSq = 0;
  private maxVad = -1;

  private readonly sched = new DenoiseScheduler();
  /** The last raw frames, replayed through RNNoise on wake (state warm-up). */
  private readonly history = new Float32Array(FRAME * PRE_ROLL);
  private historyPos = 0;
  private historyLen = 0;
  private readonly scratch = new Float32Array(FRAME);

  constructor(options?: { processorOptions?: ProcessorOptions }) {
    super();
    const opts = options?.processorOptions ?? { denoise: false };
    this.denoise = opts.denoise;
    if (this.denoise) {
      const mod = createRNNWasmModuleSync();
      this.mod = mod;
      this.state = mod._rnnoise_create();
      this.buf = mod._malloc(FRAME * 4);
    }
    this.port.onmessage = (e: MessageEvent<unknown>) => {
      if (e.data === 'destroy') this.destroy();
      else if (isControl(e.data)) this.sched.control(e.data);
    };
  }

  private destroy(): void {
    this.alive = false;
    if (this.mod) {
      this.mod._rnnoise_destroy(this.state);
      this.mod._free(this.buf);
      this.mod = null;
    }
  }

  /** RNNoise in place on `buf` (FRAME samples); returns the VAD probability. */
  private denoiseInPlace(mod: RnnoiseWasmModule, buf: Float32Array, offset: number): number {
    const heap = mod.HEAPF32; // re-read: may be replaced on memory growth
    const base = this.buf >> 2;
    for (let i = 0; i < FRAME; i++) heap[base + i] = (buf[offset + i] ?? 0) * PCM_SCALE;
    const vad = mod._rnnoise_process_frame(this.state, this.buf, this.buf);
    const out = mod.HEAPF32;
    for (let i = 0; i < FRAME; i++) buf[offset + i] = (out[base + i] ?? 0) / PCM_SCALE;
    return vad;
  }

  private processFrame(): void {
    const f = this.frame;
    let rawSq = 0;
    for (let i = 0; i < FRAME; i++) {
      const s = f[i] ?? 0;
      rawSq += s * s;
    }
    const action = this.sched.step(rmsDb(Math.sqrt(rawSq / FRAME)));
    let vad = -1;
    let sq = rawSq;
    const mod = this.mod;
    if (mod) {
      if (action === 'wake') {
        // Oldest first; the output is dropped — only RNNoise's recurrent state matters.
        const scratch = this.scratch;
        for (let k = this.historyLen; k > 0; k--) {
          const slot = (this.historyPos - k + PRE_ROLL) % PRE_ROLL;
          scratch.set(this.history.subarray(slot * FRAME, (slot + 1) * FRAME));
          this.denoiseInPlace(mod, scratch, 0);
        }
      }
      this.history.set(f, this.historyPos * FRAME);
      this.historyPos = (this.historyPos + 1) % PRE_ROLL;
      this.historyLen = Math.min(PRE_ROLL, this.historyLen + 1);
      if (action === 'sleep') {
        vad = 0; // not speech: the gate stays closed (its level test fails anyway)
        f.fill(0); // silence out: the track is disabled while the mic is off air
      } else {
        vad = this.denoiseInPlace(mod, f, 0);
        sq = 0;
        for (let i = 0; i < FRAME; i++) {
          const s = f[i] ?? 0;
          sq += s * s;
        }
      }
      this.fifo.push(f);
    }

    this.sumSq += sq;
    if (vad > this.maxVad) this.maxVad = vad;
    const every = this.sched.asleep ? DENOISE_SLEEP.sleepReportFrames : FRAMES_PER_REPORT;
    if (++this.framesInReport >= every) {
      const report: MicReport = {
        rms: Math.sqrt(this.sumSq / (FRAME * this.framesInReport)),
        vad: this.maxVad,
      };
      this.port.postMessage(report);
      this.framesInReport = 0;
      this.sumSq = 0;
      this.maxVad = -1;
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (!this.alive) return false;
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (input) {
      for (let i = 0; i < input.length; i++) {
        this.frame[this.framePos++] = input[i] ?? 0;
        if (this.framePos === FRAME) {
          this.processFrame();
          this.framePos = 0;
        }
      }
    }
    if (output) this.fifo.pull(output);
    return true;
  }
}

function isControl(d: unknown): d is DenoiseControl {
  return typeof d === 'object' && d !== null && (d as { type?: unknown }).type === 'denoise';
}

registerProcessor('calaba-mic', MicProcessor);
