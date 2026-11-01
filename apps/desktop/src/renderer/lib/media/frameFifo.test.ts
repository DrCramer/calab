import { describe, expect, it } from 'vitest';
import { FrameFifo } from './frameFifo';

/**
 * The worklet's loop: a quantum of input completes 480-sample frames (pushed), then one pull.
 * Sample value = its 1-based index, so the output must be `max(0, i − delay + 1)`. Checked inline
 * (no per-sample `expect`, no growing array): counts the samples that break that rule.
 */
function run(quanta: number, quantum = 128, frame = 480, skip: (q: number) => boolean = () => false) {
  const fifo = new FrameFifo(frame);
  const acc = new Float32Array(frame);
  const q = new Float32Array(quantum);
  let pos = 0;
  let n = 0;
  let underruns = 0;
  let prev = 0;
  let outOfOrder = 0;
  let firstNonZero = -1;
  let delayMismatches = 0;
  const delay = frame - gcd(frame, quantum);
  for (let k = 0; k < quanta; k++) {
    if (!skip(k)) {
      for (let i = 0; i < quantum; i++) {
        acc[pos++] = ++n;
        if (pos === frame) {
          fifo.push(acc);
          pos = 0;
        }
      }
    }
    if (!fifo.pull(q)) underruns++;
    for (let i = 0; i < quantum; i++) {
      const v = q[i] ?? 0;
      const at = k * quantum + i;
      if (v !== (at < delay ? 0 : at - delay + 1)) delayMismatches++;
      if (v > 0) {
        if (firstNonZero < 0) firstNonZero = at;
        else if (v !== prev + 1) outOfOrder++;
        prev = v;
      }
    }
  }
  return { underruns, delayMismatches, outOfOrder, firstNonZero };
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

describe('FrameFifo', () => {
  it('never underruns with 480-sample frames and 128-sample quanta, at a constant 448-sample delay', () => {
    // 2 s: the frame / quantum beat repeats every 15 quanta (1920 samples), so this covers it 50×.
    const r = run(750);
    expect(r).toEqual({ underruns: 0, delayMismatches: 0, outOfOrder: 0, firstNonZero: 448 });
  });

  it('other quantum sizes (a future renderSizeHint) are covered by the same rule', () => {
    for (const quantum of [256, 512, 441, 1024]) {
      const r = run(400, quantum);
      expect(r.underruns, `quantum ${quantum}`).toBe(0);
      expect(r.delayMismatches, `quantum ${quantum}`).toBe(0);
    }
  });

  it('a starved quantum (no input) is one quantum of silence, then playback continues in order', () => {
    const r = run(400, 128, 480, (k) => k === 200);
    expect(r.underruns).toBeGreaterThan(0);
    expect(r.outOfOrder).toBe(0);
  });
});
