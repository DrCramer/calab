import * as DialogP from '../../components/radix/dialog';
import { Phone } from 'lucide-react';
import type { ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { formatPhone } from '../../lib/sip';
import { accept, cancel, decline, setCollapsed } from '../../services/call';
import { acceptInbound, declineInbound } from '../../services/sipInbound';
import { useCall } from '../../stores/call';
import { useSipInbound } from '../../stores/sipInbound';
import { useMemberName, useWorkspaces } from '../../stores/workspaces';

/**
 * One-to-one call overlays (ADR-0034 §6, docs/08 «Звонок»), mounted once over the app:
 *  - outgoing — «как на iPhone»: avatar 96, name, «Вызов…», red round «Отменить»; a click
 *    outside (or Esc) collapses it into the top strip «Вызов: X · Отменить» — the chat stays usable;
 *  - incoming — over everything: avatar, name, «Входящий звонок», red «Отклонить», green
 *    «Принять»; only the buttons close it (the call rings on every device);
 *  - an inbound phone call (ADR-0117 §7) — the same sheet with a phone in place of the avatar,
 *    the caller's number and «Входящий на номер · <меню / группа>»; shown when no one-to-one
 *    call rings or dials.
 * Phones (ADR-0021): full screen. Solid materials only (no backdrop-filter); the dots are finite.
 */
export function CallLayer(): ReactNode {
  const phase = useCall((s) => s.phase);
  const collapsed = useCall((s) => s.collapsed);
  const sipRing = useSipInbound((s) => s.ringing[0]?.id ?? '');
  if (phase === 'incoming') return <IncomingCall />;
  if (phase === 'outgoing') return collapsed ? <CallingStrip /> : <OutgoingCall />;
  if (sipRing) return <SipIncomingCall id={sipRing} />;
  return null;
}

/** 56 px round action with its label under it (FaceTime / iPhone call screen). */
function RoundAction({ label, tone, onClick, disabled, autoFocus, testId, children }: { label: string; tone: 'accept' | 'decline'; onClick: () => void; disabled: boolean; autoFocus?: boolean; testId: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex w-20 flex-col items-center gap-2">
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        disabled={disabled}
        autoFocus={autoFocus}
        data-testid={testId}
        className={cx(
          'grid size-14 place-items-center rounded-full text-white shadow-[var(--shadow-card)] transition-[filter] duration-[var(--motion-fast)] hover:brightness-110 active:brightness-90 disabled:opacity-60',
          tone === 'accept' ? 'bg-ok-fill' : 'bg-danger-fill',
        )}
      >
        {children}
      </button>
      <span className="text-caption text-muted mobile:text-[15px] mobile:text-fg" aria-hidden>
        {label}
      </span>
    </div>
  );
}

/** The sheet of a one-to-one call: the peer's avatar and name. */
function CallSheet({
  testId,
  subtitle,
  onOutside,
  children,
}: {
  testId: string;
  subtitle: ReactNode;
  /** A click outside / Esc: the outgoing modal collapses; the incoming one ignores it. */
  onOutside: (() => void) | null;
  children: ReactNode;
}): ReactNode {
  const peerId = useCall((s) => s.peerId);
  const name = useMemberName(null, peerId);
  const fileId = useWorkspaces((s) => s.users[peerId]?.avatarFileId || undefined);
  return (
    <Sheet testId={testId} subtitle={subtitle} onOutside={onOutside} title={name} avatar={<Avatar userId={peerId} name={name} fileId={fileId} size={96} />}>
      {children}
    </Sheet>
  );
}

/** The sheet all call modals share: centred 320 px card; on a phone the whole screen. */
function Sheet({
  testId,
  subtitle,
  onOutside,
  title,
  avatar,
  children,
}: {
  testId: string;
  subtitle: ReactNode;
  onOutside: (() => void) | null;
  title: string;
  avatar: ReactNode;
  children: ReactNode;
}): ReactNode {
  const outside = (e: Event): void => {
    e.preventDefault();
    onOutside?.();
  };
  return (
    <DialogP.Root open>
      <DialogP.Portal>
        <DialogP.Overlay className="no-drag fixed inset-0 z-[var(--z-toast)] bg-scrim" />
        <DialogP.Content
          aria-modal="true"
          data-testid={testId}
          onEscapeKeyDown={outside}
          onPointerDownOutside={outside}
          className={cx(
            'mat-sheet anim-in fixed left-1/2 top-1/2 z-[var(--z-toast)] flex w-[320px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col items-center rounded-[var(--radius-panel)] px-6 pb-6 pt-8 text-center focus:outline-none',
            'mobile:inset-0 mobile:w-full mobile:max-w-none mobile:translate-x-0 mobile:translate-y-0 mobile:justify-start mobile:rounded-none mobile:border-0! mobile:shadow-none! mobile:pb-[calc(var(--safe-bottom,0px)+48px)] mobile:pt-[calc(var(--safe-top,0px)+72px)]',
          )}
        >
          {avatar}
          <DialogP.Title className="mt-4 max-w-full truncate text-[20px] font-semibold leading-[26px] tabular-nums" title={title}>
            {title}
          </DialogP.Title>
          <DialogP.Description className="mt-1 text-body text-muted">{subtitle}</DialogP.Description>
          <div className="mt-8 flex items-start justify-center gap-12 mobile:mt-auto">{children}</div>
        </DialogP.Content>
      </DialogP.Portal>
    </DialogP.Root>
  );
}

/** «Вызов» + three dots lighting up in turn (finite, styles.css `.call-dots`). */
function Calling(): ReactNode {
  return (
    <span>
      {t('call.calling')}
      <span className="call-dots" aria-hidden>
        <span>.</span>
        <span>.</span>
        <span>.</span>
      </span>
    </span>
  );
}

function OutgoingCall(): ReactNode {
  const busy = useCall((s) => s.busy);
  return (
    <CallSheet testId="call-outgoing" subtitle={<Calling />} onOutside={() => setCollapsed(true)}>
      <RoundAction label={t('call.cancel')} tone="decline" onClick={() => void cancel()} disabled={busy} autoFocus testId="call-cancel">
        <Phone className="size-6 rotate-[135deg]" aria-hidden />
      </RoundAction>
    </CallSheet>
  );
}

function IncomingCall(): ReactNode {
  const busy = useCall((s) => s.busy);
  return (
    <CallSheet testId="call-incoming" subtitle={t('call.incoming')} onOutside={null}>
      <RoundAction label={t('call.decline')} tone="decline" onClick={() => void decline()} disabled={busy} testId="call-decline">
        <Phone className="size-6 rotate-[135deg]" aria-hidden />
      </RoundAction>
      <RoundAction label={t('call.accept')} tone="accept" onClick={() => void accept()} disabled={busy} autoFocus testId="call-accept">
        <Phone className="size-6" aria-hidden />
      </RoundAction>
    </CallSheet>
  );
}

/** An inbound phone call (ADR-0117): the caller's number, what it came through, answer / refuse. */
function SipIncomingCall({ id }: { id: string }): ReactNode {
  const number = useSipInbound((s) => s.ringing.find((c) => c.id === id)?.number ?? '');
  const via = useSipInbound((s) => s.ringing.find((c) => c.id === id)?.via ?? '');
  const busy = useSipInbound((s) => s.busy);
  const title = number ? formatPhone(number) : t('call.sipUnknown');
  const phone = (
    <span className="grid size-24 place-items-center rounded-full bg-[var(--color-fill)] text-ok" aria-hidden>
      <Phone className="size-10" />
    </span>
  );
  return (
    <Sheet testId="sip-incoming" title={title} avatar={phone} subtitle={via ? t('call.sipVia', { via }) : t('call.sipIncoming')} onOutside={null}>
      <RoundAction label={t('call.decline')} tone="decline" onClick={() => void declineInbound(id)} disabled={busy} testId="sip-decline">
        <Phone className="size-6 rotate-[135deg]" aria-hidden />
      </RoundAction>
      <RoundAction label={t('call.accept')} tone="accept" onClick={() => void acceptInbound(id)} disabled={busy} autoFocus testId="sip-accept">
        <Phone className="size-6" aria-hidden />
      </RoundAction>
    </Sheet>
  );
}

/** The collapsed outgoing call: a pill under the title bar — click to expand, «Отменить». */
function CallingStrip(): ReactNode {
  const peerId = useCall((s) => s.peerId);
  const busy = useCall((s) => s.busy);
  const name = useMemberName(null, peerId);
  return (
    <div
      role="status"
      data-testid="call-strip"
      data-app-occluder
      className="no-drag mat-toolbar fixed left-1/2 top-[calc(var(--titlebar-height)+8px)] z-[var(--z-toast)] flex h-9 max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-1 rounded-full pl-1 pr-1 shadow-[var(--shadow-island)] mobile:top-[calc(var(--safe-top,0px)+8px)]"
    >
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        aria-label={t('call.expand')}
        className="flex h-7 min-w-0 items-center gap-2 rounded-full px-2 text-body transition-colors duration-[var(--motion-fast)] hover:bg-hover"
      >
        <Phone className="size-4 shrink-0 text-ok" aria-hidden />
        <span className="min-w-0 truncate font-medium">{t('call.stripCalling', { name })}</span>
        <span className="call-dots text-muted" aria-hidden>
          <span>.</span>
          <span>.</span>
          <span>.</span>
        </span>
      </button>
      <button
        type="button"
        onClick={() => void cancel()}
        disabled={busy}
        className="h-7 shrink-0 rounded-full bg-danger-fill px-3 text-body font-semibold text-white transition-[filter] duration-[var(--motion-fast)] hover:brightness-110 disabled:opacity-60"
      >
        {t('call.cancel')}
      </button>
    </div>
  );
}
