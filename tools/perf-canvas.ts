/**
 * Canvas engine benchmark (ADR-0115 §4, docs/14-energy.md). Bundles the engine with esbuild, opens it in a
 * real Chromium page and measures, for N objects (default 2000 and 5000): document build, loading a synced
 * state (Y update → Scene), first paint, full-frame time at several zooms, the pan frame time (cached layer
 * scrolled, exposed strips painted), zoom and single-object-edit frames, a snapped drag through the
 * engine's own pointer handling, memory, and the idle state (rAF / timers over 3 s must be zero).
 *
 * "record" is the time to issue the draw calls; "withRaster" adds a 1×1 readback that forces the
 * rasterization to finish, so it is the real cost of a frame on that machine.
 *
 *   nice -n 19 npx tsx tools/perf-canvas.ts [--n 500,2000,5000] [--dpr 1,2] [--size 1920x1080] [--runs 5] [--software] [--mix h9|v2]
 *
 * Every (dpr, n) is run `--runs` times in a fresh page; the output is median [min..max] of every number.
 * Heap numbers are taken by CDP after a forced GC (`heapDocMB`: the Y.Doc, `heapEngineMB`: scene + index +
 * layers' JS side; `canvasLayersMB` is the two bitmap layers).
 *
 * `--software` uses Chromium's software rasterizer (no GPU), a stand-in for a weak machine.
 * Uses the installed Google Chrome (channel "chrome") and falls back to Playwright's Chromium.
 * Not part of CI. One run at a time, on a quiet machine: `nice -n 19 npx tsx tools/perf-canvas.ts`.
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from '@playwright/test';
import { aggregate, attachProbe, compact, topSelf } from './perf-canvas-probe';
import type { BenchResult } from './perf-canvas-page';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv;
const opt = (name: string, def: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i > 0 ? (argv[i + 1] ?? def) : def;
};
const COUNTS = opt('n', '500,2000,5000').split(',').map(Number);
const DPRS = opt('dpr', '1,2').split(',').map(Number);
const [VW, VH] = opt('size', '1920x1080').split('x').map(Number) as [number, number];
const RUNS = Number(opt('runs', '1'));
const SOFTWARE = argv.includes('--software');
/** `v2`: the second iteration's objects (rotated, grouped, formatted, new shapes) and its commands (templates, align, group rotation). */
const MIX = opt('mix', 'h9');
/** `--profile zoom`: the top functions by self time during the zoom frames (CDP sampling profiler). */
const PROFILE = opt('profile', '');

async function bundle(): Promise<string> {
  const require = createRequire(import.meta.url);
  const esbuild = require('esbuild') as typeof import('esbuild');
  const out = await esbuild.build({
    entryPoints: [resolve(here, 'perf-canvas-page.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    write: false,
    minify: false,
    logLevel: 'error',
  });
  const f = out.outputFiles[0];
  if (!f) throw new Error('esbuild produced nothing');
  return f.text;
}

async function launch(): Promise<Browser> {
  const args = ['--mute-audio', ...(SOFTWARE ? ['--disable-gpu', '--use-gl=disabled'] : [])];
  try {
    return await chromium.launch({ channel: 'chrome', args });
  } catch {
    return chromium.launch({ args });
  }
}

const html = (w: number, h: number): string =>
  `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#111"><canvas id="c" style="display:block;width:${w}px;height:${h}px"></canvas></body>`;

async function main(): Promise<void> {
  const code = await bundle();
  const out: unknown[] = [];
  for (const dpr of DPRS) {
    for (const n of COUNTS) {
      const runs: unknown[] = [];
      for (let r = 0; r < RUNS; r++) {
        const browser = await launch();
        try {
          const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: dpr });
          const page = await ctx.newPage();
          page.on('pageerror', (e) => console.error('pageerror', e));
          await page.setContent(html(VW, VH));
          const probe = await attachProbe(browser, page, async (name, cdp) => {
            if (!PROFILE) return;
            if (name === `${PROFILE}-start`) {
              await cdp.send('Profiler.enable');
              await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
              await cdp.send('Profiler.start');
            } else if (name === `${PROFILE}-end`) {
              const { profile } = (await cdp.send('Profiler.stop')) as { profile: Parameters<typeof topSelf>[0] };
              console.error(`--- top self time during ${PROFILE}\n${topSelf(profile).join('\n')}`);
            }
          });
          await page.addScriptTag({ content: code });
          const res = (await page.evaluate(([count, d, m]) => (window as unknown as { __bench: { run(n: number, dpr: number, mix: string): Promise<unknown> } }).__bench.run(count as number, d as number, m as string), [n, dpr, MIX] as const)) as BenchResult;
          const heapDocMB = Math.round((probe.heapMB('gc:engine-before') - probe.heapMB('gc:start')) * 100) / 100;
          const heapEngineMB = Math.round((probe.heapMB('gc:engine-after') - probe.heapMB('gc:engine-before')) * 100) / 100;
          runs.push({ ...res, heapDocMB, heapEngineMB, rendererRssMB: probe.rssMB('gc:engine-after') });
          await probe.close();
          await ctx.close();
        } finally {
          await browser.close();
        }
        console.error(`dpr=${dpr} n=${n} run ${r + 1}/${RUNS} done`);
      }
      out.push({ dpr, objects: n, runs: RUNS, agg: compact(aggregate(runs)) });
    }
  }
  console.log(JSON.stringify({ viewport: `${VW}x${VH}`, software: SOFTWARE, mix: MIX, results: out }, null, 2));
}

void main();
