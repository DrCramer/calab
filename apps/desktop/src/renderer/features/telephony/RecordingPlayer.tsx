import type { SipJournalRecording } from '@calaba/protocol';
import { FolderOpen, Pause, Play } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { IconButton, cx } from '../../components/ui';
import { t } from '../../i18n';
import { formatTime } from '../../lib/chatMedia';
import { haptics } from '../../lib/haptics';
import { openDiskHit } from '../../services/disk';
import { usePlayer, type Track } from '../../stores/player';
import { SeekBar } from '../chat/MediaPlayer';

/*
 * The recording of a call (ADR-0131, ADR-0137 §6–§7: only when GET journal/{cid} returns it — I may
 * view its Disk file). It plays through the app's one audio player (stores/player: a single
 * <audio> element, never WebAudio — docs/02), so a voice message or another recording stops it
 * and vice versa; leaving the detail stops it. «Открыть в Диске» opens the file there.
 */

/** The player track of a call's recording (one per call: «messageId» is the call). */
export function recordingTrack(callId: string, rec: SipJournalRecording, subtitle = ''): Track {
  return { fileId: rec.fileId, messageId: `sip-call:${callId}`, roomId: '', name: `${t('tel.recording')}.ogg`, title: t('tel.recording.title'), subtitle };
}

/** Play / pause the recording of a call (the phone's bar button, the row's menu). */
export function toggleRecording(callId: string, rec: SipJournalRecording, subtitle = ''): void {
  haptics.tap();
  usePlayer.getState().toggle(recordingTrack(callId, rec, subtitle));
}

const mine = (callId: string) => (s: ReturnType<typeof usePlayer.getState>): boolean => s.track?.messageId === `sip-call:${callId}`;

/** The player card: ▶ / ⏸, the progress with seeking, «0:12 / 6:20», «Открыть в Диске». */
export function RecordingPlayer({ ws, callId, rec, subtitle, phone }: { ws: string; callId: string; rec: SipJournalRecording; subtitle: string; phone: boolean }): ReactNode {
  const active = usePlayer(mine(callId));
  const playing = usePlayer((s) => mine(callId)(s) && s.playing);
  const position = usePlayer((s) => (mine(callId)(s) ? s.position : 0));
  const duration = usePlayer((s) => (mine(callId)(s) && s.duration > 0 ? s.duration : rec.durationMs / 1000));
  const failed = usePlayer((s) => mine(callId)(s) && s.error);
  // The player of this detail is on screen (no chat mini-player for it); gone with the detail.
  const token = useRef({});
  useEffect(() => {
    const who = token.current;
    if (active) usePlayer.getState().setInView(who, true);
    return () => usePlayer.getState().setInView(who, false);
  }, [active]);
  useEffect(
    () => () => {
      if (mine(callId)(usePlayer.getState())) usePlayer.getState().close();
    },
    [callId],
  );
  const track = recordingTrack(callId, rec, subtitle);
  return (
    <div className={cx('flex items-center gap-3 rounded-[var(--radius-card)] bg-[var(--color-card)]', phone ? 'mt-5 px-3 py-2' : 'mt-4 px-3 py-2.5')} role="group" aria-label={t('tel.recording.title')} data-testid="tel-recording">
      <button
        type="button"
        onClick={() => toggleRecording(callId, rec, subtitle)}
        aria-label={playing ? t('tel.recording.pause') : t('tel.recording.play')}
        className="grid size-11 shrink-0 place-items-center rounded-full bg-accent-strong text-accent-fg transition-[filter] duration-[var(--motion-fast)] hover:brightness-110"
        data-testid="tel-recording-play"
      >
        {playing ? <Pause className="size-5 fill-current" aria-hidden /> : <Play className="ml-0.5 size-5 fill-current" aria-hidden />}
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="min-w-0 truncate text-body font-medium">{t('tel.recording.title')}</span>
          <span className="shrink-0 text-caption tabular-nums text-muted" data-testid="tel-recording-time">
            {failed ? <span className="text-danger-text">{t('media.error')}</span> : active ? `${formatTime(position)} / ${formatTime(duration)}` : formatTime(duration)}
          </span>
        </div>
        <SeekBar
          label={t('media.seek')}
          position={position}
          duration={duration}
          onSeek={(sec) => usePlayer.getState().seek(track, sec)}
          className={phone ? 'h-8' : 'h-4'}
          render={(pct) => (
            <div className="relative h-[3px] w-full rounded-full bg-[var(--color-fill)]">
              <div className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${pct}%` }} />
              {active ? <div aria-hidden className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent" style={{ left: `${pct}%` }} /> : null}
            </div>
          )}
        />
      </div>
      {rec.diskItemId ? (
        <IconButton label={t('tel.recording.disk')} onClick={() => void openDiskHit(ws, { itemId: rec.diskItemId, parentId: '', folder: false })} data-testid="tel-recording-disk">
          <FolderOpen className="size-[18px]" strokeWidth={1.75} aria-hidden />
        </IconButton>
      ) : null}
    </div>
  );
}
