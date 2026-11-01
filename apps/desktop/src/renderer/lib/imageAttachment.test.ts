import type { FileMeta } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { imageSteps, isImageAttachment, ORIGINAL_PREVIEW_MAX } from './imageAttachment';
import { filePreview } from './filePreview';

const file = (name: string, mime: string, extra: Partial<{ size: number; width: number; height: number; thumbnailUrl: string; voice: object }> = {}): FileMeta =>
  ({ id: 'f', name, mime, size: BigInt(extra.size ?? 117_000), width: extra.width ?? 0, height: extra.height ?? 0, thumbnailUrl: extra.thumbnailUrl ?? '', voice: extra.voice }) as unknown as FileMeta;

describe('imageSteps', () => {
  it('a normal png: its thumbnail, then the original', () => {
    expect(imageSteps(file('a.png', 'image/png', { thumbnailUrl: '/api/files/f/thumbnail', width: 800, height: 600 }))).toEqual(['thumb', 'original']);
  });
  it('owner 28.10: a png whose upload made no thumbnail is still a picture', () => {
    const f = file('image.png', 'image/png', { width: 2880, height: 1800 });
    expect(isImageAttachment(f)).toBe(true);
    // The thumbnail request makes the missing one on the server (files/backfill.go).
    expect(imageSteps(f)).toEqual(['thumb', 'original']);
  });
  it('a png stored with a wrong type: the extension decides', () => {
    expect(imageSteps(file('image.png', 'application/octet-stream'))).toEqual(['thumb', 'original']);
    expect(imageSteps(file('IMG_1.JPG', ''))).toEqual(['thumb', 'original']);
    expect(imageSteps(file('pic.avif', 'application/octet-stream'))).toEqual(['original']);
  });
  it('types the server does not thumbnail: the original only', () => {
    expect(imageSteps(file('a.avif', 'image/avif'))).toEqual(['original']);
    expect(imageSteps(file('a.bmp', 'image/bmp'))).toEqual(['original']);
  });
  it('a huge original is not drawn in the feed', () => {
    expect(imageSteps(file('big.png', 'image/png', { size: ORIGINAL_PREVIEW_MAX + 1 }))).toEqual(['thumb']);
    expect(imageSteps(file('long.png', 'image/png', { width: 8000, height: 6000 }))).toEqual(['thumb']);
    expect(isImageAttachment(file('big.avif', 'image/avif', { size: ORIGINAL_PREVIEW_MAX + 1 }))).toBe(false);
  });
  it('not pictures: SVG, HEIC, other files, a known non-image type behind an image name, voice', () => {
    expect(isImageAttachment(file('a.svg', 'image/svg+xml'))).toBe(false);
    expect(isImageAttachment(file('a.svg', 'application/octet-stream'))).toBe(false);
    expect(isImageAttachment(file('a.heic', 'image/heic'))).toBe(false);
    expect(isImageAttachment(file('a.pdf', 'application/pdf'))).toBe(false);
    expect(isImageAttachment(file('a.zip', 'application/octet-stream'))).toBe(false);
    expect(isImageAttachment(file('fake.png', 'text/plain'))).toBe(false);
    expect(isImageAttachment(file('v.png', 'image/png', { voice: {} }))).toBe(false);
  });
});

describe('filePreview', () => {
  it('opens a picture without a thumbnail in the Lightbox, not as a download', () => {
    expect(filePreview(file('image.png', 'image/png'), false)).toBe('image');
    expect(filePreview(file('image.png', 'application/octet-stream'), false)).toBe('image');
    expect(filePreview(file('a.svg', 'image/svg+xml'), false)).toBeNull();
    expect(filePreview(file('a.bin', 'application/octet-stream'), false)).toBeNull();
  });
});
