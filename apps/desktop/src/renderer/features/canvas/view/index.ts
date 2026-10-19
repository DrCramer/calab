/**
 * Public surface of the Canvas screen's body (ADR-0107 §5). The section shell imports `CanvasView`
 * (lazily, it brings the engine and Yjs); the rest is for the header's «⋯» menu and for tests.
 */
export { CanvasView } from './CanvasView';
export type { CanvasViewProps } from './CanvasView';
export { exportCanvasPng, pngFileName, downloadBlob } from './exportPng';
export type { ExportArea, ExportOptions } from './exportPng';
export { getCanvasViewHandle } from './handle';
export type { CanvasViewHandle } from './handle';
export type { CanvasViewDeps } from './session';
