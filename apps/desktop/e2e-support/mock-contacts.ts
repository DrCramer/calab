import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { SipContactImportSkipSchema, SipContactPhoneSchema, SipContactSchema, SipPhoneLabel, type SipContact, type SipContactImportSkip, type SipContactPhone } from '@calaba/protocol';
import { normalizeContactNumber } from '../src/renderer/lib/phoneNumber';

/**
 * The phone book of the mock API (ADR-0137 §2, sip.proto contacts): contacts in memory with the
 * server's rules — a number belongs to one contact (409 SIP_CONTACT_NUMBER_TAKEN with its id and
 * name), names / company / note limits, the numbers normalised like sip.NormalizeContactNumber
 * (the TS mirror), the list order (Cyrillic, Latin, the rest; by name, else company), `q` by text
 * or digits, an index cursor; a CSV import (header ru/en, `,` or `;`, several numbers in a cell)
 * with the dry run and its skips; the export. Wired into mock-server.ts (`sipContactRoutes`).
 */

export type ContactBook = Map<string, SipContact>;

export const CONTACTS_PAGE = 200;

const title = (c: Pick<SipContact, 'name' | 'company'>): string => c.name || c.company;

/** 0 Cyrillic, 1 Latin, 2 the rest (the server's order). */
function script(s: string): number {
  const ch = s.trim().charAt(0);
  if (/[А-Яа-яЁё]/.test(ch)) return 0;
  if (/[A-Za-z]/.test(ch)) return 1;
  return 2;
}

export function sortContacts(list: SipContact[]): SipContact[] {
  return list.sort((a, b) => script(title(a)) - script(title(b)) || title(a).localeCompare(title(b), 'ru', { sensitivity: 'base' }) || (a.id < b.id ? -1 : 1));
}

/** The contact that has `number` (E.164) in workspace `ws`, but `except`. */
export function numberOwner(book: ContactBook, ws: string, number: string, except = ''): SipContact | undefined {
  for (const c of book.values()) if (c.workspaceId === ws && c.id !== except && c.phones.some((p) => p.number === number)) return c;
  return undefined;
}

/** GET …/sip/contacts: a page by the server's order, `q` — digits of a number or a part of a name / company. */
export function listContacts(book: ContactBook, ws: string, q: string, cursor: number, limit = CONTACTS_PAGE): { contacts: SipContact[]; nextCursor: string } {
  const text = q.trim().toLowerCase();
  const digits = /^[\d\s()+\-.]+$/.test(text) ? text.replace(/\D/g, '') : '';
  const all = sortContacts(
    [...book.values()].filter((c) => {
      if (c.workspaceId !== ws) return false;
      if (!text) return true;
      if (digits) return c.phones.some((p) => p.number.replace(/\D/g, '').includes(digits));
      return [c.name, c.company].some((s) => s.toLowerCase().includes(text));
    }),
  );
  const page = all.slice(cursor, cursor + limit);
  return { contacts: page, nextCursor: cursor + limit < all.length ? String(cursor + limit) : '' };
}

export interface ContactInput {
  name: string;
  company: string;
  note: string;
  phones: readonly SipContactPhone[];
}

export type ContactError =
  | { kind: 'validation'; field: string; message: string }
  | { kind: 'taken'; id: string; name: string };

/** The server's checks of a create / edit: the normalised phones, or why not. */
export function checkContact(book: ContactBook, ws: string, self: string, input: ContactInput, callerId: string): { phones: SipContactPhone[] } | ContactError {
  const name = input.name.trim();
  const company = input.company.trim();
  if (!name && !company) return { kind: 'validation', field: 'name', message: 'name or company is required' };
  if (name.length > 128) return { kind: 'validation', field: 'name', message: 'name: at most 128 characters' };
  if (company.length > 128) return { kind: 'validation', field: 'company', message: 'company: at most 128 characters' };
  if (input.note.length > 1000) return { kind: 'validation', field: 'note', message: 'note: at most 1000 characters' };
  if (input.phones.length > 10) return { kind: 'validation', field: 'phones', message: 'phones: at most 10' };
  const phones: SipContactPhone[] = [];
  for (const p of input.phones) {
    const n = normalizeContactNumber(p.number, callerId);
    if (!n) return { kind: 'validation', field: 'phones', message: 'phones: use the international format' };
    if (phones.some((x) => x.number === n)) return { kind: 'validation', field: 'phones', message: 'phones: a number twice' };
    const owner = numberOwner(book, ws, n, self);
    if (owner) return { kind: 'taken', id: owner.id, name: title(owner) };
    phones.push(create(SipContactPhoneSchema, { number: n, label: p.label || SipPhoneLabel.OTHER }));
  }
  return { phones };
}

