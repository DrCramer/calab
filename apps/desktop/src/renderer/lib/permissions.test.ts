import { create } from '@bufbuild/protobuf';
import { PERMISSION_BITS, PermissionTargetType, RoleSchema, RoomPermissionOverrideSchema, RoomSchema, WorkspaceRole, type Role } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import {
  can,
  compactDrafts,
  cycleTri,
  isAdminRole,
  mayArrangeRooms,
  mayCreateTempRooms,
  mayManageRoom,
  mayManageWorkspace,
  mayModerateVoice,
  mayMoveMembersIn,
  mayMoveVoice,
  roomPerms,
  setOwnerSeesPrivate,
  triOf,
  voiceCaps,
  withTri,
  workspacePerms,
} from './permissions';
import { legacyRoles, rolesOfMember } from './roles';

const { VIEW_ROOM, SEND_MESSAGES, STREAM, MANAGE_ROOM, MUTE_MEMBERS, CONNECT, SPEAK } = PERMISSION_BITS;

function room(overrides: { t: PermissionTargetType; id: string; allow?: bigint; deny?: bigint }[]) {
  return create(RoomSchema, {
    id: 'r1',
    permissionOverrides: overrides.map((o) =>
      create(RoomPermissionOverrideSchema, { targetType: o.t, targetId: o.id, allow: o.allow ?? 0n, deny: o.deny ?? 0n }),
    ),
  });
}

// Built-ins with their legacy ids ("member"…) plus two custom roles (ADR-0026).
const design = create(RoleSchema, { id: 'r-design', name: 'Design', position: 3, permissions: STREAM, color: 0x0a84ff });
const mod = create(RoleSchema, { id: 'r-mod', name: 'Moderator', position: 2, permissions: MUTE_MEMBERS | MANAGE_ROOM, color: 0x34c759 });
const ALL: Role[] = [...legacyRoles('w'), design, mod];

/** A member's roles: the built-ins implied by `role` + the given custom roles. */
const as = (role: WorkspaceRole, ...custom: Role[]): Role[] => [...rolesOfMember(ALL, { role, roleIds: [] }), ...custom];

