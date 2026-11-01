'use client';
import { useEffect, useRef, type ReactNode } from 'react';
import { keepHashTarget } from '@/lib/hash-target';

/**
 * Desktop enhancement of «Один день команды» (§4.3): the steps scroll on the left while one sticky frame on the
 * right shows the shot of the step in the middle of the screen. Without JS, on phones and narrow windows the
 * steps simply follow each other, each with its own shot. Work happens only in IntersectionObserver callbacks.
 */
export function StoryScroller({ children }: { children: ReactNode }) {
  const root = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const list = root.current;
    if (!list) return;
    const wide = window.matchMedia('(min-width: 1024px)');
    const steps = [...list.querySelectorAll<HTMLElement>('[data-step]')];
    let observer: IntersectionObserver | null = null;
    let edges: IntersectionObserver | null = null;
    const show = (index: string) => {
      steps.forEach((s) => { s.toggleAttribute('data-active', s.dataset.step === index); });
    };
    const apply = () => {
      observer?.disconnect();
      edges?.disconnect();
      observer = null;
      edges = null;
      list.classList.toggle('story-sticky', wide.matches);
      if (!wide.matches) return;
      show('0');
      // The callback only says «something crossed the middle band»; the active step is then the one whose text
      // spans the middle of the screen (or the nearest), so a batch of entries never picks a stale one.
      const texts = steps.map((st) => st.querySelector<HTMLElement>('.story-text'));
      const pick = () => {
        const mid = window.innerHeight / 2;
        let best = 0;
        let dist = Infinity;
        texts.forEach((t, i) => {
          if (!t) return;
          const r = t.getBoundingClientRect();
          const d = r.top <= mid && r.bottom >= mid ? 0 : Math.min(Math.abs(r.top - mid), Math.abs(r.bottom - mid));
          if (d < dist) { dist = d; best = i; }
        });
        show(String(best));
      };
      observer = new IntersectionObserver(pick, { rootMargin: '-45% 0px -45% 0px' });
      // The list's own visibility in 5 % steps: a jump (an anchor, a fling) past the middle band still picks a step.
      edges = new IntersectionObserver(pick, { threshold: Array.from({ length: 21 }, (_, i) => i / 20) });
      edges.observe(list);
      texts.forEach((t) => { if (t) observer?.observe(t); });
    };
    apply();
    keepHashTarget();
    wide.addEventListener('change', apply);
    return () => {
      observer?.disconnect();
      edges?.disconnect();
      wide.removeEventListener('change', apply);
    };
  }, []);
  return (
    <ol ref={root} className="story-steps swipe-sm">
      {children}
    </ol>
  );
}
