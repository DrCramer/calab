import { OAuthClientType } from '@calaba/protocol';
import type { MessageKey } from '../../i18n';
import { lines } from './model';

/**
 * Pre-validation of the «OAuth-клиенты» form (ADR-0102): the same rules as the server's
 * validateClient / redirectProblem / validOrigin (apps/server/internal/oauthprovider), so a
 * mistake is named under its field before the request. Pure: no DOM, no i18n lookups.
 */
export type OAuthFormField = 'name' | 'redirectUris' | 'allowedOrigins';

export interface OAuthFormError {
  key: MessageKey;
  /** The offending line, when the error is about one URI / origin. */
  value?: string;
}

export interface OAuthFormInput {
  name: string;
  type: OAuthClientType;
  redirects: string;
  origins: string;
}

export interface OAuthFormResult {
  /** Request values: trimmed, blank lines dropped; origins only for an SPA. */
  value: { name: string; redirectUris: string[]; allowedOrigins: string[] };
  errors: Partial<Record<OAuthFormField, OAuthFormError>>;
}

export const MAX_URIS = 10;
const MAX_NAME = 100;
const MAX_URI_LENGTH = 2048;

/** The Save button: a name and at least one redirect; everything else is explained inline. */
export const canSubmit = (name: string, redirects: string): boolean => name.trim() !== '' && lines(redirects).length > 0;

/** Plain-http loopback, as the server's loopback(): the exact lower-case host, any port. */
const LOOPBACK = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?]|$)/;

/** Why a redirect URI is refused, or null. Mirrors redirectProblem in validation.go. */
export function redirectError(raw: string, type: OAuthClientType): MessageKey | null {
  const native = type === OAuthClientType.OAUTH_CLIENT_TYPE_PUBLIC_NATIVE;
  if (!raw || raw.length > MAX_URI_LENGTH) return 'identity.err.redirectInvalid';
  if (/[\s#*]/.test(raw)) return 'identity.err.redirectChars';
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)?.[1]?.toLowerCase();
  if (!scheme) return 'identity.err.redirectInvalid';
  if (scheme === 'https' || scheme === 'http') {
    // WHATWG URL forgives «https:/host»; the server's Go parser does not.
    if (!/^https?:\/\/[^/?]/i.test(raw)) return 'identity.err.redirectInvalid';
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return 'identity.err.redirectInvalid';
    }
    if (u.username || u.password) return 'identity.err.redirectInvalid';
    if (scheme === 'https') return null;
    // The scheme may be any case, the host is compared as typed; an IP literal needs a real port.
    const loopback = LOOPBACK.test(`http${raw.slice(4)}`) && !(u.port === '0' && u.hostname !== 'localhost');
    return loopback ? null : native ? 'identity.err.redirectSchemeNative' : 'identity.err.redirectScheme';
  }
  // A reverse-domain private scheme with a path (RFC 8252 §7.1): native apps only.
  const rest = raw.slice(scheme.length + 1);
  if (scheme.includes('.') && rest.startsWith('/') && (!rest.startsWith('//') || rest.startsWith('///'))) {
    return native ? null : 'identity.err.redirectNative';
  }
  return native ? 'identity.err.redirectSchemeNative' : 'identity.err.redirectScheme';
}

/** An exact browser origin https://host[:port]: what a browser sends, byte for byte. */
export function originValid(raw: string): boolean {
  if (!/^https:\/\/[^/?#*@\s]+$/i.test(raw)) return false;
  try {
    return new URL(raw).origin === raw;
  } catch {
    return false;
  }
}

function listError(items: string[], check: (v: string) => MessageKey | null, max: MessageKey, duplicate: MessageKey): OAuthFormError | undefined {
  if (items.length > MAX_URIS) return { key: max };
  const seen = new Set<string>();
  for (const v of items) {
    const key = check(v);
    if (key) return { key, value: v };
    if (seen.has(v)) return { key: duplicate, value: v };
    seen.add(v);
  }
  return undefined;
}

export function validateOAuthClientForm(input: OAuthFormInput): OAuthFormResult {
  const spa = input.type === OAuthClientType.OAUTH_CLIENT_TYPE_PUBLIC_SPA;
  const name = input.name.trim();
  const redirectUris = lines(input.redirects);
  // The field is shown only for an SPA; a hidden value is never sent (the server refuses it).
  const allowedOrigins = spa ? lines(input.origins) : [];
  const errors: OAuthFormResult['errors'] = {};
  // Code points, as the server counts runes.
  if (!name || Array.from(name).length > MAX_NAME) errors.name = { key: 'err.field.name' };
  const redirect = redirectUris.length
    ? listError(redirectUris, (v) => redirectError(v, input.type), 'identity.err.redirectMax', 'identity.err.redirectDuplicate')
    : { key: 'identity.err.redirectRequired' as const };
  if (redirect) errors.redirectUris = redirect;
  const origin = listError(allowedOrigins, (v) => (originValid(v) ? null : 'identity.err.origin'), 'identity.err.originMax', 'identity.err.originDuplicate');
  if (origin) errors.allowedOrigins = origin;
  return { value: { name, redirectUris, allowedOrigins }, errors };
}

/** Server field (ApiError.field of a 422) → the form field it belongs to. */
export function formField(field: string | undefined): OAuthFormField | null {
  return field === 'name' || field === 'redirectUris' || field === 'allowedOrigins' ? field : null;
}
