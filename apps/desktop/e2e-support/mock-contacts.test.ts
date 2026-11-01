import { create } from '@bufbuild/protobuf';
import { SipContactPhoneSchema, SipPhoneLabel } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { checkContact, exportCsv, importCsv, listContacts, makeContact, type ContactBook } from './mock-contacts';

const WS = 'ws1';
const book = (): ContactBook => {
  const b: ContactBook = new Map();
  const add = (id: string, name: string, company: string, number: string): void => void b.set(id, makeContact({ id, ws: WS, name, company, phones: [[number, SipPhoneLabel.MOBILE]], by: 'u1', at: 0 }));
  add('c1', 'Bob', '', '+12125550100');
  add('c2', 'Анна Петрова', 'ООО Ромашка', '+79161234567');
  add('c3', '', '1С-Сервис', '+74951112233');
  add('c4', 'Алексей', '', '+79035550142');
  return b;
};

describe('the mock phone book', () => {
  it('lists Cyrillic, then Latin, then the rest; q by text or digits', () => {
    expect(listContacts(book(), WS, '', 0).contacts.map((c) => c.id)).toEqual(['c4', 'c2', 'c1', 'c3']);
    expect(listContacts(book(), WS, 'ромаш', 0).contacts.map((c) => c.id)).toEqual(['c2']);
    expect(listContacts(book(), WS, '916 123', 0).contacts.map((c) => c.id)).toEqual(['c2']);
    expect(listContacts(book(), WS, '', 0, 2)).toMatchObject({ nextCursor: '2' });
  });

  it('checks a contact like the server: name or company, numbers normalised, a number taken', () => {
    const phone = (number: string) => create(SipContactPhoneSchema, { number, label: SipPhoneLabel.WORK });
    expect(checkContact(book(), WS, '', { name: '', company: '', note: '', phones: [] }, '+74950000000')).toMatchObject({ kind: 'validation', field: 'name' });
    expect(checkContact(book(), WS, '', { name: 'X', company: '', note: '', phones: [phone('9161112233')] }, '+74950000000')).toMatchObject({ phones: [{ number: '+79161112233' }] });
    expect(checkContact(book(), WS, '', { name: 'X', company: '', note: '', phones: [phone('9161112233')] }, '')).toMatchObject({ kind: 'validation', field: 'phones' });
    expect(checkContact(book(), WS, '', { name: 'X', company: '', note: '', phones: [phone('8 916 123-45-67')] }, '')).toEqual({ kind: 'taken', id: 'c2', name: 'Анна Петрова' });
    expect(checkContact(book(), WS, 'c2', { name: 'Анна', company: '', note: '', phones: [phone('+79161234567')] }, '')).toMatchObject({ phones: [{ number: '+79161234567' }] });
  });

  it('previews a CSV import with its skips', () => {
    let n = 0;
    const csv = '\uFEFFИмя;Компания;Телефон;Заметка\nИрина;ООО Лютик;8 916 000-11-22;\nДубль;;+79161234567;\n;;+79160000000;\nКто-то;;abc;\nИрина 2;;+7 916 000-11-22;\n';
    const r = importCsv(book(), WS, csv, '+74950000000', 'u1', () => `n${++n}`, 0);
    if ('field' in r) throw new Error(r.message);
    expect(r.rows).toBe(5);
    expect(r.created.map((c) => c.name)).toEqual(['Ирина']);
    expect(r.skipped.map((s) => [s.row, s.reason])).toEqual([
      [3, 'number_taken'],
      [4, 'no_name'],
      [5, 'bad_number'],
      [6, 'duplicate'],
    ]);
    expect(r.skipped[0]).toMatchObject({ contactId: 'c2', contactName: 'Анна Петрова' });
    expect(importCsv(book(), WS, 'foo,bar\n1,2', '', 'u1', () => 'x', 0)).toMatchObject({ field: 'file' });
  });

  it('exports with a BOM, «;» and formula cells guarded', () => {
    const b = book();
    b.set('c5', makeContact({ id: 'c5', ws: WS, name: '=HYPERLINK()', company: '', phones: [['+79990001122', SipPhoneLabel.HOME]], by: 'u1', at: 0 }));
    const out = exportCsv(b, WS);
    expect(out.startsWith('\uFEFFИмя;Компания;Мобильный;Рабочий;Домашний;Другой;Заметка')).toBe(true);
    expect(out).toContain("'=HYPERLINK();;;;'+79990001122;;");
  });
});
