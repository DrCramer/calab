import { describe, expect, it } from 'vitest';
import { redact, trimTo } from '../src/redact.js';

const M = '[скрыто]';

describe('redact', () => {
  it('hides known secret values from the env file', () => {
    expect(redact('the value is hunter2hunter2!', ['hunter2hunter2'])).toBe(`the value is ${M}!`);
    expect(redact('short', ['abc'])).toBe('short'); // < 8 chars: not a secret list entry
  });

  it('hides token-shaped strings', () => {
    // Built from parts so secret scanners do not flag the fixtures.
    const j = (...p: string[]) => p.join('');
    const cases = [
      j('calab_', 'bot_0192f1b2-aaaa-bbbb_AbCdEf123456'),
      j('sk_', 'live_51HxYzAbCdEfGh'),
      j('rk_', 'test_abcdefgh1234'),
      j('sk-', 'ant-api03-abcdefghijklmnopqrstuv'),
      j('ghp', '_abcdefghijklmnopqrstuvwxyz0123'),
      j('github', '_pat_11ABCDEFG0abcdefghijklmn'),
      j('xoxb', '-1234567890-abcdefghij'),
      j('AKIA', 'IOSFODNN7EXAMPLE'),
      j('eyJhbGciOiJIUzI1NiJ9', '.eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'),
      j('123456789', ':AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'),
    ];
    for (const c of cases) expect(redact(`x ${c} y`)).toBe(`x ${M} y`);
  });

  it('keeps labels but hides credentials', () => {
    expect(redact('Authorization: Bearer abcdefghijk123')).toBe(`Authorization: Bearer ${M}`);
    expect(redact('postgres://calaba:s3cretpw@db:5432/calaba')).toBe(`postgres://${M}@db:5432/calaba`);
    expect(redact('STRIPE_SECRET_KEY=whatever123 and API_KEY: "q w"')).toBe(`STRIPE_SECRET_KEY=${M} and API_KEY: ${M}`);
    expect(redact('-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----')).toBe(M);
  });

  it('hides long opaque strings but keeps SHAs, uuids, paths and prose', () => {
    expect(redact('k=Zx9QwErTyUiOpAsDfGhJkLzXcVbNm12345678')).toBe(`k=${M}`);
    const sha = 'db20e162a8f3c1b2d4e5f60718293a4b5c6d7e8f';
    const uuid = '01a15335-e861-7e04-9005-65f09159164f';
    const path = 'apps/desktop/src/renderer/components/VoiceRoomPanel2.tsx';
    const prose = 'Задача #8 сделана в версии 3.8.1, CI зелёный.';
    for (const s of [sha, uuid, path, prose]) expect(redact(s)).toBe(s);
  });
});

describe('trimTo', () => {
  it('leaves short text alone and cuts long text on a boundary', () => {
    expect(trimTo('  hi  ', 10)).toBe('hi');
    const long = 'слово '.repeat(1000);
    const t = trimTo(long, 4000);
    expect(t.length).toBeLessThanOrEqual(4000);
    expect(t.endsWith('…')).toBe(true);
  });
});
