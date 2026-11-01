import { memo, useCallback, type ReactNode } from 'react';
import { Button, Modal } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { eventSpan, formatRange } from '../../lib/calendar/time';
import { fmt } from '../../lib/format';
import { joinPlan, peopleSummary } from '../../lib/joinConfirm';
import { localTimeZone } from '../../lib/timezone';
import { goToRoom, openEvent } from '../../services/calendar';
import { useJoinConfirm } from '../../stores/joinConfirm';
import { useRooms } from '../../stores/rooms';
import { useVoice } from '../../stores/voice';
import { memberName, useWorkspaces } from '../../stores/workspaces';

/**
 * «Войти в комнату?» (owner, 29.10): a click on a meeting reminder (the system notification or the
 * toast) asks before it joins the voice room. Leaf: nothing runs while closed. Mounted in Dialogs.
 */
export function JoinConfirmHost(): ReactNode {
  const open = useJoinConfirm((s) => s.ev !== null);
  return open ? <JoinConfirm /> : null;
}

const JoinConfirm = memo(function JoinConfirm(): ReactNode {
  useLocale();
  const ev = useJoinConfirm((s) => s.ev);
  const close = useJoinConfirm((s) => s.close);
  const roomId = ev?.roomId ?? '';
  const workspaceId = ev?.workspaceId ?? '';
  const roomName = useRooms((s) => s.byId[roomId]?.name ?? '');
  const seatRoom = useVoice((s) => s.roomId);
  const call = useVoice((s) => s.call);
  const seatName = useRooms((s) => (seatRoom ? (s.byId[seatRoom]?.name ?? '') : ''));
  // Who is in the room now: a primitive line, so the dialog re-renders only when it changes.
  const who = useWorkspaces((s) => {
    const names = Object.values(s.byId[workspaceId]?.voice ?? {})
      .filter((v) => v.roomId === roomId)
      .map((v) => memberName(workspaceId, v.userId));
    const { shown, more } = peopleSummary(names);
    if (shown.length === 0) return '';
    return more > 0 ? t('jc.peopleMore', { names: shown.join(', '), n: more }) : t('jc.people', { names: shown.join(', ') });
  });
  const plan = joinPlan({ roomId: seatRoom, call }, roomId);
  const join = useCallback((): void => {
    if (!ev) return;
    close();
    goToRoom(ev);
  }, [ev, close]);
  const open = useCallback((): void => {
    if (!ev) return;
    close();
    openEvent(ev);
  }, [ev, close]);
  if (!ev) return null;
  const { start } = eventSpan(ev);
  const zone = localTimeZone();
  const warn = plan === 'call' ? t('jc.inCall') : plan === 'switch' ? t('jc.inRoom', { room: `«${seatName}»` }) : '';
  return (
    <Modal
      open
      onClose={close}
      title={t('jc.title')}
      initialFocus="body"
      footer={
        <>
          <Button variant="secondary" onClick={open} data-testid="join-confirm-open">
            {t('cal.openEvent')}
          </Button>
          <Button variant="primary" onClick={join} data-testid="join-confirm-go">
            {warn ? t('jc.joinSwitch') : t('jc.join')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" data-testid="join-confirm">
        <div className="min-w-0">
          <p className="break-words text-body font-medium text-fg [overflow-wrap:anywhere]">{ev.title}</p>
          <p className="mt-0.5 text-body text-muted">
            {formatRange(ev)} · {fmt.relative(new Date(start))}
          </p>
          {zone ? <p className="text-caption text-faint">{t('jc.zone', { zone: zone.replace(/_/g, ' ') })}</p> : null}
        </div>
        <div className="min-w-0 text-body text-muted">
          <p className="break-words [overflow-wrap:anywhere]">{t('jc.room', { room: `«${roomName}»` })}</p>
          <p>{who || t('jc.nobody')}</p>
        </div>
        {warn ? (
          <p className="rounded-[var(--radius-control)] border border-line bg-elev px-3 py-2 text-body text-fg" role="note" data-testid="join-confirm-warn">
            {warn}
          </p>
        ) : null}
      </div>
    </Modal>
  );
});
