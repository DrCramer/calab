import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { VoiceStateIcons, voiceStateIcons } from './VoiceStateIcons';

describe('voice state icons (docs/09 #15, Discord)', () => {
  it('none when speaking freely', () => {
    expect(voiceStateIcons(false, false)).toEqual([]);
  });

  it('self-mute: the grey crossed mic', () => {
    expect(voiceStateIcons(true, false)).toEqual(['muted']);
  });

  it('deafen: the crossed mic, then the crossed headphones', () => {
    expect(voiceStateIcons(true, true)).toEqual(['muted', 'deafened']);
    expect(voiceStateIcons(false, true)).toEqual(['muted', 'deafened']); // deafen implies mute
  });

  it('server mute: the red mic replaces the grey one, headphones still follow', () => {
    expect(voiceStateIcons(true, false, true)).toEqual(['server-muted']);
    expect(voiceStateIcons(false, true, true)).toEqual(['server-muted', 'deafened']);
  });

  it('renders 16 px icons in order, red only for the server mute', () => {
    const html = renderToStaticMarkup(createElement(VoiceStateIcons, { muted: true, deafened: true }));
    expect(html.indexOf('data-voice-icon="muted"')).toBeLessThan(html.indexOf('data-voice-icon="deafened"'));
    expect(html).not.toContain('text-danger');
    expect(html.match(/size-4/g)).toHaveLength(2);
    expect(renderToStaticMarkup(createElement(VoiceStateIcons, { muted: true, deafened: false, serverMuted: true }))).toContain('text-danger');
  });

  it('on a phone call (ADR-0133) only the handset: the parked mic state says nothing', () => {
    expect(voiceStateIcons(true, true, true, false, true)).toEqual(['on-phone']);
    const html = renderToStaticMarkup(createElement(VoiceStateIcons, { muted: false, deafened: false, onPhone: true }));
    expect(html).toContain('data-voice-icon="on-phone"');
    expect(html).not.toContain('data-voice-icon="muted"');
  });
});
