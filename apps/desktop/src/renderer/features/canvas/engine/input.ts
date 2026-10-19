import { dist, hitHandle, type HandleId, type Point } from '../../../lib/canvas/geometry';
import { isConnector } from '../../../lib/canvas/types';
import type { CanvasEngine } from './engine';
import {
  CreateGesture, EndpointGesture, MarqueeGesture, MoveGesture, PanGesture, PinchGesture, ResizeGesture, WireGesture,
  type Mods,
} from './gestures';
import { HANDLE_PX } from './overlay';

const RESIZE_CURSOR: Record<HandleId, string> = {
  nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
};

const mods = (e: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): Mods => ({
  shift: e.shiftKey,
  alt: e.altKey,
  mod: e.ctrlKey || e.metaKey,
});

/**
 * Wires pointer, wheel and keyboard events on the canvas element to engine commands (ADR-0107 §4).
 * Returns the detach function. Listeners are passive-free only where preventDefault is needed (wheel).
 */
export function attachInput(engine: CanvasEngine, canvas: HTMLCanvasElement): () => void {
  const pointers = new Map<number, Point>();
  let spaceDown = false;
  let panDrag: { id: number } | null = null;
  let pinch: PinchGesture | null = null;
  let cursor = '';

  const setCursor = (c: string): void => {
    if (c === cursor) return;
    cursor = c;
    canvas.style.cursor = c;
  };

  const local = (e: { clientX: number; clientY: number }): { s: Point; w: Point } => {
    const r = canvas.getBoundingClientRect();
    const s = { x: e.clientX - r.left, y: e.clientY - r.top };
    return { s, w: engine.toWorld(s) };
  };

  const idleCursor = (): string => {
    if (spaceDown) return 'grab';
    return engine.tool === 'select' ? '' : 'crosshair';
  };

  const hoverCursor = (w: Point): string => {
    if (engine.tool !== 'select') return 'crosshair';
    if (engine.readOnly) return 'grab';
    const g = groupHandleAt(w);
    if (g) return RESIZE_CURSOR[g];
    if (connectorEndAt(w)) return 'pointer';
    return engine.hitAt(w) ? 'move' : '';
  };

  const groupHandleAt = (w: Point): HandleId | null => {
    const grp = currentGroup();
    return grp ? hitHandle(grp, w, engine.px(HANDLE_PX)) : null;
  };

  const currentGroup = (): import('../../../lib/canvas/geometry').Rect | null => {
    if (engine.readOnly) return null;
    const b = engine.scene.bounds([...engine.selection].filter((id) => {
      const o = engine.scene.get(id);
      return o && !isConnector(o);
    }));
    return b;
  };

  const connectorEndAt = (w: Point): 'from' | 'to' | null => {
    if (engine.selection.size !== 1) return null;
    const id = [...engine.selection][0];
    const c = id ? engine.scene.get(id) : undefined;
    if (!c || !isConnector(c) || c.points.length < 4) return null;
    const r = engine.px(HANDLE_PX);
    const a = { x: c.points[0] ?? 0, y: c.points[1] ?? 0 };
    const b = { x: c.points[c.points.length - 2] ?? 0, y: c.points[c.points.length - 1] ?? 0 };
    if (dist(w, b) <= r) return 'to';
    if (dist(w, a) <= r) return 'from';
    return null;
  };

  const onDown = (e: PointerEvent): void => {
    canvas.focus({ preventScroll: true });
    engine.cancelAnimation();
    const { s, w } = local(e);
    pointers.set(e.pointerId, s);
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic events have no active pointer to capture.
    }
    if (pointers.size === 2) {
      // Second finger: abort a plain gesture and pinch.
      engine.activeGesture?.cancel();
      engine.activeGesture = null;
      const [a, b] = [...pointers.values()];
      if (a && b) pinch = new PinchGesture(engine, a, b);
      return;
    }
    if (pointers.size > 2) return;
    const m = mods(e);
    const wantsPan = e.button === 1 || (e.button === 0 && spaceDown) || (e.button === 0 && engine.readOnly);
    if (wantsPan) {
      e.preventDefault();
      engine.activeGesture = new PanGesture(engine, s);
      panDrag = { id: e.pointerId };
      setCursor('grabbing');
      return;
    }
    if (e.button !== 0) return;
    switch (engine.tool) {
      case 'sticky':
      case 'text':
      case 'shape':
        engine.activeGesture = new CreateGesture(engine, engine.tool, w, s);
        return;
      case 'connector':
        engine.activeGesture = new WireGesture(engine, w, s);
        return;
      case 'select':
        break;
    }
    // Select tool.
    const handle = groupHandleAt(w);
    if (handle) {
      const ids = [...engine.selection].filter((id) => {
        const o = engine.scene.get(id);
        return o && !isConnector(o);
      });
      engine.activeGesture = new ResizeGesture(engine, handle, ids);
      return;
    }
    const end = connectorEndAt(w);
    if (end) {
      const id = [...engine.selection][0];
      const c = id ? engine.scene.get(id) : undefined;
      if (c && isConnector(c)) {
        engine.activeGesture = new EndpointGesture(engine, c, end);
        return;
      }
    }
    const hit = engine.hitAt(w);
    if (hit) {
      const wasSelected = engine.selection.has(hit.id);
      if (m.shift) {
        const next = new Set(engine.selection);
        if (wasSelected) next.delete(hit.id);
        else next.add(hit.id);
        engine.setSelection(next);
        if (wasSelected) return;
      } else if (!wasSelected) engine.setSelection([hit.id]);
      const ids = [...engine.selection];
      engine.activeGesture = new MoveGesture(engine, ids, w, s, () => {
        // A click on an already selected member of a group narrows to it.
        if (!m.shift && wasSelected && ids.length > 1) engine.setSelection([hit.id]);
      });
      return;
    }
    engine.activeGesture = new MarqueeGesture(engine, w, m.shift);
  };

  const onMove = (e: PointerEvent): void => {
    const { s, w } = local(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, s);
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      if (a && b) pinch.update(a, b);
      return;
    }
    const g = engine.activeGesture;
    if (g) {
      g.move(w, s, mods(e));
      return;
    }
    engine.setLocalCursor(w);
    if (e.pointerType === 'mouse') setCursor(spaceDown ? 'grab' : hoverCursor(w));
  };

  const finish = (e: PointerEvent, cancelled: boolean): void => {
    const { s, w } = local(e);
    pointers.delete(e.pointerId);
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      // Already released.
    }
    if (pinch) {
      if (pointers.size < 2) pinch = null;
      return;
    }
    const g = engine.activeGesture;
    if (!g) return;
    engine.activeGesture = null;
    if (panDrag?.id === e.pointerId) panDrag = null;
    if (cancelled) g.cancel();
    else g.end(w, s, mods(e));
    setCursor(idleCursor());
  };

  const onUp = (e: PointerEvent): void => finish(e, false);
  const onCancel = (e: PointerEvent): void => finish(e, true);
  const onLeave = (): void => engine.setLocalCursor(null);

  const onDouble = (e: MouseEvent): void => {
    if (engine.readOnly || engine.tool !== 'select') return;
    const { w } = local(e);
    const hit = engine.hitAt(w);
    if (hit) {
      engine.setSelection([hit.id]);
      engine.startTextEdit(hit.id);
    } else engine.createTextAt(w);
  };

  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const { s } = local(e);
    // Line/page deltas are a mouse wheel; the scale below makes them comparable to pixel deltas.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.clientHeight : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    if (e.ctrlKey || e.metaKey) {
      // Trackpad pinch arrives as ctrl+wheel with small deltas; a mouse notch is ~100.
      const notch = e.deltaMode !== 0 || Math.abs(e.deltaY) >= 50;
      const factor = notch ? (dy < 0 ? 1.1 : 1 / 1.1) : Math.exp(-dy * 0.01);
      engine.zoomAtPoint(factor, s);
    } else if (e.shiftKey && dx === 0) engine.panByScreen(-dy, 0);
    else engine.panByScreen(-dx, -dy);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.isComposing || e.target !== canvas) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (e.key === ' ' && !spaceDown) {
      spaceDown = true;
      setCursor('grab');
      e.preventDefault();
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      const g = engine.activeGesture;
      if (g) {
        engine.activeGesture = null;
        g.cancel();
      } else if (engine.selection.size > 0) engine.clearSelection();
      else engine.setTool('select');
      return;
    }
    if (mod) {
      switch (true) {
        case k === 'a': engine.selectAll(); break;
        case k === 'c': void engine.copy(); break;
        case k === 'x': void engine.cut(); break;
        case k === 'v': void engine.paste(); break;
        case k === 'z': if (e.shiftKey) engine.redo(); else engine.undo(); break;
        case k === 'y': engine.redo(); break;
        case k === 'd': engine.duplicateSelection(); break;
        case e.code === 'BracketRight': engine.reorder(1, e.shiftKey); break;
        case e.code === 'BracketLeft': engine.reorder(-1, e.shiftKey); break;
        case k === '0': engine.zoomTo(100); break;
        case k === '=' || k === '+': engine.zoomStep(1); break;
        case k === '-': engine.zoomStep(-1); break;
        default: return;
      }
      e.preventDefault();
      return;
    }
    if (e.shiftKey && e.code === 'Digit1') {
      engine.fitAll();
    } else if (e.shiftKey && e.code === 'Digit2') {
      engine.fitSelection();
    } else {
      switch (e.key) {
        case 'Delete':
        case 'Backspace': engine.deleteSelection(); break;
        case 'Enter': if (!engine.startTextEdit()) return; break;
        case 'Tab': engine.cycleSelection(e.shiftKey ? -1 : 1); break;
        case 'ArrowLeft': engine.nudge(e.shiftKey ? -10 : -1, 0); break;
        case 'ArrowRight': engine.nudge(e.shiftKey ? 10 : 1, 0); break;
        case 'ArrowUp': engine.nudge(0, e.shiftKey ? -10 : -1); break;
        case 'ArrowDown': engine.nudge(0, e.shiftKey ? 10 : 1); break;
        case '+':
        case '=': engine.zoomStep(1); break;
        case '-':
        case '_': engine.zoomStep(-1); break;
        default:
          if (e.shiftKey || e.altKey) return;
          switch (k) {
            case 'v': engine.setTool('select'); break;
            case 's': if (engine.readOnly) return; engine.setTool('sticky'); break;
            case 't': if (engine.readOnly) return; engine.setTool('text'); break;
            case 'r': if (engine.readOnly) return; engine.setTool('shape'); break;
            case 'c': if (engine.readOnly) return; engine.setTool('connector'); break;
            default: return;
          }
      }
    }
    e.preventDefault();
  };

  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === ' ') {
      spaceDown = false;
      setCursor(idleCursor());
    }
  };

  const onBlur = (): void => {
    spaceDown = false;
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onCancel);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('dblclick', onDouble);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('keydown', onKeyDown);
  canvas.addEventListener('keyup', onKeyUp);
  canvas.addEventListener('blur', onBlur);
  return () => {
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onCancel);
    canvas.removeEventListener('pointerleave', onLeave);
    canvas.removeEventListener('dblclick', onDouble);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('keydown', onKeyDown);
    canvas.removeEventListener('keyup', onKeyUp);
    canvas.removeEventListener('blur', onBlur);
  };
}
