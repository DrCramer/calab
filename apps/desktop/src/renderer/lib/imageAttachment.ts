import type { FileMeta } from '@calaba/protocol';
import { extOf } from './fileType';

/**
 * Is an attachment a picture (shown as a preview, opened in the Lightbox) or a plain file (a chip,
 * downloaded)? Owner 28.10: a PNG whose upload-time server thumbnail failed carried no
 * thumbnail_url and was drawn as a file chip. The type and the name decide now; the thumbnail is
 * one way to draw the preview, not a condition for it. Pure, unit-tested.
 *
 * How the preview is drawn — the steps tried in order, the next one on a load error:
 *  - `thumb`: GET /api/files/{id}/thumbnail. Also tried without thumbnail_url for the types the
 *    server thumbnails: the server makes a missing thumbnail on that request (files/backfill.go).
 *  - `original`: the file itself, for the types Chromium decodes (AVIF, BMP… have no server
 *    thumbnail) and as the fallback of a picture the server could not thumbnail (over its
 *    MaxPixels), within ORIGINAL_PREVIEW_MAX bytes and ORIGINAL_PREVIEW_MAX_PIXELS.
 * No step left → a plain file. SVG never is a picture here (active content, never inlined), nor
 * HEIC (Chromium does not decode it).
 */
export type ImageStep = 'thumb' | 'original';

/** The largest original drawn in the feed in place of a missing thumbnail (bytes). */
export const ORIGINAL_PREVIEW_MAX = 20 * 1024 * 1024;
/** …and pixels (a decoded 40 MP picture is ~160 MB of memory). */
export const ORIGINAL_PREVIEW_MAX_PIXELS = 40_000_000;

/** Types the server thumbnails (pbconv.IsImage) and their extensions. */
const SERVER_THUMB_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const SERVER_THUMB_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
/** Raster types Chromium decodes in an <img>. */
const RASTER_MIME = new Set([...SERVER_THUMB_MIME, 'image/avif', 'image/bmp', 'image/apng', 'image/x-icon', 'image/pjpeg', 'image/jpg']);
const RASTER_EXT = new Set([...SERVER_THUMB_EXT, 'avif', 'bmp', 'apng', 'jfif', 'ico']);
/** A stored type that says nothing: the name's extension decides. */
const UNKNOWN_MIME = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

type ImageFields = Pick<FileMeta, 'mime' | 'name' | 'size' | 'width' | 'height' | 'thumbnailUrl'> & { voice?: unknown };

export function imageSteps(f: ImageFields): ImageStep[] {
  if (f.voice) return [];
  const mime = f.mime.toLowerCase().split(';')[0]?.trim() ?? '';
  const unknown = UNKNOWN_MIME.has(mime);
  const ext = unknown ? extOf(f.name) : '';
  const steps: ImageStep[] = [];
  if ((f.thumbnailUrl && mime.startsWith('image/')) || SERVER_THUMB_MIME.has(mime) || SERVER_THUMB_EXT.has(ext)) steps.push('thumb');
  const raster = RASTER_MIME.has(mime) || RASTER_EXT.has(ext);
  const pixels = f.width && f.height ? f.width * f.height : 0;
  if (raster && Number(f.size) <= ORIGINAL_PREVIEW_MAX && pixels <= ORIGINAL_PREVIEW_MAX_PIXELS) steps.push('original');
  return steps;
}

/** The attachment is shown as a picture (see imageSteps). */
export const isImageAttachment = (f: ImageFields): boolean => imageSteps(f).length > 0;
