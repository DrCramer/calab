import { memo, useEffect, useRef, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { cx } from '../../../components/ui';
import { t, useLocale } from '../../../i18n';
import { cameraCenteredOn, mapFrame, mapToWorld, MAP_H, MAP_W, type MapFrame } from '../../../lib/canvas/minimap';
import type { CanvasEngine, CanvasPalette } from '../engine';
import { PANEL } from './chrome';
import { drawMinimap, minimapPref } from './minimapDraw';

/** At most this many redraws per second while the scene or the camera keeps changing. */
const MAX_FPS = 10;

export const useMinimapPref = (): boolean => useSyncExternalStore(minimapPref.subscribe, minimapPref.get);

/**
 * The mini-map (ADR-0116): the whole scene as small rectangles with the visible area framed, click or drag to move
 * the camera. Off by default. While off this renders nothing and holds no subscription, timer or canvas; while on
 * it listens to scene and camera changes, redraws at most 10 times a second and only when something changed, and
 * stays quiet while the window is hidden (a timer exists only between a change and its redraw).
 */
export const MiniMap = memo(function MiniMap({ engine, palette, focusCanvas }: { engine: CanvasEngine; palette: CanvasPalette; focusCanvas: () => void }): ReactNode {
  const on = useMinimapPref();
  return on ? <MiniMapBody engine={engine} palette={palette} focusCanvas={focusCanvas} /> : null;
});

function MiniMapBody({ engine, palette, focusCanvas }: { engine: CanvasEngine; palette: CanvasPalette; focusCanvas: () => void }): ReactNode {
  useLocale();
  const ref = useRef<HTMLCanvasElement>(null);
  /** The frame the picture was drawn in; held while dragging so the map does not slide under the pointer. */
  const frame = useRef<MapFrame | null>(null);
  const dragging = useRef(false);
  const redraw = useRef<() => void>(() => undefined);

  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext('2d');
    if (!cv || !ctx) return undefined;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(MAP_W * dpr);
    cv.height = Math.round(MAP_H * dpr);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = -Infinity;
    const draw = (): void => {
      const view = engine.visibleWorld();
      if (!dragging.current || !frame.current) frame.current = mapFrame(engine.scene.bounds(), view);
      drawMinimap(ctx, engine.scene, palette, frame.current, view, dpr);
    };
    const run = (): void => {
      timer = null;
      if (!engine.isActive) return; // hidden: the next view event (it becoming active) schedules again
      last = performance.now();
      draw();
    };
    const schedule = (): void => {
      if (timer !== null || !engine.isActive) return;
      timer = setTimeout(run, Math.max(0, last + 1000 / MAX_FPS - performance.now()));
    };
    redraw.current = schedule;
    const offScene = engine.scene.subscribe(schedule);
    const offView = engine.subscribeView(schedule);
    schedule();
    return () => {
      if (timer !== null) clearTimeout(timer);
      offScene();
      offView();
      redraw.current = () => undefined;
    };
  }, [engine, palette]);

  const steer = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const cv = ref.current;
    const f = frame.current;
    if (!cv || !f) return;
    const r = cv.getBoundingClientRect();
    const p = mapToWorld(f, { x: ((e.clientX - r.left) * MAP_W) / Math.max(r.width, 1), y: ((e.clientY - r.top) * MAP_H) / Math.max(r.height, 1) });
    engine.steerCamera(cameraCenteredOn(engine.liveCamera, engine.viewport, p));
  };

  return (
    <div className={cx(PANEL, 'absolute bottom-[3.75rem] right-3 z-10')} data-testid="canvas-minimap-box">
      <canvas
        ref={ref}
        role="img"
        aria-label={t('canvasBoard.minimap.label')}
        data-testid="canvas-minimap"
        style={{ width: MAP_W, height: MAP_H, touchAction: 'none', cursor: 'pointer' }}
        className="block rounded-[calc(var(--radius-card)-4px)]"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            // No pointer capture (jsdom) or the pointer is already gone: the drag still follows the canvas' own events.
          }
          dragging.current = true;
          steer(e);
        }}
        onPointerMove={(e) => {
          if (dragging.current) steer(e);
        }}
        onPointerUp={(e) => {
          if (!dragging.current) return;
          dragging.current = false;
          try {
            e.currentTarget.releasePointerCapture(e.pointerId);
          } catch {
            // As above.
          }
          engine.flushCamera();
          redraw.current();
          focusCanvas();
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
      />
    </div>
  );
}
