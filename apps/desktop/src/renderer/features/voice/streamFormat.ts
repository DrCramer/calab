import { SCREEN_SHARE_PRESETS, SCREEN_SHARE_PRESET_DISPLAY_ORDER, SCREEN_SHARE_PRESET_ORDER, ScreenSharePreset, type ConcreteScreenSharePreset, type ScreenShareContentHint } from '@calaba/protocol';
import type { CaptureSource } from '../../../shared/ipc';
import { plural, t, type MessageKey } from '../../i18n';
import { streamPresetLock, type PresetLock } from '../../lib/plan';
import type { StreamQuality } from '../../stores/voice';

/** Pure formatting / grouping for the stream picker and the stream stage (unit-tested). */

export const PRESET_LABEL: Record<ConcreteScreenSharePreset, MessageKey> = {
  [ScreenSharePreset.ECONOMY]: 'preset.economy',
  [ScreenSharePreset.H720]: 'preset.h720',
  [ScreenSharePreset.H1080]: 'preset.h1080',
  [ScreenSharePreset.ORIGINAL]: 'preset.original',
  [ScreenSharePreset.H720_30]: 'preset.h72030',
  [ScreenSharePreset.H1080_30]: 'preset.h108030',
  [ScreenSharePreset.H1080_60]: 'preset.h108060',
  [ScreenSharePreset.H1440_30]: 'preset.h144030',
  [ScreenSharePreset.H1440_60]: 'preset.h144060',
  [ScreenSharePreset.H2160_30]: 'preset.h216030',
  [ScreenSharePreset.H2160_60]: 'preset.h216060',
  [ScreenSharePreset.ORIGINAL_60]: 'preset.original60',
};

export const PRESETS = [...SCREEN_SHARE_PRESET_ORDER];

/** Resolution in words: «1080p» or «исходное разрешение». */
function presetRes(p: ConcreteScreenSharePreset): string {
  const v = SCREEN_SHARE_PRESETS[p];
  return v.height ? `${v.height}p` : t('preset.native');
}

/**
 * Short option label for the 240 px selects in room / workspace settings: «1080p · 15 fps»,
 * «Экономия · 5 fps» — never repeats the resolution. The rest goes to presetDetail (hint / title).
 */
export function presetText(p: ConcreteScreenSharePreset): string {
  return t(PRESET_LABEL[p]);
}

/** The full parameters for a row hint or an option title: «1080p, 15 fps, до 2,0 Мбит/с». */
export function presetDetail(p: ConcreteScreenSharePreset): string {
  const v = SCREEN_SHARE_PRESETS[p];
  return t('preset.detail', { res: presetRes(p), fps: v.fps, mbps: (v.maxBitrate / 1e6).toFixed(1).replace('.', ',') });
}

/** The picker's summary in words: «Текст • 1080p • 15 fps». */
export function presetSummary(p: ConcreteScreenSharePreset, hint: ScreenShareContentHint): string {
  const v = SCREEN_SHARE_PRESETS[p];
  const res = v.height ? `${v.height}p` : t('streamPick.native');
  const kind = hint === 'motion' ? t('streamPick.video') : t('streamPick.text');
  return [kind, res, t('streamPick.fps', { fps: v.fps })].join(' • ');
}

/**
 * Picker quality segment: presets above the room's limit are disabled with the reason; above the
 * plan's (`stream_max_preset`, ADR-0024) — locked, with «Доступно на тарифе Team» (`lock: 'plan'`).
 */
export function presetOptions(
  max: ConcreteScreenSharePreset,
  planMax?: ScreenSharePreset,
): Array<{ preset: ConcreteScreenSharePreset; label: string; lock: PresetLock; disabledReason: string | null }> {
  return SCREEN_SHARE_PRESET_DISPLAY_ORDER.map((p) => {
    const lock = streamPresetLock(p, max, planMax);
    return {
      preset: p,
      label: t(PRESET_LABEL[p]),
      lock,
      disabledReason: lock === 'room' ? t('streamPick.qualityLimited', { max: t(PRESET_LABEL[max]) }) : lock === 'plan' ? t('plan.lockTip') : null,
    };
  });
}

