import { create } from 'zustand';
import { idAfter } from './rooms';

/**
 * Read receipts (docs/09 #92, ADR-0140): per room, how far the others saw — in a DM the peer, in
 * a workspace or task room the furthest other member (READY.peer_reads, DmSummary.peer_read_message_id,
 * ListMessagesResponse.peer_read_message_id, READ_RECEIPT). Apart from stores/rooms.ts so a receipt
 * wakes only the ticks it flips (`useReadReceipt` selects a number per message), not room lists
 * or the feed. `from` (READY.read_receipts_from): own messages before it get no ticks at all.
 */
interface ReadReceiptsState {
  byRoom: Record<string, string>;
  from: string;
  /** Keeps the maximum (uuidv7 ids order like messages): a stale event never un-reads. */
  set: (roomId: string, messageId: string) => void;
  setFrom: (from: string) => void;
  reset: () => void;
}

export const useReadReceipts = create<ReadReceiptsState>()((set) => ({
  byRoom: {},
  from: '',
  set: (roomId, messageId) => set((s) => (idAfter(messageId, s.byRoom[roomId]) ? { byRoom: { ...s.byRoom, [roomId]: messageId } } : s)),
  setFrom: (from) => set((s) => (s.from === from ? s : { from })),
  reset: () => set({ byRoom: {}, from: '' }),
}));

/** What the ticks of an own message show: none (before receipts started), ✓ sent, ✓✓ read. */
export const TICKS_NONE = 0;
export const TICKS_SENT = 1;
export const TICKS_READ = 2;
export type TickState = typeof TICKS_NONE | typeof TICKS_SENT | typeof TICKS_READ;

/** Pure: the tick state of `messageId` given the others' marker `upTo` and the start `from`. */
export function tickState(messageId: string, upTo: string | undefined, from: string): TickState {
  if (from && messageId < from) return TICKS_NONE;
  return upTo !== undefined && !idAfter(messageId, upTo) ? TICKS_READ : TICKS_SENT;
}

/** The ticks of `messageId` of `roomId` (a leaf subscription: a number). */
export const useReadReceipt = (roomId: string, messageId: string): TickState =>
  useReadReceipts((s) => tickState(messageId, s.byRoom[roomId], s.from));