describe('roomPerms', () => {
  it('member defaults allow chat, not management', () => {
    const p = roomPerms(as(WorkspaceRole.MEMBER), 'u1', room([]));
    expect(can(p, 'SEND_MESSAGES')).toBe(true);
    expect(can(p, 'MANAGE_ROOM')).toBe(false);
  });

  it('private room: member denied, specific user allowed', () => {
    const r = room([
      { t: PermissionTargetType.ROLE, id: 'member', deny: VIEW_ROOM },
      { t: PermissionTargetType.USER, id: 'u2', allow: VIEW_ROOM },
    ]);
    expect(roomPerms(as(WorkspaceRole.MEMBER), 'u1', r)).toBe(0n);
    expect(can(roomPerms(as(WorkspaceRole.MEMBER), 'u2', r), 'VIEW_ROOM')).toBe(true);
  });

  it('admin ignores deny', () => {
    const r = room([{ t: PermissionTargetType.ROLE, id: 'admin', deny: VIEW_ROOM | STREAM }]);
    expect(can(roomPerms(as(WorkspaceRole.ADMIN), 'a', r), 'STREAM')).toBe(true);
  });

  it('private room (ADR-0078 addendum 2026-10-14): admins and the owner count as members; the owner sees all only with «Владелец видит приватное»', () => {
    const r = room([
      { t: PermissionTargetType.ROLE, id: 'member', deny: VIEW_ROOM },
      { t: PermissionTargetType.USER, id: 'a2', allow: VIEW_ROOM },
    ]);
    r.restricted = true;
    r.workspaceId = 'w-private';
    expect(roomPerms(as(WorkspaceRole.ADMIN), 'a', r)).toBe(0n);
    const listed = roomPerms(as(WorkspaceRole.ADMIN), 'a2', r);
    expect(can(listed, 'VIEW_ROOM') && can(listed, 'SEND_MESSAGES')).toBe(true);
    expect(can(listed, 'MANAGE_ROOM')).toBe(false);
    expect(roomPerms(as(WorkspaceRole.OWNER), 'o', r)).toBe(0n);
    setOwnerSeesPrivate(r.workspaceId, true);
    expect(can(roomPerms(as(WorkspaceRole.OWNER), 'o', r), 'MANAGE_ROOM')).toBe(true);
    expect(roomPerms(as(WorkspaceRole.ADMIN), 'a', r)).toBe(0n);
    setOwnerSeesPrivate(r.workspaceId, false);
    // Not private: the admin bypass is back.
    r.restricted = false;
    expect(can(roomPerms(as(WorkspaceRole.ADMIN), 'a', r), 'MANAGE_ROOM')).toBe(true);
  });

  it('guest sees nothing without explicit allow', () => {
    expect(roomPerms(as(WorkspaceRole.GUEST), 'g', room([]))).toBe(0n);
    const r = room([{ t: PermissionTargetType.ROLE, id: 'guest', allow: VIEW_ROOM | SEND_MESSAGES }]);
    expect(can(roomPerms(as(WorkspaceRole.GUEST), 'g', r), 'SEND_MESSAGES')).toBe(true);
  });

  it('unknown room / no roles → no permissions', () => {
    expect(roomPerms(undefined, 'u', room([]))).toBe(0n);
    expect(roomPerms([], 'u', room([]))).toBe(0n);
    expect(roomPerms(as(WorkspaceRole.MEMBER), 'u', undefined)).toBe(0n);
  });

  it('several roles: workspace bits are the OR, overrides go lowest position first', () => {
    // Custom role bits add up with the member defaults.
    const p = roomPerms(as(WorkspaceRole.MEMBER, mod), 'u', room([]));
    expect(can(p, 'MUTE_MEMBERS') && can(p, 'MANAGE_ROOM') && can(p, 'SEND_MESSAGES')).toBe(true);
    // A private room: member denied, Design (higher) allowed → the senior role wins.
    const priv = room([
      { t: PermissionTargetType.ROLE, id: 'member', deny: VIEW_ROOM },
      { t: PermissionTargetType.ROLE, id: design.id, allow: VIEW_ROOM },
    ]);
    expect(roomPerms(as(WorkspaceRole.MEMBER), 'u', priv)).toBe(0n);
    expect(can(roomPerms(as(WorkspaceRole.MEMBER, design), 'u', priv), 'VIEW_ROOM')).toBe(true);
    // Moderator (2) allows SPEAK, Design (3) denies it: the higher position applies last.
    const voice = room([
      { t: PermissionTargetType.ROLE, id: mod.id, allow: SPEAK },
      { t: PermissionTargetType.ROLE, id: design.id, deny: SPEAK | CONNECT },
    ]);
    const both = roomPerms(as(WorkspaceRole.MEMBER, mod, design), 'u', voice);
    expect(can(both, 'SPEAK')).toBe(false);
    expect(can(both, 'CONNECT')).toBe(false);
    // … and the user's own override beats every role.
    const user = room([
      { t: PermissionTargetType.ROLE, id: design.id, deny: SPEAK },
      { t: PermissionTargetType.USER, id: 'u', allow: SPEAK },
    ]);
    expect(can(roomPerms(as(WorkspaceRole.MEMBER, design), 'u', user), 'SPEAK')).toBe(true);
  });
});

describe('workspace level', () => {
  it('admins get everything; custom roles add their bits', () => {
    expect(can(workspacePerms(as(WorkspaceRole.OWNER)), 'MANAGE_WORKSPACE')).toBe(true);
    expect(can(workspacePerms(as(WorkspaceRole.MEMBER)), 'MANAGE_WORKSPACE')).toBe(false);
    expect(can(workspacePerms(as(WorkspaceRole.MEMBER, mod)), 'MANAGE_ROOM')).toBe(true);
    expect(workspacePerms(undefined)).toBe(0n);
    expect(isAdminRole(WorkspaceRole.ADMIN)).toBe(true);
    expect(isAdminRole(WorkspaceRole.MEMBER)).toBe(false);
  });
});

