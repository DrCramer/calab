import type { Sticker } from '@calaba/protocol';
import manifest from '../../../../server/internal/builtinstickers/manifest.json';

// The same immutable source assets are embedded in Go and bundled by Vite (web + Electron).
const images = import.meta.glob<string>('../../../../server/internal/builtinstickers/assets/*.webp', {
  eager: true, query: '?url', import: 'default',
});
const byId = new Map(manifest.stickers.map((s) => [s.id, images[`../../../../server/internal/builtinstickers/assets/${s.name}.webp`]]));

export function builtinStickerUrl(sticker: Pick<Sticker, 'id' | 'packId'>): string | undefined {
  return sticker.packId === manifest.id ? byId.get(sticker.id) : undefined;
}

/** The bundled picture of a built-in sticker's API path (`/api/stickers/builtin/{id}.webp`), or undefined for any other path. */
export function builtinStickerSrc(path: string): string | undefined {
  const m = /^\/api\/stickers\/builtin\/([0-9A-Za-z-]+)\.webp$/.exec(path);
  return m?.[1] ? byId.get(m[1]) : undefined;
}
