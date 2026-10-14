import { create } from '@bufbuild/protobuf';
import {
  BoardSchema,
  PERMISSION_BITS,
  PermissionTargetType,
  RoleSchema,
  RoomPermissionOverrideSchema,
  RoomSchema,
  RoomType,
  WorkspaceRole,
  type PermissionName,
  type Role,
} from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { ru } from '../i18n/ru';
import {
  accessLevelOf,
  accessSteps,
  mayAllowRecording,
  mayAssignRoles,
  mayCreateBoards,
  mayManageBots,
  mayManageEvents,
  mayManageIntegrations,
  mayManageMembers,
  mayManageRecordings,
  mayOpenWorkspaceSettings,
  mayTakeOver,
  mayViewJournals,
  ownerSeesPrivate,
  roomPerms,
  setOwnerSeesPrivate,
  settingsAccess,
} from './permissions';
import { previewRoles, rolePreview, visibleBoards, visibleRooms } from './rolePreview';
import {
  ROLE_PERM_GROUPS,
  ROLE_TEMPLATES,
  canAssignRole,
  legacyRoles,
  permDefault,
  roleActor,
  rolesOfMember,
  templateBits,
  templateClipped,
} from './roles';

/* ADR-0048 on the client: the role editor's groups and templates, the preview, the gating helpers. */

const B = PERMISSION_BITS;
const custom = (id: string, position: number, permissions: bigint): Role => create(RoleSchema, { id, workspaceId: 'w', name: id, position, permissions });
const builtins = legacyRoles('w');
const as = (role: WorkspaceRole, ...extra: Role[]): Role[] => [...rolesOfMember(builtins, { role, roleIds: [] }), ...extra];

describe('role editor groups (ADR-0048 «Контракт для клиента»)', () => {
  it('lists every bit once, in the contract order, but ADMINISTRATOR (Телефония = PLACE_CALLS, ADR-0046)', () => {
    const listed = ROLE_PERM_GROUPS.flatMap((g) => g.perms);
    expect(new Set(listed).size).toBe(listed.length);
    const all = (Object.keys(B) as PermissionName[]).filter((n) => n !== 'ADMINISTRATOR');
    expect([...listed].sort()).toEqual([...all].sort());
    expect(ROLE_PERM_GROUPS.map((g) => g.id)).toEqual([
      'workspace',
      'members',
      'invites',
      'rooms',
      'voice',
      'moderation',
      'calendar',
      'boards',
      'recordings',
      'telephony',
      'integrations',
      'journals',
    ]);
  });

  it('every listed bit has a label and a hint (perm.hint.*) in ru', () => {
    const dict = ru as Record<string, unknown>;
    for (const p of ROLE_PERM_GROUPS.flatMap((g) => g.perms)) {
      expect(dict[`perm.${p}`], p).toBeTypeOf('string');
      expect(dict[`perm.hint.${p}`], p).toBeTypeOf('string');
    }
  });

  it('«кому по умолчанию» comes from the built-in defaults', () => {
    expect(permDefault('CONNECT')).toBe('guests');
    expect(permDefault('SEND_MESSAGES')).toBe('members');
    expect(permDefault('CREATE_TEMP_ROOMS')).toBe('members');
    expect(permDefault('CREATE_BOARDS')).toBe('admins');
    expect(permDefault('MANAGE_RECORDINGS')).toBe('admins');
  });
});

describe('role templates', () => {
  const bits = (id: string): bigint => ROLE_TEMPLATES.find((x) => x.id === id)?.bits ?? -1n;
  it('carry the ADR bit sets', () => {
    expect(bits('empty')).toBe(0n);
    expect(bits('moderator')).toBe(14472n);
    expect(bits('manager')).toBe(1656750080n);
    expect(bits('observer')).toBe(131089n);
    expect(bits('observer') & B.SEND_MESSAGES).toBe(0n);
  });

  it('are clipped to what I may grant', () => {
    const editable = B.MANAGE_MESSAGES | B.MUTE_MEMBERS;
    expect(templateBits('moderator', editable)).toBe(B.MANAGE_MESSAGES | B.MUTE_MEMBERS);
    expect(templateClipped('moderator', editable)).toBe(B.MOVE_MEMBERS | B.MANAGE_NICKNAMES | B.MENTION_EVERYONE);
    expect(templateClipped('empty', 0n)).toBe(0n);
  });
});

