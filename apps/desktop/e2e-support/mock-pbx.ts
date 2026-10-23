import { create, type MessageShape } from '@bufbuild/protobuf';
import type { Timestamp } from '@bufbuild/protobuf/wkt';
import {
  ErrorCode,
  SipExtensionKind,
  SipExtensionSchema,
  SipGroupMemberSchema,
  SipGroupSchema,
  SipGroupStrategy,
  SipIvrItemSchema,
  SipIvrMenuSchema,
  SipPromptStatus,
  SipRouteKind,
  SipRouteTargetSchema,
  type CreateSipExtensionRequestSchema,
  type CreateSipGroupRequestSchema,
  type CreateSipIvrMenuRequestSchema,
  type SipExtension,
  type SipGroup,
  type SipIvrMenu,
  type SipRouteTarget,
  type UpdateSipExtensionRequestSchema,
  type UpdateSipGroupRequestSchema,
  type UpdateSipIvrMenuRequestSchema,
} from '@calaba/protocol';

/**
 * The telephony exchange of the mock API (ADR-0117 step 1, sip.proto): internal numbers, groups
 * and voice menus of a workspace in memory, with the server's main rules — 2..6 digit numbers
 * unique in the workspace, one number per member (not a guest), group members are person / bot
 * numbers, targets of this workspace; deleting never fails because of a route, the route comes
 * back `missing`. A prompt «upload» takes the source file id as the prompt (42 s).
 */

export interface MockPbx {
  exts: SipExtension[];
  groups: SipGroup[];
  menus: SipIvrMenu[];
}

export const emptyPbx = (): MockPbx => ({ exts: [], groups: [], menus: [] });

export class PbxError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly field: string,
  ) {
    super(message);
  }
}

const invalid = (field: string): PbxError => new PbxError(422, ErrorCode.VALIDATION, `invalid ${field}`, field);
const taken = (field: string): PbxError => new PbxError(409, ErrorCode.SIP_EXTENSION_TAKEN, `${field} taken`, field);
export const PROMPT_MS = 42_000;

/** Who may hold a number: a member of the workspace that is not a guest; bot = the user is a bot. */
export interface PbxMembers {
  eligible: (userId: string) => boolean;
  isBot: (userId: string) => boolean;
}

function checkNumber(p: MockPbx, number: string, self?: string): void {
  if (!/^\d{2,6}$/.test(number)) throw invalid('number');
  if (p.exts.some((e) => e.number === number && e.id !== self)) throw taken('number');
}

function checkUser(p: MockPbx, m: PbxMembers, userId: string, self?: string): void {
  if (!m.eligible(userId)) throw invalid('userId');
  if (p.exts.some((e) => e.userId === userId && e.id !== self)) throw taken('userId');
}

const trimmed = (s: string, max: number, field: string, required: boolean): string => {
  const v = s.trim();
  if ((required && !v) || Array.from(v).length > max) throw invalid(field);
  return v;
};

/** A route of a request checked against the exchange; a group's number becomes the group. */
function target(p: MockPbx, t: MessageShape<typeof SipRouteTargetSchema> | undefined, field: string, allowRepeat: boolean): SipRouteTarget {
  const kind = t?.kind ?? SipRouteKind.UNSPECIFIED;
  if (kind === SipRouteKind.UNSPECIFIED || kind === SipRouteKind.HANGUP) return create(SipRouteTargetSchema, { kind: SipRouteKind.HANGUP });
  if (kind === SipRouteKind.REPEAT) {
    if (!allowRepeat) throw invalid(field);
    return create(SipRouteTargetSchema, { kind });
  }
  const id = t?.id ?? '';
  if (kind === SipRouteKind.MENU && p.menus.some((m) => m.id === id)) return create(SipRouteTargetSchema, { kind, id });
  if (kind === SipRouteKind.GROUP && p.groups.some((g) => g.id === id)) return create(SipRouteTargetSchema, { kind, id });
  if (kind === SipRouteKind.EXTENSION) {
    const e = p.exts.find((x) => x.id === id);
    if (e?.kind === SipExtensionKind.GROUP) return create(SipRouteTargetSchema, { kind: SipRouteKind.GROUP, id: e.groupId });
    if (e) return create(SipRouteTargetSchema, { kind, id });
  }
  throw invalid(field);
}

