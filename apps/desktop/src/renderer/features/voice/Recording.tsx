import * as Dropdown from '../../components/radix/dropdown-menu';
import { CircleStop } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { recPulseDelay } from '../../lib/recording';
import { stopRecording } from '../../services/recording';
import { useRecordings } from '../../stores/recordings';
import { myUserId } from '../../stores/session';
import { useVoice, type VoiceRecording } from '../../stores/voice';
import { isGuest, memberName, useWorkspaces } from '../../stores/workspaces';
import { menuBox, menuItem, menuSeparator } from '../shell/menu';
import { recordingTime, useNow } from '../shell/voiceFormat';

/**
 * Meeting recording indication (docs/09 #30 / #64, docs/08 «Запись встреч», ADR-0025): a red dot
 * that pulses 3 times when the recording starts and then stays still (`.rec-dot-pulse`: an
 * endless pulse over the blurred sidebar / island kept the compositor redrawing the blur every
 * frame for the whole meeting — docs/14) — on the card / row of every room being recorded (dot +
 * «REC» + timer next to the call timer: whoever joins knows before), in the «Голос подключён»
 * header of my call (a red pill «● Запись · 12:34») and on the phone strip (the dot only). The
 * pill, the card's badge and the phone dot open a small menu: «Идёт запись · 12:34», who started
 * it and — for whoever may stop it (any member but a guest, as the room menu) — «Остановить
 * запись» with a one-line confirmation. Source: the server's state (stores/recordings, READY +
 * ROOM_RECORDING; `voice.recording` mirrors my room — services/recording.ts).
 */

/** The recording of `roomId`, if it is my room and it is being recorded. */
export function useRecording(roomId: string | null | undefined): VoiceRecording | null {
  return useVoice((s) => (roomId && s.roomId === roomId ? s.recording : null));
}

/** Whether any room (mine or not) is being recorded: the room list's REC. */
function useRoomRecording(roomId: string) {
  return useRecordings((s) => s.byRoom[roomId] ?? null);
}

/** The red dot; `since` (ms) — the recording's start: the dot pulses only in its first 6 s. */
export function RecDot({ since, className }: { since?: number; className?: string }): ReactNode {
  return <RecDotAt key={since ?? 0} since={since} className={className} />;
}

function RecDotAt({ since, className }: { since: number | undefined; className: string | undefined }): ReactNode {
  // Read once at mount: the dot never re-renders for the clock.
  const [delay] = useState(() => (since === undefined ? null : recPulseDelay(Date.now() - since)));
  return (
    <span
      aria-hidden
      className={cx('rec-dot inline-block size-2 shrink-0 rounded-full', delay !== null && 'rec-dot-pulse', className ?? 'bg-danger')}
      style={delay !== null ? { animationDelay: delay } : undefined}
    />
  );
}

/** Who may stop a recording: any member of the workspace but a guest (ADR-0025, lib/roomMenu). */
function useCanStop(workspaceId: string | null): boolean {
  return useWorkspaces((s) => {
    const m = workspaceId ? s.byId[workspaceId]?.members[myUserId()] : undefined;
    return !!m && !isGuest(m);
  });
}

/** «● REC 12:34» on the room card (its status line, under the call timer); `compact`: the dot only (a plain row). */
export function RoomRecBadge({ roomId, className, compact = false }: { roomId: string; className?: string; compact?: boolean }): ReactNode {
  const rec = useRoomRecording(roomId);
  if (!rec) return null;
  return <RoomRecBadgeOn roomId={roomId} rec={rec} className={className} compact={compact} />;
}

function RoomRecBadgeOn({ roomId, rec, className, compact }: { roomId: string; rec: { workspaceId: string; byUserId: string; since: number }; className?: string | undefined; compact: boolean }): ReactNode {
  const time = recordingTime(rec.since, useNow());
  // A plain row swaps its right side for the actions on hover / focus, so its dot cannot be
  // clicked: it only says so (the row's «…» has «Остановить запись»).
  if (compact)
    return (
      <span role="img" aria-label={t('rec.time', { time })} title={t('rec.time', { time })} data-testid="room-rec" className="inline-flex h-5 items-center">
        <RecDot since={rec.since} />
      </span>
    );
  const by = t('rec.by', { name: memberName(rec.workspaceId, rec.byUserId) });
  return (
    <RecMenu roomId={roomId} workspaceId={rec.workspaceId} rec={rec} label={`${t('rec.time', { time })}. ${by}`} tip={by} testId="room-rec"
      className={cx('inline-flex h-5 shrink-0 items-center gap-1 rounded-[var(--radius-icon)] tabular-nums leading-none', className ?? 'text-micro')}
    >
      <RecDot since={rec.since} />
      <span className="font-semibold text-danger-text">{t('rec.badge')}</span>
      <span className="text-fg">{time}</span>
    </RecMenu>
  );
}

/**
 * «● Запись · 12:34» in the voice panel, a line under its header (`className` places the line);
 * the tooltip names who started it, a click opens the recording menu.
 */
