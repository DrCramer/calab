import type { SipContact, SipContactPhone } from '@calaba/protocol';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { t } from '../../../i18n';
import { ApiError } from '../../../lib/api/client';
import { describeError } from '../../../lib/api/errors';
import { api } from '../../../lib/api/endpoints';
import { pushOnTab } from '../../../lib/phoneNav';
import { queryClient } from '../../../lib/queryClient';
import { formatPhone } from '../../../lib/sip';
import { copyText } from '../../../services/boards';
import { placePersonalCall } from '../../../services/sipOutbound';
import { useTelContacts, type ContactPrefill } from '../../../stores/telContacts';
import { useTelephonyUi } from '../../../stores/telephonyUi';
import { toast } from '../../../stores/toasts';
import { useUi } from '../../../stores/ui';

/**
 * The phone book's data (ADR-0137 §2): react-query pages of GET …/sip/contacts (200 a page, read
 * when the list opens and after my own changes — no gateway events), one contact with its last
 * calls, the writes, and where a contact / the form / the dial pad open (the desktop's panels or
 * the phone's pushed screens).
 */

export const contactsKey = (ws: string): readonly unknown[] => ['sipContacts', ws];
export const contactKey = (ws: string, id: string): readonly unknown[] => ['sipContact', ws, id];

const NO_CONTACTS: SipContact[] = [];

/** The list for a search (`q`: a part of a name / company, or digits), page by page. */
export function useContactList(ws: string, q: string): {
  contacts: SipContact[];
  status: 'loading' | 'error' | 'ready';
  more: boolean;
  loadMore: () => void;
  retry: () => void;
} {
  const query = useInfiniteQuery({
    queryKey: [...contactsKey(ws), q],
    queryFn: ({ pageParam, signal }) => api.sip.contacts(ws, { q, cursor: pageParam }, signal),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor || undefined,
    // Re-read on every open of the list (the book changes on other devices without events).
    staleTime: 0,
  });
  const contacts = useMemo(() => query.data?.pages.flatMap((p) => p.contacts) ?? NO_CONTACTS, [query.data]);
  return {
    contacts,
    status: query.isPending ? 'loading' : query.isError && !query.data ? 'error' : 'ready',
    more: query.hasNextPage,
    loadMore: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
    },
    retry: () => void query.refetch(),
  };
}

/** One contact and its last calls (the card). */
export function useContact(ws: string, id: string) {
  return useQuery({ queryKey: contactKey(ws, id), queryFn: ({ signal }) => api.sip.contact(ws, id, signal), enabled: !!id });
}

/** After a write: the lists and that contact read again (the journal's names too — they are «as of now»). */
export function contactsChanged(ws: string, id?: string): void {
  void queryClient.invalidateQueries({ queryKey: contactsKey(ws) });
  if (id) void queryClient.invalidateQueries({ queryKey: contactKey(ws, id) });
}

export interface ContactDraft {
  name: string;
  company: string;
  note: string;
  phones: SipContactPhone[];
}

/** Why a save failed, by field (under the field), with the contact that already has a number. */
export interface SaveError {
  field: 'name' | 'company' | 'note' | 'phones' | '';
  text: string;
  /** SIP_CONTACT_NUMBER_TAKEN: the contact that has the number. */
  taken?: { id: string; name: string };
}

export function saveErrorOf(e: unknown): SaveError {
  if (e instanceof ApiError && e.code === 'ERROR_CODE_SIP_CONTACT_NUMBER_TAKEN') {
    const name = e.extra.conflictName ?? '';
    return { field: 'phones', text: name ? t('telc.err.numberTakenBy', { name }) : t('telc.err.numberTaken'), taken: { id: e.extra.conflictId ?? '', name } };
  }
  if (e instanceof ApiError && e.code === 'ERROR_CODE_VALIDATION') {
    const f = e.field ?? '';
    if (f === 'phones' || f.startsWith('phones')) return { field: 'phones', text: t('telc.err.number') };
    if (f === 'name' || f === 'company') return { field: f, text: t('telc.err.nameOrCompany') };
    if (f === 'note') return { field: 'note', text: t('telc.err.note') };
  }
  return { field: '', text: describeError(e).text };
}

