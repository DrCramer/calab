/** The parts of a `WheelEvent` the classifier reads (kept narrow so tests can pass plain objects). */
export interface WheelLike {
  deltaX: number;
  deltaY: number;
  /** 0 pixels, 1 lines, 2 pages. */
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  timeStamp: number;
}

/** What a wheel event means on the canvas: a zoom by `factor`, or a pan by screen pixels. */
export type WheelAction =
  | { kind: 'zoom'; factor: number }
  | { kind: 'pan'; dx: number; dy: number };

/** Zoom factor of one mouse-wheel notch (a notch is ±100 px, 3 lines). */
export const NOTCH_ZOOM = 1.15;
/**
 * Trackpad pinch in Chrome/Electron/Firefox arrives as ctrl+wheel whose deltaY is ≈ −100 × the relative
 * scale change (±1…20 per event, 60–120 events a second), so exp(−deltaY × 0.01) follows the fingers 1:1.
 */
const PINCH_RATE = 0.01;
const PINCH_MAX_DELTA = 50;
const NOTCH_PX = 100;
const NOTCH_LINES = 3;
const LINE_PX = 16;
/** After a trackpad-looking event, big integer deltas are still the trackpad (a fast flick starts and ends with them). */
const TRACKPAD_HOLD_MS = 400;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Tells the devices apart from what the browser gives (there is no flag for it): a two-finger scroll is a
 * pan, a pinch (ctrl+wheel with small deltas) is a smooth zoom, a mouse wheel notch (line/page mode or a
 * big integer pixel delta) zooms in steps. Stateful only by the time of the last trackpad-looking event.
 */
export class WheelClassifier {
  private trackpadAt = -Infinity;

  classify(e: WheelLike, pageHeight: number): WheelAction {
    const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? pageHeight : 1;
    if (e.ctrlKey || e.metaKey) {
      if (e.deltaMode !== 0 || (Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= NOTCH_PX)) return this.notch(e);
      this.trackpadAt = e.timeStamp;
      return { kind: 'zoom', factor: Math.exp(-clamp(e.deltaY, -PINCH_MAX_DELTA, PINCH_MAX_DELTA) * PINCH_RATE) };
    }
    const wheel =
      e.deltaMode !== 0 ||
      (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= NOTCH_PX && e.timeStamp - this.trackpadAt > TRACKPAD_HOLD_MS);
    if (wheel) {
      // Shift turns a notch into a horizontal pan, as everywhere.
      if (e.shiftKey) return { kind: 'pan', dx: -(e.deltaX || e.deltaY) * unit, dy: 0 };
      return this.notch(e);
    }
    this.trackpadAt = e.timeStamp;
    if (e.shiftKey && e.deltaX === 0) return { kind: 'pan', dx: -e.deltaY, dy: 0 };
    return { kind: 'pan', dx: -e.deltaX, dy: -e.deltaY };
  }

  private notch(e: WheelLike): WheelAction {
    const notches = clamp(e.deltaMode === 0 ? e.deltaY / NOTCH_PX : e.deltaY / NOTCH_LINES, -3, 3);
    return { kind: 'zoom', factor: NOTCH_ZOOM ** -notches };
  }
}
