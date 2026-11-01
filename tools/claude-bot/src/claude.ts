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

/** Tool calls of a stream-json run: made, answered without error, refused by permissions, failed otherwise. */
export interface ToolStats {
  calls: number;
  ok: number;
  denied: number;
  failed: number;
}

/** Counts tool calls in a stream-json transcript fed chunk by chunk (only whole lines are parsed). */
export class ToolCounter {
  readonly stats: ToolStats = { calls: 0, ok: 0, denied: 0, failed: 0 };
  private rest = '';

  feed(chunk: string): void {
    const lines = (this.rest + chunk).split('\n');
    this.rest = lines.pop() ?? '';
    if (this.rest.length > 4_000_000) this.rest = ''; // a giant line: give up on it
    for (const line of lines) this.line(line);
  }

  end(): ToolStats {
    if (this.rest) this.line(this.rest);
    this.rest = '';
    return this.stats;
  }

  private line(line: string): void {
    if (!line.startsWith('{')) return;
    let ev: { type?: string; subtype?: string; message?: { content?: unknown } };
    try {
      ev = JSON.parse(line) as typeof ev;
    } catch {
      return;
    }
    if (ev.type === 'system' && ev.subtype === 'permission_denied') {
      this.stats.denied++;
      return;
    }
    const content = Array.isArray(ev.message?.content) ? (ev.message.content as { type?: string; is_error?: boolean; content?: unknown }[]) : [];
    for (const c of content) {
      if (ev.type === 'assistant' && c.type === 'tool_use') this.stats.calls++;
      if (ev.type === 'user' && c.type === 'tool_result') {
        if (c.is_error !== true) this.stats.ok++;
        else if (!/^Permission to use .* has been denied/.test(typeof c.content === 'string' ? c.content : '')) this.stats.failed++;
      }
    }
  }
}

/** One line for daemon.log; loud when the run could do nothing. */
export function toolOutcome(s: ToolStats): { line: string; allDenied: boolean } {
  const allDenied = s.calls > 0 && s.denied >= s.calls;
  const line = `tools: ${String(s.calls)} call(s), ${String(s.ok)} ok, ${String(s.denied)} denied, ${String(s.failed)} failed`;
  return { line: allDenied ? `WARNING every tool call was denied — the run could do nothing (${line})` : line, allDenied };
}

export function runLead(opts: { bin: string; argv: string[]; cwd: string; env: NodeJS.ProcessEnv; logFile: string; timeoutMs: number; stdin?: string }): Promise<RunResult & { tools: ToolStats }> {
  return new Promise((resolve) => {
    const log = createWriteStream(opts.logFile, { flags: 'a', mode: 0o600 });
    const child = spawn(opts.bin, opts.argv, { cwd: opts.cwd, env: opts.env, stdio: [opts.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => undefined);
      child.stdin.end(opts.stdin);
    }
    // Keep only the tail in memory: the result line is last.
    let tail = '';
    let timedOut = false;
    const counter = new ToolCounter();
    child.stdout?.on('data', (d: Buffer) => {
      log.write(d);
      const text = d.toString('utf8');
      counter.feed(text);
      tail = (tail + text).slice(-1_000_000);
    });
    child.stderr?.on('data', (d: Buffer) => log.write(d));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
    }, opts.timeoutMs);
    const done = (code: number | null): void => {
      clearTimeout(timer);
      log.end();
      const r = resultFromStream(tail);
      resolve({ code, result: r?.result ?? '', isError: r ? r.isError : true, timedOut, tools: counter.end() });
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
