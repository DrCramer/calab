import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { lastSpoke } from '../../lib/lastSpoke';
import { NO_SLOTS, galleryLayout, galleryPageSize, pageOf, sameGallery, type Gallery, type GallerySlots, type TilePerson } from './tileLayout';

export interface GalleryInput {
  people: readonly TilePerson[];
  pinned: string | null;
  me: string;
  hideSelf: boolean;
  hideNoVideo: boolean;
  size: number;
  page: number;
  /**
   * The asked page is out of range (people left, a bigger page size): the layout shows `page`
   * instead; the owner of `page` follows. A stable function.
   */
  onClamp: (page: number) => void;
}

const NOOP = (): void => undefined;
const OFF: GalleryInput = { people: [], pinned: null, me: '', hideSelf: false, hideNoVideo: false, size: 1, page: 0, onClamp: NOOP };

/**
 * The gallery page on screen (tileLayout.ts galleryLayout) with the order carried between
 * layouts, so page 1 and the visible page keep their tiles and a hidden speaker comes forward in
 * place (ADR-0066 §2). `null` input: the speaker view — nothing runs.
 *
 * Rerenders: «last spoke» lives outside the stores (lib/lastSpoke.ts). Each speaking start re-runs
 * the layout here, but the state — and so the grid — changes only when the page's tiles, the page
 * or the page count do. A rate-limited swap re-runs once on a one-shot timer. `pageOf` reads the
 * latest order without re-rendering anyone.
 *
 * The clamp is reported from the layout run itself, against the page it was computed for — not by
 * comparing the returned state with the asked page in an effect: that state lags one commit behind
 * a flip, so such an effect sent the store back to the old page and the two chased each other
 * («Maximum update depth exceeded» on «следующая страница», 2026-10).
 */
export function useGallery(input: GalleryInput | null): { gallery: Gallery | null; pageOf: (userId: string) => number } {
  const slots = useRef<GallerySlots>(NO_SLOTS);
  const [gallery, setGallery] = useState<Gallery | null>(null);
  const { people, pinned, me, hideSelf, hideNoVideo, size, page, onClamp } = input ?? OFF;
  const on = input !== null;
  useLayoutEffect(() => {
    // «Спикер»: no gallery; the next gallery starts afresh.
    if (!on) {
      slots.current = NO_SLOTS;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = (): void => {
      clearTimeout(timer);
      timer = undefined;
      const now = performance.now();
      const next = galleryLayout(people, { pinned, me, hideSelf, hideNoVideo, size, page, spoke: lastSpoke.snapshot(), prev: slots.current, now });
      slots.current = next.slots;
      if (next.retryAt !== null) timer = setTimeout(run, Math.max(0, next.retryAt - now));
      setGallery((cur) => (cur && sameGallery(cur, next) ? cur : next));
      if (next.page !== page) onClamp(next.page);
    };
    // Before paint: a new participant / pin / page shows in the same frame.
    run();
    const off = lastSpoke.subscribe(run);
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [on, people, pinned, me, hideSelf, hideNoVideo, size, page, onClamp]);
  const find = useCallback((userId: string) => pageOf(slots.current, userId), []);
  return { gallery: on ? gallery : null, pageOf: find };
}

const subscribeResize = (fn: () => void): (() => void) => {
  window.addEventListener('resize', fn);
  return () => window.removeEventListener('resize', fn);
};

/**
 * «Слабый компьютер» (docs/09 #44): not built yet; when it is, it sets `data-low-end` on <html>
 * (the flag lib/tilt.ts already reads) and the gallery drops to 9 tiles.
 */
const lowEnd = (): boolean => document.documentElement.dataset['lowEnd'] === 'true';

/** Tiles per gallery page for this window (a primitive: a resize re-renders only when it changes). */
export function useGalleryPageSize(phone: boolean): number {
  return useSyncExternalStore(subscribeResize, () => galleryPageSize(window.innerWidth, window.innerHeight, { phone, weak: lowEnd() }));
}
