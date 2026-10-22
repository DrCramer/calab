import { Guitar, HeadphoneOff, MicOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { micGlyph } from '../../lib/voiceLogic';
import { usePrefs } from '../../stores/prefs';
import { useVoice } from '../../stores/voice';

/** One icon of the per-participant voice state, in display order. */
export type VoiceStateIcon = 'server-muted' | 'muted' | 'deafened' | 'ptt-idle';

/**
 * Which icons a participant shows (docs/09 #15, Discord): the crossed mic first — red for a
 * moderator (server) mute, grey for a self-mute; deafen implies mute, so a deafened member shows
 * the crossed mic too, then the crossed headphones.
 */
export function voiceStateIcons(muted: boolean, deafened: boolean, serverMuted = false, pttIdle = false): VoiceStateIcon[] {
  const out: VoiceStateIcon[] = [];
  if (serverMuted) out.push('server-muted');
  else if (muted || deafened) out.push('muted');
  else if (pttIdle) out.push('ptt-idle');
  if (deafened) out.push('deafened');
  return out;
}

/** Per-participant voice state icons, 16 px: voiceStateIcons() decides which and in what order. */
export function VoiceStateIcons({
  muted,
  deafened,
  serverMuted = false,
  pttIdle = false,
  className,
}: {
  muted: boolean;
  deafened: boolean;
  serverMuted?: boolean;
  /** My mic is on but waits for the push-to-talk key (CBF-71): a pale crossed mic. */
  pttIdle?: boolean;
  className?: string;
}): ReactNode {
  return (
    <>
      {voiceStateIcons(muted, deafened, serverMuted, pttIdle).map((k) =>
        k === 'deafened' ? (
          <HeadphoneOff key={k} className={cx('size-4 shrink-0 text-muted', className)} aria-label={t('shell.deafenedState')} role="img" data-voice-icon={k} />
        ) : (
          <MicOff
            key={k}
            className={cx('size-4 shrink-0', k === 'server-muted' ? 'text-danger' : 'text-muted', k === 'ptt-idle' && 'opacity-50', className)}
            aria-label={t(k === 'server-muted' ? 'voiceUi.serverMuted' : k === 'ptt-idle' ? 'voice.pttIdleState' : 'shell.mutedState')}
            role="img"
            data-voice-icon={k}
          />
        ),
      )}
    </>
  );
}

/**
 * «Режим музыканта» of a participant (ADR-0052, VoiceState.musician): a guitar by the name, so
 * others know why they hear raw sound. The tooltip is native (no popover per row).
 */
export function MusicianIcon({ className }: { className?: string }): ReactNode {
  return (
    <span className="inline-flex shrink-0" title={t('music.badgeHint')} data-voice-icon="musician">
      <Guitar className={cx('size-4 shrink-0 text-muted', className)} aria-label={t('music.badgeHint')} role="img" />
    </span>
  );
}

/**
 * My own voice-state icons (CBF-71): the leaf that knows the push-to-talk wait. It subscribes to
 * two booleans, so a key press redraws only this icon, never the row.
 */
export function SelfVoiceStateIcons({ muted, deafened, serverMuted = false }: { muted: boolean; deafened: boolean; serverMuted?: boolean }): ReactNode {
  // A one-to-one call is voice activation only (ADR-0034): no PTT wait there.
  const pttPref = usePrefs((s) => s.micMode === 'ptt');
  const oneToOne = useVoice((s) => s.call);
  const talking = useVoice((s) => s.pttDown);
  const pttIdle = micGlyph({ muted, deafened, ptt: pttPref && !oneToOne, talking }) === 'ptt-idle';
  return <VoiceStateIcons muted={muted} deafened={deafened} serverMuted={serverMuted} pttIdle={pttIdle} />;
}
