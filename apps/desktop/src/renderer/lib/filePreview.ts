import type { FileMeta } from '@calaba/protocol';
import { isImageAttachment } from './imageAttachment';

/**
 * What a click on a file attachment opens (ADR-0103): a picture → the Lightbox, a PDF → the PDF
 * viewer (Chromium's built-in one in a blob: frame), anything else → a download. Kept pure for
 * unit tests.
 */
export type FilePreview = 'image' | 'pdf' | null;

/**
 * The largest PDF previewed: the viewer holds the whole file in memory (a blob) while open; a
 * bigger one is downloaded as before.
 */
export const PDF_PREVIEW_MAX = 50 * 1024 * 1024;

/**
 * `phone`: the phone shell (ADR-0067) has no PDF viewer in its WebView (Android), so PDFs are
 * downloaded there. A picture is what lib/imageAttachment says (a thumbnail is not required:
 * owner 28.10), like «Открыть» on the Disk (lib/disk.ts previewable).
 */
export function filePreview(f: Pick<FileMeta, 'mime' | 'name' | 'size' | 'width' | 'height' | 'thumbnailUrl' | 'voice'>, phone: boolean): FilePreview {
  const mime = f.mime.toLowerCase();
  if (isImageAttachment(f)) return 'image';
  if (mime === 'application/pdf' && !phone && f.size <= BigInt(PDF_PREVIEW_MAX)) return 'pdf';
  return null;
}
