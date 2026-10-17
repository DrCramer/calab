import { describe, expect, it } from 'vitest';
import { OAuthClientType } from '@calaba/protocol';
import { canSubmit, formField, originValid, redirectError, validateOAuthClientForm } from './oauthClientForm';

const WEB = OAuthClientType.OAUTH_CLIENT_TYPE_CONFIDENTIAL_WEB;
const NATIVE = OAuthClientType.OAUTH_CLIENT_TYPE_PUBLIC_NATIVE;
const SPA = OAuthClientType.OAUTH_CLIENT_TYPE_PUBLIC_SPA;
const form = (over: Partial<Parameters<typeof validateOAuthClientForm>[0]>) =>
  validateOAuthClientForm({ name: 'My app', type: WEB, redirects: 'https://app.example.com/cb', origins: '', ...over });

describe('redirectError', () => {
  it('accepts https for every type', () => {
    for (const type of [WEB, NATIVE, SPA]) expect(redirectError('https://app.example.com/auth/callback?x=1', type)).toBeNull();
  });
  it('accepts plain-http loopback for every type', () => {
    for (const type of [WEB, NATIVE, SPA]) {
      expect(redirectError('http://localhost:3000/callback', type)).toBeNull();
      expect(redirectError('http://localhost/callback', type)).toBeNull();
      expect(redirectError('http://127.0.0.1:8080/cb', type)).toBeNull();
      expect(redirectError('http://[::1]:8080/cb', type)).toBeNull();
      expect(redirectError('HTTP://localhost:3000', type)).toBeNull();
    }
  });
  it('refuses plain http elsewhere and look-alike loopbacks', () => {
    expect(redirectError('http://app.example.com/cb', WEB)).toBe('identity.err.redirectScheme');
    expect(redirectError('http://localhost.evil.example/cb', SPA)).toBe('identity.err.redirectScheme');
    expect(redirectError('http://LOCALHOST:3000/cb', WEB)).toBe('identity.err.redirectScheme');
    expect(redirectError('http://127.0.0.2/cb', WEB)).toBe('identity.err.redirectScheme');
    expect(redirectError('http://127.0.0.1:0/cb', WEB)).toBe('identity.err.redirectScheme');
    expect(redirectError('ftp://app.example.com/cb', WEB)).toBe('identity.err.redirectScheme');
    expect(redirectError('http://app.example.com/cb', NATIVE)).toBe('identity.err.redirectSchemeNative');
  });
  it('allows an app scheme with a path for native only', () => {
    expect(redirectError('com.example.app:/callback', NATIVE)).toBeNull();
    expect(redirectError('com.example.app:/callback', WEB)).toBe('identity.err.redirectNative');
    expect(redirectError('com.example.app:/callback', SPA)).toBe('identity.err.redirectNative');
    expect(redirectError('com.example.app:callback', NATIVE)).toBe('identity.err.redirectSchemeNative');
    expect(redirectError('myapp:/callback', NATIVE)).toBe('identity.err.redirectSchemeNative');
  });
  it('refuses spaces, fragments and wildcards', () => {
    expect(redirectError('https://app.example.com/cb#x', WEB)).toBe('identity.err.redirectChars');
    expect(redirectError('https://*.example.com/cb', WEB)).toBe('identity.err.redirectChars');
    expect(redirectError('https://app.example.com/c b', WEB)).toBe('identity.err.redirectChars');
  });
  it('refuses relative, credentialed, lenient and overlong addresses', () => {
    expect(redirectError('/callback', WEB)).toBe('identity.err.redirectInvalid');
    expect(redirectError('app.example.com/callback', WEB)).toBe('identity.err.redirectInvalid');
    expect(redirectError('https:/app.example.com/cb', WEB)).toBe('identity.err.redirectInvalid');
    expect(redirectError('https://user@app.example.com/cb', WEB)).toBe('identity.err.redirectInvalid');
    expect(redirectError(`https://app.example.com/${'a'.repeat(2048)}`, WEB)).toBe('identity.err.redirectInvalid');
  });
});

