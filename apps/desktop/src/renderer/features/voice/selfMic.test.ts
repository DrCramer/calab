// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePrefs } from '../../stores/prefs';
import { useSession } from '../../stores/session';
import { useVoice } from '../../stores/voice';
import { useWorkspaces } from '../../stores/workspaces';
import { useSelfMic } from './selfMic';
import { SelfVoiceStateIcons } from './VoiceStateIcons';

vi.mock('../../platform', () => ({ platform: { kind: 'web', app: { log: () => undefined } } }));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root;
let host: HTMLElement;
let panelRenders = 0;

/** What the self panel reads (VoiceControls): the same hook. */
function Panel(): ReactNode {
  panelRenders++;
  const m = useSelfMic();
  return createElement('span', { 'data-testid': 'panel', 'data-muted': String(m.muted), 'data-elsewhere': String(m.elsewhere) });
}

const row = (): string => host.querySelector('[data-testid="row"]')?.innerHTML ?? '';
const panel = (): HTMLElement | null => host.querySelector('[data-testid="panel"]');
const set = (fn: () => void): void => act(fn);
const mySeat = (s: { muted: boolean; ptt?: boolean } | null): void =>
  set(() => useWorkspaces.setState({ byId: { ws: { voice: s ? { me: { userId: 'me', roomId: 'A', deafened: false, ...s } } : {} } } } as never));

beforeEach(() => {
  useSession.setState({ me: { user: { id: 'me' } } } as never);
  usePrefs.getState().setPrefs({ micMode: 'voice' });
  useVoice.setState({ roomId: null, muted: false, deafened: false, serverMuted: false, pttDown: false, call: false });
  useWorkspaces.setState({ byId: {} } as never);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(createElement('div', null, createElement(Panel), createElement('span', { 'data-testid': 'row' }, createElement(SelfVoiceStateIcons)))));
  panelRenders = 0;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('my row and the self panel draw one view (#96)', () => {
  it('another device of mine muted in the room: both crossed at full brightness, the pre-join intent is ignored', () => {
    mySeat({ muted: true });
    expect(panel()?.dataset).toMatchObject({ muted: 'true', elsewhere: 'true' });
    expect(row()).toContain('data-voice-icon="muted"');
    expect(row()).not.toContain('opacity-50');
    mySeat({ muted: false, ptt: true });
    expect(panel()?.dataset.muted).toBe('false');
    expect(row()).toContain('data-voice-icon="ptt-idle"');
  });

  it('in the call here: my intent over a server copy that still says off; PTT pale until the key', () => {
    mySeat({ muted: true });
    set(() => useVoice.setState({ roomId: 'A' }));
    expect(panel()?.dataset).toMatchObject({ muted: 'false', elsewhere: 'false' });
    expect(row()).toBe('');
    set(() => usePrefs.getState().setPrefs({ micMode: 'ptt' }));
    expect(row()).toContain('data-voice-icon="ptt-idle"');
    expect(row()).toContain('opacity-50');
    set(() => useVoice.setState({ pttDown: true }));
    expect(row()).toBe('');
    set(() => useVoice.setState({ muted: true }));
    expect(panel()?.dataset.muted).toBe('true');
    expect(row()).toContain('data-voice-icon="muted"');
  });

  it('re-renders stay bounded: the PTT key and someone else\'s voice event do not redraw the panel', () => {
    set(() => useVoice.setState({ roomId: 'A' }));
    set(() => usePrefs.getState().setPrefs({ micMode: 'ptt' }));
    const n = panelRenders;
    set(() => useVoice.setState({ pttDown: true }));
    set(() => useVoice.setState({ pttDown: false }));
    set(() => useWorkspaces.setState({ byId: { ws: { voice: { other: { userId: 'other', roomId: 'A', muted: true, deafened: false } } } } } as never));
    expect(panelRenders).toBe(n);
  });
});
