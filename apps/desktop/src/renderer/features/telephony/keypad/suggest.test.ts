import { create } from '@bufbuild/protobuf';
import { SipContactPhoneSchema, SipContactSchema } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { suggestDial } from './suggest';

const exts = [
  { userId: 'u-anna', name: 'Анна Петрова', number: '101' },
  { userId: 'u-boris', name: 'Борис Петров', number: '1002' },
];
const contact = (id: string, name: string, company: string, ...numbers: string[]) =>
  create(SipContactSchema, { id, name, company, phones: numbers.map((number) => create(SipContactPhoneSchema, { number })) });
const contacts = [contact('c1', 'Анна Смирнова', 'ООО Ромашка', '+79161234567', '+74951112233'), contact('c2', '', 'ООО Лютик', '+74957654321')];

describe('the dial pad suggestion', () => {
  it('a colleague\'s internal number (2–6 digits)', () => {
    expect(suggestDial('101', exts, contacts)).toEqual({ kind: 'ext', userId: 'u-anna', name: 'Анна Петрова', number: '101' });
    expect(suggestDial('1002', exts, contacts)).toMatchObject({ kind: 'ext', userId: 'u-boris' });
    expect(suggestDial('10', exts, contacts)).toBeNull();
  });

  it('a contact by the whole number, 8… and +7… alike, and 10 digits on 9', () => {
    expect(suggestDial('8 916 123-45-67', exts, contacts)).toMatchObject({ kind: 'contact', contactId: 'c1', exact: true, number: '+79161234567' });
    expect(suggestDial('+79161234567', exts, contacts)).toMatchObject({ contactId: 'c1', exact: true });
    expect(suggestDial('9161234567', exts, contacts)).toMatchObject({ contactId: 'c1', exact: true });
  });

  it('a contact by the start of a number, then by a part of it', () => {
    expect(suggestDial('+7495765', exts, contacts)).toMatchObject({ contactId: 'c2', company: 'ООО Лютик', exact: false });
    expect(suggestDial('1112233', exts, contacts)).toMatchObject({ contactId: 'c1', number: '+74951112233', exact: false });
  });

  it('nothing for two digits or no match', () => {
    expect(suggestDial('+7', exts, contacts)).toBeNull();
    expect(suggestDial('+1212555', exts, contacts)).toBeNull();
    expect(suggestDial('', exts, contacts)).toBeNull();
  });
});
