import { BookUser, Grid3x3, History, Settings, type LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';
import { t } from '../../i18n';
import type { TelPage } from '../../stores/telephonyUi';
import { ContactsPage } from './contacts/ContactsPage';
import { DialPage } from './keypad/DialPage';

/**
 * The pages of «Телефония» (ADR-0137 §6): the column's navigation on the desktop. One registry so
 * the next stages only add entries — «Контакты» and «Набор» (T4), the station's settings under
 * «Настройки» for MANAGE_INTEGRATIONS (T5).
 */
export interface TelPageDef {
  id: TelPage;
  label: () => string;
  icon: LucideIcon;
  /** The red count of my missed calls next to it («Недавние»). */
  missedBadge?: boolean;
  /** MANAGE_INTEGRATIONS only; the column shows it as the «Настройки» group of its pages (settings/pages.ts). */
  manage?: boolean;
  /** The page's centre (and its right panel); none = «Недавние» with the call's detail. */
  Center?: ComponentType<{ workspaceId: string; floating: boolean }>;
}

export const TEL_PAGES: readonly TelPageDef[] = [
  { id: 'recents', label: () => t('tel.recents'), icon: History, missedBadge: true },
  // T4 (ADR-0137 §6): the phone book and the dial pad.
  { id: 'contacts', label: () => t('telc.contacts'), icon: BookUser, Center: ContactsPage },
  { id: 'dial', label: () => t('telc.dial'), icon: Grid3x3, Center: DialPage },
  { id: 'settings', label: () => t('tset.title'), icon: Settings, manage: true },
];
