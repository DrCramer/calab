import { describe, expect, it } from 'vitest';
import { CREATE_TASKS, EDIT_TASKS, editLockKey, mayEditTask } from './model';

describe('editLockKey / mayEditTask (CBF-51)', () => {
  const task = { createdBy: 'a', assignees: [], archivedAt: undefined };
  it('explains an archived task and a missing right differently', () => {
    expect(editLockKey(true)).toBe('boards.err.archivedTask');
    expect(editLockKey(false)).toBe('boards.needEditRight');
  });
  it('a plain member without EDIT_TASKS cannot edit a foreign task', () => {
    expect(mayEditTask(task, CREATE_TASKS, 'b')).toBe(false);
    expect(mayEditTask(task, CREATE_TASKS, 'a')).toBe(true);
    expect(mayEditTask(task, EDIT_TASKS, 'b')).toBe(true);
  });
});
