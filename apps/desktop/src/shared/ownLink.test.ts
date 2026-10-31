import { describe, expect, it } from 'vitest';
import { classifyLink, isOwnAppLink, ownOrigins, parseOriginList, type LinkClass } from './ownLink';

const ID = '0190a0b0-0000-7000-80c1-0000000000d1';
/** The cloud deployment's app origins (docs/06 «Домены»), as .env.production lists them. */
const CLOUD = parseOriginList('https://app.calab.io https://app.calab.ru, https://meet.gptunnel.ru junk calab://x https://u:p@x.test');

describe('ownOrigins', () => {
  it('parses the env list, dropping junk and userinfo', () => {
    expect(CLOUD).toEqual(['https://app.calab.io', 'https://app.calab.ru', 'https://meet.gptunnel.ru']);
  });
  it('adds the deployment aliases only when the server is one of them', () => {
    expect(ownOrigins(['https://app.calab.io/'], CLOUD)).toEqual(CLOUD);
    // A restored pre-2.0 session on the alias, settings on the main host: both families.
    expect(ownOrigins(['https://app.calab.ru', 'https://app.calab.io'], CLOUD).sort()).toEqual([...CLOUD].sort());
    // Self-hosted / the stand / dev: only their own origin, never the cloud's.
    expect(ownOrigins(['https://calab.example.com'], CLOUD)).toEqual(['https://calab.example.com']);
    expect(ownOrigins(['http://localhost:8080'], CLOUD)).toEqual(['http://localhost:8080']);
    expect(ownOrigins(['', 'not a url'], CLOUD)).toEqual([]);
  });
});

type Want = ['app', string] | ['own-page'] | ['external'] | ['invalid'];

