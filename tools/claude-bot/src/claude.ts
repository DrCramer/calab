// Spawning claude: the lead run (stream-json into a log file, final result extracted) and the assistant
// run (json on stdout, chat on stdin).
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';

export interface RunResult {
  code: number | null;
  /** The final `result` text, '' when the run produced none. */
  result: string;
  isError: boolean;
  timedOut: boolean;
}

/** The last `{"type":"result"}` line of a stream-json transcript. */
export function resultFromStream(lines: string): { result: string; isError: boolean } | null {
  let last: { result: string; isError: boolean } | null = null;
  for (const line of lines.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const ev = JSON.parse(line) as { type?: string; result?: unknown; is_error?: unknown; subtype?: unknown };
      if (ev.type === 'result') {
        last = { result: typeof ev.result === 'string' ? ev.result : '', isError: ev.is_error === true || (typeof ev.subtype === 'string' && ev.subtype !== 'success') };
      }
    } catch {
      // a partial line: ignore
    }
  }
  return last;
}

export function runLead(opts: { bin: string; argv: string[]; cwd: string; env: NodeJS.ProcessEnv; logFile: string; timeoutMs: number }): Promise<RunResult> {
  return new Promise((resolve) => {
    const log = createWriteStream(opts.logFile, { flags: 'a' });
    const child = spawn(opts.bin, opts.argv, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    // Keep only the tail in memory: the result line is last.
    let tail = '';
    let timedOut = false;
    child.stdout.on('data', (d: Buffer) => {
      log.write(d);
      tail = (tail + d.toString('utf8')).slice(-1_000_000);
    });
    child.stderr.on('data', (d: Buffer) => log.write(d));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
    }, opts.timeoutMs);
    const done = (code: number | null): void => {
      clearTimeout(timer);
      log.end();
      const r = resultFromStream(tail);
      resolve({ code, result: r?.result ?? '', isError: r ? r.isError : true, timedOut });
    };
    child.on('error', (err) => {
      log.write(`\n[spawn error] ${err.message}\n`);
      done(null);
    });
    child.on('close', done);
  });
}

export function runAssistant(opts: { bin: string; argv: string[]; cwd: string; env: NodeJS.ProcessEnv; stdin: string; timeoutMs: number }): Promise<RunResult & { stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(opts.bin, opts.argv, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let timedOut = false;
    child.stdout.on('data', (d: Buffer) => {
      if (out.length < 2_000_000) out += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      if (err.length < 20_000) err += d.toString('utf8');
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    let settled = false;
    const done = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let result = '';
      let isError = true;
      try {
        const j = JSON.parse(out) as { result?: unknown; is_error?: unknown };
        result = typeof j.result === 'string' ? j.result : '';
        isError = j.is_error === true;
      } catch {
        // not json: the run failed before answering
      }
      resolve({ code, result, isError, timedOut, stderr: err });
    };
    child.on('error', (e) => {
      err += e.message;
      done(null);
    });
    child.on('close', done);
    child.stdin.on('error', () => undefined);
    child.stdin.end(opts.stdin);
  });
}
