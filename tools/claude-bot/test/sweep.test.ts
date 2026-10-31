import { describe, expect, it } from 'vitest';
import { ToolCounter, toolOutcome } from '../src/claude.js';
import { installCrashGuard } from '../src/guard.js';
import type { BoardItem } from '../src/poll.js';
import { emptySweep, markSeen, markSweep, reasons, sweepBoard, sweepChanges, sweepDue } from '../src/sweep.js';

const BOT = 'bot-id';
const task = (o: Partial<BoardItem> = {}): BoardItem => ({ title: 'Bug', status: 'Todo', comments: 0, createdBy: 'u-anna', roomId: 'room', labels: ['bug', 'Voice'], priority: 2, ...o });

/** A fake board API: the newest message author per room, and how many lookups were made. */
function api(lastByRoom: Record<string, string>) {
  const looked: string[] = [];
  return {
    looked,
    deps: {
      botId: BOT,
      lastAuthor: (roomId: string) => {
        looked.push(roomId);
        return Promise.resolve(lastByRoom[roomId]);
      },
    },
  };
}

describe('sweep timing', () => {
  it('is due at the first poll after 10:00 and again after 15:00, once each per day', () => {
    const st = emptySweep();
    expect(sweepDue(st, 9, '2026-10-28')).toBeNull();
    expect(sweepDue(st, 10, '2026-10-28')).toBe(10);
    markSweep(st, '2026-10-28', 10);
    expect(sweepDue(st, 13, '2026-10-28')).toBeNull();
    expect(sweepDue(st, 15, '2026-10-28')).toBe(15);
    markSweep(st, '2026-10-28', 15);
    expect(sweepDue(st, 22, '2026-10-28')).toBeNull();
    expect(sweepDue(st, 10, '2026-10-29')).toBe(10); // a new day
  });

  it('a daemon started in the afternoon sweeps once, not twice', () => {
    const st = emptySweep();
    expect(sweepDue(st, 16, '2026-10-28')).toBe(15);
    markSweep(st, '2026-10-28', 15);
    expect(st.slots.sort()).toEqual([10, 15]);
    expect(sweepDue(st, 17, '2026-10-28')).toBeNull();
  });
});

describe('sweep rules', () => {
  it('flags Todo tasks without a type label, without a priority, or with someone else\'s last comment', () => {
    expect(reasons(task({ labels: ['Voice'] }), undefined, BOT)).toEqual(['no type label']);
    expect(reasons(task({ priority: 0 }), undefined, BOT)).toEqual(['no priority']);
    expect(reasons(task({ comments: 2 }), 'u-anna', BOT)).toEqual(['last comment not by the bot']);
    expect(reasons(task({ comments: 2 }), BOT, BOT)).toEqual([]);
    expect(reasons(task({ labels: [], priority: 0, status: 'В работе' }), undefined, BOT)).toEqual([]);
    // snapshots from before the sweep have no labels/priority: no guessing
    expect(reasons({ title: 'x', status: 'Todo', comments: 0, createdBy: 'u', roomId: 'r' }, undefined, BOT)).toEqual([]);
  });

  it('queues tasks as sweep:#N, looks up comment authors only when there are comments, and skips seen ones', async () => {
    const st = emptySweep();
    const board = {
      '#3': task({ labels: [], roomId: 'r3' }),
      '#5': task({ comments: 1, roomId: 'r5' }),
      '#7': task({ comments: 4, roomId: 'r7' }),
      '#8': task({ status: 'Готово', labels: [], roomId: 'r8' }),
      '#9': task({ roomId: 'r9' }),
    };
    const { deps, looked } = api({ r5: 'u-anna', r7: BOT });
    expect(await sweepBoard(board, st, deps)).toBe(2);
    expect(looked).toEqual(['r5', 'r7']);
    const ch = sweepChanges(st, board, new Set());
    expect(ch.map((c) => [c.key, c.what, c.trusted, c.source])).toEqual([
      ['sweep:#3', ['sweep: no type label'], true, 'board'],
      ['sweep:#5', ['sweep: last comment not by the bot'], true, 'board'],
    ]);
    // a regular change of the same task is not listed twice
    expect(sweepChanges(st, board, new Set(['#5'])).map((c) => c.key)).toEqual(['sweep:#3']);
    // the wake looked at them: not swept again until they change
    markSeen(st, board, ['sweep:#3', '#5']);
    expect(st.pending).toEqual({});
    expect(await sweepBoard(board, st, api({ r5: 'u-anna' }).deps)).toBe(0);
    // a new comment on #5 by someone else: back in
    const later = { ...board, '#5': task({ comments: 2, roomId: 'r5' }) };
    expect(await sweepBoard(later, st, api({ r5: 'u-boris' }).deps)).toBe(1);
    expect(Object.keys(st.pending)).toEqual(['#5']);
  });

  it('keeps an entry pending until a wake takes it; drops it when the task leaves Todo', async () => {
    const st = emptySweep();
    const board = { '#3': task({ priority: 0 }), '#4': task({ labels: [] }) };
    await sweepBoard(board, st, api({}).deps);
    // a wake was blocked (cap, cooldown): the 15:00 sweep finds nothing new, the entries are still there
    expect(await sweepBoard(board, st, api({}).deps)).toBe(0);
    expect(sweepChanges(st, board, new Set())).toHaveLength(2);
    // someone moved #4 to work meanwhile
    expect(sweepChanges(st, { ...board, '#4': task({ labels: [], status: 'В работе' }) }, new Set()).map((c) => c.key)).toEqual(['sweep:#3']);
    expect(Object.keys(st.pending)).toEqual(['#3']);
  });

  it('caps a sweep and its author lookups', async () => {
    const st = emptySweep();
    const board = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`#${String(i + 1)}`, task({ priority: 0, comments: 1, roomId: `r${String(i)}` })]));
    const { deps, looked } = api({});
    expect(await sweepBoard(board, st, { ...deps, max: 15, lookups: 5 })).toBe(15);
    expect(looked).toHaveLength(5);
    expect(Object.keys(st.pending).slice(0, 3)).toEqual(['#1', '#2', '#3']);
  });

  it('forgets tasks that left the board', () => {
    const st = emptySweep();
    st.seen = { '#1': 'x', '#2': 'y' };
    markSeen(st, { '#2': task() }, []);
    expect(st.seen).toEqual({ '#2': 'y' });
    markSeen(st, { '#2': task() }, ['#2']);
    expect(st.seen['#2']).not.toBe('y');
    markSeen(st, {}, []);
    expect(st.seen).toEqual({});
  });
});

