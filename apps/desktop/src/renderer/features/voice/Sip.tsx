import * as Popover from '../../components/radix/popover';
import { SipCallStatus } from '@calaba/protocol';
import { Grid3x3, Phone, PhoneOff } from 'lucide-react';
import { memo, useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { Button, IconButton, Input, Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { can, roomPerms } from '../../lib/permissions';
import { planHas } from '../../lib/plan';
import { extensionLabel, formatPhone, isLiveStatus, maskEdit, mayDial, mayHangUp, mayKeypad, reasonKey, statusKey, type LiveSipCall } from '../../lib/sip';
import { hangUpSipCall, placeSipCall } from '../../services/sip';
import { sendRoomDtmf } from '../../services/sipRoomDtmf';
import { DtmfPad } from '../call/DtmfKeypad';
import { useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { useSipCalls } from '../../stores/sipCalls';
import { useSipDial } from '../../stores/sipDial';
import { useVoice } from '../../stores/voice';
import { isGuest, useMemberRoles, useWorkspaces } from '../../stores/workspaces';
import { formatDuration, useNow } from '../shell/voiceFormat';

/**
 * Telephony in a voice room (ADR-0046, docs/08 «Телефония»): «Позвонить на номер» (room header;
 * on a phone — the members drawer) and the phone participant row under the room. Selectors are
 * per room and return primitives or the store's own call object; the talk timer is a leaf with
 * its own 1 s clock, mounted only while the line is ACTIVE.
 */

/**
 * Telephony is part of the workspace's plan (Business only, owner 02.10, ADR-0046). A primitive
 * selector. Without it the header button is hidden and the room menu's item shows a lock: only a
 * workspace downgraded with telephony still on gets there (below Business it can't be switched on).
 */
export function useTelephonyOnPlan(workspaceId: string): boolean {
  return useWorkspaces((s) => planHas(s.byId[workspaceId]?.ws.plan, 'telephony'));
}

/**
 * «Позвонить на номер» is offered here (lib/sip mayDial; the server checks the same). `anyCall`:
 * the room menu's item — the same rules without «I am in this room's call» (the item joins first).
 */
export function useCanDial(workspaceId: string, roomId: string, anyCall = false): boolean {
  const me = useSession((s) => s.me?.user?.id ?? '');
  const sipEnabled = useWorkspaces((s) => !!s.byId[workspaceId]?.ws.sipEnabled);
  const guest = useWorkspaces((s) => isGuest(s.byId[workspaceId]?.members[me]));
  const roles = useMemberRoles(workspaceId, me);
  const room = useRooms((s) => s.byId[roomId]);
  const inCall = useVoice((s) => s.roomId === roomId && (s.phase === 'connected' || s.phase === 'reconnecting'));
  const liveCall = useSipCalls((s) => {
    const c = s.byRoom[roomId];
    return !!c && isLiveStatus(c.status);
  });
  // Cheap until the gate's primitives pass: no permission math for rooms without telephony.
  if (!sipEnabled || !(inCall || anyCall) || liveCall || guest) return false;
  const perms = roomPerms(roles, me, room);
  return mayDial({ sipEnabled, placeCalls: can(perms, 'PLACE_CALLS'), connect: can(perms, 'CONNECT'), guest, inCall: true, liveCall });
}

/**
 * The dial button and its popover: a number field (mask «+7 916 123-45-67», paste-friendly),
 * Enter or «Позвонить» dials; a refusal stays inline under the field. `variant`: the room
 * header's 32 px icon, or a full-width button in the phone's members drawer.
 */
export function SipDialButton({ workspaceId, roomId, variant }: { workspaceId: string; roomId: string; variant: 'header' | 'sheet' }): ReactNode {
  const onPlan = useTelephonyOnPlan(workspaceId);
  const allowed = useCanDial(workspaceId, roomId) && onPlan;
  const [open, setOpen] = useState(false);
  // «Позвонить на номер» from the room menu (stores/sipDial): open once the gate passes (the
  // join it started has connected); a primitive selector, the store never ticks.
  const requested = useSipDial((s) => s.roomId === roomId);
  const consume = requested && allowed;
  if (consume && !open) setOpen(true);
  useEffect(() => {
    if (consume) useSipDial.getState().clear(roomId);
  }, [consume, roomId]);
  if (!allowed) {
    // Left the call / the line went live meanwhile: the popover closes with the button.
    if (open) setOpen(false);
    return null;
  }
  return (
    <Popover.Root open={open} onOpenChange={setOpen} modal={false}>
      {variant === 'header' ? (
        <Tip label={t('sip.dial')}>
          <Popover.Trigger asChild>
            <IconButton tip={false} label={t('sip.dial')} active={open} data-testid="sip-dial">
              <Phone className="size-[18px]" />
            </IconButton>
          </Popover.Trigger>
        </Tip>
      ) : (
        <Popover.Trigger asChild>
          <Button variant="secondary" className="mb-3 w-full" data-testid="sip-dial">
            <Phone className="size-4" aria-hidden />
            {t('sip.dial')}
          </Button>
        </Popover.Trigger>
      )}
      <Popover.Portal>
        <Popover.Content
          align={variant === 'header' ? 'end' : 'center'}
          sideOffset={8}
          collisionPadding={16}
          aria-label={t('sip.dial')}
          className="mat-popover anim-in z-[var(--z-popover)] w-[300px] max-w-[calc(100vw-32px)] rounded-[var(--radius-panel)] p-3"
        >
          <DialForm roomId={roomId} onDone={() => setOpen(false)} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function DialForm({ roomId, onDone }: { roomId: string; onDone: () => void }): ReactNode {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const submit = async (): Promise<void> => {
    if (busy || !value.trim()) return;
    setBusy(true);
    const err = await placeSipCall(roomId, value);
    setBusy(false);
    if (err) setError(err);
    else onDone();
  };
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={`${id}-n`} className="text-body font-semibold">
        {t('sip.dial')}
      </label>
      <Input
        id={`${id}-n`}
        data-testid="sip-number"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        autoFocus
        enterKeyHint="go"
        value={value}
        placeholder={t('sip.dial.placeholder')}
        aria-label={t('sip.dial.label')}
        aria-describedby={`${id}-h`}
        aria-invalid={error ? true : undefined}
        className="font-medium tabular-nums"
        onChange={(e) => {
          setValue((prev) => maskEdit(prev, e.target.value));
          if (error) setError(null);
        }}
      />
      {error ? (
        <span id={`${id}-h`} className="text-caption text-danger-text" role="alert" data-testid="sip-dial-error">
          {error}
        </span>
      ) : (
        <span id={`${id}-h`} className="text-caption text-faint">
          {t('sip.dial.hint')}
        </span>
      )}
      <Button type="submit" busy={busy} disabled={!value.replace(/\D/g, '')} className="self-end" data-testid="sip-dial-call">
        <Phone className="size-3.5" aria-hidden />
        {t('sip.dial.call')}
      </Button>
    </form>
  );
}

/**
 * The room's phone line in its participant list (docs/08 «Телефония»): a 40 px two-line row on
 * the participants' grid — a 24 px circle with the handset where the avatar is, the number, and
 * the status line «Набираем… / Звонит… / В разговоре 02:14 / Завершён · причина»; «Завершить» for
 * the caller and MUTE_MEMBERS holders; «Клавиатура» left of it while the line is answered.
 * Drawn from the SipCall (the line has no voice state). `card`: the «В голосе» card's 56 px row
 * (the header's people card, the phone's only view of the room's line) — a 40 px circle.
 */
export const SipCallRow = memo(function SipCallRow({ workspaceId, roomId, card = false }: { workspaceId: string; roomId: string; card?: boolean }): ReactNode {
  const call = useSipCalls((s) => s.byRoom[roomId]);
  if (!call) return null;
  return <SipCallLine workspaceId={workspaceId} call={call} card={card} />;
});

/** «Завершить» / «Клавиатура» of a line for me: the caller or MUTE_MEMBERS (the server's rules). */
function useLineControl(workspaceId: string, call: LiveSipCall): { hangUp: boolean; keys: boolean } {
  const me = useSession((s) => s.me?.user?.id ?? '');
  const roles = useMemberRoles(workspaceId, me);
  const room = useRooms((s) => s.byId[call.roomId]);
  const inCall = useVoice((s) => s.roomId === call.roomId && s.phase === 'connected');
  const live = isLiveStatus(call.status);
  // Cheap for a finished line: no permission math.
  const muteMembers = live && can(roomPerms(roles, me, room), 'MUTE_MEMBERS');
  return {
    hangUp: mayHangUp({ me, startedBy: call.startedBy, muteMembers, live }),
    keys: mayKeypad({ me, startedBy: call.startedBy, muteMembers, active: call.status === SipCallStatus.ACTIVE, inCall }),
  };
}

/** «+7 495 123-45-67 доб. 101» — the number and its extension as people read them. */
function lineName(call: LiveSipCall): { number: string; ext: string; full: string } {
  const number = formatPhone(call.number);
  const ext = call.extension ? t('sip.row.ext', { ext: extensionLabel(call.extension) }) : '';
  return { number, ext, full: ext ? `${number} ${ext}` : number };
}

function SipCallLine({ workspaceId, call, card }: { workspaceId: string; call: LiveSipCall; card: boolean }): ReactNode {
  const control = useLineControl(workspaceId, call);
  const live = isLiveStatus(call.status);
  const active = call.status === SipCallStatus.ACTIVE;
  const { number, ext, full } = lineName(call);
  const canHang = control.hangUp;
  // The sidebar's row is too narrow for two buttons: there «Клавиатура» is the island's row.
  const canKeys = card && control.keys;
  return (
    <li
      className={cx(
        'flex items-center rounded-[var(--radius-row)] transition-colors duration-[var(--motion-fast)]',
        card ? 'h-14 gap-3 px-2' : 'h-10 gap-2 pl-8 pr-1.5 hover:bg-hover',
        !live && 'opacity-70',
      )}
      aria-label={t('sip.row.label', { number: full })}
      data-testid="sip-call-row"
      data-status={SipCallStatus[call.status].toLowerCase()}
    >
      <span className={cx('grid shrink-0 place-items-center rounded-full bg-[var(--color-fill)]', card ? 'size-10' : 'size-6', active ? 'text-ok' : 'text-muted')} aria-hidden>
        <Phone className={card ? 'size-[18px]' : 'size-3.5'} />
      </span>
      <span className={cx('flex min-w-0 flex-1 flex-col', card ? 'gap-0.5 leading-5' : 'leading-tight')}>
        <span className={cx('truncate tabular-nums text-fg', card ? 'text-list font-medium' : 'text-body')} title={full}>
          {number}
        </span>
        {ext ? (
          // The rows are narrow (the sidebar's grid, the card's big number and wide buttons):
          // «доб. 101» goes under the number after the status, and the status gives way first.
          <span className="flex min-w-0 items-baseline gap-1">
            <SipStatusLine call={call} short />
            <span className="shrink-0 text-caption tabular-nums text-muted" data-testid="sip-call-ext">
              · {ext}
            </span>
          </span>
        ) : (
          <SipStatusLine call={call} />
        )}
      </span>
      {canKeys ? <SipKeypad roomId={call.roomId} callId={call.id} title={t('sip.keypad.for', { number: full })} variant="icon" /> : null}
      {canHang ? (
        <IconButton
          label={t('sip.row.hangup')}
          size="sm"
          danger
          className="mobile:tap-size"
          data-testid="sip-hangup"
          onClick={() => void hangUpSipCall(call.roomId, call.id)}
        >
          <PhoneOff className="size-4" />
        </IconButton>
      ) : null}
    </li>
  );
}

/**
 * The island's «Клавиатура» while my room's line is answered and I may press keys (the number is
 * the pad's title; desktop and web; ADR-0046 addendum «Тональный набор») — like the personal
 * call's DtmfRow.
 */
export const RoomLineKeypad = memo(function RoomLineKeypad({ workspaceId, roomId, className }: { workspaceId: string; roomId: string; className?: string }): ReactNode {
  const call = useSipCalls((s) => s.byRoom[roomId]);
  if (!call || call.status !== SipCallStatus.ACTIVE) return null;
  return <RoomLineKeypadFor workspaceId={workspaceId} call={call} className={className} />;
});

function RoomLineKeypadFor({ workspaceId, call, className }: { workspaceId: string; call: LiveSipCall; className?: string | undefined }): ReactNode {
  const { keys } = useLineControl(workspaceId, call);
  if (!keys) return null;
  const { full } = lineName(call);
  return (
    <div className={className}>
      <SipKeypad roomId={call.roomId} callId={call.id} title={t('sip.keypad.for', { number: full })} variant="island" />
    </div>
  );
}

/**
 * «Клавиатура» of an answered line (ADR-0046 addendum «Тональный набор»): the shared tone pad
 * (call/DtmfKeypad DtmfPad) in a popover — beside the island (`island`: a full-width button
 * «Клавиатура»), beside the «В голосе» card's row (`icon`); on a phone a centred card,
 * a level over the card (`mat-popover`, owner 07.10: no bottom sheets). The pad mounts only while
 * open; its keys go to this one line.
 */
function SipKeypad({ roomId, callId, title, variant }: { roomId: string; callId: string; title: string; variant: 'icon' | 'island' }): ReactNode {
  const [open, setOpen] = useState(false);
  const send = useCallback((k: string) => sendRoomDtmf(roomId, k, callId), [roomId, callId]);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        {variant === 'icon' ? (
          <IconButton label={t('sip.row.keypad')} size="sm" active={open} className="mobile:tap-size" data-testid="sip-keypad">
            <Grid3x3 className="size-4" />
          </IconButton>
        ) : (
          <Button variant="secondary" className="w-full" data-testid="sip-keypad">
            <Grid3x3 className="size-4" aria-hidden />
            {t('sip.row.keypad')}
          </Button>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          // Beside the island / the card, never over its hang-up.
          side="right"
          align={variant === 'island' ? 'end' : 'start'}
          sideOffset={variant === 'island' ? 12 : 8}
          collisionPadding={16}
          aria-label={title}
          className="mat-popover anim-in z-[var(--z-popover)] rounded-[var(--radius-panel)] p-4"
          data-testid="sip-keypad-popover"
        >
          <DtmfPad send={send} title={title} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** `short`: an answered line with an extension says only «02:14» (green): «доб. 101» follows. */
function SipStatusLine({ call, short = false }: { call: LiveSipCall; short?: boolean }): ReactNode {
  const cls = 'truncate text-caption tabular-nums';
  if (call.status === SipCallStatus.ACTIVE) {
    return (
      <span className={cx(cls, 'text-[var(--color-green-text)]')} data-testid="sip-status">
        {short && call.answeredAt ? null : t('sip.status.active')} {call.answeredAt ? <SipTalkTime since={call.answeredAt} /> : null}
      </span>
    );
  }
  const text = isLiveStatus(call.status) ? t(statusKey(call.status)) : `${t('sip.status.ended')} · ${t(reasonKey(call.status, call.reason))}`;
  return (
    <span className={cx(cls, 'text-muted')} title={text} data-testid="sip-status">
      {text}
    </span>
  );
}

/** «02:14» since the answer: the only thing that ticks, and only while the line is ACTIVE. */
function SipTalkTime({ since }: { since: number }): ReactNode {
  const now = useNow(1000);
  return <>{formatDuration(Math.max(0, now - since))}</>;
}
