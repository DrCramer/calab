import { createLucideIcon } from 'lucide-react';

/**
 * Lucide's StickyNote turned upside down: the fold at the bottom right, like a note peeling off the board. The sticky
 * tool (desktop and phone) and the color swatches share this outline (`STICKY_BODY` / `STICKY_FOLD`).
 */
export const STICKY_BODY = 'M16 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v11Z';
export const STICKY_FOLD = 'M15 21v-4a2 2 0 0 1 2-2h4';

export const StickyIcon = createLucideIcon('sticky-note-fold', [
  ['path', { d: STICKY_BODY, key: 'body' }],
  ['path', { d: STICKY_FOLD, key: 'fold' }],
]);
