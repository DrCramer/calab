import type { ReactNode } from 'react';
import type { RouteKind } from '../../../lib/canvas/types';

/** The path each connector route draws, in a 16×16 box: a diagonal, an orthogonal step, an S-curve. */
const PATH: Record<RouteKind, string> = {
  straight: 'M2 13 14 3',
  elbow: 'M2 13h6V3h6',
  curve: 'M2 13C9 13 7 3 14 3',
};

/** A connector route's icon (the toolbar's connector tool and its menu, the properties panel, the phone's sheet). */
export function RouteIcon({ route, className }: { route: RouteKind; className: string }): ReactNode {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={PATH[route]} />
    </svg>
  );
}
