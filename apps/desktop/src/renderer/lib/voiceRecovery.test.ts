import { describe, expect, it } from 'vitest';
import {
  LONG_HIDE_MS,
  MIC_MUTED_RESTART_MS,
  MIC_REPORT_STALE_MS,
  VISIBLE_RESUME_MS,
  afterVisible,
  audioFixes,
  captureWaitsForVisible,
  micFix,
  seatGraceMs,
  type MicPubView,
  type MicView,
  type VisibleView,
} from './voiceRecovery';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1';
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0';

describe('captureWaitsForVisible (WebKit queues a hidden page’s getUserMedia)', () => {
  it('every iOS browser and Safari on a Mac', () => {
    expect(captureWaitsForVisible(true, IPHONE)).toBe(true);
    expect(captureWaitsForVisible(true, IPHONE_CHROME)).toBe(true);
    expect(captureWaitsForVisible(true, MAC_SAFARI)).toBe(true);
  });

  it('not Chromium / Firefox pages, and never the desktop app', () => {
    expect(captureWaitsForVisible(true, MAC_CHROME)).toBe(false);
    expect(captureWaitsForVisible(true, FIREFOX)).toBe(false);
    expect(captureWaitsForVisible(false, IPHONE)).toBe(false);
  });
});

const visible = (p: Partial<VisibleView>): VisibleView => ({ hiddenMs: 1_000, livekit: 'connected', loop: false, waiting: false, settled: false, ...p });

describe('afterVisible', () => {
  it('our rejoin cycle: wakes a waiting backoff, leaves an attempt in flight alone', () => {
    expect(afterVisible(visible({ loop: true, waiting: true, livekit: 'none' }))).toBe('wake');
    expect(afterVisible(visible({ loop: true, livekit: 'none' }))).toBe('ok');
  });

  it('LiveKit gone (Disconnected) after any hide: rejoin at once', () => {
    expect(afterVisible(visible({ livekit: 'none', hiddenMs: 0 }))).toBe('rejoin');
  });

  it('short hide: a resuming LiveKit gets the visible grace, a connected one is fine', () => {
    expect(afterVisible(visible({ livekit: 'reconnecting' }))).toBe('watch');
    expect(afterVisible(visible({}))).toBe('ok');
  });

  it('long hide: not connected → rejoin now; «connected» is looked at once more', () => {
    expect(afterVisible(visible({ hiddenMs: LONG_HIDE_MS, livekit: 'reconnecting' }))).toBe('rejoin');
    expect(afterVisible(visible({ hiddenMs: LONG_HIDE_MS }))).toBe('settle');
    expect(afterVisible(visible({ hiddenMs: LONG_HIDE_MS, settled: true }))).toBe('ok');
    expect(afterVisible(visible({ hiddenMs: LONG_HIDE_MS, settled: true, livekit: 'reconnecting' }))).toBe('rejoin');
  });
});

describe('seatGraceMs', () => {
  it('visible: the rest of VISIBLE_RESUME_MS of visible reconnecting', () => {
    expect(seatGraceMs({ visible: true, reconnectingVisibleMs: 0, hiddenGraceMs: 5_000 })).toBe(VISIBLE_RESUME_MS);
    expect(seatGraceMs({ visible: true, reconnectingVisibleMs: 4_000, hiddenGraceMs: 5_000 })).toBe(VISIBLE_RESUME_MS - 4_000);
    expect(seatGraceMs({ visible: true, reconnectingVisibleMs: VISIBLE_RESUME_MS + 1, hiddenGraceMs: 5_000 })).toBe(0);
  });

  it('hidden: the old grace, unchanged', () => {
    expect(seatGraceMs({ visible: false, reconnectingVisibleMs: 0, hiddenGraceMs: 5_000 })).toBe(5_000);
  });
});

const pub = (p: Partial<MicPubView>): MicPubView => ({ sid: 'TR_a', desired: true, track: true, element: true, tries: 0, ...p });

