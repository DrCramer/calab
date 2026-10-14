import type { MessageKey } from '../../i18n';

/**
 * Board hotkeys (ADR-0042 «Хоткеи», as in Linear): one registry for the listener
 * (features/boards/useBoardHotkeys.ts), the «?» sheet and Settings → «Горячие клавиши». Keys are
 * matched by the physical key (`code`) with the Latin letter as a fallback, so a Russian layout
 * works too. Single-letter keys fire only outside text fields and when no menu/dialog is open.
 * Pure (no React, no stores): `conflicts()` is unit-tested.
 */
export type BoardHotkeyId =
  | 'newTask'
  | 'filter'
  | 'cycleView'
  | 'viewKanban'
  | 'viewList'
  | 'viewTimeline'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'open'
  | 'close'
  | 'status'
  | 'assignee'
  | 'priority'
  | 'label'
  | 'due'
  | 'estimate'
  | 'milestone'
  | 'edit'
  | 'select'
  | 'extendUp'
  | 'extendDown'
  | 'moveLeft'
  | 'moveRight'
  | 'moveUp'
  | 'moveDown'
  | 'copyKey'
  | 'copyLink'
  | 'archive'
  | 'save'
  | 'help';

export type HotkeyGroup = 'general' | 'navigation' | 'task' | 'move';

export interface Chord {
  /** KeyboardEvent.code ('KeyC', 'ArrowUp', 'Comma', 'Enter', 'Backslash', 'Slash', 'Delete'…). */
  code: string;
  /** Primary modifier: ⌘ on macOS, Ctrl elsewhere. */
  mod?: boolean;
  shift?: boolean;
}

export interface BoardHotkey {
  id: BoardHotkeyId;
  group: HotkeyGroup;
  label: MessageKey;
  /** Alternatives (Enter or Space opens a card). */
  chords: Chord[];
  /** Needs a focused / selected task. */
  needsTask?: boolean;
}

const k = (code: string, extra: Omit<Chord, 'code'> = {}): Chord => ({ code, ...extra });

export const BOARD_HOTKEYS: readonly BoardHotkey[] = [
  { id: 'newTask', group: 'general', label: 'boards.kbd.newTask', chords: [k('KeyC')] },
  { id: 'filter', group: 'general', label: 'boards.kbd.filter', chords: [k('KeyF')] },
  { id: 'cycleView', group: 'general', label: 'boards.kbd.cycleView', chords: [k('KeyV')] },
  { id: 'viewKanban', group: 'general', label: 'boards.kbd.viewKanban', chords: [k('Digit1')] },
  { id: 'viewList', group: 'general', label: 'boards.kbd.viewList', chords: [k('Digit2')] },
  { id: 'viewTimeline', group: 'general', label: 'boards.kbd.viewTimeline', chords: [k('Digit3')] },
  { id: 'help', group: 'general', label: 'boards.kbd.help', chords: [k('Slash', { shift: true })] },
  { id: 'up', group: 'navigation', label: 'boards.kbd.up', chords: [k('ArrowUp'), k('KeyK')] },
  { id: 'down', group: 'navigation', label: 'boards.kbd.down', chords: [k('ArrowDown'), k('KeyJ')] },
  { id: 'left', group: 'navigation', label: 'boards.kbd.left', chords: [k('ArrowLeft')] },
  { id: 'right', group: 'navigation', label: 'boards.kbd.right', chords: [k('ArrowRight')] },
  { id: 'open', group: 'navigation', label: 'boards.kbd.open', chords: [k('Enter'), k('Space')], needsTask: true },
  { id: 'close', group: 'navigation', label: 'boards.kbd.close', chords: [k('Escape')] },
  { id: 'status', group: 'task', label: 'boards.kbd.status', chords: [k('KeyS')], needsTask: true },
  { id: 'assignee', group: 'task', label: 'boards.kbd.assignee', chords: [k('KeyA')], needsTask: true },
  { id: 'priority', group: 'task', label: 'boards.kbd.priority', chords: [k('KeyP')], needsTask: true },
  { id: 'label', group: 'task', label: 'boards.kbd.label', chords: [k('KeyL')], needsTask: true },
  { id: 'due', group: 'task', label: 'boards.kbd.due', chords: [k('KeyD')], needsTask: true },
  { id: 'estimate', group: 'task', label: 'boards.kbd.estimate', chords: [k('KeyE')], needsTask: true },
  { id: 'milestone', group: 'task', label: 'boards.kbd.milestone', chords: [k('KeyM')], needsTask: true },
  { id: 'edit', group: 'task', label: 'boards.kbd.edit', chords: [k('KeyE', { shift: true })], needsTask: true },
  { id: 'archive', group: 'task', label: 'boards.kbd.archive', chords: [k('Delete'), k('Backspace', { mod: true })], needsTask: true },
  { id: 'copyKey', group: 'task', label: 'boards.kbd.copyKey', chords: [k('KeyC', { mod: true })], needsTask: true },
  { id: 'copyLink', group: 'task', label: 'boards.kbd.copyLink', chords: [k('KeyC', { mod: true, shift: true })], needsTask: true },
  { id: 'save', group: 'task', label: 'boards.kbd.save', chords: [k('Enter', { mod: true })] },
  { id: 'select', group: 'move', label: 'boards.kbd.select', chords: [k('KeyX')], needsTask: true },
  { id: 'extendUp', group: 'move', label: 'boards.kbd.extendUp', chords: [k('ArrowUp', { shift: true })], needsTask: true },
  { id: 'extendDown', group: 'move', label: 'boards.kbd.extendDown', chords: [k('ArrowDown', { shift: true })], needsTask: true },
  { id: 'moveLeft', group: 'move', label: 'boards.kbd.moveLeft', chords: [k('Comma', { mod: true, shift: true })], needsTask: true },
  { id: 'moveRight', group: 'move', label: 'boards.kbd.moveRight', chords: [k('Period', { mod: true, shift: true })], needsTask: true },
  { id: 'moveUp', group: 'move', label: 'boards.kbd.moveUp', chords: [k('ArrowUp', { mod: true, shift: true })], needsTask: true },
  { id: 'moveDown', group: 'move', label: 'boards.kbd.moveDown', chords: [k('ArrowDown', { mod: true, shift: true })], needsTask: true },
];

