import { create } from 'zustand';

/**
 * The folded bottom island is open (ADR-0146): the island over the content on hover / toggle.
 * Written only on open / close (features/shell/BottomIsland.tsx); read by the island and by the
 * web app view, which steps aside while the open island lies over it (AppScreen occluders).
 */
export const useIsland = create<{ open: boolean }>()(() => ({ open: false }));
