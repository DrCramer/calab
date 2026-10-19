/**
 * Shared measuring helper of the Canvas benches (tools/perf-canvas*.ts): the page calls `await __mark(name)`
 * at the edges of a phase, the driver samples Chromium there — real CPU time of every browser process
 * (CDP SystemInfo.getProcessInfo), the page's main-thread task / script time (Performance.getMetrics),
 * the JS heap (after a forced GC for `gc:` marks) and the renderers' RSS — and derives per-phase numbers.
 */
import { execFileSync } from 'node:child_process';
import type { Browser, CDPSession, Page } from '@playwright/test';

interface ProcSample {
  type: string;
  id: number;
  cpu: number;
}
export interface Sample {
  t: number;
  task: number;
  script: number;
  heapUsed: number;
  procs: ProcSample[];
  rssKB: number;
}

export interface Probe {
  marks: Map<string, Sample>;
  /** Percent of ONE core, per process type, between two marks (`renderer` summed over renderers). */
  cpu(from: string, to: string): { wallS: number; renderer: number; gpu: number; browser: number; total: number; mainThread: number; script: number };
  /** Takes a sample now (driver-side marks, e.g. a blank-page baseline). */
  sample(name: string): Promise<void>;
  heapMB(mark: string): number;
  rssMB(mark: string): number;
  close(): Promise<void>;
}

const round = (n: number, d = 2): number => Math.round(n * 10 ** d) / 10 ** d;

function rssOfRenderers(pids: number[]): number {
  if (pids.length === 0) return 0;
  try {
    const out = execFileSync('ps', ['-o', 'rss=', '-p', pids.join(',')], { encoding: 'utf8' });
    return out.split('\n').reduce((a, l) => a + (Number(l.trim()) || 0), 0);
  } catch {
    return 0;
  }
}

export async function attachProbe(browser: Browser, page: Page, onMark?: (name: string, cdp: CDPSession) => Promise<void> | void): Promise<Probe> {
  const bs = await browser.newBrowserCDPSession();
  const ps: CDPSession = await page.context().newCDPSession(page);
  await ps.send('Performance.enable');
  await ps.send('HeapProfiler.enable');
  const marks = new Map<string, Sample>();
  const sample = async (name: string): Promise<Sample> => {
    if (name.startsWith('gc:')) await ps.send('HeapProfiler.collectGarbage');
    const [info, metrics, heap] = await Promise.all([
      bs.send('SystemInfo.getProcessInfo') as Promise<{ processInfo: { type: string; id: number; cpuTime: number }[] }>,
      ps.send('Performance.getMetrics') as Promise<{ metrics: { name: string; value: number }[] }>,
      ps.send('Runtime.getHeapUsage') as Promise<{ usedSize: number }>,
    ]);
    const m = (n: string): number => metrics.metrics.find((x) => x.name === n)?.value ?? 0;
    const procs = info.processInfo.map((p) => ({ type: p.type, id: p.id, cpu: p.cpuTime }));
    return {
      t: Date.now() / 1000,
      task: m('TaskDuration'),
      script: m('ScriptDuration'),
      heapUsed: heap.usedSize,
      procs,
      rssKB: rssOfRenderers(procs.filter((p) => p.type === 'renderer').map((p) => p.id)),
    };
  };
  await page.exposeFunction('__mark', async (name: string) => {
    marks.set(name, await sample(name));
    await onMark?.(name, ps);
  });
  const get = (n: string): Sample => {
    const s = marks.get(n);
    if (!s) throw new Error(`mark ${n} missing`);
    return s;
  };
  return {
    marks,
    cpu(from, to) {
      const a = get(from);
      const b = get(to);
      const wall = b.t - a.t;
      const sum = (type: string): number => {
        let d = 0;
        for (const p of b.procs) if (p.type === type) d += p.cpu - (a.procs.find((q) => q.id === p.id)?.cpu ?? p.cpu);
        return (d / wall) * 100;
      };
      const renderer = sum('renderer');
      const gpu = sum('GPU');
      const browserP = sum('browser');
      return {
        wallS: round(wall, 1),
        renderer: round(renderer),
        gpu: round(gpu),
        browser: round(browserP),
        total: round(renderer + gpu + browserP),
        mainThread: round(((b.task - a.task) / wall) * 100),
        script: round(((b.script - a.script) / wall) * 100),
      };
    },
    sample: async (name) => {
      marks.set(name, await sample(name));
    },
    heapMB: (n) => round(get(n).heapUsed / 1048576),
    rssMB: (n) => round(get(n).rssKB / 1024, 1),
    close: async () => {
      await bs.detach().catch(() => undefined);
    },
  };
}

export interface Agg {
  median: number;
  min: number;
  max: number;
  n: number;
}

/** Median / min / max of every numeric leaf across runs (same shape in, same shape out). */
export function aggregate(runs: unknown[]): unknown {
  const first = runs[0];
  if (typeof first === 'number') {
    const xs = (runs as number[]).slice().sort((a, b) => a - b);
    const mid = xs.length >> 1;
    const med = xs.length % 2 ? (xs[mid] as number) : ((xs[mid - 1] as number) + (xs[mid] as number)) / 2;
    return { median: round(med), min: xs[0], max: xs[xs.length - 1], n: xs.length } satisfies Agg;
  }
  if (Array.isArray(first)) return first.map((_, i) => aggregate(runs.map((r) => (r as unknown[])[i])));
  if (first && typeof first === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(first)) out[k] = aggregate(runs.map((r) => (r as Record<string, unknown>)[k]));
    return out;
  }
  return first;
}

/** `aggregate` output with every leaf as one short string: `median [min..max]` (just the value when all runs agree). */
export function compact(x: unknown): unknown {
  if (x && typeof x === 'object') {
    const a = x as Partial<Agg>;
    if (typeof a.median === 'number' && typeof a.min === 'number' && typeof a.max === 'number' && typeof a.n === 'number') {
      return a.min === a.max ? `${a.median}` : `${a.median} [${a.min}..${a.max}]`;
    }
    if (Array.isArray(x)) return x.map(compact);
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, compact(v)]));
  }
  return x;
}

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
}
/** Top functions by self time (ms) of a CDP CPU profile — a diagnosis aid (`--profile <phase>`). */
export function topSelf(profile: { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] }, limit = 25): string[] {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map<string, number>();
  profile.samples.forEach((id, i) => {
    const n = byId.get(id);
    if (!n) return;
    const f = n.callFrame;
    const key = `${f.functionName || '(anonymous)'} ${f.url.split('/').pop() ?? ''}:${f.lineNumber}`;
    self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
  });
  return [...self].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k, ms]) => `${round(ms, 1)} ms  ${k}`);
}
