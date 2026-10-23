import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  NO_TIMER, TIMER_MAX_MINUTES, clampMinutes, finishTimer, mmss, nextTickIn, parseTimer, pauseTimer, resetTimer, resumeTimer, startTimer, viewOf,
} from './timer';

const meta = (): Y.Map<unknown> => new Y.Doc().getMap('meta');

describe('meta.timer field', () => {
  it('reads a well-formed timer and drops garbage', () => {
    const t = { state: 'running', endsAt: 10_000, remainingMs: 5000, durationMs: 60_000, by: 'u' };
    expect(parseTimer(t)).toEqual(t);
    for (const bad of [null, 7, {}, { ...t, state: 'x' }, { ...t, endsAt: NaN }, { ...t, durationMs: 'a' }, { ...t, remainingMs: undefined }]) expect(parseTimer(bad)).toBeNull();
    // out-of-range numbers are clamped, not trusted
    expect(parseTimer({ ...t, durationMs: 1e12, remainingMs: 1e12 })?.durationMs).toBe(TIMER_MAX_MINUTES * 60_000);
    expect(parseTimer({ ...t, remainingMs: 1e9, durationMs: 60_000 })?.remainingMs).toBe(60_000);
  });

  it('a document without a timer reads as none', () => {
    expect(parseTimer(meta().get('timer'))).toBeNull();
    expect(viewOf(null, 0)).toBe(NO_TIMER);
  });
});

describe('what is shown', () => {
  const run = { state: 'running', endsAt: 100_000, remainingMs: 60_000, durationMs: 60_000, by: 'u' } as const;
  it('counts down from endsAt, rounding up, and is ended at zero', () => {
    expect(viewOf(run, 40_000)).toMatchObject({ phase: 'running', secs: 60 });
    expect(viewOf(run, 40_001)).toMatchObject({ phase: 'running', secs: 60 });
    expect(viewOf(run, 99_001)).toMatchObject({ phase: 'running', secs: 1 });
    expect(viewOf(run, 100_000)).toMatchObject({ phase: 'ended', secs: 0 });
    expect(viewOf(run, 130_000)).toMatchObject({ phase: 'ended' });
  });
  it('paused shows what was left; done is ended', () => {
    expect(viewOf({ ...run, state: 'paused', remainingMs: 12_300 }, 999_999)).toMatchObject({ phase: 'paused', secs: 13 });
    expect(viewOf({ ...run, state: 'done', remainingMs: 0 }, 0)).toMatchObject({ phase: 'ended', secs: 0 });
  });
  it('the next change is at the next second boundary; none unless running', () => {
    expect(nextTickIn(run, 40_000)).toBe(1000);
    expect(nextTickIn(run, 40_300)).toBe(700);
    expect(nextTickIn(run, 100_000)).toBeNull();
    expect(nextTickIn({ ...run, state: 'paused' }, 40_000)).toBeNull();
    expect(nextTickIn(null, 0)).toBeNull();
  });
  it('formats m:ss and h:mm:ss', () => {
    expect(mmss(0)).toBe('0:00');
    expect(mmss(65)).toBe('1:05');
    expect(mmss(600)).toBe('10:00');
    expect(mmss(3725)).toBe('1:02:05');
  });
  it('minutes are clamped to 1–180', () => {
    expect([clampMinutes(0), clampMinutes(1), clampMinutes(180), clampMinutes(999), clampMinutes(2.6)]).toEqual([1, 1, 180, 180, 3]);
    expect(clampMinutes(NaN)).toBe(5);
  });
});

describe('writing', () => {
  it('start, pause, resume, finish and reset are single transactions of meta.timer', () => {
    const m = meta();
    let updates = 0;
    m.doc?.on('update', () => updates++);
    const t = startTimer(m, 5, 'ann', 1_000_000);
    expect(t).toMatchObject({ state: 'running', endsAt: 1_300_000, durationMs: 300_000, remainingMs: 300_000, by: 'ann' });
    expect(parseTimer(m.get('timer'))).toEqual(t);
    expect(pauseTimer(m, 'bob', 1_100_000)).toBe(true);
    expect(parseTimer(m.get('timer'))).toMatchObject({ state: 'paused', remainingMs: 200_000, by: 'bob' });
    expect(pauseTimer(m, 'bob', 1_100_000)).toBe(false);
    expect(resumeTimer(m, 'ann', 2_000_000)).toBe(true);
    expect(parseTimer(m.get('timer'))).toMatchObject({ state: 'running', endsAt: 2_200_000, remainingMs: 200_000, by: 'ann' });
    expect(resumeTimer(m, 'ann', 2_000_000)).toBe(false);
    expect(finishTimer(m)).toBe(true);
    expect(parseTimer(m.get('timer'))).toMatchObject({ state: 'done', remainingMs: 0, by: 'ann' });
    expect(finishTimer(m)).toBe(false);
    expect(resetTimer(m)).toBe(true);
    expect(m.get('timer')).toBeUndefined();
    expect(resetTimer(m)).toBe(false);
    expect(updates).toBe(5);
  });
  it('a pause never records more than the duration or less than zero', () => {
    const m = meta();
    startTimer(m, 1, 'a', 0);
    pauseTimer(m, 'a', -5000); // clock error: before the start
    expect(parseTimer(m.get('timer'))?.remainingMs).toBe(60_000);
    resumeTimer(m, 'a', 0);
    pauseTimer(m, 'a', 999_999_999);
    expect(parseTimer(m.get('timer'))?.remainingMs).toBe(0);
  });
});
