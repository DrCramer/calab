/**
 * The shared timer of a canvas (ADR-0116, wave 3): `meta.timer = {state, endsAt, remainingMs, durationMs, by}`.
 * `endsAt` is a point in server time (ms since the epoch, as the starter's client estimated the server clock);
 * every client counts down from it on its own, nothing ticks on the server. A paused timer keeps `remainingMs`.
 * The field is optional and additive: a build that does not know it draws the canvas as before and leaves it alone.
 */
import type * as Y from 'yjs';

export type TimerState = 'running' | 'paused' | 'done';

export interface TimerDoc {
  readonly state: TimerState;
  /** Server time (ms) the countdown reaches zero; meaningful while running. */
  readonly endsAt: number;
  /** What is left when paused (and the full duration right after a start). */
  readonly remainingMs: number;
  readonly durationMs: number;
  /** The last person to change it. */
  readonly by: string;
}

export const TIMER_PRESETS_MIN = [1, 3, 5, 10] as const;
export const TIMER_MIN_MINUTES = 1;
export const TIMER_MAX_MINUTES = 180;
const MAX_MS = TIMER_MAX_MINUTES * 60_000;

/** Transaction origin of timer writes: not the canvas UndoManager's, so the timer is not undoable. */
export const TIMER_ORIGIN = 'canvas-timer';

export const clampMinutes = (m: number): number => (Number.isFinite(m) ? Math.min(TIMER_MAX_MINUTES, Math.max(TIMER_MIN_MINUTES, Math.round(m))) : 5);

const ms = (v: unknown, lo: number, hi: number): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);

/** `meta.timer` as the document has it, or null when absent / not well-formed. */
export function parseTimer(v: unknown): TimerDoc | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const state = o.state;
  if (state !== 'running' && state !== 'paused' && state !== 'done') return null;
  const duration = ms(o.durationMs, 1000, MAX_MS);
  const remaining = ms(o.remainingMs, 0, MAX_MS);
  const endsAt = ms(o.endsAt, 0, Number.MAX_SAFE_INTEGER);
  if (duration === null || remaining === null || endsAt === null) return null;
  return { state, endsAt, remainingMs: Math.min(remaining, duration), durationMs: duration, by: typeof o.by === 'string' ? o.by.slice(0, 64) : '' };
}

export type TimerPhase = 'none' | 'running' | 'paused' | 'ended';

export interface TimerView {
  readonly phase: TimerPhase;
  /** Whole seconds to show: rounded up, so «0:00» appears only when it is over. */
  readonly secs: number;
  readonly durationMs: number;
  readonly by: string;
}

export const NO_TIMER: TimerView = { phase: 'none', secs: 0, durationMs: 0, by: '' };

/** What to show for `t` at server time `now`. A running timer past its end is «ended» whether or not anyone wrote `done`. */
export function viewOf(t: TimerDoc | null, now: number): TimerView {
  if (!t) return NO_TIMER;
  if (t.state === 'done') return { phase: 'ended', secs: 0, durationMs: t.durationMs, by: t.by };
  if (t.state === 'paused') return { phase: 'paused', secs: Math.ceil(t.remainingMs / 1000), durationMs: t.durationMs, by: t.by };
  const left = t.endsAt - now;
  if (left <= 0) return { phase: 'ended', secs: 0, durationMs: t.durationMs, by: t.by };
  return { phase: 'running', secs: Math.ceil(left / 1000), durationMs: t.durationMs, by: t.by };
}

/** Milliseconds until the shown seconds change next; null when the timer is not running. */
export function nextTickIn(t: TimerDoc | null, now: number): number | null {
  if (t?.state !== 'running') return null;
  const left = t.endsAt - now;
  if (left <= 0) return null;
  return left % 1000 || 1000;
}

export const mmss = (secs: number): string => {
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
};

// ── writes (one transaction each) ────────────────────────────────────────────

function put(meta: Y.Map<unknown>, t: TimerDoc): void {
  meta.doc?.transact(() => meta.set('timer', t), TIMER_ORIGIN);
}

export function startTimer(meta: Y.Map<unknown>, minutes: number, by: string, now: number): TimerDoc {
  const durationMs = clampMinutes(minutes) * 60_000;
  const t: TimerDoc = { state: 'running', endsAt: Math.round(now + durationMs), remainingMs: durationMs, durationMs, by };
  put(meta, t);
  return t;
}

/** Pauses a running timer, keeping what is left. */
export function pauseTimer(meta: Y.Map<unknown>, by: string, now: number): boolean {
  const t = parseTimer(meta.get('timer'));
  if (t?.state !== 'running') return false;
  put(meta, { ...t, state: 'paused', remainingMs: Math.max(0, Math.min(t.durationMs, t.endsAt - now)), by });
  return true;
}

/** Continues a paused timer from what was left. */
export function resumeTimer(meta: Y.Map<unknown>, by: string, now: number): boolean {
  const t = parseTimer(meta.get('timer'));
  if (t?.state !== 'paused') return false;
  put(meta, { ...t, state: 'running', endsAt: Math.round(now + t.remainingMs), by });
  return true;
}

/** Marks a timer that ran out as done (the starter's client does it; everyone shows «ended» without it). */
export function finishTimer(meta: Y.Map<unknown>): boolean {
  const t = parseTimer(meta.get('timer'));
  if (t?.state !== 'running') return false;
  put(meta, { ...t, state: 'done', remainingMs: 0 });
  return true;
}

/** Removes the timer. */
export function resetTimer(meta: Y.Map<unknown>): boolean {
  if (!meta.has('timer')) return false;
  meta.doc?.transact(() => meta.delete('timer'), TIMER_ORIGIN);
  return true;
}
