'use client';
import { useEffect, useRef } from 'react';
import { STICKERS, stickerSrc } from '@/lib/stickers';

/** Stickers that pop out behind the mouse (the finale only, owner 24.10). */
export function CursorStickerTrail() {
  const layer = useRef<HTMLSpanElement>(null);
  const count = 8;
  useEffect(() => {
    const surface = layer.current;
    const root = surface?.parentElement;
    if (!surface || !root) return;
    const nodes = Array.from(surface.querySelectorAll('img'));
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const state = { x: 0, y: 0, index: 0, ready: false, distance: 0, asset: -1 };
    const clear = () => { state.ready = false; state.distance = 0; };
    const stop = () => { clear(); nodes.forEach((node) => { node.getAnimations().forEach((animation) => { animation.cancel(); }); }); };
    const move = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' || preference.matches || document.hidden) { clear(); return; }
      if ((event.target as HTMLElement).closest('a,button,summary')) { clear(); return; }
      if (!state.ready) { state.x = event.clientX; state.y = event.clientY; state.ready = true; return; }
      const dx = event.clientX - state.x; const dy = event.clientY - state.y;
      state.x = event.clientX; state.y = event.clientY;
      state.distance += Math.abs(dx) + Math.abs(dy);
      const threshold = window.innerWidth / 8;
      if (state.distance < threshold) return;
      state.distance = 0;
      const node = nodes[state.index % nodes.length];
      if (!node) return;
      node.getAnimations().forEach((animation) => { animation.cancel(); });
      state.asset = (state.asset + 1 + Math.floor(Math.random() * (STICKERS.length - 1))) % STICKERS.length;
      node.src = stickerSrc(STICKERS[state.asset] ?? 'chat');
      const box = root.getBoundingClientRect();
      node.style.left = `${event.clientX - box.left}px`; node.style.top = `${event.clientY - box.top}px`;
      const angle = (Math.random() - .5) * 20;
      const endAngle = (Math.random() - .5) * 20;
      const xOffset = -50 + (Math.random() - .5) * 80;
      const yOffset = -50 + (Math.random() - .5) * 10;
      const frames = Array.from({ length: 96 }, (_, i) => {
        const seconds = i / 95 * 1.9;
        const drift = 1 - Math.pow(1 - Math.min(1, seconds / 1.5), 5);
        const settle = Math.min(1, seconds / .6);
        const elastic = settle === 1 ? 1 : 1 - Math.pow(2, -10 * settle) * Math.cos(settle * Math.PI * 4);
        let scale = 1.3 - .3 * elastic;
        if (seconds > 1.6) {
          const t = (seconds - 1.6) / .3;
          scale = 1 - .5 * (2.5 * t * t * t - 1.5 * t * t);
        }
        const motion = 4;
        return { offset: i / 95, opacity: i === 95 ? 0 : 1, transform: `translate(calc(${xOffset}% + ${dx * motion * drift}px), calc(${yOffset}% + ${dy * motion * drift}px)) rotate(${angle + (endAngle - angle) * drift}deg) scale(${scale})` };
      });
      node.animate(frames, { duration: 1900, easing: 'linear' });
      state.index += 1;
    };
    root.addEventListener('pointermove', move, { passive: true });
    root.addEventListener('pointerleave', clear);
    preference.addEventListener('change', stop);
    document.addEventListener('visibilitychange', stop);
    const observer = new IntersectionObserver(([entry]) => { if (!entry?.isIntersecting) stop(); });
    observer.observe(root);
    return () => {
      stop(); observer.disconnect();
      root.removeEventListener('pointermove', move); root.removeEventListener('pointerleave', clear);
      preference.removeEventListener('change', stop); document.removeEventListener('visibilitychange', stop);
    };
  }, []);
  return <span ref={layer} className="cursor-sticker-layer" aria-hidden="true">
    {Array.from({ length: count }, (_, index) => <img key={index} className="trail-sticker" width={180} height={180} alt="" draggable={false} />)}
  </span>;
}
