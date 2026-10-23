import { describe, expect, it } from 'vitest';
import { CREATE_TASKS, EDIT_TASKS, MANAGE_BOARD, VIEW_BOARD, mayEditBoardItems, settingsEntryTab, settingsTabShown } from './model';

// CBF-73: statuses, labels and milestones are EDIT_TASKS'; settings and access stay MANAGE_BOARD's.
describe('board settings by rights (CBF-73)', () => {
  const member = VIEW_BOARD | CREATE_TASKS;
  const editor = member | EDIT_TASKS;
  const manager = member | MANAGE_BOARD;
  const items = ['statuses', 'labels', 'milestones'];
  const rest = ['general', 'features', 'access', 'rules', 'git', 'webhook', 'danger'];

  it('an editor sees only the statuses, labels and milestones and opens on «Статусы»', () => {
    expect(mayEditBoardItems(editor)).toBe(true);
    for (const id of items) expect(settingsTabShown(id, editor)).toBe(true);
    for (const id of rest) expect(settingsTabShown(id, editor)).toBe(false);
    expect(settingsEntryTab(editor)).toBe('statuses');
  });

  it('a manager without EDIT_TASKS sees the settings and access, not the lists', () => {
    expect(mayEditBoardItems(manager)).toBe(false);
    for (const id of items) expect(settingsTabShown(id, manager)).toBe(false);
    for (const id of rest) expect(settingsTabShown(id, manager)).toBe(true);
    expect(settingsEntryTab(manager)).toBe('general');
  });

  it('both bits show everything; a member gets no settings entry', () => {
    for (const id of [...items, ...rest]) expect(settingsTabShown(id, editor | MANAGE_BOARD)).toBe(true);
    expect(settingsEntryTab(editor | MANAGE_BOARD)).toBe('general');
    expect(settingsEntryTab(member)).toBeNull();
    expect(settingsEntryTab(undefined)).toBeNull();
    for (const id of [...items, ...rest]) expect(settingsTabShown(id, member)).toBe(false);
  });
});
