// Everything the bot posts passes through here: known secret values from the env file, then anything
// shaped like a token, key or credential. Over-redaction is fine; a leaked token is not.

const MASK = '[скрыто]';

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /calab_(?:bot|app|pat)_[A-Za-z0-9_-]+/g,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g, // Stripe
  /\bsk-[A-Za-z0-9_-]{16,}/g, // Anthropic / OpenAI style
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /\b\d{8,10}:[A-Za-z0-9_-]{30,}/g, // Telegram bot token
];

// Keep the label, hide the credential.
const LABELLED: [RegExp, string][] = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`],
  [/\b([a-z][a-z0-9+]*):\/\/[^\s:@/]+:[^\s@/]+@/gi, `$1://${MASK}@`],
];

// NAME=value / NAME: value where NAME says it's a secret.
const ASSIGNMENT = /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY|_KEY|DSN)[A-Z0-9_]*)(\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"']+)/g;

// Long opaque strings (≥ 32 chars of base64url with letters and digits mixed). Pure hex (git SHAs,
// sha256 sums) and uuids are not secrets and stay readable.
const OPAQUE = /[A-Za-z0-9_\-+/]{32,}={0,2}/g;

function looksOpaque(s: string): boolean {
  const core = s.replace(/=+$/, '');
  if (/^[0-9a-f]+$/i.test(core)) return false;
  if (/^[0-9a-f-]+$/i.test(core)) return false;
  if (core.includes('/') && /^[A-Za-z0-9_.\-/]+$/.test(core) && /\/[a-z]/.test(core)) return false; // paths
  if (!/[0-9]/.test(core) || !/[a-z]/.test(core) || !/[A-Z]/.test(core)) return false;
  return true;
}

export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) {
    if (s.length >= 8) out = out.split(s).join(MASK);
  }
  for (const re of PATTERNS) out = out.replace(re, MASK);
  for (const [re, to] of LABELLED) out = out.replace(re, to);
  out = out.replace(ASSIGNMENT, (_m, name: string, sep: string) => `${name}${sep}${MASK}`);
  out = out.replace(OPAQUE, (m) => (looksOpaque(m) ? MASK : m));
  return out;
}

/** Trims to `max` characters on a line or word boundary, with an ellipsis. */
export function trimTo(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const at = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
  return `${(at > max * 0.7 ? cut.slice(0, at) : cut).trimEnd()}…`;
}
