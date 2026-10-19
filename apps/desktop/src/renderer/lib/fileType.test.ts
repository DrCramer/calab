import { describe, expect, it } from 'vitest';
import { fileType } from './fileType';

const f = (name: string, mime = 'application/octet-stream') => ({ name, mime });

describe('fileType', () => {
  it('maps extensions to families', () => {
    expect(fileType(f('a.DOCX'))).toEqual({ family: 'doc', label: 'DOCX' });
    expect(fileType(f('b.xlsx')).family).toBe('sheet');
    expect(fileType(f('b.csv')).family).toBe('sheet');
    expect(fileType(f('c.key')).family).toBe('slides');
    expect(fileType(f('d.pdf')).family).toBe('pdf');
    expect(fileType(f('e.7z')).family).toBe('archive');
    expect(fileType(f('f.go')).family).toBe('code');
    expect(fileType(f('g.fig')).family).toBe('design');
    expect(fileType(f('h.md')).family).toBe('text');
  });
  it('falls back to the mime, then to other', () => {
    expect(fileType(f('voice', 'audio/ogg')).family).toBe('audio');
    expect(fileType(f('clip.bin', 'video/mp4')).family).toBe('video');
    expect(fileType(f('pic', 'image/png')).family).toBe('image');
    expect(fileType(f('notes', 'text/plain')).family).toBe('text');
    expect(fileType(f('blob'))).toEqual({ family: 'other', label: '' });
    expect(fileType(f('.hidden'))).toEqual({ family: 'other', label: '' });
    expect(fileType(undefined).family).toBe('other');
  });
  it('clips a long extension to four letters', () => {
    expect(fileType(f('x.torrent2')).label).toBe('TORR');
  });
});
