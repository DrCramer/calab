/**
 * The PDF viewer's sub-frames (ADR-0103), let through the navigation guard (windows.ts
 * guardWebContents): the renderer shows a PDF as a blob: URL of its own page in an <iframe>, and
 * Chromium's built-in viewer then navigates that frame's inner frame to its component extension.
 * Proven on Electron 44 (macOS): blocking either leaves an empty viewer. No `plugins: true` needed.
 */

/** Chromium's PDF viewer component extension (a fixed id in Chromium: extension_constants.cc). */
export const PDF_VIEWER_ORIGIN = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai';

/**
 * A sub-frame URL of the PDF viewer: a blob: URL created by our page (packaged: `blob:file:///…`;
 * dev: `blob:<dev origin>/…`) or the viewer extension's page. Only our page creates blobs of its
 * origin, so a blob frame shows nothing the page did not make.
 */
export function isPdfViewerFrame(url: string, devUrl: string | undefined): boolean {
  if (url.startsWith(`${PDF_VIEWER_ORIGIN}/`)) return true;
  if (url.startsWith('blob:file:///')) return true;
  if (!devUrl) return false;
  try {
    return url.startsWith(`blob:${new URL(devUrl).origin}/`);
  } catch {
    return false;
  }
}
