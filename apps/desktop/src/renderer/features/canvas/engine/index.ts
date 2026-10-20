/** Public surface of the Canvas engine (ADR-0113 §4) for the section UI. No React in here. */
export { CanvasEngine } from './engine';
export type { ClipboardPort, EngineOptions, EngineState, LocalAwareness, Tool } from './engine';
export type { PeerState } from './awareness';
export { HUE_IDS, INK_EXTRA_IDS, STICKY_IDS, contrastRatio, defaultPalette, readableInk, resolveColor, resolveSticky } from './palette';
export type { CanvasPalette } from './palette';
export { CanvasDoc, LOCAL_ORIGIN } from '../../../lib/canvas/doc';
export * from '../../../lib/canvas/types';
