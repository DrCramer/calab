import { describe, expect, it } from 'vitest';
import { nextEditing } from './mode';

describe('wiki page mode', () => {
  it('a freshly created page opens in edit mode', () => {
    expect(nextEditing(null, { kind: 'create', id: 'a' })).toBe('a');
    expect(nextEditing('b', { kind: 'create', id: 'a' })).toBe('a');
  });
  it('opening an existing page is read mode', () => {
    expect(nextEditing(null, { kind: 'open', id: 'a' })).toBeNull();
    expect(nextEditing('b', { kind: 'open', id: 'a' })).toBeNull();
  });
  it('re-opening the page being edited keeps it (a click on the active tree row)', () => {
    expect(nextEditing('a', { kind: 'open', id: 'a' })).toBe('a');
  });
  it('create then open another page ends the edit', () => {
    const editing = nextEditing(null, { kind: 'create', id: 'a' });
    expect(nextEditing(editing, { kind: 'open', id: 'b' })).toBeNull();
  });
  it('toggle switches read and edit, only with WRITE', () => {
    expect(nextEditing(null, { kind: 'toggle', id: 'a', canWrite: true })).toBe('a');
    expect(nextEditing('a', { kind: 'toggle', id: 'a', canWrite: true })).toBeNull();
    expect(nextEditing(null, { kind: 'toggle', id: 'a', canWrite: false })).toBeNull();
    expect(nextEditing('a', { kind: 'toggle', id: 'a', canWrite: false })).toBeNull();
  });
  it('leaving a page ends its edit mode only', () => {
    expect(nextEditing('a', { kind: 'leave', id: 'a' })).toBeNull();
    expect(nextEditing('a', { kind: 'leave', id: 'b' })).toBe('a');
  });
});
