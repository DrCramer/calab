import type { FileMeta } from '@calaba/protocol';

/**
 * The look of a file's type icon (CBF-22): a family (drives the colour) and the extension label
 * written on the plate. Pure, so the mapping is unit-tested in Node (features/disk/visuals.tsx draws it).
 */
export type FileFamily = 'doc' | 'sheet' | 'slides' | 'pdf' | 'archive' | 'code' | 'design' | 'audio' | 'video' | 'image' | 'text' | 'other';

export interface FileType {
  family: FileFamily;
  /** Upper-case extension, at most four characters ('' when the name has none). */
  label: string;
}

const EXT: Record<string, FileFamily> = {
  doc: 'doc', docx: 'doc', odt: 'doc', rtf: 'doc', pages: 'doc',
  xls: 'sheet', xlsx: 'sheet', ods: 'sheet', csv: 'sheet', numbers: 'sheet', tsv: 'sheet',
  ppt: 'slides', pptx: 'slides', odp: 'slides', key: 'slides',
  pdf: 'pdf',
  zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive', tgz: 'archive', bz2: 'archive', xz: 'archive',
  js: 'code', jsx: 'code', ts: 'code', tsx: 'code', json: 'code', go: 'code', py: 'code', rs: 'code', java: 'code', kt: 'code', swift: 'code',
  c: 'code', h: 'code', cpp: 'code', cs: 'code', rb: 'code', php: 'code', html: 'code', css: 'code', scss: 'code', yml: 'code', yaml: 'code',
  sh: 'code', sql: 'code', xml: 'code', toml: 'code',
  fig: 'design', sketch: 'design', psd: 'design', ai: 'design', xd: 'design', indd: 'design',
  txt: 'text', md: 'text', log: 'text', markdown: 'text',
  mp3: 'audio', wav: 'audio', flac: 'audio', ogg: 'audio', m4a: 'audio', aac: 'audio', opus: 'audio',
  mp4: 'video', mov: 'video', mkv: 'video', webm: 'video', avi: 'video',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', heic: 'image', bmp: 'image',
};

/** The lower-case extension of a file name ('' for none or a dot-file). */
export function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function fileType(f: Pick<FileMeta, 'mime' | 'name'> | undefined): FileType {
  if (!f) return { family: 'other', label: '' };
  const ext = extOf(f.name);
  const label = ext.slice(0, 4).toUpperCase();
  const mime = f.mime.toLowerCase();
  let family: FileFamily | undefined = EXT[ext];
  if (!family) {
    if (mime.startsWith('image/')) family = 'image';
    else if (mime.startsWith('video/')) family = 'video';
    else if (mime.startsWith('audio/')) family = 'audio';
    else if (mime === 'application/pdf') family = 'pdf';
    else if (mime.startsWith('text/')) family = 'text';
    else family = 'other';
  }
  return { family, label };
}
