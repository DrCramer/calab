/**
 * Voice after the page was away: an iPhone screen lock, another app's audio (music, a
 * video note), Safari's background tab. The connection may come back while the remote <audio>
 * stays paused, a subscribed mic has no element, or the capture is muted / its AudioContext
 * suspended — «in the room» but nobody heard. Pure decisions here; services/voice.ts carries them
 * out on events only (visibility, pageshow, Reconnected, a rejoin, a capture interruption) with
 * one-shot timers: no new continuous timer in a call (docs/14-energy.md).
 */

/** Visible and LiveKit resuming by itself: its resume gets this long before the seat check rejoins. */
export const VISIBLE_RESUME_MS = 15_000;
/**
 * Hidden at least this long and LiveKit not connected right after the page is back: its own resume
 * ran while the page was frozen and is not trusted — rejoin at once. A tuned guess (the SFU drops a
 * silent session after a while), not a measured limit.
 */
export const LONG_HIDE_MS = 20_000;
/** After a long hide LiveKit may still say Connected (the dead link not noticed yet): looked at once more after this. */
export const VISIBLE_SETTLE_MS = 2_000;
/** «Вы не слышите собеседников» stays this long (offered again by the next event while still refused). */
export const PLAYBACK_PROMPT_MS = 2 * 60_000;
/** A subscribed mic gets its <audio> within this; checked after it. */
export const AUDIO_SETTLE_MS = 3_000;
/** Resubscriptions of one mic publication per connection (setSubscribed false → true), never a rejoin. */
export const RESUBSCRIBE_TRIES = 2;
/** The pause between the unsubscribe and the subscribe of a resubscription (the SFU sees two changes). */
export const RESUBSCRIBE_GAP_MS = 500;
/** A capture event (mute, unmute, context state) or the page coming back: the mic is checked after this. */
export const MIC_SETTLE_MS = 1_500;
/** The capture muted by the system this long while it may restart (visible): restart it. */
export const MIC_MUTED_RESTART_MS = 2_000;
/** No worklet report for this long while the context runs: the graph is dead. */
export const MIC_REPORT_STALE_MS = 2_000;
/** AudioContext.resume() tries per episode before the pipeline is rebuilt. */
export const MIC_RESUME_TRIES = 2;
/** Pipeline rebuilds per episode (an episode ends when the mic is healthy or the page comes back). */
export const MIC_RESTARTS = 1;

export type LinkState = 'connected' | 'reconnecting' | 'none';

/**
 * WebKit queues a getUserMedia of a page that is not visible (docs/mobile/locked-audio-findings.md):
 * the capture is never restarted there while hidden. Every iOS browser is WebKit; on a Mac only
 * Safari is. The desktop app (Chromium) and Chromium / Firefox pages capture while hidden.
 */
export function captureWaitsForVisible(web: boolean, userAgent: string): boolean {
  if (!web) return false;
  if (/\b(iPhone|iPad|iPod)\b/.test(userAgent)) return true;
  return /AppleWebKit\//.test(userAgent) && !/(Chrome|Chromium|Edg|OPR|Firefox)\//.test(userAgent);
}

/** What to do when the page becomes visible again while I have a voice seat. */
export type VisibleVerdict =
  /** Nothing about the link (the audio and the mic are still checked). */
  | 'ok'
  /** Our rejoin cycle waits out a backoff: start its attempt now. */
  | 'wake'
  /** Rejoin now with a fresh token, without the 5 s / 30 s timers. */
  | 'rejoin'
  /** LiveKit resumes by itself after a short hide: the seat check gives it the visible grace. */
  | 'watch'
  /** A long hide and LiveKit still says Connected: look again after VISIBLE_SETTLE_MS. */
  | 'settle';

export interface VisibleView {
  hiddenMs: number;
  livekit: LinkState;
  /** Our rejoin cycle runs (services/voice.ts rejoin). */
  loop: boolean;
  /** …and waits out a backoff right now. */
  waiting: boolean;
  /** This is the second look (VISIBLE_SETTLE_MS after the page came back). */
  settled: boolean;
}

export function afterVisible(v: VisibleView): VisibleVerdict {
  if (v.loop) return v.waiting ? 'wake' : 'ok';
  if (v.livekit === 'none') return 'rejoin';
  const long = v.hiddenMs >= LONG_HIDE_MS;
  if (v.livekit === 'reconnecting') return long || v.settled ? 'rejoin' : 'watch';
  return long && !v.settled ? 'settle' : 'ok';
}

