/**
 * The room menu (docs/09 #30, docs/08 «Колонка комнат»): one list for the voice room's «…»
 * button and the right click / long press on any room row. Pure, so the item set per
 * permission / guest is unit-tested; Sidebar.tsx renders it.
 *
 *   [Открыть чат — phone, voice] · Пригласить в комнату · Запись встречи (voice, not guests)
 *   · Позвонить на номер (voice, `dial`: the telephony gate without «I am in the call», ADR-0046)
 *   · Настройки комнаты | Прочитано · Уведомления › | Вверх · Вниз · В категорию ›
 *
 * A temporary room (ADR-0044) managed by me (MANAGE_ROOM or its creator) adds
 *   | Скопировать ссылку · Ссылки… (I manage its links, ADR-0107) · Продлить › · Добавить встречу
 *   (no meeting yet) … | Сделать постоянной (workspace MANAGE_ROOM) · Удалить комнату
 * and has no reorder items (the «Временные» group is sorted by expiry, not dragged).
 */
export type RoomMenuItem =
  | 'openChat'
  | 'invite'
  | 'record'
  | 'dial'
  | 'settings'
  | 'markRead'
  | 'notify'
  | 'moveUp'
  | 'moveDown'
  | 'toCategory'
  | 'copyLink'
  | 'links'
  | 'makePermanent'
  | 'extend'
  | 'addMeeting'
  | 'deleteRoom';
/** One group of items; groups are separated by a hairline. */
export type RoomMenuGroup = RoomMenuItem[];

export interface RoomMenuInput {
  voice: boolean;
  /** Phone layout: no hover actions, so the voice room's chat is the first item. */
  mobile: boolean;
  guest: boolean;
  /** Workspace invites: INVITE_MEMBERS (lib/permissions mayInviteMembers, ADR-0043). */
  admin: boolean;
  /** INVITE_GUESTS or INVITE_MEMBERS in the room (ADR-0043): the voice room's link dialog. */
  inviteRoom: boolean;
  /** «Позвонить на номер» is allowed here (Sip useCanDial with anyCall): joins the call first. */
  dial?: boolean;
  /** Room MANAGE_ROOM: settings and (voice) the room link. */
  canManage: boolean;
  /** Workspace MANAGE_ROOM: the reorder items. */
  canOrder: boolean;
  /** The workspace has categories («В категорию ›»). */
  hasCategories: boolean;
  /** A temporary room (ADR-0044); `canManage` then includes its creator. */
  temp?: boolean;
  /** The temporary room already has a meeting in the calendar. */
  hasEvent?: boolean;
  /** I manage the room's links (an invite right there, or its creator): «Ссылки…» of a temporary room. */
  manageLinks?: boolean;
  /** Workspace MANAGE_ROOM (the right to create regular rooms): «Сделать постоянной» of a temporary room. */
  makePermanent?: boolean;
}

export function roomMenuGroups(i: RoomMenuInput): RoomMenuGroup[] {
  const head: RoomMenuItem[] = [];
  if (i.voice && i.mobile) head.push('openChat');
  // Voice: a room link (a room invite right, ADR-0016 / ADR-0043) or the workspace invite
  // (INVITE_MEMBERS); text: the latter.
  if (!i.guest && (i.admin || (i.voice && i.inviteRoom))) head.push('invite');
  // Meeting recording (docs/09 #30): any member but a guest; start, or stop the running one (ADR-0025).
  if (i.voice && !i.guest) head.push('record');
  if (i.voice && i.dial && !i.guest) head.push('dial');
  if (i.canManage) head.push('settings');
  const groups: RoomMenuGroup[] = [head];
  const temp = !!i.temp && i.canManage;
  if (temp) {
    const g: RoomMenuItem[] = i.manageLinks && !i.guest ? ['copyLink', 'links', 'extend'] : ['copyLink', 'extend'];
    groups.push(i.hasEvent || i.guest ? g : [...g, 'addMeeting']);
  }
  groups.push(['markRead', 'notify']);
  if (i.canOrder && !i.temp) groups.push(i.hasCategories ? ['moveUp', 'moveDown', 'toCategory'] : ['moveUp', 'moveDown']);
  if (temp) groups.push(i.makePermanent && !i.guest ? ['makePermanent', 'deleteRoom'] : ['deleteRoom']);
  return groups.filter((g) => g.length > 0);
}

