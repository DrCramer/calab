import type { FileMeta } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { parseCsv, previewKind, stepSibling, textKind, textTooLarge, TEXT_PREVIEW_MAX } from './diskPreview';

const file = (name: string, mime: string, size = 100, thumbnailUrl = ''): FileMeta => ({ name, mime, size: BigInt(size), thumbnailUrl }) as unknown as FileMeta;

describe('textKind', () => {
  it('recognises text-like files by extension and mime', () => {
    expect(textKind({ name: 'README.md', mime: 'application/octet-stream' })).toBe('markdown');
    expect(textKind({ name: 'data.CSV', mime: 'text/csv' })).toBe('csv');
    expect(textKind({ name: 'a.json', mime: 'application/json' })).toBe('code');
    expect(textKind({ name: 'main.go', mime: 'application/octet-stream' })).toBe('code');
    expect(textKind({ name: 'server.log', mime: 'application/octet-stream' })).toBe('text');
    expect(textKind({ name: 'notes', mime: 'text/plain' })).toBe('text');
    expect(textKind({ name: 'x.bin', mime: 'application/octet-stream' })).toBeNull();
    expect(textKind({ name: 'pic.svg', mime: 'image/svg+xml' })).toBeNull();
  });
});

describe('previewKind', () => {
  it('picks the viewer', () => {
    expect(previewKind(file('a.png', 'image/png', 10, 'x'), false)).toBe('image');
    expect(previewKind(file('a.png', 'image/png'), false)).toBe('card');
    expect(previewKind(file('a.mp4', 'video/mp4'), false)).toBe('video');
    expect(previewKind(file('a.pdf', 'application/pdf'), false)).toBe('pdf');
    expect(previewKind(file('a.pdf', 'application/pdf'), true)).toBe('card');
    expect(previewKind(file('a.mp3', 'audio/mpeg'), false)).toBe('audio');
    expect(previewKind(file('a.md', 'text/markdown'), false)).toBe('text');
    expect(previewKind(file('a.xlsx', 'application/vnd.ms-excel'), false)).toBe('card');
    expect(previewKind(undefined, false)).toBe('card');
  });
  it('flags text over the cap', () => {
    expect(textTooLarge({ size: BigInt(TEXT_PREVIEW_MAX) })).toBe(false);
    expect(textTooLarge({ size: BigInt(TEXT_PREVIEW_MAX + 1) })).toBe(true);
  });
});

describe('parseCsv', () => {
  it('handles quotes, escaped quotes and newlines in cells', () => {
    const { rows, capped } = parseCsv('a,"b,c","d ""x"""\n1,2,"l1\nl2"\r\n', ',');
    expect(rows).toEqual([
      ['a', 'b,c', 'd "x"'],
      ['1', '2', 'l1\nl2'],
    ]);
    expect(capped).toBe(false);
  });
  it('caps rows and columns', () => {
    const { rows, capped } = parseCsv('1,2,3,4\n5,6,7,8\n9,9,9,9', ',', 2, 3);
    expect(rows).toEqual([
      ['1', '2', '3'],
      ['5', '6', '7'],
    ]);
    expect(capped).toBe(true);
  });
  it('supports tabs and a last row without a newline', () => {
    expect(parseCsv('a\tb\nc\td', '\t').rows).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });
});

describe('stepSibling', () => {
  it('moves without wrapping', () => {
    expect(stepSibling(['a', 'b', 'c'], 'b', 1)).toBe('c');
    expect(stepSibling(['a', 'b', 'c'], 'c', 1)).toBeNull();
    expect(stepSibling(['a', 'b', 'c'], 'a', -1)).toBeNull();
    expect(stepSibling(['a'], 'z', 1)).toBeNull();
  });
});
