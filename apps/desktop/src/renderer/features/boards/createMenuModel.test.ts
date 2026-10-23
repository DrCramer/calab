import { describe, expect, it } from 'vitest';
import { createMenuPlan, pickTaskBoard } from './createMenuModel';

describe('createMenuPlan', () => {
  it('creator with boards: both groups and a separator', () => {
    expect(createMenuPlan(true, ['a'])).toEqual({ tasks: true, manage: true, separator: true, empty: false });
  });
  it('creator without writable boards: only the manage group', () => {
    expect(createMenuPlan(true, [])).toEqual({ tasks: false, manage: true, separator: false, empty: false });
  });
  it('member who may only add tasks: no manage items', () => {
    expect(createMenuPlan(false, ['a', 'b'])).toEqual({ tasks: true, manage: false, separator: false, empty: false });
  });
  it('nothing allowed: empty', () => {
    expect(createMenuPlan(false, []).empty).toBe(true);
  });
});

describe('pickTaskBoard', () => {
  it('prefers the last used board, then the open one, then the first', () => {
    expect(pickTaskBoard(['a', 'b', 'c'], 'b', 'c')).toBe('b');
    expect(pickTaskBoard(['a', 'b', 'c'], undefined, 'c')).toBe('c');
    expect(pickTaskBoard(['a', 'b', 'c'], 'x', 'mine')).toBe('a');
  });
  it('returns an empty id when no board accepts tasks', () => {
    expect(pickTaskBoard([], 'a', 'a')).toBe('');
  });
});
