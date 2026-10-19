import { GitProvider } from '@calaba/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ru } from '../../i18n/ru';

// Board settings → «Git»: the webhook address and the secret are known before saving; the
// numbered guide names the provider's own fields and the events the server really parses.
vi.mock('../../platform', () => ({ platform: { kind: 'web', app: { openExternal: () => Promise.resolve(), log: () => undefined } } }));
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });

const { GuideStep } = await import('./GitSettings');
const { GIT_STEPS, GIT_STEPS_COMMON, generateGitSecret, gitHookUrl } = await import('../../lib/boards/git');

describe('gitHookUrl', () => {
  it('is <origin>/api/git/boards/<id>/<provider>, trailing slashes dropped', () => {
    expect(gitHookUrl('https://app.calab.io/', 'b1', GitProvider.GITHUB)).toBe('https://app.calab.io/api/git/boards/b1/github');
    expect(gitHookUrl('http://localhost:8080', 'b1', GitProvider.GITLAB)).toBe('http://localhost:8080/api/git/boards/b1/gitlab');
    expect(gitHookUrl('https://x.test', 'b1', GitProvider.GITEA)).toBe('https://x.test/api/git/boards/b1/gitea');
  });

  it('is empty without a usable origin or provider', () => {
    expect(gitHookUrl('', 'b1', GitProvider.GITHUB)).toBe('');
    expect(gitHookUrl('app.calab.io', 'b1', GitProvider.GITHUB)).toBe('');
    expect(gitHookUrl('https://x.test', 'b1', GitProvider.UNSPECIFIED)).toBe('');
  });
});

describe('generateGitSecret', () => {
  it('is 32 random bytes as base64url (43 chars, within the server 16..256)', () => {
    const s = generateGitSecret((a) => a.fill(0xfb));
    expect(s).toBe('-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_s');
    expect(generateGitSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateGitSecret()).not.toBe(generateGitSecret());
  });
});

describe('guide', () => {
  it('has every step text in the dictionary', () => {
    for (const st of [...Object.values(GIT_STEPS).flat(), ...GIT_STEPS_COMMON]) expect(ru, st.text).toHaveProperty([st.text]);
  });

  it('GitHub: the events are exactly what the server parses', () => {
    const dict = ru as unknown as Record<string, string>;
    const text = (GIT_STEPS[GitProvider.GITHUB] ?? []).map((s) => dict[s.text]).join('\n');
    expect(text).toContain('application/json');
    expect(text).toContain('Pushes');
    expect(text).toContain('Pull requests');
    expect(text).not.toContain('Branch or tag creation');
  });

  it('a step with copy renders the button only when the value is known; the key is in the link step', () => {
    const step = (GIT_STEPS[GitProvider.GITHUB] ?? [])[1] ?? { text: 'git.step.github.2' as const };
    const common = GIT_STEPS_COMMON[0] ?? { text: 'git.step.link' as const };
    const base = { n: 2, step, boardKey: 'CBF', secret: '' };
    expect(renderToStaticMarkup(createElement(GuideStep, { ...base, url: 'https://x.test/h' }))).toContain('aria-label="Скопировать"');
    expect(renderToStaticMarkup(createElement(GuideStep, { ...base, url: '' }))).not.toContain('aria-label="Скопировать"');
    const link = renderToStaticMarkup(createElement(GuideStep, { ...base, step: common, url: 'u' }));
    expect(link).toContain('CBF-12');
    expect(link).not.toContain('aria-label');
  });
});
