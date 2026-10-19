/**
 * Canvas SCREEN benchmark (H5b, docs/14-energy.md): the real `CanvasView` — React, panels, sync binding — in a
 * real Chromium against the in-memory relay. tools/perf-canvas.ts measures the engine alone; this one proves
 * the screen around it adds nothing at rest: idle rAF / timer / React-commit counts over 3 s and the React
 * commits caused by pan, drag, remote edits (must be 0). Sockets and platform are stubbed (no server).
 *
 *   nice -n 19 npx tsx tools/perf-canvas-view.ts [--n 2000,5000] [--runs 5] [--software]
 *
 * Every run is a fresh page; the output is the median / min / max over `--runs` of every number. CPU is the
 * real CPU time of the Chromium processes (CDP), per phase, in % of one core. Phase list: see the page file.
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from '@playwright/test';
import { aggregate, attachProbe, compact, topSelf } from './perf-canvas-probe';
import type { ViewBenchResult } from './perf-canvas-view-page';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv;
const opt = (name: string, def: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i > 0 ? (argv[i + 1] ?? def) : def;
};
const COUNTS = opt('n', '2000').split(',').map(Number);
const RUNS = Number(opt('runs', '3'));
const SOFTWARE = argv.includes('--software');
const SITES = argv.includes('--sites');
const PROFILE = opt('profile', '');

async function bundle(): Promise<string> {
  const require = createRequire(import.meta.url);
  const esbuild = require('esbuild') as typeof import('esbuild');
  const stub = (file: string): string => resolve(here, file);
  const out = await esbuild.build({
    entryPoints: [resolve(here, 'perf-canvas-view-page.tsx')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    write: false,
    jsx: 'automatic',
    // Profiler callbacks only fire in React's profiling build.
    alias: { 'react-dom/client': 'react-dom/profiling' },
    banner: { js: 'var __noGlob = () => ({});' },
    loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl', '.mp3': 'dataurl' },
    define: { 'import.meta.env': '{}', 'import.meta.glob': '__noGlob', 'process.env.NODE_ENV': '"production"' },
    logLevel: 'error',
    plugins: [
      {
        // The app wiring (platform bridge, session) is stubbed: this bench injects its own deps.
        name: 'stub-app',
        setup(b) {
          b.onResolve({ filter: /defaultDeps$/ }, () => ({ path: stub('perf-canvas-view-stub.ts') }));
          b.onResolve({ filter: /\/platform$/ }, () => ({ path: stub('perf-canvas-view-platform.ts') }));
        },
      },
    ],
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

const PHASES = ['idle', 'hiddenIdle', 'hiddenBusy', 'cursors', 'peerEdits', 'drag'];

async function main(): Promise<void> {
  const code = await bundle();
  const out: unknown[] = [];
  for (const n of COUNTS) {
    const runs: unknown[] = [];
    for (let r = 0; r < RUNS; r++) {
      const browser = await launch();
      try {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
        const page = await ctx.newPage();
        page.on('pageerror', (e) => console.error('pageerror', e));
        page.on('console', (m) => m.type() === 'error' && console.error('console', m.text()));
        await page.setContent('<!doctype html><meta charset="utf-8"><body style="margin:0"><div id="app" style="width:1280px;height:800px;position:relative"></div></body>');
        const probe = await attachProbe(browser, page, async (name, cdp) => {
          if (!PROFILE) return;
          if (name === `${PROFILE}-start`) {
            await cdp.send('Profiler.enable');
            await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
            await cdp.send('Profiler.start');
          } else if (name === `${PROFILE}-end`) {
            const { profile } = (await cdp.send('Profiler.stop')) as { profile: Parameters<typeof topSelf>[0] };
            console.error(`--- top self time during ${PROFILE}\n${topSelf(profile).join('\n')}`);
          }
        });
        // Baseline: the same Chromium with an empty page for 10 s — what the harness itself costs.
        await probe.sample('blank-start');
        await page.waitForTimeout(10_000);
        await probe.sample('blank-end');
        if (SITES) await page.evaluate(() => ((window as unknown as { __sites: boolean }).__sites = true));
        await page.addScriptTag({ content: code });
        const res = (await page.evaluate((count) => (window as unknown as { __viewBench: { run(n: number): Promise<unknown> } }).__viewBench.run(count), n)) as ViewBenchResult;
        const cpu: Record<string, unknown> = { blank: probe.cpu('blank-start', 'blank-end') };
        for (const p of PHASES) cpu[p] = probe.cpu(`${p}-start`, `${p}-end`);
        const memory = {
          heapDocOnlyMB: probe.heapMB('gc:doc-only'),
          heapMountedMB: probe.heapMB('gc:mounted'),
          heapClientMB: Math.round((probe.heapMB('gc:mounted') - probe.heapMB('gc:doc-only')) * 100) / 100,
          rendererRssMB: probe.rssMB('gc:mounted'),
        };
        runs.push({ ...res, cpu, memory });
        await probe.close();
        await ctx.close();
      } finally {
        await browser.close();
      }
      console.error(`n=${n} run ${r + 1}/${RUNS} done`);
    }
    out.push({ objects: n, runs: RUNS, agg: compact(aggregate(runs)) });
  }
  console.log(JSON.stringify({ software: SOFTWARE, results: out }, null, 2));
}

void main();
