import { create } from '@bufbuild/protobuf';
import { RoomInviteSchema } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { linkDraftOf, linkEditInit, maxUsesOptions } from './linkEdit';

const invite = create(RoomInviteSchema, { id: 'i', code: 'c', maxUses: 5, uses: 2, allowSpeak: true, allowMessages: true, allowFiles: false, allowStream: false });

describe('linkEditInit', () => {
  it('an untouched draft changes nothing', () => {
    expect(linkEditInit(invite, linkDraftOf(invite), true)).toBeNull();
  });

  it('only what changed; a new expiry counts from now, 0 = never', () => {
    const d = { ...linkDraftOf(invite), expires: 0, maxUses: 0, files: true };
    expect(linkEditInit(invite, d, true)).toEqual({ expiresInSeconds: 0, maxUses: 0, allowFiles: true });
    expect(linkEditInit(invite, { ...linkDraftOf(invite), expires: 3600 }, true)).toEqual({ expiresInSeconds: 3600 });
  });

  it('speak and stream only in a voice room', () => {
    const d = { ...linkDraftOf(invite), speak: false, stream: true };
    expect(linkEditInit(invite, d, false)).toBeNull();
    expect(linkEditInit(invite, d, true)).toEqual({ allowSpeak: false, allowStream: true });
  });
});

describe('maxUsesOptions', () => {
  it('unlimited first, then limits above the uses so far, the current one kept', () => {
    expect(maxUsesOptions({ maxUses: 3, uses: 2 }, [0, 1, 5, 10])).toEqual([0, 3, 5, 10]);
    expect(maxUsesOptions({ maxUses: 0, uses: 0 }, [0, 1, 5])).toEqual([0, 1, 5]);
  });
});
