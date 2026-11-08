/**
 * Lightbox view logic (docs/08 «Медиа в чате», issue #7), kept pure for unit tests.
 *
 * The viewer opens at once with the chat thumbnail (already loaded) as a placeholder and a
 * spinner over it; the full file replaces it when loaded. Both are drawn in one frame whose size
 * is the image fitted into the viewer box — never cropped, never upscaled past its own pixels.
 */

export interface LightboxImage {
  fileId: string;
  name: string;
  /** MIME type from FileMeta, when known (the web drag-out names the file's type with it). */
  mime?: string;
  /** Pixel size from FileMeta (0 when the server does not know it). */
  width: number;
  height: number;
  /**
   * A ready URL instead of an API file (a mail attachment, ADR-0088 §8: `calaba-mail://…`): shown
   * as is (no thumbnail) and downloaded through a link; `fileId` is then just a unique key.
   */
  src?: string;
}

export type LoadState = 'loading' | 'loaded' | 'error';

export interface Layers {
  /** The thumbnail placeholder (stays under a failed full image). */
  thumb: boolean;
  /** The full image is shown (opacity 1). */
  full: boolean;
  spinner: boolean;
  error: boolean;
}

/** What the frame shows for the thumbnail and full-image load states. */
export function lightboxLayers(thumb: LoadState, full: LoadState): Layers {
  return {
    thumb: full !== 'loaded' && thumb === 'loaded',
    full: full === 'loaded',
    spinner: full === 'loading',
    error: full === 'error',
  };
}

export interface Dims {
  w: number;
  h: number;
}

/** Known pixel size of an image, or null (0 / missing). */
export function dimsOf(w: number | undefined, h: number | undefined): Dims | null {
  return w && h && w > 0 && h > 0 ? { w, h } : null;
}

/**
 * The frame's CSS size inside a `container-type: size` box: the aspect ratio of the image and the
 * largest width at which it fits the box both ways (`cqw`/`cqh`). `natural` caps the width at the
 * image's own pixels (a known size: no upscaling); an aspect known only from the thumbnail fills
 * the box. null → no frame yet (nothing known about the image).
 */
export function fitFrame(d: Dims | null, natural: boolean): { width: string; aspectRatio: string } | null {
  if (!d) return null;
  const byHeight = `calc(100cqh * ${d.w} / ${d.h})`;
  return {
    width: natural ? `min(100cqw, ${d.w}px, ${byHeight})` : `min(100cqw, ${byHeight})`,
    aspectRatio: `${d.w} / ${d.h}`,
  };
}

/** ←/→ in a gallery: the next index, clamped (no wrap-around), or null when there is none. */
export function stepImage(index: number, delta: -1 | 1, count: number): number | null {
  const next = index + delta;
  return next >= 0 && next < count ? next : null;
}

/** Movement (CSS px) under which a press on the image still counts as a click, not a drag. */
export const TAP_SLOP = 6;

/** A press released within TAP_SLOP of where it started: a click on the image (closes the viewer). */
export function isTap(down: { x: number; y: number }, up: { x: number; y: number }, slop = TAP_SLOP): boolean {
  return Math.hypot(up.x - down.x, up.y - down.y) <= slop;
}

/**
 * The chat's photo list for the viewer (board #118): the image attachments of the loaded messages in
 * message order, and the position of `fileId` in it. Only what the store already holds — paging stops
 * at the loaded edge. `attachmentsPerMessage`: oldest first, already filtered to the pictures.
 * fileId not found → just `fallback` (the message's own pictures).
 */
export function chatGallery<T extends { id: string }>(attachmentsPerMessage: T[][], fileId: string, fallback: T[]): { files: T[]; index: number } {
  const files = attachmentsPerMessage.flat();
  const index = files.findIndex((f) => f.id === fileId);
  if (index < 0) return { files: fallback, index: Math.max(0, fallback.findIndex((f) => f.id === fileId)) };
  return { files, index };
}

/** Zoom / pan of the shown picture: `s` scale (1 = fitted), `x`/`y` translation in CSS px from the centre. */
export interface ViewT {
  s: number;
  x: number;
  y: number;
}
export interface Pt {
  x: number;
  y: number;
}

export const IDENTITY: ViewT = { s: 1, x: 0, y: 0 };
export const MAX_ZOOM = 5;
/** Scale of a double tap. */
export const DOUBLE_TAP_ZOOM = 2.5;
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_SLOP = 30;

export const clampScale = (s: number): number => Math.min(MAX_ZOOM, Math.max(1, s));

/** Keeps a zoomed picture covering the view: no gap beyond its edge; at scale 1 it is centred. */
export function clampPan(t: ViewT, frame: Dims, view: Dims): ViewT {
  if (t.s <= 1) return IDENTITY;
  const mx = Math.max(0, (frame.w * t.s - view.w) / 2);
  const my = Math.max(0, (frame.h * t.s - view.h) / 2);
  return { s: t.s, x: Math.min(mx, Math.max(-mx, t.x)), y: Math.min(my, Math.max(-my, t.y)) };
}

/** The picture-space point (relative to the frame centre, unscaled) under the view point `p` (relative to the centre). */
export const anchorAt = (t: ViewT, p: Pt): Pt => ({ x: (p.x - t.x) / t.s, y: (p.y - t.y) / t.s });

/** Scale `s` with the picture point `anchor` placed under the view point `p` (a pinch or a double tap). */
export const placeAnchor = (anchor: Pt, s: number, p: Pt): ViewT => ({ s, x: p.x - anchor.x * s, y: p.y - anchor.y * s });

/** Double tap: zoomed → back to fitted; fitted → DOUBLE_TAP_ZOOM about the tapped point. */
export function doubleTapTarget(t: ViewT, p: Pt, frame: Dims, view: Dims): ViewT {
  if (t.s > 1.01) return IDENTITY;
  return clampPan(placeAnchor(anchorAt(t, p), DOUBLE_TAP_ZOOM, p), frame, view);
}

export const distance = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);
export const midpoint = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Two taps close in time and place. */
export function isDoubleTap(prev: { t: number; x: number; y: number } | null, now: { t: number; x: number; y: number }): boolean {
  return !!prev && now.t - prev.t <= DOUBLE_TAP_MS && Math.hypot(now.x - prev.x, now.y - prev.y) <= DOUBLE_TAP_SLOP;
}

/** Which axis a single-finger drag on a fitted picture follows, once it is past the slop (null: undecided). */
export function lockAxis(dx: number, dy: number, slop = 10): 'x' | 'y' | null {
  if (Math.hypot(dx, dy) < slop) return null;
  return Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
}

export const SWIPE_CLOSE_PX = 110;

/**
 * What a released drag of a fitted picture does. Dragging right shows the previous picture, left the
 * next; no neighbour (the ends, no wrap) gives 'none' (snaps back). Down past SWIPE_CLOSE_PX closes.
 */
export function swipeAction(axis: 'x' | 'y', dx: number, dy: number, viewW: number, hasPrev: boolean, hasNext: boolean): 'prev' | 'next' | 'close' | 'none' {
  if (axis === 'y') return dy > SWIPE_CLOSE_PX ? 'close' : 'none';
  const need = Math.min(80, viewW * 0.25);
  if (dx > need && hasPrev) return 'prev';
  if (dx < -need && hasNext) return 'next';
  return 'none';
}