/** [href, servers, expected]: the decision every click path makes. */
const CASES: Array<[string, string[], Want]> = [
  // The owner's case: the link's host is another origin of the same deployment.
  ['https://app.calab.io/t/DEV-123', ['https://app.calab.ru'], ['app', 'calab://t/DEV-123']],
  ['https://app.calab.ru/t/DEV-123', ['https://app.calab.io'], ['app', 'calab://t/DEV-123']],
  ['https://meet.gptunnel.ru/r/AbCd1234', ['https://app.calab.io'], ['app', 'calab://r/AbCd1234']],
  ['https://APP.CALAB.IO:443/t/DEV-1', ['https://app.calab.io'], ['app', 'calab://t/DEV-1']],
  // Every in-app route, key forms included.
  ['https://app.calab.io/t/dev-123/?x=1#c', ['https://app.calab.io'], ['app', 'calab://t/dev-123/']],
  ['https://app.calab.io/t/DEV-1000022', ['https://app.calab.io'], ['app', 'calab://t/DEV-1000022']],
  ['https://app.calab.io/t/AB12CD-123456789', ['https://app.calab.io'], ['app', 'calab://t/AB12CD-123456789']],
  ['https://app.calab.io/r/AbCd1234', ['https://app.calab.io'], ['app', 'calab://r/AbCd1234']],
  ['https://app.calab.io/join/AbCd_12-x', ['https://app.calab.io'], ['app', 'calab://join/AbCd_12-x']],
  [`https://app.calab.io/b/${ID}`, ['https://app.calab.io'], ['app', `calab://b/${ID}`]],
  [`https://app.calab.io/m/${ID}/${ID}`, ['https://app.calab.io'], ['app', `calab://m/${ID}/${ID}`]],
  [`https://app.calab.io/dm/${ID}`, ['https://app.calab.io'], ['app', `calab://dm/${ID}`]],
  [`https://app.calab.io/e/${ID}`, ['https://app.calab.io'], ['app', `calab://e/${ID}`]],
  [`https://app.calab.io/wiki/${ID}`, ['https://app.calab.io'], ['app', `calab://wiki/${ID}`]],
  [`https://app.calab.io/canvas/${ID}`, ['https://app.calab.io'], ['app', `calab://canvas/${ID}`]],
  [`https://app.calab.io/disk/${ID}`, ['https://app.calab.io'], ['app', `calab://disk/${ID}`]],
  ['https://app.calab.io/plans?plan=business', ['https://app.calab.io'], ['app', 'calab://plans?plan=business']],
  ['https://app.calab.io/plans?plan=x%20y&z=1', ['https://app.calab.io'], ['app', 'calab://plans']],
  ['https://app.calab.io/', ['https://app.calab.io'], ['app', 'calab://']],
  ['http://localhost:8080/t/DEV-1', ['http://localhost:8080'], ['app', 'calab://t/DEV-1']],
  // Our host, web-only pages: the browser.
  ['https://app.calab.io/download/', ['https://app.calab.io'], ['own-page']],
  [`https://app.calab.io/e/${ID}/rsvp?t=x`, ['https://app.calab.io'], ['own-page']],
  ['https://app.calab.io/api/version', ['https://app.calab.io'], ['own-page']],
  ['https://app.calab.io/c/AbCd1234', ['https://app.calab.io'], ['own-page']],
  ['https://app.calab.io/plansx', ['https://app.calab.io'], ['own-page']],
  ['https://app.calab.io/t/slug-not-a-key', ['https://app.calab.io'], ['own-page']],
  ['https://app.calab.io/t/DEV-1234567890', ['https://app.calab.io'], ['own-page']],
  ['https://app.calab.io//t/DEV-1', ['https://app.calab.io'], ['own-page']],
  // Not ours: the browser.
  ['https://app.calab.io/t/DEV-1', ['https://calab.example.com'], ['external']],
  ['https://calab.example.com/t/DEV-1', ['https://app.calab.io'], ['external']],
  ['https://calab.io/t/DEV-1', ['https://app.calab.io'], ['external']],
  ['https://www.calab.io/t/DEV-1', ['https://app.calab.io'], ['external']],
  ['https://app.calab.io.evil.test/t/DEV-1', ['https://app.calab.io'], ['external']],
  ['http://app.calab.io/t/DEV-1', ['https://app.calab.io'], ['external']],
  ['https://app.calab.io:8443/t/DEV-1', ['https://app.calab.io'], ['external']],
  ['https://example.org/', ['https://app.calab.io'], ['external']],
  ['https://app.calab.io/t/DEV-1', [], ['external']],
  // Nothing opens.
  ['https://user@app.calab.io/t/DEV-1', ['https://app.calab.io'], ['invalid']],
  ['https://app.calab.io@evil.test/t/DEV-1', ['https://app.calab.io'], ['invalid']],
  ['javascript:alert(1)//https://app.calab.io/t/DEV-1', ['https://app.calab.io'], ['invalid']],
  ['calab://t/DEV-1', ['https://app.calab.io'], ['invalid']],
  ['file:///etc/passwd', ['https://app.calab.io'], ['invalid']],
  ['https://app.calab.io/t/DE\nV-1', ['https://app.calab.io'], ['invalid']],
  ['https:\\\\evil.test\\t\\DEV-1', ['https://app.calab.io'], ['invalid']],
  ['not a url', ['https://app.calab.io'], ['invalid']],
];

function decide(c: LinkClass): Want {
  return c.kind === 'app' ? ['app', c.deepLink] : [c.kind];
}

describe('classifyLink', () => {
  it.each(CASES)('%s on %j', (href, servers, want) => {
    expect(decide(classifyLink(href, ownOrigins(servers, CLOUD)))).toEqual(want);
  });
  it('hands the browser the normalized URL', () => {
    expect(classifyLink('https://Example.org/a b', ['https://app.calab.io'])).toEqual({ kind: 'external', url: 'https://example.org/a%20b' });
    expect(classifyLink('https://app.calab.io/download/', ['https://app.calab.io'])).toEqual({ kind: 'own-page', url: 'https://app.calab.io/download/' });
  });
  it('isOwnAppLink is the app decision', () => {
    expect(isOwnAppLink('https://app.calab.ru/t/DEV-1', ownOrigins(['https://app.calab.io'], CLOUD))).toBe(true);
    expect(isOwnAppLink('https://app.calab.ru/t/DEV-1', ['https://app.calab.io'])).toBe(false);
  });
});
