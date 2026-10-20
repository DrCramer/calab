/**
 * The desktop room row's box and button classes — one source for the room rows (Sidebar) and the
 * «Архив · N» row at the end of «Временные» (TempArchive), so the two never drift apart.
 */
export const ROOM_ROW_BOX = 'group/row relative flex h-9 items-center rounded-[var(--radius-card)] transition-colors duration-[var(--motion-fast)]';

/** The row's main button: left indent, icon slot + name, size, weight and colour of a room. */
export const ROOM_ROW_BUTTON = 'flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-[var(--radius-row)] pl-2 pr-1 text-left text-list leading-5';
