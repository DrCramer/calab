import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import {
  CreateSipExtensionRequestSchema,
  CreateSipGroupRequestSchema,
  CreateSipIvrMenuRequestSchema,
  ErrorCode,
  SipExtensionKind,
  SipRouteKind,
  UpdateSipExtensionRequestSchema,
} from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { PbxError, createExtension, createGroup, createMenu, deleteExtension, deleteGroup, emptyPbx, outGroup, outMenu, updateExtension } from './mock-pbx';

// The exchange of the mock API (ADR-0117): pnpm -F @calaba/desktop exec vitest run --config e2e-support/vitest.config.ts

const now = timestampFromMs(0);
const members = { eligible: (u: string) => u !== 'guest', isBot: (u: string) => u === 'bot' };

function code(fn: () => unknown): [ErrorCode, string] {
  try {
    fn();
  } catch (e) {
    if (e instanceof PbxError) return [e.code, e.field];
    throw e;
  }
  throw new Error('no error');
}

describe('mock exchange', () => {
  it('numbers: format, unique, one per member, no guests, bots marked', () => {
    const p = emptyPbx();
    const ext = (number: string, userId: string) => createExtension(p, members, 'w', `e${number}`, now, create(CreateSipExtensionRequestSchema, { number, userId }));
    ext('101', 'anna');
    expect(code(() => ext('1', 'boris'))).toEqual([ErrorCode.VALIDATION, 'number']);
    expect(code(() => ext('101', 'boris'))).toEqual([ErrorCode.SIP_EXTENSION_TAKEN, 'number']);
    expect(code(() => ext('102', 'anna'))).toEqual([ErrorCode.SIP_EXTENSION_TAKEN, 'userId']);
    expect(code(() => ext('103', 'guest'))).toEqual([ErrorCode.VALIDATION, 'userId']);
    expect(ext('104', 'bot').kind).toBe(SipExtensionKind.BOT);
  });

  it('deletes are never blocked: routes come back missing', () => {
    const p = emptyPbx();
    const e = createExtension(p, members, 'w', 'e1', now, create(CreateSipExtensionRequestSchema, { number: '101', userId: 'anna' }));
    const g = createGroup(p, 'w', { group: 'g1', ext: 'e2' }, now, create(CreateSipGroupRequestSchema, { name: 'Sales', number: '1001', members: { extensionIds: [e.id] } }));
    expect(code(() => createGroup(p, 'w', { group: 'g2', ext: 'e3' }, now, create(CreateSipGroupRequestSchema, { name: 'x', number: '1002', members: { extensionIds: ['e2'] } })))).toEqual([ErrorCode.VALIDATION, 'members']);
    const m = createMenu(p, 'w', 'm1', 'anna', now, create(CreateSipIvrMenuRequestSchema, {
      name: 'Main',
      items: { items: [{ digit: '1', action: { kind: SipRouteKind.EXTENSION, id: 'e2' } }, { digit: '2', action: { kind: SipRouteKind.EXTENSION, id: e.id } }] },
    }));
    expect(m.items[0]?.action?.kind).toBe(SipRouteKind.GROUP); // a group's number is the group
    updateExtension(p, members, e.id, create(UpdateSipExtensionRequestSchema, { userId: '' }));
    expect(outMenu(p, m).items[1]?.action?.missing).toBe(true); // nobody behind the number
    deleteExtension(p, e.id);
    expect(outGroup(p, g).members).toHaveLength(0);
    deleteGroup(p, g.id);
    const out = outMenu(p, m);
    expect(out.items[0]?.action).toMatchObject({ missing: true, id: '' });
    expect(p.exts).toHaveLength(0); // the group's number went with it
  });
});
