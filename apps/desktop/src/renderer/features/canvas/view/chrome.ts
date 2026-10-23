/** Class strings shared by the Canvas screen's floating panels (docs/08: solid materials, no glass). */
export const PANEL = 'mat-popover pointer-events-auto rounded-[var(--radius-card)] p-1';
export const MENU_BOX = 'mat-popover anim-in z-[var(--z-popover)] min-w-56 rounded-[var(--radius-card)] p-1';
export const MENU_ITEM =
  'flex h-8 cursor-default items-center gap-2 rounded-[6px] px-2.5 text-body text-fg outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-accent-strong data-[highlighted]:text-accent-fg';
export const ACTIVE_TOOL = 'bg-accent-strong! text-accent-fg! hover:bg-accent-strong!';
export const DIVIDER = 'mx-0.5 h-5 w-px shrink-0 bg-line';

/** Pressing a panel button must not take the focus from the canvas: its hotkeys (Delete, arrows) keep working. */
export const keepFocus = (e: { preventDefault(): void }): void => e.preventDefault();
