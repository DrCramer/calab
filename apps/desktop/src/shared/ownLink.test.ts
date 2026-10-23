import { describe, expect, it } from 'vitest';
import { isOwnAppLink, ownLinkToDeepLink } from './ownLink';

const S = 'https://app.test';
const ID = '0190a0b0-0000-7000-80c1-0000000000d1';

describe('own app links (CBF-63)', () => {
  it('maps known routes of the server host to calab://', () => {
    expect(ownLinkToDeepLink(`${S}/t/CBF-63`, S)).toBe('calab://t/CBF-63');
    expect(ownLinkToDeepLink(`${S}/t/cbf-63/?x=1#y`, S)).toBe('calab://t/cbf-63/');
    expect(ownLinkToDeepLink(`${S}/r/AbCd1234`, S)).toBe('calab://r/AbCd1234');
    expect(ownLinkToDeepLink(`${S}/join/AbCd1234`, S)).toBe('calab://join/AbCd1234');
    expect(ownLinkToDeepLink(`${S}/b/${ID}`, S)).toBe(`calab://b/${ID}`);
    expect(ownLinkToDeepLink(`${S}/m/${ID}/${ID}`, S)).toBe(`calab://m/${ID}/${ID}`);
    expect(ownLinkToDeepLink(`${S}/dm/${ID}`, S)).toBe(`calab://dm/${ID}`);
    expect(ownLinkToDeepLink(`${S}/e/${ID}`, S)).toBe(`calab://e/${ID}`);
    expect(ownLinkToDeepLink(`${S}/wiki/${ID}`, S)).toBe(`calab://wiki/${ID}`);
    expect(ownLinkToDeepLink(`${S}/disk/${ID}`, S)).toBe(`calab://disk/${ID}`);
  });
  it('leaves unknown paths of our host and foreign hosts to the browser', () => {
    expect(isOwnAppLink(`${S}/download/`, S)).toBe(false);
    expect(isOwnAppLink(`${S}/e/${ID}/rsvp`, S)).toBe(false);
    expect(isOwnAppLink(`${S}/api/version`, S)).toBe(false);
    expect(isOwnAppLink('https://evil.test/t/CBF-63', S)).toBe(false);
    expect(isOwnAppLink('https://app.test.evil.test/t/CBF-63', S)).toBe(false);
    expect(isOwnAppLink('https://user@app.test/t/CBF-63', S)).toBe(false);
    expect(isOwnAppLink('http://app.test/t/CBF-63', S)).toBe(false);
  });
  it('is false without a server and for junk', () => {
    expect(isOwnAppLink(`${S}/t/CBF-63`, '')).toBe(false);
    expect(isOwnAppLink('not a url', S)).toBe(false);
    expect(isOwnAppLink('calab://t/CBF-63', S)).toBe(false);
  });
  it('compares hosts case-insensitively', () => {
    expect(isOwnAppLink('https://APP.test/t/CBF-63', S)).toBe(true);
  });
});
