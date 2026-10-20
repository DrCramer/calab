import type { FileMeta } from '@calaba/protocol';
import { previewable } from './disk';
import { filePreview } from './filePreview';
import { extOf } from './fileType';

/**
 * What a Disk file opens in (CBF-22; ADR-0094): the viewer by kind. Pure, unit-tested in Node.
 * Images / video / PDF keep their viewers, audio plays in the chat's player, text-like files open
 * in a read-only viewer, anything else gets the file card.
 */
export type PreviewKind = 'image' | 'video' | 'pdf' | 'audio' | 'text' | 'card';

/** The largest text file fetched for the viewer; a bigger one shows «Слишком большой» + «Скачать». */
export const TEXT_PREVIEW_MAX = 1024 * 1024;
/** CSV is drawn as a table of at most this many rows and columns. */
export const CSV_MAX_ROWS = 200;
export const CSV_MAX_COLS = 30;

export type TextKind = 'markdown' | 'csv' | 'code' | 'text';

const MARKDOWN = new Set(['md', 'markdown']);
const CSV = new Set(['csv', 'tsv']);
const PLAIN = new Set(['txt', 'log', 'ini', 'cfg', 'conf', 'env', 'diff', 'patch']);
const CODE = new Set([
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'json', 'jsonl', 'go', 'py', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'cs', 'rb', 'php',
  'html', 'css', 'scss', 'yml', 'yaml', 'sh', 'sql', 'xml', 'toml', 'svg',
]);
const CODE_MIME = /^application\/(json|xml|javascript|x-sh|x-yaml|sql)$/;

/** The text viewer's mode for a file, or null when it is not a text-like file (by extension, then mime). */
export function textKind(f: Pick<FileMeta, 'mime' | 'name'>): TextKind | null {
  const ext = extOf(f.name);
  if (MARKDOWN.has(ext)) return 'markdown';
  if (CSV.has(ext)) return 'csv';
  if (CODE.has(ext) && ext !== 'svg') return 'code';
  if (PLAIN.has(ext)) return 'text';
  const mime = f.mime.toLowerCase();
  if (mime === 'text/markdown') return 'markdown';
  if (mime === 'text/csv' || mime === 'text/tab-separated-values') return 'csv';
  if (CODE_MIME.test(mime) || mime === 'text/html' || mime === 'text/css' || mime === 'text/javascript') return 'code';
  if (mime.startsWith('text/')) return 'text';
  return null;
}

/** Files over the cap are not fetched. */
export const textTooLarge = (f: Pick<FileMeta, 'size'>): boolean => f.size > BigInt(TEXT_PREVIEW_MAX);

/** The viewer a file opens in. `phone`: the shell has no PDF viewer (filePreview). */
export function previewKind(f: FileMeta | undefined, phone: boolean): PreviewKind {
  if (!f) return 'card';
  const p = previewable(f);
  if (p) return p;
  if (filePreview(f, phone) === 'pdf') return 'pdf';
  if (f.mime.toLowerCase().startsWith('audio/')) return 'audio';
  if (textKind(f)) return 'text';
  return 'card';
}

/**
 * Parses CSV / TSV (RFC 4180 quoting: `""` inside quotes, newlines inside quotes) into at most
 * `maxRows` rows of at most `maxCols` cells. `capped`: more rows existed.
 */
export function parseCsv(text: string, delimiter: string, maxRows = CSV_MAX_ROWS, maxCols = CSV_MAX_COLS): { rows: string[][]; capped: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let capped = false;
  const endCell = (): void => {
    if (row.length < maxCols) row.push(cell);
    cell = '';
  };
  const endRow = (): boolean => {
    endCell();
    if (rows.length >= maxRows) {
      capped = true;
      return false;
    }
    rows.push(row);
    row = [];
    return true;
  };
  let more = true;
  for (let i = 0; i < text.length && more; i++) {
    const c = text[i] ?? '';
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === delimiter) endCell();
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      more = endRow();
    } else cell += c;
  }
  if (more && (cell !== '' || row.length > 0)) endRow();
  return { rows, capped };
}

/** The neighbour (±1) of `current` in `ids`; null at the ends (no wrap, like the Lightbox). */
export function stepSibling(ids: readonly string[], current: string, dir: 1 | -1): string | null {
  const i = ids.indexOf(current);
  if (i < 0) return null;
  return ids[i + dir] ?? null;
}
