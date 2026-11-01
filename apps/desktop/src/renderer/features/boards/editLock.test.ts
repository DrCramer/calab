import { taskPermissions } from '@calaba/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { useBots } from '../../stores/bots';
import { taskBits } from '../../lib/boards/access';
import { CREATE_TASKS, EDIT_TASKS, MANAGE_BOARD, VIEW_BOARD, accessRowNote, editLockKey, lacksView, mayArchiveTask, mayEditTask, mayRestoreTask } from './model';

describe('editLockKey / mayEditTask (CBF-51)', () => {
  const task = { createdBy: 'a', assignees: [], archivedAt: undefined };
  it('explains an archived task, a card-only view and a missing right differently', () => {
    expect(editLockKey(true)).toBe('boards.err.archivedTask');
    expect(editLockKey(true, true)).toBe('boards.err.archivedTask');
    expect(editLockKey(false)).toBe('boards.needEditRight');
    expect(editLockKey(false, true)).toBe('boards.needEditRightCard');
  });
  it('a plain member without EDIT_TASKS cannot edit a foreign task', () => {
    expect(mayEditTask(task, CREATE_TASKS, 'a')).toBe(true);
    expect(mayEditTask(task, CREATE_TASKS, 'b')).toBe(false);
    expect(mayEditTask(task, EDIT_TASKS, 'b')).toBe(true);
  });
  it('the author watching their card on a closed board edits it only when create-only (ADR-0115)', () => {
    const card = { ...task, approvers: [], watcherIds: ['a'] };
    // «Править любые задачи» alone arrives as 0 bits on a task-scoped board: the card is a watcher's.
    const watching = taskPermissions({ permissions: 0n, taskScoped: true }, card, 'a');
    expect(watching).toBe(VIEW_BOARD);
    expect(mayEditTask(card, watching, 'a')).toBe(false);
    const createOnly = taskPermissions({ permissions: CREATE_TASKS, taskScoped: true }, card, 'a');
    expect(mayEditTask(card, createOnly, 'a')).toBe(true);
  });
});

describe('a task of my bot is mine (ADR-0151)', () => {
  const byBot = { createdBy: 'bot1', assignees: [], approvers: [], watcherIds: [], archivedAt: undefined };
  afterEach(() => useBots.getState().reset());
  it('edit, archive and create-only visibility follow READY.my_bot_ids', () => {
    expect(mayEditTask(byBot, CREATE_TASKS, 'a')).toBe(false);
    expect(taskBits({ permissions: CREATE_TASKS, taskScoped: true }, byBot, 'a')).toBe(0n);
    useBots.getState().setMine(['bot1']);
    expect(mayEditTask(byBot, CREATE_TASKS, 'a')).toBe(true);
    expect(mayArchiveTask(byBot, CREATE_TASKS, 'a')).toBe(true);
    expect(mayRestoreTask(byBot, VIEW_BOARD, 'a')).toBe(false); // still needs CREATE_TASKS
    expect(taskBits({ permissions: CREATE_TASKS, taskScoped: true }, byBot, 'a')).toBe(VIEW_BOARD | CREATE_TASKS);
    expect(mayEditTask({ ...byBot, createdBy: 'bot2' }, CREATE_TASKS, 'a')).toBe(false);
  });
});

describe('«Доступ» notes without «Видеть доску» (CBF-51)', () => {
  it('a neutral view lacks only on a private board and without a role allowing it', () => {
    expect(lacksView('deny', false, true)).toBe(true);
    expect(lacksView('inherit', true, false)).toBe(true);
    expect(lacksView('inherit', true, true)).toBe(false);
    expect(lacksView('inherit', false, false)).toBe(false);
    expect(lacksView('allow', true, false)).toBe(false);
  });
  it('edit and manage ✓ do nothing, create ✓ is create-only', () => {
    expect(accessRowNote(EDIT_TASKS, 'allow', true)).toBe('boards.perm.needsView');
    expect(accessRowNote(MANAGE_BOARD, 'allow', true)).toBe('boards.perm.needsView');
    expect(accessRowNote(CREATE_TASKS, 'allow', true)).toBe('boards.perm.createOnly');
    expect(accessRowNote(EDIT_TASKS, 'allow', false)).toBeNull();
    expect(accessRowNote(EDIT_TASKS, 'inherit', true)).toBeNull();
    expect(accessRowNote(VIEW_BOARD, 'deny', true)).toBeNull();
  });
});
