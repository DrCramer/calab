import { ScreenSharePreset, clampStreamPreset, type ConcreteScreenSharePreset } from '@calaba/protocol';
import * as DialogP from '@radix-ui/react-dialog';
import * as TooltipP from '@radix-ui/react-tooltip';
import { AppWindow, Lock, Monitor, MonitorUp, Settings2, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { thumbSizeFor, type ThumbRequest } from '../../../shared/captureThumb';
import type { CaptureSource } from '../../../shared/ipc';
import { Button, CloseButton, Segmented, Spinner, Toggle, cx } from '../../components/ui';
import { t } from '../../i18n';
import { platform } from '../../platform';
import { allowedStreamPreset } from '../../lib/plan';
import { planToast } from '../../services/plan';
import { voice } from '../../services/voice';
import { usePrefs } from '../../stores/prefs';
import { useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { useVoice } from '../../stores/voice';
import { useWorkspaces } from '../../stores/workspaces';
import { StreamCodecSelect, streamCodecHint } from './StreamCodecSelect';
import { pickerLayout, presetOptions, presetSummary, splitSources } from './streamFormat';

// Room / workspace settings import these from here.
export { PRESETS, PRESET_LABEL, presetDetail, presetText } from './streamFormat';

type Tab = 'apps' | 'screens';

/** Resizing the window resizes the cards: refetch the thumbnails once the size settles. */
const THUMB_REFETCH_MS = 250;

/** Content box (without padding) of the sources area, kept up to date by a ResizeObserver. */
function useAreaSize(): [(el: HTMLDivElement | null) => void, { w: number; h: number } | null] {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const ro = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => {
    ro.current?.disconnect();
    ro.current = null;
    if (!el) return;
    const measure = (): void => {
      const cs = getComputedStyle(el);
      const w = Math.floor(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
      const h = Math.floor(el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom));
      if (w > 0) setSize((s) => (s && s.w === w && s.h === h ? s : { w, h }));
    };
    ro.current = new ResizeObserver(measure);
    ro.current.observe(el);
    measure();
  }, []);
  return [ref, size];
}

/**
 * Tooltip rendered inside the dialog (no portal): the shared Tip portals to <body> at the popover
 * layer, which sits under the modal layer (docs/08, z-index scale).
 */
function InlineTip({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <TooltipP.Root delayDuration={400}>
      <TooltipP.Trigger asChild>{children}</TooltipP.Trigger>
      <TooltipP.Content
        side="top"
        sideOffset={6}
        collisionPadding={8}
        className="tip mat-popover anim-in z-[var(--z-popover)] max-w-72 rounded-[var(--radius-row)] px-2 py-1 text-[12px] text-fg"
      >
        {label}
      </TooltipP.Content>
    </TooltipP.Root>
  );
}

/**
 * Quality segment: presets above the room limit stay visible but disabled, with the reason on
 * hover; above the plan's limit (ADR-0024) — with a lock, and a click explains how to get them.
 */
function QualitySegment({
  max,
  planMax,
  value,
  onChange,
}: {
  max: ConcreteScreenSharePreset;
  planMax: ScreenSharePreset | undefined;
  value: ConcreteScreenSharePreset;
  onChange: (p: ConcreteScreenSharePreset) => void;
}): ReactNode {
  return (
    <div role="radiogroup" aria-label={t('streamPick.quality')} className="inline-flex max-w-full flex-wrap rounded-[var(--radius-control)] bg-hover p-0.5">
      {presetOptions(max, planMax).map((o) => {
        const btn = (
          <button
            key={o.preset}
            type="button"
            role="radio"
            aria-checked={value === o.preset}
            aria-disabled={o.disabledReason ? true : undefined}
            onClick={() => {
              if (o.lock === 'plan') planToast(t('plan.toast.preset', { preset: o.label }));
              else if (!o.disabledReason) onChange(o.preset);
            }}
            className={cx(
              'inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-[12px] font-medium transition-colors duration-[var(--motion-fast)]',
              value === o.preset ? 'bg-elev text-fg shadow-[var(--shadow-card)]' : o.disabledReason ? 'cursor-default text-faint' : 'text-fg hover:bg-[var(--color-fill)]',
            )}
          >
            {o.lock === 'plan' ? <Lock className="size-3" aria-hidden /> : null}
            {o.label}
          </button>
        );
        return o.disabledReason ? (
          <InlineTip key={o.preset} label={o.disabledReason}>
            {btn}
          </InlineTip>
        ) : (
          btn
        );
      })}
    </div>
  );
}

/** One capture source: 16:9 preview + app icon + name; hover (or keyboard focus) shows «Стримить». */
function SourceCard({ source, selected, onSelect, onStart }: { source: CaptureSource; selected: boolean; onSelect: () => void; onStart: () => void }): ReactNode {
  const Fallback = source.kind === 'screen' ? Monitor : AppWindow;
  return (
    <div
      data-testid="stream-source"
      // The selection ring is inset: it never sticks out of the card (nor gets clipped by the grid).
      className={cx(
        'group relative rounded-[var(--radius-card)] p-1.5 transition-colors duration-[var(--motion-fast)]',
        selected ? 'bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] ring-2 ring-inset ring-accent' : 'hover:bg-hover',
      )}
    >
      <button
        type="button"
        aria-pressed={selected}
        aria-label={source.name}
        onClick={onSelect}
        onDoubleClick={onStart}
        className="flex w-full flex-col gap-1.5 rounded-[var(--radius-row)] text-left"
      >
        <span className="grid aspect-video w-full place-items-center overflow-hidden rounded-[var(--radius-row)] bg-[var(--color-video-bg)]">
          {source.thumbnail ? (
            // Fetched at this box's size in device pixels (shared/captureThumb): drawn 1:1, no upscaling.
            <img src={source.thumbnail} alt="" draggable={false} className="size-full object-contain [image-rendering:auto]" />
          ) : (
            <Fallback className="size-10 text-faint" aria-hidden />
          )}
        </span>
        <span className="flex min-w-0 items-center gap-2 px-1 pb-0.5">
          {source.appIcon ? (
            <img src={source.appIcon} alt="" draggable={false} className="size-4 shrink-0 rounded-[3px]" />
          ) : (
            <Fallback className="size-4 shrink-0 text-muted" aria-hidden />
          )}
          <span className="min-w-0 flex-1 truncate text-[13px]" title={source.name}>
            {source.name}
          </span>
        </span>
      </button>
      {/* Over the preview; the card button stays the click target around it. */}
      <div className="pointer-events-none absolute inset-x-1.5 top-1.5 grid aspect-video place-items-center rounded-[var(--radius-row)] bg-black/45 opacity-0 transition-opacity duration-[var(--motion-fast)] group-focus-within:opacity-100 group-hover:opacity-100">
        <Button size="lg" className="pointer-events-auto" aria-label={t('streamPick.streamSource', { name: source.name })} onClick={onStart}>
          <MonitorUp className="size-4" aria-hidden />
          {t('streamPick.stream')}
        </Button>
      </div>
    </div>
  );
}

/** Stream picker (docs/09 #13, Discord-like): sources grid + preset bar. */
export function StreamPicker({ onClose }: { onClose: () => void }): ReactNode {
  const roomId = useVoice((s) => s.roomId);
  const room = useRooms((s) => (roomId ? s.byId[roomId] : undefined));
  const info = useSession((s) => s.appInfo);
  const prefs = usePrefs();
  const web = platform.kind === 'web';
  const [sources, setSources] = useState<CaptureSource[] | null>(web ? [] : null);
  const [tab, setTab] = useState<Tab>('screens');
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [areaRef, area] = useAreaSize();
  const [systemAudio, setSystemAudio] = useState(info?.systemAudioLoopback === 'supported');
  const [advanced, setAdvanced] = useState(false);
  const max = room?.media?.maxStreamPreset || ScreenSharePreset.H1080;
  const wsId = useVoice((s) => s.workspaceId);
  const planMax = useWorkspaces((s) => (wsId ? s.byId[wsId]?.ws.plan?.limits?.streamMaxPreset : undefined));
  // The saved choice, lowered to what the room and the plan allow (never a locked preset).
  const preset = allowedStreamPreset(clampStreamPreset(prefs.streamPreset, max), max, planMax);
  const loopback = info?.systemAudioLoopback ?? 'unsupported';

  const groups = splitSources(sources ?? []);
  const shown = tab === 'apps' ? groups.apps : groups.screens;

  // Thumbnails at the cards' size (docs/09 #17): one screen = one big card, several = a grid.
  // Before the first list: one screen (the usual case), a grid of windows.
  const dpr = window.devicePixelRatio || 1;
  const nScreens = sources ? groups.screens.length : 1;
  const nApps = sources ? groups.apps.length : 2;
  const wanted: ThumbRequest | null = area
    ? { screen: thumbSizeFor(pickerLayout(area.w, area.h, nScreens).preview, dpr), window: thumbSizeFor(pickerLayout(area.w, area.h, nApps).preview, dpr) }
    : null;
  const wantedKey = wanted ? `${wanted.screen.width}x${wanted.screen.height}/${wanted.window.width}x${wanted.window.height}` : '';
  const fetched = useRef<string | null>(null);
  const initialized = useRef(false);
  const oneScreen = !!info?.visualTest && (window as Window & { __calabaVisualOneScreen?: boolean }).__calabaVisualOneScreen === true;

  const listed = sources !== null;
  useEffect(() => {
    if (web || !wanted || fetched.current === wantedKey) return; // web: the browser shows its own picker
    let alive = true;
    let done = false;
    const load = (): void => {
      fetched.current = wantedKey;
      void platform.capture.listSources(wanted).then((all) => {
        if (!alive) return;
        done = true;
        // Visual tests: the single-screen layout from the two synthetic screens.
        const list = oneScreen ? all.filter((s) => s.kind !== 'screen' || s === all.find((o) => o.kind === 'screen')) : all;
        setSources(list);
        if (initialized.current) return;
        // The first list: «Весь экран» first and by default (docs/09 #17), its first screen picked.
        initialized.current = true;
        const { apps, screens } = splitSources(list);
        const firstTab: Tab = screens.length > 0 || apps.length === 0 ? 'screens' : 'apps';
        setTab(firstTab);
        setPickedId((firstTab === 'screens' ? screens[0] : apps[0])?.id ?? null);
      });
    };
    // The first list at once; after a resize, once the size settles.
    const timer = window.setTimeout(load, listed ? THUMB_REFETCH_MS : 0);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      // Superseded before its answer: this size was not shown after all.
      if (!done && fetched.current === wantedKey) fetched.current = null;
    };
    // `wanted` is described by `wantedKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [web, wantedKey, oneScreen]);

  const layout = area ? pickerLayout(area.w, area.h, shown.length) : null;
  const only = shown.length === 1 ? shown[0] : undefined;
  const picked = sources?.find((s) => s.id === pickedId) ?? null;

  const switchTab = (next: Tab): void => {
    setTab(next);
    const list = next === 'apps' ? groups.apps : groups.screens;
    if (!list.some((s) => s.id === pickedId)) setPickedId(list[0]?.id ?? null);
  };

  const start = (src: CaptureSource | null = picked): void => {
    if (!src && !web) return;
    onClose();
    const source = src ? { id: src.id, name: src.name, displayId: src.displayId } : { id: '', name: '' };
    void voice.startStream({ source, preset, contentHint: prefs.contentHint, systemAudio });
  };

  const noThumbs = sources !== null && sources.length > 0 && sources.every((s) => !s.thumbnail);
  // Visual tests: synthetic sources, and the machine's real TCC state must not leak into shots.
  const denied = noThumbs || (!info?.visualTest && info?.screenAccess === 'denied');

  return (
    <DialogP.Root open onOpenChange={(o) => !o && onClose()}>
      <DialogP.Portal>
        <DialogP.Overlay className="no-drag fixed inset-0 z-[var(--z-modal)] bg-scrim" />
        <DialogP.Content
          aria-modal="true"
          aria-describedby={undefined}
          data-testid="stream-picker"
          // Desktop: 900×600 like a macOS sheet — never above y = 46 (the 38 px title bar and the
          // traffic lights stay visible), shrinking to 100vh − 62 px (16 px bottom margin); the grid
          // scrolls inside. Centred when the window is tall enough, top-anchored otherwise, hence
          // data-layout-anchor (same as SettingsWindow). The web has no source grid (the browser
          // picks), so its sheet only needs its content height and stays centred.
          data-layout-anchor={web ? undefined : ''}
          className={cx(
            'mat-sheet anim-in fixed left-1/2 z-[var(--z-modal)] flex -translate-x-1/2 flex-col overflow-hidden rounded-[var(--radius-panel)] text-[13px] focus:outline-none',
            web ? 'top-1/2 max-h-[calc(100vh-62px)] -translate-y-1/2' : 'top-[max(46px,calc(50vh-300px))] h-[min(600px,calc(100vh-62px))]',
          )}
          style={{ width: web ? 'min(720px, calc(100vw - 32px))' : 'min(900px, calc(100vw - 32px))' }}
        >
          <TooltipP.Provider>
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4 px-5 pb-3 pt-4">
              <DialogP.Title className="truncate text-[16px] font-semibold">{t('streamPick.title')}</DialogP.Title>
              {web ? (
                <span />
              ) : (
                <Segmented
                  label={t('streamPick.kind')}
                  value={tab}
                  onChange={switchTab}
                  options={[
                    { value: 'screens', label: t('streamPick.screens') },
                    { value: 'apps', label: t('streamPick.apps') },
                  ]}
                />
              )}
              <DialogP.Close asChild>
                <CloseButton label={t('streamPick.close')} className="-mr-1 justify-self-end" />
              </DialogP.Close>
            </div>

            {denied && !web ? (
              <div className="mx-5 mb-3 flex items-center gap-3 rounded-[var(--radius-row)] bg-mention px-3 py-2 text-[13px]" role="alert">
                <TriangleAlert className="size-4 shrink-0 text-warn" aria-hidden />
                <span className="min-w-0 flex-1">{t('stream.noScreenAccess')}</span>
                <Button size="sm" variant="secondary" onClick={() => void platform.system.openPrivacySettings('screen')}>
                  {t('common.openSettings')}
                </Button>
              </div>
            ) : null}

            {/* The last 16 px (the bottom padding) fade out, so a row cut by the footer reads as «more below». */}
            <div ref={areaRef} className="min-h-0 flex-1 overflow-y-auto px-5 pb-4 [mask-image:linear-gradient(to_bottom,black_calc(100%-16px),transparent)]">
              {web ? (
                <div className="flex flex-col items-center justify-center gap-2 px-8 py-6 text-center">
                  <MonitorUp className="size-10 text-faint" aria-hidden />
                  <div className="text-[16px] font-semibold">{t('streamPick.webTitle')}</div>
                  <p className="max-w-md text-muted">{t('stream.webPicker')}</p>
                </div>
              ) : sources === null ? (
                <div className="grid h-full place-items-center">
                  <Spinner />
                </div>
              ) : shown.length === 0 ? (
                <div className="grid h-full place-items-center text-muted">{tab === 'apps' ? t('streamPick.noApps') : t('streamPick.noScreens')}</div>
              ) : layout?.single && only ? (
                // One source: one large card in the middle of the area (docs/09 #17).
                <div className="grid h-full place-items-center" data-layout="single">
                  <div style={{ width: layout.card }}>
                    <SourceCard source={only} selected={only.id === pickedId} onSelect={() => setPickedId(only.id)} onStart={() => start(only)} />
                  </div>
                </div>
              ) : (
                // Fixed column width = the width the thumbnails were fetched for (drawn 1:1).
                <div
                  className="grid justify-center gap-3"
                  data-layout="grid"
                  style={{ gridTemplateColumns: layout ? `repeat(2, ${layout.card}px)` : 'repeat(2, minmax(0, 1fr))' }}
                >
                  {shown.map((s) => (
                    <SourceCard key={s.id} source={s} selected={s.id === pickedId} onSelect={() => setPickedId(s.id)} onStart={() => start(s)} />
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-3 border-t border-line px-5 py-3">
              {systemAudio && loopback === 'experimental' ? (
                <p className="flex items-start gap-2 rounded-[var(--radius-row)] bg-mention px-3 py-2 text-[12px]" role="note">
                  <TriangleAlert className="mt-px size-4 shrink-0 text-warn" aria-hidden />
                  {t(info?.platform === 'win32' ? 'stream.systemAudioWin10' : 'stream.systemAudioMac')}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                <QualitySegment max={max} planMax={planMax} value={preset} onChange={(p) => prefs.setPrefs({ streamPreset: p })} />
                <InlineTip label={prefs.contentHint === 'motion' ? t('streamPick.videoHint') : t('streamPick.textHint')}>
                  <span>
                    <Segmented
                      label={t('streamPick.content')}
                      value={prefs.contentHint}
                      onChange={(v) => prefs.setPrefs({ contentHint: v })}
                      options={[
                        { value: 'detail', label: t('streamPick.text') },
                        { value: 'motion', label: t('streamPick.video') },
                      ]}
                    />
                  </span>
                </InlineTip>
                <span className={cx('flex items-center gap-2', loopback === 'unsupported' && 'opacity-50')}>
                  <span className="text-[13px]">{t('streamPick.sound')}</span>
                  {loopback === 'unsupported' ? (
                    <InlineTip label={t('stream.systemAudioNo')}>
                      <span>
                        <Toggle checked={false} disabled onChange={() => undefined} label={t('streamPick.sound')} />
                      </span>
                    </InlineTip>
                  ) : (
                    <Toggle checked={systemAudio} onChange={setSystemAudio} label={t('streamPick.sound')} />
                  )}
                </span>
                <button
                  type="button"
                  aria-label={t('streamPick.advanced')}
                  aria-expanded={advanced}
                  onClick={() => setAdvanced(!advanced)}
                  className={cx(
                    'ml-auto grid size-7 place-items-center rounded-[var(--radius-icon)] transition-colors duration-[var(--motion-fast)]',
                    advanced ? 'bg-active text-fg' : 'text-muted hover:bg-hover hover:text-fg',
                  )}
                >
                  <Settings2 className="size-4" aria-hidden />
                </button>
              </div>
              {advanced ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[var(--radius-card)] bg-hover px-3 py-2" data-testid="stream-advanced">
                  {/* The same «Кодек стрима» as settings → «Показ экрана» (ADR-0032). */}
                  <span>{t('video.streamCodec')}</span>
                  <StreamCodecSelect />
                  <span className="basis-full text-[12px] text-muted">{streamCodecHint(prefs.streamCodec)}</span>
                </div>
              ) : null}
              <div className="flex items-center gap-2">
                <span className="flex min-w-0 flex-1 items-center gap-2 text-muted" data-testid="stream-summary">
                  <MonitorUp className="size-4 shrink-0" aria-hidden />
                  <span className="truncate">{presetSummary(preset, prefs.contentHint)}</span>
                </span>
                <Button variant="secondary" onClick={onClose}>
                  {t('common.cancel')}
                </Button>
                <Button onClick={() => start()} disabled={!picked && !web}>
                  {t('stream.go')}
                </Button>
              </div>
            </div>
          </TooltipP.Provider>
        </DialogP.Content>
      </DialogP.Portal>
    </DialogP.Root>
  );
}
