import * as DialogP from '../../components/radix/dialog';
import { SipCallStatus } from '@calaba/protocol';
import { Phone } from 'lucide-react';
import { avatarColor } from '../../components/Avatar';
import { workspaceInitials } from '../../lib/initials';
import { isDialing } from '../../lib/sipOutbound';
import { hangupPersonal } from '../../services/sipOutbound';
import { useSipOutbound } from '../../stores/sipOutbound';
import { useUi } from '../../stores/ui';
import { callPartyLabel } from './phoneCall';
import type { ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { formatPhone } from '../../lib/sip';
import { accept, cancel, decline, setCollapsed } from '../../services/call';
import { acceptInbound, declineInbound } from '../../services/sipInbound';
import { useCall } from '../../stores/call';
import { useSipInbound } from '../../stores/sipInbound';
import { memberName, useMemberName, useWorkspaces } from '../../stores/workspaces';

/**
 * One-to-one call overlays (ADR-0034 §6, docs/08 «Звонок»), mounted once over the app:
 *  - outgoing — «как на iPhone»: avatar 96, name, «Вызов…», red round «Отменить»; a click
 *    outside (or Esc) collapses it into the top strip «Вызов: X · Отменить» — the chat stays usable;
 *  - incoming — over everything: avatar, name, «Входящий звонок», red «Отклонить», green
 *    «Принять»; only the buttons close it (the call rings on every device);
 *  - an inbound phone call (ADR-0117 §7) — the same sheet with the caller (ADR-0137 §2: the
 *    contact's name big, the company, the number under them; else the number) and «Входящий на
 *    номер · <меню / группа>»; shown when no one-to-one call rings or dials;
 *  - a personal call from «Телефония» on a phone (ADR-0137 §7) — the same full-screen sheet
 *    «Вызов…» with «Завершить» until the answer, then the call band (the desktop has the island).
 * Phones (ADR-0021): full screen. Solid materials only (no backdrop-filter); the dots are finite.
 */
export function CallLayer(): ReactNode {
  const phase = useCall((s) => s.phase);
  const collapsed = useCall((s) => s.collapsed);
  const sipRing = useSipInbound((s) => s.ringing[0]?.id ?? '');
  const dialing = useSipOutbound((s) => s.placing || isDialing(s.call));
  const phoneLayout = useUi((s) => s.phone.on);
  if (phase === 'incoming') return <IncomingCall />;
  if (phase === 'outgoing') return collapsed ? <CallingStrip /> : <OutgoingCall />;
  if (sipRing) return <SipIncomingCall id={sipRing} />;
  if (dialing && phoneLayout) return <SipOutgoingCall />;
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
  lines,
  big = false,
  children,
}: {
  testId: string;
  subtitle: ReactNode;
  onOutside: (() => void) | null;
  title: string;
  avatar: ReactNode;
  /** Under the title (a caller's company and number). */
  lines?: ReactNode;
  /** A phone caller's name: 28/600 on a phone, two lines before it is cut (ADR-0137 §7). */
  big?: boolean;
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
          <DialogP.Title
            className={cx('mt-4 max-w-full font-semibold tabular-nums', big ? 'line-clamp-2 break-words text-[20px] leading-[26px] mobile:text-[28px] mobile:leading-[34px]' : 'truncate text-[20px] leading-[26px]')}
            title={title}
            data-testid="call-sheet-title"
          >
            {title}
          </DialogP.Title>
          {lines}
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

/**
 * An inbound phone call (ADR-0117): who calls (ADR-0137 §2 — the contact's name big, the company,
 * the number muted under them; an employee's name; else the number), what it came through,
 * answer / refuse.
 */
function SipIncomingCall({ id }: { id: string }): ReactNode {
  const c = useSipInbound((s) => s.ringing.find((x) => x.id === id));
  const number = c?.number ?? '';
  const via = c?.via ?? '';
  // A colleague transfers the call they answered (ADR-0132): «Переводит Имя».
  const from = c?.status === SipCallStatus.ACTIVE ? c.answeredBy : '';
  const wsId = c?.workspaceId ?? '';
  const fromName = useMemberName(from ? wsId : null, from);
  const busy = useSipInbound((s) => s.busy);
  const name = useWorkspaces(() => (c ? c.callerName || (c.callerUserId ? memberName(c.workspaceId, c.callerUserId) : '') : ''));
  const company = c?.callerCompany ?? '';
  const shownNumber = number ? formatPhone(number) : t('call.sipUnknown');
  const title = name || company || shownNumber;
  return (
    <Sheet
      testId="sip-incoming"
      title={title}
      big
      avatar={<PartyDisc id={c?.contactId || c?.callerUserId || number} name={name || company} />}
      lines={<CallerLines company={name ? company : ''} number={title === shownNumber ? '' : shownNumber} />}
      subtitle={from ? t('call.sipTransferFrom', { name: fromName }) : via ? t('call.sipVia', { via }) : t('call.sipIncoming')}
      onOutside={null}
    >
      <RoundAction label={t('call.decline')} tone="decline" onClick={() => void declineInbound(id)} disabled={busy} testId="sip-decline">
        <Phone className="size-6 rotate-[135deg]" aria-hidden />
      </RoundAction>
      <RoundAction label={t('call.accept')} tone="accept" onClick={() => void acceptInbound(id)} disabled={busy} autoFocus testId="sip-accept">
        <Phone className="size-6" aria-hidden />
      </RoundAction>
    </Sheet>
  );
}

/** A phone party's circle: the contact's initials on its colour, else a handset. */
function PartyDisc({ id, name }: { id: string; name: string }): ReactNode {
  if (name) {
    return (
      <span className="grid size-24 place-items-center rounded-full text-[34px] font-semibold text-white" style={{ background: avatarColor(id || name) }} aria-hidden>
        {workspaceInitials(name)}
      </span>
    );
  }
  return (
    <span className="grid size-24 place-items-center rounded-full bg-[var(--color-fill)] text-ok" aria-hidden>
      <Phone className="size-10" />
    </span>
  );
}

/** The company and the number under a phone caller's name. */
function CallerLines({ company, number }: { company: string; number: string }): ReactNode {
  if (!company && !number) return null;
  return (
    <div className="mt-1 flex max-w-full flex-col items-center gap-0.5" data-testid="call-sheet-lines">
      {company ? <span className="line-clamp-2 max-w-full break-words text-body text-fg mobile:text-[17px]">{company}</span> : null}
      {number ? <span className="text-body tabular-nums text-muted mobile:text-[15px]">{number}</span> : null}
    </div>
  );
}

/**
 * A personal call being placed on a phone (ADR-0137 §7): «Вызов…» full screen with «Завершить» at
 * the thumb until the answer; then the call band takes over. The desktop shows it in the island.
 */
function SipOutgoingCall(): ReactNode {
  const c = useSipOutbound((s) => s.call);
  const placed = useSipOutbound((s) => s.name);
  const label = useWorkspaces(() => (c ? callPartyLabel(c, placed) : placed));
  const name = c ? c.callerName || placed : placed;
  const company = c?.callerCompany ?? '';
  const number = c?.number ? formatPhone(c.number) : '';
  const title = name || company || number || label;
  return (
    <Sheet
      testId="sip-outgoing"
      title={title}
      big
      avatar={<PartyDisc id={c?.contactId || c?.number || ''} name={name || company} />}
      lines={<CallerLines company={name ? company : ''} number={title === number ? '' : number} />}
      subtitle={<Calling />}
      onOutside={null}
    >
      <RoundAction label={t('call.hangup')} tone="decline" onClick={() => void hangupPersonal()} disabled={!c} testId="sip-outgoing-hangup">
        <Phone className="size-6 rotate-[135deg]" aria-hidden />
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
