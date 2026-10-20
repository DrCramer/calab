import { create } from 'zustand';
import type { Range } from '../../lib/calendar/drag';

/**
 * The day view's drag in progress (owner, 29.09: d&d like Apple Calendar). A leaf store: only the
 * ghost, the dragged block's «lifted» flag, the all-day row's and the mini calendar's drop
 * highlights read it — every pointer move writes it, the calendar store is written once on drop.
 */
export interface DragState {
  /** The occurrence dragged (move / resize), null for a range selected on the empty grid. */
  key: string | null;
  mode: 'move' | 'resize' | 'create' | null;
  /** Minutes of the day under the pointer (snapped); null while over the all-day row or elsewhere. */
  range: Range | null;
  /** Over the all-day row: the meeting becomes all-day. */
  allDay: boolean;
  /**
   * The day the range / the all-day drop is on: the day view's own day, in the week view the
   * column under the pointer (its ghost draws there). Null elsewhere.
   */
  day: string | null;
  /** Over a day of the mini calendar: the meeting moves to that day (same time). */
  overDay: string | null;
  /** A meeting I may not change: the cursor says no, nothing moves. */
  locked: boolean;
  set: (patch: Partial<Omit<DragState, 'set' | 'clear'>>) => void;
  clear: () => void;
}

const IDLE = { key: null, mode: null, range: null, allDay: false, day: null, overDay: null, locked: false } as const;

export const useDayDrag = create<DragState>()((set) => ({
  ...IDLE,
  set: (patch) => set(patch),
  clear: () => set(IDLE),
}));

/**
 * Drag payloads from elsewhere (owner addendum): a member (members panel) onto the dialog's
 * attendees or the meeting card, a voice room (room list) onto the dialog's room field or the card.
 * HTML5 drag data types; the room list's own reordering (dnd-kit) hands a room over through
 * `dropRoomAt` instead (services: its drag ends outside the list).
 */
export const DRAG_USER = 'application/x-calab-user';
export const DRAG_ROOM = 'application/x-calab-room';

/** What a native drag carries, if it is one of ours. */
export function dragPayload(dt: DataTransfer | null): { userId?: string; roomId?: string } | null {
  if (!dt) return null;
  const types = [...dt.types];
  if (types.includes(DRAG_USER)) return { userId: dt.getData(DRAG_USER) };
  if (types.includes(DRAG_ROOM)) return { roomId: dt.getData(DRAG_ROOM) };
  return null;
}

/** During dragover the data is hidden: only the types tell what it is. */
export function dragKind(dt: DataTransfer | null): 'user' | 'room' | null {
  const types = dt ? [...dt.types] : [];
  return types.includes(DRAG_USER) ? 'user' : types.includes(DRAG_ROOM) ? 'room' : null;
}

/**
 * A room row dragged by the list's reordering (dnd-kit, no native drag) and released over a room
 * drop target (`[data-drop-room]`): the target gets a `calab-drop-room` event with the room id.
 */
export function dropRoomAt(x: number, y: number, roomId: string): boolean {
  const el = roomTargetAt(x, y);
  useRoomDropHover.setState({ el: null });
  if (!el) return false;
  el.dispatchEvent(new CustomEvent('calab-drop-room', { detail: roomId, bubbles: false }));
  return true;
}

/** The room drop target under a point. elementsFromPoint: the drag chip (DragOverlay) may be the topmost element there. */
function roomTargetAt(x: number, y: number): HTMLElement | null {
  return (
    document
      .elementsFromPoint(x, y)
      .map((n) => n.closest<HTMLElement>('[data-drop-room]'))
      .find((n): n is HTMLElement => !!n) ?? null
  );
}

/**
 * The room drop target the room list's drag is over (a leaf store): the target highlights itself
 * like under a native drag, and the list hides its insertion line — the drop goes to the target.
 */
export const useRoomDropHover = create<{ el: HTMLElement | null }>()(() => ({ el: null }));

/** While the room list drags a voice room: marks the drop target under the pointer (null = none). Returns whether there is one. */
export function hoverRoomAt(x: number | null, y = 0): boolean {
  const el = x === null ? null : roomTargetAt(x, y);
  if (useRoomDropHover.getState().el !== el) useRoomDropHover.setState({ el });
  return !!el;
}