describe('gating helpers (ADR-0048: no implication from MANAGE_WORKSPACE)', () => {
  const wsOnly = custom('ws', 5, B.MANAGE_WORKSPACE);
  const v2 = custom('v2', 5, B.MANAGE_WORKSPACE | B.CREATE_BOARDS | B.MANAGE_MEMBERS | B.MANAGE_BOTS | B.MANAGE_INTEGRATIONS | B.VIEW_JOURNALS | B.MANAGE_EVENTS | B.MANAGE_RECORDINGS);
  const helpers = [mayCreateBoards, mayManageMembers, mayManageBots, mayManageIntegrations, mayViewJournals, mayManageEvents, mayManageRecordings];

  it('each bit alone; MANAGE_WORKSPACE gives none of them; admins all; guests never', () => {
    for (const h of helpers) {
      expect(h(as(WorkspaceRole.MEMBER, wsOnly)), h.name).toBe(false);
      expect(h(as(WorkspaceRole.MEMBER, v2)), h.name).toBe(true);
      expect(h(as(WorkspaceRole.ADMIN)), h.name).toBe(true);
      expect(h(as(WorkspaceRole.MEMBER)), h.name).toBe(false);
      expect(h(as(WorkspaceRole.GUEST, v2)), h.name).toBe(false);
      expect(h(undefined), h.name).toBe(false);
    }
    expect(mayCreateBoards(as(WorkspaceRole.MEMBER, custom('b', 3, B.CREATE_BOARDS)))).toBe(true);
    expect(mayManageBots(as(WorkspaceRole.MEMBER, custom('b', 3, B.CREATE_BOARDS)))).toBe(false);
  });

  it('role assignment: MANAGE_MEMBERS or MANAGE_ROLES, the hierarchy stays', () => {
    const hr = custom('hr', 4, B.MANAGE_MEMBERS);
    const lower = custom('lower', 3, 0n);
    const higher = custom('higher', 5, 0n);
    expect(mayAssignRoles(as(WorkspaceRole.MEMBER, hr))).toBe(true);
    expect(mayAssignRoles(as(WorkspaceRole.MEMBER, custom('r', 4, B.MANAGE_ROLES)))).toBe(true);
    expect(mayAssignRoles(as(WorkspaceRole.MEMBER, wsOnly))).toBe(false);
    const actor = roleActor(as(WorkspaceRole.MEMBER, hr));
    expect(canAssignRole(actor, lower, 1, false)).toBe(true);
    expect(canAssignRole(actor, higher, 1, false)).toBe(false);
    expect(canAssignRole(roleActor(as(WorkspaceRole.MEMBER, wsOnly)), lower, 1, false)).toBe(false);
  });

  it('settings tabs by right; the menu item for any of them', () => {
    expect(settingsAccess(as(WorkspaceRole.MEMBER, custom('b', 3, B.MANAGE_BOTS)))).toMatchObject({ workspace: false, bots: true, members: false, integrations: false });
    expect(mayOpenWorkspaceSettings(as(WorkspaceRole.MEMBER, custom('b', 3, B.MANAGE_BOTS)))).toBe(true);
    expect(mayOpenWorkspaceSettings(as(WorkspaceRole.MEMBER, custom('j', 3, B.VIEW_JOURNALS)))).toBe(false);
    expect(mayOpenWorkspaceSettings(as(WorkspaceRole.MEMBER))).toBe(false);
    expect(mayOpenWorkspaceSettings(as(WorkspaceRole.ADMIN))).toBe(true);
  });

  it('allow_recording: MANAGE_ROOM in the room and MANAGE_RECORDINGS of the workspace', () => {
    const room = create(RoomSchema, { id: 'r', workspaceId: 'w', type: RoomType.VOICE });
    expect(mayAllowRecording(as(WorkspaceRole.MEMBER, custom('m', 3, B.MANAGE_ROOM)), 'u', room)).toBe(false);
    expect(mayAllowRecording(as(WorkspaceRole.MEMBER, custom('m', 3, B.MANAGE_ROOM | B.MANAGE_RECORDINGS)), 'u', room)).toBe(true);
    expect(mayAllowRecording(as(WorkspaceRole.MEMBER, custom('m', 3, B.MANAGE_RECORDINGS)), 'u', room)).toBe(false);
    expect(mayAllowRecording(as(WorkspaceRole.ADMIN), 'u', room)).toBe(true);
  });
});

