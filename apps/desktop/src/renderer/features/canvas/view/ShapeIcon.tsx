import type { ReactNode } from 'react';
import type { ShapeKind } from '../../../lib/canvas/types';

/** 16×16 outlines of the shapes: one icon set for the toolbar and the properties panel. */
const PATHS: Record<ShapeKind, ReactNode> = {
  rect: <rect x="2.5" y="3.5" width="11" height="9" />,
  rounded: <rect x="2.5" y="3.5" width="11" height="9" rx="3" />,
  ellipse: <ellipse cx="8" cy="8" rx="5.5" ry="4.5" />,
  diamond: <path d="M8 2.5 13.5 8 8 13.5 2.5 8Z" />,
  triangle: <path d="M8 3 13.5 13h-11Z" />,
  star: <path d="M8 1.8 9.8 6l4.5.4-3.4 3 1 4.4L8 11.4l-3.9 2.4 1-4.4-3.4-3L6.2 6Z" />,
  hexagon: <path d="M5 3h6l3 5-3 5H5L2 8Z" />,
  parallelogram: <path d="M5 3.5h8.5L11 12.5H2.5Z" />,
  arrow: <path d="M2 6h6V3l6 5-6 5v-3H2Z" />,
  bubble: <path d="M3.5 2.5h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7L4 13.5v-3h-.5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z" />,
  cylinder: (
    <>
      <path d="M3 4.5v7c0 1.1 2.2 2 5 2s5-.9 5-2v-7" />
      <ellipse cx="8" cy="4.5" rx="5" ry="2" />
    </>
  ),
};

export function ShapeIcon({ kind, className }: { kind: ShapeKind; className?: string }): ReactNode {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden>
      {PATHS[kind] ?? PATHS.rect}
    </svg>
  );
}
