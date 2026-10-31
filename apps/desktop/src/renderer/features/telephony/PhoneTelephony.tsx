import { Grid3x3, Phone, Settings } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Bar } from '../../components/Bar';
import { CreateButton } from '../../components/CreateButton';
import { HeaderIcon } from '../../components/PhoneHeader';
import { IconButton, Segmented } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { openTab } from '../../services/phoneNav';
import { usePersonalCallOn } from '../../stores/sipOutbound';
import { useTelContacts } from '../../stores/telContacts';
import { useTelephonyUi } from '../../stores/telephonyUi';
import { useVoice } from '../../stores/voice';
import { useHasExtensions, useMayManageTelephony, usePlaceCalls, useTelephonyConnected, useTelephonyVisible } from './access';
import { ContactSearch, ContactsList } from './contacts/ContactsList';
import { editContact, openDial } from './contacts/data';
import { ImportDialog } from './contacts/ImportDialog';
import { JournalList } from './Recents';
import { FilterButton, FilterCard, FilterChips, SearchField, setFilter } from './RecentsFilters';
import { NotConnected } from './settings/Connection';
import { pushTelSettings } from './settings/pages';

/**
 * «Телефония» on the phone (ADR-0137 §7 — the owner's priority: one hand, actions at the thumb,
 * the iPhone «Телефон» patterns): the tab root — the title with «＋» (a new contact), the segments
 * «Недавние | Пропущенные | Контакты», the list with its search pill that scrolls away with it (as
 * iOS Contacts; the journal's funnel at its right end → a centred card, the set filters as chips),
 * and the FAB «Набор» at the thumb over the list. A journal row's tap calls back; ⓘ opens the
 * detail (a pushed screen); a contact's tap opens its card.
 * ⚙ in the header (MANAGE_INTEGRATIONS) pushes the station's settings list (T5); before telephony
 * is connected the root is the empty state «Подключите SIP-провайдера» with its one action.
 */
type PhoneSegment = 'all' | 'missed' | 'contacts';

export function PhoneTelephony({ workspaceId }: { workspaceId: string }): ReactNode {
  useLocale();
  const visible = useTelephonyVisible(workspaceId);
  useEffect(() => {
    // The section went away (telephony off, a right taken): back to «Команда».
    if (!visible) openTab('chats');
  }, [visible]);
  // «Контакты» is the section's contacts page (stores/telephonyUi `page`); the other two are the journal's segment.
  const segment = useTelephonyUi((s): PhoneSegment => (s.page === 'contacts' ? 'contacts' : s.filter.segment));
  const [filters, setFilters] = useState(false);
  const manage = useMayManageTelephony(workspaceId);
  const connected = useTelephonyConnected(workspaceId);
  if (!visible) return null;
  const pick = (v: PhoneSegment): void => {
    if (v === 'contacts') {
      useTelephonyUi.getState().setPage('contacts');
      return;
    }
    useTelephonyUi.getState().setPage('recents');
    setFilter({ segment: v });
  };
  const header = (
    <Bar>
      <HeaderIcon icon={Phone} />
      <h1 className="min-w-0 flex-1 truncate text-headline font-semibold">{t('tel.section')}</h1>
      {manage ? (
        <IconButton tip={false} label={t('tset.title')} onClick={() => pushTelSettings('list')} bar data-testid="tel-settings-open">
          <Settings className="size-5" aria-hidden />
        </IconButton>
      ) : null}
      {connected ? <CreateButton label={t('telc.newTitle')} tip={false} onClick={() => editContact('')} data-testid="tel-create" /> : null}
    </Bar>
  );
  if (!connected) {
    return (
      <section className="mat-content flex min-h-0 flex-1 flex-col" data-testid="phone-telephony">
        {header}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <NotConnected onStart={() => pushTelSettings('connection')} />
        </div>
      </section>
    );
  }
  return (
    <section className="mat-content relative flex min-h-0 flex-1 flex-col" data-testid="phone-telephony">
      {header}
      <div className="shrink-0 px-3 pb-2 pt-1">
        <Segmented
          value={segment}
          onChange={pick}
          label={t('tel.seg.label')}
          fill
          options={[
            { value: 'all', label: t('tel.seg.recents') },
            { value: 'missed', label: t('tel.seg.missed') },
            { value: 'contacts', label: t('telc.contacts') },
          ]}
          testId="tel-segment"
        />
      </div>
      {segment === 'contacts' ? (
        <ContactsList ws={workspaceId} phone header={<ContactsHeader />} />
      ) : (
        <JournalList ws={workspaceId} phone header={<ListHeader ws={workspaceId} onFilters={() => setFilters(true)} />} />
      )}
      <DialFab ws={workspaceId} />
      <FilterCard ws={workspaceId} open={filters} onClose={() => setFilters(false)} />
      <ImportDialog ws={workspaceId} />
    </section>
  );
}

/** The search pill with the funnel and, under it, the chips of the set filters (it scrolls with the list). */
function ListHeader({ ws, onFilters }: { ws: string; onFilters: () => void }): ReactNode {
  return (
    <div className="pt-1">
      <div className="px-3 pb-2">
        <SearchField phone trailing={<FilterButton onOpen={onFilters} />} />
      </div>
      <FilterChips ws={ws} />
    </div>
  );
}

function ContactsHeader(): ReactNode {
  return (
    <div className="px-3 pb-2 pt-1">
      <ContactSearch phone />
    </div>
  );
}

/**
 * FAB «Набор» (ADR-0137 §7): a 56 px accent circle at the thumb, 16 px from the edge and above the
 * tab bar; hidden in a call (the call band is down there, a second call does not start from it)
 * and without PLACE_CALLS and internal numbers to dial.
 */
function DialFab({ ws }: { ws: string }): ReactNode {
  const place = usePlaceCalls(ws);
  const exts = useHasExtensions(ws);
  const inCall = useVoice((s) => s.roomId !== null);
  const personal = usePersonalCallOn();
  // A row swiped open under it: the FAB steps aside so its actions stay reachable.
  const swiped = useTelContacts((s) => s.swipeOpen > 0);
  if ((!place && !exts) || inCall || personal || swiped) return null;
  return (
    <button
      type="button"
      onClick={() => openDial()}
      aria-label={t('telc.dial')}
      className="absolute bottom-4 right-4 z-[2] grid size-14 place-items-center rounded-full bg-accent-strong text-accent-fg shadow-[var(--shadow-island)] transition-[filter] duration-[var(--motion-fast)] active:brightness-90"
      data-testid="tel-fab"
    >
      <Grid3x3 className="size-6" aria-hidden />
    </button>
  );
}
