import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { SipCallDirection, SipCallOrigin, SipCallSchema, SipCallStatus } from '@calaba/protocol';

/**
 * A personal call from «Телефония» (ADR-0137 §3): place → dialing (ring-back) → answered → ended;
 * a refused POST; the room I am in parked and left alone on the call's end (the engine resumes
 * it); no call while another goes on. The voice engine, the API and the sounds are mocked.
 */

const voice = vi.hoisted(() => ({
  park: vi.fn(() => Promise.resolve(true)),
  leave: vi.fn(() => Promise.resolve()),
  join: vi.fn((_room: string, _ws: string, _o?: unknown) => Promise.resolve()),
  unmuteForAnswer: vi.fn(),
  publishDtmf: vi.fn((_d: string, _line: string) => true),
}));
vi.mock('./voice', () => ({ voice }));
const placePersonal = vi.hoisted(() => vi.fn((_ws: string, _b: unknown): Promise<unknown> => Promise.resolve({})));
const hangupPersonal = vi.hoisted(() => vi.fn((_ws: string, _id: string): Promise<unknown> => Promise.resolve({})));
vi.mock('../lib/api/endpoints', () => ({ api: { sip: { placePersonal: (ws: string, b: unknown) => placePersonal(ws, b), hangupPersonal: (ws: string, id: string) => hangupPersonal(ws, id) } } }));
const ring = vi.hoisted(() => ({ now: null as string | null }));
vi.mock('../lib/sounds', () => ({
  currentRing: () => ring.now,
  startRing: vi.fn((n: string) => {
    ring.now = n;
  }),
  stopRing: vi.fn(() => {
    ring.now = null;
  }),
}));
const toast = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock('../stores/toasts', () => ({ toast }));
vi.mock('../platform', () => ({ platform: { app: { attention: vi.fn() } } }));
vi.mock('../lib/haptics', () => ({ haptics: { impact: vi.fn(), tap: vi.fn(), select: vi.fn() } }));

let out: typeof import('./sipOutbound');
let useVoice: (typeof import('../stores/voice'))['useVoice'];
let useSipOutbound: (typeof import('../stores/sipOutbound'))['useSipOutbound'];
let useCall: (typeof import('../stores/call'))['useCall'];
let ApiError: (typeof import('../lib/api/client'))['ApiError'];

const call = (status: SipCallStatus, reason = '') => create(SipCallSchema, {
  id: 'c1',
  workspaceId: 'ws',
  number: '+79161234567',
  direction: SipCallDirection.OUT,
  origin: SipCallOrigin.PERSONAL,
  status,
  reason,
  startedBy: 'me',
  ringingUserIds: [],
  callerName: 'Анна Петрова',
  callerCompany: '',
});

beforeEach(async () => {
  vi.resetModules();
  for (const f of Object.values(voice)) f.mockClear();
  for (const f of Object.values(toast)) f.mockClear();
  ring.now = null;
  placePersonal.mockImplementation(() => Promise.resolve({ call: call(SipCallStatus.DIALING), join: { url: 'wss://lk', token: 't' } }));
  hangupPersonal.mockImplementation(() => Promise.resolve({ call: call(SipCallStatus.ENDED, 'cancelled') }));
  out = await import('./sipOutbound');
  ({ useVoice } = await import('../stores/voice'));
  ({ useSipOutbound } = await import('../stores/sipOutbound'));
  ({ useCall } = await import('../stores/call'));
  ({ ApiError } = await import('../lib/api/client'));
  out.installSipOutbound();
});

