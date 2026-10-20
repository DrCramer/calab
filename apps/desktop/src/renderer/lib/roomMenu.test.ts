import { describe, expect, it } from 'vitest';
import { roomMenuGroups, type RoomMenuInput } from './roomMenu';

const base: RoomMenuInput = { voice: true, mobile: false, guest: false, admin: false, inviteRoom: false, canManage: false, canOrder: false, hasCategories: false };

describe('roomMenuGroups', () => {
  it('member in a voice room: recording, read, notifications', () => {
    expect(roomMenuGroups(base)).toEqual([['record'], ['markRead', 'notify']]);
  });

  it('owner / admin: invite, recording, settings, then the reorder items', () => {
    expect(roomMenuGroups({ ...base, admin: true, canManage: true, canOrder: true, hasCategories: true })).toEqual([
      ['invite', 'record', 'settings'],
      ['markRead', 'notify'],
      ['moveUp', 'moveDown', 'toCategory'],
    ]);
  });

  it('a room invite right (ADR-0043) invites by room link (voice only); MANAGE_ROOM alone does not', () => {
    expect(roomMenuGroups({ ...base, inviteRoom: true })[0]).toEqual(['invite', 'record']);
    expect(roomMenuGroups({ ...base, voice: false, inviteRoom: true })).toEqual([['markRead', 'notify']]);
    expect(roomMenuGroups({ ...base, canManage: true })[0]).toEqual(['record', 'settings']);
  });

  it('guest: no invite, no recording', () => {
    expect(roomMenuGroups({ ...base, guest: true, canManage: true, inviteRoom: true })).toEqual([['settings'], ['markRead', 'notify']]);
    expect(roomMenuGroups({ ...base, guest: true })).toEqual([['markRead', 'notify']]);
  });

  it('«Запланировать встречу» (CBF-18): a permanent voice room, for who creates meetings', () => {
    expect(roomMenuGroups({ ...base, schedule: true, inviteRoom: true })[0]).toEqual(['invite', 'schedule', 'record']);
    expect(roomMenuGroups({ ...base, schedule: true, voice: false, admin: true })[0]).toEqual(['invite']);
    expect(roomMenuGroups({ ...base, schedule: true, guest: true })[0]).toEqual(['markRead', 'notify']);
    expect(roomMenuGroups({ ...base, schedule: true, temp: true, canManage: true })[0]).toEqual(['record', 'settings']);
  });

  it('text room: no recording, no chat item', () => {
    expect(roomMenuGroups({ ...base, voice: false, mobile: true, admin: true })[0]).toEqual(['invite']);
  });

  it('phone: the voice room chat comes first', () => {
    expect(roomMenuGroups({ ...base, mobile: true })[0]).toEqual(['openChat', 'record']);
  });

  it('no categories: no «В категорию ›»', () => {
    expect(roomMenuGroups({ ...base, canOrder: true })[2]).toEqual(['moveUp', 'moveDown']);
  });

  it('a temporary room I manage (ADR-0044): link, extend, meeting, delete; no reorder', () => {
    expect(roomMenuGroups({ ...base, canManage: true, canOrder: true, hasCategories: true, temp: true })).toEqual([
      ['record', 'settings'],
      ['copyLink', 'extend', 'addMeeting'],
      ['markRead', 'notify'],
      ['deleteRoom'],
    ]);
  });

  it('a temporary room: «Ссылки…» for who manages its links, «Сделать постоянной» with workspace MANAGE_ROOM (ADR-0107)', () => {
    expect(roomMenuGroups({ ...base, canManage: true, temp: true, manageLinks: true, makePermanent: true })).toEqual([
      ['record', 'settings'],
      ['copyLink', 'links', 'extend', 'addMeeting'],
      ['markRead', 'notify'],
      ['makePermanent', 'deleteRoom'],
    ]);
    expect(roomMenuGroups({ ...base, canManage: true, temp: true, guest: true, manageLinks: true, makePermanent: true })[1]).toEqual(['copyLink', 'extend']);
    expect(roomMenuGroups({ ...base, canManage: true, temp: true, guest: true, makePermanent: true }).at(-1)).toEqual(['deleteRoom']);
    expect(roomMenuGroups({ ...base, canManage: false, temp: true, manageLinks: true, makePermanent: true })).toEqual([['record'], ['markRead', 'notify']]);
  });

  it('a temporary room with a meeting already: no «Добавить встречу»', () => {
    expect(roomMenuGroups({ ...base, canManage: true, temp: true, hasEvent: true })[1]).toEqual(['copyLink', 'extend']);
  });

  it('a temporary room of someone else: the voice room items only', () => {
    expect(roomMenuGroups({ ...base, canOrder: true, temp: true })).toEqual([['record'], ['markRead', 'notify']]);
  });

  it('«Позвонить на номер»: voice, allowed, not a guest — after the recording, before the settings', () => {
    expect(roomMenuGroups({ ...base, dial: true })[0]).toEqual(['record', 'dial']);
    expect(roomMenuGroups({ ...base, dial: true, admin: true, canManage: true, mobile: true })[0]).toEqual(['openChat', 'invite', 'record', 'dial', 'settings']);
    expect(roomMenuGroups({ ...base, dial: false })[0]).toEqual(['record']);
    expect(roomMenuGroups(base)[0]).toEqual(['record']);
  });

  it('«Позвонить на номер»: never in a text room or for a guest', () => {
    expect(roomMenuGroups({ ...base, voice: false, dial: true })).toEqual([['markRead', 'notify']]);
    expect(roomMenuGroups({ ...base, guest: true, dial: true })).toEqual([['markRead', 'notify']]);
  });
});
