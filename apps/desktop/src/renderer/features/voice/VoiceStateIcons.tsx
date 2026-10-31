import { Guitar, HeadphoneOff, MicOff, Phone } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { selfMicGlyph } from '../../lib/voiceLogic';
import { useVoice } from '../../stores/voice';
import { useSelfMic } from './selfMic';

/** One icon of the per-participant voice state, in display order. */
export type VoiceStateIcon = 'server-muted' | 'muted' | 'deafened' | 'ptt-idle' | 'on-phone';

/**
 * Which icons a participant shows (docs/09 #15, Discord): the crossed mic first — red for a
 * moderator (server) mute, grey for a self-mute; deafen implies mute, so a deafened member shows
 * the crossed mic too, then the crossed headphones. On a phone call (ADR-0133) only the handset:
 * the mic state of a parked room says nothing then.
 */
export function voiceStateIcons(muted: boolean, deafened: boolean, serverMuted = false, pttIdle = false, onPhone = false): VoiceStateIcon[] {
  if (onPhone) return ['on-phone'];
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
  onPhone = false,
  className,
}: {
  muted: boolean;
  deafened: boolean;
  serverMuted?: boolean;
  /** My mic is on but waits for the push-to-talk key (CBF-71): a pale crossed mic. */
  pttIdle?: boolean;
  /** Parked here for a phone call (ADR-0133, VoiceState.on_phone): a handset instead. */
  onPhone?: boolean;
  className?: string;
}): ReactNode {
  return (
    <>
      {voiceStateIcons(muted, deafened, serverMuted, pttIdle, onPhone).map((k) =>
        k === 'on-phone' ? (
          <OnPhoneIcon key={k} className={className} />
        ) : k === 'deafened' ? (
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

/** «Разговаривает по телефону» (ADR-0133): the handset; the tooltip is native (no popover per row). */
export function OnPhoneIcon({ className }: { className?: string }): ReactNode {
  return (
    <span className="inline-flex shrink-0" title={t('call.onPhone')}>
      <Phone className={cx('size-4 shrink-0 text-muted', className)} aria-label={t('call.onPhone')} role="img" data-voice-icon="on-phone" />
    </span>
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
 * My own voice-state icons (CBF-71): the leaf that knows the push-to-talk wait. It draws the same
 * view as the self panel (#96, useSelfMic), never the row's server copy: that copy lags this
 * device's intent, and with another device of mine in the call it is not what the panel showed.
 * Primitive subscriptions: a key press redraws only this icon, never the row.
 */
export function SelfVoiceStateIcons({ onPhone = false, pttWait = true }: { onPhone?: boolean; /** False: a list that shows nobody's PTT wait (the members column). */ pttWait?: boolean }): ReactNode {
  const m = useSelfMic();
  const pttDown = useVoice((s) => s.pttDown);
  const pttIdle = pttWait && selfMicGlyph(m, pttDown) === 'ptt-idle';
  return <VoiceStateIcons muted={m.muted} deafened={m.deafened} serverMuted={m.serverMuted} pttIdle={pttIdle} onPhone={onPhone} />;
}