describe('access level (two levels, ADR-0058 / ADR-0078 addenda 2026-10-14)', () => {
  it('reads the level off the flags: isPrivate or the old restricted flag is private', () => {
    expect(accessLevelOf({ isPrivate: false, restricted: false })).toBe('all');
    expect(accessLevelOf({ isPrivate: true, restricted: false })).toBe('private');
    expect(accessLevelOf({ isPrivate: true, restricted: true })).toBe('private');
    expect(accessLevelOf({ isPrivate: false, restricted: true })).toBe('private');
  });

  it('one PATCH of is_private per change', () => {
    expect(accessSteps('all', 'private')).toEqual([{ isPrivate: true }]);
    expect(accessSteps('private', 'all')).toEqual([{ isPrivate: false }]);
    expect(accessSteps('private', 'private')).toEqual([]);
  });

  it('take-over: the owner with the setting, a private item, a creator who left', () => {
    const members = { u1: {} };
    const base = { isOwner: true, seesPrivate: true, isPrivate: true, itemOwnerId: 'gone', members };
    expect(mayTakeOver(base)).toBe(true);
    expect(mayTakeOver({ ...base, itemOwnerId: '' })).toBe(true);
    expect(mayTakeOver({ ...base, itemOwnerId: 'u1' })).toBe(false);
    expect(mayTakeOver({ ...base, seesPrivate: false })).toBe(false);
    expect(mayTakeOver({ ...base, isOwner: false })).toBe(false);
    expect(mayTakeOver({ ...base, isPrivate: false })).toBe(false);
  });

  it('room bits follow «Владелец видит приватное» of the room\'s workspace', () => {
    const room = create(RoomSchema, { id: 'r', workspaceId: 'w-sees', type: RoomType.TEXT, isPrivate: true, restricted: true, createdBy: 'c' });
    const owner = [{ id: 'o', position: 1001, permissions: B.ADMINISTRATOR, builtin: WorkspaceRole.OWNER }];
    expect(roomPerms(owner, 'u', room)).toBe(0n);
    setOwnerSeesPrivate('w-sees', true);
    expect(roomPerms(owner, 'u', room)).not.toBe(0n);
    expect(ownerSeesPrivate('w-sees')).toBe(true);
    setOwnerSeesPrivate('w-sees', false);
    expect(roomPerms(owner, 'u', room)).toBe(0n);
  });
});

