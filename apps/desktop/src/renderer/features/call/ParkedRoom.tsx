import { CirclePause } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { voice } from '../../services/voice';
import { useRooms } from '../../stores/rooms';
import { useUi } from '../../stores/ui';
import { useVoice } from '../../stores/voice';

/**
 * The room a phone call parked (ADR-0133, docs/08 «Телефония»): «Комната: Lobby — на паузе» under
 * the call's header, the name opens the room, «Выйти» leaves it (the call goes on). The island and
 * the phone strip show it while the call runs; the room comes back by itself when the call ends.
 * A leaf with its own primitive subscriptions: the island does not re-render for it.
 */
export function ParkedRoomLine({ className }: { className?: string }): ReactNode {
  const roomId = useVoice((s) => s.parked?.roomId ?? null);
  const wsId = useVoice((s) => s.parked?.workspaceId ?? null);
  const name = useRooms((s) => (roomId ? (s.byId[roomId]?.name ?? '') : ''));
  if (!roomId || !wsId) return null;
  const text = t('call.sipParked', { room: name });
  return (
    <div className={cx('flex items-center gap-2 rounded-[var(--radius-row)] bg-hover px-2 py-1.5 text-[12px]', className)} data-testid="voice-parked">
      <CirclePause className="size-4 shrink-0 text-muted" aria-hidden />
      <button
        type="button"
        className="min-w-0 flex-1 truncate text-left text-muted hover:text-fg hover:underline"
        title={text}
        onClick={() => useUi.getState().openRoom(wsId, roomId)}
      >
        {text}
      </button>
      <button
        type="button"
        className="shrink-0 rounded-[var(--radius-control)] font-medium text-danger-text hover:underline mobile:tap-h"
        onClick={() => voice.leaveParked()}
        aria-label={t('call.sipParkedLeave')}
        title={t('call.sipParkedLeave')}
        data-testid="voice-parked-leave"
      >
        {t('mobile.leaveVoice')}
      </button>
    </div>
  );
}