/**
 * App-wide shortcuts the board keys must not shadow (services/hotkeys.ts): ⌘K search, ⌘⇧M mute,
 * ⌘⇧D deafen, ⌘F room search, ⌘[ / ⌘] history. Checked by `conflicts()` in the unit test.
 */
export const APP_CHORDS: readonly Chord[] = [
  k('KeyK', { mod: true }),
  k('KeyM', { mod: true, shift: true }),
  k('KeyD', { mod: true, shift: true }),
  k('KeyF', { mod: true }),
  k('BracketLeft', { mod: true }),
  k('BracketRight', { mod: true }),
];

const chordKey = (c: Chord): string => `${c.mod ? 'mod+' : ''}${c.shift ? 'shift+' : ''}${c.code}`;

/** Pairs of registry entries (or an entry and an app shortcut, `app:<n>`) bound to one chord. */
export function conflicts(list: readonly BoardHotkey[] = BOARD_HOTKEYS, app: readonly Chord[] = APP_CHORDS): Array<[string, string]> {
  const seen = new Map<string, string>();
  app.forEach((c, i) => seen.set(chordKey(c), `app:${i}`));
  const out: Array<[string, string]> = [];
  for (const h of list) {
    for (const c of h.chords) {
      const key = chordKey(c);
      const prev = seen.get(key);
      if (prev && prev !== h.id) out.push([prev, h.id]);
      else seen.set(key, h.id);
    }
  }
  return out;
}

export interface KeyLike {
  code: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Does the key press match the chord? `mac`: ⌘ is the primary modifier, else Ctrl. */
export function matchesChord(e: KeyLike, c: Chord, mac: boolean): boolean {
  const primary = mac ? e.metaKey : e.ctrlKey;
  const other = mac ? e.ctrlKey : e.metaKey;
  if (!!c.mod !== primary || other || e.altKey) return false;
  // «?» is Shift+/ on most layouts; on others the key itself says it.
  if (c.code === 'Slash' && c.shift && e.key === '?') return true;
  if (!!c.shift !== e.shiftKey) return false;
  if (e.code === c.code) return true;
  const letter = /^Key([A-Z])$/.exec(c.code)?.[1];
  return !!letter && e.key.length === 1 && e.key.toUpperCase() === letter;
}

/** The registry entry a key press triggers, if any. */
export function hotkeyOf(e: KeyLike, mac: boolean, list: readonly BoardHotkey[] = BOARD_HOTKEYS): BoardHotkey | null {
  for (const h of list) if (h.chords.some((c) => matchesChord(e, c, mac))) return h;
  return null;
}

const NAMES: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Enter: '↩',
  Escape: 'Esc',
  Space: 'Space',
  Backspace: '⌫',
  Delete: 'Del',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
};

/** «C», «⌘⇧,», «Ctrl+Shift+,»; «?» for Shift+/. */
export function chordLabel(c: Chord, mac: boolean): string {
  if (c.code === 'Slash' && c.shift && !c.mod) return '?';
  const key = NAMES[c.code] ?? c.code.replace(/^Key|^Digit/, '');
  if (mac) return `${c.mod ? '⌘' : ''}${c.shift ? '⇧' : ''}${key}`;
  return [c.mod ? 'Ctrl' : '', c.shift ? 'Shift' : '', key].filter(Boolean).join('+');
}

/** Status / priority menus: digits pick the n-th item (Linear). 1-based; 0 = none. */
export function digitOf(e: Pick<KeyLike, 'code' | 'key'>): number {
  const m = /^(?:Digit|Numpad)([0-9])$/.exec(e.code);
  return m ? Number(m[1]) : 0;
}