/** A stored route as the API returns it: a deleted target is `missing` with an empty id. */
function resolved(p: MockPbx, t: SipRouteTarget | undefined): SipRouteTarget {
  const r = create(SipRouteTargetSchema, { kind: t?.kind ?? SipRouteKind.HANGUP, id: t?.id ?? '' });
  const gone =
    (r.kind === SipRouteKind.MENU && !p.menus.some((m) => m.id === r.id)) ||
    (r.kind === SipRouteKind.GROUP && !p.groups.some((g) => g.id === r.id)) ||
    (r.kind === SipRouteKind.EXTENSION && !p.exts.some((e) => e.id === r.id));
  if (gone) r.id = '';
  const unassigned = r.kind === SipRouteKind.EXTENSION && p.exts.some((e) => e.id === r.id && !e.userId);
  r.missing = gone || unassigned;
  return r;
}

export function outGroup(p: MockPbx, g: SipGroup): SipGroup {
  const ext = p.exts.find((e) => e.groupId === g.id);
  return create(SipGroupSchema, {
    ...g,
    ...(ext ? { extension: ext } : {}),
    onFail: resolved(p, g.onFail),
    members: g.members.filter((m) => p.exts.some((e) => e.id === m.extensionId)).map((m, i) => create(SipGroupMemberSchema, { extensionId: m.extensionId, position: i })),
  });
}

export function outMenu(p: MockPbx, m: SipIvrMenu): SipIvrMenu {
  return create(SipIvrMenuSchema, { ...m, onNoInput: resolved(p, m.onNoInput), items: m.items.map((it) => create(SipIvrItemSchema, { digit: it.digit, action: resolved(p, it.action) })) });
}

function memberIds(p: MockPbx, ids: readonly string[]): string[] {
  if (ids.length > 20 || new Set(ids).size !== ids.length) throw invalid('members');
  for (const id of ids) if (!p.exts.some((e) => e.id === id && e.kind !== SipExtensionKind.GROUP)) throw invalid('members');
  return [...ids];
}

