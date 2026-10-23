import { afterEach, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ status: 'anon', settings: null as { serverUrl: string } | null }));
vi.mock('../stores/session', () => ({ useSession: { getState: () => session } }));
const openRoom = vi.hoisted(() => vi.fn());
vi.mock('../stores/ui', () => ({ useUi: { getState: () => ({ openDialog: () => undefined, openRoom }) } }));
vi.mock('../features/people/roomLink', () => ({ openRoomLink: () => undefined }));
const checkDmLink = vi.hoisted(() => vi.fn());
vi.mock('./dms', () => ({ checkDmLink }));
const openEventLink = vi.hoisted(() => vi.fn());
vi.mock('./calendar', () => ({ openEventLink }));
const openWikiLink = vi.hoisted(() => vi.fn());
vi.mock('./wiki', () => ({ openWikiLink }));
const openDiskLink = vi.hoisted(() => vi.fn());
vi.mock('./diskLink', () => ({ openDiskLink }));

const { INVITE_EXAMPLE_CODE, diskItemUrl, handleDeepLink, inviteUrl, joinPlaceholder, openOwnLink, ownDiskItemId, ownWikiPageId, parseBoardLink, parseDiskLink, parseDmLink, parseEventLink, parseInviteCode, parseMessageLink, parseRoomInviteCode, parseWikiLink, roomInviteUrl, wikiPageUrl } = await import('./links');

describe('DM links (ADR-0020)', () => {
  const ID = '00000000-0000-7000-8003-000000000021';
  it('parses calab://dm/<id> and https://<server>/dm/<id>, nothing else', () => {
    expect(parseDmLink(`calab://dm/${ID}`)).toBe(ID);
    expect(parseDmLink(`calaba://dm/${ID}/`)).toBe(ID);
    expect(parseDmLink(`https://app.calab.io/dm/${ID.toUpperCase()}?x=1`)).toBe(ID);
    expect(parseDmLink('calab://dm/abcd1234')).toBeNull();
    expect(parseDmLink(`https://app.calab.io/r/${ID}`)).toBeNull();
  });
  it('opens the DM in «Личные»', async () => {
    handleDeepLink(`calab://dm/${ID}`);
    expect(openRoom).toHaveBeenCalledWith('@me', ID);
    // Someone else's id: a clear error once signed in (services/dms.ts checkDmLink).
    await vi.waitFor(() => expect(checkDmLink).toHaveBeenCalledWith(ID));
  });
});

describe('meeting links (ADR-0038)', () => {
  const ID = '00000000-0000-7000-8010-000000000001';
  it('parses https://<server>/e/<id> and calab://e/<id>, not the answer page', () => {
    expect(parseEventLink(`https://app.calab.io/e/${ID}`)).toBe(ID);
    expect(parseEventLink(`https://app.calab.io/e/${ID.toUpperCase()}/?utm=mail`)).toBe(ID);
    expect(parseEventLink(`calab://e/${ID}`)).toBe(ID);
    expect(parseEventLink(`https://app.calab.io/e/${ID}/rsvp?t=x`)).toBeNull();
    expect(parseEventLink('https://app.calab.io/e/abcd1234')).toBeNull();
    expect(parseEventLink(`https://app.calab.io/dm/${ID}`)).toBeNull();
  });
  it('opens the meeting card (after sign-in if need be)', async () => {
    handleDeepLink(`https://app.calab.io/e/${ID}`);
    await vi.waitFor(() => expect(openEventLink).toHaveBeenCalledWith(ID));
    expect(openRoom).not.toHaveBeenCalledWith('@me', ID);
  });
});

describe('invite links', () => {
  it('parses https links, deep links and bare codes', () => {
    expect(parseInviteCode('https://colaba.gptunnel.ai/join/AbC_12-x')).toBe('AbC_12-x');
    expect(parseInviteCode(' https://example.org/join/abcd1234/ ')).toBe('abcd1234');
    expect(parseInviteCode('http://localhost:4173/join/abcd1234?utm=x')).toBe('abcd1234');
    expect(parseInviteCode('calab://join/abcd1234')).toBe('abcd1234');
    expect(parseInviteCode('calaba://join/abcd1234')).toBe('abcd1234'); // legacy scheme
    expect(parseInviteCode('abcd1234')).toBe('abcd1234');
  });
  it('rejects anything else', () => {
    expect(parseInviteCode('https://example.org/rooms/abcd1234')).toBeNull();
    expect(parseInviteCode('abc')).toBeNull();
    expect(parseInviteCode('https://example.org/join/abcd1234/extra')).toBeNull();
  });
  it('builds the shareable link from the server URL', () => {
    expect(inviteUrl('https://colaba.gptunnel.ai', 'abcd1234')).toBe('https://colaba.gptunnel.ai/join/abcd1234');
    expect(inviteUrl('https://colaba.gptunnel.ai/', 'abcd1234')).toBe('https://colaba.gptunnel.ai/join/abcd1234');
  });
});

