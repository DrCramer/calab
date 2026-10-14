import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { wikiPageHref, wikiPageIdOf } from './links';
import { fromMarkdown, toMarkdown, type PmNode } from './markdown';
import { wikiSchema } from './schema';
import { docToJSON, docToMarkdown, setDocMarkdown } from './ydoc';

const ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const link: PmNode = { type: 'wikiPageLink', attrs: { pageId: ID } };
const doc = (...content: PmNode[]): PmNode => ({ type: 'doc', content: [{ type: 'paragraph', content }] });

describe('wikiPageIdOf', () => {
  it('matches the page path on any origin, case-insensitive id', () => {
    expect(wikiPageIdOf(`https://app.calab.io/wiki/${ID}`)).toBe(ID);
    expect(wikiPageIdOf(`http://localhost:5173/wiki/${ID.toUpperCase()}/`)).toBe(ID);
    expect(wikiPageIdOf(`https://x.test/wiki/${ID}?a=1#h`)).toBe(ID);
    expect(wikiPageIdOf(`/wiki/${ID}`)).toBe(ID);
  });

  it('rejects other paths and schemes', () => {
    expect(wikiPageIdOf(`https://x.test/w/${ID}`)).toBeNull();
    expect(wikiPageIdOf(`https://x.test/a/wiki/${ID}`)).toBeNull();
    expect(wikiPageIdOf(`https://x.test/wiki/${ID}/edit`)).toBeNull();
    expect(wikiPageIdOf(`javascript:/wiki/${ID}`)).toBeNull();
    expect(wikiPageIdOf('https://x.test/wiki/not-an-id')).toBeNull();
  });

  it('builds the address', () => {
    expect(wikiPageHref('https://x.test/', ID)).toBe(`https://x.test/wiki/${ID}`);
    expect(wikiPageHref('', ID)).toBe(`/wiki/${ID}`);
  });
});

describe('wikiPageLink in Markdown', () => {
  it('writes the title and the address', () => {
    const md = toMarkdown(doc({ type: 'text', text: 'see ' }, link), { pageUrl: (id) => `https://x.test/wiki/${id}`, pageTitle: () => 'Plan [v2] *draft*' });
    expect(md).toBe(`see [Plan v2 \\*draft\\*](https://x.test/wiki/${ID})\n`);
  });

  it('falls back to the address as the text and the bare path as the address', () => {
    expect(toMarkdown(doc(link))).toBe(`[/wiki/${ID}](/wiki/${ID})\n`);
  });

  it('parses page links back from any origin, bare URLs and the bare path', () => {
    expect(fromMarkdown(`see [Plan](https://other.test/wiki/${ID})`)).toEqual(doc({ type: 'text', text: 'see ' }, link));
    expect(fromMarkdown(`https://app.calab.io/wiki/${ID}`)).toEqual(doc(link));
    expect(fromMarkdown(`[x](/wiki/${ID})`)).toEqual(doc(link));
    // Not a page address: an ordinary link.
    expect(fromMarkdown('[x](https://x.test/wiki/nope)')).toEqual(doc({ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'https://x.test/wiki/nope' } }] }));
  });

  it('round-trips through Markdown', () => {
    const src = doc({ type: 'text', text: 'a ' }, link, { type: 'text', text: ' b' });
    expect(fromMarkdown(toMarkdown(src, { pageUrl: (id) => `https://x.test/wiki/${id}`, pageTitle: () => 'T' }))).toEqual(src);
    expect(fromMarkdown(toMarkdown(src))).toEqual(src);
  });

  it('is in the schema and survives the Yjs binding', () => {
    expect(wikiSchema().nodes['wikiPageLink']).toBeDefined();
    const y = new Y.Doc();
    setDocMarkdown(y, `Link: [Plan](https://x.test/wiki/${ID})`);
    expect(docToJSON(y)).toEqual(doc({ type: 'text', text: 'Link: ' }, link));
    expect(docToMarkdown(y, { pageUrl: (id) => `https://y.test/wiki/${id}`, pageTitle: () => 'Plan' })).toBe(`Link: [Plan](https://y.test/wiki/${ID})\n`);
  });
});
