import * as Popover from '../../components/radix/popover';
import { Grid3x3 } from 'lucide-react';
import { useCallback, useState, type ReactNode } from 'react';
import { Button, Modal, cx } from '../../components/ui';
import { t } from '../../i18n';
import { sendDtmf } from '../../services/sipOutbound';
import { usePersonalActive } from '../../stores/sipOutbound';
import { playKeyClick } from '../../lib/sounds';
import { Keypad } from '../telephony/keypad/Keypad';

/**
 * The tone keypad of a phone call (ADR-0137 §3.7, §6–§7): a bank's menu, an extension — the
 * digits go to the line as SipDTMF data packets addressed to that line only (voice.publishDtmf;
 * livekit/sip v1.14 forwards them to the provider as RFC 2833). Data, not sound: the echo rules
 * (docs/02) are untouched. A voice room's phone line has its own «Клавиатура» with the same pad
 * (voice/Sip.tsx). Here: only on an answered personal call: the inbound call's token has no data
 * grant yet (docs/12), so it is hidden there. Desktop: «Клавиатура» in the island → a popover; phone: the band's 44 px round
 * button (in the camera's place) → a centred card. The typed digits live in the card (a leaf).
 */

/**
 * The keypad card's body: what was sent so far and the 3×4 keys. `send` puts one key on the line
 * (false = not now: nothing is shown or clicked). A sent key ticks (lib/sounds playKeyClick, a
 * plain <audio>) besides the Keypad's haptic. `title`: which line («Тоновый набор: +7 …»).
 * Mounted only while its card is open; the typed digits live here (a leaf).
 */
export function DtmfPad({ send, title }: { send: (k: string) => boolean; title?: string }): ReactNode {
  const [typed, setTyped] = useState('');
  const onKey = useCallback(
    (k: string) => {
      if (!send(k)) return;
      playKeyClick();
      setTyped((s) => (s + k).slice(-24));
    },
    [send],
  );
  return (
    <div className="flex flex-col items-center gap-3" data-testid="dtmf-pad">
      {title ? (
        <span className="max-w-full truncate text-caption tabular-nums text-muted" data-testid="dtmf-for">
          {title}
        </span>
      ) : null}
      <output className="flex h-8 w-full items-center justify-center truncate text-[22px] tabular-nums tracking-[0.08em] text-fg" aria-live="polite" aria-label={t('telc.dtmf.sent')} data-testid="dtmf-typed">
        {typed}
      </output>
      <Keypad size="compact" onKey={onKey} />
    </div>
  );
}

/** The island's row (desktop and web): «Клавиатура» → the keypad above it. */
export function DtmfRow({ roomId, className }: { roomId: string; className?: string }): ReactNode {
  const active = usePersonalActive(roomId);
  const [open, setOpen] = useState(false);
  if (!active) return null;
  return (
    <div className={className}>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <Button variant="secondary" className="w-full" data-testid="dtmf-open">
            <Grid3x3 className="size-4" aria-hidden />
            {t('telc.dtmf')}
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            // Beside the island, never over its hang-up.
            side="right"
            align="end"
            sideOffset={12}
            collisionPadding={16}
            className="mat-popover anim-in z-[var(--z-popover)] rounded-[var(--radius-panel)] p-4"
            aria-label={t('telc.dtmf')}
            data-testid="dtmf-popover"
          >
            <DtmfPad send={sendDtmf} />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

/** The phone band's round «Клавиатура» → a centred card with the keypad. */
export function DtmfButton({ roomId, className }: { roomId: string; className: string }): ReactNode {
  const active = usePersonalActive(roomId);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" aria-label={t('telc.dtmf')} disabled={!active} onClick={() => setOpen(true)} className={cx(className, 'disabled:opacity-40')} data-testid="dtmf-open">
        <Grid3x3 className="size-5" aria-hidden />
      </button>
      {open && active ? (
        <Modal open onClose={() => setOpen(false)} title={t('telc.dtmf')}>
          <div className="flex justify-center pb-2">
            <DtmfPad send={sendDtmf} />
          </div>
        </Modal>
      ) : null}
    </>
  );
}
