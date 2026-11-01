'use client';
import type { ReactNode } from 'react';
import { useRef } from 'react';

// Hand-drawn underlines: a new stroke each time (pathLength 1, dash offset 1 → 0). The nav link draws on hover
// and wipes off on leave; the call-to-action link («Все возможности ↓») keeps its line and redraws on hover.
const MARKS = [
  'M2 8 Q35 1 66 6 T118 5',
  'M2 7 Q48 -1 79 6 Q101 14 62 10 Q58 3 118 6',
  'M2 7 Q7 1 13 6 T25 6 T37 6 T49 6 T61 6 T73 6 T85 6 T97 6 T118 6',
  'M2 5 Q54 9 117 3 M9 10 Q55 5 108 9',
];
const EASE = 'cubic-bezier(.65,0,.35,1)';
let next = 0;
const still = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function DrawnLink({
  href,
  children,
  current,
  variant = 'nav',
  arrow,
  className,
}: {
  href: string;
  children: ReactNode;
  current?: boolean | undefined;
  variant?: 'nav' | 'cta' | undefined;
  /** cta: the round arrow after the label, pointing down (same page) or right. */
  arrow?: 'down' | 'right' | undefined;
  className?: string | undefined;
}) {
  const path = useRef<SVGPathElement>(null);
  const draw = () => {
    const el = path.current;
    if (!el) return;
    el.getAnimations().forEach((a) => { a.cancel(); });
    el.setAttribute('d', MARKS[next++ % MARKS.length] ?? MARKS[0] ?? '');
    el.animate([{ strokeDashoffset: '1' }, { strokeDashoffset: '0' }], { duration: still() ? 0 : 500, easing: EASE, fill: 'forwards' });
  };
  const erase = () => {
    const el = path.current;
    if (!el || current || variant === 'cta') return;
    const offset = getComputedStyle(el).strokeDashoffset;
    el.getAnimations().forEach((a) => { a.cancel(); });
    el.animate([{ strokeDashoffset: offset }, { strokeDashoffset: '-1' }], { duration: still() ? 0 : 500, easing: EASE, fill: 'forwards' });
  };
  return (
    <a
      href={href}
      aria-current={current ? 'page' : undefined}
      className={`drawn drawn-${variant}${className ? ` ${className}` : ''}`}
      onPointerEnter={draw}
      onPointerLeave={erase}
      onFocus={draw}
      onBlur={erase}
    >
      <span className="drawn-label">
        {children}
        <svg className="drawn-line" viewBox="0 0 120 12" preserveAspectRatio="none" aria-hidden="true">
          <path ref={path} d={MARKS[0]} pathLength="1" />
        </svg>
      </span>
      {arrow && (
        <span className={`drawn-arrow drawn-arrow-${arrow}`} aria-hidden="true">
          {[0, 1].map((i) => (
            <span className="drawn-arrow-wrap" key={i}>
              <svg viewBox="0 0 16 18">
                <path d="M6 1h4v9l3-3 3 3-8 8-8-8 3-3 3 3Z" />
              </svg>
            </span>
          ))}
        </span>
      )}
    </a>
  );
}
