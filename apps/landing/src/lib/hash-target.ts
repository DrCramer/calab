/**
 * The browser scrolls to `#download` / `#pricing` while the page still has its no-JS layout; the story (sticky frame)
 * then gets shorter after hydration and the target slides away. Components that
 * change the layout on mount call this afterwards: it scrolls back to the hash target, unless the visitor has already
 * scrolled on their own.
 */
let touched = false;
if (typeof window !== 'undefined') {
  const mark = () => {
    touched = true;
  };
  for (const e of ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const) window.addEventListener(e, mark, { once: true, passive: true });
}

export function keepHashTarget(): void {
  if (touched) return;
  const id = decodeURIComponent(window.location.hash.slice(1));
  if (!id || id.includes('=')) return;
  requestAnimationFrame(() => {
    if (!touched) document.getElementById(id)?.scrollIntoView({ block: 'start' });
  });
}
