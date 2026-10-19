import * as Popover from '../../components/radix/popover';
import { AudioLines } from 'lucide-react';
import { useEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react';
import { Button, Tip, Toggle, cx } from '../../components/ui';
import { t } from '../../i18n';
import { MIC_CHECK_SEGMENTS, litSegments } from '../../lib/media/micCheck';
import { stopMicCheck, toggleMicCheck, useMicCheck } from '../../services/micCheck';
import { usePrefs } from '../../stores/prefs';
import { popoverBox } from './menu';

/** «Подробнее»: how the capture pipeline and RNNoise work (docs/02 in the repository). */
export const RNNOISE_DOCS_URL = 'https://github.com/itrcz/calab/blob/main/docs/02-media.md';

/** 24 segments, 4 × 20 px, lit green from the left (docs/09 #12; the Discord mic-test meter). */
function SegmentMeter({ db }: { db: number }): ReactNode {
  const lit = litSegments(db);
  return (
    <div
      role="meter"
      aria-label={t('voice.level')}
      aria-valuemin={0}
      aria-valuemax={MIC_CHECK_SEGMENTS}
      aria-valuenow={lit}
      data-testid="noise-meter"
      className="flex h-6 min-w-0 flex-1 items-center justify-between"
    >
      {Array.from({ length: MIC_CHECK_SEGMENTS }, (_, i) => (
        <span key={i} aria-hidden className={cx('h-5 w-1 rounded-full', i < lit ? 'bg-ok' : 'bg-[var(--color-fill-hover)]')} />
      ))}
    </div>
  );
}

/**
 * Noise suppression in the «Голос подключён» header (docs/09 #12, Discord reference): the wave
 * button (accent-tinted while on) opens a popover to the right of the island, growing upward —
 * the RNNoise toggle (same pref as Settings → «Голос и устройства»), a short explanation and the
 * mic check (3 s recording → played back to me, 24-segment post-RNNoise meter).
 */
export function NoiseButton(): ReactNode {
  // Musician mode (ADR-0052) forces RNNoise off: the button and the toggle show what is in force.
  const musician = usePrefs((s) => s.musicianMode);
  const rnnoise = usePrefs((s) => s.rnnoise) && !musician;
  const setPrefs = usePrefs((s) => s.setPrefs);
  const phase = useMicCheck((s) => s.phase);
  const db = useMicCheck((s) => s.db);
  const error = useMicCheck((s) => s.error);
  // The panel goes away (left the call) with the check running: release the mic.
  useEffect(() => () => stopMicCheck(), []);
  const trigger = useRef<HTMLButtonElement>(null);
  // Anchored at the island's right edge (level with the button), not at the button: «right of
  // the button» alone would lie over the hang-up and the island's right part.
  const anchor = useMemo<RefObject<{ getBoundingClientRect: () => DOMRect }>>(
    () => ({
      current: {
        getBoundingClientRect: () => {
          const b = trigger.current?.getBoundingClientRect() ?? new DOMRect();
          const island = trigger.current?.closest('[data-island]')?.getBoundingClientRect();
          return new DOMRect(island ? island.right : b.right, b.top, 0, b.height);
        },
      },
    }),
    [],
  );
  const label = rnnoise ? t('shell.noiseOn') : t('shell.noiseOff');
  return (
    <Popover.Root onOpenChange={(open) => (open ? undefined : stopMicCheck())}>
      <Tip label={label}>
        <Popover.Trigger asChild>
          <button
            ref={trigger}
            type="button"
            aria-label={label}
            data-testid="noise-button"
            className={cx(
              'grid size-8 shrink-0 place-items-center rounded-[var(--radius-icon)] transition-colors duration-[var(--motion-fast)]',
              rnnoise
                ? 'bg-[color-mix(in_srgb,var(--color-accent)_20%,transparent)] text-accent-text hover:bg-[color-mix(in_srgb,var(--color-accent)_28%,transparent)]'
                : 'text-muted hover:bg-hover hover:text-fg data-[state=open]:bg-hover data-[state=open]:text-fg',
            )}
          >
            <AudioLines className="size-5" aria-hidden />
          </button>
        </Popover.Trigger>
      </Tip>
      <Popover.Anchor virtualRef={anchor} />
      <Popover.Portal>
        {/* Right of the island, bottom-aligned with the button, so it grows up over the chat and never covers the panel. */}
        <Popover.Content
          side="right"
          align="end"
          sideOffset={12}
          collisionPadding={16}
          aria-label={t('voice.rnnoise')}
          data-testid="noise-popover"
          className={cx(popoverBox, 'flex w-80 flex-col gap-3 p-4')}
        >
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-[15px] font-semibold leading-5">{t('voice.rnnoise')}</h2>
            <Toggle label={t('voice.rnnoise')} checked={rnnoise} disabled={musician} onChange={(v) => setPrefs({ rnnoise: v })} />
          </div>
          <p className="text-body text-muted">{musician ? t('music.rnnoiseOff') : t('noise.about')}</p>
          <div className="flex flex-col gap-2">
            <h3 className="text-body font-semibold">{t('voice.micTest')}</h3>
            <div className="flex items-center gap-3">
              <Button variant="secondary" className="min-w-24" onClick={toggleMicCheck}>
                {phase === 'idle' ? t('voice.startTest') : t('voice.stopTest')}
              </Button>
              <SegmentMeter db={db} />
            </div>
            {phase === 'idle' && error ? (
              <p className="text-caption text-danger-text" role="alert">
                {error}
              </p>
            ) : (
              <p className="text-caption text-faint" aria-live="polite">
                {phase === 'recording' ? t('noise.recording') : phase === 'playing' ? t('noise.playing') : t('noise.checkHint')}
              </p>
            )}
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-line pt-3 text-caption">
            <span className="text-muted">{t('noise.poweredBy')}</span>
            <a href={RNNOISE_DOCS_URL} target="_blank" rel="noreferrer" className="rounded-[var(--radius-control)] font-medium text-accent-text hover:underline">
              {t('noise.learnMore')}
            </a>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
