'use client';
import { useEffect, useRef, type ReactNode } from 'react';

/**
 * The phone menu (a <details> sheet, works without JS): a chosen link, Escape or a tap outside closes it, so the
 * sheet never stays over the section the visitor jumped to. Listeners only while it is open.
 */
export function SiteMenu({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const close = () => { menu.open = false; };
    const outside = (e: PointerEvent) => { if (!menu.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const toggle = () => {
      if (menu.open) {
        document.addEventListener('pointerdown', outside);
        document.addEventListener('keydown', key);
      } else {
        document.removeEventListener('pointerdown', outside);
        document.removeEventListener('keydown', key);
      }
    };
    const pick = (e: MouseEvent) => { if ((e.target as HTMLElement).closest('a')) close(); };
    menu.addEventListener('toggle', toggle);
    menu.addEventListener('click', pick);
    return () => {
      menu.removeEventListener('toggle', toggle);
      menu.removeEventListener('click', pick);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', key);
    };
  }, []);
  return (
    <details ref={ref} className="site-menu">
      <summary aria-label={label}>
        <span />
        <span />
      </summary>
      {children}
    </details>
  );
}
