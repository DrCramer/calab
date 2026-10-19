import type { ReactNode } from 'react';
import { useCanvas } from '../../../stores/canvas';

/**
 * Placeholder of the canvas screen (task H5a) until the real view lands (H5b): a frame with the
 * canvas's name. It takes the final props (the contract with `features/canvas/view/index.ts`), so
 * swapping it for the real `CanvasView` changes no import.
 */
export interface CanvasViewProps {
  canvasId: string;
  workspaceId: string;
  /** The caller's canvas bits on this canvas (CanvasItem.my_bits). */
  bits: bigint;
  onOpenHistory: () => void;
  onShare: () => void;
}

export function CanvasView({ canvasId }: CanvasViewProps): ReactNode {
  const name = useCanvas((s) => s.items[canvasId]?.name ?? '');
  return (
    <div className="grid size-full place-items-center border border-dashed border-line text-body text-muted" data-testid="canvas-view-stub">
      {name}
    </div>
  );
}
