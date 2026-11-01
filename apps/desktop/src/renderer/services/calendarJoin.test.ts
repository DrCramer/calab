import type { CalendarEvent } from '@calaba/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const join = vi.fn(() => Promise.resolve());
vi.mock('../platform', () => ({ platform: { kind: 'web', app: { log: () => undefined, attention: () => undefined } } }));
vi.mock('./voice', () => ({ voice: { join: (...a: unknown[]) => join(...(a as [])) } }));

import { useJoinConfirm } from '../stores/joinConfirm';
import { useUi } from '../stores/ui';
import { setVoice } from '../stores/voice';
import { goToRoom, requestJoin } from './calendar';

const ev = { id: 'e1', workspaceId: 'w1', roomId: 'r1', title: 'Планёрка' } as unknown as CalendarEvent;

beforeEach(() => {
  join.mockClear();
  useJoinConfirm.getState().close();
  setVoice({ roomId: null, workspaceId: null, call: false });
  vi.spyOn(useUi.getState(), 'openRoom').mockImplementation(() => undefined);
});

describe('a reminder click (notification or toast)', () => {
  it('asks first and does not join', () => {
    requestJoin(ev);
    expect(useJoinConfirm.getState().ev).toBe(ev);
    expect(join).not.toHaveBeenCalled();
  });

  it('asks also from another voice room (the dialog names it); still no join', () => {
    setVoice({ roomId: 'r2', workspaceId: 'w1' });
    requestJoin(ev);
    expect(useJoinConfirm.getState().ev).toBe(ev);
    expect(join).not.toHaveBeenCalled();
  });

  it('already in that room: nothing to join or ask', () => {
    setVoice({ roomId: 'r1', workspaceId: 'w1' });
    requestJoin(ev);
    expect(useJoinConfirm.getState().ev).toBeNull();
    expect(join).not.toHaveBeenCalled();
  });

  it('the confirmation (goToRoom) joins the meeting room', () => {
    goToRoom(ev);
    expect(join).toHaveBeenCalledWith('r1', 'w1');
  });
});
