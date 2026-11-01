'use client';
import { useEffect, useState, type CSSProperties } from 'react';

import { STICKERS as assets } from '@/lib/stickers';
type Sticker = { asset: string; left: number; top: number; x: number; y: number; angle: number; size: number };
const hiddenSticker: Sticker = { asset: 'chat', left: 50, top: 50, x: 0, y: 0, angle: 0, size: 1 };

function randomSticker(side: number, asset: string): Sticker {
  // Continuous coordinates along the chosen edge, not a bank of anchor points.
  const along = 12 + Math.random() * 76;
  const depth = 30 + Math.random() * 24;
  const drift = (Math.random() - .5) * 30;
  const horizontal = side % 2 === 0;
  return {
    asset,
    left: horizontal ? along : side === 1 ? 100 : 0,
    top: horizontal ? side === 0 ? 0 : 100 : along,
    x: horizontal ? drift : side === 1 ? depth : -depth,
    y: horizontal ? side === 0 ? -depth : depth : drift,
    angle: Math.random() * 44 - 22,
    size: .88 + Math.random() * .24,
  };
}

/** Decorations stay behind the card surface and never intercept the pointer. */
export function CardStickers({ active }: { active: boolean }) {
  const [stickers, setStickers] = useState<Sticker[]>([hiddenSticker, { ...hiddenSticker, asset: 'video' }]);
  useEffect(() => {
    if (!active) return;
    const first = Math.floor(Math.random() * assets.length);
    const next = (first + 1 + Math.floor(Math.random() * (assets.length - 1))) % assets.length;
    const side = Math.floor(Math.random() * 4);
    const otherSide = (side + 1 + Math.floor(Math.random() * 3)) % 4;
    setStickers([
      randomSticker(side, assets[first] ?? 'chat'),
      randomSticker(otherSide, assets[next] ?? 'video'),
    ]);
  }, [active]);
  return <span className="card-stickers" data-visible={active} aria-hidden="true">
    {stickers.map((sticker, index) => <img key={index} src={`/editorial/sticker-${sticker.asset}.webp`} alt="" width={112} height={112} loading="lazy" draggable={false}
      style={{ left: `${sticker.left}%`, top: `${sticker.top}%`, '--peek-x': `${sticker.x}px`, '--peek-y': `${sticker.y}px`, '--peek-angle': `${sticker.angle}deg`, '--peek-scale': sticker.size, '--peek-delay': `${index * 65}ms` } as CSSProperties} />)}
  </span>;
}
