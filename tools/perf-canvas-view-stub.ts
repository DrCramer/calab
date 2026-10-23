/** Stand-in for features/canvas/view/defaultDeps.ts in tools/perf-canvas-view.ts (the bench injects its own deps). */
export function appDeps(): never {
  throw new Error('appDeps is not available in the bench');
}
