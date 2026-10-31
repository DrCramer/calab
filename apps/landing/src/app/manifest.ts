import type { MetadataRoute } from 'next';

export const dynamic = 'force-static';

// Locale-neutral (one manifest for all /<locale>/ pages): English description, start at the language router.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Calab',
    short_name: 'Calab',
    description: 'Voice rooms, chat and screen sharing for your team, on your own server',
    start_url: '/',
    display: 'browser',
    background_color: '#141416',
    theme_color: '#141416',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  };
}