/** Create (`id` '') or save a contact; the saved contact. Throws for the form to show. */
export async function saveContact(ws: string, id: string, d: ContactDraft): Promise<SipContact | undefined> {
  const phones = d.phones.filter((p) => p.number.trim());
  const r = id
    ? await api.sip.updateContact(ws, id, { name: d.name.trim(), company: d.company.trim(), note: d.note.trim(), phones: { phones } })
    : await api.sip.createContact(ws, { name: d.name.trim(), company: d.company.trim(), note: d.note.trim(), phones });
  contactsChanged(ws, r.contact?.id ?? id);
  return r.contact;
}

export async function deleteContact(ws: string, id: string): Promise<boolean> {
  try {
    await api.sip.removeContact(ws, id);
    contactsChanged(ws);
    queryClient.removeQueries({ queryKey: contactKey(ws, id) });
    if (useTelContacts.getState().selected === id) useTelContacts.getState().select(null);
    toast.success(t('telc.deleted'));
    return true;
  } catch (e) {
    toast.fail(e);
    return false;
  }
}

/** «Экспорт CSV»: the whole book as a file (MANAGE_INTEGRATIONS). */
export async function exportContacts(ws: string): Promise<void> {
  try {
    const blob = await api.sip.exportContacts(ws);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'contacts.csv';
    document.body.append(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    toast.fail(e);
  }
}

// ---------------------------------------------------------------- actions and places

/** «Позвонить» a contact's number (a personal call over the trunk, ADR-0137 §3). */
export function callContact(ws: string, c: Pick<SipContact, 'id' | 'name' | 'company'>, number: string): void {
  void placePersonalCall({ workspaceId: ws, number, contactId: c.id, name: c.name || c.company });
}

export function copyContactNumber(number: string): void {
  copyText(formatPhone(number), t('tel.copied'));
}

/** The card: the desktop's right panel on «Контакты», the phone's pushed screen. */
export function openContact(id: string): void {
  const ui = useUi.getState();
  if (ui.phone.on) {
    ui.setPhone((n) => pushOnTab(n, 'telephony', { kind: 'telContact', contactId: id }));
    return;
  }
  useTelephonyUi.getState().openDetail(null);
  useTelephonyUi.getState().setPage('contacts');
  useTelContacts.getState().select(id);
}

/**
 * The form is done and a contact should show (a new one saved, the one that has the number): the
 * phone swaps the form's screen for the card (no back-then-push race with the history), the
 * desktop closes the Modal and opens the card in the panel.
 */
export function formToContact(id: string): void {
  useTelContacts.getState().openForm(null);
  const ui = useUi.getState();
  if (!ui.phone.on) {
    openContact(id);
    return;
  }
  ui.setPhone((n) => {
    const top = n.stack.at(-1);
    if (top?.kind !== 'telContactEdit') return pushOnTab(n, 'telephony', { kind: 'telContact', contactId: id });
    const below = n.stack.at(-2);
    // Back from the form to this very card: just drop the form.
    if (below?.kind === 'telContact' && below.contactId === id) return { ...n, stack: n.stack.slice(0, -1) };
    return { ...n, stack: [...n.stack.slice(0, -1), { kind: 'telContact', contactId: id }] };
  });
}

/** The form: a Modal on the desktop, a pushed screen on the phone; `id` '' = a new contact. */
export function editContact(id: string, prefill?: ContactPrefill): void {
  const ui = useUi.getState();
  useTelContacts.getState().openForm({ id, ...(prefill ? { prefill } : {}) });
  if (ui.phone.on) ui.setPhone((n) => pushOnTab(n, 'telephony', { kind: 'telContactEdit', contactId: id }));
}

/** «Набор»: the desktop's page, the phone's pushed screen; `number` fills the field. */
export function openDial(number = ''): void {
  useTelContacts.getState().setDialPrefill(number);
  const ui = useUi.getState();
  if (ui.phone.on) {
    ui.setPhone((n) => pushOnTab(n, 'telephony', { kind: 'telDial' }));
    return;
  }
  useTelephonyUi.getState().openDetail(null);
  useTelephonyUi.getState().setPage('dial');
}
