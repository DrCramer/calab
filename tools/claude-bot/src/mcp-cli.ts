// The stdio entry of the runs' MCP server (src/mcp.ts): Claude Code starts it from the `--mcp-config` the
// daemon passes, with the inbox directory and the run's ticket in its env. One JSON-RPC message per line.
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { HandoffError } from './inbox.js';
import { handleMessage, type ServerOptions } from './mcp.js';

const inboxDir = process.env.CALAB_HANDOFF_DIR ?? '';
const ticketId = process.env.CALAB_HANDOFF_TICKET ?? '';

const opts: ServerOptions = {
  inboxDir: inboxDir.startsWith('/') ? inboxDir : '/nonexistent',
  ticketId,
  env: process.env,
  exec: (bin, args, o) => {
    try {
      return execFileSync(bin, args, { input: o.input ?? '', env: o.env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      const e = err as { stderr?: string; status?: number | null };
      throw new HandoffError(`failed (${String(e.status ?? '?')}): ${(e.stderr ?? '').trim().slice(0, 500)}`);
    }
  },
  log: (line) => process.stderr.write(`[calab-mcp] ${line}\n`),
};

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`);
    return;
  }
  const res = handleMessage(opts, msg);
  if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
});
rl.on('close', () => process.exit(0));