/** Picker card chrome around the 16:9 preview: p-1.5 on each side, and the name row below it. */
export const CARD_PAD = 6;
export const CARD_LABEL = 28;
export const CARD_GAP = 12;

/**
 * Stream picker layout (docs/09 #17) for a source area `areaW` × `areaH` CSS px: one source → one
 * large card centred (≤ 60 % of the width, and short enough to fit the height), several → a
 * two-column grid. `preview` is the 16:9 box the thumbnail is fetched for (thumbSizeFor).
 */
export function pickerLayout(areaW: number, areaH: number, count: number): { single: boolean; card: number; preview: number } {
  const w = Math.max(0, areaW);
  if (count <= 1) {
    const byHeight = areaH > 0 ? ((areaH - CARD_LABEL - 2 * CARD_PAD) * 16) / 9 + 2 * CARD_PAD : Infinity;
    const card = Math.floor(Math.max(160, Math.min(w * 0.6, byHeight)));
    return { single: true, card, preview: card - 2 * CARD_PAD };
  }
  const card = Math.floor((w - CARD_GAP) / 2);
  return { single: false, card, preview: Math.max(0, card - 2 * CARD_PAD) };
}

/** Picker tabs: «Весь экран» = screens (first, the default), «Приложения» = windows. */
export function splitSources(sources: readonly CaptureSource[]): { apps: CaptureSource[]; screens: CaptureSource[] } {
  return { apps: sources.filter((s) => s.kind === 'window'), screens: sources.filter((s) => s.kind === 'screen') };
}

const STANDARD = [144, 180, 240, 360, 480, 540, 720, 1080, 1440, 2160];

/** Layer height → a familiar name: 1078 → «1080p», 359 → «360p», 1912 → «1912p». */
export function layerLabel(height: number): string {
  const near = STANDARD.find((h) => Math.abs(h - height) <= h * 0.03);
  return `${near ?? Math.round(height)}p`;
}

/** Viewer's quality menu: «Авто» + one entry per published layer (largest first, no duplicates). */
export function qualityOptions(layers: ReadonlyArray<{ quality: Exclude<StreamQuality, 'auto'>; height: number }>): Array<{ value: StreamQuality; label: string }> {
  const out: Array<{ value: StreamQuality; label: string }> = [{ value: 'auto', label: t('streamView.qualityAuto') }];
  for (const l of [...layers].sort((a, b) => b.height - a.height)) {
    const label = layerLabel(l.height);
    if (!out.some((o) => o.label === label || o.value === l.quality)) out.push({ value: l.quality, label });
  }
  return out;
}

/** «3 смотрят», «1 смотрит». */
export function viewersText(n: number): string {
  return plural('streamView.viewers', n);
}

const SMALLEST_PIP = { w: 192, h: 108 };
/** PiP sizes (16:9): 320×180 in windows from 1200 px, 240×135 below; 192×108 when the chat is very short. */
const PIP_SIZES = [{ w: 320, h: 180 }, { w: 240, h: 135 }, SMALLEST_PIP];

/** The largest PiP that fits the message area with `gap` above and below it. */
export function pipSize(wide: boolean, availableHeight: number, gap: number): { w: number; h: number } {
  const candidates = wide ? PIP_SIZES : PIP_SIZES.slice(1);
  return candidates.find((s) => s.h + 2 * gap <= availableHeight) ?? SMALLEST_PIP;
}

/** Height of the compact welcome row (EmptyRoom under the stage / video grid): 32 px icon + 2 × 12 px (#56). */
export const WELCOME_ROW = 56;

/** The PiP's edge + shadow, so a tile doesn't float unanchored over an empty feed (#56). */
export const PIP_SHADOW = '0 0 0 1px var(--color-line), 0 16px 40px rgb(0 0 0 / 40%), 0 2px 8px rgb(0 0 0 / 25%)';
