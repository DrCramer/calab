import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * «Телефония → Контакты» and «Набор» UI state (ADR-0137 §6–§7): the search, the contact whose card
 * is open on the desktop (the right panel), the form (a Modal on the desktop; on the phone the edit
 * screen reads its prefill here), the import dialog and the number the dial pad opens with. The
 * phone book itself is react-query data (features/telephony/contacts/data.ts).
 */
export interface ContactPrefill {
  number?: string;
  name?: string;
}

interface TelContactsState {
  q: string;
  setQ: (q: string) => void;
  /** Desktop: the contact whose card is in the right panel. */
  selected: string | null;
  select: (id: string | null) => void;
  /** Desktop: the form ('' = a new contact); phone: the prefill of the edit screen. */
  form: { id: string; prefill?: ContactPrefill } | null;
  openForm: (f: { id: string; prefill?: ContactPrefill } | null) => void;
  importOpen: boolean;
  setImport: (open: boolean) => void;
  /** What the dial pad shows when it opens (a «Набрать +7 …» from an empty search); taken once. */
  dialPrefill: string;
  setDialPrefill: (n: string) => void;
  /** Phone: rows swiped open now (the FAB «Набор» steps aside so it never covers their actions). */
  swipeOpen: number;
}

export const useTelContacts = create<TelContactsState>()((set) => ({
  q: '',
  setQ: (q) => set((s) => (s.q === q ? s : { q })),
  selected: null,
  select: (selected) => set((s) => (s.selected === selected ? s : { selected })),
  form: null,
  openForm: (form) => set({ form }),
  importOpen: false,
  setImport: (importOpen) => set({ importOpen }),
  dialPrefill: '',
  setDialPrefill: (dialPrefill) => set({ dialPrefill }),
  swipeOpen: 0,
}));

/** A phone row of «Телефония» swiped open (`open`) or closed: counted while it is open. */
export function useSwipeOpenMark(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    useTelContacts.setState((s) => ({ swipeOpen: s.swipeOpen + 1 }));
    return () => useTelContacts.setState((s) => ({ swipeOpen: Math.max(0, s.swipeOpen - 1) }));
  }, [open]);
}

/** The dial pad's opening number, once. */
export function takeDialPrefill(): string {
  const n = useTelContacts.getState().dialPrefill;
  if (n) useTelContacts.getState().setDialPrefill('');
  return n;
}
