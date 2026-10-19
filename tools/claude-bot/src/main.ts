// Mr.Claude daemon (tools/claude-bot/README.md): `/check` starts one headless lead run on Opus; a DM or a
// mention in a task chat gets an answer from a sandboxed Sonnet assistant.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { ApiError, Bot, GatewayFatalError, type CommandEvent, type Message, type WorkspaceMember } from '@calaba/bot-sdk';
import { MessageKind, RoomType } from '@calaba/protocol';
import { assistArgv, leadArgv } from './argv.js';
import { buildChatPrompt, CONTEXT_MESSAGES, MAX_ANSWER } from './chat.js';
import { runAssistant, runLead } from './claude.js';
import { childEnv, loadConfig } from './config.js';
import { gate, roomAllowed } from './gate.js';
import { RateLimiter } from './ratelimit.js';
import { redact, trimTo } from './redact.js';
import { RunLock } from './runlock.js';

const installDir = dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig(process.env, installDir);
mkdirSync(cfg.logDir, { recursive: true });

const log = (...a: unknown[]): void => {
  console.log(new Date().toISOString(), ...a);
};

const hhmm = (t: number): string => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', ...(cfg.timeZone ? { timeZone: cfg.timeZone } : {}) });

function readPrompt(name: string): string {
  for (const dir of cfg.promptDirs) {
    const p = join(dir, name);
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  throw new Error(`prompt ${name} not found in ${cfg.promptDirs.join(', ')}`);
}

const bot = new Bot(cfg.token, { server: cfg.apiUrl, log: (m) => {
  log('[sdk]', m);
} });
const lock = new RunLock(cfg.cooldownMs);
const limiter = new RateLimiter(10, 10 * 60_000);
const env = childEnv(process.env);
let workspaceId = cfg.workspaceId;

// ---- members (gate + names), cached for 5 minutes ----

const memberCache = new Map<string, { at: number; member: WorkspaceMember | null }>();

async function memberOf(userId: string): Promise<WorkspaceMember | null> {
  const hit = memberCache.get(userId);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.member;
  let member: WorkspaceMember | null = null;
  try {
    member = (await bot.members.get(workspaceId, userId)).member ?? null;
  } catch (err) {
    if (!(err instanceof ApiError) || (err.status !== 404 && err.status !== 403)) throw err;
  }
  memberCache.set(userId, { at: Date.now(), member });
  return member;
}

const nameOf = (m: WorkspaceMember | null): string => m?.nickname || m?.user?.displayName || 'Участник';

async function allowed(userId: string): Promise<{ ok: boolean; name: string; isBot: boolean }> {
  const m = await memberOf(userId);
  const g = gate(m, workspaceId);
  return { ok: g.ok, name: nameOf(m), isBot: !g.ok && g.reason === 'bot' };
}

// ---- rooms ----

const roomCache = new Map<string, { workspaceId: string; type: RoomType }>();

async function roomMeta(roomId: string): Promise<{ workspaceId: string; type: RoomType }> {
  if (bot.isDm(roomId)) return { workspaceId: '', type: RoomType.DM };
  const hit = roomCache.get(roomId);
  if (hit) return hit;
  const r = await bot.room(roomId);
  const meta = { workspaceId: r.workspaceId, type: r.type };
  roomCache.set(roomId, meta);
  return meta;
}

async function say(to: Message, text: string): Promise<void> {
  await bot.reply(to, trimTo(redact(text, cfg.secrets), MAX_ANSWER));
}

// ---- /check: one lead run ----

async function onCheck(cmd: CommandEvent): Promise<void> {
  const m = cmd.message;
  if (!roomAllowed(cmd.workspaceId, workspaceId)) return;
  const who = await allowed(m.authorId);
  if (!who.ok) {
    log('/check refused', m.authorId);
    if (!who.isBot) await say(m, 'Команда /check доступна только участникам пространства.');
    return;
  }
  const now = Date.now();
  const got = lock.tryAcquire(now);
  if (!got.ok) {
    if (got.reason === 'running') await say(m, `Уже работаю с ${hhmm(got.since)}, отпишусь по готовности.`);
    else await say(m, `Последний запуск был в ${hhmm(got.lastStart)}; следующий — не раньше ${hhmm(got.nextAt)}.`);
    return;
  }
  try {
    await say(m, 'Принял — смотрю доску, отпишусь в задачах.');
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    const logFile = join(cfg.logDir, `lead-${stamp}.log`);
    const prompt = `${readPrompt('lead-prompt.md')}\n\nЗапуск попросил(а): ${who.name}, ${new Date(now).toISOString()}.`;
    log('/check by', who.name, '→ lead run, log', logFile);
    void runLead({ bin: cfg.claudeBin, argv: leadArgv(prompt), cwd: cfg.leadRepo, env, logFile, timeoutMs: cfg.leadTimeoutMs })
      .then(async (r) => {
        const mins = Math.round((Date.now() - now) / 60_000);
        log('lead run done', { code: r.code, isError: r.isError, timedOut: r.timedOut, mins });
        const head = `Итог /check (запуск ${hhmm(now)}, ${mins} мин):`;
        const body = r.result.trim()
          ? trimTo(r.result, 3500)
          : r.timedOut
            ? 'Запуск прерван по таймауту, итога нет. Подробности — в логе на машине владельца.'
            : `Запуск завершился без итога (код ${String(r.code)}). Подробности — в логе на машине владельца.`;
        await say(m, `${head}\n${body}`);
      })
      .catch((err: unknown) => {
        log('lead run report failed', err);
      })
      .finally(() => {
        got.release();
      });
  } catch (err) {
    got.release();
    throw err;
  }
}

// ---- chat on Sonnet ----

const busy = new Set<string>();
const pending = new Map<string, Message>();
const refusedOnce = new Set<string>();

async function onMessage(m: Message): Promise<void> {
  if (m.kind === MessageKind.SYSTEM || !m.content.trim()) return;
  const meId = bot.me?.id ?? '';
  const meta = await roomMeta(m.roomId);
  let kind: 'dm' | 'task';
  if (meta.type === RoomType.DM) kind = 'dm';
  else if (meta.type === RoomType.TASK && meId && m.content.includes(`@${meId}`) && roomAllowed(meta.workspaceId, workspaceId)) kind = 'task';
  else return;
  const who = await allowed(m.authorId);
  if (!who.ok) {
    if (!who.isBot && kind === 'dm' && !refusedOnce.has(m.authorId)) {
      refusedOnce.add(m.authorId);
      await say(m, 'Я отвечаю только участникам пространства Calab.');
    }
    return;
  }
  const hit = limiter.hit(m.authorId, Date.now());
  if (!hit.ok) {
    if (hit.firstRefusal) await say(m, `Слишком много сообщений подряд — подождите ~${Math.ceil(hit.retryAfterMs / 60_000)} мин.`);
    return;
  }
  if (busy.has(m.roomId)) {
    pending.set(m.roomId, m); // answered with the fresh context when the current answer is out
    return;
  }
  await answer(m, kind, who.name);
}

async function answer(m: Message, kind: 'dm' | 'task', askerName: string): Promise<void> {
  busy.add(m.roomId);
  bot.typing(m.roomId);
  const typing = setInterval(() => {
    bot.typing(m.roomId);
  }, 4000);
  try {
    const history = (await bot.messages(m.roomId, { limit: CONTEXT_MESSAGES })).messages.slice().reverse();
    const names = new Map<string, string>();
    for (const id of new Set(history.map((h) => h.authorId))) {
      if (id && id !== bot.me?.id) names.set(id.toLowerCase(), nameOf(await memberOf(id)));
    }
    const stdin = buildChatPrompt(
      history.map((h) => ({ authorId: h.authorId, content: h.content, createdAt: h.createdAt ? timestampDate(h.createdAt) : undefined })),
      { botId: bot.me?.id ?? '', names, askerName, kind, timeZone: cfg.timeZone },
    );
    const systemPrompt = readPrompt('assistant-prompt.md').replaceAll('{{BUGBOARD}}', cfg.bugboard);
    const argv = assistArgv({ systemPrompt, bugboard: cfg.bugboard, home: homedir(), ownerRepo: cfg.ownerDir });
    const t0 = Date.now();
    const r = await runAssistant({ bin: cfg.claudeBin, argv, cwd: cfg.assistRepo, env, stdin, timeoutMs: cfg.assistTimeoutMs });
    log('assistant', { room: m.roomId, kind, code: r.code, isError: r.isError, timedOut: r.timedOut, ms: Date.now() - t0, chars: r.result.length });
    if (r.isError || !r.result.trim()) log('assistant stderr', redact(r.stderr.slice(-2000), cfg.secrets));
    await say(m, r.result.trim() && !r.isError ? r.result : 'Не получилось ответить — попробуйте ещё раз чуть позже.');
  } finally {
    clearInterval(typing);
    busy.delete(m.roomId);
  }
  const next = pending.get(m.roomId);
  if (next) {
    pending.delete(m.roomId);
    const who = await allowed(next.authorId);
    if (who.ok) await answer(next, kind, who.name);
  }
}

// ---- the assistant's checkout follows main ----

function refreshAssistRepo(): void {
  execFile('git', ['checkout', '-q', '--detach', 'main'], { cwd: cfg.assistRepo, env }, (err) => {
    if (err) log('assist repo refresh failed:', err.message);
  });
}

// ---- wiring ----

const report = (where: string) => (err: unknown) => {
  log(`${where} failed:`, err instanceof Error ? err.message : err);
};

bot.on('command', (cmd) => {
  if (cmd.name === 'check') onCheck(cmd).catch(report('/check'));
});
bot.on('message', (m) => {
  onMessage(m).catch(report('message'));
});
bot.on('status', (s) => {
  log('gateway', s);
});
bot.on('error', (err) => {
  log('error:', err.message);
  if (err instanceof GatewayFatalError) process.exit(1); // launchd restarts us
});

async function main(): Promise<void> {
  if (!workspaceId) workspaceId = (await bot.boards.get(cfg.boardId)).workspaceId;
  const cmds = await bot.commands([{ name: 'check', description: 'Проверить доску багов и взять новые задачи' }]);
  log('commands registered:', cmds.map((c) => `/${c.name}`).join(' '));
  const ready = await bot.start();
  log(`online as ${ready.me?.user?.displayName ?? '?'} · workspace ${workspaceId} · ${ready.dms.length} DM(s)`);
  refreshAssistRepo();
  setInterval(refreshAssistRepo, 60 * 60_000).unref();
  setInterval(() => {
    limiter.sweep(Date.now());
  }, 10 * 60_000).unref();
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log('stopping on', sig);
    bot.stop();
    process.exit(0);
  });
}

main().catch((err: unknown) => {
  log('fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