describe('placePersonalCall', () => {
  it('dials → answered → ended: ring-back until the answer, the session left at the end', async () => {
    useVoice.setState({ roomId: 'room-A', workspaceId: 'ws' });
    expect(await out.placePersonalCall({ workspaceId: 'ws', number: '8 916 123-45-67', name: 'Анна' })).toBe(true);
    expect(placePersonal).toHaveBeenCalledWith('ws', { number: '8 916 123-45-67' });
    expect(voice.park).toHaveBeenCalledOnce();
    expect(voice.leave).not.toHaveBeenCalled();
    expect(voice.join).toHaveBeenCalledWith('sipout:c1', '', { call: true });
    expect(ring.now).toBe('call-outgoing');
    expect(useSipOutbound.getState().call?.status).toBe(SipCallStatus.DIALING);

    useVoice.setState({ roomId: 'sipout:c1', workspaceId: '' });
    out.onPersonalCallUpdate(call(SipCallStatus.ACTIVE));
    expect(ring.now).toBeNull();
    expect(useSipOutbound.getState().call?.status).toBe(SipCallStatus.ACTIVE);
    // A late DIALING does not take it back.
    out.onPersonalCallUpdate(call(SipCallStatus.DIALING));
    expect(useSipOutbound.getState().call?.status).toBe(SipCallStatus.ACTIVE);
    expect(out.sendDtmf('5')).toBe(true);
    expect(voice.publishDtmf).toHaveBeenCalledWith('5', 'sip:c1'); // to the line only

    out.onPersonalCallUpdate(call(SipCallStatus.ENDED, 'remote'));
    expect(voice.leave).toHaveBeenCalledOnce(); // the engine then resumes the parked room
    expect(useSipOutbound.getState().call).toBeNull();
    expect(toast.info).not.toHaveBeenCalled();
  });

  it('a call that fails says why and leaves its session', async () => {
    await out.placePersonalCall({ workspaceId: 'ws', number: '+79161234567' });
    useVoice.setState({ roomId: 'sipout:c1', workspaceId: '' });
    out.onPersonalCallUpdate(call(SipCallStatus.FAILED, 'busy'));
    expect(voice.leave).toHaveBeenCalledOnce();
    expect(toast.info).toHaveBeenCalledOnce();
    expect(ring.now).toBeNull();
    expect(useSipOutbound.getState().call).toBeNull();
  });

  it('a refused POST: the error, no session, nothing parked', async () => {
    placePersonal.mockImplementation(() => Promise.reject(new ApiError('ERROR_CODE_SIP_BUSY', 'busy', 409)));
    useVoice.setState({ roomId: 'room-A', workspaceId: 'ws' });
    expect(await out.placePersonalCall({ workspaceId: 'ws', number: '+79161234567' })).toBe(false);
    expect(toast.error).toHaveBeenCalledOnce();
    expect(voice.park).not.toHaveBeenCalled();
    expect(voice.join).not.toHaveBeenCalled();
    expect(useSipOutbound.getState()).toMatchObject({ call: null, placing: false });
    expect(out.placeErrorKey(new ApiError('ERROR_CODE_SIP_BUSY', '', 409))).toBe('telc.err.busy');
    expect(out.placeErrorKey(new ApiError('ERROR_CODE_SIP_NUMBER_NOT_ALLOWED', '', 422))).toBe('sip.err.notAllowed');
    expect(out.placeErrorKey(new ApiError('ERROR_CODE_SIP_RATE_LIMITED', '', 429))).toBe('sip.err.rate');
    expect(out.placeErrorKey(new ApiError('ERROR_CODE_CONFLICT', '', 409, undefined, { reason: 'PLAN_LIMIT' }))).toBe('plan.telephonyLocked');
  });

  it('no call during a call: a second personal call, a one-to-one call, an inbound phone call', async () => {
    await out.placePersonalCall({ workspaceId: 'ws', number: '+79161234567' });
    expect(await out.placePersonalCall({ workspaceId: 'ws', number: '+79161112233' })).toBe(false);
    expect(placePersonal).toHaveBeenCalledOnce();

    useSipOutbound.setState({ call: null });
    useCall.setState({ phase: 'active' });
    expect(await out.placePersonalCall({ workspaceId: 'ws', number: '+79161112233' })).toBe(false);
    useCall.setState({ phase: 'idle' });
    useVoice.setState({ roomId: 'sipin:c9', workspaceId: '' });
    expect(await out.placePersonalCall({ workspaceId: 'ws', number: '+79161112233' })).toBe(false);
    expect(placePersonal).toHaveBeenCalledOnce();
  });

  it('leaving the call\'s session (the band\'s hang-up) hangs it up once', async () => {
    await out.placePersonalCall({ workspaceId: 'ws', number: '+79161234567' });
    useVoice.setState({ roomId: 'sipout:c1', workspaceId: '' });
    useVoice.setState({ roomId: 'room-A', workspaceId: 'ws' });
    await vi.waitFor(() => expect(hangupPersonal).toHaveBeenCalledWith('ws', 'c1'));
    await vi.waitFor(() => expect(useSipOutbound.getState().call).toBeNull());
    expect(hangupPersonal).toHaveBeenCalledOnce();
  });

  it('READY without my call: it ended while I was away', async () => {
    await out.placePersonalCall({ workspaceId: 'ws', number: '+79161234567' });
    useVoice.setState({ roomId: 'sipout:c1', workspaceId: '' });
    out.resetOutbound([]);
    expect(useSipOutbound.getState().call).toBeNull();
    expect(voice.leave).toHaveBeenCalledOnce();
  });
});