function items(p: MockPbx, list: readonly { digit: string; action?: MessageShape<typeof SipRouteTargetSchema> | undefined }[]): SipIvrMenu['items'] {
  if (list.length > 12) throw invalid('items');
  const seen = new Set<string>();
  return list.map((it) => {
    if (!/^[0-9*#]$/.test(it.digit) || seen.has(it.digit)) throw invalid('digit');
    seen.add(it.digit);
    return create(SipIvrItemSchema, { digit: it.digit, action: target(p, it.action, 'items', true) });
  });
}

const seconds = (v: number, def: number, lo: number, hi: number, field: string): number => {
  if (!v) return def;
  if (v < lo || v > hi) throw invalid(field);
  return v;
};

export function createExtension(
  p: MockPbx,
  m: PbxMembers,
  wsId: string,
  id: string,
  now: Timestamp,
  b: MessageShape<typeof CreateSipExtensionRequestSchema>,
): SipExtension {
  checkNumber(p, b.number);
  checkUser(p, m, b.userId);
  const e = create(SipExtensionSchema, {
    id,
    workspaceId: wsId,
    number: b.number,
    kind: m.isBot(b.userId) ? SipExtensionKind.BOT : SipExtensionKind.USER,
    userId: b.userId,
    description: trimmed(b.description, 64, 'description', false),
    createdAt: now,
    externalBlocked: b.externalBlocked,
  });
  p.exts.push(e);
  return e;
}

export function updateExtension(p: MockPbx, m: PbxMembers, id: string, b: MessageShape<typeof UpdateSipExtensionRequestSchema>): SipExtension {
  const e = p.exts.find((x) => x.id === id);
  if (!e) throw new PbxError(404, ErrorCode.NOT_FOUND, 'extension not found', '');
  if (b.number !== undefined) checkNumber(p, b.number, id);
  if (b.userId !== undefined) {
    if (e.kind === SipExtensionKind.GROUP) throw invalid('userId');
    if (b.userId) checkUser(p, m, b.userId, id);
  }
  const description = b.description !== undefined ? trimmed(b.description, 64, 'description', false) : e.description;
  if (b.number !== undefined) e.number = b.number;
  if (b.userId !== undefined) {
    e.userId = b.userId;
    e.kind = b.userId && m.isBot(b.userId) ? SipExtensionKind.BOT : SipExtensionKind.USER;
  }
  if (b.externalBlocked !== undefined) {
    if (e.kind === SipExtensionKind.GROUP && b.externalBlocked) throw invalid('externalBlocked');
    e.externalBlocked = b.externalBlocked;
  }
  e.description = description;
  return e;
}

export function deleteExtension(p: MockPbx, id: string): SipExtension {
  const e = p.exts.find((x) => x.id === id);
  if (!e) throw new PbxError(404, ErrorCode.NOT_FOUND, 'extension not found', '');
  if (e.kind === SipExtensionKind.GROUP) throw invalid('id');
  p.exts = p.exts.filter((x) => x !== e);
  for (const g of p.groups) g.members = g.members.filter((x) => x.extensionId !== id);
  return e;
}

export function createGroup(p: MockPbx, wsId: string, ids: { group: string; ext: string }, now: Timestamp, b: MessageShape<typeof CreateSipGroupRequestSchema>): SipGroup {
  const name = trimmed(b.name, 64, 'name', true);
  checkNumber(p, b.number);
  const g = create(SipGroupSchema, {
    id: ids.group,
    workspaceId: wsId,
    name,
    strategy: b.strategy === SipGroupStrategy.ROUND_ROBIN ? SipGroupStrategy.ROUND_ROBIN : SipGroupStrategy.RING_ALL,
    ringSec: seconds(b.ringSec, 30, 10, 60, 'ringSec'),
    memberRingSec: seconds(b.memberRingSec, 15, 5, 60, 'memberRingSec'),
    fallbackEnabled: b.fallbackEnabled,
    fallbackSec: seconds(b.fallbackSec, 30, 5, 600, 'fallbackSec'),
    onFail: target(p, b.onFail, 'onFail', false),
    members: memberIds(p, b.members?.extensionIds ?? []).map((extensionId, position) => ({ extensionId, position })),
    updatedAt: now,
  });
  p.groups.push(g);
  p.exts.push(create(SipExtensionSchema, { id: ids.ext, workspaceId: wsId, number: b.number, kind: SipExtensionKind.GROUP, groupId: g.id, createdAt: now }));
  return g;
}

export function updateGroup(p: MockPbx, id: string, now: Timestamp, b: MessageShape<typeof UpdateSipGroupRequestSchema>): SipGroup {
  const g = p.groups.find((x) => x.id === id);
  const ext = p.exts.find((e) => e.groupId === id);
  if (!g || !ext) throw new PbxError(404, ErrorCode.NOT_FOUND, 'group not found', '');
  const name = b.name !== undefined ? trimmed(b.name, 64, 'name', true) : g.name;
  if (b.number !== undefined) checkNumber(p, b.number, ext.id);
  const ringSec = b.ringSec !== undefined ? seconds(b.ringSec, 30, 10, 60, 'ringSec') : g.ringSec;
  const memberRingSec = b.memberRingSec !== undefined ? seconds(b.memberRingSec, 15, 5, 60, 'memberRingSec') : g.memberRingSec;
  const onFail = b.onFail ? target(p, b.onFail, 'onFail', false) : g.onFail;
  if (b.onFail && ((onFail?.kind === SipRouteKind.GROUP && onFail.id === id) || (b.onFail.kind === SipRouteKind.EXTENSION && b.onFail.id === ext.id)))
    throw invalid('onFail');
  const fallbackSec = b.fallbackSec !== undefined ? seconds(b.fallbackSec, 30, 5, 600, 'fallbackSec') : g.fallbackSec;
  const fallbackEnabled = b.fallbackEnabled ?? g.fallbackEnabled;
  const members = b.members ? memberIds(p, b.members.extensionIds).map((extensionId, position) => create(SipGroupMemberSchema, { extensionId, position })) : g.members;
  Object.assign(g, { name, ringSec, memberRingSec, fallbackEnabled, fallbackSec, members, updatedAt: now, ...(onFail ? { onFail } : {}) });
  if (b.strategy !== undefined) g.strategy = b.strategy === SipGroupStrategy.ROUND_ROBIN ? SipGroupStrategy.ROUND_ROBIN : SipGroupStrategy.RING_ALL;
  if (b.number !== undefined) ext.number = b.number;
  return g;
}

export function deleteGroup(p: MockPbx, id: string): void {
  if (!p.groups.some((g) => g.id === id)) throw new PbxError(404, ErrorCode.NOT_FOUND, 'group not found', '');
  p.groups = p.groups.filter((g) => g.id !== id);
  p.exts = p.exts.filter((e) => e.groupId !== id);
}

/** The recording notice's length (ADR-0131) after the mock «conversion». */
const NOTICE_MS = 6_000;

export function createMenu(p: MockPbx, wsId: string, id: string, me: string, now: Timestamp, b: MessageShape<typeof CreateSipIvrMenuRequestSchema>): SipIvrMenu {
  const name = trimmed(b.name, 64, 'name', true);
  const m = create(SipIvrMenuSchema, {
    id,
    workspaceId: wsId,
    name,
    promptFileId: b.promptSourceFileId,
    promptStatus: b.promptSourceFileId ? SipPromptStatus.READY : SipPromptStatus.NONE,
    promptDurationMs: b.promptSourceFileId ? PROMPT_MS : 0,
    inputTimeoutSec: seconds(b.inputTimeoutSec, 5, 3, 15, 'inputTimeoutSec'),
    repeats: seconds(b.repeats, 3, 1, 5, 'repeats'),
    onNoInput: target(p, b.onNoInput, 'onNoInput', false),
    items: items(p, b.items?.items ?? []),
    updatedAt: now,
    updatedBy: me,
    dialExtensions: b.dialExtensions,
    noticeFileId: b.noticeSourceFileId,
    noticeDurationMs: b.noticeSourceFileId ? NOTICE_MS : 0,
  });
  p.menus.push(m);
  return m;
}

export function updateMenu(p: MockPbx, id: string, me: string, now: Timestamp, b: MessageShape<typeof UpdateSipIvrMenuRequestSchema>): SipIvrMenu {
  const m = p.menus.find((x) => x.id === id);
  if (!m) throw new PbxError(404, ErrorCode.NOT_FOUND, 'menu not found', '');
  const name = b.name !== undefined ? trimmed(b.name, 64, 'name', true) : m.name;
  const inputTimeoutSec = b.inputTimeoutSec !== undefined ? seconds(b.inputTimeoutSec, 5, 3, 15, 'inputTimeoutSec') : m.inputTimeoutSec;
  const repeats = b.repeats !== undefined ? seconds(b.repeats, 3, 1, 5, 'repeats') : m.repeats;
  const onNoInput = b.onNoInput ? target(p, b.onNoInput, 'onNoInput', false) : m.onNoInput;
  const list = b.items ? items(p, b.items.items) : m.items;
  Object.assign(m, { name, inputTimeoutSec, repeats, items: list, updatedAt: now, updatedBy: me, ...(onNoInput ? { onNoInput } : {}) });
  if (b.dialExtensions !== undefined) m.dialExtensions = b.dialExtensions;
  if (b.promptSourceFileId !== undefined) {
    m.promptFileId = b.promptSourceFileId;
    m.promptStatus = b.promptSourceFileId ? SipPromptStatus.READY : SipPromptStatus.NONE;
    m.promptDurationMs = b.promptSourceFileId ? PROMPT_MS : 0;
  }
  if (b.noticeSourceFileId !== undefined) {
    m.noticeFileId = b.noticeSourceFileId;
    m.noticeDurationMs = b.noticeSourceFileId ? NOTICE_MS : 0;
  }
  return m;
}

export function deleteMenu(p: MockPbx, id: string): void {
  if (!p.menus.some((m) => m.id === id)) throw new PbxError(404, ErrorCode.NOT_FOUND, 'menu not found', '');
  p.menus = p.menus.filter((m) => m.id !== id);
}
