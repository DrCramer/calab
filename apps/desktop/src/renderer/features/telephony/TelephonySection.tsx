import { memo, useEffect, type ReactNode } from 'react';
import { ResizeHandle } from '../../components/ResizeHandle';
import { CountBadge, cx } from '../../components/ui';
import { plural, t, useLocale } from '../../i18n';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { useSipJournal } from '../../stores/sipJournal';
import { useTelephonyUi, type TelPage } from '../../stores/telephonyUi';
import { MEMBERS_COLUMN_MIN, useUi } from '../../stores/ui';
import { ColumnHeader, ColumnTitle, ROW_HOVER, ROW_SELECTED } from '../shell/ColumnHeader';
import { showMode } from '../shell/sectionNav';
import { useMayManageTelephony, useTelephonyConnected, useTelephonyVisible } from './access';
import { CallDetailPanel } from './CallDetail';
import { TEL_PAGES, type TelPageDef } from './pages';
import { Recents } from './Recents';
import { TelSettingsNav, TelSettingsPage } from './settings/SettingsSection';
import { CreateButton } from '../../components/CreateButton';
import { ContactFormModal } from './contacts/ContactForm';
import { editContact } from './contacts/data';
import { ImportDialog } from './contacts/ImportDialog';

/**
 * «Телефония» on the desktop (ADR-0137 §5–§6): the column with the section's pages (pages.ts) —
 * «Недавние» with my missed count, «Контакты», «Набор» — the page in the centre and its detail
 * (the call's, the contact's card) on the right (a column from 1200 px, a floating panel over the
 * list below); for MANAGE_INTEGRATIONS the «Настройки» group of the station's pages (settings/,
 * T5) — before telephony is connected the section is only that, opened on «Подключение». Mounted only while the section is
 * open: a hidden section holds no list, no subscriptions and no timers. When the section stops
 * being mine (telephony off, a right taken away) it gives way to «Команда».
 */
export function TelephonySection({ workspaceId }: { workspaceId: string }): ReactNode {
  const visible = useTelephonyVisible(workspaceId);
  useEffect(() => {
    if (!visible) showMode('voice');
  }, [visible]);
  const connected = useTelephonyConnected(workspaceId);
  const manage = useMayManageTelephony(workspaceId);
  // A page this build does not have yet shows «Недавние»; the settings — MANAGE_INTEGRATIONS only;
  // nothing connected yet — only the settings.
  const chosen = useTelephonyUi((s) => (TEL_PAGES.some((p) => p.id === s.page) ? s.page : 'recents'));
  const page: TelPage = !connected ? 'settings' : chosen === 'settings' && !manage ? 'recents' : chosen;
  const wide = useMediaQuery(`(min-width: ${MEMBERS_COLUMN_MIN}px)`);
  if (!visible) return null;
  return (
    <>
      <TelNav workspaceId={workspaceId} page={page} connected={connected} manage={manage} />
      <ResizeHandle width={() => useUi.getState().sidebarWidth} min={200} max={320} label={t('shell.resize')} onChange={(w) => useUi.getState().setSidebarWidth(w)} />
      <div className="mat-content relative flex min-w-0 flex-1" data-testid="telephony">
        {page === 'settings' ? <TelSettingsPage workspaceId={workspaceId} /> : <PageCenter page={page} workspaceId={workspaceId} floating={!wide} />}
      </div>
      {/* T4: the contact form and the CSV import (Modals over the section). */}
      <ContactFormModal ws={workspaceId} />
      <ImportDialog ws={workspaceId} />
    </>
  );
}

/** The page's centre: its own (pages.ts `Center`), else «Недавние» with the call's detail. */
function PageCenter({ page, workspaceId, floating }: { page: TelPage; workspaceId: string; floating: boolean }): ReactNode {
  const Center = TEL_PAGES.find((p) => p.id === page)?.Center;
  if (Center) return <Center workspaceId={workspaceId} floating={floating} />;
  return (
    <>
      <Recents workspaceId={workspaceId} />
      <CallDetailPanel ws={workspaceId} floating={floating} />
    </>
  );
}

function TelNav({ workspaceId, page, connected, manage }: { workspaceId: string; page: TelPage; connected: boolean; manage: boolean }): ReactNode {
  useLocale();
  return (
    <aside className="island-fade mat-sidebar mat-sidebar-window flex w-[var(--sidebar-width)] shrink-0 flex-col" aria-label={t('tel.section')} data-testid="tel-nav">
      <ColumnHeader title={<ColumnTitle>{t('tel.section')}</ColumnTitle>}>
        {/* «+» of the section: a new contact (ADR-0137 §6). */}
        {connected ? <CreateButton label={t('telc.newTitle')} onClick={() => editContact('')} data-testid="tel-create" /> : null}
      </ColumnHeader>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pt-1" style={{ paddingBottom: 'calc(var(--island-height, 0px) + 20px)' }} aria-label={t('tel.nav')}>
        <ul className="flex flex-col gap-px">
          {TEL_PAGES.map((p) =>
            p.manage ? (
              manage ? <TelSettingsNav key={p.id} workspaceId={workspaceId} active={p.id === page} /> : null
            ) : connected ? (
              <NavRow key={p.id} def={p} workspaceId={workspaceId} active={p.id === page} />
            ) : null,
          )}
        </ul>
      </nav>
    </aside>
  );
}

/** A page of the column: 36 px like a room row (icon 18 + text 15), the missed count on «Недавние». */
const NavRow = memo(function NavRow({ def, workspaceId, active }: { def: TelPageDef; workspaceId: string; active: boolean }): ReactNode {
  const missed = useSipJournal((s) => (def.missedBadge ? (s.missed[workspaceId] ?? 0) : 0));
  const Icon = def.icon;
  const label = def.label();
  return (
    <li>
      <button
        type="button"
        onClick={() => useTelephonyUi.getState().setPage(def.id)}
        aria-current={active ? 'page' : undefined}
        aria-label={missed ? `${label}, ${plural('tel.missedCount', missed)}` : label}
        className={cx('flex h-9 w-full min-w-0 items-center gap-2 rounded-[8px] pl-2 pr-1.5 text-left text-list', active ? cx(ROW_SELECTED, 'font-medium text-fg') : cx(ROW_HOVER, 'text-fg'))}
        data-testid={`tel-nav-${def.id}`}
      >
        <Icon className={cx('size-[18px] shrink-0', active ? 'text-fg' : 'text-muted')} strokeWidth={1.75} aria-hidden />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {missed ? <CountBadge count={missed} aria-hidden /> : null}
      </button>
    </li>
  );
});
