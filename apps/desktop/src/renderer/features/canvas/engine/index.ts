/** Public surface of the Canvas engine (ADR-0126 §4) for the section UI. No React in here. */
export { CanvasEngine, makeCanvasMeasure } from './engine';
export type { ClipboardPort, EngineOptions, EngineState, LocalAwareness, QuickDrop, RefusedWhy, Tool } from './engine';
export type { QuickChoice } from './quick';
export type { PeerState } from './awareness';
export { HUE_IDS, INK_EXTRA_IDS, STICKY_IDS, contrastRatio, defaultPalette, readableInk, resolveColor, resolveFill, resolveSticky } from './palette';
export type { CanvasPalette } from './palette';
export { CanvasDoc, LOCAL_ORIGIN } from '../../../lib/canvas/doc';
export * from '../../../lib/canvas/types';
export { renderSceneTo } from './renderer';
