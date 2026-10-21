import { ROTATE_CURSOR, dist, hitHandleRot, resizeCursorAt, rotateHandlePoint, type HandleId, type Point } from '../../../lib/canvas/geometry';
import { isConnector } from '../../../lib/canvas/types';
import type { CanvasEngine } from './engine';
import {
  CreateGesture, EndpointGesture, MarqueeGesture, MoveGesture, PanGesture, PinchGesture, ResizeGesture, RotateGesture, TOUCH_SLOP_PX, TapPanGesture, WireGesture,
  type Mods,
} from './gestures';
import { HANDLE_PX, ROTATE_OFFSET_PX, TOUCH_HIT_PX, TOUCH_ROTATE_OFFSET_PX, type SelFrame } from './overlay';
import { WheelClassifier } from './wheel';
import { clampScale } from '../../../lib/canvas/camera';

/** Safari's pinch events (macOS trackpad, iPadOS): no `wheel`, no pointer events; `scale` is relative to the start. */
interface SafariGestureEvent extends UIEvent {
  scale: number;
  clientX: number;
  clientY: number;
}

const mods = (e: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): Mods => ({
  shift: e.shiftKey,
  alt: e.altKey,
  mod: e.ctrlKey || e.metaKey,
});

const NO_MODS: Mods = { shift: false, alt: false, mod: false };
/** Touch editing (ADR-0115 wave 5b): a press that stays put this long on empty canvas opens the phone's menu. */
const LONG_PRESS_MS = 500;
/** Two taps on one object within this long edit its text (the finger's double click). */
const DOUBLE_TAP_MS = 350;
/** How far (px) from an object a finger still picks it. */
const TOUCH_PICK_PX = 10;

/**
 * Wires pointer, wheel and keyboard events on the canvas element to engine commands (ADR-0114 §4).
 * Returns the detach function. Camera input (wheel, pinch, Safari gestures) is queued on the engine and
 * applied once per frame; nothing here owns a timer or a frame of its own.
 */
