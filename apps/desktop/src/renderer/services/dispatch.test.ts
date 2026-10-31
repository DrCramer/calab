import { create } from '@bufbuild/protobuf';
import {
  DispatchEventSchema,
  PERMISSION_BITS,
  PermissionTargetType,
  RoleSchema,
  RoleUpdateSchema,
  RoomPermissionOverrideSchema,
  RoomPermissionsUpdateSchema,
  UserSchema,
  WorkspaceMemberSchema,
  WorkspaceMemberUpdateSchema,
  WorkspaceRole,
  MessageCreateSchema,
  MessageSchema,
  ReadySchema,
  MessageDeleteSchema,
  PeerReadSchema,
  ReadStateSchema,
  ReadStateUpdateSchema,
  RoomSchema,
  TypingStartSchema,
  RoomType,
  TimeFormat,
  WorkspaceSchema,
  WorkspaceUpdateSchema,
  WorkspaceSnapshotSchema,
  SipCallSchema,
  SipCallStatus,
  SipCallUpdateSchema,
  type DispatchEvent,
} from '@calaba/protocol';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});
vi.stubGlobal('document', { hasFocus: () => false });
vi.stubGlobal('window', globalThis);

const onIncomingMessage = vi.fn<(...a: unknown[]) => void>();
const loadMentions = vi.fn(() => Promise.resolve());
vi.mock('./voice', () => ({ voice: { leave: vi.fn(), currentRoomId: null, onMoved: vi.fn(), reconcileSelfState: vi.fn(), stopStream: vi.fn(), checkSeat: vi.fn(), onGatewayBack: vi.fn(), refreshRights: vi.fn() } }));
vi.mock('./chat', () => ({ resyncLoadedRooms: vi.fn(() => Promise.resolve()), resyncPins: vi.fn(() => Promise.resolve()), retryFailedLoads: vi.fn(() => Promise.resolve()) }));
vi.mock('./mentions', () => ({ loadMentions: () => loadMentions() }));
vi.mock('./notify', () => ({ onIncomingMessage: (...a: unknown[]) => {
    onIncomingMessage(...a);
  }, mentionsMe: () => false }));
vi.mock('./profile', () => ({ applyUserSettings: vi.fn() }));
vi.mock('../stores/toasts', () => ({ toast: { info: vi.fn(), error: vi.fn() } }));
vi.mock('../platform', () => ({ platform: { kind: 'web', app: { log: () => undefined } } }));

const { applyDispatch, TYPING_MS } = await import('./dispatch');
const { useMessages } = await import('../stores/messages');
const { useRooms } = await import('../stores/rooms');
const { useReadReceipts } = await import('../stores/readReceipts');
const { useTyping } = await import('../stores/typing');
const { useInbox } = await import('../stores/inbox');
const { useDms, HOME } = await import('../stores/dms');
const { useUi } = await import('../stores/ui');
const { useWorkspaces } = await import('../stores/workspaces');
const { installTimeFormat } = await import('./timeFormat');
const { getTimeFormat } = await import('../lib/format');
const { useSession } = await import('../stores/session');
const { rolesOf } = await import('../stores/workspaces');
const { mayInviteGuestsIn, mayInviteMembers, mayInviteToRoom } = await import('../lib/permissions');
const { useSipCalls } = await import('../stores/sipCalls');
const { useVoice } = await import('../stores/voice');
const { useStreamFullscreen } = await import('../features/voice/fullscreen');
const { ENDED_LINGER_MS, mayHangUp, statusKey } = await import('../lib/sip');

