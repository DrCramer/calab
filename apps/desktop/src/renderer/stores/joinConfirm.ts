import type { CalendarEvent } from '@calaba/protocol';
import { create } from 'zustand';

/** The meeting whose room a notification click asked to join; the dialog (features/calendar/JoinConfirm) shows it. */
interface JoinConfirmState {
  ev: CalendarEvent | null;
  ask: (ev: CalendarEvent) => void;
  close: () => void;
}

export const useJoinConfirm = create<JoinConfirmState>()((set) => ({
  ev: null,
  ask: (ev) => set({ ev }),
  close: () => set({ ev: null }),
}));
