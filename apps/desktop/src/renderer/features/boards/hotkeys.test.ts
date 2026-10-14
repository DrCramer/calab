import { describe, expect, it } from 'vitest';
import { BOARD_HOTKEYS, chordLabel, conflicts, digitOf, hotkeyOf, matchesChord, type KeyLike } from './hotkeys';

const key = (p: Partial<KeyLike>): KeyLike => ({ code: '', key: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...p });

describe('board hotkeys registry', () => {
  it('has no two actions on one chord and does not shadow the app shortcuts (⌘K, ⌘⇧M, ⌘⇧D, ⌘F, ⌘[ ⌘])', () => {
    expect(conflicts()).toEqual([]);
    // The check itself finds a clash.
    const dup = [...BOARD_HOTKEYS, { id: 'filter' as const, group: 'general' as const, label: 'boards.kbd.filter' as const, chords: [{ code: 'KeyC' }] }];
    expect(conflicts(dup).length).toBeGreaterThan(0);
    expect(conflicts(BOARD_HOTKEYS, [{ code: 'KeyC' }])).toContainEqual(['app:0', 'newTask']);
    // Unique ids.
    expect(new Set(BOARD_HOTKEYS.map((h) => h.id)).size).toBe(BOARD_HOTKEYS.length);
  });

  it('matches by physical key, the Latin letter on other layouts, and the platform modifier', () => {
    expect(hotkeyOf(key({ code: 'KeyC', key: 'c' }), true)?.id).toBe('newTask');
    // Russian layout: «с» on the C key.
    expect(hotkeyOf(key({ code: 'KeyC', key: 'с' }), true)?.id).toBe('newTask');
    expect(hotkeyOf(key({ code: 'KeyC', key: 'c', metaKey: true }), true)?.id).toBe('copyKey');
    expect(hotkeyOf(key({ code: 'KeyC', key: 'c', ctrlKey: true }), false)?.id).toBe('copyKey');
    // Ctrl on a Mac is not ⌘.
    expect(hotkeyOf(key({ code: 'KeyC', key: 'c', ctrlKey: true }), true)).toBeNull();
    expect(hotkeyOf(key({ code: 'Comma', key: ',', metaKey: true, shiftKey: true }), true)?.id).toBe('moveLeft');
    expect(hotkeyOf(key({ code: 'Slash', key: '?', shiftKey: true }), true)?.id).toBe('help');
    expect(hotkeyOf(key({ code: 'Backslash', key: '\\', metaKey: true }), true)).toBeNull();
    expect(matchesChord(key({ code: 'KeyS', key: 's', altKey: true }), { code: 'KeyS' }, true)).toBe(false);
  });

  it('labels chords per platform and reads menu digits', () => {
    expect(chordLabel({ code: 'Comma', mod: true, shift: true }, true)).toBe('⌘⇧,');
    expect(chordLabel({ code: 'Comma', mod: true, shift: true }, false)).toBe('Ctrl+Shift+,');
    expect(chordLabel({ code: 'Slash', shift: true }, true)).toBe('?');
    expect(chordLabel({ code: 'ArrowUp' }, true)).toBe('↑');
    expect(digitOf({ code: 'Digit3', key: '3' })).toBe(3);
    expect(digitOf({ code: 'Numpad7', key: '7' })).toBe(7);
    expect(digitOf({ code: 'KeyA', key: 'a' })).toBe(0);
  });
});
