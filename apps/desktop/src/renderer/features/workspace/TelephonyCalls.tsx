import { timestampMs } from '@bufbuild/protobuf/wkt';
import { SipActiveStep, SipCallDirection } from '@calaba/protocol';
import { useQuery } from '@tanstack/react-query';
import { PhoneIncoming, PhoneOutgoing } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { Button, Card, Spinner, cx } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { usePageVisible } from '../../lib/pageVisible';
import { activeCallsKey, callerNumber } from '../../lib/sipPbx';
import { useRooms } from '../../stores/rooms';
import { memberName, useWorkspaces } from '../../stores/workspaces';
import { formatDuration, useNow } from '../shell/voiceFormat';

/*
 * «Телефония → Активные звонки» (CBF-77, ADR-0128): the workspace's calls going on now — who
 * calls, where the call is (a voice menu, ringing a group / a person, talking), for how long.
 * Re-read on SIP_CALLS_CHANGED (services/dispatch: only while this list is mounted and the window
 * is seen) and, as a safety net for a lost event, once a minute while visible. Rows are memo'd with
 * primitive props; each row's timer is its own leaf on the shared 1 s clock, stopped while hidden.
 */

/** A missed SIP_CALLS_CHANGED heals within this (react-query pauses it in a hidden window). */
const SAFETY_REFETCH_MS = 60_000;

export function ActiveCalls({ workspaceId }: { workspaceId: string }): ReactNode {
  const q = useQuery({
    queryKey: activeCallsKey(workspaceId),
    queryFn: ({ signal }) => api.sip.activeCalls(workspaceId, signal),
    refetchInterval: SAFETY_REFETCH_MS,
  });
  const calls = q.data?.calls;
  return (
    <Card footer={t('pbx.calls.footer')}>
      {q.isPending ? (
        <div className="grid place-items-center py-6">
          <Spinner />
        </div>
      ) : q.isError || !calls ? (
        <div className="flex items-center justify-between gap-3 px-3 py-2.5">
          <span className="text-body text-danger-text" role="alert">
            {t('pbx.calls.loadFailed')}
          </span>
          <Button variant="secondary" size="sm" onClick={() => void q.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : calls.length === 0 ? (
        <p className="px-3 py-6 text-center text-body text-muted" data-testid="sip-calls-empty">
          {t('pbx.calls.empty')}
        </p>
      ) : (
        <ul className="divide-y divide-[var(--color-card-line)]" data-testid="sip-calls">
          {calls.map((a) => {
            const c = a.call;
            if (!c) return null;
            return (
              <ActiveCallRow
                key={c.id}
                workspaceId={workspaceId}
                number={c.number}
                masked={a.numberMasked}
                inbound={c.direction === SipCallDirection.IN}
                step={a.step}
                stepName={a.stepName}
                roomId={c.roomId}
                answeredBy={c.answeredBy}
                ringing={c.ringingUserIds.join(',')}
                startedAt={c.startedAt ? timestampMs(c.startedAt) : 0}
              />
            );
          })}
        </ul>
      )}
    </Card>
  );
}

const ActiveCallRow = memo(function ActiveCallRow({
  workspaceId,
  number,
  masked,
  inbound,
  step,
  stepName,
  roomId,
  answeredBy,
  ringing,
  startedAt,
}: {
  workspaceId: string;
  number: string;
  masked: boolean;
  inbound: boolean;
  step: SipActiveStep;
  stepName: string;
  roomId: string;
  answeredBy: string;
  /** Who rings now, ids joined by «,» (a primitive for memo). */
  ringing: string;
  startedAt: number;
}): ReactNode {
  const room = useRooms((s) => (roomId ? (s.byId[roomId]?.name ?? '') : ''));
  // Names re-read when the members change (rare); a string, so no re-render otherwise.
  const ringNames = useWorkspaces(() => (ringing ? ringing.split(',').map((u) => memberName(workspaceId, u)).join(', ') : ''));
  const talker = useWorkspaces(() => (answeredBy ? memberName(workspaceId, answeredBy) : ''));
  const connected = step === SipActiveStep.CONNECTED;
  let where: string;
  switch (step) {
    case SipActiveStep.MENU:
      where = stepName ? t('pbx.calls.menu', { name: stepName }) : t('pbx.calls.menuAny');
      break;
    case SipActiveStep.RINGING:
      where = stepName
        ? `${t('pbx.calls.ringGroup', { name: stepName })}${ringNames ? ` · ${ringNames}` : ''}`
        : ringNames
          ? t('pbx.calls.ringing', { names: ringNames })
          : t('pbx.calls.ringWait');
      break;
    case SipActiveStep.CONNECTED:
      where = inbound ? t('pbx.calls.connected', { name: talker || '—' }) : room ? t('pbx.calls.connectedRoom', { room }) : t('pbx.calls.test');
      break;
    default:
      where = room ? t('pbx.calls.dialing', { room }) : roomId ? t('pbx.calls.dialingAny') : t('pbx.calls.test');
  }
  const dir = t(inbound ? 'pbx.calls.in' : 'pbx.calls.out');
  return (
    <li className="flex min-h-12 items-center gap-3 px-3 py-2" data-testid="sip-call-row">
      <span
        className={cx('grid size-8 shrink-0 place-items-center rounded-full bg-[var(--color-fill)]', connected ? 'text-ok' : 'text-muted')}
        title={dir}
        aria-label={dir}
        role="img"
      >
        {inbound ? <PhoneIncoming className="size-4" aria-hidden /> : <PhoneOutgoing className="size-4" aria-hidden />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="selectable truncate text-body font-medium tabular-nums">{callerNumber(number, masked)}</span>
        <span className="truncate text-caption text-muted" title={where} data-testid="sip-call-step">
          {where}
        </span>
      </span>
      {startedAt ? <CallTimer since={startedAt} /> : null}
    </li>
  );
});

/** How long the call goes on: its own leaf on the shared 1 s clock, no clock while the window is hidden. */
function CallTimer({ since }: { since: number }): ReactNode {
  const visible = usePageVisible();
  const now = useNow(visible ? 1000 : 0);
  return (
    <span className="shrink-0 text-body tabular-nums text-muted" data-testid="sip-call-timer">
      {formatDuration(Math.max(0, now - since))}
    </span>
  );
}
