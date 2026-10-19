import { Headphones, HeadphoneOff, Mic, MicOff, Phone } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { IconButton, Tip, cx } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { useMobile } from '../../lib/mobile';
import { useHotkeyLabel } from '../../services/hotkeys';
import { openDm } from '../../services/dms';
import { voice } from '../../services/voice';
import { dmPeer } from '../../stores/dms';
import { useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { useVoice } from '../../stores/voice';
import { useMemberName, useWorkspaces } from '../../stores/workspaces';
import { useDisplayedPhase } from './VoiceBar';

/**
 * The voice connection at the foot of the work sections (bug board #4, 19.10; docs/08 «Нижний
 * островок»): Boards, Calendar, Disk and Wiki have no bottom island, so a compact block — status +
 * room, mic, sound, leave — lets me unmute and answer without leaving the board. Only while in
 * voice, desktop layout only (the phone has its call strip on every tab).
 *
 * Acts on the one call of this window's VoiceService (the stream pop-out is a portal of the same
 * renderer, the tray and the app menu reach it over IPC) — it never starts media of its own.
 * Leaf subscriptions: the title, the mic (my speaking) and the sound button each read their own
 * slice; a speaking tick re-renders the mic button only, never the column.
 */
export const VoiceDock = memo(function VoiceDock({ variant = 'column', className }: { variant?: 'column' | 'footer'; className?: string }): ReactNode {
  const inVoice = useVoice((s) => s.roomId !== null);
  const mobile = useMobile();
  useLocale();
  if (!inVoice || mobile) return null;
  return (
    <div
      role="region"
      aria-label={t('voice.panel')}
      data-testid="voice-dock"
      className={cx(
        'flex shrink-0 items-center gap-0.5',
        variant === 'column' ? 'mx-2 mb-2 mt-1 h-12 rounded-[var(--radius-card)] bg-[var(--color-fill)] pl-2.5 pr-1' : 'h-10 max-w-80 min-w-0 pl-2',
        className,
      )}
    >
      <DockTitle />
      <DockMic />
      <DockSound />
      <IconButton label={t('voice.leave')} danger onClick={() => void voice.leave()} data-testid="voice-dock-leave">
        {/* The island's hang-up: a handset tilted down. */}
        <Phone className="size-[18px] rotate-[135deg]" aria-hidden />
      </IconButton>
    </div>
  );
});

/** «Голос подключён» (green; yellow while connecting / reconnecting) over «Комната / Пространство»; a click opens the room. */
const DockTitle = memo(function DockTitle(): ReactNode {
  useLocale();
  const phase = useDisplayedPhase();
  const roomId = useVoice((s) => s.roomId);
  const wsId = useVoice((s) => s.workspaceId);
  const call = useVoice((s) => s.call);
  const roomName = useRooms((s) => (roomId ? (s.byId[roomId]?.name ?? '') : ''));
  const wsName = useWorkspaces((s) => (wsId ? (s.byId[wsId]?.ws.name ?? '') : ''));
  const peerName = useMemberName(null, call && roomId ? dmPeer(roomId) : '');
  if (!roomId) return null;
  const phaseText =
    phase === 'connected' ? t('voice.connected') : phase === 'reconnecting' ? t('voice.reconnecting') : phase === 'blocked' ? t('voice.blocked') : t('voice.connecting');
  const place = call ? t('call.panel', { name: peerName }) : roomName;
  const full = call ? place : t('shell.voiceIn', { room: roomName, ws: wsName });
  const go = (): void => {
    if (call) openDm(roomId);
    else if (wsId) useUi.getState().openRoom(wsId, roomId);
  };
  return (
    <Tip label={full}>
      <button
        type="button"
        onClick={go}
        aria-label={`${phaseText}: ${full}`}
        className="-ml-1 mr-0.5 flex min-w-0 flex-1 flex-col rounded-[var(--radius-icon)] px-1 py-0.5 text-left transition-colors duration-[var(--motion-fast)] hover:bg-hover"
        data-testid="voice-dock-room"
      >
        <span aria-live="polite" className={cx('truncate text-[13px] font-semibold leading-4', phase === 'connected' ? 'text-ok' : 'text-warn')}>
          {phaseText}
        </span>
        <span className="truncate text-[12px] leading-4 text-muted">{place}</span>
      </button>
    </Tip>
  );
});

/** Mic toggle; green while I speak (my own speaking flag — a leaf, re-rendered on its ticks only). */
const DockMic = memo(function DockMic(): ReactNode {
  useLocale();
  const muted = useVoice((s) => s.muted);
  const serverMuted = useVoice((s) => s.serverMuted);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const speaking = useVoice((s) => !s.muted && (s.speaking[me] ?? false));
  const keys = useHotkeyLabel('mute');
  return (
    <IconButton
      label={serverMuted ? t('voiceUi.serverMuted') : muted ? t('voice.unmute') : t('voice.mute')}
      shortcut={keys}
      danger={muted}
      className={cx(speaking && 'text-ok hover:text-ok')}
      onClick={() => voice.toggleMute()}
      data-testid="voice-dock-mic"
      data-muted={muted ? 'true' : 'false'}
    >
      {muted ? <MicOff className="size-[18px]" aria-hidden /> : <Mic className="size-[18px]" aria-hidden />}
    </IconButton>
  );
});

const DockSound = memo(function DockSound(): ReactNode {
  useLocale();
  const deafened = useVoice((s) => s.deafened);
  const keys = useHotkeyLabel('deafen');
  return (
    <IconButton
      label={deafened ? t('voice.undeafen') : t('voice.deafen')}
      shortcut={keys}
      danger={deafened}
      onClick={() => voice.toggleDeafen()}
      data-testid="voice-dock-sound"
    >
      {deafened ? <HeadphoneOff className="size-[18px]" aria-hidden /> : <Headphones className="size-[18px]" aria-hidden />}
    </IconButton>
  );
});

/**
 * The mic on the stream's full-screen / pop-out bar (bug board #4): watching a stream in its own
 * window, I still answer without going back to the main one. Same VoiceService call (the pop-out
 * is a portal of this renderer). A native `title`, not a Tip: a Tip portals into the main
 * window's document, not the pop-out's.
 */
export const OverlayMic = memo(function OverlayMic(): ReactNode {
  useLocale();
  const inVoice = useVoice((s) => s.roomId !== null);
  const muted = useVoice((s) => s.muted);
  const serverMuted = useVoice((s) => s.serverMuted);
  const keys = useHotkeyLabel('mute');
  if (!inVoice) return null;
  const label = serverMuted ? t('voiceUi.serverMuted') : muted ? t('voice.unmute') : t('voice.mute');
  return (
    <button
      type="button"
      onClick={() => voice.toggleMute()}
      aria-label={label}
      title={keys ? `${label} (${keys})` : label}
      data-testid="stream-mic"
      data-muted={muted ? 'true' : 'false'}
      className={cx(
        'grid size-7 shrink-0 place-items-center rounded-full text-white transition-colors duration-[var(--motion-fast)]',
        muted ? 'bg-[var(--color-danger)] hover:bg-[color-mix(in_srgb,var(--color-danger)_85%,white)]' : 'bg-white/15 hover:bg-white/25',
      )}
    >
      {muted ? <MicOff className="size-3.5" aria-hidden /> : <Mic className="size-3.5" aria-hidden />}
    </button>
  );
});