describe('shared links are https only (docs/09 #53)', () => {
  afterEach(() => {
    session.settings = null;
    vi.unstubAllEnvs();
  });
  it('never falls back to a deep link', () => {
    expect(inviteUrl('', 'abcd1234')).toBeNull();
    expect(roomInviteUrl('', 'abcd1234')).toBeNull();
    expect(inviteUrl('calab://join', 'abcd1234')).toBeNull();
  });
  it('falls back to the configured server URL', () => {
    session.settings = { serverUrl: 'https://app.calab.io/' };
    expect(inviteUrl('', 'abcd1234')).toBe('https://app.calab.io/join/abcd1234');
    expect(roomInviteUrl('', 'abcd1234')).toBe('https://app.calab.io/r/abcd1234');
  });
  it('prefers the session server over settings', () => {
    session.settings = { serverUrl: 'https://old.example.org' };
    expect(inviteUrl('https://app.calab.io', 'abcd1234')).toBe('https://app.calab.io/join/abcd1234');
  });
  it('on the web uses the page origin', () => {
    vi.stubEnv('VITE_PLATFORM', 'web');
    vi.stubGlobal('location', { origin: 'https://app.calab.io' });
    try {
      expect(inviteUrl('', 'abcd1234')).toBe('https://app.calab.io/join/abcd1234');
      expect(roomInviteUrl('', 'abcd1234')).toBe('https://app.calab.io/r/abcd1234');
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('does not use the page origin in the desktop app (file:// or the dev server)', () => {
    vi.stubGlobal('location', { origin: 'http://localhost:5173' });
    try {
      expect(inviteUrl('', 'abcd1234')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('room links', () => {
  it('parses https and deep links', () => {
    expect(parseRoomInviteCode('https://colaba.gptunnel.ai/r/AbC_12-x')).toBe('AbC_12-x');
    expect(parseRoomInviteCode(' http://localhost:5183/r/abcd1234/?x=1 ')).toBe('abcd1234');
    expect(parseRoomInviteCode('calab://r/abcd1234')).toBe('abcd1234');
    expect(parseRoomInviteCode('calaba://r/abcd1234')).toBe('abcd1234'); // legacy scheme
  });
  it('rejects bare codes and workspace invites', () => {
    expect(parseRoomInviteCode('abcd1234')).toBeNull();
    expect(parseRoomInviteCode('https://example.org/join/abcd1234')).toBeNull();
    expect(parseInviteCode('https://example.org/r/abcd1234')).toBeNull();
    expect(parseRoomInviteCode('https://example.org/r/abcd1234/extra')).toBeNull();
  });
  it('builds the shareable link', () => {
    expect(roomInviteUrl('https://colaba.gptunnel.ai/', 'abcd1234')).toBe('https://colaba.gptunnel.ai/r/abcd1234');
  });
});

describe('join dialog placeholder', () => {
  afterEach(() => {
    session.settings = null;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  it('is a real-looking link on the session server', () => {
    expect(joinPlaceholder('https://app.calab.io')).toBe('https://app.calab.io/join/AbC123xYz');
    expect(joinPlaceholder('https://app.calab.io/')).toBe('https://app.calab.io/join/AbC123xYz');
  });
  it('falls back to the configured server, then to the web page origin', () => {
    session.settings = { serverUrl: 'https://team.example.org' };
    expect(joinPlaceholder('')).toBe('https://team.example.org/join/AbC123xYz');
    session.settings = null;
    vi.stubEnv('VITE_PLATFORM', 'web');
    vi.stubGlobal('location', { origin: 'https://web.example.org' });
    expect(joinPlaceholder('')).toBe('https://web.example.org/join/AbC123xYz');
  });
  it('is the bare example code without a server', () => {
    expect(joinPlaceholder('')).toBe('AbC123xYz');
  });
  it('the example itself is accepted by the parser (it shows a valid shape)', () => {
    expect(parseInviteCode(joinPlaceholder('https://app.calab.io'))).toBe(INVITE_EXAMPLE_CODE);
    expect(parseInviteCode(joinPlaceholder(''))).toBe(INVITE_EXAMPLE_CODE);
  });
});

describe('board, task and message links (ADR-0042)', () => {
  const B = '0190a0b0-0000-7000-80b1-000000000001';
  const M = '0190a0b0-0000-7000-8004-000000000002';
  it('parses /b/<id>, /t/<KEY-N> and /m/<room>/<message> in both forms', () => {
    expect(parseBoardLink(`https://app.calab.io/b/${B}`)).toEqual({ kind: 'board', id: B });
    expect(parseBoardLink('calab://t/cal-12')).toEqual({ kind: 'task', id: 'CAL-12' });
    expect(parseBoardLink('https://app.calab.io/t/FNG-98?x=1')).toEqual({ kind: 'task', id: 'FNG-98' });
    expect(parseBoardLink('https://app.calab.io/t/9X-1')).toBeNull();
    expect(parseMessageLink(`https://app.calab.io/m/${B}/${M}`)).toEqual({ roomId: B, messageId: M });
    expect(parseMessageLink(`calab://m/${B}/${M}`)).toEqual({ roomId: B, messageId: M });
    expect(parseMessageLink(`https://app.calab.io/m/${B}`)).toBeNull();
  });
});

describe('wiki page links (owner 14.10)', () => {
  const P = '0190a0b0-0000-7000-80c1-000000000003';
  afterEach(() => {
    session.settings = null;
  });
  it('parses https://<server>/wiki/<id> and calab://wiki/<id>, nothing else', () => {
    expect(parseWikiLink(`https://app.calab.io/wiki/${P}`)).toBe(P);
    expect(parseWikiLink(`calab://wiki/${P.toUpperCase()}/`)).toBe(P);
    expect(parseWikiLink(`/wiki/${P}`)).toBeNull();
    expect(parseWikiLink(`https://app.calab.io/w/${P}`)).toBeNull();
    expect(parseWikiLink('https://app.calab.io/wiki/abc')).toBeNull();
  });
  it('builds the address on this server and recognises only this server as own', () => {
    session.settings = { serverUrl: 'https://app.calab.io/' };
    expect(wikiPageUrl(P)).toBe(`https://app.calab.io/wiki/${P}`);
    expect(ownWikiPageId(`https://app.calab.io/wiki/${P}`)).toBe(P);
    expect(ownWikiPageId(`https://other.test/wiki/${P}`)).toBeNull();
  });
  it('opens the page in the app (deep link, a click in a message)', async () => {
    handleDeepLink(`calab://wiki/${P}`);
    await vi.waitFor(() => expect(openWikiLink).toHaveBeenCalledWith(P));
    openWikiLink.mockClear();
    session.settings = { serverUrl: 'https://app.calab.io' };
    expect(openOwnLink(`https://app.calab.io/wiki/${P}`)).toBe(true);
    await vi.waitFor(() => expect(openWikiLink).toHaveBeenCalledWith(P));
    expect(openOwnLink(`https://other.test/wiki/${P}`)).toBe(false);
  });
});

describe('disk item links (CBF-20)', () => {
  const D = '0190a0b0-0000-7000-80c1-0000000000d1';
  afterEach(() => {
    session.settings = null;
  });
  it('parses https://<server>/disk/<id> and calab://disk/<id>, nothing else', () => {
    expect(parseDiskLink(`https://app.calab.io/disk/${D}`)).toBe(D);
    expect(parseDiskLink(`calab://disk/${D.toUpperCase()}/`)).toBe(D);
    expect(parseDiskLink(`/disk/${D}`)).toBeNull();
    expect(parseDiskLink('https://app.calab.io/disk/abc')).toBeNull();
  });
  it('builds the address on this server and opens it in the app', async () => {
    session.settings = { serverUrl: 'https://app.calab.io/' };
    expect(diskItemUrl(D)).toBe(`https://app.calab.io/disk/${D}`);
    expect(ownDiskItemId(`https://app.calab.io/disk/${D}`)).toBe(D);
    expect(ownDiskItemId(`https://other.test/disk/${D}`)).toBeNull();
    expect(openOwnLink(`https://app.calab.io/disk/${D}`)).toBe(true);
    await vi.waitFor(() => expect(openDiskLink).toHaveBeenCalledWith(D));
    expect(openOwnLink(`https://other.test/disk/${D}`)).toBe(false);
  });
});

describe('own-host links open in the app (CBF-63)', () => {
  afterEach(() => {
    session.settings = null;
  });
  it('claims every in-app route of this server, not unknown paths or other hosts', () => {
    session.settings = { serverUrl: 'https://app.calab.io' };
    const ID = '00000000-0000-7000-8003-000000000021';
    for (const p of ['t/CBF-63', `dm/${ID}`, `e/${ID}`, 'r/AbCd1234', 'join/AbCd1234', `b/${ID}`]) {
      expect(openOwnLink(`https://app.calab.io/${p}`), p).toBe(true);
    }
    expect(openOwnLink('https://app.calab.io/download/')).toBe(false);
    expect(openOwnLink(`https://app.calab.io/e/${ID}/rsvp?t=x`)).toBe(false);
    expect(openOwnLink('https://other.test/t/CBF-63')).toBe(false);
  });
});
