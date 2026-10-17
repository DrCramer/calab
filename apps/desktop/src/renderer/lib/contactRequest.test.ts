import { create } from '@bufbuild/protobuf';
import { ContactField, ContactSharedCardSchema, MessageKind, MessageSchema, SystemMessageSchema, type Message } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { contactFieldList, contactPreview, contactSharedCardOf, contactSharedText, sharedThroughButton } from './contactRequest';

const card = (messageId: string, buttonId: string, fields = [ContactField.PHONE, ContactField.EMAIL]) =>
  create(ContactSharedCardSchema, { botUserId: 'bot', fields, messageId, buttonId });

function sys(id: string, author: string, c: ReturnType<typeof card>): { msg: Message } {
  return { msg: create(MessageSchema, { id, authorId: author, kind: MessageKind.SYSTEM, system: create(SystemMessageSchema, { payload: { case: 'contactShared', value: c } }) }) };
}

describe('contact requests (ADR-0100)', () => {
  it('previews the requested fields in order with verification and empty values', () => {
    expect(contactPreview([ContactField.EMAIL, ContactField.PHONE], { phone: '+7 999', email: 'a@b.test', emailVerified: true })).toEqual([
      { field: ContactField.PHONE, value: '+7 999', verified: false },
      { field: ContactField.EMAIL, value: 'a@b.test', verified: true },
    ]);
    expect(contactPreview([ContactField.EMAIL], { phone: '', email: 'a@b.test', emailVerified: false })).toEqual([{ field: ContactField.EMAIL, value: 'a@b.test', verified: false }]);
    expect(contactPreview([ContactField.PHONE], { phone: '', email: '', emailVerified: false })[0]?.value).toBe('');
  });

  it('reads the card and words the service line', () => {
    const m = sys('2', 'me', card('1', 'share')).msg;
    expect(contactSharedCardOf(m)?.buttonId).toBe('share');
    expect(contactSharedCardOf(create(MessageSchema, { id: '3' }))).toBeNull();
    expect(contactFieldList([ContactField.PHONE, ContactField.EMAIL])).toBe('телефон, почта');
    expect(contactSharedText(card('1', 'share'), true, 'Olga', '@helper')).toBe('Вы поделились контактом с @helper: телефон, почта');
  });

  it('finds my share of a button after its message only', () => {
    const plain = { msg: create(MessageSchema, { id: '0190', authorId: 'bot' }) };
    const items = [plain, { msg: create(MessageSchema, { id: '0191', authorId: 'bot' }) }, sys('0192', 'me', card('0191', 'share')), sys('0193', 'other', card('0191', 'mail'))];
    expect(sharedThroughButton(items, '0191', 'share', 'me')).toBe(true);
    expect(sharedThroughButton(items, '0191', 'mail', 'me')).toBe(false); // someone else's card
    expect(sharedThroughButton(items, '0191', 'other', 'me')).toBe(false);
    expect(sharedThroughButton(items, '0190', 'share', 'me')).toBe(false); // another message
  });
});
