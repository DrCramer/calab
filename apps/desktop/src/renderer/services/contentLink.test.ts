import { beforeEach, describe, expect, it, vi } from 'vitest';
const { own, external } = vi.hoisted(() => ({ own: vi.fn(() => false), external: vi.fn() }));
vi.mock('./links', () => ({ openOwnLink: own, shareOrigin: () => 'https://app.test' }));
vi.mock('../platform', () => ({ platform: { app: { openExternal: external } } }));
import { contentHref, openContentLink } from './contentLink';
beforeEach(() => { own.mockReset(); external.mockReset(); });

describe('synchronous content navigation', () => {
  it.each(['/t/DEV-1', '/plans', '/r/abcd1234', '/disk/uuid', '/canvas/uuid'])('canonicalizes %s and lets the existing router decide access/confirmation', (href) => {
    own.mockReturnValue(true);
    expect(openContentLink(href)).toBe(true);
    expect(own).toHaveBeenCalledWith(`https://app.test${href}`);
    expect(external).not.toHaveBeenCalled();
  });
  it('normalizes uppercase origin and preserves page-source navigation', () => {
    const pages = { idOf: vi.fn(() => 'p'), open: vi.fn() };
    openContentLink('https://APP.TEST/wiki/p', pages);
    expect(pages.idOf).toHaveBeenCalledWith('https://app.test/wiki/p');
    expect(pages.open).toHaveBeenCalledWith('p'); expect(own).not.toHaveBeenCalled();
  });
  it.each(['https://external.test/path', 'https://app.test.evil.test/t/DEV-1'])('opens external %s within the click stack', (href) => {
    openContentLink(href);
    expect(external).toHaveBeenCalledWith(href); // No microtask/timer awaited.
  });
  it('keeps a protocol-relative foreign authority external', () => {
    openContentLink('//external.test/path');
    expect(external).toHaveBeenCalledWith('https://external.test/path');
  });
  it.each(['/c/public-code', '/e/event/rsvp?t=token', '/unsupported'])('hands unsupported own path %s to the platform; the native host may block it', (path) => {
    expect(openContentLink(path)).toBe(true);
    expect(own).toHaveBeenCalledWith(`https://app.test${path}`);
    expect(external).toHaveBeenCalledWith(`https://app.test${path}`);
  });
  it('hands mailto to the platform without invoking the Mail deep-link parser', () => {
    openContentLink('mailto:test@example.com');
    expect(own).not.toHaveBeenCalled(); expect(external).toHaveBeenCalledWith('mailto:test@example.com');
  });
  it.each(['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'https://user:password@app.test/t/DEV-1', 'https://app.test\\@evil.test', 'https://app.te\nst/t/DEV-1', ''])('blocks unsafe or ambiguous %j', (href) => {
    expect(contentHref(href)).toBeNull(); expect(openContentLink(href)).toBe(false);
    expect(own).not.toHaveBeenCalled(); expect(external).not.toHaveBeenCalled();
  });
});
