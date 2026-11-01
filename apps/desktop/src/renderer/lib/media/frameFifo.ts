/**
 * Output FIFO of the mic worklet: RNNoise produces 480-sample frames, the render quantum pulls
 * 128 samples. The old ring started playing as soon as the first frame was ready and then ran dry
 * once, ~16 ms later (a quantum of zeros inside the signal), before the latency settled — and any
 * starved quantum later did the same. Here the first pull primes the FIFO with exactly the latency the
 * frame / quantum beat needs — `frame − gcd(frame, quantum)` zeros, 448 samples (9.3 ms) for
 * 480 / 128 — and from then on it never underruns while input keeps coming (unit test).
 *
 * The caller pushes this quantum's input (completing frames) before it pulls.
 */
export class FrameFifo {
  private readonly buf: Float32Array;
  private rd = 0;
  private wr = 0;
  private avail = 0;
  /** Priming zeros still to emit; -1 = not primed yet. */
  private zeros = -1;

  constructor(
    private readonly frame: number,
    capacity = 4096,
  ) {
    this.buf = new Float32Array(capacity);
  }

  push(f: Float32Array): void {
    const cap = this.buf.length;
    for (let i = 0; i < f.length; i++) {
      this.buf[this.wr] = f[i] ?? 0;
      this.wr = (this.wr + 1) % cap;
    }
    this.avail += f.length;
    if (this.avail > cap) {
      // Overflow (cannot happen with a steady 1:1 rate): drop the oldest, keep the newest.
      this.rd = (this.rd + this.avail - cap) % cap;
      this.avail = cap;
    }
  }

  /** Fills `out`; false = underrun (input starved), `out` is silence and nothing is consumed. */
  pull(out: Float32Array): boolean {
    if (this.zeros < 0) this.zeros = this.frame - gcd(this.frame, out.length);
    const z = Math.min(this.zeros, out.length);
    const need = out.length - z;
    if (this.avail < need) {
      out.fill(0);
      return false;
    }
    this.zeros -= z;
    out.fill(0, 0, z);
    const cap = this.buf.length;
    for (let i = z; i < out.length; i++) {
      out[i] = this.buf[this.rd] ?? 0;
      this.rd = (this.rd + 1) % cap;
    }
    this.avail -= need;
    return true;
  }

  /** Samples buffered (tests, diagnostics). */
  get buffered(): number {
    return this.avail;
  }
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}