describe('drag & drop gates (rooms, categories, voice participants)', () => {
  const MOVE = PERMISSION_BITS.MOVE_MEMBERS;
  it('admin and owner arrange rooms and move members; a member without the bits does not', () => {
    for (const r of [WorkspaceRole.OWNER, WorkspaceRole.ADMIN]) {
      expect(mayArrangeRooms(as(r))).toBe(true);
      // ADMINISTRATOR = everything: a room deny does not stop an admin.
      expect(mayMoveMembersIn(as(r), 'a', room([{ t: PermissionTargetType.ROLE, id: 'admin', deny: MOVE }]))).toBe(true);
    }
    expect(mayArrangeRooms(as(WorkspaceRole.MEMBER))).toBe(false);
    expect(mayMoveMembersIn(as(WorkspaceRole.MEMBER), 'u', room([]))).toBe(false);
    expect(mayArrangeRooms(as(WorkspaceRole.GUEST))).toBe(false);
    expect(mayArrangeRooms(undefined)).toBe(false);
  });

  it('a custom role or a room grant gives the bit', () => {
    // «Moderator» carries MANAGE_ROOM at the workspace level.
    expect(mayArrangeRooms(as(WorkspaceRole.MEMBER, mod))).toBe(true);
    const grant = room([{ t: PermissionTargetType.ROLE, id: design.id, allow: MOVE }]);
    expect(mayMoveMembersIn(as(WorkspaceRole.MEMBER), 'u', grant)).toBe(false);
    expect(mayMoveMembersIn(as(WorkspaceRole.MEMBER, design), 'u', grant)).toBe(true);
  });
});

describe('tri-state editor', () => {
  it('cycles inherit → allow → deny → inherit and keeps bits exclusive', () => {
    let o = { allow: 0n, deny: 0n };
    expect(triOf(o, MANAGE_ROOM)).toBe('inherit');
    o = withTri(o, MANAGE_ROOM, cycleTri(triOf(o, MANAGE_ROOM)));
    expect(triOf(o, MANAGE_ROOM)).toBe('allow');
    o = withTri(o, MANAGE_ROOM, cycleTri(triOf(o, MANAGE_ROOM)));
    expect(triOf(o, MANAGE_ROOM)).toBe('deny');
    expect(o.allow & MANAGE_ROOM).toBe(0n);
    o = withTri(o, MANAGE_ROOM, cycleTri(triOf(o, MANAGE_ROOM)));
    expect(o).toEqual({ allow: 0n, deny: 0n });
  });

  it('compact drops empty overrides', () => {
    const drafts = [
      { targetType: PermissionTargetType.ROLE, targetId: 'member', allow: 0n, deny: 0n },
      { targetType: PermissionTargetType.USER, targetId: 'u', allow: VIEW_ROOM, deny: 0n },
    ];
    expect(compactDrafts(drafts)).toHaveLength(1);
  });
});

