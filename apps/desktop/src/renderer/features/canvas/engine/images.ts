/**
 * Pictures on the board (ADR-0127, 2026-10-23): decoded images by their API path, for the renderer and the PNG export.
 * Loading is on demand (the first draw asks), through the app's authenticated media loader (`resolve`: path → a URL an
 * <img> can load, e.g. a blob URL). A picture is decoded once to a still bitmap — an animated WebP stands on its first
 * frame, nothing animates (no timers at rest, docs/14) — and `onLoad` fires once per load so the owner repaints just
 * the objects that show it. Failures are remembered: no retry loop.
 *
 * At most `cap` entries are kept, least recently drawn out first; an entry drawn within the last `KEEP_MS` is never
 * dropped (a view with more distinct pictures than `cap` holds them all instead of reloading them on every repaint).
 */

export type ImageResolver = (src: string) => Promise<string> | string | null;

/** What the draw code needs: the still picture for a path, or null while it loads (or failed). */
export interface ImageSource {
  get(src: string): CanvasImageSource | null;
}

interface Entry {
  state: 'loading' | 'ready' | 'failed';
  image: CanvasImageSource | null;
  /** When a draw last asked for it (the cache's clock). */
  used: number;
}

export const IMAGE_CACHE_CAP = 64;
/** An entry drawn this recently stays even over the cap. */
export const KEEP_MS = 10_000;

export type DecodeFn = (url: string) => Promise<CanvasImageSource>;

/** <img> → ImageBitmap: a detached image is never painted, so the bitmap is the first frame of an animated WebP. */
const decodeStill: DecodeFn = (url) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    // A CORS-clean picture: a tainted one would make the board's PNG export throw (Electron's API scheme echoes our origin).
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (typeof createImageBitmap !== 'function') {
        resolve(img);
        return;
      }
      createImageBitmap(img).then(resolve, () => resolve(img));
    };
    img.onerror = () => reject(new Error('image failed'));
    img.src = url;
  });

export class ImageCache implements ImageSource {
  private readonly map = new Map<string, Entry>();
  private dead = false;

  constructor(
    private readonly resolve: ImageResolver,
    private readonly onLoad: (src: string) => void,
    private readonly opts: { cap?: number; decode?: DecodeFn; now?: () => number } = {},
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  get size(): number {
    return this.map.size;
  }

  get(src: string): CanvasImageSource | null {
    const hit = this.map.get(src);
    if (hit) {
      hit.used = this.now();
      // Most recently drawn last (Map order is the LRU order).
      this.map.delete(src);
      this.map.set(src, hit);
      return hit.image;
    }
    if (this.dead) return null;
    const e: Entry = { state: 'loading', image: null, used: this.now() };
    this.map.set(src, e);
    this.evict();
    void this.load(src, e);
    return null;
  }

  /** Whether a load is still in flight (tests, the export waiting for nothing). */
  get pending(): number {
    let n = 0;
    for (const e of this.map.values()) if (e.state === 'loading') n++;
    return n;
  }

  private async load(src: string, e: Entry): Promise<void> {
    try {
      const url = await this.resolve(src);
      if (!url) throw new Error('no url');
      const img = await (this.opts.decode ?? decodeStill)(url);
      if (this.dead) return;
      e.state = 'ready';
      e.image = img;
    } catch {
      e.state = 'failed';
      return;
    }
    // Repaint only while this entry is still the one in the cache (it may have been dropped meanwhile).
    if (this.map.get(src) === e) this.onLoad(src);
  }

  private evict(): void {
    const cap = this.opts.cap ?? IMAGE_CACHE_CAP;
    if (this.map.size <= cap) return;
    const fresh = this.now() - KEEP_MS;
    for (const [k, v] of this.map) {
      if (this.map.size <= cap) break;
      // Oldest first: the first one drawn recently means all after it were too.
      if (v.used > fresh) break;
      this.map.delete(k);
      if (v.image && 'close' in v.image && typeof v.image.close === 'function') v.image.close();
    }
  }

  destroy(): void {
    this.dead = true;
    for (const v of this.map.values()) if (v.image && 'close' in v.image && typeof v.image.close === 'function') v.image.close();
    this.map.clear();
  }
}