export function RecordingPill({ roomId, workspaceId, className }: { roomId: string; workspaceId: string | null; className?: string }): ReactNode {
  const rec = useRecording(roomId);
  if (!rec) return null;
  return (
    <div className={cx('flex', className)}>
      <RecordingPillOn roomId={roomId} rec={rec} workspaceId={workspaceId} />
    </div>
  );
}

function RecordingPillOn({ roomId, rec, workspaceId }: { roomId: string; rec: VoiceRecording; workspaceId: string | null }): ReactNode {
  const time = recordingTime(rec.since, useNow());
  const by = t('rec.by', { name: memberName(workspaceId, rec.byUserId) });
  return (
    <RecMenu roomId={roomId} workspaceId={workspaceId} rec={rec} label={`${t('rec.time', { time })}. ${by}`} tip={by} testId="voice-rec-pill"
      className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-danger-fill px-2 text-micro font-semibold tabular-nums leading-none text-white hover:brightness-110 data-[state=open]:brightness-110"
    >
      <RecDot since={rec.since} className="size-1.5 bg-white" />
      {t('rec.label')} · {time}
    </RecMenu>
  );
}

/** The phone strip's REC: the dot alone (no room for the timer), opening the same menu. */
export function MobileRecDot({ roomId, workspaceId, rec, className }: { roomId: string; workspaceId: string | null; rec: VoiceRecording; className?: string }): ReactNode {
  return (
    <RecMenu roomId={roomId} workspaceId={workspaceId} rec={rec} label={t('rec.on')} testId="mobile-rec" side="top" className={cx('grid size-6 place-items-center rounded-full', className)}>
      <RecDot since={rec.since} />
    </RecMenu>
  );
}

/**
 * The REC trigger + its menu (Radix: keyboard, focus return, Escape). The header is not an item;
 * «Остановить запись» asks once more in the same line («Остановить запись? · Остановить») before
 * POST …/recording/stop.
 */
function RecMenu(p: {
  roomId: string;
  workspaceId: string | null;
  rec: { byUserId: string; since: number };
  label: string;
  tip?: string;
  testId: string;
  className: string;
  side?: 'top' | 'bottom';
  children: ReactNode;
}): ReactNode {
  const [confirm, setConfirm] = useState(false);
  const trigger = (
    <Dropdown.Trigger asChild>
      <button type="button" aria-label={p.label} data-testid={p.testId} className={cx('cursor-default', p.className)}>
        {p.children}
      </button>
    </Dropdown.Trigger>
  );
  return (
    <Dropdown.Root modal={false} onOpenChange={(open) => (open ? undefined : setConfirm(false))}>
      {p.tip ? <Tip label={p.tip}>{trigger}</Tip> : trigger}
      <Dropdown.Portal>
        <Dropdown.Content className={cx(menuBox, 'w-64')} side={p.side ?? 'bottom'} align="start" sideOffset={6} collisionPadding={12} data-testid="rec-menu">
          <RecMenuBody roomId={p.roomId} workspaceId={p.workspaceId} rec={p.rec} confirm={confirm} onConfirm={() => setConfirm(true)} />
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

function RecMenuBody({ roomId, workspaceId, rec, confirm, onConfirm }: { roomId: string; workspaceId: string | null; rec: { byUserId: string; since: number }; confirm: boolean; onConfirm: () => void }): ReactNode {
  const time = recordingTime(rec.since, useNow());
  const canStop = useCanStop(workspaceId);
  const confirmRef = useRef<HTMLDivElement>(null);
  // The confirmation replaces the item under the pointer / keyboard focus: keep the focus on it.
  useEffect(() => {
    if (confirm) confirmRef.current?.focus();
  }, [confirm]);
  return (
    <>
      <Dropdown.Label className="flex flex-col gap-0.5 px-2 pb-1.5 pt-1" data-testid="rec-menu-title">
        <span className="flex items-center gap-1.5 text-body font-semibold tabular-nums text-fg">
          <RecDot since={rec.since} />
          {t('rec.menu.title', { time })}
        </span>
        <span className="truncate text-caption text-muted">{t('rec.menu.by', { name: memberName(workspaceId, rec.byUserId) })}</span>
      </Dropdown.Label>
      {canStop ? (
        <>
          <Dropdown.Separator className={menuSeparator} />
          {confirm ? (
            <Dropdown.Item ref={confirmRef} className={cx(menuItem, 'group')} data-testid="rec-menu-stop-confirm" onSelect={() => void stopRecording(roomId)}>
              <span className="flex-1">{t('rec.menu.confirm')}</span>
              <span className="font-semibold text-danger-text group-data-[highlighted]:text-accent-fg">{t('rec.menu.confirmAction')}</span>
            </Dropdown.Item>
          ) : (
            <Dropdown.Item
              className={menuItem}
              data-testid="rec-menu-stop"
              onSelect={(e) => {
                e.preventDefault(); // stay open for the confirmation
                onConfirm();
              }}
            >
              <CircleStop className="size-4 text-danger-text" aria-hidden /> {t('roomMenu.recordStop')}
            </Dropdown.Item>
          )}
        </>
      ) : null}
    </>
  );
}