describe('permissions matrix: the client gates what the server checks (docs/16)', () => {
  const wsMgr = create(RoleSchema, { id: 'r-ws', name: 'Managers', position: 4, permissions: PERMISSION_BITS.MANAGE_WORKSPACE });

  it('workspace management follows MANAGE_WORKSPACE, a custom role included', () => {
    expect(mayManageWorkspace(as(WorkspaceRole.OWNER))).toBe(true);
    expect(mayManageWorkspace(as(WorkspaceRole.ADMIN))).toBe(true);
    expect(mayManageWorkspace(as(WorkspaceRole.MEMBER))).toBe(false);
    expect(mayManageWorkspace(as(WorkspaceRole.GUEST))).toBe(false);
    expect(mayManageWorkspace(as(WorkspaceRole.MEMBER, wsMgr))).toBe(true);
    // Moderator has MUTE_MEMBERS | MANAGE_ROOM, not MANAGE_WORKSPACE.
    expect(mayManageWorkspace(as(WorkspaceRole.MEMBER, mod))).toBe(false);
    expect(mayManageWorkspace(undefined)).toBe(false);
  });

  it('voice moderation hierarchy mirrors rtc.outranks', () => {
    const { OWNER, ADMIN, MEMBER, GUEST } = WorkspaceRole;
    // [me, target, allowed]
    const cases: Array<[WorkspaceRole, WorkspaceRole, boolean]> = [
      [OWNER, ADMIN, true],
      [OWNER, MEMBER, true],
      [ADMIN, ADMIN, false],
      [ADMIN, OWNER, false],
      [ADMIN, MEMBER, true],
      [ADMIN, GUEST, true],
      [MEMBER, MEMBER, true],
      [MEMBER, ADMIN, false],
      [GUEST, MEMBER, true],
    ];
    for (const [me, target, ok] of cases) expect(mayModerateVoice(me, target, false), `${me} → ${target}`).toBe(ok);
    // Oneself: always (the server skips the hierarchy).
    expect(mayModerateVoice(ADMIN, ADMIN, true)).toBe(true);
  });

  it('move hierarchy (rtc.mayMove, docs/09 #54): admins move admins and the owner', () => {
    const { OWNER, ADMIN, MEMBER, GUEST } = WorkspaceRole;
    const cases: Array<[WorkspaceRole, WorkspaceRole, boolean]> = [
      [OWNER, ADMIN, true],
      [ADMIN, ADMIN, true],
      [ADMIN, OWNER, true],
      [ADMIN, MEMBER, true],
      [MEMBER, MEMBER, true],
      [MEMBER, ADMIN, false],
      [MEMBER, OWNER, false],
      [GUEST, MEMBER, true],
    ];
    for (const [me, target, ok] of cases) expect(mayMoveVoice(me, target, false), `${me} → ${target}`).toBe(ok);
  });

  it('call buttons: STREAM, VIDEO and a room that allows cameras', () => {
    const cams = create(RoomSchema, { id: 'v', media: { cameraLimit: 4 } });
    const noCams = create(RoomSchema, { id: 'v', media: { cameraLimit: 0 } });
    expect(voiceCaps(roomPerms(as(WorkspaceRole.MEMBER), 'u', cams), cams)).toEqual({ canStream: true, canVideo: true });
    expect(voiceCaps(roomPerms(as(WorkspaceRole.MEMBER), 'u', noCams), noCams)).toEqual({ canStream: true, canVideo: false });
    // A room override taking STREAM + VIDEO from the member role (applied live by voice.refreshRights).
    const denied = create(RoomSchema, {
      id: 'v',
      media: { cameraLimit: 4 },
      permissionOverrides: [
        create(RoomPermissionOverrideSchema, { targetType: PermissionTargetType.ROLE, targetId: 'member', deny: STREAM | PERMISSION_BITS.VIDEO }),
      ],
    });
    expect(voiceCaps(roomPerms(as(WorkspaceRole.MEMBER), 'u', denied), denied)).toEqual({ canStream: false, canVideo: false });
    expect(voiceCaps(roomPerms(as(WorkspaceRole.ADMIN), 'u', denied), denied)).toEqual({ canStream: true, canVideo: true });
    expect(voiceCaps(0n, undefined)).toEqual({ canStream: false, canVideo: false });
  });
});

describe('temporary rooms (ADR-0044)', () => {
  const temp = (createdBy: string) => create(RoomSchema, { id: 't1', createdBy, expiresAt: { seconds: 2_000_000_000n, nanos: 0 } });

  it('members create them by default; guests never', () => {
    expect(mayCreateTempRooms(as(WorkspaceRole.MEMBER))).toBe(true);
    expect(mayCreateTempRooms(as(WorkspaceRole.GUEST))).toBe(false);
    expect(mayCreateTempRooms(undefined)).toBe(false);
  });

  it('the creator manages their temporary room; others need MANAGE_ROOM', () => {
    expect(mayManageRoom(as(WorkspaceRole.MEMBER), 'u1', temp('u1'))).toBe(true);
    expect(mayManageRoom(as(WorkspaceRole.MEMBER), 'u2', temp('u1'))).toBe(false);
    expect(mayManageRoom(as(WorkspaceRole.MEMBER, mod), 'u2', temp('u1'))).toBe(true);
    expect(mayManageRoom(as(WorkspaceRole.GUEST), 'u1', temp('u1'))).toBe(false);
  });

  it('created_by gives nothing on a permanent room', () => {
    expect(mayManageRoom(as(WorkspaceRole.MEMBER), 'u1', create(RoomSchema, { id: 'p', createdBy: 'u1' }))).toBe(false);
  });
});