describe('«Что увидит участник с этой ролью»', () => {
  const all = builtins;
  const ov = (id: string, allow: bigint, deny = 0n) => create(RoomPermissionOverrideSchema, { targetType: PermissionTargetType.ROLE, targetId: id, allow, deny });
  const rooms = {
    pub: create(RoomSchema, { id: 'pub', workspaceId: 'w', type: RoomType.TEXT }),
    priv: create(RoomSchema, { id: 'priv', workspaceId: 'w', type: RoomType.TEXT, isPrivate: true, permissionOverrides: [ov('member', 0n, B.VIEW_ROOM)] }),
    closed: create(RoomSchema, { id: 'closed', workspaceId: 'w', type: RoomType.VOICE, isPrivate: true, restricted: true, permissionOverrides: [ov('member', 0n, B.VIEW_ROOM), ov('sales', B.VIEW_ROOM)] }),
    dm: create(RoomSchema, { id: 'dm', workspaceId: 'w', type: RoomType.DM }),
    other: create(RoomSchema, { id: 'other', workspaceId: 'x', type: RoomType.TEXT }),
  };

  it('a custom role is previewed with «Участник»; owner / admin — nothing to preview', () => {
    const r = custom('sales', 3, 0n);
    expect(previewRoles(all, r, B.CREATE_BOARDS)?.map((x) => x.id)).toEqual(['member', 'sales']);
    expect(previewRoles(all, { id: 'member', position: 1, builtin: WorkspaceRole.MEMBER }, 0n)?.map((x) => x.id)).toEqual(['member']);
    expect(previewRoles(all, { id: 'admin', position: 1000, builtin: WorkspaceRole.ADMIN }, 0n)).toBeNull();
  });

  it('counts rooms through their overrides: a closed room only when it lists the role', () => {
    const sales = previewRoles(all, custom('sales', 3, 0n), 0n) ?? [];
    const ops = previewRoles(all, custom('ops', 3, 0n), 0n) ?? [];
    expect(visibleRooms(rooms, 'w', sales)).toBe('2/3');
    expect(visibleRooms(rooms, 'w', ops)).toBe('1/3');
    // ADMINISTRATOR opens no private room (ADR-0078 addendum 2026-10-14).
    expect(visibleRooms(rooms, 'w', [...ops, custom('adm', 900, B.ADMINISTRATOR)])).toBe('1/3');
  });

  it('boards: a guest sees none; a closed board only by an override', () => {
    const boards = {
      b1: create(BoardSchema, { id: 'b1', workspaceId: 'w' }),
      b2: create(BoardSchema, { id: 'b2', workspaceId: 'w', isPrivate: true, restricted: true, permissionOverrides: [ov('sales', B.VIEW_BOARD)] }),
    };
    const sales = previewRoles(all, custom('sales', 3, 0n), 0n) ?? [];
    expect(visibleBoards(boards, 'w', sales, false)).toBe('2/2');
    expect(visibleBoards(boards, 'w', previewRoles(all, custom('ops', 3, 0n), 0n) ?? [], false)).toBe('1/2');
    const guest = previewRoles(all, { id: 'guest', position: 0, builtin: WorkspaceRole.GUEST }, B.CONNECT | B.SPEAK) ?? [];
    expect(visibleBoards(boards, 'w', guest, true)).toBe('0/2');
  });

  it('lists sections and settings tabs as the bits change', () => {
    const on = (roles: Role[], guest = false): string[] =>
      rolePreview(roles, guest, { rooms: '1/1', boards: '1/1' })
        .filter((i) => i.on)
        .map((i) => i.id);
    const base = previewRoles(all, custom('x', 3, 0n), 0n) as Role[];
    expect(on(base)).toEqual(['rooms', 'voice', 'tempRooms', 'calendar', 'boards']);
    const mgr = previewRoles(all, custom('x', 3, 0n), ROLE_TEMPLATES.find((x) => x.id === 'manager')?.bits ?? 0n) as Role[];
    expect(on(mgr)).toEqual(['rooms', 'voice', 'tempRooms', 'calendar', 'events', 'boards', 'createBoards', 'tabJournals']);
    const guest = previewRoles(all, { id: 'guest', position: 0, builtin: WorkspaceRole.GUEST }, B.CONNECT | B.SPEAK) as Role[];
    expect(on(guest, true)).toEqual(['rooms', 'voice']);
    // Nothing loaded to count (boards never opened): the workspace bit decides.
    expect(rolePreview(base, false, { rooms: '0/0', boards: '0/0' }).find((i) => i.id === 'boards')?.on).toBe(true);
  });
});
