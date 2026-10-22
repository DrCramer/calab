import { forwardRef, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { useMobile } from '../../lib/mobile';
import { useVoice } from '../../stores/voice';
import { SelfPanel } from './SelfPanel';
import { VoiceBar } from './VoiceBar';
import { MeetingRecordPrompt } from '../calendar/RoomEvent';

/**
 * Bottom island (docs/08 «Нижний островок», Discord reference): «Голос подключён» and
 * the self panel as one floating block across the whole left part — from the rail's
 * left edge to the room column's right edge, 8 px in (4 px up from the bottom, so my avatar lands
 * on the rail's axis at the inset the old rail avatar had), radius 12, on the window layer. The rail
 * and the room list end above it: its height is published as `--island-height` on the parent
 * (their bottom padding).
 */
export function BottomIsland(): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const host = el?.parentElement;
    if (!el || !host) return;
    const ro = new ResizeObserver(() => host.style.setProperty('--island-height', `${el.offsetHeight}px`));
    ro.observe(el);
    return () => {
      ro.disconnect();
      host.style.removeProperty('--island-height');
    };
  }, []);
  return (
    <VoiceBlock
      ref={ref}
      testId="bottom-island"
      island
      className="absolute bottom-2 left-2 z-[var(--z-sticky)]"
      style={{ width: 'calc(var(--rail-width) + var(--sidebar-width) - 16px)' }}
    />
  );
}

/**
 * The one shell of the voice block (docs/08 «Нижний островок»): mat-toolbar plate, panel radius,
 * island shadow, hairline-separated record prompt, VoiceBar and SelfPanel. The island and the
 * work-section column both render it; they differ only in positioning and width (className/style).
 */
const VoiceBlock = forwardRef<
  HTMLDivElement,
  { testId: string; island?: boolean; className: string; style?: CSSProperties }
>(function VoiceBlock({ testId, island, className, style }, ref) {
  return (
    <div
      ref={ref}
      data-testid={testId}
      data-island={island ? true : undefined}
      className={`mat-toolbar flex flex-col divide-y divide-line overflow-hidden rounded-[var(--radius-panel)] shadow-[var(--shadow-island)] ${className}`}
      style={style}
    >
      <MeetingRecordPrompt />
      <VoiceBar />
      <SelfPanel />
    </div>
  );
});

/**
 * The same block as the island (`VoiceBlock`), in the flow at the foot of a work-section
 * column (Boards, Calendar, Wiki have no island - owner 02.10 - but a call must stay reachable:
 * bug board CBF-4). Only while in voice, desktop layout only (the phone has its call strip).
 */
export function ColumnVoice(): ReactNode {
  const inVoice = useVoice((s) => s.roomId !== null);
  const mobile = useMobile();
  if (!inVoice || mobile) return null;
  return <VoiceBlock testId="voice-dock" className="mx-2 mb-2 mt-auto shrink-0" />;
}
