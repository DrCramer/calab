import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SipCallDirection, SipCallStatus } from '@calaba/protocol';

/**
 * «Принять» on an inbound phone call (ADR-0117) with the room I am in (ADR-0133): parked, not
 * left; a one-to-one call (nothing to park) is left as before; another phone call is switched
 * over without leaving. The voice engine and the API are mocked: what the engine does with a
 * parked room is in services/voice.test.ts.
 */

const voice = vi.hoisted(() => ({
  park: vi.fn(() => Promise.resolve(true)),
  leave: vi.fn(() => Promise.resolve()),
  join: vi.fn((_room: string, _ws: string, _o?: unknown) => Promise.resolve()),
  unmuteForAnswer: vi.fn(),
}));
vi.mock('./voice', () => ({ voice }));
const acceptInbound = vi.hoisted(() => vi.fn((_id: string): Promise<unknown> => Promise.resolve({})));
const hangupInbound = vi.hoisted(() => vi.fn((_id: string): Promise<unknown> => Promise.resolve({})));
vi.mock('../lib/api/endpoints', () => ({ api: { sip: { acceptInbound: (id: string) => acceptInbound(id), hangupInbound: (id: string) => hangupInbound(id) } } }));
vi.mock('../lib/sounds', () => ({ currentRing: () => null, startRing: vi.fn(), stopRing: vi.fn() }));
vi.mock('../stores/toasts', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }));
vi.mock('../platform', () => ({ platform: { app: { attention: vi.fn() } } }));
vi.mock('../stores/session', () => ({ myUserId: () => 'me' }));
vi.mock('../stores/prefs', () => ({ prefs: () => ({ presence: 0 }) }));

let sip: typeof import('./sipInbound');
let useVoice: (typeof import('../stores/voice'))['useVoice'];

const call = (id: string) => ({ id, workspaceId: 'ws', direction: SipCallDirection.IN, status: SipCallStatus.ACTIVE, answeredBy: 'me', number: '+79161234567', ringingUserIds: [] });

beforeEach(async () => {
  vi.resetModules();
  for (const f of Object.values(voice)) f.mockClear();
  voice.park.mockImplementation(() => Promise.resolve(true));
  acceptInbound.mockImplementation((id: string) => Promise.resolve({ call: call(id), join: { url: 'wss://lk', token: 't' } }));
  hangupInbound.mockImplementation((id: string) => Promise.resolve({ call: { ...call(id), status: SipCallStatus.ENDED } }));
  sip = await import('./sipInbound');
  ({ useVoice } = await import('../stores/voice'));
});

describe('acceptInbound parks the room (ADR-0133)', () => {
  it('in a workspace room: parked, not left, then the phone room is joined', async () => {
    useVoice.setState({ roomId: 'room-A', workspaceId: 'ws' });
    await sip.acceptInbound('c1');
    expect(voice.park).toHaveBeenCalledOnce();
    expect(voice.leave).not.toHaveBeenCalled();
    expect(voice.join).toHaveBeenCalledWith('sipin:c1', '', { call: true });
  });

  it('nothing to park (a one-to-one call): left as before', async () => {
    voice.park.mockImplementation(() => Promise.resolve(false));
    useVoice.setState({ roomId: 'dm-1', workspaceId: '', call: true });
    await sip.acceptInbound('c1');
    expect(voice.leave).toHaveBeenCalledOnce();
    expect(voice.join).toHaveBeenCalledWith('sipin:c1', '', { call: true });
  });

  it('on another phone call: switched over, neither parked nor left (the parked room stays)', async () => {
    useVoice.setState({ roomId: 'sipin:c0', workspaceId: '' });
    await sip.acceptInbound('c1');
    expect(voice.park).not.toHaveBeenCalled();
    expect(voice.leave).not.toHaveBeenCalled();
    expect(voice.join).toHaveBeenCalledWith('sipin:c1', '', { call: true });
  });

  it('not in voice: just the phone room', async () => {
    await sip.acceptInbound('c1');
    expect(voice.park).not.toHaveBeenCalled();
    expect(voice.leave).not.toHaveBeenCalled();
  });

  it('hang-up leaves the phone session (the engine then resumes the parked room)', async () => {
    useVoice.setState({ roomId: 'room-A', workspaceId: 'ws' });
    await sip.acceptInbound('c1');
    useVoice.setState({ roomId: 'sipin:c1', workspaceId: '' });
    await sip.hangupInbound('c1');
    expect(hangupInbound).toHaveBeenCalledWith('c1');
    expect(voice.leave).toHaveBeenCalled(); // the call's end (effects) and the hang-up itself: idempotent in the engine
    expect(voice.park).toHaveBeenCalledOnce();
  });
});
