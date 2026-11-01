import { create } from 'zustand';

/** Annotation tool of this viewer (ADR-0028): none, laser pointer or pen. */
export type AnnotTool = 'none' | 'pointer' | 'pen';

export interface AnnotState {
  tool: AnnotTool;
  /** Pen / pointer colour (0xRRGGBB); null = my default colour (lib/annot/paint colorFor). */
  color: number | null;
  /** Presenter's policy per stream track sid (POLICY messages); absent = allowed. */
  policy: Record<string, boolean>;
  /** My own stream: viewers may annotate it (the switch in my stream's panel). */
  allowMine: boolean;
  /**
   * Where I see the viewers' annotations of my stream: over the shared screen (the overlay
   * window) or only in the preview of my stream (web, a window source, no overlay possible).
   */
  mineView: 'screen' | 'preview';
  /** Someone annotates my stream right now (the panel's indicator); null after a few quiet seconds. */
  mineActivity: { name: string; kind: 'pointer' | 'stroke' } | null;
}

export const useAnnot = create<AnnotState>(() => ({ tool: 'none', color: null, policy: {}, allowMine: true, mineView: 'preview', mineActivity: null }));

export const setAnnot = (p: Partial<AnnotState>): void => useAnnot.setState(p);