const WS = 'ws-1';
const id = (n: number): string => `0190a0b0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const room = (rid: string, lastMessageId = '') => create(RoomSchema, { id: rid, workspaceId: WS, type: RoomType.TEXT, name: rid, lastMessageId });

function ready(rooms: ReturnType<typeof room>[], reads: Array<[string, string, number?, number?]> = []): DispatchEvent {
  return create(DispatchEventSchema, {
    event: {
      case: 'ready',
      value: create(ReadySchema, {
        sessionId: 'gs',
        workspaces: [create(WorkspaceSnapshotSchema, { workspace: create(WorkspaceSchema, { id: WS, name: 'W' }), rooms })],
        readStates: reads.map(([roomId, lastReadMessageId, unreadCount = 0, mentionCount = 0]) =>
          create(ReadStateSchema, { roomId, lastReadMessageId, unreadCount, mentionCount }),
        ),
      }),
    },
  });
}

const messageCreate = (rid: string, n: number): DispatchEvent =>
  create(DispatchEventSchema, {
    event: { case: 'messageCreate', value: create(MessageCreateSchema, { workspaceId: WS, message: create(MessageSchema, { id: id(n), roomId: rid, authorId: 'other' }) }) },
  });

beforeEach(() => {
  useMessages.getState().reset();
  useRooms.getState().reset();
  onIncomingMessage.mockClear();
  loadMentions.mockClear();
});

describe('dispatch READY (re-IDENTIFY while the UI is up)', () => {
  it('keeps loaded windows; counters come from the READY read states; drops vanished rooms', () => {
    applyDispatch(ready([room('a', id(5)), room('b', id(9))], [['a', id(1), 4, 1], ['b', id(1), 8, 2]]));
    expect(useRooms.getState().unread).toEqual({ a: 4, b: 8 });
    expect(useRooms.getState().mentions).toEqual({ a: 1, b: 2 });
    useMessages.getState().setWindow('a', [create(MessageSchema, { id: id(5), roomId: 'a' })], false, false);
    useMessages.getState().setWindow('b', [create(MessageSchema, { id: id(9), roomId: 'b' })], false, false);
    useRooms.getState().addUnread('a', id(6), true);

    // Re-IDENTIFY: room b is gone; a's counters are the server's (they include what was missed).
    applyDispatch(ready([room('a', id(7))], [['a', id(1), 6, 3]]));
    expect(useMessages.getState().rooms['a']?.items).toHaveLength(1);
    expect(useMessages.getState().rooms['b']).toBeUndefined();
    expect(useRooms.getState().unread).toEqual({ a: 6 });
    expect(useRooms.getState().mentions).toEqual({ a: 3 });
    expect(loadMentions).toHaveBeenCalled(); // the inbox list is refreshed
  });

  it('the open history of an archived temporary room survives READY (#48)', async () => {
    const { useArchiveView } = await import('../stores/archiveView');
    applyDispatch(ready([room('a', id(5))]));
    const old = create(RoomSchema, { id: 'old', workspaceId: WS, type: RoomType.TEXT, name: 'old' });
    useArchiveView.getState().open(old);
    useMessages.getState().setWindow('old', [create(MessageSchema, { id: id(3), roomId: 'old' })], false, false);
    useMessages.getState().setWindow('gone', [create(MessageSchema, { id: id(4), roomId: 'gone' })], false, false);
    applyDispatch(ready([room('a', id(5))]));
    expect(useMessages.getState().rooms['old']?.items).toHaveLength(1);
    expect(useMessages.getState().rooms['gone']).toBeUndefined();
    useArchiveView.getState().close();
  });

  it('a room without a read state keeps its live counters across READY', () => {
    applyDispatch(ready([room('a', id(5))]));
    useRooms.getState().addUnread('a', id(6), true);
    applyDispatch(ready([room('a', id(6))]));
    expect(useRooms.getState().unread).toEqual({ a: 1 });
    expect(useRooms.getState().mentions).toEqual({ a: 1 });
  });

  it('drops the badge of a room read on another device meanwhile', () => {
    applyDispatch(ready([room('a', id(5))], [['a', id(1), 2, 1]]));
    applyDispatch(ready([room('a', id(5))], [['a', id(5)]]));
    expect(useRooms.getState().mentions['a']).toBeUndefined();
    expect(useRooms.getState().unread['a']).toBe(0);
  });

  it('READ_STATE_UPDATE clears the counters; a deleted unread message counts −1', () => {
    applyDispatch(ready([room('a', id(9))], [['a', id(1), 5, 2]]));
    // A deleted unread mention (the inbox has it) and a deleted unread plain message.
    useInbox.getState().addLive(create(MessageSchema, { id: id(8), roomId: 'a', authorId: 'other' }));
    applyDispatch(create(DispatchEventSchema, { event: { case: 'messageDelete', value: create(MessageDeleteSchema, { roomId: 'a', messageId: id(8) }) } }));
    applyDispatch(create(DispatchEventSchema, { event: { case: 'messageDelete', value: create(MessageDeleteSchema, { roomId: 'a', messageId: id(7) }) } }));
    expect(useRooms.getState().unread['a']).toBe(3);
    expect(useRooms.getState().mentions['a']).toBe(1);
    // An already read message deleted: nothing changes.
    applyDispatch(create(DispatchEventSchema, { event: { case: 'messageDelete', value: create(MessageDeleteSchema, { roomId: 'a', messageId: id(1) }) } }));
    expect(useRooms.getState().unread['a']).toBe(3);
    applyDispatch(
      create(DispatchEventSchema, {
        event: { case: 'readStateUpdate', value: create(ReadStateUpdateSchema, { readState: create(ReadStateSchema, { roomId: 'a', lastReadMessageId: id(9) }) }) },
      }),
    );
    expect(useRooms.getState().unread['a']).toBe(0);
    expect(useRooms.getState().mentions['a']).toBeUndefined();
  });

  it('read receipts (docs/09 #92): READY replaces them, READ_RECEIPT only moves forward', () => {
    useReadReceipts.getState().set('gone', id(3));
    const r = ready([room('a'), room('b')]);
    if (r.event.case === 'ready') r.event.value.peerReads = [create(PeerReadSchema, { roomId: 'a', lastReadMessageId: id(5) })];
    applyDispatch(r);
    expect(useReadReceipts.getState().byRoom).toEqual({ a: id(5) });
    const receipt = (rid: string, n: number): DispatchEvent =>
      create(DispatchEventSchema, { event: { case: 'readReceipt', value: create(PeerReadSchema, { roomId: rid, lastReadMessageId: id(n) }) } });
    applyDispatch(receipt('a', 7));
    applyDispatch(receipt('a', 6)); // stale
    applyDispatch(receipt('b', 2));
    expect(useReadReceipts.getState().byRoom).toEqual({ a: id(7), b: id(2) });
  });

  it('a replayed MESSAGE_CREATE counts once (no double badge / sound)', () => {
    applyDispatch(ready([room('a')]));
    applyDispatch(messageCreate('a', 100));
    applyDispatch(messageCreate('a', 100));
    expect(onIncomingMessage).toHaveBeenCalledTimes(1);
    applyDispatch(messageCreate('a', 101));
    expect(onIncomingMessage).toHaveBeenCalledTimes(2);
  });

  it('READY and RESUMED run the voice seat check (docs/09 #71)', async () => {
    const { voice } = await import('./voice');
    const check = vi.spyOn(voice, 'checkSeat');
    check.mockClear();
    applyDispatch(ready([room('a')]));
    applyDispatch(create(DispatchEventSchema, { event: { case: 'resumed', value: { replayed: 3 } } }));
    expect(check).toHaveBeenCalledTimes(2);
  });
});

describe('dispatch TYPING_START', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('expires on local time even when the server clock is far ahead (review N8)', async () => {
    vi.useFakeTimers();
    useTyping.getState().reset();
    const serverAhead = Date.now() + 10 * 60_000;
    applyDispatch(
      create(DispatchEventSchema, {
        event: { case: 'typingStart', value: create(TypingStartSchema, { roomId: 'a', userId: 'other', timestamp: timestampFromMs(serverAhead) }) },
      }),
    );
    const until = useTyping.getState().rooms['a']?.['other'];
    expect(until).toBeDefined();
    expect(until).toBeLessThanOrEqual(Date.now() + TYPING_MS);
    await vi.advanceTimersByTimeAsync(TYPING_MS + 100);
    expect(useTyping.getState().rooms['a']?.['other']).toBeUndefined();
  });
});

describe('DM_STATE_UPDATE (docs/09 #51)', () => {
  const dmReady = (): DispatchEvent =>
    create(DispatchEventSchema, {
      event: {
        case: 'ready',
        value: create(ReadySchema, {
          sessionId: 'gs',
          dms: [
            {
              room: { id: 'd', type: RoomType.DM, lastMessageId: id(3), createdAt: timestampFromMs(1000) },
              peer: { id: 'p', displayName: 'P' },
              lastMessage: { id: id(3), authorId: 'p', content: 'old', attachmentCount: 0, createdAt: timestampFromMs(2000) },
            },
          ],
          readStates: [create(ReadStateSchema, { roomId: 'd', lastReadMessageId: id(1), unreadCount: 2, mentionCount: 2 })],
        }),
      },
    });
  const state = (archivedAt: number, cleared: string): DispatchEvent =>
    create(DispatchEventSchema, {
      event: { case: 'dmStateUpdate', value: { roomId: 'd', clearedBeforeMessageId: cleared, ...(archivedAt ? { archivedAt: timestampFromMs(archivedAt) } : {}) } },
    });

  it('archives and un-archives; a new clear mark drops the history, counters and the open chat', () => {
    applyDispatch(dmReady());
    applyDispatch(state(5000, ''));
    expect(useDms.getState().byRoom['d']).toMatchObject({ archivedAt: 5000, clearedBefore: '' });
    applyDispatch(state(0, ''));
    expect(useDms.getState().byRoom['d']?.archivedAt).toBe(0);

    useUi.getState().openRoom(HOME, 'd');
    useMessages.getState().setWindow('d', [create(MessageSchema, { id: id(3), roomId: 'd' })], false, false);
    applyDispatch(state(0, id(4)));
    expect(useMessages.getState().rooms['d']).toBeUndefined();
    expect(useRooms.getState().unread['d']).toBe(0);
    expect(useRooms.getState().mentions['d'] ?? 0).toBe(0);
    expect(useDms.getState().preview['d']).toBeNull();
    expect(useUi.getState().lastRoom[HOME]).toBe('');
    // A stale (older) mark never brings the hidden history back.
    applyDispatch(state(0, id(2)));
    expect(useDms.getState().byRoom['d']?.clearedBefore).toBe(id(4));
  });
});

describe('WORKSPACE_UPDATE → clock format (docs/09 #73)', () => {
  const update = (wsId: string, timeFormat: TimeFormat): DispatchEvent =>
    create(DispatchEventSchema, {
      event: { case: 'workspaceUpdate', value: create(WorkspaceUpdateSchema, { workspace: create(WorkspaceSchema, { id: wsId, name: 'W', timeFormat }) }) },
    });

  it('the current workspace format applies live; another one does not; DMs follow the last one opened', () => {
    const off = installTimeFormat();
    try {
      applyDispatch(ready([room('a', id(1))]));
      useUi.getState().setWorkspace(WS);
      expect(getTimeFormat()).toBe('auto');

      applyDispatch(update(WS, TimeFormat.H12));
      expect(getTimeFormat()).toBe('h12');
      applyDispatch(update(WS, TimeFormat.H24));
      expect(getTimeFormat()).toBe('h24');

      // Another workspace (not open) changing its format leaves ours alone.
      useWorkspaces.getState().applySnapshot(create(WorkspaceSnapshotSchema, { workspace: create(WorkspaceSchema, { id: 'ws-2', name: 'Other' }) }));
      applyDispatch(update('ws-2', TimeFormat.H12));
      expect(getTimeFormat()).toBe('h24');

      // «Личные» (DMs): the workspace opened last; opening the other one switches.
      useUi.getState().setWorkspace(HOME);
      expect(getTimeFormat()).toBe('h24');
      useUi.getState().setWorkspace('ws-2');
      expect(getTimeFormat()).toBe('h12');

      // UNSPECIFIED (an older server) reads as auto; no workspace at all: auto.
      applyDispatch(update('ws-2', TimeFormat.UNSPECIFIED));
      expect(getTimeFormat()).toBe('auto');
      applyDispatch(update(WS, TimeFormat.H12));
      useWorkspaces.getState().reset();
      expect(getTimeFormat()).toBe('auto');
    } finally {
      off();
    }
  });
});

// Part B of ADR-0043: rights granted or taken apply to my UI at once — the gated UI reads
// useMemberRoles (= rolesOf over the store) and the room's overrides, both updated by dispatch.
describe('dispatch: my roles and their permissions apply live (ADR-0026, ADR-0043)', () => {
  const ME = 'me';
  const MEMBER_BITS = PERMISSION_BITS.VIEW_ROOM | PERMISSION_BITS.SEND_MESSAGES | PERMISSION_BITS.CONNECT;
  const roles = [
    create(RoleSchema, { id: 'owner', workspaceId: WS, position: 1001, permissions: PERMISSION_BITS.ADMINISTRATOR, builtin: WorkspaceRole.OWNER }),
    create(RoleSchema, { id: 'hr', workspaceId: WS, position: 2, permissions: PERMISSION_BITS.INVITE_MEMBERS }),
    create(RoleSchema, { id: 'member', workspaceId: WS, position: 1, permissions: MEMBER_BITS, builtin: WorkspaceRole.MEMBER }),
  ];
  const me = (roleIds: string[]) =>
    create(WorkspaceMemberSchema, { workspaceId: WS, user: create(UserSchema, { id: ME, displayName: 'Me' }), role: WorkspaceRole.MEMBER, roleIds });
  const entry = () => useWorkspaces.getState().byId[WS];
  const r1 = room('r1');

  beforeEach(() => {
    useSession.setState({ me: { user: create(UserSchema, { id: ME }) } } as never);
    useWorkspaces.getState().reset();
    useWorkspaces.getState().applySnapshot(
      create(WorkspaceSnapshotSchema, { workspace: create(WorkspaceSchema, { id: WS, name: 'W' }), role: WorkspaceRole.MEMBER, roles, members: [me(['member'])] }),
    );
    useRooms.getState().upsert(r1);
  });

  it('WORKSPACE_MEMBER_UPDATE with a new role, then ROLE_UPDATE of its bits', () => {
    expect(mayInviteMembers(rolesOf(entry(), ME))).toBe(false);
    applyDispatch(create(DispatchEventSchema, { event: { case: 'workspaceMemberUpdate', value: create(WorkspaceMemberUpdateSchema, { member: me(['member', 'hr']) }) } }));
    expect(rolesOf(entry(), ME).map((r) => r.id)).toEqual(['hr', 'member']);
    expect(mayInviteMembers(rolesOf(entry(), ME))).toBe(true);

    const edited = create(RoleSchema, { id: 'hr', workspaceId: WS, position: 2, permissions: 0n });
    applyDispatch(create(DispatchEventSchema, { event: { case: 'roleUpdate', value: create(RoleUpdateSchema, { role: edited }) } }));
    expect(mayInviteMembers(rolesOf(entry(), ME))).toBe(false);

    applyDispatch(create(DispatchEventSchema, { event: { case: 'workspaceMemberUpdate', value: create(WorkspaceMemberUpdateSchema, { member: me(['member']) }) } }));
    expect(rolesOf(entry(), ME).map((r) => r.id)).toEqual(['member']);
  });

  it('ROOM_PERMISSIONS_UPDATE grants a room invite right in that room only', () => {
    const inRoom = () => mayInviteGuestsIn(rolesOf(entry(), ME), ME, useRooms.getState().byId['r1']);
    expect(inRoom()).toBe(false);
    const ov = create(RoomPermissionOverrideSchema, { targetType: PermissionTargetType.USER, targetId: ME, allow: PERMISSION_BITS.INVITE_GUESTS, deny: 0n });
    applyDispatch(create(DispatchEventSchema, { event: { case: 'roomPermissionsUpdate', value: create(RoomPermissionsUpdateSchema, { roomId: 'r1', permissions: [ov] }) } }));
    expect(inRoom()).toBe(true);
    expect(mayInviteToRoom(rolesOf(entry(), ME), ME, useRooms.getState().byId['r1'])).toBe(true);
    // Not workspace-wide, and MANAGE_ROOM alone would not do.
    expect(mayInviteMembers(rolesOf(entry(), ME))).toBe(false);
    const manage = create(RoomPermissionOverrideSchema, { targetType: PermissionTargetType.USER, targetId: ME, allow: PERMISSION_BITS.MANAGE_ROOM, deny: 0n });
    applyDispatch(create(DispatchEventSchema, { event: { case: 'roomPermissionsUpdate', value: create(RoomPermissionsUpdateSchema, { roomId: 'r1', permissions: [manage] }) } }));
    expect(inRoom()).toBe(false);
  });

  it('a guest never gets the invite helpers, even with an allow', () => {
    const guestRole = create(RoleSchema, { id: 'guest', workspaceId: WS, position: 0, permissions: PERMISSION_BITS.CONNECT, builtin: WorkspaceRole.GUEST });
    const host = create(RoleSchema, { id: 'host', workspaceId: WS, position: 3, permissions: PERMISSION_BITS.INVITE_GUESTS | PERMISSION_BITS.INVITE_MEMBERS });
    expect(mayInviteMembers([guestRole, host])).toBe(false);
    expect(mayInviteMembers([...roles.slice(2), host])).toBe(true);
  });
});

// Issue #35: the stream stage (and stream full screen) covers the open room's feed — a message
// behind it is not «on screen», so it must arrive as unread (visible = false → addUnread).
describe('MESSAGE_CREATE while the stream viewer covers the feed (#35)', () => {
  const stream = { trackSid: 't1', userId: 'u2', identity: 'u2:s', hasAudio: false };
  /** `visible` arg of the last onIncomingMessage call (message, workspaceId, visible). */
  const lastVisible = (): unknown => onIncomingMessage.mock.calls.at(-1)?.[2];

  afterEach(() => {
    useVoice.getState().set({ roomId: null, workspaceId: null, stage: 'pip', streams: [], watching: null });
    useStreamFullscreen.setState({ on: false });
    useUi.setState({ activeWorkspaceId: null, lastRoom: {} });
    vi.stubGlobal('document', { hasFocus: () => false });
  });

  it('expanded stage hides the open room’s feed; the PiP does not', () => {
    vi.stubGlobal('document', { hasFocus: () => true });
    applyDispatch(ready([room('a'), room('b')]));
    useUi.getState().openRoom(WS, 'a');
    useVoice.getState().set({ roomId: 'a', workspaceId: WS, stage: 'expanded', streams: [stream], watching: 't1' });
    applyDispatch(messageCreate('a', 200));
    expect(lastVisible()).toBe(false);

    useVoice.getState().set({ stage: 'pip' });
    applyDispatch(messageCreate('a', 201));
    expect(lastVisible()).toBe(true);
  });

  it('pop-out and stream full screen hide it too', () => {
    vi.stubGlobal('document', { hasFocus: () => true });
    applyDispatch(ready([room('a')]));
    useUi.getState().openRoom(WS, 'a');
    useVoice.getState().set({ roomId: 'a', workspaceId: WS, stage: 'popout', streams: [stream], watching: 't1' });
    applyDispatch(messageCreate('a', 210));
    expect(lastVisible()).toBe(false);

    useVoice.getState().set({ stage: 'pip' });
    useStreamFullscreen.setState({ on: true });
    applyDispatch(messageCreate('a', 211));
    expect(lastVisible()).toBe(false);
  });

  it('a covered voice room does not mark another open room hidden', () => {
    vi.stubGlobal('document', { hasFocus: () => true });
    applyDispatch(ready([room('a'), room('b')]));
    useUi.getState().openRoom(WS, 'b');
    useVoice.getState().set({ roomId: 'a', workspaceId: WS, stage: 'expanded', streams: [stream], watching: 't1' });
    applyDispatch(messageCreate('b', 220));
    expect(lastVisible()).toBe(true);
    // The covered room is not the open one either way.
    applyDispatch(messageCreate('a', 221));
    expect(lastVisible()).toBe(false);
  });
});

describe('SIP_CALL_UPDATE of someone else\'s call (ADR-0046)', () => {
  const CALLER = id(41);
  const sipEvent = (status: SipCallStatus, reason = ''): DispatchEvent =>
    create(DispatchEventSchema, {
      event: {
        case: 'sipCallUpdate',
        value: create(SipCallUpdateSchema, {
          call: create(SipCallSchema, { id: 'c1', workspaceId: WS, roomId: 'v1', number: '+79161234567', startedBy: CALLER, status, reason, participantIdentity: 'sip:c1' }),
        }),
      },
    });
  afterEach(() => vi.useRealTimers());

  it('shows the line from DIALING on (before any answer) and drops it for everyone after a busy', () => {
    vi.useFakeTimers();
    useSipCalls.getState().set({});
    applyDispatch(sipEvent(SipCallStatus.DIALING));
    const line = useSipCalls.getState().byRoom['v1'];
    expect(line?.status).toBe(SipCallStatus.DIALING);
    expect(line?.number).toBe('+79161234567');
    expect(statusKey(line?.status ?? SipCallStatus.UNSPECIFIED)).toBe('sip.status.dialing');
    // «Завершить» while it rings: a MUTE_MEMBERS holder yes, a plain member no.
    expect(mayHangUp({ me: 'mod', startedBy: CALLER, muteMembers: true, live: true })).toBe(true);
    expect(mayHangUp({ me: 'member', startedBy: CALLER, muteMembers: false, live: true })).toBe(false);

    applyDispatch(sipEvent(SipCallStatus.FAILED, 'busy'));
    expect(useSipCalls.getState().byRoom['v1']?.status).toBe(SipCallStatus.FAILED);
    vi.advanceTimersByTime(ENDED_LINGER_MS);
    expect(useSipCalls.getState().byRoom['v1']).toBeUndefined();
  });
});