/**
 * How long the seat check waits for LiveKit's own resume (it is reconnecting, the gateway is back).
 * Visible: up to VISIBLE_RESUME_MS of reconnecting while visible in total — a resume keeps the
 * session, a rejoin starts a new one. Hidden: the old short grace (`hiddenGraceMs`).
 */
export function seatGraceMs(v: { visible: boolean; reconnectingVisibleMs: number; hiddenGraceMs: number }): number {
  if (!v.visible) return v.hiddenGraceMs;
  return Math.max(0, VISIBLE_RESUME_MS - v.reconnectingVisibleMs);
}

/** One remote mic publication as the audio check sees it. */
export interface MicPubView {
  /** The publication's track sid. */
  sid: string;
  /** We asked for it (RemoteTrackPublication.isDesired). */
  desired: boolean;
  /** LiveKit handed us the track. */
  track: boolean;
  /** Its <audio> is in RemoteAudioOut. */
  element: boolean;
  /** Resubscriptions already spent on it. */
  tries: number;
}

export type AudioFix =
  /** Subscribed with a track but no element (TrackSubscribed lost while reconnecting): attach it. */
  | { kind: 'attach'; sid: string }
  /** Not even asked for (a TrackPublished missed): subscribe. */
  | { kind: 'subscribe'; sid: string }
  /** Asked for, no track after the settle (TrackSubscriptionFailed, a stale SFU state): resubscribe. */
  | { kind: 'resubscribe'; sid: string };

/**
 * Every subscribed remote mic must have an element (docs/02 «Подписки»: all mics, unless deafened).
 * Bounded: a publication that still has no track after `maxTries` resubscriptions is left alone.
 */
export function audioFixes(pubs: readonly MicPubView[], opts: { deafened: boolean; maxTries: number }): AudioFix[] {
  if (opts.deafened) return [];
  const out: AudioFix[] = [];
  for (const p of pubs) {
    if (p.element) continue;
    if (p.track) out.push({ kind: 'attach', sid: p.sid });
    else if (!p.desired) out.push({ kind: 'subscribe', sid: p.sid });
    else if (p.tries < opts.maxTries) out.push({ kind: 'resubscribe', sid: p.sid });
  }
  return out;
}

/** The capture as the mic check sees it (lib/media/micPipeline.ts `health`). */
export interface MicView {
  /** A capture may start now: not a hidden WebKit page (captureWaitsForVisible). */
  canCapture: boolean;
  /** AudioContext.state: 'running' | 'suspended' | 'interrupted' (WebKit) | 'closed'. */
  ctx: string;
  /** The raw capture track ended. */
  ended: boolean;
  /** The raw capture track is muted by the system (another app holds the mic, an interruption). */
  muted: boolean;
  /** How long it has been muted while a capture could start. */
  mutedMs: number;
  /** Since the last worklet report; null = none yet (not every engine pulls an analysis-only node). */
  reportAgeMs: number | null;
  /** AudioContext resumes tried in this episode. */
  resumes: number;
  /** Pipeline rebuilds tried in this episode. */
  restarts: number;
}

export type MicFix =
  | { kind: 'ok' }
  /** Hidden WebKit page: nothing now (a capture would queue), checked again when visible. */
  | { kind: 'wait' }
  /** Resume the AudioContext and look again. */
  | { kind: 'resume' }
  /** Muted by the system: «Ждём микрофон»; looked at again after `recheckMs`. */
  | { kind: 'muted'; recheckMs: number }
  | { kind: 'restart'; reason: 'ended' | 'closed' | 'muted' | 'suspended' | 'silent' }
  /** The rebuild did not help: «Вас не слышно». */
  | { kind: 'give-up' };

export function micFix(v: MicView): MicFix {
  const stale = v.reportAgeMs !== null && v.reportAgeMs > MIC_REPORT_STALE_MS;
  const running = v.ctx === 'running';
  if (!v.ended && !v.muted && running && !stale) return { kind: 'ok' };
  if (!v.canCapture) return { kind: 'wait' };
  const restart = (reason: Extract<MicFix, { kind: 'restart' }>['reason']): MicFix => (v.restarts < MIC_RESTARTS ? { kind: 'restart', reason } : { kind: 'give-up' });
  if (v.ended) return restart('ended');
  if (v.ctx === 'closed') return restart('closed');
  if (v.muted) return v.mutedMs >= MIC_MUTED_RESTART_MS ? restart('muted') : { kind: 'muted', recheckMs: MIC_MUTED_RESTART_MS - v.mutedMs };
  if (v.resumes < MIC_RESUME_TRIES) return { kind: 'resume' };
  return restart(running ? 'silent' : 'suspended');
}
