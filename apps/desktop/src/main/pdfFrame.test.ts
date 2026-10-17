import { describe, expect, it } from 'vitest';
import { PDF_VIEWER_ORIGIN, isPdfViewerFrame } from './pdfFrame';

describe('isPdfViewerFrame', () => {
  it('lets the blob: frame of our packaged page and the viewer extension through', () => {
    expect(isPdfViewerFrame('blob:file:///d1844b69-abef-4d6d-96d9-5f53de97ebd1', undefined)).toBe(true);
    expect(isPdfViewerFrame(`${PDF_VIEWER_ORIGIN}/index.html`, undefined)).toBe(true);
    expect(isPdfViewerFrame(`${PDF_VIEWER_ORIGIN}/96847f61-5ea4-4345-8d3a-f3024033688a`, undefined)).toBe(true);
  });

  it('dev: blobs of the dev server origin only', () => {
    expect(isPdfViewerFrame('blob:http://localhost:5173/abc', 'http://localhost:5173/')).toBe(true);
    expect(isPdfViewerFrame('blob:http://localhost:5174/abc', 'http://localhost:5173/')).toBe(false);
    expect(isPdfViewerFrame('blob:http://localhost:5173/abc', undefined)).toBe(false);
  });

  it('nothing else: other blobs, other extensions, web pages, look-alike prefixes', () => {
    expect(isPdfViewerFrame('blob:https://evil.example/abc', undefined)).toBe(false);
    expect(isPdfViewerFrame('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/index.html', undefined)).toBe(false);
    expect(isPdfViewerFrame(`${PDF_VIEWER_ORIGIN}.evil/x`, undefined)).toBe(false);
    expect(isPdfViewerFrame('https://example.com/a.pdf', undefined)).toBe(false);
    expect(isPdfViewerFrame('file:///Users/x/Downloads/a.html', undefined)).toBe(false);
    expect(isPdfViewerFrame('data:application/pdf;base64,AAAA', undefined)).toBe(false);
  });
});