describe('audioFixes (every subscribed mic has an <audio>)', () => {
  it('a healthy room needs nothing', () => {
    expect(audioFixes([pub({}), pub({ sid: 'TR_b' })], { deafened: false, maxTries: 2 })).toEqual([]);
  });

  it('a track without an element is attached; a mic never asked for is subscribed', () => {
    expect(audioFixes([pub({ element: false }), pub({ sid: 'TR_b', desired: false, track: false, element: false })], { deafened: false, maxTries: 2 })).toEqual([
      { kind: 'attach', sid: 'TR_a' },
      { kind: 'subscribe', sid: 'TR_b' },
    ]);
  });

  it('asked for with no track: resubscribed, at most maxTries times', () => {
    const stuck = pub({ track: false, element: false });
    expect(audioFixes([stuck], { deafened: false, maxTries: 2 })).toEqual([{ kind: 'resubscribe', sid: 'TR_a' }]);
    expect(audioFixes([{ ...stuck, tries: 2 }], { deafened: false, maxTries: 2 })).toEqual([]);
  });

  it('deafened: nothing is received on purpose', () => {
    expect(audioFixes([pub({ track: false, element: false })], { deafened: true, maxTries: 2 })).toEqual([]);
  });
});

const mic = (p: Partial<MicView>): MicView => ({ canCapture: true, ctx: 'running', ended: false, muted: false, mutedMs: 0, reportAgeMs: 20, resumes: 0, restarts: 0, ...p });

describe('micFix', () => {
  it('healthy: running context, live unmuted track, reports flowing (or none yet)', () => {
    expect(micFix(mic({}))).toEqual({ kind: 'ok' });
    expect(micFix(mic({ reportAgeMs: null }))).toEqual({ kind: 'ok' });
    expect(micFix(mic({ canCapture: false }))).toEqual({ kind: 'ok' });
  });

  it('never restarts the capture of a hidden WebKit page', () => {
    expect(micFix(mic({ canCapture: false, ended: true }))).toEqual({ kind: 'wait' });
    expect(micFix(mic({ canCapture: false, muted: true, mutedMs: 60_000 }))).toEqual({ kind: 'wait' });
    expect(micFix(mic({ canCapture: false, ctx: 'suspended' }))).toEqual({ kind: 'wait' });
  });

  it('muted by the system: wait first, a restart after MIC_MUTED_RESTART_MS', () => {
    expect(micFix(mic({ muted: true, mutedMs: 500 }))).toEqual({ kind: 'muted', recheckMs: MIC_MUTED_RESTART_MS - 500 });
    expect(micFix(mic({ muted: true, mutedMs: MIC_MUTED_RESTART_MS }))).toEqual({ kind: 'restart', reason: 'muted' });
  });

  it('ended or closed: restart', () => {
    expect(micFix(mic({ ended: true }))).toEqual({ kind: 'restart', reason: 'ended' });
    expect(micFix(mic({ ctx: 'closed' }))).toEqual({ kind: 'restart', reason: 'closed' });
  });

  it('suspended / interrupted or silent: resume first, then rebuild', () => {
    expect(micFix(mic({ ctx: 'interrupted' }))).toEqual({ kind: 'resume' });
    expect(micFix(mic({ ctx: 'suspended', resumes: 2 }))).toEqual({ kind: 'restart', reason: 'suspended' });
    expect(micFix(mic({ reportAgeMs: MIC_REPORT_STALE_MS + 1 }))).toEqual({ kind: 'resume' });
    expect(micFix(mic({ reportAgeMs: MIC_REPORT_STALE_MS + 1, resumes: 2 }))).toEqual({ kind: 'restart', reason: 'silent' });
  });

  it('one rebuild per episode: then «Вас не слышно»', () => {
    expect(micFix(mic({ ended: true, restarts: 1 }))).toEqual({ kind: 'give-up' });
    expect(micFix(mic({ muted: true, mutedMs: 5_000, restarts: 1 }))).toEqual({ kind: 'give-up' });
  });
});
