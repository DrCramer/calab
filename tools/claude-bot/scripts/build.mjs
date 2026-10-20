// Bundles the daemon into one file for plain `node` under launchd: the SDK sources (and the contract,
// protobuf runtime and `ws` they import) are inlined, so the installed copy does not depend on a checkout.
import { build } from 'esbuild';
import { URL, fileURLToPath } from 'node:url';

const sdk = fileURLToPath(new URL('../../../packages/bot-sdk/src/index.ts', import.meta.url));

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/daemon.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  alias: { '@calaba/bot-sdk': sdk },
  // ws loads these optional native helpers in try/catch.
  external: ['bufferutil', 'utf-8-validate'],
  // ws is CommonJS: give the ESM bundle a require().
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'info',
});