export function attachInput(engine: CanvasEngine, canvas: HTMLCanvasElement): () => void {
  const pointers = new Map<number, Point>();
  let spaceDown = false;
  let panDrag: { id: number } | null = null;
  let pinch: PinchGesture | null = null;
  /** Pointer ids the pinch measures (a third finger does not take part). */
  let pair: [number, number] = [0, 0];
  const wheelKind = new WheelClassifier();
  /** A Safari pinch in progress: the camera and world point at its start. */
  let gesture: { scale: number; wx: number; wy: number } | null = null;
  let cursor = '';
  /** Touch editing: the long press in progress (one at most) and the last tap, for the double tap. */
  let press: { id: number; timer: ReturnType<typeof setTimeout>; s: Point; w: Point; g: TapPanGesture } | null = null;
  let lastTap: { id: string; at: number } | null = null;

  const clearPress = (): void => {
    if (press) clearTimeout(press.timer);
    press = null;
  };

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
    if (rotateHandleAt(w)) return ROTATE_CURSOR;
    const g = resizeHandleAt(w);
    if (g) return resizeCursorAt(g, engine.selectionFrame()?.rot ?? 0);
    if (connectorEndAt(w)) return 'pointer';
    const over = engine.hitAt(w);
    return over ? (engine.votableAt(over.id) ? 'pointer' : 'move') : '';
  };

  /** The selection frame's rotation handle under the pointer. */
  const rotateHandleAt = (w: Point): boolean => {
    const f = engine.selectionFrame();
    if (!f || !f.rotate) return false;
    // The finger: the handle hangs further out and is hit from a 44 px zone.
    const off = engine.touch ? TOUCH_ROTATE_OFFSET_PX : ROTATE_OFFSET_PX;
    return dist(w, rotateHandlePoint(f.rect, f.rot, engine.px(off))) <= engine.px(engine.touch ? TOUCH_HIT_PX : HANDLE_PX + 2);
  };

  /** The hit radius (px) of the frame's resize handles under a finger: 22, less on a small object so its body stays reachable. */
  const touchRadius = (f: SelFrame): number => Math.min(TOUCH_HIT_PX, Math.max(12, Math.min(f.rect.w, f.rect.h) * engine.camera.scale * 0.35));

  /** A resize handle of the selection frame under the pointer (none on a locked or grouped selection). */
  const resizeHandleAt = (w: Point): HandleId | null => {
    const f = engine.selectionFrame();
    return f && f.resize ? hitHandleRot(f.rect, f.rot, w, engine.px(engine.touch ? touchRadius(f) : HANDLE_PX)) : null;
  };

  const connectorEndAt = (w: Point): 'from' | 'to' | null => {
    if (engine.selection.size !== 1) return null;
    const id = [...engine.selection][0];
    const c = id ? engine.scene.get(id) : undefined;
    if (!c || !isConnector(c) || c.points.length < 4) return null;
    const r = engine.px(engine.touch ? TOUCH_HIT_PX : HANDLE_PX);
    const a = { x: c.points[0] ?? 0, y: c.points[1] ?? 0 };
    const b = { x: c.points[c.points.length - 2] ?? 0, y: c.points[c.points.length - 1] ?? 0 };
    if (dist(w, b) <= r) return 'to';
    if (dist(w, a) <= r) return 'from';
    return null;
  };

  /** A finger on an editable canvas (the phone's edit mode): tap selects, drag moves what is selected, anything else pans. */
  const touchDown = (e: PointerEvent, s: Point, w: Point): void => {
    const tool = engine.tool;
    if (tool === 'sticky' || tool === 'text' || tool === 'shape') {
      // A tap places the object (a text opens its editor at once); a drag pans to where it should go.
      engine.activeGesture = new TapPanGesture(engine, s, () => new CreateGesture(engine, tool, w, s).end(w, s, NO_MODS));
      return;
    }
    if (tool === 'connector') {
      engine.activeGesture = new WireGesture(engine, w, s, TOUCH_SLOP_PX);
      return;
    }
    if (tool === 'comment') {
      // A tap places a pin; a drag pans.
      engine.activeGesture = new TapPanGesture(engine, s, () => engine.emitCommentAt(s, w));
      return;
    }
    if (rotateHandleAt(w)) {
      engine.activeGesture = new RotateGesture(engine, engine.selection, w);
      return;
    }
    const handle = resizeHandleAt(w);
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
    const multi = engine.multiSelect;
    const hit = engine.hitAt(w, TOUCH_PICK_PX);
    if (!hit) {
      // Empty place: a tap clears the selection, a drag pans, a press that stays put opens the menu.
      const g = new TapPanGesture(engine, s, () => engine.clearSelection());
      engine.activeGesture = g;
      press = {
        id: e.pointerId, s, w, g,
        timer: setTimeout(() => {
          const p = press;
          press = null;
          if (!p || engine.activeGesture !== p.g || p.g.panned) return;
          p.g.consume();
          engine.emitLongPress(p.s, p.w);
        }, LONG_PRESS_MS),
      };
      return;
    }
    // A tap takes the object's whole group; stepped into a group, just the member.
    const unit = engine.unitAt(hit.id);
    if (engine.selection.has(hit.id)) {
      // Selected: dragging it moves the selection; a tap narrows, edits (second tap) or — in «several» mode — takes it out.
      const ids = [...engine.selection];
      engine.activeGesture = new MoveGesture(engine, ids, w, s, () => {
        if (multi) {
          const next = new Set(engine.selection);
          for (const id of unit) next.delete(id);
          engine.setSelection(next);
          return;
        }
        const now = Date.now();
        if (lastTap && lastTap.id === hit.id && now - lastTap.at < DOUBLE_TAP_MS && !engine.votableAt(hit.id)) {
          lastTap = null;
          // As a double click: the first steps into a group, the next edits the text.
          if (engine.enterGroupAt(hit.id)) return;
          engine.setSelection([hit.id]);
          engine.startTextEdit(hit.id);
          return;
        }
        lastTap = { id: hit.id, at: now };
        if (ids.length > 1) engine.setSelection(unit);
        engine.voteClick(hit.id, w, false);
      }, TOUCH_SLOP_PX);
      return;
    }
    // Not selected: a tap selects (adds, in «several» mode), a drag pans — nothing moves by accident.
    engine.activeGesture = new TapPanGesture(engine, s, () => {
      if (multi) engine.setSelection([...engine.selection, ...unit]);
      else {
        engine.setSelection(unit);
        lastTap = { id: hit.id, at: Date.now() };
        engine.voteClick(hit.id, w, false);
      }
    });
  };

  const onDown = (e: PointerEvent): void => {
    canvas.focus({ preventScroll: true });
    engine.cancelAnimation();
    engine.flushCamera();
    clearPress();
    const { s, w } = local(e);
    if (e.isPrimary && pointers.size > 0) {
      // A new first finger while the old ones are still "down": their pointerup was lost (a system gesture,
      // the app went to the background). Forget them, or the next touch would pinch with a phantom finger.
      pointers.clear();
      pinch = null;
      panDrag = null;
      engine.activeGesture?.cancel();
      engine.activeGesture = null;
    }
    pointers.set(e.pointerId, s);
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic events have no active pointer to capture.
    }
    if (pointers.size === 2) {
      // Second finger: abort a plain gesture and pinch. A pan in progress is kept (cancelling it would
      // snap the view back to where the first finger touched down).
      const g = engine.activeGesture;
      if (g?.kind === 'pan') g.end(w, s, mods(e));
      else g?.cancel();
      engine.activeGesture = null;
      panDrag = null;
      const [ea, eb] = [...pointers.entries()];
      if (ea && eb) {
        pair = [ea[0], eb[0]];
        pinch = new PinchGesture(engine, ea[1], eb[1]);
      }
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
    if (engine.touch && !engine.readOnly) {
      touchDown(e, s, w);
      return;
    }
    switch (engine.tool) {
      case 'sticky':
      case 'text':
      case 'shape':
        engine.activeGesture = new CreateGesture(engine, engine.tool, w, s);
        return;
      case 'connector':
        engine.activeGesture = new WireGesture(engine, w, s);
        return;
      case 'comment':
        engine.emitCommentAt(s, w);
        return;
      case 'select':
        break;
    }
    // Select tool.
    if (rotateHandleAt(w)) {
      engine.activeGesture = new RotateGesture(engine, engine.selection, w);
      // The turn keeps its cursor while the pointer leaves the knob (moves do not touch it during a gesture).
      if (e.pointerType === 'mouse') setCursor(ROTATE_CURSOR);
      return;
    }
    const handle = resizeHandleAt(w);
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
      // A click takes the object's whole group; stepped into a group, just the member.
      const unit = engine.unitAt(hit.id);
      const wasSelected = engine.selection.has(hit.id);
      if (m.shift) {
        const next = new Set(engine.selection);
        if (wasSelected) for (const id of unit) next.delete(id);
        else for (const id of unit) next.add(id);
        engine.setSelection(next);
        if (wasSelected) return;
      } else if (!wasSelected) engine.setSelection(unit);
      const ids = [...engine.selection];
      engine.activeGesture = new MoveGesture(engine, ids, w, s, () => {
        // A click on an already selected member of a multi-selection narrows to it (to its group, if it has one).
        if (!m.shift && wasSelected && ids.length > 1) engine.setSelection(unit);
        // Voting open: a plain click on a sticky or shape is a vote (Alt or its own badge takes one back).
        if (!m.shift && !m.mod) engine.voteClick(hit.id, w, m.alt);
      });
      return;
    }
    engine.activeGesture = new MarqueeGesture(engine, w, m.shift);
  };

  const onMove = (e: PointerEvent): void => {
    const { s, w } = local(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, s);
    if (press && press.id === e.pointerId && Math.hypot(s.x - press.s.x, s.y - press.s.y) > TOUCH_SLOP_PX) clearPress();
    if (pinch) {
      const a = pointers.get(pair[0]);
      const b = pointers.get(pair[1]);
      if (a && b && (e.pointerId === pair[0] || e.pointerId === pair[1])) pinch.update(a, b);
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
    clearPress();
    const { s, w } = local(e);
    pointers.delete(e.pointerId);
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      // Already released.
    }
    if (pinch) {
      if (e.pointerId !== pair[0] && e.pointerId !== pair[1]) return;
      const [ea, eb] = [...pointers.entries()];
      if (ea && eb && !cancelled) {
        // A third finger takes the place of the one that left: measure from the new pair, no jump.
        pair = [ea[0], eb[0]];
        pinch.rebase(ea[1], eb[1]);
        return;
      }
      pinch.end();
      pinch = null;
      // One finger stays down after a pinch: it carries on as a pan, as in any map.
      if (ea && !cancelled) {
        engine.activeGesture = new PanGesture(engine, ea[1]);
        panDrag = { id: ea[0] };
      } else pointers.clear();
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
      // While voting a double-click is two votes, not a text edit.
      if (engine.votableAt(hit.id)) return;
      // First double-click on a group member steps into the group; the next edits the text.
      if (engine.enterGroupAt(hit.id)) return;
      engine.setSelection([hit.id]);
      engine.startTextEdit(hit.id);
    } else engine.createTextAt(w);
  };

  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    // Safari reports a trackpad pinch as gesture events; a ctrl+wheel in the middle of one is not a second zoom.
    if (gesture && e.ctrlKey) return;
    const { s } = local(e);
    const a = wheelKind.classify(e, canvas.clientHeight);
    if (a.kind === 'zoom') engine.steerZoom(a.factor, s);
    else engine.steerPan(a.dx, a.dy);
  };

  // Safari (macOS trackpad, iPadOS): the browser would zoom the page, so the events are always consumed.
  // On a touch screen they fire next to the pointer events (which already drive the pinch): ignored there.
  const onGestureStart = (ev: Event): void => {
    ev.preventDefault();
    gesture = null;
    if (pinch || pointers.size >= 2) return;
    const e = ev as SafariGestureEvent;
    const { s } = local(e);
    const c = engine.liveCamera;
    gesture = { scale: c.scale, wx: (s.x - c.tx) / c.scale, wy: (s.y - c.ty) / c.scale };
  };

  const onGestureChange = (ev: Event): void => {
    ev.preventDefault();
    if (!gesture || pinch || pointers.size >= 2) return;
    const e = ev as SafariGestureEvent;
    if (!(e.scale > 0)) return;
    const { s } = local(e);
    // The world point that was under the fingers at the start follows them: zoom and pan in one gesture.
    const scale = clampScale(gesture.scale * e.scale);
    engine.steerCamera({ scale, tx: s.x - gesture.wx * scale, ty: s.y - gesture.wy * scale });
  };

  const onGestureEnd = (ev: Event): void => {
    ev.preventDefault();
    if (!gesture) return;
    gesture = null;
    engine.flushCamera();
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
      } else if (engine.exitGroup()) {
        // Left the group stepped into; it stays selected as a whole.
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
        case k === 'g': if (e.shiftKey) engine.ungroupSelection(); else engine.groupSelection(); break;
        case k === 'l' && e.shiftKey: engine.toggleLock(); break;
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
    if (e.altKey && !e.shiftKey && e.code === 'KeyC') {
      // ⌥C: the «Комментарий» tool (ADR-0115 wave 4) on and off; by the physical key (⌥C types «ç» on a Mac).
      if (engine.readOnly) return;
      engine.setTool(engine.tool === 'comment' ? 'select' : 'comment');
    } else if (e.shiftKey && e.code === 'Digit1') {
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
  canvas.addEventListener('gesturestart', onGestureStart);
  canvas.addEventListener('gesturechange', onGestureChange);
  canvas.addEventListener('gestureend', onGestureEnd);
  canvas.addEventListener('keydown', onKeyDown);
  canvas.addEventListener('keyup', onKeyUp);
  canvas.addEventListener('blur', onBlur);
  return () => {
    clearPress();
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onCancel);
    canvas.removeEventListener('pointerleave', onLeave);
    canvas.removeEventListener('dblclick', onDouble);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('gesturestart', onGestureStart);
    canvas.removeEventListener('gesturechange', onGestureChange);
    canvas.removeEventListener('gestureend', onGestureEnd);
    canvas.removeEventListener('keydown', onKeyDown);
    canvas.removeEventListener('keyup', onKeyUp);
    canvas.removeEventListener('blur', onBlur);
  };
}
