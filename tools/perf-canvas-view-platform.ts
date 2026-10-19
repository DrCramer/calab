/** Stand-in for renderer/platform in tools/perf-canvas-view.ts: the pieces the UI kit touches at import time. */
export const platform = { kind: 'web', apiBase: '', directMedia: false, mediaUrl: () => new Promise<string>(() => undefined) };