describe('wake outcome', () => {
  it('counts tool calls, denials and failures from the stream, across chunk boundaries', () => {
    const lines = [
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__calab__board_list' }, { type: 'tool_use', name: 'Bash' }] } },
      { type: 'system', subtype: 'permission_denied', tool_name: 'Bash' },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'list' }, { type: 'tool_result', is_error: true, content: 'Permission to use Bash with command x has been denied.' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__calab__board_status' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'status: one of …' }] }] } },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n');
    const c = new ToolCounter();
    for (let i = 0; i < lines.length; i += 37) c.feed(lines.slice(i, i + 37));
    expect(c.end()).toEqual({ calls: 3, ok: 1, denied: 1, failed: 1 });
    expect(toolOutcome({ calls: 3, ok: 1, denied: 1, failed: 1 })).toEqual({ line: 'tools: 3 call(s), 1 ok, 1 denied, 1 failed', allDenied: false });
  });

  it('warns loudly when every call was denied (the 28.10 failure)', () => {
    const o = toolOutcome({ calls: 4, ok: 0, denied: 4, failed: 0 });
    expect(o.allDenied).toBe(true);
    expect(o.line).toMatch(/^WARNING every tool call was denied/);
    expect(toolOutcome({ calls: 0, ok: 0, denied: 0, failed: 0 }).allDenied).toBe(false);
  });
});

describe('crash guard', () => {
  function setup(status: string, opts: { maxErrors?: number } = {}) {
    const handlers = new Map<string, (e: unknown) => void>();
    const timers: (() => void)[] = [];
    const logs: string[] = [];
    const exits: number[] = [];
    let s = status;
    installCrashGuard({
      proc: {
        on: (ev, fn) => handlers.set(ev, fn),
      },
      log: (l) => logs.push(l),
      gatewayStatus: () => s,
      exit: (c) => exits.push(c),
      redact: (x) => x.replace(/calab_bot_\w+/g, '[скрыто]'),
      setTimer: (fn) => timers.push(fn),
      ...opts,
    });
    const flush = () => {
      for (const t of timers.splice(0)) t();
    };
    return { handlers, logs, exits, flush, set: (x: string) => (s = x) };
  }

  it('logs an uncaught WebSocket error without exiting and checks the gateway came back', () => {
    const g = setup('reconnecting');
    g.handlers.get('uncaughtException')?.(new Error('WebSocket was closed before the connection was established, token calab_bot_abc123'));
    expect(g.logs[0]).toMatch(/^warning: uncaught exception, the daemon keeps running: Error: WebSocket was closed/);
    expect(g.logs[0]).not.toContain('calab_bot_abc123');
    expect(g.exits).toEqual([]);
    g.set('ready');
    g.flush();
    expect(g.logs.at(-1)).toBe('gateway recovered after the error');
    expect(g.exits).toEqual([]);
  });

  it('exits non-zero on purpose when the gateway does not recover, saying why', () => {
    const g = setup('reconnecting');
    g.handlers.get('unhandledRejection')?.('boom');
    g.flush(); // the recovery check
    expect(g.logs.at(-1)).toMatch(/exiting \(launchd restarts the daemon\): the gateway did not recover/);
    g.flush(); // the short delay
    expect(g.exits).toEqual([1]);
  });

  it('exits when errors keep coming', () => {
    const g = setup('ready', { maxErrors: 3 });
    for (let i = 0; i < 4; i++) g.handlers.get('uncaughtException')?.(new Error(`e${String(i)}`));
    expect(g.logs.some((l) => /exiting .*4 errors/.test(l))).toBe(true);
  });
});
