import * as Dropdown from '../../../components/radix/dropdown-menu';
import { Download, Ellipsis, Upload, UserRoundPlus } from 'lucide-react';
import type { ReactNode } from 'react';
import { Bar } from '../../../components/Bar';
import { Button, IconButton, cx } from '../../../components/ui';
import { t, useLocale } from '../../../i18n';
import { useTelContacts } from '../../../stores/telContacts';
import { menuBox, menuItem } from '../../shell/menu';
import { useMayManageTelephony } from '../access';
import { ContactPanel } from './ContactCard';
import { ContactSearch, ContactsList } from './ContactsList';
import { editContact, exportContacts } from './data';

/**
 * «Контакты» on the desktop (ADR-0137 §6): the bar (search, «Новый контакт», import / export for
 * MANAGE_INTEGRATIONS) over the list; the card in the right panel (a column from 1200 px, a
 * floating panel below — the rule of the call detail).
 */
export function ContactsPage({ workspaceId, floating }: { workspaceId: string; floating: boolean }): ReactNode {
  useLocale();
  const manage = useMayManageTelephony(workspaceId);
  return (
    <>
      <section className="flex min-w-0 flex-1 flex-col" aria-label={t('telc.contacts')} data-testid="telc-page">
        <Bar className="gap-2 pr-3">
          <ContactSearch phone={false} className="w-[320px] min-w-0 shrink pl-3" />
          <span className="min-w-0 flex-1" />
          <Button variant="secondary" onClick={() => editContact('')} data-testid="telc-new">
            <UserRoundPlus className="size-3.5" aria-hidden /> {t('telc.add')}
          </Button>
          {manage ? (
            <Dropdown.Root modal={false}>
              <Dropdown.Trigger asChild>
                <IconButton label={t('telc.more')} className="data-[state=open]:bg-hover" data-testid="telc-more">
                  <Ellipsis className="size-4" aria-hidden />
                </IconButton>
              </Dropdown.Trigger>
              <Dropdown.Portal>
                <Dropdown.Content className={cx(menuBox, 'w-56')} align="end" sideOffset={6} collisionPadding={16}>
                  <Dropdown.Item className={menuItem} onSelect={() => useTelContacts.getState().setImport(true)} data-testid="telc-import-open">
                    <Upload className="size-4" aria-hidden /> {t('telc.import')}
                  </Dropdown.Item>
                  <Dropdown.Item className={menuItem} onSelect={() => void exportContacts(workspaceId)} data-testid="telc-export">
                    <Download className="size-4" aria-hidden /> {t('telc.export')}
                  </Dropdown.Item>
                </Dropdown.Content>
              </Dropdown.Portal>
            </Dropdown.Root>
          ) : null}
        </Bar>
        <ContactsList ws={workspaceId} phone={false} />
      </section>
      <ContactPanel ws={workspaceId} floating={floating} />
    </>
  );
}
