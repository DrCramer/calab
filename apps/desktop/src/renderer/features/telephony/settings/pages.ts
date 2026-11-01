import { Archive, CircleDot, Clock, Hash, ListTree, PhoneIncoming, Plug, Users, type LucideIcon } from 'lucide-react';
import { create } from 'zustand';
import type { MessageKey } from '../../../i18n';
import { pushOnTab, pushScreen } from '../../../lib/phoneNav';
import { useTelephonyUi } from '../../../stores/telephonyUi';
import { useUi } from '../../../stores/ui';
import { openSection } from '../../shell/sectionNav';

/*
 * The station's settings inside «Телефония» (ADR-0137 §5, T5; MANAGE_INTEGRATIONS): the pages of
 * the «Настройки» group in the desktop column and the rows of the phone's drill-down list, in the
 * order of the ADR's table. The desktop remembers the open page here; the phone keeps it in its
 * stack (lib/phoneNav `telSettings`).
 */

export type SetPage = 'connection' | 'inbound' | 'schedule' | 'numbers' | 'groups' | 'ivr' | 'recording' | 'policy';

export interface SetPageDef {
  id: SetPage;
  label: MessageKey;
  icon: LucideIcon;
}

export const SET_PAGES: readonly SetPageDef[] = [
  { id: 'connection', label: 'tset.page.connection', icon: Plug },
  { id: 'inbound', label: 'tset.page.inbound', icon: PhoneIncoming },
  { id: 'schedule', label: 'tset.page.schedule', icon: Clock },
  { id: 'numbers', label: 'tset.page.numbers', icon: Hash },
  { id: 'groups', label: 'tset.page.groups', icon: Users },
  { id: 'ivr', label: 'tset.page.ivr', icon: ListTree },
  { id: 'recording', label: 'tset.page.recording', icon: CircleDot },
  { id: 'policy', label: 'tset.page.policy', icon: Archive },
];

export const isSetPage = (v: string): v is SetPage => SET_PAGES.some((p) => p.id === v);

interface TelSettingsUi {
  page: SetPage;
  setPage: (p: SetPage) => void;
}

/** The desktop's open settings page (not persisted: the section opens on «Недавние» next time). */
export const useTelSettingsUi = create<TelSettingsUi>((set) => ({
  page: 'connection',
  setPage: (page) => set((s) => (s.page === page ? s : { page })),
}));

/** Phone: pushes a settings screen ('list', a page, or a form 'ext:<id>' / 'group:<id>' / 'menu:<id>'). */
export function pushTelSettings(page: string): void {
  useUi.getState().setPhone((n) => pushScreen(n, { kind: 'telSettings', page }));
}

/** Phone: the top settings screen becomes another (a new menu saved → its own form), back goes where it went. */
export function replaceTelSettings(page: string): void {
  useUi.getState().setPhone((n) => {
    const top = n.stack.at(-1);
    return top?.kind === 'telSettings' ? { ...n, stack: [...n.stack.slice(0, -1), { kind: 'telSettings', page }] } : pushScreen(n, { kind: 'telSettings', page });
  });
}

/**
 * Opens a settings page of «Телефония» in the open workspace from anywhere (a plan violation's
 * «Исправить», an old deep link): the desktop switches the section to it, the phone pushes the
 * page over the section's root.
 */
export function openTelephonySettings(page: SetPage = 'connection'): void {
  const ui = useUi.getState();
  if (ui.phone.on) {
    ui.setPhone((n) => pushOnTab(n, 'telephony', { kind: 'telSettings', page }));
    return;
  }
  useTelSettingsUi.getState().setPage(page);
  useTelephonyUi.getState().setPage('settings');
  openSection('telephony');
}