describe('originValid', () => {
  it('is an exact https origin', () => {
    expect(originValid('https://app.example.com')).toBe(true);
    expect(originValid('https://app.example.com:8443')).toBe(true);
    expect(originValid('https://app.example.com/')).toBe(false);
    expect(originValid('https://app.example.com/app')).toBe(false);
    expect(originValid('http://app.example.com')).toBe(false);
    expect(originValid('https://App.example.com')).toBe(false);
    expect(originValid('https://app.example.com:443')).toBe(false);
    expect(originValid('https://*.example.com')).toBe(false);
    expect(originValid('https://app.example.com?x')).toBe(false);
  });
});

describe('validateOAuthClientForm', () => {
  it('trims and ignores blank lines', () => {
    const r = form({ name: '  My app ', redirects: '\n  https://a.example.com/cb  \n\n http://localhost:3000/cb\n' });
    expect(r.errors).toEqual({});
    expect(r.value).toEqual({ name: 'My app', redirectUris: ['https://a.example.com/cb', 'http://localhost:3000/cb'], allowedOrigins: [] });
  });
  it('requires a name of at most 100 characters', () => {
    expect(form({ name: '   ' }).errors.name?.key).toBe('err.field.name');
    expect(form({ name: 'я'.repeat(101) }).errors.name?.key).toBe('err.field.name');
    expect(form({ name: '😀'.repeat(100) }).errors.name).toBeUndefined();
  });
  it('requires 1 to 10 distinct redirects and names the offending line', () => {
    expect(form({ redirects: ' \n ' }).errors.redirectUris?.key).toBe('identity.err.redirectRequired');
    const eleven = Array.from({ length: 11 }, (_, i) => `https://a.example.com/${i}`).join('\n');
    expect(form({ redirects: eleven }).errors.redirectUris?.key).toBe('identity.err.redirectMax');
    expect(form({ redirects: 'https://a.example.com/cb\nhttps://a.example.com/cb' }).errors.redirectUris).toEqual({
      key: 'identity.err.redirectDuplicate',
      value: 'https://a.example.com/cb',
    });
    expect(form({ redirects: 'https://a.example.com/cb\nhttp://a.example.com/cb' }).errors.redirectUris).toEqual({
      key: 'identity.err.redirectScheme',
      value: 'http://a.example.com/cb',
    });
  });
  it('sends origins only for an SPA', () => {
    const web = form({ origins: 'https://a.example.com' });
    expect(web.errors).toEqual({});
    expect(web.value.allowedOrigins).toEqual([]);
    expect(form({ type: SPA, origins: ' https://a.example.com \n' }).value.allowedOrigins).toEqual(['https://a.example.com']);
  });
  it('checks SPA origins: exact, at most 10, distinct', () => {
    expect(form({ type: SPA, origins: 'https://a.example.com/' }).errors.allowedOrigins).toEqual({ key: 'identity.err.origin', value: 'https://a.example.com/' });
    const eleven = Array.from({ length: 11 }, (_, i) => `https://a${i}.example.com`).join('\n');
    expect(form({ type: SPA, origins: eleven }).errors.allowedOrigins?.key).toBe('identity.err.originMax');
    expect(form({ type: SPA, origins: 'https://a.example.com\nhttps://a.example.com' }).errors.allowedOrigins?.key).toBe('identity.err.originDuplicate');
    expect(form({ type: SPA, origins: '' }).errors.allowedOrigins).toBeUndefined();
  });
  it('reports every field at once', () => {
    const r = form({ type: SPA, name: '', redirects: 'http://a.example.com', origins: 'nope' });
    expect(Object.keys(r.errors).sort()).toEqual(['allowedOrigins', 'name', 'redirectUris']);
  });
});

describe('canSubmit / formField', () => {
  it('needs a name and a redirect, nothing else', () => {
    expect(canSubmit('App', 'x')).toBe(true);
    expect(canSubmit(' ', 'https://a.example.com/cb')).toBe(false);
    expect(canSubmit('App', ' \n ')).toBe(false);
  });
  it('maps server fields to form fields', () => {
    expect(formField('redirectUris')).toBe('redirectUris');
    expect(formField('allowedOrigins')).toBe('allowedOrigins');
    expect(formField('name')).toBe('name');
    expect(formField('scopes')).toBeNull();
    expect(formField(undefined)).toBeNull();
  });
});
