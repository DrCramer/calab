import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SipCallStatus } from '@calaba/protocol';
import type { LiveSipCall } from '../lib/sip';

/**
 * Tones on a voice room's phone line (ADR-0046 addendum): a key goes to the room's answered line
 * only — addressed to its identity — and only from my connection in that room; the extension
 * dialed after the number goes once after the answer and stops with the call. The voice engine
 * is mocked.
 */

const voice = vi.hoisted(() => ({ publishDtmf: vi.fn((_k: string, _line: string) => true) }));
vi.mock('./voice', () => ({ voice }));

let dtmf: typeof import('./sipRoomDtmf');
let useVoice: (typeof import('../stores/voice'))['useVoice'];
let useSipCalls: (typeof import('../stores/sipCalls'))['useSipCalls'];

const line = (over: Partial<LiveSipCall> = {}): LiveSipCall => ({
  id: 'c1',
  workspaceId: 'w1',
  roomId: 'r1',
  number: '+74951234567',
  startedBy: 'me',
  status: SipCallStatus.ACTIVE,
  reason: '',
  answeredAt: 1,
  identity: 'sip:c1',
  extension: '',
  ...over,
});

const setLine = (c: LiveSipCall): void => useSipCalls.getState().set({ [c.roomId]: c });

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  voice.publishDtmf.mockClear();
  dtmf = await import('./sipRoomDtmf');
  ({ useVoice } = await import('../stores/voice'));
  ({ useSipCalls } = await import('../stores/sipCalls'));
  useVoice.setState({ roomId: 'r1' });
});

afterEach(() => {
  dtmf.resetRoomDtmf();
  vi.useRealTimers();
});

describe('keys to the room’s line', () => {
  it('goes to that line’s identity only', () => {
    setLine(line());
    expect(dtmf.sendRoomDtmf('r1', '5', 'c1')).toBe(true);
    expect(voice.publishDtmf).toHaveBeenCalledWith('5', 'sip:c1');
  });

  it('not while ringing, not for another call, not from outside the room', () => {
    setLine(line({ status: SipCallStatus.RINGING }));
    expect(dtmf.sendRoomDtmf('r1', '5')).toBe(false);
    setLine(line());
    expect(dtmf.sendRoomDtmf('r1', '5', 'c0')).toBe(false); // the keypad of an earlier call
    useVoice.setState({ roomId: 'r2' });
    expect(dtmf.sendRoomDtmf('r1', '5')).toBe(false);
    expect(voice.publishDtmf).not.toHaveBeenCalled();
  });
});

describe('the extension after the number', () => {
  it('waits for the answer, then sends the keys with the pauses', () => {
    const dialing = line({ status: SipCallStatus.DIALING, extension: '1,2' });
    setLine(dialing);
    dtmf.expectExtension(dialing);
    vi.advanceTimersByTime(10_000);
    expect(voice.publishDtmf).not.toHaveBeenCalled(); // not before the answer

    const answered = line({ extension: '1,2' });
    setLine(answered);
    dtmf.onRoomCall(answered);
    vi.advanceTimersByTime(1999);
    expect(voice.publishDtmf).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(voice.publishDtmf).toHaveBeenLastCalledWith('1', 'sip:c1');
    vi.advanceTimersByTime(2000);
    expect(voice.publishDtmf).toHaveBeenLastCalledWith('2', 'sip:c1');
    expect(voice.publishDtmf).toHaveBeenCalledTimes(2);

    dtmf.onRoomCall(answered); // a repeated event does not send it again
    vi.advanceTimersByTime(10_000);
    expect(voice.publishDtmf).toHaveBeenCalledTimes(2);
  });

  it('stops when the call ends', () => {
    const answered = line({ extension: '123' });
    setLine(answered);
    dtmf.expectExtension(answered); // the answer came before the POST response
    vi.advanceTimersByTime(2000);
    expect(voice.publishDtmf).toHaveBeenCalledTimes(1);
    dtmf.onRoomCall(line({ status: SipCallStatus.ENDED, extension: '123' }));
    vi.advanceTimersByTime(10_000);
    expect(voice.publishDtmf).toHaveBeenCalledTimes(1);
  });

  it('nothing without an extension', () => {
    dtmf.expectExtension(line());
    vi.advanceTimersByTime(10_000);
    expect(voice.publishDtmf).not.toHaveBeenCalled();
  });
});