export function makeContact(o: { id: string; ws: string; name?: string; company?: string; note?: string; phones: Array<[string, SipPhoneLabel]>; by: string; at: number }): SipContact {
  return create(SipContactSchema, {
    id: o.id,
    workspaceId: o.ws,
    name: o.name ?? '',
    company: o.company ?? '',
    note: o.note ?? '',
    phones: o.phones.map(([number, label]) => create(SipContactPhoneSchema, { number, label })),
    createdBy: o.by,
    updatedBy: o.by,
    createdAt: timestampFromMs(o.at),
    updatedAt: timestampFromMs(o.at),
  });
}

// ---------------------------------------------------------------- CSV

const HEAD: Array<[RegExp, 'name' | 'company' | 'note' | SipPhoneLabel]> = [
  [/^(имя|фио|name)$/i, 'name'],
  [/^(компания|организация|company)$/i, 'company'],
  [/^(заметка|комментарий|note)$/i, 'note'],
  [/^(мобильный|mobile)$/i, SipPhoneLabel.MOBILE],
  [/^(рабочий|work)$/i, SipPhoneLabel.WORK],
  [/^(домашний|home)$/i, SipPhoneLabel.HOME],
  [/^(другой|other)$/i, SipPhoneLabel.OTHER],
  [/^(телефон|phone)/i, SipPhoneLabel.MOBILE],
];

function cells(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] ?? '';
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim().replace(/^'/, ''));
}

export interface ImportResult {
  created: SipContact[];
  rows: number;
  skipped: SipContactImportSkip[];
}

/** POST …/import: the rows that would be created and the skipped ones (nothing is written here). */
export function importCsv(book: ContactBook, ws: string, text: string, callerId: string, by: string, nextId: () => string, now: number): ImportResult | { field: string; message: string } {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return { field: 'file', message: 'empty file' };
  const first = lines[0] ?? '';
  const sep = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ';' : ',';
  const cols = cells(first, sep).map((h) => HEAD.find(([re]) => re.test(h))?.[1]);
  if (!cols.some((c) => c !== undefined)) return { field: 'file', message: 'no recognised header' };
  if (lines.length - 1 > 5000) return { field: 'file', message: 'more than 5000 rows' };
  const created: SipContact[] = [];
  const skipped: SipContactImportSkip[] = [];
  const seen = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    const row = i + 1;
    const v = cells(lines[i] ?? '', sep);
    let name = '';
    let company = '';
    let note = '';
    const phones: SipContactPhone[] = [];
    let bad = '';
    cols.forEach((col, j) => {
      const cell = v[j] ?? '';
      if (col === 'name') name = cell;
      else if (col === 'company') company = cell;
      else if (col === 'note') note = cell;
      else if (col !== undefined)
        for (const raw of cell.split(/[;,]/).map((s) => s.trim()).filter(Boolean)) {
          const n = normalizeContactNumber(raw, callerId);
          if (!n) bad ||= raw;
          else phones.push(create(SipContactPhoneSchema, { number: n, label: col }));
        }
    });
    const skip = (reason: string, extra: { number?: string; contactId?: string; contactName?: string } = {}): void =>
      void skipped.push(create(SipContactImportSkipSchema, { row, reason, number: extra.number ?? '', contactId: extra.contactId ?? '', contactName: extra.contactName ?? '' }));
    if (!name && !company) skip('no_name');
    else if (bad) skip('bad_number', { number: bad });
    else if (phones.length === 0) skip('no_number');
    else if (phones.length > 10) skip('too_many_numbers');
    else {
      const dup = phones.find((p) => seen.has(p.number));
      const taken = phones.map((p) => ({ p, owner: numberOwner(book, ws, p.number) })).find((x) => x.owner);
      if (taken?.owner) skip('number_taken', { number: taken.p.number, contactId: taken.owner.id, contactName: title(taken.owner) });
      else if (dup) skip('duplicate', { number: dup.number });
      else {
        for (const p of phones) seen.add(p.number);
        created.push(makeContact({ id: nextId(), ws, name, company, note, phones: phones.map((p) => [p.number, p.label]), by, at: now }));
      }
    }
  }
  return { created, rows: lines.length - 1, skipped };
}

/** GET …/export.csv: UTF-8 with BOM, «;», a cell a spreadsheet would run as a formula gets a «'». */
export function exportCsv(book: ContactBook, ws: string): string {
  const esc = (s: string): string => {
    const safe = /^[=+\-@\t\r\n]/.test(s) ? `'${s}` : s;
    return /[;"\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const of = (c: SipContact, l: SipPhoneLabel): string =>
    c.phones
      .filter((p) => (p.label || SipPhoneLabel.OTHER) === l)
      .map((p) => p.number)
      .join(', ');
  const lines = ['Имя;Компания;Мобильный;Рабочий;Домашний;Другой;Заметка'];
  for (const c of sortContacts([...book.values()].filter((x) => x.workspaceId === ws))) {
    lines.push([c.name, c.company, of(c, SipPhoneLabel.MOBILE), of(c, SipPhoneLabel.WORK), of(c, SipPhoneLabel.HOME), of(c, SipPhoneLabel.OTHER), c.note].map(esc).join(';'));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
